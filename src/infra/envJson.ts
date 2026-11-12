/**
 * src/infra/envJson.ts
 * env.json 的读取 / 规整 / 校验 / 序列化 / 原子写 / 备份（迁移文档 4.1）。
 *
 * 唯一职责：把「JSON 文件」与「强类型 EnvJson 对象」互相转换，并保证写盘安全。
 *   · 不做业务判断（开关语义在 settings.ts，配置页语义在 configFile.ts / routes/config.ts）
 *   · 不 import 任何业务模块（避免 env.ts ⇄ configFile.ts 成环）
 *
 * ⚠️ 默认值单一来源：默认值来自 CONFIG_KEYS，由调用方注册（registerEnvJsonDefaults），
 *    本文件**不写任何默认值字面量**，也绝不把默认值预填进 env.json（方案 2.2-1）。
 *
 * 允许的 import（迁移文档第七章第 6 条）：
 *   fs / path / ./thinkingMode（零依赖） / ../tools/paths（零依赖底座）
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  copyFileSync, unlinkSync, readdirSync, statSync,
} from "fs";
import { resolve, join } from "path";
import { parseThinkingMode, type ThinkingMode } from "./thinkingMode";
import { hasManagedPrefix, isReservedName } from "../tools/paths";
/** 项目根目录：<项目根>/src/infra/ 上溯两级（与 configFile.ts 同基准，勿改） */
const PROJECT_ROOT = resolve(import.meta.dir, "../..");

/** env.json 绝对路径（替代原 .env）。用 let 仅为测试钩子 __setEnvJsonPathForTest 服务。 */
let envJsonPath = resolve(PROJECT_ROOT, "env.json");
/** 原子写中转文件（必须与目标同目录，rename 才是原子的） */
let envJsonTmp = resolve(PROJECT_ROOT, "env.json.tmp");
/** 备份目录：沿用 data/envbk（方案 4.3；见第零章 P2） */
const backupDir = resolve(PROJECT_ROOT, "data/envbk");
/** 备份保留份数（与现状一致） */
const KEEP_BACKUPS = 20;

/** LLM 组名规则（方案 3.1；第零章 P3：另需排除 RESERVED_NAMES） */
export const LLM_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * [BR-6] LLM 组名**比较口径**的唯一实现：ASCII 折叠（仅折叠 A-Z）+ trim。
 *
 * ⚠️ 不用 `toLowerCase()`：它会做 Unicode 大小写映射（`İ` → `i̇`、`K` → `k`），
 *    与「ASCII 折叠」约定不符，且会让 `llm[]` 里两个不同名字折叠成同一个。
 * ⚠️ 折叠**只用于比较**，不用于存储：`app.defaultLlm` 与 `setup.json` 的 `llm`
 *    都保留用户书写时的原始大小写（见代码修改文档 4.5a 约束 2）。
 */
