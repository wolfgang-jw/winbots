/**
 * src/infra/db.ts
 * 本地 SQLite 数据库连接与建表（US-4.1：会话持久化）
 *
 * 职责：
 * 1. 打开/创建本地数据库文件（<项目根>/data/winbots.db）
 * 2. 设置 PRAGMA（WAL / 外键 / 同步级别），保证抗中断与并发安全
 * 3. 建表（sessions / messages）与索引
 * 4. 提供 getDb() 单例与 closeDb() 优雅关闭
 *
 * 设计说明：
 * - 使用 Bun 内置 bun:sqlite，零外部依赖（满足 N1）。
 * - 数据文件位于项目本地 data/ 目录，随项目迁移（满足 N5）。
 * - WAL 模式 + 事务写入，抵御进程被杀/断电（满足 N3）。
 * - Bun 单线程事件循环下同步 API 天然串行（满足 N4）。
 * - data/ 目录由 .gitignore 忽略，不提交仓库（满足 N7）。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { resolve } from "path";

/** 数据目录：<项目根>/data（相对本文件 src/infra/../../data） */
const DATA_DIR = resolve(import.meta.dir, "../../data");

/** 数据库文件路径 */
const DB_PATH = resolve(DATA_DIR, "winbots.db");

/** 数据库单例 */
let db: Database | null = null;

/**
 * 建表 SQL（幂等：IF NOT EXISTS）。
 *
 * sessions：会话表
 *   - id            会话 ID（主键）
 *   - title         标题（默认「新会话」，US-4.2 使用）
 *   - created_at    创建时间（epoch ms）
 *   - updated_at    最后活动时间（epoch ms，US-4.3 列表倒序用）
 *   - message_count 消息条数（冗余字段，便于列表展示，US-4.3 使用）
 *
 * messages：消息表
 *   - id         自增主键
 *   - session_id 关联会话（外键，级联删除，US-4.6 使用）
 *   - role       角色 user/assistant/system/tool
 *   - content    正文（可为 NULL，如 assistant 仅含 tool_calls）
 *   - seq        会话内序号（保证严格顺序）
 *   - meta       JSON 字符串：渲染元数据 + 工具字段（见 appendMessage）
 *   - created_at 写入时间（epoch ms）
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '新会话',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT,
    seq        INTEGER NOT NULL,
    meta       TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq
    ON messages(session_id, seq);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
    ON sessions(updated_at DESC);
`;

/**
 * 初始化数据库：打开连接、设置 PRAGMA、建表。
 * 幂等：重复调用返回同一单例。
 *
 * @returns 数据库实例
 */
export function initDb(): Database {
    if (db) return db;

    // 确保数据目录存在（首次运行自动创建）
    mkdirSync(DATA_DIR, { recursive: true });

    db = new Database(DB_PATH, { create: true });

    // WAL 模式：提升并发读性能，并增强抗中断能力（N3/N4）
    db.run("PRAGMA journal_mode = WAL;");
    // 外键约束：启用级联删除（US-4.6 依赖）
    db.run("PRAGMA foreign_keys = ON;");
    // 同步级别 NORMAL：WAL 下兼顾性能与安全（N3）
    db.run("PRAGMA synchronous = NORMAL;");

    // 建表（多语句一次执行）
    db.run(SCHEMA_SQL);

    console.log(`🗄️  [US-4.1] 本地数据库已就绪: ${DB_PATH}`);
    return db;
}

/**
 * 获取数据库单例（未初始化则自动初始化）。
 */
export function getDb(): Database {
    return db ?? initDb();
}

/**
 * 优雅关闭数据库：checkpoint 后关闭，确保 WAL 数据落盘。
 * 幂等：重复调用安全。
 */
export function closeDb(): void {
    if (!db) return;
    try {
        // 将 WAL 内容合并回主库，避免残留 -wal/-shm（N3）
        db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch (e) {
        console.warn("⚠️  [US-4.1] WAL checkpoint 失败（忽略）:", e);
    }
    try {
        db.close();
    } catch (e) {
        console.warn("⚠️  [US-4.1] 数据库关闭失败（忽略）:", e);
    }
    db = null;
}
