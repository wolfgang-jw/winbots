/**
 * etc/tools/examples/analysis/_pca_data.ts
 * PCA 的数据读写：路径守卫 / CSV·JSON 解析 / 结果落盘
 *
 * ⚠️ 本文件【不导出 tools】：`_` 前缀 → 扫描器不注册（§4.2）。
 * ⚠️ 只做 IO 与解析，不做统计计算（在 _pca_math.ts），不 console 业务日志（在 pca.ts）。
 */
import { resolve, sep, basename, extname, dirname, relative } from "path";
import { readFile, writeFile, stat, mkdir } from "fs/promises";
import { dirSettings } from "@/infra/settings";

/**
 * [规范 §7.3] 本目录设置项作用域（目录项对子树可读）。
 * ⚠️ 每次调用实时读，禁止模块级缓存 —— 否则「保存即生效」失效。
 *
 * ⚠️ 目录路径**必须由本文件位置自动推导**，不得手写字符串。
 *   目录设置项的键是 etc__tools__<目录路径>__<键名>，而 _settings.ts 的键由扫描器按
 *   「文件实际所在目录」算出。手写字符串要求「代码里的路径」与「文件在磁盘的位置」
 *   两份信息永远保持一致 —— 本目录曾从 tools/analysis/ 挪到 tools/examples/analysis/，
 *   代码没跟着改，于是 dirScope 算出 etc__tools__analysis__data_root_dir，
 *   与扫描器声明的 etc__tools__examples__analysis__data_root_dir 对不上，
 *   导致 pca 三个工具全部 ERR_UNDECLARED_SETTING。
 *
 *   改为按 import.meta.dir 反推相对 TOOLS_ROOT 的目录段后，文件挪到哪，键就跟着到哪。
 */
const D = dirSettings(import.meta);

/**
 * 数据根目录的基准：**进程启动时的工作目录**（process.cwd()），而非「项目根」。
 *
 * ⚠️ 这里刻意不再保留 PROJECT_ROOT 常量。历史上它被写成
 *   resolve(import.meta.dir, "../../..")（上溯三级），只在 etc/tools/local/ 这类
 *   「tools 下第一层」目录成立；本文件在 etc/tools/examples/analysis/（第二层），
 *   上溯三级只到 etc/tools，数据目录被算成 <项目根>/etc/tools/working。
 *   改成「由 TOOLS_ROOT 上溯若干级」仍是在数层级，目录一挪又会坏 —— 与本次
 *   dirScope 漏写 examples 是同一个病根（路径信息要维护两份，必然失配）。
 *
 *   因此 data_root_dir **明确定义为相对 process.cwd()**（与 LLM_LOG_FILE 等
 *   其它「相对启动工作目录」的配置项语义一致）。代码文件挪到哪都不影响数据目录，
 *   彻底摆脱层级计数。
 */

/** 统一成功结果（与 local/_shared.ts 同形状，避免跨目录依赖） */
export function ok(data: unknown): { ok: true; data: unknown } {
    return { ok: true, data };
}

/** 统一失败结果 */
export function fail(
    code: string,
    message: string,
): { ok: false; error: { code: string; message: string } } {
    return { ok: false, error: { code, message } };
}

/** 分析数据根目录：<启动工作目录>/<data_root_dir>（每次实时计算，支持热更） */
export function getDataRoot(): string {
    return resolve(process.cwd(), D.get<string>("data_root_dir"));
}

/**
 * 路径守卫（与 local/_shared.ts 的 resolveInRoot 同规则，但根目录是本目录的设置项）：
 * 相对路径解析为绝对路径，并校验必须位于 data_root_dir 内。
 *
 * @throws Error（message 前缀 ERR_OUT_OF_ROOT）
 */
