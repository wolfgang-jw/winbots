/**
 * src/tools/index.ts
 * 工具契约 + 注册表门面 + 执行分发
 *
 * 职责（规范 §8 / §13）：
 *   1. 定义 Tool / ToolContext 契约（供 etc/tools 下的工具文件实现）
 *   2. ensureToolRegistry()：目录指纹校验 + 可重入扫描
 *   3. getToolDefinitions()：按「祖先目录 AND 组开关 AND 工具自身条件」组装清单，
 *      打一行可见性日志；全部关闭时返回空数组（调用方据此不下发 tools 字段）
 *   4. executeTool()：唯一执行出口，按「不存在 / 已停用 / 暂不可用」分级回应
 *
 * 注册表本身在 src/tools/scan.ts；取值与门禁判定在 src/infra/settings.ts。
 * ⚠️ 本文件不得再持有「一次性加载」的状态（§4.1 明令禁止进程内永久持有）。
 *
 * 安全：仅加载 etc/tools/ 白名单目录，绝不加载任意路径。
 *
 * R1.1：function.name 合法性
 * OpenAI 及多数兼容网关要求 function.name 匹配 ^[a-zA-Z0-9_-]{1,64}$，
 * 而内部调用名形如 local.common.get_current_time（含点号），直接作为
 * function.name 会触发 400。因此：
 *   - 内部注册表 / 日志 / 前端展示：保留点号调用名（callName）
 *   - 模型可见的 function.name：路径段 + 双下划线（visibleName，见 paths.ts）
 *   - executeTool 入口：只查表，不做字符串反解（§3.3 键只生成、不反解析）
 *
 * [需求域 T] 平台工具能力扩展：
 *   - T-01/T-02：Tool.enabled 每次实时求值，getToolDefinitions() 每次重新组装；
 *   - T-03：handler 可选第二参 ToolContext（signal / sessionId）；
 *   - T-04：executeTool 透传 ctx；在途工具抛 AbortError 时归一为 cancelled 信封；
 *   - T-05：命中但 enabled() 为 false → 结构化「已停用」信封，不执行；
 *   - T-06：executeTool 是唯一执行出口，结果在此统一做与工具无关的长度兜底。
 */
import { env } from "@/infra/env";
import { MAX_TOOL_ENTRIES } from "./paths";
import { ensureRegistry, getRegistry, type Registry } from "./scan";
import { groupState } from "@/infra/settings";
// [模块 5 · 第 4 步 / A10] 清单与执行的**同口径**判据容器。
//   ⚠️ 必须是 `import type`：本文件在运行期不得依赖 agents/（工具子系统不认识 agent）。
//      「谁来判定放行」完全在 chat.ts：它把 ToolFilter 传进来，
//      本文件只调用 filter.allows(...)，不自带任何 allow/deny 逻辑。
//   ⚠️ 不要为了「能调用判定函数」把它改成值导入：那会让 tools → agents → match
//      进入运行期模块图，破坏「第 4 步不接线」（判据 V5）。
import type { ToolFilter } from "@/agents";
// ⚠️ 迁移后不再 import @/infra/migrate（迁移文档 4.2 / 4.8）：
//    存量迁移（.env → env.json）已并入启动链的 envJson.migrateFromDotenv()，早于任何请求；
//    本文件跑在请求边界，太晚，且旧的 parseEnvText 已随 .env 支持一并删除。
// [skill / 升级 §3.4] 元工具 skill__get_l2：代码内置、配置页看不见、开关关不掉。
//   ⚠️ 环依赖（R5）：skills/l2tool.ts **不得** import 本文件（连 `import type` 也不行，
//      Bun 直跑 .ts 不保证擦除 type-only import，会成环并在启动时报
//      `L2_TOOL_CALL_NAME is not defined`）。本文件对它是唯一的**值**导入方向。
//      改动任一侧前先看 l2tool.ts 头注释。
//   ⚠️ 导入清单必须与实际使用对齐：executeTool() 里比较 `L2_TOOL_CALL_NAME`，
//      漏 import 会在 Bun 直跑（不做类型检查）时报 `L2_TOOL_CALL_NAME is not defined`。
//      tsc --noEmit 能抓到这类漏，因此合并前务必跑一遍（§9.1）。
import {
    l2Tool,
    L2_TOOL_VISIBLE_NAME,
    L2_TOOL_CALL_NAME,
    L2_TOOL_DESCRIPTION,
} from "@/skills/l2tool";

