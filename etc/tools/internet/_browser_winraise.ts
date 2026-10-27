/**
 * etc/tools/internet/_browser_winraise.ts
 * Windows 前台锁兜底 + **OS 级前台判定**（INC-02 补强）
 *
 * [REQ-browser BR-10] 有头模式下 open 后窗口必须到最前（含失败保留分支）。
 * [REQ-browser BR-13] 兜底失败不得影响 open 的成败、不得新增错误码 —— 本文件**永不抛错**，
 *   结果只体现在 ForegroundAssist 上，文案由调用点给（提示语固定，不随兜底结果变化）。
 * [REQ-browser BR-14] 无头模式不得到这里：调用点 raiseWindow() 已按 Session.headless 短路。
 * [REQ-browser NB-05] 本文件自己不打日志（不泄露 URL）；只回一个结果对象，由调用点记一行。
 * [REQ-browser NB-01] 逻辑落在本文件，驱动与门面都不增长；门面只多一次 await。
 *
 * ── 为什么需要它（两轮实测）──────────────────────────────────────────────
 * 第一轮结论：`Page.bringToFront` 在内核里最终落到 Win32 `SetForegroundWindow`，Windows 有前台锁
 * （SPI_GETFOREGROUNDLOCKTIMEOUT，默认 2s），非前台进程调用会被**静默拒绝**，CDP 照样回成功。
 *
 * 第二轮结论（P2-P32，更关键）：**判据本身不可信**。上一版用页面自报的
 * `document.hasFocus()` 复核「是否真的到了前台」，实测在这台机器上恒为 true ——
 * 它只表示「渲染器认为这个标签页处于激活态」（`Page.bringToFront` 之后必然如此），
 * 与操作系统有没有把窗口提到最前毫无关系。结果：
 *     front=yes / reached=activate / ms=54，**连 assist= 段都没有**，兜底一次都没触发。
 * 因此本文件承担第二件事：给出**操作系统级**的权威判定
 *     GetForegroundWindow() 的所属进程 == 浏览器的 pid ？
 * 判定与提升放在**同一段 PowerShell** 里，一次 spawn 完成「探测 →（不在前则）提升 → 复核」。
 *
 * ── 提升的四条路（按「穿透前台锁」的能力从强到弱）────────────────────────
 *  ① attach：`AttachThreadInput(前台线程, 本线程)` 后 `BringWindowToTop` + `SetForegroundWindow`，
 *     借前台线程的输入归属绕过前台锁；
 *  ② alt   ：`keybd_event(VK_MENU)` 下压/抬起，人为制造一次键盘输入，解锁前台锁后再
 *     `SetForegroundWindow`（Windows 允许「最近有输入」的进程夺前台）；
 *  ③ appactivate：`WScript.Shell.AppActivate(pid)`（内部自有一套 AttachThreadInput 逻辑）；
 *  ④ topmost：`SetWindowPos(HWND_TOPMOST)` → 立刻 `HWND_NOTOPMOST`。不受前台锁限制，
 *     能把窗口抬到最上层；还原 NOTOPMOST 是为了不留下「永远压着别人」的副作用。
 *
 * ── 回执三态（P2-P31）────────────────────────────────────────────────────
 * 只回 ok/no 会造出**反向误导**：④ 能把窗口摆到最前，但抢不到键盘焦点，
 * 工具若报「窗口未能置前」，用户看到的窗口明明就在最前面。因此分三档：
 *     OK  = 窗口已在最前 **且** 取得（或本来就是）前台
 *     TOP = 仅置顶成功（窗口在最前，未取得键盘焦点）
 *     NO  = 都没成
 *
 * ── 偏离登记（见 P2 文档 §12/§13，待签署）────────────────────────────────
 * BR-09 要求「零第三方依赖」：本文件只用系统自带 powershell.exe 与 user32/kernel32，
 * 不引任何 npm 包；但确实引入了「每次 open spawn 一个系统进程」的副作用
 * （Add-Type 编译 + 探测 + 提升，实测约 0.4～1.2s；无头 / 开关关闭 / pid 不存在时 0 次）。
 */

import { execFile } from "node:child_process";

export interface ForegroundAssist {
  /** 是否拿到了**操作系统级**判定（脚本跑通并回报 OK/TOP/NO）。false 时调用点保留 CDP 自报结论 */
  probed: boolean;
  /** 窗口是否已在 OS 前台（OK 或 TOP 都为 true） */
  ok: boolean;
  /** 是否取得了前台焦点（OK=true / TOP=false） */
  focused: boolean;
  /** 走了哪条路：already / attach / alt / appactivate / topmost / none / no_window / circuit / … */
  how: string;
  /** 未执行或失败的原因（只进日志，不进模型可见文案 —— BR-13 规定提示语固定） */
  why: string;
}

