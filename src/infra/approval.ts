/**
 * src/infra/approval.ts
 * 待审批请求的注册、挂起、唤醒与推送（批次三 / NH-02 ①②③、AP-19、AP-20、NH-13）
 *
 * 设计要点：
 *   1. 一次性标识：每个请求一个 requestId，决定提交后立即失效（AP-19）；重复/过期提交返回「该请求已结束」。
 *   2. 保守拒绝：没有任何交互通道（界面未连接 / 已断开）→ 立即 approval_unavailable，**绝不默认放行**（AP-16）。
 *   3. 生命周期终态：允许 / 拒绝 / 超时 / 取消 / 断连 / 会话结束 —— 六种结局都必然走 settle()，
 *      且 settle 幂等（第二次调用直接返回 false），因此不会出现「永不清理的待审批请求」（NH-13）。
 *   4. 只有两行审计日志（AP-20），都经掩码；不含完整命令、不含输出。
 *   5. **不读任何工具配置**（§7.3 / R-25）：等待上限由调用方（`local/_shell_approval.ts`）算好传进来，
 *      本模块只接收 waitMs。
 */
export type ApprovalOutcomeKind =
    | "allowed"
    | "denied_by_user"
    | "approval_timeout"
    | "cancelled"
    | "approval_unavailable";

/** 用户的决定（与界面 5 个选项一一对应，AP-14 / AP-15） */
export interface ApprovalDecision {
    allow: boolean;
    scope: "once" | "session";
    target: "command" | "all";
}

/** 推送给界面的请求体（**不含任何授权凭证字段**，AP-18） */
export interface PendingApproval {
    requestId: string;
    sessionId: string;
    sessionTitle: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    intent: string;
    risk: string;
    boundary: string;
    noticeVersion: string;
    permission: string;
    destructiveHint: boolean;
    allowAllOption: boolean;
    createdAt: number;
}

export interface ApprovalResult {
    outcome: ApprovalOutcomeKind;
    decision?: ApprovalDecision;
    waitMs: number;
}

export type ApprovalEvent =
    | { type: "approval_request"; request: PendingApproval }
    | { type: "approval_settled"; requestId: string; outcome: ApprovalOutcomeKind };

interface Entry {
    payload: PendingApproval;
    settle: (outcome: ApprovalOutcomeKind, decision?: ApprovalDecision) => boolean;
    settled: boolean;
    startedAt: number;
}

/** 待审批请求：requestId → Entry（进程内内存；不落盘） */
const pending = new Map<string, Entry>();

/** 每个会话的订阅者（SSE 连接）；一个会话可以有多个标签页 */
const subscribers = new Map<string, Set<(e: ApprovalEvent) => void>>();

/** 会话通道关闭后的清理回调（由工具层注册，用于清空授权记忆，AP-13） */
const channelClosedHandlers = new Set<(sessionId: string) => void>();

const MAX_COMMAND_LOG_CHARS = 200;
const MAX_INTENT_LOG_CHARS = 200;

