/**
 * etc/tools/internet/_browser_driver.ts
 * 驱动层：页面原语 + 事件 + 失败类别归一（BR-06 的「可替换单文件」）
 *
 * [需求] BR-06 换驱动只改本文件；BR-09 零第三方依赖；BR-20 真实指针序列；
 *        BR-41 导航判据=加载完成+稳定窗口；BR-42 在途命令可放弃
 * [设计] §3.2 原语清单、§3.3 Chromium 实现要点、§3.4 超时落点
 *
 * 边界（DG-02）：本文件只产出「页面事实」并把底层失败归一为失败类别；
 *   **不产出快照文本、不分配 ref、不决定需求错误码**。
 * 注入点（NB-04）：`setDriverFactoryForTest()` 可整体替换驱动，用例全程零真实浏览器。
 */
import type { ChildProcess } from "node:child_process";
import { env } from "@/infra/env";
import { CdpConnection, CdpClosedError } from "./_browser_cdp";
import { buildArgs, proc } from "./_browser_proc";

// ============================================================
// 类型：事实与失败类别
// ============================================================

export type DriverFailureKind =
  | "not_found"
  | "not_interactable"
  | "nav_failed"
  | "nav_timeout"
  | "timeout"
  | "cancelled"
  | "closed"
  | "launch_failed";

export type DriverResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: DriverFailureKind; reason: string };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 元素事实（驱动产出，域内过滤/整形） */
export interface ElementFact {
  id: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  rect: Rect;
  visible: boolean;
  inputType: string;
  hasValue: boolean;
  value: string;
  checked: boolean;
  disabled: boolean;
  readOnly: boolean;
  href: string;
  placeholder: string;
  ref: string;
}

/** 锚点：ref 失效时的二级定位特征（同代次内才允许兜底） */
export interface ElementAnchor {
  name: string;
  placeholder: string;
  text: string;
  tag: string;
  inputType: string;
}

export interface CollectedFacts {
  facts: ElementFact[];
  total: number;
  nodes: number;
}

export interface PageSignature {
  url: string;
  title: string;
  mutations: number;
  ready: string;
}

export interface LaunchOptions {
  headless: boolean;
  profileDir: string;
  /** 每个请求的判定回调（请求层拦截，BR-52） */
  judgeRequest?: (url: string) => Promise<{ allow: boolean; reason?: string }>;
  allowDownload: boolean;
  allowUpload: boolean;
  onBlockedRequest?: (url: string, reason: string) => void;
  onDownloadBlocked?: () => void;
  onUploadBlocked?: () => void;
  onDisconnected?: (reason: string) => void;
}

export interface NavigateOptions {
  timeoutMs: number;
  stableMs: number;
}

/** 驱动契约：域内模块只依赖这个接口 */
export interface BrowserDriver {
  launch(o: LaunchOptions): Promise<DriverResult<{ port: number }>>;
  shutdown(): Promise<void>;
  navigate(url: string, o: NavigateOptions): Promise<DriverResult<{ url: string; title: string; timedOut: boolean }>>;
  collectFacts(): Promise<DriverResult<CollectedFacts>>;
  signature(): Promise<DriverResult<PageSignature>>;
  bodyText(): Promise<DriverResult<string>>;
  assignRefs(pairs: Array<{ id: string; ref: string }>): Promise<DriverResult<number>>;
  locateByRef(ref: string): Promise<DriverResult<string>>;
  locateByAnchor(a: ElementAnchor): Promise<DriverResult<string>>;
  scrollIntoView(id: string): Promise<DriverResult<boolean>>;
  boxOf(id: string): Promise<DriverResult<Rect & { visible: boolean }>>;
  hitTest(id: string, x: number, y: number): Promise<DriverResult<boolean>>;
  movePointer(x: number, y: number): Promise<DriverResult<void>>;
  clickAt(x: number, y: number, button: string, clickCount: number): Promise<DriverResult<void>>;
  scriptClick(id: string): Promise<DriverResult<boolean>>;
  dragPointer(from: { x: number; y: number }, to: { x: number; y: number }, steps: number): Promise<DriverResult<void>>;
  armDrag(): Promise<DriverResult<void>>;
  dragFired(): Promise<DriverResult<number>>;
  dragNativeHtml5(from: { x: number; y: number }, to: { x: number; y: number }): Promise<DriverResult<void>>;
  dragSynthetic(fromId: string, toId: string): Promise<DriverResult<void>>;
  focus(id: string): Promise<DriverResult<void>>;
  clearValue(id: string): Promise<DriverResult<void>>;
  fillValue(id: string, text: string): Promise<DriverResult<string>>;
  typeChars(text: string): Promise<DriverResult<void>>;
  readValue(id: string): Promise<DriverResult<string>>;
  pressKey(key: string, modifiers: string[]): Promise<DriverResult<void>>;
  selectOption(id: string, text: string): Promise<DriverResult<{ value: string }>>;
  submitForm(id: string): Promise<DriverResult<boolean>>;
  wheel(dx: number, dy: number): Promise<DriverResult<void>>;
  sleep(ms: number): Promise<DriverResult<void>>;
  isClosed(): boolean;
  /** 子进程号（进程级兜底清理用；假驱动可不实现） */
  processId?(): number | null;
}

