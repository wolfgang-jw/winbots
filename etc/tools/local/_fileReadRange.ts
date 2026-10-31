/**
 * etc/tools/local/_fileReadRange.ts
 * read_file 分段读取的纯函数集合（批次一 / 需求域 F，FR-05 ~ FR-28）
 *
 * ⚠️ 本文件【不导出 tools】，不会被 src/tools/index.ts 注册为工具；
 *    文件名以 _ 开头，loadTools 会直接跳过（不刷「未导出 tools 数组」告警）。
 *
 * 只放纯计算：行数统计、行号→字节偏移、字符预算、行选取、返回体装配、日志文本。
 * 不读文件、不打印日志，便于单测（AC-FR-05 / AC-FR-11 / AC-FR-12 …）。
 */

/** 单次调用允许返回的最大行数（FR-22：lineCount 与配置默认值都受此值钳制） */
export const MAX_LINES_PER_CALL = 50000;

/** 字符预算里给信封字段留的安全余量（FR-21，要求「建议 512 字符」） */
export const ENVELOPE_RESERVE_CHARS = 512;

/** FR-27：单行自身超过整个预算时的说明文案（与行前缀一起放进 content） */
export const PARTIAL_LINE_NOTE =
    "\n…[本行剩余部分超过单次结果上限，本工具无法返回：请改用其它方式获取该行剩余内容]";

export type ReadMode = "full" | "range";

/** FR-05：固定 10 个信封字段 + content；键序即 FR-06 要求的顺序 */
export interface ReadEnvelope {
    path: string;
    mode: ReadMode;
    startLine: number;
    lastLineNum: number;
    totalLines: number;
    partialLastLine: boolean;
    nextStartLine: number | null;
    truncated: boolean;
    size: number;
    mtime: string;
    content: string;
}

/** 不含正文的信封头（预算测量、日志都用它） */
export type ReadEnvelopeHead = Omit<ReadEnvelope, "content">;

/** 一个字符串在 JSON 文本里占的字符数（不含首尾引号）—— 精确计入转义膨胀（FR-21） */
export function escapedChars(s: string): number {
    return JSON.stringify(s).length - 2;
}

/** 按 \n 切行：与 search_in_files 同一口径（\r\n 等价 \n，孤立 \r 不算换行，FR-15 / FR-16） */
export function splitLines(text: string): string[] {
    return text.split(/\r?\n/);
}

/**
 * 文件总行数：统计 0x0A 字节数 + 1（FR-09 / FR-17 / FR-18）。
 *
 * 直接在完整字节上数、不解码全文：0x0A 不可能出现在 UTF-8 多字节序列里，
 * 因此结果与 search_in_files 的 lines[] 口径逐项相等（FR-19），且与
 * `text.split(/\r?\n/).length` 恒等（有 k 个 \n 就有 k+1 段）。
 * 空文件 → 1（FR-17）；以换行结尾 → 多算一行（FR-18）。
 */
export function countLines(buf: Uint8Array): number {
    let n = 1;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) n++;
    }
    return n;
}

/** 第 lineNo 行（1 起）的起始字节偏移；超出末行时返回 buf.length */
export function lineStartOffset(buf: Uint8Array, lineNo: number): number {
    if (lineNo <= 1) return 0;
    let current = 1;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
            current++;
            if (current === lineNo) return i + 1;
        }
    }
    return buf.length;
}

/**
 * 续读位置（FR-10 / FR-25 / FR-26 / FR-27 / FR-31）。
 *   repeatLastLine=true（整文件模式因 256KB 停在行中）→ 重读该行（FR-26）；
 *   已到文末 → null（FR-10）；
 *   其余 → 前进一行（FR-25 / FR-27：**不得**停在 lastLineNum，否则同参数同预算原地循环）。
 */
export function nextStartAfter(
    lastLineNum: number,
    totalLines: number,
    repeatLastLine: boolean,
): number | null {
    if (repeatLastLine) return lastLineNum;
    if (lastLineNum >= totalLines) return null;
    return lastLineNum + 1;
}

