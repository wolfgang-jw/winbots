/**
 * src/agents/skillPolicy.ts
 * 技能过滤（模块 4）——「这个 agent 能看见哪些技能」的**唯一判定函数**。
 *
 * ⚠️ 三条铁律：
 *   1. 本文件**不含通配实现**：通配只有一份，在 match.ts（需求 §3.1）。
 *   2. 本文件**只收窄、不放宽**：输入必须是「全局已开启且正常」的技能集合，
 *      本函数在其上做减法。绝不允许把全局关掉的技能通过白名单放回来。
 *   3. 本文件**不接线**：第 3 步无任何运行期调用方（判据见文档 §四）。
 *
 * 需求锚点：A1（每 agent 独立技能集合）、A10（清单与执行同口径）。
 */

import { matchesAny } from "./match";
import type { AgentRecord, AgentSkillsMode } from "./types";

/** 过滤时只看得到技能的身份字段——不依赖 skills 侧的具体类型，保持零耦合 */
export interface SkillRef {
  /** 技能目录路径，如 examples/log_triage（裁决 D-3-3：白名单用目录路径，不用短名） */
  dir: string;
  /** 叶子名（仅用于日志/展示，不参与匹配） */
  name: string;
}

/**
 * 策略裁决结果：把 setup 里两个字段压成一个可直接判断的形态。
 *
 * 为什么不直接用 (mode, allow) 两个字段判断：
 *   若干处都要判「是否放行」，多字段组合容易在某一处写反（尤其 null / [] 的差别）。
 *   归一到 kind 之后，后续只认 kind，坏写法无处可藏。
 */
export type SkillPolicy =
  /** 不做任何收窄：只用全局开关口径（**仅 mode="all" 会产生**） */
  | { kind: "unrestricted" }
  /** 白名单：命中 list 中的任一模式才可用；空数组 = 全禁 */
  | { kind: "allowlist"; patterns: readonly string[] };

/**
 * 把 setup 的 (mode, list) 裁决成 SkillPolicy。
 *
 * 裁决表（文档 §0.2 / D-3-1，用户确认口径：null = 全禁）：
 *   mode=all,   list=任意   → unrestricted（跟随全局开关；list 被忽略）  ← 唯一放行形态
 *   mode=allow, list=null   → allowlist([]) 全禁  ← 白名单未给 = 空 = 全禁
 *   mode=allow, list=[]     → allowlist([]) 全禁
 *   mode=allow, list=[..]   → allowlist(..)
 *
 * 为什么 null 不当作「不限制」：
 *   需求 §3.1 把 skills.mode 默认定为 allow（白名单）。既然是白名单，
 *   「没给 list」只能读作「白名单为空」，而不是「没有白名单 = 全放行」。
 *   这是权限模型的保守默认：漏写字段不会意外获得全部技能。
 *
 * 已知代价（用户确认接受）：静默失效。只写 {"name":"devops"} 的 setup.json，
 *   agent 起来后没有任何技能，不报错也不告警。→ 文档 R-3-3，
 *   第 5 步接配置页时**必须**对「allow + null」给出显式提示。
 *
 * @param mode  setup.skillsMode
 * @param allow setup.skillsAllow（null = 未写 list）
 */
export function resolveSkillPolicy(
  mode: AgentSkillsMode,
  allow: readonly string[] | null,
): SkillPolicy {
  // mode=all：显式放弃白名单，完全跟随全局开关（等价于接 agent 前的现状）。
  if (mode === "all") return { kind: "unrestricted" };

  // mode=allow + 未写 list → 空白名单 → 全禁（裁决 D-3-1）。
  if (allow === null) return { kind: "allowlist", patterns: [] };

  // mode=allow + [] → 空白名单 → 全禁（与 null 同结果，但来源不同：用户明确写了空）。
  // mode=allow + [..] → 白名单，原样保留。
  return { kind: "allowlist", patterns: allow };
}

/**
 * 【唯一判定函数】给定 agent 的技能策略，某个技能是否可用。
 *
 * ⚠️ 输入 `candidate` 必须**已经**是「全局已开启且正常」的技能。
 *   本函数刻意**不**接受 isToggleOn，避免它被误用成全局开关的替代品，
 *   也避免把 assemble.ts:281 的三条件在这里复制出第二份（两份必然漂移）。
 *   全局口径由调用方（第 5 步）先行过滤，本函数只做 agent 侧收窄。
 *
 * 匹配对象是 skill.dir（裁决 D-3-3），不是 name。
 */
export function isSkillAllowedByPolicy(
  policy: SkillPolicy,
  candidate: SkillRef,
): boolean {
  if (policy.kind === "unrestricted") return true;
  // 空数组 → matchesAny 恒 false → 全禁（与「不限制」严格区分）
  return matchesAny(policy.patterns, candidate.dir);
}

/**
 * 便捷组合：直接从 AgentRecord 判定（第 5 步的主要调用形态）。
 *
 * 保留为独立函数而不是让调用方自己拼 resolve + isAllowed，是为了让
 * 「第 5 步只能通过本文件判定」这条约束有唯一入口可 grep。
 */
export function isSkillAllowedForAgent(
  agent: Pick<AgentRecord, "skillsMode" | "skillsAllow">,
  candidate: SkillRef,
): boolean {
  return isSkillAllowedByPolicy(
    resolveSkillPolicy(agent.skillsMode, agent.skillsAllow),
    candidate,
  );
}

/**
 * 批量过滤：把一个「全局已开启且正常」的技能列表按 agent 策略收窄。
 *
 * 顺序稳定性：输出保持输入顺序（调用方已按字典序排好），本函数不重排，
 * 避免与 assemble.ts 的排序口径产生两套秩序。
 *
 * ⚠️ 调用顺序必须是「先全局、后 agent」：
 *     全局口径（status===ok ∧ isToggleOn ∧ 工具可用） ← 留在 skills 侧
 *            ↓ 输出候选集
 *     agent 口径（白名单收窄）                        ← 本函数
 *     顺序反了，白名单就会绕过全局开关。
 */
export function filterSkillsForAgent<T extends SkillRef>(
  agent: Pick<AgentRecord, "skillsMode" | "skillsAllow">,
  candidates: readonly T[],
): T[] {
  const policy = resolveSkillPolicy(agent.skillsMode, agent.skillsAllow);
  return candidates.filter((c) => isSkillAllowedByPolicy(policy, c));
}
