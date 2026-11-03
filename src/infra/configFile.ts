/**
 * src/infra/configFile.ts
 * .env 配置文件的读写 / 备份 / 校验 / 掩码（配置页专用，需求 §4.5）
 *
 * 设计要点：
 * 1. 路径基准与 src/infra/env.ts 完全一致（import.meta.dir 而非 process.cwd()）；
 * 2. 逐键替换 / 逐键删除、保留注释与行序，不重生成文件；
 * 3. 原子写（tmp + rename），失败回退 copy；
 * 4. 独立于 etc/tools/local 文件沙箱，不受工具开关影响（需求 §4.7 S5）。
 *
 * ⚠️ 工具配置**不再**在这里声明：类型、默认值、范围、说明的唯一来源是 etc/tools/** 的
 *    `settings` 声明（规范 §3.2 默认值单一来源 / §9.2 存量分流）。本文件只保留系统项，
 *    工具键通过参数注入的白名单与声明校验（§9.1 写入白名单 = 系统项 ∪ 本次扫描注册键）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { resolve, join } from "path";

/** 项目根目录：<项目根>/src/infra/ 上溯两级 */
const PROJECT_ROOT = resolve(import.meta.dir, "../..");

/** .env 绝对路径（与 src/infra/env.ts 的 loadDotenv 保持一致，勿改基准） */
export const ENV_PATH = resolve(PROJECT_ROOT, ".env");

/** 备份目录：<项目根>/data/envbk（data/ 已被 .gitignore 忽略） */
export const BACKUP_DIR = resolve(PROJECT_ROOT, "data/envbk");

/** 备份保留份数（需求 §4.5.3 / AC-CFG-6） */
const KEEP_BACKUPS = 20;

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
  /** 枚举项的**中文显示名**（值仍写 .env / 仍走 enumValues 校验） */
  enumLabels?: Record<string, string>;
  min?: number;
  max?: number;
  /** 分组标题（与 .env.example 注释块一致） */
  groupTitle: string;
  /** 说明文字（取自 .env.example 注释） */
  desc: string;
}

/**
 * 系统项白名单（12 项）。
 * 已下沉到工具域声明的项（文件工具 / 命令执行 / 互联网 / 浏览器）**全部移出本表**：
 * 它们的类型、默认值、范围、说明的唯一来源是 etc/tools/** 的声明（规范 §3.2 / §9.2）。
 *
 * ⚠️ `TOOL_RESULT_MAX_CHARS` 仍是系统项，但沿用「不进配置页、手工维护」，
 *    故不在本表内 → 经配置接口**不可写**（只能手工改 .env 后重启）。
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
// .env 逐键替换（保留注释与行序）
// ============================================

export interface EnvFileSnapshot {
  exists: boolean;
  /** 文件全文（不存在时为空串） */
  text: string;
  /** 文件使用的换行符（写回时沿用，避免整文件行尾被改写） */
  eol: "\n" | "\r\n";
}

/** 读取 .env 快照（不存在视为空文件，不抛错） */
export function readEnvFile(): EnvFileSnapshot {
  if (!existsSync(ENV_PATH)) return { exists: false, text: "", eol: "\n" };
  const text = readFileSync(ENV_PATH, "utf-8");
  const m = text.match(/\r?\n/);
  const eol: "\n" | "\r\n" = m && m[0] === "\r\n" ? "\r\n" : "\n";
  return { exists: true, text, eol };
}

