/**
 * etc/tools/internet/browser.ts
 * 浏览器工具门面（本目录唯一的入口文件，由 src/tools/scan.ts 扫描加载；BR-02）
 *
 * 契约：导出 tools: Tool[]，调用名 internet.browser.<name>
 *       模型可见名固定 internet__browser__open / __observe / __act / __extract / __close（BR-03）
 * 分层：本文件只做「开关复检 → 入参预检 → 会话编排 → 结果整形」；
 *       动作在 _browser_actions，快照在 _browser_snapshot，会话在 _browser_session，
 *       页面原语在 _browser_driver，传输在 _browser_cdp（BR-06）。
 *
 * ⚠️ 工具内部永不向平台抛业务异常（BR-45）；失败一律返回结构化信封。
 */
import type { Tool, ToolContext } from "@/tools";
import { groupScope, type SettingDef } from "@/infra/settings";

/**
 * [规范 §7.3] 本组作用域（只有 internet/browser 可读）。
 * 私有模块 `_browser_*.ts` 服务本组，用显式形式 groupScope("internet","browser")。
 * ⚠️ 每次调用实时读，禁止模块级缓存（保存即生效的前提）。
 */
const B = groupScope("internet", "browser");
import { ok, type Envelope } from "./_common";
import { failEnvelope, withTail, type BrowserErrorCode } from "./_browser_errors";
import { precheckUrl, reasonLabel, urlForLog } from "./_browser_policy";
// [REQ-browser BR-13] 置前结果类型（raiseWindow 的局部变量声明用；三步序列在 _browser_foreground.ts）
import type { ForegroundResult } from "./_browser_foreground";
// [实测修正 P2-P26/P2-P32] Windows 前台锁兜底 + **OS 级前台判定**（页面自报 hasFocus 不可信）
import { ensureForeground } from "./_browser_winraise";
import { buildSnapshot } from "./_browser_snapshot";
import {
  adoptCreatedTab,
  bumpGeneration,
  closeCurrentTab,
  closeSession,
  ensureSession,
  getSession,
  runSerial,
  sessionLimit,
  sessionMaxTabs,
  sessionTtlSeconds,
  SessionBusyError,
  tabNoticeLines,
  touch,
  type Session,
} from "./_browser_session";
import { runAct, validateActArgs } from "./_browser_actions";
// [REQ-browser BR-27] extract 的域内整形全部落在 _browser_extract.ts（NB-01：驱动不再承载域内逻辑）
import { runExtract } from "./_browser_extract";
import {
  DESC_ACT,
  DESC_CLOSE,
  DESC_EXTRACT,
  DESC_OBSERVE,
  DESC_OPEN,
  SCHEMA_ACT,
  SCHEMA_CLOSE,
  SCHEMA_EXTRACT,
  SCHEMA_OBSERVE,
  SCHEMA_OPEN,
} from "./_browser_schemas";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function navTimeout(): number {
  return Math.max(1000, Number(B.get<number>("nav_timeout_ms")) || 20000);
}

function stableWindow(): number {
  return Math.max(0, Number(B.get<number>("stable_window_ms")) || 400);
}

/**
 * 会话忙（排队超时）统一文案：明确告知「会话正忙、未执行」。
 * [R-08-3] 改用独立错误码 session_busy —— 原先借用 action_timeout，
 * 模型会误判成「页面慢」并原样重试，而实际是我们自己的排队上限。
 */
function busyEnvelope(): Envelope {
  return failEnvelope("session_busy", "会话正忙：上一次操作尚未结束，本次未对页面做任何操作");
}

/**
 * [FIX-SILENT-03] 无头模式必然「用户看不到窗口」。
 * 把这件事写进结果正文，让模型必须转告用户，而不是只回一句「已打开」——
 * 否则在用户侧就是「要求打开浏览器，但什么也没发生」。
 * 只在 open 结果里出现一次，不污染 observe/act 的正文。
 */
function headlessHint(s: Session): string | null {
  // [FIX-WIN-03] 判据改用会话的真实模式
  if (!s.headless) return null;
  return (
    "【提示】当前为无头模式：浏览器窗口不会出现在你的屏幕上（操作仍在真实浏览器内执行，可正常抓取页面）。" +
    "如需亲眼看到操作过程，请让用户把配置页「浏览器工具配置 › 无头模式」设为 false（或 .env 写 BROWSER_HEADLESS=false），" +
    "然后再次调用 open —— 本工具检测到窗口模式变化会按新配置自动重建浏览器，无需先 close。"
  );
}

function modeLine(s: Session): string {
  const blocked = s.blocked.length > 0 ? `｜本次有 ${s.blocked.length} 个请求被策略阻断` : "";
  // [FIX-WIN-03] 用会话创建时的真实模式，不读 env（配置热更后会与运行中的实例不一致）
  return `会话 ${s.prefix}｜${s.headless ? "无头" : "有头"}｜${
    s.tempProfile ? "临时 profile" : "持久 profile"
  }${blocked}`;
}

