/**
 * etc/tools/local/_shell_policy.ts
 * 本机命令执行的静态策略与纯函数（批次三 / SH-09 ~ SH-13、SH-20、SH-26 ~ SH-37、SH-42）
 *
 * ⚠️ 本文件【不导出 tools】：loadTools 会因 `_` 前缀直接跳过（SH-04），不会刷「未导出 tools 告警」。
 * ⚠️ 只放纯函数与只读查询：不创建进程、不打印日志（日志文本由 runLogLine 返回，由调用方输出）。
 *
 * 职责：
 *   1. 档位读取（currentPermission）
 *   2. 参数校验（command / intent / cwd / timeoutMs）
 *   3. 拒绝清单与允许清单（启发式，SH-36：不是安全保证）
 *   4. 子进程环境白名单构造（SH-35）
 *   5. 输出整形：ANSI 剥离、编码统一、二进制判定、三要素截断（SH-25 ~ SH-30）
 *   6. 敏感值掩码（SH-37）
 */
import { statSync } from "fs";
import { env } from "@/infra/env";
import { groupScope, secretSettingValues } from "@/infra/settings";
import { resolveInRoot } from "./_shared";
import { escapedChars } from "./_fileReadRange";

/**
 * [规范 §7.3] 本文件服务 local/shell 组；每次实时取值，禁止模块级缓存（SH-46）。
 */
const S = groupScope("local", "shell");

/**
 * 权限档位的三值枚举。
 * ⚠️ 类型定义的**唯一来源**已随 C-06-1 从 `src/infra/env.ts` 搬到本文件（平台层不再持有工具配置类型）：
 *   配置本体是组设置项 `TOOLSET__local__shell__permission`，其合法取值由这里与 `settings` 声明共同定义。
 */
export type ShellPermission = "forbid" | "ask" | "allow";

/** 合法取值（顺序即配置页下拉顺序） */
export const SHELL_PERMISSIONS: readonly ShellPermission[] = ["forbid", "ask", "allow"];

/**
 * [SH-33] 内置拒绝清单默认集（大小写不敏感、去多余空白后按「包含」匹配）。
 * ⚠️ 这是**启发式**，不是安全保证（SH-36）；覆盖磁盘级与系统级破坏性操作。
 * 值为数组（组设置项声明类型 `string_array`，落盘为 JSON 文本）。
 */
export const DEFAULT_SHELL_DENY_LIST: readonly string[] = [
    "format", "diskpart", "bcdedit", "vssadmin delete", "vssadmin resize", "cipher /w",
    "wbadmin delete", "reg delete", "reg add", "shutdown", "restart-computer", "stop-computer",
    "net user", "net localgroup", "takeown /f", "icacls . /reset",
    "del /f /s /q c:", "rd /s /q c:", "rmdir /s /q c:",
];

/* ============================================================
 * 一、权限档位（AP-01 ~ AP-05）
 * ============================================================ */

/**
 * 当前档位：**每次实时读**组设置项（SH-46：不得在模块顶层缓存，否则热更失效）。
 * 非法值一律回退 "forbid"（保守失败：宁可工具消失，也不误开）。
 */
export function currentPermission(): ShellPermission {
    const raw = String(S.get<string>("permission") ?? "").toLowerCase();
    return raw === "ask" || raw === "allow" ? raw : "forbid";
}

/* ============================================================
 * 二、参数校验（SH-09 ~ SH-13、AP-06 ②③、SH-42）
 * ============================================================ */

/** intent 上限（AP-23 / SH-06 ⑥） */
export const INTENT_MAX_CHARS = 500;

/** 超时下限（SH-15：不得低于 1000ms） */
export const TIMEOUT_MIN_MS = 1000;

export type TextCheck = { ok: true; text: string } | { ok: false; message: string };

/**
 * 校验 command（SH-11 / SH-13）。
 * 通过时**原样返回**：不 trim、不折叠空白、不做任何改写 ——
 * 弹窗展示、授权记忆键、实际执行必须逐字节一致（AP-12 / AP-19）。
 */