export function foldLlmName(s: string): string {
  return String(s ?? "").trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** [BR-6] 两个 LLM 组名是否相同（大小写不敏感的 ASCII 折叠比较） */
export function eqLlmName(a: string, b: string): boolean {
  return foldLlmName(a) === foldLlmName(b);
}

/**
 * [BR-4] 读出「默认 LLM 组名」：唯一来源是 `app.defaultLlm`。
 *
 * @returns 组名（已 trim，保留原始大小写）
 * @throws  EnvJsonError —— 字段缺失 / 非字符串 / 空串（D-1 选 (a)：拒绝启动），
 *          或字段存在但指向 `llm[]` 中不存在的组（同样拒绝启动）。
 *          调用方若只想「读读看」（如配置页列表），请自行 try/catch。
 */
export function resolveDefaultLlmName(raw: EnvJson): string {
  const app = raw.app as unknown as Record<string, unknown>;
  const name = app?.defaultLlm;
  if (typeof name !== "string" || name.trim() === "") {
    const available = raw.llm.map((g) => g.name).join(", ") || "(llm[] 为空)";
    throw new EnvJsonError(
      "env.json 缺少必需项：app.defaultLlm（默认 LLM 组名）",
      undefined, undefined,
      `请在 app 段补 "defaultLlm": "<组名>"，可选值：${available}。` +
      "（升级后默认组必须显式指定，不再按下标取 llm[0] —— 见 docs/配置说明.md）",
    );
  }
  return name.trim();
}

/**
 * [BR-6] 按名字定位 `llm[]` 下标（大小写不敏感）。未命中返回 -1（**永不回退到 0**）。
 */
export function findLlmIndex(env: EnvJson, name: string): number {
  const want = foldLlmName(name);
  if (want === "") return -1;
  return env.llm.findIndex((g) => foldLlmName(g.name) === want);
}

/**
 * [BR-4] 取默认组的**下标**；字段缺失/指向不存在组时抛 EnvJsonError。
 * 这是全仓「默认组是谁」的唯一判定入口。
 */
export function defaultLlmIndex(env: EnvJson): number {
  const name = resolveDefaultLlmName(env);
  const i = findLlmIndex(env, name);
  if (i < 0) {
    const available = env.llm.map((g) => g.name).join(", ") || "(llm[] 为空)";
    throw new EnvJsonError(
      `env.json 的 app.defaultLlm 指向不存在的 LLM 组：「${name}」`,
      undefined, undefined,
      `可选值：${available}。请把 app.defaultLlm 改成其中一个组名（不区分大小写）。`,
    );
  }
  return i;
}

/** env.json 绝对路径（读取用，勿改） */
export function envJsonFilePath(): string { return envJsonPath; }
/** 备份目录（读取用，勿改） */
export function envJsonBackupDir(): string { return backupDir; }

/**
 * 测试与验收脚本用：把 env.json 指到别的路径（**生产代码永不调用**）。
 * 传 null 恢复默认。切换后强制让托管值缓存失效，避免读到上一个文件的快照。
 */
export function __setEnvJsonPathForTest(p: string | null): void {
  envJsonPath = p ?? resolve(PROJECT_ROOT, "env.json");
  envJsonTmp = `${envJsonPath}.tmp`;
  cacheStamp = null;
}

/* ============================================================
 * 类型与映射表（单一来源，从 CONFIG_KEYS 派生）
 * ============================================================ */

export interface LlmGroup {
  name: string;
  base: string;
  key: string;
  model: string;
  thinkingMode?: ThinkingMode;
  thinking?: boolean;
  reasoningEffort?: string;
}

export interface EnvJson {
  /**
   * [BR-4] `defaultLlm` = 默认 LLM 组名（**唯一来源**，不再按下标取 `llm[0]`）。
   *
   * 它是持久化字段，但**不是**扁平配置项：不进 CONFIG_KEY_TO_JSON、不进配置页控件、
   * 不进 `pruneDefaults` 的 strip 范围（strip 只删「值等于默认值」的已识别字段，
   * defaultLlm 恒有值且必须落盘，否则重启即报错）。
   */
  app: { port: number; defaultLlm: string };
  /** 至少 1 项；「默认组」由 app.defaultLlm 指定（BR-4），找不到即配置错误 */
  llm: LlmGroup[];
  log: { enabled: boolean; file: string; maxRows: number };
  stab: { maxToolRounds: number; sseHeartbeatMs: number; toolResultMaxChars: number };
  /** 托管键 → **持久化文本（字符串）**；不是 boolean/number（第零章 P4） */
  tools: Record<string, string>;
}

/** 系统项键名 → JSON 路径（分组 + 字段名） */
export type FieldSpec =
  | { group: "app"; field: "port" }
  | { group: "log"; field: "enabled" | "file" | "maxRows" }
  | { group: "stab"; field: "maxToolRounds" | "sseHeartbeatMs" | "toolResultMaxChars" }
  | { group: "llm"; field: "base" | "key" | "model" | "thinkingMode" | "thinking" | "reasoningEffort" };

/**
 * ⚠️ 这张表是「系统项键名」→「JSON 路径」的**唯一落点**，与 CONFIG_KEYS 必须一一对应（有单测守）。
 *    新增系统项：这里 + CONFIG_KEYS 两处各加一行，顺序不限。
 *
 * 与 CONFIG_KEYS（12 项）的差集是 `EXTRA_SYSTEM_KEYS`（见下）：`TOOL_RESULT_MAX_CHARS`
 * 按方案 2.1 明确「不进配置页」，但仍是系统项、仍需 JSON 路径。
 */
export const CONFIG_KEY_TO_JSON: Readonly<Record<string, FieldSpec>> = {
  APP_PORT: { group: "app", field: "port" },
  LLM_API_BASE: { group: "llm", field: "base" },
  LLM_API_KEY: { group: "llm", field: "key" },
  LLM_MODEL: { group: "llm", field: "model" },
  LLM_THINKING_MODE: { group: "llm", field: "thinkingMode" },
  LLM_THINKING: { group: "llm", field: "thinking" },
  LLM_REASONING_EFFORT: { group: "llm", field: "reasoningEffort" },
  LLM_LOG_ENABLED: { group: "log", field: "enabled" },
  LLM_LOG_FILE: { group: "log", field: "file" },
  LLM_LOG_MAX_ROWS: { group: "log", field: "maxRows" },
  MAX_TOOL_ROUNDS: { group: "stab", field: "maxToolRounds" },
  SSE_HEARTBEAT_MS: { group: "stab", field: "sseHeartbeatMs" },
  TOOL_RESULT_MAX_CHARS: { group: "stab", field: "toolResultMaxChars" },
};

/**
 * 系统项里**不**出现在 CONFIG_KEYS（配置页）的键。
 * 迁移文档 4.1.2 的验证命令期望「多: ['TOOL_RESULT_MAX_CHARS']」——
 * 差异由本集合显式登记，不允许再出现第二种差异。
 */
export const EXTRA_SYSTEM_KEYS: readonly string[] = ["TOOL_RESULT_MAX_CHARS"];

/** 系统项键名集合（CONFIG_KEY_TO_JSON 的键） */
export const SYSTEM_KEY_SET: ReadonlySet<string> = new Set(Object.keys(CONFIG_KEY_TO_JSON));

/* ============================================================
 * 带定位信息的读取错误
 * ============================================================ */

/** 带定位信息的读取错误（方案 4.2：语法错误必须打印行列位置） */
export class EnvJsonError extends Error {
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly hint: string | undefined;

  constructor(message: string, line?: number, column?: number, hint?: string) {
    super(message);
    this.name = "EnvJsonError";
    this.line = line;
    this.column = column;
    this.hint = hint;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 把 JSON.parse 报的 position 换算成 行列 */
function locate(text: string, position: number): { line: number; column: number } {
  const head = text.slice(0, Math.max(0, position));
  const lines = head.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1] ?? "").length + 1 };
}

/**
 * 扫描**顶层**重复键（tools 是一层扁平对象，重复 key 也在顶层）。
 * 做法：跳过字符串字面量与转义，只在「深度 1 且字符串后紧跟冒号」时记为键。
 * 为什么不用正则 / 不手写完整 JSON 解析器：前者会把值里的 `"x":` 误判，后者成本过高。
 */
function findDuplicateTopKeys(text: string): string[] {
  const counts = new Map<string, number>();
  let inStr = false;
  let esc = false;
  let depth = 0;
  let token = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inStr) {
      if (esc) { esc = false; token += ch; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') {
        inStr = false;
        let j = i + 1;
        while (j < text.length && /\s/.test(text.charAt(j))) j++;
        if (depth === 1 && text.charAt(j) === ":") counts.set(token, (counts.get(token) ?? 0) + 1);
        token = "";
        continue;
      }
      token += ch;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") { depth++; continue; }
    if (ch === "}" || ch === "]") { depth--; continue; }
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

/** 读原始对象：不存在返回 null（不抛）；结构非法抛 EnvJsonError（带行列与修复提示） */
export function readEnvJsonRaw(): Record<string, unknown> | null {
  if (!existsSync(envJsonPath)) return null;
  // 去 BOM：记事本 / PowerShell 5 另存会带 U+FEFF，JSON.parse 会直接报错
  const text = readFileSync(envJsonPath, "utf-8").replace(/^\uFEFF/, "");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    const msg = errText(e);
    const m = /position\s+(\d+)/i.exec(msg);
    const { line, column } = locate(text, m ? Number(m[1]) : 0);
    throw new EnvJsonError(
      `env.json 不是合法 JSON：${msg}`, line, column,
      `请修正第 ${line} 行第 ${column} 列，或删除 env.json 后从 env.example.json 重建（说明见 docs/配置说明.md）。`,
    );
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new EnvJsonError("env.json 顶层必须是对象（{ ... }）", 1, 1, "参考 env.example.json 重建。");
  }
  const dups = findDuplicateTopKeys(text);
  if (dups.length > 0) {
    throw new EnvJsonError(
      `env.json 存在重复键：${dups.join(", ")}`, undefined, undefined,
      "JSON 对重复键「后者生效」且不报错，会导致「改了却不生效」。请删掉多余的那一份。",
    );
  }
  return obj as Record<string, unknown>;
}

/* ============================================================
 * 默认值注册 + 规整
 * ============================================================ */

/** 单键告警去重（方案 4.2「单键告警」；**不打印取值原文**，§8.7） */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`⚠️  [env-json] ${message}（键/路径：${key}）`);
}

/** 默认值注册：由调用方在模块顶部注册一次（避免本文件 import CONFIG_KEYS 造成成环） */
let defaults: EnvJson | null = null;
export function registerEnvJsonDefaults(d: EnvJson): void { defaults = d; }

