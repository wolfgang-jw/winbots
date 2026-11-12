/**
 * src/agents/toolConfig.ts
 * 「AgentRecord → 请求级工具配置快照」的唯一翻译层。
 *
 * 职责（代码文档 §4.2 的 `cfgFromRecord`）：
 *   把 setup.json 的三个结构化字段翻译成 `settings.ts` / `skills/assemble.ts` 认识的
 *   **两个键集合** + **一个设置项文本表**：
 *     · setup.tools.allow / deny   → enabledToggles（TOOLON__… 集合）
 *     · setup.skills.list          → enabledSkillToggles（SKILLON__… 集合）
 *     · setup.toolSettings         → settings（TOOLSET__… → 持久化文本）
 *
 * 翻译规则：
 *   · 工具组「开启」= `tools.allow` 命中该组的 toggleKey / 可见名前缀 / 前缀通配，
 *     且未被 `tools.deny` 命中；
 *   · 目录「开启」= 其子树里**至少有一个**组开启（目录节点没有独立配置项）；
 *   · 技能「开启」= `skills.list` 命中该技能目录（dir）；
 *   · 设置项：只保留**已注册组**的项（未注册组的项写了也读不到，不产生键）。
 *
 * ⚠️ 依赖约束（与 agents/ 其它文件同口径）：
 *     只允许 import `./types`（类型）、`./match`（通配）、`@/tools/paths`（键拼装）、
 *     `@/skills/paths`（技能键拼装）、`@/infra/toolConfigContext`（仅类型）。
 *   **禁止** import `@/tools/scan` / `@/skills/scan` / `@/infra/settings`：
 *     注册表结构由调用方（routes/chat.ts）注入，本文件保持纯函数、可直接单测。
 *
 * ⚠️ 为什么把「allow 命中组」翻译成 enabledToggles，而不是让 settings 直接看 allow：
 *   既有接口是 `isToggleOn(toggleKey)`，保持这个形状可以让**所有工具实现**里
 *   `dirSettings()/groupSettings()` 的取值调用一行不改。翻译每次请求只做一次。
 */
import type { AgentRecord, SettingScalar } from "./types";
import { matchesAny } from "./match";
import {
  dirSettingKey, dirToggleKey, formatManagedValue, groupSettingKey, groupToggleKey,
} from "@/tools/paths";
import { skillToggleKey } from "@/skills/paths";
import type { AgentToolConfig } from "@/infra/toolConfigContext";

/** 翻译所需的「工具组」结构（从工具注册表提取的最小信息，便于单测注入） */
export interface ToolGroupInfo {
  /** 组 id，形如 `internet/browser`；根级组为单段 `browser` */
  id: string;
  /** 所属目录路径，根级为 "" */
  dirPath: string;
  /** 入口文件名（不含 .ts） */
  fileBase: string;
  /** 模型可见名前缀，如 `internet__browser` */
  visiblePrefix: string;
}

/** 翻译所需的「目录」结构 */
export interface ToolDirInfo {
  /** 目录路径；根级为 ""（根目录没有开关，不会产生键） */
  path: string;
  /** 直属的组 id */
  groups: string[];
  /** 子目录 path */
  children: string[];
}

/**
 * 某个工具组是否对该 agent「开启」。
 *
 * 匹配对象（与 toolPolicy 同一套通配口径，不得另立）：
 *   · 组的 toggleKey（`TOOLON__internet__browser`）—— 推荐写法；
 *   · 组的可见名前缀（`internet__browser`）—— 省略 TOOLON__ 前缀的简写；
 *   · 前缀通配（`internet__browser__*`）—— 等价于整组。
 * 任一命中即视为整组开启；`deny` 命中 toggleKey 或可见名前缀则一票否决。
 *
 * ⚠️ 粒度说明：这里只判断「组开关」这一层；**逐工具**是否可用仍由
 *    toolPolicy 的 ToolFilter 在可见名层面判定（它是权威）。两层叠加的结果是
 *    「组开启 ∧ 逐工具命中 allow」，正是需求 BR-1 要的语义。
 */
function groupEnabled(
  g: ToolGroupInfo,
  allow: readonly string[] | null,
  deny: readonly string[],
): boolean {
  if (!allow || allow.length === 0) return false;              // BR-1：null / [] 全禁
  const toggleKey = groupToggleKey(g.dirPath, g.fileBase);
  if (matchesAny(deny, toggleKey) || matchesAny(deny, g.visiblePrefix)) return false;
  return (
    matchesAny(allow, toggleKey)
    || matchesAny(allow, g.visiblePrefix)
    || matchesAny(allow, `${g.visiblePrefix}__*`)
  );
}

