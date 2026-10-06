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
    FILE_ROOT,
} from "./_shared";
import { readdir, stat, readFile } from "fs/promises";
import { join, relative, sep } from "path";

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
    const r = relative(FILE_ROOT, abs);
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
            "读取总操作目录下文本文件的完整内容。单次读取上限 256KB，超限会截断并标记 truncated。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的文件路径，如 \"notes/a.md\"" },
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
                // ③ 目标必须存在且为文件（F4-3 边界）
                const st = await stat(abs);
                if (st.isDirectory()) {
                    return fail("ERR_IS_DIRECTORY", `目标是目录而非文件: ${toRel(abs)}`);
                }
                // 软链越界二次校验（可选加固）
                assertRealPathInRoot(abs);

                // ④ 读取（F4-4：超限截断，不抛异常）
                const buf = await readFile(abs);
                const truncated = buf.length > MAX_READ_BYTES;
                const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;

                // ⑤ 二进制检测（F4-3 边界：二进制返回可读错误）
                if (looksBinary(slice)) {
                    return fail("ERR_SIZE_EXCEEDED", `疑似二进制文件，拒绝读取: ${toRel(abs)}`);
                }

                return ok({
                    path: toRel(abs),
                    content: slice.toString("utf-8"),
                    truncated,
                    size: st.size,
                });
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
                    matches.push(base === FILE_ROOT ? norm : `${toRel(base)}/${norm}`);
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
