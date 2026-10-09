/**
 * src/infra/llmLog.ts
 * LLM 对话日志存储模块（Sprint 5.1 / US-LOG-2）
 *
 * 职责：
 * 1. 将每一次与 LLM 的对话交互，以 JSONL 文件（每行一条 JSON）结构化落盘；
 * 2. 提供写入（appendLlmLog）、查询（listLlmLogs / getLlmLog）、清理（clearLlmLogs）能力；
 * 3. 按条数上限（LLM_LOG_MAX_ROWS）自动裁剪最旧记录，避免无限增长。
 *
 * 设计说明：
 * - 存储形态：本地 JSONL 文件（默认 data/llm_logs.jsonl），零数据库依赖（仅用 fs）。
 * - 独立存储：与会话库 data/winbots.db（messages 表）完全分离，互不影响，
 *   且不受 MAX_HISTORY=20 裁剪影响（满足 F7-4 / N7-6）。
 * - 开关门控：appendLlmLog 内部先判 env.LLM_LOG_ENABLED，关闭直接返回，零 IO（满足 F7-12 / N7-4）。
 * - 旁路容错：所有写操作 try/catch 兜底，永不抛出到调用方（满足 F7-13 / N7-3）。
 * - 不截断：单条记录完整序列化，不设长度上限（满足 D7-4）。
 * - 损坏行容错：读取时跳过无法 JSON.parse 的行，避免单行损坏导致整体不可读。
 * - 无主键：JSONL 无自增主键，查询以「文件行序号」定位（index，0 起）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { env } from "@/infra/env";

/** 日志记录结构（字段清单见《用户故事》第三节；无 id、无 truncated） */
export interface LlmLogRecord {
    /** 会话 ID（新模式）；旧模式为 null */
    sessionId?: string | null;
    /** 请求 ID（用于关联取消）；旧模式为 null */
    requestId?: string | null;
    /** 时间戳（epoch ms），由 appendLlmLog 写入时补齐 */
    createdAt?: number;
    /** 模型名 */
    model: string;
    /** 用户输入内容 */
    userInput: string;
    /** 模型正文（完整，不截断） */
    assistantText?: string | null;
    /** 思考过程（完整，不截断） */
    thinking?: string | null;
    /** 工具调用（名称/参数/结果，多轮） */
    toolCalls?: unknown[] | null;
    /** token 用量 */
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
    /** 结束原因（finish_reason） */
    finishReason?: string | null;
    /** 耗时（毫秒） */
    elapsedMs?: number;
    /** 是否被中断 */
    interrupted?: boolean;
    /** 错误信息（若有） */
    error?: string | null;
}

/** 查询结果：日志记录 + 文件行序号 */
export type LlmLogItem = LlmLogRecord & { index: number };

/** 解析日志文件绝对路径（相对工作目录） */
function logFilePath(): string {
    return resolve(process.cwd(), env.LLM_LOG_FILE);
}

/** 确保日志文件所在目录存在 */
function ensureDir(file: string): void {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 读取全部日志行（解析为对象数组，跳过损坏行） */
function readAll(): LlmLogRecord[] {
    const file = logFilePath();
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            try {
                return JSON.parse(line) as LlmLogRecord;
            } catch {
                return null;
            }
        })
        .filter((r): r is LlmLogRecord => r !== null);
}

/** 超过条数上限时，保留最近 N 行并重写文件（F7-14） */
function trimIfNeeded(file: string): void {
    const lines = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    if (lines.length <= env.LLM_LOG_MAX_ROWS) return;
    const kept = lines.slice(lines.length - env.LLM_LOG_MAX_ROWS);
    writeFileSync(file, kept.join("\n") + "\n", "utf8");
}

/**
 * 写入一条日志：内部判开关 + 内部兜底异常（永不抛出到调用方）。
 *
 * @param record 日志记录（createdAt 由本函数补齐）
 * @returns 写入成功返回 true；开关关闭或写入失败返回 false
 */
export function appendLlmLog(record: LlmLogRecord): boolean {
    if (!env.LLM_LOG_ENABLED) return false;   // 开关关闭：零 IO
    try {
        const file = logFilePath();
        ensureDir(file);
        const line = JSON.stringify({ ...record, createdAt: Date.now() }) + "\n";
        appendFileSync(file, line, "utf8");   // 追加一行（不截断）
        trimIfNeeded(file);                   // 按条数上限裁剪最旧
        return true;
    } catch (e) {
        console.warn("⚠️ [US-LOG-2] 日志写入失败（忽略，不影响主链路）:", e);
        return false;
    }
}

/**
 * 查询日志列表（时间倒序），供 US-LOG-4。
 * index 为文件行序号（0 起，越旧越小）。
 *
 * @param limit 返回条数上限（默认 100）
 */
export function listLlmLogs(limit = 100): LlmLogItem[] {
    const all = readAll();
    return all
        .map((r, index) => ({ index, ...r }))
        .slice(-limit)      // 取最近 limit 条
        .reverse();         // 时间倒序
}

/**
 * 读取单条日志详情（按文件行序号），供 US-LOG-4。
 *
 * @param index 文件行序号（0 起）
 * @returns 命中返回记录，越界返回 null
 */
export function getLlmLog(index: number): LlmLogItem | null {
    const all = readAll();
    if (index < 0 || index >= all.length) return null;
    const item = all[index];
    if (item === undefined) return null;
    return { index, ...item };
}

/**
 * 清空全部日志，供 US-LOG-4。
 *
 * @returns 被清除的条数（文件不存在返回 0）
 */
export function clearLlmLogs(): number {
    const file = logFilePath();
    if (!existsSync(file)) return 0;
    const count = readAll().length;
    writeFileSync(file, "", "utf8");
    return count;
}
