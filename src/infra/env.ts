/**
 * 配置校验与类型安全导出（迁移后：读 env.json，不再读 Bun.env / .env）
 *
 * 职责：
 * 1. 启动时一次性把 .env 迁移为 env.json（幂等，见 envJson.migrateFromDotenv）
 * 2. 读取并校验 env.json（必需项缺失 → 打印清晰错误并退出）
 * 3. 映射为强类型 EnvConfig（**字段名与迁移前逐字相同**，故所有调用方零改动）
 * 4. 热更时重新读取 env.json 并就地更新单例
 *
 * [规范 §7.3 / §13 / C-06-1] **本文件只持有系统项**。
 *   文件工具 / 命令执行 / 互联网 / 浏览器 / read_file 默认行数等**工具域配置已全部下沉**
 *   到 `etc/tools/**` 的 `settings` 声明（目录项 + 组项），取值统一走 `src/infra/settings.ts`
 *   （`dirScope` / `groupScope` / `readSetting`）。
 *   ⚠️ 这里**刻意不保留**任何「兼容字段」，也不保留任何工具域的默认值与解析函数：
 *      §3.2 要求默认值单一来源，留一份就是埋一个「改了不生效」的坑（字段没人读、日志却还在报旧值）。
 *   ⚠️ 不要再往本文件加工具配置；要加就写进对应目录的 `_settings.ts` 或出口文件的 `settings` 导出。
 *   自检命令：`grep -rn "env\.BROWSER_\|env\.SHELL_\|env\.INTERNET_\|env\.FILE_" src/ etc/tools/` 必须为空。
 *
 * [迁移] 方案 4.3 / 迁移文档 4.3：彻底去掉 Bun.env。`EnvConfig` 的字段名一个不改，
 *   这样 routes/chat、health、llmLog、approval、middleware/origin、index 全部零改动。
 */
// ⚠️ 必须先完成 configFile 的 import 求值：它在模块顶部注册 envJson 的默认值，
//    而下面立刻就要用 loadEnvJson()（顺序颠倒会撞 ERR_ENVJSON_NO_DEFAULTS）。
import { CONFIG_KEY_SET } from "./configFile";
import {
  EnvJsonError, loadEnvJson, managedValues, maybeMigrateOnce, envJsonFilePath,
  defaultLlmIndex, resolveDefaultLlmName,
  type EnvJson, type LlmGroup,
} from "./envJson";
import { DEFAULT_THINKING_MODE, THINKING_MODE_LABEL, type ThinkingMode } from "./thinkingMode";
import { hasManagedPrefix } from "@/tools/paths";

/**
 * [需求域 C / C-04] 思考相关字段的下发方式。
 *
 * ⚠️ 定义已下沉到 ./thinkingMode.ts（纯常量 + 纯函数，零依赖）：
 *    envJson.ts 需要 parseThinkingMode，而 env.ts 又要 import envJson.ts ——
 *    放在本文件会让两者成环（Bun 直跑时报「无法在初始化前访问」）。
 *    这里只做转发，**对外导出面与迁移前完全一致**，调用方一行不用改。
 */
export * from "./thinkingMode";

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

/**
 * 由 EnvJson 映射到 EnvConfig（**字段名与迁移前逐字相同**，故所有调用方零改动）。
 * 映射关系见 envJson.ts 的 CONFIG_KEY_TO_JSON（方案三章 3.2 的表格）。
 *
 * ⚠️ [BR-4] `LLM_*` 的取值来源从「`llm[0]`」改为「**默认组**（app.defaultLlm 指定）」。
 *    默认组缺失 / 指向不存在的组 → defaultLlmIndex 抛 EnvJsonError，
 *    这里**不 catch**：启动期由 dieOnConfig 退出（D-1 选 (a)），
 *    热更期由 reloadEnvExcluding 兜住并保留旧值。
 */
