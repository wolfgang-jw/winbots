/**
 * src/infra/session.ts
 * 会话标识生成与校验（US-2.1：会话唯一标识）
 *
 * 职责：
 * 1. 生成全局唯一的会话 ID（F1-1）
 * 2. 校验会话 ID 的格式合法性（供路由接收参数时使用）
 *
 * 设计说明：
 * - 唯一性来源：crypto.randomUUID()（Bun 内置，RFC 4122 v4），
 *   碰撞概率可忽略，无需引入任何外部依赖（满足 N1「零外部依赖」）。
 * - 可读性/可排序：在 UUID 前加时间戳前缀（36 进制），便于日志排查与粗略排序，
 *   但唯一性仍由 UUID 部分保证。
 * - 本模块只负责「生成 / 校验」标识，不涉及存储与隔离（属 US-2.2 / US-2.3）。
 */

/** 会话 ID 前缀：便于识别与日志排查 */
const SESSION_ID_PREFIX = "sess_";

/**
 * 会话 ID 格式：sess_<时间戳36进制>_<UUID>
 * 例：sess_lx8f2k_3f2504e0-4f89-41d3-9a0c-0305e82c3301
 */
const SESSION_ID_RE = /^sess_[0-9a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 生成一个全局唯一的会话 ID。
 *
 * @returns 形如 `sess_<ts36>_<uuid>` 的唯一标识
 */
export function generateSessionId(): string {
    const ts = Date.now().toString(36);          // 时间戳（36 进制），便于排序与排查
    const uuid = crypto.randomUUID();            // 唯一性来源（Bun 内置）
    return `${SESSION_ID_PREFIX}${ts}_${uuid}`;
}

/**
 * 校验会话 ID 是否符合本模块生成的格式。
 *
 * 用途：路由接收前端传来的 sessionId 时做格式校验，
 * 拒绝明显非法的值（如空串、注入尝试），但**不校验其是否真实存在**
 * （存在性校验属 US-2.2 存储层职责）。
 *
 * @param id 待校验的值（可能为 undefined / 非字符串）
 * @returns 合法返回 true，否则 false
 */
export function isValidSessionId(id: unknown): id is string {
    return typeof id === "string" && SESSION_ID_RE.test(id);
}

// ============================================================
// 会话历史存取（US-2.2：服务端持有会话历史）
// [US-4.1] 持久化：由「进程内内存 Map」替换为「本地 SQLite」，
//          对外接口签名保持不变，调用方（/stream）零改动。
// ============================================================
//
// 设计说明：
// - 存储实现：bun:sqlite（见 src/infra/db.ts），数据落盘，重启不丢（F2-1）。
// - 对外接口不变：appendMessage / getHistory / hasSession / clearHistory。
// - 长度上限 MAX_HISTORY 与前端 CONFIG.MAX_HISTORY 对齐，满足 N6。
// - 消息元数据与工具字段以 JSON 存入 messages.meta，供后续 US-4.4 重现。

import { getDb } from "@/infra/db";

/** 单条消息结构（与 OpenAI Chat Completions 的 message 对齐） */
export interface SessionMessage {
    role: "user" | "assistant" | "system" | "tool";
    content: string | null;
    /** assistant 携带工具调用时保留（供多轮上下文回灌） */
    tool_calls?: unknown;
    /** tool 消息对应的调用 ID */
    tool_call_id?: string;
    /** tool 消息的工具名 */
    name?: string;
}

/**
 * [US-4.1] 消息渲染元数据（存入 messages.meta，供历史重现）。
 * 本 US 仅定义结构并写入；读取与渲染属 US-4.4。
 */
export interface MessageMeta {
    /** 思考过程（reasoning_content 累积） */
    thinking?: string;
    /** 工具调用记录（名称/参数/结果） */
    toolCalls?: Array<{ name: string; arguments?: unknown; result?: string }>;
    /** token 用量（被打断时全 0） */
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    /** 是否被打断（US-3.6） */
    interrupted?: boolean;
    /** 模型名 */
    model?: string;
    /** 耗时（毫秒） */
    elapsedMs?: number;
    /** 开始时刻（epoch ms） */
    startedAt?: number;
}

/** 历史条数上限（N6：存储规模可控），与前端 MAX_HISTORY 对齐 */
export const MAX_HISTORY = 20;

/** 会话标题默认值（US-4.2 将据此自动生成） */
const DEFAULT_TITLE = "新会话";

/**
 * [US-4.2] 自动生成标题的最大字符数（超出则截断并追加省略号）。
 * 取值 30：兼顾「可识别性」与「列表展示不溢出」（对应需求文档「待确认事项 3」）。
 */
const TITLE_MAX_LEN = 30;

/**
 * 确保会话记录存在（US-4.1 内部辅助）。
 * 首次写入时创建 sessions 行（标题默认「新会话」）。
 *
 * @param sessionId 会话 ID
 * @param now       当前时间（epoch ms）
 */
function ensureSessionRow(sessionId: string, now: number): void {
    const db = getDb();
    db.run(
        `INSERT INTO sessions (id, title, created_at, updated_at, message_count)
         VALUES ($id, $title, $now, $now, 0)
         ON CONFLICT(id) DO NOTHING`,
        { $id: sessionId, $title: DEFAULT_TITLE, $now: now }
    );
}

/**
 * [US-4.2] 由首条用户消息内容推导会话标题（F2-2）。
 *
 * 规则：
 *   1. 归一化：将连续空白（换行/制表/多空格）压缩为单个空格，并去除首尾空白；
 *   2. 截断：超过 TITLE_MAX_LEN 时取前 TITLE_MAX_LEN 个字符并追加「…」；
 *   3. 兜底：归一化后为空串时返回空串（调用方据此跳过更新，保持默认标题）。
 *
 * 说明：本函数为**纯函数**（无副作用、不访问数据库），便于单元测试。
 *
 * @param raw 首条用户消息的原始内容
 * @returns 生成的标题；内容为空时返回空串
 */
function deriveTitle(raw: string): string {
    // 1. 归一化：压缩空白 + 去首尾
    const normalized = raw.replace(/\s+/g, " ").trim();
    if (!normalized) return ""; // 纯空白 → 不生成标题

    // 2. 截断：超长则截取并追加省略号
    if (normalized.length > TITLE_MAX_LEN) {
        return normalized.slice(0, TITLE_MAX_LEN) + "…";
    }
    return normalized;
}

/**
 * 追加一条消息到指定会话历史（F1-2）。
 * [US-4.1] 持久化到 SQLite；写入后若超出 MAX_HISTORY，裁剪最旧（N6）。
 * [US-4.2] 若为会话首条用户消息，自动生成并更新会话标题（F2-2）。
 *
 * @param sessionId 会话 ID（调用方需先通过 isValidSessionId 校验）
 * @param message   要追加的消息
 * @param meta      [US-4.1] 可选渲染元数据（思考/工具/usage/interrupted 等）
 */
export function appendMessage(
    sessionId: string,
    message: SessionMessage,
    meta?: MessageMeta
): void {
    const db = getDb();
    const now = Date.now();

    // 事务：保证「会话登记 + 消息插入 + 计数更新 + 标题生成 + 裁剪」原子完成（N3/N4）
    const tx = db.transaction(() => {
        ensureSessionRow(sessionId, now);

        // 计算会话内序号 seq = 当前最大 seq + 1
        const row = db
            .query<{ maxSeq: number | null }, { $sid: string }>(
                `SELECT MAX(seq) AS maxSeq FROM messages WHERE session_id = $sid`
            )
            .get({ $sid: sessionId });
        const nextSeq = (row?.maxSeq ?? 0) + 1;

        // 组装 meta：渲染元数据 + 工具字段（tool_calls/tool_call_id/name）。
        // 说明：messages 表只存 role/content，工具字段必须一并塞入 meta，
        //       否则 getHistory 读回时 tool 消息的 tool_call_id 会丢失，
        //       破坏多轮工具上下文回灌（US-2.2 功能回归）。
        const metaObj: Record<string, unknown> = { ...(meta ?? {}) };
        if (message.tool_calls !== undefined) metaObj.tool_calls = message.tool_calls;
        if (message.tool_call_id !== undefined) metaObj.tool_call_id = message.tool_call_id;
        if (message.name !== undefined) metaObj.name = message.name;
        const metaJson =
            Object.keys(metaObj).length > 0 ? JSON.stringify(metaObj) : null;

        // 插入消息（meta 以 JSON 字符串存储；无任何元数据时存 NULL）
        db.run(
            `INSERT INTO messages (session_id, role, content, seq, meta, created_at)
             VALUES ($sid, $role, $content, $seq, $meta, $now)`,
            {
                $sid: sessionId,
                $role: message.role,
                $content: message.content ?? null,
                $seq: nextSeq,
                $meta: metaJson,
                $now: now,
            }
        );

        // 更新会话最后活动时间与消息计数
        db.run(
            `UPDATE sessions
             SET updated_at = $now, message_count = message_count + 1
             WHERE id = $sid`,
            { $now: now, $sid: sessionId }
        );

        // [US-4.2] 自动生成标题（F2-2）：
        //   仅当「本次写入的是用户消息」且「会话标题仍为默认值」时，
        //   用该消息内容推导标题并更新。
        //   - 条件 message.role === "user"：仅首条用户消息触发，符合 F2-2 语义；
        //   - 条件 title = $default：保证「只设置一次」，天然幂等，
        //     且不会覆盖后续可能的自定义标题（为 US-4.3/4.4 预留空间）；
        //   - 空标题（纯空白消息）跳过更新，保持默认「新会话」。
        //   说明：本更新与消息写入处于**同一事务**，保证「消息落盘 ⇔ 标题更新」原子提交。
        if (message.role === "user") {
            const title = deriveTitle(message.content ?? "");
            if (title) {
                db.run(
                    `UPDATE sessions
                     SET title = $title
                     WHERE id = $sid AND title = $default`,
                    { $title: title, $sid: sessionId, $default: DEFAULT_TITLE }
                );
            }
        }

        // N6 裁剪：仅保留最近 MAX_HISTORY 条，删除更旧的（含其 meta）
        db.run(
            `DELETE FROM messages
             WHERE session_id = $sid
               AND seq <= (
                   SELECT MAX(seq) FROM messages WHERE session_id = $sid
               ) - $keep`,
            { $sid: sessionId, $keep: MAX_HISTORY }
        );
    });

    tx();
}

/**
 * 读取指定会话的历史消息（F1-2）。
 * [US-4.1] 从 SQLite 读取，取**最近 MAX_HISTORY 条**并按 seq 升序返回
 * （与旧实现 `slice(-MAX_HISTORY)` 语义一致，N6）。
 * 返回**深拷贝**，切断与存储的引用共享（US-2.3 会话隔离 F1-3 与并发安全 N4）。
 *
 * 说明：本函数返回「供模型上下文使用」的消息（role/content/tool 字段），
 *       不含 meta；meta 的读取由 getMessagesWithMeta 提供（供 US-4.4 重现）。
 *
 * @param sessionId 会话 ID
 * @returns 该会话的历史消息数组（无则返回空数组）
 */
export function getHistory(sessionId: string): SessionMessage[] {
    const db = getDb();
    // 内层子查询：按 seq 倒序取最近 MAX_HISTORY 条；外层再按 seq 升序还原顺序。
    // 这样等价于旧实现的「保留最近 N 条」，避免长会话取到最旧 N 条。
    const rows = db
        .query<
            { role: string; content: string | null; meta: string | null },
            { $sid: string; $keep: number }
        >(
            `SELECT role, content, meta FROM (
                 SELECT role, content, meta, seq FROM messages
                 WHERE session_id = $sid
                 ORDER BY seq DESC
                 LIMIT $keep
             ) ORDER BY seq ASC`
        )
        .all({ $sid: sessionId, $keep: MAX_HISTORY });

    // 逐条还原为 SessionMessage（深拷贝：新对象，切断与存储引用）
    return rows.map((r) => {
        const msg: SessionMessage = {
            role: r.role as SessionMessage["role"],
            content: r.content,
        };
        // 从 meta 还原工具字段（供多轮上下文回灌，保持与旧行为一致）
        if (r.meta) {
            try {
                const m = JSON.parse(r.meta) as MessageMeta & {
                    tool_calls?: unknown;
                    tool_call_id?: string;
                    name?: string;
                };
                if (m.tool_calls !== undefined) msg.tool_calls = m.tool_calls;
                if (m.tool_call_id !== undefined) msg.tool_call_id = m.tool_call_id;
                if (m.name !== undefined) msg.name = m.name;
            } catch {
                // meta 解析失败：忽略，仅返回 role/content
            }
        }
        return msg;
    });
}

/**
 * [US-4.1] 读取会话消息及其渲染元数据（供 US-4.4 完整重现）。
 * 取最近 MAX_HISTORY 条并按 seq 升序返回，含 meta 对象。
 *
 * @param sessionId 会话 ID
 * @returns 消息数组（含 meta）
 */
export function getMessagesWithMeta(
    sessionId: string
): Array<{ role: string; content: string | null; meta: MessageMeta | null }> {
    const db = getDb();
    const rows = db
        .query<
            { role: string; content: string | null; meta: string | null },
            { $sid: string; $keep: number }
        >(
            `SELECT role, content, meta FROM (
                 SELECT role, content, meta, seq FROM messages
                 WHERE session_id = $sid
                 ORDER BY seq DESC
                 LIMIT $keep
             ) ORDER BY seq ASC`
        )
        .all({ $sid: sessionId, $keep: MAX_HISTORY });

    return rows.map((r) => {
        let meta: MessageMeta | null = null;
        if (r.meta) {
            try {
                meta = JSON.parse(r.meta) as MessageMeta;
            } catch {
                meta = null;
            }
        }
        return { role: r.role, content: r.content, meta };
    });
}

/**
 * 判断指定会话是否已存在（US-2.3：会话隔离）。
 *
 * 语义（与内存实现保持一致）：会话在**首条消息写入**时被登记。
 *   - 新建会话（仅 /api/chat/session 分配 ID、未发消息）→ 返回 false；
 *   - 已发送过至少一条消息的会话 → 返回 true。
 *
 * [US-4.1] 由 sessions 表存在性判定（ensureSessionRow 在首条消息时创建行）。
 *
 * @param sessionId 会话 ID
 * @returns 存在返回 true，否则 false
 */
export function hasSession(sessionId: string): boolean {
    const db = getDb();
    const row = db
        .query<{ cnt: number }, { $sid: string }>(
            `SELECT COUNT(1) AS cnt FROM sessions WHERE id = $sid`
        )
        .get({ $sid: sessionId });
    return (row?.cnt ?? 0) > 0;
}

/**
 * 清空指定会话的历史（供后续 US-4.6「删除会话」等使用；本 US 暂不调用）。
 * [US-4.1] 删除会话行，messages 经外键级联删除（PRAGMA foreign_keys=ON）。
 *
 * @param sessionId 会话 ID
 */
export function clearHistory(sessionId: string): void {
    const db = getDb();
    db.run(`DELETE FROM sessions WHERE id = $sid`, { $sid: sessionId });
}

// ============================================================
// [US-4.3] 会话列表查询（F2-3：历史页面按最后活动时间倒序列出所有会话）
// ============================================================
//
// 设计说明：
// - 只返回「列表展示所需」的摘要字段（标题/时间/条数），不含消息正文，
//   避免大字段传输与无谓 IO。
// - 排序：updated_at DESC（最后活动时间倒序） + id DESC（同毫秒兜底，保证稳定）。
//   复用 db.ts 已建索引 idx_sessions_updated_at，查询走索引。
// - 返回新对象数组（天然深拷贝，无引用共享，符合会话隔离 N4）。
// - 本 US 不设分页/上限（会话数量级可控）；如需上限，可在后续 US 增加 LIMIT。

/** [US-4.3] 会话列表项（摘要，供历史页面展示） */
export interface SessionSummary {
    /** 会话 ID */
    id: string;
    /** 会话标题（US-4.2 自动生成，默认「新会话」） */
    title: string;
    /** 创建时间（epoch ms） */
    createdAt: number;
    /** 最后活动时间（epoch ms），列表排序依据 */
    updatedAt: number;
    /** 消息条数 */
    messageCount: number;
}

/**
 * [US-4.3] 列出全部会话摘要，按最后活动时间倒序（F2-3）。
 *
 * 排序：updated_at DESC, id DESC
 *   - 主键 updated_at：最后活动时间倒序（最新会话在最前）；
 *   - 次键 id：同一毫秒内创建/更新的多个会话，用 id 兜底，保证顺序确定、稳定。
 *
 * @returns 会话摘要数组；无会话时返回空数组
 */
export function listSessions(): SessionSummary[] {
    const db = getDb();
    const rows = db
        .query<
            {
                id: string;
                title: string;
                created_at: number;
                updated_at: number;
                message_count: number;
            },
            Record<string, never>
        >(
            `SELECT id, title, created_at, updated_at, message_count
             FROM sessions
             ORDER BY updated_at DESC, id DESC`
        )
        .all({});

    // 逐条映射为驼峰命名的摘要对象（新对象，切断与存储引用）
    return rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: r.message_count,
    }));
}

