/**
 * src/skills/frontmatter.ts
 * SKILL.md 的 frontmatter 切分 + 字段契约校验（§4.2 / §4.5 / §4.6）。
 *
 * 设计：**纯函数**。工具是否存在由调用方以 isKnownTool 回调注入 ——
 *   本文件不 import @/tools/scan，避免「校验逻辑绑定到注册表单例」。
 *
 * [C-19] **零依赖**：本仓库没有（也不打算引入）`yaml` 包，因此内置 `parseYamlLite`。
 *   它只支持确定性的子集（见 §2.6 的语法表），超出范围一律 `parse_failed`（挂起 + 给出怎么改），
 *   绝不做「猜意图」的容错 —— 猜错的代价是用户以为 skill 生效了。
 */
// ⚠️ 只引 src/tools/paths.ts —— 该文件【零业务依赖，只 import node:path】，
//    因此引它既不成环、也不会把工具注册表拉进来（见该文件顶部注释）。
//    键名规则与「形似密钥」判定必须与工具侧**同一份实现**，不能各写一遍。
import { checkName, isSensitiveName } from "@/tools/paths";

/* ============================================================
 * 契约（§4.5 / §4.6）
 * ============================================================ */

export const TITLE_MAX = 20;
export const SUMMARY_MAX = 60;

export interface SkillSettingDefLike {
  kind: "string" | "number" | "boolean" | "string_array";
  default: string | number | boolean | readonly string[];
  desc?: string;
  secret?: boolean;
  min?: number;
  max?: number;
  options?: readonly string[];
  optionLabels?: Record<string, string>;
  dependsOn?: { name: string; equals: readonly string[] };
}

export interface SkillFrontmatter {
  name: string;
  title: string;
  summary: string;
  /** 已归一为 callName（点号）；空数组 = 不收窄白名单（§7.3 第 3 条） */
  tools: string[];
  settings: Record<string, SkillSettingDefLike>;
  version?: number;
}

export type FrontmatterCode =
  | "parse_failed"
  | "invalid_frontmatter"
  | "name_mismatch"
  | "unknown_tool"
  | "invalid_settings";

export type FrontmatterResult =
  | { ok: true; data: SkillFrontmatter; body: string }
  | { ok: false; code: FrontmatterCode; reason: string };

/**
 * 工具名归一（C-7）：允许 `local.shell.run`（callName）与 `local__shell__run`（visibleName）。
 *
 * ⚠️ 只做**形状**归一，不做「存在性」判断 —— 存在性仍由调用方用注册表判定，
 *    且**归一后仍必须是已注册工具**，不放松任何边界。
 */
export function normalizeToolName(raw: string): string {
  const t = raw.trim();
  return t.includes(".") ? t : t.replace(/__/g, ".");
}

/* ============================================================
 * 迷你 YAML（C-19，零依赖）
 * ============================================================ */

/** 支持范围见 §2.6 的语法表；超范围一律报错（含行号），不猜 */
export class YamlLiteError extends Error {}

/** 去掉行尾 `#` 注释（引号内的 `#` 不算） */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // 注释起点：`#` 且位于行首或前面是空白
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 标量转换：引号字符串 / true|false / 整数 / 空值；其余按字符串 */
function parseScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return null;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    // 双引号：支持 \" \\ \n \t 四种转义（够用且确定）
    return t.slice(1, -1).replace(/\\(.)/g, (_m, c: string) => {
      if (c === "n") return "\n";
      if (c === "t") return "\t";
      return c;
    });
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : t;
  }
  // 不确定的形态一律按字符串，交给后续字段校验（例如 version: 1.5 → 字符串 → invalid_frontmatter）
  return t;
}

/** 按顶层逗号切分 flow 内容（忽略引号与括号内的逗号） */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

