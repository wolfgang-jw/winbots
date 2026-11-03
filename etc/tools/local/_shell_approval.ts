/**
 * etc/tools/local/_shell_approval.ts
 * 审批策略层（批次三 / AP-01 ~ AP-25、NB-21）
 *
 * ⚠️ 本文件【不导出 tools】（SH-04）。
 *
 * 职责：
 *   1. 告知块三段生成（目的 / 风险 / 边界）+ 版本号；缺任一段返回 null（AP-21）
 *   2. 授权记忆（会话级、内存、不落盘）与拒绝冷却（AP-12 ~ AP-17）
 *   3. 选项语义（5 个按钮 → 决定），以及「不产生记忆」的选项处理（AP-14）
 *   4. 审批结果 → 错误码 / 回灌文案（AP-16 / AP-18 / SH-42）
 * ⚠️ 不在此文件创建进程、不弹窗；弹窗由界面（approval.js）完成。
 */
import { groupScope } from "@/infra/settings";
import { maskSecrets, stripAnsi, type ShellPermission } from "./_shell_policy";

/** [规范 §7.3] 本文件服务 local/shell 组；每次实时取值，禁止模块级缓存（SH-46） */
const S = groupScope("local", "shell");

/** 告知块三段的生成版本号（AP-20 审计要求记录；改模板必须同时改这里） */
export const APPROVAL_NOTICE_VERSION = "ap-2026-10-31.1";

/* ============================================================
 * 一、告知块三段（AP-21 / AP-22）
 * ============================================================ */

export interface NoticeInput {
    intent: string;
    // ⚠️ 刻意**不接收** command：目的/风险/边界三段都不允许引用命令原文（AP-22），
    //    命令原文由调用方另外放进 payload.command（弹窗命令区用），与本处文案无关。
    cwd: string;
    timeoutMs: number;
    permission: ShellPermission;
    /** 是否命中会话授权记忆（此时不弹窗，仅用于日志/边界文案的事实位） */
    memoryHit: boolean;
    /** 是否疑似破坏性特征（AP-10：只追加一行警示，不影响是否弹窗） */
    destructive: boolean;
    /** 「本会话都允许 · 所有命令」选项是否提供（AP-15） */
    allowAllOption: boolean;
}

export interface ApprovalNotices {
    intent: string;
    risk: string;
    boundary: string;
    version: string;
    destructiveHint: boolean;
    allowAllOption: boolean;
}

/** 疑似破坏性特征（只用于弹窗追加警示，不参与拒绝判定，AP-10） */
const DESTRUCTIVE_HINTS = [
    "del", "rmdir", "rd ", "remove-item", "format", "git reset", "git clean",
    "git push", "npm publish", ">", ">>", "icacls", "takeown", "reg add", "reg delete",
];

export function looksDestructive(command: string): boolean {
    const c = command.toLowerCase();
    return DESTRUCTIVE_HINTS.some((h) => c.includes(h));
}

/**
 * 组装三段告知（AP-21）。
 *
 * 关键约束（AP-22）：
 *   · 目的段**只能**取自 intent（模型自述，未经核实）；
 *   · 风险段 / 边界段**禁止**取自任何模型可控内容 —— 只用固定模板 + 已确定事实；
 *   · 任一段为空 → 返回 null → 调用方返回 internal_error 且**不注册、不弹窗**。
 */