/** 解析 .env 为 key→value 映射（与 env.ts 的 trim/跳注释行为一致） */
export function parseEnvText(text: string): Map<string, string> {
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
 * 逐键改写 + 追加 + 删除：
 *   - changes 里的键：**同名多处全部改写**（FIX-DUP-01 结论不变），文件里没有则追加
 *   - deleteKeys 里的键：**同名多处全部删除**，其余行（含注释、空行、无法解析的行）原样保留
 *   - 不重排文件、不改换行风格
 *
 * [FIX-DUP-01] 同名键出现多次时必须**全部改写**：旧实现命中第一处后即从待改集合移除，
 *   于是「配置页保存只改第一行、末尾那行仍旧值」，而运行时按「后者覆盖前者」取值 ——
 *   表现为「页面回执已保存并热更，开关却毫无变化」。
 */
export function mergeEnvText(
  snapshot: EnvFileSnapshot,
  changes: Record<string, string>,
  deleteKeys: readonly string[] = [],
): string {
  const pending = new Map<string, string>(
    Object.entries(changes).map(([k, v]) => [k, String(v).trim()] as [string, string]),
  );
  const del = new Set(deleteKeys.map((k) => k.trim()));
  const lines = snapshot.exists ? snapshot.text.split(/\r?\n/) : [];
  /** 文件中确实存在过的键（用于区分「需追加的新键」/「同名多处」） */
  const found = new Set<string>();

  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // 注释行 / 空行 / 无法解析的行 → 原样保留（不丢用户内容）
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();

    if (del.has(key) && !pending.has(key)) continue;    // 删除（同名多处全部删除）
    if (!pending.has(key)) {
      out.push(line);
      continue;
    }

    // 保留原行「= 之前的一切」，只替换 = 之后的内容（不改动缩进与行尾空白风格）
    found.add(key);
    const eqIdxInLine = line.indexOf("=");
    out.push(line.slice(0, eqIdxInLine + 1) + (pending.get(key) as string));
  }

  // 仅「文件中完全没有出现」的键 → 追加（单独成行）
  for (const [k, v] of pending) {
    if (found.has(k)) continue;
    out.push(`${k}=${v}`);
  }

  return out.join(snapshot.eol);
}

/**
 * [FIX-DUP-01] 统计文本中同名键的出现次数（>1 即重复键）。
 * 供保存路径显式告警：重复键是「改了却不生效」最常见的原因，必须喊出来。
 */
export function countDuplicateKeys(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...counts]) if (n < 2) counts.delete(k);
  return counts;
}

// ============================================
// 原子写 + 失败回退
// ============================================

export interface WriteResult {
  ok: boolean;
  /** 原子 rename 失败、回退 copy 成功时置 true（前端可提示"已写入但非原子"） */
  degraded?: boolean;
  error?: string;
}