/** flow 值：`[a, b]` / `{ k: v }` / 标量 */
function parseFlowValue(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    return splitFlow(t.slice(1, -1)).map((x) => parseFlowValue(x));
  }
  if (t.startsWith("{") && t.endsWith("}")) {
    const obj: Record<string, unknown> = {};
    for (const part of splitFlow(t.slice(1, -1))) {
      const idx = part.indexOf(":");
      if (idx === -1) throw new YamlLiteError(`flow 映射的项缺少冒号：${part.trim()}`);
      obj[part.slice(0, idx).trim()] = parseFlowValue(part.slice(idx + 1));
    }
    return obj;
  }
  return parseScalar(t);
}

/** 找未加引号的 `key: value` 分隔符位置（key 不允许含引号） */
function findKeyColon(line: string): number {
  return line.indexOf(":");
}

/**
 * 解析 frontmatter 文本为普通对象。
 *
 * 只支持 §2.6 表里列出的语法：
 *   单层键值 / flow 序列 / 行块序列 / flow 映射 / 两层嵌套 / 单双引号 / 行内注释 / 标量。
 * 显式拒绝：多行块标量 `|` `>`、锚点别名 `&` `*`、Tab 缩进、多文档 `---`。
 */
export function parseYamlLite(raw: string): Record<string, unknown> {
  const src = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = src.split("\n");
  const root: Record<string, unknown> = {};
  /** 缩进栈：{ indent, node, parentIndent } */
  const stack: Array<{ indent: number; node: Record<string, unknown> }> = [
    { indent: -1, node: root },
  ];

  /** 当前「待填充的数组型键」：行块序列 `- a` 用 */
  let pendingArray: { node: Record<string, unknown>; key: string; indent: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i] as string;
    if (rawLine.trim() === "") continue;
    // Tab 缩进：只允许空格
    if (/^ *\t/.test(rawLine)) {
      throw new YamlLiteError(`第 ${lineNo} 行用了 Tab 缩进（只允许空格）`);
    }
    const noComment = stripComment(rawLine).replace(/\s+$/, "");
    if (noComment.trim() === "") continue;
    const indent = (noComment.length - noComment.trimStart().length) | 0;
    const body = noComment.trim();

    // 多文档分隔 / 多行块标量 / 锚点别名：显式拒绝（宁可不解析，也不猜）
    if (body === "---" || body === "...") {
      throw new YamlLiteError(`第 ${lineNo} 行出现多文档分隔符（一个文件只能有一个文档）`);
    }
    if (/^[&*]/.test(body)) {
      throw new YamlLiteError(`第 ${lineNo} 行使用了锚点 / 别名（不受支持的语法）`);
    }

    // ── 行块序列项：`- xxx` ──
    if (body.startsWith("- ") || body === "-") {
      if (!pendingArray) {
        throw new YamlLiteError(`第 ${lineNo} 行是列表项，但上面没有可放入列表的键`);
      }
      if (indent <= pendingArray.indent) {
        throw new YamlLiteError(`第 ${lineNo} 行的列表缩进不正确（应比键更深）`);
      }
      // 键下面直接写列表（key: 换行 - a）：此时该键此前被当成「空嵌套映射」建了空对象，
      // 第一次遇到列表项时把空对象替换成数组（只有「空对象」才允许替换，非空说明写错了）
      const slot = pendingArray.node[pendingArray.key];
      let arr: unknown[];
      if (Array.isArray(slot)) {
        arr = slot;
      } else if (slot && typeof slot === "object" && Object.keys(slot as object).length === 0) {
        arr = [];
        pendingArray.node[pendingArray.key] = arr;
      } else {
        throw new YamlLiteError(
          `第 ${lineNo} 行：键 ${pendingArray.key} 下面既有映射又有列表项，不受支持的语法`,
        );
      }
      arr.push(parseFlowValue(body.slice(1).trim()));
      continue;
    }

    // ── 键值行 ──
    const colon = findKeyColon(body);
    if (colon <= 0) {
      throw new YamlLiteError(`第 ${lineNo} 行不是合法的「键: 值」形式`);
    }
    const key = body.slice(0, colon).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new YamlLiteError(`第 ${lineNo} 行的键名不合法：${key}`);
    }
    const valueText = body.slice(colon + 1).trim();

    // 定位当前缩进层级对应的节点
    while (stack.length > 1 && indent <= (stack[stack.length - 1] as { indent: number }).indent) {
      stack.pop();
    }
    const cur = (stack[stack.length - 1] as { indent: number; node: Record<string, unknown> }).node;
    pendingArray = null;

    if (valueText === "") {
      // 空值：可能是嵌套映射，也可能是行块序列（由后续行决定）
      const child: Record<string, unknown> = {};
      cur[key] = child;
      stack.push({ indent, node: child });
      pendingArray = { node: cur, key, indent };
      continue;
    }
    if (valueText.startsWith("|") || valueText.startsWith(">")) {
      throw new YamlLiteError(
        `第 ${lineNo} 行使用了多行块标量（${valueText[0]}），不受支持的语法；请改写成一行`,
      );
    }
    cur[key] = parseFlowValue(valueText);
  }

  /**
   * 收尾：被当作「嵌套映射」建出来的空对象，如果从未被填充，说明它其实是一个**空数组**的键
   * （如 `tools:` 下一行没有列表）——此时按 null 处理，交给字段校验报出可读原因。
   * 这里不做魔法转换：空对象保持空对象，`tools` 的校验会给出「必须是字符串数组」。
   */
  return root;
}

