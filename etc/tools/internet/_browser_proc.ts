/**
 * etc/tools/internet/_browser_proc.ts
 * 可执行文件探测、端口、启动参数、profile 目录、进程树结束、孤儿回收
 *
 * [需求] BR-09 只用系统已装浏览器；BR-40 端口不冲突且不静默失败；BR-39 临时 profile；
 *        BR-38 进程级兜底；NB-08 资源回收
 * [设计] 第 4 章「进程、端口与 profile」
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { env } from "@/infra/env";

// ============================================================
// 可执行文件探测（BR-09 / US-03）
// ============================================================

/** 候选路径：Edge → Chrome（32/64 位 Program Files + 用户级安装目录） */
export function candidatePaths(): string[] {
  const list: string[] = [];
  const push = (p: string | undefined) => {
    if (p && !list.includes(p)) list.push(p);
  };

  if (process.platform === "win32") {
    const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
    for (const base of bases) {
      if (!base) continue;
      push(join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
    const local = process.env.LOCALAPPDATA;
    if (local) {
      push(join(local, "Microsoft", "Edge", "Application", "msedge.exe"));
      push(join(local, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    push("/usr/bin/microsoft-edge");
    push("/usr/bin/google-chrome");
    push("/usr/bin/google-chrome-stable");
    push("/usr/bin/chromium");
    push("/usr/bin/chromium-browser");
  }
  return list;
}

/**
 * 解析最终使用的可执行文件。
 * `BROWSER_EXECUTABLE_PATH=auto`（或空）→ 自动探测；显式路径优先，但**必须存在**，
 * 否则直接返回 null（不静默回退到探测：用户配错了要被告知）。
 */
export function resolveExecutable(): { path: string | null; tried: string[] } {
  const configured = String(env.BROWSER_EXECUTABLE_PATH ?? "").trim();
  if (configured && configured.toLowerCase() !== "auto") {
    return existsSync(configured)
      ? { path: configured, tried: [configured] }
      : { path: null, tried: [configured] };
  }
  const tried = candidatePaths();
  for (const p of tried) {
    if (existsSync(p)) return { path: p, tried };
  }
  return { path: null, tried };
}

/** 日志用：只打文件名，不打完整路径（避免暴露用户名目录） */
export function exeLabel(p: string | null): string {
  if (!p) return "-";
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// ============================================================
// 端口（BR-40 / US-04）
// ============================================================

/** 向系统申请一个空闲端口后立即释放（配置为 0 时使用） */
export function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("无法分配空闲端口"))));
    });
  });
}

/** 端口是否被占用（固定端口场景：占用即失败，不静默换端口） */
export function isPortBusy(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}

/** 轮询等待端口释放（close 流程第 ④ 步，最多 3s） */
export async function waitPortReleased(port: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortBusy(port))) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return !(await isPortBusy(port));
}

// ============================================================
// profile 目录（BR-39 / BR-59）
// ============================================================

export function profileRoot(): string {
  return join(tmpdir(), "winbots-browser");
}

/** 本进程正在使用的目录，孤儿回收时跳过 */
const activeDirs = new Set<string>();

export function registerActiveDir(dir: string): void {
  activeDirs.add(dir);
}

export function unregisterActiveDir(dir: string): void {
  activeDirs.delete(dir);
}

/** 临时 profile：<系统临时目录>/winbots-browser/<会话前缀>-<时间戳> */
export function makeTempProfileDir(prefix: string): string {
  const root = profileRoot();
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${prefix}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  registerActiveDir(dir);
  return dir;
}

/** 持久 profile 目录（配置为空 → 返回 null，由调用方回退临时并告警） */
export function resolvePersistDir(): string | null {
  if (env.BROWSER_PROFILE_MODE !== "persist") return null;
  const dir = String(env.BROWSER_PROFILE_DIR ?? "").trim();
  if (!dir) {
    // [R-04] 选了 persist 却没填目录：必须说清「已回退临时」，
    //   否则用户以为登录态被保留，实际每次都是空 profile。
    console.warn(
      "⚠️ [browser] BROWSER_PROFILE_MODE=persist 但 BROWSER_PROFILE_DIR 为空，已回退临时 profile（会话关闭即删）。" +
        "请在配置页「持久化用户数据目录」填一个独立目录。",
    );
    return null;
  }
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    console.warn(`⚠️ [browser] 持久 profile 目录不可用，回退临时: ${dir}`, err);
    return null;
  }
}

/**
 * 删除目录，最多 3 次、间隔递增（BR-59 要求重试且不得静默）。
 * 返回值语义统一为「重试次数」= 尝试次数 - 1：
 *   成功时 = 成功前失败过几次；失败时 = attempts - 1（原先直接返回 attempts，
 *   与成功分支的语义不一致，文案「已重试 N 次」会多算一次）。
 */
