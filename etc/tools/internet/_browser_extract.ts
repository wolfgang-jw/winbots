/**
 * etc/tools/internet/_browser_extract.ts
 * extract 工具：选择器预检、入参归一、页面侧取文调用、三段结果拼装、预算收缩与截断标注
 *
 * [REQ-browser BR-27] 工具与入参（selector / ref 二选一，ref 优先；selector ≤500 字符，域内预检）
 * [REQ-browser BR-28] 只读：不改 gen / refTable / baseline，不写 DOM，不新建 ref，返回前 touch
 * [REQ-browser BR-29] 语法错误 ≠ 空结果：预检或页面侧 badSelector → invalid_request；0 命中走成功信封
 * [REQ-browser BR-30] 命中必须回显：首段恒含「命中 N 个（可见 M 个）」，清单逐条给 tag/角色/摘要/字符数/ref
 * [REQ-browser BR-31] ref 只顺带回填、绝不新建；解析走会话层的 refEntryOf（与 act 同一张表）
 * [REQ-browser BR-32] 默认关门：可见性、tag 黑名单、表单值不回、疑似指令标记、脱敏
 * [REQ-browser BR-33] 三层上限：清单条数 / 单元素 2000 字符 / 单次总量；截断一律显式标注
 * [REQ-browser BR-34] 措辞与其余工具统一（ref 只能取自清单，不暗示选择器/坐标可用于动作）
 * [REQ-browser NB-05] 每次调用一行结构化日志（不含正文、不含密码）
 * [REQ-browser NB-06] 页面侧先 cut、域内再收缩，不依赖平台 capToolResult 兜底
 *
 * ⚠️ 本文件不导出 tools（`_` 前缀，loadTools 跳过且不告警）；不含任何页面代码
 *    （页面原语在 _browser_driver.ts 的 PAGE_LIB 里）。
 * ⚠️ 不得 import browser.ts（会与门面形成环）；也不得改 Session 的任何字段（P4 出口判据）。
 */
import { env } from "@/infra/env";
import { ok, type Envelope } from "./_common";
import { failEnvelope, TAIL_LINE, type BrowserErrorCode } from "./_browser_errors";
import { createMasker, previewText } from "./_browser_policy";
import { HARD_MAX_CHARS, markInstructionHtml, markInstructions } from "./_browser_snapshot";
import { currentGen, refEntryOf, touch, type Session } from "./_browser_session";
import type {
  DriverFailureKind,
  DriverResult,
  ElementAnchor,
  ExtractPayload,
  ExtractRequest,
} from "./_browser_driver";

/** [REQ-browser BR-33] 单元素正文上限（固定 2000，不进配置项） */
const ITEM_MAX_CHARS = 2000;
/** [REQ-browser BR-27] selector 长度上限（域内拒绝，0 次浏览器操作） */
const SELECTOR_MAX = 500;
/** 与 `_browser_actions.ts::REF_PATTERN` 同字面量（不引入第二套校验，BR-34） */
const REF_RE = /^e\d{1,6}$/;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================
// ① 域内预检（同步、0 次浏览器操作）
// ============================================================

/**
 * [REQ-browser BR-27/BR-29] 选择器预检。
 * 只做「本地一定能判死」的三类检查：长度、NUL、括号与引号配平。
 * 配平错误（如 `div[`）必须在这里拦下 —— AC-21 要求此时浏览器操作次数为 0；
 * 留到页面侧只能靠 querySelectorAll 抛异常兜底，那已经发出一次 Runtime.evaluate 了。
 */
export function precheckSelector(
  raw: unknown,
): { ok: true; selector: string } | { ok: false; message: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: false, message: "selector 为空（若要按 ref 定位请改用 ref 字段）" };
  if (s.length > SELECTOR_MAX) {
    return { ok: false, message: `selector 过长（${s.length} 字符，上限 ${SELECTOR_MAX}）` };
  }
  if (s.includes("\0")) return { ok: false, message: "selector 含非法字符 NUL" };
  const bad = unbalanced(s);
  if (bad) return { ok: false, message: bad };
  return { ok: true, selector: s };
}

/** 括号/引号配平（跳过引号区段与反斜杠转义）：返回空串表示配平 */
function unbalanced(s: string): string {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push(ch);
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const top = stack.pop();
      if (top !== pairs[ch]) {
        return `括号不配平：第 ${i + 1} 个字符「${ch}」没有对应的「${pairs[ch] ?? ""}」`;
      }
    }
  }
  if (quote) return "引号未闭合";
  if (stack.length > 0) return `括号不配平：缺少 ${stack.length} 个右括号`;
  return "";
}

