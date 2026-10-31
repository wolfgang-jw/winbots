/**
 * etc/tools/local/_shell_exec.ts
 * 命令执行层（批次三 / SH-14 ~ SH-22、NH-08、NH-09）
 *
 * ⚠️ 本文件【不导出 tools】（SH-04）。
 *
 * 职责：
 *   1. shell 类型的 argv 组装（cmd / powershell，SH-12 / XS-04）
 *   2. 进程创建、stdin 一次性写入并**立即关闭**（SH-14）
 *   3. stdout / stderr **并行**读取（NH-09：不得因单流无数据阻塞整体超时）
 *   4. 超时与取消：统一的绝对时间上限 + 进程树终止（SH-15 / SH-16 / SH-22）
 *   5. 会话串行锁 与 全局并发槽（AP-08 / SH-17；两把锁语义不同，见注释）
 */
import { env, type ShellType } from "@/infra/env";
import { buildChildEnv, codePageToEncoding } from "./_shell_policy";

/** shell 类型。⚠️ 类型定义只有一处（src/infra/env.ts），这里再导出，避免两处字面量漂移（复核 R17）。 */
export type { ShellType };

/** 当前 shell 类型（实时读配置，SH-46） */
export function currentShellType(): ShellType {
    return String(env.SHELL_TYPE ?? "").toLowerCase() === "powershell" ? "powershell" : "cmd";
}

/**
 * 组装 argv。
 * ⚠️ 只放 shell 自身的固定开关，**命令串原样**作为最后一个参数传入 ——
 *    不得在这里拼 `chcp`、`&&`、引号或任何前缀（AP-19 / AC-SH-30，理由见文档 §3.4）。
 */
export function buildSpawnArgs(shell: ShellType, command: string): string[] {
    if (shell === "powershell") {
        return [
            "powershell.exe",
            "-NoLogo",              // 不打印版权头
            "-NoProfile",           // 不加载用户 profile（AC-SH-20：无用户配置加载）
            "-NonInteractive",      // 非交互（XS-01）
            "-ExecutionPolicy", "Bypass",
            "-Command", command,
        ];
    }
    return ["cmd.exe", "/d", "/s", "/c", command];
}

/* ============================================================
 * 一、控制台代码页探测（SH-28）
 * ============================================================ */

let consoleEncodingCache: string | null = null;

/**
 * 探测控制台代码页（只在首次执行时探测一次）。
 * 说明：这不是「配置项」，而是环境事实，缓存不违反 SH-46 的「配置必须实时读」。
 */
export function consoleEncoding(): string {
    if (consoleEncodingCache) return consoleEncodingCache;
    let cp = 0;
    try {
        const r = Bun.spawnSync(["cmd.exe", "/d", "/c", "chcp"], {
            stdout: "pipe",
            stderr: "ignore",
            windowsHide: true,
        });
        const text = new TextDecoder("latin1").decode(r.stdout ?? new Uint8Array(0));
        const m = text.match(/(\d{3,5})/);
        cp = m ? Number(m[1]) : 0;
    } catch {
        cp = 0;
    }
    consoleEncodingCache = codePageToEncoding(cp);
    return consoleEncodingCache;
}

/* ============================================================
 * 二、会话串行锁 与 全局并发槽（两把不同的锁）
 * ============================================================ */

const sessionLocks = new Set<string>();
let activeSlots = 0;

/**
 * 第 ⑥ 步：会话串行锁。覆盖「挂起待审批 + 执行」**整段**（SH-17 / AC-SH-15）。
 * 取不到 → 立即 busy（不排队、不静默等待）。
 */
export function tryLockSession(sessionId: string): (() => void) | null {
    const key = sessionId || "unknown";
    if (sessionLocks.has(key)) return null;
    sessionLocks.add(key);
    return () => { sessionLocks.delete(key); };
}

/**
 * 第 ⑦ 步之后：全局并发槽。**必须**在「用户批准后、创建进程前」才获取（AP-08）：
 * 挂起期间不占槽位，否则「没人点的弹窗」会把全局并发吃满。
 * 取不到 → 立即 busy（SH-17：超限立即拒绝，不得排队）。
 */
