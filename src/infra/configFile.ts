/**
 * src/infra/configFile.ts
 * 配置项**元数据 + 校验 + 掩码 + GET/PUT 语义**（配置页专用，需求 §4.5）。
 *
 * 设计要点（迁移后，见 docs/ENV-JSON-代码修改文档.md 4.6）：
 * 1. 文件读写**全部**下沉到 src/infra/envJson.ts（JSON 序列化 / 原子写 / 备份）；
 *    本文件只负责「键名 ↔ JSON 路径」的业务语义与校验。
 * 2. 不再有「逐键替换、保留注释与行序」——JSON 整体重写（方案 2.3 C2）；
 *    用户的备注请用 `_` 开头的顶层键承载（方案 3.5）。
 * 3. 独立于 etc/tools/local 文件沙箱，不受工具开关影响（需求 §4.7 S5）。
 *
 * ⚠️ 工具配置**不再**在这里声明：类型、默认值、范围、说明的唯一来源是 etc/tools/** 的
 *    `settings` 声明（规范 §3.2 默认值单一来源 / §9.2 存量分流）。本文件只保留系统项，
 *    工具键通过参数注入的白名单与声明校验（§9.1 写入白名单 = 系统项 ∪ 本次扫描注册键）。
 */
import { existsSync } from "fs";
import {
  CONFIG_KEY_TO_JSON, envJsonFilePath, envJsonBackupDir, loadEnvJson,
  registerEnvJsonDefaults, readEnvJsonRaw, writeEnvJson,
  backupEnvJson, envJsonDefaultsOrNull,
  type EnvJson, type FieldSpec,
} from "./envJson";
import { parseThinkingMode } from "./thinkingMode";
import { formatManagedValue } from "@/tools/paths";

/**
 * 兼容别名：路由层原来读 `ENV_PATH` / `BACKUP_DIR`（GET /api/config 的 envPath / backupDir）。
 * ⚠️ 迁移后改为函数 `envPath()` / `backupDirPath()`：只有这样才能让测试钩子
 *    __setEnvJsonPathForTest 生效，同时让 routes/config.ts 的响应字段名保持不变。
 */
export function envPath(): string { return envJsonFilePath(); }
export function backupDirPath(): string { return envJsonBackupDir(); }

/**
 * 配置页容错读取：**永不抛错**，读不到就回落到默认值。
 *
 * 为什么必须有（附录 A-10）：配置页是用户修配置的唯一入口。若 env.json 缺失/损坏时
 * GET /api/config 直接 500，用户就失去了自救途径。启动路径仍用严格版（loadEnvJson）。
 */
export function loadEnvJsonSafely(): EnvJson {
  try {
    return loadEnvJson();
  } catch (e) {
    const def = envJsonDefaultsOrNull();
    if (def) return def;
    throw e;                                  // 连默认值都没注册：这是代码问题，不该被吞掉
  }
}

// ============================================
// 配置项清单（白名单 + 校验元数据）
// ============================================

export type ConfigType = "int" | "bool" | "enum" | "string" | "secret";
/** 系统配置分组（工具配置不再走这里，见规范 §11 的工具区） */
export type ConfigGroup = "app" | "llm" | "log" | "stab";

export interface ConfigKeyMeta {
  key: string;
  group: ConfigGroup;
  type: ConfigType;
  /** 中文标签（前端表单显示） */
  label: string;
  /** 文件缺失该键时的回填值（默认值单一来源 = 这里的 defaultValue） */
  defaultValue: string;
  secret?: boolean;
  /**
   * [需求域 R / R-17、§9.2] 必需项：不允许清空（界面不显示按钮，接口收到清空须拒绝且不改写文件）。
   */
  required?: boolean;
  /** [R-04] 允许写空值：仅用于「留空 = 未配置」这类语义。 */
  allowEmpty?: boolean;
  enumValues?: readonly string[];
  /** 枚举项的**中文显示名**（值仍写原始 token / 仍走 enumValues 校验） */
  enumLabels?: Record<string, string>;
  min?: number;
  max?: number;
  /** 分组标题（与 env.example.json 的分组一致） */
  groupTitle: string;
  /** 说明文字（迁到 docs/配置说明.md，此处保留一行摘要） */
  desc: string;
}

