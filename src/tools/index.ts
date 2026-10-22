/**
 * src/tools/index.ts
 * 工具契约定义 + 动态加载器 + 执行分发
 *
 * 职责：
 * 1. 定义 Tool 契约（供 etc/ 下的工具文件实现）
 * 2. 启动时用 Bun.Glob 扫描 etc/tools 下所有 .ts，动态 import 并汇总注册表
 * 3. 对外提供 getToolDefinitions()（转 OpenAI tools 格式）与 executeTool()
 *
 * 安全：仅加载 etc/tools/ 白名单目录，绝不加载任意路径。
 *
 * R1.1 修复：function.name 合法性
 * OpenAI 及多数兼容网关要求 function.name 匹配 ^[a-zA-Z0-9_-]{1,64}$，
 * 而内部调用名形如 local.common.get_current_time（含点号），直接作为
 * function.name 会触发 400。因此：
 *   - 内部注册表 / 日志 / 前端展示：保留点号调用名（callName）
 *   - 模型可见的 function.name：点号 → 双下划线（wireName）
 *   - executeTool 入口：把 wireName 反解回 callName，兼容两种写法
 *
 * 修复记录（本次）：
 *   - [问题 5] loadTools 的 loaded 标志改为「加载成功后才置位」，
 *     并保证扫描异常时可重试，避免首次加载失败后工具永久失效。
 *   - [问题 6] toWireName 截断到 64 字符时记录到 truncatedWires；
 *     fromWireName 对截断名不再做有损的 replace 兜底，改为明确报错。
 *   - [问题 2] 新增 toDisplayName()，供 chat.ts 推送可读的 callName。
 *   - [US-CFG-1] loadTools 跳过以 _ 开头的共享模块（如 local/_shared.ts）。
 *
 * [需求域 T / v0.0.7] 平台工具能力扩展（US-T-01 ~ US-T-05）
 *   - T-01：Tool 契约新增可选 enabled 判定；过滤发生在 getToolDefinitions()
 *     每次被调用时（而非 loadTools 的一次性加载阶段），故热更立即生效（T-02）。
 *     本期仅联网工具会声明 enabled；现有文件工具仍在 handler 内校验开关，
 *     不因开关变化从模型可见列表移除（T-01 后半句 / AC-20）。
 *   - T-03：handler 增加可选第二参 ToolContext（signal / sessionId）；
 *     现有只声明一个参数的工具不改动也能编译并保持行为（AC-16）。
 *   - T-04：executeTool 透传 ctx；已中断则不启动工具、在途工具抛 AbortError
 *     时归一为 cancelled 信封，不向平台抛异常（R-37）。
 *   - T-05：命中但 enabled() 为 false 的工具返回结构化「已禁用」信封，不执行。
 *   - T-06：executeTool 是唯一执行出口，结果在此统一做与工具无关的长度兜底
 *     （capToolResult + env.TOOL_RESULT_MAX_CHARS，默认 32000）。
 */
import { resolve } from "path";
// [需求域 T / T-06] 结果长度兜底的上限来自配置（env.TOOL_RESULT_MAX_CHARS，默认 32000）
import { env } from "@/infra/env";

/**
 * [需求域 T / T-03] 工具处理函数的可选上下文。
 *
 * 只声明一个参数的工具（现有 13 个文件类工具全部如此）无需任何改动：
 * TS 允许「参数更少」的函数赋给「参数更多」的函数类型（AC-16）。
 */
export interface ToolContext {
    /** [T-04] 用户中断信号：工具内的耗时/网络操作应挂到该信号上，以便点「停止」时中止在途操作 */
    signal?: AbortSignal;
    /** [T-03] 会话标识：供需要「会话内暂存」的工具定位（如联网抓取的偏移续读，R-30） */
    sessionId?: string;
}

