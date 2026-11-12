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
 * [需求域 A / v0.0.7] 上游请求单链路化（US-A-01 ~ US-A-05）
 *   - 一次用户请求只走一条链路：以流式请求为唯一生成入口，以流式聚合出的
 *     tool_calls 作为「是否进入工具轮次」的唯一判据（A-03）。
 *   - 上游生成次数：无工具 = 1；N 轮工具 = 1 + N（A-01）。每次生成打一行
 *     `📡 [A-05] 上游生成 #n`，链路结束打一行 `📊 [A-05] 上游生成次数=…`，
 *     便于按「请求次数 + usage」验收（A-05）。
 *   - 已删除：阶段一非流式探测请求、探测返回正文的回灌路径、
 *     「分支 A / 分支 B」两套并行逻辑（A-02、A-04、B-02）。
 *   - 首轮遭遇「上游拒绝带 tools 的请求」（4xx）时，去掉 tools 重试一次，
 *     保持原有「上游不支持工具则优雅降级」的对外行为（A-06）。
 *   - pipeStream 的流式聚合逻辑未改动（A-07）；工具轮数上限沿用
 *     env.MAX_TOOL_ROUNDS（默认 8，语义不变，A-08）。
 *
 * [需求域 B / v0.0.7] 工具调用全链路不丢失（US-B-01 ~ US-B-04）
 *   - B-01/B-02：工具的执行、事件推送、记录、回灌只有一处调用点（主循环内
 *     `for (const tc of currentToolCalls)` → `executeTool`），不存在「只取正文、
 *     忽略 tool_calls」的第二条路径；`stream:false` 探测已随 A 域删除。
 *   - B-03：是否结束链路只看「本轮是否聚合出 tool_calls」，与正文是否为空无关；
 *     链路收尾时若正文为空但确实执行过工具，追加一条 notice 显式告知，
 *     不让前端停在空气泡。
 *   - B-04：调用日志与历史 meta 的工具字段统一为 `{ id, name, arguments, result }`，
 *     id 与 tool_call 事件一致；异常路径也不再写入未经整形的原始 wire 结构。
 *   - B-06：以上改动均在服务端历史模式（useServerHistory）分支内，旧消息模式
 *     （直接传 messages 数组）的请求/响应行为与事件序列不变。
 *
 * [需求域 C / v0.0.7] 思考相关字段按配置可选下发（US-C-01 ~ US-C-05）
 *   - C-01/C-02：`thinking` 与 `reasoning_effort` 不再无条件写入请求体；仅在
 *     LLM_THINKING_MODE 允许时才下发，none（默认）时请求体不含这两个字段。
 *   - C-04：下发方式为四值枚举 none / effort / thinking / both，由纯函数
 *     buildThinkingFields 组装，不做「单一布尔 + 组合猜测」。
 *   - C-06：解析上游思考内容（delta.reasoning_content）与本配置完全解耦 ——
 *     无论是否下发，`think` 事件与 meta.thinking 落库照旧。
 *
 * [需求域 T / v0.0.7] 平台工具能力扩展（US-T-01 ~ US-T-05；本文件只承担 T-04 的接线）
 *   - T-01/T-02：工具定义快照仍按「每次请求取一次」获取（见下方 `const toolDefs = getToolDefinitions()`），
 *     过滤（enabled 判定）发生在 getToolDefinitions 内部，故热更后下一请求即刻生效，无需重启。
 *   - T-03/T-04：工具执行时把 `{ signal, sessionId }` 作为上下文透传给 executeTool →
 *     handler 第二参；用户点「停止」时在途工具可据此中止，本轮剩余工具也会被跳过。
 *   - T-05/T-06 在 src/tools/index.ts 内实现（已禁用信封、结果长度兜底），本文件无需改动。
 *
 * 历史修复记录（保留以便追溯，均已完成）：
 *   - [US-1.1~1.3] 统一流式输出；上游不支持工具时的流式兼容。
 *   - [US-2.1~2.4] 会话唯一标识 / 服务端持有历史 / 会话隔离 / 兼容旧接口。
 *   - [US-3.3] 上游取消（止损）：带外取消 + AbortController。
 *   - [US-4.3~4.6] 会话列表 / 详情 / 删除接口。
 *   - [A3] 助手消息落盘时补传渲染元数据（meta）。
 *   - [US-HF-1~4] 阶段二补传 tools；pipeStream 聚合 delta.tool_calls；多轮工具循环；DSML 兜底。
 *   - [US-HF-6] 中间轮不推送 finish，链路结束后统一补发；正文 / 思考跨轮累积。
 *   - [US-LOG-3 / FIX / FIX2] LLM 对话日志旁路采集与异常路径收尾。
 *   - [US-STAB-1/3/4] SSE 心跳保活；轮次上限截断显式告知；clientGone 可观测。
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
 * data: {"type":"notice","message":"已达工具调用轮次上限（8 轮），任务可能未完成，可继续追问。"}
 * data: {"type":"finish","reason":"stop","usage":{...},"raw":{...}}
 * data: {"type":"error","message":"错误信息"}
 */
import { Hono } from "hono";
import { env } from "@/infra/env";
// [T-HOT / §4.1] 工具注册表不再有「一次性加载」入口，改为「指纹校验 + 可重入扫描」的门面
import { ensureToolRegistry, getToolDefinitions, executeTool, toDisplayName } from "@/tools";
// [skill / 升级 §3.1、§3.2] skill 子系统：指纹校验 + 多技能装配（不再收窄工具面）
import { ensureSkillRegistry, assembleForRequestMulti } from "@/skills";
// [agent / 第 5 步 §3] system 三段式装配（人设 → 技能 → 基础）；只从门面取，不直连 ./prompt。
// [agent / 第 6 步 §4] 绑定解析、注册表、判据函数；同样只从门面取（V27：零直连）。
import {
    buildSystemText, fitSystemBudget,
    ensureAgentRegistry, getAgentRegistry, resolveBinding,
    isSkillAllowedByPolicy, denyAllToolFilter,
    // [agent / 第 7 步 模块 6a] LLM 查表纯函数 + 结果类型（llm[] 由本文件从 env.json 注入）
    resolveLlm, type ResolvedLlm,
    // 【D-1】默认智能体的保留 uid：首问未选智能体时绑定它（需求 1）
    DEFAULT_AGENT_UID,
} from "@/agents";
// [agent / 第 6 步 F3] env 不暴露 llm[]，合法 llm 名字集合必须从 env.json 直接取。
// [agent / 第 7 步] 同一份 llm[] 也用于 agent 的 LLM 解析 —— 见 C2。
// [BR-4 / BR-6] foldLlmName（名字比较口径）、resolveDefaultLlmName（默认组来源）
import { loadEnvJson, foldLlmName, resolveDefaultLlmName } from "@/infra/envJson";
import {
    generateSessionId,
    isValidSessionId,
    appendMessage,
    getHistory,
    hasSession,
    listSessions,
    getSessionDetail,
    deleteSession,
    // [agent / 第 6 步 A14] 会话 ↔ agent 绑定读写（存储层的唯一入口）
    getSessionAgentBinding,
    bindSessionAgent,
    type SessionMessage,
    type MessageMeta,
} from "@/infra/session";
import { registerCancel, cancelRequest, unregisterCancel } from "@/infra/cancel";
// [Sprint 5.1 / US-LOG-3] LLM 对话日志（旁路采集）
import { appendLlmLog } from "@/infra/llmLog";

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
    // [US-HF-2] 聚合后的流式工具调用（供多轮循环判断「本轮是否又请求工具」）
    toolCalls: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
    }>;
    // [US-HF-6] 上游结束原因与最后一个带 finish_reason 的原始 chunk。
    //   主链路中间轮不发 finish 事件，由调用方在链路结束后统一补发，
    //   故需把 finish 所需信息（reason / raw）随返回值带出。
    finishReason: string | null;
    raw: unknown;
}

