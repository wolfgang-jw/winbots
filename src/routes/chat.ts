/**
 * POST /api/chat/stream
 *
 * 流式 LLM 对话接口
 * 直接使用 fetch 调用 OpenAI 兼容的 Chat Completions API（/v1/chat/completions）
 * 通过 SSE (Server-Sent Events) 将流式数据推送给前端
 *
 * 为什么不用 @ai-sdk/openai 的 streamText？
 * streamText 默认使用 OpenAI 最新的 Responses API（/v1/responses），
 * 而 DeepSeek 等第三方 API 只兼容传统的 Chat Completions API（/v1/chat/completions），
 * 会导致 404 错误。因此直接使用 fetch + 原生 API 更通用、更可控。
 *
 * R1 工具调用能力（方案 A：后端执行 + 单轮）：
 * 采用「两阶段链路」——
 *   阶段一：携带 tools 定义，非流式探测模型是否请求工具调用（tool_calls）；
 *   阶段二：若命中工具，后端执行工具并回灌 role:"tool" 消息，再流式生成最终回答。
 * 无工具调用 / 上游不支持 tools / 工具异常时，均优雅降级为纯文本流式对话。
 *
 * R1.1 修复：
 *   - 阶段一探测失败时打印上游错误正文（此前只打印状态码，无法定位 400）
 *   - 若探测失败疑似「上游不支持 tools」，自动去掉 tools 重试一次非流式探测，
 *     命中则回吐文本，避免无谓地再发起一次流式请求
 *
 * 本次修复：
 *   - [问题 1] baseBody.messages 保留 tool_calls / tool_call_id / name 字段，
 *     避免多轮或回灌场景丢失工具字段导致上游 400。
 *   - [问题 2] tool_call 事件推送可读的 callName（toDisplayName），
 *     并额外保留 wireName 便于排查。
 *   - [问题 3] 阶段一降级重试保留上游 usage，分支 B 回吐时不再返回空 usage/raw。
 *   - [问题 4] pipeStream 精确统计 token：优先采用上游 usage.completion_tokens，
 *     上游未返回时才用「累计字符数」作为兜底（不再用 chunk 计数冒充 token 数）。
 *
 * 请求体 (JSON):
 * {
 *   "messages": [
 *     { "role": "user", "content": "你好" }
 *   ]
 * }
 *
 * 响应 (SSE):
 * data: {"type":"think","content":"思考过程..."}
 * data: {"type":"tool_call","id":"...","name":"local.common.get_current_time","arguments":{}}
 * data: {"type":"tool_call","id":"...","name":"local.common.get_current_time","arguments":{},"result":"{...}"}
 * data: {"type":"text","content":"你"}
 * data: {"type":"text","content":"好"}
 * data: {"type":"text","content":"！"}
 * data: {"type":"finish","reason":"stop","usage":{"promptTokens":10,"completionTokens":5,"totalTokens":15},"raw":{...}}
 * data: {"type":"error","message":"错误信息"}
 */
import { Hono } from "hono";
import { env } from "@/infra/env";
import { loadTools, getToolDefinitions, executeTool, toDisplayName } from "@/tools";   // R1: 工具调用能力

const router = new Hono();

/** 上游 usage 的原始结构（OpenAI 兼容） */
interface RawUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}

/**
 * 读取上游 SSE 流，解析 delta，转发为前端事件
 * 复用现有解析逻辑（think / text / finish）
 *
 * [问题 4] token 精确统计策略：
 *   - 权威值：上游在最后一个 chunk 返回的 usage.completion_tokens（精确）；
 *   - 兜底值：上游未返回 usage 时，累计「输出文本字符数」作为近似，
 *     字段名与注释均明确其为字符数，不再把 chunk 数量当作 token 数。
 */
async function pipeStream(
    upstream: ReadableStream<Uint8Array>,
    send: (obj: unknown) => void
): Promise<void> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // 兜底统计：累计输出字符数（仅在上游不返回 usage 时使用）
    let fallbackCompletionChars = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content || "";
                const thinking = parsed.choices?.[0]?.delta?.reasoning_content || "";

                if (thinking) send({ type: "think", content: thinking });
                if (delta) {
                    // 累计输出字符数（兜底用）
                    fallbackCompletionChars += delta.length;
                    send({ type: "text", content: delta });
                }

                const finishReason = parsed.choices?.[0]?.finish_reason;
                if (finishReason) {
                    const usage: RawUsage = parsed.usage || {};
                    // 精确优先：上游 completion_tokens；否则用字符数兜底
                    const completionTokens =
                        usage.completion_tokens ?? fallbackCompletionChars;
                    const promptTokens = usage.prompt_tokens ?? 0;
                    send({
                        type: "finish",
                        reason: finishReason,
                        usage: {
                            promptTokens,
                            completionTokens,
                            totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
                        },
                        raw: parsed,
                    });
                }
            } catch {
                // 忽略解析失败的行
            }
        }
    }
}