export function resolveInDataRoot(relPath: string): string {
    const root = getDataRoot();
    const raw = (relPath ?? "").trim();
    const target = raw === "" || raw === "." ? root : resolve(root, raw);

    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (target !== root && !target.startsWith(rootWithSep)) {
        throw new Error(`ERR_OUT_OF_ROOT: 路径越界，仅允许访问数据目录内: ${relPath}`);
    }
    return target;
}

/** 绝对路径 → 相对数据根目录的展示路径（统一 / 分隔） */
export function toRel(abs: string): string {
    const r = relative(getDataRoot(), abs);
    return (r === "" ? "." : r).split(sep).join("/");
}

/** 解析后的数据集 */
export interface Dataset {
    /** 特征名（列名） */
    features: string[];
    /** 数值矩阵；缺失记为 NaN */
    rows: number[][];
    /** 原始记录行数（不含表头） */
    rawRows: number;
    /** 格式：csv / json */
    format: "csv" | "json";
}

/** 数据集读取结果 */
export type LoadResult =
    | { ok: true; data: Dataset }
    | { ok: false; code: string; message: string };

/** 把单元格文本转成数值；空串 / 非数值 → NaN（视为缺失） */
function toNum(text: string): number {
    const t = text.trim();
    if (t === "") return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * CSV 解析（RFC 4180 风格的最小实现）：
 *   · 支持双引号包裹、字段内逗号、`""` 转义、字段内换行；
 *   · 支持 , / ; / \t 三种分隔符（自动识别表头里出现最多的那个）；
 *   · 表头首列若为空或形如 index/id/序号，则当作行索引并剔除（不计入特征）。
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
    // ① 先整体切记录（考虑引号内的换行）
    const records: string[][] = [];
    let field = "";
    let record: string[] = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i] ?? "";
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
        } else if (ch === "," || ch === ";" || ch === "\t") {
            record.push(field);
            field = "";
        } else if (ch === "\n") {
            record.push(field);
            records.push(record);
            record = [];
            field = "";
        } else if (ch === "\r") {
            // 交给 \n 处理
        } else {
            field += ch;
        }
    }
    if (field !== "" || record.length > 0) {
        record.push(field);
        records.push(record);
    }

    // ② 去掉完全空白的行
    const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
    const head = nonEmpty[0];
    if (!head) return { header: [], rows: [] };

    // ③ 首行作表头
    const header = head.map((h) => h.trim());
    const rows = nonEmpty.slice(1);
    return { header, rows };
}

/**
 * 表头首列是否是行索引（不计入特征）。
 *
 * ⚠️ 这里必须保守：整数列常常是**真正的特征**（如 x=1,2,3,4,5），
 * 早期版本用「全为互不相同的整数」判断，会把这类特征列误删，
 * 导致 x,y 两列的数据被当成「只有 1 个特征列」。
 *
 * 因此只在两种情形下判定为索引列：
 *   ① 列名本身有索引语义（index/id/序号/unnamed…），直接剔除；
 *   ② 列名像行号（row / row_id / 行号 / 记录号）**且**值恰为 1..n 连续序列。
 * 仅凭「值是整数」绝不剔除 —— 那是合法特征。
 */
function looksLikeIndexColumn(name: string, values: string[]): boolean {
    const n = name.trim().toLowerCase();
    if (n === "" || n === "index" || n === "id" || n === "no" || n === "序号" || n === "编号") return true;
    if (n.startsWith("unnamed")) return true;

    // ② 值形如 1..n 连续序列 **且列名是空的/像行号** 才认作行号；
    //    仅凭「连续整数」不足以判定 —— x=1,2,3 是合法特征。
    if (values.length > 2 && /^(row|row_?id|行号|记录号)$/.test(n)) {
        let consecutive = true;
        for (let i = 0; i < values.length; i++) {
            const v = values[i]?.trim() ?? "";
            if (!/^\d+$/.test(v) || Number(v) !== i + 1) {
                consecutive = false;
                break;
            }
        }
        if (consecutive) return true;
    }
    return false;
}

