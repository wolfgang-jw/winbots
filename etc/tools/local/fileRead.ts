/**
 * etc/tools/local/fileRead.ts
 * 只读文件工具集（US-READ-1 ~ US-READ-4，需求四）
 *
 * 契约：导出 tools: Tool[]，调用名 local.fileRead.<name>
 * 安全：全部工具经 _shared.resolveInRoot() 白名单校验 + isReadEnabled() 门控
 *
 * 工具清单：
 *   - list_directory   列出目录（可选递归）      US-READ-1
 *   - get_path_info    查看路径属性              US-READ-1
 *   - read_file        读取文件（256KB 上限）    US-READ-2
 *   - search_files     通配符搜索文件路径        US-READ-3
 *   - search_in_files  关键字搜索文件内容        US-READ-4
 */
import type { Tool } from "@/tools";
import {
    resolveInRoot,
    assertRealPathInRoot,
    isReadEnabled,
    ok,
    fail,
    getFileRoot,          // [配置页 / US-CFG-PAGE-6] FILE_ROOT 常量 → 函数
} from "./_shared";
import { readdir, stat, readFile } from "fs/promises";
import { join, relative, sep } from "path";
// [批次一 / FR-21、FR-38、FR-39] 预算上限与默认行数：每次调用实时读取，禁止模块级缓存
import { env } from "@/infra/env";
// [批次一] 分段读取纯函数（不导出 tools，loadTools 会跳过 _ 前缀文件）
import {
    MAX_LINES_PER_CALL,
    buildEnvelope,
    contentBudget,
    countLines,
    lineStartOffset,
    nextStartAfter,
    readLogLine,
    splitLines,
    takeLines,
    type ReadEnvelope,
    type ReadEnvelopeHead,
} from "./_fileReadRange";

/** 结果数量上限（F4-8） */
const MAX_ENTRIES = 200;
/** 单次读取上限 256KB（F4-4） */
const MAX_READ_BYTES = 256 * 1024;
/** 递归列举默认深度上限（F4-2） */
const DEFAULT_MAX_DEPTH = 5;
/** 内容搜索：最大扫描文件数（F4-9） */
const MAX_SCAN_FILES = 500;
/** 内容搜索：单文件大小上限（F4-9） */
const MAX_SCAN_FILE_BYTES = 256 * 1024;

/** 将绝对路径转为「相对沙箱根」的展示路径（统一用 / 分隔） */
function toRel(abs: string): string {
    const r = relative(getFileRoot(), abs);
    return (r === "" ? "." : r).split(sep).join("/");
}

/** 判断是否为「二进制/非文本」内容（含 NUL 字节即视为二进制） */
function looksBinary(buf: Buffer): boolean {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) {
        if (buf[i] === 0) return true;
    }
    return false;
}

/** 是否为正整数（FR-30：非整数一律 ERR_BAD_RANGE，不做隐式数值转换） */
function isPositiveInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/** 回显用户传入的非法参数值（对象/字符串都能安全打印） */
function describeArg(v: unknown): string {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
}

/**
 * [FR-36] 读操作日志：每次成功返回打印一行结构化文本。
 * 只输出信封字段，**不含正文与任何文件内容片段**；不新增日志依赖。
 * 整文件模式也打印（用 mode 区分），便于把「降级」这件事看到眼里。
 */
function logRead(envelope: ReadEnvelope): void {
    console.log(readLogLine(envelope));
}

/**
 * 区间模式（含整文件降级）的唯一实现。
 *
 * ① 用「最大可能的行号位数」实测信封占用 → 内容预算（FR-20 / FR-21）；
 * ② 只解码从 startLine 起的一个窗口，不整文件解码（内存与 IO 不因分段而恶化，FR-48）；
 * ③ 按预算取完整行；单行自身超预算时退化为「前缀 + 说明」（FR-27）。
 */
