/**
 * src/skills/markdown.ts
 * 正文切段 + 分层归类 + 预算截断（§4.2 / §4.3 / §4.4）。
 *
 * ⚠️ 与 src/tools/index.ts 的 capToolResult 的差别（刻意不同，别"顺手统一"）：
 *    · capToolResult：标注**预留**在上限内，最终长度 ≤ maxChars；
 *    · 本文件：上限只按**段落正文**累加，标注是额外追加的元信息，
 *      因此 l2Text.length 可能略大于 L2_MAX（差值 = 标注长度）。
 *    理由：skill 的预算是"注入正文预算"，标注是给模型看的元信息，不该挤占正文。
 */
import { BUDGET_MAX, L1_MAX, L2_MAX } from "./paths";

export interface Section {
  /** 二级标题文本（`## ` 之后、去掉首尾空白）；第一个 `##` 之前的前置说明段为 "" */
  heading: string;
  /** 段全文，**含** `## 标题` 行（注入时原样拼回，保住 markdown 结构） */
  text: string;
}

/** 必需段落（缺失 → missing_section，§4.3） */
export const REQUIRED_SECTIONS = ["目标", "方法"] as const;

/** 归入 L1 的段落（§4.3 表） */
const L1_HEADINGS = new Set(["目标", "使用时机"]);

/**
 * 按 `##` 切段：
 *   · 只认**行首**恰好两个 `#` 加空白；`###` 属于父段内容，不会被切出来；
 *   · 第一个 `##` 之前的非空内容记为 `heading: ""` 的前置段（归 L2），
 *     避免用户把关键约束写在最前面时被静默丢掉。
 */
export function splitSections(body: string): Section[] {
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/);
  const out: Section[] = [];
  let heading = "";
  let buf: string[] = [];
  let started = false;

  const flush = () => {
    const text = buf.join("\n").trim();
    if (started || text !== "") out.push({ heading, text });
    buf = [];
  };

  for (const line of lines) {
    const m = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m) {
      flush();
      heading = (m[1] as string).trim();
      buf = [line];
      started = true;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.filter((s) => s.text !== "");
}

/**
 * 段落正文是否为空（只有 `## 标题` 行、没有实体内容）。
 *
 * 背景：`splitSections` 的 `text` **含**标题行，因此「只写了标题」的段落
 * text === "## 目标"，并不等于 ""，能通过 filter 存活。若只用
 * `new Set(headings).has(h)` 判断存在性，这种空壳段落会被判为「已提供」，
 * 结果 L1 里注入一个只有标题的空段 —— 校验通过、内容缺失，比直接报错更糟。
 */
function isSectionBodyEmpty(s: Section): boolean {
  const lines = s.text.split(/\r?\n/);
  // 首行是 `## 标题`，正文从第二行算起（前置段的 heading 为 ""，整段都是正文）
  const body = (s.heading === "" ? lines : lines.slice(1)).join("\n").trim();
  return body === "";
}

/**
 * 缺失的必需段落（§4.3）。
 *
 * 「缺失」包含两种情形，两者都要挂起 missing_section：
 *   ① 段落标题不存在；
 *   ② 标题存在但正文为空（只有 `## 目标` 一行）。
 * 理由：§4.3 判定必需段的依据是「缺一模型就无从下手」——只有标题同样无从下手。
 */
export function missingSections(sections: Section[]): string[] {
  const byHeading = new Map(sections.map((s) => [s.heading, s]));
  return REQUIRED_SECTIONS.filter((h) => {
    const sec = byHeading.get(h);
    if (!sec) return true;
    return isSectionBodyEmpty(sec);
  });
}

/** 分层：L1 = 目标 / 使用时机；L2 = 其余（输出格式 / 自检 / 自定义段 / 前置说明） */
export function layer(sections: Section[]): { l1: Section[]; l2: Section[] } {
  return {
    l1: sections.filter((s) => L1_HEADINGS.has(s.heading)),
    l2: sections.filter((s) => !L1_HEADINGS.has(s.heading)),
  };
}

export function joinSections(secs: Section[]): string {
  return secs.map((s) => s.text).join("\n\n");
}

export interface BudgetResult {
  l1Text: string;
  l2Text: string;
  truncated: boolean;
  originalChars: number;
  /** 被省略的段落标题（配置页预览与日志都用它） */
  omitted: string[];
}

/**
 * 截断文案：与 src/tools/index.ts 的 capToolResult **同一风格**（§4.4：让模型看到截断本身）。
 * 措辞差异：那边是「工具结果」，这里是「skill 内容」。
 */
export function truncationMarker(original: number, limit: number): string {
  return `\n…[skill 内容超长已截断：原长 ${original} 字，上限 ${limit} 字；已省略的段落请按 skill 名向用户确认是否补充]`;
}

/**
 * 按 §4.4 做**整段**截断（不切半句），顺序 L1 在前、L2 在后。
 *
 * 三个上限同时生效（C-1）：
 *   ① L1 段总长 ≤ L1_MAX；② L2 段总长 ≤ L2_MAX；③ L1 + L2 ≤ BUDGET_MAX。
 * 先装 L1（超了丢末尾段），剩余额度再给 L2；任一超限都在 **L2 末尾**追加标注。
 *
 * ⚠️ 标注**不计入**预算（见文件头说明）。
 * ⚠️ 标注只加在 L2 之后，L1 之后不加（否则模型会看到两条重复标注）。
 */
export function applyBudget(l1: Section[], l2: Section[]): BudgetResult {
  const original = joinSections([...l1, ...l2]).length;

  const keepL1: Section[] = [];
  let l1Len = 0;
  for (const s of l1) {
    const next = l1Len + s.text.length + (keepL1.length > 0 ? 2 : 0);
    if (next > L1_MAX) break;
    keepL1.push(s);
    l1Len = next;
  }

  const keepL2: Section[] = [];
  let l2Len = 0;
  for (const s of l2) {
    const next = l2Len + s.text.length + (keepL2.length > 0 ? 2 : 0);
    if (next > L2_MAX) break;
    if (l1Len + next > BUDGET_MAX) break;
    keepL2.push(s);
    l2Len = next;
  }

  const kept = new Set([...keepL1, ...keepL2]);
  const omitted = [...l1, ...l2].filter((s) => !kept.has(s)).map((s) => s.heading || "(前置说明)");
  const truncated = omitted.length > 0;

  return {
    l1Text: joinSections(keepL1),
    l2Text: joinSections(keepL2) + (truncated ? truncationMarker(original, BUDGET_MAX) : ""),
    truncated,
    originalChars: original,
    omitted,
  };
}
