/**
 * etc/tools/examples/analysis/pca.ts
 * PCA（主成分分析）工具组：fit / transform / explain
 *
 * 调用名：examples.analysis.pca.<name> → 模型可见名 examples__analysis__pca__<name>
 *
 * ⚠️ 本文件是入口文件：必须导出 tools: Tool[]；组设置项用 export const settings 声明。
 * ⚠️ 计算在 _pca_math.ts（纯函数）、读写与路径守卫在 _pca_data.ts（IO）。
 *    本文件只做参数校验、编排、结果整形与一行结构化日志。
 *
 * 安全：全部文件操作经 resolveInDataRoot() 白名单校验，只能访问 <项目根>/<data_root_dir> 内。
 * 预算：大矩阵一律落盘，回灌给模型的只有摘要 —— 外层 capToolResult 不应被触发。
 */
import type { Tool } from "@/tools";
import { groupSettings, type SettingDef } from "@/infra/settings";
import {
    columnStats,
    componentsForThreshold,
    covariance,
    jacobiEigen,
    projectRow,
    round4,
    type ColumnStats,
    type EigenResult,
} from "./_pca_math";
import {
    defaultOutPath,
    fail,
    loadDataset,
    ok,
    resolveInDataRoot,
    toRel,
    writeCsv,
    type Dataset,
} from "./_pca_data";

/**
 * [规范 §7.3] 本组作用域（只有本目录下的本组可读）。
 * ⚠️ 每次调用实时读，禁止模块级缓存 —— 否则「保存即生效」失效。
 *
 * ⚠️ 目录路径与文件名一律由本文件位置推导，不得手写。
 *   组设置键 = TOOLSET__<目录路径>__<文件名>__<键名>，与扫描器按「文件实际所在目录」
 *   算出的声明键必须逐段一致。原先写死 dirScope/groupScope("analysis", …)，
 *   而实际目录是 etc/tools/examples/analysis → 声明键是
 *   TOOLSET__examples__analysis__pca__…，与取值键对不上 → ERR_UNDECLARED_SETTING。
 */
const G = groupSettings(import.meta);

/* ============================================================
 * 硬上限（防止一次调用把服务进程拖死）
 *   超限一律返回 ERR_SIZE_EXCEEDED，不做静默采样（静默采样会让结论不可复现）。
 * ============================================================ */
const HARD_MAX_ROWS = 200_000;
const HARD_MAX_COLS = 200;
/** 载荷矩阵回灌的默认上限：前 k 个主成分 × 前 m 个特征 */
const DEFAULT_LOADING_COLS = 20;
/** explain 里累计解释方差曲线的最大长度（超出则稀疏采样） */
const MAX_CURVE_POINTS = 40;

/** 参数校验小工具：非负整数 / 正整数 */
function isPosInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v) && v >= 1;
}
function describeArg(v: unknown): string {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
}

/** 拟合结果（fit / transform / explain 共用） */
interface FitResult {
    dataset: Dataset;
    stats: ColumnStats;
    factor: "correlation" | "covariance";
    eigen: EigenResult;
    totalVariance: number;
    explained: number[];
    cumulative: number[];
    usedRows: number;
    droppedRows: number;
}

/**
 * 拟合 + 检验的唯一实现。
 *
 * @param relPath 相对数据根目录的路径
 * @param standardize true = 相关矩阵（Z-score）；false = 协方差矩阵（只中心化）
 */