function takeRange(
    buf: Buffer,
    startLine: number,
    maxLines: number,
    limit: number,
    fromFullFile: boolean,
    relPath: string,
    totalLines: number,
    size: number,
    mtime: string,
): ReadEnvelope {
    // ① 信封占用取上界：最后一次可能返回的行号不会超过 startLine + maxLines
    const maxReach = Math.min(totalLines, startLine + maxLines);
    const probe: ReadEnvelopeHead = {
        path: relPath,
        mode: "range",
        startLine,
        lastLineNum: maxReach,
        totalLines,
        partialLastLine: true,
        nextStartLine: Math.min(totalLines, maxReach + 1),
        truncated: true,
        size,
        mtime,
    };
    const budget = Math.max(1, contentBudget(limit, probe));

    // ② 窗口字节数 = 3 × 预算 + 1024：
    //    一个「转义后的字符」最多消耗 3 个源字节（3 字节 UTF-8 字符 → 1 字符），
    //    所以预算一定在窗口内被用尽，取到的每一行都是完整的；
    //    窗口末尾那段不完整的行必须剔除，否则会把半行当成完整行返回。
    const offset = lineStartOffset(buf, startLine);
    const windowEnd = Math.min(buf.length, offset + budget * 3 + 1024);
    const windowLines = splitLines(buf.subarray(offset, windowEnd).toString("utf-8"));
    // 窗口没到文件末尾时，最后一个元素必然是「被截断的半行」或「换行后的空串」，剔除
    if (windowEnd < buf.length && windowLines.length > 1) windowLines.pop();

    // ③ 取行
    const taken = takeLines(windowLines, maxLines, budget);
    const lastLineNum = taken.partialLine
        ? startLine + taken.linesTaken          // 前缀落在这一行
        : startLine + taken.linesTaken - 1;     // 完整返回的最后一行
    const nextStartLine = nextStartAfter(lastLineNum, totalLines, false);

    return buildEnvelope(
        {
            path: relPath,
            mode: "range",
            startLine,
            lastLineNum,
            totalLines,
            partialLastLine: taken.partialLine,
            nextStartLine,
            // 整文件降级时「所请求范围」是全文：只要没给全文就算截断（FR-12 / FR-24）
            truncated:
                taken.partialLine ||
                taken.stoppedByBudget ||
                (fromFullFile && nextStartLine !== null),
            size,
            mtime,
        },
        taken.content,
    );
}

/**
 * read_file 描述：必须同时讲清两个新参数、两种模式差别、续读字段用法与「分段读更费轮次」
 * （FR-04 / AC-FR-17）。
 * ⚠️ 不要在这里拼 env 的值（工具 schema 在模块加载时固化，拼了就永远不变，热更失效）。
 */
const READ_FILE_DESCRIPTION =
    "读取总操作目录下文本文件的内容，支持整文件与按行区间两种模式。" +
    "①整文件模式：只传 path，返回整个文件（单次上限 256KB，超出会截断 truncated=true；" +
    "若整文件序列化后超出结果长度预算，会自动降级为区间模式：mode=range、从第 1 行起返回完整行）。" +
    "②区间模式：传 startLine（行号，从 1 起）与可选 lineCount（行数；省略时取配置 " +
    "FILE_READ_DEFAULT_LINES，通常 2000；上限 50000），只返回该区间；" +
    "只给 lineCount 而没给 startLine 会返回 ERR_BAD_RANGE；区间越过末行时截到末行并返回成功。" +
    "续读字段用法：nextStartLine 就是下一次调用应传入的 startLine（已到文末为 null，调用方不要自己加一）；" +
    "lastLineNum 是本次返回的最后一行行号；totalLines 是文件总行数；" +
    "partialLastLine=true 表示 lastLineNum 这一行没有完整返回（该行剩余部分本工具无法返回，请改用其它方式获取）；" +
    "truncated=true 表示本次正文不是所请求范围的全部内容。" +
    "分段读会占用更多轮次（每一段都是一次工具调用），能用整文件读时不要分段；" +
    "已知行号、已知报错位置、或命令输出重定向到文件后的回看，才适合用 startLine 定向读取。" +
    "行号口径与 search_in_files 一致，可直接把搜索结果里的行号用作 startLine。";

