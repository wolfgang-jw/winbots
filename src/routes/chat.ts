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
 * 本次修复：
 *   - [US-1.1] 统一流式输出：移除分支 B「探测拿到文本后整段回吐」，
 *     无工具调用的回答一律改走流式请求，消除一次性整段输出路径。
 *   - [US-1.2] 保留工具场景流式：分支 A（工具调用 → 阶段二流式）保持 stream:true。
 *   - [US-1.3] 上游不支持工具时的流式兼容：supportsTools 门控。
 *   - [US-2.1~2.4] 会话唯一标识 / 服务端持有历史 / 会话隔离 / 兼容旧接口。
 *   - [US-3.3] 上游取消（止损）：带外取消 + AbortController。
 *   - [US-4.3~4.6] 会话列表 / 详情 / 删除接口。
 *   - [A3 修复] 助手消息落盘时补传渲染元数据（meta）：
 *     pipeStream 现返回 { text, thinking, usage }，两处 appendMessage 写回助手消息时
 *     携带 thinking / toolCalls / usage / model / elapsedMs / interrupted，
 *     使 US-4.4 的「完整重现」（思考/工具/信息栏/中断标识）在端到端数据链路上真正达成。
 *
 * 请求体 (JSON):
 * {
 *   "messages": [ { "role": "user", "content": "你好" } ],
 *   "sessionId": "sess_lx8f2k_3f2504e0-4f89-41d3-9a0c-0305e82c3301",  // US-2.1 可选
 *   "requestId": "req_lx8f2k_3f2504e0-4f89-41d3-9a0c-0305e82c3301"    // US-3.3 可选
 * }
 *
 * 响应 (SSE):
 * data: {"type":"think","content":"思考过程..."}
 * data: {"type":"tool_call","id":"...","name":"local.common.get_current_time","arguments":{}}
 * data: {"type":"text","content":"你"}
 * data: {"type":"finish","reason":"stop","usage":{...},"raw":{...}}
 * data: {"type":"error","message":"错误信息"}
 */
import { Hono } from "hono";
import { env } from "@/infra/env";
import { loadTools, getToolDefinitions, executeTool, toDisplayName } from "@/tools";
import {
    generateSessionId,
    isValidSessionId,
    appendMessage,
    getHistory,
    hasSession,
    listSessions,
    getSessionDetail,
    deleteSession,
    type SessionMessage,
    type MessageMeta,
} from "@/infra/session";
import { registerCancel, cancelRequest, unregisterCancel } from "@/infra/cancel";

const router = new Hono();

/**
 * [US-4.3] 将 epoch 毫秒格式化为本地时区可读文本（YYYY-MM-DD HH:mm:ss）。
 * 纯函数，便于单元测试。
 */
function formatDateTime(epochMs: number): string {
    const d = new Date(epochMs);
    const p = (n: number) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    );
}

/** 上游 usage 的原始结构（OpenAI 兼容） */
interface RawUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}

/** [A3] pipeStream 的返回值：正文 + 思考 + usage（供写回 meta） */
interface PipeResult {
    text: string;
    thinking: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

/**
 * 读取上游 SSE 流，解析 delta，转发为前端事件（think / text / finish）。
 *
 * [A3 修复] 返回值由「纯文本」升级为 PipeResult（text + thinking + usage），
 *   以便 /stream 写回助手消息时携带完整渲染元数据（meta），
 *   使历史重现能还原思考过程、信息栏（含 token/耗时/模型）。
 *
 * [US-3.3] 捕获 AbortError：上游被 /cancel 取消时，reader.read() 会抛 AbortError，
 *   这是「用户主动打断」的正常路径，返回已累积内容交由调用方正常收尾，不误报为错误。
 */
async function pipeStream(
    upstream: ReadableStream<Uint8Array>,
    send: (obj: unknown) => void
): Promise<PipeResult> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // 兜底统计：累计输出字符数（仅在上游不返回 usage 时使用）
    let fallbackCompletionChars = 0;
    let fullText = "";                            // [US-2.2] 累积完整正文，供写回历史
    let fullThinking = "";                        // [A3] 累积思考过程，供写回 meta
    let lastUsage: PipeResult["usage"] = null;    // [A3] 记录上游 usage，供写回 meta

