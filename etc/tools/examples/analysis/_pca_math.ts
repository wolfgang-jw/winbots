/**
 * etc/tools/examples/analysis/_pca_math.ts
 * PCA 的纯数学实现（零依赖、无 IO、无日志）
 *
 * ⚠️ 本文件【不导出 tools】：`_` 前缀 → 扫描器不注册（§4.2），也不会刷「未导出 tools」告警。
 * ⚠️ 只放纯函数：不读配置、不碰文件系统、不 console。IO 与配置读取全部在 pca.ts。
 *
 * 实现选型：
 *   · 协方差矩阵 + 对称 Jacobi 特征分解 —— 只依赖线性代数基本运算，
 *     不引入第三方数值库；对 d ≤ 200 的稠密小矩阵足够稳。
 *   · tsconfig 开了 noUncheckedIndexedAccess：所有下标访问都先取到局部变量并做兜底。
 */

/** 对称矩阵特征分解结果（按特征值降序排列） */
export interface EigenResult {
    /** 特征值，降序 */
    values: number[];
    /** 特征向量（values[i] 对应 vectors[i]；每个向量长度 = d） */
    vectors: number[][];
    /** 实际迭代轮数（每轮清零一个非对角元素） */
    sweeps: number;
    /** 是否在轮数上限内达到收敛判定 */
    converged: boolean;
}

/**
 * 对称矩阵 Jacobi 特征分解。
 *
 * 算法：每轮在所有 (p,q) 对里找出最大的非对角元素，做一次 Givens 旋转把它清零；
 * 一轮清零一个 → 最多 d(d-1)/2 轮必然结束。这里用「最大元素」而非经典循环扫描，
 * 收敛更快，代价是每轮多一次 O(d²) 的找最大。
 *
 * 停止条件：最大非对角元 <= tol * (Frobenius 范数 + 1)，或达到轮数上限。
 *
 * @param aIn 对称矩阵（调用方保证对称，本函数不做对称化）
 * @param tol 相对收敛阈值，默认 1e-12
 */
