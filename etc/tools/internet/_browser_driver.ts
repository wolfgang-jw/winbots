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
import { groupScope } from "@/infra/settings";

/** [规范 §7.3] 本文件服务 internet/browser 组；每次实时取值，禁止模块级缓存 */
const B = groupScope("internet", "browser");
import { CdpConnection, CdpClosedError } from "./_browser_cdp";
import { buildArgs, proc } from "./_browser_proc";
// [REQ-browser BR-01/BR-03] 目标发现与计数落在 _browser_targets.ts（NB-01：驱动不再承载标签逻辑）
import { ensureStartupPageTarget, tabFacts } from "./_browser_targets";
// [REQ-browser BR-10] 置前：类型 + 三步协议序列（序列在 _browser_foreground.ts，NB-01：驱动不再增长）
import { bringWindowToFront, type ForegroundResult } from "./_browser_foreground";
// [REQ-browser BR-16～BR-26] 标签中心：注册 / 附着 / 切换 / 关闭 / 编号 / 目标事件
//   NB-01：这些逻辑写在 _browser_targets.ts，驱动只留转发方法与「按活跃标签解析会话 id」
import { TargetHub, type TabBrief, type TabOp, type TabsSnapshot } from "./_browser_targets";

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
  | "launch_failed"
  /** [REQ-browser BR-27] 驱动/内核不支持该命令，或页面内库缺少该原语（非超时、非网络） */
  | "unsupported";

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
  /**
   * [FIX-LOCALHOST] 启动时定格的「阻断私网/回环」策略值。
   * 请求层判定发生在 CDP 异步回调中（已脱离 ALS 上下文），若届时再 `B.get()` 会回退默认值
   * （block_private_net 默认 true），使 setup.json 的 false 失效、localhost 被一律阻断。
   * 因此由调用方在 launch 时把实时配置快照传进来，驱动只用这份快照。
   */
  blockPrivateNet?: boolean;
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
  // [REQ-browser BR-02] 返回值追加可选 tabs（启动完成时的 page 目标数）；既有 port 字段不变
  launch(o: LaunchOptions): Promise<DriverResult<{ port: number; tabs?: number }>>;
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
  /**
   * [REQ-browser BR-27/BR-28] 按 CSS 选择器或 ref / 锚点取局部内容（**只读**）。
   * 追加方法、可选实现：假驱动未实现时 `extract` 返回 internal_error，
   * 其余 4 个工具完全不受影响（NB-03：接口只允许追加，不改既有签名）。
   */
  extractContent?(q: ExtractRequest): Promise<DriverResult<ExtractPayload>>;
  /**
   * [REQ-browser BR-02] 会话内 page 目标数与当前激活标签序号（1 起）。
   * 追加方法、可选实现：假驱动未实现时调用方按 1/1 缺省（NB-03）。
   */
  tabs?(): Promise<DriverResult<TabsFact>>;
  /**
   * [REQ-browser BR-10/BR-11] 把窗口带到最前：取窗口 → 恢复窗口状态（仅最小化时）→ 激活页面。
   * 追加方法、可选实现：假驱动未实现时调用方按「不适用」处理，**不因缺方法而让 open 失败**（NB-03）。
   * 语义是「尽力而为」：不抛错，失败只在返回值里体现（BR-13）。
   */
  bringToFront?(): Promise<ForegroundResult>;
  /**
   * [REQ-browser BR-17/BR-26] 与真实目标集合对账，返回当前标签摘要。
   * 追加方法、可选实现：假驱动未实现时调用方按「单标签隐式态」处理（NB-03）。
   */
  getTargets?(): Promise<TabOp<TabsSnapshot>>;
  /** [REQ-browser BR-16] 新建标签（`url` 传 about:blank，随后的导航仍走 navigate：见 P3 文档 §5 的 P-1） */
  createTarget?(url: string, maxTabs: number): Promise<TabOp<TabBrief>>;
  /** [REQ-browser BR-18] 切换活动标签（1 起序号 / prev / next） */
  switchTarget?(sel: number | "prev" | "next"): Promise<TabOp<{ index: number; count: number; targetId: string }>>;
  /** [REQ-browser BR-23] 关闭当前标签并回退（`targetId` = 回退后的活动标签） */
  closeTarget?(): Promise<TabOp<{ closedIndex: number; index: number; count: number; targetId: string }>>;
}

