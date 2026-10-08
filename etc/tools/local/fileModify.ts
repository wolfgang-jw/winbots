/**
 * etc/tools/local/fileModify.ts
 * 修改文件工具集（US-MOD-1 ~ US-MOD-4，需求六）
 *
 * 契约：导出 tools: Tool[]，调用名 local.fileModify.<name>
 * 安全：全部工具经 _shared.resolveInRoot() 白名单校验 + isModifyEnabled() 门控
 * 语义：只负责「改动已有内容」；创建新内容归 fileNew.ts，读取归 fileRead.ts
 *
 * 工具清单：
 *   - overwrite_file   整篇覆盖（需 confirm）           US-MOD-1
 *   - replace_in_file  定点替换（唯一匹配/指定位置/删片段） US-MOD-2
 *   - move_path        移动 / 重命名（不覆盖）           US-MOD-3
 *   - delete_path      删除（需 confirm，移入回收站）     US-MOD-4
 */
import type { Tool } from "@/tools";
import {
    resolveInRoot,
    assertRealPathInRoot,
    isModifyEnabled,
    ok,
    fail,
    FILE_ROOT,
    TRASH_DIR,
} from "./_shared";
import { readFile, writeFile, stat, rename, mkdir, readdir } from "fs/promises";
import { dirname, relative, basename, join, sep } from "path";

/** 单次写入内容上限 1MB（与 fileNew.ts 对齐，防超大内容撑爆内存） */
const MAX_WRITE_BYTES = 1024 * 1024;

/** 将绝对路径转为「相对沙箱根」的展示路径（统一用 / 分隔） */
function toRel(abs: string): string {
    const r = relative(FILE_ROOT, abs);
    return (r === "" ? "." : r).split(sep).join("/");
}

/** 生成回收站对象名：<原名>_<YYYYMMDD-HHmmss>（F6-10 可追溯） */
function trashName(originalName: string): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const ts =
        `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${originalName}_${ts}`;
}

