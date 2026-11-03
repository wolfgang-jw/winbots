import { readFileSync } from "fs";
// [规范 §9.1] 热重载白名单 = 系统项 ∪ 本次扫描注册键；托管键一律不进进程环境
import { CONFIG_KEY_SET } from "./configFile";
import { hasManagedPrefix } from "@/tools/paths";
import { resolve } from "path";

/**
 * 环境变量校验与类型安全导出
 *
 * 职责：
 * 1. 在应用启动时校验所有必需的环境变量
 * 2. 将 Bun.env 的字符串值转换为正确的类型（number 等）
 * 3. 导出不可变的配置对象供其他模块使用
 * 4. 缺失变量时打印清晰错误并终止进程
 *
 * [规范 §7.3 / §13 / C-06-1] **本文件只持有系统项**。
 *   文件工具 / 命令执行 / 互联网 / 浏览器 / read_file 默认行数等**工具域配置已全部下沉**
 *   到 `etc/tools/**` 的 `settings` 声明（目录项 + 组项），取值统一走 `src/infra/settings.ts`
 *   （`dirScope` / `groupScope` / `readSetting`）。
 *   ⚠️ 这里**刻意不保留**任何「兼容字段」，也不保留任何工具域的默认值与解析函数：
 *      §3.2 要求默认值单一来源，留一份就是埋一个「改了不生效」的坑（字段没人读、日志却还在报旧值）。
 *   ⚠️ 不要再往本文件加工具配置；要加就写进对应目录的 `_settings.ts` 或出口文件的 `settings` 导出。
 *   自检命令：`grep -rn "env\.BROWSER_\|env\.SHELL_\|env\.INTERNET_\|env\.FILE_" src/ etc/tools/` 必须为空。
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

/* ============================================================
 * 原文归一化（.env 手工编辑容错）
 * ============================================================ */

/**
 * [FIX-BOOT-03] 布尔原文归一化：剥掉成对引号与行内注释，再小写。
 *
 * 起因（现场故障 2026-10-22 第二例）：用户照抄示例把值写成
 *   LLM_THINKING=true      # 打开
 * 或
 *   LLM_THINKING="true"
 * 旧实现直接把整串拿去比较，`true      # 打开` 不等于任何真值词，于是判为「关」。
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

/* ============================================================
 * 配置结构（仅系统项）
 * ============================================================ */

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

  // [规范 §7.3 / §13] 文件工具 / 命令执行 / 互联网 / 浏览器 / read_file 默认行数的配置
  //   **全部**已下沉到 `etc/tools/**` 的 `settings` 声明（目录项 + 组项），本文件不再持有任何工具域字段。
  //   取值统一走 `src/infra/settings.ts`（`dirScope` / `groupScope` / `readSetting`）。
  //   ⚠️ 这里**刻意不保留**任何「兼容字段」：§3.8「无过渡层」。

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
 * 固定路径：winbots/.env（相对于当前文件 src/infra/../.env）
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
 * 现场故障（2026-10-22）：`.env` 里原本已有一个键，之后又把 `.env.example` 的整段配置块
 * 追加到文件末尾，而示例块里取值不同 —— 同名键出现两次，**后者覆盖前者**，
 * 于是「我明明改了」与「就是不生效」同时成立，且没有任何提示。
 *
 * 这里把两类会被静默吃掉的情况显式喊出来：
 *   ① 同名键重复（**不限是否托管键**）—— 说明最后一行才生效；
 *   ② 值里带行内注释（` #` 之后）—— 布尔类配置会解析失败（见 stripInlineComment）。
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
    //   （托管键 TOOLON__* / TOOLSET__* 的布尔项同样适用，故正则按后缀匹配、不绑定具体键名）
    if (!/(_ENABLED|_HEADLESS|_PRIVATE_NET|_ALLOW_[A-Z]+|_THINKING|_ON_OPEN)$/.test(key)) continue;
    console.warn(
      `⚠️  [.env] ${key} 的值里含行内注释，实际解析按注释前的部分处理（原始值 "${last}"）。` +
        `建议把注释单独写一行，避免歧义。`
    );
  }
}