// ============================================================
// 页面内库（只做「事实采集」与「元素级操作」，不含任何需求语义）
// ============================================================

const PAGE_LIB = `(function () {
  var V = 3;
  if (window.__wb && window.__wb.v === V) return;
  var ID = 'data-wb-k', REF = 'data-wb-ref';
  var ids = new WeakMap();
  var seq = 0;
  if (typeof window.__wbCount !== 'number') window.__wbCount = 0;
  if (typeof window.__wbDragCount !== 'number') window.__wbDragCount = 0;
  var SEL = 'a[href],button,input,select,textarea,[role],[onclick],[tabindex],[contenteditable=""],[contenteditable="true"]';

  function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }
  function cut(s, n) { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
  function ensureObs() {
    try {
      if (window.__wbObs) return;
      var target = document.documentElement || document;
      if (!target) return;
      window.__wbObs = new MutationObserver(function (list) { window.__wbCount = (window.__wbCount || 0) + list.length; });
      window.__wbObs.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch (e) {}
  }
  function idOf(el) {
    var v = ids.get(el);
    if (!v) { v = 'k' + (++seq); ids.set(el, v); try { el.setAttribute(ID, v); } catch (e) {} }
    return v;
  }
  function byId(id) { try { return document.querySelector('[' + ID + '="' + String(id).replace(/"/g, '') + '"]'); } catch (e) { return null; } }
  function byRef(ref) { try { return document.querySelector('[' + REF + '="' + String(ref).replace(/"/g, '') + '"]'); } catch (e) { return null; } }

  function visible(el) {
    try {
      var r = el.getBoundingClientRect();
      if (!(r.width >= 1 && r.height >= 1)) return false;
      var cs = window.getComputedStyle(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
      if (cs && cs.opacity !== '' && Number(cs.opacity) === 0) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.closest && el.closest('[inert]')) return false;
      return true;
    } catch (e) { return false; }
  }

  function roleOf(el) {
    var tag = el.tagName.toLowerCase();
    var t = (el.type || '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'clickable';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'file') return 'file';
      return 'textbox';
    }
    var r = el.getAttribute('role');
    if (r) return r;
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  }

  function nameOf(el) {
    var v = el.getAttribute ? el.getAttribute('aria-label') : '';
    if (norm(v)) return norm(v);
    var lb = el.getAttribute ? el.getAttribute('aria-labelledby') : '';
    if (lb) {
      var acc = lb.split(/\\s+/).map(function (id) {
        var n = document.getElementById(id);
        return n ? (n.textContent || '') : '';
      }).join(' ');
      if (norm(acc)) return norm(acc);
    }
    try {
      if (el.labels && el.labels.length) {
        var lt = Array.prototype.map.call(el.labels, function (l) { return l.textContent || ''; }).join(' ');
        if (norm(lt)) return norm(lt);
      }
    } catch (e) {}
    var txt = norm(el.innerText || el.textContent || '');
    if (txt) return txt;
    var ph = el.getAttribute ? el.getAttribute('placeholder') : '';
    if (norm(ph)) return norm(ph);
    var ti = el.getAttribute ? el.getAttribute('title') : '';
    if (norm(ti)) return norm(ti);
    var alt = el.getAttribute ? el.getAttribute('alt') : '';
    if (norm(alt)) return norm(alt);
    var tag = el.tagName.toLowerCase();
    if ((tag === 'input' || tag === 'textarea') && (el.type || '').toLowerCase() !== 'password' && norm(el.value)) return norm(el.value);
    return '';
  }

  function readValue(id) {
    var el = byId(id);
    if (!el) return null;
    var tag = el.tagName.toLowerCase();
    var t = (el.type || '').toLowerCase();
    if (t === 'password') return '';
    if (tag === 'input' || tag === 'textarea') return String(el.value == null ? '' : el.value);
    if (tag === 'select') {
      var o = el.selectedOptions && el.selectedOptions[0];
      return o ? norm(o.textContent) : String(el.value || '');
    }
    if (el.isContentEditable) return String(el.textContent || '');
    return '';
  }

  function displayValue(el) {
    var tag = el.tagName.toLowerCase();
    var t = (el.type || '').toLowerCase();
    if (t === 'password') return '';
    if (t === 'checkbox' || t === 'radio') return el.checked ? '已勾选' : '未勾选';
    return readValue(idOf(el)) || '';
  }

  function collect() {
    ensureObs();
    var out = [];
    var all = [];
    try { all = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch (e) { all = []; }
    var total = all.length;
    for (var i = 0; i < all.length && out.length < 1200; i++) {
      var el = all[i];
      var tag = el.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') continue;
      var r = el.getBoundingClientRect();
      out.push({
        id: idOf(el),
        tag: tag,
        role: roleOf(el),
        name: cut(nameOf(el), 160),
        text: cut(norm(el.innerText || el.textContent || ''), 160),
        rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        visible: visible(el),
        inputType: String(el.type || '').toLowerCase(),
        hasValue: !!(el.value && String(el.value).length > 0),
        value: cut(displayValue(el), 80),
        checked: !!el.checked,
        disabled: !!el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'),
        readOnly: !!el.readOnly,
        href: el.href ? String(el.href) : '',
        placeholder: (el.getAttribute && el.getAttribute('placeholder')) || '',
        ref: (el.getAttribute && el.getAttribute(REF)) || ''
      });
    }
    return {
      facts: out,
      total: total,
      nodes: document.getElementsByTagName('*').length
    };
  }

  function sig() {
    ensureObs();
    return {
      url: String(location.href),
      title: String(document.title || ''),
      mutations: window.__wbCount || 0,
      ready: String(document.readyState)
    };
  }

  function text() {
    var b = document.body;
    var t = b ? (b.innerText || b.textContent || '') : '';
    return String(t).replace(/[\\t\\r]+/g, ' ').replace(/ {2,}/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  }

  function assignRefs(pairs) {
    var n = 0;
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i] || {};
      var el = byId(p.id);
      if (!el) continue;
      try { el.setAttribute(REF, String(p.ref)); n++; } catch (e) {}
    }
    return n;
  }

  function idByRef(ref) { var el = byRef(ref); return el ? idOf(el) : null; }

  function anchorOf(el) {
    return {
      name: cut(nameOf(el), 160),
      placeholder: (el.getAttribute && el.getAttribute('placeholder')) || '',
      text: cut(norm(el.innerText || el.textContent || ''), 160),
      tag: el.tagName.toLowerCase(),
      inputType: String(el.type || '').toLowerCase()
    };
  }

  function anchorOfById(id) { var el = byId(id); return el ? anchorOf(el) : null; }

  function idByAnchor(a) {
    if (!a || !a.tag) return null;
    var all = [];
    try { all = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch (e) { return null; }
    var hit = null;
    for (var i = 0; i < all.length; i++) {
      var c = anchorOf(all[i]);
      if (c.tag !== a.tag) continue;
      if (a.inputType && c.inputType !== a.inputType) continue;
      if (a.name && c.name !== a.name) continue;
      if (a.placeholder && c.placeholder !== a.placeholder) continue;
      if (!a.name && !a.placeholder && a.text && c.text !== a.text) continue;
      if (!a.name && !a.placeholder && !a.text) continue;
      if (hit) return null;
      hit = all[i];
    }
    return hit ? idOf(hit) : null;
  }

  function scrollTo(id) {
    var el = byId(id);
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    return true;
  }

  function box(id) {
    var el = byId(id);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), visible: visible(el) };
  }

  function hitOk(id, x, y) {
    var el = byId(id);
    if (!el) return false;
    var hit = null;
    try { hit = document.elementFromPoint(x, y); } catch (e) { hit = null; }
    if (!hit) return false;
    if (hit === el || el.contains(hit)) return true;
    try { if (hit.tagName === 'LABEL' && hit.control === el) return true; } catch (e) {}
    try { if (el.labels && Array.prototype.indexOf.call(el.labels, hit) >= 0) return true; } catch (e) {}
    try { if (hit.closest && hit.closest('label') && el.labels && Array.prototype.indexOf.call(el.labels, hit.closest('label')) >= 0) return true; } catch (e) {}
    return false;
  }

  function focus(id) {
    var el = byId(id);
    if (!el) return false;
    try { el.focus(); } catch (e) {}
    return true;
  }

  function nativeSet(el, v) {
    try {
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) { d.set.call(el, v); return true; }
    } catch (e) {}
    try { el.value = v; return true; } catch (e2) { return false; }
  }

  function clear(id) {
    var el = byId(id);
    if (!el) return false;
    if (el.isContentEditable) { el.textContent = ''; }
    else nativeSet(el, '');
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    return true;
  }

  function fill(id, value) {
    var el = byId(id);
    if (!el) return { ok: false, why: 'not_found' };
    try { el.focus(); } catch (e) {}
    if (el.isContentEditable) { el.textContent = String(value); }
    else { nativeSet(el, String(value)); }
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}
    return { ok: true, value: readValue(id) };
  }

  function selectOption(id, wanted) {
    var el = byId(id);
    if (!el) return { ok: false, why: 'not_found' };
    if (el.tagName.toLowerCase() !== 'select') return { ok: false, why: 'not_select' };
    if (el.multiple) return { ok: false, why: 'multiple' };
    var want = norm(wanted);
    var opts = Array.prototype.slice.call(el.options || []);
    var hit = null;
    for (var i = 0; i < opts.length; i++) {
      if (norm(opts[i].textContent) === want || String(opts[i].value) === want) { hit = opts[i]; break; }
    }
    if (!hit) {
      return { ok: false, why: 'no_option', options: opts.slice(0, 10).map(function (o) { return cut(norm(o.textContent), 30); }) };
    }
    try { el.value = hit.value; } catch (e) {}
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}
    return { ok: true, value: readValue(id) };
  }

  function submit(id) {
    var el = byId(id);
    if (!el) return false;
    var form = el.form || (el.closest ? el.closest('form') : null);
    if (!form) return false;
    try {
      if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
      form.submit();
      return true;
    } catch (e) { return false; }
  }

  function click(id) {
    var el = byId(id);
    if (!el) return false;
    try { el.click(); return true; } catch (e) { return false; }
  }

  function armDrag() {
    if (window.__wbDragArmed) { window.__wbDragCount = 0; return true; }
    window.__wbDragArmed = true;
    window.__wbDragCount = 0;
    var types = ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'];
    for (var i = 0; i < types.length; i++) {
      (function (t) {
        document.addEventListener(t, function () { window.__wbDragCount = (window.__wbDragCount || 0) + 1; }, true);
      })(types[i]);
    }
    return true;
  }

  function dragSynthetic(fromId, toId) {
    var a = byId(fromId), b = byId(toId);
    if (!a || !b) return false;
    var dt = null;
    try { dt = new DataTransfer(); } catch (e) { dt = null; }
    function fire(el, type) {
      try { el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })); } catch (e) {}
    }
    fire(a, 'dragstart'); fire(a, 'drag'); fire(b, 'dragenter'); fire(b, 'dragover'); fire(b, 'drop'); fire(a, 'dragend');
    return true;
  }

  window.__wb = {
    v: V,
    collect: collect,
    sig: sig,
    text: text,
    assignRefs: assignRefs,
    idByRef: idByRef,
    idByAnchor: idByAnchor,
    anchorOf: anchorOf,
    anchorOfById: anchorOfById,
    scrollTo: scrollTo,
    box: box,
    hitOk: hitOk,
    focus: focus,
    clear: clear,
    fill: fill,
    readValue: readValue,
    select: selectOption,
    submit: submit,
    click: click,
    armDrag: armDrag,
    dragCount: function () { return window.__wbDragCount || 0; },
    dragSynthetic: dragSynthetic
  };
  ensureObs();
})()`;