/**
 * 系统项白名单（12 项）。
 * 已下沉到工具域声明的项（文件工具 / 命令执行 / 互联网 / 浏览器）**全部移出本表**：
 * 它们的类型、默认值、范围、说明的唯一来源是 etc/tools/** 的声明（规范 §3.2 / §9.2）。
 *
 * ⚠️ `TOOL_RESULT_MAX_CHARS` 仍是系统项，但沿用「不进配置页、手工维护」，
 *    故不在本表内 → 经配置接口**不可写**（只能手工改 env.json 后重启）。
 *    若日后要让它可写，必须**同时**做三件事（进 CONFIG_KEYS / 进页面 / 确认热更路径），
 *    否则会出现「接口能写、页面看不到、热更不生效」的三方不一致。
 */
export const CONFIG_KEYS: readonly ConfigKeyMeta[] = [
  {
    key: "APP_PORT", group: "app", groupTitle: "应用配置", type: "int",
    label: "服务端口", defaultValue: "3001", min: 1, max: 65535,
    desc: "服务监听端口。修改后必须重启服务才生效。",
  },

  {
    key: "LLM_API_BASE", group: "llm", groupTitle: "LLM 配置", type: "string",
    label: "API 地址", defaultValue: "https://api.deepseek.com",
    desc: "OpenAI 兼容接口的基础地址。",
  },
  {
    key: "LLM_API_KEY", group: "llm", groupTitle: "LLM 配置", type: "secret",
    label: "API 密钥", defaultValue: "sk-apikey", secret: true, required: true,
    desc: "你的 API 密钥。页面不回显明文，留空表示不修改。",
  },
  {
    key: "LLM_MODEL", group: "llm", groupTitle: "LLM 配置", type: "string",
    label: "模型名称", defaultValue: "deepseek-flash",
    desc: "使用的模型名称。",
  },
  {
    key: "LLM_THINKING_MODE", group: "llm", groupTitle: "LLM 配置", type: "enum",
    label: "思考字段下发方式", defaultValue: "none",
    enumValues: ["none", "effort", "thinking", "both"],
    desc: "控制请求体携带哪些思考相关字段：none=均不下发（默认，兼容非 DeepSeek 服务商）/ effort=仅下发推理强度 / thinking=仅下发思考开关 / both=两者都下发。下面两项只提供取值。",
  },
  {
    key: "LLM_THINKING", group: "llm", groupTitle: "LLM 配置", type: "bool",
    label: "思考开关取值", defaultValue: "true",
    desc: "仅提供思考开关字段的取值（true=开启，false=关闭）；是否下发由「思考字段下发方式」决定。",
  },
  {
    key: "LLM_REASONING_EFFORT", group: "llm", groupTitle: "LLM 配置", type: "enum",
    label: "推理强度取值", defaultValue: "high", enumValues: ["low", "high", "max"],
    desc: "仅提供推理强度字段的取值；是否下发由「思考字段下发方式」决定。",
  },

  {
    key: "LLM_LOG_ENABLED", group: "log", groupTitle: "LLM 对话日志配置", type: "bool",
    label: "日志开关", defaultValue: "false",
    desc: "记录与 LLM 的对话日志。默认关闭。",
  },
  {
    key: "LLM_LOG_FILE", group: "log", groupTitle: "LLM 对话日志配置", type: "string",
    label: "日志文件路径", defaultValue: "data/llm_logs.jsonl",
    desc: "JSONL 文件路径（相对启动工作目录）。路径不做限制。",
  },
  {
    key: "LLM_LOG_MAX_ROWS", group: "log", groupTitle: "LLM 对话日志配置", type: "int",
    label: "日志条数上限", defaultValue: "2000", min: 1,
    desc: "超出后自动清理最旧记录。",
  },

  {
    key: "MAX_TOOL_ROUNDS", group: "stab", groupTitle: "复杂问题稳定性配置", type: "int",
    label: "工具轮次上限", defaultValue: "8", min: 1,
    desc: "工具调用轮次上限，超出则截断并提示。",
  },
  {
    key: "SSE_HEARTBEAT_MS", group: "stab", groupTitle: "复杂问题稳定性配置", type: "int",
    label: "SSE 心跳间隔（毫秒）", defaultValue: "10000", min: 1000, max: 254999,
    desc: "必须显著小于 Bun.serve 的 idleTimeout（255 秒），切勿大于 254999。",
  },
] as const;

