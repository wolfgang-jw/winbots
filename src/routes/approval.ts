/**
 * src/routes/approval.ts
 * 审批通道接口（批次三 / NH-02 ②③、AP-11、AP-19、VS-03）
 *
 * 挂载点：/api/approvals
 *   GET  /api/approvals/stream?sessionId=…         SSE 推送（approval_snapshot / approval_request / approval_settled）
 *   GET  /api/approvals/pending?sessionId=…        快照（断线对账 / 短轮询降级）
 *   POST /api/approvals/:requestId/decision        提交决定（需 confirm: true）
 *
 * 安全：
 *   · 全部走既有 originGuard（仅本机来源）；
 *   · sessionId 用既有 isValidSessionId() 校验（防注入）；
 *   · 决定只来自本接口，且带一次性 requestId（AP-19）；重复/过期提交回 409「该请求已结束」。
 */
import { Hono } from "hono";
import { env } from "@/infra/env";
import { isValidSessionId } from "@/infra/session";
import {
    attachChannel, getPending, getPendingById, submitDecision, type ApprovalDecision, type ApprovalEvent,
} from "@/infra/approval";

const router = new Hono();

/** 界面 5 个选项 → 决定（AP-14 / AP-15；与 approval.js 的按钮一一对应） */
const DECISION_MAP: Record<string, ApprovalDecision> = {
    allow_once_command: { allow: true, scope: "once", target: "command" },
    allow_once_all: { allow: true, scope: "once", target: "all" },
    allow_session_command: { allow: true, scope: "session", target: "command" },
    allow_session_all: { allow: true, scope: "session", target: "all" },
    deny: { allow: false, scope: "once", target: "command" },
};

// GET /api/approvals/stream —— SSE 推送
router.get("/stream", (c) => {
    const sessionId = c.req.query("sessionId") ?? "";
    if (!isValidSessionId(sessionId)) return c.json({ error: "sessionId 非法" }, 400);

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    return c.body(
        new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                let closed = false;
                let cleaned = false;

                const write = (chunk: string) => {
                    if (closed) return;
                    try {
                        controller.enqueue(encoder.encode(chunk));
                    } catch {
                        closed = true;      // 连接已断：后续写入全部丢弃（与 chat.ts 同一手法）
                    }
                };
                const send = (obj: unknown) => write(`data: ${JSON.stringify(obj)}\n\n`);

                // ① 连接建立即推全量快照：重连 / 轮询刷新靠 requestId 去重（NB-22③ / AP-25）
                send({ type: "approval_snapshot", requests: getPending(sessionId) });

                // ② 订阅后续事件
                const detach = attachChannel(sessionId, (evt: ApprovalEvent) => send(evt));

                // ③ 心跳保活（与 chat.ts 同一配置；注释帧不触发前端 data: 解析）
                const heartbeat = setInterval(() => write(": ping\n\n"), env.SSE_HEARTBEAT_MS);

                const cleanup = () => {
                    if (cleaned) return;
                    cleaned = true;
                    clearInterval(heartbeat);
                    detach();               // 断开 → closeSession：挂起请求保守拒绝（AP-16）
                    try { controller.close(); } catch { /* 已关闭 */ }
                };

                // 客户端断开（关标签页 / 断网）
                c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
            },
        }),
    );
});

// GET /api/approvals/pending —— 快照（VS-03 短轮询降级用；与 SSE 共用去重键）
router.get("/pending", (c) => {
    const sessionId = c.req.query("sessionId") ?? "";
    if (!isValidSessionId(sessionId)) return c.json({ error: "sessionId 非法" }, 400);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, requests: getPending(sessionId) });
});

// POST /api/approvals/:requestId/decision —— 提交决定
router.post("/:requestId/decision", async (c) => {
    const requestId = c.req.param("requestId");
    if (!requestId || requestId.length > 128) {
        return c.json({ ok: false, code: "ERR_BAD_REQUEST_ID", error: "请求标识非法" }, 400);
    }

    let body: { decision?: unknown; confirm?: unknown };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ ok: false, code: "ERR_ILLEGAL_CHARS", error: "请求体不是合法 JSON" }, 400);
    }

    // 与配置页/日志接口同一约定：破坏性动作需显式确认
    if (body?.confirm !== true) {
        return c.json({ ok: false, code: "ERR_NO_CONFIRM", error: "提交审批决定需显式确认（confirm: true）" }, 400);
    }

    const key = typeof body.decision === "string" ? body.decision : "";
    const decision = DECISION_MAP[key];
    if (!decision) {
        return c.json(
            { ok: false, code: "ERR_BAD_DECISION", error: `未知决定：${key}；允许值为 ${Object.keys(DECISION_MAP).join(" / ")}` },
            400,
        );
    }

    // AP-15：弹窗创建时若未提供「所有命令」选项，服务端同样拒绝该选项（界面隐藏 + 接口拒绝两道）。
    // [C-14 / R-25] 判据取自**该请求自己的 payload**（弹窗创建时固化的 allowAllOption）：
    //   旧写法读 SHELL_ALLOW_ALL_OPTION 这个环境变量 —— 那是工具配置（§7.3 组设置项），平台侧不许读；
    //   且读「当前配置」会让「弹窗挂着时改了配置」把已渲染的弹窗变成提交即 400（口径分裂）。
    const pendingReq = getPendingById(requestId);
    if (
        pendingReq !== null &&
        decision.target === "all" &&
        decision.scope === "session" &&
        pendingReq.allowAllOption === false
    ) {
        return c.json(
            { ok: false, code: "ERR_OPTION_DISABLED", error: "「本会话都允许 · 所有命令」在该弹窗中未提供，请选择其它选项" },
            400,
        );
    }

    const r = submitDecision(requestId, decision);
    if (r !== "ok") {
        // AP-19：重复提交 / 过期提交 / 已结束请求一律忽略并提示
        return c.json({ ok: false, code: "ERR_REQUEST_CLOSED", error: "该请求已结束" }, 409);
    }
    return c.json({ ok: true, accepted: true });
});

export default router;