/**
 * [REQ-browser BR-13] 置前结果三态：
 *   attempted=false → 本次「不适用」（无头 / 开关关闭 / 驱动未实现），**不写提示行、meta 记 null**；
 *   attempted=true, ok=false → 真的试了但没成功，写提示行、meta 记 false。
 * 为什么必须区分：假驱动都不实现 bringToFront()，若把「未实现」当失败，
 * 既有用例的每个 open 结果都会多出一行「窗口未能置前」，文本断言与 meta 深比较会集体变红。
 *
 * [实测修正 P2-P26] `ok` 只是「CDP 命令成功」，不等于「窗口到了前台」。
 * [实测修正 P2-P32] `verified`（页面自报 hasFocus）**也不可信**：`Page.bringToFront` 之后它恒为 true，
 *   窗口仍在后面也报 true。真正的权威判定来自操作系统（_browser_winraise.ensureForeground）：
 *   OS 说在不在前台，才算数；OS 取不到判定时才退回 `verified ?? ok`。
 */
type ForegroundAttempt =
  | { attempted: false; why: string }
  | { attempted: true; ok: boolean; verified?: boolean };

/**
 * [REQ-browser BR-10～BR-14] 把会话窗口带到最前（**仅 open 调用**）。
 * 三类「不适用」一律不发起任何 CDP 调用：
 *   ① 会话是无头（BR-14：判据取 Session.headless，不读 env —— 配置热更后旧会话仍按旧模式运行，
 *      与 headlessHint / modeLine 的既有口径一致）；
 *   ② BROWSER_FOREGROUND_ON_OPEN=false（NB-04 的回滚旋钮）；
 *   ③ 驱动没实现 bringToFront()（假驱动，NB-03）。
 * 任何异常都在这里吞掉：置前失败绝不影响 open 的成败（BR-13）。
 */
async function raiseWindow(s: Session): Promise<ForegroundAttempt> {
  if (s.headless) return { attempted: false, why: "headless" };
  if (!B.get<boolean>("foreground_on_open")) return { attempted: false, why: "switch_off" };
  const fn = s.driver.bringToFront;
  if (typeof fn !== "function") return { attempted: false, why: "driver_unsupported" };

  const startedAt = Date.now();
  let r: ForegroundResult;
  try {
    r = await fn.call(s.driver);
  } catch (err) {
    // 驱动实现里理论上不抛（_browser_foreground 各步各自 try/catch），
    // 但假驱动 / 未来改动可能抛：这里再兜一层，守住 BR-13
    r = { ok: false, reached: "window", before: "", restored: false, windowId: 0, reason: errText(err) };
  }

  // [实测修正 P2-P32] 权威判定必须来自**操作系统**。
  //   上一版只在 `r.verified === false` 时兜底，而 verified 来自页面自报的 document.hasFocus()：
  //   它只表示「渲染器认为标签页已激活」（Page.bringToFront 之后必然如此），
  //   窗口仍在别的窗口后面也报 true → 兜底一次都没触发（日志里连 assist= 都没有）。
  //   现在改为：拿浏览器 pid 做一次 OS 级「探测 →（不在前则）提升 → 复核」，
  //   OS 判定优先于 CDP 自报；拿不到判定（非 Windows / 进程已退 / 脚本编译失败）才退回自报。
  let front: boolean | undefined = r.verified;
  let assist = "";
  const pid = Number(s.driver.processId?.() ?? 0);
  if (Number.isFinite(pid) && pid > 0) {
    const a = await ensureForeground(pid);
    // probed=false 表示「没拿到 OS 判定」（非 Windows / 进程已退 / PowerShell 不可用），
    //   此时保留 CDP 自报结论，并把跳过原因记进日志 —— 否则「为什么又没置前」无从排查。
    //   how: already / attach / alt / appactivate / topmost / none / no_window / circuit / skip
    assist = a.probed ? `｜os=${a.how}` : `｜os=${a.how}:${a.why}`;
    if (a.probed) front = a.ok;
  }

  // [REQ-browser NB-05] 每次置前记一行（成功/失败都记）：窗口在不在前台，是用户投诉的第一顺位。
  //   cdp= CDP 命令是否成功；front= **最终结论**（OS 判定优先，? = 两边都判定不了）；
  //   os= 走了哪条提升路径（already 表示本来就在前台，没做任何操作）。
  console.log(
    `[browser] 置前｜session=${s.prefix}｜cdp=${r.ok ? "yes" : "no"}` +
      `｜front=${front === undefined ? "?" : front ? "yes" : "no"}｜reached=${r.reached}` +
      `｜state=${r.before || "?"}${r.restored ? "→normal" : ""}｜window=${r.windowId}` +
      `｜ms=${Date.now() - startedAt}${assist}${r.reason ? `｜reason=${r.reason}` : ""}`,
  );
  // front===false 才算真失败（含 TOP：窗口在最前但没拿到键盘焦点，仍属「已置前」）
  return { attempted: true, ok: front ?? r.ok, verified: front };
}

/**
 * [REQ-browser BR-13] 置前失败的单行提示（成功 / 不适用时返回空串，不留空行）。
 * 措辞按需求文档给定：「窗口未能置前（可能受系统前台锁限制）」，并补一句「页面本身没问题」——
 * 否则模型容易把它当成打开失败转告用户。
 */