/** 键名白名单集合（系统项；PUT 的写入白名单 = 本集合 ∪ 本次扫描注册键） */
export const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS.map((m) => m.key));

/** 分组顺序（前端渲染顺序） */
export const CONFIG_GROUPS: readonly ConfigGroup[] = ["app", "llm", "log", "stab"];

/**
 * [需求域 T / T-06] 工具结果总长度上限的**唯一**默认值。
 *
 * 为什么定义在这里：它不在 CONFIG_KEYS（方案 2.1「不进配置页」），但 EnvConfig 与
 * envJson 的默认值注册都需要它；迁移前 env.ts 里重复写了三处 `|| 32000`，本次收口。
 */
export const TOOL_RESULT_MAX_CHARS_DEFAULT = 32000;

/** 取某个系统项的默认值文本（默认值单一来源） */
function defaultOf(key: string): string {
  const meta = CONFIG_KEYS.find((m) => m.key === key);
  if (!meta) throw new Error(`ERR_CONFIG_META: ${key} 不在 CONFIG_KEYS 中，无法取得默认值`);
  return meta.defaultValue;
}

/**
 * 把 CONFIG_KEYS 的默认值注册给 envJson（envJson 不 import 本文件，避免成环）。
 * ⚠️ 必须在**任何** loadEnvJson() / managedValues() 调用之前执行 —— 放在模块顶层即可：
 *    env.ts 与 routes 都会先完成 configFile.ts 的 import 求值。
 * 默认值来源唯一：CONFIG_KEYS[].defaultValue（方案 2.2-1）；此处只做「字符串 → 强类型」搬运。
 */
registerEnvJsonDefaults({
  // [BR-4] defaultLlm 的**注册值只是占位**：loadEnvJson 显式忽略它（缺失即保留空串，
  //   由 assertRequired 抛错拒绝启动，D-1 选 (a)）。填 "main" 只为满足 EnvJson 类型。
  app: { port: Number(defaultOf("APP_PORT")), defaultLlm: "main" },
  llm: [{
    name: "main",                                    // 第零章 P3：不用保留名 default
    base: defaultOf("LLM_API_BASE"),
    key: defaultOf("LLM_API_KEY"),
    model: defaultOf("LLM_MODEL"),
    thinkingMode: parseThinkingMode(defaultOf("LLM_THINKING_MODE")),
    thinking: defaultOf("LLM_THINKING") === "true",
    reasoningEffort: defaultOf("LLM_REASONING_EFFORT"),
  }],
  log: {
    enabled: defaultOf("LLM_LOG_ENABLED") === "true",
    file: defaultOf("LLM_LOG_FILE"),
    maxRows: Number(defaultOf("LLM_LOG_MAX_ROWS")),
  },
  stab: {
    maxToolRounds: Number(defaultOf("MAX_TOOL_ROUNDS")),
    sseHeartbeatMs: Number(defaultOf("SSE_HEARTBEAT_MS")),
    toolResultMaxChars: TOOL_RESULT_MAX_CHARS_DEFAULT,
  },
  tools: {},
});

// ============================================
// 校验
// ============================================

/**
 * 校验单个值。通过返回 null，失败返回可读原因（中文，前端直接展示）。
 * 注意：不含「留空即不修改」的 secret 语义——该语义由 routes/config.ts 在进入本函数前处理。
 */
export function validateValue(meta: ConfigKeyMeta, raw: string): string | null {
  const v = String(raw ?? "");
  // 需求 §4.4.2 约束 3：禁止换行（防「一行值注入一个新键」）
  if (/[\r\n]/.test(v)) return "值不能包含换行符";

  const t = v.trim();
  switch (meta.type) {
    case "int": {
      if (!/^\d+$/.test(t)) return "必须为纯整数（不接受 1e3 / 0x10 / 负数）";
      const n = parseInt(t, 10);
      if (meta.min !== undefined && n < meta.min) return `不能小于 ${meta.min}`;
      if (meta.max !== undefined && n > meta.max) return `不能大于 ${meta.max}`;
      return null;
    }
    case "bool":
      return t === "true" || t === "false" ? null : "只能为 true 或 false";
    case "enum":
      return meta.enumValues?.includes(t) ? null : `只能为 ${meta.enumValues?.join(" / ")}`;
    case "secret":
      return t === "" ? "不能为空" : null;
    default:
      if (t === "") return meta.allowEmpty ? null : "不能为空";
      return null;
  }
}