/** 读 CSV 数据集 */
export function datasetFromCsv(text: string): LoadResult {
    const { header, rows } = parseCsv(text);
    if (header.length === 0) {
        return { ok: false, code: "ERR_EMPTY_DATA", message: "文件内容为空或无法解析出任何记录行。" };
    }

    let colStart = 0;
    if (rows.length > 0 && looksLikeIndexColumn(header[0] ?? "", rows.map((r) => r[0] ?? ""))) {
        colStart = 1;
    }

    const features = header.slice(colStart).map((h, i) => h || `f${i + 1}`);
    if (features.length === 0) {
        return { ok: false, code: "ERR_NO_FEATURES", message: "除行索引外没有可用的数值列，无法做 PCA。" };
    }

    const matrix: number[][] = [];
    for (const r of rows) {
        const row: number[] = [];
        for (let j = colStart; j < colStart + features.length; j++) row.push(toNum(r[j] ?? ""));
        matrix.push(row);
    }
    return { ok: true, data: { features, rows: matrix, rawRows: rows.length, format: "csv" } };
}

/** 读 JSON 数据集：数组对象 / 数组数组（首行为表头）/ { features, rows } 三种形状 */
export function datasetFromJson(text: string): LoadResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { ok: false, code: "ERR_BAD_FORMAT", message: `JSON 解析失败：${(e as Error).message}` };
    }

    // 形状 C：{ features: [...], rows: [[...], ...] }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as { features?: unknown; rows?: unknown };
        if (Array.isArray(obj.features) && Array.isArray(obj.rows)) {
            const features = (obj.features as unknown[]).map((f, i) => String(f ?? `f${i + 1}`));
            const rows = (obj.rows as unknown[]).map((r) =>
                Array.isArray(r) ? r.map((x) => (typeof x === "number" ? x : toNum(String(x ?? "")))) : [],
            );
            return finishJson(features, rows);
        }
        return {
            ok: false,
            code: "ERR_BAD_FORMAT",
            message: "JSON 对象形态只支持 { features: [...], rows: [[...]] }；请改成数组对象或数组数组。",
        };
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
        return { ok: false, code: "ERR_EMPTY_DATA", message: "JSON 内容为空或不是数组。" };
    }

    // 形状 A：数组对象 [{a:1,b:2}, ...] —— 取所有对象键的并集（按首次出现顺序）
    const firstItem: unknown = parsed[0];
    if (typeof firstItem === "object" && firstItem !== null && !Array.isArray(firstItem)) {
        const objs = parsed as Array<Record<string, unknown>>;
        const features: string[] = [];
        for (const o of objs) {
            for (const k of Object.keys(o)) if (!features.includes(k)) features.push(k);
        }
        if (features.length === 0) {
            return { ok: false, code: "ERR_NO_FEATURES", message: "数组对象里没有任何字段。" };
        }
        const rows = objs.map((o) =>
            features.map((k) => {
                const v = o[k];
                if (typeof v === "number") return v;
                if (v === null || v === undefined) return NaN;
                return toNum(String(v));
            }),
        );
        return finishJson(features, rows);
    }

    // 形状 B：数组数组 [[...], ...] —— 首行为表头
    if (Array.isArray(firstItem)) {
        const arr = parsed as unknown[][];
        const headRow = arr[0] ?? [];
        const header = headRow.map((h, i) => {
            const s = h === null || h === undefined ? "" : String(h);
            return s === "" ? `f${i + 1}` : s;
        });
        const rows = arr.slice(1).map((r) =>
            r.map((x) => (typeof x === "number" ? x : toNum(String(x ?? "")))),
        );
        return finishJson(header, rows);
    }

    return { ok: false, code: "ERR_BAD_FORMAT", message: "无法识别的 JSON 结构（既不是数组对象也不是数组数组）。" };
}