export const tools: Tool[] = [
    {
        name: "list_directory",
        description:
            "列出总操作目录下指定目录的文件与子目录。可选递归列举。用于了解沙箱内有什么。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的目录路径，如 \"notes\" 或 \".\"" },
                recursive: { type: "boolean", description: "是否递归列出子目录，默认 false" },
                maxDepth: { type: "number", description: "递归深度上限，默认 5" },
            },
            required: ["path"],
        },
        handler: async (args) => {
            // ① 读开关门控（F4-10）
            if (!isReadEnabled()) {
                return fail("ERR_READ_DISABLED", "读操作已关闭（FILE_READ_ENABLED=false）");
            }
            // ② 路径白名单（F4-2）
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            const recursive = args.recursive === true;
            const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : DEFAULT_MAX_DEPTH;

            try {
                // ③ 目标必须存在且为目录
                const st = await stat(abs);
                if (!st.isDirectory()) {
                    return fail("ERR_NOT_DIRECTORY", `不是目录: ${toRel(abs)}`);
                }
                // 软链越界二次校验（可选加固）
                assertRealPathInRoot(abs);

                const entries: Array<{ name: string; type: string; size: number; mtime: string }> = [];
                let truncated = false;

                // 递归遍历（深度受限，F4-2）
                async function walk(dir: string, depth: number): Promise<void> {
                    if (truncated) return;
                    const items = await readdir(dir, { withFileTypes: true });
                    for (const it of items) {
                        if (entries.length >= MAX_ENTRIES) { truncated = true; return; }
                        const child = join(dir, it.name);
                        const cst = await stat(child);
                        entries.push({
                            name: toRel(child),
                            type: it.isDirectory() ? "directory" : "file",
                            size: it.isDirectory() ? 0 : cst.size,
                            mtime: cst.mtime.toISOString(),
                        });
                        if (recursive && it.isDirectory() && depth < maxDepth) {
                            await walk(child, depth + 1);
                        }
                    }
                }

                await walk(abs, 0);
                return ok({ entries, truncated });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") return fail("ERR_NOT_FOUND", `目录不存在: ${toRel(abs)}`);
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
    {
        name: "get_path_info",
        description: "查看总操作目录下某个文件或目录的属性：类型、大小、修改时间。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的文件或目录路径" },
            },
            required: ["path"],
        },
        handler: async (args) => {
            if (!isReadEnabled()) {
                return fail("ERR_READ_DISABLED", "读操作已关闭（FILE_READ_ENABLED=false）");
            }
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }
            try {
                const st = await stat(abs);
                // 软链越界二次校验（可选加固）
                assertRealPathInRoot(abs);

                return ok({
                    path: toRel(abs),
                    type: st.isDirectory() ? "directory" : "file",
                    size: st.isDirectory() ? 0 : st.size,
                    mtime: st.mtime.toISOString(),
                });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") return fail("ERR_NOT_FOUND", `路径不存在: ${toRel(abs)}`);
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
    {
        name: "read_file",
        description:
            READ_FILE_DESCRIPTION,   // [FR-04] 描述抽常量：两参数 + 两模式 + 续读字段 + 轮次成本
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的文件路径，如 \"notes/a.md\"" },
                // [批次一 / FR-02] 两个可选参数：给 startLine 才进入区间模式
                startLine: {
                    type: "integer",
                    minimum: 1,
                    description:
                        "起始行号（从 1 起）。省略则整文件模式；给出则只返回从该行开始的区间。" +
                        "可直接使用 search_in_files 返回的行号。",
                },
                lineCount: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAX_LINES_PER_CALL,
                    description:
                        "区间模式下最多返回的行数；省略则取配置 FILE_READ_DEFAULT_LINES（通常 2000），" +
                        "上限 50000。实际行数以返回的 lastLineNum 为准。",
                },
            },
            required: ["path"],
        },
        handler: async (args) => {
            // ① 读开关门控（F4-10）
            if (!isReadEnabled()) {
                return fail("ERR_READ_DISABLED", "读操作已关闭（FILE_READ_ENABLED=false）");
            }
            // ② 路径白名单
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            try {
                // ③ 模式判定与数值校验（FR-03 / FR-30）：不碰文件系统就能判定的先判掉
                const hasStart = args.startLine !== undefined && args.startLine !== null;
                const hasCount = args.lineCount !== undefined && args.lineCount !== null;
                if (!hasStart && hasCount) {
                    // FR-03 ④：只给 lineCount → ERR_BAD_RANGE
                    return fail(
                        "ERR_BAD_RANGE",
                        "只给了 lineCount 而没给 startLine：请补上起始行号 startLine（从 1 起），" +
                            "或只传 path 改用整文件模式。",
                    );
                }
                if (hasStart && !isPositiveInt(args.startLine)) {
                    return fail(
                        "ERR_BAD_RANGE",
                        `startLine 必须是 ≥1 的整数（收到 ${describeArg(args.startLine)}）：` +
                            "请把 startLine 改成 1 起的整数行号；也可只传 path 改用整文件模式。",
                    );
                }
                if (hasCount && !isPositiveInt(args.lineCount)) {
                    return fail(
                        "ERR_BAD_RANGE",
                        `lineCount 必须是 ≥1 的整数（收到 ${describeArg(args.lineCount)}）：` +
                            "请把 lineCount 改成正整数，或省略该参数使用默认行数。",
                    );
                }
                const rangeRequested = hasStart;
                // FR-22：lineCount 与配置默认值都受 50000 钳制；默认值每次调用实时读取（FR-39）
                const maxLines = hasCount
                    ? Math.min(args.lineCount as number, MAX_LINES_PER_CALL)
                    : Math.min(env.FILE_READ_DEFAULT_LINES, MAX_LINES_PER_CALL);

                // ④ 目标必须存在且为文件（F4-3 边界）
                const st = await stat(abs);
                if (st.isDirectory()) {
                    return fail("ERR_IS_DIRECTORY", `目标是目录而非文件: ${toRel(abs)}`);
                }
                // 软链越界二次校验（可选加固）
                assertRealPathInRoot(abs);

                // ⑤ 整文件读入（FR-48：不做流式与内存优化，区间模式只减少回灌字符数）
                const buf = await readFile(abs);
                // 信封基础字段：行数在完整字节上数（FR-19），大小/时间取 stat（FR-13 / FR-14）
                const totalLines = countLines(buf);
                const limit = env.TOOL_RESULT_MAX_CHARS;    // 每次调用实时读取（热更）
                const relPath = toRel(abs);
                const size = st.size;
                const mtime = st.mtime.toISOString();
                const truncated = buf.length > MAX_READ_BYTES;
                const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;

                // ⑥ 二进制判定：对**完整文件**开头 8000 字节判定一次（FR-34）；错误码与文案保持原样（FR-29）
                if (looksBinary(buf)) {
                    return fail("ERR_SIZE_EXCEEDED", `疑似二进制文件，拒绝读取: ${toRel(abs)}`);
                }

                // ⑦ 整文件模式：先按旧规则构造（256KB 字节上限），超字符预算再降级（FR-24）
                if (!rangeRequested) {
                    // 与旧版逐字符一致：仍是「先按字节切，再按 UTF-8 解码」（AC-FR-01）
                    const content = slice.toString("utf-8");
                    const lines = splitLines(content);
                    const endsWithNewline = content.endsWith("\n");

                    // 未截断时整文件都在，末行就是 totalLines（含结尾空行，FR-18）；
                    // 被 256KB 截断时只能按已返回的正文推算（FR-26 / FR-27）
                    const lastLineNum = truncated
                        ? (endsWithNewline ? Math.max(1, lines.length - 1) : lines.length)
                        : totalLines;
                    const partialLastLine = truncated && !endsWithNewline;

                    const full = buildEnvelope(
                        {
                            path: relPath,
                            mode: "full",
                            startLine: 1,                                   // FR-07
                            lastLineNum,
                            totalLines,
                            partialLastLine,
                            nextStartLine: truncated
                                ? nextStartAfter(lastLineNum, totalLines, partialLastLine)
                                : null,
                            truncated,
                            size,
                            mtime,
                        },
                        content,
                    );

                    // FR-20 / FR-24：长度自己算准，外层 capToolResult 永不触发
                    if (JSON.stringify(ok(full)).length <= limit) {
                        logRead(full);
                        return ok(full);
                    }
                    // 超预算 → 自动降级为区间模式：从第 1 行起返回完整行（FR-24 ②）
                    const degraded = takeRange(buf, 1, maxLines, limit, true, relPath, totalLines, size, mtime);
                    logRead(degraded);
                    return ok(degraded);
                }

                // ⑧ 区间模式
                const startLine = args.startLine as number;
                if (startLine > totalLines) {
                    // FR-30：超界必须报错，不能返回空区间（空串与空文件不可区分）
                    return fail(
                        "ERR_BAD_RANGE",
                        `startLine=${startLine} 超出文件末行（totalLines=${totalLines}）：` +
                            `请把 startLine 改到 1–${totalLines} 之间；如需读全文请只传 path 改用整文件模式。`,
                    );
                }
                const ranged = takeRange(buf, startLine, maxLines, limit, false, relPath, totalLines, size, mtime);
                logRead(ranged);
                return ok(ranged);
                /* [批次一] 下面这段旧实现（整文件直接返回）已由上面的 ⑦ / ⑧ 统一出口取代，保留注释仅为对照：
                    content: slice.toString("utf-8"),
                    truncated,
                    size: st.size,
                });
                */
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") return fail("ERR_NOT_FOUND", `文件不存在: ${toRel(abs)}`);
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
    {
        name: "search_files",
        description:
            "按通配符（如 *.ts、data_*.txt）在总操作目录下搜索文件路径。结果上限 200 条。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "搜索起始目录，默认沙箱根" },
                pattern: { type: "string", description: "通配符模式，如 *.ts / data_*.txt" },
            },
            required: ["pattern"],
        },
        handler: async (args) => {
            // ① 读开关门控（F4-10）
            if (!isReadEnabled()) {
                return fail("ERR_READ_DISABLED", "读操作已关闭（FILE_READ_ENABLED=false）");
            }
            // ② 路径白名单（起始目录，默认沙箱根）
            let base: string;
            try {
                base = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            const pattern = String(args.pattern ?? "").trim();
            if (!pattern) {
                return fail("ERR_IO", "缺少 pattern 参数");
            }
            // 可选加固：拒绝含 .. 的 pattern，防 glob 回溯越界
            if (pattern.split(/[\\/]/).includes("..")) {
                return fail("ERR_OUT_OF_ROOT", `pattern 不允许包含 ..: ${pattern}`);
            }

            try {
                const st = await stat(base);
                if (!st.isDirectory()) {
                    return fail("ERR_NOT_DIRECTORY", `搜索起始路径不是目录: ${toRel(base)}`);
                }
                assertRealPathInRoot(base);

                // ③ 用 Bun.Glob 在沙箱内匹配（F4-6）
                const glob = new Bun.Glob(pattern);
                const matches: string[] = [];
                let truncated = false;

                for await (const rel of glob.scan({ cwd: base, absolute: false, dot: false })) {
                    if (matches.length >= MAX_ENTRIES) { truncated = true; break; }
                    // 统一用 / 分隔，并拼上起始目录前缀
                    const norm = rel.split(sep).join("/");
                    matches.push(base === getFileRoot() ? norm : `${toRel(base)}/${norm}`);
                }

                return ok({ matches, truncated });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") return fail("ERR_NOT_FOUND", `目录不存在: ${toRel(base)}`);
                return fail("ERR_IO", `搜索失败: ${err.message}`);
            }
        },
    },
    {
        name: "search_in_files",
        description:
            "按关键字搜索总操作目录下文件内容，返回命中的文件与行号。受扫描文件数/单文件大小上限约束。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "搜索起始目录，默认沙箱根" },
                keyword: { type: "string", description: "要搜索的关键字" },
                maxFiles: { type: "number", description: "最大扫描文件数，默认 500" },
                maxFileSize: { type: "number", description: "单文件大小上限（字节），默认 256KB" },
            },
            required: ["keyword"],
        },
        handler: async (args) => {
            // ① 读开关门控（F4-10）
            if (!isReadEnabled()) {
                return fail("ERR_READ_DISABLED", "读操作已关闭（FILE_READ_ENABLED=false）");
            }
            // ② 路径白名单
            let base: string;
            try {
                base = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            const keyword = String(args.keyword ?? "");
            if (!keyword) {
                return fail("ERR_IO", "缺少 keyword 参数");
            }
            const maxFiles = typeof args.maxFiles === "number" ? args.maxFiles : MAX_SCAN_FILES;
            const maxFileSize =
                typeof args.maxFileSize === "number" ? args.maxFileSize : MAX_SCAN_FILE_BYTES;

            try {
                const st = await stat(base);
                if (!st.isDirectory()) {
                    return fail("ERR_NOT_DIRECTORY", `搜索起始路径不是目录: ${toRel(base)}`);
                }
                assertRealPathInRoot(base);

                const matches: Array<{ file: string; lines: number[] }> = [];
                let scannedFiles = 0;
                let truncated = false;

                // ③ 递归遍历（受 maxFiles 约束，F4-9）
                async function walk(dir: string): Promise<void> {
                    if (truncated) return;
                    const items = await readdir(dir, { withFileTypes: true });
                    for (const it of items) {
                        if (truncated) return;
                        const child = join(dir, it.name);
                        if (it.isDirectory()) {
                            // 跳过回收站等隐藏目录
                            if (it.name.startsWith(".")) continue;
                            await walk(child);
                            continue;
                        }
                        if (scannedFiles >= maxFiles) { truncated = true; return; }

                        // 单文件大小限制（F4-9）
                        const cst = await stat(child);
                        if (cst.size > maxFileSize) continue;
                        scannedFiles++;

                        const buf = await readFile(child);
                        if (looksBinary(buf)) continue; // 跳过二进制

                        const lines: number[] = [];
                        const text = buf.toString("utf-8");
                        const arr = text.split(/\r?\n/);
                        for (let i = 0; i < arr.length; i++) {
                            if (arr[i].includes(keyword)) lines.push(i + 1); // 行号 1 起
                        }
                        if (lines.length > 0) {
                            matches.push({ file: toRel(child), lines });
                            if (matches.length >= MAX_ENTRIES) { truncated = true; return; }
                        }
                    }
                }

                await walk(base);
                return ok({ matches, scannedFiles, truncated });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") return fail("ERR_NOT_FOUND", `目录不存在: ${toRel(base)}`);
                return fail("ERR_IO", `搜索失败: ${err.message}`);
            }
        },
    },
];
