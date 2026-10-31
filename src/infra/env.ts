import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * 环境变量校验与类型安全导出
 * 
 * 职责：
 * 1. 在应用启动时校验所有必需的环境变量
 * 2. 将 Bun.env 的字符串值转换为正确的类型（number 等）
 * 3. 导出不可变的配置对象供其他模块使用
 * 4. 缺失变量时打印清晰错误并终止进程
 */

/**
 * [需求域 C / C-04] 思考相关字段的下发方式。
 * 取值固定为四值枚举，不得用单一布尔表达「只发开关 / 只发强度」两种语义。
 */
export type ThinkingMode = "none" | "effort" | "thinking" | "both";

/** 合法取值（顺序即配置页下拉顺序） */
export const THINKING_MODES: readonly ThinkingMode[] = ["none", "effort", "thinking", "both"];

/** 默认值：均不下发（C-05：接入非 DeepSeek 的 OpenAI 兼容服务商时不因未知字段被拒） */
export const DEFAULT_THINKING_MODE: ThinkingMode = "none";

/**
 * [需求域 C / C-04、C-07] 解析「思考字段下发方式」。
 * 缺失 / 非法 / 大小写不符一律回退默认值 none：
 * §9.1 约束——新增配置项不得加入必填校验，缺失时回退默认值而非退出进程。
 */
export function parseThinkingMode(raw: string | undefined): ThinkingMode {
  const v = (raw ?? "").trim().toLowerCase();
  return (THINKING_MODES as readonly string[]).includes(v)
    ? (v as ThinkingMode)
    : DEFAULT_THINKING_MODE;
}

/** 各取值的中文说明（启动日志与配置页描述共用同一措辞，C-07 一致性） */
export const THINKING_MODE_LABEL: Record<ThinkingMode, string> = {
  none: "均不下发",
  effort: "仅下发推理强度",
  thinking: "仅下发思考开关",
  both: "两者都下发",
};

/**
 * [需求域 BR / BR-61] 浏览器 profile 模式。
 * persist 等于把登录态交给模型，配置页说明里必须写清（BR-39）。
 */
export type BrowserProfileMode = "temp" | "persist";

export const BROWSER_PROFILE_MODES: readonly BrowserProfileMode[] = ["temp", "persist"];

/** 枚举非法/缺失一律回退 temp（§13.2-2） */
export function parseProfileMode(raw: string | undefined): BrowserProfileMode {
  const v = (raw ?? "").trim().toLowerCase();
  return (BROWSER_PROFILE_MODES as readonly string[]).includes(v)
    ? (v as BrowserProfileMode)
    : "temp";
}

/**
 * 数值项：缺失/非法回退默认值并钳制到 [min, max]（§13.2-3）
 *
 * [R-02 附带] 原文先用 normalizeScalarText 归一：旧写法直接用 Number(原文)，
 * 于是 `BROWSER_SESSION_TTL_S=600   # 10 分钟` 得到 NaN → 静默回退 180，
 * 与布尔项「设了却不生效」是同一类病，只是换成了数值。
 */
export function parseIntClamped(
  raw: string | undefined,
  def: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  label = "",
): number {
  const text = normalizeScalarText(raw);
  if (text === "") return def;
  const n = Number(text);
  if (!Number.isFinite(n)) {
    console.warn(
      `⚠️  ${label || "配置项"} 取值不是数字（${JSON.stringify(String(raw))}），已按默认值 ${def} 处理。`
    );
    return def;
  }
  const v = Math.trunc(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** 内部沿用旧名，避免十几处调用点改名（语义见 parseIntClamped） */
const numOr = parseIntClamped;

/**
 * [§13.2-3 关键点] BROWSER_DEBUG_PORT 的 0 是**合法且有语义**的值（随机端口），
 * 因此不能用「空值/0 一律取默认」的写法，必须单独解析。
 */
export function parseDebugPort(raw: string | undefined): number {
  // [R-02 附带] 同样容忍引号与行内注释；0 的语义（随机端口）保持不变
  const text = normalizeScalarText(raw);
  if (text === "") return 0;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.warn(
      `⚠️  BROWSER_DEBUG_PORT 取值非法（${JSON.stringify(String(raw))}），已按 0（随机端口）处理；有效范围 0–65535。`
    );
    return 0;
  }
  return n;
}

/** [批次一 / FR-38] read_file 区间模式的默认行数：默认 2000，范围 1–50000 */
export const FILE_READ_DEFAULT_LINES_DEFAULT = 2000;
export const FILE_READ_DEFAULT_LINES_MIN = 1;
export const FILE_READ_DEFAULT_LINES_MAX = 50000;

/**
 * [批次一 / FR-38、AC-FR-19] 解析 FILE_READ_DEFAULT_LINES。
 *
 * 与 parseIntClamped 的差别（有意为之）：
 *   · 缺失 / 非数字 / 非整数 / 0 / 负数 → **告警并回退默认值 2000**（而不是钳到下限 1）；
 *   · 超过 50000 → 钳到 50000；
 *   · 原文先经 normalizeScalarText 归一（容忍 `  # 注释`、成对引号，与布尔/数值项同一口径）。
 *
 * 不得改写为 `parseInt(raw) || 2000`：那样 0 会被静默吞成默认值且无任何告警。
 */
export function parseFileReadDefaultLines(raw: string | undefined): number {
  const text = normalizeScalarText(raw);
  if (text === "") return FILE_READ_DEFAULT_LINES_DEFAULT;
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < FILE_READ_DEFAULT_LINES_MIN) {
    console.warn(
      `⚠️  FILE_READ_DEFAULT_LINES 取值非法（${JSON.stringify(String(raw))}），` +
        `已按默认值 ${FILE_READ_DEFAULT_LINES_DEFAULT} 处理；有效范围 ` +
        `${FILE_READ_DEFAULT_LINES_MIN}–${FILE_READ_DEFAULT_LINES_MAX}。`,
    );
    return FILE_READ_DEFAULT_LINES_DEFAULT;
  }
  if (n > FILE_READ_DEFAULT_LINES_MAX) {
    console.warn(
      `⚠️  FILE_READ_DEFAULT_LINES 取值 ${n} 超过上限，已钳制为 ${FILE_READ_DEFAULT_LINES_MAX}。`,
    );
    return FILE_READ_DEFAULT_LINES_MAX;
  }
  return n;
}

/* ============================================================
 * [批次三 / 第 4.11 节] 本机命令执行配置（15 项；其中 9 项进配置页）
 *   解析原则（SH-46 / SH-47）：
 *     · 缺失 / 非法一律回退默认值，**不加入 REQUIRED_VARS**（不得导致进程退出）；
 *     · 整数项只接受纯数字（不接受 1e3 / 0x10 / 负数）；越界钳制；
 *     · 枚举项非法值回退最保守取值（权限档位 → forbid）；
 *     · 不得用 `parseInt(raw) || 默认`：那样 0 会被静默吞成默认值且无告警。
 * ============================================================ */

/** [AP-01] 权限档位：三值枚举 */
export type ShellPermission = "forbid" | "ask" | "allow";
export const SHELL_PERMISSIONS: readonly ShellPermission[] = ["forbid", "ask", "allow"];
export const DEFAULT_SHELL_PERMISSION: ShellPermission = "forbid";

/** 三档的中文说明（启动摘要与配置页 desc 共用同一措辞，AP-04 / SH-31） */
export const SHELL_PERMISSION_LABEL: Record<ShellPermission, string> = {
  forbid: "禁止（工具不在模型可见列表）",
  ask: "需用户同意（每次执行都要用户点一次确认）",
  allow: "允许（等于把本机命令行完全交给模型，不再有任何人工闸门）",
};

