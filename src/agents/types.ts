/**
 * src/agents/types.ts
 * Agent 定义与注册表的类型契约（模块 1）。
 *
 * ⚠️ 本文件【零运行期依赖】：只放类型，不 import 任何业务模块。
 *    它在第 2–9 步会被反复引用，一旦带运行期 import 就会把 agents 子系统
 *    拖进 chat.ts 的模块图，破坏「第 2 步不接线」。
 */

/** 【12.1 D-J】uid 格式：ag_ + 8 位小写十六进制，例 ag_7f3a9c21 */
export type AgentUid = string;

/** skills.mode：allow = 白名单；all = 跟随全局开关（§3.1） */
export type AgentSkillsMode = "allow" | "all";

/** setup.json 的解析结果（已校验的强类型形态） */
export interface AgentSetup {
  /** 【D-J】唯一编号；老目录首次扫描时由扫描器补写 */
  uid: AgentUid;
  /** 叶子名，必须等于目录最后一段（§12.4） */
  name: string;
  title: string;
  description: string;
  /** setup.json 的 llm，可空；非空时必须在注入的合法名字集合里 */
  llmRef: string | null;
  /**
   * 技能白名单模式（§3.1）。缺省 "allow"。
   * 语义见 skillPolicy.resolveSkillPolicy 与 SkillPolicy 类型注释。
   */
  skillsMode: AgentSkillsMode;
  /**
   * 技能白名单（§3.1）。
   *
   * ⚠️ 本字段在 AgentSetup（解析结果）里为 null 表示「setup.json 未写 list」。
   *    它**不等于**「不限制」：skillsMode=allow 时 null 按**全禁**处理（裁决 D-3-1）。
   *    只有 skillsMode="all" 才表示跟随全局开关。
   *    （原注释「null = 不限制」是第 2 步遗留，与 mode 默认 allow 冲突，已更正。）
   */
  skillsAllow: string[] | null;
  /** null = 不限制（§3.1「tools.allow 缺省 = 不限制」） */
  toolsAllow: string[] | null;
  toolsDeny: string[];
  /** null = 跟随 env.MAX_TOOL_ROUNDS；有值时已钳制到 1–32 */
  maxRounds: number | null;
  memoryEnabled: boolean;
  systemBudget: number;
}

/** 一个 agent 的完整记录（§3.2 定义 + 本步实现口径） */
export interface AgentRecord {
  /** 【D-J】唯一键，永不复用 */
  uid: AgentUid;
  /** 叶子名（如 devops），仅用于与目录名一致性校验 */
  name: string;
  /** 完整相对路径（如 ops/devops）；根级为单段（如 devops） */
  path: string;
  /** 【D-B】是否为 etc/agents/default/ */
  isDefault: boolean;
  /** 绝对路径 */
  dir: string;
  title: string;
  description: string;
  /** AGENT.md 全文（配置页展示用；本步不参与装配） */
  body: string;
  /** 【12.2 D-F】快照前的体积校验线：>32KB 只 warn，不 invalid */
  bodySize: number;
  /** setup.json 的 llm，可空 */
  llmRef: string | null;
  skillsMode: AgentSkillsMode;
  skillsAllow: string[] | null;
  toolsAllow: string[] | null;
  toolsDeny: string[];
  maxRounds: number | null;
  memoryEnabled: boolean;
  systemBudget: number;
  status: "ok" | "invalid";
  /** status === "invalid" 时的可读原因（配置页展示） */
  invalidReason?: string;
}

/** 扫描结果 */
export interface AgentRegistry {
  /** key = uid（【D-J】原设计为 path，已改） */
  agents: Map<AgentUid, AgentRecord>;
  /** path → uid，供 :path 寻址反查 */
  byPath: Map<string, AgentUid>;
  /** 告警：目录名与 name 不一致、uid 重复、uid 变动、层级过深等 */
  warnings: string[];
  /** 指纹（setup.json + AGENT.md 的 mtime+size） */
  fingerprint: string;
  scannedAt: number;
  /** 根目录读失败 → true；调用方下轮重试（与 skills 侧同义） */
  failed: boolean;
}

/** setup.json 校验失败的错误码 */
export type SetupErrorCode =
  | "read_failed"      // 读不出来
  | "parse_failed"     // JSON 语法错
  | "invalid_setup"    // 字段类型/取值范围不合法
  | "name_mismatch"    // name ≠ 目录叶子名
  | "unknown_llm";     // llm 不在合法名字集合里

export type SetupResult =
  | { ok: true; data: AgentSetup }
  | { ok: false; code: SetupErrorCode; reason: string };
