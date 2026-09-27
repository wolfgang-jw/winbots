/**
 * src/infra/cancel.ts
 * 进行中上游请求的取消句柄管理（US-3.3：上游取消 / 止损）
 *
 * 职责：
 * 1. 登记「进行中请求」的取消句柄（requestId → AbortController）；
 * 2. 依据 requestId 触发取消（供取消接口调用）；
 * 3. 请求结束时注销句柄，避免内存泄漏。
 *
 * 设计说明：
 * - 采用「带外取消」：对话流连接（/stream）与取消请求连接（/cancel）相互独立，
 *   取消请求不切断对话流，从而保证 US-3.2「保留在途数据」不被破坏。
 * - 存储为进程内 Map，零外部依赖（满足 N1）。
 * - 单线程事件循环下 Map 读写原子，无需额外锁（满足 N4）。
 * - 本模块只负责「句柄管理」，不涉及路由与上游调用（属 chat.ts 职责）。
 */

/** 取消句柄存储：requestId → AbortController */
const cancelStore = new Map<string, AbortController>();

/**
 * 登记一个进行中请求的取消句柄。
 *
 * 语义：请求开始时调用，将 requestId 与其 AbortController 关联。
 * 若同一 requestId 已存在（理论上不应发生），以最新句柄覆盖，避免旧句柄残留。
 *
 * @param requestId  请求标识（调用方需保证非空）
 * @param controller 该请求的 AbortController
 */
export function registerCancel(requestId: string, controller: AbortController): void {
    cancelStore.set(requestId, controller);
}

/**
 * 依据 requestId 触发取消（幂等）。
 *
 * 语义：取消接口调用。找到对应句柄则 abort() 并移除，返回 true；
 *       未找到（请求已结束 / ID 非法 / 重复取消）则返回 false，不抛错。
 *
 * 说明：abort() 会令上游 fetch 的 signal 进入 aborted 状态，
 *       pipeStream 的 reader.read() 随即抛 AbortError，从而停止上游生成（止损）。
 *
 * @param requestId 请求标识
 * @returns 是否成功取消了一个进行中的请求
 */
export function cancelRequest(requestId: string): boolean {
    const controller = cancelStore.get(requestId);
    if (!controller) return false;      // 未知/已结束：幂等返回 false
    cancelStore.delete(requestId);      // 先移除，避免重复取消
    controller.abort();                 // 触发上游取消
    return true;
}

/**
 * 注销一个请求的取消句柄（幂等）。
 *
 * 语义：请求结束时调用（成功 / 失败 / 被取消均需调用），清理映射。
 *
 * @param requestId 请求标识
 */
export function unregisterCancel(requestId: string): void {
    cancelStore.delete(requestId);
}

/**
 * 判断指定 requestId 是否仍在进行中（供测试与排查使用，可选）。
 *
 * @param requestId 请求标识
 * @returns 进行中返回 true，否则 false
 */
export function isPending(requestId: string): boolean {
    return cancelStore.has(requestId);
}
