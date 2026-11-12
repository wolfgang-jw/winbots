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

/**
 * skills.mode：**只允许 "allow"**（白名单）。
 *
 * ⚠️ `"all"` 已废除（需求 D-1）：它原本表示「跟随全局技能开关」，
 *    而本次改造取消了全局总闸（env.json 的 tools 块整体移除），
 *    `all` 失去了依附对象，且极易被误读成「全部技能都可用」。
 *    出现 `"all"` 时 `parseAgentSetup` 直接判 `invalid_setup` 并提示如何改。
 */
export type AgentSkillsMode = "allow";

/** 工具设置项的单值类型（toolSettings 的值必须收敛在标量与字符串数组） */
export type SettingScalar = string | number | boolean | string[];

/** setup.json 的解析结果（已校验的强类型形态） */
export interface AgentSetup {
  /** 【D-J】唯一编号；老目录首次扫描时由扫描器补写 */
  uid: AgentUid;
  /** 叶子名，必须等于目录最后一段（§12.4） */
  name: string;
  title: string;
  description: string;
  /**
   * setup.json 的 llm。**解析期必填**（BR-1）：缺少 / 空串 / 指向不存在的组 → 该 agent invalid。
   * 类型保留 `string | null`：`null` 仍表示「会话未绑定 agent」这一会话层语义
   * （binding.ts 的 unbound 路径），**不代表**「agent 没写 llm」。
   */
  llmRef: string | null;
  /**
   * 技能白名单模式（§3.1）。缺省 "allow"。
   * 语义见 skillPolicy.resolveSkillPolicy 与 SkillPolicy 类型注释。
   */
  skillsMode: AgentSkillsMode;
  /**
   * 技能白名单（§3.1）。
   *
   * ⚠️ null / [] / 缺失 → **全禁**（没有任何技能可用）。这是「显式列举才可用」的唯一口径。
   */
  skillsAllow: string[] | null;
  /**
   * 工具白名单。
   *
   * ⚠️ **null / [] / 缺失 → 全禁**（本次改造的行为变更，见需求 BR-1）。
   *    改造前这里的语义是「null = 不限制」，与技能侧刻意相反；现在两侧已统一为
   *    「只在配置中明确列出的才能使用」。想给 agent 全部工具，必须显式写通配模式。
   */
  toolsAllow: string[] | null;
  toolsDeny: string[];
  /**
   * 工具设置项（需求 D-2）：`{ "<dir>/<group>": { "<name>": 值 } }`，如
   * `{ "internet/browser": { "headless": false } }`。
   *
   * ⚠️ **缺失 ≠ 全禁**：设置项缺失只表示「不覆盖」，一律用声明里的默认值；
   *    该工具能不能用由 `toolsAllow` 决定（两者语义完全不同，不要混）。
   * ⚠️ 键的形态是「目录/组」（根级组为单段 fileBase），值见 SettingScalar。
   */
  toolSettings: Record<string, Record<string, SettingScalar>>;
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
  /** 工具设置项（缺失 = {}，表示全部用默认值；不是「全禁」） */
  toolSettings: Record<string, Record<string, SettingScalar>>;
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
