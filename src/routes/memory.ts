/**
 * src/routes/memory.ts
 * [agent / 第 8 步 · 模块 6b] 记忆摘要接口（**独立路由，完全脱离主循环**）
 *
 *   GET  /api/memory/status   查看某 agent 的记忆游标与事实（只读，零副作用）
 *   POST /api/memory/summarize 触发一次摘要（同步执行，返回本次推进结果）
 *
 * ⚠️ A11 的保证方式（结构性，不是靠 try/catch 兜底）：
 *    本路由**既不 import chat.ts，也不被 chat.ts import**。
 *    对话主链路（SSE）与摘要链路在任何时刻都是两条独立的请求，
 *    因此「摘要失败」在物理上不可能污染正在流的会话。
 *
 * 幂等：
 *   - 摘要只消费 `seq > summarized_seq` 的增量，不会重复记账；
 *   - 推进游标用 CAS（WHERE summarized_seq = 期望值），并发触发时后到者不生效。
 *
 * LLM 选择（A5）：使用**该 agent 绑定的 LLM**。
 *   env 不暴露 llm[]，故这里走 loadEnvJson() + resolveLlm()（与 chat.ts 同源），
 *   而不是固定用 env.LLM_*。
 */
import { Hono } from "hono";
import { hasSession, getSessionAgentBinding } from "@/infra/session";
import {
    advanceMemory,
    getMemoryCursor,
    getMessagesSince,
    listMemoryScopes,
    MEMORY_SCOPE_GLOBAL,
    memoryScopeOfSession,
} from "@/infra/memory";
import { loadEnvJson } from "@/infra/envJson";
import {
    buildSummarizePrompt,
    callSummarizeLlm,
    parseSummarizeOutput,
} from "@/agents/memorySummarize";
import { getAgentRegistry, resolveLlm, type ResolvedLlm } from "@/agents";

/** 摘要请求的超时上限（毫秒）：超时视为失败，不推进游标 */
const SUMMARIZE_TIMEOUT_MS = 60_000;

/** 单次摘要最多消费多少条消息 */
const SUMMARIZE_BATCH_LIMIT = 50;

export const memoryRoute = new Hono();

/**
 * 解析请求里的作用域。
 *
 * 规则：显式 scope 优先；否则给了 sessionId 就用会话作用域；都没有则 global。
 *
 * @param scope     显式作用域（"global" | "session:xxx"）
 * @param sessionId 会话 ID
 * @returns 作用域字符串
 */
function resolveScope(scope: unknown, sessionId: unknown): string {
    if (typeof scope === "string" && scope.trim() !== "") {
        return scope.trim();
    }
    if (typeof sessionId === "string" && sessionId.trim() !== "") {
        return memoryScopeOfSession(sessionId.trim());
    }
    return MEMORY_SCOPE_GLOBAL;
}

/**
 * GET /api/memory/status
 *
 * 返回某 agent 的记忆游标。**只读，不初始化任何行**（避免 GET 产生副作用）。
 *
 * Query:
 *   - agentUid  必填
 *   - sessionId 可选（给了就查该会话作用域）
 *   - scope     可选（显式作用域，优先级最高）
 *   - all=1     可选（列出该 agent 的全部作用域）
 */
memoryRoute.get("/status", (c) => {
    const agentUid = (c.req.query("agentUid") ?? "").trim();
    if (agentUid === "") {
        return c.json({ ok: false, error: "缺少 agentUid" }, 400);
    }

    if (c.req.query("all") === "1") {
        return c.json({ ok: true, scopes: listMemoryScopes(agentUid) });
    }

    const scope = resolveScope(c.req.query("scope"), c.req.query("sessionId"));
    return c.json({ ok: true, cursor: getMemoryCursor(agentUid, scope) });
});

/**
 * POST /api/memory/summarize
 *
 * Body:
 *   { agentUid: string, sessionId?: string, scope?: string }
 *
 * 行为：
 *   1. 取游标，读 `seq > summarized_seq` 的增量（不含 system 行）
 *   2. 无增量 → 直接返回 summarized=false（不调 LLM、不写库）
 *   3. 调该 agent 的 LLM 归纳事实
 *   4. **解析成功才推进游标**；解析失败返回 502 且游标不动（不丢数据）
 *
 * 返回：
 *   { ok, agentUid, scope, fromSeq, toSeq, summarized, factsChanged, messageCount, llm }
 */
