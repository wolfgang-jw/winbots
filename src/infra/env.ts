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
}

/** 必需的环境变量列表 */
const REQUIRED_VARS: (keyof EnvConfig)[] = [
  "APP_PORT",
  "LLM_API_BASE", "LLM_API_KEY", "LLM_MODEL",
];

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
  };
}

// 在模块加载时立即加载 .env（必须在 validateEnv 之前执行）
loadDotenv();

/** 类型安全的全局配置对象（单例） */
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
console.log("=".repeat(60));