/** 原子写入 .env：先写同目录 .env.tmp → rename；失败回退 copyFile */
export function writeEnvAtomic(text: string): WriteResult {
  const tmp = resolve(PROJECT_ROOT, ".env.tmp");
  try {
    writeFileSync(tmp, text, "utf-8");
    try {
      renameSync(tmp, ENV_PATH);
      return { ok: true };
    } catch {
      // Windows 下目标被占用等 → 回退为覆盖写（非原子，但保证内容完整）
      copyFileSync(tmp, ENV_PATH);
      try { unlinkSync(tmp); } catch { /* 清理失败不致命 */ }
      return { ok: true, degraded: true };
    }
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================
// 备份 + 保留最近 20 份
// ============================================

/** 生成 yyyyMMddHHmmss 本地时间戳 */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 备份当前 .env；.env 不存在时返回 null（跳过备份，AC-CFG-9） */
export function backupEnv(): string | null {
  if (!existsSync(ENV_PATH)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `env.${timestamp()}.bak`;
  copyFileSync(ENV_PATH, join(BACKUP_DIR, name));
  pruneBackups();
  return name;   // 相对 BACKUP_DIR 的文件名，回执给前端
}

/** 只保留最近 KEEP_BACKUPS 份（文件名时间戳为定长 14 位，字典序 = 时间序） */
function pruneBackups(): void {
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => /^env\.\d{14}\.bak$/.test(f))
    .sort();                                  // 升序：最旧在前
  const excess = files.length - KEEP_BACKUPS;
  for (let i = 0; i < excess; i++) {
    const f = files[i];
    if (!f) continue;                         // noUncheckedIndexedAccess
    try { unlinkSync(join(BACKUP_DIR, f)); } catch { /* 删除失败不阻断保存 */ }
  }
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
  /** 被系统环境变量遮蔽（AC-CFG-8） */
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
 * @param shadowed     被系统环境变量遮蔽的键集合（来自 env.ts 的 envShadowedBySystem）
 * @param effectiveOf  可选：运行时实际生效值（阶段 B 回填）
 */
export function buildConfigItems(
  restartOnly: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
  effectiveOf?: (key: string) => unknown,
): ConfigItem[] {
  const snap = readEnvFile();
  const fileMap = parseEnvText(snap.text);

  return CONFIG_KEYS.map((meta) => {
    // 文件中缺失该键 → 回填默认值（AC-CFG-9）
    const raw = fileMap.has(meta.key) ? (fileMap.get(meta.key) as string) : meta.defaultValue;
    const base: ConfigItem = {
      key: meta.key, group: meta.group, groupTitle: meta.groupTitle,
      type: meta.type, label: meta.label, desc: meta.desc,
      value: raw, secret: !!meta.secret, required: meta.required === true,
      allowEmpty: meta.allowEmpty === true,
      enumValues: meta.enumValues, enumLabels: meta.enumLabels, min: meta.min, max: meta.max,
      shadowed: shadowed.has(meta.key),
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
  /** 需要删除的键（恢复默认 / 存量迁移 / 遗留键清理）：同名多处全部删除 */
  deleteKeys?: readonly string[];
  /** 本次扫描注册的键（**写入**白名单的并集，§9.1） */
  allowedKeys?: ReadonlySet<string>;
  /**
   * **删除**侧的额外白名单（旧键 / 遗留键）。缺省 = 空集。
   *
   * ⚠️ 为什么必须与 `allowedKeys` 分开（R-24）：**「可写」与「可删」是两个不同的集合**。
   *   · 迁移要删的是**已被移出 `CONFIG_KEYS` 的旧键**（`FILE_READ_ENABLED` 等）——
   *     它们按定义不在任何白名单里；
   *   · 遗留键接口要删的是**未被本次扫描注册的托管键**——按定义也不在 `allowedKeys` 里。
   *   用一个白名单同时校验写入与删除，会让这两个功能 **100% 失败**（落入 unknown → `ok:false`）。
   */
  allowDeleteKeys?: ReadonlySet<string>;
  /** 不备份（遗留键独立接口：§10.2「删除不备份」） */
  skipBackup?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  /** 实际写入的键 */
  written: string[];
  /** 实际删除的键（= 恢复默认 / 迁移 / 遗留键清理） */
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
 * 应用一批改动：白名单 → 键名硬校验 → 写删互斥 → 密文清空约束 → 系统值校验 → 备份 → 合并 → 原子写
 *
 * [R-24] 写入与删除**分别**校验白名单（见 ApplyRequest.allowDeleteKeys 的注释）。
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
      key: k, reason: "键名不符合环境变量格式（^[A-Za-z_][A-Za-z0-9_]*$）",
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

  // ⑥ 备份（可跳过；.env 不存在则跳过，AC-CFG-9）
  const snap = readEnvFile();
  const backupFile = req.skipBackup ? null : backupEnv();

  // ⑦ 合并 + 原子写
  const writeMap: Record<string, string> = { ...changes };
  for (const k of clearKeys) writeMap[k] = "";
  const dupInFile = countDuplicateKeys(snap.text);
  const dupTouched = [...dupInFile.entries()].filter(([k]) => k in writeMap);
  if (dupTouched.length > 0) {
    console.warn(
      `⚠️  [.env] 以下键在文件中重复出现，本次已把全部同名行改成同一值：` +
      dupTouched.map(([k, n]) => `${k}×${n}`).join(", ") + `；建议删掉多余行。`,
    );
  }
  const next = mergeEnvText(snap, writeMap, deleted);
  const w = writeEnvAtomic(next);
  if (!w.ok) {
    return { ok: false, written: [], deleted: [], backupFile: null, envCreated: false, error: w.error };
  }

  return {
    ok: true,
    written,
    deleted,
    backupFile,
    envCreated: !snap.exists,
    degraded: w.degraded,
  };
}
