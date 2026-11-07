/**
 * src/skills/index.ts
 * skill 子系统门面。**唯一对外出口**（与 src/tools/index.ts 的分工一致）：
 *   chat.ts / routes/config.ts / routes/skills.ts 只 import 这里，不直接碰 scan.ts 的单例。
 *
 * ⚠️ 几个易漏的转发：① `listStaleSkillKeys`（清理用）；② `SKILL_NAME_PATTERN`（/preview 校验要用）；
 *    ③ 预算常量与 L1_TOTAL_WARN（/preview 与单测要用）；④ 多技能装配 + 可用性判定 + 元工具（升级版）。
 *    漏转发会让调用方直连 `scan.ts`，破坏分层。
 *
 * ⚠️ `assembleForRequest` / `applyToolWhitelist` **保留导出**：前者供回退与对照，
 *    后者是 /preview「最终工具白名单」的唯一口径（升级版 R1，skills/tools.ts 一行不改）。
 */
export {
  ensureSkillRegistry, getSkillRegistry, isSkillRegistryReady,
  listStaleSkillKeys, listSkillDeclaredKeys,
  SKILL_SUSPEND_LABEL, SKILL_SUSPEND_HINT,
  type SkillRecord, type SkillRegistry, type SkillDirNode, type SkillSuspendCode,
} from "./scan";
export {
  assembleForRequest, assembleForRequestMulti, previewSkill,
  type Assembly, type MultiAssembly, type SkillBlock,
  type SkillL0Item, type SkillPreview, type AssembleDeps,
} from "./assemble";
export {
  checkRequiredTools,
  type UnavailableTool, type UnavailableKind,
} from "./availability";
export {
  l2Tool, resolveL2, L2_TOOL_VISIBLE_NAME, L2_TOOL_CALL_NAME, L2_TOOL_DESCRIPTION,
} from "./l2tool";
export { applyToolWhitelist, type WhitelistResult } from "./tools";
export {
  skillSettingKey, skillToggleKey, isSkillManagedKey,
  SKILLS_ROOT, SKILL_FILE, SKILL_NAME_PATTERN,
  MAX_SKILL_DEPTH, BUDGET_MAX, L1_MAX, L2_MAX, L1_TOTAL_WARN,
} from "./paths";