function fgHintLine(f: ForegroundAttempt): string {
  if (!f.attempted) return "";
  // [实测修正 P2-P26] 判据与 meta.foreground 同口径：命令成功但窗口没到前台，也必须如实提示
  if ((f.verified ?? f.ok) === true) return "";
  return "【提示】窗口未能置前（可能受系统前台锁限制）；页面本身已正常打开，可直接在窗口里操作。";
}

/**
 * [REQ-browser BR-06] 会话是否已经不可用：驱动已断开 / 被标记 dead / 正在关闭。
 * 用于区分「有窗口可留的失败」与「只剩空壳的失败」。
 */
function sessionGone(s: Session): boolean {
  if (s.dead || s.state === "closing") return true;
  try {
    return s.driver.isClosed();
  } catch {
    return true;
  }
}

/**
 * [REQ-browser BR-07] 失败保留文案：错误码由信封携带，这里补齐其余四要素
 * —— 目标地址（只到 host+path，BR-57）、会话前缀、进程号、保留声明 + TTL。
 * 措辞必须同时表达「失败」与「窗口还在」，模型才能一边报错、一边告诉用户去哪儿看。
 * 结尾不留句号：describeFailure 会先剥掉尾部标点，再拼「。」+ 建议句。
 */
function keptAliveDetail(s: Session, targetUrl: string, reason: string, ttl: number): string {
  const pid = s.driver.processId?.() ?? null;
  return (
    `导航失败：${reason}（目标 ${urlForLog(targetUrl)}；会话 ${s.prefix}；进程 ${pid ?? "未知"}）` +
    `。窗口已保留，约 ${ttl} 秒无操作后自动关闭；如需立刻关闭请调用 close`
  );
}

/*
 * [REQ-browser BR-02/BR-21] 标签事实统一由会话层的 syncTabs() 提供（见 _browser_session.ts），
 * 并在构建快照时随结果返回（SnapshotOutcome.tabs）—— 门面不再单独取一次，
 * 避免 meta.tabCount 与 meta.tabList 来自两个来源而互相矛盾。
 */

// ============================================================
// open
// ============================================================

