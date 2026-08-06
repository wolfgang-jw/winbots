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
 * 请求体 (JSON):
 * {
 *   "messages": [
 *     { "role": "user", "content": "你好" }
 *   ]
 * }
 *
 * 响应 (SSE):
 * data: {"type":"think","content":"思考过程..."} 
 * data: {"type":"text","content":"你"}
 * data: {"type":"text","content":"好"}
 * data: {"type":"text","content":"！"}
 * data: {"type":"finish","reason":"stop","usage":{"promptTokens":10,"completionTokens":5,"totalTokens":15}}
 * data: {"type":"error","message":"错误信息"}
 */
import { Hono } from "hono";
import { env } from "@/infra/env";

const router = new Hono();

/**
 * POST /api/chat/stream
 * 流式对话接口
 */
router.post("/stream", async (c) => {
    try {
        // ── 1. 解析请求体 ──────────────────────────────────────────
        const body = await c.req.json();
        const { messages } = body;

        // 校验 messages 参数
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return c.json({ error: "messages 参数必须是非空数组" }, 400);
        }

        // 校验每条消息的格式
        const validRoles = ["user", "assistant", "system"];
        for (const msg of messages) {
            if (!msg.role || !msg.content) {
                return c.json(
                    { error: "每条消息必须包含 role 和 content 字段" },
                    400
                );
            }
            if (!validRoles.includes(msg.role)) {
                return c.json(
                    { error: `无效的 role: ${msg.role}，允许: ${validRoles.join("/")}` },
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

        const apiResponse = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.LLM_API_KEY}`,
            },
            body: JSON.stringify({
                model: env.LLM_MODEL,
                messages: messages.map((m: { role: string; content: string }) => ({
                    role: m.role,
                    content: m.content,
                })),
                stream: true,
                // DeepSeek 思考模式控制（官方文档）：
                // - 开启: thinking.type = "enabled"（默认即开启）
                // - 关闭: thinking.type = "disabled"
                // - 强度: reasoning_effort = "low"/"high"/"max"
                reasoning_effort: env.LLM_REASONING_EFFORT,
                ...(env.LLM_THINKING
                    ? { thinking: { type: "enabled" } }
                    : { thinking: { type: "disabled" } }),
            }),

        });

        // 检查 API 响应状态
        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            return c.json(
                {
                    error: `LLM API 返回错误 (${apiResponse.status})`,
                    detail: errorText || apiResponse.statusText,
                },
                502
            );
        }

        // ── 3. 设置 SSE 响应头 ─────────────────────────────────────
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");
        c.header("X-Accel-Buffering", "no"); // 禁用 Nginx 缓冲

        // ── 4. 返回流式响应 ────────────────────────────────────────
        return c.body(
            new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    let completionTokens = 0;

                    try {
                        // 获取响应体作为 ReadableStream
                        const responseStream = apiResponse.body;
                        if (!responseStream) {
                            throw new Error("API 响应体为空");
                        }

                        const reader = responseStream.getReader();
                        const decoder = new TextDecoder();
                        let buffer = "";

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            // 解码并追加到缓冲区
                            buffer += decoder.decode(value, { stream: true });

                            // 按行处理 SSE 数据
                            const lines = buffer.split("\n");
                            // 最后一个可能是不完整的行，保留到下一次
                            buffer = lines.pop() || "";

                            for (const line of lines) {
                                const trimmed = line.trim();

                                // 跳过空行和注释
                                if (!trimmed || trimmed.startsWith(":")) continue;

                                // 解析 "data: ..." 格式
                                if (trimmed.startsWith("data:")) {
                                    const data = trimmed.slice(5).trim();

                                    // SSE 结束标记
                                    if (data === "[DONE]") continue;

                                    try {
                                        const parsed = JSON.parse(data);

                                        // 提取文本内容（Delta 模式）
                                        const delta =
                                            parsed.choices?.[0]?.delta?.content || "";
                                        const thinking =
                                            parsed.choices?.[0]?.delta?.reasoning_content || "";
                                        if (thinking) {
                                            const thinkPayload = JSON.stringify({
                                                type: "think",
                                                content: thinking,
                                            });
                                            controller.enqueue(
                                                encoder.encode(`data: ${thinkPayload}\n\n`)
                                            );
                                        }
                                        if (delta) {
                                            completionTokens++;
                                            const payload = JSON.stringify({
                                                type: "text",
                                                content: delta,
                                            });
                                            controller.enqueue(
                                                encoder.encode(`data: ${payload}\n\n`)
                                            );
                                        }

                                        // 提取结束原因
                                        const finishReason =
                                            parsed.choices?.[0]?.finish_reason;
                                        if (finishReason) {
                                            const usage = parsed.usage || {};
                                            const finishPayload = JSON.stringify({
                                                type: "finish",
                                                reason: finishReason,
                                                usage: {
                                                    promptTokens: usage.prompt_tokens ?? 0,
                                                    completionTokens: usage.completion_tokens ?? completionTokens,
                                                    totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + completionTokens,
                                                },
                                            });
                                            controller.enqueue(
                                                encoder.encode(`data: ${finishPayload}\n\n`)
                                            );
                                        }
                                    } catch {
                                        // 忽略解析失败的 data 行（如纯文本日志）
                                    }
                                }
                            }
                        }

                        // 如果没有收到 finish 事件（某些 API 行为），手动发送
                        // 这里 reader 已结束，流自然关闭
                    } catch (err) {
                        const errorMessage =
                            err instanceof Error ? err.message : String(err);
                        const errorPayload = JSON.stringify({
                            type: "error",
                            message: errorMessage,
                        });
                        controller.enqueue(
                            encoder.encode(`data: ${errorPayload}\n\n`)
                        );
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