export function checkCommand(raw: unknown): TextCheck {
    const text = typeof raw === "string" ? raw : "";
    if (text.trim() === "") {
        // SH-13：参数被截断时的自我修正文案（不弹窗，见 shell.ts ①②）
        return {
            ok: false,
            message:
                "command 缺失或为空（可能是单次输出过长导致参数被截断）。" +
                "请给出更短的命令后重试；如确需长命令，请改写为脚本文件后用一条命令执行。",
        };
    }
    const max = Math.max(1, Number(S.get<number>("max_command_chars")) || 4000);
    if (text.length > max) {
        return {
            ok: false,
            message:
                `命令过长（${text.length} 字符，上限 ${max} 字符）。` +
                "命令过长，请拆分为多次调用，或改写为脚本文件后用一条命令执行。",
        };
    }
    return { ok: true, text };
}

/**
 * 校验 intent（SH-06 ⑥ / AP-23）。
 * 注意：intent 只用于弹窗「目的段」，**不参与任何权限判定**——
 * 写「已获批准」「用户已同意」不产生任何效力（AP-23 后半句）。
 */
export function checkIntent(raw: unknown): TextCheck {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
        return {
            ok: false,
            message:
                "intent 必填：请说明这条命令要做什么、为什么必须现在执行、预期产出（不超过 500 字符）。" +
                "审批弹窗的「目的」段只取自这里，系统不会替你代填。",
        };
    }
    if (text.length > INTENT_MAX_CHARS) {
        return {
            ok: false,
            message: `intent 过长（${text.length} 字符 > ${INTENT_MAX_CHARS}）。请把目的压缩成一句话后重试。`,
        };
    }
    return { ok: true, text };
}

export type CwdCheck =
    | { ok: true; abs: string }
    | { ok: false; code: "out_of_root" | "invalid_request"; message: string };

/**
 * 解析 cwd（SH-20）：复用既有 _shared.resolveInRoot()，绝对路径与 `..` 越界一律 out_of_root。
 * ⚠️ 这不是沙箱：它只约束「启动目录」，命令内部仍可用 cd .. 或绝对路径（SH-32）。
 */
export function checkCwd(raw: unknown): CwdCheck {
    const text = raw === undefined || raw === null ? "" : String(raw);
    let abs: string;
    try {
        abs = resolveInRoot(text);
    } catch (e) {
        return {
            ok: false,
            code: "out_of_root",
            message:
                `${(e as Error).message}。` +
                "cwd 只能是相对总操作目录的子路径（如 \"build\" 或 \".\"），不能是绝对路径或用 .. 越界。",
        };
    }
    try {
        if (!statSync(abs).isDirectory()) {
            return {
                ok: false,
                code: "invalid_request",
                message: `cwd 不是目录：${text || "."}。请改成已存在的目录，或省略 cwd 使用总操作目录。`,
            };
        }
    } catch {
        return {
            ok: false,
            code: "invalid_request",
            message: `cwd 不存在：${text || "."}。请改成已存在的目录，或省略 cwd 使用总操作目录。`,
        };
    }
    return { ok: true, abs };
}

export type TimeoutCheck = { ok: true; ms: number } | { ok: false; message: string };

/**
 * 解析并钳制 timeoutMs（SH-15）：
 *   缺省 → SHELL_TIMEOUT_DEFAULT_MS；
 *   非法（非整数 / ≤0）→ invalid_request；
 *   合法但越界 → 钳制到 [1000, SHELL_TIMEOUT_MAX_MS]。
 */
export function checkTimeout(raw: unknown): TimeoutCheck {
    const max = Math.max(TIMEOUT_MIN_MS, Number(S.get<number>("timeout_max_ms")) || 120000);
    const def = Math.min(Math.max(Number(S.get<number>("timeout_default_ms")) || 30000, TIMEOUT_MIN_MS), max);
    if (raw === undefined || raw === null || raw === "") return { ok: true, ms: def };
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return {
            ok: false,
            message:
                `timeoutMs 必须是正整数毫秒（收到 ${JSON.stringify(raw)}）。` +
                `可省略使用默认 ${def}ms，或给出 ${TIMEOUT_MIN_MS}–${max} 之间的值。`,
        };
    }
    return { ok: true, ms: Math.min(Math.max(n, TIMEOUT_MIN_MS), max) };
}

