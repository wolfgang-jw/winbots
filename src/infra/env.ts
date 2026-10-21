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
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!Bun.env[key]) {
        Bun.env[key] = value;
      } else if (Bun.env[key] !== value) {
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