/**
 * [Sprint 5.1 / US-LOG-3-FIX] 上游流读取异常（非 AbortError）。
 * 携带异常发生前已累积的内容，供调用方写日志 / 收尾，避免"内容清空 + 无日志"。
 */
class UpstreamStreamError extends Error {
    partial: {
        text: string;
        thinking: string;
        toolCalls: PipeResult["toolCalls"];
        usage: PipeResult["usage"];
        finishReason: string | null;
        raw: unknown;
    };
    constructor(cause: unknown, partial: UpstreamStreamError["partial"]) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "UpstreamStreamError";
        this.partial = partial;
    }
}

/**
 * [需求域 B / B-04] 解析流式聚合得到的工具参数 JSON 串。
 *
 * 用途：让「执行工具时用的参数」与「写进历史 meta / 调用日志的参数」走同一个解析器，
 *   避免两处各写一遍 try/catch 后出现语义漂移。解析失败或非对象一律返回 {}，
 *   与改造前主链路对非法参数的兜底行为一致（不因参数坏掉而中断整条链路）。
 */
function parseToolArguments(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return {};
    } catch {
        return {};
    }
}

/**
 * [需求域 C / C-01、C-02、C-04] 按「下发方式」组装思考相关字段（纯函数，便于单测，N-08）。
 *
 * 背景：改造前 `reasoning_effort` 与 `thinking` 被无条件写入每一次上游请求体，
 *   接入非 DeepSeek 的 OpenAI 兼容服务商时可能因未知字段被拒（C-01 / C-05）。
 *
 * @param mode     下发方式：none / effort / thinking / both（其它值按 none 处理）
 * @param thinking 思考开关字段的**取值来源**（env.LLM_THINKING）
 * @param effort   推理强度字段的**取值来源**（env.LLM_REASONING_EFFORT）
 * @returns 仅包含允许下发的字段；none 时为空对象（C-02）
 *
 * 四种取值的字段组合（AC-10）：
 *   none     → {}
 *   effort   → { reasoning_effort }
 *   thinking → { thinking: { type } }
 *   both     → { reasoning_effort, thinking: { type } }
 */
export function buildThinkingFields(
    mode: string,
    thinking: boolean,
    effort: string,
): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (mode === "effort" || mode === "both") fields.reasoning_effort = effort;
    if (mode === "thinking" || mode === "both") {
        fields.thinking = { type: thinking ? "enabled" : "disabled" };
    }
    return fields;
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
 *
 * [US-HF-2] 聚合流式 delta.tool_calls（按 index 累加 name/arguments）。
 * [US-HF-4] 推送 content 前做 DSML 文本兜底过滤（累积缓冲区跨帧检测 + 前缀保留）。
 * [US-HF-6] emitFinish 控制是否推送 finish 事件。
 *   [需求域 A / A-07] 主链路（单链路）恒传 false，由调用方在链路结束后统一补发一次 finish，
 *   避免前端过早收尾置空气泡。本函数的聚合逻辑在 A 域整改中未做任何改动。
 */
async function pipeStream(
    upstream: ReadableStream<Uint8Array>,
    send: (obj: unknown) => void,
    // [US-HF-6] 是否在读到 finish_reason 时立即推送 finish 事件。
    //   [A-07] 本文件已无「分支 B」单轮路径，唯一调用点恒传 false，
    //   由主链路在结束后统一补发 finish，保证前端在所有轮次完成后才收尾。
    emitFinish: boolean = true
): Promise<PipeResult> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // 兜底统计：累计输出字符数（仅在上游不返回 usage 时使用）
    let fallbackCompletionChars = 0;
    let fullText = "";                            // [US-2.2] 累积完整正文，供写回历史
    let fullThinking = "";                        // [A3] 累积思考过程，供写回 meta
    let lastUsage: PipeResult["usage"] = null;    // [A3] 记录上游 usage，供写回 meta
    // [US-HF-6] 记录上游结束原因与最后一个带 finish_reason 的原始 chunk，
    //   供调用方在链路结束后统一补发 finish 事件。
    let lastFinishReason: string | null = null;
    let lastRaw: unknown = null;

    // [US-HF-2] 聚合流式 tool_calls 分片（按 index）
    const toolCallsAcc: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
    }> = [];

    // [US-HF-4] DSML 块过滤状态
    let inDsmlBlock = false;

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

                    // [US-HF-2] 聚合流式 tool_calls 分片（按 index）
                    const deltaToolCalls = parsed.choices?.[0]?.delta?.tool_calls;
                    if (Array.isArray(deltaToolCalls)) {
                        for (const tc of deltaToolCalls) {
                            const idx = typeof tc.index === "number" ? tc.index : 0;
                            if (!toolCallsAcc[idx]) {
                                toolCallsAcc[idx] = {
                                    id: tc.id || "",
                                    type: tc.type || "function",
                                    function: { name: "", arguments: "" },
                                };
                            }
                            if (tc.id) toolCallsAcc[idx].id = tc.id;
                            if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
                        }
                    }

                    if (delta) {
                        // [US-HF-4] DSML 兜底过滤
                        // 说明：DSML 标记跨帧到达，用「进入/退出块」状态机判断更稳。
                        // [US-HF-6] 检测正则：匹配「全角/半角竖线 + DSML + 竖线」形式的标记，
                        //   例如 ｜DSML｜... 或 |DSML|...，兼容常见包裹符与前后空白。
                        //   若实际日志中的标记形态不同，请以日志为准调整此正则。
                        const DSML_OPEN_RE = /[|｜]\s*DSML\s*[|｜]/;
                        const DSML_CLOSE_RE = /[|｜]\s*DSML\s*[|｜]/;

                        let pushText = "";

                        if (!inDsmlBlock) {
                            const openIdx = delta.search(DSML_OPEN_RE);
                            if (openIdx >= 0) {
                                // 进入 DSML 块：保留 DSML_OPEN 之前的正文前缀
                                pushText = delta.slice(0, openIdx);
                                inDsmlBlock = true;
                                // 若同一帧内又出现 DSML_CLOSE（短块），立即退出
                                if (DSML_CLOSE_RE.test(delta.slice(openIdx))) {
                                    inDsmlBlock = false;
                                }
                            } else {
                                // 未进入块：本帧正常推送（跨帧拆分的 OPEN 由下一帧的 search 兜住）
                                pushText = delta;
                            }
                        } else {
                            // 块内：检测是否退出
                            if (DSML_CLOSE_RE.test(delta)) {
                                inDsmlBlock = false;
                            }
                            pushText = "";   // 块内文本不推送
                        }

                        if (pushText) {
                            // 累计输出字符数（兜底用）
                            fallbackCompletionChars += pushText.length;
                            fullText += pushText;            // [US-2.2] 同步累积完整正文
                            send({ type: "text", content: pushText });
                        }
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
                        // [US-HF-6] 记录结束原因与原始 chunk，供调用方统一补发 finish
                        lastFinishReason = finishReason;
                        lastRaw = parsed;
                        // [US-HF-6] 仅当允许时才推送 finish。
                        //   主链路中间轮 emitFinish=false，不推送，避免前端过早收尾。
                        if (emitFinish) {
                            send({
                                type: "finish",
                                reason: finishReason,
                                usage: lastUsage,
                                raw: parsed,
                            });
                        }
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
            return {
                text: fullText,
                thinking: fullThinking,
                usage: lastUsage,
                toolCalls: toolCallsAcc,
                finishReason: lastFinishReason,
                raw: lastRaw,
            };
        }
        // [Sprint 5.1 / US-LOG-3-FIX] 其他错误（如 network error）：
        //   携带已累积内容上抛，供调用方写日志 / 收尾，避免内容与日志双丢失。
        throw new UpstreamStreamError(err, {
            text: fullText,
            thinking: fullThinking,
            toolCalls: toolCallsAcc,
            usage: lastUsage,
            finishReason: lastFinishReason,
            raw: lastRaw,
        });
    }

    return {
        text: fullText,
        thinking: fullThinking,
        usage: lastUsage,
        toolCalls: toolCallsAcc,
        finishReason: lastFinishReason,
        raw: lastRaw,
    };
}

