/**
 * src/skills/assemble.ts
 * 请求边界装配（§8.3）。**纯计算 + 一次注册表读取**，不做 IO、不写 .env。
 *
 * [升级版 §3.2] 两套装配并存、互不替换：
 *   · `assembleForRequest(requested)`      —— 旧路径：请求级激活 + 单技能 +（旧）工具收窄数据源。
 *     保留以便回退与对照；行为与改造前**逐字一致**（含 L0 引导文案）。
 *   · `assembleForRequestMulti()`          —— 新路径：多技能全量装配、L1 全注入、L2 由元工具按需取。
 *     chat.ts 走这一条。
 */
import { isToggleOn } from "@/infra/settings";
import { layer } from "./markdown";
import { applySkillBudget } from "./budget";
import { L1_MAX, L1_TOTAL_WARN, SKILL_NAME_PATTERN } from "./paths";
import { getSkillRegistry, type SkillRecord, type SkillRegistry } from "./scan";
import { checkRequiredTools } from "./availability";
import { L2_TOOL_VISIBLE_NAME } from "./l2tool";

export interface SkillL0Item {
  /**
   * L0 行里展示给模型的名字：正常情况下是短名（name）；
   * **同名歧义**时改用完整目录路径（dir），保证模型调元工具时不会拿到 ambiguous_skill。
   */
  name: string;
  title: string;
  summary: string;
}

export interface Assembly {
  /** 本轮实际装配的 skill 名（未激活 / 未开启 / 挂起 → null） */
  skillName: string | null;
  /**
   * L0「可用 skill 清单」（只列**已开启且正常**的）。
   * ⚠️ C-11 修订：L0 **会**进 systemText，供模型发现「有哪些技能可用」；
   *   激活仍必须显式（C-5）。
   */
  l0: SkillL0Item[];
  /** L1 文本（## 目标 / ## 使用时机），已按预算裁剪 */
  l1: string;
  /** L2 文本（其余段落），已按预算裁剪 */
  l2: string;
  truncated: boolean;
  /** 要收窄的工具名（callName）；空数组 = 不收窄 */
  tools: string[];
  /** 最终拼给模型的 system 文本；**无任何已开启 skill 时为 ""**（AC-14） */
  systemText: string;
  /** 一句话诊断（写日志用；未装配时为 null） */
  diag: string | null;
  /**
   * [C-33] 「请求了激活但没能生效」的原因（未请求 / 生效成功 → null）。
   * 典型：请求的 skill 未在配置页开启（SKILLON__ 默认 false）。
   * 前端/SSE 据此给出明确提示，避免「点了本轮激活却毫无反应」。
   */
  skipReason: string | null;
}

/**
 * 单测注入点（§12.2.1 / C-16）：默认取真实实现，生产路径完全不变。
 * 加可选默认参数不会影响任何既有调用点（chat.ts / routes/skills.ts 不需要改一行）。
 */
export interface AssembleDeps {
  isToggleOn: (key: string) => boolean;
  getRegistry: () => SkillRegistry;
}

const REAL_DEPS: AssembleDeps = { isToggleOn, getRegistry: getSkillRegistry };

const EMPTY: Assembly = {
  skillName: null, l0: [], l1: "", l2: "", truncated: false, tools: [], systemText: "", diag: null,
  skipReason: null,
};

/**
 * 激活判定：只认**显式**激活（C-5）。
 * @param requested 请求里带的 skill 名（目录路径或目录名；`dir` 优先精确匹配）
 */
function pickActive(requested: string | null, reg: SkillRegistry): SkillRecord | null {
  if (!requested) return null;
  // 先用形状校验挡一次：避免把用户输入（可能含 ".." / 空格）直接拿去查 Map
  if (!SKILL_NAME_PATTERN.test(requested)) {
    console.warn(`⚠️  [skill] 激活名形状不合法：${requested}（应形如 dev/log_triage）`);
    return null;
  }
  // 允许写 "dev/log_triage" 或 "log_triage"（唯一命中时）。
  // ⚠️ 歧义（两个 skill 同名、不同分类）→ 视为未激活并告警，绝不猜。
  const exact = reg.skills.get(requested);
  if (exact) return exact;
  const byName = [...reg.skills.values()].filter((r) => r.name === requested);
  if (byName.length === 1) return byName[0] as SkillRecord;
  if (byName.length > 1) {
    console.warn(
      `⚠️  [skill] 激活名「${requested}」命中多个 skill（${byName.map((r) => r.dir).join("、")}），本轮不装配；请改用完整目录路径`,
    );
  }
  return null;
}