/** [AP-01 / AP-05] 缺失 / 非法 → forbid（保守失败：宁可工具消失，也不误开） */
export function parseShellPermission(raw: string | undefined): ShellPermission {
  const v = normalizeScalarText(raw).toLowerCase();
  if (v === "") return DEFAULT_SHELL_PERMISSION;
  if ((SHELL_PERMISSIONS as readonly string[]).includes(v)) return v as ShellPermission;
  console.warn(
    `⚠️  SHELL_PERMISSION 取值非法（${JSON.stringify(String(raw))}），已按「禁止」处理；` +
      `有效值 forbid / ask / allow。`,
  );
  return DEFAULT_SHELL_PERMISSION;
}

/** [SH-12 / XS-04] shell 类型：不可由模型选择，只由配置决定 */
export type ShellType = "cmd" | "powershell";
export const SHELL_TYPES: readonly ShellType[] = ["cmd", "powershell"];

export function parseShellType(raw: string | undefined): ShellType {
  const v = normalizeScalarText(raw).toLowerCase();
  if (v === "") return "cmd";
  if (v === "cmd" || v === "powershell") return v;
  console.warn(`⚠️  SHELL_TYPE 取值非法（${JSON.stringify(String(raw))}），已按 cmd 处理；有效值 cmd / powershell。`);
  return "cmd";
}

/**
 * [SH-33] 内置拒绝清单默认集（逗号分隔，大小写不敏感、去多余空白后按「包含」匹配）。
 * ⚠️ 这是**启发式**，不是安全保证（SH-36）；覆盖磁盘级与系统级破坏性操作。
 */
export const DEFAULT_SHELL_DENY_LIST = [
  "format", "diskpart", "bcdedit", "vssadmin delete", "vssadmin resize", "cipher /w",
  "wbadmin delete", "reg delete", "reg add", "shutdown", "restart-computer", "stop-computer",
  "net user", "net localgroup", "takeown /f", "icacls . /reset",
  "del /f /s /q c:", "rd /s /q c:", "rmdir /s /q c:",
].join(",");

/** [SH-34 / SH-47 ③] 允许清单未启用时的固定取值（非密文文本项不能留空） */
export const DEFAULT_SHELL_ALLOW_LIST = "none";

/**
 * [FIX-SILENT-01] 浏览器开关的布尔容错解析。
 *
 * 起因（现场故障 2026-10-22）：用户手工把 `.env` 写成 `BROWSER_ENABLED=True` /
 * `=1` / `=yes`，而旧写法是严格的 `=== "true"`，于是被判为「关」：
 * 四个浏览器工具直接从模型可见列表消失，模型连「开关没开」都说不出来，
 * 表现正是「要求打开浏览器，但什么也没有发生」。
 *
 * 规则：缺省/空 → 默认值；真值词 → true；假值词 → false；
 *       其余无法识别 → 取默认值**并在启动日志告警**（绝不静默）。
 */
export function parseBoolLoose(raw: string | undefined, def: boolean, label = ""): boolean {
  const v = normalizeBoolText(raw);
  if (v === "") return def;
  if (v === "true" || v === "1" || v === "yes" || v === "on" || v === "y") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off" || v === "n") return false;
  console.warn(
    `⚠️  ${label || "配置项"} 取值无法识别（${JSON.stringify(String(raw))}），` +
      `已按「${def ? "开启" : "关闭"}」处理；请写 true / false。`
  );
  return def;
}

/**
 * [FIX-BOOT-03] 布尔原文归一化：剥掉成对引号与行内注释，再小写。
 *
 * 起因（现场故障 2026-10-22 第二例）：用户照抄示例把值写成
 *   BROWSER_ENABLED=true      # 打开
 * 或
 *   BROWSER_ENABLED="true"
 * 旧实现直接把整串拿去比较，`true      # 打开` 不等于任何真值词，
 * 于是判为「关」→ 四个工具从模型可见列表消失（症状与开关没开完全一样）。
 *
 * 同一函数也用于数值项（parseIntClamped / parseDebugPort）与 .env 遮蔽比对，
 * 三处共用一套归一化口径，避免「布尔认、数字不认」这类不一致。
 *
 * [FIX-QUOTE-CMT-01] 顺序必须是「先截注释、再剥引号」（用例实测暴露）：
 *   原实现先判「首尾是否成对引号」再截注释，于是 `"true"  # 开` 因为尾部是 `开`
 *   被判成「未加引号」，截注释后得到 `"true"`（引号仍在）→ 仍无法识别 → 回退默认值。
 *   即「引号 + 行内注释」这一最常见的照抄写法依旧失效，与修复前的症状一模一样。
 */
function normalizeScalarText(raw: string | undefined): string {
  return stripPairedQuotes(stripInlineComment(String(raw ?? "").trim()));
}

/**
 * 截断行内注释：只有「成对引号之外」且「前一字符是空白」的 `#` 才算注释起点。
 *
 * 为什么不直接 `search(/\s#/)`：那样会把 `KEY="a # b"`（密码/URL 里带 `#`）
 * 从引号内部截断。这里用一次线性扫描跳过引号区段，两类写法都能正确处理：
 *   `true   # 开`      → `true`          （引号外 + 空白后 → 注释）
 *   `"true"  # 开`     → `"true"`        （先截注释，再由下面剥引号）
 *   `"a # b"`          → `"a # b"`       （`#` 在引号内 → 不是注释）
 *   `tr#ue`            → `tr#ue`         （`#` 前无空白 → 不是注释）
 */
function stripInlineComment(v: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < v.length; i++) {
    const ch = v.charAt(i);
    if (quote !== null) {
      if (ch === "\\") {
        i += 1;                          // 转义：跳过下一个字符
        continue;
      }
      if (ch === quote) quote = null;     // 引号闭合
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && i > 0 && /\s/.test(v.charAt(i - 1))) {
      return v.slice(0, i).trim();
    }
  }
  return v;
}

