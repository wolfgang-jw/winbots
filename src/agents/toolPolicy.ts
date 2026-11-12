/**
 * src/agents/toolPolicy.ts
 * 工具过滤（模块 5）——「这个 agent 能调用哪些工具」的**唯一判定函数**。
 *
 * ⚠️ 四条铁律：
 *   1. 本文件**不含通配实现**：通配只有一份，在 match.ts（需求 §3.1）。
 *   2. 本文件**只收窄、不放宽**：输入必须是「组可用 ∧ 工具自身启用」的工具集合
 *      （src/tools/index.ts 的三条件），本函数在其上做减法。
 *   3. 本文件**只在类型层被 tools/ 依赖**：src/tools/index.ts 只 `import type` 本文件的
 *      ToolFilter，据此做到「第 4 步不接线」（判据见文档 §六 V5）。
 *   4. **清单与执行必须调用同一个函数**（A10）。
 *
 * 需求锚点：A2（每 agent 独立工具集合）、A10（清单与执行同口径）、C20（写操作边界）。
 *
 * ⚠️ **与 skillPolicy.ts 同口径**（需求 BR-1 / BR-2，「显式列举才可用」）：
 *    技能侧：list 缺省(null) / [] = 空名单 = 全禁；
 *    工具侧：allow 缺省(null) / [] = 空名单 = 全禁（**这是本次改造的行为变更**：
 *            改造前 allow 缺省 = 不限制，裁决 D-4-1 已作废）。
 *    想给 agent 全部工具，必须显式写通配模式（如 `local__*`），不能再靠省略字段。
 *
 * ⚠️ 依赖约束：本文件只允许 import `./match`（值）与 `./types`（仅 type）。
 *    **禁止** import `@/tools/*` 或 `@/infra/settings`：那会把全局口径复制出第二份，
 *    也会让 agents 子系统在运行期依赖执行域（判据 V4）。
 */

import { matchesAny } from "./match";
import type { AgentRecord } from "./types";

/** 过滤时只看得到工具的身份字段——不依赖 tools 侧类型，保持零耦合 */
export interface ToolRef {
  /**
   * 模型可见名，形如 local__fileRead__read_file。
   *
   * ⚠️ 匹配对象必须是它，不是 callName（local.fileRead.read_file）：
   *   需求 §3.1 的示例全部是双下划线形式，既有 skills 白名单（applyToolWhitelist）也用它。
   *   用 callName 会让「从需求里抄来的白名单」一条都命中不了，且不报错。
   */
  visibleName: string;
  /** 内部调用名（仅用于日志 / 展示，不参与匹配） */
  callName: string;
}

/**
 * 策略裁决结果：把 setup 的 allow 压成一个可直接判断的形态。
 *
 * ⚠️ 已删除 `unrestricted` 变体（需求 BR-1）：allow 缺省 = 全禁，不再产生「不限制」。
 *    删除这个变体是刻意的 —— 让编译器逼出所有残留的 `kind === "unrestricted"` 判断。
 */
export type ToolPolicy = {
  /** 白名单：命中 allow 中任一模式才放行；**空数组 = 全拒绝** */
  kind: "allowlist";
  patterns: readonly string[];
};

/**
 * 把 setup 的 allow 裁决成 ToolPolicy（deny 不进来，见下）。
 *
 * 裁决表（需求 BR-1「显式列举才可用」，与技能侧同口径）：
 *   allow = null（未写）  → allowlist([])：**全拒绝**（改造前是「不限制」，已变更）
 *   allow = []（显式空）  → allowlist([])：全拒绝
 *   allow = [..]          → allowlist(..)
 *
 * 为什么 deny 不并进 policy：
 *   「deny 一票否决」是**优先级**，合并进同一个 patterns 数组就无法表达它
 *  （同一模式同时命中两边时该算什么说不清）。保留为两处数据、判定时先判 deny，
 *   与 §6.1 第 7 条逐字对应。
 *
 * @param allow setup.toolsAllow（null / [] 均 = 全禁）
 */
export function resolveToolPolicy(allow: readonly string[] | null): ToolPolicy {
  return { kind: "allowlist", patterns: allow ?? [] };
}

/**
 * 【降级路径专用】全拒绝策略（§12.1 D-D′）。
 *
 * 用途：agent 目录被删 / setup.json 损坏 / uid 重复 / 配置不可信 → 一个工具都不给。
 * ⚠️ 必须复用本函数，不要在其它文件手写 { kind:"allowlist", patterns: [] }：
 *   「全拒绝」一旦出现多份实现，将来改动必漏一处。
 */
