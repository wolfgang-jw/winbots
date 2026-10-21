/**
 * tests/repro-tool-chain.ts
 * [需求域 B / B-07] 工具调用全链路复现脚本（假上游，不访问真实模型服务）
 *
 * 目的：把「工具调用是否被执行 / 推送事件 / 回灌 / 落库」变成可重复执行的用例，
 *   而不是只能靠人工观察。三个场景：
 *
 *   A. 首轮未请求工具      → 上游生成 1 次，无 tool_call 事件，正文落库（对照 AC-01）
 *   B. 多轮工具链          → 第 1 轮工具 call_1、第 2 轮工具 call_2、第 3 轮正文；
 *                            上游生成 3 次，tool_call 事件 4 条（每次调用 2 条：调用中 + 结果），
 *                            落库 meta.toolCalls 含 2 条且 id 与事件一致（对应 B-01 / B-05 / B-07）
 *   C. 空正文 + 工具       → 第 1 轮只回工具、第 2 轮空正文收尾；
 *                            工具照样被执行、落库，并补一条 notice 而非空气泡（对应 B-03）
 *
 * 运行（在 winbots/ 目录下）：
 *   bun run tests/repro-tool-chain.ts
 *   成功后退出码 0；任一断言失败退出码 1，并打印失败项。
 *
 * 说明：
 * - 语言/运行时：Bun（用到 bun:sqlite、Bun.serve、Bun.env），不引入任何新依赖。
 * - 假上游：Bun.serve 起在 127.0.0.1 的随机端口上，按「第几轮」返回预置 SSE，
 *   并统计请求次数——「上游生成次数」即断言依据（A-01 / AC-02）。
 * - 必须先设置 Bun.env 再动态 import：src/infra/env.ts 在模块加载时就校验环境变量，
 *   静态 import 会先于赋值执行（N-09）。
 * - 会写本地会话库 winbots/data/winbots.db：脚本结尾用 deleteSession 清理自己产生的会话。
 */

const TOOL_WIRE_NAME = "local__common__get_current_time";

// ============================================================
// 假上游
// ============================================================

/** 统计上游请求次数（每个场景前清零） */
let upstreamRequests = 0;

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

/** 一段正文分片 */
function textDelta(text: string): string {
    return sse({ choices: [{ delta: { content: text } }] });
}

/**
 * 一个工具调用的分片序列：先 id/name/type，再把 arguments 拆成两片。
 * 这样能同时覆盖「按 index 聚合 id/name/arguments」的路径（V-01）。
 */
function toolCallDeltas(index: number, id: string, name: string, argsJson: string): string {
    const head = {
        choices: [
            {
                delta: {
                    tool_calls: [
                        { index, id, type: "function", function: { name, arguments: "" } },
                    ],
                },
            },
        ],
    };
    const mid = {
        choices: [
            { delta: { tool_calls: [{ index, function: { arguments: argsJson.slice(0, 2) } }] } },
        ],
    };
    const tail = {
        choices: [
            { delta: { tool_calls: [{ index, function: { arguments: argsJson.slice(2) } }] } },
        ],
    };
    return sse(head) + sse(mid) + sse(tail);
}

