/**
 * etc/tools/internet/_browser_session.ts
 * 会话注册表、状态机、TTL、并发上限、串行互斥、关停编排
 *
 * [需求] BR-34 按 sessionId 隔离；BR-35 无标识退化进程级单例；BR-36 TTL；
 *        BR-37 并发上限；BR-38 进程级兜底；BR-59 临时目录删除
 * [设计] 第 5 章、§4「结束顺序」
 *
 * ⚠️ 进程清理钩子在本文件自行注册，`src/index.ts` 保持零改动（NB-02）。
 */
import type { ToolContext } from "@/tools";
import { env } from "@/infra/env";
import type { BrowserDriver, ElementAnchor, PageSignature } from "./_browser_driver";
import { newDriver } from "./_browser_driver";
import {
  killTreeSync,
  removeDirSyncBestEffort,
  cleanupOrphanProfileDirs,
  proc,
  makeTempProfileDir,
  exeLabel,
} from "./_browser_proc";
import {
  judgeRequestUrl,
  reasonLabel,
  downloadAllowed,
  uploadAllowed,
} from "./_browser_policy";

// ============================================================
// 类型
// ============================================================

export interface RefEntry {
  gen: number;
  anchor: ElementAnchor;
}

export interface Session {
  key: string;
  /** 会话标识前 8 位（结果文本与日志只用这个，避免回灌完整标识） */
  prefix: string;
  state: "starting" | "ready" | "closing";
  driver: BrowserDriver;
  port: number;
  profileDir: string;
  tempProfile: boolean;
  /**
   * [FIX-WIN-03] 创建时实际使用的窗口模式。
   * 不得在展示时回头看 env：配置热更后旧会话仍按旧模式运行，
   * 按 env 报告会出现「说有头、其实还是无头」的假话。
   */
  headless: boolean;
  createdAt: number;
  lastUsedAt: number;
  /**
   * [R-03] 正在执行 + 排队中的调用数。
   * 清扫器据此跳过回收：否则 BROWSER_SESSION_TTL_S 若小于单批动作耗时
   * （10 个动作 × 单步 8s ≈ 80s），浏览器会在 act 执行到一半被关掉 ——
   * 这是「静默中断业务逻辑」，比空闲回收严重得多。
   */
  inFlight: number;
  /** 文档代次：只在主框架导航/重载时递增 */
  gen: number;
  refTable: Map<string, RefEntry>;
  /** [实现取舍] 会话内单调，跨代次不重置 —— 避免旧 ref 与新元素同号 */
  refSeq: number;
  baseline: PageSignature | null;
  /** 本次会话填过的密码明文（整形文本与日志前精确替换，BR-57） */
  secrets: Set<string>;
  /** 会话内串行链（FIFO） */
  chain: Promise<void>;
  /** 被请求层阻断的请求（数量上限 50，仅用于结果追加行与日志） */
  blocked: Array<{ url: string; reason: string }>;
  /** 下载/上传被拒次数 */
  downloadBlocked: number;
  uploadBlocked: number;
  /** 驱动已断开（浏览器崩溃 / 窗口被用户关闭） */
  dead: boolean;
  deadReason: string;
}

export interface CloseReport {
  key: string;
  prefix: string;
  exited: boolean;
  portReleased: boolean;
  port: number;
  dirDeleted: boolean;
  dirRetries: number;
  dirPath: string;
  tempProfile: boolean;
  reason: string;
}

export type CreateResult =
  | { ok: true; session: Session }
  | {
      ok: false;
      code: "session_limit" | "browser_unavailable";
      detail: string;
      occupied?: string[];
      attemptedPaths?: string[];
    };

// ============================================================
// 注册表
// ============================================================

const registry = new Map<string, Session>();
const pending = new Map<string, Promise<CreateResult>>();

/**
 * [R-06] 进程退出时必须强杀的会话集合（含「正在关闭中」的）。
 * 不能用 registry：closeSession 在杀进程**之前**就把自己从 registry 摘掉，
 * 于是「关闭途中收到退出信号」会漏杀 → 浏览器变孤儿进程 + 临时目录删不掉。
 */
const liveSessions = new Set<Session>();

/** 会话键：`browser:<sessionId>`；无标识用固定键（进程级单例，BR-35） */
export function keyOf(sessionId?: string): string {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  return sid ? `browser:${sid}` : "browser:__default__";
}

/** 会话标识展示前缀（≤8 字符） */
function prefixOf(key: string): string {
  const raw = key.startsWith("browser:") ? key.slice("browser:".length) : key;
  if (raw === "__default__") return "default";
  return raw.slice(0, 8) || "default";
}

export function listSessions(): Session[] {
  return [...registry.values()];
}