/* ============================================================
 * 三、拒绝清单 / 允许清单（SH-33 / SH-34 / SH-36）
 * ============================================================ */

/** 名单规范化：去空白项；`none` 与空串都表示「未启用」（沿用旧语义，SH-47 ③） */
export function normalizeList(items: readonly string[]): string[] {
    return (items ?? [])
        .map((s) => String(s ?? "").trim())
        .filter((s) => s !== "" && s.toLowerCase() !== "none");
}

/** 空白归一 + 小写（拒绝清单匹配用；**不用于**授权记忆比较，见 AP-12） */
export function normalizeForDeny(text: string): string {
    return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 命令的首个 token（允许清单用；支持被引号包住的路径） */
export function firstToken(command: string): string {
    const t = String(command ?? "").trim();
    const m = t.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
    return (m ? (m[1] || m[2] || m[3] || "") : "").toLowerCase();
}

/**
 * 命中拒绝清单或未命中非空允许清单 → 返回原因（调用方据此 denied_by_policy，且**不弹窗**）。
 * 判定顺序：拒绝清单优先（SH-34 末句）。
 * ⚠️ 两者都是**启发式**：可通过变量展开、字符串拼接、别名、脚本文件、大小写与转义变体绕过（SH-36）。
 */
export function denialReason(command: string): string | null {
    const normalized = normalizeForDeny(command);

    for (const pattern of normalizeList(S.get<string[]>("deny_list"))) {
        const p = normalizeForDeny(pattern);
        if (p && normalized.includes(p)) {
            return (
                `命中拒绝清单（${pattern}）。` +
                "该命令被本地策略拦截，未创建进程；如确需执行，请让用户调整「拒绝清单」配置。"
            );
        }
    }

    const allow = normalizeList(S.get<string[]>("allow_list"));
    if (allow.length > 0) {
        const token = firstToken(command);
        const hit = allow.some((a) => a.toLowerCase() === token);
        if (!hit) {
            return (
                `未命中允许清单（命令首 token = "${token}"，允许清单已启用且只放行首 token 命中的命令）。` +
                "请改用清单内允许的程序，或让用户调整「允许清单」（留空表示不启用）。"
            );
        }
    }
    return null;
}

/* ============================================================
 * 四、子进程环境（SH-35）
 * ============================================================ */

/**
 * 内置放行键：只放行「运行命令所必需」的少量键。
 * PATH 是必需的（否则 git / node / curl 都找不到），它本身不含密钥。
 */
const BASE_ENV_KEYS = [
    "SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "PATH",
    "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG",
];

/** 密钥类键名（大小写不敏感）：命中即剔除，**对追加项同样生效**（SH-35） */
const SECRET_ENV_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export interface ChildEnvResult {
    env: Record<string, string>;
    /** 因命中密钥正则被剔除的键（只记键名，不记值） */
    dropped: string[];
}

/**
 * 显式构造子进程环境：**禁止**整体继承 process.env（那会带上 LLM_API_KEY）。
 * 支持 SHELL_EXTRA_ENV_KEYS 追加，但追加项同样要过密钥正则。
 */
export function buildChildEnv(): ChildEnvResult {
    const out: Record<string, string> = {};
    const dropped: string[] = [];
    const keys = [...BASE_ENV_KEYS, ...normalizeList(S.get<string[]>("extra_env_keys"))];

    for (const key of keys) {
        if (!key) continue;
        if (SECRET_ENV_KEY_RE.test(key)) {
            dropped.push(key);
            continue;
        }
        const v = Bun.env[key];
        if (typeof v === "string") out[key] = v;
    }
    return { env: out, dropped };
}

/* ============================================================
 * 五、敏感值掩码（SH-37）
 * ============================================================ */

/**
 * 需要掩码的字面值：已配置的密钥（精确匹配，不做通配）。
 * 长串优先替换，避免「短密钥是长密钥前缀」时残留片段。
 *
 * - 系统密钥 `LLM_API_KEY` 由平台自己取（系统项允许平台读）；
 * - 工具域的密钥**不在这里跨组读**（§7.3 组设置项仅本组可读），
 *   而是由取值层 `secretSettingValues()` 统一枚举所有声明了 `secret: true` 的项（R-25 / V-22）。
 */
export function secretLiterals(): string[] {
    const list = [String(env.LLM_API_KEY ?? ""), ...secretSettingValues()];
    return [...new Set(list.filter((s) => s !== ""))].sort((a, b) => b.length - a.length);
}

/** 把已配置的密钥字面值精确替换为 ****（回灌文本、日志、弹窗文本三处都必须过这一步） */
export function maskSecrets(text: string, literals: string[] = secretLiterals()): string {
    let out = String(text ?? "");
    for (const s of literals) {
        if (!s) continue;
        out = out.split(s).join("****");
    }
    return out;
}

/* ============================================================
 * 六、输出整形（SH-25 ~ SH-30）
 * ============================================================ */

/** ANSI 转义：CSI 序列 + OSC 序列（SH-27；只删控制序列，不删普通文本） */
const ANSI_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
    return String(text ?? "").replace(ANSI_RE, "");
}