async function fitCore(
    relPath: string,
    standardize: boolean,
): Promise<{ ok: true; fit: FitResult } | { ok: false; code: string; message: string }> {
    // ① 路径守卫（提前判，避免读了文件才发现越界）
    try {
        resolveInDataRoot(relPath);
    } catch (e) {
        return { ok: false, code: "ERR_OUT_OF_ROOT", message: (e as Error).message };
    }

    // ② 读数据
    const loaded = await loadDataset(relPath);
    if (!loaded.ok) return loaded;
    const dataset = loaded.data;

    // ③ 规模检查
    const d = dataset.features.length;
    const n = dataset.rows.length;
    if (n === 0) {
        return { ok: false, code: "ERR_EMPTY_DATA", message: "文件只有表头没有数据行，无法做 PCA。" };
    }
    if (d < 2) {
        return {
            ok: false,
            code: "ERR_ONLY_ONE_FEATURE",
            message: "只有 1 个特征列，PCA 无意义（降维前后维度相同）。请检查表头是否被误判为行索引。",
        };
    }
    const maxRows = Math.min(HARD_MAX_ROWS, G.get<number>("max_rows"));
    const maxCols = Math.min(HARD_MAX_COLS, G.get<number>("max_columns"));
    if (n > maxRows) {
        return {
            ok: false,
            code: "ERR_SIZE_EXCEEDED",
            message:
                `数据行数 ${n} 超过上限 ${maxRows}（可调：配置页 › 工具配置 › analysis › pca › max_rows，` +
                `硬上限 ${HARD_MAX_ROWS}）。请先抽样或聚合后再分析。`,
        };
    }
    if (d > maxCols) {
        return {
            ok: false,
            code: "ERR_SIZE_EXCEEDED",
            message:
                `特征列数 ${d} 超过上限 ${maxCols}（可调：配置页 › 工具配置 › analysis › pca › max_columns，` +
                `硬上限 ${HARD_MAX_COLS}）。协方差矩阵是 O(d²)、特征分解是 O(d³)，列太多会拖死服务进程。`,
        };
    }

    // ④ 列统计 → 协方差 → 特征分解
    const stats = columnStats(dataset.rows, d, standardize);
    const { cov, usedRows } = covariance(dataset.rows, d, stats);
    if (usedRows < 2) {
        return {
            ok: false,
            code: "ERR_TOO_FEW_SAMPLES",
            message:
                `按行剔除缺失后只剩 ${usedRows} 行有效样本（至少需要 2 行）。` +
                "请检查数据里是否有大量空值或非数值内容。",
        };
    }
    const eigen = jacobiEigen(cov);

    // ⑤ 解释方差
    const totalVariance = eigen.values.reduce((a, b) => a + Math.max(0, b), 0);
    const explained = eigen.values.map((v) => (totalVariance > 0 ? Math.max(0, v) / totalVariance : 0));
    const cumulative: number[] = [];
    let acc = 0;
    for (const e of explained) {
        acc += e;
        cumulative.push(acc);
    }

    return {
        ok: true,
        fit: {
            dataset,
            stats,
            factor: standardize ? "correlation" : "covariance",
            eigen,
            totalVariance,
            explained,
            cumulative,
            usedRows,
            droppedRows: n - usedRows,
        },
    };
}

/** 载荷矩阵（特征 × 主成分）：loading[i][j] = 特征 i 在第 j 个主成分上的载荷 */
function loadings(fit: FitResult): number[][] {
    const d = fit.dataset.features.length;
    const out: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (let j = 0; j < d; j++) {
        const vec = fit.eigen.vectors[j];
        if (!vec) continue;
        const scale = Math.sqrt(Math.max(0, fit.eigen.values[j] ?? 0));
        for (let i = 0; i < d; i++) {
            const row = out[i];
            if (row) row[j] = (vec[i] ?? 0) * scale;
        }
    }
    return out;
}

/** 取 k（受 d 与用户输入约束） */
function pickK(fit: FitResult, requested: unknown): number {
    const d = fit.dataset.features.length;
    if (!isPosInt(requested)) return Math.min(3, d);
    return Math.min(requested, d);
}

/** 一段供模型阅读的口径说明（每次拟合都带，避免模型误读数字含义） */
function conventionNote(fit: FitResult): string {
    const base =
        fit.factor === "correlation"
            ? "已标准化（standardize=true）：特征已按 Z-score 处理，特征值来自相关矩阵，总方差 = 特征数。"
            : "未标准化（standardize=false）：特征值来自协方差矩阵，量纲大的特征会主导主成分，比较各特征贡献前请三思。";
    const missing =
        fit.droppedRows > 0
            ? `另有 ${fit.droppedRows} 行因含缺失值被按行剔除，未参与协方差计算。`
            : "所有行都参与了计算（无缺失值）。";
    return `${base}${missing}特征值已按降序排列，解释方差比 = 特征值 / 特征值总和。`;
}

/** 一行结构化日志（不含数据正文，只含规模与耗时） */
function fitLogLine(tool: string, fit: FitResult, extra: string): string {
    return (
        `[pca] tool=analysis.pca.${tool} rows=${fit.usedRows} cols=${fit.dataset.features.length} ` +
        `factor=${fit.factor} sweeps=${fit.eigen.sweeps} converged=${fit.eigen.converged} ${extra}`
    );
}