/**
 * [需求域 T / T-03] 工具处理函数的可选上下文。
 *
 * 只声明一个参数的工具无需任何改动：
 * TS 允许「参数更少」的函数赋给「参数更多」的函数类型。
 */
export interface ToolContext {
    /** [T-04] 用户中断信号：工具内的耗时/网络操作应挂到该信号上，以便点「停止」时中止在途操作 */
    signal?: AbortSignal;
    /** [T-03] 会话标识：供需要「会话内暂存」的工具定位（如联网抓取的偏移续读，R-30） */
    sessionId?: string;
    /**
     * [skill / 升级 §5.2] 本轮参与装配的技能名数组（如 ["log_triage"]）；无技能时缺省。
     * 只用于**展示与审计**：审批弹窗「来源技能」、审计日志来源字段。
     * ⚠️ 不得据此放宽任何判定（N-SK-12：skill 没有免审批路径）。
     */
    skills?: string[];
}

/** 工具契约：etc/ 下每个工具文件导出的单个工具结构 */
export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    // [T-03] 可选第二参：不声明也能编译；[T-04] 中断信号经此透传
    handler: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
    /**
     * [T-01] 可选的启用判定：返回 false 的工具不出现在模型可见列表（getToolDefinitions 过滤），
     * 且若模型硬要调用（历史里残留的调用名），executeTool 返回「已停用」信封而不执行（T-05）。
     * 约定：必须每次实时读取配置，不得缓存结果，否则热更失效（T-02）。
     * ⚠️ 这是 §8.3 的「工具自身声明的附加条件」（如 shell 的权限档位），
     *    **不再**承担「组是否启用」的判定 —— 后者由目录 / 组开关统一负责（§8.4）。
     */
    enabled?: () => boolean;
}

/**
 * 对话请求 / 配置页的统一入口：指纹校验 + 可重入扫描。
 * 幂等、可并发调用（重入去重由 scan.ts 的 in-flight 保证）。
 *
 * ⚠️ 迁移后**只做两件事**：托管键缓存刷新 + 扫描。
 *    存量迁移已上移到启动链（env.ts 模块顶层，见迁移文档 4.3.4），不再由请求边界触发。
 */
export async function ensureToolRegistry(opts: { force?: boolean } = {}): Promise<void> {
    // ⚠️ 改造后这里**不再**刷新任何「全局托管值」缓存：工具开关 / 设置项已改为
    //    每 agent 一份（setup.json），取值由请求上下文的 AsyncLocalStorage 承载
    //    （见 @/infra/toolConfigContext 与 @/agents/toolConfig 的用法）。
    //    因此本函数只剩「目录指纹校验 + 可重入扫描」这一件事。
    await ensureRegistry(opts);
}