/**
 * [R-05] 从注册表摘除指定会话实例（仅当注册表里仍是它自己）。
 * 不按 key 无条件删：同一 key 可能已被新会话（窗口模式重建 / 快速重开）占用，
 * 旧实例的断开回调若 delete(key)，会把新会话从注册表摘掉 ——
 * 表现是「窗口还在跑，工具却报 session_not_found」。
 */
export function detachSession(s: Session): void {
  if (registry.get(s.key) === s) registry.delete(s.key);
  liveSessions.delete(s);
}

/**
 * 仅用于用例：直接登记一个会话（绕过真实启动流程）。
 * 供「清扫器是否跳过忙会话」「断开是否误删新会话」这类纯逻辑用例使用。
 */
export function __testOnlyAddSession(s: Session): void {
  registry.set(s.key, s);
  liveSessions.add(s);
}

/** 仅用于用例：清空注册表与在管集合 */
export function __testOnlyClearSessions(): void {
  registry.clear();
  liveSessions.clear();
}

export function sessionCount(): number {
  return [...registry.values()].filter((s) => s.state !== "closing" && !s.dead).length;
}

export function getSession(sessionId?: string): Session | null {
  const s = registry.get(keyOf(sessionId));
  if (!s) return null;
  if (s.dead || s.state !== "ready") return null;
  return s;
}

export function touch(s: Session): void {
  s.lastUsedAt = Date.now();
}

/** 导航后：代次递增、ref 全失效、基线作废（BR-19 / BR-27） */
export function bumpGeneration(s: Session): void {
  s.gen += 1;
  s.refTable.clear();
  s.baseline = null;
}

/** 分配新 ref（会话内单调） */
export function allocRef(s: Session): string {
  s.refSeq += 1;
  return `e${s.refSeq}`;
}

export function rememberSecret(s: Session, value: string): void {
  const v = String(value ?? "");
  if (v.length >= 4) s.secrets.add(v);
}

// ============================================================
// 创建
// ============================================================

/** 取会话；不存在则创建。`starting` 期间的并发请求共享同一次启动 */
export async function ensureSession(sessionId?: string): Promise<CreateResult> {
  const key = keyOf(sessionId);
  const existing = registry.get(key);
  if (existing && !existing.dead && existing.state === "ready") {
    touch(existing);
    return { ok: true, session: existing };
  }
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const task = createSession(key);
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

async function createSession(key: string): Promise<CreateResult> {
  const limit = Math.max(1, Number(env.BROWSER_MAX_SESSIONS) || 2);
  const active = [...registry.values()].filter((s) => s.state !== "closing" && !s.dead);
  if (active.length >= limit) {
    return {
      ok: false,
      code: "session_limit",
      detail: "",
      occupied: active.slice(0, 3).map((s) => s.prefix),
    };
  }

  const prefix = prefixOf(key);
  const driver = newDriver();
  const startedAt = Date.now();

  // profile：持久优先（仅在 persist 模式且目录可用时），否则临时
  const persistDir = proc().resolvePersistDir();
  const tempProfile = persistDir === null;
  const profileDir = persistDir ?? makeTempProfileDir(prefix);

  const session: Session = {
    key,
    prefix,
    state: "starting",
    driver,
    port: 0,
    profileDir,
    tempProfile,
    // [FIX-WIN-03] 窗口模式在此定格；open 会据此判断「配置是否已变更，需要按新配置重建」
    headless: env.BROWSER_HEADLESS,
    createdAt: startedAt,
    lastUsedAt: startedAt,
    inFlight: 0,
    gen: 1,
    refTable: new Map<string, RefEntry>(),
    refSeq: 0,
    baseline: null,
    secrets: new Set<string>(),
    chain: Promise.resolve(),
    blocked: [],
    downloadBlocked: 0,
    uploadBlocked: 0,
    dead: false,
    deadReason: "",
  };

  // [R-06] 先登记再启动：启动途中收到退出信号也要能强杀
  liveSessions.add(session);
  registerProcessHooks();
  startSweeper();

  const launch = await driver.launch({
    headless: env.BROWSER_HEADLESS,
    profileDir,
    allowDownload: downloadAllowed(),
    allowUpload: uploadAllowed(),
    judgeRequest: async (url: string) => {
      const v = await judgeRequestUrl(url);
      return { allow: !v.blocked, reason: v.blocked ? reasonLabel(v.reason) : "" };
    },
    onBlockedRequest: (url, reason) => {
      if (session.blocked.length < 50) session.blocked.push({ url, reason });
    },
    onDownloadBlocked: () => {
      session.downloadBlocked += 1;
    },
    onUploadBlocked: () => {
      session.uploadBlocked += 1;
    },
    onDisconnected: (reason) => {
      if (session.state === "closing") return;
      session.dead = true;
      session.deadReason = reason;
      // [R-05] 只摘自己这一条（key 可能已被新实例占用）
      detachSession(session);
      console.warn(`[browser] 会话 ${session.prefix} 已断开：${reason}`);
      void (async () => {
        try {
          await driver.shutdown();
        } catch {
          /* ignore */
        }
        if (session.tempProfile) await proc().removeDirWithRetry(session.profileDir);
      })();
    },
  });

  if (!launch.ok) {
    liveSessions.delete(session); // 启动失败：不再需要它在退出钩子里
    if (tempProfile) await proc().removeDirWithRetry(profileDir);
    const tried = proc().resolveExecutable().tried;
    return {
      ok: false,
      code: "browser_unavailable",
      detail: launch.reason,
      attemptedPaths: tried,
    };
  }

  session.port = launch.value.port;
  session.state = "ready";
  session.lastUsedAt = Date.now();
  registry.set(key, session);

  console.log(
    [
      "[browser] 会话启动",
      `session=${prefix}`,
      `exe=${exeLabel(proc().resolveExecutable().path)}`,
      `headless=${session.headless ? "yes" : "no"}`,
      `profile=${tempProfile ? "temp" : "persist"}`,
      `port=${session.port}`,
      `elapsed=${Date.now() - startedAt}ms`,
    ].join("｜"),
  );

  return { ok: true, session };
}

// ============================================================
// 串行与取消
// ============================================================

export class SessionBusyError extends Error {
  constructor() {
    super("会话正忙：排队等待超过上限");
    this.name = "SessionBusyError";
  }
}

/**
 * 会话内串行（FIFO）。排队超过上限视为会话忙，**但必须放行后续请求**
 * （因此超时分支也要释放占位，不能把队列永久堵死）。
 */
export async function runSerial<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const waitLimit =
    Math.max(1000, Number(env.BROWSER_ACTION_TIMEOUT_MS) || 8000) +
    Math.max(1000, Number(env.BROWSER_NAV_TIMEOUT_MS) || 20000);

  const prev = s.chain;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  s.chain = prev.then(() => gate, () => gate);

  // [R-03] 从「进入队列」就计价：排队等待中的请求同样属于「正在使用」，
  //        不能被清扫器当成空闲会话收掉。
  s.inFlight += 1;
  try {
    const waited = await Promise.race([
      prev.then(() => true, () => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), waitLimit)),
    ]);
    if (!waited) throw new SessionBusyError();
    touch(s);
    return await fn();
  } finally {
    s.inFlight = Math.max(0, s.inFlight - 1);
    release();
  }
}