export function jacobiEigen(aIn: number[][], tol = 1e-12): EigenResult {
    const d = aIn.length;
    if (d === 0) return { values: [], vectors: [], sweeps: 0, converged: true };
    const first = aIn[0]?.[0] ?? 0;
    if (d === 1) return { values: [first], vectors: [[1]], sweeps: 0, converged: true };

    // 复制，避免改动调用方数据
    const a = aIn.map((row) => row.slice());
    // v 累积旋转 = 特征向量矩阵（列 j 是第 j 个特征向量）
    const v: number[][] = Array.from({ length: d }, (_, i) =>
        Array.from({ length: d }, (_, j) => (i === j ? 1 : 0)),
    );

    const maxSweeps = (d * (d - 1)) / 2 + 8;

    // Frobenius 范数（用于相对阈值）
    let frob = 0;
    for (let i = 0; i < d; i++) {
        const ai = a[i];
        if (!ai) continue;
        for (let j = 0; j < d; j++) {
            const x = ai[j] ?? 0;
            frob += x * x;
        }
    }
    frob = Math.sqrt(frob);
    const eps = tol * (frob + 1);

    let sweeps = 0;
    let converged = false;
    for (; sweeps < maxSweeps; sweeps++) {
        // ① 找最大非对角元素
        let p = 0;
        let q = 1;
        let maxOff = 0;
        for (let i = 0; i < d; i++) {
            const ai = a[i];
            if (!ai) continue;
            for (let j = i + 1; j < d; j++) {
                const aij = Math.abs(ai[j] ?? 0);
                if (aij > maxOff) {
                    maxOff = aij;
                    p = i;
                    q = j;
                }
            }
        }
        if (maxOff <= eps) {
            converged = true;
            break;
        }

        // ② 计算旋转角：用 tau 形式避免小角度的精度损失
        const rowP = a[p];
        const rowQ = a[q];
        if (!rowP || !rowQ) break;
        const app = rowP[p] ?? 0;
        const aqq = rowQ[q] ?? 0;
        const apq = rowP[q] ?? 0;
        const tau = (aqq - app) / (2 * apq);
        const t =
            tau >= 0
                ? 1 / (tau + Math.sqrt(1 + tau * tau))
                : 1 / (tau - Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        // ③ 左乘 / 右乘旋转矩阵到 a（保持对称）
        for (let k = 0; k < d; k++) {
            if (k === p || k === q) continue;
            const rowK = a[k];
            const colKp = (a[k] ?? [])[p] ?? 0;   // = a[k][p]
            const aqk = (a[q] ?? [])[k] ?? 0;     // = a[q][k] = a[k][q]
            const akp = colKp;
            const akq = aqk;
            if (rowK) {
                rowK[p] = c * akp - s * akq;
                rowK[q] = s * akp + c * akq;
            }
            const rowP2 = a[p];
            if (rowP2) rowP2[k] = c * akp - s * akq;
            const rowQ2 = a[q];
            if (rowQ2) rowQ2[k] = s * akp + c * akq;
        }
        const rowP3 = a[p];
        const rowQ3 = a[q];
        if (rowP3) {
            rowP3[p] = c * c * app - 2 * s * c * apq + s * s * aqq;
            rowP3[q] = 0;
        }
        if (rowQ3) {
            rowQ3[q] = s * s * app + 2 * s * c * apq + c * c * aqq;
            rowQ3[p] = 0;
        }

        // ④ 累积到特征向量矩阵
        for (let k = 0; k < d; k++) {
            const rowV = v[k];
            if (!rowV) continue;
            const vkp = rowV[p] ?? 0;
            const vkq = rowV[q] ?? 0;
            rowV[p] = c * vkp - s * vkq;
            rowV[q] = s * vkp + c * vkq;
        }
    }

    // ⑤ 取对角 → 特征值；组装特征向量；按特征值降序排序
    const pairs = Array.from({ length: d }, (_, j) => ({
        value: a[j]?.[j] ?? 0,
        vector: Array.from({ length: d }, (_, i) => v[i]?.[j] ?? 0),
    }));
    pairs.sort((x, y) => y.value - x.value);

    return {
        values: pairs.map((x) => x.value),
        vectors: pairs.map((x) => x.vector),
        sweeps,
        converged,
    };
}

/** 标准化 / 中心化所需的列统计量 */
export interface ColumnStats {
    mean: number[];
    /** 总体标准差（除以 n）；standardize=false 时全为 1 */
    std: number[];
    /** 每列在实际参与计算的行里出现的有效样本数 */
    counts: number[];
}

/**
 * 计算列均值与标准差。
 *
 * 缺失值口径：`null` / `NaN` / `Infinity` 视为缺失，按列成对剔除（缺失不参与该列的均值与标准差）。
 *
 * @param rows 数值矩阵（已解析，缺失为 NaN）
 * @param d 列数
 * @param standardize true = 用于 Z-score（分母用总体标准差）；false = 只中心化（std 记 1）
 */
export function columnStats(rows: number[][], d: number, standardize: boolean): ColumnStats {
    const mean = new Array<number>(d).fill(0);
    const counts = new Array<number>(d).fill(0);

    for (const row of rows) {
        for (let j = 0; j < d; j++) {
            const x = row[j] ?? NaN;
            if (Number.isFinite(x)) {
                mean[j] = (mean[j] ?? 0) + x;
                counts[j] = (counts[j] ?? 0) + 1;
            }
        }
    }
    for (let j = 0; j < d; j++) {
        const c = counts[j] ?? 0;
        mean[j] = c > 0 ? (mean[j] ?? 0) / c : 0;
    }

    const std = new Array<number>(d).fill(1);
    if (standardize) {
        const ss = new Array<number>(d).fill(0);
        for (const row of rows) {
            for (let j = 0; j < d; j++) {
                const x = row[j] ?? NaN;
                if (Number.isFinite(x)) {
                    const dv = x - (mean[j] ?? 0);
                    ss[j] = (ss[j] ?? 0) + dv * dv;
                }
            }
        }
        for (let j = 0; j < d; j++) {
            const c = counts[j] ?? 0;
            const sd = c > 0 ? Math.sqrt((ss[j] ?? 0) / c) : 0;
            // 常数列标准差为 0：不做缩放（除以 0 会得到 NaN/Inf）
            std[j] = sd > 0 ? sd : 1;
        }
    }

    return { mean, std, counts };
}

/**
 * 按「列均值 / 标准差」中心化（并可选缩放）后，计算协方差矩阵。
 *
 * 缺失值口径：**按行成对剔除** —— 一行里只要该列有缺失，这一整行就不参与协方差计算。
 *   这样得到的协方差矩阵是对称正半定的，不会像「逐列填均值」那样人为压低方差。
 */
export function covariance(
    rows: number[][],
    d: number,
    stats: ColumnStats,
): { cov: number[][]; usedRows: number } {
    const cov: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    let used = 0;

    const z = new Array<number>(d).fill(0);
    for (const row of rows) {
        let complete = true;
        for (let j = 0; j < d; j++) {
            const x = row[j] ?? NaN;
            if (!Number.isFinite(x)) {
                complete = false;
                break;
            }
            const sd = stats.std[j] ?? 1;
            z[j] = (x - (stats.mean[j] ?? 0)) / (sd === 0 ? 1 : sd);
        }
        if (!complete) continue;
        used += 1;
        for (let i = 0; i < d; i++) {
            const zi = z[i] ?? 0;
            const covI = cov[i];
            if (!covI) continue;
            for (let j = i; j < d; j++) {
                const val = zi * (z[j] ?? 0);
                covI[j] = (covI[j] ?? 0) + val;
                if (i !== j) {
                    const covJ = cov[j];
                    if (covJ) covJ[i] = (covJ[i] ?? 0) + val;   // 对称写入
                }
            }
        }
    }

    // 分母口径必须与 columnStats 的 std 一致：
    //   std 用的是**总体标准差**（除以 n），所以这里也必须除以 n。
    //   若这里用 n-1，标准化后相关矩阵的对角线会变成 n/(n-1) ≠ 1，
    //   导致「特征值之和 = 迹 = 特征数」这个不变量被破坏（曾出现 eigenvalues=[2.5,0]、载荷=1.118 的现象）。
    const denom = used > 0 ? used : 0;
    if (denom > 0) {
        for (let i = 0; i < d; i++) {
            const covI = cov[i];
            if (!covI) continue;
            for (let j = 0; j < d; j++) covI[j] = (covI[j] ?? 0) / denom;
        }
    }

    return { cov, usedRows: used };
}

/**
 * 把一行原始数据投影到前 k 个主成分上。
 * 缺失（任一维度非有限值）时返回 null，由调用方统计。
 */
export function projectRow(
    row: number[],
    stats: ColumnStats,
    vectors: number[][],
    k: number,
    d: number,
): number[] | null {
    const z = new Array<number>(d).fill(0);
    for (let j = 0; j < d; j++) {
        const x = row[j] ?? NaN;
        if (!Number.isFinite(x)) return null;
        const sd = stats.std[j] ?? 1;
        z[j] = (x - (stats.mean[j] ?? 0)) / (sd === 0 ? 1 : sd);
    }
    const out = new Array<number>(k).fill(0);
    for (let i = 0; i < k; i++) {
        const vec = vectors[i];
        if (!vec) continue;
        let s = 0;
        for (let j = 0; j < d; j++) s += (vec[j] ?? 0) * (z[j] ?? 0);
        out[i] = s;
    }
    return out;
}

/** 累计解释方差比达到 threshold 所需的主成分个数（至少 1，至多 d） */
export function componentsForThreshold(explained: number[], threshold: number): number {
    let acc = 0;
    for (let i = 0; i < explained.length; i++) {
        acc += explained[i] ?? 0;
        if (acc >= threshold) return i + 1;
    }
    return Math.max(1, explained.length);
}

/** 保留 4 位有效数字，避免工具结果被无意义的小数打爆 */
export function round4(x: number): number {
    if (!Number.isFinite(x)) return 0;
    return Number(x.toPrecision(4));
}