/** 控制台代码页 → WHATWG 编码名（启动时可被 chcp 探测结果覆盖，见 _shell_exec.ts） */
export function codePageToEncoding(cp: number): string {
    switch (cp) {
        case 65001: return "utf-8";
        case 936: return "gbk";
        case 950: return "big5";
        case 932: return "shift_jis";
        case 949: return "euc-kr";
        case 1252: return "windows-1252";
        default: return "utf-8";
    }
}

/** 疑似二进制（SH-29）：含 NUL 直接判定；否则抽样前 8000 字节，控制字符占比 > 10% 判定 */
export function looksBinary(buf: Uint8Array): boolean {
    const n = Math.min(buf.length, 8000);
    if (n === 0) return false;
    let ctrl = 0;
    for (let i = 0; i < n; i++) {
        const b = buf[i]!;
        if (b === 0) return true;
        if (b < 9 || (b > 13 && b < 32) || b === 127) ctrl++;
    }
    return ctrl / n > 0.1;
}

export interface PackedStream {
    /** 已剥离 ANSI、已统一编码、已按字节上限截断的文本（二进制输出时为空串） */
    text: string;
    /** 原始字节数（SH-26 三要素之二；**不是** text 的字符数） */
    bytes: number;
    /** 本次实际回灌的字符数 */
    shownChars: number;
    truncated: boolean;
    /** 疑似二进制，未原样回灌（SH-29） */
    binary: boolean;
}

export interface PackedOutput {
    stdout: PackedStream;
    stderr: PackedStream;
    /** 解码时是否发生了「UTF-8 失败 → 回退控制台码页」（SH-28：须显式告知） */
    encodingFallback: boolean;
    /** 实际使用的编码名（供日志与正文说明） */
    encodingUsed: string;
}

/** 按「JSON 转义后长度」截断（与批次一同一口径，保证总长不超预算） */
function takeEscaped(text: string, budget: number): string {
    let acc = "";
    let used = 0;
    for (const ch of text) {
        const c = escapedChars(ch);
        if (acc !== "" && used + c > budget) break;
        acc += ch;
        used += c;
    }
    return acc;
}

function decode(bytes: Uint8Array, utf8Unify: boolean, fallbackEncoding: string): {
    text: string;
    encodingUsed: string;
    fallback: boolean;
} {
    if (utf8Unify) {
        try {
            return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encodingUsed: "utf-8", fallback: false };
        } catch {
            // 落到控制台码页解码，并标记 fallback（SH-28 后半句：必须显式告知）
        }
    }
    try {
        return { text: new TextDecoder(fallbackEncoding).decode(bytes), encodingUsed: fallbackEncoding, fallback: utf8Unify };
    } catch {
        return { text: new TextDecoder("utf-8").decode(bytes), encodingUsed: "utf-8", fallback: true };
    }
}