// ============================================================
// [US-4.4] 会话详情查询（F2-4/F2-5：打开历史会话并完整重现）
// ============================================================
//
// 设计说明：
// - 组装「会话元信息 + 全部消息（含 meta）」，供前端一次性拉取并静态重现。
// - 复用既有查询：
//     · 会话元信息：单独查 sessions 行（字段映射与 listSessions 一致）；
//     · 消息列表：直接调用 getMessagesWithMeta（US-4.1 已实现）。
// - 会话不存在时 session 返回 null，由路由层据此返回 404。
// - 返回新对象数组（天然深拷贝，无引用共享，符合会话隔离 N4）。

/** [US-4.4] 会话详情（元信息 + 消息，供历史重现） */
export interface SessionDetail {
    /** 会话元信息；会话不存在时为 null */
    session: SessionSummary | null;
    /** 会话消息（含 meta），按 seq 升序；会话不存在时为空数组 */
    messages: Array<{ role: string; content: string | null; meta: MessageMeta | null }>;
}

/**
 * [US-4.4] 读取会话详情：元信息 + 全部消息（含 meta）。
 *
 * @param sessionId 会话 ID（调用方需先通过 isValidSessionId 校验）
 * @returns 会话详情；会话不存在时 session 为 null、messages 为空数组
 */