export function buildNotices(input: NoticeInput): ApprovalNotices | null {
    // ① 目的段：唯一来源是 intent；ANSI 剥离 + 密钥掩码（AP-22 末段）
    const intent = maskSecrets(stripAnsi(String(input.intent ?? ""))).trim();

    // ② 风险段：固定模板 + 已确定事实（档位 / cwd / 超时 / 破坏性特征）
    const risk = [
        "以服务进程权限在本机真实执行，可能修改或删除文件，且无法撤销。",
        `工作目录守卫只约束启动目录（当前为 ${input.cwd}）：命令内部仍可用 cd .. 或绝对路径访问沙箱外内容。`,
        "命令可发起任意网络请求，不经过任何域名或私有网段策略；批准即等于为该命令的一切后果背书。",
        `本次执行上限 ${input.timeoutMs}ms，输出超出上限会被截断；当前权限档位为 ${input.permission}。`,
        input.destructive
            ? "⚠️ 该命令命中疑似破坏性特征（删除 / 覆盖 / 提交 / 权限变更一类），请确认目标与影响范围。"
            : "",
    ].filter(Boolean).join("");

    // ③ 边界段：只描述「覆盖什么 / 不覆盖什么」（AP-21 ③）
    const boundary = [
        "本次批准只覆盖：这一条命令原文（与上方展示逐字符相同）、这一个绝对工作目录、这一次执行。",
        input.memoryHit
            ? "该命令已命中本会话的授权记忆，本次不再弹窗；授权记忆仅在本会话内有效，会话结束即失效。"
            : "不覆盖同一命令的后续再次调用（除非用户选择「本会话都允许」）、其它目录、其它命令、其它会话。",
        input.allowAllOption
            ? "「本会话都允许 · 所有命令」会在本会话内关闭审批，关闭后任意命令都会被直接执行且无法撤销。"
            : "",
        "本次批准不改动权限档位，也不构成对后续任何调用的许可。",
    ].filter(Boolean).join("");

    // 缺任一段即视为「告知不完整」（AP-21 / AC-SH-33 后半句）
    if (!intent || !risk || !boundary) return null;

    return {
        intent,
        risk,
        boundary,
        version: APPROVAL_NOTICE_VERSION,
        destructiveHint: !!input.destructive,
        allowAllOption: !!input.allowAllOption,
    };
}

/* ============================================================
 * 二、授权记忆（AP-12 / AP-13）与拒绝冷却（AP-17）
 * ============================================================ */

/** 全放开：sessionId 集合 */
const sessionAllowAll = new Set<string>();
/** 单条命令记忆：`sessionId \0 command \0 absCwd` */
const sessionCommandMemo = new Set<string>();
/** 拒绝冷却：同键 → 到期时间戳 */
const denyCooldown = new Map<string, number>();

/** 记忆键：会话 + 命令原文（逐字符）+ 绝对工作目录（AP-12） */
export function memoryKey(sessionId: string, command: string, absCwd: string): string {
    return `${sessionId}\u0000${command}\u0000${absCwd}`;
}

/** 是否命中授权记忆（记忆开关关闭时恒 false，SH-46 每次实时读） */
export function memoryHit(sessionId: string, command: string, absCwd: string): boolean {
    if (S.get<boolean>("session_memory_enabled") === false) return false;
    return sessionAllowAll.has(sessionId) || sessionCommandMemo.has(memoryKey(sessionId, command, absCwd));
}

/** 是否处于拒绝冷却期（60s 内原样重发不再弹窗，AP-17） */
export function inDenyCooldown(sessionId: string, command: string, absCwd: string): boolean {
    const key = memoryKey(sessionId, command, absCwd);
    const until = denyCooldown.get(key);
    if (until === undefined) return false;
    if (Date.now() >= until) {
        denyCooldown.delete(key);        // 惰性清理，避免无限增长
        return false;
    }
    return true;
}

/**
 * 记录一次决定（只对「允许」的两档 + 拒绝冷却有效）。
 * AP-14：「仅当次允许 · 所有命令」与「仅当次允许 · 仅当前命令」等价，**不产生记忆**。
 */
export function rememberDecision(
    sessionId: string,
    decision: { allow: boolean; scope: "once" | "session"; target: "command" | "all" },
    command: string,
    absCwd: string,
): void {
    if (!decision.allow) {
        const cooldownMs = Math.max(0, Number(S.get<number>("deny_cooldown_ms")) || 60000);
        denyCooldown.set(memoryKey(sessionId, command, absCwd), Date.now() + cooldownMs);
        return;
    }
    if (decision.scope !== "session") return;                       // AP-14：单次允许不留记忆
    if (S.get<boolean>("session_memory_enabled") === false) return;           // 关掉记忆 → 退化为逐次询问
    if (decision.target === "all") sessionAllowAll.add(sessionId);
    else sessionCommandMemo.add(memoryKey(sessionId, command, absCwd));
}

/** 清空某会话的全部记忆与冷却（会话结束 / 界面断连 / 服务重启时调用，AP-13） */
export function clearSessionMemory(sessionId: string): void {
    sessionAllowAll.delete(sessionId);
    const prefix = `${sessionId}\u0000`;
    for (const key of [...sessionCommandMemo]) if (key.startsWith(prefix)) sessionCommandMemo.delete(key);
    for (const key of [...denyCooldown.keys()]) if (key.startsWith(prefix)) denyCooldown.delete(key);
}