/** 某目录的子树里是否至少有一个组开启（自底向上，防结构异常成环） */
function subtreeHasEnabledGroup(
  path: string,
  dirs: ReadonlyMap<string, ToolDirInfo>,
  enabledGroups: ReadonlySet<string>,
  guard: Set<string> = new Set<string>(),
): boolean {
  if (guard.has(path)) return false;
  guard.add(path);
  const d = dirs.get(path);
  if (!d) return false;
  for (const gid of d.groups) if (enabledGroups.has(gid)) return true;
  for (const c of d.children) if (subtreeHasEnabledGroup(c, dirs, enabledGroups, guard)) return true;
  return false;
}

/**
 * 把 `AgentRecord` 翻译成请求级配置快照。
 *
 * @param rec       已通过校验的 agent 记录
 * @param groups    当前工具注册表里的全部组
 * @param dirs      当前工具注册表里的全部目录（含根目录 ""）
 * @param skillDirs 技能注册表里的全部技能目录（用于生成 SKILLON__ 键）
 */
export function agentToolConfigOf(
  rec: Pick<AgentRecord, "uid" | "path" | "toolsAllow" | "toolsDeny" | "toolSettings" | "skillsAllow">,
  groups: readonly ToolGroupInfo[],
  dirs: readonly ToolDirInfo[],
  skillDirs: readonly string[],
): AgentToolConfig {
  const allow = rec.toolsAllow;
  const deny = rec.toolsDeny ?? [];

  /* ① 组：allow 命中 → 开；deny 命中 → 关 */
  const enabledGroups = new Set<string>();
  const toggleOfGroup = new Map<string, string>();
  for (const g of groups) {
    toggleOfGroup.set(g.id, groupToggleKey(g.dirPath, g.fileBase));
    if (groupEnabled(g, allow, deny)) enabledGroups.add(g.id);
  }

  const enabledToggles = new Set<string>();
  for (const gid of enabledGroups) {
    const key = toggleOfGroup.get(gid);
    if (key !== undefined) enabledToggles.add(key);
  }

  /* ② 目录：子树里有可用组即为开（根目录没有开关） */
  const dirMap = new Map<string, ToolDirInfo>();
  for (const d of dirs) dirMap.set(d.path, d);
  for (const d of dirs) {
    if (d.path === "") continue;
    if (subtreeHasEnabledGroup(d.path, dirMap, enabledGroups)) {
      enabledToggles.add(dirToggleKey(d.path));
    }
  }

  /* ③ 技能：skills.list 命中技能目录 → SKILLON__ 键 */
  const enabledSkillToggles = new Set<string>();
  if (rec.skillsAllow && rec.skillsAllow.length > 0) {
    for (const dir of skillDirs) {
      if (matchesAny(rec.skillsAllow, dir)) enabledSkillToggles.add(skillToggleKey(dir));
    }
  }

  /* ④ 设置项：{ "<dir>/<group>" | "<dir>": { name: value } } → TOOLSET__… / etc__tools__…
   *    ⚠️ 键可以是**组**（`internet/browser` / 根级组 `browser`）也可以是**目录**（`local`）。
   *       目录级项（如 local 的 file_root_dir）在旧 env.json 里的键是 `etc__tools__local__…`，
   *       与组项的 `TOOLSET__…` 前缀不同，所以必须按「命中组还是命中目录」分派到
   *       groupSettingKey / dirSettingKey，否则目录级设置项会被静默丢弃。
   *    ⚠️ 只收**已注册**的组 / 目录：未注册的写了也读不到（getSettingDef 会抛
   *       ERR_UNDECLARED_SETTING），与其让它静默存在，不如不产生键。
   *    ⚠️ 缺失 = 不产生键 = 用声明里的默认值；这**不是**「全禁」。
   */
  const settings = new Map<string, string>();
  const knownGroupIds = new Set(groups.map((g) => g.id));
  const dirPaths = new Set<string>();
  for (const d of dirs) if (d.path !== "") dirPaths.add(d.path);
  for (const [key, bag] of Object.entries(rec.toolSettings ?? {})) {
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
    const isDirKey = dirPaths.has(key) && !knownGroupIds.has(key);
    const isGroupKey = knownGroupIds.has(key);
    if (!isDirKey && !isGroupKey) continue;

    for (const [name, value] of Object.entries(bag)) {
      const text = formatManagedValue(value as SettingScalar);
      if (isDirKey) {
        settings.set(dirSettingKey(key, name), text);
      } else {
        const segs = key.split("/").filter((s) => s.length > 0);
        const fileBase = segs.pop() ?? "";
        if (fileBase === "") continue;
        settings.set(groupSettingKey(segs.join("/"), fileBase, name), text);
      }
    }
  }

  return {
    agentUid: rec.uid,
    agentPath: rec.path,
    enabledToggles,
    enabledSkillToggles,
    settings,
  };
}
