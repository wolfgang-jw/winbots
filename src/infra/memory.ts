/**
 * src/infra/memory.ts
 * [agent / 第 8 步 · 模块 6b] 记忆摘要的数据访问层
 *
 * 职责（只做数据读写，不含任何 LLM 调用）：
 * 1. 读取/初始化某 agent 在某作用域的记忆游标行（agent_memory）
 * 2. 按游标取「尚未摘要」的消息增量（含 seq —— 这是 getHistory 拿不到的）
 * 3. 单事务写入 facts 并推进游标（幂等：一次只推进一步）
 * 4. 按作用域清理记忆（不设外键，故需显式删除）
 *
 * 设计说明：
 * - 为什么另写增量查询而不用 getHistory()：
 *   getHistory() / getMessagesWithMeta() 只取最近 MAX_HISTORY(20) 条且**不返回 seq**，
 *   一旦游标落后超过 20 条就永远追不上（且静默无报错）。
 *   摘要必须按 `seq > summarized_seq` 全量增量取，故在此单独实现。
 * - 为什么不在 agent_memory 上加外键：删会话会静默级联删掉长期记忆（方案 §3.7.1）。
 *   需要清理时显式调用 deleteMemoryByScope()。
 * - 为什么游标推进与 facts 写入必须同事务：否则「facts 写了一半、游标没推进」
 *   会导致下次重复摘要同一段；反过来「游标推进了、facts 没写」会永久丢数据。
 */
import { getDb } from "./db";

/** 作用域：全局（跨会话长期记忆） */
export const MEMORY_SCOPE_GLOBAL = "global";

/**
 * 构造会话级作用域键。
 *
 * @param sessionId 会话 ID
 * @returns `session:<sid>`
 */
export function memoryScopeOfSession(sessionId: string): string {
    return `session:${sessionId}`;
}

/** 记忆游标行（无记录时 summarized_seq 视为 0） */
export interface MemoryCursor {
    agentUid: string;
    scope: string;
    /** 已摘要到 messages.seq 的哪一条（含）；0 = 尚未摘要任何消息 */
    summarizedSeq: number;
    /** 已归纳的事实文本；null = 尚无事实 */
    facts: string | null;
    updatedAt: number;
}

/** 增量消息（摘要的输入单元） */
export interface MemorySourceMessage {
    seq: number;
    role: string;
    content: string | null;
}

/**
 * 读取记忆游标行。
 *
 * @param agentUid agent uid
 * @param scope    作用域（MEMORY_SCOPE_GLOBAL 或 memoryScopeOfSession(sid)）
 * @returns 游标行；不存在时返回 summarized_seq = 0 的空游标（**不写库**）
 */
export function getMemoryCursor(agentUid: string, scope: string): MemoryCursor {
    const db = getDb();
    const row = db
        .query<
            {
                agent_uid: string;
                scope: string;
                summarized_seq: number;
                facts: string | null;
                updated_at: number;
            },
            { $uid: string; $scope: string }
        >(
            `SELECT agent_uid, scope, summarized_seq, facts, updated_at
               FROM agent_memory
              WHERE agent_uid = $uid AND scope = $scope`
        )
        .get({ $uid: agentUid, $scope: scope });

    if (!row) {
        // 不存在时给零游标：读操作不产生副作用，写库只在 advanceMemory 里发生
        return {
            agentUid,
            scope,
            summarizedSeq: 0,
            facts: null,
            updatedAt: 0,
        };
    }
    return {
        agentUid: row.agent_uid,
        scope: row.scope,
        summarizedSeq: row.summarized_seq,
        facts: row.facts,
        updatedAt: row.updated_at,
    };
}

/**
 * 取「尚未摘要」的消息增量（seq > afterSeq），按 seq 升序。
 *
 * ⚠️ 与 getHistory() 的关键差别：**不截断为 MAX_HISTORY 条**。
 *   摘要需要的是完整增量，截断会导致游标永远追不上（见文件头说明）。
 *   system 行不参与摘要：它由技能注入产生，不是对话内容。
 *
 * @param sessionId 会话 ID
 * @param afterSeq  游标（只取 seq 严格大于它的行）
 * @param limit     单次最多取多少条（防止一次摘要过长撑爆上下文）
 * @returns 增量消息数组（升序）
 */
export function getMessagesSince(
    sessionId: string,
    afterSeq: number,
    limit = 50
): MemorySourceMessage[] {
    const db = getDb();
    return db
        .query<
            { seq: number; role: string; content: string | null },
            { $sid: string; $after: number; $limit: number }
        >(
            `SELECT seq, role, content
               FROM messages
              WHERE session_id = $sid
                AND seq > $after
                AND role <> 'system'
              ORDER BY seq ASC
              LIMIT $limit`
        )
        .all({ $sid: sessionId, $after: afterSeq, $limit: limit });
}