/** 取一份默认值副本；未注册时抛错（这是「装了 configFile 却忘了注册」的唯一哨兵） */
function baseDefaults(): EnvJson {
  if (!defaults) {
    throw new Error(
      "ERR_ENVJSON_NO_DEFAULTS: 调用方未注册默认值（应在 configFile.ts 模块顶部调用 registerEnvJsonDefaults）",
    );
  }
  return structuredClone(defaults);
}

/**
 * 取一份默认值副本（未注册时返回 null）。
 * ⚠️ 与 baseDefaults() 的区别：不会因为「未注册」而抛错，仅用于配置页容错路径。
 */
export function envJsonDefaultsOrNull(): EnvJson | null {
  return defaults ? structuredClone(defaults) : null;
}

/** 逐字段按「期望类型」校验；不符 → 回填默认值 + 告警（**不抛错**，第零章 P5） */
function coerceGroup<T extends Record<string, unknown>>(raw: unknown, def: T, where: string): T {
  const out = { ...def };
  if (raw === undefined) return out;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnOnce(where, `${where} 必须是对象，已按默认值处理`);
    return out;
  }
  for (const [k, dv] of Object.entries(def)) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const okType = typeof v === typeof dv && (typeof dv !== "number" || Number.isFinite(v as number));
    if (okType) (out as Record<string, unknown>)[k] = v;
    else warnOnce(`${where}.${k}`, `类型不符（期望 ${typeof dv}），已回填默认值`);
  }
  return out;
}

/** llm[i]：环境字段必须存在；name 非法/缺失 → 用兜底名 + 告警（不退出） */
function coerceLlmGroup(raw: unknown, i: number, fallback: LlmGroup): LlmGroup {
  const at = `llm[${i}]`;
  const fbName = i === 0 ? "main" : `llm${i}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnOnce(at, "元素必须是对象，已按默认值处理");
    return { ...fallback, name: fbName };
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string, dv: string): string => {
    const v = o[k];
    if (typeof v === "string") return v;
    if (v !== undefined) warnOnce(`${at}.${k}`, "必须是字符串，已回填默认值");
    return dv;
  };
  let name = str("name", fbName);
  // 第零章 P3：name 既要满足形状，也不得命中 RESERVED_NAMES（大小写不敏感）
  if (!LLM_NAME_RE.test(name) || isReservedName(name)) {
    warnOnce(`${at}.name`, `不合法（须匹配 ${LLM_NAME_RE} 且不得为保留名），已改用 "${fbName}"`);
    name = fbName;
  }
  const thinkingRaw = o.thinking;
  if (thinkingRaw !== undefined && typeof thinkingRaw !== "boolean") {
    warnOnce(`${at}.thinking`, "必须是布尔，已回填默认值");
  }
  return {
    name,
    base: str("base", fallback.base),
    key: str("key", fallback.key),
    model: str("model", fallback.model),
    thinkingMode: parseThinkingMode(str("thinkingMode", fallback.thinkingMode ?? "none")),
    thinking: typeof thinkingRaw === "boolean" ? thinkingRaw : (fallback.thinking ?? true),
    reasoningEffort: str("reasoningEffort", fallback.reasoningEffort ?? "high"),
  };
}

/**
 * 必需项断言（与 env.ts 的 REQUIRED_VARS 同口径，仅**默认组**三项）：
 *   · 文件不存在             → 抛错（提示从 env.example.json 复制）
 *   · 关键项为空             → 抛错（列出缺哪些 JSON 路径）
 *   · app.defaultLlm 缺失/指向不存在的组 → 抛错（D-1 选 (a)：拒绝启动）
 *   · app.port 缺失          → **不抛**：回填 CONFIG_KEYS 默认值（见 4.1.4 的 📌）
 *
 * ⚠️ [BR-4] 本函数判的是**默认组**的 base/key/model，不是 `llm[0]`。
 *    默认组的判定在 `defaultLlmIndex()` 内完成，字段缺失会直接抛错 ——
 *    这正是 D-1「缺字段拒绝启动」的落点（加载期，而非运行期）。
 */
function assertRequired(v: EnvJson, existed: boolean): EnvJson {
  if (!existed) {
    throw new EnvJsonError(
      `未找到 env.json（预期路径：${envJsonPath}）`, undefined, undefined,
      "请把项目根目录的 env.example.json 复制为 env.json，填入默认组的 key 后重启。",
    );
  }
  const idx = defaultLlmIndex(v);                 // 缺失 / 指向不存在组 → 抛 EnvJsonError
  const g = v.llm[idx] as LlmGroup;
  const at = `llm[${idx}]（默认组 ${g.name}）`;
  const missing: string[] = [];
  if (!g.base) missing.push(`${at}.base`);
  if (!g.key) missing.push(`${at}.key`);
  if (!g.model) missing.push(`${at}.model`);
  if (missing.length > 0) {
    throw new EnvJsonError(
      `env.json 缺少必需项：${missing.join(", ")}`, undefined, undefined,
      "参照 env.example.json 补齐后重启；密钥仍为明文落盘，与迁移前一致。",
    );
  }
  return v;
}

/** 读并规整为强类型（缺失项回填默认值；必需项缺失抛错） */
export function loadEnvJson(): EnvJson {
  const def = baseDefaults();
  const raw = readEnvJsonRaw();
  if (raw === null) return assertRequired(def, false);

  // ① llm 数组
  const rawLlm = raw.llm;
  const llm: LlmGroup[] = [];
  if (Array.isArray(rawLlm) && rawLlm.length > 0) {
    rawLlm.forEach((item, i) => llm.push(coerceLlmGroup(item, i, def.llm[0] as LlmGroup)));
  }
  if (llm.length === 0) {
    throw new EnvJsonError(
      "env.json 的 llm 至少需要 1 项（数组为空或缺失）", undefined, undefined,
      "参照 env.example.json 补一个 { name, base, key, model } 元素。",
    );
  }
  const names = llm.map((g) => g.name.toLowerCase());
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dup.length > 0) {
    throw new EnvJsonError(`llm 组的 name 重复：${dup.join(", ")}`, undefined, undefined,
      "name 用于 agent 阶段按名选组，必须唯一（大小写不敏感）。");
  }

  // ② 分组对象（app / log / stab）
  const app = coerceGroup(raw.app, def.app, "app") as EnvJson["app"];
  /**
   * [BR-4 / D-1(a)] `app.defaultLlm` **不做默认值回填**：
   *   `coerceGroup` 会按 def 回填缺失字段，而 def.app.defaultLlm 是占位值，
   *   回填就等于「悄悄兜底到某个组」，正是 D-1 明确拒绝的行为。
   *   这里显式判类型并**保留缺失态**（保留为空串），由 assertRequired 抛错。
   *   ⚠️ 不能用 delete —— EnvJson.app 的静态类型要求 defaultLlm 是 string。
   */
  const rawDefault = (raw.app as Record<string, unknown> | undefined)?.defaultLlm;
  if (typeof rawDefault === "string") {
    app.defaultLlm = rawDefault.trim();
  } else {
    if (rawDefault !== undefined && rawDefault !== null) {
      warnOnce("app.defaultLlm", "必须是字符串，已按「缺失」处理（启动时将报错）");
    }
    app.defaultLlm = "";
  }
  const log = coerceGroup(raw.log, def.log, "log");
  const stab = coerceGroup(raw.stab, def.stab, "stab");

  // ③ tools：值必须是字符串；非字符串丢弃 + 告警
  const tools: Record<string, string> = {};
  const rawTools = raw.tools;
  if (rawTools && typeof rawTools === "object" && !Array.isArray(rawTools)) {
    for (const [k, v] of Object.entries(rawTools as Record<string, unknown>)) {
      if (k.startsWith("_")) continue;                      // tools 里的 _comment 之类：忽略
      if (typeof v !== "string") {
        warnOnce(k, 'tools 的值必须是字符串，已丢弃该键（布尔请写 "true"/"false"，数组请写 JSON 文本）');
        continue;
      }
      tools[k] = v;
    }
  } else if (rawTools !== undefined) {
    warnOnce("tools", "tools 必须是对象，已按空处理");
  }

  // ④ 未知顶层键：告警但忽略（下次整树重写时会从文件里消失），不阻断启动
  for (const k of Object.keys(raw)) {
    if (k.startsWith("_")) continue;
    if (["app", "llm", "log", "stab", "tools"].includes(k)) continue;
    warnOnce(k, "未知的顶层键（既不是 app/llm/log/stab/tools 也不是 _ 开头的备注），已忽略；下次保存会从文件中移除");
  }

  return assertRequired({ app, llm, log, stab, tools }, true);
}

/* ============================================================
 * 托管键缓存（供 settings.ts 取值）
 * ============================================================ */

/**
 * 托管键缓存。**只缓存 tools 块**：
 *   · tools 是唯一存放 TOOLON__ / TOOLSET__ / etc__tools__ / SKILLON__ / SKILLSET__ 的地方
 *   · 顶层 _unmapped 里的键**不进**这里（它们是「未识别」的，按遗留键处理）
 *
 * 缓存键 = `${mtimeMs 取整}:${size}`，与迁移前 settings.ts 的 statStamp 完全同款语义。
 */
let cache: ReadonlyMap<string, string> = new Map();
let cacheStamp: string | null = null;
/** 供测试与日志使用：本进程里缓存被重建过几次（不改语义） */
export let refreshCount = 0;

function toolsStamp(): string {
  try {
    const st = statSync(envJsonPath);
    return `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "absent";
  }
}

