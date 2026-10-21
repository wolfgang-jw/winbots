/**
 * src/infra/configFile.ts
 * .env 配置文件的读写 / 备份 / 校验 / 掩码（配置页专用，需求 §4.5）
 *
 * 设计要点：
 * 1. 路径基准与 src/infra/env.ts 完全一致（import.meta.dir 而非 process.cwd()）；
 * 2. 逐键替换、保留注释与行序，不重生成文件；
 * 3. 原子写（tmp + rename），失败回退 copy；
 * 4. 独立于 etc/tools/local 文件沙箱，不受 FILE_MODIFY_ENABLED 影响（需求 §4.7 S5）。
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
export type ConfigGroup = "app" | "llm" | "file" | "log" | "stab" | "internet";

export interface ConfigKeyMeta {
  key: string;
  group: ConfigGroup;
  type: ConfigType;
  /** 中文标签（前端表单显示） */
  label: string;
  /** 文件缺失该键时的回填值（取自 src/infra/env.ts 的 validateEnv 默认值） */
  defaultValue: string;
  secret?: boolean;
  /**
   * [需求域 R / R-17、§9.2] 必需项：不允许清空（界面不显示按钮，接口收到清空须拒绝且不改写文件）。
   * 仅为 true 时才受限制；未声明视为「非必需」——但非密文项本身也不支持清空（§9.2 适用范围）。
   */
  required?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  /** 分组标题（与 .env.example 注释块一致） */
  groupTitle: string;
  /** 说明文字（取自 .env.example 注释） */
  desc: string;
}

/** 22 项全量白名单（16 项原有 + 6 项互联网工具；顺序与 .env.example 一致；需求 §4.2 / §9.1） */
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
    key: "FILE_ROOT_DIR", group: "file", groupTitle: "文件工具配置", type: "string",
    label: "沙箱总目录", defaultValue: "working",
    desc: "AI 文件操作的沙箱根（相对项目根）。路径不做限制，请自行确认安全。",
  },
  {
    key: "FILE_READ_ENABLED", group: "file", groupTitle: "文件工具配置", type: "bool",
    label: "读开关", defaultValue: "true",
    desc: "控制列目录/读文件/查信息/搜索。默认开启。",
  },
  {
    key: "FILE_CREATE_ENABLED", group: "file", groupTitle: "文件工具配置", type: "bool",
    label: "新建开关", defaultValue: "false",
    desc: "控制建目录/建文件/追加。默认关闭。",
  },
  {
    key: "FILE_MODIFY_ENABLED", group: "file", groupTitle: "文件工具配置", type: "bool",
    label: "修改开关（含删除）", defaultValue: "false",
    desc: "控制覆盖/替换/移动/删除。破坏性最强，默认关闭。",
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
  // ============================================
  // [需求域 R / US-R-01] 互联网工具配置（6 项进配置页，R-13/R-14/R-17）
  //   进配置页的判定见 §9.1；其余（基址、默认条数、暂存四要素）手工维护，不在此白名单内。
  // ============================================
  {
    key: "INTERNET_ENABLED", group: "internet", groupTitle: "互联网工具配置", type: "bool",
    label: "联网工具总开关", defaultValue: "true",
    desc: "控制网页检索/抓取工具是否出现在模型可见工具列表中；保存后热更立即生效（R-13）。",
  },
  {
    key: "INTERNET_SEARCH_PROVIDER", group: "internet", groupTitle: "互联网工具配置", type: "enum",
    label: "检索供应商", defaultValue: "deepseek", enumValues: ["deepseek"],
    desc: "网页检索使用的供应商标识；与抓取供应商相互独立，缺密钥只影响各自的 kind（R-07/R-14）。",
  },
  {
    key: "INTERNET_FETCH_PROVIDER", group: "internet", groupTitle: "互联网工具配置", type: "enum",
    label: "抓取供应商", defaultValue: "deepseek", enumValues: ["deepseek"],
    desc: "网页抓取使用的供应商标识；与检索供应商相互独立（R-07/R-14）。",
  },
  {
    key: "INTERNET_DEEPSEEK_API_KEY", group: "internet", groupTitle: "互联网工具配置", type: "secret",
    label: "DeepSeek 供应商密钥", defaultValue: "", secret: true,
    desc: "留空表示不修改；需删除已保存的密钥请点『清空』。密钥为空时按免鉴权调用（不发送鉴权头，R-15），若该供应商实际需要鉴权则每次调用返回 auth_required（R-16）。",
  },
  {
    key: "INTERNET_TIMEOUT_MS", group: "internet", groupTitle: "互联网工具配置", type: "int",
    label: "单次请求超时（毫秒）", defaultValue: "20000", min: 1000,
    desc: "联网工具单次上请求的超时上限（R-39）；超时挂在中止信号上，点「停止」也会中止在途请求（R-40）。",
  },
  {
    key: "INTERNET_FETCH_MAX_CHARS", group: "internet", groupTitle: "互联网工具配置", type: "int",
    label: "抓取回灌上限（字符）", defaultValue: "8000", min: 200,
    desc: "单次抓取正文回灌给模型的字符上限，超限按三要素标注截断状态（R-41/R-24）。",
  },
] as const;