export function tryAcquireSlot(): (() => void) | null {
    const max = Math.max(1, Number(env.SHELL_MAX_CONCURRENCY) || 1);
    if (activeSlots >= max) return null;
    activeSlots++;
    return () => { activeSlots = Math.max(0, activeSlots - 1); };
}

/** 供用例/排查观察（不参与判定） */
export function execStats(): { activeSlots: number; lockedSessions: number } {
    return { activeSlots, lockedSessions: sessionLocks.size };
}

/* ============================================================
 * 三、进程树终止（SH-16）
 * ============================================================ */

/**
 * 终止整棵进程树：**先** `taskkill /F /T`（`/T` = 连子孙进程一起），**再**兜底父进程。
 * 顺序不可颠倒：先杀 cmd.exe 会让孙进程孤儿化并继续运行（NH-08）。
 */
export async function killTree(pid: number): Promise<void> {
    try {
        const k = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(pid)], {
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
        });
        await k.exited;
    } catch {
        // taskkill 不存在 / 已被终止：忽略，走下面的兜底
    }
    try {
        process.kill(pid);
    } catch {
        // 已退出：正常
    }
}

/* ============================================================
 * 四、执行
 * ============================================================ */

export interface ExecRequest {
    command: string;
    cwd: string;
    timeoutMs: number;
    /** 一次性写入后立即关闭；未提供时**也**要立即关闭（SH-14） */
    stdin?: string;
    signal?: AbortSignal;
}

export type ExecOutcomeKind = "exited" | "timeout" | "cancelled" | "spawn_failed" | "internal_error";

export interface ExecResult {
    kind: ExecOutcomeKind;
    /** kind = exited 时的退出码（**非 0 不是错误**，SH-18） */
    exitCode: number | null;
    elapsedMs: number;
    stdoutBytes: Uint8Array;
    stderrBytes: Uint8Array;
    /** kind = spawn_failed / internal_error 时的说明（不含命令内容） */
    message?: string;
}

/**
 * 流读取累积器（复核修正 R-DRAIN）。
 *
 * 为什么不用「readAll 直接返回 Promise<Uint8Array>」：
 *   若孙进程孤儿化后仍持有管道写端（`start` 一类 detach 进程，`taskkill /T` 也追不到），
 *   `reader.read()` 会**永不 resolve**。此时外层无论怎么 race，只要再 await 这个 Promise
 *   就会永久挂起 —— 直接违反 SH-22「不得出现进程已退出但工具仍在等待」。
 * 因此把已读到的块放在**调用方可见**的 sink 里：等待有上限，超时就取已读部分。
 */
interface StreamSink {
    chunks: Uint8Array[];
    ended: boolean;
}

function newSink(): StreamSink {
    return { chunks: [], ended: false };
}

/** 把 sink 中已读到的块拼成一个 Uint8Array（不做任何解码，纯字节） */
function sinkBytes(sink: StreamSink): Uint8Array {
    let total = 0;
    for (const c of sink.chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of sink.chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

/** 把流读到 sink（并行调用，互不阻塞，NH-09）；异常结束也保留已读部分 */
async function pump(stream: ReadableStream<Uint8Array> | null, sink: StreamSink): Promise<void> {
    if (!stream) {
        sink.ended = true;
        return;
    }
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) sink.chunks.push(value);
        }
    } catch {
        // 进程被强杀时流可能异常结束：已读到的部分照常返回
    }
    sink.ended = true;
}

/** 简单延时（用于给「流收尾」留一个上限，SH-22） */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建子 shell 进程（单独成函数：让 Bun.spawn 按选项字面量自行推断泛型，
 * 不在调用处手写 `Bun.Subprocess<…>`，避免与 bun-types 的泛型元数/默认值漂移）。
 * 选项固定为三个 pipe：stdin 用于一次性写入（SH-14），stdout/stderr 用于并行读取（NH-09）。
 */