/**
 * 读取托管键缓存。
 * @param force true = 忽略 stamp 强制重读（保存配置后必须用 true，见 R-3）
 * @returns 当前缓存（未被重建时返回同一对象引用）
 */
export function managedValues(force = false): ReadonlyMap<string, string> {
  const stamp = toolsStamp();
  if (!force && stamp === cacheStamp) return cache;
  // ⚠️ 读取必须容错：配置页与请求边界都会走这里，JSON 被改坏时不能把整站打成 500
  //    （严格校验由 loadEnvJson 负责，启动期才致命）。
  let raw: Record<string, unknown> | null = null;
  try {
    raw = readEnvJsonRaw();
  } catch {
    raw = null;
  }
  const next = new Map<string, string>();
  const t = raw?.tools;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
      // 只认字符串（P4）；非字符串在 loadEnvJson 阶段已告警，这里静默跳过，避免重复刷屏
      if (typeof v === "string") next.set(k, v);
    }
  }
  cache = next;
  cacheStamp = stamp;
  refreshCount += 1;
  return cache;
}

/** 强制让下一次 managedValues() 重读（写盘后调用，避免「同毫秒同大小」导致 stamp 未变） */
export function invalidateManagedCache(): void {
  cacheStamp = null;
}

/**
 * 顶层 `_unmapped`（迁移时未识别的旧键）。
 * 返回普通对象副本；文件不存在 / 字段缺失 / 类型不对时返回空对象。
 */