/* ============================================================
 * 工具 1：fit —— 拟合，只回摘要
 * ============================================================ */
const FIT_DESCRIPTION =
    "对数据文件做 PCA（主成分分析）拟合并返回摘要：特征值、各主成分的解释方差比、累计解释方差、" +
    "均值与标准差、以及载荷矩阵（特征 × 主成分，指向前若干列）。" +
    "①数据须先位于分析数据目录（配置项 data_root_dir，默认 working）内，支持 .csv / .tsv / .txt（逗号/分号/制表符分隔，" +
    "首行为表头）与 .json（数组对象 / 数组数组 / {features,rows}）。" +
    "②默认 standardize=true：先做 Z-score 再求相关矩阵，这是 PCA 的标准做法（量纲差异会让不标准化的大数值列独占主成分）；" +
    "仅当所有特征本就同量纲时才传 false。特征值、载荷、解释方差比的含义都随该参数变化，回包里的 conventionNote 会写明本次口径。" +
    "③缺失值（空单元格 / 非数值）按行成对剔除：含缺失的行整行不参与协方差计算，回包会给出 droppedRows 与 usedRows。" +
    "④载荷矩阵是二维的，容易撑爆结果长度：默认只回前 loading_features 个特征（上限见配置），需要完整矩阵请用 transform 落盘后再读文件。" +
    "⑤不确定该保留几个主成分时，可直接用 explain 工具（它会按阈值给出建议并画出累计曲线）。" +
    "⑥本工具只读数据、不写任何文件；有副作用（落盘）的是 transform。";

const FIT_PARAMETERS = {
    type: "object",
    properties: {
        path: {
            type: "string",
            description: "相对分析数据目录的文件路径，如 \"data/iris.csv\"。不允许 ../ 或绝对路径。",
        },
        n_components: {
            type: "integer",
            minimum: 1,
            description: "回包中展示多少主成分的载荷与解释方差比（默认 3，会被特征数钳制）。",
        },
        standardize: {
            type: "boolean",
            description:
                "是否标准化（Z-score）。默认 true（用相关矩阵）；false 则只中心化（用协方差矩阵）。",
        },
        loading_features: {
            type: "integer",
            minimum: 1,
            description: "载荷矩阵回灌多少个特征行（默认 20，会被特征数钳制）。完整矩阵请用 transform 落盘。",
        },
    },
    required: ["path"],
};

/** 构造载荷矩阵的回灌切片 */
function loadingSlice(fit: FitResult, k: number, maxFeatures: number) {
    const L = loadings(fit);
    const features = fit.dataset.features;
    const m = Math.min(features.length, maxFeatures);
    const rows = [] as Array<Record<string, number | string>>;
    for (let i = 0; i < m; i++) {
        const row: Record<string, number | string> = { feature: features[i] ?? `f${i + 1}` };
        const Li = L[i];
        for (let j = 0; j < k; j++) row[`PC${j + 1}`] = round4(Li?.[j] ?? 0);
        rows.push(row);
    }
    return {
        rows,
        shownFeatures: m,
        totalFeatures: features.length,
        truncated: m < features.length,
        note:
            m < features.length
                ? `载荷矩阵只回灌了前 ${m} 个特征（共 ${features.length}）；完整矩阵请调大 loading_features，或用 transform 落盘后读文件。`
                : "",
    };
}

/* ============================================================
 * 工具 2：transform —— 拟合 + 投影 + 落盘
 * ============================================================ */
const TRANSFORM_DESCRIPTION =
    "对数据文件做 PCA 并把投影后的低维坐标写成新的 CSV 文件，返回落盘路径与摘要。" +
    "①输出 = 原始行索引（存在时）+ PC1..PCk 坐标；缺失行会被跳过并计数。" +
    "②out_path 省略时默认写到原文件旁的 <原名>.pca.csv；输出路径同样受分析数据目录约束（不可越界），已存在的文件会被覆盖。" +
    "③standardize 默认 true，务必与后续使用时保持一致：用同一份数据、同样的 standardize 拟合出来的坐标才可比。" +
    "④若目的是给聚类 / 回归做预处理，通常用 2–10 个主成分即可；先用 explain 或 fit 看累计解释方差再决定 k。" +
    "⑤本工具会写文件（覆盖同名输出），调用前请确认 out_path 不会覆盖有用文件。";

