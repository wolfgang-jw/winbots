/**
 * etc/tools/local/fileNew.ts
 * 新建文件工具集（US-NEW-1 ~ US-NEW-3，需求五）
 *
 * 契约：导出 tools: Tool[]，调用名 local.fileNew.<name>
 * 安全：全部工具经 _shared.resolveInRoot() 白名单校验 + isCreateEnabled() 门控
 * 语义：只负责「创建新内容」，绝不覆盖已有文件（覆盖归 fileModify.overwrite_file）
 *
 * 工具清单：
 *   - create_directory  创建文件夹（多级，已存在幂等成功）   US-NEW-1
 *   - create_file       创建新文件（已存在报错拒绝）         US-NEW-2
 *   - append_file       追加内容（文件不存在报错）           US-NEW-3
 */
import type { Tool } from "@/tools";
import {
    resolveInRoot,
    assertRealPathInRoot,
    isCreateEnabled,
    ok,
    fail,
    FILE_ROOT,
} from "./_shared";
import { mkdir, writeFile, appendFile, stat } from "fs/promises";
import { dirname, relative, sep } from "path";

/** 单次写入内容上限 1MB（建议加固项，防超大内容撑爆内存） */
const MAX_WRITE_BYTES = 1024 * 1024;

/** 将绝对路径转为「相对沙箱根」的展示路径（统一用 / 分隔） */
function toRel(abs: string): string {
    const r = relative(FILE_ROOT, abs);
    return (r === "" ? "." : r).split(sep).join("/");
}

export const tools: Tool[] = [
    {
        name: "create_directory",
        description:
            "在总操作目录下创建文件夹，支持递归创建多级目录。若目标目录已存在，视为成功（幂等）。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的目录路径，如 \"notes/2025\"" },
            },
            required: ["path"],
        },
        handler: async (args) => {
            // ① 新建开关门控（F5-5）
            if (!isCreateEnabled()) {
                return fail("ERR_CREATE_DISABLED", "新建操作已关闭（FILE_CREATE_ENABLED=false）");
            }
            // ② 路径白名单（F5-6）
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            try {
                // ③ 幂等判断（F5-1 + 决策 D4）：已存在且为目录 → 直接成功
                try {
                    const st = await stat(abs);
                    if (st.isDirectory()) {
                        assertRealPathInRoot(abs); // 软链越界二次校验
                        return ok({ path: toRel(abs), created: false });
                    }
                    // 已存在但是「文件」：与「创建目录」目标冲突，报错
                    return fail("ERR_ALREADY_EXISTS", `同名文件已存在，无法创建目录: ${toRel(abs)}`);
                } catch (e) {
                    // 仅「目标不存在」才继续创建；其余错误（EACCES 等）向上抛
                    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                }

                // ④ 递归创建（mkdir -p 语义，F5-1）：走到此处说明目标不存在
                await mkdir(abs, { recursive: true });
                return ok({ path: toRel(abs), created: true });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") {
                    return fail("ERR_NOT_FOUND", `父目录不存在: ${toRel(abs)}`);
                }
                if (err.code === "EEXIST") {
                    return fail("ERR_ALREADY_EXISTS", `目标已存在: ${toRel(abs)}`);
                }
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
    {
        name: "create_file",
        description:
            "在总操作目录下创建新文件并写入内容。若目标文件已存在则报错，绝不覆盖（覆盖请用修改类工具）。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的文件路径，如 \"notes/a.md\"" },
                content: { type: "string", description: "文件内容，默认空字符串" },
            },
            required: ["path"],
        },
        handler: async (args) => {
            // ① 新建开关门控（F5-5）
            if (!isCreateEnabled()) {
                return fail("ERR_CREATE_DISABLED", "新建操作已关闭（FILE_CREATE_ENABLED=false）");
            }
            // ② 路径白名单（F5-6）
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            const content = typeof args.content === "string" ? args.content : "";
            // ③ 写入大小上限（建议加固项，N7 精神）
            const bytes = Buffer.byteLength(content, "utf-8");
            if (bytes > MAX_WRITE_BYTES) {
                return fail("ERR_SIZE_EXCEEDED", `内容超过写入上限 ${MAX_WRITE_BYTES} 字节: ${bytes}`);
            }

            try {
                // ④ 拒绝覆盖（F5-3 + 决策 D2）：目标已存在即报错
                try {
                    await stat(abs);
                    return fail("ERR_ALREADY_EXISTS", `文件已存在，拒绝覆盖: ${toRel(abs)}`);
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                    // ENOENT：目标不存在，可安全创建
                }

                // ⑤ 父目录必须存在（F5-2 边界：要求先 create_directory）
                const parent = dirname(abs);
                try {
                    const pst = await stat(parent);
                    if (!pst.isDirectory()) {
                        // 父路径存在但不是目录（是文件）：无法在其下创建文件
                        return fail("ERR_NOT_FOUND", `父路径不是目录，无法创建文件: ${toRel(parent)}`);
                    }
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                        return fail("ERR_NOT_FOUND", `父目录不存在，请先创建: ${toRel(parent)}`);
                    }
                    throw e;
                }

                // ⑥ 写入（flag: "wx" 二次保证不覆盖，防 TOCTOU 竞态）
                await writeFile(abs, content, { encoding: "utf-8", flag: "wx" });
                return ok({ path: toRel(abs), bytes });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "EEXIST") {
                    return fail("ERR_ALREADY_EXISTS", `文件已存在，拒绝覆盖: ${toRel(abs)}`);
                }
                if (err.code === "ENOENT") {
                    return fail("ERR_NOT_FOUND", `父目录不存在: ${toRel(abs)}`);
                }
                if (err.code === "EISDIR") {
                    return fail("ERR_IS_DIRECTORY", `目标已存在且为目录: ${toRel(abs)}`);
                }
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
    {
        name: "append_file",
        description:
            "在总操作目录下已有文件的末尾追加内容，不改动原有内容。若文件不存在则报错（不隐式创建）。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的文件路径，如 \"notes/a.md\"" },
                content: { type: "string", description: "要追加的内容" },
            },
            required: ["path", "content"],
        },
        handler: async (args) => {
            // ① 新建开关门控（F5-5）
            if (!isCreateEnabled()) {
                return fail("ERR_CREATE_DISABLED", "新建操作已关闭（FILE_CREATE_ENABLED=false）");
            }
            // ② 路径白名单（F5-6）
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            const content = typeof args.content === "string" ? args.content : "";
            // ③ 追加内容大小上限（建议加固项）
            const bytes = Buffer.byteLength(content, "utf-8");
            if (bytes > MAX_WRITE_BYTES) {
                return fail("ERR_SIZE_EXCEEDED", `追加内容超过上限 ${MAX_WRITE_BYTES} 字节: ${bytes}`);
            }

            try {
                // ④ 文件必须已存在且为文件（F5-4 边界 + 决策 D5）
                const st = await stat(abs);
                if (st.isDirectory()) {
                    return fail("ERR_IS_DIRECTORY", `目标是目录而非文件: ${toRel(abs)}`);
                }
                assertRealPathInRoot(abs); // 软链越界二次校验

                // ⑤ 末尾追加（appendFile 默认追加，不改动已有内容）
                await appendFile(abs, content, { encoding: "utf-8" });
                return ok({ path: toRel(abs), bytes });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") {
                    return fail("ERR_NOT_FOUND", `文件不存在，无法追加（请先创建）: ${toRel(abs)}`);
                }
                if (err.code === "EISDIR") {
                    return fail("ERR_IS_DIRECTORY", `目标是目录而非文件: ${toRel(abs)}`);
                }
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
];
