/**
 * src/tools/paths.ts
 * 工具目录基准、键空间生成、命名规则与上限常量。
 *
 * ⚠️ 本文件【零业务依赖】（只 import node:path）。
 *    scan.ts、settings.ts、以及 etc/tools/** 下的工具文件都会（间接）引用它，
 *    一旦它 import 了任何业务模块，就会与「扫描时动态 import 工具文件」形成模块环。
 */

import { resolve } from "path";

/** 工具根目录：<项目根>/etc/tools */
export const TOOLS_ROOT = resolve(import.meta.dir, "../../etc/tools");

/** 目录声明文件的固定名（`_` 前缀 → 入口扫描天然跳过；扫描器显式加载它取 settings） */
export const DIR_SETTINGS_FILE = "_settings.ts";

/* ============================================================
 * 上限（规范 §5 / §6.2 / §8.5）
 * ============================================================ */

/** 单个路径段 / 键名长度上限（§5：1–32） */
export const MAX_NAME_LEN = 32;
/** 可见名长度上限：OpenAI 等兼容网关要求 function.name 匹配 ^[a-zA-Z0-9_-]{1,64}$ */
export const MAX_VISIBLE_NAME_LEN = 64;
/** 单个配置键的长度上限（§6.2「键长需满足环境变量长度上限」，超限组判为不可用） */
export const MAX_KEY_LEN = 120;
/** 目录层级深度上限（§8.5「可见名受长度与层级深度上限约束」） */
export const MAX_DIR_DEPTH = 4;
/** 清单条目总数上限（§8.5「条目总数上限」，超出按确定顺序取舍并告警） */
export const MAX_TOOL_ENTRIES = 60;

/* ============================================================
 * 命名规则（§5：目录名 / 入口文件名 / 键名 共用一套）
 * ============================================================ */

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * 保留名（小写比较）：
 *   ① 与开关语义相关的名字（enabled / on / off / toggle / toolon / toolset …）——
 *      允许它们作键名会让「键名」与「开关名」在同一字符串空间里混淆；
 *   ② 与对象原型相关的名字（__proto__ / constructor / prototype / toString …）——
 *      注册表与取值表都是普通对象 / Map 的混合使用场景，禁止它们可避免原型污染类误用。
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set<string>([
  "__proto__", "constructor", "prototype", "hasownproperty", "isprototypeof",
  "propertyisenumerable", "tolocalestring", "tostring", "valueof",
  "enabled", "disabled", "on", "off", "toggle", "toolon", "toolset",
  // [skill / 需求 §5.5] skill 的两个前缀同样保留：允许它们当键名 / 目录名，
  //   会让「键名」「目录名」「SKILLON__ / SKILLSET__ 前缀」三个字符串空间互相混淆。
  "skillon", "skillset", "skill", "skills",
  "true", "false", "null", "undefined", "default", "defaults",
]);

export interface NameCheck {
  ok: boolean;
  reason?: string;
}

/** 命名校验（纯函数；不替换字符、不猜测意图 —— 违规即忽略并告警，§4.2 / §3.7） */
export function checkName(name: string): NameCheck {
  if (name.length < 1 || name.length > MAX_NAME_LEN) {
    return { ok: false, reason: `长度必须在 1–${MAX_NAME_LEN} 之间（当前 ${name.length}）` };
  }
  if (!NAME_RE.test(name)) {
    return { ok: false, reason: "必须以字母开头，且只含字母、数字、下划线" };
  }
  if (name.endsWith("_")) {
    return { ok: false, reason: "末尾不得为下划线" };
  }
  if (name.includes("__")) {
    return { ok: false, reason: "不得出现连续双下划线（分隔符保留）" };
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return { ok: false, reason: "属保留名（与开关语义或对象原型相关）" };
  }
  return { ok: true };
}

/* ============================================================
 * 键空间（§6.1）
 * ============================================================ */

const TOGGLE_NS = "TOOLON";
const SETTING_NS = "TOOLSET";
const DIR_NS = "etc";
const DIR_SUB_NS = "tools";
/**
 * [skill / C-20] skill 键空间的两个前缀。
 *
 * ⚠️ 必须在本文件（而不是 import `@/skills/paths`）：本文件是零业务依赖底座，
 *    而 `skills/scan.ts` 反过来要 `import { getRegistry } from "@/tools/scan"`，
 *    互相 import 会成环。常量各写一份，语义一致性由用例与文档 §19.3 / C-20 约束。
 *
 * ⚠️ 为什么这里必须有：`hasManagedPrefix()` 是取值层 `refreshManagedValues()` 与
 *    遗留键 `listOrphanKeys()` 的**唯一筛键入口**。缺这两个前缀 → `.env` 里的
 *    `SKILLON__*` 永远进不了取值缓存 → 配置页开关保存成功、刷新后又变回未勾选（读写不对称）。
 */
const SKILL_TOGGLE_NS = "SKILLON";
const SKILL_SETTING_NS = "SKILLSET";

/** 目录路径 → 路径段数组（根目录 "" → []） */
export function pathSegments(dirPath: string): string[] {
  return dirPath === "" ? [] : dirPath.split("/").filter((s) => s.length > 0);
}