/**
 * POST /api/chat/stream
 * 流式对话接口（R1：两阶段工具调用）
 */
router.post("/stream", async (c) => {
    try {
        await loadTools();   // R1：确保工具注册表已构建（幂等，失败可重试）

        // ── 1. 解析请求体 ──────────────────────────────────────────
        const body = await c.req.json();
        const { messages } = body;

        // 校验 messages 参数
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return c.json({ error: "messages 参数必须是非空数组" }, 400);
        }

        // 校验每条消息的格式
        // 说明：允许 tool 角色（工具结果回灌），tool 消息的 content 允许为空
        const validRoles = ["user", "assistant", "system", "tool"];
        for (const msg of messages) {
            if (!msg.role) {
                return c.json({ error: "每条消息必须包含 role 字段" }, 400);
            }
            if (!validRoles.includes(msg.role)) {
                return c.json(
                    { error: `无效的 role: ${msg.role}，允许: ${validRoles.join("/")}` },
                    400
                );
            }
            // assistant 携带 tool_calls 时 content 可为空；tool 消息 content 可为空
            const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
            if (
                msg.role !== "tool" &&
                !hasToolCalls &&
                (msg.content === undefined || msg.content === null)
            ) {
                return c.json(
                    { error: "非 tool 消息必须包含 content 字段" },
                    400
                );
            }
        }

        // ── 2. 构建 Chat Completions API 请求 ──────────────────────
        // 自动处理 API Base URL：
        // - 如果 LLM_API_BASE 末尾已有 /v1，则直接拼接 /chat/completions
        // - 如果末尾没有 /v1，则自动补全 /v1/chat/completions
        const base = env.LLM_API_BASE.replace(/\/+$/, "");
        const apiUrl = base.endsWith("/v1")
            ? `${base}/chat/completions`
            : `${base}/v1/chat/completions`;

        // 公共请求头
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.LLM_API_KEY}`,
        };

        // 公共请求体（不含 stream / tools，按阶段拼装）
        // DeepSeek 思考模式控制（官方文档）：
        // - 开启: thinking.type = "enabled"（默认即开启）
        // - 关闭: thinking.type = "disabled"
        // - 强度: reasoning_effort = "low"/"high"/"max"
        //
        // [问题 1 修复] 保留工具相关字段：tool_calls / tool_call_id / name。
        // 此前仅保留 role/content，会丢弃历史消息中的工具字段，
        // 与 5.4「允许 tool 角色」的设计自相矛盾，多轮/回灌场景会触发上游 400。
        const baseBody = {
            model: env.LLM_MODEL,
            messages: messages.map((m: {
                role: string;
                content: string | null;
                tool_calls?: unknown;
                tool_call_id?: string;
                name?: string;
            }) => {
                const out: Record<string, unknown> = { role: m.role, content: m.content };
                if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
                if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
                if (m.name !== undefined) out.name = m.name;
                return out;
            }),
            reasoning_effort: env.LLM_REASONING_EFFORT,
            ...(env.LLM_THINKING
                ? { thinking: { type: "enabled" } }
                : { thinking: { type: "disabled" } }),
        };

        // ── 阶段一：非流式探测工具调用意图 ─────────────────────────
        const toolDefs = getToolDefinitions();
        let toolCalls: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
        }> = [];
        let probeContent = "";
        // [问题 3 修复] 保存探测/降级重试拿到的 usage，供分支 B 回吐时使用
        let probeUsage: RawUsage = {};

        try {
            const probeResp = await fetch(apiUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    ...baseBody,
                    stream: false,
                    ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
                }),
            });

            if (probeResp.ok) {
                const probeJson = await probeResp.json();
                const choice = probeJson.choices?.[0];
                toolCalls = choice?.message?.tool_calls || [];
                probeContent = choice?.message?.content || "";
                probeUsage = probeJson.usage || {};
            } else {
                // 上游可能不支持 tools 参数 → 打印错误正文并降级（不抛错）
                const errText = await probeResp.text().catch(() => "");
                console.warn(
                    `⚠️ 阶段一探测失败 (${probeResp.status})，降级为纯文本对话。上游返回: ${errText || "(空)"}`
                );

                // 若疑似「不支持 tools」，去掉 tools 重试一次非流式探测
                // 目的：命中则直接回吐文本，避免再发起一次流式请求
                try {
                    const retryResp = await fetch(apiUrl, {
                        method: "POST",
                        headers,
                        body: JSON.stringify({ ...baseBody, stream: false }),
                    });
                    if (retryResp.ok) {
                        const retryJson = await retryResp.json();
                        probeContent = retryJson.choices?.[0]?.message?.content || "";
                        probeUsage = retryJson.usage || {};   // [问题 3] 保留 usage
                    } else {
                        const retryErr = await retryResp.text().catch(() => "");
                        console.warn(
                            `⚠️ 阶段一降级重试仍失败 (${retryResp.status})。上游返回: ${retryErr || "(空)"}`
                        );
                    }
                } catch (retryErr) {
                    console.warn("⚠️ 阶段一降级重试异常", retryErr);
                }
            }
        } catch (err) {
            console.warn("⚠️ 阶段一探测异常，降级为纯文本对话", err);
        }

        // ── 3. 设置 SSE 响应头 ─────────────────────────────────────
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");
        c.header("X-Accel-Buffering", "no"); // 禁用 Nginx 缓冲

        // ── 4. 分支：有工具调用 → 执行 + 阶段二流式；无 → 降级流式 ──
        return c.body(
            new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    const send = (obj: unknown) =>
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

                    try {
                        // 分支 A：模型请求了工具调用
                        if (toolCalls.length > 0) {
                            // 4.1 逐个执行工具，推送 tool_call 事件，并构造回灌消息
                            const toolResultMessages: Array<Record<string, unknown>> = [];
                            for (const tc of toolCalls) {
                                const wireName = tc.function?.name || "";
                                // [问题 2 修复] 展示用可读 callName
                                const displayName = toDisplayName(wireName);
                                let args: Record<string, unknown> = {};
                                try {
                                    args = tc.function?.arguments
                                        ? JSON.parse(tc.function.arguments)
                                        : {};
                                } catch {
                                    args = {};
                                }

                                // 推送「工具调用发生」事件（前端展示，默认收起）
                                send({
                                    type: "tool_call",
                                    id: tc.id,
                                    name: displayName,      // 可读名（callName）
                                    wireName,               // 原始名（便于排查）
                                    arguments: args,
                                });

                                // 后端执行（executeTool 内部已兜底异常）
                                const result = await executeTool(wireName, args);

                                // 推送「工具结果」事件
                                send({
                                    type: "tool_call",
                                    id: tc.id,
                                    name: displayName,
                                    wireName,
                                    arguments: args,
                                    result,
                                });

                                toolResultMessages.push({
                                    role: "tool",
                                    tool_call_id: tc.id,
                                    content: result,
                                });
                            }

                            // 4.2 阶段二：回灌 assistant(tool_calls) + tool 结果，流式请求
                            // 注意：tool_calls 原样回灌（含模型返回的 function.name），
                            // 以符合 OpenAI 协议对 tool_call_id 配对的要求。
                            const secondMessages = [
                                ...baseBody.messages,
                                {
                                    role: "assistant",
                                    content: probeContent || null,
                                    tool_calls: toolCalls,
                                },
                                ...toolResultMessages,
                            ];

                            const secondResp = await fetch(apiUrl, {
                                method: "POST",
                                headers,
                                body: JSON.stringify({
                                    ...baseBody,
                                    messages: secondMessages,
                                    stream: true,
                                }),
                            });

                            if (!secondResp.ok || !secondResp.body) {
                                const t = await secondResp.text().catch(() => "");
                                send({ type: "error", message: `阶段二请求失败: ${t || secondResp.status}` });
                                return;
                            }

                            await pipeStream(secondResp.body, send);
                            return;
                        }

                        // 分支 B：无工具调用 → 降级为纯文本流式
                        // 若探测已拿到完整文本，直接以流式回吐；否则重新发起流式请求
                        if (probeContent) {
                            send({ type: "text", content: probeContent });
                            // [问题 3 修复] 回吐真实 usage/raw，避免信息栏显示 0 tokens / unknown
                            const p = probeUsage.prompt_tokens ?? 0;
                            const cTok = probeUsage.completion_tokens ?? probeContent.length;
                            send({
                                type: "finish",
                                reason: "stop",
                                usage: {
                                    promptTokens: p,
                                    completionTokens: cTok,
                                    totalTokens: probeUsage.total_tokens ?? p + cTok,
                                },
                                raw: { model: env.LLM_MODEL, usage: probeUsage },
                            });
                            return;
                        }

                        const fallbackResp = await fetch(apiUrl, {
                            method: "POST",
                            headers,
                            body: JSON.stringify({ ...baseBody, stream: true }),
                        });
                        if (!fallbackResp.ok || !fallbackResp.body) {
                            const t = await fallbackResp.text().catch(() => "");
                            send({ type: "error", message: `LLM API 返回错误: ${t || fallbackResp.status}` });
                            return;
                        }
                        await pipeStream(fallbackResp.body, send);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        send({ type: "error", message: msg });
                    } finally {
                        controller.close();
                    }
                },
            })
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `请求处理失败: ${message}` }, 500);
    }
});

export default router;