/**
 * [REQ-browser BR-02/BR-21] 标签事实。
 * P1 只定义 { count, activeIndex }；P3 只**追加可选** list，P1 的调用方与用例不受影响。
 */
export interface TabsFact {
  count: number;
  activeIndex: number;
  /** 存活标签清单（序号 / 地址 / 标题），供快照头部与结果文案使用 */
  list?: TabBrief[];
}

/**
 * [REQ-browser BR-27] 取文请求（页面侧 content(q) 的入参）。
 * 字段全部必填并由域内 `_browser_extract.ts::planOf` 统一归一：
 * 驱动层不做任何默认值填充，否则「谁负责缺省」会在两层之间漂移。
 */
export interface ExtractRequest {
  /** CSS 选择器（与 ref 二选一；ref 非空时本字段为空串） */
  selector: string;
  /** 目标元素的 data-wb-ref 值（空串 = 未指定） */
  ref: string;
  /** ref 在页面上找不到时的锚点兜底（与 act 的 locateByAnchor 同一套字段） */
  anchor: ElementAnchor | null;
  /** 1 起的命中序号；0 = 未指定（只有一个可选命中时自动取它） */
  index: number;
  /** 正文起始偏移（仅对已选定的那一个元素生效） */
  offset: number;
  includeHidden: boolean;
  includeHtml: boolean;
  /** 清单条数上限 = BROWSER_EXTRACT_MAX_ELEMENTS */
  maxItems: number;
  /** 单元素正文上限（固定 2000，BR-33） */
  itemChars: number;
}

/**
 * [REQ-browser BR-27/BR-29/BR-30] 取文结果（页面侧 `content()` 的返回）。
 * 「选择器语法非法」用 `badSelector` 标记表达，而**不是** DriverFailureKind ——
 * 后者是「驱动/传输层」的失败类别，把域内语法判定塞进去会让 mapKind 多出无意义的映射。
 */
export interface ExtractPayload {
  badSelector?: boolean;
  hits?: number;
  visibleHits?: number;
  skipped?: number;
  avail?: number;
  /** ref 与锚点都没在页面上命中（元素已被移除） */
  missRef?: boolean;
  truncated?: number;
  items?: Array<{
    tag: string;
    role: string;
    chars: number;
    visible: boolean;
    ref: string;
    preview: string;
  }>;
  /** 仅当已选定某个元素时存在 */
  body?: string;
  bodyStart?: number;
  bodyTotal?: number;
  html?: string;
}

// ============================================================
// 页面内库（只做「事实采集」与「元素级操作」，不含任何需求语义）
// ============================================================