/** 工具契约：etc/ 下每个工具文件导出的单个工具结构 */
export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    // [T-03] 可选第二参：不声明也能编译（现有工具零改动）；[T-04] 中断信号经此透传
    handler: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
    /**
     * [T-01] 可选的启用判定：返回 false 的工具不出现在模型可见列表（getToolDefinitions 过滤），
     * 且若模型硬要调用（历史里残留的调用名），executeTool 返回「已禁用」信封而不执行（T-05）。
     * 约定：必须每次实时读取配置，不得缓存结果，否则热更失效（T-02）。
     */
    enabled?: () => boolean;
}

/** 注册表条目：调用名 → 工具 + 来源文件 */
interface ToolEntry {
    callName: string;   // 如 local.common.get_current_time（内部规范名）
    wireName: string;   // 如 local__common__get_current_time（模型可见名）
    tool: Tool;
    file: string;
}

/** 工具根目录：<项目根>/etc/tools */
const TOOLS_ROOT = resolve(import.meta.dir, "../../etc/tools");

/** 注册表（进程内单例，启动时构建一次） */
const registry = new Map<string, ToolEntry>();

/** wireName → callName 反查表（executeTool 用） */
const wireToCall = new Map<string, string>();

/**
 * 记录「因截断导致无法反解」的 wireName。
 * toWireName 在超长时截断到 64 字符，截断后的名字无法通过
 * replace(/__/g,".") 还原，必须依赖反查表；若反查表也未命中，
 * 则明确报错而非静默返回错误名字。
 */
const truncatedWires = new Set<string>();

let loaded = false;

/** 由文件绝对路径生成命名空间前缀，如 .../etc/tools/local/common.ts → local.common */
function toNamespace(file: string): string {
    const rel = file
        .slice(TOOLS_ROOT.length + 1)
        .replace(/\\/g, "/")
        .replace(/\.ts$/, "");
    return rel.split("/").join(".");
}

/**
 * 内部调用名 → 模型可见名
 * 点号替换为双下划线，并过滤掉所有非 [a-zA-Z0-9_-] 字符，确保符合
 * ^[a-zA-Z0-9_-]{1,64}$ 约束；超长时截断到 64 字符。
 *
 * 注意：截断会破坏「双下划线 ↔ 点号」的可逆性，因此截断名会被记入
 * truncatedWires，后续 fromWireName 对这类名字只认反查表。
 */
function toWireName(callName: string): string {
    const safe = callName.replace(/\./g, "__").replace(/[^a-zA-Z0-9_-]/g, "_");
    if (safe.length > 64) {
        const truncated = safe.slice(0, 64);
        truncatedWires.add(truncated);
        return truncated;
    }
    return safe;
}

/**
 * 模型可见名 → 内部调用名
 * 优先走反查表（唯一可靠来源）；
 * 未命中时：
 *   - 若该名是「截断名」，说明无法可靠反解 → 抛出明确错误；
 *   - 否则把双下划线还原为点号作为兜底（适用于未截断的常规名）。
 */
function fromWireName(wireName: string): string {
    const hit = wireToCall.get(wireName);
    if (hit) return hit;
    if (truncatedWires.has(wireName)) {
        throw new Error(
            `无法反解被截断的工具名: ${wireName}（原始名过长，已丢失映射）`
        );
    }
    return wireName.replace(/__/g, ".");
}

/**
 * 对外暴露：把模型返回的 wireName 还原为可读的 callName，
 * 供日志 / 前端展示使用（问题 2 修复）。
 * 反解失败时回退为原始名，保证展示逻辑不抛错。
 */
export function toDisplayName(wireName: string): string {
    try {
        return fromWireName(wireName);
    } catch {
        return wireName;
    }
}

/** 运行时校验：确认导出对象符合 Tool 契约 */
function isValidTool(t: unknown): t is Tool {
    if (!t || typeof t !== "object") return false;
    const o = t as Record<string, unknown>;
    return (
        typeof o.name === "string" &&
        typeof o.description === "string" &&
        typeof o.parameters === "object" &&
        typeof o.handler === "function"
    );
}

/**
 * 扫描并加载 etc/tools 下所有工具文件。
 *
 * 幂等：已成功加载则直接返回。
 * 可重试（问题 5 修复）：仅当「目录扫描 + 全部文件加载」均无致命错误时，
 * 才把 loaded 置为 true；否则保持 false，下次请求可重新尝试加载。
 */