const TRANSFORM_PARAMETERS = {
    type: "object",
    properties: {
        path: { type: "string", description: "相对分析数据目录的输入文件路径，如 \"data/iris.csv\"。" },
        out_path: {
            type: "string",
            description: "相对分析数据目录的输出 CSV 路径；省略则默认为输入文件旁的 <原名>.pca.csv。",
        },
        n_components: {
            type: "integer",
            minimum: 1,
            description: "输出多少个主成分坐标（默认 3，会被特征数钳制）。",
        },
        standardize: {
            type: "boolean",
            description: "是否标准化（Z-score）。默认 true；须与后续用途保持一致。",
        },
        include_index: {
            type: "boolean",
            description: "是否在输出首列写入原始行号（从 1 起，不含表头）。默认 true。",
        },
    },
    required: ["path"],
};

/* ============================================================
 * 工具 3：explain —— 只给「取几个主成分」的建议
 * ============================================================ */
const EXPLAIN_DESCRIPTION =
    "只回答「该保留几个主成分」：按累计解释方差比计算达到阈值所需的主成分个数，并给出累计解释方差曲线。" +
    "①threshold 默认 0.9（累计解释 90%）；常用 0.85 / 0.9 / 0.95。" +
    "②同时给出 Kaiser 准则的结果（保留特征值 > 1 的主成分，仅对 standardize=true 的相关矩阵有意义）。" +
    "③曲线过长时会稀疏采样，返回的 cumulative_curve 每项都带 dim，不必自己算序号。" +
    "④本工具只读数据、不写文件；确定 k 之后用 transform 落盘。";

const EXPLAIN_PARAMETERS = {
    type: "object",
    properties: {
        path: { type: "string", description: "相对分析数据目录的路径，如 \"data/iris.csv\"。" },
        threshold: {
            type: "number",
            minimum: 0.01,
            maximum: 1,
            description: "累计解释方差比阈值，默认 0.9。",
        },
        standardize: {
            type: "boolean",
            description: "是否标准化（Z-score）。默认 true；与 K 的取值口径直接相关，建议先想清楚再改。",
        },
    },
    required: ["path"],
};

/* ============================================================
 * 导出
 * ============================================================ */
