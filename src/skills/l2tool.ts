/**
 * src/skills/l2tool.ts
 * 元工具：按技能名取回其 L2 正文。**代码内置，不进 etc/tools**（升级版 §3.4）。
 *
 * ⚠️ 只读注册表内存：不做 IO、不触发扫描、不执行用户内容。
 * ⚠️ 断环（升级版 R5）：本文件**不得** import `@/tools/index`——连 `import type` 也不行。
 *    `tools/index.ts` 要引本文件的 l2Tool 合并清单；Bun 直接运行 .ts 时不保证擦除
 *    type-only import（tsconfig 又开了 `verbatimModuleSyntax`），一旦保留即成环，
 *    启动时报 `L2_TOOL_CALL_NAME is not defined`。
 *    因此：① 工具形状用下方的本地 `L2ToolSpec` 结构化类型（TS 结构化子类型，
 *    赋给 tools/index.ts 的 `Tool` 无需转换）；② 错误信封用 `l2error`（与
 *    tools/index.ts 的 `toolError` 形状逐字一致，但**故意不复用其名字**，
 *    避免 `grep toolError` 时误以为这里导入了它）。
 */
// [FIX-SKILLTOGGLE] 技能开关必须走技能侧取值函数（isSkillToggleOn）：
//   工具侧 isToggleOn 查的是 enabledToggles（TOOLON__*），技能键 SKILLON__* 永远不在其中，
//   会让本元工具对所有技能恒返回 skill_disabled，与 assemble.ts 已装配出该技能的事实矛盾。
//   assemble.ts 采用同一写法（isSkillToggleOn as isToggleOn），此处此前漏改。
import { isSkillToggleOn } from "@/infra/settings";
import { getSkillRegistry, type SkillRecord } from "./scan";
import { SKILL_NAME_PATTERN } from "./paths";
import { joinSections, layer } from "./markdown";
import { checkRequiredTools } from "./availability";

/** 模型可见的 function.name（双下划线；OpenAI 要求 ^[a-zA-Z0-9_-]{1,64}$） */
export const L2_TOOL_VISIBLE_NAME = "skill__get_l2";
/** 内部调用名（点号）；executeTool 两种都接受 */
export const L2_TOOL_CALL_NAME = "skill.get_l2";

export const L2_TOOL_DESCRIPTION =
  "读取某个已开启技能（skill）的 L2 操作手册正文（## 方法 / ## 输出格式 / ## 自检 等）。" +
  "当用户需求命中系统提示「可用技能」里某条的使用时机时，**先调用本工具取回 L2，再严格按其步骤执行**；" +
  "多个技能同时适用时按任务性质择优，一次只取一个。参数 name 用系统提示里列出的技能名或完整目录路径。";

/**
 * 元工具的工具形状（与 `src/tools/index.ts` 的 `Tool` 结构一致）。
 *
 * ⚠️ [断环 R5] 这里是**本地结构化声明**，不是从 `@/tools/index` 导入的类型。
 * 依赖 TS 的结构化子类型：`l2Tool` 将来若被塞进 `Tool` 数组也无需转换（编译期自动兼容）。
 * 代价：`ToolContext` 若新增字段，本文件**不会**自动跟进——新增字段均为可选，
 * 本文件只读 `ctx.signal`，因此不影响正确性。
 */
export interface L2ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 第二参与 `ToolContext` 保持结构兼容（`signal` 是唯一用到的字段）。
   * 用结构化声明而非导入类型，正是为了不断环。
   */
  handler: (
    args: Record<string, unknown>,
    ctx?: { signal?: AbortSignal },
  ) => Promise<unknown>;
}

/**
 * 结构化工具错误信封（元工具专用）。
 * ⚠️ 形状与 `src/tools/index.ts` 的 `toolError` **逐字一致**（`{ ok:false, error:{ code, message } }`），
 * 但刻意不复用该函数/同名标识符：l2tool 不许 import tools/index（R5）。
 */
function l2error(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

export const l2Tool: L2ToolSpec = {
  name: L2_TOOL_CALL_NAME,
  description: L2_TOOL_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "技能名（如 log_triage）或完整目录路径（如 examples/log_triage）",
      },
    },
    required: ["name"],
  },
  handler: async (args) => resolveL2(String(args?.["name"] ?? "")),
};

/**
 * 取某个技能的 L2 正文（供 handler 与单测直接调用）。
 *
 * 结果分四类（升级版 §6.2）：
 *   ① 参数非法 → invalid_args；② 找不到 → unknown_skill；③ 同名歧义 → ambiguous_skill；
 *   ④ 技能不可用（未开启 / 挂起 / 必须工具不可用）→ skill_disabled / skill_unavailable。
 * 正常时返回「身份行 + 依赖工具行 + L2 正文」；技能没有 L2 正文时返回提示文本（**成功**）。
 *
 * ⚠️ 不在此处做长度裁剪：工具结果的长度兜底统一由 executeTool 的 capToolResult 负责（§3.4）。
 */
export function resolveL2(rawName: string): string {
  const raw = rawName.trim();
  if (raw === "") return l2error("invalid_args", "缺少参数 name：请传入技能名或完整目录路径");
  if (!SKILL_NAME_PATTERN.test(raw)) {
    return l2error("invalid_args", `技能名形状不合法：${raw}（应形如 log_triage 或 examples/log_triage）`);
  }

  const reg = getSkillRegistry();
  let rec: SkillRecord | undefined = reg.skills.get(raw);
  if (!rec) {
    const hits = [...reg.skills.values()].filter((r) => r.name === raw);
    if (hits.length > 1) {
      return l2error(
        "ambiguous_skill",
        `技能名「${raw}」存在歧义（${hits.map((h) => h.dir).join("、")}），请改用完整目录路径`,
      );
    }
    rec = hits[0];
  }
  if (!rec) {
    return l2error(
      "unknown_skill",
      `未知技能：${raw}。请使用系统提示「可用技能」里列出的名字，或完整目录路径`,
    );
  }

  // [FIX-SKILLTOGGLE] 用技能侧取值（查 enabledSkillToggles），不能用工具侧 isToggleOn
  if (!isSkillToggleOn(rec.toggleKey)) {
    return l2error(
      "skill_disabled",
      `技能「${rec.dir}」未开启（${rec.toggleKey}=false），不返回 L2。请到配置页开启该技能`,
    );
  }
  if (rec.status !== "ok") {
    return l2error(
      "skill_unavailable",
      `技能「${rec.dir}」已挂起（${rec.suspend?.code ?? "声明不合法"}），不返回 L2。原因与改法见配置页`,
    );
  }
  const un = checkRequiredTools(rec.tools);
  if (un.length > 0) {
    return l2error(
      "skill_unavailable",
      `技能「${rec.dir}」依赖的工具不可用，不返回 L2：${un.map((u) => `${u.call}（${u.detail}）`).join("；")}`,
    );
  }

  const { l2 } = layer(rec.sections);
  const body = joinSections(l2).trim();
  if (body === "") {
    return `技能「${rec.dir}」没有 L2 正文，请按 L1 的「目标 / 使用时机」执行。`;
  }
  const deps = rec.tools.map((c) => reg.tools.get(c)?.visibleName ?? c);
  const head = [`技能：${rec.title}（${rec.dir}）`];
  if (deps.length > 0) head.push(`依赖工具：${deps.join("、")}`);
  return `${head.join("\n")}\n\n${body}`;
}