export async function removeDirWithRetry(
  dir: string,
  attempts = 3,
): Promise<{ ok: boolean; retries: number; error?: string }> {
  let lastErr: string | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      unregisterActiveDir(dir);
      return { ok: true, retries: i };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 100 * 2 ** i));
    }
  }
  return { ok: false, retries: Math.max(0, attempts - 1), error: lastErr };
}

/** 同步睡眠：`exit` 钩子里不能 await，用 Atomics.wait 阻塞一小段 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不支持时不睡，直接进入下一次重试 */
  }
}

/**
 * 同步版：只能用在进程 `exit` 钩子里（钩子内不允许异步）。
 *
 * [R-06 连带] Windows 上 taskkill 返回后，浏览器子进程收尾还要一点时间，
 * 文件句柄尚未释放，立刻 rmSync 常常失败 → 每次 Ctrl+C 都留下
 * %TEMP%\winbots-browser\... 直到 24h 孤儿回收。因此这里做带间隔的重试。
 */
export function removeDirSyncBestEffort(dir: string, attempts = 3): void {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      unregisterActiveDir(dir);
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) sleepSync(120 * (i + 1));
    }
  }
  console.warn(`⚠️ [browser] 退出清理未能删除目录（已重试 ${attempts} 次）: ${dir}`, lastErr);
}

/**
 * 孤儿回收（BR-38 / NB-08）：启动时扫描临时目录，删除「非本进程使用」且超过 24h 的会话目录。
 * @returns 删除数量
 */
export function cleanupOrphanProfileDirs(maxAgeMs = 24 * 3600_000): number {
  const root = profileRoot();
  if (!existsSync(root)) return 0;
  let removed = 0;
  const now = Date.now();
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (activeDirs.has(full)) continue;
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < maxAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* 单个目录失败不影响其它 */
    }
  }
  if (removed > 0) console.log(`[browser] 孤儿 profile 目录已清理: ${removed} 个`);
  return removed;
}

// ============================================================
// 启动参数与进程（BR-40 / XB-07）
// ============================================================

/** 不注入 UA / 代理 / 指纹参数（XB-07）；关闭恢复会话与首次运行向导 */
export function buildArgs(o: { headless: boolean; userDataDir: string; port: number }): string[] {
  const args = [
    `--remote-debugging-port=${o.port}`,
    `--user-data-dir=${o.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1280,900",
    "about:blank",
  ];
  if (o.headless) args.unshift("--headless=new");
  return args;
}

export function spawnBrowser(exe: string, args: string[]): ChildProcess {
  // [FIX-WIN-02] `windowsHide` 只能给无头模式用。
  //   Windows 下该选项会让子进程以 STARTF_USESHOWWINDOW + SW_HIDE 启动，浏览器属于 GUI 程序，
  //   可能「进程在跑、窗口不显示」—— 这正是「配成有头却仍然看不到窗口」的一类成因。
  //   无头模式本来就没有窗口，继续给 true 以避免控制台闪窗。
  //   判据取自 args（buildArgs 在无头时插入 --headless=new），无需改 ProcOps 签名。
  const headless = args.some((a) => a === "--headless" || a.startsWith("--headless="));
  // POSIX 下用独立进程组，便于整棵树一起结束
  return spawn(exe, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: headless,
  });
}

/** 异步结束整棵进程树：先 SIGTERM，超时后强杀 */
export async function killTree(pid: number, graceMs = 1500): Promise<void> {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
    await new Promise((r) => setTimeout(r, graceMs));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  } catch {
    /* 进程已不存在 */
  }
}

/** 同步强杀：只用于 `exit` 钩子 */
export function killTreeSync(pid: number): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* ignore */
  }
}

// ============================================================
// 注入点（NB-04 / US-31）
// ============================================================

export interface ProcOps {
  resolveExecutable: typeof resolveExecutable;
  pickFreePort: typeof pickFreePort;
  isPortBusy: typeof isPortBusy;
  waitPortReleased: typeof waitPortReleased;
  makeTempProfileDir: typeof makeTempProfileDir;
  resolvePersistDir: typeof resolvePersistDir;
  removeDirWithRetry: typeof removeDirWithRetry;
  spawnBrowser: typeof spawnBrowser;
  killTree: typeof killTree;
}

const realOps: ProcOps = {
  resolveExecutable,
  pickFreePort,
  isPortBusy,
  waitPortReleased,
  makeTempProfileDir,
  resolvePersistDir,
  removeDirWithRetry,
  spawnBrowser,
  killTree,
};

let currentOps: ProcOps = realOps;

/** 用例注入假进程操作；传 null 复原。用例据此断言「校验失败时 spawn 次数为 0」 */
export function setProcOpsForTest(over: Partial<ProcOps> | null): void {
  currentOps = over ? { ...realOps, ...over } : realOps;
  activeDirs.clear();
}

export function proc(): ProcOps {
  return currentOps;
}