export const tools: Tool[] = [
    {
        name: "fit",
        description: FIT_DESCRIPTION,
        parameters: FIT_PARAMETERS,
        handler: async (args: Record<string, unknown>) => {
            const relPath = String(args.path ?? "").trim();
            if (!relPath) return fail("ERR_INVALID_ARGUMENT", "缺少 path 参数：请给出相对分析数据目录的数据文件路径。");

            const standardize = args.standardize !== false;   // 默认 true
            const r = await fitCore(relPath, standardize);
            if (!r.ok) return fail(r.code, r.message);
            const fit = r.fit;

            const d = fit.dataset.features.length;
            const k = pickK(fit, args.n_components);
            const maxFeatures =
                typeof args.loading_features === "number" && args.loading_features >= 1
                    ? Math.min(Math.floor(args.loading_features), d)
                    : Math.min(DEFAULT_LOADING_COLS, d);

            const body = {
                tool: "analysis.pca.fit",
                path: toRel(resolveInDataRoot(relPath)),
                format: fit.dataset.format,
                shape: { rows: fit.usedRows, columns: d, rawRows: fit.dataset.rows.length },
                droppedRows: fit.droppedRows,
                standardize,
                factor: fit.factor,
                totalVariance: round4(fit.totalVariance),
                components_shown: k,
                eigenvalues: fit.eigen.values.slice(0, k).map(round4),
                explained_variance_ratio: fit.explained.slice(0, k).map(round4),
                cumulative_ratio: fit.cumulative.slice(0, k).map(round4),
                mean: fit.dataset.features.map((f, i) => ({ feature: f, mean: round4(fit.stats.mean[i] ?? 0) })),
                std: fit.dataset.features.map((f, i) => ({ feature: f, std: round4(fit.stats.std[i] ?? 1) })),
                loadings: loadingSlice(fit, k, maxFeatures),
                convergence: {
                    sweeps: fit.eigen.sweeps,
                    converged: fit.eigen.converged,
                    note: fit.eigen.converged
                        ? "Jacobi 迭代已收敛。"
                        : "Jacobi 达到轮数上限仍未完全收敛：数值结果可能有小误差，建议降维列数或先检查异常值。",
                },
                conventionNote: conventionNote(fit),
                nextStep:
                    "要落盘低维坐标请用 transform（n_components 同 k）；只要「取几个」的建议请用 explain。",
            };

            console.log(fitLogLine("fit", fit, `k=${k}`));
            return ok(body);
        },
    },

    {
        name: "transform",
        description: TRANSFORM_DESCRIPTION,
        parameters: TRANSFORM_PARAMETERS,
        handler: async (args: Record<string, unknown>) => {
            const relPath = String(args.path ?? "").trim();
            if (!relPath) return fail("ERR_INVALID_ARGUMENT", "缺少 path 参数：请给出相对分析数据目录的输入文件路径。");

            const standardize = args.standardize !== false;   // 默认 true
            const includeIndex = args.include_index !== false; // 默认 true

            const r = await fitCore(relPath, standardize);
            if (!r.ok) return fail(r.code, r.message);
            const fit = r.fit;

            const d = fit.dataset.features.length;
            const k = pickK(fit, args.n_components);

            // ① 投影（缺失行跳过）
            const projected: Array<Array<number | string>> = [];
            let skipped = 0;
            for (let i = 0; i < fit.dataset.rows.length; i++) {
                const srcRow = fit.dataset.rows[i] ?? [];
                const coords = projectRow(srcRow, fit.stats, fit.eigen.vectors, k, d);
                if (coords === null) {
                    skipped += 1;
                    continue;
                }
                const line: Array<number | string> = [];
                if (includeIndex) line.push(i + 1);
                for (const c of coords) line.push(round4(c) as unknown as number);
                projected.push(line);
            }

            if (projected.length === 0) {
                return fail(
                    "ERR_TOO_FEW_SAMPLES",
                    "所有行都含缺失值，投影后没有任何有效输出行；未写入文件。请先清洗数据。",
                );
            }

            // ② 落盘
            const outRel =
                typeof args.out_path === "string" && args.out_path.trim() !== ""
                    ? args.out_path.trim()
                    : defaultOutPath(relPath);
            // 防御：输出不能覆盖输入本身
            const inAbs = resolveInDataRoot(relPath);
            let outAbs: string;
            try {
                outAbs = resolveInDataRoot(outRel);
            } catch (e) {
                return fail("ERR_OUT_OF_ROOT", (e as Error).message);
            }
            if (outAbs === inAbs) {
                return fail(
                    "ERR_INVALID_ARGUMENT",
                    `out_path 与输入文件相同（${toRel(inAbs)}）：这会覆盖原始数据。请换一个输出路径。`,
                );
            }

            const header: string[] = [];
            if (includeIndex) header.push("row_index");
            for (let j = 0; j < k; j++) header.push(`PC${j + 1}`);

            const w = await writeCsv(outRel, header, projected);
            if (!w.ok) return fail(w.code, w.message);

            // ③ 抽样回灌若干行坐标（不整表回灌，避免撑爆预算）
            const previewRows = projected.slice(0, 5);

            const body = {
                tool: "analysis.pca.transform",
                input: toRel(inAbs),
                output: w.path,
                standardize,
                factor: fit.factor,
                shape: {
                    inputRows: fit.dataset.rows.length,
                    outputRows: projected.length,
                    columns: k,
                    features: d,
                },
                droppedRows: fit.droppedRows,
                skippedRows: skipped,
                explained_variance_ratio: fit.explained.slice(0, k).map(round4),
                cumulative_ratio: round4(fit.cumulative[k - 1] ?? 0),
                preview: { header, rows: previewRows.slice(0, 5) },
                note:
                    `坐标已用同一份拟合结果计算（standardize=${standardize}）。` +
                    "要复现同样的坐标，必须用同样的数据、同样的 standardize 与同样的 n_components。" +
                    (skipped > 0 ? `有 ${skipped} 行因含缺失值被跳过，未写入输出。` : ""),
                conventionNote: conventionNote(fit),
            };

            console.log(fitLogLine("transform", fit, `k=${k} output=${w.path} skipped=${skipped}`));
            return ok(body);
        },
    },

    {
        name: "explain",
        description: EXPLAIN_DESCRIPTION,
        parameters: EXPLAIN_PARAMETERS,
        handler: async (args: Record<string, unknown>) => {
            const relPath = String(args.path ?? "").trim();
            if (!relPath) return fail("ERR_INVALID_ARGUMENT", "缺少 path 参数：请给出相对分析数据目录的数据文件路径。");

            const standardize = args.standardize !== false;   // 默认 true
            let threshold = 0.9;
            if (args.threshold !== undefined) {
                if (typeof args.threshold !== "number" || !(args.threshold > 0 && args.threshold <= 1)) {
                    return fail(
                        "ERR_INVALID_ARGUMENT",
                        `threshold 必须是 (0, 1] 之间的数（收到 ${describeArg(args.threshold)}）：例如 0.9 表示累计解释 90%。`,
                    );
                }
                threshold = args.threshold;
            }

            const r = await fitCore(relPath, standardize);
            if (!r.ok) return fail(r.code, r.message);
            const fit = r.fit;

            const d = fit.dataset.features.length;
            const needed = componentsForThreshold(fit.explained, threshold);
            // Kaiser 准则：特征值 > 1 的个数（仅相关矩阵下有意义）
            const kaiser = fit.eigen.values.filter((v) => v > 1).length;

            // 稀疏采样曲线
            const step = Math.max(1, Math.ceil(d / MAX_CURVE_POINTS));
            const curve: Array<{ dim: number; explained: number; cumulative: number }> = [];
            for (let j = 0; j < d; j += step) {
                curve.push({
                    dim: j + 1,
                    explained: round4(fit.explained[j] ?? 0),
                    cumulative: round4(fit.cumulative[j] ?? 0),
                });
            }
            if (curve[curve.length - 1]?.dim !== d) {
                curve.push({
                    dim: d,
                    explained: round4(fit.explained[d - 1] ?? 0),
                    cumulative: round4(fit.cumulative[d - 1] ?? 0),
                });
            }

            const body = {
                tool: "analysis.pca.explain",
                path: toRel(resolveInDataRoot(relPath)),
                shape: { rows: fit.usedRows, columns: d, rawRows: fit.dataset.rows.length },
                droppedRows: fit.droppedRows,
                standardize,
                factor: fit.factor,
                threshold,
                recommended_components: needed,
                cumulative_at_recommended: round4(fit.cumulative[needed - 1] ?? 0),
                kaiser_components: standardize ? kaiser : null,
                kaiser_note: standardize
                    ? `Kaiser 准则：特征值 > 1 的主成分有 ${kaiser} 个（仅相关矩阵下有明确含义）。`
                    : "未标准化时特征值来自协方差矩阵，量纲不同则特征值不可比，Kaiser 准则不适用（返回 null）。",
                cumulative_curve: curve,
                curveSampled: step > 1 ? `共 ${d} 维，已按步长 ${step} 稀疏采样。` : "已给出每一维。",
                conventionNote: conventionNote(fit),
                nextStep:
                    `确定取 ${needed} 个主成分后，用 transform（n_components=${needed}）把低维坐标落盘。`,
            };

            console.log(fitLogLine("explain", fit, `threshold=${threshold} k=${needed}`));
            return ok(body);
        },
    },
];