export function getSessionDetail(sessionId: string): SessionDetail {
    const db = getDb();

    // 1. 查询会话元信息（字段映射与 listSessions 保持一致）
    const row = db
        .query<
            {
                id: string;
                title: string;
                created_at: number;
                updated_at: number;
                message_count: number;
            },
            { $sid: string }
        >(
            `SELECT id, title, created_at, updated_at, message_count
             FROM sessions
             WHERE id = $sid`
        )
        .get({ $sid: sessionId });

    // 会话不存在：返回空详情（路由层据此 404）
    if (!row) {
        return { session: null, messages: [] };
    }

    const session: SessionSummary = {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
    };

    // 2. 查询消息列表（含 meta），复用 US-4.1 既有函数
    const messages = getMessagesWithMeta(sessionId);

    return { session, messages };
}

// ============================================================
// [US-4.6] 删除会话（F2-7：删除会话时一并清除其消息）
// ============================================================
//
// 设计说明：
// - 删除 sessions 行，messages 经外键级联删除（db.ts 已 PRAGMA foreign_keys=ON）。
// - 返回「是否实际删除」，供路由层区分 200 / 404：
//     · 会话存在 → 删除成功 → true  → 200
//     · 会话不存在 → 删除 0 行 → false → 404
// - 与 clearHistory 的关系：clearHistory 是 US-4.1 预留的「清空」原语（返回 void），
//   本函数在其基础上增加「删除结果」语义，二者并存、互不影响（向后兼容）。
// - 安全：使用参数化查询（$sid），无 SQL 注入风险。
// - 版本要求：依赖 bun:sqlite 的 run() 返回 { changes }，需 Bun >= 1.1.14
//   （见 US-4.6 文档 2.1.6；低版本可用 changes() 兜底）。