function toEnvConfig(j: EnvJson): EnvConfig {
  const g = j.llm[defaultLlmIndex(j)] as LlmGroup;   // 默认组（找不到即抛错，不回退下标 0）
  return {
    APP_PORT: j.app.port,

    LLM_API_BASE: g.base,
    LLM_API_KEY: g.key,
    LLM_MODEL: g.model,
    LLM_THINKING: g.thinking === true,
    LLM_REASONING_EFFORT: g.reasoningEffort || "high",
    // [需求域 C / C-01~C-05] 下发方式：缺失/非法回退 none；不进 REQUIRED_VARS（§9.1）
    LLM_THINKING_MODE: g.thinkingMode ?? DEFAULT_THINKING_MODE,

    // [Sprint 5.1 / US-LOG-1] LLM 对话日志配置（可选，带默认值）
    LLM_LOG_ENABLED: j.log.enabled === true,
    LLM_LOG_FILE: j.log.file || "data/llm_logs.jsonl",
    LLM_LOG_MAX_ROWS: j.log.maxRows,

    // [Sprint 5.2 / US-STAB-3] 复杂问题稳定性配置（可选，带默认值）
    MAX_TOOL_ROUNDS: j.stab.maxToolRounds,
    //   [Sprint 5.2 / US-STAB-1-FIX] 心跳必须显著小于 Bun.serve 的 idleTimeout（index.ts 设为 255s）
    SSE_HEARTBEAT_MS: j.stab.sseHeartbeatMs,
    // [需求域 T / T-06] 工具结果总长度上限（不进配置页）
    TOOL_RESULT_MAX_CHARS: j.stab.toolResultMaxChars,
  };
}

/** 启动阶段的致命错误：打印后 exit 1（与迁移前一致） */
function dieOnConfig(e: unknown): never {
  const err = e as EnvJsonError;
  console.error("=".repeat(60));
  console.error(`❌ 启动失败：${err?.message ?? String(e)}`);
  if (err?.line !== undefined) console.error(`   位置：第 ${err.line} 行第 ${err.column ?? 1} 列`);
  if (err?.hint) console.error(`   建议：${err.hint}`);
  console.error("=".repeat(60));
  console.error(`   配置文件：${envJsonFilePath()}`);
  console.error(`   配置说明：docs/配置说明.md`);
  process.exit(1);
}

/**
 * [配置页 / US-CFG-PAGE-7 → 迁移后作废] 被系统环境变量遮蔽的键。
 *
 * ⚠️ 迁移后**恒为空集**，仅为兼容既有 import 而保留（routes/config.ts、前端 items[].shadowed 都依赖它的形状）。
 *    原因：遮蔽判据是「Bun.env 已有值与文件值不同」，而 env.json 不再经过 Bun.env（方案 2.3 C1）。
 *    下一轮清理时可连同 routes/config.ts 的传参、ConfigItem.shadowed 字段一起删除。
 */
export const envShadowedBySystem: ReadonlySet<string> = new Set<string>();

// ⚠️ 执行顺序（不能调换）：
//   ① 一次性迁移：.env → env.json（幂等；env.json 已存在时直接返回 null）
//   ② 读取并规整 env.json（必需项缺失 / 语法错误 → dieOnConfig）
//   ③ 映射为 EnvConfig 单例
const migrationResult = maybeMigrateOnce();
if (migrationResult) {
  console.log("=".repeat(60));
  console.log(
    `🚚 [env-json] 已从 .env 迁移 ${migrationResult.systemKeys} 个系统项、` +
    `${migrationResult.toolKeys} 个工具键，原文件保留为 ${migrationResult.backupDotenv}`,
  );
  if (migrationResult.droppedKeys.length > 0) {
    console.log(
      `   §9.2「删除，不迁移」的旧启用开关 ${migrationResult.droppedKeys.length} 个：` +
      `${migrationResult.droppedKeys.join(", ")}（所有目录 / 工具组回到初始关闭，请在配置页重新开启）`,
    );
  }
  if (migrationResult.unmappedKeys.length > 0) {
    console.log(`   另有 ${migrationResult.unmappedKeys.length} 个未识别键保留在 _unmapped，请在配置页「🧹 遗留键」核对`);
  }
  console.log("=".repeat(60));
}

let initialJson: EnvJson;
try {
  initialJson = loadEnvJson();
} catch (e) {
  dieOnConfig(e);
}

/** 类型安全的全局配置对象（单例）。热更请用 reloadEnvExcluding()，勿重新赋值。 */
export const env = toEnvConfig(initialJson);

