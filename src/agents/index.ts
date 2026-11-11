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