export function denyAllPolicy(): ToolPolicy {
  return { kind: "allowlist", patterns: [] };
}

/**
 * 【唯一判定函数】给定策略与单个工具，是否放行。
 *
 * 判定顺序（不可交换）：
 *   ① deny 命中 → 拒绝（deny 一票否决，§6.1 第 7 条）
 *   ② 命中 allow 才放行（空数组 → 恒拒绝；已无「不限制」分支）
 *
 * @param candidate 必须**已经**是「组可用 ∧ 工具自身启用」的工具；
 *                  本函数刻意不接受 groupState / isToolEnabled，避免复制全局口径。
 */
export function isToolAllowedByPolicy(
  policy: ToolPolicy,
  deny: readonly string[],
  candidate: ToolRef,
): boolean {
  if (matchesAny(deny, candidate.visibleName)) return false;
  return matchesAny(policy.patterns, candidate.visibleName);
}

/**
 * 便捷组合：直接从 AgentRecord 判定（第 5 步的主要调用形态）。
 *
 * 保留为独立函数（而不是让调用方自己拼 resolve + judge），是为了让
 * 「只能通过本文件判定」这条约束有唯一入口可 grep。
 */
export function isToolAllowedForAgent(
  agent: Pick<AgentRecord, "toolsAllow" | "toolsDeny">,
  candidate: ToolRef,
): boolean {
  return isToolAllowedByPolicy(
    resolveToolPolicy(agent.toolsAllow),
    agent.toolsDeny,
    candidate,
  );
}

/**
 * 批量过滤：把「组可用 ∧ 工具自身启用」的工具列表按 agent 策略收窄。
 *
 * 顺序稳定性：输出保持输入顺序，本函数**不重排**——清单顺序的唯一来源是
 * src/tools/index.ts 的「可见名字典序」排序；两处各排一次必然漂移。
 */
export function filterToolsForAgent<T extends ToolRef>(
  agent: Pick<AgentRecord, "toolsAllow" | "toolsDeny">,
  candidates: readonly T[],
): T[] {
  const policy = resolveToolPolicy(agent.toolsAllow);
  return candidates.filter((c) => isToolAllowedByPolicy(policy, agent.toolsDeny, c));
}

/**
 * `tool_not_allowed` 信封 ①：单个工具未被当前 agent 授权（A10）。
 *
 * 形状与 src/tools/index.ts 的 toolError 完全一致（{ ok:false, error:{ code, message } }），
 * 保证「结构化错误码不丢失」且模型可读。返回**字符串**（executeTool 的返回值就是字符串）。
 *
 * ⚠️ 文案纪律：
 *   · 不写「请修改配置后重试」——模型不能改配置，会诱导原地重试（同 tool_disabled）；
 *   · 不写「请新建会话」——该建议只对「目录被删」成立（裁决 D-4-2）。
 *
 * ⚠️ 与 src/tools/index.ts 的 toolNotAllowedEnvelope() 文案**逐字一致**（R4-5）：
 *   tools/ 不能值导入本文件（V5），故两处各存一份；改文案时两处一起改（V11 人工 diff）。
 */
export function toolNotAllowed(visibleName?: string): string {
  const who = visibleName ? `工具 ${visibleName}` : "该工具";
  return JSON.stringify({
    ok: false,
    error: {
      code: "tool_not_allowed",
      message:
        `${who} 未授权给当前 agent，本次未执行。` +
        `请改用其他可用工具完成任务；若确认需要该能力，请联系管理员为当前 agent 添加授权。`,
    },
  });
}

/**
 * `tool_not_allowed` 信封 ②：整个 agent 的配置不可信（§12.1 降级矩阵 3 / 4 / 5 行）。
 *
 * 与 ① 分开是因为对用户的下一步动作完全不同：①是「要授权」，②是「修配置」。
 * 第 6 步只负责决定「何时用哪一句」，不负责写文案。
 */
export function toolNotAllowedAgentUnavailable(): string {
  return JSON.stringify({
    ok: false,
    error: {
      code: "tool_not_allowed",
      message:
        "该 agent 的配置当前不可用，本次未执行任何工具。" +
        "请改用其他可用工具完成任务，或联系管理员检查 agent 配置。",
    },
  });
}