/** 剥掉成对的首尾引号（只剥一层，要求首尾同种引号；不成对则原样返回） */
function stripPairedQuotes(v: string): string {
  if (v.length < 2) return v;
  const first = v.charAt(0);
  if ((first === '"' || first === "'") && first === v.charAt(v.length - 1)) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/** 布尔项在归一化后再小写比较；数值项直接用 normalizeScalarText（R-02） */
function normalizeBoolText(raw: string | undefined): string {
  return normalizeScalarText(raw).toLowerCase();
}

export interface EnvConfig {
  // 服务端口
  APP_PORT: number;

  // LLM (OpenAI 兼容接口) 配置
  LLM_API_BASE: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
  // 思考模式配置（可选）
  LLM_THINKING: boolean;
  LLM_REASONING_EFFORT: string;
  // [需求域 C / C-01~C-05] 思考相关字段的下发方式（none / effort / thinking / both）
  //   上面两项 LLM_THINKING / LLM_REASONING_EFFORT 只是「取值来源」，
  //   不再各自决定请求体是否携带对应字段。
  LLM_THINKING_MODE: ThinkingMode;

  // [US-CFG-1] 文件工具配置（全部可选，带默认值；不加入 REQUIRED_VARS）
  FILE_ROOT_DIR: string;          // 沙箱总目录（默认 working，与 data 平级）
  FILE_READ_ENABLED: boolean;     // 读开关（默认 true）
  FILE_CREATE_ENABLED: boolean;   // 新建开关（默认 false）
  FILE_MODIFY_ENABLED: boolean;   // 修改开关（含删除，默认 false）
  // [批次一 / FR-38、FR-39] read_file 区间模式的默认行数（默认 2000，范围 1–50000）。
  //   不进配置页（手工维护），也不进 REQUIRED_VARS；改 .env 后热更即生效。
  FILE_READ_DEFAULT_LINES: number;

  // [批次三 / 第 4.11 节] 本机命令执行配置（15 项，全部可选、带默认值；不加入 REQUIRED_VARS）
  //   工具每次调用实时读取（SH-46），不得在模块顶层缓存。
  SHELL_PERMISSION: ShellPermission;      // 权限档位（默认 forbid；AP-01 ~ AP-05）
  SHELL_APPROVAL_WAIT_MS: number;         // 审批等待上限（默认 120000；AP-16）
  SHELL_SESSION_MEMORY_ENABLED: boolean;  // 本会话授权记忆（默认开；关闭后退化为逐次询问，AP-13）
  SHELL_ALLOW_ALL_OPTION: boolean;        // 是否提供「本会话都允许 · 所有命令」（默认提供；AP-15）
  SHELL_DENY_COOLDOWN_MS: number;         // 拒绝冷却时长（默认 60000；AP-17）
  SHELL_TYPE: ShellType;                  // shell 类型（默认 cmd；SH-12）
  SHELL_TIMEOUT_DEFAULT_MS: number;       // 默认超时（默认 30000；SH-15）
  SHELL_TIMEOUT_MAX_MS: number;           // 超时上限（默认 120000；SH-15）
  SHELL_OUTPUT_MAX_CHARS: number;         // 输出上限（默认 8000；SH-26 / SH-30）
  SHELL_MAX_COMMAND_CHARS: number;        // 命令长度上限（默认 4000；SH-11）
  SHELL_MAX_CONCURRENCY: number;          // 全局并发上限（默认 1；SH-17）
  SHELL_UTF8_UNIFY: boolean;              // UTF-8 统一编码（默认开；SH-28，语义见文档 §3.4）
  SHELL_DENY_LIST: string;                // 拒绝清单（逗号分隔；SH-33）
  SHELL_ALLOW_LIST: string;               // 允许清单（none = 未启用；SH-34）
  SHELL_EXTRA_ENV_KEYS: string;           // 追加环境变量键（逗号分隔；SH-35）

  // [Sprint 5.1 / US-LOG-1] LLM 对话日志配置（全部可选，带默认值；不加入 REQUIRED_VARS）
  LLM_LOG_ENABLED: boolean;       // 日志总开关（默认 false，关闭）
  LLM_LOG_FILE: string;           // 日志文件路径（JSONL，默认 data/llm_logs.jsonl）
  LLM_LOG_MAX_ROWS: number;       // 日志条数上限（默认 2000，超出清理最旧）

  // [Sprint 5.2 / US-STAB-3] 复杂问题稳定性配置（可选，带默认值；不加入 REQUIRED_VARS）
  MAX_TOOL_ROUNDS: number;        // 工具调用轮次上限（默认 8）
  SSE_HEARTBEAT_MS: number;       // SSE 心跳间隔毫秒（默认 10000）
  // [需求域 T / T-06] 平台兜底：工具结果总长度上限（字符，默认 32000）。
  //   与具体工具无关，在 executeTool 唯一出口统一截断；不进配置页（§9.1「进配置页=否」），
  //   也不进 REQUIRED_VARS（缺失回退默认值，§9.1 约束 2）。
  TOOL_RESULT_MAX_CHARS: number;

  // [需求域 R / US-R-01] 互联网工具配置（全部可选，带默认值；不加入 REQUIRED_VARS）
  //   §9.1 约束：新增项须进入本字面量（否则热更静默失效），且不得加入必填校验。
  INTERNET_ENABLED: boolean;                    // 总开关：是否暴露联网工具（R-13，热更生效）
  INTERNET_SEARCH_PROVIDER: string;             // 检索供应商（R-07）
  INTERNET_FETCH_PROVIDER: string;              // 抓取供应商（R-07）
  INTERNET_DEEPSEEK_API_KEY: string;            // 供应商密钥（R-11：按供应商独立，空=免鉴权）
  INTERNET_DEEPSEEK_BASE_URL: string;           // 供应商基址（可覆盖，§9.1「基址」不进配置页）
  INTERNET_DEEPSEEK_SEARCH_PATH: string;        // 检索端点路径（R-08 第 1 类差异）
  INTERNET_DEEPSEEK_FETCH_PATH: string;         // 抓取端点路径（R-08 第 1 类差异）
  INTERNET_DEFAULT_COUNT: number;               // 检索默认条数（R-18，默认 5）
  INTERNET_TIMEOUT_MS: number;                  // 单次请求超时毫秒（R-39，默认 20000）
  INTERNET_FETCH_MAX_CHARS: number;             // 抓取回灌上限字符（R-41，默认 8000）
  INTERNET_STORE_TTL_S: number;                 // 暂存 TTL 秒（R-30，默认 300）
  INTERNET_STORE_MAX_ITEMS_PER_SESSION: number; // 暂存单会话条数上限（R-30，默认 8）
  INTERNET_STORE_MAX_CHARS_PER_ITEM: number;    // 暂存单条字符上限（R-30，默认 200000）
  INTERNET_STORE_MAX_CHARS_TOTAL: number;       // 暂存全局字符上限（R-30，默认 4 MB）

  // [需求域 BR / US-BR-01] 浏览器工具配置（25 项，全部可选，带默认值；不加入 REQUIRED_VARS，BR-61）
  //   [R-07 → REQ-browser BR-22] BROWSER_MAX_TABS 曾以「单标签语义 XB-01 下无实际用途」为由删除，
  //   P3 交付标签栈后它是**必需**的：既是单会话标签数上限，也是唯一的回滚旋钮
  //   （NB-04：设为 1 即退回单标签语义 —— 同标签导航、不登记站点新标签、不输出标签清单）。
  //   §13.2 解析规则：默认关闭的布尔「显式 true 才开」，默认开启的布尔「显式 false 才关」。
  BROWSER_ENABLED: boolean;                     // 总开关（默认关闭，BR-51）
  BROWSER_EXECUTABLE_PATH: string;              // 可执行文件路径；auto = 自动探测 Edge → Chrome
  // [REQ-browser BR-10 / NB-04] 窗口置前开关（默认开启）。关闭后 open 不做任何窗口激活，
  //   且 buildArgs 也不再追加 --start-maximized —— INC-02 的唯一回滚旋钮。
  BROWSER_FOREGROUND_ON_OPEN: boolean;
  BROWSER_HEADLESS: boolean;                    // 无头（默认开启）
  BROWSER_DEBUG_PORT: number;                   // 0 = 随机；固定值用于端口冲突场景
  BROWSER_PROFILE_MODE: BrowserProfileMode;     // temp / persist
  BROWSER_PROFILE_DIR: string;                  // 仅 persist 使用
  BROWSER_SESSION_TTL_S: number;                // 会话空闲 TTL（默认 180s）
  BROWSER_MAX_SESSIONS: number;                 // 并发会话上限（默认 2）
  // [REQ-browser BR-22/NB-04] 单会话标签数上限（默认 10，范围 1–20）；=1 即退回单标签语义
  BROWSER_MAX_TABS: number;
  BROWSER_ACTION_TIMEOUT_MS: number;            // 单步动作超时（默认 8000）
  BROWSER_NAV_TIMEOUT_MS: number;               // 导航超时（默认 20000）
  BROWSER_STABLE_WINDOW_MS: number;             // 稳定窗口（默认 400）
  BROWSER_SNAPSHOT_MAX_ELEMENTS: number;        // 快照元素上限（默认 120）
  BROWSER_SNAPSHOT_MAX_CHARS: number;           // 快照正文字符上限（默认 6000）
  // [REQ-browser BR-33] extract 的两个上限。**语义独立于快照上限**：
  //   快照是「整页概览」（元素多、正文短），extract 是「局部细读」（单元素深、清单短），
  //   共用一个键会让调大取文上限时把快照一起撑爆（违反 BR-32 的单次结果硬预算）。
  BROWSER_EXTRACT_MAX_CHARS: number;            // 单次 extract 回灌字符上限（默认 12000，硬上限 24000）
  BROWSER_EXTRACT_MAX_ELEMENTS: number;         // extract 命中清单条数上限（默认 20）
  BROWSER_MAX_ACTIONS: number;                  // 单次动作数上限（默认 10）
  BROWSER_DOMAIN_ALLOWLIST: string;             // 域名白名单（逗号分隔，空=不额外限制）
  BROWSER_DOMAIN_BLOCKLIST: string;             // 域名黑名单（优先于白名单）
  BROWSER_BLOCK_PRIVATE_NET: boolean;           // 私有网段阻断（默认开启）
  BROWSER_ALLOW_DOWNLOAD: boolean;              // 允许下载（默认关闭）
  BROWSER_ALLOW_UPLOAD: boolean;                // 允许上传（默认关闭）
  BROWSER_DRAG_STEPS: number;                   // 拖拽插值步数（默认 12，代码强制下限 10）
  BROWSER_TYPE_DELAY_MS: number;                // 逐字输入间隔（默认 0，上限 100）
}

/** 必需的环境变量列表 */
const REQUIRED_VARS: (keyof EnvConfig)[] = [
  "APP_PORT",
  "LLM_API_BASE", "LLM_API_KEY", "LLM_MODEL",
];

/** [配置页 / US-CFG-PAGE-7] 被系统环境变量遮蔽的键（启动时快照，AC-CFG-8） */
const shadowedKeys = new Set<string>();

/**
 * 显式加载 .env 文件（兼容 debug 模式工作目录不一致的情况）
 * 固定路径：bots/.env（相对于当前文件 src/infra/../.env）
 */
function loadDotenv(): void {
  const envPath = resolve(import.meta.dir, "../../.env");
  try {
    const content = readFileSync(envPath, "utf-8");
    /** [R-08] 文件内已出现过的键 → 取值（用于识别重复键，令「末次生效」） */
    const fileValues = new Map<string, string>();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      // [R-08] 重复键一律「末次生效」，且不判遮蔽
      //   （否则「首行 true / 末行 false」会被误报为「被系统环境变量遮蔽」）
      const seenBefore = fileValues.has(key);
      fileValues.set(key, value);
      if (seenBefore) {
        Bun.env[key] = value;
        shadowedKeys.delete(key);
        continue;
      }
      if (!Bun.env[key]) {
        Bun.env[key] = value;
      } else if (normalizeScalarText(Bun.env[key]) !== normalizeScalarText(value)) {
        // [配置页 / US-CFG-PAGE-7] 已存在且与 .env 不一致 → 判定为"被系统环境变量遮蔽"。
        //   判据用「值不相同」而非「键已存在」：Bun 运行时自身可能已加载 .env，
        //   若以"键已存在"判定，会把全部键误报为遮蔽，等于没有提示。
        shadowedKeys.add(key);
      }
    }
  } catch {
    console.warn(`⚠️  未找到 .env 文件（预期路径: ${envPath}），将依赖系统环境变量`);
  }
}