export interface TakeResult {
    content: string;
    /** 完整返回的行数（partialLine 为 true 时不含那半行） */
    linesTaken: number;
    /** 最后一行只返回了前缀（FR-27） */
    partialLine: boolean;
    /** 因字符预算停下（不是行数用满，也不是到文末）（FR-12） */
    stoppedByBudget: boolean;
}

/**
 * 从 lines[0] 开始最多取 maxLines 行，并保证 JSON 转义后总长 ≤ budget（FR-20 / FR-22 / FR-23）。
 * budget 连第一行都放不下时，退化为「该行前缀 + 说明文案」（FR-27），且此时 linesTaken=0。
 */
export function takeLines(lines: readonly string[], maxLines: number, budget: number): TakeResult {
    const kept: string[] = [];
    let used = 0;
    const end = Math.min(lines.length, maxLines);

    for (let i = 0; i < end; i++) {
        const line = lines[i] ?? "";
        // 行间分隔符 "\n" 序列化后占 2 个字符（FR-21）；第一行没有分隔符
        const cost = escapedChars(line) + (kept.length > 0 ? 2 : 0);
        if (used + cost > budget) {
            if (kept.length > 0) {
                return {
                    content: kept.join("\n"),
                    linesTaken: kept.length,
                    partialLine: false,
                    stoppedByBudget: true,
                };
            }
            // FR-27：单行自身超预算 → 只给前缀，并留出文案自身占用的预算
            const room = budget - escapedChars(PARTIAL_LINE_NOTE);
            return {
                content: takePrefix(line, room) + PARTIAL_LINE_NOTE,
                linesTaken: 0,
                partialLine: true,
                stoppedByBudget: true,
            };
        }
        kept.push(line);
        used += cost;
    }

    return {
        content: kept.join("\n"),
        linesTaken: kept.length,
        partialLine: false,
        stoppedByBudget: false,
    };
}

/** 按码点取前缀，使其 JSON 转义后不超过 budget；至少保留 1 个码点（FR-23） */
function takePrefix(line: string, budget: number): string {
    let acc = "";
    let used = 0;
    for (const ch of line) {
        const c = escapedChars(ch);
        if (acc !== "" && used + c > budget) break;
        acc += ch;
        used += c;
    }
    return acc;
}

/**
 * 组装返回体：键序即 FR-05 / FR-06 —— 十个信封字段全部排在 content 之前。
 * ⚠️ 不要调整这里的字段顺序，也不要在 content 之后追加字段：
 *    外层兜底截断从尾部切，排在 content 之后的字段在长结果里必然丢失。
 */
export function buildEnvelope(head: ReadEnvelopeHead, content: string): ReadEnvelope {
    return {
        path: head.path,
        mode: head.mode,
        startLine: head.startLine,
        lastLineNum: head.lastLineNum,
        totalLines: head.totalLines,
        partialLastLine: head.partialLastLine,
        nextStartLine: head.nextStartLine,
        truncated: head.truncated,
        size: head.size,
        mtime: head.mtime,
        content,
    };
}

/**
 * content 可用字符预算 = 上限 − 信封实测占用 − 预留（FR-20 / FR-21）。
 *
 * 信封占用用「最大可能的行号位数」实测（调用方传入的 head 应取上界值），
 * 因此实际结果长度一定 ≤ 上限，外层 capToolResult 永不触发。
 * 形状必须与 `_shared.ok()` 完全一致：{ ok: true, data }。
 */
export function contentBudget(limit: number, head: ReadEnvelopeHead): number {
    const overhead = JSON.stringify({ ok: true, data: buildEnvelope(head, "") }).length;
    return limit - overhead - ENVELOPE_RESERVE_CHARS;
}

/**
 * FR-36 结构化日志文本：单行 JSON，只含信封字段，**绝不含正文或任何文件内容片段**。
 * 返回字符串，由调用方 console.log —— 本模块不产生副作用。
 */
export function readLogLine(head: ReadEnvelopeHead): string {
    return JSON.stringify({
        event: "read_file",
        path: head.path,
        mode: head.mode,
        startLine: head.startLine,
        lastLineNum: head.lastLineNum,
        totalLines: head.totalLines,
        partialLastLine: head.partialLastLine,
        nextStartLine: head.nextStartLine,
        truncated: head.truncated,
        size: head.size,
    });
}
