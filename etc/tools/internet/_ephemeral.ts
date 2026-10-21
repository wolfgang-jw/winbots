/**
 * etc/tools/internet/_ephemeral.ts
 * 抓取全文的会话内暂存（需求域 R-30 ~ R-34）
 *
 * 定位：**不是**计费缓存（X-01），只解决「同一 URL 的偏移续读不必重复抓取」。
 *
 * 规则：
 *   R-30 TTL + 单会话条数上限 + 单条字符上限 + 全局字符上限，LRU 淘汰；**不得跨会话复用**
 *        （键 = 会话作用域 + URL，作用域不同即不同条目）
 *   R-31 命中本地切片、不发起请求；未命中重新抓取一次后写回再切片（由调用方完成）
 *   R-32 重新抓取后若全文长度变化，由调用方用「过期条目」的长度做对比并显式告知
 *   R-33 续读阶段抓取失败时，已暂存的旧内容**不得被清空**（本模块只在过期/超限时淘汰）
 *
 * ⚠️ 本文件【不导出 tools】，文件名以 _ 开头 → 加载器跳过、不告警（R-04 / R-05）。
 */
import { env } from "@/infra/env";

export interface Entry {
    /** 会话作用域（无会话标识时的实现见 web.ts） */
    scope: string;
    /** 归一化后的 URL（暂存键的一部分） */
    url: string;
    title: string;
    /** 全文（未截断；回灌时的截断由调用方按 INTERNET_FETCH_MAX_CHARS 处理） */
    text: string;
    /** 写入时刻（毫秒） */
    at: number;
}

/** key = `${scope}\u0000${url}`；Map 的插入顺序即 LRU 顺序（命中时重新插入到队尾） */
const entries = new Map<string, Entry>();
let totalChars = 0;

/** 可注入时钟（AC-41：假时钟验证 TTL，不依赖真实等待） */
let now: () => number = () => Date.now();

export function setNowForTest(f: (() => number) | null): void {
    now = f ?? (() => Date.now());
}

export function clearForTest(): void {
    entries.clear();
    totalChars = 0;
}

function keyOf(scope: string, url: string): string {
    return `${scope}\u0000${url}`;
}

function ttlMs(): number {
    const s = env.INTERNET_STORE_TTL_S;
    return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

function isExpired(e: Entry): boolean {
    const t = ttlMs();
    if (t <= 0) return false;              // TTL <= 0 视为不按时间淘汰（仍受条数与字符上限约束）
    return now() - e.at > t;
}

/** 淘汰单条（同步维护全局字符计数） */
function drop(key: string): void {
    const e = entries.get(key);
    if (!e) return;
    entries.delete(key);
    totalChars -= e.text.length;
}

export interface Lookup {
    /** 未过期、可本地切片的条目 */
    live: Entry | null;
    /** 已过期但曾被暂存的条目（供 R-32 对比全文长度，读取后即淘汰） */
    stale: Entry | null;
}

/**
 * 查询暂存。
 * 命中未过期 → live（并把它移到 LRU 队尾）；
 * 命中已过期 → 淘汰并作为 stale 返回（调用方据此比较长度，R-32）。
 */
export function get(scope: string, url: string): Lookup {
    const key = keyOf(scope, url);
    const e = entries.get(key);
    if (!e) return { live: null, stale: null };
    if (isExpired(e)) {
        drop(key);
        return { live: null, stale: e };
    }
    // LRU：命中后移到队尾
    entries.delete(key);
    entries.set(key, e);
    return { live: e, stale: null };
}

export interface PutResult {
    stored: boolean;
    /** 未暂存时可读原因（写入 meta，便于排查） */
    reason?: string;
}

/**
 * 写入暂存。
 * 单条字符上限（R-30）：超过上限**不暂存**（而非截断存储）——
 *   截断存储会让「下一段偏移」指向不存在的内容，对续读是错误语义。
 * 条数/全局字符超限：按 LRU 从最旧开始淘汰。
 */
export function put(scope: string, url: string, title: string, text: string): PutResult {
    const maxItem = env.INTERNET_STORE_MAX_CHARS_PER_ITEM;
    if (Number.isFinite(maxItem) && maxItem > 0 && text.length > maxItem) {
        return { stored: false, reason: `单条超过 ${maxItem} 字符上限，未暂存（续读需重新抓取）` };
    }

    const key = keyOf(scope, url);
    drop(key);   // 同键覆盖前先摘除，避免字符计数重复

    // 单会话条数上限：淘汰本会话最旧的条目
    const maxItems = env.INTERNET_STORE_MAX_ITEMS_PER_SESSION;
    if (Number.isFinite(maxItems) && maxItems > 0) {
        const same = [...entries.entries()].filter(([, e]) => e.scope === scope);
        while (same.length >= maxItems) {
            const oldest = same.shift();
            if (!oldest) break;
            drop(oldest[0]);
        }
    }

    entries.set(key, { scope, url, title, text, at: now() });
    totalChars += text.length;

    // 全局字符上限：从最旧（LRU 队首）开始淘汰
    const maxTotal = env.INTERNET_STORE_MAX_CHARS_TOTAL;
    if (Number.isFinite(maxTotal) && maxTotal > 0) {
        while (totalChars > maxTotal && entries.size > 0) {
            const first = entries.keys().next();
            if (first.done) break;
            drop(first.value);
        }
    }
    return { stored: true };
}

/** 当前占用（测试与日志用） */
export function stats(): { items: number; chars: number } {
    return { items: entries.size, chars: totalChars };
}
