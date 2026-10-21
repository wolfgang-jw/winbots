/**
 * tests/repro-thinking-fields.ts
 * [需求域 C / C-01~C-06] 思考相关字段「按配置可选下发」的复现用例（假上游，不访问真实模型服务）
 *
 * 目的：把「请求体到底带了哪些思考字段」从「只能看日志猜」变成可重复执行的断言。
 *
 * 覆盖：
 *   ① 纯函数层（C-04 / AC-10）：buildThinkingFields 对 none / effort / thinking / both
 *      四种取值分别产出 {} / {reasoning_effort} / {thinking} / {reasoning_effort, thinking}。
 *   ② 解析层（C-05 默认值）：parseThinkingMode 对缺失 / 非法 / 大小写不符一律回退 none。
 *   ③ 端到端（C-01 / C-02 / AC-09）：LLM_THINKING_MODE=none 时，上游收到的请求体
 *      不含 thinking、不含 reasoning_effort。
 *   ④ 端到端（C-03 / C-04 / AC-10 / AC-11）：thinking / both 时请求体带思考开关字段；
 *      both 且 LLM_THINKING=false 时字段值为 disabled。
 *   ⑤ 端到端（C-06 / AC-12）：mode=none（不下发）时，上游仍返回 reasoning_content，
 *      前端仍收到 think 事件，meta.thinking 仍落库 —— 解析与下发完全解耦。
 *
 * 运行（在 winbots/ 目录下）：
 *   bun run tests/repro-thinking-fields.ts
 *   全部断言通过 → 退出码 0；任一失败 → 退出码 1 并打印失败项。
 *
 * 说明：
 * - 运行时为 Bun（用到 Bun.serve / Bun.env），不引入新依赖（N-10）。
 * - 必须先设置 Bun.env 再动态 import：src/infra/env.ts 在模块加载时就校验环境变量（N-09）。
 * - 端到端用例通过就地修改 env 单例（Object.assign 语义，与热更一致）切换下发方式，
 *   避免为测试写 .env 文件；每次请求都在 handler 内实时读取 env，故立即生效。
 * - 会写本地会话库 winbots/data/winbots.db：脚本结尾用 deleteSession 清理自己产生的会话。
 */

// ============================================================
// 假上游：记录每次请求体 + 固定返回带思考内容的 SSE
// ============================================================

/** 上游收到的请求体（每次请求一条） */
const capturedBodies: Array<Record<string, unknown>> = [];

/** 统计上游请求次数（每轮用例前清零） */
let upstreamRequests = 0;

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

/** 一轮完整响应：两片思考 + 一片正文 + 带 usage 的 finish */
function responseWithThinking(): string {
    return (
        sse({ choices: [{ delta: { reasoning_content: "先想一步：" } }] }) +
        sse({ choices: [{ delta: { reasoning_content: "再想一步。" } }] }) +
        sse({ choices: [{ delta: { content: "这是正文。" } }] }) +
        sse({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }) +
        "data: [DONE]\n\n"
    );
}

function startFakeUpstream() {
    return Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
            upstreamRequests++;
            try {
                capturedBodies.push((await req.json()) as Record<string, unknown>);
            } catch {
                capturedBodies.push({});
            }
            return new Response(responseWithThinking(), {
                headers: { "content-type": "text/event-stream; charset=utf-8" },
            });
        },
    });
}

// ============================================================
// 断言工具
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

/** 取最近一次上游请求体的字段名集合（便于打印与断言） */
function lastBodyKeys(): string[] {
    const body = capturedBodies[capturedBodies.length - 1] ?? {};
    return Object.keys(body).sort();
}

// ============================================================
// 主流程
// ============================================================

const fake = startFakeUpstream();

// 必须在 import 业务模块之前注入环境变量（env.ts 被 import 时立即校验）
Bun.env.APP_PORT = "0";
Bun.env.LLM_API_BASE = `http://127.0.0.1:${fake.port}/v1`;
Bun.env.LLM_API_KEY = "test-key-not-used-by-fake-upstream";
Bun.env.LLM_MODEL = "fake-model";
Bun.env.LLM_THINKING = "true";
Bun.env.LLM_REASONING_EFFORT = "high";
Bun.env.LLM_THINKING_MODE = "none";     // C-05 默认值
Bun.env.LLM_LOG_ENABLED = "false";
Bun.env.SSE_HEARTBEAT_MS = "60000";

const chatModule = await import("../src/routes/chat.ts");
const chatRouter = chatModule.default;
const envModule = await import("../src/infra/env.ts");
const { env, parseThinkingMode } = envModule;
const { getSessionDetail, deleteSession } = await import("../src/infra/session.ts");

const createdSessions: string[] = [];

/** 跑一轮对话：返回事件、落库的助手消息、上游请求体 */
async function runTurn(label: string) {
    upstreamRequests = 0;
    capturedBodies.length = 0;
    const sessionId = newSessionId();
    createdSessions.push(sessionId);

    const resp = await chatRouter.request("/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: label }),
    });

    const events = await readEvents(resp);
    const detail = getSessionDetail(sessionId);
    const assistantMsgs = detail.messages.filter((m) => m.role === "assistant");
    return { sessionId, events, assistantMsgs, status: resp.status, body: capturedBodies[0] ?? {} };
}