/** 单次脚本的上限：Add-Type 首次编译较慢，留 8s；仍远小于 open 的导航超时 */
const PS_TIMEOUT_MS = 8000;
/** 连续「提升失败」熔断：穿不透前台锁的环境里，不要再每次都尝试提升（但**仍然探测**，保证报告真实） */
const FAIL_STREAK_LIMIT = 3;
/** 原因串截断长度：日志单行，不能因为 PowerShell 的堆栈把整行冲掉 */
const WHY_MAX = 160;

let failStreak = 0;
let disabled = false;

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cut(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= WHY_MAX ? t : `${t.slice(0, WHY_MAX - 1)}…`;
}

/**
 * pid 是否仍然存在。
 * 目的有二：① 假驱动返回的假 pid（用例里常见）不会真的去 spawn 一个 PowerShell；
 * ② 持久 profile 复用已有实例时，我们启动的进程可能已退出，此时代码要如实降级而不是乱提窗口。
 * 注意 EPERM（进程存在但无权限打开）必须当成「存在」，否则会漏判。
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/**
 * C# 侧：枚举同 pid 的顶层可见窗口，取面积最大的那个当作「浏览器主窗口」。
 * 为什么不用 `(Get-Process).MainWindowHandle`：Chrome 的主进程未必持有窗口句柄，
 * 该字段常为 0；而且它只给一个候选，无法区分「主窗口」和工具窗口。
 */
const CS = `using System;
using System.Runtime.InteropServices;
public class WbWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  public static readonly IntPtr TopMost = new IntPtr(-1);
  public static readonly IntPtr NoTopMost = new IntPtr(-2);
  public static uint PidOf(IntPtr h) { uint p = 0; GetWindowThreadProcessId(h, out p); return p; }
  public static uint TidOf(IntPtr h) { uint p = 0; return GetWindowThreadProcessId(h, out p); }
  public static IntPtr FindMain(uint pid) {
    IntPtr best = IntPtr.Zero; long area = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (PidOf(h) != pid) return true;
      if (!IsWindowVisible(h)) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (a > area) { area = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}`;

/**
 * 生成 PowerShell 脚本。pid / 开关都是**数字**内插，不做字符串转义，从根上避免注入面。
 * 输出固定一行：`WB|<OK|TOP|NO|ERR>|<how>|h=<hwnd>|fg=<前台窗口所属 pid>`
 * 注意变量名用 `$WBPID`：`$PID` 是 PowerShell 的保留自动变量（当前进程号），绝不能覆盖。
 */