    try {
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

                    if (thinking) {
                        send({ type: "think", content: thinking });
                        fullThinking += thinking;     // [A3] 累积思考过程
                    }
                    if (delta) {
                        // 累计输出字符数（兜底用）
                        fallbackCompletionChars += delta.length;
                        fullText += delta;            // [US-2.2] 同步累积完整正文
                        send({ type: "text", content: delta });
                    }

                    const finishReason = parsed.choices?.[0]?.finish_reason;
                    if (finishReason) {
                        const usage: RawUsage = parsed.usage || {};
                        // 精确优先：上游 completion_tokens；否则用字符数兜底
                        const completionTokens =
                            usage.completion_tokens ?? fallbackCompletionChars;
                        const promptTokens = usage.prompt_tokens ?? 0;
                        // [A3] 记录本次 usage，供写回 meta（历史重现信息栏）
                        lastUsage = {
                            promptTokens,
                            completionTokens,
                            totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
                        };
                        send({
                            type: "finish",
                            reason: finishReason,
                            usage: lastUsage,
                            raw: parsed,
                        });
                    }
                } catch {
                    // 忽略解析失败的行
                }
            }
        }
    } catch (err) {
        // [US-3.3] 上游被取消（/cancel 触发 abort）：正常路径，返回已累积内容。
        if (err instanceof Error && err.name === "AbortError") {
            console.log("⏹️ [US-3.3] 上游请求已被取消，停止读取并收尾");
            return { text: fullText, thinking: fullThinking, usage: lastUsage };
        }
        throw err;                                           // 其他错误：继续上抛
    }

    return { text: fullText, thinking: fullThinking, usage: lastUsage };
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
        const { messages, sessionId, message, requestId } = body;

        // [US-3.3] 校验 requestId（若提供）：非空字符串且长度受限；非法静默忽略。
        const hasRequestId =
            typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128;

        // [US-2.2] 入参双模式：
        //   模式一（新）：{ sessionId, message } → 服务端按 sessionId 存取历史；
        //   模式二（旧）：{ messages }           → 行为与改造前完全一致。
        const useServerHistory = typeof message === "string" && message.length > 0;

        if (!useServerHistory) {
            // 旧模式：messages 必须是非空数组（保持原校验）
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return c.json(
                    { error: "messages 参数必须是非空数组（或提供 message 单条消息）" },
                    400
                );
            }
        } else {
            // 新模式：必须提供合法的 sessionId（否则无法定位会话历史）
            if (!isValidSessionId(sessionId)) {
                return c.json({ error: "使用 message 时 sessionId 必须为合法会话 ID" }, 400);
            }
        }

        // [US-2.3 / US-2.4] 旧模式（无状态）不接受格式合法的 sessionId：明确拒绝；
        //   格式非法/任意非空值一律静默忽略，与旧接口对未知字段的容错一致。
        if (!useServerHistory && isValidSessionId(sessionId)) {
            return c.json(
                {
                    error:
                        "旧模式（messages）不支持 sessionId；如需按会话保存历史，请改用 { sessionId, message } 单条消息模式",
                },
                400
            );
        }

        // [US-2.2] 计算本次请求的上下文消息数组：
        //   - 新模式：读取服务端已存历史（快照） + 本次用户消息；先写用户消息。
        //   - 旧模式：直接使用前端回传的 messages（无状态，行为不变）。
        let contextMessages: SessionMessage[];
        if (useServerHistory) {
            const sid = sessionId as string;
            const isNewSession = !hasSession(sid);
            if (isNewSession) {
                console.log(`🆕 新会话首次写入: ${sid}`);
            }
            const historySnapshot = getHistory(sid);                 // 读取历史快照（深拷贝）
            const userMsg: SessionMessage = { role: "user", content: message };
            appendMessage(sid, userMsg);                             // 先写用户消息（写入即登记会话）
            contextMessages = [...historySnapshot, userMsg];         // 快照 + 本次消息
        } else {
            contextMessages = messages as SessionMessage[];
        }

        // 校验每条消息的格式（允许 tool 角色；tool 消息 content 允许为空）
        const validRoles = ["user", "assistant", "system", "tool"];
        for (const msg of contextMessages) {
            if (!msg.role) {
                return c.json({ error: "每条消息必须包含 role 字段" }, 400);
            }
            if (!validRoles.includes(msg.role)) {
                return c.json(
                    { error: `无效的 role: ${msg.role}，允许: ${validRoles.join("/")}` },
                    400
                );
            }
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
        // [问题 1 修复] 保留工具相关字段：tool_calls / tool_call_id / name。
        const baseBody = {
            model: env.LLM_MODEL,
            messages: contextMessages.map((m: SessionMessage) => {
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
        // [US-1.3] 记录「上游是否支持 tools」的判断结果
        let supportsTools = true;

        // ── [US-3.3] 创建取消句柄并登记 ────────────────────────────
        // 整个 /stream 请求（阶段一探测 + 阶段二/分支 B 流式）共用同一 AbortController。
        const upstreamController = new AbortController();
        if (hasRequestId) {
            registerCancel(requestId as string, upstreamController);
            console.log(`🔗 [US-3.3] 登记取消句柄: ${requestId}`);
        }

        try {
            const probeResp = await fetch(apiUrl, {
                method: "POST",
                headers,
                signal: upstreamController.signal,
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
                supportsTools = true;
            } else {
                const errText = await probeResp.text().catch(() => "");
                console.warn(
                    `⚠️ 阶段一探测失败 (${probeResp.status})，降级为纯文本流式对话。上游返回: ${errText || "(空)"}`
                );
                supportsTools = false;
            }
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                console.log("⏹️ [US-3.3] 阶段一探测已被取消");
            } else {
                console.warn("⚠️ 阶段一探测异常，降级为纯文本对话", err);
            }
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

                    // [A3] 本次回答的渲染元数据（供写回 meta）
                    const startedAt = Date.now();
                    const collectedToolCalls: Array<{ name: string; arguments?: unknown; result?: string }> = [];

                    try {
                        // 分支 A：模型请求了工具调用
                        // [US-1.2] 工具场景保持流式：阶段二请求 stream:true 并调用 pipeStream 逐字推送。
                        if (toolCalls.length > 0) {
                            // 4.1 逐个执行工具，推送 tool_call 事件，并构造回灌消息
                            const toolResultMessages: Array<Record<string, unknown>> = [];
                            for (const tc of toolCalls) {
                                const wireName = tc.function?.name || "";
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
                                    name: displayName,
                                    wireName,
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

                                // [A3] 收集工具调用记录，供写回 meta（历史重现工具段）
                                collectedToolCalls.push({
                                    name: displayName,
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
                                signal: upstreamController.signal,
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

                            const result = await pipeStream(secondResp.body, send);
                            const assistantText = result.text;
                            // [US-2.2 + A3] 助手回复写回会话历史（仅新模式），携带渲染元数据
                            if (useServerHistory && assistantText) {
                                const meta: MessageMeta = {
                                    thinking: result.thinking || undefined,
                                    toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
                                    usage: result.usage ?? undefined,
                                    model: env.LLM_MODEL,
                                    elapsedMs: Date.now() - startedAt,
                                    startedAt,
                                    interrupted: upstreamController.signal.aborted || undefined,
                                };
                                appendMessage(
                                    sessionId as string,
                                    { role: "assistant", content: assistantText },
                                    meta
                                );
                            }
                            return;
                        }

                        // 分支 B：无工具调用 → 一律走流式请求（US-1.1：消除一次性整段输出）
                        // [US-1.3] 上游不支持工具时（supportsTools === false），流式请求去除工具参数。
                        const fallbackResp = await fetch(apiUrl, {
                            method: "POST",
                            headers,
                            signal: upstreamController.signal,
                            body: JSON.stringify({
                                ...baseBody,
                                stream: true,
                                ...(supportsTools && toolDefs.length > 0
                                    ? { tools: toolDefs }
                                    : {}),
                            }),
                        });
                        if (!fallbackResp.ok || !fallbackResp.body) {
                            const t = await fallbackResp.text().catch(() => "");
                            send({ type: "error", message: `LLM API 返回错误: ${t || fallbackResp.status}` });
                            return;
                        }
                        const result = await pipeStream(fallbackResp.body, send);
                        const assistantText = result.text;
                        // [US-2.2 + A3] 助手回复写回会话历史（仅新模式），携带渲染元数据
                        if (useServerHistory && assistantText) {
                            const meta: MessageMeta = {
                                thinking: result.thinking || undefined,
                                usage: result.usage ?? undefined,
                                model: env.LLM_MODEL,
                                elapsedMs: Date.now() - startedAt,
                                startedAt,
                                interrupted: upstreamController.signal.aborted || undefined,
                            };
                            appendMessage(
                                sessionId as string,
                                { role: "assistant", content: assistantText },
                                meta
                            );
                        }
                    } catch (err) {
                        // [US-3.3] 取消（AbortError）属正常路径，不误报为错误。
                        if (err instanceof Error && err.name === "AbortError") {
                            console.log("⏹️ [US-3.3] 上游请求已取消（start 兜底）");
                        } else {
                            const msg = err instanceof Error ? err.message : String(err);
                            send({ type: "error", message: msg });
                        }
                    } finally {
                        // [US-3.3] 注销取消句柄（幂等）。
                        if (hasRequestId) {
                            unregisterCancel(requestId as string);
                        }
                        controller.close();   // 主动关流：作为前端"排空完成"信号
                    }
                },
            })
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `请求处理失败: ${message}` }, 500);
    }
});