// ============================================================
// ② 入参归一（本地，0 次浏览器操作）
// ============================================================

interface Plan {
  ok: true;
  request: ExtractRequest;
  source: "ref" | "selector";
  selector: string;
  /** ref 分支时被忽略的 selector（用于首段注明；无则空串） */
  ignoredSelector: string;
  ref: string;
  index: number;
  offset: number;
}

type PlanFail = { ok: false; envelope: Envelope };

/** 计数类入参归一：缺省 / 空串 / 0 视为「未指定」返回 0；负数与非数字返回 null（本地拒绝） */
function countOr(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return t < 0 ? null : t;
}

function planOf(s: Session, args: Record<string, unknown>): Plan | PlanFail {
  const rawRef = typeof args.ref === "string" ? args.ref.trim() : "";
  const rawSel = typeof args.selector === "string" ? args.selector.trim() : "";

  // [REQ-browser BR-27] selector 与 ref 至少一个
  if (!rawRef && !rawSel) {
    return {
      ok: false,
      envelope: failEnvelope(
        "invalid_request",
        "selector 与 ref 至少提供一个：selector 是 CSS 选择器（只用于只读定位），" +
          "ref 取自上一次工具返回的元素清单。本次未读取任何内容",
      ),
    };
  }

  const idx = countOr(args.index);
  if (idx === null) {
    return {
      ok: false,
      envelope: failEnvelope(
        "invalid_request",
        `index 必须为 1 起的整数（收到 ${String(args.index)}）。省略 index 时：` +
          "只有 1 个可选命中会直接返回正文，多个命中只返回清单",
      ),
    };
  }
  const off = countOr(args.offset);
  if (off === null) {
    return {
      ok: false,
      envelope: failEnvelope(
        "invalid_request",
        `offset 必须为非负整数（收到 ${String(args.offset)}）；0 表示从正文开头开始，` +
          "续读请使用上一次返回的「下一段偏移」",
      ),
    };
  }

  let anchor: ElementAnchor | null = null;
  let sel = "";
  if (rawRef) {
    // [REQ-browser BR-34] 不新增第二套 ref 校验：与 act 的 REF_PATTERN 同口径
    if (!REF_RE.test(rawRef)) {
      return {
        ok: false,
        envelope: failEnvelope(
          "invalid_request",
          `ref 格式非法：${previewText(rawRef, 20)}。ref 形如 e12，只能取自上一次工具返回的元素清单；` +
            "按选择器只读定位请用 selector 字段。本次未读取任何内容",
        ),
      };
    }
    // [REQ-browser BR-31] 与 act 同一张表、同一个取表函数
    const entry = refEntryOf(s, rawRef);
    if (!entry) {
      return {
        ok: false,
        envelope: failEnvelope(
          "element_not_found",
          `未找到 ref ${rawRef}（页面已跳转、元素已移除，或该 ref 属于另一个标签）。` +
            "请重新 observe 取新的 ref 后再试",
        ),
      };
    }
    anchor = entry.anchor;
  } else {
    const pre = precheckSelector(rawSel);
    if (!pre.ok) {
      return {
        ok: false,
        envelope: failEnvelope("invalid_request", `${pre.message}。本次未读取任何内容`),
      };
    }
    sel = pre.selector;
  }

  const maxItems = Math.max(1, Math.min(200, Number(env.BROWSER_EXTRACT_MAX_ELEMENTS) || 20));
  const includeHidden = args.includeHidden === true || args.includeHidden === "true";
  const includeHtml = args.includeHtml === true || args.includeHtml === "true";

  const request: ExtractRequest = {
    selector: sel,
    ref: rawRef,
    anchor,
    index: idx,
    offset: off,
    includeHidden,
    includeHtml,
    maxItems,
    itemChars: ITEM_MAX_CHARS,
  };

  return {
    ok: true,
    request,
    source: rawRef ? "ref" : "selector",
    selector: sel,
    ignoredSelector: rawRef ? rawSel : "",
    ref: rawRef,
    index: idx,
    offset: off,
  };
}

// ============================================================
// ③ 结果拼装
// ============================================================

interface ItemView {
  tag: string;
  role: string;
  chars: number;
  visible: boolean;
  ref: string;
  preview: string;
}

