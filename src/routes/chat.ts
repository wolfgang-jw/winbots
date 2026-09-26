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
 *   - [US-1.1] 统一流式输出：移除分支 B「探测拿到文本后整段回吐」，
 *     无工具调用的回答一律改走流式请求，消除一次性整段输出路径。
 *   - [US-1.2] 保留工具场景流式：确认分支 A（工具调用 → 阶段二流式）不受 US-1.1 影响，
 *     阶段二请求保持 stream:true 并经 pipeStream 逐字推送，工具场景与普通问答体验一致。
 *   - [US-1.3] 上游不支持工具时的流式兼容：新增 supportsTools 状态记录探测结论，
 *     探测失败即判定「不支持工具」并移除已失效的非流式降级重试；
 *     后续流式请求据 supportsTools 去除工具参数，避免上游 400，回答仍正常逐字返回。
 *   - [US-2.1] 会话唯一标识：新增 src/infra/session.ts 生成全局唯一会话 ID；
 *     新增 POST /api/chat/session 分配 ID，/stream 接收并校验可选 sessionId，
 *     前端新建会话时获取并随请求携带，为后续会话隔离与持久化奠定标识基础。
 *   - [US-2.2] 服务端持有会话历史：扩展 src/infra/session.ts 新增内存态会话历史存取
 *     （appendMessage / getHistory / clearHistory，上限 MAX_HISTORY=20）；
 *     /stream 支持单条 message + sessionId 入参，按会话读取历史并拼接本次消息作为上下文，
 *     消息格式校验改为遍历 contextMessages（避免新模式 messages 为 undefined 时崩溃），
 *     用户消息先写、助手回复（pipeStream 累积完整正文）后写回历史；
 *     前端改为只发送单条 message，不再回传 messages 历史数组（保留旧入参兼容）。
 *   - [US-2.3] 会话隔离：
 *     P2 旧模式（messages）明确不接受 sessionId，携带即 400，杜绝误用导致会话边界模糊；
 *     P3 新模式写入前用 hasSession 判定会话归属，首次写入仅记录日志（不拒绝），
 *        强化隔离边界的可观测性（隔离硬保证仍由 Map 按 key 提供）。
 *   - [US-2.4] 兼容旧接口（F1-5）：收窄旧模式 sessionId 的拒绝范围——
 *     仅当 sessionId 格式合法时才 400；格式非法/任意非空值一律静默忽略，
 *     与改造前旧接口对未知字段的容错行为保持一致，保证既有调用方式不受影响。
 *
 * 请求体 (JSON):
 * {
 *   "messages": [
 *     { "role": "user", "content": "你好" }
 *   ],
 *   "sessionId": "sess_lx8f2k_3f2504e0-4f89-41d3-9a0c-0305e82c3301"   // US-2.1 可选
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
// US-2.1: 会话唯一标识；US-2.2: 会话历史存取；US-2.3: 会话隔离（hasSession）
import {
    generateSessionId,
    isValidSessionId,
    appendMessage,
    getHistory,
    hasSession,
    type SessionMessage,
} from "@/infra/session";

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
 *
 * [US-2.2] 返回值改为「累积的完整正文」，供 /stream 写回会话历史。
 */
async function pipeStream(
    upstream: ReadableStream<Uint8Array>,
    send: (obj: unknown) => void
): Promise<string> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // 兜底统计：累计输出字符数（仅在上游不返回 usage 时使用）
    let fallbackCompletionChars = 0;
    let fullText = "";                            // [US-2.2] 累积完整正文，供写回历史

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

    return fullText;                              // [US-2.2] 返回完整正文
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
        // US-2.2：新增单条消息入参 message；保留 messages 以兼容旧调用方
        const { messages, sessionId, message } = body;

        // [US-2.2] 入参双模式：
        //   模式一（新，服务端持有历史）：{ sessionId, message } → 服务端按 sessionId 存取历史；
        //   模式二（旧，无状态）：        { messages }           → 行为与改造前完全一致。
        // 判定规则：提供 message 即走模式一；否则要求 messages（模式二）。
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

        // [US-2.3] 旧模式（无状态）不接受 sessionId：
        //   旧模式的历史由前端全量回传，服务端不读写任何会话存储；
        //   若旧模式携带**格式合法的** sessionId，说明调用方想用会话功能却用错了模式，
        //   一律拒绝并给出明确指引，避免误以为「已落盘/已续接会话」（F1-3 会话隔离）。
        // [US-2.4] 兼容旧接口（F1-5）：收窄拒绝范围——
        //   仅当 sessionId **格式合法**时才拒绝；格式非法/任意非空值一律「静默忽略」，
        //   与改造前旧接口对未知字段的容错行为保持一致，避免旧调用方因误带无关字段而 400。
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
        //   - 新模式：读取服务端已存历史（快照） + 本次用户消息；
        //     同时先把本次用户消息写入历史（先写用户消息，保证模型失败也不丢）。
        //   - 旧模式：直接使用前端回传的 messages（无状态，行为不变）。
        let contextMessages: SessionMessage[];
        if (useServerHistory) {
            const sid = sessionId as string;
            // [US-2.3] 会话归属判定：区分「续接已有会话」与「首次写入（隐式新建）」。
            // 说明：Map 以 sessionId 为 key，天然硬隔离——即便 sid 错误，
            //       也只会写入该 sid 自己的历史，绝不污染其他会话。
            //       此处仅做可观测性记录，便于排查异常/伪造 ID。
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

        // 校验每条消息的格式
        // 说明：允许 tool 角色（工具结果回灌），tool 消息的 content 允许为空
        // [US-2.2] 改为遍历 contextMessages：新模式 messages 为 undefined，
        //          若仍遍历 messages 会抛 TypeError；contextMessages 已统一两种模式的数据来源。
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
            messages: contextMessages.map((m: SessionMessage) => {   // ← [US-2.2] 改用 contextMessages
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
        // [US-1.3] 记录「上游是否支持 tools」的判断结果：
        //   - 探测成功（含上游静默忽略 tools）→ true
        //   - 探测因 tools 失败（非 2xx）→ false
        // 后续流式请求据此决定是否携带工具参数（F4-6）。
        let supportsTools = true;

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
                // [US-1.3] 探测成功 → 上游接受 tools 参数，标记为支持工具
                supportsTools = true;
            } else {
                // 上游可能不支持 tools 参数 → 打印错误正文并降级（不抛错）
                const errText = await probeResp.text().catch(() => "");
                console.warn(
                    `⚠️ 阶段一探测失败 (${probeResp.status})，降级为纯文本流式对话。上游返回: ${errText || "(空)"}`
                );

                // [US-1.3] 探测失败（疑似上游不支持 tools）→ 标记为不支持工具。
                // 说明：US-1.1 已移除「整段回吐」分支，此处原先的「非流式降级重试」
                // 所拿到的文本已无人使用（其 toolCalls 必为空，不会进入分支 A），
                // 属于多余请求，故移除；「上游不支持工具」的兜底统一交由分支 B 的
                // 流式请求完成（分支 B 不携带 tools，天然兼容）。
                supportsTools = false;
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
                        // [US-1.2] 工具场景保持流式：阶段二请求 stream:true 并调用 pipeStream 逐字推送，
                        // 与分支 B 的流式行为一致；本分支不因 US-1.1 的改动而改变。
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

                            const assistantText = await pipeStream(secondResp.body, send);
                            // [US-2.2] 助手回复写回会话历史（仅新模式）
                            if (useServerHistory && assistantText) {
                                appendMessage(sessionId as string, {
                                    role: "assistant",
                                    content: assistantText,
                                });
                            }
                            return;
                        }

                        // 分支 B：无工具调用 → 一律走流式请求（US-1.1：消除一次性整段输出）
                        // 说明：不再判断 probeContent 是否已有文本，统一发起流式请求，
                        // 保证所有回答均具备逐字过程，输出方式一致，且可被打断。
                        // [US-1.3] 上游不支持工具时（supportsTools === false），流式请求去除工具参数，
                        // 避免上游因无法识别 tools 而返回 400；上游支持工具时才按需携带。
                        const fallbackResp = await fetch(apiUrl, {
                            method: "POST",
                            headers,
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
                        const assistantText = await pipeStream(fallbackResp.body, send);
                        // [US-2.2] 助手回复写回会话历史（仅新模式）
                        if (useServerHistory && assistantText) {
                            appendMessage(sessionId as string, {
                                role: "assistant",
                                content: assistantText,
                            });
                        }
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

/**
 * POST /api/chat/session
 * 新建会话，返回全局唯一的会话 ID（US-2.1：会话唯一标识）
 *
 * 说明：
 * - 本接口只负责「分配唯一 ID」，不创建任何存储记录（存储属 US-2.2 / US-4.1）。
 * - 前端在「新建会话」时调用本接口获取 ID，之后该会话的所有请求复用此 ID。
 *
 * 响应 (200):
 * { "sessionId": "sess_lx8f2k_3f2504e0-4f89-41d3-9a0c-0305e82c3301" }
 */
router.post("/session", (c) => {
    const sessionId = generateSessionId();
    return c.json({ sessionId });
});

export default router;
