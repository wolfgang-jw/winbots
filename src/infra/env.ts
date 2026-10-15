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

// 启动日志（隐藏敏感信息）
console.log("=".repeat(60));
console.log("✅ 环境变量校验通过");
console.log("-".repeat(60));
console.log(`  APP_PORT:              ${env.APP_PORT}`);
console.log(`  LLM_API_BASE:          ${env.LLM_API_BASE}`);
console.log(`  LLM_MODEL:             ${env.LLM_MODEL}`);
console.log(`  LLM_API_KEY:           ${env.LLM_API_KEY ? "******" : "未设置"}`);
console.log(`  LLM_THINKING:          ${env.LLM_THINKING ? "开启" : "关闭"}`);
console.log(`  LLM_REASONING_EFFORT:  ${env.LLM_REASONING_EFFORT}`);
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