/**
 * L0：所有**已开启且正常**的 skill 的 title + summary（§4.3；长度已由 frontmatter 校验保证）。
 *
 * @param onlyUsable [升级版 §3.3] true → 额外剔除「必须工具不可用」的技能（新装配用）；
 *                   false（缺省）→ 旧行为，因此旧路径逐字不变。
 */
function buildL0(
  reg: SkillRegistry,
  deps: AssembleDeps,
  onlyUsable = false,
  /**
   * [agent / 第 6 步 A10] agent 侧白名单过滤（**必须在全局条件之后**）。
   * 缺省 undefined = 不过滤，旧路径 assembleForRequest 逐字节不变。
   */
  agentFilter?: (candidate: { dir: string; name: string }) => boolean,
): SkillL0Item[] {
  const usable = [...reg.skills.values()]
    .filter((r) => r.status === "ok" && deps.isToggleOn(r.toggleKey))
    .filter((r) => (onlyUsable ? (r.unavailable ?? []).length === 0 : true))
    // [agent / 第 6 步 A10] agent 侧白名单：必须在全局三条件之后（反了会成为后门）。
    .filter((r) => (agentFilter ? agentFilter({ dir: r.dir, name: r.name }) : true))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // [升级版 §4.5] 同名歧义：模型靠名字调元工具，短名会拿到 ambiguous_skill → 改用完整目录路径。
  const count = new Map<string, number>();
  for (const r of usable) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  return usable.map((r) => ({
    name: (count.get(r.name) ?? 0) > 1 ? r.dir : r.name,
    title: r.title,
    summary: r.summary,
  }));
}

/**
 * L0 清单文本：一行一个 skill，形如
 *   - 本地日志排查（log_triage）：从日志文件定位报错根因…
 *
 * @param withL2Hint [升级版 R6] true → 新版两句引导（一句清单引导 + 「先取 L2 再照做」的 ①② 两条规则）；
 *                   false（缺省）→ **旧文案逐字保留**，供旧装配 `assembleForRequest` 使用。
 */
function l0TextOf(l0: SkillL0Item[], withL2Hint = false): string {
  if (l0.length === 0) return "";
  const guide = withL2Hint
    ? "【可用技能】以下技能已开启，请按下列规则使用：\n" +
      `① 遇到某技能「使用时机」描述的场景时，**必须先调用 ${L2_TOOL_VISIBLE_NAME}（参数 name 取技能名）取回它的 L2 正文，再严格按 L2 的步骤执行**；未取 L2 时不要假定自己掌握该技能的做法。\n` +
      "② 多个技能同时适用时，按任务性质择优：**只用一个技能的步骤，不要混用不同技能的步骤**。"
    : "【可用技能】以下技能已开启。需要用时请按名称显式激活；未激活时不要假定自己具备其能力：";
  return [guide, ...l0.map((s) => `- ${s.title}（${s.name}）：${s.summary}`)].join("\n");
}