memoryRoute.post("/summarize", async (c) => {
    // 1. 解析 body（保持宽松：body 解析失败按空对象处理，下面靠 agentUid 判空）
    let body: Record<string, unknown> = {};
    try {
        body = (await c.req.json()) as Record<string, unknown>;
    } catch {
        body = {};
    }

    const agentUid =
        typeof body.agentUid === "string" ? body.agentUid.trim() : "";
    if (agentUid === "") {
        return c.json({ ok: false, error: "缺少 agentUid" }, 400);
    }

    const scope = resolveScope(body.scope, body.sessionId);
    const sessionId =
        typeof body.sessionId === "string" ? body.sessionId.trim() : "";

    // 会话作用域必须校验会话存在，避免给不存在的会话累积孤儿记忆
    if (scope.startsWith("session:")) {
        const sid = scope.slice("session:".length);
        if (!hasSession(sid)) {
            return c.json({ ok: false, error: `会话不存在: ${sid}` }, 404);
        }
    }
    // 摘要必须有消息源：global 作用域没有会话就没有增量
    //
    // ⚠️ 消息来源必须与作用域**一致**：
    //    若 scope 是 session:A 而 body.sessionId 是 B，用 B 的消息推进 A 的游标
    //    会让两个会话的记忆互相串味（游标错位且难以察觉）。这里直接拒绝。
    const scopeSessionId = scope.startsWith("session:")
        ? scope.slice("session:".length)
        : "";
    if (scopeSessionId !== "" && sessionId !== "" && scopeSessionId !== sessionId) {
        return c.json(
            {
                ok: false,
                error: `scope 与 sessionId 不一致：scope=${scope}，sessionId=${sessionId}`,
            },
            400
        );
    }
    const sourceSessionId = scopeSessionId !== "" ? scopeSessionId : sessionId;
    if (sourceSessionId === "") {
        return c.json(
            { ok: false, error: "global 作用域的摘要必须提供 sessionId 作为消息来源" },
            400
        );
    }

    // 2. 读游标 + 增量
    const cursor = getMemoryCursor(agentUid, scope);
    const fromSeq = cursor.summarizedSeq;
    const messages = getMessagesSince(
        sourceSessionId,
        fromSeq,
        SUMMARIZE_BATCH_LIMIT
    );

    if (messages.length === 0) {
        return c.json({
            ok: true,
            agentUid,
            scope,
            fromSeq,
            toSeq: fromSeq,
            summarized: false,
            factsChanged: false,
            messageCount: 0,
            reason: "没有待摘要的新消息",
        });
    }

    // 3. 选 LLM：优先用该 agent 绑定的 llmRef（A5）；未绑定则回退到 llm[0]
    //    ⚠️ getSessionAgentBinding 永不返回 null（会话不存在时字段为 null），故无需判空。
    let llmName: string | null = null;
    if (sessionId !== "") {
        const binding = getSessionAgentBinding(sessionId);
        if (binding.agentUid === agentUid) {
            llmName = getAgentRegistry().agents.get(agentUid)?.llmRef ?? null;
        }
    }
    if (llmName === null) {
        llmName = getAgentRegistry().agents.get(agentUid)?.llmRef ?? null;
    }

    let resolved: ResolvedLlm | null = null;
    try {
        const envJson = loadEnvJson();
        resolved = resolveLlm(envJson.llm, llmName);
    } catch (e) {
        // env.json 读取失败：不能带病调用，直接报错且不推进游标
        console.error("🔴 [memory] 读取 env.json 失败:", e);
        return c.json({ ok: false, error: "读取 LLM 配置失败" }, 500);
    }
    if (!resolved) {
        return c.json({ ok: false, error: "env.json 中没有可用的 llm 配置" }, 500);
    }

    // 4. 调 LLM（超时即失败）
    const prompt = buildSummarizePrompt({
        previousFacts: cursor.facts,
        messages,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);
    // ⚠️ 不用 `let raw: string` + 在 catch 里 return：TS 的控制流分析不保证
    //    catch 必然 return，会报「使用前未赋值」。改为先取结果、再分支。
    const llmOutcome = await callSummarizeLlm(
        resolved.base,
        resolved.key,
        resolved.model,
        prompt,
        controller.signal
    )
        .then((text) => ({ ok: true as const, text }))
        .catch((e: unknown) => ({ ok: false as const, error: e }))
        .finally(() => clearTimeout(timer));

    if (!llmOutcome.ok) {
        console.error(
            "🔴 [memory] 摘要 LLM 调用失败（游标不推进）:",
            llmOutcome.error
        );
        return c.json(
            {
                ok: false,
                error: "摘要调用失败",
                detail:
                    llmOutcome.error instanceof Error
                        ? llmOutcome.error.message
                        : String(llmOutcome.error),
            },
            502
        );
    }
    const raw = llmOutcome.text;

    // 5. 解析：成功才推进游标
    const facts = parseSummarizeOutput(raw);
    // 本次实际消费到的最大 seq（不是批次上界 —— 否则会跳过错过的消息）
    const toSeq = messages[messages.length - 1]?.seq ?? fromSeq;
    const factsChanged = facts !== null && facts !== cursor.facts;

    const advanced = advanceMemory(agentUid, scope, fromSeq, toSeq, facts);

    return c.json({
        ok: true,
        agentUid,
        scope,
        fromSeq,
        toSeq,
        summarized: true,
        /** 游标是否真的推进了（false = 并发下已被他处推进，本次结果被丢弃） */
        advanced,
        factsChanged,
        messageCount: messages.length,
        llm: { name: resolved.name, model: resolved.model, fallback: resolved.fallback },
    });
});
