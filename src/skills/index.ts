/**
 * src/skills/index.ts
 * skill 子系统门面。**唯一对外出口**（与 src/tools/index.ts 的分工一致）：
 *   chat.ts / routes/config.ts / routes/skills.ts 只 import 这里，不直接碰 scan.ts 的单例。
 *
 * ⚠️ 三个易漏的转发：① `listStaleSkillKeys`（清理用）；② `SKILL_NAME_PATTERN`（chat.ts 与 /preview 要用）；
 *    ③ 三个预算常量（/preview 与单测要用）。漏转发会让调用方直连 `scan.ts`，破坏分层。
 */
export {
  ensureSkillRegistry, getSkillRegistry, isSkillRegistryReady,
  listStaleSkillKeys, listSkillDeclaredKeys,
  SKILL_SUSPEND_LABEL, SKILL_SUSPEND_HINT,
  type SkillRecord, type SkillRegistry, type SkillDirNode, type SkillSuspendCode,
} from "./scan";
export {
  assembleForRequest, previewSkill,
  type Assembly, type SkillL0Item, type SkillPreview, type AssembleDeps,
} from "./assemble";
export { applyToolWhitelist, type WhitelistResult } from "./tools";
export {
  skillSettingKey, skillToggleKey, isSkillManagedKey,
  SKILLS_ROOT, SKILL_FILE, SKILL_NAME_PATTERN,
  MAX_SKILL_DEPTH, BUDGET_MAX, L1_MAX, L2_MAX,
} from "./paths";