// ============================================
// 系统项 JSON 路径读写（保持 CONFIG_KEY_TO_JSON 是唯一路径知识）
// ============================================

/** 取 spec 指向的分组对象（llm 取 [0]） */
function boxOf(raw: Record<string, unknown>, spec: FieldSpec): Record<string, unknown> {
  if (spec.group === "llm") {
    const arr = raw.llm;
    const first = Array.isArray(arr) ? arr[0] : undefined;
    if (!first || typeof first !== "object" || Array.isArray(first)) {
      const created: Record<string, unknown> = {};
      if (!Array.isArray(arr)) raw.llm = [created];
      else (raw.llm as unknown[])[0] = created;
      return created;
    }
    return first as Record<string, unknown>;
  }
  const g = raw[spec.group];
  if (!g || typeof g !== "object" || Array.isArray(g)) {
    const created: Record<string, unknown> = {};
    raw[spec.group] = created;
    return created;
  }
  return g as Record<string, unknown>;
}

/** 从原始对象里读出某个系统项的值（未设置返回 undefined） */
function readSystemFromRaw(raw: Record<string, unknown> | null, spec: FieldSpec): unknown {
  if (!raw) return undefined;
  if (spec.group === "llm") {
    const arr = raw.llm;
    const first = Array.isArray(arr) ? arr[0] : undefined;
    if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
    return (first as Record<string, unknown>)[spec.field];
  }
  const g = raw[spec.group];
  if (!g || typeof g !== "object" || Array.isArray(g)) return undefined;
  return (g as Record<string, unknown>)[spec.field];
}

/**
 * 把「持久化文本」写进原始 JSON 对象的对应路径（**最小改动**，不重排、不补默认值）。
 *
 * ⚠️ 为什么不经过 loadEnvJson() 再序列化（附录 A-2）：那样会把 13 个缺失项全部回填
 *    默认值写进文件，直接违反「值等于默认值即不落盘」（方案 2.2-1）。
 */
export function writeSystemIntoRaw(raw: Record<string, unknown>, key: string, text: string): boolean {
  const spec = CONFIG_KEY_TO_JSON[key];
  if (!spec) return false;
  const meta = CONFIG_KEYS.find((m) => m.key === key);
  const box = boxOf(raw, spec);
  const t = String(text ?? "").trim();
  switch (meta?.type) {
    case "int":
      box[spec.field] = parseInt(t, 10);
      return true;
    case "bool":
      box[spec.field] = t === "true";
      return true;
    case "enum":
      box[spec.field] = spec.group === "llm" && spec.field === "thinkingMode" ? parseThinkingMode(t) : t;
      return true;
    default:
      box[spec.field] = t;
      return true;
  }
}

/**
 * 删除原始 JSON 对象里的某个系统项路径（「恢复默认」= 让该字段从文件里消失）。
 * 删完后若分组对象为空，整组一起去掉 —— 否则会留下 `"log": {}` 这种空壳。
 */
export function deleteSystemPath(raw: Record<string, unknown>, key: string): boolean {
  const spec = CONFIG_KEY_TO_JSON[key];
  if (!spec) return false;
  if (spec.group === "llm") {
    const arr = raw.llm;
    const first = Array.isArray(arr) ? arr[0] : undefined;
    if (!first || typeof first !== "object" || Array.isArray(first)) return false;
    delete (first as Record<string, unknown>)[spec.field];
    return true;
  }
  const g = raw[spec.group];
  if (!g || typeof g !== "object" || Array.isArray(g)) return false;
  const box = g as Record<string, unknown>;
  delete box[spec.field];
  if (Object.keys(box).length === 0) delete raw[spec.group];
  return true;
}

/**
 * 把系统项从 env.json 里取出来，转成「持久化文本」的映射（key → 文本）。
 *
 * 与迁移前 parseEnvText 的关系：那个返回「文件里写了什么」，这个返回「JSON 里的值写成文本后是什么」。
 * 唯一语义差异（必须知道）：**值等于默认值的字段在 JSON 里根本不存在**（「读默认即删键」）→
 *   这里用 `?? meta.defaultValue` 回填，与 AC-CFG-9 一致。
 */