// ============================================================
// 关闭
// ============================================================

/** [BR-38 / BR-59] 结束顺序：连接 → 自行退出 → 杀进程树 → 等端口 → 删目录 → 日志 */
export async function closeSession(s: Session, reason: string): Promise<CloseReport> {
  if (s.state === "closing") {
    return {
      key: s.key,
      prefix: s.prefix,
      exited: true,
      portReleased: true,
      port: s.port,
      dirDeleted: true,
      dirRetries: 0,
      dirPath: s.profileDir,
      tempProfile: s.tempProfile,
      reason,
    };
  }
  s.state = "closing";
  // [R-05] 只摘自己；[R-06] 仍留在 liveSessions 里，直到确认收尾完成才移除
  //   （否则「关闭途中收到退出信号」会漏杀，浏览器变孤儿）
  if (registry.get(s.key) === s) registry.delete(s.key);

  let exited = false;
  try {
    await s.driver.shutdown();
    exited = true;
  } catch (err) {
    console.warn(`[browser] 会话 ${s.prefix} 关闭时出错（继续清理）`, err);
  }

  const portReleased = s.port > 0 ? await proc().waitPortReleased(s.port, 3000) : true;

  let dirDeleted = true;
  let dirRetries = 0;
  if (s.tempProfile) {
    const r = await proc().removeDirWithRetry(s.profileDir);
    dirDeleted = r.ok;
    dirRetries = r.retries;
    if (!r.ok) {
      console.warn(
        `⚠️ [browser] 临时 profile 目录未删除（已重试 ${r.retries} 次）：${s.profileDir}｜${r.error ?? ""}`,
      );
    }
  }

  console.log(
    [
      "[browser] 会话关闭",
      `session=${s.prefix}`,
      `reason=${reason}`,
      `exited=${exited ? "yes" : "no"}`,
      `dir=${s.tempProfile ? (dirDeleted ? "deleted" : "kept") : "persist"}`,
      `retries=${dirRetries}`,
      `port=${s.port}${portReleased ? "(released)" : "(busy)"}`,
    ].join("｜"),
  );

  // [R-06] 收尾完成（进程结束 / 端口释放 / 目录处理）后才从退出钩子的管辖集合移除
  liveSessions.delete(s);

  return {
    key: s.key,
    prefix: s.prefix,
    exited,
    portReleased,
    port: s.port,
    dirDeleted,
    dirRetries,
    dirPath: s.profileDir,
    tempProfile: s.tempProfile,
    reason,
  };
}

