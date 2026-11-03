/**
 * etc/tools/local/_shared.ts
 * 文件工具共享模块（US-CFG-1）
 *
 * 职责：
 * 1. 路径白名单守卫：resolveInRoot() —— 所有文件操作路径统一经此校验
 * 2. 目录函数：getFileRoot() / getTrashDir()（回收站，位于总操作目录内）
 * 3. 结果封装：ok() / fail()
 *
 * ⚠️ 本文件【不导出 tools】，因此不会被 src/tools/index.ts 注册为工具。
 *    它仅被 fileRead.ts / fileNew.ts / fileModify.ts 等工具文件 import。
 *
 * [规范 §8.4 / R-36] 旧的三个「启用开关」判定（读 FILE_READ_ENABLED /
 *   FILE_CREATE_ENABLED / FILE_MODIFY_ENABLED）已**彻底删除**，不是保留恒真：
 *   · 可用性由「祖先目录开 AND 组开关开 AND 未挂起」在 `src/tools/index.ts`
 *     统一判定（§8.3），并在每次 executeTool 前实时复查（§8.5）；
 *   · 旧开关在迁移时已从 .env 删除且不迁移（§9.2），代码里不再有读取方。
 *   因此各个 handler 里也**不应**再写「开关关闭就 return fail(...)」这类自检：
 *   平台侧已经拦过一道，工具侧再判一次只会出现两套口径。
 *
 * 契约见《文件工具接口契约.md》第二节。
 */
import { resolve, sep } from "path";
import { realpathSync } from "fs";
import { dirScope } from "@/infra/settings";

/**
 * [规范 §7.3] local 目录共享设置项作用域（目录项对本目录及所有子级可读）。
 * 私有模块不能用 groupSettings(import.meta)（它按「入口文件名」定位分组），故用显式形式。
 * ⚠️ 每次调用实时读，禁止模块级缓存 —— 否则「保存即生效」失效。
 */
const D = dirScope("local");

/** 项目根目录：<项目根>/etc/tools/local/ 上溯三级 */
const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

/**
 * [配置页 / US-CFG-PAGE-6] 沙箱总目录：<项目根>/<file_root_dir>
 *   由模块级常量改为函数——file_root_dir 需支持热更新（需求 §4.9.3）。
 *   ⚠️ 不要在模块顶层缓存调用结果，否则热更失效。
 */
export function getFileRoot(): string {
    return resolve(PROJECT_ROOT, D.get<string>("file_root_dir"));
}

/** 回收站目录：<沙箱总目录>/.trash（F3-8，位于总操作目录内） */
export function getTrashDir(): string {
    return resolve(getFileRoot(), ".trash");
}

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
    // 0. [配置页 / US-CFG-PAGE-6] 每次调用重新计算沙箱根（不缓存），使 file_root_dir 热更生效
    const fileRoot = getFileRoot();

    // 1. 归一化输入：空 / 未提供视为沙箱根
    const raw = (relPath ?? "").trim();
    const target = raw === "" || raw === "." ? fileRoot : resolve(fileRoot, raw);

    // 2. 白名单校验：解析后的绝对路径必须以 fileRoot + 分隔符 开头，
    //    或恰好等于 fileRoot 本身。
    //    注意：fileRoot 自身允许（如 list_directory 列根目录）。
    const rootWithSep = fileRoot.endsWith(sep) ? fileRoot : fileRoot + sep;
    if (target !== fileRoot && !target.startsWith(rootWithSep)) {
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
    // [配置页 / US-CFG-PAGE-6] 每次调用重新计算沙箱根（不缓存）
    const fileRoot = getFileRoot();
    let real: string;
    try {
        real = realpathSync(absPath);
    } catch {
        // 目标不存在：交给字面校验即可（新文件/新目录场景）
        return;
    }
    const rootWithSep = fileRoot.endsWith(sep) ? fileRoot : fileRoot + sep;
    if (real !== fileRoot && !real.startsWith(rootWithSep)) {
        throw new Error(`ERR_OUT_OF_ROOT: 软链越界，真实路径不在总操作目录内: ${absPath}`);
    }
}