/**
 * POST /api/chat/session
 * 新建会话，返回全局唯一的会话 ID（US-2.1）
 * 响应 (200): { "sessionId": "sess_..." }
 */
router.post("/session", (c) => {
    const sessionId = generateSessionId();
    return c.json({ sessionId });
});

/**
 * GET /api/chat/sessions
 * 列出全部会话摘要，按最后活动时间倒序（US-4.3：会话列表，F2-3）
 * 响应 (200): { "sessions": [ { id, title, createdAt, updatedAt, updatedAtText, messageCount } ] }
 */
router.get("/sessions", (c) => {
    const sessions = listSessions();
    const items = sessions.map((s) => ({
        ...s,
        updatedAtText: formatDateTime(s.updatedAt),
    }));
    return c.json({ sessions: items });
});

/**
 * GET /api/chat/sessions/:id
 * 读取单个会话的详情：元信息 + 全部消息（含 meta）（US-4.4：打开历史会话并完整重现）
 * 响应 (200): { "session": {...}, "messages": [ { role, content, meta } ] }
 * 响应 (400): { "error": "会话 ID 格式非法" }
 * 响应 (404): { "error": "会话不存在" }
 */
router.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidSessionId(id)) {
        return c.json({ error: "会话 ID 格式非法" }, 400);
    }
    const detail = getSessionDetail(id);
    if (!detail.session) {
        return c.json({ error: "会话不存在" }, 404);
    }
    return c.json({
        session: {
            ...detail.session,
            updatedAtText: formatDateTime(detail.session.updatedAt),
        },
        messages: detail.messages,
    });
});