// 启动日志（隐藏敏感信息；字段与迁移前逐条对应，1.4-1 要求「日志等价」）
console.log("=".repeat(60));
console.log("✅ 配置校验通过（env.json）");
console.log("-".repeat(60));
console.log(`  APP_PORT:              ${env.APP_PORT}`);
// [BR-4] 默认组名必须可见：它是 LLM_* 的取值来源，排查「改了不生效」时先看这一行
console.log(`  LLM 默认组:            ${resolveDefaultLlmName(initialJson)}（LLM_* 的取值来源）`);
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
console.log("  工具配置：已全部下沉到配置页（也可在 env.json 的 tools 块手写 TOOLON__* / TOOLSET__* / etc__tools__*）");
console.log("  ⚠️  当前所有工具组均为「关闭」或「未开启」：请在配置页按 目录 → 工具组 逐级开启（保存即生效）。");
console.log("      每次请求的可见工具数与排除原因见日志 🧰 [T-VIS]；私有模块（_ 前缀）改动需重启进程。");
console.log("  配置说明：docs/配置说明.md（JSON 不支持注释，说明文字都在这里）");
console.log("=".repeat(60));

/**
 * [规范 §9.1] 热重载回执：routes/config.ts 原样回给配置页。
 *   applied = 系统项中**真正发生变化**的键名（迁移后不再有「注入进程环境」这一步）
 *   skipped = 因 skipKeys 跳过、或不在白名单内的键
 *   managed = tools 块里的全部托管键（字段保留以兼容前端；「不进进程环境」已恒成立）
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
    `⚠️  [env] ${key} 不在热重载白名单内（既非系统项，也非本次扫描注册的键），已跳过`,
  );
}

/**
 * [配置页 / US-CFG-PAGE-6] 热更新：重新读取 env.json 并就地更新 env 单例。
 *
 * 与迁移前的差异（方案 4.4）：
 *   · **不再写 Bun.env**（JSON 不经过进程环境）；已核对无其它读取方。
 *   · applied / skipped / managed 三个字段**保留**（前端在用），语义微调见下方注释。
 *
 * 不变量（与迁移前完全一致）：
 *   1. 不重新赋值 env —— 全仓 import 的是同一引用，必须 Object.assign 就地改；
 *   2. skipKeys 内的键保持旧值（如 APP_PORT：端口已绑定、origin.ts 白名单已构造）。
 *
 * @param skipKeys    不参与热更、需重启才生效的键
 * @param allowedKeys 本次扫描注册的键（保留入参以兼容调用方；JSON 模式下只用于**报告** skipped）
 */
export function reloadEnvExcluding(
  skipKeys: readonly string[] = [],
  allowedKeys?: Iterable<string>,
): EnvReloadResult {
  const skip = new Set(skipKeys);
  const applied: string[] = [];
  const skipped: string[] = [];
  const managed: string[] = [];

  // ① 重新读 JSON
  let next: EnvConfig;
  try {
    next = toEnvConfig(loadEnvJson());
  } catch (e) {
    // ⚠️ 热更期配置被改坏：**不改动**当前单例，只告警（进程继续用旧值跑）。
    //    与启动期「失败即退出」不同 —— 运行中炸掉比保持旧配置更糟（§9.2 风险 R-4）。
    console.warn(`⚠️  [env] env.json 读取失败，本次热更已跳过（继续使用内存中的旧配置）：${String(e)}`);
    return { applied, skipped, managed };
  }

  // ② 报告：系统项中「真正发生变化」的键（按 settingKey 名报告，保持前端兼容）
  const cur = env as unknown as Record<string, unknown>;
  const nxt = next as unknown as Record<string, unknown>;
  for (const key of CONFIG_KEY_SET) {
    if (skip.has(key)) { skipped.push(key); continue; }
    if (cur[key] !== nxt[key]) applied.push(key);
  }

  // ③ 托管键（tools 块）：字段语义保留，值 = tools 块里全部「命中托管前缀」的键
  const managedKeys = [...managedValues(true).keys()].filter((k) => hasManagedPrefix(k));
  managed.push(...managedKeys);

  // ④ 名单外的键：仅当调用方显式给了 allowedKeys 时才报告（用于前端提示「手写键未生效」）
  if (allowedKeys) {
    const wl = new Set<string>(CONFIG_KEY_SET);
    for (const k of allowedKeys) wl.add(k);
    for (const k of managedKeys) {
      if (!wl.has(k)) { skipped.push(k); warnReloadSkipOnce(k); }
    }
  }

  // ⑤ 就地更新单例（引用不变），skipKeys 保持旧值
  for (const k of skipKeys) nxt[k] = cur[k];
  Object.assign(env, next);

  return { applied, skipped, managed };
}
