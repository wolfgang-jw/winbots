/**
 * etc/tools/internet/browser.ts
 * 浏览器工具门面（唯一被 loadTools 加载的文件，BR-02）
 *
 * 契约：导出 tools: Tool[]，调用名 internet.browser.<name>
 *       模型可见名固定 internet__browser__open / __observe / __act / __close（BR-03）
 * 分层：本文件只做「开关复检 → 入参预检 → 会话编排 → 结果整形」；
 *       动作在 _browser_actions，快照在 _browser_snapshot，会话在 _browser_session，
 *       页面原语在 _browser_driver，传输在 _browser_cdp（BR-06）。
 *
 * ⚠️ 工具内部永不向平台抛业务异常（BR-45）；失败一律返回结构化信封。
 */
import type { Tool, ToolContext } from "@/tools";
import { env } from "@/infra/env";
import { ok, type Envelope } from "./_common";
import { failEnvelope, withTail, type BrowserErrorCode } from "./_browser_errors";
import { precheckUrl, reasonLabel } from "./_browser_policy";
import { buildSnapshot } from "./_browser_snapshot";
import {
  bumpGeneration,
  closeSession,
  ensureSession,
  getSession,
  resetTab,
  runSerial,
  SessionBusyError,
  touch,
  type Session,
} from "./_browser_session";
import { runAct, validateActArgs } from "./_browser_actions";
import {
  DESC_ACT,
  DESC_CLOSE,
  DESC_OBSERVE,
  DESC_OPEN,
  SCHEMA_ACT,
  SCHEMA_CLOSE,
  SCHEMA_OBSERVE,
  SCHEMA_OPEN,
} from "./_browser_schemas";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function navTimeout(): number {
  return Math.max(1000, Number(env.BROWSER_NAV_TIMEOUT_MS) || 20000);
}

function stableWindow(): number {
  return Math.max(0, Number(env.BROWSER_STABLE_WINDOW_MS) || 400);
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

// ============================================================
// open
// ============================================================

async function runOpen(args: Record<string, unknown>, ctx?: ToolContext): Promise<Envelope> {
  // ① 开关复检（BR-08：即使平台放行也必须再检查，且不得启动浏览器）
  if (!env.BROWSER_ENABLED) {
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
      return failEnvelope("session_limit", undefined, { occupied: ensured.occupied });
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
  if (s.headless !== Boolean(env.BROWSER_HEADLESS)) {
    const from = s.headless ? "无头" : "有头";
    const to = env.BROWSER_HEADLESS ? "无头" : "有头";
    console.log(`[browser] 窗口模式已变更（${from} → ${to}），按新配置重建会话 ${s.prefix}`);
    await closeSession(s, "窗口模式配置变更，按新配置重建");
    const again = await ensureSession(ctx?.sessionId);
    if (!again.ok) {
      if (again.code === "session_limit") {
        return failEnvelope("session_limit", undefined, { occupied: again.occupied });
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
      // ④ 导航（判据=加载完成 + 稳定窗口，不是「命令返回」）
      const nav = await s.driver.navigate(pre.url, {
        timeoutMs: navTimeout(),
        stableMs: stableWindow(),
      });
      if (!nav.ok) {
        // 新建会话导航失败：清理半成品，绝不留半死进程
        if (!hadSession) await closeSession(s, "打开失败清理");
        const code: BrowserErrorCode =
          nav.kind === "nav_timeout"
            ? "navigation_timeout"
            : nav.kind === "closed"
              ? "session_not_found"
              : "navigation_failed";
        return failEnvelope(code, nav.reason);
      }

      // ⑤ 导航后文档代次递增，旧 ref 全部失效
      bumpGeneration(s);

      // ⑥ 首屏快照
      const snap = await buildSnapshot(s, s.driver, { mode: "full" });
      if (!snap.ok) {
        return failEnvelope("internal_error", `页面已打开，但读取页面快照失败：${snap.reason}`);
      }

      const head =
        `【已打开】${nav.value.url}｜${modeLine(s)}` +
        (switched ? `｜已按最新配置重建（${s.headless ? "无头" : "有头"}）` : "");
      // [FIX-SILENT-03] 无头时把「窗口不可见」显式写进结果，避免模型误报「已打开」
      const hint = headlessHint(s);
      const body = hint ? [head, hint, "", snap.text] : [head, "", snap.text];
      return ok(body.join("\n"), {
        tool: "internet.browser.open",
        session: s.prefix,
        url: nav.value.url,
        title: nav.value.title,
        // [FIX-WIN-03] 报会话真实模式，不报 env
        headless: s.headless,
        tempProfile: s.tempProfile,
        refCount: snap.refCount,
        generation: s.gen,
        // [FIX-WIN-03] 便于用户/开发者在任务管理器里核对「是否真有浏览器进程」
        pid: s.driver.processId?.() ?? null,
        reusedSession: hadSession,
      });
    });
  } catch (err) {
    if (err instanceof SessionBusyError) return busyEnvelope();
    if (!hadSession) await closeSession(s, "打开异常清理");
    return failEnvelope("internal_error", `打开页面时发生未预期异常：${errText(err)}`);
  }
}

// ============================================================
// observe
// ============================================================

async function runObserve(args: Record<string, unknown>, ctx?: ToolContext): Promise<Envelope> {
  if (!env.BROWSER_ENABLED) {
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
      return ok(snap.text, {
        tool: "internet.browser.observe",
        session: s.prefix,
        offset,
        bodyEnd: snap.bodyEnd,
        totalChars: snap.totalChars,
        nextOffset: snap.nextOffset,
        refCount: snap.refCount,
        generation: s.gen,
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
  if (!env.BROWSER_ENABLED) {
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
      const r = await runSerial(s, () => resetTab(s));
      const text = `【已关闭标签页】${modeLine(s)}｜${r.detail}`;
      return ok(withTail(text), { tool: "internet.browser.close", scope, session: s.prefix });
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
// 工具导出（BR-01：恰为 4 个；BR-08：总开关共用 enabled）
// ============================================================

export const tools: Tool[] = [
  {
    name: "open",
    description: DESC_OPEN,
    parameters: SCHEMA_OPEN,
    enabled: () => env.BROWSER_ENABLED,
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
    enabled: () => env.BROWSER_ENABLED,
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
    enabled: () => env.BROWSER_ENABLED,
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
    enabled: () => env.BROWSER_ENABLED,
    handler: async (args, ctx) => {
      try {
        return await runClose(args, ctx);
      } catch (err) {
        return failEnvelope("internal_error", `关闭工具内部错误：${errText(err)}`);
      }
    },
  },
];