function itemLine(v: ItemView, at: number): string {
  // [REQ-browser BR-30] 每条必须给全五项：序号 / tag+角色 / 摘要 / 字符数 / 已有 ref
  const cols: string[] = [`${at}.`, v.role ? `${v.tag}(${v.role})` : v.tag];
  cols.push(`「${v.preview || "（无文本）"}」`);
  cols.push(`${v.chars} 字符`);
  if (!v.visible) cols.push("不可见");
  // ref 只顺带回填（本阶段不给新元素发 ref，BR-31）
  if (v.ref) cols.push(v.ref);
  return cols.join(" ");
}

interface ComposeInput {
  head: string[];
  items: ItemView[];
  itemLimit: number;
  totalItems: number;
  bodyBlock: string;
  htmlBlock: string;
  notes: string[];
}

function compose(c: ComposeInput): string {
  const lines: string[] = [...c.head];
  const listed = Math.min(c.itemLimit, c.items.length);
  if (c.items.length > 0) {
    lines.push("");
    lines.push(`【命中清单】共 ${c.totalItems} 个可选命中，列出 ${listed} 个`);
    for (let i = 0; i < listed; i++) {
      const v = c.items[i];
      if (!v) continue;
      lines.push(itemLine(v, i + 1));
    }
    if (listed < c.items.length) {
      lines.push(`  …另有 ${c.items.length - listed} 个未列出（用 index 指定单个元素可直接取正文）`);
    }
  }
  if (c.bodyBlock) {
    lines.push("");
    lines.push(c.bodyBlock);
  }
  if (c.htmlBlock) {
    lines.push("");
    lines.push(c.htmlBlock);
  }
  if (c.notes.length > 0) {
    lines.push("");
    lines.push(`【提示】${c.notes.join("；")}`);
  }
  lines.push(TAIL_LINE);
  return lines.join("\n");
}

/** [REQ-browser NB-05] 每次调用一行结构化日志：不含正文、不含密码、URL/选择器只留前缀 */
function logLine(
  s: Session,
  plan: Plan,
  hits: number,
  avail: number,
  chars: number,
  gen: number,
  startedAt: number,
): void {
  const target =
    plan.source === "ref" ? `ref=${plan.ref}` : `selector=${previewText(plan.selector, 40)}`;
  console.log(
    [
      "[browser] extract",
      `session=${s.prefix}`,
      `src=${plan.source}`,
      target,
      `hits=${hits}`,
      `avail=${avail}`,
      `index=${plan.index}`,
      `offset=${plan.offset}`,
      `chars=${chars}`,
      `gen=${gen}`,
      `elapsed=${Date.now() - startedAt}ms`,
    ].join("｜"),
  );
}

/** 驱动失败类别 → 需求错误码（unsupported / 其它一律 internal_error：都不该重试） */
function codeOfKind(kind: DriverFailureKind): BrowserErrorCode {
  switch (kind) {
    case "closed":
      return "session_not_found";
    case "timeout":
      return "action_timeout";
    case "cancelled":
      return "cancelled";
    case "nav_failed":
      return "navigation_failed";
    default:
      return "internal_error";
  }
}

// ============================================================
// ④ 入口（门面调用；已在 runSerial 内）
// ============================================================