export const tools: Tool[] = [
    {
        name: "overwrite_file",
        description:
            "用新内容整体覆盖总操作目录下已存在的文件。必须显式确认（confirm: true）。" +
            "若目标不存在请改用新建类工具；本工具只覆盖、不创建。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的文件路径，如 \"notes/a.md\"" },
                content: { type: "string", description: "新的完整文件内容" },
                confirm: {
                    type: "boolean",
                    description: "覆盖确认，必须为 true，否则拒绝执行",
                },
            },
            required: ["path", "content", "confirm"],
        },
        handler: async (args) => {
            // ① 修改开关门控（F6-12）
            if (!isModifyEnabled()) {
                return fail("ERR_MODIFY_DISABLED", "修改操作已关闭（FILE_MODIFY_ENABLED=false）");
            }
            // ② 二次确认（F6-2）
            if (args.confirm !== true) {
                return fail("ERR_CONFIRM_REQUIRED", "覆盖操作需显式确认（confirm: true）");
            }
            // ③ 路径白名单
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            const content = typeof args.content === "string" ? args.content : "";
            const bytes = Buffer.byteLength(content, "utf-8");
            if (bytes > MAX_WRITE_BYTES) {
                return fail("ERR_SIZE_EXCEEDED", `内容超过写入上限 ${MAX_WRITE_BYTES} 字节: ${bytes}`);
            }

            try {
                // ④ 目标必须已存在且为文件（覆盖语义，F6-1）
                const st = await stat(abs);
                if (st.isDirectory()) {
                    return fail("ERR_IS_DIRECTORY", `目标是目录而非文件: ${toRel(abs)}`);
                }
                assertRealPathInRoot(abs); // 软链越界二次校验

                // ⑤ 整篇覆盖（writeFile 默认截断重写）
                await writeFile(abs, content, { encoding: "utf-8" });
                return ok({ path: toRel(abs), bytes });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") {
                    return fail("ERR_NOT_FOUND", `文件不存在，无法覆盖（请先创建）: ${toRel(abs)}`);
                }
                if (err.code === "EISDIR") {
                    return fail("ERR_IS_DIRECTORY", `目标是目录而非文件: ${toRel(abs)}`);
                }
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
    {
        name: "replace_in_file",
        description:
            "在总操作目录下的文件中，按「原文片段 → 新片段」定点替换内容。" +
            "默认要求原文片段唯一匹配（命中数必须为 1）；" +
            "若原文多次出现，可用 occurrence 指定改第几处（1 起，支持数组多处）。" +
            "newText 传空字符串即删除该片段。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的文件路径，如 \"notes/a.md\"" },
                oldText: { type: "string", description: "待替换的原文片段（非空）" },
                newText: { type: "string", description: "替换后的新片段；为空字符串即删除该片段" },
                occurrence: {
                    description: "指定替换第几处（1 起）；可传数字或数字数组。缺省时要求唯一匹配。",
                    oneOf: [
                        { type: "number" },
                        { type: "array", items: { type: "number" } },
                    ],
                },
            },
            required: ["path", "oldText", "newText"],
        },
        handler: async (args) => {
            // ① 修改开关门控（F6-12）
            if (!isModifyEnabled()) {
                return fail("ERR_MODIFY_DISABLED", "修改操作已关闭（FILE_MODIFY_ENABLED=false）");
            }
            // ② 路径白名单
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            const oldText = typeof args.oldText === "string" ? args.oldText : "";
            const newText = typeof args.newText === "string" ? args.newText : "";
            // 原文片段必须非空，否则匹配无意义
            if (oldText === "") {
                return fail("ERR_MATCH_COUNT", "oldText 不能为空");
            }

            try {
                // ③ 目标必须存在且为文件
                const st = await stat(abs);
                if (st.isDirectory()) {
                    return fail("ERR_IS_DIRECTORY", `目标是目录而非文件: ${toRel(abs)}`);
                }
                assertRealPathInRoot(abs);

                const original = await readFile(abs, "utf-8");

                // ④ 计算所有出现位置（字符索引，1 起计数）
                const positions: number[] = [];
                let from = 0;
                while (true) {
                    const idx = original.indexOf(oldText, from);
                    if (idx === -1) break;
                    positions.push(idx);
                    from = idx + oldText.length;
                }

                if (positions.length === 0) {
                    return fail("ERR_MATCH_COUNT", `原文片段未找到: ${toRel(abs)}`);
                }

                // ⑤ 解析 occurrence（可选）：number 或 number[]
                const occRaw = args.occurrence;
                let occList: number[] | null = null;
                if (typeof occRaw === "number") {
                    occList = [occRaw];
                } else if (Array.isArray(occRaw)) {
                    occList = occRaw.filter((n) => typeof n === "number") as number[];
                }

                // ⑥ 确定要替换的索引集合
                let targets: number[];
                if (occList === null) {
                    // 默认唯一匹配（F6-4）：命中数必须为 1
                    if (positions.length !== 1) {
                        return fail(
                            "ERR_MATCH_COUNT",
                            `原文片段出现 ${positions.length} 次，未指定 occurrence，拒绝替换（需唯一匹配）: ${toRel(abs)}`
                        );
                    }
                    targets = [0];
                } else {
                    // 指定位置（F6-5）：校验序号范围（1 起）
                    if (occList.length === 0) {
                        return fail("ERR_MATCH_COUNT", "occurrence 不能为空数组");
                    }
                    for (const n of occList) {
                        if (!Number.isInteger(n) || n < 1 || n > positions.length) {
                            return fail(
                                "ERR_MATCH_COUNT",
                                `occurrence 超出范围（1~${positions.length}）: ${n}`
                            );
                        }
                    }
                    // 去重并转 0 起索引
                    targets = [...new Set(occList)].map((n) => n - 1).sort((a, b) => a - b);
                }

                // ⑦ 从后往前替换，避免索引位移
                let result = original;
                for (let i = targets.length - 1; i >= 0; i--) {
                    const pos = positions[targets[i]!]!;
                    result = result.slice(0, pos) + newText + result.slice(pos + oldText.length);
                }

                // ⑧ 写回（newText 为空即删除片段，F6-6）
                await writeFile(abs, result, { encoding: "utf-8" });
                return ok({ path: toRel(abs), replaced: targets.length });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") {
                    return fail("ERR_NOT_FOUND", `文件不存在: ${toRel(abs)}`);
                }
                if (err.code === "EISDIR") {
                    return fail("ERR_IS_DIRECTORY", `目标是目录而非文件: ${toRel(abs)}`);
                }
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
    {
        name: "move_path",
        description:
            "在总操作目录内移动或重命名文件/目录。源与目标都必须位于总操作目录内。" +
            "若目标已存在则拒绝（不覆盖），以保证不丢数据。",
        parameters: {
            type: "object",
            properties: {
                from: { type: "string", description: "源路径（相对沙箱），如 \"notes/a.md\"" },
                to: { type: "string", description: "目标路径（相对沙箱），如 \"archive/a.md\"" },
            },
            required: ["from", "to"],
        },
        handler: async (args) => {
            // ① 修改开关门控（F6-12）
            if (!isModifyEnabled()) {
                return fail("ERR_MODIFY_DISABLED", "修改操作已关闭（FILE_MODIFY_ENABLED=false）");
            }
            // ② 源与目标均需通过路径白名单（F6-7 边界）
            let fromAbs: string;
            let toAbs: string;
            try {
                fromAbs = resolveInRoot(String(args.from ?? ""));
                toAbs = resolveInRoot(String(args.to ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }

            // ③ 源不能是沙箱根本身（避免把整个沙箱移走）
            if (fromAbs === FILE_ROOT) {
                return fail("ERR_OUT_OF_ROOT", "不允许移动总操作目录本身");
            }

            try {
                // ④ 源必须存在
                const st = await stat(fromAbs);
                assertRealPathInRoot(fromAbs); // 软链越界二次校验

                // ⑤ 目标不得已存在（F6-7 边界：拒绝覆盖）
                let toExists = true;
                try {
                    await stat(toAbs);
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code === "ENOENT") toExists = false;
                    else throw e;
                }
                if (toExists) {
                    return fail("ERR_ALREADY_EXISTS", `目标已存在，拒绝覆盖: ${toRel(toAbs)}`);
                }

                // ⑥ 目标父目录必须存在（不隐式创建，保持职责单一）
                const parent = dirname(toAbs);
                try {
                    const pst = await stat(parent);
                    if (!pst.isDirectory()) {
                        return fail("ERR_NOT_FOUND", `目标父路径不是目录: ${toRel(parent)}`);
                    }
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                        return fail("ERR_NOT_FOUND", `目标父目录不存在，请先创建: ${toRel(parent)}`);
                    }
                    throw e;
                }

                // ⑦ 执行移动/重命名（同一文件系统内 rename 原子生效）
                await rename(fromAbs, toAbs);
                return ok({ from: toRel(fromAbs), to: toRel(toAbs) });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") {
                    return fail("ERR_NOT_FOUND", `源路径不存在: ${toRel(fromAbs)}`);
                }
                if (err.code === "EEXIST" || err.code === "ENOTEMPTY") {
                    return fail("ERR_ALREADY_EXISTS", `目标已存在，拒绝覆盖: ${toRel(toAbs)}`);
                }
                if (err.code === "EXDEV") {
                    return fail("ERR_IO", `跨设备移动不支持（请确保源与目标在同一文件系统）`);
                }
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
    {
        name: "delete_path",
        description:
            "删除总操作目录下的文件或目录。删除不会物理销毁，而是移入回收站 .trash（带时间戳，可追溯）。" +
            "必须显式确认（confirm: true）。删除目录需 recursive: true 且同样需要确认；" +
            "默认不递归，删除非空目录会被拒绝。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对沙箱的文件或目录路径，如 \"notes/a.md\"" },
                confirm: {
                    type: "boolean",
                    description: "删除确认，必须为 true，否则拒绝执行",
                },
                recursive: {
                    type: "boolean",
                    description: "是否递归删除目录，默认 false；删除目录时必须为 true",
                },
            },
            required: ["path", "confirm"],
        },
        handler: async (args) => {
            // ① 修改开关门控（F6-12 / F6-13：复用修改开关，无独立删除开关）
            if (!isModifyEnabled()) {
                return fail("ERR_MODIFY_DISABLED", "修改操作已关闭（FILE_MODIFY_ENABLED=false）");
            }
            // ② 二次确认（F6-9）
            if (args.confirm !== true) {
                return fail("ERR_CONFIRM_REQUIRED", "删除操作需显式确认（confirm: true）");
            }
            // ③ 路径白名单
            let abs: string;
            try {
                abs = resolveInRoot(String(args.path ?? ""));
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }
            // ④ 禁止删除沙箱根与回收站本身
            if (abs === FILE_ROOT) {
                return fail("ERR_OUT_OF_ROOT", "不允许删除总操作目录本身");
            }
            if (abs === TRASH_DIR || abs.startsWith(TRASH_DIR + sep)) {
                return fail("ERR_OUT_OF_ROOT", "不允许操作回收站目录");
            }

            const recursive = args.recursive === true;

            try {
                // ⑤ 目标必须存在
                const st = await stat(abs);
                assertRealPathInRoot(abs); // 软链越界二次校验

                // ⑥ 目录删除：默认不递归（F6-11）
                if (st.isDirectory()) {
                    if (!recursive) {
                        // 非空目录且未递归 → 拒绝；空目录允许（等价于删除空目录）
                        const items = await readdir(abs);
                        if (items.length > 0) {
                            return fail(
                                "ERR_IS_DIRECTORY",
                                `目录非空，需 recursive: true 才能删除: ${toRel(abs)}`
                            );
                        }
                    }
                }

                // ⑦ 确保回收站存在（位于总操作目录内，F6-10）
                await mkdir(TRASH_DIR, { recursive: true });

                // ⑧ 生成回收站目标名（带时间戳，F6-10 可追溯）
                let dest = join(TRASH_DIR, trashName(basename(abs)));
                // 同一秒内同名冲突兜底：追加 -1 / -2 ...
                let n = 1;
                while (true) {
                    try {
                        await stat(dest);
                        dest = join(TRASH_DIR, `${trashName(basename(abs))}-${n++}`);
                    } catch (e) {
                        if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
                        throw e;
                    }
                }

                // ⑨ 移入回收站（rename 原子迁移，非物理删除）
                await rename(abs, dest);
                return ok({ path: toRel(abs), trashed: toRel(dest) });
            } catch (e) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === "ENOENT") {
                    return fail("ERR_NOT_FOUND", `路径不存在: ${toRel(abs)}`);
                }
                if (err.code === "ENOTEMPTY") {
                    return fail("ERR_IS_DIRECTORY", `目录非空，需 recursive: true: ${toRel(abs)}`);
                }
                if (err.code === "EXDEV") {
                    return fail("ERR_IO", "跨设备移动不支持（回收站需与目标同文件系统）");
                }
                return fail("ERR_IO", `文件系统错误: ${err.message}`);
            }
        },
    },
];
