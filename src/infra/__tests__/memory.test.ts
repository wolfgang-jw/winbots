/**
 * src/infra/__tests__/memory.test.ts
 * 第 8 步 · 模块 6b 的数据层单测（T-M1 ~ T-M10）。
 *
 * ⚠️ 本测试会**真实建库**，每个用例用 __setDbPathForTest 指向临时文件，
 *    绝不允许碰到 data/winbots.db（与 sessionBinding.test.ts 同一策略）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { __setDbPathForTest, closeDb, getDb } from "@/infra/db";
import { appendMessage, generateSessionId } from "@/infra/session";
import {
    advanceMemory,
    deleteMemoryByScope,
    getMemoryCursor,
    getMessagesSince,
    listMemoryScopes,
    MEMORY_SCOPE_GLOBAL,
    memoryScopeOfSession,
} from "@/infra/memory";

let tmpDir = "";
let dbFile = "";

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "winbots-mem-test-"));
    dbFile = join(tmpDir, "test.db");
    __setDbPathForTest(dbFile);
    getDb(); // 触发 initDb + 建表
});

afterEach(() => {
    __setDbPathForTest(null);
    closeDb();
    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        /* 清理失败不影响断言 */
    }
});

describe("建表（M1）", () => {
    test("T-M1 agent_memory 表存在且具备 5 个字段", () => {
        const rows = getDb()
            .query<{ name: string }, Record<string, never>>(
                `PRAGMA table_info(agent_memory)`
            )
            .all({});
        const cols = new Set(rows.map((r) => r.name));
        for (const c of [
            "agent_uid",
            "scope",
            "summarized_seq",
            "facts",
            "updated_at",
        ]) {
            expect(cols.has(c)).toBe(true);
        }
    });

    test("T-M2 同一 agent + scope 只能有一行（联合主键）", () => {
        const now = Date.now();
        const db = getDb();
        db.run(
            `INSERT INTO agent_memory (agent_uid, scope, summarized_seq, facts, updated_at)
             VALUES ('a1', 'global', 0, NULL, $now)`,
            { $now: now }
        );
        // 再插一次同键：主键冲突应抛错（证明 PRIMARY KEY (agent_uid, scope) 生效）
        expect(() =>
            db.run(
                `INSERT INTO agent_memory (agent_uid, scope, summarized_seq, facts, updated_at)
                 VALUES ('a1', 'global', 0, NULL, $now)`,
                { $now: now }
            )
        ).toThrow();
    });
});

describe("游标读写（M2）", () => {
    test("T-M3 无记录时返回零游标，且不写库", () => {
        const cur = getMemoryCursor("a1", MEMORY_SCOPE_GLOBAL);
        expect(cur.summarizedSeq).toBe(0);
        expect(cur.facts).toBeNull();
        // 读操作不应产生行
        expect(listMemoryScopes("a1").length).toBe(0);
    });

    test("T-M4 advanceMemory 首次写入：建行并推进游标", () => {
        const ok = advanceMemory("a1", MEMORY_SCOPE_GLOBAL, 0, 5, "- 喜欢深色主题");
        expect(ok).toBe(true);
        const cur = getMemoryCursor("a1", MEMORY_SCOPE_GLOBAL);
        expect(cur.summarizedSeq).toBe(5);
        expect(cur.facts).toBe("- 喜欢深色主题");
    });

    test("T-M5 facts 为 null 时仍推进游标（sentinel，防重复摘要）", () => {
        const ok = advanceMemory("a1", MEMORY_SCOPE_GLOBAL, 0, 3, null);
        expect(ok).toBe(true);
        const cur = getMemoryCursor("a1", MEMORY_SCOPE_GLOBAL);
        expect(cur.summarizedSeq).toBe(3);
        expect(cur.facts).toBeNull();
    });

    test("T-M6 CAS：expectedSeq 不匹配时返回 false 且游标不动", () => {
        advanceMemory("a1", MEMORY_SCOPE_GLOBAL, 0, 5, "- f1");
        // 用过期的期望值再推一次
        const ok = advanceMemory("a1", MEMORY_SCOPE_GLOBAL, 0, 9, "- f2");
        expect(ok).toBe(false);
        const cur = getMemoryCursor("a1", MEMORY_SCOPE_GLOBAL);
        expect(cur.summarizedSeq).toBe(5);
        expect(cur.facts).toBe("- f1");
    });

    test("T-M7 facts 为 null 时保留旧事实（COALESCE）", () => {
        advanceMemory("a1", MEMORY_SCOPE_GLOBAL, 0, 5, "- 旧事实");
        advanceMemory("a1", MEMORY_SCOPE_GLOBAL, 5, 8, null);
        const cur = getMemoryCursor("a1", MEMORY_SCOPE_GLOBAL);
        expect(cur.summarizedSeq).toBe(8);
        expect(cur.facts).toBe("- 旧事实");
    });

    test("T-M8 不同 scope 互不干扰", () => {
        const sid = generateSessionId();
        advanceMemory("a1", MEMORY_SCOPE_GLOBAL, 0, 5, "- 全局");
        advanceMemory("a1", memoryScopeOfSession(sid), 0, 2, "- 会话");

        expect(getMemoryCursor("a1", MEMORY_SCOPE_GLOBAL).summarizedSeq).toBe(5);
        expect(getMemoryCursor("a1", memoryScopeOfSession(sid)).summarizedSeq).toBe(2);
        expect(listMemoryScopes("a1").length).toBe(2);
    });
});