export async function runExtract(s: Session, args: Record<string, unknown>): Promise<Envelope> {
  const plan = planOf(s, args);
  if (!plan.ok) return plan.envelope;

  const fn = s.driver.extractContent;
  if (typeof fn !== "function") {
    // NB-03：假驱动 / 纯单标签驱动未实现该可选方法 —— 明确告知，不误报成页面问题
    return failEnvelope(
      "internal_error",
      "当前驱动未实现取文能力，本次未读取任何内容（请勿重试，属实现缺失）",
    );
  }

  const startedAt = Date.now();
  let res: DriverResult<ExtractPayload>;
  try {
    res = await fn.call(s.driver, plan.request);
  } catch (err) {
    return failEnvelope("internal_error", `读取页面内容时发生未预期异常：${errText(err)}`);
  }

  if (!res.ok) {
    if (res.kind === "closed") {
      // 会话真的没了：不 touch（注册表里已经没有它）
      return failEnvelope("session_not_found", `读取页面内容失败：${res.reason}`);
    }
    touch(s);
    return failEnvelope(codeOfKind(res.kind), `读取页面内容失败：${res.reason}`);
  }

  const pay = res.value;
  const gen = currentGen(s);
  const targetIndex = plan.index > 0 ? plan.index : 1;

  // [REQ-browser BR-29] 选择器语法非法 → invalid_request（绝不是 empty / timeout）
  if (pay.badSelector) {
    return failEnvelope(
      "invalid_request",
      `selector 语法非法：${previewText(plan.selector, 60)}。本工具只接受 CSS 选择器` +
        "（不支持 XPath、不支持 ::text 一类伪元素）；若要按 ref 定位请改用 ref 字段。本次未读取任何内容",
    );
  }
  // ref 在页面上已被移除（表里还有、DOM 里没了）
  if (pay.missRef) {
    return failEnvelope(
      "element_not_found",
      `ref ${plan.ref} 在页面上已找不到（元素已被移除，或该标签已跳转）。请重新 observe 取新的 ref 后再试`,
    );
  }

  const hits = pay.hits ?? 0;
  const visibleHits = pay.visibleHits ?? 0;
  const skipped = pay.skipped ?? 0;
  const avail = pay.avail ?? 0;

  // [REQ-browser BR-33] index 越界必须以「可选命中数 avail」判定，不能用 hits：
  //   不可见 / 黑名单标签会被过滤，用 hits 会放过越界值，页面随后静默返回空正文。
  if (plan.index > 0 && plan.index > avail) {
    return failEnvelope(
      "invalid_request",
      `index=${plan.index} 超出范围：本次可选命中 ${avail} 个（命中 ${hits} 个，其中 ${
        hits - avail
      } 个因不可见或属不可取内容被过滤）。请按返回的命中清单重新指定 index`,
    );
  }

  const head: string[] = [];
  if (plan.source === "ref") {
    // [REQ-browser BR-30] 首段**恒**含「命中 N 个（可见 M 个）」：ref 分支同样回显，
    //   否则「ref 取文」与「selector 取文」的首段结构不一致，模型无法判断本次到底匹配了几个
    head.push(`【定位】ref ${plan.ref}｜命中 ${hits} 个（可见 ${visibleHits} 个）｜代次 ${gen}`);
  } else {
    // [REQ-browser BR-30] 首段恒含「命中 N 个（可见 M 个）」
    head.push(
      `【定位】selector ${plan.selector}｜命中 ${hits} 个（可见 ${visibleHits} 个）｜代次 ${gen}`,
    );
  }
  if (plan.ignoredSelector) {
    head.push(`（已按 ref 定位，selector ${previewText(plan.ignoredSelector, 60)} 本次未使用）`);
  }
  if (skipped > 0) {
    head.push(
      `（已跳过 ${skipped} 个不可取内容的标签：script / style / noscript / template / head / meta / link）`,
    );
  }

  const notes: string[] = [];

  // [REQ-browser BR-29/BR-30] 0 命中不是错误：走**成功**信封，并说清「语法没错、只是没匹配到」
  if (plan.source === "selector" && hits === 0) {
    head.push("");
    head.push(
      "未命中任何元素：选择器语法本身没有问题，只是页面上没有匹配的节点。" +
        "可能是写法不匹配、元素尚未渲染（可先用 act 的 wait），或内容在 iframe / shadow DOM 内（本工具不穿透）。",
    );
    const text0 = `${head.join("\n")}\n${TAIL_LINE}`;
    // [REQ-browser BR-57] 脱敏后再返回；touch 必须是返回前最后一次写（BR-05 同口径）
    const masked0 = createMasker(s.secrets)(text0);
    touch(s);
    logLine(s, plan, 0, 0, masked0.length, gen, startedAt);
    return ok(masked0, {
      tool: "internet.browser.extract",
      session: s.prefix,
      source: plan.source,
      selector: plan.selector,
      ref: plan.ref,
      index: 0,
      hits: 0,
      visibleHits,
      avail: 0,
      bodyStart: 0,
      bodyTotal: 0,
      nextOffset: null,
      chars: masked0.length,
      generation: gen,
      readOnly: true,
    });
  }

  const items: ItemView[] = (pay.items ?? []).map((it) => ({
    tag: it.tag,
    role: it.role,
    chars: it.chars,
    visible: it.visible,
    ref: it.ref,
    preview: it.preview,
  }));

  // [REQ-browser BR-33] 页面侧按 maxItems 截过清单：可用命中数多于返回条数时必须显式说出来，
  //   否则模型会以为「只有这么多命中」，从而用错 index 或误判页面没渲染全
  if (avail > items.length) {
    notes.push(
      `命中清单只返回前 ${items.length} 条（共 ${avail} 个可选命中，上限 BROWSER_EXTRACT_MAX_ELEMENTS）；` +
        "其余请缩小选择器，或直接用 index 指定序号取正文",
    );
  }

  let bodyBlock = "";
  let bodyStart = 0;
  let bodyTotal = 0;
  let nextOffset: number | null = null;

  if (typeof pay.body === "string" && pay.bodyTotal !== undefined) {
    bodyStart = pay.bodyStart ?? 0;
    bodyTotal = pay.bodyTotal ?? pay.body.length;
    const end = bodyStart + pay.body.length;
    nextOffset = end < bodyTotal ? end : null;
    const marked = markInstructions(pay.body);
    if (marked.marked > 0) {
      notes.push(`正文中有 ${marked.marked} 处疑似指令文本，已标记为 [疑似指令文本]`);
    }
    // [REQ-browser BR-33] 三要素与 observe 同口径（显示区间 / 全文长度 / 下一段偏移）
    bodyBlock = [
      `【正文】第 ${targetIndex} 个命中｜显示区间 ${bodyStart}–${end}（全文 ${bodyTotal} 字符）｜下一段偏移 ${
        nextOffset === null ? "无（已到末尾）" : String(nextOffset)
      }`,
      marked.text || "（该元素无可读正文）",
    ].join("\n");
  } else if (avail > 0) {
    notes.push(
      `共 ${avail} 个可选命中，未指定 index，本次只返回清单；请用 index 指定第几个再取正文（同一元素续读用 offset）`,
    );
  } else if (hits > 0) {
    // 命中了、但全被过滤（不可见 或 属 script/style 一类不可取内容）
    notes.push(
      `命中 ${hits} 个元素，但全部不可取正文（不可见或属 script/style 一类标签）。` +
        "可加 includeHidden=true 把不可见元素计入，或改用更精确的选择器",
    );
  }

  let htmlBlock = "";
  if (typeof pay.html === "string" && pay.html) {
    // [REQ-browser BR-32 ④] HTML 片段同样要标疑似指令，否则「换成 HTML 形态」就能绕过标记
    const markedHtml = markInstructionHtml(pay.html);
    if (markedHtml.marked > 0) {
      notes.push(`HTML 片段中有 ${markedHtml.marked} 处疑似指令文本，已标记`);
    }
    htmlBlock = `【HTML 片段】${markedHtml.text}`;
  }

  // [REQ-browser BR-33/NB-06] 三层预算：清单条数 → 总量。页面侧已按 itemChars 切过单元素。
  const budget = Math.min(
    HARD_MAX_CHARS,
    Math.max(500, Number(env.BROWSER_EXTRACT_MAX_CHARS) || 12000),
  );
  const itemMax = Math.max(1, Math.min(200, Number(env.BROWSER_EXTRACT_MAX_ELEMENTS) || 20));
  const attempts = [itemMax, Math.min(itemMax, 10), Math.min(itemMax, 5), Math.min(itemMax, 3)];

  let text = "";
  for (let i = 0; i < attempts.length; i++) {
    const limit = attempts[i] ?? 3;
    // 标注里用「实际列出条数」而不是收缩目标值：命中本来就少于目标值时，
    // 写「已收缩到 10 条」而实际只列了 3 条，是自相矛盾的假话
    const shown = Math.min(limit, items.length);
    const localNotes =
      i === 0 ? notes : [...notes, `结果超出 ${budget} 字符预算，命中清单已收缩到 ${shown} 条`];
    text = compose({
      head,
      items,
      itemLimit: limit,
      totalItems: avail,
      bodyBlock,
      htmlBlock,
      notes: localNotes,
    });
    if (text.length <= budget) break;
    if (i === attempts.length - 1) {
      // 最后一级仍超限：硬切并保留续读指引（保结构，不把 JSON 切一半）
      text = `${text.slice(0, Math.max(0, budget - 90))}\n…[结果超预算已截断；剩余内容请用 offset 续读]\n${TAIL_LINE}`;
    }
  }

  const masked = createMasker(s.secrets)(text);
  // [REQ-browser BR-05 同口径] touch 必须是返回前最后一次写：否则 TTL 极小时会话仍会被扫掉
  touch(s);
  logLine(s, plan, hits, avail, masked.length, gen, startedAt);

  return ok(masked, {
    tool: "internet.browser.extract",
    session: s.prefix,
    source: plan.source,
    selector: plan.selector,
    ref: plan.ref,
    index: targetIndex,
    hits,
    visibleHits,
    avail,
    bodyStart,
    bodyTotal,
    nextOffset,
    chars: masked.length,
    generation: gen,
    // [REQ-browser BR-28] 显式声明只读，便于审计与用例断言「零写操作」
    readOnly: true,
  });
}