export async function loadTools(): Promise<void> {
    if (loaded) return;

    // 每次重试前清空注册表，避免重复累积（正常路径下注册表为空）
    registry.clear();
    wireToCall.clear();
    truncatedWires.clear();

    let ok = true;

    try {
        const glob = new Bun.Glob("**/*.ts");
        for await (const rel of glob.scan({ cwd: TOOLS_ROOT, absolute: false })) {
            // [US-CFG-1] 跳过以 _ 开头的共享模块（如 local/_shared.ts），
            // 它们不导出 tools，仅被其他工具 import。
            // [FIX-WIN-01] Windows 下 glob 返回反斜杠相对路径（如 internet\_browser_cdp.ts），
            //   旧写法 rel.split("/") 切不开 → base 变成整串 → 下面「_ 前缀跳过」完全失效，
            //   启动日志会刷出一串「工具文件未导出 tools 数组，已跳过: internet\_browser_xxx.ts」。
            const relPath = rel.replace(/\\/g, "/");
            const base = relPath.split("/").pop() ?? "";
            if (base.startsWith("_")) continue;

            const full = resolve(TOOLS_ROOT, rel);
            try {
                const mod = await import(full);
                const list: unknown = mod.tools;
                if (!Array.isArray(list)) {
                    console.warn(`⚠️  工具文件未导出 tools 数组，已跳过: ${rel}`);
                    continue;
                }
                const ns = toNamespace(full);
                for (const raw of list) {
                    if (!isValidTool(raw)) {
                        console.warn(`⚠️  工具结构不合法，已跳过: ${rel}`);
                        continue;
                    }
                    const callName = `${ns}.${raw.name}`;
                    const wireName = toWireName(callName);
                    registry.set(callName, { callName, wireName, tool: raw, file: rel });
                    wireToCall.set(wireName, callName);
                }
            } catch (err) {
                // 单个工具文件加载失败：记录并标记整体未完全成功
                ok = false;
                console.error(`❌ 加载工具文件失败: ${rel}`, err);
            }
        }
    } catch (err) {
        // 目录扫描本身失败（如目录缺失/权限问题）：标记失败，允许下次重试
        ok = false;
        console.error(`❌ 扫描工具目录失败: ${TOOLS_ROOT}`, err);
    }

    if (ok) {
        loaded = true;
        console.log(`🔧 已加载工具 ${registry.size} 个: ${[...registry.keys()].join(", ") || "（无）"}`);
    } else {
        console.warn("⚠️  工具加载未完全成功，将在下次请求时重试");
    }
}

/** 转为 OpenAI Chat Completions 的 tools 参数格式 */
export function getToolDefinitions(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
    // [需求域 T / T-01、T-02] 过滤在「每次获取工具定义时」执行（不在 loadTools 里做），
    //   故 enabled() 结果变化后无需重启、下一次请求即刻生效。
    return [...registry.values()].filter((e) => isToolEnabled(e.tool)).map((e) => ({
        type: "function" as const,
        function: {
            name: e.wireName,          // 模型可见名：合法标识符（点号已转 __）
            description: e.tool.description,
            parameters: e.tool.parameters,
        },
    }));
}

/**
 * [需求域 T / T-01、T-05] 判断单个工具当前是否启用（纯函数，便于单测 N-08）。
 *
 * - 未声明 enabled（现有 13 个文件类工具全部如此）→ 恒为启用；
 * - 声明了 → 每次实时调用，不缓存（T-02 热更的前提）；
 * - 判定函数自身抛错 → 按「已禁用」处理并告警：不因某个工具的配置读取出错
 *   而让整条工具列表或整个请求失败。
 */
export function isToolEnabled(tool: Pick<Tool, "enabled">): boolean {
    if (typeof tool.enabled !== "function") return true;
    try {
        return tool.enabled() !== false;
    } catch (err) {
        console.warn("⚠️ [T-01] 工具启用判定抛错，按「已禁用」处理:", err);
        return false;
    }
}