try {
    // ── ① 纯函数：四值枚举 → 字段组合（AC-10） ────────────────
    const combos: Array<[string, string[]]> = [
        ["none", []],
        ["effort", ["reasoning_effort"]],
        ["thinking", ["thinking"]],
        ["both", ["reasoning_effort", "thinking"]],
    ];
    for (const [mode, expected] of combos) {
        const fields = chatModule.buildThinkingFields(mode, true, "high");
        const keys = Object.keys(fields).sort();
        check(
            `① buildThinkingFields(${mode}) 字段集合 = [${expected.join(", ")}]`,
            JSON.stringify(keys) === JSON.stringify(expected),
            keys
        );
    }
    const noneFields = chatModule.buildThinkingFields("none", true, "high");
    check("① none 返回空对象（C-02）", Object.keys(noneFields).length === 0, noneFields);
    const bothFields = chatModule.buildThinkingFields("both", false, "max");
    check(
        "① both + LLM_THINKING=false → thinking.type=disabled",
        (bothFields.thinking as { type?: string } | undefined)?.type === "disabled",
        bothFields
    );
    check(
        "① both + 非法/未知 mode 不额外下发字段",
        Object.keys(chatModule.buildThinkingFields("bogus", true, "high")).length === 0,
        chatModule.buildThinkingFields("bogus", true, "high")
    );

    // ── ② 解析层：默认值与兜底（C-05） ───────────────────────
    check("② parseThinkingMode(undefined) = none", parseThinkingMode(undefined) === "none", parseThinkingMode(undefined));
    check('② parseThinkingMode("") = none', parseThinkingMode("") === "none", parseThinkingMode(""));
    check('② parseThinkingMode("bogus") = none', parseThinkingMode("bogus") === "none", parseThinkingMode("bogus"));
    check('② parseThinkingMode("EFFORT") = effort（大小写不敏感）', parseThinkingMode("EFFORT") === "effort", parseThinkingMode("EFFORT"));
    check('② parseThinkingMode("both") = both', parseThinkingMode("both") === "both", parseThinkingMode("both"));
    check("② 启动时 env.LLM_THINKING_MODE = none（默认不下发）", env.LLM_THINKING_MODE === "none", env.LLM_THINKING_MODE);

    // ── ③ 端到端：none 不下发（AC-09） + 思考仍被解析落库（AC-12） ──
    env.LLM_THINKING_MODE = "none";
    env.LLM_THINKING = true;
    const r3 = await runTurn("C-NONE");
    check("③ mode=none｜HTTP 200", r3.status === 200, r3.status);
    check("③ mode=none｜上游生成 1 次", upstreamRequests === 1, upstreamRequests);
    check("③ mode=none｜请求体不含 reasoning_effort", !("reasoning_effort" in r3.body), lastBodyKeys());
    check("③ mode=none｜请求体不含 thinking", !("thinking" in r3.body), lastBodyKeys());
    check("③ mode=none｜请求体仍含 model", r3.body.model === "fake-model", r3.body.model);
    check("③ mode=none｜仍收到 think 事件（C-06）", countType(r3.events, "think") === 2, countType(r3.events, "think"));
    check(
        "③ mode=none｜思考内容仍落库（C-06）",
        (r3.assistantMsgs[0]?.meta?.thinking ?? "").includes("先想一步"),
        r3.assistantMsgs[0]?.meta?.thinking
    );
    check("③ mode=none｜正文仍正常落库", (r3.assistantMsgs[0]?.content ?? "").includes("这是正文"), r3.assistantMsgs[0]?.content);

    // ── ④ both：两个字段都下发，取值来自两个「取值来源」 ──────
    env.LLM_THINKING_MODE = "both";
    env.LLM_THINKING = true;
    const r4 = await runTurn("C-BOTH-ON");
    check("④ mode=both｜请求体含 reasoning_effort=high", r4.body.reasoning_effort === "high", r4.body.reasoning_effort);
    check(
        "④ mode=both｜请求体含 thinking.type=enabled",
        (r4.body.thinking as { type?: string } | undefined)?.type === "enabled",
        r4.body.thinking
    );
    check("④ mode=both｜仍收到 think 事件", countType(r4.events, "think") === 2, countType(r4.events, "think"));

    env.LLM_THINKING = false;
    const r4b = await runTurn("C-BOTH-OFF");
    check(
        "④ mode=both + LLM_THINKING=false｜thinking.type=disabled",
        (r4b.body.thinking as { type?: string } | undefined)?.type === "disabled",
        r4b.body.thinking
    );

    // ── ⑤ 单字段模式 ─────────────────────────────────────────
    env.LLM_THINKING_MODE = "thinking";
    env.LLM_THINKING = true;
    const r5 = await runTurn("C-THINKING-ONLY");
    check("⑤ mode=thinking｜请求体不含 reasoning_effort", !("reasoning_effort" in r5.body), lastBodyKeys());
    check(
        "⑤ mode=thinking｜请求体含 thinking.type=enabled",
        (r5.body.thinking as { type?: string } | undefined)?.type === "enabled",
        r5.body.thinking
    );

    env.LLM_THINKING_MODE = "effort";
    const r6 = await runTurn("C-EFFORT-ONLY");
    check("⑥ mode=effort｜请求体不含 thinking", !("thinking" in r6.body), lastBodyKeys());
    check("⑥ mode=effort｜请求体含 reasoning_effort=high", r6.body.reasoning_effort === "high", r6.body.reasoning_effort);
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
