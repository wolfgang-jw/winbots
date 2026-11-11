/**
 * src/agents/index.ts
 * agents 子系统门面。**唯一对外出口**（与 src/skills/index.ts、src/tools/index.ts 的分工一致）。
 *
 * ⚠️ 第 2 步此文件**没有任何运行期调用方**。它存在是为了让后续 7 个模块
 *    都对着同一个出口写，避免各自 import 内部文件、绕过单例。
 */
export type {
  AgentRecord, AgentRegistry, AgentSetup, AgentUid, AgentSkillsMode,
  SetupResult, SetupErrorCode,
} from "./types";

export {
  checkAgentName, checkAgentPath, agentDepth, agentLeafName,
  isDefaultAgentPath, isAgentUid, generateAgentUid,
  AGENTS_ROOT, AGENT_FILE, SETUP_FILE,
  MAX_AGENT_DEPTH, AGENT_BODY_WARN_BYTES,
  AGENT_NAME_RE, AGENT_NAME_MAX_LEN, AGENT_UID_RE,
  type AgentNameCheck,
} from "./paths";

export {
  parseAgentSetup,
  SYSTEM_BUDGET_DEFAULT, MAX_ROUNDS_MIN, MAX_ROUNDS_MAX,
  type ParseSetupOpts,
} from "./setup";

export { matchWildcard, matchesAny } from "./match";

export {
  ensureAgentRegistry, getAgentRegistry, isAgentRegistryReady,
  emptyAgentRegistry,
  walkAgentFiles, computeAgentFingerprint, scanAgentsOnce,
  resetAgentRegistryForTest,
  type ScanDeps, type Stamp,
} from "./scan";

// ── 第 3 步（模块 4：技能过滤）──────────────────────────────────────────
// 通配实现仍只在 ./match 里一份，此处只转发策略层，不重复导出匹配函数。
export {
  resolveSkillPolicy, isSkillAllowedByPolicy, isSkillAllowedForAgent,
  filterSkillsForAgent,
  type SkillRef, type SkillPolicy,
} from "./skillPolicy";

// ── 第 4 步（模块 5：工具过滤）──────────────────────────────────────────
// 通配实现仍只在 ./match 里一份；此处转发策略层与判据容器，不重复导出匹配函数。
// ⚠️ 必须含 `type ToolFilter`：src/tools/index.ts 以 `import type` 从这里取（V1 判据），
//    漏转发会被 __tests__/toolPolicy.test.ts 的 T19 抓到（它逐一断言 10 个符号）。
export {
  resolveToolPolicy, denyAllPolicy, isToolAllowedByPolicy, isToolAllowedForAgent,
  filterToolsForAgent, toolFilterOf, denyAllToolFilter, isToolAllowedByFilter,
  toolNotAllowed, toolNotAllowedAgentUnavailable,
  type ToolRef, type ToolPolicy, type ToolFilter,
} from "./toolPolicy";

// ── 第 5 步（模块 3：system 装配与预算）────────────────────────────────
// 只转发装配层，不转发预算实现（预算的唯一口径在 @/skills 的 budget.ts）。
export {
  buildSystemText, fitSystemBudget,
  type PersonaPart, type BuildSystemParts, type BuiltSystem,
} from "./prompt";

// ── 第 6 步（模块 2：会话绑定与生命周期）────────────────────────────────
// 只转发绑定解析；存储侧（getSessionAgentBinding / bindSessionAgent）在 @/infra/session，
// 不在此处转发 —— agents/ 不得在运行期依赖存储层（见 binding.ts 的依赖约束）。
// ⚠️ 不要在这里重复转发 denyAllToolFilter / toolFilterOf：第 4 步的 toolPolicy 块已导出，
//    重复 export 会报 "Module has already exported a member named"。
export {
  resolveBinding,
  type BindingResolution,
} from "./binding";

// ── 第 7 步（模块 6a：LLM 解析）────────────────────────────────────────
// 只转发查表纯函数；llm[] 由调用方注入（本文件不 import @/infra/envJson）。
export {
  resolveLlm, DEFAULT_LLM_NAME,
  type ResolvedLlm,
} from "./llmResolve";
