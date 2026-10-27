/**
 * etc/tools/internet/_browser_targets.ts
 * 页面目标（标签）的发现与计数：P3 标签栈的落点，P1 只用到「启动期单标签基线」
 *
 * [REQ-browser BR-01] 会话启动完成后，会话内 type === "page" 的目标数恰为 1。
 * [REQ-browser BR-03] 修复方式受限：只用 Target.getTargets 复用已有 page 目标，
 *   仅在没有 page 目标时才 createTarget；不得「先建新目标再关旧目标」
 *   （关闭最后一个标签可能让浏览器自身退出）。
 * [REQ-browser NB-01] 标签相关逻辑一律落在本文件，_browser_driver.ts 不再增长。
 *
 * 本文件不导出 tools（`_` 前缀，src/tools/index.ts::loadTools 自动跳过）。
 */

/**
 * 只依赖 send 的最小接口：用例可传桩，无需真实 WebSocket。
 * [REQ-browser BR-17] P3 把 on 追加为**可选**：桩不实现它时，事件通道整体退化为
 *   「每次串行操作前后用 Target.getTargets 对账」（BR-17 的报数仍然成立，
 *   只是「新标签出现」这件事要等到下一次工具调用才被看见）。
 */
export interface CdpLike {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  on?(method: string, listener: (params: Record<string, unknown>, sessionId?: string) => void): () => void;
}

export interface TargetInfoLike {
  targetId: string;
  type?: string;
  url?: string;
  title?: string;
}

export interface StartupTarget {
  /** 被选中的目标（随后 attach 到它） */
  targetId: string;
  /** 选定后复查到的 page 目标数（BR-02 的 tabCount 基线） */
  count: number;
  /** 是否走了 createTarget 分支（仅用于日志区分） */
  created: boolean;
}

/** 内核把启动 URL 建成目标有先后，这里给足等待；等不到才允许新建 */
const WAIT_MS = 3_000;
const POLL_MS = 100;
/** 新建/复用之后再静置一次，避免「刚数完又冒出第二个目标」的假基线 */
const SETTLE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 列出当前浏览器内所有 type === "page" 的目标（浏览器级命令，不带 page sessionId） */
export async function listPageTargets(cdp: CdpLike): Promise<TargetInfoLike[]> {
  const res = await cdp.send("Target.getTargets", {}, undefined, 10_000);
  const infos = Array.isArray(res.targetInfos) ? (res.targetInfos as TargetInfoLike[]) : [];
  return infos.filter(
    (t) => t && t.type === "page" && typeof t.targetId === "string" && t.targetId !== "",
  );
}

/** 优先选启动参数里那个 about:blank（`buildArgs` 末尾的启动 URL），其次第一个 */
function pickStartup(pages: TargetInfoLike[]): string {
  const blank = pages.find((p) => String(p.url ?? "") === "about:blank");
  return (blank ?? pages[0]!).targetId;
}

/**
 * [REQ-browser BR-01/BR-03] 取启动后的唯一 page 目标。
 *   ① 先轮询等待内核把启动 URL 建成目标：等不到就新建，会在「新建完 + 内核又建出启动目标」
 *      时变成 2 个 page 目标 —— 这正是 INC-04 的镜像形态；
 *   ② 只有真的一个 page 目标都没有时，才 createTarget（BR-03 ③ 唯一允许的新建分支）；
 *   ③ 两条路径都静置 SETTLE_MS 后复查一次计数，count 如实回报（不静默强杀已存在的标签）。
 */
export async function ensureStartupPageTarget(cdp: CdpLike): Promise<StartupTarget> {
  const deadline = Date.now() + WAIT_MS;
  let pages = await listPageTargets(cdp);
  while (pages.length === 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    pages = await listPageTargets(cdp);
  }

  if (pages.length > 0) {
    const targetId = pickStartup(pages);
    await sleep(SETTLE_MS);
    const again = await listPageTargets(cdp);
    return { targetId, count: again.length || pages.length, created: false };
  }

  const res = await cdp.send("Target.createTarget", { url: "about:blank" }, undefined, 10_000);
  const targetId = String((res as { targetId?: string }).targetId ?? "");
  if (!targetId) throw new Error("未能创建页面目标");
  await sleep(SETTLE_MS);
  const again = await listPageTargets(cdp);
  return { targetId, count: again.length || 1, created: true };
}