/**
 * 校验环境变量并返回类型安全的配置对象
 * 任何必需变量缺失都会导致进程以 exit code 1 终止
 */
function validateEnv(): EnvConfig {
  const missing: string[] = [];

  for (const name of REQUIRED_VARS) {
    if (!Bun.env[name]) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    console.error("=".repeat(60));
    console.error("❌ 启动失败：以下环境变量未设置");
    console.error("=".repeat(60));
    for (const name of missing) {
      console.error(`   - ${name}`);
    }
    console.error("=".repeat(60));
    console.error("请检查 .env 文件或系统环境变量。");
    process.exit(1);
  }

  return {
    APP_PORT: parseInt(Bun.env.APP_PORT!, 10),

    LLM_API_BASE: Bun.env.LLM_API_BASE!,
    LLM_API_KEY: Bun.env.LLM_API_KEY!,
    LLM_MODEL: Bun.env.LLM_MODEL!,
    LLM_THINKING: Bun.env.LLM_THINKING === "true",
    LLM_REASONING_EFFORT: Bun.env.LLM_REASONING_EFFORT || "high",
    // [需求域 C / C-01~C-05] 下发方式：缺失/非法回退 none；不进 REQUIRED_VARS（§9.1）
    LLM_THINKING_MODE: parseThinkingMode(Bun.env.LLM_THINKING_MODE),

    // [US-CFG-1] 文件工具配置（可选，带默认值）
    //   总目录：默认 "working"（与 data 平级）；仅存目录名，绝对路径由 _shared.ts 拼接
    FILE_ROOT_DIR: Bun.env.FILE_ROOT_DIR || "working",
    //   读开关：默认开启（读操作无副作用）
    FILE_READ_ENABLED: Bun.env.FILE_READ_ENABLED !== "false",
    //   新建开关：默认关闭（写操作需显式开启）
    FILE_CREATE_ENABLED: Bun.env.FILE_CREATE_ENABLED === "true",
    //   修改开关：默认关闭（含删除，破坏性最强）
    FILE_MODIFY_ENABLED: Bun.env.FILE_MODIFY_ENABLED === "true",
    //   [批次一 / FR-38] read_file 区间默认行数：默认 2000，范围 1–50000
    //     0 / 负数 / 非整数 → 告警并回退 2000；> 50000 → 钳到 50000（AC-FR-19）
    FILE_READ_DEFAULT_LINES: parseFileReadDefaultLines(Bun.env.FILE_READ_DEFAULT_LINES),

    // [批次三] 本机命令执行配置：缺失/非法一律回退默认值并告警，不退出进程（SH-46）
    SHELL_PERMISSION: parseShellPermission(Bun.env.SHELL_PERMISSION),
    SHELL_APPROVAL_WAIT_MS: parseIntClamped(Bun.env.SHELL_APPROVAL_WAIT_MS, 120000, 1000, 3600000, "SHELL_APPROVAL_WAIT_MS"),
    SHELL_SESSION_MEMORY_ENABLED: parseBoolLoose(Bun.env.SHELL_SESSION_MEMORY_ENABLED, true, "SHELL_SESSION_MEMORY_ENABLED"),
    SHELL_ALLOW_ALL_OPTION: parseBoolLoose(Bun.env.SHELL_ALLOW_ALL_OPTION, true, "SHELL_ALLOW_ALL_OPTION"),
    SHELL_DENY_COOLDOWN_MS: parseIntClamped(Bun.env.SHELL_DENY_COOLDOWN_MS, 60000, 0, 3600000, "SHELL_DENY_COOLDOWN_MS"),
    SHELL_TYPE: parseShellType(Bun.env.SHELL_TYPE),
    SHELL_TIMEOUT_DEFAULT_MS: parseIntClamped(Bun.env.SHELL_TIMEOUT_DEFAULT_MS, 30000, 1000, 3600000, "SHELL_TIMEOUT_DEFAULT_MS"),
    SHELL_TIMEOUT_MAX_MS: parseIntClamped(Bun.env.SHELL_TIMEOUT_MAX_MS, 120000, 1000, 3600000, "SHELL_TIMEOUT_MAX_MS"),
    SHELL_OUTPUT_MAX_CHARS: parseIntClamped(Bun.env.SHELL_OUTPUT_MAX_CHARS, 8000, 500, 24000, "SHELL_OUTPUT_MAX_CHARS"),
    SHELL_MAX_COMMAND_CHARS: parseIntClamped(Bun.env.SHELL_MAX_COMMAND_CHARS, 4000, 16, 32000, "SHELL_MAX_COMMAND_CHARS"),
    SHELL_MAX_CONCURRENCY: parseIntClamped(Bun.env.SHELL_MAX_CONCURRENCY, 1, 1, 8, "SHELL_MAX_CONCURRENCY"),
    SHELL_UTF8_UNIFY: parseBoolLoose(Bun.env.SHELL_UTF8_UNIFY, true, "SHELL_UTF8_UNIFY"),
    // 拒绝清单 / 允许清单：空值在解析期回退为内置默认集 / none（配置页保存空串会被 validateValue 拒绝，SH-47 ③）
    SHELL_DENY_LIST: (Bun.env.SHELL_DENY_LIST ?? "").trim() === "" ? DEFAULT_SHELL_DENY_LIST : Bun.env.SHELL_DENY_LIST!.trim(),
    SHELL_ALLOW_LIST: (Bun.env.SHELL_ALLOW_LIST ?? "").trim() === "" ? DEFAULT_SHELL_ALLOW_LIST : Bun.env.SHELL_ALLOW_LIST!.trim(),
    SHELL_EXTRA_ENV_KEYS: (Bun.env.SHELL_EXTRA_ENV_KEYS || "").trim(),

    // [Sprint 5.1 / US-LOG-1] LLM 对话日志配置（可选，带默认值）
    //   开关：默认关闭（仅显式 "true" 才开启，与 LLM_THINKING 语义一致）
    LLM_LOG_ENABLED: Bun.env.LLM_LOG_ENABLED === "true",
    //   文件：默认 data/llm_logs.jsonl（JSONL，每行一条 JSON）
    LLM_LOG_FILE: Bun.env.LLM_LOG_FILE || "data/llm_logs.jsonl",
    //   上限：默认 2000 条；非法/缺失时回退默认值（防 parseInt 返回 NaN）
    LLM_LOG_MAX_ROWS: parseInt(Bun.env.LLM_LOG_MAX_ROWS || "2000", 10) || 2000,

    // [Sprint 5.2 / US-STAB-3] 复杂问题稳定性配置（可选，带默认值）
    //   轮次上限：默认 8；非法/缺失时回退默认值（防 parseInt 返回 NaN）
    MAX_TOOL_ROUNDS: parseInt(Bun.env.MAX_TOOL_ROUNDS || "8", 10) || 8,
    //   心跳间隔：默认 10000ms；非法/缺失时回退默认值
    //   [Sprint 5.2 / US-STAB-1-FIX] 由 15000 下调至 10000：
    //     必须显著小于 Bun.serve 的 idleTimeout（index.ts 设为 255s），
    //     且原 15s 与 Bun 默认空闲超时 10s 冲突，导致连接被提前关闭。
    SSE_HEARTBEAT_MS: parseInt(Bun.env.SSE_HEARTBEAT_MS || "10000", 10) || 10000,
    // [需求域 T / T-06] 工具结果总长度上限：默认 32000；非法/缺失回退默认值（防 parseInt 返回 NaN）
    TOOL_RESULT_MAX_CHARS:
      parseInt(Bun.env.TOOL_RESULT_MAX_CHARS || "32000", 10) || 32000,

    // [需求域 R / US-R-01] 互联网工具配置（可选，带默认值；缺失/非法一律回退，不退出进程）
    //   总开关：默认开启，仅显式 "false" 才关闭（与 FILE_READ_ENABLED 语义一致）
    INTERNET_ENABLED: Bun.env.INTERNET_ENABLED !== "false",
    //   供应商选择：空值回退 deepseek；非法值不在此处拦截，由工具调用时返回 invalid_provider（R-12）
    INTERNET_SEARCH_PROVIDER: Bun.env.INTERNET_SEARCH_PROVIDER || "deepseek",
    INTERNET_FETCH_PROVIDER: Bun.env.INTERNET_FETCH_PROVIDER || "deepseek",
    //   密钥：按供应商独立，空串 = 免鉴权（R-11）；默认空，**不设全局回退**（X-06）
    INTERNET_DEEPSEEK_API_KEY: Bun.env.INTERNET_DEEPSEEK_API_KEY || "",
    //   基址/端点路径：允许覆盖，便于接自建网关（R-08 第 1 类差异）
    //   ✅ 端点已按 DeepSeek 官方文档核实（2026-10-21）：Search = /v1/tools/search，Fetch = /v1/tools/fetch。
    //      旧默认值 /v1/search、/v1/fetch 在官方不存在 → 稳定 404 → not_extractable（见 FIX 文档）。
    INTERNET_DEEPSEEK_BASE_URL: Bun.env.INTERNET_DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    INTERNET_DEEPSEEK_SEARCH_PATH: Bun.env.INTERNET_DEEPSEEK_SEARCH_PATH || "/v1/tools/search",
    INTERNET_DEEPSEEK_FETCH_PATH: Bun.env.INTERNET_DEEPSEEK_FETCH_PATH || "/v1/tools/fetch",
    //   默认条数：代码侧最终仍会钳制到 1–10（R-18）
    INTERNET_DEFAULT_COUNT: parseInt(Bun.env.INTERNET_DEFAULT_COUNT || "5", 10) || 5,
    INTERNET_TIMEOUT_MS: parseInt(Bun.env.INTERNET_TIMEOUT_MS || "20000", 10) || 20000,
    INTERNET_FETCH_MAX_CHARS: parseInt(Bun.env.INTERNET_FETCH_MAX_CHARS || "8000", 10) || 8000,
    //   暂存四要素（R-30）：TTL / 单会话条数 / 单条字符 / 全局字符
    INTERNET_STORE_TTL_S: parseInt(Bun.env.INTERNET_STORE_TTL_S || "300", 10) || 300,
    INTERNET_STORE_MAX_ITEMS_PER_SESSION:
      parseInt(Bun.env.INTERNET_STORE_MAX_ITEMS_PER_SESSION || "8", 10) || 8,
    INTERNET_STORE_MAX_CHARS_PER_ITEM:
      parseInt(Bun.env.INTERNET_STORE_MAX_CHARS_PER_ITEM || "200000", 10) || 200000,
    INTERNET_STORE_MAX_CHARS_TOTAL:
      parseInt(Bun.env.INTERNET_STORE_MAX_CHARS_TOTAL || "4194304", 10) || 4194304,

    // [需求域 BR / US-BR-01] 浏览器工具配置（25 项，缺失/非法一律回退默认，不退出进程，BR-61）
    //   总开关：默认关闭（BR-51）；[FIX-SILENT-01] 容错 true/1/yes/on，无法识别时取默认并告警
    BROWSER_ENABLED: parseBoolLoose(Bun.env.BROWSER_ENABLED, false, "BROWSER_ENABLED"),
    //   可执行文件：auto（或留空）= 自动探测 Edge → Chrome；显式路径必须存在，否则启动失败并列出已尝试路径
    BROWSER_EXECUTABLE_PATH: (Bun.env.BROWSER_EXECUTABLE_PATH || "auto").trim() || "auto",
    //   [REQ-browser BR-10] 置前：默认开启（显式 false/0/no/off 才关）；不进配置页（需求 §5）
    BROWSER_FOREGROUND_ON_OPEN: parseBoolLoose(
      Bun.env.BROWSER_FOREGROUND_ON_OPEN,
      true,
      "BROWSER_FOREGROUND_ON_OPEN"
    ),
    //   无头：默认开启；[FIX-SILENT-01] 容错 false/0/no/off（写 False 也认）
    BROWSER_HEADLESS: parseBoolLoose(Bun.env.BROWSER_HEADLESS, true, "BROWSER_HEADLESS"),
    //   调试端口：0 = 随机（**合法语义**，不得被「0 取默认」吞掉，见 parseDebugPort）
    BROWSER_DEBUG_PORT: parseDebugPort(Bun.env.BROWSER_DEBUG_PORT),
    BROWSER_PROFILE_MODE: parseProfileMode(Bun.env.BROWSER_PROFILE_MODE),
    BROWSER_PROFILE_DIR: (Bun.env.BROWSER_PROFILE_DIR || "").trim(),
    BROWSER_SESSION_TTL_S: numOr(Bun.env.BROWSER_SESSION_TTL_S, 180, 10, 86400),
    BROWSER_MAX_SESSIONS: numOr(Bun.env.BROWSER_MAX_SESSIONS, 2, 1, 10),
    //   [REQ-browser BR-22/NB-04] 标签上限：默认 10，钳制到 1–20；=1 即「退回单标签语义」的回滚旋钮
    BROWSER_MAX_TABS: numOr(Bun.env.BROWSER_MAX_TABS, 10, 1, 20),
    BROWSER_ACTION_TIMEOUT_MS: numOr(Bun.env.BROWSER_ACTION_TIMEOUT_MS, 8000, 500, 120000),
    BROWSER_NAV_TIMEOUT_MS: numOr(Bun.env.BROWSER_NAV_TIMEOUT_MS, 20000, 1000, 300000),
    BROWSER_STABLE_WINDOW_MS: numOr(Bun.env.BROWSER_STABLE_WINDOW_MS, 400, 0, 5000),
    BROWSER_SNAPSHOT_MAX_ELEMENTS: numOr(Bun.env.BROWSER_SNAPSHOT_MAX_ELEMENTS, 120, 1, 1000),
    BROWSER_SNAPSHOT_MAX_CHARS: numOr(Bun.env.BROWSER_SNAPSHOT_MAX_CHARS, 6000, 200, 12000),
    //   [REQ-browser BR-33] extract：回灌上限默认 12000（硬上限 24000，见 HARD_MAX_CHARS），清单默认 20 条
    BROWSER_EXTRACT_MAX_CHARS: numOr(Bun.env.BROWSER_EXTRACT_MAX_CHARS, 12000, 500, 24000),
    BROWSER_EXTRACT_MAX_ELEMENTS: numOr(Bun.env.BROWSER_EXTRACT_MAX_ELEMENTS, 20, 1, 200),
    BROWSER_MAX_ACTIONS: numOr(Bun.env.BROWSER_MAX_ACTIONS, 10, 1, 30),
    BROWSER_DOMAIN_ALLOWLIST: (Bun.env.BROWSER_DOMAIN_ALLOWLIST || "").trim(),
    BROWSER_DOMAIN_BLOCKLIST: (Bun.env.BROWSER_DOMAIN_BLOCKLIST || "").trim(),
    //   私有网段阻断：默认开启（[R-02] 走容错解析，写 False/0/off 也认）
    BROWSER_BLOCK_PRIVATE_NET: parseBoolLoose(
      Bun.env.BROWSER_BLOCK_PRIVATE_NET,
      true,
      "BROWSER_BLOCK_PRIVATE_NET"
    ),
    //   [R-02] 下载/上传：默认关闭（走容错解析，写 True/1/yes 也认）
    BROWSER_ALLOW_DOWNLOAD: parseBoolLoose(Bun.env.BROWSER_ALLOW_DOWNLOAD, false, "BROWSER_ALLOW_DOWNLOAD"),
    BROWSER_ALLOW_UPLOAD: parseBoolLoose(Bun.env.BROWSER_ALLOW_UPLOAD, false, "BROWSER_ALLOW_UPLOAD"),
    //   拖拽步数：下限强制 10（步数过小会被拖拽库判定为点击，BR-22）
    BROWSER_DRAG_STEPS: Math.max(10, numOr(Bun.env.BROWSER_DRAG_STEPS, 12, 10, 60)),
    BROWSER_TYPE_DELAY_MS: numOr(Bun.env.BROWSER_TYPE_DELAY_MS, 0, 0, 100),
  };
}