/**
 * 读取「最近一次写操作影响的行数」（跨 Bun 版本兼容）。
 *
 * ⚠️ 与 session.ts 的 A1 修复同一策略：bun:sqlite 的 run() 在 Bun v1.1.14 之前
 *    不返回 changes（为 undefined），直接用会让 CAS 误判为「推进失败」。
 *    兜底改为 SELECT changes() 读取，保证语义一致。
 *
 * @param res run() 的返回值
 * @returns 影响行数
 */
function changesOf(res: unknown): number {
    const n = (res as { changes?: number } | undefined)?.changes;
    if (typeof n === "number") return n;
    const row = getDb()
        .query<{ c: number }, Record<string, never>>("SELECT changes() AS c")
        .get({});
    return row?.c ?? 0;
}

/**
 * 写入 facts 并推进游标（单事务、幂等）。
 *
 * 幂等语义：仅当库中 summarized_seq 仍等于 `expectedSeq` 时才推进（CAS）。
 *   - 并发两个摘要请求时，后到者 CAS 失败返回 false，不会重复记账。
 *   - 没有增量（newSeq === expectedSeq）时也允许写 facts（用于「首次建立事实」），
 *     但此时不推进游标。
 *
 * facts 为空时的处理：仍写入一行（facts = NULL），只为**推进游标** ——
 *   否则下次会把同一段再摘要一遍，属于重复记账。
 *
 * @param agentUid    agent uid
 * @param scope       作用域
 * @param expectedSeq 调用方读到的旧游标（CAS 期望值）
 * @param newSeq      本次摘要后应推进到的 seq
 * @param facts       归纳出的事实文本（null/空 = 无新事实，仅推进游标）
 * @returns 是否推进成功（false = 游标已被他处改动，调用方应重试或忽略）
 */
export function advanceMemory(
    agentUid: string,
    scope: string,
    expectedSeq: number,
    newSeq: number,
    facts: string | null
): boolean {
    const db = getDb();
    const now = Date.now();
    const factText = facts && facts.trim() !== "" ? facts.trim() : null;

    // 单事务：CAS 推进 + facts 写入原子完成
    const result = db.transaction(() => {
        // 先确保行存在（首次摘要时 agent_memory 无记录）
        if (expectedSeq === 0) {
            db.run(
                `INSERT INTO agent_memory (agent_uid, scope, summarized_seq, facts, updated_at)
                 VALUES ($uid, $scope, 0, NULL, $now)
                 ON CONFLICT(agent_uid, scope) DO NOTHING`,
                { $uid: agentUid, $scope: scope, $now: now }
            );
        }
        // CAS：只有游标仍是 expectedSeq 才更新
        const res = db.run(
            `UPDATE agent_memory
                SET summarized_seq = $newSeq,
                    facts = COALESCE($facts, facts),
                    updated_at = $now
              WHERE agent_uid = $uid
                AND scope = $scope
                AND summarized_seq = $expected`,
            {
                $uid: agentUid,
                $scope: scope,
                $newSeq: newSeq,
                $facts: factText,
                $now: now,
                $expected: expectedSeq,
            }
        );
        return changesOf(res) > 0;
    })();

    return result;
}

/**
 * 删除某作用域的记忆（会话删除时可选调用；不设外键故需显式清理）。
 *
 * @param agentUid agent uid
 * @param scope    作用域
 * @returns 删除行数
 */
export function deleteMemoryByScope(agentUid: string, scope: string): number {
    const db = getDb();
    const res = db.run(
        `DELETE FROM agent_memory WHERE agent_uid = $uid AND scope = $scope`,
        { $uid: agentUid, $scope: scope }
    );
    return changesOf(res);
}

/**
 * 列出某 agent 的全部记忆作用域（供调试/状态页展示）。
 *
 * @param agentUid agent uid
 * @returns 游标行数组（按 updated_at 倒序）
 */
export function listMemoryScopes(agentUid: string): MemoryCursor[] {
    const db = getDb();
    const rows = db
        .query<
            {
                agent_uid: string;
                scope: string;
                summarized_seq: number;
                facts: string | null;
                updated_at: number;
            },
            { $uid: string }
        >(
            `SELECT agent_uid, scope, summarized_seq, facts, updated_at
               FROM agent_memory
              WHERE agent_uid = $uid
              ORDER BY updated_at DESC`
        )
        .all({ $uid: agentUid });

    return rows.map((row) => ({
        agentUid: row.agent_uid,
        scope: row.scope,
        summarizedSeq: row.summarized_seq,
        facts: row.facts,
        updatedAt: row.updated_at,
    }));
}