async function runOpen(args: Record<string, unknown>, ctx?: ToolContext): Promise<Envelope> {
  // ① 开关复检（BR-08：即使平台放行也必须再检查，且不得启动浏览器）
  if (!isBrowserGroupOn()) {
    return failEnvelope("tool_disabled", "浏览器工具已禁用，本次未执行");
  }

  // ② 入参 URL 预检（同步，0 次浏览器操作）
  const pre = precheckUrl(args.url);
  if (!pre.ok) {
    if (pre.verdict.reason === "protocol" || pre.verdict.reason === "credentials") {
      return failEnvelope(
        "invalid_request",
        `url 不合法：${pre.detail}。必须是含 host 的 http/https 地址，例如 {"url":"https://example.com"}`,
      );
    }
    return failEnvelope(
      "blocked_url",
      `目标地址被策略阻断：${reasonLabel(pre.verdict.reason)}（${pre.host}）`,
      { host: pre.host },
    );
  }

  let hadSession = getSession(ctx?.sessionId) !== null;

  // ③ 会话（不存在则创建，受并发上限约束）
  const ensured = await ensureSession(ctx?.sessionId);
  if (!ensured.ok) {
    if (ensured.code === "session_limit") {
      // [REQ-browser 第 4 章] 带上真实上限，与会话层 sessionLimit() 同口径
      return failEnvelope("session_limit", undefined, {
        occupied: ensured.occupied,
        limit: sessionLimit(),
      });
    }
    return failEnvelope(
      "browser_unavailable",
      `未能启动受控浏览器：${ensured.detail}`,
      { attemptedPaths: ensured.attemptedPaths },
    );
  }
  let s = ensured.session;
  let switched = false;

  // ③' [FIX-WIN-03] 窗口模式与当前配置不一致 → 按新配置重建实例。
  //   起因：会话「有就复用」，用户把「无头」改成「有头」后再 open，拿到的仍是旧的无头浏览器，
  //   而结果文本又按 env 报「有头」——表现就是「说是有头，屏幕上还是什么都没有」。
  //   只在 open（用户明确要求打开）时重建，act / observe 不擅自打断在途任务。
  if (s.headless !== B.get<boolean>("headless")) {
    const from = s.headless ? "无头" : "有头";
    const to = B.get<boolean>("headless") ? "无头" : "有头";
    console.log(`[browser] 窗口模式已变更（${from} → ${to}），按新配置重建会话 ${s.prefix}`);
    await closeSession(s, "窗口模式配置变更，按新配置重建");
    const again = await ensureSession(ctx?.sessionId);
    if (!again.ok) {
      if (again.code === "session_limit") {
        return failEnvelope("session_limit", undefined, {
          occupied: again.occupied,
          limit: sessionLimit(),
        });
      }
      return failEnvelope(
        "browser_unavailable",
        `窗口模式已从「${from}」改为「${to}」，但按新配置重启浏览器失败：${again.detail}`,
        { attemptedPaths: again.attemptedPaths },
      );
    }
    s = again.session;
    switched = true;
    hadSession = false; // 新实例：后续失败按「新建会话」清理，不留半死进程
  }

  try {
    return await runSerial(s, async () => {
      // [REQ-browser BR-16/BR-21] 会话**已存在**时：在新标签里打开，原标签保留（多标签场景）。
      //   判据用 hadSession（本次调用前是否已有就绪会话），不是「getSession() !== null」——
      //   后者在「窗口模式变更后重建」时也成立，会在刚建好的实例上多开一个标签（INC-04 复发）。
      //   BROWSER_MAX_TABS=1（单标签退化）、驱动不支持多标签：都退回「同标签导航」，不让 open 失败。
      let tabNote = "";
      if (hadSession && sessionMaxTabs() > 1) {
        const make = s.driver.createTarget;
        if (typeof make === "function") {
          // url 传 about:blank：最终地址由随后的 navigate 进入，才能走同一条策略与超时链路
          const made = await make.call(s.driver, "about:blank", sessionMaxTabs());
          if (!made.ok) {
            if (made.code === "tab_limit") {
              // [REQ-browser BR-22] 超上限：不清理会话、不导航，明确让模型先关标签
              //   detail 直接用驱动给的「已有 N 个、上限 M」：这里拿不到准确计数，自己拼会报错数
              touch(s);
              return failEnvelope("tab_limit", made.reason);
            }
            tabNote = `（新建标签失败：${made.reason}；已在当前标签打开）`;
          } else {
            // 新标签的文档状态从空开始（ref 不跨标签复用，BR-20）
            adoptCreatedTab(s, made.value.targetId);
            console.log(
              `[browser] 新标签｜session=${s.prefix}｜index=${made.value.index}｜max=${sessionMaxTabs()}`,
            );
          }
        } else {
          // [自评审 P-33] 驱动没实现 createTarget（假驱动 / 纯单标签驱动）：静默退回同标签导航，
          //   **不写提示行** —— 与 P2 置前的「未实现即不适用」同口径。真实驱动一定实现它，
          //   写出来只会让每次 open 多一行噪声，并让既有文本断言集体变红。
          console.log(`[browser] 驱动未实现 createTarget，已在当前标签打开｜session=${s.prefix}`);
        }
      }

      // ④ 导航（判据=加载完成 + 稳定窗口，不是「命令返回」）
      const nav = await s.driver.navigate(pre.url, {
        timeoutMs: navTimeout(),
        stableMs: stableWindow(),
      });
      if (!nav.ok) {
        const code: BrowserErrorCode =
          nav.kind === "nav_timeout"
            ? "navigation_timeout"
            : nav.kind === "closed"
              ? "session_not_found"
              : "navigation_failed";

        // [REQ-browser BR-06 ②③] 驱动已断开 / 会话已被标记 dead：没有窗口可留，立即清理。
        //   这是「打开失败清理」唯一允许出现的场景之一（BR-08）。
        if (nav.kind === "closed" || s.dead) {
          if (!hadSession) await closeSession(s, "打开失败清理");
          return failEnvelope(code, nav.reason);
        }

        // [REQ-browser BR-04/BR-05] 导航失败：保留进程、窗口与标签，交由空闲回收。
        //   用户能在窗口里看到浏览器错误页并自行重试；TTL 必须从**失败时刻**重新起算。
        //   ⚠️ 此分支内绝不能调用 closeSession —— 它会 shutdown 进程并删临时 profile。
        // [REQ-browser BR-10] 失败保留同样要置前：用户正是靠窗口里那张错误页发现问题的。
        //   顺序：先置前（最坏约 6s：三步 CDP + 复核 + OS 探测/提升的一次 PowerShell，不写 lastUsedAt）
        //   → 再 touch（BR-05 要求它是返回前最后一次写）→ 再拼文案返回。
        //   反过来会在 TTL 极小时被扫掉，等于没保活。
        const fg = await raiseWindow(s);
        touch(s);
        const ttl = sessionTtlSeconds();
        console.log(
          `[browser] 打开失败但已保留会话 ${s.prefix}｜code=${code}｜pid=${
            s.driver.processId?.() ?? "-"
          }｜ttl=${ttl}s`,
        );
        const fgLine = fgHintLine(fg);
        return failEnvelope(code, keptAliveDetail(s, pre.url, nav.reason, ttl) + (fgLine ? `\n${fgLine}` : ""));
      }

      // ⑤ 导航后文档代次递增，旧 ref 全部失效
      bumpGeneration(s);

      // ⑥ [REQ-browser BR-10/BR-11] 置前：有头且开关开启时「取窗口 → 恢复窗口状态 → 激活页面
      //   → 复核是否真的到了前台（未到时做一次系统级兜底，见 _browser_winraise.ts）」。
      //   必须在首屏快照**之前**：激活窗口会让页面产生 focus / 懒加载 / 轮播一类 DOM 变更，
      //   而 buildSnapshot 会把当时的 __wbCount 记进 s.baseline；若置前在快照之后，
      //   这批变更就落在基线之外，下一次 act 的 detectChange 会误报「页面已变化」。
      //   置前失败不影响成败（BR-13），raiseWindow 内部已吞掉所有异常。
      const fg = await raiseWindow(s);

      // ⑦ 首屏快照
      const snap = await buildSnapshot(s, s.driver, { mode: "full" });
      if (!snap.ok) {
        return failEnvelope("internal_error", `页面已打开，但读取页面快照失败：${snap.reason}`);
      }

      // [REQ-browser BR-21] 标签事实随快照返回（唯一来源；P1 的 tabFactsOf 已删除）
      const tabs = snap.tabs;
      // [REQ-browser BR-09] URL/标题一律取页面真实 location（snap 内来自 driver.signature()），
      //   入参与 navigate 的返回值只作兜底：用户可能在窗口里自行重试或跳到别的站点
      const pageUrl = snap.url || nav.value.url;
      const pageTitle = snap.title || nav.value.title;

      const head =
        `【已打开】${pageUrl}｜${modeLine(s)}` +
        (switched ? `｜已按最新配置重建（${s.headless ? "无头" : "有头"}）` : "");
      // [REQ-browser BR-21] P3 起多标签是**正常态**：只列清单与可用动作，不再当成异常报警
      //   （P1 的 tabWarn 会每次都喊「启动基线应为 1」，与标签栈直接矛盾，已删除）
      const tabLines = tabNoticeLines(tabs);
      // [FIX-SILENT-03] 无头时把「窗口不可见」显式写进结果，避免模型误报「已打开」
      const hint = headlessHint(s);
      // [REQ-browser BR-13] 置前失败只加一行提示，不给错误码
      const fgLine = fgHintLine(fg);
      const lines = [head];
      if (tabNote) lines.push(tabNote);
      if (tabLines.length > 0) lines.push(...tabLines);
      if (fgLine) lines.push(fgLine);
      if (hint) lines.push(hint);
      lines.push("", snap.text);
      return ok(lines.join("\n"), {
        tool: "internet.browser.open",
        session: s.prefix,
        url: pageUrl,
        title: pageTitle,
        // [FIX-WIN-03] 报会话真实模式，不报 env
        headless: s.headless,
        tempProfile: s.tempProfile,
        refCount: snap.refCount,
        generation: s.gen,
        // [FIX-WIN-03] 便于用户/开发者在任务管理器里核对「是否真有浏览器进程」
        pid: s.driver.processId?.() ?? null,
        reusedSession: hadSession,
        // [REQ-browser BR-21] 打开后的标签数与当前序号（多标签时附清单）
        tabCount: tabs.count,
        tabIndex: tabs.activeIndex,
        // 计数是否来自真实驱动；假驱动未实现 getTargets 或读数失真时为 false（NB-03 的缺省路径）
        tabCountKnown: tabs.known,
        tabList: tabs.list.map((b) => ({
          index: b.index,
          title: b.title,
          url: urlForLog(b.url),
          active: b.index === tabs.activeIndex,
        })),
        // [REQ-browser BR-13] true=已置前；false=尝试过但失败；null=本次不适用（无头/开关关/假驱动）
        // [实测修正 P2-P32] 口径 = **OS 前台判定**（取不到时退回 CDP 自报的 verified / ok）
        foreground: fg.attempted ? (fg.verified ?? fg.ok) : null,
      });
    });
  } catch (err) {
    // SessionBusyError 必须在最前面拦掉：它代表「上一次操作还没结束，本次压根没执行」，
    // 与保活/清理无关，touch 也不该发生（那一侧正在用）。
    if (err instanceof SessionBusyError) return busyEnvelope();
    // [REQ-browser BR-06/BR-08] 只有「会话真的没了」才即时清理；
    //   异常发生在导航之后时窗口仍然可用，按 BR-04 的口径保活 ——
    //   否则用户看到的是「页面已经打开，然后窗口自己消失」，日志里还会多一条「打开异常清理」。
    if (sessionGone(s)) {
      if (!hadSession) await closeSession(s, "打开异常清理");
      return failEnvelope("internal_error", `打开页面时发生未预期异常：${errText(err)}`);
    }
    touch(s);
    const ttl = sessionTtlSeconds();
    return failEnvelope(
      "internal_error",
      `打开页面时发生未预期异常：${errText(err)}（会话 ${s.prefix}；进程 ${
        s.driver.processId?.() ?? "未知"
      }）。窗口已保留，约 ${ttl} 秒无操作后自动关闭；如需立刻关闭请调用 close`,
    );
  }
}