// 在模块加载时立即加载 .env（必须在 validateEnv 之前执行）
loadDotenv();

/**
 * [配置页 / US-CFG-PAGE-7] 被系统环境变量遮蔽的键（启动快照，只读）。
 * 局限：运行中修改 OS 环境变量后需重启才准确（与需求 §4.9.4 一致）。
 */
export const envShadowedBySystem: ReadonlySet<string> = shadowedKeys;

/** 类型安全的全局配置对象（单例）。热更请用 reloadEnvExcluding()，勿重新赋值。 */
export const env = validateEnv();

/**
 * [FIX-BOOT-04] .env 结构性异常嗅探（只告警，不改值）。
 *
 * 现场故障（2026-10-22）：`.env` 里原本已有 `BROWSER_ENABLED=true`，
 * 之后又把 `.env.example` 的整段浏览器配置块追加到文件末尾，而示例块里是
 * `BROWSER_ENABLED=false` —— 同名键出现两次，**后者覆盖前者**，
 * 于是「我明明改成 true 了」与「工具就是不出现」同时成立，且没有任何提示。
 *
 * 这里把两类会被静默吃掉的情况显式喊出来：
 *   ① 同名键重复且取值不同 —— 说明最后一行才生效；
 *   ② 值里带行内注释（` #` 之后）—— 布尔类配置会解析失败（见 normalizeBoolText）。
 */