/* ============================================================
 * [规范 §7.1] 组设置项声明（只有 analysis/pca 可读，§7.3）
 *   · 默认值只在这里写一次（§3.2），配置页只展示、不得改；
 *   · 与默认值相同的取值不落盘（§9.1「值等于默认值即删键」）；
 *   · 越界值由读取端一次性告警并回退默认（§7.4）；
 *   · 这里的上限还会被代码里的硬上限（HARD_MAX_ROWS / HARD_MAX_COLS）再夹一层。
 * ============================================================ */
export const settings: Record<string, SettingDef> = {
    max_rows: {
        kind: "number",
        default: 50000,
        min: 2,
        max: HARD_MAX_ROWS,
        desc:
            "单次 PCA 允许的最大数据行数（硬上限 200000）。协方差计算是 O(n·d²)，行数过多会长时间占用服务进程。" +
            "超限直接返回 ERR_SIZE_EXCEEDED，不做静默采样。",
    },
    max_columns: {
        kind: "number",
        default: 100,
        min: 2,
        max: HARD_MAX_COLS,
        desc:
            "单次 PCA 允许的最大特征列数（硬上限 200）。特征分解是 O(d³)，列太多会拖死服务进程。" +
            "超限直接返回 ERR_SIZE_EXCEEDED。",
    },
};
