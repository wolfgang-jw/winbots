/**
 * src/infra/settings.ts
 * 动态取值层 + 工具配置门禁（规范 §7 / §8.3）。
 *
 * 取值顺序：**当前 agent 的配置快照**（见 ./toolConfigContext） → 声明处默认值
 * 校验：写入端（智能体编辑弹窗 → POST /api/agents → setup.ts）与读取端（本文件）各校验一次
 * 告警：同一键只告警一次，且**不打印取值原文**（§8.7）
 *
 * ⚠️ 自「工具/技能配置归位 setup.json」改造起，取值来源从「env.json 的 tools 块（全局一份）」
 *    改为「当前请求所绑 agent 的 setup.json（每 agent 一份）」。实现上的关键约定：
 *      · 本文件的**函数签名与所有业务调用点一行未改**；
 *      · 数据来源换成 AsyncLocalStorage 里的快照（currentAgentToolConfig()）；
 *      · **无上下文** = 全关 / 声明里的默认值（保守降级，绝不放宽）。
 *    详见 docs/工具技能配置归位setup与agent权限收紧-代码修改文档.md §4.2。
 *
 * 为什么不用 `Bun.env` 读：托管键**从不进进程环境**（§7.4），且「值等于默认值即删键」要求
 *   读到的是文件里的真实状态，而不是进程里累积的历史值。
 */

import { relative } from "path";
import { fileURLToPath } from "url";
import { currentAgentToolConfig } from "./toolConfigContext";
import {
  DIR_SETTINGS_FILE, TOOLS_ROOT, dirSettingKey, groupSettingKey, pathSegments,
} from "@/tools/paths";
import { getRegistry } from "@/tools/scan";

/* ============================================================
 * 声明结构（§7.2）
 * ============================================================ */

export type SettingKind = "string" | "number" | "boolean" | "string_array";

export interface SettingDef {
  /** 类型：仅标量（字符串 / 数值 / 布尔）与字符串数组 */
  kind: SettingKind;
  /** 默认值：必填、只读，且是唯一来源（§3.2） */
  default: string | number | boolean | readonly string[];
  /** 说明文本（配置页展示） */
  desc?: string;
  /** 敏感项：页面脱敏、日志不得输出取值 */
  secret?: boolean;
  /** number 的取值范围 */
  min?: number;
  max?: number;
  /** string 的枚举候选 */
  options?: readonly string[];
  /** 枚举候选的中文显示名（页面下拉用；值仍写原始 token） */
  optionLabels?: Record<string, string>;
  /** 组设置项的成对约束（§7.2）：本项仅在「另一项取值 ∈ equals」时有意义 */
  dependsOn?: { name: string; equals: readonly string[] };
}

export type ParsedValue = string | number | boolean | string[];
export type ParseResult = { ok: true; value: ParsedValue } | { ok: false; reason: string };

/** 读取端校验（§7.4）：类型不符 / 越界一律拒绝，不做宽松解析（§3.4） */
export function parseSettingValue(def: SettingDef, raw: string): ParseResult {
  const text = String(raw);
  switch (def.kind) {
    case "boolean": {
      const v = text.trim().toLowerCase();
      if (v === "true") return { ok: true, value: true };
      if (v === "false") return { ok: true, value: false };
      return { ok: false, reason: "只能为 true 或 false" };
    }
    case "number": {
      const v = text.trim();
      if (!/^-?\d+$/.test(v)) return { ok: false, reason: "必须为整数（不接受小数、科学计数法、空值）" };
      const n = Number(v);
      if (!Number.isSafeInteger(n)) return { ok: false, reason: "超出安全整数范围" };
      if (def.min !== undefined && n < def.min) return { ok: false, reason: `不能小于 ${def.min}` };
      if (def.max !== undefined && n > def.max) return { ok: false, reason: `不能大于 ${def.max}` };
      return { ok: true, value: n };
    }
    case "string_array": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, reason: "必须为合法 JSON 数组文本" };   // §7.2：解析失败即回退并告警
      }
      if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
        return { ok: false, reason: "必须为字符串数组" };
      }
      return { ok: true, value: parsed };
    }
    default: {
      if (def.options && def.options.length > 0) {
        const v = text.trim();
        if (!def.options.includes(v)) return { ok: false, reason: `只能为 ${def.options.join(" / ")}` };
        return { ok: true, value: v };
      }
      return { ok: true, value: text };
    }
  }
}