function detectEnvAnomalies(): void {
  const envPath = resolve(import.meta.dir, "../../.env");
  let text: string;
  try {
    text = readFileSync(envPath, "utf-8");
  } catch {
    return; // .env 不存在时 loadDotenv 已告警
  }

  const seen = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    const list = seen.get(key);
    if (list) list.push(value);
    else seen.set(key, [value]);
  }

  for (const [key, values] of seen) {
    if (values.length < 2) continue;
    const first = values[0] ?? "";
    const last = values[values.length - 1] ?? "";
    if (first === last) continue;
    console.warn(
      `⚠️  [.env] ${key} 出现了 ${values.length} 次且取值不同，实际生效的是最后一行（"${last}"）；` +
        `第一行是 "${first}"。请删掉多余的那一行，否则会出现「改了却不生效」。`
    );
  }

  for (const [key, values] of seen) {
    const last = (values[values.length - 1] ?? "").trim();
    // [FIX-QUOTE-CMT-01] 判据必须与解析同一口径：引号内的 `#` 不算注释，
    //   否则 `KEY="a # b"`（密码/URL 带 #）会被误报「含行内注释」。
    if (stripInlineComment(last) === last) continue;
    // 只提示布尔/数值这类「不该带注释」的键，避免对路径、密钥类误报
    // [REQ-browser BR-10] 补 _ON_OPEN：新键以 _ON_OPEN 结尾，不命中原有分组，
    //   否则 `BROWSER_FOREGROUND_ON_OPEN=true   # 开` 这类写法不会被告警（解析仍正确，只是少了提示）
    if (!/(_ENABLED|_HEADLESS|_PRIVATE_NET|_ALLOW_[A-Z]+|_THINKING|_ON_OPEN)$/.test(key)) continue;
    console.warn(
      `⚠️  [.env] ${key} 的值里含行内注释，实际解析按注释前的部分处理（原始值 "${last}"）。` +
        `建议把注释单独写一行，避免歧义。`
    );
  }
}