function buildScript(pid: number, doRaise: boolean): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$WBPID=${pid}`,
    `$WBRAISE=${doRaise ? 1 : 0}`,
    "try{Add-Type -TypeDefinition @'",
    CS,
    "'@",
    "}catch{[Console]::Out.Write('WB|ERR|compile|h=0|fg=0');exit}",
    "$h=[WbWin]::FindMain([uint32]$WBPID)",
    "if($h.ToInt64() -eq 0){try{$p=Get-Process -Id $WBPID -ErrorAction SilentlyContinue;if($p){$h=$p.MainWindowHandle}}catch{}}",
    "$hw=$h.ToInt64()",
    "$fg=[WbWin]::GetForegroundWindow()",
    "$fgp=[WbWin]::PidOf($fg)",
    "$kind='NO'",
    "$how='init'",
    // 没有窗口可提升：如实回报（调用点据此保留 CDP 结论，不误报失败）
    "if($hw -eq 0){$how='no_window'}",
    // 已经在最前：不做任何提升（这是最常见的情形，避免无谓的焦点抢占）
    "elseif($fgp -eq $WBPID){$kind='OK';$how='already'}",
    // 已熔断：只探测不提升，保证报告仍然是真实的前台状态
    "elseif($WBRAISE -ne 1){$how='circuit'}",
    "else{",
    // SW_RESTORE=9：最小化时先还原，否则后续置顶/提权对隐藏窗口无效
    "  if([WbWin]::IsIconic($h)){[void][WbWin]::ShowWindow($h,9);Start-Sleep -Milliseconds 80}",
    "  $tid=[WbWin]::TidOf($fg)",
    "  if($tid -ne 0){[void][WbWin]::AttachThreadInput($tid,[WbWin]::GetCurrentThreadId(),$true)}",
    "  [void][WbWin]::BringWindowToTop($h)",
    "  [void][WbWin]::SetForegroundWindow($h)",
    "  if($tid -ne 0){[void][WbWin]::AttachThreadInput($tid,[WbWin]::GetCurrentThreadId(),$false)}",
    "  Start-Sleep -Milliseconds 60",
    "  if([WbWin]::PidOf([WbWin]::GetForegroundWindow()) -eq $WBPID){$kind='OK';$how='attach'}",
    "  else{",
    // VK_MENU(0x12) 下压 → 解锁前台锁 → 抬起；KEYEVENTF_KEYUP=2
    "    [WbWin]::keybd_event(0x12,0,0,[UIntPtr]::Zero)",
    "    [void][WbWin]::SetForegroundWindow($h)",
    "    [WbWin]::keybd_event(0x12,0,2,[UIntPtr]::Zero)",
    "    Start-Sleep -Milliseconds 60",
    "    if([WbWin]::PidOf([WbWin]::GetForegroundWindow()) -eq $WBPID){$kind='OK';$how='alt'}",
    "    else{",
    "      try{$sh=New-Object -ComObject WScript.Shell;if($sh.AppActivate($WBPID)){$how='appactivate'}}catch{}",
    "      Start-Sleep -Milliseconds 60",
    "      if([WbWin]::PidOf([WbWin]::GetForegroundWindow()) -eq $WBPID){$kind='OK'}",
    // SWP_NOSIZE|SWP_NOMOVE=3；置顶后再取消置顶，窗口留在最上层但不永久压制他人
    "      elseif([WbWin]::SetWindowPos($h,[WbWin]::TopMost,0,0,0,0,3)){[void][WbWin]::SetWindowPos($h,[WbWin]::NoTopMost,0,0,0,0,3);$kind='TOP';$how='topmost'}",
    "      else{$how='none'}",
    "    }",
    "  }",
    "}",
    "$fg2=[WbWin]::PidOf([WbWin]::GetForegroundWindow())",
    "[Console]::Out.Write('WB|'+$kind+'|'+$how+'|h='+$hw+'|fg='+$fg2)",
  ].join("\n");
}

/** 跑一段 PowerShell；永不抛错，超时/缺失都归一为失败 */
function runPowerShell(script: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          // 只对 -Command 生效，不写盘、不改机器策略
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-Command",
          script,
        ],
        { windowsHide: true, timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            out: String(stdout ?? "").trim(),
            err: String(stderr ?? "").trim() || (err ? msgOf(err) : ""),
          });
        },
      );
    } catch (err) {
      // execFile 同步抛（极少见：参数非法 / 资源不足）
      resolve({ ok: false, out: "", err: msgOf(err) });
    }
  });
}

/**
 * 判定并（必要时）把浏览器窗口提到最前。**永不抛错**。
 *
 * @param pid 浏览器主进程号（调用点用 driver.processId()）
 */
export async function ensureForeground(pid: number): Promise<ForegroundAssist> {
  const no = (why: string): ForegroundAssist => ({
    probed: false,
    ok: false,
    focused: false,
    how: "skip",
    why,
  });

  if (process.platform !== "win32") return no("not_windows");
  const id = Math.trunc(Number(pid));
  if (!Number.isFinite(id) || id <= 0) return no("no_pid");
  if (!processAlive(id)) return no("pid_gone");

  const res = await runPowerShell(buildScript(id, !disabled));
  // 只认最后一条 WB| 打头的行：Add-Type 的告警/编译信息可能混进 stdout，不能整段当结果解析
  const line = res.out
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.startsWith("WB|"))
    .pop();
  if (!line) return no(cut(res.err || res.out || "no_output"));

  const parts = line.split("|");
  const kind = (parts[1] ?? "").toUpperCase();
  const how = parts[2] ?? "";
  // 编译失败：**没有拿到判定**（不是「不在前台」），调用点要保留 CDP 自报结论
  if (kind !== "OK" && kind !== "TOP" && kind !== "NO") return no(`script:${how}`);

  const ok = kind === "OK" || kind === "TOP";
  // 找不到该 pid 的顶层窗口 ≠「不在前台」：可能窗口属于另一个 chrome 进程、或窗口还没创建出来。
  // 这种情况我们没有能力判定，**必须交回 CDP 自报**，否则会把「正常打开」误报成「未能置前」。
  if (kind === "NO" && how === "no_window") {
    return { probed: false, ok: false, focused: false, how, why: "no_window" };
  }
  if (ok) {
    failStreak = 0;
  } else if (how !== "circuit") {
    failStreak++;
    if (failStreak >= FAIL_STREAK_LIMIT) disabled = true;
  }
  return {
    probed: true,
    ok,
    focused: kind === "OK",
    how,
    why: ok ? "" : cut(how),
  };
}

/** 用例复位熔断状态（生产路径不需要） */
export function resetForegroundAssist(): void {
  failStreak = 0;
  disabled = false;
}