/* ============================================================
 * 切分
 * ============================================================ */

/**
 * 切出 frontmatter 与正文。
 *
 * 规则（刻意严格，宁可 parse_failed 也不猜）：
 *   ① 文件必须以 `---` 单独一行开头（允许 BOM / CRLF）；否则 parse_failed
 *   ② 必须有一个**单独一行**的 `---` 收尾；找不到 → parse_failed
 *   ③ frontmatter 内文本交给 parseYamlLite
 */
function splitFrontmatter(text: string): { raw: string; body: string } | { error: string } {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  // ⚠️ tsconfig 开了 noUncheckedIndexedAccess：lines[0] 的类型是 string | undefined，
  //    必须显式判空后再取 trim()，不能写 lines[0]!（文档原写法在本仓库不可用）
  const first = lines[0];
  if (first === undefined || first.trim() !== "---") {
    return { error: "文件必须以单独一行 --- 开头（这是 frontmatter 的起始围栏）" };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] as string).trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { error: "frontmatter 没有收尾：需要一个单独一行的 ---" };
  return {
    raw: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

/* ============================================================
 * 设置项校验（与 src/tools/scan.ts 的 validateDefinition + checkDefaultValue 逐条对应）
 * ============================================================ */

function checkDefault(kind: string, v: unknown): string | null {
  switch (kind) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? null : "default 必须为数值";
    case "boolean":
      return typeof v === "boolean" ? null : "default 必须为布尔值";
    case "string":
      return typeof v === "string" ? null : "default 必须为字符串";
    case "string_array":
      return Array.isArray(v) && v.every((x) => typeof x === "string")
        ? null
        : "default 必须为字符串数组";
    default:
      return "kind 不受支持";
  }
}