/** 带 finish_reason 与 usage 的收尾分片 */
function finishDelta(reason: string): string {
    return sse({
        choices: [{ delta: {}, finish_reason: reason }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
}

const DONE_LINE = "data: [DONE]\n\n";

/** 依据「首个 user 消息里的场景标记」+「已回灌的 tool 消息条数」决定本轮返回什么 */
function buildUpstreamSse(scenario: string, toolMsgCount: number): string {
    if (scenario === "SCENARIO-A") {
        return textDelta("你好，我是假上游，本轮没有工具调用。") + finishDelta("stop") + DONE_LINE;
    }

    if (scenario === "SCENARIO-B") {
        if (toolMsgCount === 0) {
            return (
                toolCallDeltas(0, "call_1", TOOL_WIRE_NAME, "{}") + finishDelta("tool_calls") + DONE_LINE
            );
        }
        if (toolMsgCount === 1) {
            return (
                toolCallDeltas(0, "call_2", TOOL_WIRE_NAME, "{}") + finishDelta("tool_calls") + DONE_LINE
            );
        }
        return textDelta("两个工具都执行完了。") + finishDelta("stop") + DONE_LINE;
    }

    // SCENARIO-C：第 1 轮只调工具（正文为空），第 2 轮空正文收尾
    if (toolMsgCount === 0) {
        return (
            toolCallDeltas(0, "call_c1", TOOL_WIRE_NAME, "{}") + finishDelta("tool_calls") + DONE_LINE
        );
    }
    return finishDelta("stop") + DONE_LINE;
}

function startFakeUpstream() {
    return Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
            upstreamRequests++;
            let scenario = "SCENARIO-A";
            let toolMsgCount = 0;
            try {
                const body = (await req.json()) as { messages?: Array<{ role?: string; content?: unknown }> };
                const msgs = Array.isArray(body.messages) ? body.messages : [];
                toolMsgCount = msgs.filter((m) => m.role === "tool").length;
                const firstUser = msgs.find((m) => m.role === "user");
                if (typeof firstUser?.content === "string" && firstUser.content.startsWith("SCENARIO-")) {
                    scenario = firstUser.content;
                }
            } catch {
                /* 解析失败：按默认场景返回 */
            }
            return new Response(buildUpstreamSse(scenario, toolMsgCount), {
                headers: { "content-type": "text/event-stream; charset=utf-8" },
            });
        },
    });
}

// ============================================================
// 断言与工具函数
// ============================================================

interface Check {
    name: string;
    ok: boolean;
    detail: string;
}
const checks: Check[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
    checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
}

/** 读取一次 /stream 响应，解析出全部 SSE 事件对象 */
async function readEvents(resp: Response): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = [];
    if (!resp.body) return events;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
            for (const line of frame.split("\n")) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;   // 跳过心跳注释帧 ": ping"
                try {
                    events.push(JSON.parse(t.slice(5).trim()) as Record<string, unknown>);
                } catch {
                    /* 忽略不可解析帧 */
                }
            }
        }
    }
    return events;
}

function countType(events: Array<Record<string, unknown>>, type: string): number {
    return events.filter((e) => e.type === type).length;
}

function newSessionId(): string {
    return `sess_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

// ============================================================
// 主流程
// ============================================================

const fake = startFakeUpstream();

// 必须在 import 业务模块之前注入环境变量（env.ts 在被 import 时立即校验）
Bun.env.APP_PORT = "0";
Bun.env.LLM_API_BASE = `http://127.0.0.1:${fake.port}/v1`;
Bun.env.LLM_API_KEY = "test-key-not-used-by-fake-upstream";
Bun.env.LLM_MODEL = "fake-model";
Bun.env.LLM_THINKING = "false";
Bun.env.LLM_REASONING_EFFORT = "high";
Bun.env.LLM_LOG_ENABLED = "false";
Bun.env.MAX_TOOL_ROUNDS = "8";
Bun.env.SSE_HEARTBEAT_MS = "60000";

const { default: chatRouter } = await import("../src/routes/chat.ts");
const { getSessionDetail, deleteSession } = await import("../src/infra/session.ts");

const createdSessions: string[] = [];

/** 跑一个场景，返回事件列表与助手消息 */
async function runScenario(scenario: string) {
    upstreamRequests = 0;
    const sessionId = newSessionId();
    createdSessions.push(sessionId);

    const resp = await chatRouter.request("/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: scenario, requestId: `req_${scenario}` }),
    });

    const events = await readEvents(resp);
    const detail = getSessionDetail(sessionId);
    const assistantMsgs = detail.messages.filter((m) => m.role === "assistant");
    return { sessionId, events, assistantMsgs, status: resp.status };
}

