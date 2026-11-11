/**
 * src/agents/binding.ts
 * 会话 ↔ agent 绑定解析与降级矩阵（模块 2）。
 *
 * ⚠️ 本文件【不知道存储】：不 import @/infra/session，不做任何 IO。
 *    输入是「会话里存的 agentUid + 当前注册表」，输出是「本轮该怎么装配」。
 *    存储读写留在 session.ts，由 chat.ts 串联。
 *
 * ⚠️ 本文件【不做技能列表过滤】：只产出 SkillPolicy，真正的过滤在
 *    assembleForRequestMulti 的第二参数里执行。理由：不能改它的签名语义
 *    （scripts/verify-agent-compat.ts 无参调用，该脚本是第 1 步等价基线的门禁）。
 *
 * ⚠️ 依赖约束（与本目录其它策略文件的铁律一致）：
 *    只允许 import ./types（仅类型）、./toolPolicy、./skillPolicy。
 *    **禁止** import @/infra/*（会让 agents/ 依赖存储层，verify-agent-compat.ts
 *    载入 @/agents 时会连带建库）、@/skills/*（技能过滤只产出策略）、
 *    @/routes/*、@/infra/env。
 */
import type { AgentRecord, AgentRegistry } from "./types";
import { toolFilterOf, type ToolFilter } from "./toolPolicy";
import { resolveSkillPolicy, type SkillPolicy } from "./skillPolicy";

/**
 * 绑定解析结果（A14 / A17 / A18 的全部情形）。
 *
 * ⚠️ `degraded` 分支**刻意不携带 toolFilter**：让「降级必须配全拒」成为类型层面的强制。
 *    调用方必须显式写 `binding.kind === "degraded" ? denyAllToolFilter() : ...`，
 *    若把 toolFilter 塞进 degraded，调用方可能只写 `case "bound"` + `default` 就混过去。
 */
export type BindingResolution =
  /** 未绑定：走等价路径（A8），人设/技能/工具全部按现状 */
  | { kind: "unbound" }
  /** 正常绑定：人设用快照，技能/工具用实时配置（A15） */
  | {
      kind: "bound";
      agent: AgentRecord;
      /** 人设快照（绑定时刻的 AGENT.md 全文）；"" = 该 agent 无正文 */
      personaText: string;
      /** 实时工具判据（A15「权限侧实时」）—— 交给 getToolDefinitions / executeTool */
      toolFilter: ToolFilter;
      skillPolicy: SkillPolicy;
      systemBudget: number;
      maxRounds: number | null;
      memoryEnabled: boolean;
      /**
       * agent 指定的 LLM 名字（setup.json 的 llm）；null = 未指定，走 env 的默认组。
       * ⚠️ 本字段**只转手**，不在此处查表：llmResolve.resolveLlm 负责按 name 解析，
       *    原因是 binding.ts 不得 import @/infra/*（见文件头依赖铁律 + D-7-1）。
       */
      llmRef: string | null;
    }
  /** 降级：目录被删 / setup 损坏 / uid 重复 → 按未绑定装配，但工具全拒（元工具除外，A17） */
  | { kind: "degraded"; reason: string; personaText: string };

/**
 * 解析会话的绑定。
 *
 * 判据顺序（**不可交换**，逐条对应 A17 降级矩阵）：
 *   1. agentUid 为空                      → unbound（A8 等价路径）
 *   2. 注册表里找不到该 uid                → degraded（目录被删 / 重建换 uid）
 *   3. 找到但 status !== "ok"             → degraded（setup 损坏 / uid 重复）
 *   4. 找到且 ok                          → bound
 *
 * ⚠️ 第 2 条按「uid 找不到」而不是「path 找不到」：
 *   A16 的 uid 双层标识就是为了区分「同名新建」与「删了重建」。
 *   目录删了重建会生成新 uid → 旧会话的 uid 找不到 → 正确降级。
 *   若按 path 找，重建后会误绑到新 agent（人设被悄悄换掉）。
 *
 * @param agentUid        会话里存的 uid（null / "" = 未绑定）
 * @param personaSnapshot 会话里存的人设快照（null = 绑定时刻无 AGENT.md）
 * @param registry        当前注册表（由调用方传入，便于单测注入假表）
 */
export function resolveBinding(
  agentUid: string | null,
  personaSnapshot: string | null,
  registry: AgentRegistry,
): BindingResolution {
  if (agentUid === null || agentUid === "") return { kind: "unbound" };

  const rec = registry.agents.get(agentUid);
  // 情形 2：uid 不在注册表（目录被删 / 重建换了 uid）
  if (!rec) {
    return {
      kind: "degraded",
      reason: `绑定的 agent（uid=${agentUid}）已不存在于 etc/agents，已降级为未绑定`,
      personaText: personaSnapshot ?? "",
    };
  }
  // 情形 3：记录在但状态非法（setup 损坏 / uid 重复）
  if (rec.status !== "ok") {
    return {
      kind: "degraded",
      reason: `agent ${rec.path} 当前不可用（${rec.invalidReason ?? "配置非法"}），已降级`,
      personaText: personaSnapshot ?? "",
    };
  }
  // 情形 4：正常
  return {
    kind: "bound",
    agent: rec,
    // ⚠️ 用**快照**而不是 rec.body（A15：人设冻结）。
    //    快照为 null 说明绑定时该 agent 没有 AGENT.md，此时也不该去读 rec.body ——
    //    那会让「绑定后新增 AGENT.md」立刻影响存量会话，违背冻结语义。
    personaText: personaSnapshot ?? "",
    toolFilter: toolFilterOf(rec),
    skillPolicy: resolveSkillPolicy(rec.skillsMode, rec.skillsAllow),
    // [第 7 步 A3] 只转手 llmRef，不查表（查表在 llmResolve.ts，避免 binding 依赖 infra）
    llmRef: rec.llmRef,
    systemBudget: rec.systemBudget,
    maxRounds: rec.maxRounds,
    memoryEnabled: rec.memoryEnabled,
  };
}