/** 持久化文本（数组以 JSON 文本落盘，§7.2） */
export function formatSettingValue(def: SettingDef, value: ParsedValue): string {
  if (def.kind === "string_array") return JSON.stringify(value);
  if (def.kind === "boolean") return value === true ? "true" : "false";
  return String(value);
}

/** 默认值的持久化文本（用于「值等于默认值即删键」的比较，§9.1） */
export function defaultValueText(def: SettingDef): string {
  return formatSettingValue(def, def.default as ParsedValue);
}

/* ============================================================
 * 取值来源（当前 agent 的配置快照，不进进程环境）
 * ============================================================ */

const warned = new Set<string>();

/**
 * 当前上下文里的「托管键文本表」。
 *
 * ⚠️ 无上下文 → 空表：所有开关读到「未开启」、所有设置项回退声明里的默认值。
 *    这是刻意的保守降级（BR-5 / AC-15）。若在业务请求里看到工具全不可用，
 *    第一件要查的事就是「请求入口有没有包 runWithAgentToolConfig」。
 * ⚠️ 不再有 `refreshManagedValues()`：配置来自内存里的 AgentRecord，
 *    保存 agent 后不需要刷任何全局缓存（下次请求用新 record 构造上下文）。
 */
function currentSettings(): ReadonlyMap<string, string> {
  return currentAgentToolConfig()?.settings ?? EMPTY_SETTINGS;
}
const EMPTY_SETTINGS: ReadonlyMap<string, string> = new Map<string, string>();

/** 当前上下文里的原始文本（未解析）；配置页回显用 */
export function currentSettingText(key: string): string | undefined {
  return currentSettings().get(key);
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // 规范 §8.7：日志不得输出任何设置项取值原文 —— 这里只给键与原因
  console.warn(`⚠️  [tool-cfg] ${message}（键：${key}）；同一键不再重复提示。`);
}

/** 声明查询：未声明的键视为不存在，读取即报错（§3.1，不给静默默认值） */
export function getSettingDef(key: string): SettingDef | undefined {
  return getRegistry().settingDefs.get(key);
}

/** 按声明取值（唯一取值入口） */
export function readSetting<T>(key: string): T {
  const def = getSettingDef(key);
  if (!def) {
    throw new Error(`ERR_UNDECLARED_SETTING: 未声明的设置项 ${key}（不在本次扫描的注册表内）`);
  }
  const raw = currentSettings().get(key);
  if (raw === undefined) return def.default as unknown as T;
  const parsed = parseSettingValue(def, raw);
  if (!parsed.ok) {
    warnOnce(key, `取值不合法（${parsed.reason}），已回退默认值`);
    return def.default as unknown as T;
  }
  return parsed.value as unknown as T;
}

/**
 * 软读：键**未声明**时回落到调用方给的兜底值（而不是抛错）。
 *
 * ⚠️ 只给「后台清理 / 定时器 / 进程收尾」这类路径用，业务取值仍必须用 readSetting()：
 *   · §3.1 要求「未声明的键读取即报错」，业务路径要的就是这个响声；
 *   · 但会话清扫器（`_browser_session.ts` 的 sweepOnce / TTL）跑在 setInterval 里，
 *     组一旦因声明不合法被挂起，严格读会抛 ERR_UNDECLARED_SETTING → 定时器里变成
 *     unhandled rejection，且「关不掉已经开着的浏览器」比「读不到配置」严重得多。
 *   · 兜底值是**调用方按改造前的旧默认值**给出的，不是第二份「默认值声明」：
 *     它只在键不可读时生效，正常路径永远以声明为准（§3.2）。
 */
export function readSettingSoft<T>(key: string, fallback: T): T {
  if (!getSettingDef(key)) {
    warnOnce(key, "未声明（所属组未注册或已挂起），后台清理路径已使用内置兜底值");
    return fallback;
  }
  return readSetting<T>(key);
}