/**
 * ⚠️ 关键：过滤空段后再 join。
 *   若直接写 `${prefix}${joinPath(dirPath)}__${fileBase}`，根级入口文件（dirPath === ""）
 *   会拼出 `TOOLSET____x__y` —— 出现三连下划线，违反 §5「分隔符全程使用双下划线」，
 *   且会让「按 `__` 切分」的唯一解码失效（见代码改动文档 R-5）。
 */
function joinKey(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("__");
}

/** 目录开关：TOOLON__<目录路径>（根目录无开关） */
export function dirToggleKey(dirPath: string): string {
  return joinKey(TOGGLE_NS, ...pathSegments(dirPath));
}

/** 组开关：TOOLON__<目录路径>__<文件名> */
export function groupToggleKey(dirPath: string, fileBase: string): string {
  return joinKey(TOGGLE_NS, ...pathSegments(dirPath), fileBase);
}

/** 目录设置项：etc__tools__<目录路径>__<键名> */
export function dirSettingKey(dirPath: string, name: string): string {
  return joinKey(DIR_NS, DIR_SUB_NS, ...pathSegments(dirPath), name);
}

/** 组设置项：TOOLSET__<目录路径>__<文件名>__<键名> */
export function groupSettingKey(dirPath: string, fileBase: string, name: string): string {
  return joinKey(SETTING_NS, ...pathSegments(dirPath), fileBase, name);
}

/**
 * 托管键判定（§10.1：只有命中保留前缀的键才可能是遗留键）。
 *
 * [skill / C-20] 自本次改动起多认 `SKILLON__` / `SKILLSET__` 两类：
 *   本函数是 `refreshManagedValues()`（取值层）与 `listOrphanKeys()`（遗留键）的
 *   **唯一筛键入口**，漏掉它们会让 skill 开关「写得进、读不回」。
 */
export function hasManagedPrefix(key: string): boolean {
  return (
    key.startsWith(`${TOGGLE_NS}__`) ||
    key.startsWith(`${SETTING_NS}__`) ||
    key.startsWith(`${DIR_NS}__${DIR_SUB_NS}__`) || key.startsWith(`${SKILL_TOGGLE_NS}__`) || key.startsWith(`${SKILL_SETTING_NS}__`)
  );
}

/* ============================================================
 * 敏感键名（§9.1「拒绝敏感名称」；代码改动文档 R-11 定稿：按声明管、不按名字猜）
 * ============================================================ */

/**
 * 词表：**整段相等**匹配，绝不做子串包含。
 *   子串包含会把 `extra_env_keys`（含 "keys"）判成密钥项 —— 这是本规则唯一必须避开的坑。
 */
const SENSITIVE_WORDS: readonly string[] = [
  "KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PWD", "CREDENTIAL",
];

/** 连写形式的前缀白名单：apikey / authtoken / secretkey 这类没有下划线的名字 */
const COMPOUND_PREFIXES: readonly string[] = [
  "API", "ACCESS", "AUTH", "APP", "CLIENT", "MASTER", "PRIVATE", "SERVICE",
];

/**
 * 键名是否形似密钥。
 *
 * ⚠️ 这是**辅助判定**，不是安全边界：
 *   · 命中且声明未标 `secret: true` → 扫描期挂起该节点 / 写入期 400（提示去补声明）
 *   · 声明里写了 `secret: true` → 无论名字如何一律脱敏 —— **权威标志是它**
 *   · 漏判（例如复数写法 `api_keys`）不会扩大泄漏面：真正决定「是否脱敏」的仍是 `secret`
 * 召回优先于精确：`monkey_count` 这类被 COMPOUND_PREFIXES 挡掉，其余误判的代价只是「该项必须标 secret」。
 */
export function isSensitiveName(key: string): boolean {
  const segs = key.toUpperCase().split(/[^A-Z0-9]+/).filter((s) => s.length > 0);
  for (const seg of segs) {
    if (SENSITIVE_WORDS.includes(seg)) return true;
    for (const w of SENSITIVE_WORDS) {
      if (seg.length <= w.length || !seg.endsWith(w)) continue;   // 例：KEYS 不命中 KEY
      const prefix = seg.slice(0, seg.length - w.length);
      if (COMPOUND_PREFIXES.includes(prefix) || prefix.endsWith("API")) return true;
    }
  }
  return false;
}

/* ============================================================
 * 可见名（§8.5）
 * ============================================================ */

/** 可见名前缀：local__shell（与既有 wireName 规则完全一致，历史记录里的旧名照旧可解析） */
export function visibleNamePrefix(dirPath: string, fileBase: string): string {
  return joinKey(...pathSegments(dirPath), fileBase);
}

/** 模型可见名：local__shell__run */
export function visibleName(dirPath: string, fileBase: string, toolName: string): string {
  return `${visibleNamePrefix(dirPath, fileBase)}__${toolName}`;
}

/* ============================================================
 * 哈希（指纹 / 扫描版本标识）
 * ============================================================ */

/** FNV-1a 32 位，仅用于指纹与版本标识的比较与展示，不做安全用途 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 扫描版本标识（§9.3 / §12）：指纹 + 本次注册的键集合。
 * 加进键集合的原因：只有目录内容变化才改指纹，而「键集合」变化（如某组因撞键被剔除）
 * 也必须让前端的过期保存被拒绝，否则会基于过期的键集合写盘。
 */
export function computeVersion(fingerprint: string, keys: Iterable<string>): string {
  const sorted = [...keys].sort();
  return `v_${hashText(`${fingerprint}|${sorted.join(",")}`)}`;
}