export function readUnmapped(): Record<string, string> {
  let raw: Record<string, unknown> | null;
  try {
    raw = readEnvJsonRaw();
  } catch {
    return {};                                  // 文件坏了：读不到就当没有，别让配置页打不开
  }
  const u = raw?._unmapped;
  if (!u || typeof u !== "object" || Array.isArray(u)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** 顶层 `_unmapped` 里的键名（遗留键来源之一，第零章 P1） */
export function listUnmappedKeys(): string[] {
  return Object.keys(readUnmapped()).sort();
}

/**
 * 「文件里出现过的全部键」= tools 块 ∪ 顶层 `_unmapped`。
 *
 * 用途：`listOrphanKeys()`（遗留键）与 `POST /refresh` 的残留 skill 键清理。
 * ⚠️ 与 `managedValues()` 的区别：它**不按前缀过滤** —— `_unmapped` 里的键正是
 *    「没被任何规则认领」的那一批，调用方自己决定要不要按前缀筛。
 */
export function listJsonCandidateKeys(): string[] {
  const out: string[] = [...managedValues().keys()];
  out.push(...listUnmappedKeys());
  return [...new Set(out)].sort();
}

/**
 * 删除顶层 `_unmapped` 里的给定键（第零章 P1：用户能在「🧹 遗留键」里核对并删除）。
 *
 * ⚠️ 为什么不走 `applyConfigChanges`：`_unmapped` 的键**刻意不命中** `hasManagedPrefix()`，
 *    也永远不在写入白名单里，走那条路会 100% 被判「不允许删除」。
 *    这里是独立的一次最小改动写盘（不备份：与「删除遗留键不备份」同口径）。
 * @returns 实际删除的键
 */
export function deleteUnmappedKeys(keys: readonly string[]): string[] {
  let raw: Record<string, unknown> | null;
  try {
    raw = readEnvJsonRaw();
  } catch {
    return [];                                  // 文件坏了：删除接口不该 500
  }
  if (!raw) return [];
  const u = raw._unmapped;
  if (!u || typeof u !== "object" || Array.isArray(u)) return [];
  const map = { ...(u as Record<string, unknown>) };
  const removed: string[] = [];
  for (const k of keys) {
    if (!(k in map)) continue;
    delete map[k];
    removed.push(k);
  }
  if (removed.length === 0) return [];
  if (Object.keys(map).length === 0) delete raw._unmapped;
  else raw._unmapped = map;
  const w = writeEnvJson(`${JSON.stringify(raw, null, 2)}\n`);
  return w.ok ? removed : [];
}

/* ============================================================
 * 序列化（稳定顺序 + 保留 _ 开头的顶层键 + tools 字典序 + 默认值瘦身）
 * ============================================================ */

/**
 * 瘦身：值为默认值的字段**不写进文件**（§9.1「值等于默认值即删键」在 JSON 下的等价实现）。
 * 只在 saveEnvJson() 内部调用（只有它知道默认值）。
 *
 * ⚠️ `llm[*].base/key/model` **不瘦身**：它们是必需项，瘦掉后用户在文件里看不见，
 *    排查「我的 key 到底设了没」无从下手；而写入默认占位值更危险。
 * ⚠️ [BR-4] `app.defaultLlm` **不参与 strip**：它不是扁平配置项，且必须落盘。
 *    若被 strip 掉，下次启动就会因「缺少 app.defaultLlm」拒绝启动。
 * ⚠️ [BR-5] 本函数只处理**已识别字段**。未知字段不在 `out.llm[*]` 的类型里，
 *    自然不会被删；它们的保留由 serializeEnvJson 的「按 name 取原对象做基底」负责。
 */
function pruneDefaults(obj: EnvJson, def: EnvJson): EnvJson {
  const out = structuredClone(obj);
  const strip = (o: Record<string, unknown>, d: Record<string, unknown>): void => {
    for (const [k, dv] of Object.entries(d)) if (o[k] === dv) delete o[k];
  };
  // app：只 strip port；defaultLlm 单独保护（见上）
  const keptDefault = out.app.defaultLlm;
  strip(out.app as unknown as Record<string, unknown>, def.app as unknown as Record<string, unknown>);
  out.app.defaultLlm = keptDefault;
  strip(out.log as unknown as Record<string, unknown>, def.log as unknown as Record<string, unknown>);
  strip(out.stab as unknown as Record<string, unknown>, def.stab as unknown as Record<string, unknown>);

  /**
   * [BR-4] llm 段瘦身对**所有组**生效（F2 原先只处理 llm[0]）。
   * ⚠️ 默认值基底仍恒取 `def.llm[0]`：`baseDefaults()` 的 llm 段是**静态默认值**，
   *    与「默认组是哪一组」无关。若改成「取 defaultLlm 对应组」，就会出现
   *    「默认值来源依赖配置内容」的循环，且默认组改名会悄悄改变瘦身结果。
   */
  const dg = def.llm[0];
  if (!dg) return out;
  for (const g of out.llm) {
    if (!g) continue;
    if (g.thinkingMode === dg.thinkingMode) delete g.thinkingMode;
    if (g.thinking === dg.thinking) delete g.thinking;
    if (g.reasoningEffort === dg.reasoningEffort) delete g.reasoningEffort;
  }
  return out;
}

/**
 * 序列化：稳定顺序 + 保留 `_` 开头的顶层键 + tools 字典序。
 * @param obj      已规整的强类型对象
 * @param raw      **原始文件对象**：用于捞出 `_comment` / `_migratedFrom` / 其它 `_xxx`
 * @param unmapped 迁移期兜底：未被识别的旧键（P1：顶层 `_unmapped`）
 * @param opts.prune true（默认）= 值等于默认值的字段不写进文件
 */
export function serializeEnvJson(
  obj: EnvJson,
  raw: Record<string, unknown> | null,
  unmapped?: Record<string, string>,
  opts: { prune?: boolean } = {},
): string {
  const body = opts.prune === false ? structuredClone(obj) : pruneDefaults(obj, baseDefaults());
  const out: Record<string, unknown> = {};

  // ① `_` 开头的顶层键原样保留（顺序按原文件）
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k.startsWith("_") && k !== "_unmapped") out[k] = v;
  }
  if (unmapped && Object.keys(unmapped).length > 0) out._unmapped = unmapped;

  // ② 系统项：固定顺序。只输出「实际有值」的字段（瘦身后被删掉的字段自然不出现）
  out.app = { ...(body.app as unknown as Record<string, unknown>) };
  /**
   * [BR-5 / D3] 保留 `llm[]` 元素的**未知字段**。
   *
   * 做法：以**原文件里同名组**的对象为基底合并，而不是从零构造。
   *   · 未知字段（用户手写的 `_comment` / 将来新增的键）随基底一起留下；
   *   · 已识别字段一律以 `body`（本次规整结果）为准覆盖；
   *   · 三个可选字段仍是「有值则写、无值则删」，保持既有瘦身行为。
   *
   * ⚠️ **必须按 name 对齐，严禁按下标对齐**：删组会让 `body.llm` 与 `raw.llm`
   *    顺序错位，按下标取基底会**把 A 组的未知字段写到 B 组上**（串组）。
   * ⚠️ 名字比较用 eqLlmName（BR-6，大小写不敏感），与 resolveLlm / findLlmIndex 同口径。
   *    `name` 本身**按 body 的原样写入**，不折叠 —— 折叠只用于比较，不用于存储。
   * ⚠️ raw 为 null（首次创建 env.json）时退化为从零构造。
   */
  const rawGroups: unknown[] = Array.isArray(raw?.llm) ? (raw!.llm as unknown[]) : [];
  out.llm = body.llm.map((g) => {
    const src = rawGroups.find(
      (x): x is Record<string, unknown> =>
        !!x && typeof x === "object" && !Array.isArray(x)
        && typeof (x as Record<string, unknown>).name === "string"
        && eqLlmName((x as Record<string, unknown>).name as string, g.name),
    );
    const e: Record<string, unknown> = src ? { ...src } : {};
    e.name = g.name;
    e.base = g.base;
    e.key = g.key;
    e.model = g.model;
    if (g.thinkingMode !== undefined) e.thinkingMode = g.thinkingMode; else delete e.thinkingMode;
    if (g.thinking !== undefined) e.thinking = g.thinking; else delete e.thinking;
    if (g.reasoningEffort !== undefined) e.reasoningEffort = g.reasoningEffort; else delete e.reasoningEffort;
    return e;
  });
  out.log = { ...(body.log as unknown as Record<string, unknown>) };
  out.stab = { ...(body.stab as unknown as Record<string, unknown>) };

  // ③ tools：字典序
  const sortedTools: Record<string, string> = {};
  for (const k of Object.keys(body.tools).sort()) sortedTools[k] = body.tools[k] as string;
  out.tools = sortedTools;

  // 2 空格缩进 + 结尾换行（避免「最后一行没有换行」造成的 diff 噪声）
  return `${JSON.stringify(out, null, 2)}\n`;
}

/* ============================================================
 * 原子写 + 备份
 * ============================================================ */

export interface WriteResult {
  ok: boolean;
  /** 原子 rename 失败、回退 copy 成功时置 true（前端可提示「已写入但非原子」） */
  degraded?: boolean;
  error?: string;
}