/**
 * 装配本次请求的 skill 内容（**旧路径，保留不动**）。
 *
 * ⚠️ C-11 修订（v2）：L0「可用 skill 清单」**总是进 systemText**（无 skill 时为空串）。
 *
 *   原实现：L0 只在「本轮真的装配了某个 skill」时才进 system。
 *   实测问题：用户不激活 skill 时，模型完全不知道有哪些 skill 存在，
 *     于是对「帮我查日志」这类请求只能自己摸索（列目录、试 Node / Python / PowerShell），
 *     产生多次 shell 审批且被拒后才收敛 —— 清单不进上下文 → 能力不可被发现。
 *
 *   修订理由：L0 只有 title + summary（合计 ≤ 60 字/skill，且仅列**已开启且正常**的），
 *     成本可控；而「知道自己有什么技能」是模型做选择的前提。
 *   L0 仍然**不替代**激活：激活才带 L1/L2 与工具收窄，清单只说明「有哪些、何时该用」。
 *
 * [升级版 §3.2] 本函数**保留原样**（含显式激活语义与旧 L0 文案），供回退与对照；
 *   生产路径已改为 `assembleForRequestMulti()`。
 */
export function assembleForRequest(
  requested: string | null,
  deps: AssembleDeps = REAL_DEPS,
): Assembly {
  const reg = deps.getRegistry();
  const l0 = buildL0(reg, deps);
  const l0Text = l0TextOf(l0);
  const rec = pickActive(requested, reg);

  // ①②③ 三个硬约束：未激活 / 挂起 / 未开启 → 只给 L0，不给 L1/L2、不收窄工具
  if (!rec) {
    // 请求了激活名但没找到对应 skill（写错 / 已删除）→ 必须告诉用户，不能静默
    return {
      ...EMPTY, l0, systemText: l0Text,
      skipReason: requested ? `找不到技能「${requested}」（可能已删除或名字写错）` : null,
    };
  }
  if (rec.status !== "ok") {
    console.warn(`⚠️  [skill] ${rec.dir} 已挂起（${rec.suspend?.code}），本轮不装配；原因见配置页`);
    return {
      ...EMPTY, l0, systemText: l0Text,
      skipReason: `技能「${rec.dir}」已挂起（${rec.suspend?.code ?? "声明不合法"}），本轮不装配；原因见配置页`,
    };
  }
  if (!deps.isToggleOn(rec.toggleKey)) {
    console.warn(`⚠️  [skill] ${rec.dir} 的开关未开启（${rec.toggleKey}），本轮不装配`);
    // [C-33] 这是最容易踩的坑：配置页「本轮激活」只是请求级入参，
    //   开关没开（SKILLON__ 默认 false）时装配必被挡。以前完全静默，用户以为功能坏了。
    return {
      ...EMPTY, l0, systemText: l0Text,
      // [C-35] 文案只说「缺的那一步」：能走到这里说明本轮激活已生效（无 requested 不会进本分支），
      //   再让用户去勾「本轮激活」属于反向误导。
      skipReason: `技能「${rec.dir}」本轮已被激活，但它的开关还关着（${rec.toggleKey}=false），本轮未装配：请到配置页勾选该技能的开关并保存（「本轮激活」已生效，无需重勾）`,
    };
  }

  const { l1, l2 } = layer(rec.sections);
  const budget = applyBudget(l1, l2);

  const systemText = [
    `【本轮启用的技能】${rec.title}（${rec.name}）`,
    budget.l1Text,
    budget.l2Text,
  ].filter((s) => s !== "").join("\n\n");

  if (budget.truncated) {
    console.warn(
      `⚠️  [skill] ${rec.dir} 内容超预算（原长 ${budget.originalChars} 字），已省略段落：` +
      budget.omitted.join("、"),
    );
  }

  return {
    skillName: rec.name,
    l0,
    l1: budget.l1Text,
    l2: budget.l2Text,
    truncated: budget.truncated,
    tools: rec.tools,
    systemText,
    diag: `${rec.dir}｜L1=${budget.l1Text.length}｜L2=${budget.l2Text.length}｜截断=${budget.truncated ? "是" : "否"}`,
    skipReason: null,
  };
}

/* ============================================================
 * [升级版 §3.2 / §4.4] 多技能装配（新路径）
 * ============================================================ */

