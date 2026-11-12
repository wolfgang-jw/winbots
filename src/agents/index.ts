/**
 * src/agents/index.ts
 * agents 子系统门面。**唯一对外出口**（与 src/skills/index.ts、src/tools/index.ts 的分工一致）。
 *
 * ⚠️ 第 2 步此文件**没有任何运行期调用方**。它存在是为了让后续 7 个模块
 *    都对着同一个出口写，避免各自 import 内部文件、绕过单例。
 */
export type {
  AgentRecord, AgentRegistry, AgentSetup, AgentUid, AgentSkillsMode, SettingScalar,
  SetupResult, SetupErrorCode,
} from "./types";

export {
  checkAgentName, checkAgentPath, agentDepth, agentLeafName,
  isDefaultAgentPath, isDefaultAgentUid, isAgentUid, generateAgentUid,
  AGENTS_ROOT, AGENT_FILE, SETUP_FILE,
  MAX_AGENT_DEPTH, AGENT_BODY_WARN_BYTES,
  AGENT_NAME_RE, AGENT_NAME_MAX_LEN, AGENT_UID_RE,
  DEFAULT_AGENT_UID, DEFAULT_AGENT_PATH, DEFAULT_AGENT_BODY,
  type AgentNameCheck,
} from "./paths";

export {
  parseAgentSetup,
  SYSTEM_BUDGET_DEFAULT, MAX_ROUNDS_MIN, MAX_ROUNDS_MAX, TOOL_GROUP_KEY_RE,
  type ParseSetupOpts,
} from "./setup";

// ── 「工具/技能配置归位 setup.json」新增（代码文档 4.2 / 4.3）──────────
// 把 AgentRecord 翻译成请求级工具配置快照（AgentToolConfig）。
// ⚠️ 只转发纯函数；注册表结构由调用方注入，避免 agents/ 依赖 tools/skills 的扫描器。
export {
  agentToolConfigOf,
  type ToolGroupInfo, type ToolDirInfo,
} from "./toolConfig";

export { matchWildcard, matchesAny } from "./match";

export {
  ensureAgentRegistry, getAgentRegistry, isAgentRegistryReady,
  emptyAgentRegistry,
  walkAgentFiles, computeAgentFingerprint, scanAgentsOnce,
  resetAgentRegistryForTest,
  agentRegistryStateForTest,
  ensureDefaultAgent,
  type ScanDeps, type Stamp, type EnsureDefaultOpts,
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

// ── 第 8 步（模块 6b：记忆摘要）────────────────────────────────────────
// 只转发「纯逻辑」（拼提示词 / 解析 / 单次 LLM 调用）；
// 数据读写仍在 @/infra/memory，游标推进由 routes/memory.ts 编排 ——
// agents/ 不依赖存储层，这与 binding.ts 的约束一致。
export {
  buildSummarizePrompt, parseSummarizeOutput, callSummarizeLlm,
  type SummarizeMessage, type SummarizeParams, type SummarizeResult,
} from "./memorySummarize";

// ── 第 9 步（模块 7-A13：agent 读写）────────────────────────────────────
// 只转发「文件层」：路径归一/校验 + 读 + 写 + 删。
// HTTP 编排在 routes/agents.ts；本文件不 import @/infra/*，保持 agents 的模块图纯洁。
// ⚠️ 不要转发 AGENTS_ROOT / checkAgentPath 等：paths 块已导出，重复会报
//    "Module has already exported a member named"。
export {
  upsertAgent, deleteAgent, readAgentFile,
  normalizeAgentPath, validateAgentPath, buildSetupJson,
  readAgentUid, guardDefaultAgent,
  type WriteAgentInput, type WriteResult, type AgentFileContent,
} from "./write";
