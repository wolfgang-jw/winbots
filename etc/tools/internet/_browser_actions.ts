/**
 * etc/tools/internet/_browser_actions.ts
 * 动作校验、逐动作实现、批次串行、变更判定、三段式结果
 *
 * [需求] BR-11 唯一动作入口；BR-15/16/17/18 批次语义；BR-19 nav 不混排；
 *        BR-20 真实指针序列；BR-21 fill 读回校验；BR-22 拖拽三档；BR-24 变更才取快照；
 *        BR-47 取消 ≠ 超时；BR-49 日志；BR-50 文本只留前 20 字符
 * [设计] 第 8 章、§9 act 批次执行器
 */
import type { ToolContext } from "@/tools";
import { env } from "@/infra/env";
import { ok, type Envelope } from "./_common";
import {
  failEnvelope,
  failWithTail,
  withTail,
  describeFailure,
  type BrowserErrorCode,
} from "./_browser_errors";
import type { BrowserDriver, DriverFailureKind } from "./_browser_driver";
import {
  bumpGeneration,
  rememberSecret,
  touch,
  type Session,
} from "./_browser_session";
import { buildSnapshot } from "./_browser_snapshot";
import { precheckUrl, previewText, reasonLabel, urlForLog } from "./_browser_policy";

// ============================================================
// 动作定义与校验
// ============================================================

export type ActionName =
  | "nav"
  | "click"
  | "fill"
  | "press"
  | "scroll"
  | "drag"
  | "hover"
  | "select"
  | "wait";

const ACTIONS: readonly ActionName[] = [
  "nav",
  "click",
  "fill",
  "press",
  "scroll",
  "drag",
  "hover",
  "select",
  "wait",
];

export interface ActAction {
  action: ActionName;
  url?: string;
  ref?: string;
  toRef?: string;
  text?: string;
  mode?: "assign" | "type";
  submit?: boolean;
  key?: string;
  modifiers?: string[];
  dx?: number;
  dy?: number;
  ms?: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

/** 键名白名单（未知键在本地拒绝，BR-23） */
const KEY_NAMES = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
]);

const MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);
const REF_PATTERN = /^e\d{1,6}$/;

export type ValidationResult =
  | { ok: true; actions: ActAction[] }
  | { ok: false; code: BrowserErrorCode; message: string; detail?: { host?: string } };

/** [BR-48] 动作缺失/为空的自纠文案（必须同时含三点） */
const EMPTY_ACTIONS_HINT =
  "actions 必填且必须是「非空数组」，每一项形如 {\"action\":\"click\",\"ref\":\"e12\"}。" +
  "若你确认已经下发动作，很可能是单次动作过多导致参数被平台截断；" +
  "建议减少单次动作数量（建议 ≤5）后重试。最小示例：{\"actions\":[{\"action\":\"click\",\"ref\":\"e3\"}]}";

function numOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOf(v: unknown): number | null {
  const n = numOf(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * [设计 §9.1] 校验流水线 ①～⑥（全部本地完成，0 次浏览器操作）。
 * 会话解析（⑦）在门面完成。
 */
export function validateActArgs(raw: unknown): ValidationResult {
  // ② 存在且为非空数组（容忍模型把单个对象当成数组下发）
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    list = [raw];
  }
  if (list.length === 0) {
    return { ok: false, code: "invalid_request", message: `未收到任何动作。${EMPTY_ACTIONS_HINT}` };
  }

  // ③ 数量上限
  const max = Math.max(1, Number(env.BROWSER_MAX_ACTIONS) || 10);
  if (list.length > max) {
    return {
      ok: false,
      code: "invalid_request",
      message:
        `共收到 ${list.length} 个动作，超过单次上限 ${max}。` +
        "请减少单次动作数量（建议 ≤5）后重试；已完成的动作不会回滚，注意不要重复执行已生效的步骤。",
    };
  }

  // ⑤ 逐动作字段校验
  const actions: ActAction[] = [];
  for (let i = 0; i < list.length; i++) {
    const at = i + 1;
    const item = list[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, code: "invalid_request", message: `第 ${at} 个动作不是对象。` };
    }
    const o = item as Record<string, unknown>;
    const name = typeof o.action === "string" ? o.action.trim() : "";
    if (!name) {
      return {
        ok: false,
        code: "invalid_request",
        message: `第 ${at} 个动作缺少 action 字段。合法取值：${ACTIONS.join(" / ")}。${EMPTY_ACTIONS_HINT}`,
      };
    }
    if (!(ACTIONS as readonly string[]).includes(name)) {
      return {
        ok: false,
        code: "invalid_request",
        message: `第 ${at} 个动作的 action 非法：${previewText(name, 20)}。合法取值：${ACTIONS.join(" / ")}。`,
      };
    }
    const action = name as ActionName;
    const a: ActAction = { action };

    if (action === "nav") {
      const pre = precheckUrl(o.url);
      if (!pre.ok) {
        if (pre.verdict.reason === "protocol" || pre.verdict.reason === "credentials") {
          return {
            ok: false,
            code: "invalid_request",
            message: `第 ${at} 个动作 nav 的 url 不合法：${pre.detail}。必须是含 host 的 http/https 地址，且不得包含用户名或密码。`,
          };
        }
        return {
          ok: false,
          code: "blocked_url",
          message: `第 ${at} 个动作 nav 的目标地址被策略阻断：${reasonLabel(pre.verdict.reason)}（${pre.host}）。`,
          detail: { host: pre.host },
        };
      }
      a.url = pre.url;
    } else {
      if (o.url !== undefined) {
        return {
          ok: false,
          code: "invalid_request",
          message: `第 ${at} 个动作（${action}）不接受 url 字段；只有 nav 使用 url。`,
        };
      }
    }

    const needRef: ActionName[] = ["click", "fill", "drag", "hover", "select"];
    if (needRef.includes(action)) {
      const ref = typeof o.ref === "string" ? o.ref.trim() : "";
      if (!ref) {
        return {
          ok: false,
          code: "invalid_request",
          message: `第 ${at} 个动作（${action}）缺少 ref。ref 只能取自上一次工具返回的元素清单，例如 {"action":"${action}","ref":"e12"}。`,
        };
      }
      if (!REF_PATTERN.test(ref)) {
        return {
          ok: false,
          code: "invalid_request",
          message: `第 ${at} 个动作（${action}）的 ref 格式非法：${previewText(ref, 20)}。ref 形如 e12，只能取自上一次工具返回的元素清单，不要自行编写选择器。`,
        };
      }
      a.ref = ref;
    }

    if (action === "drag") {
      const toRef = typeof o.toRef === "string" ? o.toRef.trim() : "";
      if (!toRef) {
        return {
          ok: false,
          code: "invalid_request",
          message: `第 ${at} 个动作（drag）缺少 toRef（拖拽终点元素）。`,
        };
      }
      if (!REF_PATTERN.test(toRef)) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（drag）的 toRef 格式非法：${previewText(toRef, 20)}。` };
      }
      if (toRef === a.ref) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（drag）的 toRef 不能与 ref 相同。` };
      }
      a.toRef = toRef;
    }

    if (action === "fill") {
      const text = typeof o.text === "string" ? o.text : o.text === undefined ? "" : String(o.text);
      if (text.length > 4000) {
        return {
          ok: false,
          code: "invalid_request",
          message: `第 ${at} 个动作（fill）的 text 过长：${text.length} 字符，上限 4000。`,
        };
      }
      if (text === "" && o.text === undefined) {
        return {
          ok: false,
          code: "invalid_request",
          message: `第 ${at} 个动作（fill）缺少 text（要输入的文本；清空请显式传空串）。`,
        };
      }
      a.text = text;
      const mode = typeof o.mode === "string" ? o.mode.trim() : "assign";
      if (mode !== "assign" && mode !== "type") {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（fill）的 mode 非法：${previewText(mode, 10)}。合法取值：assign / type。` };
      }
      a.mode = mode;
      if (o.submit !== undefined) a.submit = o.submit === true || o.submit === "true";
    }

    if (action === "select") {
      const text = typeof o.text === "string" ? o.text : "";
      if (!text) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（select）缺少 text（要选中的选项文本）。` };
      }
      a.text = text;
    }

    if (action === "press") {
      const key = typeof o.key === "string" ? o.key.trim() : "";
      if (!key) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（press）缺少 key（键名，如 Enter / Tab / Escape）。` };
      }
      if (!KEY_NAMES.has(key) && key.length !== 1) {
        return {
          ok: false,
          code: "invalid_request",
          message: `第 ${at} 个动作（press）的 key 不在白名单：${previewText(key, 12)}。可用：${[...KEY_NAMES].join(" / ")}，或单个可打印字符。`,
        };
      }
      a.key = key;
      if (o.modifiers !== undefined) {
        const rawMods = Array.isArray(o.modifiers) ? o.modifiers : [o.modifiers];
        const mods: string[] = [];
        for (const m of rawMods) {
          const s = typeof m === "string" ? m.trim() : "";
          if (!MODIFIERS.has(s)) {
            return {
              ok: false,
              code: "invalid_request",
              message: `第 ${at} 个动作（press）的修饰键非法：${previewText(String(m), 12)}。合法取值：Alt / Control / Meta / Shift。`,
            };
          }
          mods.push(s);
        }
        a.modifiers = mods;
      }
    }

    if (action === "scroll") {
      const dx = o.dx === undefined ? 0 : intOf(o.dx);
      const dy = o.dy === undefined ? 0 : intOf(o.dy);
      if (dx === null || dy === null) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（scroll）的 dx / dy 必须是整数像素。` };
      }
      if (Math.abs(dx) > 20000 || Math.abs(dy) > 20000) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（scroll）的 dx / dy 绝对值上限 20000。` };
      }
      if (dx === 0 && dy === 0) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（scroll）的 dx 与 dy 不能同时为 0。` };
      }
      a.dx = dx;
      a.dy = dy;
    }

    if (action === "wait") {
      const ms = o.ms === undefined ? 500 : intOf(o.ms);
      if (ms === null || ms < 0) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（wait）的 ms 必须为非负整数毫秒。` };
      }
      if (ms > 5000) {
        return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（wait）的 ms 上限 5000，收到 ${ms}。` };
      }
      a.ms = ms;
    }

    if (action === "click") {
      if (o.button !== undefined) {
        const b = typeof o.button === "string" ? o.button.trim() : "";
        if (b !== "left" && b !== "right" && b !== "middle") {
          return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（click）的 button 非法：${previewText(b, 10)}。合法取值：left / right / middle。` };
        }
        a.button = b;
      }
      if (o.clickCount !== undefined) {
        const c = intOf(o.clickCount);
        if (c === null || c < 1 || c > 3) {
          return { ok: false, code: "invalid_request", message: `第 ${at} 个动作（click）的 clickCount 必须为 1–3。` };
        }
        a.clickCount = c;
      }
    }

    actions.push(a);
  }

  // ④ nav 不得与其他动作同批（BR-19）
  const hasNav = actions.some((a) => a.action === "nav");
  if (hasNav && actions.length > 1) {
    return {
      ok: false,
      code: "invalid_request",
      message:
        "nav 不能与其他动作放在同一次调用里：跳转后页面上所有元素引用都会失效。" +
        "请拆成两次调用——先只发 nav，等返回新快照后，再用新的 ref 继续动作。",
    };
  }

  return { ok: true, actions };
}

// ============================================================
// 取消与超时（严格分离，BR-47）
// ============================================================

class CancelledError extends Error {
  constructor() {
    super("已取消");
    this.name = "CancelledError";
  }
}

class StepTimeoutError extends Error {
  constructor(public readonly limitMs: number) {
    super(`单步动作超时（${limitMs}ms）`);
    this.name = "StepTimeoutError";
  }
}

function runStep<T>(fn: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      f();
    };
    const onAbort = () => finish(() => reject(new CancelledError()));

    if (signal?.aborted) {
      finish(() => reject(new CancelledError()));
      return;
    }
    timer = setTimeout(() => finish(() => reject(new StepTimeoutError(timeoutMs))), Math.max(500, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
    fn().then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

// ============================================================
// 失败类别 → 需求错误码
// ============================================================

function mapKind(kind: DriverFailureKind, phase: "nav" | "step"): BrowserErrorCode {
  switch (kind) {
    case "not_found":
      return "element_not_found";
    case "not_interactable":
      return "element_not_interactable";
    case "nav_failed":
      return "navigation_failed";
    case "nav_timeout":
      return "navigation_timeout";
    case "timeout":
      return phase === "nav" ? "navigation_timeout" : "action_timeout";
    case "cancelled":
      return "cancelled";
    case "closed":
      return "session_not_found";
    case "launch_failed":
      return "browser_unavailable";
  }
}

// ============================================================
// 单步执行
// ============================================================

interface StepOk {
  ok: true;
  line: string;
  changed: boolean;
  navigated: boolean;
  degraded: boolean;
  /** 触发跳转时应返回完整快照 */
  wantFullSnapshot: boolean;
  logFields: string;
}

interface StepFail {
  ok: false;
  code: BrowserErrorCode;
  reason: string;
  logFields: string;
}

type StepOutcome = StepOk | StepFail;

const stepTimeoutMs = (): number => Math.max(1000, Number(env.BROWSER_ACTION_TIMEOUT_MS) || 8000);
const navTimeoutMs = (): number => Math.max(1000, Number(env.BROWSER_NAV_TIMEOUT_MS) || 20000);
const stableWindowMs = (): number => Math.max(0, Number(env.BROWSER_STABLE_WINDOW_MS) || 400);

interface ChangeInfo {
  changed: boolean;
  navigated: boolean;
}

async function detectChange(s: Session, d: BrowserDriver): Promise<ChangeInfo> {
  const r = await d.signature();
  if (!r.ok) return { changed: false, navigated: false };
  const base = s.baseline;
  const navigated = !!base && base.url !== r.value.url;
  const changed =
    !base || base.url !== r.value.url || base.title !== r.value.title || base.mutations !== r.value.mutations;
  if (navigated) bumpGeneration(s);
  s.baseline = r.value;
  return { changed, navigated };
}

/** 定位：一级属性 → 二级锚点（跨代次不兜底，§7.2） */
async function locate(s: Session, d: BrowserDriver, ref: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const entry = s.refTable.get(ref);
  if (!entry || entry.gen !== s.gen) {
    return {
      ok: false,
      reason: `未找到 ref ${ref}（页面已跳转或元素已移除）；请重新 observe 取新的 ref`,
    };
  }
  const byRef = await d.locateByRef(ref);
  if (byRef.ok) return { ok: true, id: byRef.value };
  const byAnchor = await d.locateByAnchor(entry.anchor);
  if (byAnchor.ok) return { ok: true, id: byAnchor.value };
  return { ok: false, reason: `ref ${ref} 已失效且无法按锚点唯一定位；请重新 observe 取值` };
}

function roleTagOf(s: Session, ref: string): { tag: string; inputType: string } {
  const a = s.refTable.get(ref)?.anchor;
  return { tag: a?.tag ?? "", inputType: a?.inputType ?? "" };
}

/** 点击前的「滚动 + 矩形 + 命中测试」公共准备（BR-20） */
async function preparePoint(
  d: BrowserDriver,
  id: string,
): Promise<{ ok: true; x: number; y: number } | { ok: false; code: BrowserErrorCode; reason: string }> {
  await d.scrollIntoView(id);
  const box = await d.boxOf(id);
  if (!box.ok) return { ok: false, code: "element_not_found", reason: box.reason };
  const b = box.value;
  if (b.width < 1 || b.height < 1) {
    return { ok: false, code: "element_not_interactable", reason: "元素尺寸为零（不可见）" };
  }
  const x = Math.round(b.x + b.width / 2);
  const y = Math.round(b.y + b.height / 2);
  const hit = await d.hitTest(id, x, y);
  if (!hit.ok || hit.value !== true) {
    return { ok: false, code: "element_not_interactable", reason: "元素中心点被其它元素遮挡" };
  }
  return { ok: true, x, y };
}

async function execOne(
  s: Session,
  d: BrowserDriver,
  a: ActAction,
): Promise<StepOutcome> {
  const tag = `action=${a.action}`;

  if (a.action === "nav") {
    const res = await d.navigate(a.url ?? "", {
      timeoutMs: navTimeoutMs(),
      stableMs: stableWindowMs(),
    });
    if (!res.ok) {
      return {
        ok: false,
        code: mapKind(res.kind, "nav"),
        reason: res.reason,
        logFields: `${tag}｜url=${urlForLog(a.url ?? "")}`,
      };
    }
    bumpGeneration(s);
    s.baseline = null;
    return {
      ok: true,
      line: `nav → 已导航到 ${res.value.url}${res.value.title ? `（${res.value.title}）` : ""}`,
      changed: true,
      navigated: true,
      degraded: false,
      wantFullSnapshot: true,
      logFields: `${tag}｜url=${urlForLog(res.value.url)}`,
    };
  }

  if (a.action === "wait") {
    await d.sleep(Math.max(0, a.ms ?? 500));
    const ch = await detectChange(s, d);
    return {
      ok: true,
      line: `wait ${a.ms ?? 500}ms → 已等待${ch.changed ? "（页面已变化）" : "（页面未变化）"}`,
      changed: ch.changed,
      navigated: ch.navigated,
      degraded: false,
      wantFullSnapshot: false,
      logFields: `${tag}｜ms=${a.ms ?? 500}`,
    };
  }

  if (a.action === "scroll") {
    const dx = a.dx ?? 0;
    const dy = a.dy ?? 0;
    const r = await d.wheel(dx, dy);
    if (!r.ok) {
      return { ok: false, code: mapKind(r.kind, "step"), reason: r.reason, logFields: `${tag}｜dx=${dx}｜dy=${dy}` };
    }
    const ch = await detectChange(s, d);
    return {
      ok: true,
      line: `scroll(${dx},${dy}) → 已滚动${ch.changed ? "（页面已变化）" : "（页面未变化，可能已到边界）"}`,
      changed: ch.changed,
      navigated: ch.navigated,
      degraded: false,
      wantFullSnapshot: false,
      logFields: `${tag}｜dx=${dx}｜dy=${dy}`,
    };
  }

  // press 作用于「当前焦点元素」，不依赖 ref，必须在定位分支之前处理（BR-23）
  if (a.action === "press") {
    const r = await d.pressKey(a.key ?? "", a.modifiers ?? []);
    if (!r.ok) {
      return {
        ok: false,
        code: mapKind(r.kind, "step"),
        reason: r.reason,
        logFields: `${tag}｜key=${previewText(a.key ?? "", 12)}`,
      };
    }
    const ch = await detectChange(s, d);
    return {
      ok: true,
      line: `press ${a.key}${(a.modifiers ?? []).length > 0 ? `+${(a.modifiers ?? []).join("+")}` : ""} → 已派发${
        ch.changed ? "（页面已变化）" : "（页面未变化）"
      }`,
      changed: ch.changed,
      navigated: ch.navigated,
      degraded: false,
      wantFullSnapshot: ch.navigated,
      logFields: `${tag}｜key=${previewText(a.key ?? "", 12)}`,
    };
  }

  // 其余动作都需要 ref
  const ref = a.ref ?? "";
  const loc = await locate(s, d, ref);
  if (!loc.ok) {
    return { ok: false, code: "element_not_found", reason: loc.reason, logFields: `${tag}｜ref=${ref}` };
  }
  const id = loc.id;
  const meta = roleTagOf(s, ref);

  if (a.action === "hover") {
    const pt = await preparePoint(d, id);
    if (!pt.ok) return { ok: false, code: pt.code, reason: pt.reason, logFields: `${tag}｜ref=${ref}` };
    const mv = await d.movePointer(pt.x, pt.y);
    if (!mv.ok) return { ok: false, code: mapKind(mv.kind, "step"), reason: mv.reason, logFields: `${tag}｜ref=${ref}` };
    const ch = await detectChange(s, d);
    return {
      ok: true,
      line: `hover ${ref} → 已移入${ch.changed ? "（页面已变化）" : "（页面未变化）"}`,
      changed: ch.changed,
      navigated: ch.navigated,
      degraded: false,
      wantFullSnapshot: false,
      logFields: `${tag}｜ref=${ref}`,
    };
  }

  if (a.action === "click") {
    const pt = await preparePoint(d, id);
    if (!pt.ok) return { ok: false, code: pt.code, reason: pt.reason, logFields: `${tag}｜ref=${ref}` };
    const button = a.button ?? "left";
    const count = a.clickCount ?? 1;
    const c = await d.clickAt(pt.x, pt.y, button, count);
    if (!c.ok) {
      return { ok: false, code: mapKind(c.kind, "step"), reason: c.reason, logFields: `${tag}｜ref=${ref}` };
    }
    let ch = await detectChange(s, d);
    let degraded = false;
    let note = "";

    // 脚本点击只作降级：指针序列已派发但页面无变化，且元素具备原生激活语义（§8.2-click-3）
    if (!ch.changed && (meta.tag === "a" || meta.tag === "button" || meta.tag === "label")) {
      const sc = await d.scriptClick(id);
      if (sc.ok && sc.value) {
        degraded = true;
        ch = await detectChange(s, d);
        note = "（已降级为脚本点击）";
      }
    }
    if (ch.navigated) note += "（点击导致页面跳转）";
    return {
      ok: true,
      line: `click ${ref}${button !== "left" ? `[${button}]` : ""}${count > 1 ? `×${count}` : ""} → 已点击${
        ch.changed ? "（页面已变化）" : "（页面未变化）"
      }${note}`,
      changed: ch.changed,
      navigated: ch.navigated,
      degraded,
      wantFullSnapshot: ch.navigated,
      logFields: `${tag}｜ref=${ref}｜button=${button}｜count=${count}｜degraded=${degraded ? "yes" : "no"}｜navigated=${
        ch.navigated ? "yes" : "no"
      }`,
    };
  }

  if (a.action === "fill") {
    const text = a.text ?? "";
    const isPassword = meta.inputType === "password";
    await d.scrollIntoView(id);
    const focus = await d.focus(id);
    if (!focus.ok) {
      return { ok: false, code: mapKind(focus.kind, "step"), reason: focus.reason, logFields: `${tag}｜ref=${ref}` };
    }

    let written = "";
    let usedMode: "assign" | "type" = a.mode ?? "assign";

    if (usedMode === "assign") {
      const w = await d.fillValue(id, text);
      if (!w.ok) {
        return { ok: false, code: mapKind(w.kind, "step"), reason: w.reason, logFields: `${tag}｜ref=${ref}` };
      }
      written = w.value;
      if (written !== text) {
        // 受控组件把值回滚了：自动改走逐字输入再校验一次
        usedMode = "type";
      }
    }

    if (usedMode === "type") {
      await d.clearValue(id);
      const typed = await d.typeChars(text);
      if (!typed.ok) {
        return { ok: false, code: mapKind(typed.kind, "step"), reason: typed.reason, logFields: `${tag}｜ref=${ref}` };
      }
      const rb = await d.readValue(id);
      written = rb.ok ? rb.value : "";
    }

    if (written !== text) {
      return {
        ok: false,
        code: "element_not_interactable",
        reason: isPassword
          ? "密码字段的值未能写入（页面回滚）"
          : "输入值被页面回滚（读回与期望不一致）",
        logFields: `${tag}｜ref=${ref}｜mode=${usedMode}`,
      };
    }

    if (isPassword && text.length > 0) rememberSecret(s, text);

    let submitNote = "";
    if (a.submit) {
      const sb = await d.submitForm(id);
      if (!sb.ok || sb.value !== true) {
        await d.pressKey("Enter", []);
      }
      submitNote = "并已提交";
    }

    const ch = await detectChange(s, d);
    return {
      ok: true,
      line: `fill ${ref} → 已填写 ${text.length} 字${isPassword ? "（密码字段，值不回显）" : ""}${submitNote}${
        ch.changed ? "（页面已变化）" : "（页面未变化）"
      }`,
      changed: ch.changed,
      navigated: ch.navigated,
      degraded: usedMode === "type",
      wantFullSnapshot: ch.navigated,
      logFields: `${tag}｜ref=${ref}｜mode=${usedMode}｜chars=${text.length}${
        isPassword ? "｜password=yes" : `｜text=${previewText(text, 20)}`
      }`,
    };
  }

  if (a.action === "select") {
    const text = a.text ?? "";
    await d.scrollIntoView(id);
    const r = await d.selectOption(id, text);
    if (!r.ok) {
      return {
        ok: false,
        code: r.kind === "not_interactable" ? "element_not_interactable" : "element_not_found",
        reason: r.reason,
        logFields: `${tag}｜ref=${ref}`,
      };
    }
    const ch = await detectChange(s, d);
    return {
      ok: true,
      line: `select ${ref} → 已选中「${previewText(r.value.value, 30)}」${ch.changed ? "（页面已变化）" : "（页面未变化）"}`,
      changed: ch.changed,
      navigated: ch.navigated,
      degraded: false,
      wantFullSnapshot: ch.navigated,
      logFields: `${tag}｜ref=${ref}｜value=${previewText(r.value.value, 20)}`,
    };
  }

  // drag：三档策略链（BR-22）
  const toRef = a.toRef ?? "";
  const toLoc = await locate(s, d, toRef);
  if (!toLoc.ok) {
    return { ok: false, code: "element_not_found", reason: toLoc.reason, logFields: `${tag}｜ref=${ref}｜toRef=${toRef}` };
  }
  const toId = toLoc.id;

  await d.armDrag();
  const ptFrom = await preparePoint(d, id);
  if (!ptFrom.ok) return { ok: false, code: ptFrom.code, reason: ptFrom.reason, logFields: `${tag}｜ref=${ref}` };
  const ptTo = await preparePoint(d, toId);
  if (!ptTo.ok) {
    return {
      ok: false,
      code: ptTo.code,
      reason: `拖拽终点不可交互：${ptTo.reason}`,
      logFields: `${tag}｜ref=${ref}｜toRef=${toRef}`,
    };
  }

  const steps = Math.max(10, Math.min(60, Number(env.BROWSER_DRAG_STEPS) || 12));
  let strategy = "";
  let degraded = false;

  // ① 指针序列
  const p1 = await d.dragPointer({ x: ptFrom.x, y: ptFrom.y }, { x: ptTo.x, y: ptTo.y }, steps);
  let ch = await detectChange(s, d);
  const fired1 = await d.dragFired();
  if (p1.ok && (ch.changed || (fired1.ok && fired1.value > 0))) strategy = "指针序列";

  // ② 原生 HTML5 拖放
  if (!strategy) {
    const p2 = await d.dragNativeHtml5({ x: ptFrom.x, y: ptFrom.y }, { x: ptTo.x, y: ptTo.y });
    ch = await detectChange(s, d);
    const fired2 = await d.dragFired();
    if (p2.ok && (ch.changed || (fired2.ok && fired2.value > 0))) strategy = "原生 HTML5 拖放";
  }

  // ③ 合成拖放事件兜底
  if (!strategy) {
    const p3 = await d.dragSynthetic(id, toId);
    ch = await detectChange(s, d);
    const fired3 = await d.dragFired();
    if (p3.ok && (ch.changed || (fired3.ok && fired3.value > 0))) {
      strategy = "合成拖放事件";
      degraded = true;
    }
  }

  if (!strategy) {
    return {
      ok: false,
      code: "element_not_interactable",
      reason:
        "拖拽未生效（三档策略均无页面变化）。常见原因：①步数被拖拽库判定为点击；②页面用自定义拖拽库拦截了原生事件；" +
        "③无头模式下拖放行为与有头不同。建议由用户改为有头模式（BROWSER_HEADLESS=false）后重试，或改用其它操作方式",
      logFields: `${tag}｜ref=${ref}｜toRef=${toRef}｜steps=${steps}｜strategy=none`,
    };
  }

  return {
    ok: true,
    line: `drag ${ref}→${toRef}（${steps} 步，策略：${strategy}）→ 已完成${
      ch.changed ? "（页面已变化）" : "（页面未变化，但页面侧拖放监听已触发）"
    }${degraded ? "（已使用合成事件，站点可能不完全响应）" : ""}`,
    changed: ch.changed,
    navigated: ch.navigated,
    degraded,
    wantFullSnapshot: ch.navigated,
    logFields: `${tag}｜ref=${ref}｜toRef=${toRef}｜steps=${steps}｜strategy=${strategy}`,
  };
}

// ============================================================
// 批次执行
// ============================================================

function compactSnapshotText(s: Session): Promise<string> {
  return buildSnapshot(s, s.driver, { mode: "compact" }).then((r) =>
    r.ok ? r.text : `（当前页面快照不可用：${r.reason}）`,
  );
}

/** 结构化日志（BR-49 / BR-50：不含正文全文、不含密码、URL 只留 host+path） */
function logStep(fields: {
  session: string;
  step: string;
  result: string;
  elapsedMs: number;
  code: string;
  target: string;
  detail: string;
}): void {
  console.log(
    [
      "[BR-49] browser",
      `session=${fields.session}`,
      `tool=act`,
      fields.step,
      `target=${fields.target}`,
      `status=${fields.result}`,
      `elapsed=${fields.elapsedMs}ms`,
      `code=${fields.code}`,
      fields.detail,
    ].join("｜"),
  );
}

export async function runAct(
  s: Session,
  actions: ActAction[],
  ctx?: ToolContext,
): Promise<Envelope> {
  const startedAt = Date.now();
  const d = s.driver;
  const total = actions.length;
  const doneLines: string[] = [];
  let anyChanged = false;
  let anyNavigated = false;
  let anyDegraded = false;
  let lastAction = actions[0]?.action ?? "act";

  // 批次基线
  const base = await d.signature();
  if (base.ok) s.baseline = base.value;
  touch(s);

  for (let i = 0; i < total; i++) {
    const a = actions[i]!;
    lastAction = a.action;
    const stepStart = Date.now();

    if (ctx?.signal?.aborted) {
      const body = [
        `【已取消】用户停止了本次回答：已完成 ${doneLines.length}/${total} 步，其余 ${total - doneLines.length} 步未执行。`,
        ...doneLines.map((l, k) => `${k + 1}. ${l}`),
        "已完成的步骤已在页面上生效，重试时不要重复执行。",
      ].join("\n");
      logStep({
        session: s.prefix,
        step: `step=${i + 1}/${total}`,
        result: "cancelled",
        elapsedMs: Date.now() - startedAt,
        code: "cancelled",
        target: "-",
        detail: `动作=${a.action}`,
      });
      return failWithTail("cancelled", body);
    }

    let r: StepOutcome;
    try {
      r = await runStep(() => execOne(s, d, a), stepTimeoutMs(), ctx?.signal);
    } catch (err) {
      if (err instanceof CancelledError) {
        const body = [
          `【已取消】用户停止了本次回答：已完成 ${doneLines.length}/${total} 步，其余 ${total - doneLines.length} 步未执行。`,
          ...doneLines.map((l, k) => `${k + 1}. ${l}`),
          "已完成的步骤已在页面上生效，重试时不要重复执行。",
        ].join("\n");
        logStep({
          session: s.prefix,
          step: `step=${i + 1}/${total}`,
          result: "cancelled",
          elapsedMs: Date.now() - startedAt,
          code: "cancelled",
          target: "-",
          detail: `动作=${a.action}`,
        });
        return failWithTail("cancelled", body);
      }
      const isTimeout = err instanceof StepTimeoutError;
      const code: BrowserErrorCode = isTimeout ? "action_timeout" : "internal_error";
      const reason = err instanceof Error ? err.message : String(err);
      logStep({
        session: s.prefix,
        step: `step=${i + 1}/${total}`,
        result: "error",
        elapsedMs: Date.now() - startedAt,
        code,
        target: "-",
        detail: `动作=${a.action}`,
      });
      return failureEnvelope(s, total, doneLines, i, a, code, reason);
    }

    logStep({
      session: s.prefix,
      step: `step=${i + 1}/${total}`,
      result: r.ok ? "ok" : "error",
      elapsedMs: Date.now() - stepStart,
      code: r.ok ? "-" : r.code,
      target: urlForLog(s.baseline?.url ?? ""),
      detail: r.logFields,
    });

    if (!r.ok) {
      return failureEnvelope(s, total, doneLines, i, a, r.code, r.reason);
    }

    doneLines.push(r.line);
    if (r.changed) anyChanged = true;
    if (r.navigated) anyNavigated = true;
    if (r.degraded) anyDegraded = true;

    // 跳转后后续动作的 ref 已全部失效：如实停止，避免「点错按钮」
    if (r.navigated && i < total - 1) {
      const snap = await buildSnapshot(s, d, { mode: "full" });
      const body = [
        `【已完成】${i + 1}/${total} 步｜会话 ${s.prefix}｜${s.headless ? "无头" : "有头"}｜总耗时 ${
          Date.now() - startedAt
        }ms`,
        ...doneLines.map((l, k) => `${k + 1}. ${l}`),
        "",
        `页面已跳转，剩余 ${total - i - 1} 个动作未执行（跳转后旧 ref 全部失效，继续执行会点错元素）。`,
        "如需继续，请用下面的新 ref 重新调用 act。",
        "",
        snap.ok ? snap.text : `（快照不可用：${snap.reason}）`,
      ].join("\n");
      return ok(withTail(body), {
        tool: "internet.browser.act",
        session: s.prefix,
        steps: i + 1,
        total,
        navigated: true,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  // 全部成功：有过变化 → 附紧凑快照；否则只提示 ref 继续有效
  const head = `【已完成】${total}/${total} 步｜会话 ${s.prefix}｜${s.headless ? "无头" : "有头"}｜总耗时 ${
    Date.now() - startedAt
  }ms`;
  const lines = [head, ...doneLines.map((l, k) => `${k + 1}. ${l}`)];

  if (anyChanged || anyNavigated) {
    lines.push("");
    const snap = await buildSnapshot(s, d, { mode: "compact" });
    lines.push(snap.ok ? snap.text : `（快照不可用：${snap.reason}）`);
  } else {
    lines.push("");
    lines.push("页面未变化，原有 ref 继续有效（无需重新 observe）。");
  }
  if (anyDegraded) lines.push("（本次执行中有步骤使用了降级通道：见各步说明）");

  return ok(withTail(lines.join("\n")), {
    tool: "internet.browser.act",
    session: s.prefix,
    steps: total,
    total,
    changed: anyChanged,
    navigated: anyNavigated,
    elapsedMs: Date.now() - startedAt,
  });
}

/** 三段式失败：已完成 / 失败步 / 当前紧凑快照（BR-17、BR-18） */
async function failureEnvelope(
  s: Session,
  total: number,
  doneLines: string[],
  failIndex: number,
  a: ActAction,
  code: BrowserErrorCode,
  reason: string,
): Promise<Envelope> {
  const snap = await compactSnapshotText(s);
  const donePart =
    doneLines.length > 0
      ? `【已完成】${doneLines.length}/${total} 步（这些步骤已在页面上生效，重试时不要重复执行）\n` +
        doneLines.map((l, k) => `${k + 1}. ${l}`).join("\n")
      : `【已完成】0/${total} 步（本次调用尚未对页面产生任何已完成的效果）`;

  const where = `第 ${failIndex + 1} 步失败：动作 \`${a.action}\`${a.ref ? `，ref \`${a.ref}\`` : ""}${
    a.toRef ? `，toRef \`${a.toRef}\`` : ""
  }，错误码 \`${code}\`：${describeFailure(code, reason)}`;

  const body = [donePart, where, `【当前页面快照】\n${snap}`].join("\n\n");
  return failWithTail(code, body);
}
