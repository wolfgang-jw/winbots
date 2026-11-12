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
  | { kind: "degraded"; reason: string; personaText: string; /**
   * [D-3 / BR-2] 降级是否由「LLM 引用失效」引起。
   *
   * 为 true 时**不能**沿用 A17 的「静默降级继续回答」：那样等于用户以为在用
   * agent A，实际上跑的是默认组配置。chat.ts 见此标记直接 409 并提示。
   *
   * 判据只看 invalidReason 前缀，不看其它成因：
   *   unknown_llm:  → llm 指向不存在的组
   *   invalid_setup: 且原因为缺 llm / llm 非字符串 → 必填缺失（BR-1）
   * 目录被删 / 正文为空 / uid 重复等一律 false，保持既有降级语义。
   */
  llmInvalid?: boolean };

/**
 * [D-3] 判断 invalidReason 是否由 LLM 引用问题引起。
 *
 * 只认两种前缀，其余（invalid_body / uid 重复 / 目录问题）一律 false：
 *   - `unknown_llm:`    → setup llm 指向了 env.json llm[] 里不存在的组
 *   - `invalid_setup:` 且正文提到 llm → 缺 llm 或 llm 类型/空值非法（BR-1）
 *
 * ⚠️ 不按字符串相等判断：scan.ts 拼装 invalidReason 时会带上前缀后的说明文本，
 *    这里用 startsWith / includes 以兼容文案微调。
 */
function isLlmInvalidReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  if (reason.startsWith("unknown_llm:")) return true;
  if (!reason.startsWith("invalid_setup:")) return false;
  /* 用 \bllm\b 而不是 includes("llm")：
   *   invalid_setup 的文案形如 `invalid_setup: llm 必须是…` / `缺少 llm（必填）…`，
   *   而其它字段的文案不会出现独立的 llm 词。用词边界可避免「systemLlmFoo」这类
   *   含 llm 子串的字段名把无关错误误判成 LLM 失效（那会错误地 409）。
   */
  return /\bllm\b/i.test(reason);
}

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
  /**
   * 【D-1 / Q2 决策】走到这里说明「会话确实没有绑定」。
   *
   * ⚠️ 正常业务流不该出现这个分支（C8）：
   *   首问不选 / 存量 NULL 续聊 都已在 chat.ts 落成 agent_uid = ag_00000000，
   *   因此到达本函数时 agentUid 应为实值。
   *   能落到这里的只有两种异常：
   *     ① 默认智能体不可用（创建失败 / 扫描判 invalid / setup 读不出来）
   *        → chat.ts 的默认绑定被跳过，boundAgentUid 保持 null；
   *     ② 旧模式请求（body.messages，无 sessionId）→ 本就是未绑定语义。
   *
   * 保留该分支而不是删除（C8-b）：默认智能体的可用性依赖磁盘文件，
   *   删掉会让「磁盘配置损坏」直接导致所有未选智能体的会话不可用。
   */
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
    // [D-3] LLM 引用失效必须拒绝而非降级：见 BindingResolution 上该字段的说明
    const llmInvalid = isLlmInvalidReason(rec.invalidReason);
    return {
      kind: "degraded",
      // llmInvalid 时给一份「不说已降级」的原因：调用方会据此直接拒绝请求，
      // 文案里再出现「已降级」会与「请求已拒绝」自相矛盾。
      reason: llmInvalid
        ? `agent ${rec.path} 的 LLM 引用失效（${rec.invalidReason ?? "配置非法"}）`
        : `agent ${rec.path} 当前不可用（${rec.invalidReason ?? "配置非法"}），已降级`,
      personaText: personaSnapshot ?? "",
      llmInvalid,
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
