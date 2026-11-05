/**
 * src/skills/assemble.ts
 * 请求边界装配（§8.3）。**纯计算 + 一次注册表读取**，不做 IO、不改全局状态。
 */
import { isToggleOn } from "@/infra/settings";
import { applyBudget, layer } from "./markdown";
import { SKILL_NAME_PATTERN } from "./paths";
import { getSkillRegistry, type SkillRecord, type SkillRegistry } from "./scan";

export interface SkillL0Item {
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

/** L0：所有**已开启且正常**的 skill 的 title + summary（§4.3；长度已由 frontmatter 校验保证） */
function buildL0(reg: SkillRegistry, deps: AssembleDeps): SkillL0Item[] {
  return [...reg.skills.values()]
    .filter((r) => r.status === "ok" && deps.isToggleOn(r.toggleKey))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((r) => ({ name: r.name, title: r.title, summary: r.summary }));
}

/**
 * L0 清单文本：一行一个 skill，形如
 *   - 本地日志排查（log_triage）：从日志文件定位报错根因…
 * 只列已开启且正常的 skill；为空时返回 ""（不注入空段落）。
 */
function l0TextOf(l0: SkillL0Item[]): string {
  return l0.length === 0
    ? ""
    : [
      "【可用技能】以下技能已开启。需要用时请按名称显式激活；未激活时不要假定自己具备其能力：",
      ...l0.map((s) => `- ${s.title}（${s.name}）：${s.summary}`),
    ].join("\n");
}

/**
 * 装配本次请求的 skill 内容。
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
  const b = applyBudget(l1, l2);
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