/** 一个参与装配的技能块 */
export interface SkillBlock {
  /** 身份：examples/log_triage */
  dir: string;
  /** 末段名：log_triage */
  name: string;
  title: string;
  /** 注入 system 的 L1 正文（不裁剪，仅受 L1_MAX 保护） */
  l1: string;
  /** 仅告警，不剔除 */
  l1Truncated: boolean;
  /** 仅日志/告警（L2 不进 system，由元工具按需取） */
  l2Chars: number;
  /** 必须工具（callName） */
  mustTools: string[];
  /** 「依赖工具」行展示用（visibleName） */
  toolVisibleNames: string[];
}

export interface MultiAssembly {
  /** 参与装配的技能，按 name（再按 dir）字典序 */
  skills: SkillBlock[];
  /** = skills.map(s => s.name)；供 finish 事件与 ToolContext */
  skillNames: string[];
  l0: SkillL0Item[];
  /** 无任何已开启技能时 = "" */
  systemText: string;
  /** 逐条「不可用 / 挂起」说明（复数；未开启的技能不提示） */
  notices: string[];
  diag: string;
}

/** 「依赖工具」行：为空则整行不写（§6.2）—— 不写「零工具」 */
function depsLine(s: SkillBlock): string {
  return s.toolVisibleNames.length === 0 ? "" : `依赖工具：${s.toolVisibleNames.join("、")}`;
}

/**
 * 装配本次请求的**多技能**内容（升级版主路径）。
 *
 * 三条件：已开启（SKILLON__）∧ 扫描状态 ok ∧ 必须工具全部可用。
 *   「场景是否匹配」不在这里判定：由模型读 L1 的「使用时机」决定（§3.3）。
 *
 * ⚠️ 顺序不能乱：① 回填 unavailable → ② 算 usable → ③ 建技能块 → ④ buildL0(…, true)。
 *    若把 buildL0 提前，过滤读到的还是上一轮的旧值。
 */
export function assembleForRequestMulti(
  deps: AssembleDeps = REAL_DEPS,
  /**
   * [agent / 第 6 步 A10] agent 侧技能白名单过滤（**必须在全局三条件之后**）。
   * 缺省 undefined = 不过滤，逐字节等价于改动前（A8）。
   * 判据由 @/agents 的 isSkillAllowedByPolicy 提供，本文件不含通配实现。
   *
   * ⚠️ 必须是**可选**第二参数：scripts/verify-agent-compat.ts 无参调用本函数，
   *    改成必选会让该脚本编译失败，第 1 步的等价基线随之失真。
   */
  agentFilter?: (candidate: { dir: string; name: string }) => boolean,
): MultiAssembly {
  const reg = deps.getRegistry();

  // ① 先把可用性回填到内存记录（不落盘、不改 status）
  for (const rec of reg.skills.values()) {
    rec.unavailable = rec.status === "ok" ? checkRequiredTools(rec.tools) : [];
  }

  // ② 三条件（「场景可匹配」不在此判定，由模型读 L1 决定 —— §3.3）
  const all = [...reg.skills.values()];
  const usable = all
    .filter((r) => r.status === "ok" && deps.isToggleOn(r.toggleKey) && (r.unavailable ?? []).length === 0)
    // [agent / 第 6 步 A10] agent 白名单在全局三条件之后收窄（顺序不可反）。
    .filter((r) => (agentFilter ? agentFilter({ dir: r.dir, name: r.name }) : true))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.dir < b.dir ? -1 : 1));

  // ③ 技能块：L1 只受 L1_MAX 保护（多技能传 totalMax: null，避免 L1 被 L2 挤出预算）
  const skills: SkillBlock[] = usable.map((r) => {
    const { l1, l2 } = layer(r.sections);
    const b = applySkillBudget(l1, l2, { profile: "multi" });
    if (b.l1Text.length >= L1_MAX) {
      console.warn(`⚠️  [skill] ${r.dir} 的 L1 达到/超过 ${L1_MAX} 字上限，已整段截断（建议精简「目标 / 使用时机」）`);
    }
    return {
      dir: r.dir,
      name: r.name,
      title: r.title,
      l1: b.l1Text,
      l1Truncated: b.l1Text.length >= L1_MAX,
      l2Chars: b.l2Text.length,
      mustTools: r.tools,
      toolVisibleNames: r.tools.map((c) => reg.tools.get(c)?.visibleName ?? c),
    };
  });

  // ④ L0（已回填，可用性过滤生效）
  const l0 = buildL0(reg, deps, true, agentFilter);

  // ⑤ notices：已开启但不可用 / 已开启但挂起（未开启的不提示 —— 用户本来就没开）
  const notices: string[] = [];
  for (const r of all) {
    if (!deps.isToggleOn(r.toggleKey)) continue;
    if (r.status !== "ok") {
      notices.push(`技能「${r.dir}」已挂起（${r.suspend?.code ?? "声明不合法"}），本次未参与装配；原因见配置页`);
      continue;
    }
    if ((r.unavailable ?? []).length > 0) {
      const miss = r.unavailable.map((u) => `${u.call}（${u.detail}）`).join("；");
      notices.push(`技能「${r.dir}」未参与装配：必须工具不可用 —— ${miss}`);
    }
  }

  // ⑥ systemText：先 L0 引导（两句：一句清单引导 + 一句「先取 L2 再执行」），再按技能名字典序逐个技能块
  const parts: string[] = [];
  const l0Text = l0TextOf(l0, true);
  if (l0Text !== "") parts.push(l0Text);
  for (const s of skills) {
    parts.push([`### 技能：${s.title}（${s.dir}）`, s.l1, depsLine(s)].filter((x) => x !== "").join("\n\n"));
  }
  const systemText = parts.join("\n\n");

  // ⑦ L1 合计告警（只告警、不截断 —— 风险 5）
  const totalL1 = skills.reduce((n, s) => n + s.l1.length, 0);
  if (totalL1 > L1_TOTAL_WARN) {
    console.warn(
      `⚠️  [skill] 已开启技能 L1 合计 ${totalL1} 字（阈值 ${L1_TOTAL_WARN}），system 偏长，建议精简技能`,
    );
  }

  return {
    skills,
    skillNames: skills.map((s) => s.name),
    l0,
    systemText,
    notices,
    diag: `参与 ${skills.length}/${all.length}｜L1 合计=${totalL1}`,
  };
}