const PAGE_LIB = `(function () {
  var V = 3;
  // [REQ-browser BR-27] ID / REF 两个常量必须**提到守卫之前**赋值：
  //   补装路径下守卫会直接 return，而 content()/byRef() 都要读 REF ——
  //   var 声明提升但**赋值不提升**，放在守卫之后会让 REF === undefined，
  //   byRef 拼出 '[undefined="e12"]' → ref 分支恒未命中、正文恒为空（且本地假驱动测不出来）。
  //   （ids / seq 仍必须留在守卫之后：它们是「重建即出错」的状态，见下）
  var ID = 'data-wb-k', REF = 'data-wb-ref';
  if (window.__wb && window.__wb.v === V) {
    // [REQ-browser BR-27] 不 bump V：改版本会重置 ids/seq，而 DOM 上残留的 data-wb-k 不会消失，
    //   于是 byId('k1') 可能命中旧元素（act 点到另一个元素）。
    //   但旧库可能缺「后加的原语」，所以在守卫里**就地补装**，绝不重建 __wb 对象。
    //   注：content / rawOf / elByAnchor 都是函数声明，在本 IIFE 作用域内已提升，此处可直接引用；
    //       它们只调用 norm / cut / visible / roleOf / anchorOf / byRef 等纯函数，不碰 ids/seq/__wbCount。
    if (typeof window.__wb.content !== 'function') window.__wb.content = content;
    return;
  }
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

  // [REQ-browser BR-27/BR-28/BR-32] 按定位取局部内容的**只读**原语：
  //   不写 DOM（不 setAttribute）、不碰 ids/seq（不调 idOf）、不碰 __wbCount（不建观察器）。
  //   BR-32 的三道门也在页面侧完成：tag 黑名单、可见性、表单值不回（只取 innerText/textContent，
  //   天然不含 input.value，因此密码框不会经由这里泄出）。
  //   ⚠️ 本函数被守卫处的「补装」路径引用，必须是**函数声明**（提升），不能改成 var 赋值。
  function content(q) {
    q = q || {};
    var BLOCK = { script: 1, style: 1, noscript: 1, template: 1, head: 1, meta: 1, link: 1 };
    var ref = String(q.ref || '');
    var list = [];
    var one = null;
    if (ref) {
      one = byRef(ref);
      if (!one && q.anchor && q.anchor.tag) one = elByAnchor(q.anchor);
      if (!one) return { ok: true, hits: 0, visibleHits: 0, skipped: 0, avail: 0, missRef: true, items: [], truncated: 0 };
      list = [one];
    } else {
      try { list = Array.prototype.slice.call(document.querySelectorAll(String(q.selector || ''))); }
      catch (e) { return { ok: false, why: 'bad_selector' }; }
    }
    var hits = list.length, vis = 0, skip = 0;
    var keep = [];
    var max = Math.max(1, Number(q.maxItems) || 20);
    var cap = Math.max(100, Number(q.itemChars) || 2000);
    for (var i = 0; i < list.length; i++) {
      var el = list[i], tag = String(el.tagName || '').toLowerCase();
      if (BLOCK[tag] === 1) { skip++; continue; }
      var shown = visible(el);
      if (shown) vis++;
      // ref 分支：目标元素即使当前不可见也要能取到正文，否则「按 ref 取文」恒为空
      if (q.includeHidden || shown || ref) keep.push(el);
    }
    var want = Number(q.index) > 0 ? Math.trunc(Number(q.index)) : (keep.length === 1 ? 1 : 0);
    var off = Math.max(0, Math.trunc(Number(q.offset) || 0));
    var out = { ok: true, hits: hits, visibleHits: vis, skipped: skip, avail: keep.length, items: [], truncated: Math.max(0, keep.length - max) };
    for (var k = 0; k < keep.length && k < max; k++) {
      var e = keep[k];
      var pre = rawOf(e);
      out.items.push({
        tag: String(e.tagName || '').toLowerCase(),
        role: roleOf(e),
        chars: pre.length,
        visible: visible(e),
        ref: (e.getAttribute && e.getAttribute(REF)) || '',
        preview: cut(norm(pre), 60)
      });
    }
    var target = want > 0 && want <= keep.length ? keep[want - 1] : null;
    if (target) {
      var full = rawOf(target);
      // [REQ-browser BR-33] offset 语义与 observe **完全一致**：越界回绕到 0（既有行为，AC-20 要求一致）
      var st = off >= full.length ? 0 : off;
      out.body = full.slice(st, st + cap);
      out.bodyStart = st;
      out.bodyTotal = full.length;
      if (q.includeHtml) out.html = cut(String(target.outerHTML || ''), cap);
    }
    return out;
  }

  /** [REQ-browser BR-32] 元素原文：innerText 优先（不可见元素返回空串），空了回退 textContent（与 nameOf 同口径） */
  function rawOf(el) {
    var v = String(el.innerText || '');
    if (!norm(v)) v = String(el.textContent || '');
    return v;
  }

  /** [REQ-browser BR-27] ref 失效时的锚点兜底：**返回元素**而不是 id（idOf 会写 DOM，BR-28 不允许） */
  function elByAnchor(a) {
    var all = [];
    try { all = document.getElementsByTagName(String(a.tag)); } catch (e) { return null; }
    var hit = null;
    for (var i = 0; i < all.length; i++) {
      var c = anchorOf(all[i]);
      if (a.inputType && c.inputType !== a.inputType) continue;
      if (a.name && c.name !== a.name) continue;
      if (a.placeholder && c.placeholder !== a.placeholder) continue;
      if (!a.name && !a.placeholder && (!a.text || c.text !== a.text)) continue;
      if (hit) return null;      // 多于一个：不做猜测（与 idByAnchor 同口径）
      hit = all[i];
    }
    return hit;
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
    // [REQ-browser BR-27] 按定位取局部内容（只读）；守卫里的「缺则补装」补的就是这个成员
    content: content,
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
  /** [REQ-browser BR-02] 启动期选中的 page 目标；P3 起语义升级为**当前活动标签**的 targetId */
  private targetId = "";
  private startupTabs = 1;
  /** [REQ-browser BR-16] targetId → 扁平会话 id（cmd 按活跃标签解析，见下） */
  private readonly sidOf = new Map<string, string>();
  /** [REQ-browser BR-17] 标签中心：注册/附着/切换/关闭/编号/目标事件（逻辑在 _browser_targets.ts） */
  private hub: TargetHub | null = null;

  // ---------- 基础收发 ----------

  private async cmd(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const cdp = this.cdp;
    if (!cdp) throw new CdpClosedError(this.closeReason || "会话已关闭");
    // [REQ-browser BR-16] 按**活跃标签**解析会话 id：否则切标签后命令仍发往旧标签（静默错页）。
    //   回落到 this.sid 是给「标签表尚未建立」的窗口期用的（attach 之后、hub.start 之前）。
    const sid = this.targetId ? (this.sidOf.get(this.targetId) ?? this.sid) : this.sid;
    return cdp.send(method, params, sid, timeoutMs);
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

  async launch(o: LaunchOptions): Promise<DriverResult<{ port: number; tabs?: number }>> {
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
      const configured = Number(B.get<number>("debug_port"));
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

    // [自评审 P-32] 事件监听必须**先于**页面级策略注册：initTab 里的 Fetch.enable 一落地，
    //   请求就会开始被暂停；若此刻 Fetch.requestPaused 的监听还没挂上，这批请求会被暂停后无人放行
    //   （表现为页面一直白屏直到超时）。installPolicies 只注册监听，不发页面级命令。
    this.installPolicies(o);

    try {
      // [REQ-browser BR-01/BR-03] 复用内核已建出的启动目标；只有当会话内一个 page 目标都没有时才新建。
      //   原先无条件 Target.createTarget，与 buildArgs 末尾的 about:blank 叠加 →
      //   窗口里出现两个标签（INC-04）。目标发现/计数逻辑在 _browser_targets.ts（NB-01）。
      const picked = await ensureStartupPageTarget(cdp);
      this.targetId = picked.targetId;
      this.startupTabs = picked.count;

      const a = (await cdp.send(
        "Target.attachToTarget",
        { targetId: picked.targetId, flatten: true },
        undefined,
        10_000,
      )) as { sessionId?: string };
      this.sid = String(a.sessionId ?? "");
      if (!this.sid) throw new Error("未能附着到页面目标");

      // [REQ-browser BR-24] 启动目标与后续新标签走**同一段**每标签初始化（initTab：
      //   Page.enable / Runtime.enable / 注入脚本 / 立即求值 + 按标签重开请求策略），
      //   避免「launch 里做四步、新标签只做一半」的路径漂移。
      this.sidOf.set(this.targetId, this.sid);
      await this.initTab(this.targetId, this.sid, false);
    } catch (err) {
      await this.hardKill();
      return dFail("launch_failed", `初始化调试会话失败：${msgOf(err)}`);
    }

    // [自评审 P-32] installPolicies 已在 try 之前调用（监听必须先于 Fetch.enable）

    // [REQ-browser BR-17] 登记启动目标 + 订阅目标事件（浏览器级命令，sessionId 必须为 undefined）
    try {
      this.hub = new TargetHub(cdp, { initTab: (t, s, p) => this.initTab(t, s, p) });
      await this.hub.start(this.targetId, this.sid, { url: "about:blank", title: "" });
    } catch {
      // 事件订阅失败不影响会话可用：sync() 仍按需对账（BR-17 的报数不会因此消失）
      this.hub = null;
    }

    // [REQ-browser NB-05] tabs 只进启动日志（_browser_session.ts）；open 的 meta 用实时计数
    return { ok: true, value: { port, tabs: this.startupTabs } };
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
    //   ⚠️ 拦截开关本身（Page.setInterceptFileChooserDialog）是**页面级**命令，已移入 initTab()：
    //      每个新标签都要单独开，否则弹窗里的文件选择不会被拦下（安全回退）。
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
      // [REQ-browser BR-52 / BR-24] Fetch.enable 与 Network.setBlockedURLs 都是**页面级**命令，
      //   已移入 initTab()：只对 this.sid 那一个标签执行会让弹窗/新标签里的请求完全不过策略
      //   （私有网段阻断、域名黑白名单、下载上传拒绝在弹窗内全部失效）—— 这是安全回退，不是功能瑕疵。
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
    // [REQ-browser BR-26] 连接断开即释放事件订阅：否则目标事件回调会挂在已失效的连接上
    this.hub?.dispose();
    this.hub = null;
    this.launchOpts?.onDisconnected?.(reason);
  }

  // ---------- 标签（P3：转发到 _browser_targets.ts 的 TargetHub，NB-01） ----------

  /**
   * [自评审 P-31] 把 this.sid 同步为**活跃标签**的会话 id。
   * 三处依赖它：cmd 的回落、rawEval / callPage（经 cmd）、P2 的 bringToFront（直接用 this.sid 发 Page 域命令）。
   */
  private syncActiveSid(): void {
    if (!this.targetId) return;
    const sid = this.sidOf.get(this.targetId);
    if (sid) this.sid = sid;
  }

  /**
   * [REQ-browser BR-24] 每个标签的独立初始化。`isPopup` 只影响日志口径（弹窗与用户新开标签步骤相同）。
   * 刻意**不用** this.cmd / rawEval：那两条按活跃标签解析 sessionId，而初始化期间活跃标签
   * 可能已切到目标标签、也可能还没有，只有显式传 sid 才能保证命令落在正确的页面上。
   */
  async initTab(targetId: string, sessionId: string, isPopup: boolean): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) throw new CdpClosedError(this.closeReason || "会话已关闭");
    if (!sessionId) throw new Error("缺少页面会话标识（未附着到页面）");
    this.sidOf.set(targetId, sessionId);
    // [自评审 P-31] this.sid 必须始终是**活跃标签**的会话 id：P2 的 bringToFront() 直接用它发
    //   Page.bringToFront。若它停在启动标签上，新建/切换标签后置前会把**旧标签**激活到前台
    //   （窗口显示与实际操作的标签错位，且快照仍取自新标签 → 用户看到的和模型操作的不是同一页）。
    if (targetId === this.targetId) this.sid = sessionId;
    await cdp.send("Page.enable", {}, sessionId, 15_000);
    await cdp.send("Runtime.enable", {}, sessionId, 15_000);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_LIB }, sessionId, 15_000);
    await this.evalOn(sessionId, PAGE_LIB);
    await this.enableTabPolicies(sessionId);
    console.log(
      `[browser] 标签初始化｜target=${targetId.slice(0, 8)}｜popup=${isPopup ? "yes" : "no"}｜ok=yes`,
    );
  }

  /** 在**指定**页面会话上求值（显式 sid；失败语义与 rawEval 一致：抛错） */
  private async evalOn(sessionId: string, expression: string, timeoutMs = 15_000): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) throw new CdpClosedError(this.closeReason || "会话已关闭");
    const res = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
      timeoutMs,
    );
    const ex = res.exceptionDetails as
      | { text?: string; exception?: { description?: string } }
      | undefined;
    if (ex) throw new Error(`页面脚本执行失败：${ex.exception?.description ?? ex.text ?? "未知异常"}`);
  }

  /**
   * [REQ-browser BR-52] 按标签重开请求策略。
   * `Page.setInterceptFileChooserDialog` / `Fetch.enable` / `Network.setBlockedURLs`
   * 全部是**页面级**命令：逐个标签开一次，否则新标签（含站点弹窗）里的请求完全不过策略。
   */
  private async enableTabPolicies(sessionId: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp || !sessionId) return;
    await cdp
      .send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId, 5_000)
      .catch(() => undefined);
    if (!this.launchOpts?.judgeRequest) return;
    await cdp
      .send(
        "Fetch.enable",
        { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
        sessionId,
        10_000,
      )
      .catch(() => undefined);
    // 粗粒度兜底：覆盖请求暂停事件覆盖不到的资源类型（WebSocket 等，已知缺口）
    // [FIX-LOCALHOST] 用 launch 时的快照，而非此处的实时 B.get()：
    //   enableTabPolicies 会在每个标签（含弹窗）异步初始化时调用，同样可能脱离 ALS 上下文，
    //   回退默认 true 会把回环地址塞进 setBlockedURLs，浏览器直接显示 ERR_BLOCKED_BY_CLIENT。
    const blockPrivateNet = this.launchOpts?.blockPrivateNet ?? B.get<boolean>("block_private_net");
    if (blockPrivateNet) {
      await cdp
        .send(
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
          sessionId,
          5_000,
        )
        .catch(() => undefined);
    }
  }

  /** [REQ-browser BR-17] 与真实目标集合对账并返回标签摘要（浏览器级命令，sessionId = undefined） */
  async getTargets(): Promise<TabOp<TabsSnapshot>> {
    const hub = this.hub;
    if (!hub) {
      // 没建成标签中心（启动异常 / 旧路径）：如实降级为「只有一个标签」
      const list: TabBrief[] = this.targetId
        ? [{ targetId: this.targetId, index: 1, url: "", title: "" }]
        : [];
      return {
        ok: true,
        value: { count: list.length, activeIndex: list.length > 0 ? 1 : 0, list },
      };
    }
    // [REQ-browser BR-25] 单会话标签上限 =1：站点自开的目标一律不登记、不报数（单标签退化）
    const maxTabs = Math.min(20, Math.max(1, Number(B.get<number>("max_tabs")) || 10));
    const r = await hub.sync({ ignoreNew: maxTabs <= 1 });
    const snap = hub.briefs();
    // 驱动侧「活跃标签」与标签中心对齐：cmd 依赖 this.targetId 解析 sessionId
    this.targetId = hub.activeTargetId() || this.targetId;
    // [自评审 P-31] 目标可能已被页面自关（hub 会自动回退），this.sid 必须跟着回退后的标签走
    this.syncActiveSid();
    if (r.created.length > 0 || r.destroyed.length > 0) {
      // [REQ-browser NB-05] 标签变化只记数量，不记地址与标题
      console.log(
        `[browser] 标签变化｜created=${r.created.length}｜destroyed=${r.destroyed.length}｜total=${snap.count}｜active=${snap.activeIndex}`,
      );
    }
    return { ok: true, value: snap };
  }

  /** [REQ-browser BR-16] 新建标签（url 固定 about:blank，随后由 navigate 走策略与超时） */
  async createTarget(url: string, maxTabs: number): Promise<TabOp<TabBrief>> {
    const hub = this.hub;
    if (!hub) return { ok: false, code: "closed", reason: "标签中心不可用（会话可能已关闭）" };
    const r = await hub.create(url, maxTabs);
    if (r.ok) {
      this.targetId = r.value.targetId;
      this.syncActiveSid();
    }
    return r;
  }

  /** [REQ-browser BR-18] 切换活动标签（1 起序号 / prev / next） */
  async switchTarget(
    sel: number | "prev" | "next",
  ): Promise<TabOp<{ index: number; count: number; targetId: string }>> {
    const hub = this.hub;
    if (!hub) return { ok: false, code: "tab_not_found", reason: "标签中心不可用（会话可能已关闭）" };
    const r = await hub.switchTo(sel);
    if (r.ok) {
      this.targetId = r.value.targetId;
      this.syncActiveSid();
    }
    return r;
  }

  /** [REQ-browser BR-23] 关闭当前标签并回退 */
  async closeTarget(): Promise<
    TabOp<{ closedIndex: number; index: number; count: number; targetId: string }>
  > {
    const hub = this.hub;
    if (!hub) return { ok: false, code: "tab_not_found", reason: "标签中心不可用（会话可能已关闭）" };
    const r = await hub.closeCurrent();
    if (r.ok && r.value.targetId) {
      this.targetId = r.value.targetId;
      this.syncActiveSid();
    }
    return r;
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
    // [REQ-browser BR-02] 目标标识随会话失效，避免 tabs() 拿旧 id 去数
    this.targetId = "";
    this.startupTabs = 1;
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

  /**
   * [REQ-browser BR-10/BR-11] 窗口置前（尽力而为）。三步协议序列在 _browser_foreground.ts，
   * 这里只做状态检查 + 转发，避免驱动继续膨胀（NB-01）。
   * 注意：**永不抛错** —— 连接断了也只返回 ok:false，好让 open 不受影响（BR-13）。
   */
  async bringToFront(): Promise<ForegroundResult> {
    const cdp = this.cdp;
    if (!cdp || this.closed) {
      return {
        ok: false,
        reached: "window",
        before: "",
        restored: false,
        windowId: 0,
        reason: this.closeReason || "会话已关闭",
      };
    }
    return bringWindowToFront(cdp, this.sid, this.targetId);
  }

  /**
   * [REQ-browser BR-02] 当前 page 目标数与当前激活标签序号（1 起）。
   * P1 恒为 1/1；P3 起返回真实标签数，供快照头部「标签 i/N」使用。
   * 注意：这是**辅助信息**，失败只返回 DriverResult 失败，不得改变 open 的成败判定。
   */
  async tabs(): Promise<DriverResult<TabsFact>> {
    const cdp = this.cdp;
    if (!cdp || this.closed) return dFail("closed", this.closeReason || "会话已关闭");
    try {
      const v = await tabFacts(cdp, this.targetId);
      return { ok: true, value: v };
    } catch (err) {
      return this.fail<TabsFact>(err);
    }
  }

  blockedRequestCount(): number {
    return this.blockedCount;
  }

  // ---------- 取文（extract 专用，只读） ----------

  /**
   * [REQ-browser BR-27] 按定位取局部内容。
   *
   * 刻意**不复用** callPage：它的 `__MISSING__` 哨兵只判 `window.__wb` 是否存在，
   * 函数缺失时不会命中哨兵，而是抛 TypeError → fail() 兜底成 timeout
   * （模型会按 action_timeout 的建议重试，BR-29 明令禁止这种误归类）。
   * 这里用**独立表达式 + 独立哨兵**，并补注入一次 PAGE_LIB
   * （其守卫只补装缺的函数，不重建 __wb，因此不会重置 ids/seq）。
   */
  async extractContent(q: ExtractRequest): Promise<DriverResult<ExtractPayload>> {
    if (this.closed) return dFail("closed", this.closeReason || "会话已关闭");
    const arg = JSON.stringify(q);
    const expr = `(window.__wb && typeof window.__wb.content === "function" ? window.__wb.content(${arg}) : "__WB_NO_EXTRACT__")`;
    try {
      let v = await this.rawEval(expr, 15_000);
      if (v === "__WB_NO_EXTRACT__") {
        await this.rawEval(PAGE_LIB, 15_000);
        v = await this.rawEval(expr, 15_000);
        if (v === "__WB_NO_EXTRACT__") {
          // 独立失败类别：绝不能让上层读成「页面超时」（BR-27 / BR-29）
          return dFail(
            "unsupported",
            "页面内库缺少取文原语 content（可能被页面脚本改写），本次未读取任何内容",
          );
        }
      }
      const raw = (v ?? {}) as ExtractPayload & { ok?: boolean; why?: string };
      // 页面侧裁定「选择器语法非法」：以 payload 标记回传，由域内映射为 invalid_request（BR-29）。
      // 不塞进 DriverFailureKind —— 那是传输层类别，语法判定不该混进去。
      if (raw.ok === false) return { ok: true, value: { badSelector: true } };
      return { ok: true, value: raw };
    } catch (err) {
      return this.fail<ExtractPayload>(err);
    }
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
      const delayMs = Math.min(100, Math.max(0, Number(B.get<number>("type_delay_ms")) || 0));
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
