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
// [REQ-browser BR-20/BR-21] 标签清单类型：只取**类型**（_browser_targets 不反向依赖本文件，不会形成循环）
import type { TabBrief, TabsSnapshot } from "./_browser_targets";
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

/**
 * [REQ-browser BR-20] 单个标签的文档状态。
 * `refTable` / `baseline` 存的是**引用**，切换标签时与 Session 上的镜像字段互换引用即可，
 * 不需要深拷贝；`gen` 是数值，切换时必须显式搬运（见 saveActiveTab / activateTab）。
 */
export interface SessionTabState {
  targetId: string;
  gen: number;
  refTable: Map<string, RefEntry>;
  baseline: PageSignature | null;
  /** 最近一次已知的地址与标题（只用于清单展示，BR-21） */
  url: string;
  title: string;
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
  /**
   * [REQ-browser BR-16/BR-20] 会话内每个标签的文档状态。
   * Session 上的 gen / refTable / baseline 只是**活跃标签**那一份的镜像：
   * 页面级代码（快照、动作、驱动命令）一律照旧读写镜像字段，只有切换标签时才搬运。
   */
  tabs: SessionTabState[];
  /** [REQ-browser BR-16] 当前活动标签的 targetId（驱动侧用同名的私有字段镜像） */
  activeTargetId: string;
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

/**
 * [REQ-browser 第 4 章] 并发会话上限：配置为 0 或非法时回退 2。
 * `browser.ts` 的 session_limit 失败文案也用它 —— 否则「文案里的数」与「实际拦截用的数」会分叉。
 */
export function sessionLimit(): number {
  return Math.max(1, Number(env.BROWSER_MAX_SESSIONS) || 2);
}

/**
 * [REQ-browser BR-07/BR-08] 空闲回收秒数：与 sweepOnce 同一口径。
 * 失败保活文案里的「约 N 秒无操作后自动关闭」必须来自这里，
 * 否则文案说 180s、实际 10s 就把人骗了。
 */
export function sessionTtlSeconds(): number {
  return Math.max(10, Number(env.BROWSER_SESSION_TTL_S) || 180);
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
  // [REQ-browser BR-20] 代次与基线是「值」而不是引用：必须同步写回该标签的条目，
  //   否则切走再切回会拿到旧代次（旧 ref 会被误判为仍然有效 → 点错元素）。
  if (s.activeTargetId) {
    const t = tabEntryOf(s, s.activeTargetId);
    t.gen = s.gen;
    t.baseline = null;
    t.refTable = s.refTable;
  }
}

/**
 * [REQ-browser BR-31] ref → 表项（含代次校验）的**唯一**取表入口。
 *
 * 为什么要单独抽一个函数：`act` 的 locate 与 `extract` 的取文必须走同一张表、同一套
 * 代次判据，否则会出现「act 说 ref 有效、extract 说 ref 已失效」这类自相矛盾的结果。
 * 这里只读 `s.refTable` / `s.gen` —— P3 起它们是**活跃标签**的镜像字段
 * （切换标签时与 SessionTabState 互换引用），因此天然按标签隔离，无需再取 activeTab()。
 *
 * 注意：本函数只查表，**不碰 DOM**（BR-28：extract 不得写 data-wb-k / data-wb-ref）。
 */
export function refEntryOf(s: Session, ref: string): RefEntry | null {
  const entry = s.refTable.get(ref);
  if (!entry || entry.gen !== s.gen) return null;
  return entry;
}

/** 当前活跃标签的文档代次（只读；`extract` 首段回显用） */
export function currentGen(s: Session): number {
  return s.gen;
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
  const limit = sessionLimit();
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
    // [REQ-browser BR-16] 标签状态：首个标签由第一次 syncTabs 认领（那时才知道 targetId）
    tabs: [],
    activeTargetId: "",
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
      // [REQ-browser NB-05] 启动时的 page 目标数：INC-04 复发时这里会直接显示 2
      `tabs=${launch.value.tabs ?? 1}`,
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
    const ttlMs = sessionTtlSeconds() * 1000;
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

// ============================================================
// 标签状态（P3 / BR-16～BR-26）
// ============================================================

/** [REQ-browser BR-22/NB-04] 单会话标签上限（1 = 退回单标签语义） */
export function sessionMaxTabs(): number {
  return Math.min(20, Math.max(1, Number(env.BROWSER_MAX_TABS) || 10));
}

/** 取（必要时创建）某标签的状态条目；新建的条目文档状态为「空」（ref 不跨标签复用） */
function tabEntryOf(s: Session, targetId: string): SessionTabState {
  const hit = s.tabs.find((x) => x.targetId === targetId);
  if (hit) return hit;
  const made: SessionTabState = {
    targetId,
    gen: s.gen,
    refTable: new Map<string, RefEntry>(),
    baseline: null,
    url: "",
    title: "",
  };
  s.tabs.push(made);
  return made;
}

/**
 * 把活跃标签的三个文档字段写回它的条目。
 * 只需在「即将切走」或「即将上报」时调用一次：页面级操作期间它们一直由 Session 上的镜像承载。
 */
export function saveActiveTab(s: Session): void {
  if (!s.activeTargetId) return;
  const t = tabEntryOf(s, s.activeTargetId);
  t.gen = s.gen;
  t.refTable = s.refTable;
  t.baseline = s.baseline;
}

/**
 * [REQ-browser BR-20] 切到某标签：把它的文档状态装回镜像字段。
 * 必须在任何页面级操作之前调用（驱动侧也按同一个 targetId 解析会话 id）。
 * 刻意**不**递增代次：切回旧标签时它此前的 ref 仍然有效 —— 这是标签栈的核心收益。
 */
export function activateTab(s: Session, targetId: string): void {
  const t = tabEntryOf(s, targetId);
  s.activeTargetId = targetId;
  s.gen = t.gen;
  s.refTable = t.refTable;
  s.baseline = t.baseline;
}

/** [REQ-browser BR-16] 新建标签后接管它的状态：旧标签先存回，再切到新标签 */
export function adoptCreatedTab(s: Session, targetId: string): void {
  saveActiveTab(s);
  activateTab(s, targetId);
}

export interface TabsReport {
  count: number;
  activeIndex: number;
  list: TabBrief[];
  /** 计数是否来自真实驱动（假驱动未实现 getTargets 时为 false，NB-03） */
  known: boolean;
  /** 本次新登记 / 消失的标签数（站点弹窗、页面自关，BR-17/BR-26） */
  created: number;
  destroyed: number;
}

/**
 * 取不到可靠标签事实时的统一缺省：按 1/1 报，并标明「不是实测值」。
 * 报 0 是测量失真而不是事实（页面明明开着），比「未知」更容易误导模型。
 */
const SINGLE_TAB: TabsReport = {
  count: 1,
  activeIndex: 1,
  list: [],
  known: false,
  created: 0,
  destroyed: 0,
};

/**
 * [REQ-browser BR-17/BR-21/BR-26] 与驱动对账，并把标签状态同步到 Session。
 * 这是「标签事实」的**唯一**来源（P1 的 tabFactsOf 已删除），
 * 避免 meta.tabCount 与 meta.tabList 来自两个来源而互相矛盾。
 */
export async function syncTabs(s: Session): Promise<TabsReport> {
  // 先存回活跃标签的状态：下面的对账可能改变「哪个标签是活跃的」
  saveActiveTab(s);

  const fn = s.driver.getTargets;
  if (typeof fn !== "function") return SINGLE_TAB;

  let snap: TabsSnapshot | null = null;
  try {
    const r = await fn.call(s.driver);
    if (r.ok) snap = r.value;
  } catch {
    // 标签计数只是辅助信息：取数抛错绝不能把「页面已打开」改判成失败
    snap = null;
  }
  if (!snap || snap.count <= 0 || snap.list.length === 0) return SINGLE_TAB;

  const before = new Set(s.tabs.map((t) => t.targetId));
  const alive = new Set(snap.list.map((b) => b.targetId));

  // ① 摘除已消失标签的状态（BR-26：页面自己关了自己的标签）
  let destroyed = 0;
  s.tabs = s.tabs.filter((t) => {
    if (alive.has(t.targetId)) return true;
    destroyed += 1;
    return false;
  });
  // ② 新标签：建空状态（不继承旧 refTable —— ref 不得跨标签复用，BR-20）
  let created = 0;
  for (const b of snap.list) {
    if (!before.has(b.targetId)) created += 1;
    const t = tabEntryOf(s, b.targetId);
    if (b.url) t.url = b.url;
    if (b.title) t.title = b.title;
  }
  // ③ 活动标签以**驱动**为准（目标消失时驱动会自动回退，BR-23/BR-26）
  const activeBrief = snap.list.find((b) => b.index === snap.activeIndex);
  const want = activeBrief?.targetId ?? "";
  if (want && !s.activeTargetId) {
    // 首个对账：当前镜像字段本来就是「这个标签」的状态，直接认领 —— 不能换成空表，
    //   否则刚 buildSnapshot 分配的 ref 会全部丢失。
    const t = tabEntryOf(s, want);
    t.gen = s.gen;
    t.refTable = s.refTable;
    t.baseline = s.baseline;
    s.activeTargetId = want;
  } else if (want && want !== s.activeTargetId) {
    activateTab(s, want);
  }

  return {
    count: snap.count,
    activeIndex: snap.activeIndex,
    list: snap.list,
    known: true,
    created,
    destroyed,
  };
}

function cutText(v: string, n: number): string {
  const t = String(v ?? "");
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

/** [REQ-browser BR-57] 清单里只展示 host（不展示 query / 凭据） */
export function hostOf(url: string): string {
  const v = String(url ?? "");
  if (!v || v === "about:blank") return "";
  try {
    return new URL(v).host;
  } catch {
    return "";
  }
}

/**
 * [REQ-browser BR-21] 标签提示行：数量 + 清单 + 当前序号 + 可用动作。
 * 只在 count > 1 时产生 —— 单标签是常态，不该每次结果都多三行噪声。
 * 放在会话层而不是动作层：动作层与门面互相 import 会形成循环（`act` 拿不到本函数）。
 */
export function tabNoticeLines(r: TabsReport, max = 10): string[] {
  if (r.count <= 1 || r.list.length <= 1) return [];
  const cur = r.list.find((b) => b.index === r.activeIndex);
  const lines: string[] = [
    `【标签】共 ${r.count} 个，当前第 ${r.activeIndex} 个${cur?.title ? `：${cutText(cur.title, 40)}` : ""}`,
  ];
  for (const b of r.list.slice(0, max)) {
    const label = cutText(b.title || hostOf(b.url) || "（无标题）", 40);
    lines.push(`  ${b.index}. ${label}${b.index === r.activeIndex ? "（当前）" : ""}`);
  }
  if (r.list.length > max) lines.push(`  …另有 ${r.list.length - max} 个未列出`);
  // [REQ-browser BR-17/BR-26] 把「标签自己多出来 / 自己消失」显式说出来：
  //   否则模型只看到序号变化，会以为是自己的操作导致的，进而重复点击。
  if (r.created > 0) lines.push(`  （本次新登记 ${r.created} 个标签：由站点自行打开）`);
  if (r.destroyed > 0) lines.push(`  （本次有 ${r.destroyed} 个标签已消失：由页面自行关闭）`);
  lines.push(`切换标签：act 传 {"action":"switchTab","tab":"序号或 prev/next"}；关闭当前标签：close scope=tab。`);
  return lines;
}

export type TabSwitchResult =
  | { ok: true; count: number; activeIndex: number; title: string; url: string }
  | { ok: false; code: "tab_limit" | "tab_not_found" | "closed"; reason: string };

/** [REQ-browser BR-18] 切换活动标签（序号 1 起 / prev / next） */
export async function switchTab(s: Session, sel: number | "prev" | "next"): Promise<TabSwitchResult> {
  const fn = s.driver.switchTarget;
  if (typeof fn !== "function") {
    return { ok: false, code: "tab_not_found", reason: "当前驱动不支持多标签（会话内只有单标签）" };
  }
  saveActiveTab(s);
  const r = await fn.call(s.driver, sel);
  if (!r.ok) return { ok: false, code: r.code, reason: r.reason };

  // [REQ-browser BR-20] 切标签**不**递增代次：切回旧标签时它的 ref 仍然有效
  activateTab(s, r.value.targetId);
  const rep = await syncTabs(s);
  const t = tabEntryOf(s, r.value.targetId);
  touch(s);
  return {
    ok: true,
    count: rep.count,
    activeIndex: rep.activeIndex || r.value.index,
    title: t.title,
    url: t.url,
  };
}

export type TabCloseResult =
  | { ok: true; count: number; activeIndex: number; closedIndex: number; degraded: boolean }
  | { ok: false; code: "tab_limit" | "tab_not_found" | "closed"; reason: string };

/**
 * [REQ-browser BR-23] 关闭当前标签，并回退到上一个（BR-26 的自毁回退同口径）。
 * ⚠️ 只剩一个标签时**不真关**：关掉最后一个标签会让浏览器进程自己退出
 * （BR-03 ③ 明确不允许这种形态），因此退化为「回空白页」并如实标记 degraded。
 */
export async function closeCurrentTab(s: Session): Promise<TabCloseResult> {
  const before = await syncTabs(s);
  if (before.count <= 1) {
    const r = await resetTab(s);
    return r.ok
      ? { ok: true, count: 1, activeIndex: 1, closedIndex: 1, degraded: true }
      : { ok: false, code: "closed", reason: r.detail };
  }
  const fn = s.driver.closeTarget;
  if (typeof fn !== "function") {
    return { ok: false, code: "tab_not_found", reason: "当前驱动不支持关闭标签" };
  }
  saveActiveTab(s);
  const r = await fn.call(s.driver);
  if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
  if (r.value.targetId) activateTab(s, r.value.targetId);
  const after = await syncTabs(s);
  touch(s);
  return {
    ok: true,
    count: after.count,
    activeIndex: after.activeIndex,
    closedIndex: r.value.closedIndex,
    degraded: false,
  };
}
