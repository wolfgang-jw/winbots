/**
 * etc/tools/local/_shared.ts
 * 文件工具共享模块（US-CFG-1）
 *
 * 职责：
 * 1. 路径白名单守卫：resolveInRoot() —— 所有文件操作路径统一经此校验
 * 2. 开关读取：isReadEnabled() / isCreateEnabled() / isModifyEnabled()
 * 3. 固定目录常量：TRASH_DIR（回收站，位于总操作目录内）
 * 4. 结果封装：ok() / fail()
 *
 * ⚠️ 本文件【不导出 tools】，因此不会被 src/tools/index.ts 注册为工具。
 *    它仅被 fileRead.ts / fileNew.ts / fileModify.ts 等工具文件 import。
 *
 * 契约见《文件工具接口契约.md》第二节。
 */
import { resolve, sep } from "path";
import { realpathSync } from "fs";
import { env } from "@/infra/env";

/** 项目根目录：<项目根>/etc/tools/local/ 上溯三级 */
const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

/** 沙箱总目录绝对路径：<项目根>/<FILE_ROOT_DIR>（默认 <项目根>/working） */
export const FILE_ROOT = resolve(PROJECT_ROOT, env.FILE_ROOT_DIR);

/** 回收站目录绝对路径：<沙箱总目录>/.trash（F3-8，位于总操作目录内） */
export const TRASH_DIR = resolve(FILE_ROOT, ".trash");

/** 统一成功结果 */
export function ok(data: unknown): { ok: true; data: unknown } {
    return { ok: true, data };
}

/** 统一失败结果 */
export function fail(code: string, message: string): { ok: false; error: { code: string; message: string } } {
    return { ok: false, error: { code, message } };
}

/**
 * 路径守卫（F3-1/F3-2）：
 * 将「相对沙箱的路径」解析为绝对路径，并校验其必须位于 FILE_ROOT 内。
 * 越界（../、绝对路径、软链越界）一律抛 ERR_OUT_OF_ROOT。
 *
 * @param relPath 相对沙箱总目录的路径（如 "notes/a.md"、"."）
 * @returns 位于沙箱内的绝对路径
 * @throws Error（message 前缀 ERR_OUT_OF_ROOT）
 */
export function resolveInRoot(relPath: string): string {
    // 1. 归一化输入：空 / 未提供视为沙箱根
    const raw = (relPath ?? "").trim();
    const target = raw === "" || raw === "." ? FILE_ROOT : resolve(FILE_ROOT, raw);

    // 2. 白名单校验：解析后的绝对路径必须以 FILE_ROOT + 分隔符 开头，
    //    或恰好等于 FILE_ROOT 本身。
    //    注意：FILE_ROOT 自身允许（如 list_directory 列根目录）。
    const rootWithSep = FILE_ROOT.endsWith(sep) ? FILE_ROOT : FILE_ROOT + sep;
    if (target !== FILE_ROOT && !target.startsWith(rootWithSep)) {
        throw new Error(
            `ERR_OUT_OF_ROOT: 路径越界，仅允许访问总操作目录内: ${relPath}`
        );
    }

    return target;
}

/**
 * 软链越界二次校验（可选增强）：
 * 对「已存在」的路径解析真实路径，确认仍在沙箱内。
 * 目标不存在时（如 create_file 的新文件）无需调用，由字面校验保证。
 */
export function assertRealPathInRoot(absPath: string): void {
    let real: string;
    try {
        real = realpathSync(absPath);
    } catch {
        // 目标不存在：交给字面校验即可（新文件/新目录场景）
        return;
    }
    const rootWithSep = FILE_ROOT.endsWith(sep) ? FILE_ROOT : FILE_ROOT + sep;
    if (real !== FILE_ROOT && !real.startsWith(rootWithSep)) {
        throw new Error(`ERR_OUT_OF_ROOT: 软链越界，真实路径不在总操作目录内: ${absPath}`);
    }
}

/** 读开关（F3-3）：默认开启 */
export function isReadEnabled(): boolean {
    return env.FILE_READ_ENABLED;
}

/** 新建开关（F3-4）：默认关闭 */
export function isCreateEnabled(): boolean {
    return env.FILE_CREATE_ENABLED;
}

/** 修改开关（F3-5，含删除）：默认关闭 */
export function isModifyEnabled(): boolean {
    return env.FILE_MODIFY_ENABLED;
}