// ============================================================
// 小工具
// ============================================================

const sleepMs = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dFail<T = never>(kind: DriverFailureKind, reason: string): DriverResult<T> {
  return { ok: false, kind, reason };
}

/** 键名白名单（未知键由域内判 invalid_request，这里只做映射） */
const KEY_DEFS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
};

const MODIFIER_VK: Record<string, number> = { Alt: 18, Control: 17, Meta: 91, Shift: 16 };
const MODIFIER_MASK: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

// ============================================================
// Chromium 实现
// ============================================================

class ChromiumDriver implements BrowserDriver {
  private cdp: CdpConnection | null = null;
  private sid = "";
  private child: ChildProcess | null = null;
  private port = 0;
  private closed = false;
  private closeReason = "";
  private launchOpts: LaunchOptions | null = null;
  private blockedCount = 0;

  // ---------- 基础收发 ----------

  private async cmd(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const cdp = this.cdp;
    if (!cdp) throw new CdpClosedError(this.closeReason || "会话已关闭");
    return cdp.send(method, params, this.sid, timeoutMs);
  }

  private async rawEval(expression: string, timeoutMs = 15_000): Promise<unknown> {
    const res = await this.cmd(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    const ex = res.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    if (ex) {
      const text = ex.exception?.description ?? ex.text ?? "未知异常";
      throw new Error(`页面脚本执行失败：${text}`);
    }
    const r = res.result as { value?: unknown } | undefined;
    return r ? r.value : undefined;
  }

  /** 调用页面内库；库缺失（新文档尚未注入）时补注入一次后重试 */
  private async callPage<T>(fn: string, ...args: unknown[]): Promise<T> {
    const list = args.map((a) => JSON.stringify(a)).join(",");
    const expr = `(window.__wb ? window.__wb.${fn}(${list}) : "__MISSING__")`;
    let v = await this.rawEval(expr);
    if (v === "__MISSING__") {
      await this.rawEval(PAGE_LIB);
      v = await this.rawEval(expr);
      if (v === "__MISSING__") throw new Error("页面内库注入失败");
    }
    return v as T;
  }

  private fail<T = never>(err: unknown): DriverResult<T> {
    if (err instanceof CdpClosedError) {
      return dFail<T>("closed", this.closeReason || err.message);
    }
    const text = msgOf(err);
    if (text.includes("超时")) return dFail<T>("timeout", text);
    if (text.includes("Execution context was destroyed") || text.includes("Cannot find context")) {
      return dFail<T>("closed", "页面上下文已切换（可能正在跳转或已关闭）");
    }
    return dFail<T>("timeout", text);
  }

  // ---------- 生命周期 ----------

  async launch(o: LaunchOptions): Promise<DriverResult<{ port: number }>> {
    this.launchOpts = o;
    const exe = proc().resolveExecutable();
    if (!exe.path) {
      return dFail(
        "launch_failed",
        `未找到浏览器可执行文件（已尝试：${exe.tried.join(" / ") || "无候选路径"}）`,
      );
    }

    let port = 0;
    try {
      const configured = Number(env.BROWSER_DEBUG_PORT);
      if (Number.isInteger(configured) && configured > 0) {
        if (await proc().isPortBusy(configured)) {
          return dFail(
            "launch_failed",
            `调试端口 ${configured} 已被占用；请在配置中改用其它端口，或设为 0 由程序随机分配`,
          );
        }
        port = configured;
      } else {
        port = await proc().pickFreePort();
      }
    } catch (err) {
      return dFail("launch_failed", `无法分配调试端口：${msgOf(err)}`);
    }

    let child: ChildProcess;
    try {
      child = proc().spawnBrowser(
        exe.path,
        buildArgs({ headless: o.headless, userDataDir: o.profileDir, port }),
      );
    } catch (err) {
      return dFail("launch_failed", `启动浏览器进程失败：${msgOf(err)}`);
    }
    this.child = child;
    this.port = port;

    const wsUrl = await this.waitEndpoint(port, child, 15_000);
    if (!wsUrl) {
      await this.hardKill();
      return dFail("launch_failed", `浏览器进程已启动但未能在 15s 内取得调试地址（端口 ${port}）`);
    }

    let cdp: CdpConnection;
    try {
      cdp = await CdpConnection.open(wsUrl, 10_000);
    } catch (err) {
      await this.hardKill();
      return dFail("launch_failed", `连接调试地址失败：${msgOf(err)}`);
    }
    this.cdp = cdp;

    try {
      const t = (await cdp.send("Target.createTarget", { url: "about:blank" }, undefined, 10_000)) as {
        targetId?: string;
      };
      const targetId = String(t.targetId ?? "");
      if (!targetId) throw new Error("未能创建页面目标");
      const a = (await cdp.send(
        "Target.attachToTarget",
        { targetId, flatten: true },
        undefined,
        10_000,
      )) as { sessionId?: string };
      this.sid = String(a.sessionId ?? "");
      if (!this.sid) throw new Error("未能附着到页面目标");

      await this.cmd("Page.enable", {});
      await this.cmd("Runtime.enable", {});
      await this.cmd("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_LIB });
      await this.rawEval(PAGE_LIB);
    } catch (err) {
      await this.hardKill();
      return dFail("launch_failed", `初始化调试会话失败：${msgOf(err)}`);
    }

    this.installPolicies(o);
    return { ok: true, value: { port } };
  }

  private installPolicies(o: LaunchOptions): void {
    const cdp = this.cdp;
    if (!cdp) return;

    // ① 下载：默认拒绝，并监听开始事件兜底取消（BR-54）
    void cdp
      .send(
        "Browser.setDownloadBehavior",
        { behavior: o.allowDownload ? "default" : "deny", eventsEnabled: true },
        undefined,
        5_000,
      )
      .catch(() => {
        /* 老版本内核可能不支持 eventsEnabled，降级为静默 */
      });

    cdp.on("Browser.downloadWillBegin", (params) => {
      this.blockedCount++;
      const guid = String(params.guid ?? "");
      if (guid) void cdp.send("Browser.cancelDownload", { guid }, undefined, 5_000).catch(() => undefined);
      o.onDownloadBlocked?.();
    });

    // ② 上传/文件选择：拦截并记录（BR-54）
    void this.cmd("Page.setInterceptFileChooserDialog", { enabled: true }, 5_000).catch(() => undefined);
    cdp.on("Page.fileChooserOpened", () => {
      this.blockedCount++;
      o.onUploadBlocked?.();
    });

    // ③ 请求层拦截（BR-52）：逐个请求判定
    if (o.judgeRequest) {
      const judge = o.judgeRequest;
      cdp.on("Fetch.requestPaused", (params, sid) => {
        const requestId = String(params.requestId ?? "");
        const request = (params.request as { url?: string } | undefined) ?? {};
        const url = String(request.url ?? "");
        void (async () => {
          if (!requestId) return;
          let allow = true;
          let reason = "";
          if (o.allowUpload && url.startsWith("blob:")) allow = true;
          try {
            const v = await judge(url);
            allow = v.allow;
            reason = v.reason ?? "";
          } catch {
            allow = false;
            reason = "判定异常";
          }
          try {
            if (allow) {
              await cdp.send("Fetch.continueRequest", { requestId }, sid, 10_000);
            } else {
              this.blockedCount++;
              o.onBlockedRequest?.(url, reason);
              await cdp.send(
                "Fetch.failRequest",
                { requestId, errorReason: "BlockedByClient" },
                sid,
                10_000,
              );
            }
          } catch {
            /* 连接已断开时忽略 */
          }
        })();
      });
      void cdp
        .send(
          "Fetch.enable",
          { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
          this.sid,
          10_000,
        )
        .catch(() => undefined);

      // 粗粒度兜底：覆盖请求暂停事件覆盖不到的资源类型（WebSocket 等，已知缺口）
      if (env.BROWSER_BLOCK_PRIVATE_NET) {
        void this.cmd(
          "Network.setBlockedURLs",
          {
            urls: [
              "http://127.0.0.1:*",
              "http://localhost:*",
              "http://10.*",
              "http://192.168.*",
              "http://169.254.*",
            ],
          },
          5_000,
        ).catch(() => undefined);
      }
    }

    // ④ 断开检测（BR-41 / 会话失效）
    cdp.on("Inspector.detached", () => this.markClosed("调试会话被浏览器断开"));
    cdp.on("__closed__", () => this.markClosed(cdp.reasonOfClose || "连接已关闭"));

    this.child?.once("exit", (code) => {
      this.markClosed(`浏览器进程已退出（code=${String(code ?? "")}）`);
    });
  }

  private markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.launchOpts?.onDisconnected?.(reason);
  }

  /** 从进程输出解析调试地址；失败则轮询版本端点 */
  private waitEndpoint(port: number, child: ChildProcess, timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        resolve(v);
      };

      let buf = "";
      const onData = (chunk: unknown) => {
        buf += String(chunk);
        const m = buf.match(/(ws:\/\/[^\s'"]+)/);
        if (m && m[1]) finish(m[1]);
        if (buf.length > 32_000) buf = buf.slice(-8000);
      };
      child.stderr?.on("data", onData);
      child.stdout?.on("data", onData);
      child.once("exit", () => finish(null));

      const startedAt = Date.now();
      timer = setInterval(() => {
        if (done) return;
        if (Date.now() - startedAt > timeoutMs) {
          finish(null);
          return;
        }
        void (async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
              signal: AbortSignal.timeout(1200),
            });
            if (!r.ok) return;
            const j = (await r.json()) as { webSocketDebuggerUrl?: string };
            const u = typeof j.webSocketDebuggerUrl === "string" ? j.webSocketDebuggerUrl : "";
            if (u) finish(u);
          } catch {
            /* 尚未就绪 */
          }
        })();
      }, 300);
    });
  }

  private async hardKill(): Promise<void> {
    try {
      this.cdp?.close("启动失败清理");
    } catch {
      /* ignore */
    }
    this.cdp = null;
    const pid = this.child?.pid;
    if (pid) await proc().killTree(pid);
    this.child = null;
    this.closed = true;
  }

  async shutdown(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    this.sid = "";
    if (cdp) {
      try {
        await cdp.send("Browser.close", {}, undefined, 3000);
      } catch {
        /* 浏览器可能已退出 */
      }
      cdp.close("会话关闭");
    }
    const pid = this.child?.pid;
    if (pid) await proc().killTree(pid);
    this.child = null;
    this.closed = true;
    this.closeReason = "会话已关闭";
  }

  isClosed(): boolean {
    return this.closed;
  }

  processId(): number | null {
    return this.child?.pid ?? null;
  }

  blockedRequestCount(): number {
    return this.blockedCount;
  }

  // ---------- 导航 ----------

  async navigate(
    url: string,
    o: NavigateOptions,
  ): Promise<DriverResult<{ url: string; title: string; timedOut: boolean }>> {
    if (this.closed) return dFail("closed", this.closeReason || "会话已关闭");
    try {
      const res = await this.cmd("Page.navigate", { url }, Math.max(1000, o.timeoutMs));
      const errorText = typeof res.errorText === "string" ? res.errorText : "";
      if (errorText) return dFail("nav_failed", `导航失败：${errorText}`);
    } catch (err) {
      return this.fail(err);
    }

    const startedAt = Date.now();
    let lastChange = Date.now();
    let lastMutations = -1;
    let timedOut = false;

    for (;;) {
      if (Date.now() - startedAt > o.timeoutMs) {
        timedOut = true;
        break;
      }
      let s: PageSignature | null = null;
      try {
        s = await this.callPage<PageSignature>("sig");
      } catch {
        s = null;
      }
      if (s) {
        if (s.mutations !== lastMutations) {
          lastMutations = s.mutations;
          lastChange = Date.now();
        }
        if (s.ready === "complete" && Date.now() - lastChange >= Math.max(0, o.stableMs)) break;
      }
      await sleepMs(120);
    }

    let final: PageSignature | null = null;
    try {
      final = await this.callPage<PageSignature>("sig");
    } catch {
      final = null;
    }
    if (timedOut && (!final || final.ready !== "complete")) {
      return dFail("nav_timeout", `导航超时（超过 ${o.timeoutMs}ms 未完成）`);
    }
    return {
      ok: true,
      value: { url: final?.url ?? url, title: final?.title ?? "", timedOut },
    };
  }

  // ---------- 事实 ----------

  async collectFacts(): Promise<DriverResult<CollectedFacts>> {
    try {
      const v = await this.callPage<{ facts: ElementFact[]; total: number; nodes: number }>("collect");
      return { ok: true, value: { facts: v.facts ?? [], total: v.total ?? 0, nodes: v.nodes ?? 0 } };
    } catch (err) {
      return this.fail(err);
    }
  }

  async signature(): Promise<DriverResult<PageSignature>> {
    try {
      return { ok: true, value: await this.callPage<PageSignature>("sig") };
    } catch (err) {
      return this.fail(err);
    }
  }

  async bodyText(): Promise<DriverResult<string>> {
    try {
      return { ok: true, value: String(await this.callPage<string>("text")) };
    } catch (err) {
      return this.fail(err);
    }
  }

  async assignRefs(pairs: Array<{ id: string; ref: string }>): Promise<DriverResult<number>> {
    try {
      return { ok: true, value: Number(await this.callPage<number>("assignRefs", pairs)) };
    } catch (err) {
      return this.fail(err);
    }
  }

  async locateByRef(ref: string): Promise<DriverResult<string>> {
    try {
      const id = await this.callPage<string | null>("idByRef", ref);
      return id ? { ok: true, value: id } : dFail("not_found", `页面中已找不到 ${ref} 对应元素`);
    } catch (err) {
      return this.fail(err);
    }
  }

  async locateByAnchor(a: ElementAnchor): Promise<DriverResult<string>> {
    try {
      const id = await this.callPage<string | null>("idByAnchor", a);
      return id ? { ok: true, value: id } : dFail("not_found", "按锚点在页面中无法唯一定位该元素");
    } catch (err) {
      return this.fail(err);
    }
  }

  async anchorOfRef(ref: string): Promise<ElementAnchor | null> {
    try {
      const id = await this.callPage<string | null>("idByRef", ref);
      if (!id) return null;
      return await this.callPage<ElementAnchor>("anchorOfById", id);
    } catch {
      return null;
    }
  }

  // ---------- 元素几何与指针 ----------

  async scrollIntoView(id: string): Promise<DriverResult<boolean>> {
    try {
      return { ok: true, value: Boolean(await this.callPage<boolean>("scrollTo", id)) };
    } catch (err) {
      return this.fail(err);
    }
  }

  async boxOf(id: string): Promise<DriverResult<Rect & { visible: boolean }>> {
    try {
      const b = await this.callPage<(Rect & { visible: boolean }) | null>("box", id);
      if (!b) return dFail("not_found", "元素已不在页面中");
      return { ok: true, value: b };
    } catch (err) {
      return this.fail(err);
    }
  }

  async hitTest(id: string, x: number, y: number): Promise<DriverResult<boolean>> {
    try {
      return { ok: true, value: Boolean(await this.callPage<boolean>("hitOk", id, x, y)) };
    } catch (err) {
      return this.fail(err);
    }
  }

  async movePointer(x: number, y: number): Promise<DriverResult<void>> {
    try {
      await this.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  async clickAt(x: number, y: number, button: string, clickCount: number): Promise<DriverResult<void>> {
    try {
      const btn = button === "right" ? "right" : button === "middle" ? "middle" : "left";
      await this.cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      const times = Math.min(3, Math.max(1, clickCount));
      for (let i = 1; i <= times; i++) {
        await this.cmd("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: btn,
          clickCount: i,
        });
        await this.cmd("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: btn,
          clickCount: i,
        });
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  async scriptClick(id: string): Promise<DriverResult<boolean>> {
    try {
      return { ok: true, value: Boolean(await this.callPage<boolean>("click", id)) };
    } catch (err) {
      return this.fail(err);
    }
  }

  async dragPointer(
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps: number,
  ): Promise<DriverResult<void>> {
    try {
      const n = Math.min(60, Math.max(10, steps));
      await this.cmd("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x,
        y: from.y,
        button: "none",
      });
      await this.cmd("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: from.x,
        y: from.y,
        button: "left",
        clickCount: 1,
      });
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        await this.cmd("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(from.x + (to.x - from.x) * t),
          y: Math.round(from.y + (to.y - from.y) * t),
          button: "left",
          buttons: 1,
        });
      }
      await this.cmd("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: to.x,
        y: to.y,
        button: "left",
        clickCount: 1,
      });
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  async armDrag(): Promise<DriverResult<void>> {
    try {
      await this.callPage<boolean>("armDrag");
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  async dragFired(): Promise<DriverResult<number>> {
    try {
      return { ok: true, value: Number(await this.callPage<number>("dragCount")) };
    } catch (err) {
      return this.fail(err);
    }
  }

  async dragNativeHtml5(from: { x: number; y: number }, to: { x: number; y: number }): Promise<DriverResult<void>> {
    try {
      // 原生拖放通道：CDP 直接投递 dragEnter / dragOver / drop（不经过 DOM 合成事件）
      const data = { items: [] as unknown[], dragOperationsMask: 1 };
      await this.cmd("Input.dispatchDragEvent", { type: "dragEnter", x: from.x, y: from.y, data });
      await this.cmd("Input.dispatchDragEvent", { type: "dragOver", x: to.x, y: to.y, data });
      await this.cmd("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  async dragSynthetic(fromId: string, toId: string): Promise<DriverResult<void>> {
    try {
      await this.callPage<boolean>("dragSynthetic", fromId, toId);
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  // ---------- 输入 ----------

  async focus(id: string): Promise<DriverResult<void>> {
    try {
      const ok = Boolean(await this.callPage<boolean>("focus", id));
      return ok ? { ok: true, value: undefined } : dFail("not_found", "元素已不在页面中");
    } catch (err) {
      return this.fail(err);
    }
  }

  async clearValue(id: string): Promise<DriverResult<void>> {
    try {
      const ok = Boolean(await this.callPage<boolean>("clear", id));
      return ok ? { ok: true, value: undefined } : dFail("not_found", "元素已不在页面中");
    } catch (err) {
      return this.fail(err);
    }
  }

  async fillValue(id: string, text: string): Promise<DriverResult<string>> {
    try {
      const r = await this.callPage<{ ok: boolean; value?: string; why?: string }>("fill", id, text);
      if (!r || !r.ok) return dFail("not_found", r?.why === "not_found" ? "元素已不在页面中" : "写入失败");
      return { ok: true, value: String(r.value ?? "") };
    } catch (err) {
      return this.fail(err);
    }
  }

  async typeChars(text: string): Promise<DriverResult<void>> {
    try {
      const delayMs = Math.min(100, Math.max(0, Number(env.BROWSER_TYPE_DELAY_MS) || 0));
      for (const ch of text) {
        await this.cmd("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
        await this.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        if (delayMs > 0) await sleepMs(delayMs);
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  async readValue(id: string): Promise<DriverResult<string>> {
    try {
      const v = await this.callPage<string | null>("readValue", id);
      if (v === null) return dFail("not_found", "元素已不在页面中");
      return { ok: true, value: String(v) };
    } catch (err) {
      return this.fail(err);
    }
  }

  async pressKey(key: string, modifiers: string[]): Promise<DriverResult<void>> {
    try {
      const mods = modifiers.filter((m) => Object.prototype.hasOwnProperty.call(MODIFIER_VK, m));
      let mask = 0;
      for (const m of mods) mask |= MODIFIER_MASK[m] ?? 0;

      // ① 按下修饰键
      for (const m of mods) {
        await this.cmd("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: m,
          code: m,
          windowsVirtualKeyCode: MODIFIER_VK[m] ?? 0,
          modifiers: mask,
        });
      }

      // ② 主键
      const def = KEY_DEFS[key];
      if (def) {
        const printable = typeof def.text === "string" && def.text.length > 0;
        await this.cmd("Input.dispatchKeyEvent", {
          type: printable ? "keyDown" : "rawKeyDown",
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.vk,
          nativeVirtualKeyCode: def.vk,
          modifiers: mask,
          ...(printable ? { text: def.text, unmodifiedText: def.text } : {}),
        });
        await this.cmd("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.vk,
          nativeVirtualKeyCode: def.vk,
          modifiers: mask,
        });
      } else {
        // 单字符：直接以字符事件派发
        await this.cmd("Input.dispatchKeyEvent", { type: "keyDown", text: key, unmodifiedText: key, key, modifiers: mask });
        await this.cmd("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers: mask });
      }

      // ③ 逆序释放修饰键
      for (const m of [...mods].reverse()) {
        await this.cmd("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: m,
          code: m,
          windowsVirtualKeyCode: MODIFIER_VK[m] ?? 0,
          modifiers: mask,
        });
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  async selectOption(id: string, text: string): Promise<DriverResult<{ value: string }>> {
    try {
      const r = await this.callPage<{ ok: boolean; value?: string; why?: string; options?: string[] }>(
        "select",
        id,
        text,
      );
      if (!r || !r.ok) {
        if (r?.why === "multiple") return dFail("not_interactable", "该下拉框为多选，本工具不支持多选");
        if (r?.why === "no_option") {
          const list = (r.options ?? []).join(" / ") || "（无可选项）";
          return dFail("not_found", `未找到匹配的选项文本，可选项：${list}`);
        }
        return dFail("not_found", "元素已不在页面中或不是下拉框");
      }
      return { ok: true, value: { value: String(r.value ?? "") } };
    } catch (err) {
      return this.fail(err);
    }
  }

  async submitForm(id: string): Promise<DriverResult<boolean>> {
    try {
      return { ok: true, value: Boolean(await this.callPage<boolean>("submit", id)) };
    } catch (err) {
      return this.fail(err);
    }
  }

  async wheel(dx: number, dy: number): Promise<DriverResult<void>> {
    try {
      const size = (await this.rawEval("({ w: window.innerWidth, h: window.innerHeight })")) as {
        w?: number;
        h?: number;
      };
      const x = Math.round((size?.w ?? 800) / 2);
      const y = Math.round((size?.h ?? 600) / 2);
      await this.cmd("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: dx,
        deltaY: dy,
        button: "none",
      });
      return { ok: true, value: undefined };
    } catch (err) {
      return this.fail(err);
    }
  }

  async sleep(ms: number): Promise<DriverResult<void>> {
    await sleepMs(ms);
    return { ok: true, value: undefined };
  }
}

// ============================================================
// 工厂 + 注入点（NB-04）
// ============================================================

export function createDriver(): BrowserDriver {
  return new ChromiumDriver();
}

let factory: () => BrowserDriver = () => new ChromiumDriver();

/** 用例注入假驱动；传 null 复原。假驱动须维护「命令记录器」供断言（NB-04） */
export function setDriverFactoryForTest(f: (() => BrowserDriver) | null): void {
  factory = f ?? (() => new ChromiumDriver());
}

export function newDriver(): BrowserDriver {
  return factory();
}

/** 供域内模块读取「本次执行中被请求层/下载/上传阻断的次数」 */
export function blockedCountOf(d: BrowserDriver): number {
  return d instanceof ChromiumDriver ? d.blockedRequestCount() : 0;
}