/** 生成 yyyyMMddHHmmss 本地时间戳 */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 原子写入 env.json：先写同目录 env.json.tmp → rename；失败回退 copyFile */
export function writeEnvJson(text: string): WriteResult {
  try {
    writeFileSync(envJsonTmp, text, "utf-8");
    try {
      renameSync(envJsonTmp, envJsonPath);
      invalidateManagedCache();               // 强制下次 managedValues() 重读
      return { ok: true };
    } catch {
      // Windows 下目标被占用等 → 回退为覆盖写（非原子，但保证内容完整）
      copyFileSync(envJsonTmp, envJsonPath);
      try { unlinkSync(envJsonTmp); } catch { /* 清理失败不致命 */ }
      invalidateManagedCache();
      return { ok: true, degraded: true };
    }
  } catch (e) {
    try { if (existsSync(envJsonTmp)) unlinkSync(envJsonTmp); } catch { /* ignore */ }
    return { ok: false, error: errText(e) };
  }
}

/** 备份当前 env.json；不存在时返回 null（跳过备份，AC-CFG-9） */
export function backupEnvJson(): string | null {
  if (!existsSync(envJsonPath)) return null;
  mkdirSync(backupDir, { recursive: true });
  const name = `envjson.${timestamp()}.bak`;
  copyFileSync(envJsonPath, join(backupDir, name));
  pruneBackups();
  return name;   // 相对 backupDir 的文件名，回执给前端
}

/**
 * 只保留最近 KEEP_BACKUPS 份。
 * ⚠️ 正则同时认 `env.<ts>.bak`（迁移前的历史备份）与 `envjson.<ts>.bak`（迁移后）：
 *    否则老备份永远删不掉，备份目录只增不减（第零章 P2）。
 *    时间戳为定长 14 位，字典序 = 时间序；两类混排仍按名字排序，够用（同秒内优先级无关）。
 */
function pruneBackups(): void {
  let files: string[];
  try {
    files = readdirSync(backupDir);
  } catch {
    return;                                   // 目录刚被删 / 不可读：不阻断保存
  }
  const list = files
    .filter((f) => /^env(json)?\.\d{14}\.bak$/.test(f))
    .sort();
  const excess = list.length - KEEP_BACKUPS;
  for (let i = 0; i < excess; i++) {
    const f = list[i];
    if (!f) continue;                         // noUncheckedIndexedAccess
    try { unlinkSync(join(backupDir, f)); } catch { /* 删除失败不阻断保存 */ }
  }
}

/** 保存入口：备份 → 序列化 → 原子写（方案 4.1 的 saveEnvJson） */
export function saveEnvJson(
  obj: EnvJson,
  opts: { skipBackup?: boolean; unmapped?: Record<string, string>; raw?: Record<string, unknown> | null } = {},
): WriteResult & { backupFile: string | null; created: boolean } {
  const existed = existsSync(envJsonPath);
  const backupFile = opts.skipBackup ? null : backupEnvJson();
  const raw = opts.raw !== undefined ? opts.raw : readEnvJsonRaw();
  const text = serializeEnvJson(obj, raw, opts.unmapped);
  const w = writeEnvJson(text);
  return { ...w, backupFile, created: !existed };
}

/* ============================================================
 * 一次性迁移：.env → env.json（迁移文档 4.2）
 * ============================================================ */

export interface MigrationResult {
  ok: true;
  /** 搬进 app/llm/log/stab 的系统项个数 */
  systemKeys: number;
  /** 搬进 tools 的托管键个数 */
  toolKeys: number;
  /** 进入顶层 _unmapped 的未识别键（启动日志逐条列出） */
  unmappedKeys: string[];
  /** 按 §9.2「删除，不迁移」丢弃的旧启用开关 */
  droppedKeys: string[];
  /** 原 .env 改名后的文件名（.env.bak-<ts>） */
  backupDotenv: string;
  /** 迁移时对已存在的 env.json 的备份（正常应为 null） */
  backupJson: string | null;
}

/**
 * §9.2「删除，不迁移」：只表达「旧工具是否可见」的 5 个开关。
 * ⚠️ 迁移后初始态一律关闭（§8.2），**不写任何等价键**；升级后需在配置页重新开启。
 * 来源：src/infra/migrate.ts 的 DROP_SWITCH_KEYS（原样搬运，语义不变）。
 */
export const LEGACY_DROP_KEYS: ReadonlySet<string> = new Set([
  "FILE_READ_ENABLED", "FILE_CREATE_ENABLED", "FILE_MODIFY_ENABLED",
  "INTERNET_ENABLED", "BROWSER_ENABLED",
]);

/**
 * 旧扁平键 → 托管键（原 migrate.ts 的 DOWN_SINK，49 项，原样搬运）。
 * ⚠️ 这张表是「升级不丢值」的唯一落点：新增/改名下沉项必须同步这里。
 */