/**
 * 全部「已声明为 `secret: true` 的工具设置项」的当前取值（非空 / 去重 / 长度降序）。
 *
 * 用途：跨工具的**密钥掩码** —— `local/shell` 要把命令输出、日志、弹窗文本里出现的密钥
 * 字面值替换成 `****`（SH-37），这需要拿到**别的组**的密钥。
 *
 * ⚠️ 为什么放在取值层、而不是让 shell 直接读 internet/web 的组设置项（R-25）：
 *   §7.3 规定「组设置项仅该组可读」，`local/shell` 读 `TOOLSET__internet__web__deepseek_api_key`
 *   属于**越权**（也正是 V-5 要验证「跨组读抛 ERR_UNDECLARED_SETTING」的那条）。
 *   而「任何密钥都不得出现在回灌文本里」是**平台级**关切，应由取值层统一枚举。
 * ⚠️ 只枚举工具域；系统项（`LLM_API_KEY`）由调用方自己从 `env` 取 —— 系统项本来就允许平台读。
 */
export function secretSettingValues(): string[] {
  // ⚠️ [BR-5] 只返回**当前 agent 自己**的密钥：不再是「文件里所有 secret 项」。
  //    A agent 的密钥不会出现在 B agent 的请求上下文里（上下文隔离由 ALS 保证）。
  const bag = currentSettings();
  const out: string[] = [];
  for (const [key, def] of getRegistry().settingDefs) {
    if (def.secret !== true) continue;
    const raw = bag.get(key);
    if (raw === undefined || raw === "") continue;
    // 只收「解析成功」的值：不合法值按 §7.4 已回退默认值，不该拿默认值去替换正文
    const parsed = parseSettingValue(def, raw);
    if (parsed.ok) out.push(String(parsed.value));
  }
  return [...new Set(out.filter((s) => s !== ""))].sort((a, b) => b.length - a.length);
}

/* ============================================================
 * 开关与门禁（§8.2 / §8.3）
 *   取值顺序：**当前 agent 的配置快照**里是否包含该 toggleKey → 否则视为关闭。
 *
 *   ⚠️ 语义变更（需求 BR-1 / BR-2，「显式列举才可用」）：
 *       · 工具与技能同口径：未列出 / null / [] → 全部不可用；
 *       · 没有「全局总闸」这一层（env.json 的 tools 块已废除）；
 *       · 无请求上下文（后台定时器 / 单测）→ 一律关闭。
 * ============================================================ */

/**
 * 单个开关的生效值：当前 agent 的配置快照里**显式包含**该 toggleKey 才为 true。
 * 目录根（key === ""）没有开关，恒为可用。
 */
export function isToggleOn(key: string): boolean {
  if (key === "") return true;              // 根目录无开关
  return currentAgentToolConfig()?.enabledToggles.has(key) ?? false;
}

/**
 * 技能开关的生效值：与工具侧**分开取**（技能键是 SKILLON__，工具键是 TOOLON__）。
 *
 * ⚠️ 为什么技能不共用 `isToggleOn`：两套键空间本来就独立（N-SK-5），
 *    而 `enabledToggles`（工具）与 `enabledSkillToggles`（技能）分别由
 *    setup.json 的 `tools.allow` 与 `skills.list` 翻译而来，必须各取各的。
 * ⚠️ 历史坑（[FIX-SKILLTOGGLE]）：`skills/l2tool.ts` 与 `routes/config.ts` 的技能节点
 *    曾误用工具侧 `isToggleOn`，导致「技能已装配、但 get_l2 恒报 skill_disabled、
 *    配置页恒显示关闭」。新增任何读技能开关的代码，必须用本函数。
 */
export function isSkillToggleOn(key: string): boolean {
  if (key === "") return true;
  return currentAgentToolConfig()?.enabledSkillToggles.has(key) ?? false;
}

/** 目录链（自身 + 全部祖先）是否全开 */
export function dirSwitchOn(dirPath: string): boolean {
  const reg = getRegistry();
  let acc = "";
  for (const seg of pathSegments(dirPath)) {
    acc = acc === "" ? seg : `${acc}/${seg}`;
    const rec = reg.dirs.get(acc);
    if (!rec) return false;
    if (!isToggleOn(rec.toggleKey)) return false;
  }
  return true;
}

export type GroupState =
  | { available: true }
  | { available: false; reason: "dir_off" | "group_off" | "suspended"; detail?: string };

