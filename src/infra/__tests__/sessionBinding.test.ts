/**
 * src/infra/__tests__/sessionBinding.test.ts
 * 第 6 步 · M1/M2 的数据库层单测（T-S1 ~ T-S8）。
 *
 * ⚠️ 本测试会**真实建库**，因此每个用例都用 __setDbPathForTest 指向临时文件，
 *    绝不允许碰到 data/winbots.db（否则会污染真实会话，且测试之间互相干扰）。
 * ⚠️ db.ts 的 DB_PATH 是模块级常量，无法用环境变量覆盖 —— 这正是
 *    __setDbPathForTest 存在的原因（见 db.ts 注释，R-6-3）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { __setDbPathForTest, closeDb, getDb } from "@/infra/db";
import {
    appendMessage,
    bindSessionAgent,
    getSessionAgentBinding,
    getSessionDetail,
    hasSession,
    unbindSessionAgent,
    // 生成合法会话 ID，避免用手写字符串（isValidSessionId 有格式要求）
    generateSessionId,
} from "@/infra/session";

let tmpDir = "";
let dbFile = "";

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "winbots-test-"));
    dbFile = join(tmpDir, "test.db");
});

afterEach(() => {
    // 先关连接再删目录：Windows 上开着文件句柄删不掉
    __setDbPathForTest(null);
    closeDb();
    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        /* 清理失败不影响断言 */
    }
});

/** 读 sessions 表的列名集合 */
function sessionColumns(): Set<string> {
    const rows = getDb()
        .query<{ name: string }, Record<string, never>>(`PRAGMA table_info(sessions)`)
        .all({});
    return new Set(rows.map((r) => r.name));
}

describe("迁移（D-6-1 老库补列）", () => {
    test("T-S1 新库直接具备 agent_uid / persona_snapshot", () => {
        __setDbPathForTest(dbFile);
        getDb(); // 触发 initDb + 建表
        const cols = sessionColumns();
        expect(cols.has("agent_uid")).toBe(true);
        expect(cols.has("persona_snapshot")).toBe(true);
        // 既有的 5 列不能被破坏
        for (const c of ["id", "title", "created_at", "updated_at", "message_count"]) {
            expect(cols.has(c)).toBe(true);
        }
    });

    test("T-S2 模拟老库（只有 5 列）→ 启动后补列，且重复启动幂等", () => {
        // ① 手工造一个「改动前形状」的老库
        const old = new Database(dbFile, { create: true });
        old.run(`
            CREATE TABLE sessions (
                id            TEXT PRIMARY KEY,
                title         TEXT NOT NULL DEFAULT '新会话',
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0
            );
        `);
        old.run(
            `INSERT INTO sessions (id, title, created_at, updated_at, message_count)
             VALUES ('sess_old', '老会话', 1, 1, 0)`,
        );
        old.close();

        // ② 走正常启动路径：应触发 ALTER TABLE 补列
        __setDbPathForTest(dbFile);
        const cols = sessionColumns();
        expect(cols.has("agent_uid")).toBe(true);
        expect(cols.has("persona_snapshot")).toBe(true);

        // ③ 老数据必须还在（补列不能重建表）
        const row = getDb()
            .query<{ title: string }, { $sid: string }>(
                `SELECT title FROM sessions WHERE id = $sid`,
            )
            .get({ $sid: "sess_old" });
        expect(row?.title).toBe("老会话");

        // ④ 再启动一次：PRAGMA 探查应发现列已存在 → 不重复 ALTER（幂等，不抛错）
        closeDb();
        __setDbPathForTest(dbFile);
        expect(() => getDb()).not.toThrow();
        expect(sessionColumns().has("agent_uid")).toBe(true);
    });
});

describe("会话绑定的读写（A14 / A15 / A17）", () => {
    beforeEach(() => {
        __setDbPathForTest(dbFile);
    });

    test("T-S3 不存在的会话 → 两个 null，不抛错（A17）", () => {
        const b = getSessionAgentBinding(generateSessionId());
        expect(b.agentUid).toBeNull();
        expect(b.personaSnapshot).toBeNull();
    });

    test("T-S4 连绑两次：true / false，且快照保持第一次（A15 快照不可变）", () => {
        const sid = generateSessionId();
        const first = bindSessionAgent(sid, "ag_00000001", "第一次快照");
        const second = bindSessionAgent(sid, "ag_00000002", "第二次快照");
        expect(first).toBe(true);
        expect(second).toBe(false); // CAS：agent_uid 已非 NULL，影响 0 行

        const b = getSessionAgentBinding(sid);
        expect(b.agentUid).toBe("ag_00000001");
        expect(b.personaSnapshot).toBe("第一次快照");
    });

    test("T-S5 对不存在的会话绑定 → 先建行，hasSession 由 false 变 true", () => {
        const sid = generateSessionId();
        expect(hasSession(sid)).toBe(false);
        bindSessionAgent(sid, "ag_00000001", null);
        expect(hasSession(sid)).toBe(true);
        // 快照传 null 时读回也是 null（表示「该 agent 无 AGENT.md」）
        expect(getSessionAgentBinding(sid).personaSnapshot).toBeNull();
    });

    test("T-S6 解绑后 messages 条数不变（A17 不中断会话）", () => {
        const sid = generateSessionId();
        appendMessage(sid, { role: "user", content: "你好" });
        appendMessage(sid, { role: "assistant", content: "在的" });
        bindSessionAgent(sid, "ag_00000001", "快照");

        const before = getSessionDetail(sid).messages.length;
        unbindSessionAgent(sid);
        const after = getSessionDetail(sid).messages.length;
        expect(before).toBe(2);
        expect(after).toBe(before);
    });

    test("T-S7 解绑后两个字段都回到 null", () => {
        const sid = generateSessionId();
        bindSessionAgent(sid, "ag_00000001", "快照");
        unbindSessionAgent(sid);
        const b = getSessionAgentBinding(sid);
        expect(b.agentUid).toBeNull();
        expect(b.personaSnapshot).toBeNull();
    });

    test("T-S8 绑定后 getSessionDetail 仍可用（新列未破坏既有查询）", () => {
        const sid = generateSessionId();
        appendMessage(sid, { role: "user", content: "第一句" });
        bindSessionAgent(sid, "ag_00000001", "快照");
        const d = getSessionDetail(sid);
        expect(d.session).not.toBeNull();
        expect(d.session?.title).toBe("第一句"); // 自动标题仍生效
        expect(d.messages.length).toBe(1);
    });
});