function packOne(bytes: Uint8Array, budget: number, utf8Unify: boolean, fallbackEncoding: string) {
    const binary = looksBinary(bytes);
    if (binary) {
        return {
            stream: { text: "", bytes: bytes.length, shownChars: 0, truncated: false, binary: true } as PackedStream,
            encodingUsed: fallbackEncoding,
            fallback: false,
        };
    }
    const dec = decode(bytes, utf8Unify, fallbackEncoding);
    const cleaned = stripAnsi(dec.text).replace(/\r\n/g, "\n");
    const shown = escapedChars(cleaned) > budget ? takeEscaped(cleaned, budget) : cleaned;
    return {
        stream: {
            text: shown,
            bytes: bytes.length,
            shownChars: shown.length,
            truncated: shown.length < cleaned.length,
            binary: false,
        } as PackedStream,
        encodingUsed: dec.encodingUsed,
        fallback: dec.fallback,
    };
}

/**
 * 把两个流整形进给定预算（SH-26 / SH-30）。
 * 分配策略：stdout : stderr = 7 : 3；一方用不完时把余量让给另一方。
 * 保证 `escapedChars(stdout.text) + escapedChars(stderr.text) ≤ budget`。
 */
export function packStreams(
    stdoutBytes: Uint8Array,
    stderrBytes: Uint8Array,
    budget: number,
    utf8Unify: boolean,
    fallbackEncoding: string,
): PackedOutput {
    const soBudget = Math.max(0, Math.floor(budget * 0.7));
    const seBudget = Math.max(0, budget - soBudget);

    const so = packOne(stdoutBytes, soBudget, utf8Unify, fallbackEncoding);
    const se = packOne(stderrBytes, seBudget, utf8Unify, fallbackEncoding);

    let used = escapedChars(so.stream.text) + escapedChars(se.stream.text);
    let left = Math.max(0, budget - used);

    // 让出余量：先把 stdout 补满，再补给 stderr
    if (left > 0 && so.stream.truncated) {
        const again = packOne(stdoutBytes, escapedChars(so.stream.text) + left, utf8Unify, fallbackEncoding);
        so.stream = again.stream;
        used = escapedChars(so.stream.text) + escapedChars(se.stream.text);
        left = Math.max(0, budget - used);
    }
    if (left > 0 && se.stream.truncated) {
        const again = packOne(stderrBytes, escapedChars(se.stream.text) + left, utf8Unify, fallbackEncoding);
        se.stream = again.stream;
    }

    return {
        stdout: so.stream,
        stderr: se.stream,
        encodingFallback: so.fallback || se.fallback,
        encodingUsed: so.encodingUsed !== "utf-8" ? so.encodingUsed : se.encodingUsed,
    };
}

/** SH-26 的三要素人话版（已显示 / 原始字节数 / 后续获取方式） */
export function truncationNote(streamName: "stdout" | "stderr", shownChars: number, totalBytes: number): string {
    return (
        `${streamName} 已显示前 ${shownChars} 字符；原始 ${totalBytes} 字节；` +
        "需要完整内容时，请把命令改为重定向到文件（如 `> out.txt 2>&1`），再用读文件工具分段读取。"
    );
}

/* ============================================================
 * 七、结构化日志（SH-45 / SH-37：命令只保留前 200 字符并掩码）
 * ============================================================ */

export interface RunLogInput {
    shell: string;
    cwd: string;
    command: string;
    exitCode: number | null;
    elapsedMs: number;
    outputBytes: number;
    errorCode: string | null;
    approvalScope: string;
}

/** 单行 JSON 日志：不含完整输出、不含密钥（SH-45） */
export function runLogLine(input: RunLogInput): string {
    return JSON.stringify({
        event: "shell_run",
        tool: "local.shell.run",
        shell: input.shell,
        cwd: input.cwd,
        // SH-37：命令原文只保留前 200 字符，且先掩码
        commandHead: maskSecrets(String(input.command ?? "").slice(0, 200)),
        exitCode: input.exitCode,
        elapsedMs: input.elapsedMs,
        outputBytes: input.outputBytes,
        errorCode: input.errorCode,
        approvalScope: input.approvalScope,
    });
}
