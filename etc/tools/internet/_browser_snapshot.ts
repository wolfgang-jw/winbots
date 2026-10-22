/**
 * etc/tools/internet/_browser_snapshot.ts
 * 元素事实过滤、ref 分配与锚点、正文分页、预算切分、文本拼装
 *
 * [需求] BR-25 返回快照；BR-26 ref 写入页面属性；BR-28 过滤+数量上限；
 *        BR-29 密码值不出现；BR-30 非语义可点击元素补坐标；BR-31 正文分页三要素；
 *        BR-32 自带上限（24000）；BR-33 约束尾行
 * [设计] 第 6 章、§7 ref 生命周期
 *
 * [实现取舍] ref 序号「会话内单调、跨代次不重置」：若每代从 e1 重开，
 *   模型手里的旧 e1 会与新元素同号，refTable 直接覆盖 → 点错按钮。
 *   这比设计里「代次内单调」更严，见 IMPLEMENTATION-browser.md 第 17 章差异表。
 */
import { env } from "@/infra/env";
import { withTail, TAIL_LINE } from "./_browser_errors";
import type { BrowserDriver, DriverFailureKind, ElementFact } from "./_browser_driver";
import type { RefEntry, Session } from "./_browser_session";
import { allocRef } from "./_browser_session";
import { createMasker, previewValue } from "./_browser_policy";

/** [BR-32] 单次结果硬上限：平台兜底 32000 的 75%，留 ≥25% 余量 */
export const HARD_MAX_CHARS = 24000;
/** 紧凑形态的正文摘要上限 */
const COMPACT_BODY_CHARS = 400;
/** 元素行上限（含分隔符） */
const MAX_LINE_CHARS = 120;

export type SnapshotMode = "full" | "compact";

export interface SnapshotOptions {
  mode: SnapshotMode;
  /** 正文起始偏移（仅 full 形态有效，BR-31） */
  offset?: number;
}

export type SnapshotOutcome =
  | {
      ok: true;
      text: string;
      refCount: number;
      url: string;
      title: string;
      totalChars: number;
      bodyEnd: number;
      nextOffset: number | null;
    }
  | { ok: false; kind: DriverFailureKind; reason: string };

// ============================================================
// 角色与状态标注
// ============================================================

function roleLabel(role: string): string {
  switch (role) {
    case "link":
      return "链接";
    case "button":
      return "按钮";
    case "textbox":
      return "输入框";
    case "select":
      return "下拉框";
    case "checkbox":
      return "复选框";
    case "radio":
      return "单选框";
    case "file":
      return "文件选择";
    case "clickable":
      return "可点击";
    default:
      return role ? previewValue(role, 8) : "元素";
  }
}

/** 状态列（BR-29：密码字段只写「已填写」，永不写值） */
function statusOf(f: ElementFact): string {
  const parts: string[] = [];
  if (f.disabled) parts.push("禁用");
  if (f.readOnly) parts.push("只读");
  if (f.inputType === "password") {
    parts.push(f.hasValue ? "密码字段（已填写）" : "密码字段（空）");
  } else if (f.inputType === "checkbox" || f.inputType === "radio") {
    parts.push(f.checked ? "已勾选" : "未勾选");
  } else if (f.value) {
    parts.push(`当前值=${previewValue(f.value, 40)}`);
  }
  return parts.join("，");
}

/** 坐标只对「无角色语义且无文本的可点击元素」补充（BR-30） */
function coordOf(f: ElementFact): string {
  if (f.role !== "clickable") return "";
  if (f.name) return "";
  const cx = Math.round(f.rect.x + f.rect.width / 2);
  const cy = Math.round(f.rect.y + f.rect.height / 2);
  return `中心(${cx},${cy})`;
}