/**
 * POST /api/chat/stream
 * 流式对话接口
 *
 * [需求域 A] 单链路：请求 → 流式聚合 → 判据（tool_calls）→ 执行工具 / 回灌 → 再请求
 */
router.post("/stream", async (c) => {
    try {
        // [T-HOT / §4.1] 每次对话请求前做一次目录指纹校验：指纹未变直接复用注册表，
        //   变了（增 / 删 / 改入口文件）则重扫 —— 不进入配置页也能立即生效。
        //   幂等：并发请求共用同一次扫描；扫描失败保留「未就绪」，下次请求自动重试。
        await ensureToolRegistry();
        // [skill / §8.3] 技能目录同样按「请求边界」重扫一次；必须在 ensureToolRegistry 之后
        //   （技能校验要读工具注册表判断 unknown_tool）。
        await ensureSkillRegistry();
        // [agent / 第 6 步 A14] agent 注册表同样按请求边界重扫（与 tools/skills 同口径）。
        //   ✅ 必须在 ensureToolRegistry 之后：agent 的「必须工具」可用性判定依赖工具注册表。
        //   ⚠️ isKnownLlm 从 env.json 的 llm[].name 取（F3：env 不暴露 llm[]）。
        //   ⚠️ 扫描失败**不能**让请求 500（A17）：ensureAgentRegistry 内部已 catch 扫描错误，
        //      但 loadEnvJson() 在 env.json 损坏时会抛错，必须在外面兜住。
        try {
            const envJson = loadEnvJson();
            const llmGroups = envJson.llm;
            // [BR-6] 名字集合按**折叠后**构建，与 resolveLlm 判据 3 / findLlmIndex 同口径。
            //   只改 resolveLlm 而不改这里，setup 校验阶段就会判 unknown_llm，根本到不了 resolveLlm。
            const llmNames = new Set(llmGroups.map((g) => foldLlmName(g.name)));
            await ensureAgentRegistry({
                isKnownLlm: (n) => llmNames.has(foldLlmName(n)),
                mintUid: true,   // 运行期允许补写 uid（D-J 一次性迁移）
                // [BR-4] 默认智能体的 llm 字段取**默认组名**（app.defaultLlm），不再取 llm[0].name；
                //   保留原始大小写写入（折叠只用于比较）。
                defaultLlmName: resolveDefaultLlmName(envJson),
            });
        } catch (e) {
            console.warn(
                `⚠️  [agent] 注册表扫描失败，本轮按未绑定处理（A17 不中断会话）：` +
                `${e instanceof Error ? e.message : String(e)}`,
            );
        }

        // ── 1. 解析请求体 ──────────────────────────────────────────
        const body = await c.req.json();
        const { messages, sessionId, message, requestId, agentUid } = body;
        /* [D-1 / C9] agentUid 空串一律 400。C5 已取消「空值即默认」，前端首项改为实值
         * ag_00000000，空串不再有任何业务含义，静默接受会掩盖「前端漏清洗」的缺陷。
         * 校验必须在会话存在性判定之前，否则「已绑定会话 + 空串」会先撞上 409（A-1.17）。
         */
        if (agentUid !== undefined && agentUid !== null) {
            if (typeof agentUid !== "string") {
                return c.json({ error: "agentUid 必须是字符串", code: "agent_uid_invalid" }, 400);
            }
            if (agentUid.trim() === "") {
                return c.json(
                    {
                        error:
                            "agentUid 不能为空串：如需使用默认智能体，请省略该字段" +
                            "（或传 null）；空串不是合法取值",
                        code: "agent_uid_empty",
                    },
                    400,
                );
            }
        }
        // ✅ [skill / 升级 §3.1] 请求级技能入参已删除：技能面完全由配置页开关（SKILLON__*）决定。
        //    旧字段 body.skill / X-Skill 直接忽略（**不报 400**：老前端在灰度期仍可能发，
        //    静默忽略比 400 更稳，且它们本来就只是「本轮激活」的残留）。

        // [Sprint 5.1 / US-LOG-3] 采集请求侧时间（旁路，仅开关开启时有效）
        const logStartedAt = Date.now();

        // [US-3.3] 校验 requestId（若提供）：非空字符串且长度受限；非法静默忽略。
        const hasRequestId =
            typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128;

        // [US-2.2] 入参双模式：
        //   模式一（新）：{ sessionId, message } → 服务端按 sessionId 存取历史；
        //   模式二（旧）：{ messages }           → 行为与改造前完全一致。
        const useServerHistory = typeof message === "string" && message.length > 0;

        if (!useServerHistory) {
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return c.json(
                    { error: "messages 参数必须是非空数组（或提供 message 单条消息）" },
                    400
                );
            }
        } else {
            if (!isValidSessionId(sessionId)) {
                return c.json({ error: "使用 message 时 sessionId 必须为合法会话 ID" }, 400);
            }
        }

        if (!useServerHistory && isValidSessionId(sessionId)) {
            return c.json(
                {
                    error:
                        "旧模式（messages）不支持 sessionId；如需按会话保存历史，请改用 { sessionId, message } 单条消息模式",
                },
                400
            );
        }

        // [US-2.2] 计算本次请求的上下文消息数组
        let contextMessages: SessionMessage[];
        /** [agent / 第 6 步] 已校验通过的绑定 uid（供装配与工具判据使用）；null = 未绑定 */
        let boundAgentUid: string | null = null;
        /** [agent / 第 6 步 A15] 会话里存的人设快照（**不读 AGENT.md**） */
        let boundPersonaSnapshot: string | null = null;
        if (useServerHistory) {
            const sid = sessionId as string;
            const isNewSession = !hasSession(sid);
            if (isNewSession) {
                console.log(`🆕 新会话首次写入: ${sid}`);
            }
            const historySnapshot = getHistory(sid);
            // ── [agent / 第 6 步 A14] 会话绑定：首轮写入、后续校验，不一致返 409 ──
            //   ① 请求带 agentUid 且会话已绑定 → 必须一致，否则 409（A14 锁定语义）
            //   ② 请求带 agentUid 且会话未绑定 → 首轮绑定（CAS，见 bindSessionAgent）
            //   ③ 请求没带 agentUid          → 不动绑定，沿用会话已有值（A8 兼容）
            //   ⚠️ 请求字段名定为 `agentUid`（不是 agent / agentName）：
            //      A16 的 uid 双层标识就是为了「同名不同 agent」可区分，传名字会重新引入歧义。
            const reqAgentUid: string | null =
                typeof agentUid === "string" && agentUid.trim() !== "" ? agentUid.trim() : null;
            const existingBinding = getSessionAgentBinding(sid);
            if (reqAgentUid === null) {
                /* 【D-1】请求未指定 agentUid。
                 *
                 * 分两种情形（数据上都是 agent_uid，但处理不同）：
                 *   ① 会话已绑定 → 沿用已有绑定（原 A8 语义，不变）
                 *   ② 会话未绑定 → 绑定默认智能体 ag_00000000（需求 1 的核心）
                 *
                 * 关于 ② 与「存量 NULL 会话续聊」的关系（见代码修改文档开头的口径收窄）：
                 *   两者在数据上完全同形，本实现统一处理 —— 都绑默认智能体并冻结快照。
                 *   需求文档 A-1.10（新会话首问）与 A-1.13（存量续聊）因此走同一条代码。
                 */
                if (existingBinding.agentUid !== null) {
                    boundAgentUid = existingBinding.agentUid;
                    boundPersonaSnapshot = existingBinding.personaSnapshot;
                } else {
                    // ② 未绑定 → 绑定默认智能体。
                    //   ⚠️ 必须走与「带 uid 首轮绑定」**完全相同**的门槛（rec.status === "ok"）
                    //      和 CAS（bindSessionAgent），否则默认智能体会绕过校验。
                    const regDef = getAgentRegistry();
                    const recDef = regDef.agents.get(DEFAULT_AGENT_UID);
                    if (recDef && recDef.status === "ok") {
                        const snapDef = recDef.body === "" ? null : recDef.body;
                        bindSessionAgent(sid, DEFAULT_AGENT_UID, snapDef);
                        // ⚠️ CAS 返回值不必单独判 409：reqAgentUid === null 说明用户没做选择，
                        //    并发下另一个请求先绑了别的 agent 是合法的（那是用户显式选的），
                        //    此时重读即可，**不应**报 409 —— 否则「两个人同时发第一条消息」
                        //    会因为其中一个是默认绑定而莫名失败。
                        const afterDef = getSessionAgentBinding(sid);
                        boundAgentUid = afterDef.agentUid;
                        boundPersonaSnapshot = afterDef.personaSnapshot;
                    } else {
                        // 默认智能体不可用（创建失败 / 判 invalid / setup 读不出来）
                        // → 不绑定，走 unbound 兜底（C8）；对话不中断（A-1.9b）。
                        console.warn(
                            `⚠️  [agent] 默认智能体（uid=${DEFAULT_AGENT_UID}）不可用` +
                            `（${recDef ? `status=${recDef.status}，${recDef.invalidReason ?? ""}` : "不在注册表"}），` +
                            "本轮按 unbound 兜底装配",
                        );
                        boundAgentUid = null;
                        boundPersonaSnapshot = null;
                    }
                }
            } else if (existingBinding.agentUid === null) {
                // 首轮绑定：人设快照取自**当前**注册表里的 AGENT.md 全文（A15 冻结）
                const reg = getAgentRegistry();
                const rec = reg.agents.get(reqAgentUid);
                // ⚠️ 只有校验通过的 uid 才允许绑定；不存在/非法时**不绑**，
                //    让后续走 unbound/degraded 路径，而不是把垃圾 uid 写进库。
                if (rec && rec.status === "ok") {
                    const snap = rec.body === "" ? null : rec.body;
                    const ok = bindSessionAgent(sid, reqAgentUid, snap);
                    if (!ok) {
                        // CAS 失败：并发下别的请求先绑了 → 重读判定是否一致
                        const again = getSessionAgentBinding(sid);
                        if (again.agentUid !== null && again.agentUid !== reqAgentUid) {
                            return c.json(
                                {
                                    error:
                                        `该会话已绑定 agent（uid=${again.agentUid}），` +
                                        `不能再切换为 ${reqAgentUid}。请新建会话后再选择该 agent。`,
                                    code: "agent_locked",
                                },
                                409,
                            );
                        }
                    }
                    boundAgentUid = reqAgentUid;
                    // ⚠️ 快照必须在这里一并记下；不要留到后面再读注册表，
                    //    否则并发下「读到的可能被别的请求改过」。
                    boundPersonaSnapshot = snap;
                } else {
                    console.warn(
                        `⚠️  [agent] 请求的 agentUid=${reqAgentUid} 不在注册表或状态非法，` +
                        `本次不建立绑定（会话按未绑定处理）`,
                    );
                }
            } else if (existingBinding.agentUid !== reqAgentUid) {
                // 锁定后不一致 → 409（A14）。文案给出可操作方向，不诱导模型重试。
                return c.json(
                    {
                        error:
                            `该会话已绑定 agent（uid=${existingBinding.agentUid}），` +
                            `不能再切换为 ${reqAgentUid}。请新建会话后再选择该 agent。`,
                        code: "agent_locked",
                    },
                    409,
                );
            } else {
                boundAgentUid = existingBinding.agentUid;
                // A15：沿用会话里已存的快照（不是 rec.body）
                boundPersonaSnapshot = existingBinding.personaSnapshot;
            }
            const userMsg: SessionMessage = { role: "user", content: message };
            // [agent / 第 6 步 A14] 绑定判定结束，写入用户消息
            appendMessage(sid, userMsg);
            contextMessages = [...historySnapshot, userMsg];
            // [agent / 第 6 步] 以上三步只决定「本轮用哪个 agent」，不改动消息内容。
            // A17：降级时不抛错、不中断会话，仅告警一次（在装配处统一打印）。
            // A15：人设快照只在绑定时刻写一次，之后永不改写。
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

        // ── 2. 绑定解析 + LLM 解析（必须先于请求构造：base/headers/baseBody 都要用） ──
        // ── [agent / 第 6 步] 绑定解析：一次算清「人设 / 技能策略 / 工具判据 / 预算」 ──
        //   ⚠️ 顺序：必须先 resolveBinding，再算 toolDefs / skillAssembly ——
        //      工具判据是 getToolDefinitions 的入参，技能白名单是装配的入参，顺序反了拿不到。
        //   ⚠️ 第 7 步：binding 还产出 llmRef，而 base/headers/baseBody 都要用它，
        //      故本块整体上移到「请求构造」之前（仍在请求边界算一次，与 while 循环无关）。
        const binding = resolveBinding(boundAgentUid, boundPersonaSnapshot, getAgentRegistry());
        if (binding.kind === "degraded") {
            /* [D-3] agent 的 LLM 引用失效 → 立即不可用并提示，**不走 A17 静默降级**。
             *
             * 为什么不沿用降级：降级后会用默认组的配置继续回答，用户看不出
             * 「我选的 agent 其实没生效」。D-3 已拍板为「立即不可用并提示」。
             *
             * 与 BR-2 的分工：
             *   - BR-2（下方 llmUnresolved）处理「agent 仍 bound，但 llm 名字没命中」
             *     —— 正常流程不会出现（scan 阶段就判 invalid 了），属防御；
             *   - 本处处理「agent 已被判 invalid（unknown_llm / 缺 llm），绑定降级」
             *     —— 这才是会话已绑定后 agent 事后失效的真实路径。
             */
            if (binding.llmInvalid) {
                console.warn(`❌ [agent] agent 的 LLM 引用失效，已拒绝本次请求：${binding.reason}`);
                return c.json(
                    {
                        error:
                            `该会话所选智能体的 LLM 引用已失效，本次请求已拒绝。` +
                            `原因：${binding.reason}。` +
                            `请到配置页修正该智能体的 LLM 引用，或补建对应 LLM 组；` +
                            `如需继续使用其它智能体，请新建会话。`,
                        code: "agent_llm_unresolved",
                    },
                    409,
                );
            }
            // A17：其余降级**不报错、不中断**，只告警一次
            console.warn(`⚠️  [agent] ${binding.reason}`);
        }
        // A10：清单与执行必须同口径。降级时工具全拒（元工具除外，复用 denyAllToolFilter）。
        const agentToolFilter =
            binding.kind === "bound" ? binding.toolFilter
                : binding.kind === "degraded" ? denyAllToolFilter()
                    : undefined;
        // 技能白名单：只有 bound 才收窄；unbound / degraded 不收窄（降级时技能仍按全局口径）
        const agentSkillFilter = binding.kind === "bound"
            ? (c: { dir: string; name: string }) => isSkillAllowedByPolicy(binding.skillPolicy, c)
            : undefined;

        // ── [agent / 第 7 步 模块 6a A3] LLM 解析：一次算清，全请求复用 ──
        //   A3：agent 按 setup.json 的 llm（name）选 LLM；
        //   unbound / degraded → llmRef 为 null → 取 llm[0]，与 env.LLM_* 逐字节一致（A8）。
        //   ⚠️ F3：env 不暴露 llm[]，必须走 loadEnvJson()；此处已在 B2 读过一次，
        //      但那是 try 块内的局部变量，这里再读一次（loadEnvJson 内部有 stamp 缓存，开销可忽略）。
        //   ⚠️ 解析失败（env.json 损坏抛错）不能让请求 500（A17 精神）：
        //      兜底为「用 env 的扁平字段」，即改造前的行为。
        const llmRefOfBinding = binding.kind === "bound" ? binding.llmRef : null;
        // ⚠️ 必须显式标注 ResolvedLlm：否则 `let` 从初值推断出的类型是
        //    { thinkingMode: ThinkingMode, ... }，而下面 {...r} 展开出的
        //    thinkingMode 是 string，赋值会触发 TS2322（strict=true）。
        let agentLlm: ResolvedLlm = {
            name: null,
            base: env.LLM_API_BASE,
            key: env.LLM_API_KEY,
            model: env.LLM_MODEL,
            thinking: env.LLM_THINKING,
            reasoningEffort: env.LLM_REASONING_EFFORT,
            thinkingMode: env.LLM_THINKING_MODE,
            fallback: false,
        };
        /** [BR-2] agent 指名了 LLM 组但解析不到 → 本次请求必须拒绝（不得沿用 env 兜底值） */
        let llmUnresolved = false;
        try {
            const groups = loadEnvJson().llm;
            const r = resolveLlm(groups, llmRefOfBinding);
            if (r) {
                agentLlm = {
                    ...r,
                    // 缺省值单一来源（env.ts §3.2）：resolved 未给出时用 env 兜
                    thinkingMode: r.thinkingMode || env.LLM_THINKING_MODE,
                };
            } else {
                /**
                 * [BR-2] `resolveLlm` 返回 null 有两种成因，**必须分开处理**：
                 *   a) `llm[]` 为空 → 环境级降级，沿用 env.LLM_* 是合法的（A17 精神）；
                 *   b) agent **指名**了组但没命中 → 该 agent 的 LLM 失效，
                 *      **不能**拿 env 兜底继续请求（那等于 BR-2 没生效）。
                 *
                 * 判据用 `llmRefOfBinding`：只有 bound 且写了 llm 才有值（见上文赋值）。
                 * 未绑定会话（llmRefOfBinding === null）与「名字为空」的等价路径
                 * 走的是 resolveLlm 判据 2，返回的是对象而非 null，天然不受影响（BR-3）。
                 */
                if (llmRefOfBinding !== null && llmRefOfBinding.trim() !== "" && groups.length > 0) {
                    llmUnresolved = true;
                }
            }
        } catch (e) {
            // env.json 损坏导致 loadEnvJson 抛错：沿用 env 的扁平字段（A17：不中断会话）
            console.warn(
                `⚠️  [llm] 解析失败，本轮沿用 env 的默认 LLM：` +
                `${e instanceof Error ? e.message : String(e)}`,
            );
        }
        if (llmUnresolved) {
            // [BR-2] 请求前拒绝：该 agent 的 llm 指向了不存在的组，不回退、不静默。
            console.warn(
                `❌ [llm] agent「${boundAgentUid ?? "?"}」引用的 LLM 组「${llmRefOfBinding}」不存在，` +
                `已拒绝本次请求（不回退到任何组）`,
            );
            return c.json(
                {
                    error:
                        `该智能体引用的 LLM 组「${llmRefOfBinding}」在 env.json 的 llm[] 中不存在，` +
                        `已拒绝本次请求。请到配置页修正该智能体的 LLM 引用，或补建对应 LLM 组。`,
                    code: "agent_llm_unresolved",
                },
                409,
            );
        }
        if (agentLlm.fallback) {
            // [BR-2] fallback 恒为 false（回退路径已删除）；保留分支仅为兼容既有日志格式。
            console.warn(
                `⚠️  [llm] 本轮已回退到「${agentLlm.name ?? "(未命名)"}」（agent 指定的名字未找到）`,
            );
        }

        // ── 3. 构建 Chat Completions API 请求 ──────────────────────
        // [agent / 第 7 步 A3] 连接参数按 agent 解析结果取；unbound 时与 env 完全相同（A8）。
        const base = agentLlm.base.replace(/\/+$/, "");
        const apiUrl = base.endsWith("/v1")
            ? `${base}/chat/completions`
            : `${base}/v1/chat/completions`;

        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${agentLlm.key}`,
        };

        // 公共请求体（不含 stream / tools / messages，按轮拼装）
        // [需求域 C / C-01、C-02、C-04] 思考相关字段按「下发方式」拼装，不再无条件写入：
        //   取值来源仍是 LLM_THINKING / LLM_REASONING_EFFORT，
        //   但「是否下发」只由 LLM_THINKING_MODE（none/effort/thinking/both）决定。
        //   none（默认）时请求体不含这两个字段（C-02），保证非 DeepSeek 服务商不被拒（C-05）。
        // [agent / 第 7 步 A3] model 跟随该 agent 的 LLM
        const baseBody = {
            model: agentLlm.model,
            ...buildThinkingFields(
                agentLlm.thinkingMode,
                agentLlm.thinking,
                agentLlm.reasoningEffort,
            ),
        };

        // 工具定义快照（每次请求实时取，见 T-01）
        // [skill / 升级版 §3.2] 装配在**请求边界**算一次、全请求复用；技能不再收窄工具面。
        // ✅ [skill / 升级 §1、§3.5] 工具面 = 全部可用工具 ∪ 元工具，**与开了哪些技能无关**；
        //    getToolDefinitions() 内部已按「祖先目录 AND 组开关 AND 工具自身条件」过滤，并已追加元工具。
        // [agent / 第 6 步] binding / agentToolFilter / agentSkillFilter 已在上方统一解析（第 7 步上移）。

        const toolDefs = getToolDefinitions(agentToolFilter);
        // ✅ [skill / 升级 §3.2] 多技能装配：仍是请求边界算一次、全请求复用（同一请求内不切换）。
        const skillAssembly = assembleForRequestMulti(undefined, agentSkillFilter);

        // [agent / 第 5 步 §3 + 第 6 步 A15] system 三段式装配：人设 → 技能声明 → 基础。
        //   人设来自**绑定时刻的快照**（binding.personaText），不是 AGENT.md 现读 —— A15「人设冻结」。
        //   unbound 时 persona 传 null（等价路径，A8）；degraded 时保留快照（避免「助手换了性格」）。
        let agentCtx: { personaText: string } | null =
            binding.kind === "unbound" ? null : { personaText: binding.personaText };
        const built = buildSystemText({
            persona: agentCtx ? { text: agentCtx.personaText } : null,
            skillText: skillAssembly.systemText,
            baseText: "",
        });
        // [agent / 第 5 步] 总预算：超限整段截断（复用 skills/budget.ts 的统一口径）。
        //   第 6 步接入 agent 时传 systemBudget（P4）；本步无 agent 来源，故用缺省口径。
        const systemFit = fitSystemBudget(
            built.systemText,
            // [agent / 第 6 步 P4] 已绑定时用该 agent 的 systemBudget。
            // ⚠️ 实现上只有 < L2_MAX(3000) 才真正收紧：prompt.ts 的 cap 归一化决定了
            //    9000（缺省）等价于「不额外收紧，上限仍是 3000」。这是第 5 步的既定口径。
            binding.kind === "bound" ? { totalMax: binding.systemBudget } : {},
        );
        if (systemFit.truncated) {
            console.warn(
                `⚠️  [agent] system 超预算（原长 ${systemFit.originalChars} 字），已省略段落：` +
                systemFit.omitted.join("、"),
            );
        }
        if (skillAssembly.skills.length > 0 || skillAssembly.notices.length > 0) {
            console.log(
                `🧩 [skill] 本轮装配技能 ${skillAssembly.skills.length} 个` +
                `（${skillAssembly.skillNames.join("、")}）｜${skillAssembly.diag}｜` +
                `可见工具=${toolDefs.length} 个` +
                `｜system=${systemFit.systemText.length} 字` +
                `（人设=${built.parts.persona ? "有" : "无"}）`,
            );
        }
        // [T-VIS / §8.7] 工具可见性日志已下沉到 getToolDefinitions()：它按「祖先目录 / 组开关 /
        //   组挂起」三种原因分别记录被排除的组，且**不打印任何设置项取值**。
        //   此处不再重复打印（重复会出现两行数字不一致的错觉），也不再读 BROWSER_ENABLED
        //   （该旧开关已在迁移时删除，见 §9.2 与 migrate.ts）。

        // ── [US-3.3] 创建取消句柄并登记 ────────────────────────────
        const upstreamController = new AbortController();
        if (hasRequestId) {
            registerCancel(requestId as string, upstreamController);
            console.log(`🔗 [US-3.3] 登记取消句柄: ${requestId}`);
        }

        // ── 3. 设置 SSE 响应头 ─────────────────────────────────────
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");
        c.header("X-Accel-Buffering", "no"); // 禁用 Nginx 缓冲

        // ── 4. 单一主链路（A-02/A-03）：不再有探测请求，也没有并行分支 ──
        return c.body(
            new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    // [Sprint 5.1 / US-LOG-3-FIX2] send 永不抛错：
                    //   客户端断开后 controller 已关闭，enqueue 会抛
                    //   "Invalid state: Controller is already closed"。
                    //   若任其抛出，会中断 pipeStream 的读取循环，导致已累积内容丢失、
                    //   且被误记为上游 error。此处吞掉，仅记录一次告警。
                    let clientGone = false;
                    const send = (obj: unknown) => {
                        if (clientGone) return;
                        try {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
                        } catch (e) {
                            if (!clientGone) {
                                clientGone = true;
                                console.warn("⚠️ [Sprint 5.1] SSE 客户端已断开，后续事件将丢弃:", e);
                            }
                        }
                    };

                    // [Sprint 5.2 / US-STAB-1] SSE 心跳保活：
                    //   复杂任务（多轮工具）期间 SSE 通道可能长时间无数据，
                    //   被中间层（如 Nginx proxy_read_timeout=60s）或浏览器判为空闲而掐断，
                    //   导致前端报 "network error"。此处周期性下发 SSE 注释帧（: ping），
                    //   保持连接活跃；注释帧不触发前端 data: 解析，无渲染副作用。
                    const heartbeat = setInterval(() => {
                        if (clientGone) return;   // 客户端已断开：不再发送
                        try {
                            controller.enqueue(encoder.encode(`: ping\n\n`));
                        } catch {
                            // 连接已断，忽略（clientGone 会在 send 中置位，此处兜底）
                        }
                    }, env.SSE_HEARTBEAT_MS);

                    // [A3] 本次回答的渲染元数据（供写回 meta）
                    const startedAt = Date.now();
                    // [需求域 B / B-01、B-04] 全链路唯一的工具调用记录源：历史 meta 与调用日志都只读它。
                    //   id 与 tool_call 事件一致，便于「日志/落库 ↔ 事件流」逐条比对（AC-07）。
                    const collectedToolCalls: Array<{
                        id?: string;
                        name: string;
                        arguments?: unknown;
                        result?: string;
                    }> = [];

                    try {
                        const MAX_TOOL_ROUNDS = env.MAX_TOOL_ROUNDS;   // [US-STAB-3 / A-08] 语义与默认值不变
                        let workingMessages: Array<Record<string, unknown>> = contextMessages.map(
                            (m: SessionMessage) => {
                                const out: Record<string, unknown> = { role: m.role, content: m.content };
                                if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
                                if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
                                if (m.name !== undefined) out.name = m.name;
                                return out;
                            }
                        );
                        // [skill / 升级 §3.6] 注入内容换成多技能装配的 systemText；**位置不动**（仍在 while 外、只插一次，C-3）。
                        //   · 只放已开启技能的 L1（已在 assemble 里按 L1_MAX 截断）；L2 不进 system，由元工具按需取；
                        //   · 全关时 systemText === ""，与升级前一致（无 system、无 notice）。
                        //   ⚠️ 不要写进 while 里，否则每轮工具往返都会再插一条（C-3）。
                        //   ⚠️ 只注入内存，**不落库**（见 §6.2.8）。
                        // [agent / 第 5 步 §3] 注入源改为三段装配 + 预算裁剪后的结果（systemFit）。
                        //   判定条件与位置不变：仍 !== ""、仍在 while 外、仍只插一次。
                        if (systemFit.systemText !== "") {
                            workingMessages = [
                                { role: "system", content: systemFit.systemText },
                                ...workingMessages,
                            ];
                        }
                        // ✅ 不可用 / 挂起：逐条下发（§3.6「改为遍历复数」）；复用既有 notice 类型，不新增事件契约
                        for (const n of skillAssembly.notices) {
                            send({ type: "notice", message: `🧩 ${n}` });
                        }
                        // [A-03] 工具轮次的唯一判据：本轮流式聚合出的 tool_calls。
                        //   首轮必然为空 —— 探测请求已删除（A-02/A-04）。
                        let currentToolCalls: PipeResult["toolCalls"] = [];
                        let toolRound = 0;              // 已执行的工具轮数（语义同改造前的 round）
                        let reqSeq = 0;                 // 已发起的上游生成次数（A-01/A-05）
                        let toolsEnabled = toolDefs.length > 0;   // 上游拒绝 tools 时降级（A-06）
                        let finalText = "";
                        let finalThinking = "";
                        let finalUsage: PipeResult["usage"] = null;
                        let finalFinishReason: string | null = null;
                        let finalRaw: unknown = null;
                        let hitMaxRounds = false;

                        // 主链路循环：一次迭代 = 一次上游生成（+ 可选的一轮工具执行）
                        while (true) {
                            reqSeq++;

                            const buildBody = (withTools: boolean): Record<string, unknown> => ({
                                ...baseBody,
                                messages: workingMessages,
                                stream: true,
                                ...(withTools ? { tools: toolDefs } : {}),
                            });

                            const reqStartedAt = Date.now();
                            let resp = await fetch(apiUrl, {
                                method: "POST",
                                headers,
                                signal: upstreamController.signal,
                                body: JSON.stringify(buildBody(toolsEnabled)),
                            });

                            // [A-06] 兼容性保持：改造前「上游不支持 tools」靠探测失败来发现并降级，
                            //   探测删除后改为「首轮 4xx 且尚未执行任何工具」时去掉 tools 重试一次，
                            //   保证对外行为（不因上游不认 tools 而整轮失败）不变。
                            if (
                                !resp.ok &&
                                toolsEnabled &&
                                reqSeq === 1 &&
                                toolRound === 0 &&
                                resp.status >= 400 &&
                                resp.status < 500
                            ) {
                                const errText = await resp.text().catch(() => "");
                                console.warn(
                                    `⚠️ [A-06] 上游拒绝带 tools 的请求 (${resp.status})，改为不带 tools 重试一次。上游返回: ${errText || "(空)"}`
                                );
                                toolsEnabled = false;
                                resp = await fetch(apiUrl, {
                                    method: "POST",
                                    headers,
                                    signal: upstreamController.signal,
                                    body: JSON.stringify(buildBody(false)),
                                });
                            }

                            // [A-05] 每次上游生成留一行可核对的日志（请求次数验收依据）
                            console.log(
                                `📡 [A-05] 上游生成 #${reqSeq}｜状态=${resp.status}｜tools=${toolsEnabled ? "on" : "off"}｜messages=${workingMessages.length}｜响应头耗时=${Date.now() - reqStartedAt}ms`
                            );

                            if (!resp.ok || !resp.body) {
                                const t = await resp.text().catch(() => "");
                                const where = reqSeq === 1 ? "" : `（第 ${reqSeq} 次上游请求）`;
                                send({ type: "error", message: `LLM API 返回错误${where}: ${t || resp.status}` });
                                return;
                            }

                            // [US-HF-6] 中间轮不推送 finish（emitFinish=false），
                            //   由本链路结束后统一补发，避免前端过早收尾置空气泡。
                            // [Sprint 5.1 / US-LOG-3-FIX2] 即使本轮 pipeStream 抛错，
                            //   也要把已累积内容合并进 finalText/finalThinking，避免内容丢失。
                            let result: PipeResult;
                            try {
                                result = await pipeStream(resp.body, send, false);
                            } catch (e) {
                                if (e instanceof UpstreamStreamError) {
                                    finalText += e.partial.text;
                                    finalThinking += e.partial.thinking;
                                    finalUsage = e.partial.usage ?? finalUsage;
                                    finalFinishReason = e.partial.finishReason ?? finalFinishReason;
                                    finalRaw = e.partial.raw ?? finalRaw;
                                }
                                throw e;
                            }
                            // 正文 / 思考跨轮累积（而非覆盖），保证多轮回答的完整内容都能写回历史与展示。
                            finalText += result.text;
                            finalThinking += result.thinking;
                            finalUsage = result.usage ?? finalUsage;
                            finalFinishReason = result.finishReason ?? finalFinishReason;
                            finalRaw = result.raw ?? finalRaw;

                            // ① [A-03] 唯一判据
                            currentToolCalls = result.toolCalls || [];

                            // ② 本轮结束判定
                            if (currentToolCalls.length === 0) break;   // 未请求工具 → 链路结束（B-03：空正文也照此判定）
                            // [A-06] 用户已中断：不再执行工具、不再续跑（避免「已点停止仍在写文件」），
                            //   并按改造前的语义直接收尾 —— 不发 finish、不落库、不写调用日志，
                            //   仅由 catch 外的 finally 清理（与旧分支 A 在工具轮中途被取消的表现一致）。
                            if (upstreamController.signal.aborted) {
                                console.log("⏹️ [US-3.3] 上游请求已取消（主链路中途收尾）");
                                return;
                            }
                            // [A-08] 轮次上限：已达上限仍请求工具 → 截断，交由收尾逻辑显式告知
                            if (toolRound >= MAX_TOOL_ROUNDS) {
                                hitMaxRounds = true;
                                break;
                            }
                            toolRound++;

                            // ③ 执行本轮全部工具，推送事件，构造回灌消息
                            const toolResultMessages: Array<Record<string, unknown>> = [];
                            for (const tc of currentToolCalls) {
                                // [需求域 T / T-04] 用户已中断：跳过本轮剩余工具，直接收尾。
                                //   与既有中断早退的语义一致（不发 finish、不落库、不写调用日志），
                                //   避免「已点停止仍在写文件」。
                                if (upstreamController.signal.aborted) {
                                    console.log("⏹️ [T-04] 已中断，跳过本次工具调用及后续轮次");
                                    return;
                                }
                                const wireName = tc.function?.name || "";
                                const displayName = toDisplayName(wireName);
                                // [需求域 B / B-04] 与日志 / 落库共用同一份参数解析（parseToolArguments），
                                //   保证「执行时用的参数」与「记录下来的参数」永远一致。
                                const args: Record<string, unknown> = parseToolArguments(
                                    tc.function?.arguments
                                );

                                // 推送「工具调用发生」事件（前端展示，默认收起）
                                send({
                                    type: "tool_call",
                                    id: tc.id,
                                    name: displayName,
                                    wireName,
                                    arguments: args,
                                });

                                // 后端执行（executeTool 内部已兜底异常）
                                // [需求域 T / T-03、T-04] 透传上下文：中断信号 + 会话标识，
                                //   使在途工具可在用户点「停止」时中止，也便于后续联网工具按会话暂存（R-30）。
                                const toolResult = await executeTool(wireName, args, {
                                    signal: upstreamController.signal,
                                    sessionId: useServerHistory ? (sessionId as string) : undefined,
                                    // ✅ [升级 §5.2] 来源标识改为数组：本轮参与装配的全部技能。
                                    //    ⚠️ 仅展示与审计，**不参与任何权限判定**（N-SK-12 不变）。
                                    skills: skillAssembly.skillNames.length > 0 ? skillAssembly.skillNames : undefined,
                                }, agentToolFilter); // [agent / 第 6 步 A10] 与 getToolDefinitions 同一判据

                                // 推送「工具结果」事件
                                send({
                                    type: "tool_call",
                                    id: tc.id,
                                    name: displayName,
                                    wireName,
                                    arguments: args,
                                    result: toolResult,
                                });

                                // [A3] 收集工具调用记录，供写回 meta（历史重现工具段）与调用日志（B-04：真实值）
                                // [需求域 B / B-01] 带 id：与上面两条 tool_call 事件的 id 完全一致，可逐条比对
                                collectedToolCalls.push({
                                    id: tc.id,
                                    name: displayName,
                                    arguments: args,
                                    result: toolResult,
                                });

                                toolResultMessages.push({
                                    role: "tool",
                                    tool_call_id: tc.id,
                                    content: toolResult,
                                });
                            }

                            // ④ 回灌 assistant(tool_calls) + tool 结果，进入下一轮生成。
                            //   assistant.content 取本轮流式正文（改造前取探测请求的正文，
                            //   探测删除后统一取同一次生成的正文，语义一致且无需额外请求）。
                            workingMessages = [
                                ...workingMessages,
                                {
                                    role: "assistant",
                                    content: result.text || null,
                                    tool_calls: currentToolCalls,
                                },
                                ...toolResultMessages,
                            ];
                        }

                        // [A-05] 链路结束汇总：验收「1 或 1+N」的直接依据
                        console.log(
                            `📊 [A-05] 上游生成次数=${reqSeq}｜工具轮数=${toolRound}｜命中轮次上限=${hitMaxRounds ? "是" : "否"}`
                        );

                        // [US-HF-6] 链路结束后统一补发一次 finish 事件，
                        //   保证前端在「全部轮次完成后」才收尾置空气泡。
                        // [Sprint 5.2 / US-STAB-3] 达上限截断时，reason 置为 max_tool_rounds。
                        send({
                            type: "finish",
                            reason: hitMaxRounds ? "max_tool_rounds" : (finalFinishReason || "stop"),
                            usage: finalUsage,
                            raw: finalRaw || {},
                            // ✅ [升级 §5.1] skill 改为**数组**：本轮参与装配的全部技能；无技能时为 []（不再是「不带该字段」）。
                            //    兼容期额外给 skillName（首个技能名），老前端改完 §7 后可删。
                            skill: skillAssembly.skillNames,
                            skillName: skillAssembly.skillNames[0] ?? null,
                        });

                        // [Sprint 5.2 / US-STAB-3] 达上限截断：追加 notice 事件显式告知用户
                        if (hitMaxRounds) {
                            send({
                                type: "notice",
                                message: `已达工具调用轮次上限（${MAX_TOOL_ROUNDS} 轮），任务可能未完成，可继续追问。`,
                            });
                        }

                        // [需求域 B / B-03] 空正文兜底：链路已结束，但正文为空且确实执行过工具。
                        //   此时若什么都不说，前端就是一个只挂着工具段的「空气泡」（B-03 禁止以空内容结束本轮）。
                        //   事件顺序与其他事件契约保持不变（B-05）：仍在 finish 之后、且复用既有 notice 类型。
                        //   达轮次上限时已有上一段 notice，不重复提示。
                        if (!hitMaxRounds && !finalText.trim() && collectedToolCalls.length > 0) {
                            const names = [...new Set(collectedToolCalls.map((t) => t.name))].join("、");
                            send({
                                type: "notice",
                                message: `模型未返回正文，本轮已执行工具 ${collectedToolCalls.length} 次（${names}），结果见上方工具段，可继续追问。`,
                            });
                        }

                        // ⑤ 写回历史（携带完整 meta；格式与改造前一致，A-06）
                        // [需求域 B / B-01、B-03] 落库条件由「正文非空」放宽为「正文非空 或 已执行工具」：
                        //   上游「只调工具、不返正文」时，工具结果与 meta 不再因正文为空而整条丢失（B-01）；
                        //   同时避免「以空内容结束本轮」（B-03）。
                        //   B-06：旧消息模式（useServerHistory=false）本就不落库，此处改动对它无影响。
                        if (useServerHistory && (finalText || collectedToolCalls.length > 0)) {
                            const meta: MessageMeta = {
                                thinking: finalThinking || undefined,
                                toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
                                usage: finalUsage ?? undefined,
                                // [agent / 第 7 步 A3] 历史记录必须标**实际使用的**模型（F4 最易漏点）
                                model: agentLlm.model,
                                elapsedMs: Date.now() - startedAt,
                                startedAt,
                                interrupted: upstreamController.signal.aborted || undefined,
                            };
                            appendMessage(
                                sessionId as string,
                                { role: "assistant", content: finalText },
                                meta
                            );
                        }

                        // [Sprint 5.1 / US-LOG-3] 旁路采集日志（单链路，工具字段写真实值）
                        //   无条件采集（含 finalText 为空的中断场景），由 appendLlmLog 内部判开关。
                        appendLlmLog({
                            sessionId: (sessionId as string) ?? null,
                            requestId: hasRequestId ? (requestId as string) : null,
                            model: agentLlm.model,
                            userInput: useServerHistory ? (message as string) : "(旧模式 messages)",
                            assistantText: finalText || null,
                            thinking: finalThinking || null,
                            toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : null,
                            usage: finalUsage ?? null,
                            finishReason: finalFinishReason,
                            elapsedMs: Date.now() - logStartedAt,
                            interrupted: upstreamController.signal.aborted || undefined,
                            error: null,
                        });
                    } catch (err) {
                        const isAbort = err instanceof Error && err.name === "AbortError";
                        // [Sprint 5.1 / US-LOG-3-FIX2] 区分「客户端断开」与「上游错误」：
                        //   客户端断开（Invalid state / clientGone）不应记为上游 error。
                        const isClientGone =
                            clientGone ||
                            (err instanceof Error &&
                                /Invalid state|already closed/i.test(err.message));

                        // [Sprint 5.1 / US-LOG-3-FIX] 先写日志，再发错误事件。
                        //   原因：network error 时 controller 可能已失效，send 会抛 TypeError，
                        //   若 send 在前会中断 catch 块，导致日志永远写不进去。
                        if (!isAbort) {
                            const partial = err instanceof UpstreamStreamError ? err.partial : null;
                            appendLlmLog({
                                sessionId: (sessionId as string) ?? null,
                                requestId: hasRequestId ? (requestId as string) : null,
                                model: agentLlm.model,
                                userInput: useServerHistory ? (message as string) : "(旧模式 messages)",
                                assistantText: partial?.text || null,
                                thinking: partial?.thinking || null,
                                toolCalls:
                                    partial && partial.toolCalls.length > 0
                                        ? partial.toolCalls.map((tc) => ({
                                              // [需求域 B / B-04] 与正常路径同一形状（可读名 + 对象参数），
                                              //   异常路径下这些调用尚未执行，故无 result 字段。
                                              id: tc.id,
                                              name: toDisplayName(tc.function?.name || ""),
                                              arguments: parseToolArguments(tc.function?.arguments),
                                          }))
                                        : null,
                                usage: partial?.usage ?? null,
                                finishReason: partial?.finishReason ?? null,
                                error: isClientGone
                                    ? null
                                    : err instanceof Error
                                      ? err.message
                                      : String(err),
                                // [Sprint 5.2 / US-STAB-4] 标记客户端断开，便于事后区分
                                clientGone: isClientGone || undefined,
                                elapsedMs: Date.now() - logStartedAt,
                                interrupted: upstreamController.signal.aborted || undefined,
                            });

                            // [Sprint 5.2 / US-STAB-4] 客户端断开：记录可读告警，便于事后排查
                            if (isClientGone) {
                                console.warn(
                                    `⚠️ [Sprint 5.2] 客户端已断开，本次回答中断（已生成内容已写入日志）`
                                );
                            }
                        }

                        // [US-3.3] 取消（AbortError）属正常路径，不误报为错误。
                        if (isAbort) {
                            console.log("⏹️ [US-3.3] 上游请求已取消（start 兜底）");
                        } else {
                            // [Sprint 5.1 / US-LOG-3-FIX] send 包 try/catch：
                            //   controller 已关闭/errored 时 enqueue 会抛错，此处吞掉，
                            //   避免中断 catch 块并掩盖原始错误。
                            try {
                                const msg = err instanceof Error ? err.message : String(err);
                                send({ type: "error", message: msg });
                            } catch (sendErr) {
                                console.warn("⚠️ [Sprint 5.1] 错误事件发送失败（流已关闭，忽略）:", sendErr);
                            }
                        }
                    } finally {
                        // [US-3.3] 注销取消句柄（幂等）。
                        if (hasRequestId) {
                            unregisterCancel(requestId as string);
                        }
                        // [Sprint 5.2 / US-STAB-1] 清理心跳定时器，避免定时器泄漏
                        clearInterval(heartbeat);
                        // [Sprint 5.1 / US-LOG-3-FIX] controller 可能已 errored/closed，
                        //   close 会抛错，吞掉以免掩盖原始错误。
                        try {
                            controller.close();   // 主动关流：作为前端"排空完成"信号
                        } catch (closeErr) {
                            console.warn("⚠️ [Sprint 5.1] 关闭流失败（可能已关闭，忽略）:", closeErr);
                        }
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
