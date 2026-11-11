/**
 * src/agents/prompt.ts
 * system 三段式装配（模块 3）：人设 → 技能声明 → 基础。
 *
 * ⚠️ 三条铁律（文档 §二 模块 3「产出边界」）：
 *   1. 循环外只插一次 —— 本文件不感知轮次，由 chat.ts 保证在 while 外调用一次；
 *   2. 只注入不落库 —— 本文件是纯函数，无 IO、无副作用；
 *   3. 空串不注入 —— 三段全空时必须返回 ""（严格 === ""），由 T-P5 强制。
 *
 * ⚠️ 本文件**不做任何技能过滤**：技能过滤属于模块 4（agents/skillPolicy.ts），
 *    由调用方在传入 skillText 之前完成。本文件只负责「顺序 + 空串 + 预算」。
 *    理由：skills/assemble.ts 的 assembleForRequestMulti() 是无参函数且被
 *    verify-agent-compat.ts 直接调用，改它会让第 1 步的等价基线失真（D-5-1）。
 *
 * ⚠️ 预算必须走 skills/budget.ts 的统一口径，**禁止**在这里写第三份上限常量
 *    （budget.ts 头注释第 ② 条）。
 *
 * ⚠️ 零业务依赖：只允许 import @/skills 的门面与 markdown 纯函数，
 *    禁止 import ./scan、@/infra/env、@/tools（否则 agents ← prompt ← skills 易成环）。
 */
import { applySkillBudget, L2_MAX } from "@/skills";
// ⚠️ splitSections **未**经 @/skills 门面转发（skills/index.ts 只转发了
//    applySkillBudget / resolveBudgetLimits）。这里直接 import "@/skills/markdown"：
//    markdown.ts 是零业务依赖的纯函数模块（只 import ./paths），
//    且 skills 侧自己（skills/scan.ts、skills/l2tool.ts）也是直接 import ./markdown，
//    不存在「绕过单例」的风险。
import { splitSections, type Section } from "@/skills/markdown";

/** 人设段（来自 AgentRecord.body 的 AGENT.md 快照；本步只透传，不做来源判定） */
export interface PersonaPart {
  /** 人设正文；空串表示没有（不注入） */
  text: string;
}

export interface BuildSystemParts {
  /**
   * 人设段。null = 未绑定 agent 或 agent 无 AGENT.md → 整段跳过。
   * ⚠️ 第 5 步的运行期恒为 null（D-5-2）；真实赋值在第 6 步。
   */
  persona: PersonaPart | null;
  /** 技能段：= MultiAssembly.systemText（可能为 ""） */
  skillText: string;
  /** 基础段：环境/工具使用约定等固定文本（本步传 ""，接口先定型） */
  baseText: string;
}

export interface BuiltSystem {
  /** 最终注入的 system 文本；三段全空时严格 === "" */
  systemText: string;
  /** 各段实际是否参与（供日志与断言） */
  parts: { persona: boolean; skill: boolean; base: boolean };
  /** 各段正文合计字数（不含分隔符），供预算告警 */
  totalChars: number;
}

/**
 * 三段拼装的**唯一入口**。
 *
 * 顺序固定：人设 → 技能声明 → 基础。段间用 "\n\n" 分隔，空段既不出现也不留分隔符
 * （否则会拼出 "\n\n\n\n"，见 D-5-3）。
 */
export function buildSystemText(p: BuildSystemParts): BuiltSystem {
  const segs: string[] = [];
  const used = { persona: false, skill: false, base: false };

  // ① 人设段
  const personaText = p.persona?.text ?? "";
  if (personaText !== "") {
    segs.push(personaText);
    used.persona = true;
  }

  // ② 技能段（已由调用方完成过滤与预算）
  if (p.skillText !== "") {
    segs.push(p.skillText);
    used.skill = true;
  }

  // ③ 基础段
  if (p.baseText !== "") {
    segs.push(p.baseText);
    used.base = true;
  }

  // ⚠️ 全空必须严格 ""：若能拼出 "\n\n" 之类非空串，会破坏「未绑定路径逐字节等价」（D-5-3）。
  const systemText = segs.join("\n\n");
  return {
    systemText,
    parts: used,
    totalChars: segs.reduce((n, s) => n + s.length, 0),
  };
}