/** 生成一次性标识（AP-19） */
export function generateApprovalId(): string {
    return `apr_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

/** SH-37：日志里的命令/目的只保留前 200 字符，密钥字面值替换为 ****（由调用方先 maskSecrets） */
function head(text: string, max: number): string {
    return String(text ?? "").slice(0, max);
}

/**
 * AP-20：每次弹窗 / 每次决定各一行日志。
 * 字段：会话标识、命令前 200 字符、目的前 200 字符、绝对工作目录、档位、决定、授权范围、
 *      等待时长、告知块版本号；`拒绝` 与 `approval_timeout` 额外标注。
 * ⚠️ 命令与目的在此**再掩码一次**（防御：调用方可能忘了）。
 */
function audit(kind: "approval_request" | "approval_decision", p: PendingApproval, extra: Record<string, unknown> = {}): void {
    console.log(
        JSON.stringify({
            event: kind,
            requestId: p.requestId,
            sessionId: p.sessionId,
            commandHead: head(p.command, MAX_COMMAND_LOG_CHARS),
            intentHead: head(p.intent, MAX_INTENT_LOG_CHARS),
            cwd: p.cwd,
            permission: p.permission,
            noticeVersion: p.noticeVersion,
            ...extra,
        }),
    );
}

/** 注册一个会话的推送通道；返回 detach。最后一个通道断开时视为「界面断连」（AP-16）。 */
export function attachChannel(sessionId: string, listener: (e: ApprovalEvent) => void): () => void {
    let set = subscribers.get(sessionId);
    if (!set) {
        set = new Set();
        subscribers.set(sessionId, set);
    }
    set.add(listener);

    return () => {
        const cur = subscribers.get(sessionId);
        if (!cur) return;
        cur.delete(listener);
        if (cur.size === 0) {
            subscribers.delete(sessionId);
            // 界面断连：所有挂起请求保守拒绝（AP-16），并通知工具层清空记忆（AP-13）
            closeSession(sessionId);
            for (const h of channelClosedHandlers) {
                try { h(sessionId); } catch { /* 清理失败不影响主流程 */ }
            }
        }
    };
}

/** 是否存在可用的交互通道（决定「弹窗」还是「approval_unavailable」） */
export function hasChannel(sessionId: string): boolean {
    const set = subscribers.get(sessionId);
    return !!set && set.size > 0;
}

/** 工具层注册「会话通道关闭」回调（AP-13：断连即清空授权记忆） */
export function onChannelClosed(handler: (sessionId: string) => void): void {
    channelClosedHandlers.add(handler);
}

function broadcast(sessionId: string, event: ApprovalEvent): void {
    const set = subscribers.get(sessionId);
    if (!set) return;
    for (const fn of [...set]) {
        try { fn(event); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
}

/** 按会话列出待审批请求（快照 / 短轮询降级用；VS-03） */
export function getPending(sessionId: string): PendingApproval[] {
    return [...pending.values()]
        .filter((e) => e.payload.sessionId === sessionId && !e.settled)
        .sort((a, b) => a.payload.createdAt - b.payload.createdAt)
        .map((e) => e.payload);
}

/**
 * 注册一次审批请求并挂起等待决定（AP-06 ⑦ 的服务端实现）。
 *
 * @param payload 已含三段告知与一次性标识（requestId 由本函数补全）
 * @param opts.waitMs 等待上限（AP-16，默认 SHELL_APPROVAL_WAIT_MS=120000）
 * @param opts.signal 用户中断信号（挂起期间点「停止」→ cancelled，SH-44）
 */
export function registerApproval(
    payload: Omit<PendingApproval, "requestId" | "createdAt"> & { requestId?: string },
    opts: { waitMs: number; signal?: AbortSignal },
): Promise<ApprovalResult> {
    const requestId = payload.requestId || generateApprovalId();
    const full: PendingApproval = { ...payload, requestId, createdAt: Date.now() } as PendingApproval;

    // AP-21 兜底：三段缺一不可（正常情况下 _shell_approval.buildNotices 已拦，这里是第二道）
    if (!full.intent || !full.risk || !full.boundary) {
        console.error(`⛔ [审批] 告知块不完整，拒绝注册：requestId=${requestId}`);
        return Promise.resolve({ outcome: "approval_unavailable", waitMs: 0 });
    }

    // AP-16：没有交互通道 → 立即保守拒绝（不弹窗、不放行）
    if (!hasChannel(full.sessionId)) {
        console.warn(`⚠️ [审批] 会话 ${full.sessionId} 没有可用的界面通道，按 approval_unavailable 处理`);
        return Promise.resolve({ outcome: "approval_unavailable", waitMs: 0 });
    }

    return new Promise<ApprovalResult>((resolve) => {
        const startedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | null = null;
        let onAbort: (() => void) | null = null;

        const settle = (outcome: ApprovalOutcomeKind, decision?: ApprovalDecision): boolean => {
            const entry = pending.get(requestId);
            if (!entry || entry.settled) return false;      // 幂等：重复提交 / 过期提交忽略（AP-19）
            entry.settled = true;
            pending.delete(requestId);
            if (timer) clearTimeout(timer);
            if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);

            const waitMs = Date.now() - startedAt;
            if (outcome !== "allowed") {
                audit("approval_decision", full, {
                    decision: outcome,
                    waitMs,
                    // AP-20：拒绝与超时须额外标注
                    flagged: outcome === "denied_by_user" || outcome === "approval_timeout" ? "attention" : undefined,
                });
            }
            broadcast(full.sessionId, { type: "approval_settled", requestId, outcome });
            resolve({ outcome, decision, waitMs });
            return true;
        };

        const entry: Entry = { payload: full, settle, settled: false, startedAt };
        pending.set(requestId, entry);

        audit("approval_request", full);      // AP-20 第一行
        broadcast(full.sessionId, { type: "approval_request", request: full });

        timer = setTimeout(() => { settle("approval_timeout"); }, Math.max(1000, opts.waitMs));

        if (opts.signal) {
            onAbort = () => { settle("cancelled"); };
            if (opts.signal.aborted) {
                settle("cancelled");
            } else {
                opts.signal.addEventListener("abort", onAbort, { once: true });
            }
        }
    });
}

/**
 * 提交决定（AP-19：决定只能来自界面交互）。
 * @returns "ok" 已接受；"not_found" 请求不存在或已结束（接口回 409「该请求已结束」）
 */
export function submitDecision(requestId: string, decision: ApprovalDecision): "ok" | "not_found" {
    const entry = pending.get(requestId);
    if (!entry || entry.settled) return "not_found";
    audit("approval_decision", entry.payload, {
        decision: decision.allow ? "allow" : "deny",
        scope: decision.scope,
        target: decision.target,
        waitMs: Date.now() - entry.startedAt,
        flagged: decision.allow ? undefined : "attention",
    });
    entry.settle(decision.allow ? "allowed" : "denied_by_user", decision);
    return "ok";
}

/**
 * 会话级清理：会话结束 / 界面断连时把所有挂起请求结算为 approval_unavailable（AP-16 / NH-13）。
 * 注意：**不是**默认放行，是保守拒绝。
 */
export function closeSession(sessionId: string): void {
    for (const entry of [...pending.values()]) {
        if (entry.payload.sessionId === sessionId && !entry.settled) {
            entry.settle("approval_unavailable");
        }
    }
}

/** 仅供排查/用例：当前挂起请求数量 */
export function pendingCount(): number {
    return pending.size;
}

/**
 * [C-13] 按 requestId 取**挂起中**的请求（只读；已结算 / 不存在返回 null）。
 *
 * 用途：`src/routes/approval.ts` 的服务端复检要判断「这个弹窗当时是否提供了某个选项」——
 *   该事实在弹窗创建时就固化进了 payload（AP-15），必须读**该请求自己的** payload，
 *   而不是去读（已被下沉为工具设置项的）配置，否则会出现「配置已改 → 旧弹窗的提交被拒」的口径分裂。
 */
export function getPendingById(requestId: string): PendingApproval | null {
    const entry = pending.get(requestId);
    if (!entry || entry.settled) return null;
    return entry.payload;
}
