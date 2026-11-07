/**
 * src/skills/paths.ts
 * skill 目录基准、键空间生成、上限常量。
 *
 * ⚠️ 与 src/tools/paths.ts 同样的约束：【零业务依赖】，只 import node:path。
 *    本文件被 skills/scan.ts 与 skills/assemble.ts 同时引用，一旦 import 业务模块就会成环。
 *
 * ⚠️ 与工具侧的差异（需求文档 §5.3 要求显式记录）：
 *    · 层级上限 = 3（工具侧 MAX_DIR_DEPTH = 4）；skill 是文档，不需要那么深的命名空间
 *    · 目录无开关（N-SK-6）：只有一个 SKILLON__<路径...>，没有「分类目录」开关
 *    · 入口是 SKILL.md，只读文本，永不 import
 */
import { resolve } from "path";

/** skill 根目录：<项目根>/etc/skills */
export const SKILLS_ROOT = resolve(import.meta.dir, "../../etc/skills");

/** 唯一入口文件名（N-SK-1） */
export const SKILL_FILE = "SKILL.md";

/** 目录层级上限（§5.2：etc/skills/a/b/c/SKILL.md 最深 = 3 层） */
export const MAX_SKILL_DEPTH = 3;

/* ============================================================
 * 预算（§4.4 / C-1）：三个上限同时生效
 * ============================================================ */

/** L1（## 目标 / ## 使用时机）单层上限 */
export const L1_MAX = 1500;
/** L2（## 方法 / ## 输出格式 / ## 自检 / 自定义段）单层上限 */
export const L2_MAX = 3000;
/** L1 + L2 合计上限 */
export const BUDGET_MAX = 4500;

/* ============================================================
 * 命名
 * ============================================================ */

/**
 * 激活名形状：`dev/log_triage` 或 `log_triage`。
 * 与 checkName 的字符集一致（字母开头、[A-Za-z0-9_]、不得含 `__`），但允许 `/` 分层。
 *
 * ⚠️ 这个正则**必须**是唯一一份：chat.ts 解析 body.skill / X-Skill、
 *    路由 routes/skills.ts 校验 query.name、assemble.ts 的 pickActive 都用它。
 *    各写一份必然漂移（v0.1 就发生过）。
 */
export const SKILL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*$/;

/* ============================================================
 * 键空间（§5.5）
 * ============================================================ */

/** ⚠️ 与 src/tools/paths.ts 的 SKILL_TOGGLE_NS / SKILL_SETTING_NS 必须逐字一致（C-20） */
const TOGGLE_NS = "SKILLON";
const SETTING_NS = "SKILLSET";

/**
 * ⚠️ 关键：**过滤空段后再 join**（与 src/tools/paths.ts 的 joinKey 完全同款语义）。
 *   若直接 `${prefix}__${dirPath.replace("/", "__")}__${name}`，根级 skill（dirPath = "flat"）
 *   没问题，但一旦有人传 "" 就会拼出 `SKILLSET____x` —— 三连下划线，
 *   违反「分隔符全程双下划线」，且「按 __ 切分」的唯一解码失效。
 */
function joinKey(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("__");
}

/** 相对路径 → 路径段数组（"" → []） */
export function skillPathSegments(dir: string): string[] {
  return dir === "" ? [] : dir.split("/").filter((s) => s.length > 0);
}

/** 开关键：SKILLON__<路径段...>，例：SKILLON__dev__log_triage */
export function skillToggleKey(dir: string): string {
  return joinKey(TOGGLE_NS, ...skillPathSegments(dir));
}

/** 设置项键：SKILLSET__<路径段...>__<键名>，例：SKILLSET__dev__log_triage__max_lines */
export function skillSettingKey(dir: string, name: string): string {
  return joinKey(SETTING_NS, ...skillPathSegments(dir), name);
}

/** 是否 skill 托管键（§6.5 清理只认这两个前缀） */
export function isSkillManagedKey(key: string): boolean {
  return key.startsWith(`${TOGGLE_NS}__`) || key.startsWith(`${SETTING_NS}__`);
}

/**
 * [升级版 风险 5] 已开启技能 L1 合计告警阈值（只告警，不截断）。
 * 多技能装配时 L1 每轮都进 system；超过该值说明技能数 / 技能篇幅需要运营侧收敛。
 */
export const L1_TOTAL_WARN = 8000;