/** 关闭全部会话（总开关关闭 / 进程收尾） */
export async function closeAll(reason: string): Promise<CloseReport[]> {
  const all = [...registry.values()];
  const out: CloseReport[] = [];
  for (const s of all) {
    out.push(await closeSession(s, reason));
  }
  return out;
}

/** `close(scope=tab)`：回空白页并清空 ref，实例保留（XB-01 单标签） */
export async function resetTab(s: Session): Promise<{ ok: boolean; detail: string }> {
  const r = await s.driver.navigate("about:blank", {
    timeoutMs: Math.max(1000, Number(env.BROWSER_NAV_TIMEOUT_MS) || 20000),
    stableMs: Math.max(0, Number(env.BROWSER_STABLE_WINDOW_MS) || 400),
  });
  bumpGeneration(s);
  s.baseline = null;
  touch(s);
  return r.ok
    ? { ok: true, detail: "已回到空白页并清空元素引用，浏览器实例仍在运行" }
    : { ok: false, detail: `回到空白页失败：${r.reason}` };
}

// ============================================================
// TTL 清扫 + 总开关联动
// ============================================================

let sweeper: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * 每 5s 检查一次：过期会话回收；总开关关闭时主动回收全部会话（D-12）。
 *
 * [R-03] 间隔由 30s 收紧到 5s：TTL 下限是 10s，30s 的检查粒度让「设 10~30s」
 * 完全无意义（实际生效值只会是 30s 的倍数）。每轮只遍历注册表（并发上限 ≤10），
 * 开销可忽略。
 */
export function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepOnce();
  }, 5_000);
  // 不因定时器阻止进程退出
  const maybe = sweeper as unknown as { unref?: () => void };
  maybe.unref?.();
}

export async function sweepOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    if (!env.BROWSER_ENABLED) {
      const all = listSessions();
      if (all.length > 0) {
        console.log(`[browser] 总开关已关闭，主动回收全部会话（${all.length} 个）`);
        await closeAll("总开关关闭");
      }
      return;
    }
    const ttlMs = Math.max(10, Number(env.BROWSER_SESSION_TTL_S) || 180) * 1000;
    const now = Date.now();
    for (const s of listSessions()) {
      if (s.state === "closing" || s.dead) continue;
      const idleMs = now - s.lastUsedAt;
      if (idleMs <= ttlMs) continue;
      // [R-03] 有调用在执行或排队 → 绝不回收（否则会把浏览器从动作中途关掉）
      if (s.inFlight > 0) {
        // 只在「刚越过阈值」时提示一次，避免长任务期间每 5s 刷屏
        if (idleMs - ttlMs < 6_000) {
          console.log(
            `[browser] 会话 ${s.prefix} 已超空闲阈值，但仍有 ${s.inFlight} 个调用在执行，跳过回收`,
          );
        }
        continue;
      }
      await closeSession(s, "空闲超时回收");
    }
  } catch (err) {
    console.warn("[browser] 会话清扫出错（已忽略）", err);
  } finally {
    sweeping = false;
  }
}

/** 仅用于用例：停掉清扫定时器 */
export function stopSweeperForTest(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

// ============================================================
// 进程级兜底（BR-38）
// ============================================================

let hooksRegistered = false;

function registerProcessHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;

  // `exit` 钩子内不允许异步：只做强杀的同步版本（异步重试在正常 close 路径）
  process.on("exit", () => {
    // [R-06] 遍历 liveSessions（含「正在关闭中」的会话），不能用 registry：
    //   closeSession 在杀进程前就把自己从 registry 摘掉了，遍历 registry 会漏杀。
    for (const s of liveSessions) {
      try {
        const pid = s.driver.processId?.() ?? null;
        if (pid) killTreeSync(pid);
      } catch {
        /* ignore */
      }
      if (s.tempProfile) removeDirSyncBestEffort(s.profileDir);
    }
  });

  // 说明：不注册 SIGINT/SIGTERM 监听，避免接管 `src/index.ts` 的优雅关闭（NB-02）。
  //       信号路径最终也会走到上面的 exit 钩子。

  // 启动时清理 24h 前的孤儿目录（NB-08）
  try {
    cleanupOrphanProfileDirs();
  } catch {
    /* 清理失败不影响会话创建 */
  }
}
