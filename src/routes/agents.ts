/**
 * src/routes/agents.ts
 * [agent / 第 9 步 · 模块 7-A13] agent 配置的读写接口
 *
 *   GET    /api/agents                列表（含 status / invalidReason，供 A19 角标）
 *   GET    /api/agents/:path{.+}      详情（AGENT.md + setup.json 原文 + 解析结果）
 *   POST   /api/agents                新建或覆盖（body: { path, body?, setup? }）
 *   DELETE /api/agents/:path{.+}      删除整个目录
 *
 * ⚠️ 与对话主链路的关系：
 *    本路由只读写 etc/agents 下的文件，**不 import chat.ts、不参与 SSE**。
 *    写盘之后注册表的刷新依赖扫描器的指纹机制（下次请求自动重扫），
 *    因此这里不主动清缓存 —— 避免写操作与并发对话抢同一个单例。
 *
 * ⚠️ 所有路径参数都要过 checkAgentPath：`:path{.+}` 会捕获含斜杠的多段路径，
 *    必须逐段校验，否则 `../` 能穿越出 etc/agents。
 */
import { Hono } from "hono";
// 走门面（第 1–8 步确立的唯一出口约定）：扫描与读写符号均由 @/agents 统一转发
import {
    ensureAgentRegistry,
    getAgentRegistry,
    isAgentRegistryReady,
    computeAgentFingerprint,
    deleteAgent,
    normalizeAgentPath,
    readAgentFile,
    upsertAgent,
    validateAgentPath,
    walkAgentFiles,
    type AgentRecord,
    type ScanDeps,
} from "@/agents";
import { AGENTS_ROOT } from "@/agents/paths";
import { loadEnvJson, foldLlmName } from "@/infra/envJson";

const app = new Hono();

/* ============================================================
 * 公共：扫描 deps 与记录整形
 * ============================================================ */

/** 构造扫描 deps：合法 llm 名字集合来自 env.json 的 llm[].name（[BR-6] 折叠口径） */
function scanDeps(): ScanDeps {
    // [BR-6] 集合按**折叠后**构建，与 resolveLlm / findLlmIndex 同口径；
    //   否则 setup.json 写 "MAIN" 会在这里被判 unknown_llm，而运行期却能解析到 main。
    const names = new Set<string>();
    try {
        for (const g of loadEnvJson().llm ?? []) {
            if (g && typeof g.name === "string" && g.name !== "") names.add(foldLlmName(g.name));
        }
    } catch {
        /* env.json 不可用时视为「没有任何合法 llm」，llmRef 会被判 unknown_llm */
    }
    return {
        // 名字集合为空时放行（等价于不校验），避免 env.json 缺失导致整批 agent 变 invalid
        isKnownLlm: (n: string) => names.size === 0 || names.has(foldLlmName(n)),
        mintUid: false, // 【关键】读写接口不允许悄悄改写磁盘上的 uid
    };
}

/** AgentRecord → 列表项（去掉 body/dir 等大字段） */
function toListItem(rec: AgentRecord) {
    return {
        uid: rec.uid,
        name: rec.name,
        path: rec.path,
        isDefault: rec.isDefault,
        title: rec.title,
        description: rec.description,
        llmRef: rec.llmRef,
        skillsMode: rec.skillsMode,
        skillsAllow: rec.skillsAllow,
        toolsAllow: rec.toolsAllow,
        toolsDeny: rec.toolsDeny,
        maxRounds: rec.maxRounds,
        memoryEnabled: rec.memoryEnabled,
        systemBudget: rec.systemBudget,
        bodySize: rec.bodySize,
        status: rec.status,
        invalidReason: rec.invalidReason,
    };
}

/**
 * 按 path 反查记录。
 *
 * ⚠️ 不能走 reg.byPath：byPath 只登记 status === "ok" 的记录（scan.ts ⑥），
 *    invalid 的 agent 反而正是配置页要展示原因的对象（A19 角标）。
 * ⚠️ 也不能用 reg.agents.get(uid)：uid 重复时 key 会变成 `uid#path`（scan.ts ⑥ 的兜底），
 *    按 uid 直接取会漏。
 *    因此统一遍历 values() 按 r.path 匹配 —— 数据量是「几十个 agent」，代价可忽略。
 */
function findByPath(path: string): AgentRecord | null {
    const reg = getAgentRegistry();
    for (const r of reg.agents.values()) {
        if (r.path === path) return r;
    }
    return null;
}

/* ============================================================
 * GET /api/agents —— 列表
 * ============================================================ */