function validateSettingDef(name: string, v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return `键 ${name} 的定义必须为对象`;
  const d = v as Record<string, unknown>;
  const kind = d.kind;
  // ① kind 先判（与工具侧同序）
  if (kind !== "string" && kind !== "number" && kind !== "boolean" && kind !== "string_array") {
    return `键 ${name} 的 kind 只能是 string / number / boolean / string_array（不支持嵌套对象）`;
  }
  // ② default 必填
  if (d.default === undefined) return `键 ${name} 缺少 default（默认值必填且只读）`;
  const badDefault = checkDefault(kind, d.default);
  if (badDefault) return `键 ${name}：${badDefault}`;
  // ③ number 的 min / max
  if (kind === "number") {
    if (d.min !== undefined && typeof d.min !== "number") return `键 ${name} 的 min 必须为数值`;
    if (d.max !== undefined && typeof d.max !== "number") return `键 ${name} 的 max 必须为数值`;
    const n = d.default as number;
    if (typeof d.min === "number" && n < d.min) return `键 ${name} 的 default 小于 min`;
    if (typeof d.max === "number" && n > d.max) return `键 ${name} 的 default 大于 max`;
    if (typeof d.min === "number" && typeof d.max === "number" && d.min > d.max) {
      return `键 ${name} 的 min 不得大于 max`;
    }
  }
  // ④ string 的 options
  if (kind === "string" && d.options !== undefined) {
    if (!Array.isArray(d.options) || d.options.some((x) => typeof x !== "string")) {
      return `键 ${name} 的 options 必须为字符串数组`;
    }
    if (!(d.options as string[]).includes(d.default as string)) {
      return `键 ${name} 的 default 不在 options 候选中`;
    }
  }
  // ⑤ dependsOn 形状
  if (d.dependsOn !== undefined) {
    const dep = d.dependsOn as Record<string, unknown>;
    if (
      !dep || typeof dep !== "object" ||
      typeof dep.name !== "string" ||
      !Array.isArray(dep.equals) || dep.equals.some((x) => typeof x !== "string")
    ) {
      return `键 ${name} 的 dependsOn 必须形如 { name: string, equals: string[] }`;
    }
  }
  // ⑥ secret / desc 类型
  if (d.secret !== undefined && typeof d.secret !== "boolean") return `键 ${name} 的 secret 必须为布尔值`;
  if (d.desc !== undefined && typeof d.desc !== "string") return `键 ${name} 的 desc 必须为字符串`;
  if (d.optionLabels !== undefined) {
    const ol = d.optionLabels;
    if (!ol || typeof ol !== "object" || Array.isArray(ol) ||
      Object.values(ol as Record<string, unknown>).some((x) => typeof x !== "string")) {
      return `键 ${name} 的 optionLabels 必须是 { 值: 中文 } 的字符串映射`;
    }
  }
  return null;
}

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * @param text         SKILL.md 全文
 * @param dir          该 skill 相对 SKILLS_ROOT 的目录（用于 name 一致性校验）
 * @param isKnownTool  已注册工具判定（注入；scan.ts 传 (callName) => knownTools.has(callName)）
 */