/** 键名白名单集合（PUT 校验用） */
export const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS.map((m) => m.key));

/** 分组顺序（前端渲染顺序） */
export const CONFIG_GROUPS: readonly ConfigGroup[] = ["app", "llm", "file", "log", "stab", "internet"];

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
      return t === "" ? "不能为空" : null;
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
  // 检测换行风格：首个换行符前是否有 \r
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
 * 逐键替换：仅改写 changes 中出现的键，其余行（含注释、空行、无法解析的行）原样保留。
 * 文件中不存在的新键 → 追加到末尾。
 */
export function mergeEnvText(snapshot: EnvFileSnapshot, changes: Record<string, string>): string {
  const pending = new Map<string, string>(
    Object.entries(changes).map(([k, v]) => [k, String(v).trim()] as [string, string]),
  );
  const lines = snapshot.exists ? snapshot.text.split(/\r?\n/) : [];

  const out = lines.map((line) => {
    const trimmed = line.trim();
    // 注释行 / 空行 / 无法解析的行 → 原样保留（不丢用户内容）
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;

    const key = trimmed.slice(0, eq).trim();
    if (!pending.has(key)) return line;

    // 保留原行「= 之前的一切」，只替换 = 之后的内容（不改动缩进与行尾空白风格）
    const value = pending.get(key)!;
    pending.delete(key);
    const eqIdxInLine = line.indexOf("=");
    return line.slice(0, eqIdxInLine + 1) + value;
  });

  // 未在文件中出现的键 → 追加（单独成行）
  for (const [k, v] of pending) out.push(`${k}=${v}`);

  return out.join(snapshot.eol);
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
  /** secret 键：文件中是否已有非空值 */
  hasValue?: boolean;
  /** secret 键：掩码，如 sk-****cdef */
  mask?: string;
  enumValues?: readonly string[];
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
 * 装配 GET /api/config 的 items。
 * @param restartOnly  需重启的键集合（阶段 A 传全部 15 个键；阶段 B 传 {APP_PORT}）
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
    const raw = fileMap.has(meta.key) ? fileMap.get(meta.key)! : meta.defaultValue;
    const base: ConfigItem = {
      key: meta.key, group: meta.group, groupTitle: meta.groupTitle,
      type: meta.type, label: meta.label, desc: meta.desc,
      value: raw, secret: !!meta.secret, required: meta.required === true,
      enumValues: meta.enumValues, min: meta.min, max: meta.max,
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

export interface ApplyResult {
  ok: boolean;
  changed: string[];
  backupFile: string | null;
  envCreated: boolean;
  degraded?: boolean;
  /** 校验失败：[键, 原因] 列表（HTTP 400 用） */
  invalid?: Array<{ key: string; reason: string }>;
  error?: string;
}

/**
 * 应用一批改动：校验 → 备份 → 逐键替换 → 原子写
 *
 * [需求域 R / US-R-06 / R-17、§9.2] 新增 clearKeys：
 *   清空**只能**经该参数表达（写入空串并持久化），不复用「changes 中传空串＝不修改」的既有约定。
 *   校验（全部通过才写盘，与 §4.3 一致）：
 *     1. 必须是白名单键；
 *     2. 必须是密文类型（非密文键一律拒绝）；
 *     3. 不得是必需项（必需项写空会导致热更校验判缺失并退出进程，§9.2 约束 4）；
 *     4. 同一键不得同时出现在 changes 与 clearKeys。
 *   任一不满足 → 整请求拒绝，文件不被改写。
 */
export function applyConfigChanges(
  changes: Record<string, string>,
  clearKeys: readonly string[] = [],
): ApplyResult {
  const keys = Object.keys(changes);

  // ① 白名单（changes 与 clear 均需校验）
  const unknown = [...keys, ...clearKeys].filter((k) => !CONFIG_KEY_SET.has(k));
  if (unknown.length > 0) {
    return {
      ok: false, changed: [], backupFile: null, envCreated: false,
      invalid: unknown.map((k) => ({ key: k, reason: "未知配置项（不在白名单内）" })),
    };
  }

  // ①-b [R-17 / §9.2] clear 的合法性校验（在任何写盘动作之前）
  const clearInvalid: Array<{ key: string; reason: string }> = [];
  const seenClear = new Set<string>();
  for (const k of clearKeys) {
    if (seenClear.has(k)) continue;          // 重复项去重，不算错误
    seenClear.add(k);
    if (keys.includes(k)) {
      clearInvalid.push({ key: k, reason: "同一项不得同时出现在 changes 与 clear 中" });
      continue;
    }
    const meta = CONFIG_KEYS.find((m) => m.key === k);
    if (!meta) continue;                     // 未知键已在 ① 拦下
    if (!meta.secret) {
      clearInvalid.push({ key: k, reason: "仅密文项支持清空（非密文项请直接改值）" });
      continue;
    }
    if (meta.required) {
      clearInvalid.push({
        key: k,
        reason: "必需项不支持清空：写空后热更会判定缺失并导致进程退出，请填入新的有效值",
      });
    }
  }
  if (clearInvalid.length > 0) {
    return { ok: false, changed: [], backupFile: null, envCreated: false, invalid: clearInvalid };
  }

  // ② 校验（全部通过才写盘；需求 §4.3：失败不写文件）
  const invalid: Array<{ key: string; reason: string }> = [];
  for (const k of keys) {
    const meta = CONFIG_KEYS.find((m) => m.key === k)!;
    const reason = validateValue(meta, changes[k]!);
    if (reason) invalid.push({ key: k, reason });
  }
  if (invalid.length > 0) {
    return { ok: false, changed: [], backupFile: null, envCreated: false, invalid };
  }

  // ③ 备份（.env 不存在则跳过，AC-CFG-9）
  const snap = readEnvFile();
  const backupFile = backupEnv();

  // ④ 合并 + 原子写（清空项以空串进入同一写入映射，逐键替换后落盘为 KEY=）
  const writeMap: Record<string, string> = { ...changes };
  for (const k of clearKeys) writeMap[k] = "";
  const next = mergeEnvText(snap, writeMap);
  const w = writeEnvAtomic(next);
  if (!w.ok) {
    return { ok: false, changed: [], backupFile: null, envCreated: false, error: w.error };
  }

  return {
    ok: true, changed: [...keys, ...clearKeys], backupFile,
    envCreated: !snap.exists, degraded: w.degraded,
  };
}
