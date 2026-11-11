/**
 * src/agents/memorySummarize.ts
 * [agent / 第 8 步 · 模块 6b] 记忆摘要的「纯逻辑」部分：拼提示词、调 LLM、解析结果。
 *
 * ⚠️ 本文件**不 import 任何 @/infra/***（与 binding.ts / llmResolve.ts 同一条铁律）。
 *    数据读写由调用方（routes/memory.ts）通过 @/infra/memory 完成后注入进来，
 *    这样 agents/ 仍不附带 infra 的模块级副作用，不会污染 verify-agent-compat 基线。
 *
 * 职责边界：
 *   - 本文件**不决定**游标怎么推进、事实写不写库 —— 那是调用方的数据层职责；
 *   - 本文件**不发 HTTP 以外的副作用**：不发流、不写库、不改 env。
 */

/** 摘要输入的一条消息（与 infra/memory 的 MemorySourceMessage 结构兼容） */
export interface SummarizeMessage {
    seq: number;
    role: string;
    content: string | null;
}

/** 摘要请求参数 */
export interface SummarizeParams {
    /** 已有事实（上一轮归纳结果）；null = 首次摘要 */
    previousFacts: string | null;
    /** 本轮新增消息（升序，已剔除 system） */
    messages: readonly SummarizeMessage[];
    /** 单条消息内容截断长度（防止个别超长消息撑爆上下文） */
    perMessageMaxChars?: number;
}

/** 摘要结果 */
export interface SummarizeResult {
    /** 归纳出的完整事实文本（含 previousFacts 的合并结果）；无新事实时为 null */
    facts: string | null;
    /** 本次实际消费到的最大 seq（调用方据此推进游标）；无消息时为 null */
    consumedSeq: number | null;
}

/** 单条消息内容截断上限 */
const DEFAULT_PER_MESSAGE_MAX = 2000;

/**
 * 拼装摘要提示词。
 *
 * 设计意图：要求模型输出「合并后的完整事实列表」，而不是增量补丁 ——
 *   因为下游（后续步骤回灌记忆）只需要一个可直接注入 system 的文本块，
 *   增量补丁需要额外合并逻辑，容易与游标推进产生不一致。
 *
 * @param params 摘要参数
 * @returns [{ role: "system" | "user", content }] 形式的 messages
 */
export function buildSummarizePrompt(params: SummarizeParams): Array<{
    role: "system" | "user";
    content: string;
}> {
    const perMax = params.perMessageMaxChars ?? DEFAULT_PER_MESSAGE_MAX;

    const lines = params.messages.map((m) => {
        const raw = (m.content ?? "").trim();
        const text =
            raw.length > perMax ? `${raw.slice(0, perMax)}…（已截断）` : raw;
        return `[#${m.seq} ${m.role}] ${text}`;
    });

    const prev =
        params.previousFacts && params.previousFacts.trim() !== ""
            ? params.previousFacts.trim()
            : "（无）";

    return [
        {
            role: "system",
            content:
                "你是一个记忆归纳器。你的任务是把对话内容压缩成简洁、可长期复用的事实条目。\n" +
                "规则：\n" +
                "1. 只保留用户的事实性信息（偏好、身份、约束、正在进行的事情），不要保留寒暄和工具调用细节；\n" +
                "2. 与已有事实合并：新信息覆盖旧的同类信息，删除已过期的条目；\n" +
                "3. 输出为一个纯文本列表，每行一条，以「- 」开头，不要编号、不要标题、不要解释；\n" +
                "4. 若无任何值得保留的事实，只输出一行：NONE",
        },
        {
            role: "user",
            content:
                `【已有事实】\n${prev}\n\n` +
                `【本次新增对话】\n${lines.join("\n")}\n\n` +
                "请输出合并后的完整事实列表。",
        },
    ];
}

/**
 * 解析模型返回的事实文本。
 *
 * 处理规则（顺序固定）：
 *   1. 去掉首尾空白与代码围栏（模型常把列表包在 ``` 里）
 *   2. 模型输出 NONE（或空）→ 返回 null，表示「无新事实」
 *   3. 其余情况原样保留（含「- 」前缀），并对超长输出做上限截断
 *
 * @param raw 模型返回的原始文本
 * @param maxChars 事实文本上限
 * @returns 规整后的事实文本；无事实时为 null
 */
export function parseSummarizeOutput(
    raw: string | null | undefined,
    maxChars = 4000
): string | null {
    if (raw === null || raw === undefined) return null;

    // 去掉代码围栏
    let text = raw.trim();
    if (text.startsWith("```")) {
        text = text
            .replace(/^```[a-zA-Z]*\s*/, "")
            .replace(/\s*```$/, "")
            .trim();
    }

    if (text === "" || /^NONE$/i.test(text)) return null;

    return text.length > maxChars ? `${text.slice(0, maxChars)}…（已截断）` : text;
}

/**
 * 发起一次非流式 LLM 调用并返回摘要文本。
 *
 * ⚠️ 与 chat.ts 的主链路完全独立：不共享 SSE 流、不改会话状态。
 *    超时由调用方传入（AbortSignal），本函数不自行设定。
 *
 * @param base   LLM API base（如 https://api.deepseek.com）
 * @param key    API key
 * @param model  模型名
 * @param messages 提示词
 * @param signal 中止信号（超时控制）
 * @returns 模型返回的 content 文本
 * @throws 当 HTTP 非 2xx 或返回结构不含 choices[0].message.content 时
 */
export async function callSummarizeLlm(
    base: string,
    key: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal
): Promise<string> {
    const url = `${base.replace(/\/+$/, "")}/chat/completions`;

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
            model,
            messages,
            // 摘要不需要发散：温度取 0，保证同一段对话归纳结果稳定
            temperature: 0,
            stream: false,
        }),
        signal,
    });

    if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(
            `摘要 LLM 调用失败: HTTP ${resp.status} ${detail.slice(0, 200)}`
        );
    }

    const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
        throw new Error("摘要 LLM 返回结构异常：缺少 choices[0].message.content");
    }
    return content;
}