detectEnvAnomalies();

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

// [C-06-4 / 规范 §8.2 / §8.7] 工具域配置已全部下沉，本文件既不持有也不打印其取值。
//   升级后的初始态是「全部关闭」（§8.2），必须显式提示「去哪里开」，
//   否则用户会把「工具全没了」当成故障并回滚（§9.2 第一条风险）。
console.log("-".repeat(60));
console.log("  工具配置：已全部下沉到配置页（也可在 .env 手写 TOOLON__* / TOOLSET__* / etc__tools__*）");
console.log("  ⚠️  当前所有工具组均为「关闭」或「未开启」：请在配置页按 目录 → 工具组 逐级开启（保存即生效）。");
console.log("      每次请求的可见工具数与排除原因见日志 🧰 [T-VIS]；私有模块（_ 前缀）改动需重启进程。");
console.log("=".repeat(60));

/**
 * [配置页 / US-CFG-PAGE-6] 热更新：重新解析 .env 并就地更新 env 单例。
 *
 * 关键约束（需求 §4.9）：
 * 1. 不走 loadDotenv()——其 `if (!Bun.env[key])` 判空会让重跑变成空操作；
 * 2. 不重新赋值 env——全仓 import 的是同一引用，必须 Object.assign 就地改；
 * 3. skipKeys 内的键保持旧值（如 APP_PORT：端口已绑定、origin.ts 白名单已构造）。
 *
 * @param skipKeys    不参与热更、需重启才生效的键
 * @param allowedKeys 本次扫描注册的键（工具托管键；缺省表示只允许系统项）
 * @returns 白名单热重载回执（applied / skipped / managed）
 */
export function reloadEnvExcluding(
  skipKeys: readonly string[] = [],
  allowedKeys?: Iterable<string>,
): EnvReloadResult {
  const envPath = resolve(import.meta.dir, "../../.env");
  const skip = new Set(skipKeys);
  const applied: string[] = [];
  const skipped: string[] = [];
  const managed: string[] = [];
  // [§9.1] 白名单 = 系统项 ∪ 本次扫描注册键
  const whitelist = new Set<string>(CONFIG_KEY_SET);
  if (allowedKeys) for (const k of allowedKeys) whitelist.add(k);

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return { applied, skipped, managed };   // .env 不存在：无可热更内容
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
    if (hasManagedPrefix(key)) {
      managed.push(key);          // §7.4：托管键由取值层读 .env，绝不进进程环境
      continue;
    }
    if (!whitelist.has(key)) {
      skipped.push(key);          // §9.1：名单外跳过并告警（同一键只告警一次）
      warnReloadSkipOnce(key);
      continue;
    }
    Bun.env[key] = value;
    applied.push(key);
  }

  // ② 重新计算并就地更新单例（引用不变）
  const next = validateEnv();
  for (const k of skipKeys) {
    (next as unknown as Record<string, unknown>)[k] = (env as unknown as Record<string, unknown>)[k];
  }
  Object.assign(env, next);

  return { applied, skipped, managed };
}

/**
 * [规范 §9.1] 热重载回执：routes/config.ts 原样回给配置页。
 *   applied = 真正注入了进程环境的键
 *   skipped = 名单外、未注入的键（用户手写 / 非系统项 / 非本次注册键）
 *   managed = 托管键（TOOLON__* / TOOLSET__* / etc__tools__*）：不进进程环境，
 *             它们的生效路径是 infra/settings.ts 读取 .env 文件
 */
export interface EnvReloadResult {
  applied: string[];
  skipped: string[];
  managed: string[];
}

/** 名单外键的告警去重集合（同一键只提醒一次，避免每次保存刷屏） */
const warnedReloadSkip = new Set<string>();

/** [§9.1] 名单外键告警；**不输出取值原文**（§8.7） */
function warnReloadSkipOnce(key: string): void {
  if (warnedReloadSkip.has(key)) return;
  warnedReloadSkip.add(key);
  console.warn(
    `⚠️  [env] ${key} 不在热重载白名单内（既非系统项，也非本次扫描注册的键），已跳过，不注入进程环境`,
  );
}