export function parseFrontmatter(
  text: string,
  dir: string,
  isKnownTool: (callName: string) => boolean,
): FrontmatterResult {
  const split = splitFrontmatter(text);
  if ("error" in split) return { ok: false, code: "parse_failed", reason: split.error };

  let doc: unknown;
  try {
    doc = parseYamlLite(split.raw);
  } catch (err) {
    return {
      ok: false,
      code: "parse_failed",
      reason: `YAML 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, code: "invalid_frontmatter", reason: "frontmatter 必须是一个映射（key: value）" };
  }
  const fm = doc as Record<string, unknown>;

  /* ── name：必需 + 等于目录名（§4.5） ── */
  if (typeof fm.name !== "string" || fm.name.trim() === "") {
    return { ok: false, code: "invalid_frontmatter", reason: "缺少 name（必需，且必须等于所在目录名）" };
  }
  const name = fm.name.trim();
  const lastSeg = dir.split("/").pop() ?? "";
  if (name !== lastSeg) {
    return {
      ok: false,
      code: "name_mismatch",
      reason: `frontmatter 的 name（${name}）与所在目录名（${lastSeg}）不一致`,
    };
  }

  /* ── title / summary：必需 + 长度（C-2：三个口径都校验） ── */
  if (typeof fm.title !== "string" || fm.title.trim() === "") {
    return { ok: false, code: "invalid_frontmatter", reason: "缺少 title（必需，≤ 20 字）" };
  }
  if (typeof fm.summary !== "string" || fm.summary.trim() === "") {
    return { ok: false, code: "invalid_frontmatter", reason: "缺少 summary（必需，≤ 60 字）" };
  }
  const title = fm.title.trim();
  const summary = fm.summary.trim();
  if (title.length > TITLE_MAX) {
    return { ok: false, code: "invalid_frontmatter", reason: `title 超过 ${TITLE_MAX} 字（当前 ${title.length}）` };
  }
  if (summary.length > SUMMARY_MAX) {
    return { ok: false, code: "invalid_frontmatter", reason: `summary 超过 ${SUMMARY_MAX} 字（当前 ${summary.length}）` };
  }
  if (title.length + summary.length > SUMMARY_MAX) {
    return {
      ok: false,
      code: "invalid_frontmatter",
      reason: `title + summary 合计超过 ${SUMMARY_MAX} 字（当前 ${title.length + summary.length}）`,
    };
  }

  /* ── tools：可选；每个都必须是已注册工具（§7.3 / N-SK-3） ── */
  let tools: string[] = [];
  if (fm.tools !== undefined) {
    if (!Array.isArray(fm.tools) || fm.tools.some((x) => typeof x !== "string")) {
      return { ok: false, code: "invalid_frontmatter", reason: "tools 必须是字符串数组（如 [local.shell.run]）" };
    }
    const unknown: string[] = [];
    const norm: string[] = [];
    for (const raw of fm.tools as string[]) {
      const one = normalizeToolName(raw);
      if (!isKnownTool(one)) unknown.push(raw);
      else if (!norm.includes(one)) norm.push(one);
    }
    if (unknown.length > 0) {
      // ⚠️ 绝不「忽略并告警」：静默丢弃会让用户以为限权已生效，实际拿到全量工具（安全性质错误）
      return {
        ok: false,
        code: "unknown_tool",
        reason: `tools 里引用了不存在的工具：${unknown.join("、")}（只能用配置页「工具配置」里已开启的 callName，如 local.shell.run）`,
      };
    }
    tools = norm;
  }

  /* ── settings：可选；逐项校验 ── */
  const settings: Record<string, SkillSettingDefLike> = {};
  if (fm.settings !== undefined) {
    if (!fm.settings || typeof fm.settings !== "object" || Array.isArray(fm.settings)) {
      return { ok: false, code: "invalid_settings", reason: "settings 必须是以键名为属性名的普通对象" };
    }
    const seen = new Set<string>();
    for (const [k, def] of Object.entries(fm.settings as Record<string, unknown>)) {
      // 键名复用工具侧规则：字母开头、[A-Za-z0-9_]、1–32、不得含 __、不得用保留名
      const nm = checkName(k);
      if (!nm.ok) {
        return { ok: false, code: "invalid_settings", reason: `设置项键名 ${k} 不合规：${nm.reason}` };
      }
      if (seen.has(k.toLowerCase())) {
        return { ok: false, code: "invalid_settings", reason: `设置项键名重复：${k}` };
      }
      seen.add(k.toLowerCase());
      const bad = validateSettingDef(k, def);
      if (bad) return { ok: false, code: "invalid_settings", reason: bad };
      // §9.1 同款：形似密钥但没标 secret → 声明不合法（挂起，而不是等用户点保存才 400）
      if (isSensitiveName(k) && (def as SkillSettingDefLike).secret !== true) {
        return {
          ok: false,
          code: "invalid_settings",
          reason: `设置项 ${k} 名字形似密钥，但定义里没有 secret: true`,
        };
      }
      settings[k] = def as SkillSettingDefLike;
    }
  }

  /* ── version：可选，仅展示 ── */
  let version: number | undefined;
  if (fm.version !== undefined) {
    if (typeof fm.version !== "number" || !Number.isFinite(fm.version)) {
      return { ok: false, code: "invalid_frontmatter", reason: "version 必须是数值（仅展示用）" };
    }
    version = fm.version;
  }

  return {
    ok: true,
    data: { name, title, summary, tools, settings, version },
    body: split.body,
  };
}