// ============================================================
// observe
// ============================================================

async function runObserve(args: Record<string, unknown>, ctx?: ToolContext): Promise<Envelope> {
  if (!isBrowserGroupOn()) {
    return failEnvelope("tool_disabled", "浏览器工具已禁用，本次未执行");
  }

  // offset 校验（非负整数）
  let offset = 0;
  if (args.offset !== undefined && args.offset !== null && args.offset !== "") {
    const n = typeof args.offset === "number" ? args.offset : Number(args.offset);
    if (!Number.isInteger(n) || n < 0) {
      return failEnvelope(
        "invalid_request",
        `offset 必须为非负整数（收到 ${String(args.offset)}）；0 表示从正文开头开始，续读请使用上一次返回的「下一段偏移」`,
      );
    }
    offset = n;
  }

  const s = getSession(ctx?.sessionId);
  if (!s) {
    return failEnvelope(
      "session_not_found",
      "当前会话不存在（可能已被 close，或因空闲超时被回收）",
    );
  }

  try {
    return await runSerial(s, async () => {
      const snap = await buildSnapshot(s, s.driver, { mode: "full", offset });
      if (!snap.ok) {
        const code: BrowserErrorCode = snap.kind === "closed" ? "session_not_found" : "internal_error";
        return failEnvelope(code, `读取页面快照失败：${snap.reason}`);
      }
      // [REQ-browser BR-21] 多标签时正文前先给标签清单，否则模型不知道当前看的是哪个标签
      const tabLines = tabNoticeLines(snap.tabs);
      const body = tabLines.length > 0 ? `${tabLines.join("\n")}\n\n${snap.text}` : snap.text;
      return ok(body, {
        tool: "internet.browser.observe",
        session: s.prefix,
        offset,
        bodyEnd: snap.bodyEnd,
        totalChars: snap.totalChars,
        nextOffset: snap.nextOffset,
        refCount: snap.refCount,
        generation: s.gen,
        tabCount: snap.tabs.count,
        tabIndex: snap.tabs.activeIndex,
        tabCountKnown: snap.tabs.known,
      });
    });
  } catch (err) {
    if (err instanceof SessionBusyError) return busyEnvelope();
    return failEnvelope("internal_error", `读取页面快照时发生未预期异常：${errText(err)}`);
  }
}