/** 组可用性：祖先目录全开 且 组开关开 且 未挂起（§8.3 后端独立复查） */
export function groupState(groupId: string): GroupState {
  const reg = getRegistry();
  const g = reg.groups.get(groupId);
  if (!g) return { available: false, reason: "suspended", detail: "未注册（入口不存在或加载失败）" };
  let acc = "";
  for (const seg of pathSegments(g.dirPath)) {
    acc = acc === "" ? seg : `${acc}/${seg}`;
    const d = reg.dirs.get(acc);
    if (!d || d.suspend) return { available: false, reason: "suspended", detail: `上级目录 ${acc} 不可用` };
    if (!isToggleOn(d.toggleKey)) return { available: false, reason: "dir_off", detail: acc };
  }
  if (g.suspend) return { available: false, reason: "suspended", detail: `${g.suspend.code}：${g.suspend.reason}` };
  if (!isToggleOn(g.toggleKey)) return { available: false, reason: "group_off" };
  return { available: true };
}

/* ============================================================
 * 作用域读取器（§7.3：目录项对子树可读，组项仅本组可读）
 * ============================================================ */

export interface ScopedDirSettings {
  key(name: string): string;
  def(name: string): SettingDef;
  get<T>(name: string): T;
  /** 软读：未声明时回落到 fallback（仅后台清理路径使用，见 readSettingSoft） */
  getSoft<T>(name: string, fallback: T): T;
}

export interface ScopedGroupSettings extends ScopedDirSettings {
  /** 组当前是否可用（用于「开关关闭时主动收尾」这类内部行为） */
  isOn(): boolean;
}

export function dirScope(dirPath: string): ScopedDirSettings {
  const key = (name: string): string => dirSettingKey(dirPath, name);
  return {
    key,
    def: (name) => {
      const d = getSettingDef(key(name));
      if (!d) {
        const where = dirPath === "" ? "工具根目录" : `${dirPath}/${DIR_SETTINGS_FILE}`;
        throw new Error(`ERR_UNDECLARED_SETTING: ${key(name)} 未在 ${where} 中声明`);
      }
      return d;
    },
    get: <T,>(name: string) => readSetting<T>(key(name)),
    getSoft: <T,>(name: string, fallback: T) => readSettingSoft<T>(key(name), fallback),
  };
}

export function groupScope(dirPath: string, fileBase: string): ScopedGroupSettings {
  const key = (name: string): string => groupSettingKey(dirPath, fileBase, name);
  return {
    key,
    def: (name) => {
      const d = getSettingDef(key(name));
      if (!d) {
        throw new Error(
          `ERR_UNDECLARED_SETTING: ${key(name)} 未在 ${dirPath === "" ? "" : `${dirPath}/`}${fileBase}.ts 中声明`,
        );
      }
      return d;
    },
    get: <T,>(name: string) => readSetting<T>(key(name)),
    getSoft: <T,>(name: string, fallback: T) => readSettingSoft<T>(key(name), fallback),
    isOn: () => groupState(dirPath === "" ? fileBase : `${dirPath}/${fileBase}`).available,
  };
}

function absFromMeta(meta: ImportMeta): string {
  // 入口文件是以「路径 ?v=mtime」方式加载的，必须先去掉查询串再转成文件路径
  const url = meta.url.split("?")[0] as string;
  return fileURLToPath(url);
}

function dirFromMeta(meta: ImportMeta): string {
  const rel = relative(TOOLS_ROOT, absFromMeta(meta)).replace(/\\/g, "/");
  const segs = rel.split("/");
  segs.pop();
  return segs.join("/");
}

function scopeFromMeta(meta: ImportMeta): { dirPath: string; fileBase: string } {
  const rel = relative(TOOLS_ROOT, absFromMeta(meta)).replace(/\\/g, "/");
  const segs = rel.split("/");
  const file = segs.pop() ?? "";
  return { dirPath: segs.join("/"), fileBase: file.replace(/\.ts$/, "") };
}

/** 目录作用域：只依赖所在目录，私有模块（`_shared.ts` 等）也可直接用 */
export function dirSettings(meta: ImportMeta): ScopedDirSettings {
  return dirScope(dirFromMeta(meta));
}

/**
 * 组作用域：依赖「入口文件名」，因此**只允许在入口文件里用**。
 * 私有模块（`_common.ts` 服务 web.ts 与 browser.ts）必须用显式形式 groupScope("internet", "web")。
 */
export function groupSettings(meta: ImportMeta): ScopedGroupSettings {
  const { dirPath, fileBase } = scopeFromMeta(meta);
  return groupScope(dirPath, fileBase);
}