export const LEGACY_DOWN_SINK: ReadonlyMap<string, string> = new Map<string, string>([
  // ── local 目录项（文件工具与 shell 共用）
  ["FILE_ROOT_DIR", "etc__tools__local__file_root_dir"],

  // ── local/fileRead 组项
  ["FILE_READ_DEFAULT_LINES", "TOOLSET__local__fileRead__default_lines"],

  // ── local/shell 组项（15 项）
  ["SHELL_PERMISSION", "TOOLSET__local__shell__permission"],
  ["SHELL_APPROVAL_WAIT_MS", "TOOLSET__local__shell__approval_wait_ms"],
  ["SHELL_SESSION_MEMORY_ENABLED", "TOOLSET__local__shell__session_memory_enabled"],
  ["SHELL_ALLOW_ALL_OPTION", "TOOLSET__local__shell__allow_all_option"],
  ["SHELL_DENY_COOLDOWN_MS", "TOOLSET__local__shell__deny_cooldown_ms"],
  ["SHELL_TYPE", "TOOLSET__local__shell__type"],
  ["SHELL_TIMEOUT_DEFAULT_MS", "TOOLSET__local__shell__timeout_default_ms"],
  ["SHELL_TIMEOUT_MAX_MS", "TOOLSET__local__shell__timeout_max_ms"],
  ["SHELL_OUTPUT_MAX_CHARS", "TOOLSET__local__shell__output_max_chars"],
  ["SHELL_MAX_COMMAND_CHARS", "TOOLSET__local__shell__max_command_chars"],
  ["SHELL_MAX_CONCURRENCY", "TOOLSET__local__shell__max_concurrency"],
  ["SHELL_UTF8_UNIFY", "TOOLSET__local__shell__utf8_unify"],
  ["SHELL_DENY_LIST", "TOOLSET__local__shell__deny_list"],
  ["SHELL_ALLOW_LIST", "TOOLSET__local__shell__allow_list"],
  ["SHELL_EXTRA_ENV_KEYS", "TOOLSET__local__shell__extra_env_keys"],

  // ── internet/web 组项（13 项）
  ["INTERNET_SEARCH_PROVIDER", "TOOLSET__internet__web__search_provider"],
  ["INTERNET_FETCH_PROVIDER", "TOOLSET__internet__web__fetch_provider"],
  ["INTERNET_DEEPSEEK_API_KEY", "TOOLSET__internet__web__deepseek_api_key"],
  ["INTERNET_DEEPSEEK_BASE_URL", "TOOLSET__internet__web__deepseek_base_url"],
  ["INTERNET_DEEPSEEK_SEARCH_PATH", "TOOLSET__internet__web__deepseek_search_path"],
  ["INTERNET_DEEPSEEK_FETCH_PATH", "TOOLSET__internet__web__deepseek_fetch_path"],
  ["INTERNET_DEFAULT_COUNT", "TOOLSET__internet__web__default_count"],
  ["INTERNET_TIMEOUT_MS", "TOOLSET__internet__web__timeout_ms"],
  ["INTERNET_FETCH_MAX_CHARS", "TOOLSET__internet__web__fetch_max_chars"],
  ["INTERNET_STORE_TTL_S", "TOOLSET__internet__web__store_ttl_s"],
  ["INTERNET_STORE_MAX_ITEMS_PER_SESSION", "TOOLSET__internet__web__store_max_items_per_session"],
  ["INTERNET_STORE_MAX_CHARS_PER_ITEM", "TOOLSET__internet__web__store_max_chars_per_item"],
  ["INTERNET_STORE_MAX_CHARS_TOTAL", "TOOLSET__internet__web__store_max_chars_total"],

  // ── internet/browser 组项（24 项，BROWSER_ENABLED 已废弃不在表内）
  ["BROWSER_EXECUTABLE_PATH", "TOOLSET__internet__browser__executable_path"],
  ["BROWSER_HEADLESS", "TOOLSET__internet__browser__headless"],
  ["BROWSER_FOREGROUND_ON_OPEN", "TOOLSET__internet__browser__foreground_on_open"],
  ["BROWSER_DEBUG_PORT", "TOOLSET__internet__browser__debug_port"],
  ["BROWSER_PROFILE_MODE", "TOOLSET__internet__browser__profile_mode"],
  ["BROWSER_PROFILE_DIR", "TOOLSET__internet__browser__profile_dir"],
  ["BROWSER_SESSION_TTL_S", "TOOLSET__internet__browser__session_ttl_s"],
  ["BROWSER_MAX_SESSIONS", "TOOLSET__internet__browser__max_sessions"],
  ["BROWSER_MAX_TABS", "TOOLSET__internet__browser__max_tabs"],
  ["BROWSER_ACTION_TIMEOUT_MS", "TOOLSET__internet__browser__action_timeout_ms"],
  ["BROWSER_NAV_TIMEOUT_MS", "TOOLSET__internet__browser__nav_timeout_ms"],
  ["BROWSER_STABLE_WINDOW_MS", "TOOLSET__internet__browser__stable_window_ms"],
  ["BROWSER_SNAPSHOT_MAX_ELEMENTS", "TOOLSET__internet__browser__snapshot_max_elements"],
  ["BROWSER_SNAPSHOT_MAX_CHARS", "TOOLSET__internet__browser__snapshot_max_chars"],
  ["BROWSER_EXTRACT_MAX_CHARS", "TOOLSET__internet__browser__extract_max_chars"],
  ["BROWSER_EXTRACT_MAX_ELEMENTS", "TOOLSET__internet__browser__extract_max_elements"],
  ["BROWSER_MAX_ACTIONS", "TOOLSET__internet__browser__max_actions"],
  ["BROWSER_DOMAIN_ALLOWLIST", "TOOLSET__internet__browser__domain_allowlist"],
  ["BROWSER_DOMAIN_BLOCKLIST", "TOOLSET__internet__browser__domain_blocklist"],
  ["BROWSER_BLOCK_PRIVATE_NET", "TOOLSET__internet__browser__block_private_net"],
  ["BROWSER_ALLOW_DOWNLOAD", "TOOLSET__internet__browser__allow_download"],
  ["BROWSER_ALLOW_UPLOAD", "TOOLSET__internet__browser__allow_upload"],
  ["BROWSER_DRAG_STEPS", "TOOLSET__internet__browser__drag_steps"],
  ["BROWSER_TYPE_DELAY_MS", "TOOLSET__internet__browser__type_delay_ms"],
]);

/**
 * 旧值是「逗号分隔文本」的键：先切数组再存成 JSON 文本（原 migrate.ts 的 COMMA_LIST_KEYS）。
 * `SHELL_ALLOW_LIST` 的旧默认值 `none` 表示「未启用」→ 空数组；空串同样视为空数组。
 */
export const LEGACY_COMMA_LIST: ReadonlySet<string> = new Set([
  "SHELL_DENY_LIST",
  "SHELL_ALLOW_LIST",
  "SHELL_EXTRA_ENV_KEYS",
  "BROWSER_DOMAIN_ALLOWLIST",
  "BROWSER_DOMAIN_BLOCKLIST",
]);

function normalizeLegacyValue(oldKey: string, v: string): string {
  if (!LEGACY_COMMA_LIST.has(oldKey)) return v;
  return JSON.stringify(
    v.split(",").map((s) => s.trim()).filter((s) => s !== "" && s.toLowerCase() !== "none"),
  );
}

/** .env 文本解析（与迁移前 configFile.parseEnvText 完全同款：trim + 跳注释 + 同名末次生效） */
function parseDotenvText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

/**
 * 把「.env 的键值对」装配成强类型的 EnvJson。
 *
 * 系统项文本 → 目标类型；非必需项非法/缺失一律回退默认值 + 告警（与 loadEnvJson 同口径），
 * 只有 llm[0] 的 base/key/model 才留给 assertRequired 判死。
 */