// ============================================================
// act
// ============================================================

async function runActTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<Envelope> {
  if (!isBrowserGroupOn()) {
    return failEnvelope("tool_disabled", "浏览器工具已禁用，本次未执行");
  }

  // 校验流水线 ②～⑥：全部本地，0 次浏览器操作
  const v = validateActArgs(args.actions);
  if (!v.ok) {
    return failEnvelope(v.code, v.message, v.detail ?? {});
  }

  // ⑦ 会话解析
  const s = getSession(ctx?.sessionId);
  if (!s) {
    return failEnvelope(
      "session_not_found",
      "当前会话不存在（可能已被 close，或因空闲超时被回收）",
    );
  }

  try {
    return await runSerial(s, () => runAct(s, v.actions, ctx));
  } catch (err) {
    if (err instanceof SessionBusyError) return busyEnvelope();
    return failEnvelope("internal_error", `执行动作时发生未预期异常：${errText(err)}`);
  }
}

// ============================================================
// extract
// ============================================================

/**
 * [REQ-browser BR-27] 读取页面局部内容（只读）。
 * 与其余工具同口径：开关复检 → 会话解析 → 串行执行 → 结构化信封。
 * 注意本工具**不**触发快照、不 bump 代次、不分配 ref —— 「只读」是 BR-28 的硬约束，
 * 任何一条被破坏都会让模型手里的 ref 在毫无征兆的情况下失效。
 */
async function runExtractTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<Envelope> {
  if (!isBrowserGroupOn()) {
    return failEnvelope("tool_disabled", "浏览器工具已禁用，本次未执行");
  }

  const s = getSession(ctx?.sessionId);
  if (!s) {
    return failEnvelope(
      "session_not_found",
      "当前会话不存在（可能已被 close，或因空闲超时被回收）",
    );
  }

  try {
    return await runSerial(s, () => runExtract(s, args));
  } catch (err) {
    if (err instanceof SessionBusyError) return busyEnvelope();
    return failEnvelope("internal_error", `读取页面内容时发生未预期异常：${errText(err)}`);
  }
}

// ============================================================
// close
// ============================================================