export function readSystemValues(): Map<string, string> {
  let raw: Record<string, unknown> | null = null;
  try {
    raw = readEnvJsonRaw();
  } catch (e) {
    // 配置页必须能打开（否则用户没法修）：读失败时全部按默认值展示，原因交给路由层提示。
    console.warn(`⚠️  [config] 读取 env.json 失败，配置页将按默认值展示：${String(e)}`);
  }
  const m = new Map<string, string>();
  for (const meta of CONFIG_KEYS) {
    const spec = CONFIG_KEY_TO_JSON[meta.key];
    const v = spec ? readSystemFromRaw(raw, spec) : undefined;
    m.set(meta.key, v === undefined || v === null ? meta.defaultValue : formatManagedValue(v as never));
  }
  return m;
}

// ============================================
// 掩码与 GET 数据装配
// ============================================

export interface ConfigItem {
  key: string;
  group: ConfigGroup;
  groupTitle: string;
  type: ConfigType;
  label: string;
  desc: string;
  /** 文件中的原始字符串（未做类型转换）；secret 键恒为 null */
  value: string | null;
  secret: boolean;
  /** [R-17 / §9.2] 必需项不显示「清空」按钮（UI 依据）；未声明视为非必需 */
  required?: boolean;
  /** [R-04] 该项允许留空（前端应放行空值提交） */
  allowEmpty?: boolean;
  /** secret 键：文件中是否已有非空值 */
  hasValue?: boolean;
  /** secret 键：掩码，如 sk-****cdef */
  mask?: string;
  enumValues?: readonly string[];
  enumLabels?: Record<string, string>;
  min?: number;
  max?: number;
  /** 被系统环境变量遮蔽（AC-CFG-8）—— 迁移后恒 false */
  shadowed: boolean;
  /** 该键改动后是否需要重启 */
  restartRequired: boolean;
  /** 阶段 B：运行时实际生效值（供「文件值 vs 生效值」对照） */
  effective?: unknown;
}