/**
 * [US-4.6] 删除指定会话及其全部消息（F2-7）。
 *
 * 语义：删除 sessions 行；关联的 messages 由外键级联删除
 *       （依赖 db.ts 的 PRAGMA foreign_keys = ON）。
 *
 * @param sessionId 会话 ID（调用方需先通过 isValidSessionId 校验）
 * @returns 是否实际删除了会话：true=删除成功；false=会话不存在
 */
export function deleteSession(sessionId: string): boolean {
   const db = getDb();
   // 删除会话行；messages 经 ON DELETE CASCADE 自动清除
   const result = db.run(`DELETE FROM sessions WHERE id = $sid`, { $sid: sessionId });
    // [A1 修复] bun:sqlite 的 run() 自 Bun v1.1.14 起返回 { changes, lastInsertRowid }；
    //   低版本 Bun 下 result.changes 为 undefined，会导致「删除成功也误返回 404」。
    //   兜底策略：优先取 run().changes；若不可用（undefined），改用 SELECT changes()
//   读取「最近一次 DELETE 影响的行数」，保证跨 Bun 版本语义一致。
    let changes = (result as { changes?: number } | undefined)?.changes;
    if (typeof changes !== "number") {
        const row = db
            .query<{ c: number }, Record<string, never>>("SELECT changes() AS c")
            .get({});
        changes = row?.c ?? 0;
    }
    // changes > 0 表示确实删除了会话（否则会话不存在）
    return changes > 0;
}