async function runClose(args: Record<string, unknown>, ctx?: ToolContext): Promise<Envelope> {
  const scope = args.scope === "tab" ? "tab" : "session";

  const s = getSession(ctx?.sessionId);
  if (!s) {
    return failEnvelope("session_not_found", "没有可关闭的会话（可能已关闭，或因空闲超时被回收）");
  }

  if (scope === "tab") {
    try {
      const r = await runSerial(s, () => closeCurrentTab(s));
      if (!r.ok) {
        const code: BrowserErrorCode =
          r.code === "tab_limit"
            ? "tab_limit"
            : r.code === "closed"
              ? "session_not_found"
              : "invalid_request";
        return failEnvelope(code, `关闭标签失败：${r.reason}`);
      }
      const lines = r.degraded
        ? [
            // [自评审 P-35] 保留既有前缀「【已关闭标签页】」：P1 起就有这条断言，不能因为改了措辞就变红；
            //   但正文必须说清「没有真正关闭」，否则就是 P1 的 P-21 那类假话。
            `【已关闭标签页】${modeLine(s)}`,
            "会话内只剩这一个标签：关掉它会让浏览器进程自行退出，因此**未真正关闭**，改为把当前标签导航到空白页（实例保留）。",
          ]
        : [`【已关闭标签】原第 ${r.closedIndex} 个｜当前标签 ${r.activeIndex}/${r.count}｜${modeLine(s)}`];
      return ok(withTail(lines.join("\n")), {
        tool: "internet.browser.close",
        scope,
        session: s.prefix,
        tabCount: r.count,
        tabIndex: r.activeIndex,
        tabClosed: !r.degraded,
      });
    } catch (err) {
      if (err instanceof SessionBusyError) return busyEnvelope();
      return failEnvelope("internal_error", `关闭标签页时发生未预期异常：${errText(err)}`);
    }
  }

  try {
    touch(s);
    const report = await closeSession(s, "工具调用 close");
    const lines = [
      `【已关闭会话】${report.prefix}`,
      `浏览器进程：${report.exited ? "已退出" : "未能确认退出（已尝试强杀整棵进程树）"}`,
      report.tempProfile
        ? `临时 profile 目录：${report.dirDeleted ? "已删除" : `未删除（已重试 ${report.dirRetries} 次，目录：${report.dirPath}）`}`
        : `持久 profile 目录：保留（${report.dirPath}）`,
      `调试端口：${report.port > 0 ? `${report.port} ${report.portReleased ? "已释放" : "仍被占用"}` : "未使用"}`,
    ];
    return ok(withTail(lines.join("\n")), {
      tool: "internet.browser.close",
      scope,
      session: report.prefix,
      exited: report.exited,
      portReleased: report.portReleased,
      dirDeleted: report.dirDeleted,
    });
  } catch (err) {
    return failEnvelope("internal_error", `关闭会话时发生未预期异常：${errText(err)}`);
  }
}

// ============================================================
// 工具导出（BR-01：恰为 5 个；BR-08：总开关共用 enabled）
// ============================================================

export const tools: Tool[] = [
  {
    name: "open",
    description: DESC_OPEN,
    parameters: SCHEMA_OPEN,
    // [§8.4] 旧总开关 BROWSER_ENABLED 已废弃：自身条件改为「组开关状态」（§8.3 第三环节）
    enabled: () => isBrowserGroupOn(),
    handler: async (args, ctx) => {
      try {
        return await runOpen(args, ctx);
      } catch (err) {
        return failEnvelope("internal_error", `打开工具内部错误：${errText(err)}`);
      }
    },
  },
  {
    name: "observe",
    description: DESC_OBSERVE,
    parameters: SCHEMA_OBSERVE,
    // [§8.4] 旧总开关 BROWSER_ENABLED 已废弃：自身条件改为「组开关状态」（§8.3 第三环节）
    enabled: () => isBrowserGroupOn(),
    handler: async (args, ctx) => {
      try {
        return await runObserve(args, ctx);
      } catch (err) {
        return failEnvelope("internal_error", `快照工具内部错误：${errText(err)}`);
      }
    },
  },
  {
    name: "act",
    description: DESC_ACT,
    parameters: SCHEMA_ACT,
    // [§8.4] 旧总开关 BROWSER_ENABLED 已废弃：自身条件改为「组开关状态」（§8.3 第三环节）
    enabled: () => isBrowserGroupOn(),
    handler: async (args, ctx) => {
      try {
        return await runActTool(args, ctx);
      } catch (err) {
        return failEnvelope("internal_error", `动作工具内部错误：${errText(err)}`);
      }
    },
  },
  {
    name: "close",
    description: DESC_CLOSE,
    parameters: SCHEMA_CLOSE,
    // [§8.4] 旧总开关 BROWSER_ENABLED 已废弃：自身条件改为「组开关状态」（§8.3 第三环节）
    enabled: () => isBrowserGroupOn(),
    handler: async (args, ctx) => {
      try {
        return await runClose(args, ctx);
      } catch (err) {
        return failEnvelope("internal_error", `关闭工具内部错误：${errText(err)}`);
      }
    },
  },
  {
    // [REQ-browser BR-27/NB-03] 第 5 个工具：只读取局部内容（工具面 4 → 5，全仓 19 → 20）
    name: "extract",
    description: DESC_EXTRACT,
    parameters: SCHEMA_EXTRACT,
    // [§8.4] 旧总开关 BROWSER_ENABLED 已废弃：自身条件改为「组开关状态」（§8.3 第三环节）
    enabled: () => isBrowserGroupOn(),
    handler: async (args, ctx) => {
      try {
        return await runExtractTool(args, ctx);
      } catch (err) {
        return failEnvelope("internal_error", `读取内容工具内部错误：${errText(err)}`);
      }
    },
  },
];
// ============================================================
// [规范 §8.3 / §8.4] 执行时的层级门禁复检
// ============================================================

import { groupState } from "@/infra/settings";

/**
 * 组是否可用（祖先目录全开 + 组开关开 + 未挂起）。
 *
 * 为什么保留「工具内部再查一次」：BR-08 要求「即使平台放行也必须再检查」，
 *   而 §8.5 明确「清单按快照固定，执行时实时复查」——两者叠加正是这里的用途。
 * 为什么读 groupState 而不是读旧开关：`BROWSER_ENABLED` 已在 §9.2 迁移中删除，
 *   可用性唯一来源是「目录链 AND 组开关」（§8.3）。日志/开关值都不在此打印（§8.7）。
 */
