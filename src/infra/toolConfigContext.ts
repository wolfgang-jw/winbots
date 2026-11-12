/**
 * src/infra/toolConfigContext.ts
 * 「当前请求的 agent 工具配置快照」载体（AsyncLocalStorage）。
 *
 * 背景（docs/工具技能配置归位setup与agent权限收紧-需求文档.md §3.2 / 代码文档 4.2）：
 *   改造前，工具开关 / 工具设置项 / 技能开关只有**一份全局值**（env.json 的 tools 块），
 *   所以 `settings.ts` 可以直接从文件里读。改造后这三类配置是**每个 agent 一份**
 *   （`etc/agents/<path>/setup.json`），同一进程内不同请求要用不同 agent 的值。
 *
 * 方案：请求入口把「本请求的 agent 配置快照」放进 AsyncLocalStorage，
 *   `settings.ts` 的读取函数签名与调用点**一行都不用改**，只换数据来源：
 *     isToggleOn / currentSettingText / readSetting / secretSettingValues / groupState
 *   全部改读 `currentAgentToolConfig()`。
 *
 * ⚠️ 最重要的约定（漏一处就会「工具全部不可用」）：
 *   任何会触发工具/技能读取的**请求入口**都必须包在 `runWithAgentToolConfig(...)` 里。
 *   无上下文时一律按「全关 / 声明里的默认值」处理（保守，绝不放宽）。这是刻意的降级方向：
 *   宁可少给能力，也不要在上下文缺失时意外放行。
 *
 * ⚠️ 依赖约束：本文件**零业务依赖**（只用 node:async_hooks），
 *    这样 settings.ts（被 tools/ 与 skills/ 依赖）引入它不会成环。
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 一个 agent 的「工具域配置快照」。
 *
 * 字段全部是**已完成翻译**的形态（不是 setup.json 原始结构）：
 * 由 `agents/toolConfig.ts` 的 `agentToolConfigOf()` 负责从 AgentRecord 翻译过来，
 * 翻译时的键拼装规则必须复用 `@/tools/paths`（dirToggleKey / groupToggleKey / dirSettingKey /
 * groupSettingKey），**不要**在别处自己拼字符串。
 */
export interface AgentToolConfig {
  /** 该 agent 名下的 uid（排查用；不参与任何判定） */
  agentUid: string;
  /** agent 完整相对路径（排查用；不参与任何判定） */
  agentPath: string;
  /**
   * 「已显式开启」的**工具** toggleKey 集合（原 TOOLON__ 语义）。
   * 缺省 / 空集 = 该 agent 没有任何工具可用（BR-1：null 与 [] 同义）。
   */
  enabledToggles: ReadonlySet<string>;
  /**
   * 「已显式配给」的**技能** toggleKey 集合（原 SKILLON__ 语义）。
   * 缺省 / 空集 = 该 agent 没有任何技能可用（BR-2）。
   */
  enabledSkillToggles: ReadonlySet<string>;
  /**
   * 工具设置项的**持久化文本**：`TOOLSET__…` / `etc__tools__…` → 文本。
   *
   * ⚠️ 文本格式必须与 `settings.ts` 的 `parseSettingValue` 同口径
   *    （布尔 "true"/"false"、数组 JSON 文本、其余 String(v)），
   *    由 `@/tools/paths` 的 `formatManagedValue` 统一生成。
   * ⚠️ 缺失 = 不覆盖（用声明里的默认值），**不是**「全禁」。
   */
  settings: ReadonlyMap<string, string>;
}

const als = new AsyncLocalStorage<AgentToolConfig>();

/** 在「某个 agent 的配置快照」下执行一段逻辑（请求入口用） */
export function runWithAgentToolConfig<T>(cfg: AgentToolConfig, fn: () => T): T {
  return als.run(cfg, fn);
}

/**
 * 取当前上下文；无上下文返回 null。
 *
 * ⚠️ 返回 null 表示「本次调用不在任何 agent 的请求上下文里」
 *    （后台定时器 / 单测 / 装配脚本）。调用方必须按「全关 / 默认值」保守处理。
 */
export function currentAgentToolConfig(): AgentToolConfig | null {
  return als.getStore() ?? null;
}

/** 仅供单测：构造一个空上下文（全关 / 无设置项覆盖） */
export function emptyAgentToolConfig(agentUid = "", agentPath = ""): AgentToolConfig {
  return {
    agentUid,
    agentPath,
    enabledToggles: new Set<string>(),
    enabledSkillToggles: new Set<string>(),
    settings: new Map<string, string>(),
  };
}