/**
 * [REQ-browser BR-02] 当前 page 目标数 + 当前附着目标的序号（1 起）。
 * 附着目标已不在列表里时序号退化为 1（此时会话本身已异常，由上层按失败处理）。
 */
export async function tabFacts(
  cdp: CdpLike,
  activeTargetId: string,
): Promise<{ count: number; activeIndex: number }> {
  const pages = await listPageTargets(cdp);
  if (pages.length === 0) return { count: 0, activeIndex: 0 };
  const i = pages.findIndex((p) => p.targetId === activeTargetId);
  return { count: pages.length, activeIndex: (i >= 0 ? i : 0) + 1 };
}

// ============================================================
// P3 追加：标签中心（注册 / 附着 / 切换 / 关闭 / 编号 / 目标事件）
// ============================================================

/** 标签摘要（进快照头部清单与结果文案；不含任何正文，NB-05） */
export interface TabBrief {
  targetId: string;
  /** 1 起的显示序号 = 存活标签的**位置序**（关掉其它标签后会重排，见 IMPLEMENTATION-browser-P3 §9 Q3-1） */
  index: number;
  url: string;
  title: string;
}

export interface TabsSnapshot {
  count: number;
  /** 当前活动标签的位置序（1 起；0 表示无标签） */
  activeIndex: number;
  list: TabBrief[];
}

/** 每个新标签的独立初始化（BR-24 四步 + 按标签重开请求策略），由驱动注入 */
export interface TargetHooks {
  initTab(targetId: string, sessionId: string, isPopup: boolean): Promise<void>;
}

/**
 * [REQ-browser BR-16/BR-18/BR-22/BR-23] 标签操作的返回类型。
 * 刻意**不复用** DriverResult：它的失败类别里没有「标签序号越界」「标签数超上限」，
 * 硬塞进 not_found 会让上层映射成 element_not_found，模型会去重新 observe 取 ref
 * （跟标签编号毫无关系）。
 */
export type TabOp<T> =
  | { ok: true; value: T }
  | { ok: false; code: "tab_limit" | "tab_not_found" | "closed"; reason: string };

const TARGET_TIMEOUT_MS = 10_000;
const ATTACH_TIMEOUT_MS = 10_000;