function spawnShell(req: ExecRequest, shell: ShellType, childEnv: Record<string, string>) {
    return Bun.spawn(buildSpawnArgs(shell, req.command), {
        cwd: req.cwd,                     // SH-21：子进程工作目录只经启动参数指定，不改服务进程 cwd
        env: childEnv,                    // SH-35：显式构造，不整体继承
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    });
}

/**
 * 执行一条命令。
 * 绝对时间上限覆盖「进程创建 + 执行 + 输出读取」整段（SH-22）：
 * 即使进程已退出但某个流不结束，也会在上限到点时强制收尾。
 */
export async function execCommand(req: ExecRequest): Promise<ExecResult> {
    const startedAt = Date.now();
    const deadline = startedAt + req.timeoutMs;
    const shell = currentShellType();
    const envSet = buildChildEnv();

    let proc: ReturnType<typeof spawnShell>;
    try {
        proc = spawnShell(req, shell, envSet.env);
    } catch (e) {
        // SH-19：找不到 shell / 无权创建进程 → spawn_failed（不得表述成命令失败）
        return {
            kind: "spawn_failed",
            exitCode: null,
            elapsedMs: Date.now() - startedAt,
            stdoutBytes: new Uint8Array(0),
            stderrBytes: new Uint8Array(0),
            message: e instanceof Error ? e.message : String(e),
        };
    }

    // SH-14：有 stdin 就写入，没有也立即关闭 —— 否则 set /p、more 一类程序会等到超时
    try {
        if (typeof req.stdin === "string" && req.stdin.length > 0) proc.stdin.write(req.stdin);
        proc.stdin.end();
    } catch {
        // 进程可能立即退出：写入失败不影响结果
    }

    const stdoutSink = newSink();
    const stderrSink = newSink();
    const stdoutP = pump(proc.stdout as ReadableStream<Uint8Array>, stdoutSink);
    const stderrP = pump(proc.stderr as ReadableStream<Uint8Array>, stderrSink);

    let timedOut = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = () => {
        aborted = true;
        void killTree(proc.pid);
    };
    if (req.signal) {
        if (req.signal.aborted) {
            aborted = true;
            void killTree(proc.pid);
        } else {
            req.signal.addEventListener("abort", onAbort, { once: true });
        }
    }

    timer = setTimeout(() => {
        timedOut = true;
        void killTree(proc.pid);          // SH-15：超时必须终止进程树
    }, Math.max(1, req.timeoutMs));

    const exitCode = await proc.exited;   // 被 killTree 后也会返回
    if (timer) clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener("abort", onAbort);

    // 收尾读流：最多再等到 deadline（SH-22：不得出现「进程已退出但工具仍在等待」）
    const remain = Math.max(50, deadline - Date.now());
    await Promise.race([Promise.all([stdoutP, stderrP]), delay(remain)]);

    // 竞态兜底：若是因为超时/取消才退出，仍要把残留的树再杀一次（幂等）
    if (timedOut || aborted) await killTree(proc.pid);

    // ⚠️ 复核修正 R-DRAIN：这里**不能**再无条件 await 双流 ——
    //   上面的 race 一旦因超时结束，若某个孤儿孙进程仍持有管道写端，promise 永不 resolve，
    //   再 await 一次就等于「工具永久挂起」，SH-22 形同虚设。
    //   改为：仅在确有流未结束的情况下，再给一个有界的收尾窗口（100ms），
    //   到时无论是否读完都用「已读到的部分」返回（宁可少回灌，也绝不挂住会话）。
    if (!stdoutSink.ended || !stderrSink.ended) {
        await Promise.race([Promise.all([stdoutP, stderrP]), delay(100)]);
    }
    const stdoutBytes = sinkBytes(stdoutSink);
    const stderrBytes = sinkBytes(stderrSink);
    const elapsedMs = Date.now() - startedAt;

    if (aborted) {
        return { kind: "cancelled", exitCode: null, elapsedMs, stdoutBytes, stderrBytes };
    }
    if (timedOut) {
        return { kind: "timeout", exitCode: null, elapsedMs, stdoutBytes, stderrBytes };
    }
    return { kind: "exited", exitCode, elapsedMs, stdoutBytes, stderrBytes };
}
