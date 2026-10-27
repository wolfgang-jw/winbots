/**
 * etc/tools/internet/_browser_foreground.ts
 * 窗口置前：取窗口 → 恢复窗口状态 → 激活页面 → **校验是否真的到了前台**（INC-02）
 *
 * [REQ-browser BR-10] 有头模式下 open 结束（**包括**失败保留分支）后把会话窗口置到最前并解除最小化。
 * [REQ-browser BR-11] 三步顺序不可颠倒：最小化状态下只做页面激活不保证窗口还原；本条只约束顺序与效果，
 *   不约束具体调试命令。
 * [REQ-browser BR-12] 只有 open 置前；observe / act / extract / close 一律零前台调用（由调用点保证）。
 * [REQ-browser BR-13] 置前失败不得影响 open 的成败，也不得新增错误码 —— 因此本文件**永不抛错**，
 *   失败只体现在 ForegroundResult.ok / reason 上。
 * [REQ-browser BR-14] 无头模式零附加调用（判据由调用方用 Session.headless 判定，本文件不做判断）。
 * [REQ-browser NB-01] 协议序列落在本文件，_browser_driver.ts 只留一个转发方法，不再增长。
 * [REQ-browser NB-02] 只依赖 send，用例可注入桩记录三步命令与 sessionId 的有无。
 *
 * ── 实测修正（P2-P26）────────────────────────────────────────────────────
 * 三步全部「命令成功」≠「窗口到了前台」：Windows 前台锁会让内核里的 SetForegroundWindow
 * 静默失败（CDP 照样回成功）。因此第 ④ 步做一次复核，结果放进 `verified`。
 *
 * ── 实测修正（P2-P32）：`verified` 只是**参考信号**，不能当权威结论 ─────────
 * 第 ④ 步取的是页面自报的 `document.hasFocus()` + `visibilityState`。实测发现：
 * `Page.bringToFront` 之后它**恒为 true**（渲染器认为标签页已激活），窗口仍在别的窗口后面
 * 也照样报 true —— 于是「verified=false 才补救」的分支一次都不会触发。
 * 现在权威判定改由操作系统给出（`GetForegroundWindow()` 的进程归属），见 _browser_winraise.ts；
 * 本文件的 `verified` 仅用于：① 日志里区分「渲染器焦点」与「OS 前台」；② 无 pid 可查时
 * （非 Windows / 进程已退 / 桩驱动）作为**退化的**兜底判据。调用点以 OS 判定优先。
 *
 * 本文件不导出 tools（`_` 前缀，加载器自动跳过）。
 */