function finishJson(features: string[], rows: number[][]): LoadResult {
    const width = features.length;
    if (width === 0) {
        return { ok: false, code: "ERR_NO_FEATURES", message: "没有可用的数值列，无法做 PCA。" };
    }
    // 列数不足补 NaN，多余列丢弃（保持矩阵矩形）
    const padded = rows.map((r) => {
        const out = new Array<number>(width).fill(NaN);
        for (let j = 0; j < Math.min(width, r.length); j++) out[j] = r[j] ?? NaN;
        return out;
    });
    return { ok: true, data: { features, rows: padded, rawRows: rows.length, format: "json" } };
}

/**
 * 读取数据集（按扩展名分派）。
 * @param relPath 相对数据根目录的路径（已由调用方过 resolveInDataRoot，但这里再校验一次绝对值）
 */
export async function loadDataset(relPath: string): Promise<LoadResult> {
    let abs: string;
    try {
        abs = resolveInDataRoot(relPath);
    } catch (e) {
        return { ok: false, code: "ERR_OUT_OF_ROOT", message: (e as Error).message };
    }

    try {
        const st = await stat(abs);
        if (st.isDirectory()) {
            return { ok: false, code: "ERR_IS_DIRECTORY", message: `目标是目录而非文件: ${toRel(abs)}` };
        }
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
            return {
                ok: false,
                code: "ERR_NOT_FOUND",
                message: `数据文件不存在: ${toRel(abs)}（数据根目录 = ${getDataRoot()}，进程工作目录 = ${process.cwd()}）`,
            };
        }
        return { ok: false, code: "ERR_IO", message: `无法读取文件属性: ${err.message}` };
    }

    let text: string;
    try {
        const buf = await readFile(abs);
        // 简单二进制判定：含 NUL 即拒绝
        const probe = Math.min(buf.length, 8000);
        for (let i = 0; i < probe; i++) {
            if (buf[i] === 0) {
                return { ok: false, code: "ERR_SIZE_EXCEEDED", message: `疑似二进制文件，拒绝解析: ${toRel(abs)}` };
            }
        }
        text = buf.toString("utf-8");
    } catch (e) {
        return { ok: false, code: "ERR_IO", message: `读取文件失败: ${(e as Error).message}` };
    }

    const ext = extname(abs).toLowerCase();
    if (ext === ".json") return datasetFromJson(text);
    if (ext === ".csv" || ext === ".tsv" || ext === ".txt") return datasetFromCsv(text);
    return {
        ok: false,
        code: "ERR_BAD_FORMAT",
        message: `不支持的文件扩展名（${ext || "无"}）：目前只支持 .csv / .tsv / .txt（逗号/分号/制表符分隔）与 .json。`,
    };
}

/** 写 CSV（UTF-8 无 BOM；数值用 Number.prototype.toString 全精度） */
export async function writeCsv(
    relPath: string,
    header: string[],
    rows: Array<Array<number | string>>,
): Promise<{ ok: true; path: string } | { ok: false; code: string; message: string }> {
    let abs: string;
    try {
        abs = resolveInDataRoot(relPath);
    } catch (e) {
        return { ok: false, code: "ERR_OUT_OF_ROOT", message: (e as Error).message };
    }

    const esc = (v: number | string): string => {
        const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v;
        return /[",;\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [header.map(esc).join(",")];
    for (const r of rows) lines.push(r.map(esc).join(","));
    const body = lines.join("\n") + "\n";

    try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, body, "utf-8");
        return { ok: true, path: toRel(abs) };
    } catch (e) {
        return { ok: false, code: "ERR_IO", message: `写入文件失败: ${(e as Error).message}` };
    }
}

/** 默认输出文件名：data.csv → data.pca.csv */
export function defaultOutPath(inputRel: string): string {
    const base = basename(inputRel);
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const dir = inputRel.includes("/") ? inputRel.slice(0, inputRel.lastIndexOf("/") + 1) : "";
    return `${dir}${stem}.pca.csv`;
}
