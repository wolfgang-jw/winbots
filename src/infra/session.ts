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
// ============================================================
//
// 设计说明：
// - 本 US 采用「进程内内存 Map」作为存储实现，满足「服务端持有历史」，
//   但不满足「重启不丢」（后者属 US-4.1，届时替换为 bun:sqlite，接口不变）。
// - 对外只暴露 appendMessage / getHistory / clearHistory 三个函数，
//   调用方（/stream）不感知底层实现，便于 US-4.1 平滑替换。
// - 长度上限 MAX_HISTORY 与前端 CONFIG.MAX_HISTORY 对齐，满足 N6。

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

/** 历史条数上限（N6：存储规模可控），与前端 MAX_HISTORY 对齐 */
export const MAX_HISTORY = 20;

/** 会话历史存储：sessionId → 消息数组（进程内，US-4.1 将替换为 sqlite） */
const sessionStore = new Map<string, SessionMessage[]>();

/**
 * 追加一条消息到指定会话历史（F1-2）。
 * 写入后若超出 MAX_HISTORY，裁剪保留最近 MAX_HISTORY 条（N6）。
 *
 * @param sessionId 会话 ID（调用方需先通过 isValidSessionId 校验）
 * @param message   要追加的消息
 */
export function appendMessage(sessionId: string, message: SessionMessage): void {
    const list = sessionStore.get(sessionId) ?? [];
    list.push(message);
    // 裁剪：仅保留最近 MAX_HISTORY 条，避免存储无界增长
    if (list.length > MAX_HISTORY) {
        list.splice(0, list.length - MAX_HISTORY);
    }
    // 写入即登记该会话（US-2.3：使 hasSession 能可靠判定会话存在性）
    sessionStore.set(sessionId, list);
}

/**
 * 读取指定会话的历史消息（F1-2）。
 * 返回**深拷贝**，彻底切断与内部存储的引用共享：
 *   - 调用方对返回值的任何修改（含嵌套字段）都不会回写内部存储；
 *   - 保证「读」接口不泄露可写句柄，满足 US-2.3 会话隔离（F1-3）与并发安全（N4）。
 * 返回时按 MAX_HISTORY 兜底截断（N6）。
 *
 * @param sessionId 会话 ID
 * @returns 该会话的历史消息数组（无则返回空数组）
 */
export function getHistory(sessionId: string): SessionMessage[] {
    const list = sessionStore.get(sessionId) ?? [];
    // 兜底截断后逐条深拷贝，避免调用方误改内部存储（US-2.3）
    return list.slice(-MAX_HISTORY).map((m) => structuredClone(m));
}

/**
 * 判断指定会话是否已存在（US-2.3：会话隔离）。
 *
 * 语义：会话在**首条消息写入**时被登记（appendMessage 会 set 该 key）。
 * 因此：
 *   - 新建会话（仅 /api/chat/session 分配 ID、未发消息）→ 返回 false；
 *   - 已发送过至少一条消息的会话 → 返回 true。
 *
 * 用途：路由层可据此区分「续接已有会话」与「首次写入」，
 * 并在需要时对「未知会话」的写入做可观测记录，强化隔离边界。
 *
 * @param sessionId 会话 ID
 * @returns 存在返回 true，否则 false
 */
export function hasSession(sessionId: string): boolean {
    return sessionStore.has(sessionId);
}

/**
 * 清空指定会话的历史（供后续 US-4.6「删除会话」等使用；本 US 暂不调用）。
 *
 * @param sessionId 会话 ID
 */
export function clearHistory(sessionId: string): void {
    sessionStore.delete(sessionId);
}