export interface SkillPreview {
  found: boolean;
  l0: string;
  l1: string;
  l2: string;
  truncated: boolean;
  /** 只算「注入的正文」，不含截断标注 */
  sessionChars: number;
  tools: string[];
  status: "ok" | "suspended";
  reason: string | null;
  hint: string | null;
  /** 被截断省略的段落标题（预览浮层展示） */
  omitted: string[];
}

/** 预览接口专用：给未激活 / 未开启的 skill 也算一份「假如注入会是什么样」（§12.5） */
export function previewSkill(
  name: string,
  deps: Pick<AssembleDeps, "getRegistry"> = REAL_DEPS,
): SkillPreview {
  const reg = deps.getRegistry();
  // 先按完整目录精确匹配，再退回「唯一同名」（与 pickActive 同口径，但这里不校验形状——
  //   形状校验在路由层做，非法形状应得到 400 而不是 404）
  let rec: SkillRecord | undefined = reg.skills.get(name);
  if (!rec) {
    const byName = [...reg.skills.values()].filter((r) => r.name === name);
    if (byName.length === 1) rec = byName[0];
  }
  if (!rec) {
    return {
      found: false, l0: "", l1: "", l2: "", truncated: false, sessionChars: 0,
      tools: [], status: "ok", reason: null, hint: null, omitted: [],
    };
  }
  const { l1, l2 } = layer(rec.sections);
  const b = applySkillBudget(l1, l2);
  return {
    found: true,
    l0: `${rec.title} · ${rec.summary}`,
    l1: b.l1Text,
    l2: b.l2Text,
    truncated: b.truncated,
    // 只算「注入的正文」，不含截断标注（标注属元信息）
    sessionChars: (b.l1Text + b.l2Text).length,
    tools: rec.tools,
    status: rec.status,
    reason: rec.suspend ? rec.suspend.code : null,
    hint: rec.suspend ? rec.suspend.hint : null,
    omitted: b.omitted,
  };
}