/**
 * 按总预算裁剪已拼好的 system 文本。
 *
 * 为什么单独一个函数而不塞进 buildSystemText：
 *   预算与顺序是两件事，「只拼不裁」与「只裁不拼」两种口径单测都要用。
 *
 * 预算口径复用 skills/budget.ts：
 *   · 上限、截断标注、省略清单全部走 applySkillBudget 这同一份实现，
 *     不会出现第三套口径。
 *   · 全部段落都走 **L2 通道** ⇒ 实际生效上限 = min(L2_MAX, totalMax)，L2_MAX(3000) 始终是硬约束。
 *     传 null（或 ≥ L2_MAX 的值）时截断标注如实显示 3000；传更小的值才真正收紧。
 *   · 第 6 步接 agent.systemBudget（P4）时从 opts.totalMax 传入：
 *     小于 3000 才生效，大于 3000 不会放宽 L2_MAX（这是刻意的：system 预算不能再宽于技能预算）。
 *
 * ⚠️ 必须先切段再裁（风险 R-5-1）：
 *   若把整段文本当作**单个** Section 交给 applyBudget，一旦该段超 L2_MAX(3000)，
 *   markdown.applyBudget 的 `if (next > L2_MAX) break;` 会让 keepL2 为空，
 *   结果 l2Text 只剩一句截断标注 —— **人设与技能正文全部消失**。
 *   切段后按段累加，超限只丢尾部段落，与技能侧行为一致。
 *
 * ⚠️ 未超预算时的逐字节等价性（V9 主门禁的前提）：
 *   assembleForRequestMulti() 的 systemText 是用 "\n\n" 连接各段拼出来的；
 *   splitSections 在 "## " 处切开并 trim 首尾空白，joinSections 再用 "\n\n" 拼回，
 *   因此「不超限 ⇒ 输出与输入逐字节相同」。此性质由 T-P10 钉住。
 */
export function fitSystemBudget(
  text: string,
  opts: { totalMax?: number | null } = {},
): { systemText: string; truncated: boolean; omitted: string[]; originalChars: number } {
  if (text === "") {
    return { systemText: "", truncated: false, omitted: [], originalChars: 0 };
  }
  // 按 "## " 切段（splitSections 与技能侧同一份实现）。
  // 全部走 L2 通道：system 里没有「L1 = 目标/使用时机」的概念，
  // 塞进 L1 会被 L1_MAX(1500) 无谓截断。
  const sections: Section[] = splitSections(text);
  // ⚠️ totalMax 的取值必须让「截断标注里的上限」与「实际生效的上限」一致：
  //   全部段落都走 L2 通道 ⇒ l1Len 恒为 0 ⇒ 实际生效上限 = min(L2_MAX, totalMax)。
  //   applyBudget 的标注用的是 `totalMax === null ? L2_MAX : totalMax`，因此：
  //     · totalMax 未给 / 给了 ≥ L2_MAX（如第 6 步传 systemBudget=9000）→ 传 null，
  //       标注显示 L2_MAX(3000)，与实际一致；
  //     · totalMax < L2_MAX（真正收紧）→ 原样传，标注显示该收紧值，也与实际一致。
  //   任一种都不会改变「3000 仍是硬约束」这一点，只让文案如实。
  const cap = typeof opts.totalMax === "number" && opts.totalMax < L2_MAX ? opts.totalMax : null;
  const b = applySkillBudget([], sections, { profile: "preview", totalMax: cap });
  return {
    systemText: b.l2Text,
    truncated: b.truncated,
    omitted: b.omitted,
    originalChars: b.originalChars,
  };
}