/**
 * [需求域 T / T-04、T-05] 统一的结构化工具错误信封。
 * 形状与文件工具的 fail() 一致（{ ok:false, error:{ code, message } }），
 * 保证「结构化错误码不丢失」（R-37）且模型可读。
 */
export function toolError(code: string, message: string): string {
    return JSON.stringify({ ok: false, error: { code, message } });
}

/**
 * [需求域 T / T-06] 与工具无关的工具结果总长度兜底（纯函数，便于单测，AC-17）。
 *
 * 位置说明：executeTool 是唯一执行出口，因此在这里做一次统一兜底即可覆盖
 *   所有工具（含后续新增的联网工具，R-42 复用同一机制）。
 *
 * @param text     工具结果的文本形式（字符串原样 / 其余 JSON.stringify 后）
 * @param maxChars 上限字符数；<=0 或非数值视为不限制（配置缺失时回退默认值）
 * @returns 未超限时原样返回；超限时截断并在末尾追加标注（含原长），
 *          最终长度不超过 maxChars（标注本身按上限预留，极小的上限下会只剩标注）
 *
 * 注意：截断按字符前缀进行，若原结果是 JSON，截断后不再是合法 JSON ——
 *   标注里已明确告知原长与「缩小参数范围后重试」，由模型自行决定是否重取。
 */
export function capToolResult(text: string, maxChars: number): string {
    const limit = Number.isFinite(maxChars) ? Math.floor(maxChars) : 0;
    if (limit <= 0 || text.length <= limit) return text;
    const marker =
        `\n…[工具结果超长已截断：原长 ${text.length} 字符，上限 ${limit} 字符；` +
        `如需完整内容，请缩小参数范围后重试]`;
    const keep = Math.max(0, limit - marker.length);
    return text.slice(0, keep) + marker;
}

/** 执行工具：命中白名单则执行，异常内部兜底为可读错误字符串 */
export async function executeTool(
    callName: string,
    args: Record<string, unknown>,
    // [需求域 T / T-03、T-04] 可选上下文：中断信号 + 会话标识，透传给 handler 第二参
    ctx?: ToolContext
): Promise<string> {
    // 兼容模型返回 wireName（local__common__x）或 callName（local.common.x）
    let normalized: string;
    try {
        normalized = registry.has(callName) ? callName : fromWireName(callName);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `工具名无法解析: ${msg}` });
    }
    const entry = registry.get(normalized);
    if (!entry) {
        return JSON.stringify({ error: `未知工具: ${callName}` });
    }
    try {
        // [需求域 T / T-05] 命中但启用判定为否：返回结构化「已禁用」结果，不执行（P1）
        if (!isToolEnabled(entry.tool)) {
            return toolError(
                "tool_disabled",
                `工具 ${entry.callName} 当前已禁用（配置关闭），本次未执行；如需使用请修改配置后重试。`
            );
        }
        // [需求域 T / T-04] 调用前已被中断：不启动工具，直接返回 cancelled 信封
        if (ctx?.signal?.aborted) {
            return toolError("cancelled", "已取消：调用前请求已被中断，本次工具未执行。");
        }
        // [T-03/T-04] ctx 作为可选第二参透传（现有单参工具不受影响，AC-16）
        // [T-06] executeTool 是唯一执行出口，结果在此统一做与工具无关的长度兜底
        const result = await entry.tool.handler(args ?? {}, ctx);
        return capToolResult(
            typeof result === "string" ? result : JSON.stringify(result),
            env.TOOL_RESULT_MAX_CHARS
        );

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // [需求域 T / T-04] 在途工具因中断信号失败（AbortError）：归一为 cancelled 信封，
        //   与「工具自身异常」区分，便于日志与模型判断「是用户停止」而非工具缺陷
        //   （工具内部永不向平台抛业务异常，R-37）。
        if (err instanceof Error && err.name === "AbortError") {
            return toolError("cancelled", "已取消：工具在途被中断。");
        }
        return JSON.stringify({ error: `工具执行失败: ${msg}` });
    }
}
