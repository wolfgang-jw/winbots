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
 */
import { resolve } from "path";

/** 工具契约：etc/ 下每个工具文件导出的单个工具结构 */
export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
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
    return [...registry.values()].map((e) => ({
        type: "function" as const,
        function: {
            name: e.wireName,          // 模型可见名：合法标识符（点号已转 __）
            description: e.tool.description,
            parameters: e.tool.parameters,
        },
    }));
}

/** 执行工具：命中白名单则执行，异常内部兜底为可读错误字符串 */
export async function executeTool(
    callName: string,
    args: Record<string, unknown>
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
        const result = await entry.tool.handler(args ?? {});
        return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `工具执行失败: ${msg}` });
    }
}