app.get("/", async (c) => {
    const deps = scanDeps();
    const reg = await ensureAgentRegistry(deps);

    const items = [...reg.agents.values()]
        .map(toListItem)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    return c.json({
        ok: true,
        items,
        warnings: reg.warnings,
        failed: reg.failed,
        scannedAt: reg.scannedAt,
        // 【诊断】临时暴露扫描器视角，用于定位「文件在盘上但列表为空」——
        // 如果 filesWalked 与磁盘实际文件数不符，说明 walkAgentFiles 的根路径有问题。
        diag: (() => {
            const w = walkAgentFiles();
            return {
                agentsRoot: AGENTS_ROOT,
                filesWalked: w.length,
                // 本轮现算的指纹 vs 注册表里持有的指纹：不等却没重扫，就是 early-return 判据有问题
                fingerprint: reg.fingerprint,
                liveFingerprint: computeAgentFingerprint(w),
                walked: w.map((s) => s.rel),
                registryReady: isAgentRegistryReady(),
            };
        })(),
        // 【A19】列表角标：invalid 数量直接给前端，避免前端再算一遍
        counts: {
            total: items.length,
            ok: items.filter((x) => x.status === "ok").length,
            invalid: items.filter((x) => x.status === "invalid").length,
        },
    });
});

/* ============================================================
 * GET /api/agents/:path{.+} —— 详情
 * ============================================================ */
app.get("/:path{.+}", async (c) => {
    const raw = c.req.param("path");
    const path = normalizeAgentPath(raw);

    const bad = validateAgentPath(path);
    if (bad) return c.json({ ok: false, error: bad }, 400);

    // 详情允许查看磁盘上存在但注册表里没有（例如刚写、尚未被扫到）的目录
    const file = readAgentFile(path);
    if (!file.ok) return c.json({ ok: false, error: file.error }, 400);

    await ensureAgentRegistry(scanDeps());
    const rec = findByPath(path);

    if (!rec && file.body === "" && file.setupJson === "") {
        return c.json({ ok: false, error: `agent 不存在：${path}` }, 404);
    }

    return c.json({
        ok: true,
        path,
        body: file.body,
        setupJson: file.setupJson,
        setupError: file.setupError ?? null,
        record: rec ? toListItem(rec) : null,
    });
});

/* ============================================================
 * POST /api/agents —— 新建 / 覆盖
 * ============================================================ */
app.post("/", async (c) => {
    let payload: unknown;
    try {
        payload = await c.req.json();
    } catch {
        return c.json({ ok: false, error: "请求体必须是 JSON" }, 400);
    }
    if (!payload || typeof payload !== "object") {
        return c.json({ ok: false, error: "请求体必须是对象" }, 400);
    }
    const p = payload as Record<string, unknown>;

    const rawPath = p.path;
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return c.json({ ok: false, error: "缺少 path" }, 400);
    }
    const path = normalizeAgentPath(rawPath);
    const bad = validateAgentPath(path);
    if (bad) return c.json({ ok: false, error: bad }, 400);

    if (p.body !== undefined && typeof p.body !== "string") {
        return c.json({ ok: false, error: "body 必须是字符串" }, 400);
    }
    if (p.setup !== undefined && (typeof p.setup !== "object" || p.setup === null || Array.isArray(p.setup))) {
        return c.json({ ok: false, error: "setup 必须是对象" }, 400);
    }
    if (p.body === undefined && p.setup === undefined) {
        return c.json({ ok: false, error: "body 与 setup 至少要提供一个" }, 400);
    }

    // llmRef 合法性由这里注入（write.ts 不读配置）；[BR-6] 折叠口径与 scanDeps 一致
    const names = new Set<string>();
    try {
        for (const g of loadEnvJson().llm ?? []) {
            if (g && typeof g.name === "string" && g.name !== "") names.add(foldLlmName(g.name));
        }
    } catch {
        /* ignore */
    }
    const isKnownLlm = (n: string) => names.size === 0 || names.has(foldLlmName(n));

    const res = upsertAgent(
        {
            path,
            body: p.body as string | undefined,
            setup: p.setup as never,
        },
        { isKnownLlm },
    );

    if (!res.ok) {
        // 【D-1】把「保留名 / 默认智能体保护」与普通校验错误区分开，
        //   前端据此给出不同引导（前者应该说「换个名字」，后者是「改配置」）。
        const err = res.error ?? "写入失败";
        const code = err.includes("保留名字") || err.includes("不允许改名或移动") || err.includes("不允许删除")
            ? "agent_reserved"
            : "agent_write_failed";
        return c.json({ ok: false, error: err, code }, 400);
    }

    return c.json({ ok: true, path: res.path, overwritten: res.overwritten === true });
});

/* ============================================================
 * DELETE /api/agents/:path{.+} —— 删除
 * ============================================================ */
app.delete("/:path{.+}", (c) => {
    const raw = c.req.param("path");
    const path = normalizeAgentPath(raw);

    const bad = validateAgentPath(path);
    if (bad) return c.json({ ok: false, error: bad }, 400);

    const res = deleteAgent(path);
    if (!res.ok) {
        // 【D-1】默认智能体不可删 → 403（有权限语义，比 400 更准确）；
        //   目录不存在 → 404；其余 → 400。
        const isProtected = (res.error ?? "").includes("不允许删除");
        const status = isProtected ? 403 : (res.error === "目录不存在" ? 404 : 400);
        return c.json(
            {
                ok: false,
                error: res.error ?? "删除失败",
                code: isProtected ? "agent_reserved" : "agent_delete_failed",
            },
            status,
        );
    }

    return c.json({ ok: true, path: res.path });
});

export default app;