function elementLine(f: ElementFact, ref: string, nameChars: number): string {
  const name = previewValue(f.name || f.text || "", nameChars) || "（无文本）";
  const status = statusOf(f);
  const coord = coordOf(f);
  const cols = [ref, roleLabel(f.role), `「${name}」`];
  if (status) cols.push(status);
  if (coord) cols.push(coord);
  const line = cols.join(" ");
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

// ============================================================
// 正文：疑似指令文本只标记、不删（BR-55）
// ============================================================

const INSTRUCTION_PATTERNS: RegExp[] = [
  /忽略(以上|之前|上述|前面)/,
  /ignore\s+(all\s+|the\s+)?(previous|above|prior)/i,
  /你现在是/,
  /你现在扮演/,
  /system\s*prompt/i,
  /请执行以下(指令|操作)/,
  /disregard\s+(all\s+)?(previous|prior)/i,
];

function markInstructions(body: string): { text: string; marked: number } {
  let marked = 0;
  const lines = body.split("\n").map((line) => {
    if (!line.trim()) return line;
    for (const p of INSTRUCTION_PATTERNS) {
      if (p.test(line)) {
        marked += 1;
        return `[疑似指令文本] ${line}`;
      }
    }
    return line;
  });
  return { text: lines.join("\n"), marked };
}

// ============================================================
// ref 分配（一级：属性；二级：锚点，跨代次不兜底）
// ============================================================

interface RefPlan {
  /** 需要写回页面的「id → ref」对 */
  writes: Array<{ id: string; ref: string }>;
  /** fact.id → ref */
  refOf: Map<string, string>;
  reused: number;
}

function planRefs(s: Session, facts: ElementFact[]): RefPlan {
  const refOf = new Map<string, string>();
  const writes: Array<{ id: string; ref: string }> = [];
  let reused = 0;

  for (const f of facts) {
    const existing = f.ref ? s.refTable.get(f.ref) : undefined;
    if (f.ref && existing && existing.gen === s.gen) {
      refOf.set(f.id, f.ref);
      reused += 1;
      continue;
    }
    const ref = allocRef(s);
    const entry: RefEntry = {
      gen: s.gen,
      anchor: {
        name: previewValue(f.name, 160),
        placeholder: f.placeholder || "",
        text: previewValue(f.text, 160),
        tag: f.tag,
        inputType: f.inputType,
      },
    };
    s.refTable.set(ref, entry);
    refOf.set(f.id, ref);
    writes.push({ id: f.id, ref });
  }
  return { writes, refOf, reused };
}

// ============================================================
// 文本拼装（预算先行：先生成候选，再按固定顺序收缩）
// ============================================================

interface ComposeInput {
  header: string[];
  bodyBlock: string[];
  elements: ElementFact[];
  refOf: Map<string, string>;
  maxElements: number;
  nameChars: number;
  elementTotal: number;
  notes: string[];
}

function composeText(c: ComposeInput): { text: string; listed: number } {
  const lines: string[] = [];
  lines.push(...c.header);
  lines.push(...c.bodyBlock);

  const listed = Math.min(c.maxElements, c.elements.length);
  lines.push("");
  lines.push(
    `【可交互元素】共 ${c.elementTotal} 个可见可交互元素，列出 ${listed} 个` +
      (listed < c.elementTotal
        ? `（已截断；可先 scroll 再 observe，或提高 BROWSER_SNAPSHOT_MAX_ELEMENTS）`
        : ""),
  );
  for (let i = 0; i < listed; i++) {
    const f = c.elements[i];
    if (!f) continue;
    const ref = c.refOf.get(f.id) ?? "-";
    lines.push(elementLine(f, ref, c.nameChars));
  }
  if (c.notes.length > 0) {
    lines.push("");
    lines.push(`【提示】${c.notes.join("；")}`);
  }
  lines.push(TAIL_LINE);
  return { text: lines.join("\n"), listed };
}

// ============================================================
// 入口
// ============================================================

export async function buildSnapshot(
  s: Session,
  driver: BrowserDriver,
  o: SnapshotOptions,
): Promise<SnapshotOutcome> {
  const cfgMaxElements = Math.max(1, Number(env.BROWSER_SNAPSHOT_MAX_ELEMENTS) || 120);
  const cfgBodyChars = Math.max(200, Number(env.BROWSER_SNAPSHOT_MAX_CHARS) || 6000);
  const offset = Math.max(0, Math.trunc(o.offset ?? 0));

  // ① 事实
  const factsRes = await driver.collectFacts();
  if (!factsRes.ok) return { ok: false, kind: factsRes.kind, reason: factsRes.reason };
  const collected = factsRes.value;

  // ② 过滤（BR-28）：不可见元素剔除；禁用/只读保留并标注
  let elements = collected.facts.filter((f) => f.visible);
  const elementTotal = elements.length;

  // ③ 截断到配置上限
  const limited = elements.slice(0, cfgMaxElements);
  elements = limited;

  // ④ ref 分配 + 回写页面属性（BR-26）
  const plan = planRefs(s, elements);
  if (plan.writes.length > 0) {
    await driver.assignRefs(plan.writes);
  }

  // ⑤ 正文
  const bodyRes = await driver.bodyText();
  if (!bodyRes.ok) return { ok: false, kind: bodyRes.kind, reason: bodyRes.reason };
  const fullBody = bodyRes.value;
  const bodyTotal = fullBody.length;

  const sigRes = await driver.signature();
  const url = sigRes.ok ? sigRes.value.url : "";
  const title = sigRes.ok ? sigRes.value.title : "";

  const notes: string[] = [];
  const header: string[] = [
    `【页面】${url || "（未知地址）"}`,
    `【标题】${title || "（无标题）"}`,
    `【会话】${s.prefix}｜${s.headless ? "无头" : "有头"}｜${
      s.tempProfile ? "临时 profile" : "持久 profile"
    }｜代次 ${s.gen}｜元素 ${elementTotal} 个`,
  ];

  // 正文块：full 走分页三要素；compact 只给摘要
  let bodyBlock: string[];
  let bodyChars: number;
  let bodyEnd: number;
  let nextOffset: number | null;

  if (o.mode === "compact") {
    bodyChars = Math.min(COMPACT_BODY_CHARS, bodyTotal);
    bodyEnd = bodyChars;
    nextOffset = bodyTotal > bodyChars ? bodyChars : null;
    const marked = markInstructions(fullBody.slice(0, bodyChars));
    if (marked.marked > 0) notes.push(`正文中有 ${marked.marked} 处疑似指令文本，已标记为 [疑似指令文本]`);
    bodyBlock = [
      `【正文摘要】${bodyChars}/${bodyTotal} 字符（完整正文请用 observe 分页读取）`,
      marked.text,
    ];
  } else {
    const start = offset >= bodyTotal ? 0 : offset;
    bodyChars = Math.min(cfgBodyChars, Math.max(0, bodyTotal - start));
    bodyEnd = Math.min(bodyTotal, start + bodyChars);
    nextOffset = bodyEnd < bodyTotal ? bodyEnd : null;
    const marked = markInstructions(fullBody.slice(start, bodyEnd));
    if (marked.marked > 0) notes.push(`正文中有 ${marked.marked} 处疑似指令文本，已标记为 [疑似指令文本]`);
    bodyBlock = [
      `【正文】显示区间 ${start}–${bodyEnd}（全文 ${bodyTotal} 字符）｜下一段偏移 ${
        nextOffset === null ? "无（已到末尾）" : String(nextOffset)
      }`,
      marked.text || "（页面无可读正文）",
    ];
  }

  // ⑥ 预算收缩（顺序固定：正文 → 元素条数 → 行内文本），每级收缩都在文本里标注
  const attempts = o.mode === "compact"
    ? [
        { maxElements: cfgMaxElements, nameChars: 60 },
        { maxElements: Math.min(cfgMaxElements, 60), nameChars: 60 },
        { maxElements: Math.min(cfgMaxElements, 30), nameChars: 40 },
        { maxElements: Math.min(cfgMaxElements, 20), nameChars: 30 },
      ]
    : [
        { maxElements: cfgMaxElements, nameChars: 60 },
        { maxElements: cfgMaxElements, nameChars: 40 },
        { maxElements: Math.min(cfgMaxElements, 60), nameChars: 40 },
        { maxElements: Math.min(cfgMaxElements, 30), nameChars: 30 },
        { maxElements: Math.min(cfgMaxElements, 20), nameChars: 30 },
      ];

  let text = "";
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!;
    const localNotes = [...notes];
    if (i > 0) {
      if (a.maxElements < cfgMaxElements) {
        localNotes.push(`因结果长度超预算，元素清单已收缩到 ${Math.min(a.maxElements, elementTotal)} 条`);
      }
      if (a.nameChars < 60) localNotes.push(`元素行内文本已收缩到 ${a.nameChars} 字符`);
    }
    const built = composeText({
      header,
      bodyBlock,
      elements,
      refOf: plan.refOf,
      maxElements: a.maxElements,
      nameChars: a.nameChars,
      elementTotal,
      notes: localNotes,
    });
    text = built.text;
    if (text.length <= HARD_MAX_CHARS) break;
    if (i === attempts.length - 1) {
      // 最后一级仍超限：硬切到上限内（保结构：先切正文块）
      const overflow = text.length - HARD_MAX_CHARS;
      if (bodyBlock.length > 1 && overflow > 0) {
        const cut = Math.max(0, (bodyBlock[1] ?? "").length - overflow - 40);
        bodyBlock = [bodyBlock[0] ?? "", `${(bodyBlock[1] ?? "").slice(0, cut)}\n…[正文超预算已截断]`];
        notes.push("正文因超预算被截断");
      }
      text = composeText({
        header,
        bodyBlock,
        elements,
        refOf: plan.refOf,
        maxElements: Math.min(20, elementTotal),
        nameChars: 30,
        elementTotal,
        notes,
      }).text;
    }
  }

  // ⑦ 脱敏（BR-57：本会话填过的密码明文精确替换）
  const mask = createMasker(s.secrets);
  const masked = mask(text);

  // ⑧ 记基线（BR-24 变更判定用）
  if (sigRes.ok) s.baseline = sigRes.value;

  return {
    ok: true,
    text: masked,
    refCount: plan.refOf.size,
    url,
    title,
    totalChars: bodyTotal,
    bodyEnd,
    nextOffset,
  };
}

/** 供动作层复用：把快照文本统一收尾（尾行已在 compose 内附加，此处防重复） */
export function ensureTail(text: string): string {
  return text.includes(TAIL_LINE) ? text : withTail(text);
}