/** 只把「真实网页」算作标签：内部页与调试页不占序号、不进清单 */
function isPageUrl(u: string): boolean {
  const v = String(u || "");
  if (v.startsWith("devtools://") || v.startsWith("chrome-extension://")) return false;
  return true;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * [REQ-browser BR-16～BR-26] 标签中心：注册、附着、切换、关闭、编号、目标事件。
 *
 * 为什么不写在驱动里（NB-01）：标签的编号/附着/切换/关闭/目标事件是五种状态，
 * 散进 1,300 行以上的驱动会让它继续膨胀；集中在只依赖 send/on 的类里，
 * 用例还能注入纯记录桩（不起浏览器、不需要 WebSocket）。
 *
 * 并发约定：**所有对标签表的写操作都在 sync()/create()/switchTo()/closeCurrent() 内完成**，
 * 事件回调只做记录（不改标签表），避免事件插进 closeSession 中途把已关闭的会话登记回来。
 */
export class TargetHub {
  private readonly cdp: CdpLike;
  private readonly hooks: TargetHooks;
  /** targetId → 扁平会话 id（attachToTarget 的返回值） */
  private readonly sess = new Map<string, string>();
  /** 当前存活标签的 targetId，按注册先后排列 = 显示序号来源 */
  private order: string[] = [];
  /** 最近一次已知的 url/title（targetInfoChanged 与 getTargets 都会刷新） */
  private readonly info = new Map<string, { url: string; title: string }>();
  private active = "";
  private disposed = false;
  private readonly offs: Array<() => void> = [];

  constructor(cdp: CdpLike, hooks: TargetHooks) {
    this.cdp = cdp;
    this.hooks = hooks;
  }

  /** 启动目标已在 launch 里初始化完毕：这里只登记 + 订阅事件 */
  async start(
    startupTargetId: string,
    startupSessionId: string,
    startupInfo: { url: string; title: string },
  ): Promise<void> {
    this.order = startupTargetId ? [startupTargetId] : [];
    if (startupTargetId) {
      this.sess.set(startupTargetId, startupSessionId);
      this.info.set(startupTargetId, startupInfo);
      this.active = startupTargetId;
    }
    await this.watch();
  }

  /**
   * [REQ-browser BR-17/BR-26] 订阅目标事件。
   * 事件**只记录**，不改标签表 —— 真正的登记/摘除/附着都在 sync() 里串行完成，
   * 否则事件随时可能插进 runSerial 之外（甚至插进 closeSession 的中途）。
   */
  private async watch(): Promise<void> {
    const on = this.cdp.on?.bind(this.cdp);
    if (!on) return; // 桩不实现 on：退化为「按需对账」
    try {
      await this.cdp.send("Target.setDiscoverTargets", { discover: true }, undefined, TARGET_TIMEOUT_MS);
    } catch {
      return; // 内核不支持：BR-17 仍由 sync() 保证，只是发现得晚一点
    }
    this.offs.push(
      on("Target.targetInfoChanged", (params) => {
        const t = params.targetInfo as { targetId?: string; url?: string; title?: string } | undefined;
        if (!t || typeof t.targetId !== "string") return;
        const old = this.info.get(t.targetId);
        if (!old) return;
        this.info.set(t.targetId, {
          url: String(t.url ?? old.url),
          title: String(t.title ?? old.title),
        });
      }),
    );
    this.offs.push(
      on("Target.targetDestroyed", (params) => {
        const id = typeof params.targetId === "string" ? params.targetId : "";
        if (!id) return;
        // 只清「已知信息」里的缓存，真正的摘除留给 sync()（串行、可带回退）
        this.info.delete(id);
      }),
    );
  }

  activeTargetId(): string {
    return this.active;
  }

  activeSessionId(): string {
    return this.sess.get(this.active) ?? "";
  }

  has(targetId: string): boolean {
    return this.sess.has(targetId);
  }

  briefs(): TabsSnapshot {
    const list: TabBrief[] = this.order.map((id, i) => {
      const it = this.info.get(id);
      return { targetId: id, index: i + 1, url: it?.url ?? "", title: it?.title ?? "" };
    });
    const ai = this.order.indexOf(this.active);
    return { count: list.length, activeIndex: ai >= 0 ? ai + 1 : 0, list };
  }

  /**
   * [REQ-browser BR-17/BR-24/BR-26] 与真实目标集合对账。
   * 顺序：取列表 → 摘除消失的 → 追加新出现的（附着 + 初始化）→ 校正活动标签。
   */
  async sync(o: { ignoreNew?: boolean } = {}): Promise<{
    created: string[];
    destroyed: string[];
    activeChanged: boolean;
  }> {
    const created: string[] = [];
    const destroyed: string[] = [];
    const before = this.order.slice();
    const beforeActive = this.active;

    let pages: Array<{ targetId: string; url: string; title: string }> = [];
    try {
      const res = await this.cdp.send("Target.getTargets", {}, undefined, TARGET_TIMEOUT_MS);
      const infos = Array.isArray(res.targetInfos)
        ? (res.targetInfos as Array<Record<string, unknown>>)
        : [];
      pages = infos
        .filter((t) => t && t.type === "page" && typeof t.targetId === "string" && String(t.targetId) !== "")
        .map((t) => ({
          targetId: String(t.targetId),
          url: String(t.url ?? ""),
          title: String(t.title ?? ""),
        }))
        .filter((t) => isPageUrl(t.url));
    } catch {
      // 取不到列表：保持现状（上层按「标签数未知」处理，绝不清空标签表）
      return { created, destroyed, activeChanged: false };
    }

    const alive = new Set(pages.map((p) => p.targetId));
    // ① 摘除消失的（BR-26：页面自己关了自己的标签）
    for (const id of before) {
      if (alive.has(id)) continue;
      this.sess.delete(id);
      this.info.delete(id);
      destroyed.push(id);
    }
    // ② 保留原顺序，再按 targetInfos 顺序追加新目标
    const kept = before.filter((id) => alive.has(id));
    const added: string[] = [];
    for (const p of pages) {
      this.info.set(p.targetId, { url: p.url, title: p.title });
      if (kept.includes(p.targetId) || added.includes(p.targetId)) continue;
      added.push(p.targetId);
    }
    // [REQ-browser BR-25] 单标签退化（BROWSER_MAX_TABS=1）：站点新开的目标一律不登记、不报数。
    //   ⚠️ 只能做到「我们不认它」——物理上那个标签仍会出现（由页面脚本创建，我们无权阻止），
    //      因此报数会与调试端点看到的真实 page 数不一致（见 P3 文档 §5 的 P-26）。
    if (o.ignoreNew) added.length = 0;
    this.order = [...kept, ...added];

    // ③ 新目标：先附着、再按 BR-24 初始化；单个失败不拖垮其它（该标签暂不可用，下次 sync 重试）
    for (const id of added) {
      if (this.sess.has(id)) continue;
      try {
        const a = await this.cdp.send(
          "Target.attachToTarget",
          { targetId: id, flatten: true },
          undefined,
          ATTACH_TIMEOUT_MS,
        );
        const sid = String((a as { sessionId?: string }).sessionId ?? "");
        if (!sid) throw new Error("未能附着到页面目标");
        this.sess.set(id, sid);
        await this.hooks.initTab(id, sid, true);
        created.push(id);
      } catch {
        // 初始化失败的标签留在 order 里但 sess 缺失：调用方按「该标签不可用」处理，
        // 下一次 sync 会重试（因为 sess 仍缺失）。
      }
    }

    // ④ 活动标签：仍在则不动；不在则回退到它在旧顺序里的前一个（BR-23/BR-26 的「切回上一个」）
    if (!alive.has(this.active)) {
      const prevIdx = before.indexOf(this.active) - 1;
      const fallback = (prevIdx >= 0 ? before[prevIdx] : undefined) ?? this.order[this.order.length - 1] ?? "";
      this.active = alive.has(fallback) ? fallback : (this.order[0] ?? "");
    }

    return { created, destroyed, activeChanged: this.active !== beforeActive };
  }

  /** [REQ-browser BR-16/BR-22] 新建标签（`maxTabs` 由调用方按 BROWSER_MAX_TABS 传入；不自动关旧标签） */
  async create(url: string, maxTabs: number): Promise<TabOp<TabBrief>> {
    if (this.order.length >= maxTabs) {
      return {
        ok: false,
        code: "tab_limit",
        reason: `会话内已有 ${this.order.length} 个标签，上限 ${maxTabs}`,
      };
    }
    // 建标签失败必须回滚到这一步之前的活动标签（否则留下「有位置、没会话」的半成品）
    const beforeActive = this.active;

    let id = "";
    try {
      const r = await this.cdp.send("Target.createTarget", { url }, undefined, TARGET_TIMEOUT_MS);
      id = String((r as { targetId?: string }).targetId ?? "");
    } catch (err) {
      return { ok: false, code: "closed", reason: `新建标签失败：${msgOf(err)}` };
    }
    if (!id) return { ok: false, code: "closed", reason: "新建标签失败：内核未返回目标标识" };

    // 先切活动指针，再附着：initTab 期间可能触发页面加载，
    // 若此时 active 还指向旧标签，任何并发读都会看到旧标签。
    this.active = id;
    if (!this.order.includes(id)) this.order.push(id);
    this.info.set(id, { url, title: "" });

    try {
      const a = await this.cdp.send(
        "Target.attachToTarget",
        { targetId: id, flatten: true },
        undefined,
        ATTACH_TIMEOUT_MS,
      );
      const sid = String((a as { sessionId?: string }).sessionId ?? "");
      if (!sid) throw new Error("未能附着到页面目标");
      this.sess.set(id, sid);
      await this.hooks.initTab(id, sid, false);
    } catch (err) {
      // [自评审 P-27] 回滚：否则 active 指着它、序号把它算进 N，之后所有动作都发往空 sessionId
      this.order = this.order.filter((x) => x !== id);
      this.sess.delete(id);
      this.info.delete(id);
      this.active = this.order.includes(beforeActive)
        ? beforeActive
        : (this.order[this.order.length - 1] ?? "");
      return { ok: false, code: "closed", reason: `新标签初始化失败：${msgOf(err)}` };
    }

    // 让新标签在窗口里成为**可见**标签（否则用户与模型看到的仍是旧页）
    try {
      await this.cdp.send("Target.activateTarget", { targetId: id }, undefined, 5_000);
    } catch {
      /* 少数内核不认这条命令：不影响功能，只是窗口里显示的可能仍是旧标签 */
    }

    const idx = this.order.indexOf(id) + 1;
    return { ok: true, value: { targetId: id, index: idx, url, title: "" } };
  }

  /**
   * [REQ-browser BR-18] 切换活动标签。`sel` 为 1 起序号或 prev / next（回绕）。
   * ⚠️ 只做**标签级**激活（Target.activateTarget），不做任何窗口级操作（BR-12）。
   */
  async switchTo(
    sel: number | "prev" | "next",
  ): Promise<TabOp<{ index: number; count: number; targetId: string }>> {
    const n = this.order.length;
    if (n === 0) return { ok: false, code: "tab_not_found", reason: "会话内没有可用标签" };
    const cur = Math.max(0, this.order.indexOf(this.active));

    let idx = cur;
    if (sel === "prev") idx = (cur - 1 + n) % n;
    else if (sel === "next") idx = (cur + 1) % n;
    else {
      const want = Math.trunc(sel);
      if (!Number.isInteger(want) || want < 1 || want > n) {
        return {
          ok: false,
          code: "tab_not_found",
          reason: `标签序号超出范围：${String(sel)}（当前 ${n} 个）`,
        };
      }
      idx = want - 1;
    }

    const targetId = this.order[idx]!;
    if (!this.sess.has(targetId)) {
      // 该标签在 sync 时初始化失败过：这里补一次附着（幂等）
      try {
        const a = await this.cdp.send(
          "Target.attachToTarget",
          { targetId, flatten: true },
          undefined,
          ATTACH_TIMEOUT_MS,
        );
        const sid = String((a as { sessionId?: string }).sessionId ?? "");
        if (!sid) throw new Error("未能附着");
        this.sess.set(targetId, sid);
        await this.hooks.initTab(targetId, sid, true);
      } catch (err) {
        return {
          ok: false,
          code: "tab_not_found",
          reason: `标签 ${idx + 1} 当前不可用：${msgOf(err)}`,
        };
      }
    }

    try {
      await this.cdp.send("Target.activateTarget", { targetId }, undefined, 5_000);
    } catch (err) {
      return { ok: false, code: "closed", reason: `激活标签失败：${msgOf(err)}` };
    }
    this.active = targetId;
    return { ok: true, value: { index: idx + 1, count: n, targetId } };
  }

  /** [REQ-browser BR-23] 关闭当前标签，并回退到它前一个（BR-26 的自毁回退也走这里） */
  async closeCurrent(): Promise<
    TabOp<{ closedIndex: number; index: number; count: number; targetId: string }>
  > {
    const n = this.order.length;
    if (n === 0) return { ok: false, code: "tab_not_found", reason: "会话内没有可用标签" };
    const cur = Math.max(0, this.order.indexOf(this.active));
    const targetId = this.order[cur]!;

    try {
      await this.cdp.send("Target.closeTarget", { targetId }, undefined, TARGET_TIMEOUT_MS);
    } catch (err) {
      return { ok: false, code: "closed", reason: `关闭标签失败：${msgOf(err)}` };
    }
    this.sess.delete(targetId);
    this.info.delete(targetId);
    this.order = this.order.filter((id) => id !== targetId);

    // 回退：旧顺序里的前一个；没有了就取新的最后一个
    const nextIdx = Math.max(0, Math.min(cur - 1, this.order.length - 1));
    this.active = this.order[nextIdx] ?? "";
    if (this.active) {
      try {
        await this.cdp.send("Target.activateTarget", { targetId: this.active }, undefined, 5_000);
      } catch {
        /* 激活失败不影响「已关闭」这一事实 */
      }
    }
    return {
      ok: true,
      value: {
        closedIndex: cur + 1,
        index: this.order.length > 0 ? nextIdx + 1 : 0,
        count: this.order.length,
        targetId: this.active,
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.offs.length = 0;
    this.sess.clear();
    this.info.clear();
    this.order = [];
    this.active = "";
  }
}