/** 只依赖 send 的最小接口：用例可传桩，无需真实 WebSocket / CdpConnection */
export interface FgCdp {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

export interface ForegroundResult {
  ok: boolean;
  /** 成功到达的步骤：window=已取到窗口 / restore=已解除最小化 / activate=已激活页面 */
  reached: "window" | "restore" | "activate";
  /** 还原前的窗口状态（normal / minimized / maximized / fullscreen；字段缺失时为空串=未知） */
  before: string;
  /** 是否真的执行过「解除最小化」。maximized / fullscreen 不还原（会撤销 --start-maximized） */
  restored: boolean;
  /** 窗口号；0 表示没取到 */
  windowId: number;
  /** 失败原因（只进日志，不进模型可见文案 —— BR-13 规定提示语固定） */
  reason: string;
  /**
   * [实测修正 P2-P26/P2-P32] 页面自报的「焦点」状态。**只是参考信号，不是权威结论**：
   * `Page.bringToFront` 之后它恒为 true，窗口在别的窗口后面也报 true。
   * undefined = 无法判定（桩驱动 / 无页面会话 / 求值失败）。
   * 权威判定由 _browser_winraise.ensureForeground 的 OS 前台探测给出，调用点优先采用后者。
   */
  verified?: boolean;
}

/** 单步超时：置前是尾部的锦上添花，不能让 open 等 15s（cmd 的默认超时） */
const STEP_MS = 2000;
/** 复核超时：Runtime.evaluate 卡住时不能把 open 拖长 */
const PROBE_MS = 1500;
/** 复核轮次与间隔：窗口刚被激活时浏览器还没来得及切焦点态，需要重试几次 */
const PROBE_TRIES = 3;
const PROBE_GAP_MS = 120;

/**
 * 页面自报焦点态。**只读、无副作用**，且不返回 URL（NB-05：日志里不得出现地址）。
 * 注意 `document.hasFocus()` 为 false 也包含「用户正把光标放在地址栏」这种情形 —— 会多判一次
 * 「未到前台」，最坏结果只是多做一次兜底，不会误报失败文案以外的任何东西。
 */
const PROBE_EXPR =
  "(function(){try{return {hasFocus:document.hasFocus()===true,vis:String(document.visibilityState||'')}}catch(e){return null}})()";

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const sleepMs = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * 从 Browser.getWindowForTarget 的应答里取 windowId 与 state。
 * 字段缺失按「未知」处理（state 为空串）：**保守地不动窗口**——
 * 把「未知」当成「最小化」去设 normal，会把用户的最大化窗口缩小；
 * 把「未知」当成「最大化」不处理，最坏结果只是窗口仍是原样，由第 ③ 步兜底。
 */
function readWindow(res: Record<string, unknown>): { windowId: number; state: string } {
  const idNum = Number(res.windowId);
  const bounds = (res.bounds as { windowState?: unknown } | undefined) ?? {};
  return {
    windowId: Number.isFinite(idNum) && idNum > 0 ? Math.trunc(idNum) : 0,
    state: typeof bounds.windowState === "string" ? bounds.windowState : "",
  };
}

/**
 * 把窗口带到最前。永不抛错（BR-13）。
 *
 * @param cdp            连接（Browser 域命令 = 浏览器级，sessionId 传 undefined）
 * @param pageSessionId  页面会话（Page / Runtime 域命令必须带它）
 * @param targetId       当前**被附着**的页面目标（Browser.getWindowForTarget 的入参）
 */
export async function bringWindowToFront(
  cdp: FgCdp,
  pageSessionId: string,
  targetId: string,
): Promise<ForegroundResult> {
  /** 中间步骤的非致命原因（取窗口 / 解除最小化失败都不中断整段流程） */
  const notes: string[] = [];
  let windowId = 0;
  let before = "";
  let restored = false;

  /**
   * 第 ③ 步的公共实现：激活页面（Page 域命令，必须带 page sessionId）。
   * 抽成函数是因为「无目标标识的降级路径」与「正常路径收尾」都要用它，
   * 两处各写一遍会让「失败文案」与「超时值」出现漂移。
   * @returns 空串=成功；非空=失败原因
   */
  const activate = async (): Promise<string> => {
    // 没有页面会话时不能发 Page 域命令：不带 sessionId 的内核会直接拒绝
    if (!pageSessionId) return "缺少页面会话标识（未附着到页面）";
    try {
      await cdp.send("Page.bringToFront", {}, pageSessionId, STEP_MS);
      return "";
    } catch (err) {
      return msgOf(err);
    }
  };

  /**
   * 第 ④ 步：复核「是否真的到了前台」。返回 undefined = 无法判定。
   * 只有页面自己说 hasFocus=true 且 visibilityState=visible 才算真的在前台。
   */
  const probe = async (): Promise<boolean | undefined> => {
    if (!pageSessionId) return undefined;
    let last: boolean | undefined;
    for (let i = 0; i < PROBE_TRIES; i++) {
      if (i > 0) await sleepMs(PROBE_GAP_MS);
      try {
        const res = await cdp.send(
          "Runtime.evaluate",
          { expression: PROBE_EXPR, returnByValue: true },
          pageSessionId,
          PROBE_MS,
        );
        const r = res.result as { value?: unknown } | undefined;
        const v = r?.value as { hasFocus?: unknown; vis?: unknown } | undefined;
        if (!v || typeof v !== "object") return undefined; // 返回形状不符：判定不了，别瞎猜
        last = v.hasFocus === true && v.vis === "visible";
        if (last) return true;
      } catch {
        // 上下文已销毁 / 已关闭：判定不了
        return undefined;
      }
    }
    return last;
  };

  // ① 取窗口 —— **失败不致命**：窗口号只用于「解除最小化」，
  //   激活页面这一半效果不依赖它。原先这里直接 return，会让一次
  //   getWindowForTarget 失败连带把 Page.bringToFront 一起丢掉（P2-P27）。
  if (!targetId) {
    // 目标标识缺失（驱动没记下来 / 附着的是外部打开的目标）：退化为只激活页面，不做窗口还原。
    //   宁可「可能仍是最小化」也不整段放弃，因为「窗口到前台」这一半效果已经拿到。
    notes.push("无目标标识（跳过窗口还原）");
  } else {
    try {
      // ⚠️ Browser 域是**浏览器级**命令：第三个参数必须是 undefined（带 page sid 会被内核拒绝）
      const win = readWindow(
        await cdp.send("Browser.getWindowForTarget", { targetId }, undefined, STEP_MS),
      );
      windowId = win.windowId;
      before = win.state;
    } catch (err) {
      notes.push(`未能取得窗口：${msgOf(err)}`);
    }

    // ② 恢复窗口状态：**只处理「最小化」**
    //   - maximized：动它就等于撤销 --start-maximized，用户看到窗口变小；
    //   - fullscreen：动它会踢出全屏，属于未授权行为；
    //   - 未知（字段缺失）：不动，交给 ③ 的激活。
    if (windowId > 0 && before === "minimized") {
      try {
        // 只设 windowState，**不得**与 left/top/width/height 同时出现：
        //   Chrome 会以「不能同时修改窗口状态与尺寸」为由整条命令报错，置前直接失败。
        await cdp.send(
          "Browser.setWindowBounds",
          { windowId, bounds: { windowState: "normal" } },
          undefined,
          STEP_MS,
        );
        restored = true;
      } catch (err) {
        // 解除最小化失败也继续：页面激活对「被别的窗口挡住」这一半仍然有效
        notes.push(`未能解除最小化：${msgOf(err)}`);
      }
    }
  }

  // ③ 激活页面
  const err3 = await activate();

  // ④ 复核（失败路径同样复核：兜底要靠这个结论判断「到底到没到前台」）
  const verified = await probe();
  const reached: ForegroundResult["reached"] = err3 ? (restored ? "restore" : "window") : "activate";
  const reason = err3 ? [...notes, `未能激活页面：${err3}`].join("；") : notes.join("；");

  return {
    ok: !err3,
    reached,
    before,
    restored,
    windowId,
    reason,
    verified,
  };
}