detectEnvAnomalies();

/**
 * [修订 / R-45] 拼接「基址 + 端点路径」，仅用于启动摘要展示。
 * 与 `etc/tools/internet/_common.ts` 的 joinUrl 同规则（去尾斜杠 / 补首斜杠），
 * 让「实际会被请求的完整地址」在启动日志里一眼可见——端点配错时无需再猜。
 */
function joinEndpoint(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

// 启动日志（隐藏敏感信息）
console.log("=".repeat(60));
console.log("✅ 环境变量校验通过");
console.log("-".repeat(60));
console.log(`  APP_PORT:              ${env.APP_PORT}`);
console.log(`  LLM_API_BASE:          ${env.LLM_API_BASE}`);
console.log(`  LLM_MODEL:             ${env.LLM_MODEL}`);
console.log(`  LLM_API_KEY:           ${env.LLM_API_KEY ? "******" : "未设置"}`);
console.log(`  LLM_THINKING_MODE:     ${env.LLM_THINKING_MODE}（${THINKING_MODE_LABEL[env.LLM_THINKING_MODE]}）`);
console.log(`  LLM_THINKING:          ${env.LLM_THINKING ? "开启" : "关闭"}（仅取值来源）`);
console.log(`  LLM_REASONING_EFFORT:  ${env.LLM_REASONING_EFFORT}（仅取值来源）`);
// [US-CFG-1] 文件工具配置（无敏感信息，直接打印）
console.log("-".repeat(60));
console.log(`  FILE_ROOT_DIR:         ${env.FILE_ROOT_DIR}`);
console.log(`  FILE_READ_ENABLED:     ${env.FILE_READ_ENABLED ? "开启" : "关闭"}`);
console.log(`  FILE_CREATE_ENABLED:   ${env.FILE_CREATE_ENABLED ? "开启" : "关闭"}`);
console.log(`  FILE_MODIFY_ENABLED:   ${env.FILE_MODIFY_ENABLED ? "开启" : "关闭"}`);
// [批次一 / FR-38] 区间读取默认行数（不进配置页，手工维护）。原始值一并打印，便于排查「写了 0」的情况
console.log(
  `  FILE_READ_DEFAULT_LINES: ${env.FILE_READ_DEFAULT_LINES}（区间模式默认行数；原始值=${
    Bun.env.FILE_READ_DEFAULT_LINES === undefined
      ? "未设置"
      : JSON.stringify(Bun.env.FILE_READ_DEFAULT_LINES)
  }）`,
);

// [批次三 / SH-49] 命令执行生效摘要：权限档位、shell、两个超时、审批等待、记忆开关、
//   输出上限、命令长度上限、编码、拒绝清单条数、允许清单是否启用。不含任何敏感值与已授权命令。
console.log("-".repeat(60));
console.log(`  SHELL_PERMISSION:      ${env.SHELL_PERMISSION}（${SHELL_PERMISSION_LABEL[env.SHELL_PERMISSION]}）`);
console.log(`  SHELL_TYPE:            ${env.SHELL_TYPE}`);
console.log(
  `  SHELL 超时:            默认=${env.SHELL_TIMEOUT_DEFAULT_MS}ms｜上限=${env.SHELL_TIMEOUT_MAX_MS}ms｜审批等待=${env.SHELL_APPROVAL_WAIT_MS}ms`,
);
console.log(
  `  SHELL 会话记忆:        ${env.SHELL_SESSION_MEMORY_ENABLED ? "开启" : "关闭（逐次询问）"}` +
    `｜「所有命令」选项=${env.SHELL_ALLOW_ALL_OPTION ? "提供" : "不提供"}` +
    `｜拒绝冷却=${env.SHELL_DENY_COOLDOWN_MS}ms`,
);
console.log(
  `  SHELL 上限:            输出=${env.SHELL_OUTPUT_MAX_CHARS} 字符｜命令长度=${env.SHELL_MAX_COMMAND_CHARS} 字符｜并发=${env.SHELL_MAX_CONCURRENCY}`,
);
console.log(
  `  SHELL 编码:            ${env.SHELL_UTF8_UNIFY ? "UTF-8 优先（解码失败回退控制台码页并显式告知）" : "仅按控制台码页解码"}`,
);
console.log(
  `  SHELL 清单:            拒绝清单=${env.SHELL_DENY_LIST.split(",").filter((s) => s.trim() !== "").length} 条` +
    `｜允许清单=${env.SHELL_ALLOW_LIST.toLowerCase() === "none" ? "未启用" : "已启用（只放行首 token 命中的命令）"}`,
);
// [SH-31] 关闸/开闸提示：档位含义必须写在启动日志里，避免「为什么模型不执行命令」无从排查
if (env.SHELL_PERMISSION === "forbid") {
  console.log("  ⚠️  命令执行未启用：run 工具不在模型可见列表内，模型收到「执行命令」只会说做不到。");
  console.log("      启用方式二选一：① 配置页 › 本机命令执行配置 › 权限档位 → 需用户同意（保存即生效）；");
  console.log("      ② .env 写入 SHELL_PERMISSION=ask 后重启。注意 allow 档等于把本机命令行完全交给模型。");
} else {
  console.log("  ⚠️  命令执行已启用：命令以服务进程权限在本机真实执行，cwd 守卫不是沙箱，命令可访问任意路径与网络。");
  if (env.SHELL_PERMISSION === "allow") {
    console.log("      ⚠️  当前为 allow 档：不再有任何人工闸门，任何命令都会被直接执行。");
  }
}

// [Sprint 5.1 / US-LOG-1] LLM 对话日志配置（无敏感信息，直接打印）
console.log("-".repeat(60));
console.log(`  LLM_LOG_ENABLED:       ${env.LLM_LOG_ENABLED ? "开启" : "关闭"}`);
console.log(`  LLM_LOG_FILE:          ${env.LLM_LOG_FILE}`);
console.log(`  LLM_LOG_MAX_ROWS:      ${env.LLM_LOG_MAX_ROWS}`);
// [Sprint 5.2 / US-STAB-3] 复杂问题稳定性配置（无敏感信息，直接打印）
console.log("-".repeat(60));
console.log(`  MAX_TOOL_ROUNDS:       ${env.MAX_TOOL_ROUNDS}`);
console.log(`  SSE_HEARTBEAT_MS:      ${env.SSE_HEARTBEAT_MS}`);
// [需求域 T / T-06] 平台兜底：工具结果总长度上限（无敏感信息）
console.log(`  TOOL_RESULT_MAX_CHARS: ${env.TOOL_RESULT_MAX_CHARS}（工具结果回灌前的截断上限）`);
// [需求域 R / R-45] 互联网工具生效配置摘要（密钥打掩码；未配置时说明将按免鉴权调用）
console.log("-".repeat(60));
console.log(`  INTERNET_ENABLED:      ${env.INTERNET_ENABLED ? "开启" : "关闭"}`);
console.log(`  INTERNET 供应商:       search=${env.INTERNET_SEARCH_PROVIDER} / fetch=${env.INTERNET_FETCH_PROVIDER}`);
console.log(
  `  INTERNET_DEEPSEEK_API_KEY: ${env.INTERNET_DEEPSEEK_API_KEY ? "******" : "未设置（将按免鉴权调用）"}`
);
console.log(`  INTERNET 基址:         ${env.INTERNET_DEEPSEEK_BASE_URL}`);
// [修订] 启动即打印「拼好的完整端点」：端点配错是历史上最难定位的一类故障（见 docs/FIX-internet-endpoint-v0.0.7.md）
console.log(
  `  INTERNET 检索端点:     ${joinEndpoint(env.INTERNET_DEEPSEEK_BASE_URL, env.INTERNET_DEEPSEEK_SEARCH_PATH)}`
);
console.log(
  `  INTERNET 抓取端点:     ${joinEndpoint(env.INTERNET_DEEPSEEK_BASE_URL, env.INTERNET_DEEPSEEK_FETCH_PATH)}`
);
console.log(`  INTERNET 超时/回灌上限: ${env.INTERNET_TIMEOUT_MS}ms / ${env.INTERNET_FETCH_MAX_CHARS} 字符`);
console.log(
  `  INTERNET 暂存:         TTL=${env.INTERNET_STORE_TTL_S}s｜单会话=${env.INTERNET_STORE_MAX_ITEMS_PER_SESSION} 条｜单条=${env.INTERNET_STORE_MAX_CHARS_PER_ITEM} 字符｜全局=${env.INTERNET_STORE_MAX_CHARS_TOTAL} 字符`
);
// [需求域 BR / BR-63] 浏览器工具生效摘要（不含任何敏感值）
console.log("-".repeat(60));
console.log(
  `  BROWSER_ENABLED:       ${env.BROWSER_ENABLED ? "开启" : "关闭"}` +
    `（.env 原始值=${
      Bun.env.BROWSER_ENABLED === undefined ? "未设置" : JSON.stringify(Bun.env.BROWSER_ENABLED)
    }）`
);
console.log(
  `  BROWSER_EXECUTABLE:    ${
    env.BROWSER_EXECUTABLE_PATH.toLowerCase() === "auto"
      ? "自动探测（Edge → Chrome）"
      : env.BROWSER_EXECUTABLE_PATH
  }`
);
console.log(
  `  BROWSER 窗口:          ${env.BROWSER_HEADLESS ? "无头" : "有头（显示窗口）"}` +
    `（原始值=${
      Bun.env.BROWSER_HEADLESS === undefined ? "未设置" : JSON.stringify(Bun.env.BROWSER_HEADLESS)
    }）` +
    // [REQ-browser BR-10] 置前开关：用户反馈「窗口还是在后面」时，第一眼看的就是这一行
    `｜置前=${env.BROWSER_FOREGROUND_ON_OPEN ? "开启" : "关闭"}`
);
console.log(
  `  BROWSER profile:       ${
    env.BROWSER_PROFILE_MODE === "persist"
      ? `持久${env.BROWSER_PROFILE_DIR ? `（${env.BROWSER_PROFILE_DIR}）` : "（未配置目录，将回退临时并告警）"}`
      : "临时（关闭即删）"
  }`
);
console.log(`  BROWSER 调试端口:      ${env.BROWSER_DEBUG_PORT === 0 ? "随机分配" : env.BROWSER_DEBUG_PORT}`);
console.log(
  `  BROWSER 超时:          单步=${env.BROWSER_ACTION_TIMEOUT_MS}ms｜导航=${env.BROWSER_NAV_TIMEOUT_MS}ms｜稳定窗口=${env.BROWSER_STABLE_WINDOW_MS}ms`
);
console.log(
  `  BROWSER 快照:          元素=${env.BROWSER_SNAPSHOT_MAX_ELEMENTS} 个｜正文=${env.BROWSER_SNAPSHOT_MAX_CHARS} 字符｜单次动作=${env.BROWSER_MAX_ACTIONS} 个`
);
// [REQ-browser BR-33] extract 的两个上限与快照分列：调大取文不该顺带撑爆快照，一眼能看出各自的值
console.log(
  `  BROWSER 取文(extract): 单次=${env.BROWSER_EXTRACT_MAX_CHARS} 字符｜清单=${env.BROWSER_EXTRACT_MAX_ELEMENTS} 个`
);
// [REQ-browser BR-27] 工具面 4 → 5：关闸提示里补上 extract，避免用户以为只有四个工具
console.log(
  `  BROWSER 域名策略:      白名单=${
    env.BROWSER_DOMAIN_ALLOWLIST || "空（不额外限制）"
  }｜黑名单=${env.BROWSER_DOMAIN_BLOCKLIST || "空"}｜私有网段阻断=${
    env.BROWSER_BLOCK_PRIVATE_NET ? "开启" : "关闭"
  }`
);
console.log(
  `  BROWSER 下载/上传:     ${env.BROWSER_ALLOW_DOWNLOAD ? "允许下载" : "拒绝下载"} / ${
    env.BROWSER_ALLOW_UPLOAD ? "允许上传" : "拒绝上传"
  }`
);
console.log(
  `  BROWSER 会话:          空闲 TTL=${env.BROWSER_SESSION_TTL_S}s｜并发上限=${env.BROWSER_MAX_SESSIONS}｜标签上限=${env.BROWSER_MAX_TABS}${env.BROWSER_MAX_TABS <= 1 ? "（单标签模式）" : ""}｜拖拽步数=${env.BROWSER_DRAG_STEPS}`
);
// [FIX-SILENT-02] 关闸时把「为什么会什么也没发生」写在启动日志里：
//   开关关闭 → 四个工具不在模型可见列表，模型连拒绝的理由都拿不到。
if (!env.BROWSER_ENABLED) {
  console.log("  ⚠️  浏览器工具未启用：open/observe/act/extract/close 五个工具不在模型可见列表内，");
  console.log("      模型收到「打开浏览器」只会说做不到，不会产生任何浏览器动作。启用方式二选一：");
  console.log("      ① 配置页 › 浏览器工具配置 › 浏览器工具总开关 → 打开（保存即生效，无需重启）");
  console.log("      ② .env 写入 BROWSER_ENABLED=true 后重启");
  console.log("      如需亲眼看到浏览器窗口，再设 BROWSER_HEADLESS=false（默认无头，窗口不可见）。");
}
console.log("=".repeat(60));

/**
 * [配置页 / US-CFG-PAGE-6] 热更新：重新解析 .env 并就地更新 env 单例。
 *
 * 关键约束（需求 §4.9）：
 * 1. 不走 loadDotenv()——其 `if (!Bun.env[key])` 判空会让重跑变成空操作；
 * 2. 不重新赋值 env——全仓 import 的是同一引用，必须 Object.assign 就地改；
 * 3. skipKeys 内的键保持旧值（如 APP_PORT：端口已绑定、origin.ts 白名单已构造）。
 *
 * @param skipKeys 不参与热更、需重启才生效的键
 * @returns 实际已热更的键列表
 */
export function reloadEnvExcluding(skipKeys: readonly string[] = []): string[] {
  const envPath = resolve(import.meta.dir, "../../.env");
  const skip = new Set(skipKeys);
  const applied: string[] = [];

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return applied;   // .env 不存在：无可热更内容
  }

  // ① 强制覆盖 Bun.env（绕过 loadDotenv 的判空）
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (skip.has(key)) continue;
    Bun.env[key] = value;
    applied.push(key);
  }

  // ② 重新计算并就地更新单例（引用不变）
  const next = validateEnv();
  for (const k of skipKeys) {
    (next as unknown as Record<string, unknown>)[k] = (env as unknown as Record<string, unknown>)[k];
  }
  Object.assign(env, next);

  return applied;
}