/**
 * 【A10 的静态契约】清单侧与执行侧共用的「判据容器」。
 *
 * src/tools/index.ts 以 `import type` 引用它：
 *   getToolDefinitions(opts?: ToolFilter) / executeTool(name, args, ctx, opts?: ToolFilter)
 * 两边签名同源 → 「清单用什么判据，执行就用什么判据」在类型层面成立，
 * 不可能出现「清单传了 A、执行传了 B」。
 *
 * 为什么不直接传 AgentRecord：
 *   ① 清单 / 执行只需要两个字段，传整个 record 会让 tools/ 在类型上依赖 agents/types.ts 的
 *      全部字段演化；
 *   ② 第 6 步的降级路径不是从 record 出发的，而是「全拒绝」这一件事；用
 *      { toolsAllow: [], toolsDeny: [] } 表达，正好与正常路径共用一个类型。
 */
export interface ToolFilter {
  /** 同 setup.toolsAllow（null / [] 均 = **全禁**；BR-1） */
  toolsAllow: readonly string[] | null;
  /** 同 setup.toolsDeny（[] = 无 deny） */
  toolsDeny: readonly string[];
  /**
   * 【A10 的唯一判定入口】清单侧与执行侧都**只能**调用它。
   *
   * 为什么把函数放进数据里（而不是让 tools/ 直接 import 判定函数）：
   *   tools/ 是执行域，不得在运行期依赖 agents/（判据 V5）。
   *   做成容器的成员后，判定实现只有一份，而 tools/ 只需调用 filter.allows(...)，
   *   零 import、零复制。
   *
   * ⚠️ 该字段必须**只由本文件的构造函数产生**（toolFilterOf / denyAllToolFilter）；
   *    禁止在 chat.ts 或单测里手写对象，否则「清单与执行同口径」又退化成口头约定。
   */
  allows: (candidate: ToolRef) => boolean;
  /**
   * 该 agent 本次「可用技能数」（D-16 方案②）。
   *
   * 元工具 skill__get_l2 是「读取技能 L2 手册」的唯一入口：没有技能时它毫无用处，
   * 却仍会出现在模型可见清单里，与 BR-1「仅在配置中列出了的才可用」相悖。
   * 因此改为**至少 1 个技能才追加**。
   *
   * 缺省（undefined）视为 0 → 不追加。方向是保守的：漏填只会少给元工具，
   * 不会凭空空出一张工具面。
   */
  skillCount?: number;
}

/**
 * 从 AgentRecord 提取判据容器（第 5 步的调用形态）。
 *
 * ⚠️ policy 必须在**构造时算一次**：清单侧在组内循环里逐条调用 allows，
 *    若把 resolveToolPolicy 放进 allows 内部，就会变成「每个工具每轮重算一次」。
 */
export function toolFilterOf(
  agent: Pick<AgentRecord, "toolsAllow" | "toolsDeny">,
  /**
   * 该 agent 本次可用技能数（D-16 方案②）：≥1 才把元工具 skill__get_l2 追加进清单。
   * 省略 = 0 = 不追加。调用方（chat.ts / routes/skills.ts）在技能装配之后传入。
   */
  skillCount = 0,
): ToolFilter {
  const policy = resolveToolPolicy(agent.toolsAllow);
  return {
    toolsAllow: agent.toolsAllow,
    toolsDeny: agent.toolsDeny,
    allows: (c) => isToolAllowedByPolicy(policy, agent.toolsDeny, c),
    skillCount,
  };
}

/**
 * 降级路径的判据容器（等价于 denyAllPolicy，见 §12.1）。
 *
 * ⚠️ `toolsAllow: []` 与 `allows: () => false` **必须同时保留**：
 *   前者是给人看的（与 §12.1 的 { toolsAllow: [], toolsDeny: [] } 字面一致），
 *   后者是真正生效的判定。删任一都会让别的代码路径出错
 *   （删 allows → 容器不可用；删 toolsAllow → 第 6 步无法从容器反查配置）。
 */
export function denyAllToolFilter(): ToolFilter {
  // skillCount: 0 —— 配置不可信的降级路径不追加元工具（D-16 方案②）：
  //   降级时技能侧同样被全拒，给出「读技能手册」的入口只会让模型多绕一圈。
  return { toolsAllow: [], toolsDeny: [], allows: () => false, skillCount: 0 };
}

/**
 * 供 tools/index.ts 使用：容器缺省 → 放行（兼容路径）；否则只用容器自带的判定。
 *
 * ⚠️ 生产调用点在 src/tools/index.ts 里用的是 `opts.allows(...)`（不 import 本函数）；
 *    本函数是给「已经能值导入 agents/ 的调用方」（单测 / 第 5 步的 chat.ts）用的便捷包装。
 */
export function isToolAllowedByFilter(
  filter: ToolFilter | undefined,
  candidate: ToolRef,
): boolean {
  return filter ? filter.allows(candidate) : true;
}