try {
    // ── 场景 A：首轮未请求工具 ────────────────────────────────
    const a = await runScenario("SCENARIO-A");
    check("A｜HTTP 200", a.status === 200, a.status);
    check("A｜上游生成次数 = 1", upstreamRequests === 1, upstreamRequests);
    check("A｜无 tool_call 事件", countType(a.events, "tool_call") === 0, countType(a.events, "tool_call"));
    check("A｜text 事件存在", countType(a.events, "text") > 0, countType(a.events, "text"));
    check("A｜finish 恰好 1 条", countType(a.events, "finish") === 1, countType(a.events, "finish"));
    const aMsg = a.assistantMsgs[0];
    check("A｜助手消息落库 1 条", a.assistantMsgs.length === 1, a.assistantMsgs.length);
    check("A｜落库正文非空", (aMsg?.content ?? "").length > 0, aMsg?.content);
    check("A｜meta 无工具记录", !aMsg?.meta?.toolCalls, aMsg?.meta);

    // ── 场景 B：多轮工具链（首轮工具、次轮再工具、末轮正文） ──
    const b = await runScenario("SCENARIO-B");
    const bToolEvents = b.events.filter((e) => e.type === "tool_call");
    const bIds = new Set(bToolEvents.map((e) => e.id));
    const bMeta = b.assistantMsgs[0]?.meta?.toolCalls ?? [];
    check("B｜HTTP 200", b.status === 200, b.status);
    check("B｜上游生成次数 = 3（1 + 2 轮工具）", upstreamRequests === 3, upstreamRequests);
    check("B｜tool_call 事件 = 4 条（每次调用 2 条）", bToolEvents.length === 4, bToolEvents.length);
    check("B｜事件里的调用 id 为 call_1 / call_2", bIds.size === 2 && bIds.has("call_1") && bIds.has("call_2"), [...bIds]);
    check("B｜每条调用都带 result（无遗漏执行）", bToolEvents.filter((e) => "result" in e).length === 2, bToolEvents.filter((e) => "result" in e).length);
    check("B｜finish 恰好 1 条", countType(b.events, "finish") === 1, countType(b.events, "finish"));
    check("B｜最终正文非空", (b.assistantMsgs[0]?.content ?? "").includes("两个工具都执行完了"), b.assistantMsgs[0]?.content);
    check("B｜落库工具记录 = 2 条", bMeta.length === 2, bMeta.length);
    check(
        "B｜落库工具 id 与事件一致（B-04 / AC-07）",
        bMeta.length === 2 && bMeta[0]?.id === "call_1" && bMeta[1]?.id === "call_2",
        bMeta.map((t: { id?: string }) => t.id)
    );

    // ── 场景 C：空正文 + 工具（B-03） ─────────────────────────
    const c = await runScenario("SCENARIO-C");
    const cMeta = c.assistantMsgs[0]?.meta?.toolCalls ?? [];
    const cNotices = c.events.filter((e) => e.type === "notice");
    check("C｜HTTP 200", c.status === 200, c.status);
    check("C｜上游生成次数 = 2", upstreamRequests === 2, upstreamRequests);
    check("C｜tool_call 事件 = 2 条", countType(c.events, "tool_call") === 2, countType(c.events, "tool_call"));
    check("C｜空正文时补 notice（不以空内容收尾）", cNotices.length === 1, cNotices.length);
    check("C｜正文为空但工具记录已落库（B-01）", c.assistantMsgs.length === 1 && cMeta.length === 1, { msgs: c.assistantMsgs.length, tools: cMeta.length });
    check("C｜finish 恰好 1 条", countType(c.events, "finish") === 1, countType(c.events, "finish"));
} catch (err) {
    check("执行未抛异常", false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
} finally {
    // 清理本次产生的会话（不污染本地会话库）
    for (const sid of createdSessions) {
        try {
            deleteSession(sid);
        } catch {
            /* 忽略清理失败 */
        }
    }
    fake.stop(true);
}

// ============================================================
// 结果汇总
// ============================================================
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
    console.log(`${c.ok ? "✅" : "❌"} ${c.name} → ${c.detail}`);
}
console.log("-".repeat(60));
console.log(`共 ${checks.length} 项断言，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length > 0) process.exit(1);