/** 掩码规则：长度 ≤8 → "****"；否则前 3 + **** + 后 4 */
export function maskSecret(value: string): string {
  const v = String(value ?? "");
  if (v === "") return "****";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 3)}****${v.slice(-4)}`;
}

/**
 * 装配 GET /api/config 的系统项 items。
 * @param restartOnly  需重启的键集合
 * @param shadowed     被系统环境变量遮蔽的键集合 —— **迁移后恒为空集**（第零章 P7 / 方案 2.3 C1）
 *                     ⚠️ 参数保留不删：删了 routes/config.ts 的调用点要跟着改（方案 3.7「接口契约不动」）
 * @param effectiveOf  可选：运行时实际生效值（阶段 B 回填）
 */
export function buildConfigItems(
  restartOnly: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
  effectiveOf?: (key: string) => unknown,
): ConfigItem[] {
  const fileMap = readSystemValues();
  void shadowed;   // 迁移后恒为空集，保留参数只为不改调用方

  return CONFIG_KEYS.map((meta) => {
    const raw = fileMap.get(meta.key) ?? meta.defaultValue;   // 缺失 → 回填默认值（AC-CFG-9）
    const base: ConfigItem = {
      key: meta.key, group: meta.group, groupTitle: meta.groupTitle,
      type: meta.type, label: meta.label, desc: meta.desc,
      value: raw, secret: !!meta.secret, required: meta.required === true,
      allowEmpty: meta.allowEmpty === true,
      enumValues: meta.enumValues, enumLabels: meta.enumLabels, min: meta.min, max: meta.max,
      // ⚠️ 恒 false：JSON 不经过 Bun.env，遮蔽概念消失（方案 2.3 C1）。
      //    保留字段是为了让前端 items[].shadowed 的形状不变（方案 3.7「零改动」）。
      shadowed: false,
      restartRequired: restartOnly.has(meta.key),
    };
    if (meta.secret) {
      base.value = null;                    // 不回显明文（S1）
      base.hasValue = raw !== "";
      base.mask = maskSecret(raw);
    }
    if (effectiveOf) base.effective = effectiveOf(meta.key);
    return base;
  });
}

// ============================================
// 保存总入口
// ============================================

export interface ApplyRequest {
  /** 需要写入的键值（系统项 + 已校验的工具键） */
  changes?: Record<string, string>;
  /** 系统密文项清空（沿用 R-17：写空串，不是删行） */
  clearKeys?: readonly string[];
  /** 需要删除的键（恢复默认 / 遗留键清理） */
  deleteKeys?: readonly string[];
  /** 本次扫描注册的键（**写入**白名单的并集，§9.1） */
  allowedKeys?: ReadonlySet<string>;
  /**
   * **删除**侧的额外白名单（旧键 / 遗留键）。缺省 = 空集。
   *
   * ⚠️ 为什么必须与 `allowedKeys` 分开（R-24）：**「可写」与「可删」是两个不同的集合**。
   *   · 遗留键接口要删的是**未被本次扫描注册的托管键**——按定义不在 `allowedKeys` 里。
   *   用一个白名单同时校验写入与删除，会让该功能 100% 失败（落入 unknown → `ok:false`）。
   */
  allowDeleteKeys?: ReadonlySet<string>;
  /** 不备份（遗留键独立接口：§10.2「删除不备份」） */
  skipBackup?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  /** 实际写入的键 */
  written: string[];
  /** 实际删除的键（= 恢复默认 / 遗留键清理） */
  deleted: string[];
  backupFile: string | null;
  envCreated: boolean;
  degraded?: boolean;
  /** 校验失败：[键, 原因] 列表（HTTP 400 用） */
  invalid?: Array<{ key: string; reason: string }>;
  error?: string;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 应用一批改动：白名单 → 键名硬校验 → 写删互斥 → 密文清空约束 → 系统值校验 → 备份 → 写盘
 *
 * [R-24] 写入与删除**分别**校验白名单（见 ApplyRequest.allowDeleteKeys 的注释）。
 * [A-2] 写盘以**原始 JSON 对象**为基准做最小改动：不重排、不补默认值。
 */
export function applyConfigChanges(req: ApplyRequest): ApplyResult {
  const changes = req.changes ?? {};
  const clearKeys = req.clearKeys ?? [];
  const deleteKeys = req.deleteKeys ?? [];
  const written = [...new Set([...Object.keys(changes), ...clearKeys])];
  const deleted = [...new Set(deleteKeys)];
  const fail = (invalid: Array<{ key: string; reason: string }>): ApplyResult =>
    ({ ok: false, written: [], deleted: [], backupFile: null, envCreated: false, invalid });

  // ① 白名单（§9.1）：写入与删除**分别**校验（R-24，切勿合并成一个集合）
  //    写入 = 系统项 ∪ 本次扫描注册键
  const writeAllowed = new Set<string>(CONFIG_KEY_SET);
  if (req.allowedKeys) for (const k of req.allowedKeys) writeAllowed.add(k);
  //    删除 = 写入白名单 ∪ 调用方显式声明的可删键（旧键 / 遗留键）
  const deleteAllowed = new Set<string>(writeAllowed);
  if (req.allowDeleteKeys) for (const k of req.allowDeleteKeys) deleteAllowed.add(k);

  const unknownWrites = written.filter((k) => !writeAllowed.has(k));
  const unknownDeletes = deleted.filter((k) => !deleteAllowed.has(k));
  if (unknownWrites.length > 0) {
    return fail(unknownWrites.map((k) => ({
      key: k, reason: "未知配置项（不在「系统项 ∪ 本次扫描注册键」之内）",
    })));
  }
  if (unknownDeletes.length > 0) {
    return fail(unknownDeletes.map((k) => ({
      key: k, reason: "不允许删除该键（不在「系统项 ∪ 注册键 ∪ 调用方声明的可删键」之内）",
    })));
  }

  // ② 键名硬校验（防「值里夹换行拼出一个新键」/ 非法标识符）：§9.1
  const badKey = [...written, ...deleted].filter((k) => !ENV_KEY_RE.test(k));
  if (badKey.length > 0) {
    return fail([...new Set(badKey)].map((k) => ({
      key: k, reason: "键名不符合托管键格式（^[A-Za-z_][A-Za-z0-9_]*$）",
    })));
  }

  // ③ 同一键不得同时「写」与「删」
  const both = written.filter((k) => deleted.includes(k));
  if (both.length > 0) {
    return fail([...new Set(both)].map((k) => ({ key: k, reason: "同一项不得同时出现在写入与删除中" })));
  }

  // ④ 系统密文清空的既有约束（R-17：只允许非必需密文项）
  const clearInvalid: Array<{ key: string; reason: string }> = [];
  for (const k of new Set(clearKeys)) {
    const meta = CONFIG_KEYS.find((m) => m.key === k);
    if (!meta) continue;                       // 工具键不会走 clear（工具键用 changes / deleteKeys）
    if (!meta.secret) { clearInvalid.push({ key: k, reason: "仅密文项支持清空（非密文项请直接改值）" }); continue; }
    if (meta.required) {
      clearInvalid.push({ key: k, reason: "必需项不支持清空：写空后热更会判定缺失并导致进程退出，请填入新的有效值" });
    }
  }
  if (clearInvalid.length > 0) return fail(clearInvalid);

  // ⑤ 系统项取值校验（工具键已由调用方用声明校验过，读取端还会再校验一次）
  const invalid: Array<{ key: string; reason: string }> = [];
  for (const [k, v] of Object.entries(changes)) {
    const meta = CONFIG_KEYS.find((m) => m.key === k);
    if (!meta) continue;
    const reason = validateValue(meta, v);
    if (reason) invalid.push({ key: k, reason });
  }
  if (invalid.length > 0) return fail(invalid);

  // ⑥ 读现状 + 备份（env.json 不存在 → backupEnvJson() 内部返回 null，AC-CFG-9）
  const existedBefore = existsSync(envPath());
  const backupFile = req.skipBackup ? null : backupEnvJson();

  // ⑦ 在**原始对象**上做最小改动（不经过强类型规整，避免把默认值全写进文件）
  let raw: Record<string, unknown>;
  try {
    raw = readEnvJsonRaw() ?? {};
  } catch (e) {
    // 现状文件本身坏了：不让保存把它「顺手修好」，明确报错让用户先修文件
    return { ok: false, written: [], deleted: [], backupFile: null, envCreated: false, error: `env.json 当前不可解析：${String(e)}` };
  }
  if (!Array.isArray(raw.llm) || raw.llm.length === 0) raw.llm = [{ name: "main", base: "", key: "", model: "" }];

  const writeMap: Record<string, string> = { ...changes };
  for (const k of clearKeys) writeMap[k] = "";

  const systemDeleted: string[] = [];
  const managedChanges: Record<string, string> = {};
  for (const [k, v] of Object.entries(writeMap)) {
    if (CONFIG_KEY_TO_JSON[k]) { writeSystemIntoRaw(raw, k, v); continue; }
    managedChanges[k] = formatManagedValue(v);           // 非系统项 → 托管键（值一律字符串）
  }
  for (const k of deleted) {
    if (k in writeMap) continue;                          // ③ 已保证二者不并存，这里只防御
    if (CONFIG_KEY_TO_JSON[k]) { deleteSystemPath(raw, k); systemDeleted.push(k); continue; }
  }

  //   ⑦-b 托管键：写 = 覆盖；删 = 从 tools 移除
  const rawTools = raw.tools;
  const tools: Record<string, unknown> =
    rawTools && typeof rawTools === "object" && !Array.isArray(rawTools)
      ? { ...(rawTools as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(managedChanges)) tools[k] = v;
  for (const k of deleted) if (!CONFIG_KEY_TO_JSON[k]) delete tools[k];
  raw.tools = tools;

  //   ⑦-c 顶层 _unmapped：保留（不在这里改动；删除未识别键走 deleteUnmappedKeys，见 routes/config.ts）

  //   ⑦-d 序列化 + 原子写
  //     ⚠️ 这里**不**用 serializeEnvJson：它会重排整棵树并按默认值瘦身，
  //        而配置页保存的语义是「在用户当前文件上做最小改动」。
  const w = writeEnvJson(`${JSON.stringify(raw, null, 2)}\n`);
  if (!w.ok) {
    return { ok: false, written: [], deleted: [], backupFile: null, envCreated: false, error: w.error };
  }

  return {
    ok: true,
    written,
    deleted: [...new Set([...deleted, ...systemDeleted])],
    backupFile,
    envCreated: !existedBefore,
    degraded: w.degraded,
  };
}

/** 删除顶层 `_unmapped` 里的遗留键（转出 envJson 的实现，路由层只认这里） */
export { deleteUnmappedKeys } from "./envJson";