describe("增量查询（M2 · getMessagesSince）", () => {
    test("T-M9 只返回 seq > afterSeq 的非 system 消息，且升序", () => {
        const sid = generateSessionId();
        // 写 5 条对话消息，中间夹 1 条 system
        appendMessage(sid, { role: "user", content: "第一条" });
        appendMessage(sid, { role: "assistant", content: "第二条" });
        appendMessage(sid, { role: "system", content: "[技能注入，不应参与摘要]" });
        appendMessage(sid, { role: "user", content: "第三条" });
        appendMessage(sid, { role: "assistant", content: "第四条" });

        const all = getMessagesSince(sid, 0);
        // system 被排除
        expect(all.every((m) => m.role !== "system")).toBe(true);
        expect(all.length).toBe(4);
        // 升序
        for (let i = 1; i < all.length; i++) {
            expect(all[i]!.seq).toBeGreaterThan(all[i - 1]!.seq);
        }

        // 游标推进到 all[1].seq 后，只应剩后面两条
        const rest = getMessagesSince(sid, all[1]!.seq);
        expect(rest.length).toBe(2);
        expect(rest[0]!.seq).toBe(all[2]!.seq);
    });

    test("T-M10 limit 生效且不跳消息（按 seq 升序取前 N 条）", () => {
        const sid = generateSessionId();
        for (let i = 0; i < 10; i++)
            appendMessage(sid, { role: "user", content: `m${i}` });
        const page1 = getMessagesSince(sid, 0, 3);
        expect(page1.length).toBe(3);
        // 连续推进：两次 limit 取到的 seq 不重叠且连续
        const lastSeq = page1[page1.length - 1]!.seq;
        const page2 = getMessagesSince(sid, lastSeq, 3);
        expect(page2.length).toBe(3);
        expect(page2[0]!.seq).toBeGreaterThan(lastSeq);
    });
});

describe("清理（M2 · deleteMemoryByScope）", () => {
    test("T-M11 删除指定作用域，其他作用域保留", () => {
        const sid = generateSessionId();
        advanceMemory("a1", MEMORY_SCOPE_GLOBAL, 0, 5, "- 全局");
        advanceMemory("a1", memoryScopeOfSession(sid), 0, 2, "- 会话");

        const n = deleteMemoryByScope("a1", memoryScopeOfSession(sid));
        expect(n).toBe(1);
        expect(listMemoryScopes("a1").length).toBe(1);
        expect(getMemoryCursor("a1", MEMORY_SCOPE_GLOBAL).facts).toBe("- 全局");
    });

    test("T-M12 无外键：删会话不会级联删记忆", () => {
        const sid = generateSessionId();
        appendMessage(sid, { role: "user", content: "hello" });
        advanceMemory("a1", memoryScopeOfSession(sid), 0, 1, "- 事实");

        // 删掉会话行
        getDb().run(`DELETE FROM sessions WHERE id = $sid`, { $sid: sid });

        // 记忆仍在（这是刻意的：长期记忆不随会话消失，方案 §3.7.1）
        expect(getMemoryCursor("a1", memoryScopeOfSession(sid)).facts).toBe("- 事实");
    });
});