/**
 * DELETE /api/chat/sessions/:id
 * 删除指定会话及其全部消息（US-4.6：删除会话，F2-7）
 * 响应 (200): { "ok": true, "deleted": true }
 * 响应 (400): { "error": "会话 ID 格式非法" }
 * 响应 (404): { "error": "会话不存在" }
 */
router.delete("/sessions/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidSessionId(id)) {
        return c.json({ error: "会话 ID 格式非法" }, 400);
    }
    const deleted = deleteSession(id);
    if (!deleted) {
        return c.json({ error: "会话不存在" }, 404);
    }
    return c.json({ ok: true, deleted: true });
});

/**
 * POST /api/chat/cancel
 * 取消一个进行中的上游请求（US-3.3：上游取消 / 止损）
 * 响应 (200): { "ok": true, "cancelled": true | false }
 */
router.post("/cancel", async (c) => {
    let requestId: unknown;
    try {
        const body = await c.req.json();
        requestId = body?.requestId;
    } catch {
        return c.json({ ok: true, cancelled: false });
    }

    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
        return c.json({ ok: true, cancelled: false });
    }

    const cancelled = cancelRequest(requestId);
    if (cancelled) {
        console.log(`⏹️ [US-3.3] 已取消上游请求: ${requestId}`);
    }
    return c.json({ ok: true, cancelled });
});

export default router;