/** OpenAI Chat Completions 的 tools 条目形状 */
export interface ToolDef {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * 组装「本次请求的模型可见工具清单」（规范 §8.3 / §8.5 / §8.7）。
 * 调用方（chat.ts）在**请求边界**调用一次，后续工具轮次复用同一份（§8.5 快照粒度）。
 *
 * [skill / 升级 §3.5] 清单与「开了哪些技能」**无关**：技能不再收窄工具面，
 *   末尾额外追加 1 条元工具 skill__get_l2（不计入 MAX_TOOL_ENTRIES）。
 */
export function getToolDefinitions(opts?: ToolFilter): ToolDef[] {
    const reg = getRegistry();
    const picked: Array<{ name: string; def: ToolDef }> = [];
    const excluded: Array<{ groupId: string; reason: "dir_off" | "group_off" | "suspended" }> = [];
    const selfDisabled: string[] = [];

    for (const groupId of [...reg.groups.keys()].sort()) {
        const g = reg.groups.get(groupId);
        if (!g) continue;
        const st = groupState(groupId);
        if (!st.available) {
            excluded.push({ groupId, reason: st.reason });
            continue;
        }
        let kept = 0;
        for (const it of g.items) {
            // §8.3 第三环节：工具自身声明的附加条件（如 shell 的权限档位）
            if (!isToolEnabled(it.tool)) continue;
            // [模块 5 · 第 4 步 / A10] 第四环节：agent 侧收窄（**必须在全局三条件之后**）。
            //   顺序反了 → 白名单会把全局关掉的工具放回来（后门）。
            //   opts 缺省（未绑定 agent）→ 不进这一步，与改造前逐字节一致。
            if (opts && !opts.allows({ visibleName: it.visibleName, callName: it.callName })) {
                continue;
            }
            kept += 1;
            picked.push({
                name: it.visibleName,
                def: {
                    type: "function",
                    function: {
                        name: it.visibleName,
                        description: it.tool.description,
                        parameters: it.tool.parameters,
                    },
                },
            });
        }
        // 组可用、但组内工具一条都没留下（自身条件不成立 / 被 agent 收窄）→ 记下来，
        //   否则日志里「可见 0 个」无从定位。
        if (kept === 0 && g.items.length > 0) selfDisabled.push(groupId);
    }

    // 顺序固定为「可见名字典序」：与文件系统遍历顺序解耦，清单不抖动
    picked.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let list = picked.map((p) => p.def);

    // §8.5 条目总数上限：按确定且可复现的顺序取舍并告警
    if (list.length > MAX_TOOL_ENTRIES) {
        const dropped = list.length - MAX_TOOL_ENTRIES;
        list = list.slice(0, MAX_TOOL_ENTRIES);
        console.warn(`⚠️  [T-VIS] 可见工具超过上限 ${MAX_TOOL_ENTRIES} 条，已按可见名字典序截掉 ${dropped} 条`);
    }
    const userToolCount = list.length;

    // ✅ [skill / 升级 §3.4] 元工具在**截断之后**追加。
    //    顺序颠倒 → 条目满时元工具被截掉 → L2 加载直接失效（本次最容易漏的一处）。
    //    它不计入 MAX_TOOL_ENTRIES：平台能力，不是用户可配工具。
    //    每次调用都新建 list，因此不存在「多次调用重复追加」的累积问题。
    //
    // [D-16 方案②] 但「追加」有条件：**该 agent 至少有 1 个可用技能**才追加。
    //   理由：skill__get_l2 的唯一用途是读技能 L2 手册；没有任何技能时它照旧出现在
    //   清单里，等于给模型一张点了必然报错的入口，也与 BR-1「仅在配置中列出了的才可用」
    //   相悖。技能数由调用方经 ToolFilter.skillCount 传入（chat.ts / routes/skills.ts）。
    //   ⚠️ 缺省（无 opts 或未填 skillCount）= 0 = 不追加。这是刻意的保守方向：
    //      漏传只会少给元工具，不会凭空空出一张工具面。
    const hasSkill = (opts?.skillCount ?? 0) > 0;
    if (hasSkill) {
        const metaDef: ToolDef = {
            type: "function",
            function: {
                name: L2_TOOL_VISIBLE_NAME,
                description: L2_TOOL_DESCRIPTION,
                parameters: l2Tool.parameters,
            },
        };
        list = [...list, metaDef];
    }

    // §8.7 一行可诊断日志：可见数量 + 被排除的组与原因（三种原因互相可区分）；不含任何取值
    const detail = excluded.length === 0
        ? "无"
        : excluded.map((e) => `${e.groupId}(${e.reason})`).join("、");
    const selfOff = selfDisabled.length === 0
        ? ""
        : `｜组可用但组内工具全部未通过筛选：${selfDisabled.join("、")}`;
    // [D-16 方案②] 元工具是否追加要进日志：排查「模型为什么没拿到 skill__get_l2」时，
    //   光看「用户工具 N」看不出来，必须知道本次是「0 技能所以不追加」还是「被截掉了」。
    const metaPart = hasSkill ? ` + 元工具 1` : ` + 元工具 0（该 agent 无可用技能）`;
    console.log(
        `🧰 [T-VIS] 模型可见工具 ${list.length} 个（用户工具 ${userToolCount}${metaPart}）` +
        `｜排除 ${excluded.length} 组：${detail}${selfOff}`,
    );

    return list;
}

/**
 * [需求域 T / T-01、T-05] 判断单个工具当前是否启用（纯函数，便于单测 N-08）。
 *
 * - 未声明 enabled → 恒为启用；
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

/**
 * 执行工具（唯一执行出口）。
 *
 * 语义分级（§8.6）：名称无对应工具 → tool_not_found；组/祖先被关闭 → tool_disabled；
 *   组挂起 → tool_unavailable。文案一律「引导换途径」，禁止「请修改配置后重试」——
 *   模型不具备修改配置的能力，这类文案会诱导原地重试。
 */
export async function executeTool(
    rawName: string,
    args: Record<string, unknown>,
    ctx?: ToolContext,
    // [模块 5 · 第 4 步 / A10] 第 4 参（不是第 3 参）：ctx 已被 chat.ts 使用，
    //   插在它之前会破坏所有既有调用点；加在末尾是唯一兼容位置。
    //   缺省 → 行为与改造前逐字节一致（兼容路径，§1.4 A8）。
    opts?: ToolFilter,
): Promise<string> {
    // ✅ [skill / 升级 §3.4] 元工具：代码内置、无工具组、不受组开关与门禁约束。
    //    ⚠️ 必须放在 getRegistry() / 名称解析之前（它不在注册表里，查表会得到 tool_not_found）。
    //    ⚠️ 结果仍走 capToolResult：长度兜底是 executeTool 的统一职责（T-06「不动」）。
    if (rawName === L2_TOOL_VISIBLE_NAME || rawName === L2_TOOL_CALL_NAME) {
        if (ctx?.signal?.aborted) {
            return toolError("cancelled", "已取消：本次工具未执行。");
        }
        try {
            const out = await l2Tool.handler(args ?? {}, ctx);
            return capToolResult(
                typeof out === "string" ? out : JSON.stringify(out),
                env.TOOL_RESULT_MAX_CHARS,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return JSON.stringify({ error: `工具执行失败: ${msg}` });
        }
    }

    const reg = getRegistry();

    // ① 名称解析：wireName（local__shell__run）与 callName（local.shell.run）都接受。
    //    只查表，不做字符串反解（§3.3：键只生成、不反解析）。
    const callName = reg.wireToCall.get(rawName) ?? (reg.tools.has(rawName) ? rawName : undefined);
    const rec = callName ? reg.tools.get(callName) : undefined;

    if (rec) {
        // ② 执行时实时复查（§8.5：快照可以有，判定必须实时）
        const st = groupState(rec.groupId);
        if (!st.available) {
            return st.reason === "suspended"
                ? toolError(
                    "tool_unavailable",
                    `工具 ${rec.callName} 暂不可用（所属工具组加载失败），本次未执行。` +
                    `请改用其他可用工具完成任务，或直接说明该能力当前不可用。`,
                )
                : toolError(
                    "tool_disabled",
                    `工具 ${rec.callName} 已停用（所属工具组当前处于关闭状态），本次未执行。` +
                    `请改用其他可用工具完成任务，或直接说明该能力当前不可用。`,
                );
        }
        if (!isToolEnabled(rec.tool)) {
            return toolError(
                "tool_disabled",
                `工具 ${rec.callName} 已停用（自身启用条件不成立），本次未执行。请改用其他可用工具完成任务。`,
            );
        }
        // [模块 5 · 第 4 步 / A10] 执行侧的 agent 收窄：与清单**同一个**容器、同一个函数。
        //   ⚠️ 位置：必须在「组可用」与「自身启用」之后 —— 那两个状态比「未授权」更根本；
        //      顺序反了会把「工具已停用」报成「未授权」，把用户引向错误的修复方向。
        if (opts && !opts.allows({ visibleName: rec.visibleName, callName: rec.callName })) {
            return toolNotAllowedEnvelope(rec.visibleName);
        }
        if (ctx?.signal?.aborted) {
            return toolError("cancelled", "已取消：调用前请求已被中断，本次工具未执行。");
        }
        try {
            const result = await rec.tool.handler(args ?? {}, ctx);
            return capToolResult(
                typeof result === "string" ? result : JSON.stringify(result),
                env.TOOL_RESULT_MAX_CHARS,
            );
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                return toolError("cancelled", "已取消：工具在途被中断。");
            }
            const msg = err instanceof Error ? err.message : String(err);
            return JSON.stringify({ error: `工具执行失败: ${msg}` });
        }
    }

    // ③ 未注册：仍可能是「组在、但这个组已被挂起（连工具名都没加载出来）」
    const ownerId = findGroupByVisibleName(reg, rawName);
    if (ownerId) {
        const st = groupState(ownerId);
        if (!st.available) {
            return st.reason === "suspended"
                ? toolError(
                    "tool_unavailable",
                    `工具 ${rawName} 暂不可用（所属工具组加载失败），本次未执行。请改用其他可用工具完成任务。`,
                )
                : toolError(
                    "tool_disabled",
                    `工具 ${rawName} 已停用（所属工具组当前处于关闭状态），本次未执行。请改用其他可用工具完成任务。`,
                );
        }
    }
    // [模块 5 · 第 4 步 / A10] 未注册 + agent 判据明确不放行 → tool_not_allowed，
    //   而不是 tool_not_found。两者对模型的引导方向完全不同：
    //   「改名字」 vs 「换途径 / 要授权」；报错码错了会引发无效重试。
    //   ⚠️ 不能把「所有不存在的名字」都报成未授权（那会让真正的拼写错误无从发现）；
    //      容器缺省时仍落到 tool_not_found（T25）。
    if (opts && !opts.allows({ visibleName: rawName, callName: rawName })) {
        return toolNotAllowedEnvelope(rawName);
    }
    return toolError(
        "tool_not_found",
        `不存在名为 ${rawName} 的工具。本次请求的可用工具见 tools 字段；如需该能力请改用其他工具。`,
    );
}

/**
 * [模块 5 · 第 4 步] `tool_not_allowed` 信封（在 tools/ 内就地拼）。
 *
 * ⚠️ 为什么不在 tools/index.ts 里 import agents/toolPolicy 的 toolNotAllowed()：
 *   那是值导入，会破坏 V5（tools 运行期不依赖 agents）。
 *   代价是这段 message 与 toolPolicy.toolNotAllowed 的 message 必须**逐字一致**：
 *   由文档 §七 V11 的 grep + 人工 diff 兜住，改文案时两处一起改。
 *
 * ⚠️ 文案纪律（裁决 D-4-2）：不写「请新建会话」——该建议只对「目录被删」成立，
 *   而本信封也用于 setup.json 损坏 / uid 重复，那两种情形新建会话解决不了问题。
 */
function toolNotAllowedEnvelope(visibleName: string): string {
    return JSON.stringify({
        ok: false,
        error: {
            code: "tool_not_allowed",
            message:
                `工具 ${visibleName} 未授权给当前 agent，本次未执行。` +
                `请改用其他可用工具完成任务；若确认需要该能力，请联系管理员为当前 agent 添加授权。`,
        },
    });
}

/**
 * 按可见名前缀反查所属组（§8.6）。
 * 命名规则禁止 `__` 出现在任何一段里（§5），因此前缀匹配不会撞到别的组
 * （`local__shell` 不会误匹配 `local__shellx__run`：后者前缀是 `local__shellx`）。
 */
function findGroupByVisibleName(reg: Registry, wireName: string): string | undefined {
    for (const g of reg.groups.values()) {
        if (wireName.startsWith(`${g.visiblePrefix}__`)) return g.id;
    }
    return undefined;
}

/** 展示名：wireName → 可读 callName（查表；未注册时原样返回，不影响展示） */
export function toDisplayName(wireName: string): string {
    return getRegistry().wireToCall.get(wireName) ?? wireName;
}