function buildEnvJsonFromDotenv(
  def: EnvJson,
  fileMap: Map<string, string>,
  managed: Record<string, string>,
): EnvJson {
  const obj = structuredClone(def);

  const text = (key: string): string | undefined => fileMap.get(key);
  const intOf = (key: string, fallback: number): number => {
    const raw = text(key);
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw.trim())) {
      warnOnce(key, "旧值不是合法整数，已回退默认值");
      return fallback;
    }
    return Number(raw.trim());
  };
  const boolOf = (key: string, fallback: boolean): boolean => {
    const raw = text(key);
    if (raw === undefined || raw === "") return fallback;
    const v = raw.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    warnOnce(key, "旧值不是 true / false，已回退默认值");
    return fallback;
  };

  // app
  if (text("APP_PORT") !== undefined) obj.app.port = intOf("APP_PORT", def.app.port);

  // llm[0]
  const g = obj.llm[0] as LlmGroup;
  const base = text("LLM_API_BASE");
  const key = text("LLM_API_KEY");
  const model = text("LLM_MODEL");
  if (base !== undefined) g.base = base;
  if (key !== undefined) g.key = key;
  if (model !== undefined) g.model = model;
  const tm = text("LLM_THINKING_MODE");
  g.thinkingMode = tm === undefined ? def.llm[0]?.thinkingMode : parseThinkingMode(tm);
  g.thinking = boolOf("LLM_THINKING", def.llm[0]?.thinking ?? true);
  const re = text("LLM_REASONING_EFFORT");
  if (re !== undefined && re !== "") g.reasoningEffort = re;
  g.name = "main";                              // 第零章 P3：不用保留名 default

  // log
  obj.log.enabled = boolOf("LLM_LOG_ENABLED", def.log.enabled);
  const logFile = text("LLM_LOG_FILE");
  if (logFile !== undefined && logFile !== "") obj.log.file = logFile;
  obj.log.maxRows = intOf("LLM_LOG_MAX_ROWS", def.log.maxRows);

  // stab
  obj.stab.maxToolRounds = intOf("MAX_TOOL_ROUNDS", def.stab.maxToolRounds);
  obj.stab.sseHeartbeatMs = intOf("SSE_HEARTBEAT_MS", def.stab.sseHeartbeatMs);
  obj.stab.toolResultMaxChars = intOf("TOOL_RESULT_MAX_CHARS", def.stab.toolResultMaxChars);

  // tools
  obj.tools = { ...managed };
  return obj;
}

/** 迁移是否已尝试过（热更路径也会调 loadEnvJson，不能每次保存都去检查 .env） */
let migrationAttempted = false;

/**
 * 迁移入口（启动链用：无条件尝试一次）。
 * @returns 真的迁移了返回回执；无需迁移 / 迁移失败返回 null
 */
export function migrateFromDotenv(): MigrationResult | null {
  const dotenvPath = resolve(PROJECT_ROOT, ".env");
  if (existsSync(envJsonPath)) return null;     // 幂等：env.json 已存在即跳过
  if (!existsSync(dotenvPath)) return null;     // 没有旧文件，无需迁移

  let fileMap: Map<string, string>;
  try {
    fileMap = parseDotenvText(readFileSync(dotenvPath, "utf-8"));
  } catch (e) {
    console.warn(`⚠️  [env-json] 读取 .env 失败（${errText(e)}），本次不迁移，进程将以原 .env 继续运行`);
    return null;
  }

  let def: EnvJson;
  try {
    def = baseDefaults();
  } catch (e) {
    console.warn(`⚠️  [env-json] 默认值未注册（${errText(e)}），本次不迁移`);
    return null;
  }

  // ②③④⑤ 分类：系统项 / 旧启用开关（丢弃） / 旧键下沉 / 托管键 / 未识别
  const tools: Record<string, string> = {};
  const unmapped: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of fileMap) {
    if (CONFIG_KEY_TO_JSON[k]) continue;                             // 系统项：由 build 处理
    if (LEGACY_DROP_KEYS.has(k)) { dropped.push(k); continue; }      // §9.2「删除，不迁移」
    const sink = LEGACY_DOWN_SINK.get(k);
    if (sink) {
      // 目标键已存在则以现有值为准，不覆盖（与原 migrate.ts 同口径）
      if (!(sink in tools) && !fileMap.has(sink)) tools[sink] = normalizeLegacyValue(k, v);
      continue;
    }
    if (isManagedKey(k)) { tools[k] = v; continue; }                 // 托管键原样搬
    unmapped[k] = v;                                                 // ⑤ 兜底
  }

  let obj: EnvJson;
  try {
    obj = buildEnvJsonFromDotenv(def, fileMap, tools);
  } catch (e) {
    console.warn(`⚠️  [env-json] .env 内容无法转换为 env.json（${errText(e)}），本次不迁移，进程将以原 .env 继续运行`);
    return null;
  }

  // ⑥ 写盘（不备份：env.json 此时还不存在，backupEnvJson 会返回 null）
  const text = serializeEnvJson(obj, null, unmapped);
  const w = writeEnvJson(text);
  if (!w.ok) {
    console.warn(`⚠️  [env-json] 写 env.json 失败（${w.error}），本次不迁移，进程将以原 .env 继续运行`);
    return null;
  }

  // ⑦ 改名备份 .env（**不删除**，便于回滚）
  const bak = `.env.bak-${timestamp()}`;
  try {
    renameSync(dotenvPath, resolve(PROJECT_ROOT, bak));
  } catch (e) {
    // 极端情况：env.json 已写成功但改名失败 → 两个文件并存。
    //   此时 env.json 优先（幂等条件满足），需明确告知用户手工清理 .env，避免「两份配置谁生效」的困惑。
    console.warn(
      `⚠️  [env-json] 已生成 env.json，但 .env 改名失败（${errText(e)}）：请手工把 .env 改名为 ${bak}。` +
      `   env.json 已生效，.env 不再被读取。`,
    );
  }

  // ⑧ 回执 + 日志（方案 3.4 步骤 7 的措辞）
  for (const k of Object.keys(unmapped)) {
    console.warn(`⚠️  [env-json] 未识别的旧键 ${k} 已保留在 env.json 的 _unmapped 中，请在配置页「🧹 遗留键」核对`);
  }
  return {
    ok: true,
    systemKeys: Object.keys(CONFIG_KEY_TO_JSON).filter((k) => fileMap.has(k)).length,
    toolKeys: Object.keys(tools).length,
    unmappedKeys: Object.keys(unmapped),
    droppedKeys: dropped,
    backupDotenv: bak,
    backupJson: null,
  };
}

/**
 * 「这是不是一个托管键」：**直接复用** `hasManagedPrefix()`（第七章第 5 条：托管前缀只认这一处）。
 * 不再自己维护一串前缀字面量 —— 那样 SKILL* 前缀漏一次就会「迁移时认、取值时认不到」。
 */
function isManagedKey(key: string): boolean {
  return hasManagedPrefix(key);
}

/**
 * 只在**首次**调用时尝试迁移（幂等；后续调用直接返回 null）。
 *
 * 为什么要有这一层（附录 A-9）：热更路径（reloadEnvExcluding）也会调 loadEnvJson()，
 * 若无条件尝试迁移，每次保存都会去 stat 一遍 .env。
 */
export function maybeMigrateOnce(): MigrationResult | null {
  if (migrationAttempted) return null;
  migrationAttempted = true;
  try {
    return migrateFromDotenv();
  } catch (e) {
    console.warn(`⚠️  [env-json] 迁移异常（${errText(e)}），本次不迁移`);
    return null;
  }
}
