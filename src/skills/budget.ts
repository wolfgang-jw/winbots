/**
 * src/skills/budget.ts
 * 技能 / system 文本预算的**唯一对外口径**（模块 8 第 1 步 · 统一预算口径函数）。
 *
 * 为什么再包一层而不直接用 markdown.applyBudget：
 *   ① 第 5 步（模块 3 · system 装配）要在 chat.ts 里拼「人设 → 技能 → 基础」三段，
 *      必须复用同一套三上限与同一套截断标注，否则会出现第三份口径（风险 R-2）；
 *   ② `totalMax` 这处「预览 4500 / 多技能不设限」的差异是有意为之，
 *      必须**显式成参数并集中在 resolveBudgetLimits 里**，改一处即可全局生效；
 *   ③ 本文件是唯一允许 import 预算实现的地方，调用方（assemble.ts / 将来的 agents/prompt.ts）
 *      只认这里，不直接碰 markdown.ts 的内部规则。
 *
 * ⚠️ 零业务依赖：只允许 import ./paths 与 ./markdown，禁止 import scan.ts / settings.ts / tools/*，
 *    否则 assemble.ts ← budget.ts ← scan.ts 会成环（与 paths.ts 头注释同一约束）。
 */
import { BUDGET_MAX, L1_MAX, L2_MAX } from "./paths";
import { applyBudget, type BudgetResult, type Section } from "./markdown";

/** 预算上限集合（三个上限同时生效，见 markdown.applyBudget 的 C-1 说明） */
export interface BudgetLimits {
  l1Max: number;
  l2Max: number;
  /** L1+L2 合计上限；null = 不设合计上限 */
  totalMax: number | null;
}

/** 预算口径（决定 totalMax 取什么） */
export interface BudgetProfile {
  /**
   * · "preview"（缺省）：合计上限 = BUDGET_MAX。用于配置页预览与旧单技能装配。
   * · "multi"：合计上限 = null。用于多技能装配 —— L1 每轮都进 system，
   *   若仍走 4500 合计上限，L1 会被 L2 挤掉（升级版 R4）。
   */
  profile?: "preview" | "multi";
  /** 显式覆盖合计上限（优先级最高，仅用于单测构造边界） */
  totalMax?: number | null;
}

/**
 * 把「口径」翻译成「三个具体上限」。**全部默认值集中在这一处**，
 * 将来调整 BUDGET_MAX 或某条路径的口径，只改这里。
 */
export function resolveBudgetLimits(p: BudgetProfile = {}): BudgetLimits {
  const totalMax =
    p.totalMax !== undefined
      ? p.totalMax
      : p.profile === "multi"
        ? null
        : BUDGET_MAX;
  return { l1Max: L1_MAX, l2Max: L2_MAX, totalMax };
}

/**
 * 按口径做整段截断（不切半句）。**纯函数，无 IO，可重入**。
 *
 * 行为等价性约束（第 1 步的验收核心）：
 *   · profile 缺省时，输出必须与 `applyBudget(l1, l2)` **逐字节相等**；
 *   · profile = "multi" 时，输出必须与 `applyBudget(l1, l2, { totalMax: null })` **逐字节相等**。
 *   本条由 V5（等价全绿）+ V8（口径级注入能报红）共同保证。
 */
export function applySkillBudget(
  l1: Section[],
  l2: Section[],
  p: BudgetProfile = {},
): BudgetResult {
  const limits = resolveBudgetLimits(p);
  // 目前 markdown.applyBudget 已把 L1_MAX / L2_MAX 写死在内部，只有 totalMax 可传。
  // 这里仍算出 limits.l1Max / l2Max 并断言，是为了在常量被改动时**立刻暴露**
  // 「budget.ts 的口径与 markdown.ts 的实现不一致」—— 而不是静默漂移。
  if (limits.l1Max !== L1_MAX || limits.l2Max !== L2_MAX) {
    throw new Error(
      `budget 口径不一致：resolveBudgetLimits 返回 L1=${limits.l1Max}/L2=${limits.l2Max}，` +
        `而 markdown.applyBudget 使用的是 L1=${L1_MAX}/L2=${L2_MAX}`,
    );
  }
  return applyBudget(l1, l2, { totalMax: limits.totalMax });
}