/* ============================================================
 * 三、决定 → 错误码 / 回灌文案（AP-16 / AP-18 / SH-42）
 * ============================================================ */

export type ApprovalOutcome =
    | "allowed"
    | "denied_by_user"
    | "approval_timeout"
    | "cancelled"
    | "approval_unavailable";

/** 把否定路径映射成**各自独立**的错误码（SH-41：不得合并成 permission_denied） */
export function outcomeToCode(outcome: ApprovalOutcome): string {
    switch (outcome) {
        case "denied_by_user": return "denied_by_user";
        case "approval_timeout": return "approval_timeout";
        case "cancelled": return "cancelled";
        case "approval_unavailable": return "approval_unavailable";
        default: return "";
    }
}

/** 否定路径的文案（每类都带下一步建议，SH-42） */
export function outcomeMessage(outcome: ApprovalOutcome, waitMs: number): string {
    switch (outcome) {
        case "denied_by_user":
            return (
                "用户拒绝了这次执行，命令未运行、未创建进程。" +
                "请改变命令（换一种做法或缩小范围）后重试，或请用户调整权限档位；" +
                "不要原样重发同一条命令（60 秒内会直接被拒且不再弹窗）。"
            );
        case "approval_timeout":
            return (
                `等待用户决定超时（${Math.round(waitMs / 1000)} 秒无人应答），命令未运行。` +
                "可重试一次；若持续超时说明用户不在屏幕前，建议改约时间或改用不需要授权的做法。"
            );
        case "cancelled":
            return "用户点了「停止」，本次审批已取消，命令未运行、未创建进程。如需继续请重新发起调用。";
        case "approval_unavailable":
            return (
                "没有可用的审批通道（界面未连接或连接已断开），按保守策略拒绝执行。" +
                "请先打开会话界面（确保命令来源会话处于打开状态）后再重试。"
            );
        default:
            return "";
    }
}

/** AP-18：批准后的回灌文案（说明覆盖范围 + 后续是否仍会询问；不含任何「授权凭证」字样） */
export function approvalGrantedNote(scope: {
    source: "popup" | "memory" | "permission_allow";
    scope: "once" | "session";
    target: "command" | "all";
}): string {
    if (scope.source === "permission_allow") {
        return "权限档位为「允许」：本次未请求人工确认（该档等于把本机命令行交给模型，不再有任何人工闸门）。";
    }
    if (scope.source === "memory") {
        return "本次执行命中本会话的授权记忆，未再次弹窗；命中范围仅限「完全相同的一条命令 + 同一个工作目录」，会话结束即失效。";
    }
    if (scope.scope === "session" && scope.target === "all") {
        return "用户已选择「本会话都允许 · 所有命令」：本会话内后续命令将不再询问（无法撤销，会话结束即失效）。";
    }
    if (scope.scope === "session") {
        return "用户已选择「本会话都允许 · 仅当前命令」：本会话内逐字符相同的同一条命令（同一工作目录）不再询问，其它命令仍会询问。";
    }
    return "用户已批准「仅当次」：本次执行完成后，后续调用仍会重新询问用户。";
}

/* ============================================================
 * 四、审批等待上限（C-13：平台模块不再读工具配置）
 * ============================================================ */

/**
 * 审批等待上限（毫秒）：实时读组设置项 `approval_wait_ms`（SH-46）。
 *
 * 为什么在本文件、而不是 `src/infra/approval.ts`（R-25）：
 *   §7.3 规定组设置项仅该组可读；平台模块读 `TOOLSET__local__shell__*` 属于跨组越权。
 *   现在平台侧只接收调用方传进来的 `waitMs`，配置的解析与默认值都留在本组。
 *
 * 为什么用 getSoft：本函数在「弹窗挂起」这段关键路径上被调用，
 *   组一旦因声明不合法被挂起，严格读会抛错 → 命令直接失败且没有可读原因；
 *   回落到改造前的默认值 120s 至少保持旧行为，并在日志里留一次性告警。
 */
export function approvalWaitMs(): number {
    return Math.max(1000, Number(S.getSoft<number>("approval_wait_ms", 120000)) || 120000);
}