function isBrowserGroupOn(): boolean {
  return groupState("internet/browser").available;
}

/* ============================================================
 * [规范 §7.1] 组设置项声明（仅 internet/browser 可读，§7.3）
 *   · 键名与 migrate.ts 的 DOWN_SINK 一一对应（改名 = 用户旧值变孤儿键）；
 *   · 默认值只在这里写一次（§3.2）；BROWSER_ENABLED 已废弃，不在声明内（§8.4）；
 *   · 与默认值相同的取值不落盘（§9.1）；越界 / 类型不符读取端回退默认（§7.4）。
 * ============================================================ */
export const settings: Record<string, SettingDef> = {
    executable_path: {
        kind: "string",
        default: "auto",
        desc: "浏览器可执行文件路径；auto = 自动探测 Edge → Chrome。显式路径必须存在，否则启动失败并列出已尝试路径。",
    },
    foreground_on_open: {
        kind: "boolean",
        default: true,
        desc: "open 时是否把窗口带到最前（无头模式无效）。关闭后也不再以最大化启动。",
    },
    headless: {
        kind: "boolean",
        default: true,
        desc: "无头模式：窗口不出现在屏幕上（操作仍在真实浏览器内执行）。改为 false 后下一次 open 会按新配置重建实例。",
    },
    debug_port: {
        kind: "number",
        default: 0,
        min: 0,
        max: 65535,
        desc: "调试端口；0 = 随机分配。固定值用于端口冲突排查。",
    },
    profile_mode: {
        kind: "string",
        default: "temp",
        options: ["temp", "persist"],
        desc: "temp = 临时 profile（关闭即删）；persist = 持久 profile（登录态会保留给模型使用）。",
    },
    profile_dir: {
        kind: "string",
        default: "",
        desc: "仅 persist 模式使用；为空时回退临时 profile 并在日志告警。",
    },
    session_ttl_s: {
        kind: "number",
        default: 180,
        min: 10,
        max: 86400,
        desc: "会话空闲存活秒数，到期自动关闭浏览器并删除临时 profile。",
    },
    max_sessions: {
        kind: "number",
        default: 2,
        min: 1,
        max: 10,
        desc: "并发会话上限（打开失败后被保留的会话同样占名额）。",
    },
    max_tabs: {
        kind: "number",
        default: 10,
        min: 1,
        max: 20,
        desc: "单会话标签数上限；= 1 即退回单标签语义（同标签导航、不登记站点新标签）。",
    },
    action_timeout_ms: {
        kind: "number",
        default: 8000,
        min: 500,
        max: 120000,
        desc: "单步动作超时（毫秒）。",
    },
    nav_timeout_ms: {
        kind: "number",
        default: 20000,
        min: 1000,
        max: 300000,
        desc: "导航超时（毫秒）。",
    },
    stable_window_ms: {
        kind: "number",
        default: 400,
        min: 0,
        max: 5000,
        desc: "导航/跳转后判定「加载完成」的稳定窗口（毫秒）。",
    },
    snapshot_max_elements: {
        kind: "number",
        default: 120,
        min: 1,
        max: 1000,
        desc: "快照列出的元素上限。",
    },
    snapshot_max_chars: {
        kind: "number",
        default: 6000,
        min: 200,
        max: 12000,
        desc: "快照正文字符上限（整页概览，与 extract 的细读上限相互独立）。",
    },
    extract_max_chars: {
        kind: "number",
        default: 12000,
        min: 500,
        max: 24000,
        desc: "单次 extract 回灌字符上限（硬上限 24000）。",
    },
    extract_max_elements: {
        kind: "number",
        default: 20,
        min: 1,
        max: 200,
        desc: "extract 命中清单条数上限。",
    },
    max_actions: {
        kind: "number",
        default: 10,
        min: 1,
        max: 30,
        desc: "单次 act 的动作数上限。",
    },
    domain_allowlist: {
        kind: "string_array",
        default: [],
        desc: "域名白名单（后缀匹配）；空 = 不额外限制（私有网段仍被阻断）。",
    },
    domain_blocklist: {
        kind: "string_array",
        default: [],
        desc: "域名黑名单，优先于白名单。",
    },
    block_private_net: {
        kind: "boolean",
        default: true,
        desc: "阻断内网 / 回环地址（含 DNS 解析后的私有地址）。",
    },
    allow_download: {
        kind: "boolean",
        default: false,
        desc: "是否允许下载（默认拒绝）。",
    },
    allow_upload: {
        kind: "boolean",
        default: false,
        desc: "是否允许上传（默认拒绝）。",
    },
    drag_steps: {
        kind: "number",
        default: 12,
        min: 10,
        max: 60,
        desc: "拖拽插值步数（代码强制下限 10：步数过小会被拖拽库判定为点击）。",
    },
    type_delay_ms: {
        kind: "number",
        default: 0,
        min: 0,
        max: 100,
        desc: "逐字输入的时间间隔（毫秒）。",
    },
};
