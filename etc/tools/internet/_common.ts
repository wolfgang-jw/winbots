/**
 * etc/tools/internet/_common.ts
 * 互联网工具共用方法（需求域 R 的统一入口，R-08 ~ R-16、R-35 ~ R-45）
 *
 * 职责（唯一负责「选供应商 → 取配置 → 发请求 → 整形结果 → 错误映射」）：
 * 1. 供应商定义（ProviderDef）：表达四类差异 —— 基址+端点路径、鉴权头形式、
 *    请求体字段映射、响应字段→内部结构的映射（R-08，不得只有地址与密钥）；
 * 2. 配置读取一律走 env 实时取值，不在模块顶层缓存（R-10，热更立即生效）；
 * 3. 传输层：超时（R-39）+ 用户中断（R-40）+ 有限重试与退避（R-35）；
 * 4. 错误映射：状态码 → 结构化错误码与可指导模型行动的文案（§8.5.1、R-36、R-38）；
 * 5. 统一信封：成功 { ok:true, text, meta } / 失败 { ok:false, error:{ code, message } }（R-37）；
 * 6. 结构化调用日志（R-43/R-44）。
 *
 * ⚠️ 本文件【不导出 tools】，且文件名以 _ 开头 → 加载器跳过、不告警（R-04 / R-05）。
 * ⚠️ 工具内部永不向平台抛业务异常：所有失败以信封返回（R-37），调用方（web.ts）
 *    再用 try/catch 做最后一道兜底。
 * ⚠️ 密钥永不落日志、永不进错误文案（R-38 / R-44）。
 */
import { env } from "@/infra/env";
import type { ToolContext } from "@/tools";

// ============================================================
// 基础类型与信封
// ============================================================

/** 能力类别：本期两种（R-01） */
export type Kind = "search" | "fetch";

/** 结构化错误码（§8.5.1 错误码与重试矩阵） */
export type ErrorCode =
    | "invalid_request"
    | "auth_required"
    | "insufficient_balance"
    | "blocked_by_policy"
    | "not_extractable"
    | "rate_limited"
    | "timeout"
    | "too_large"
    | "upstream_error"
    | "invalid_provider"
    | "cancelled";

/** 成功信封：成功标志 + 供模型阅读的文本 + 可选附加信息 */
export interface EnvelopeOk {
    ok: true;
    text: string;
    meta: Record<string, unknown>;
}

/** 失败信封：形状与文件工具的 fail() 一致，保证结构化错误码不丢失 */
export interface EnvelopeFail {
    ok: false;
    error: { code: ErrorCode | string; message: string };
}

export type Envelope = EnvelopeOk | EnvelopeFail;

/** 统一成功信封 */
export function ok(text: string, meta: Record<string, unknown> = {}): EnvelopeOk {
    return { ok: true, text, meta };
}

/** 统一失败信封 */
export function fail(code: ErrorCode | string, message: string): EnvelopeFail {
    return { ok: false, error: { code, message } };
}

/** 检索结果条目（内部结构，与供应商无关，R-08 第 4 类差异的输出侧） */
export interface SearchHit {
    title: string;
    url: string;
    snippet: string;
    publishedAt: string;
    site: string;
}

export interface SearchPayload {
    hits: SearchHit[];
}

export interface FetchPayload {
    title: string;
    text: string;
}

export interface SearchArgs {
    query: string;
    count: number;
}

export interface FetchArgs {
    url: string;
}

// ============================================================
// 供应商定义（R-08：四类差异）
// ============================================================

export interface EndpointDef<A, R> {
    /** HTTP 方法（差异项，缺省 POST） */
    method: () => "GET" | "POST";
    /** 端点路径（与 baseUrl 拼成完整 URL；函数形式保证每次实时读取，R-10） */
    path: () => string;
    /** 请求体字段映射（第 3 类差异） */
    body: (args: A) => unknown;
    /** 响应字段 → 内部结构（第 4 类差异） */
    parse: (raw: unknown) => R;
}

export interface ProviderDef {
    id: string;
    label: string;
    /** 该供应商密钥对应的环境变量名（R-16 文案必须指明具体变量名） */
    keyEnv: string;
    /** 密钥取值（R-11：按供应商独立，空串 = 免鉴权；**不设全局回退**） */
    apiKey: () => string;
    /** 基址（官方地址为默认，可被环境变量覆盖；函数形式保证实时读取） */
    baseUrl: () => string;
    /** 鉴权头形式（第 2 类差异）；密钥为空时必须返回 {}，完全省略鉴权头（R-15） */
    authHeaders: (key: string) => Record<string, string>;
    search?: EndpointDef<SearchArgs, SearchPayload>;
    fetch?: EndpointDef<FetchArgs, FetchPayload>;
}

/** 从对象里按候选键取第一个非空字符串（响应字段映射的容错工具） */
function pickStr(o: Record<string, unknown>, keys: readonly string[]): string {
    for (const k of keys) {
        const v = o[k];
        if (typeof v === "string" && v !== "") return v;
        if (typeof v === "number") return String(v);
    }
    return "";
}

/** 取 URL 的 host（来源站点的兜底值） */
export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "";
    }
}

/**
 * [R-43 / R-44] 日志与错误文案用的端点标识：host + path（**不含 query，不含密钥**）。
 * 存在的理由：旧版日志只有 tool/provider/status，看不出「到底打到了哪个地址」，
 * 端点配错时只能靠猜（本案即因此被两次误判）。
 */
export function endpointOf(url: string): string {
    try {
        const u = new URL(url);
        return `${u.host}${u.pathname}`;
    } catch {
        return "-";
    }
}

/** 安全地把 unknown 视为普通对象 */
function asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 内置供应商：deepseek（§9.1 默认供应商）。
 *
 * ✅ V-R-1 已核实（2026-10-21，依据 DeepSeek 官方「网页搜索与抓取」文档）：
 *      - Search：POST {base}/v1/tools/search，请求体 { query, count, need_content, ... }
 *      - Fetch ：POST {base}/v1/tools/fetch ，请求体 { url }
 *      - 鉴权：Authorization: Bearer <key> + Content-Type: application/json
 *      - Search 响应：{ results: [{ rerank_score, title, url, snippet, summary,
 *                      content, site_name, site_icon, date, authority }] }
 *      - Fetch  响应：{ title, content }（content 为 Markdown 正文）
 *    端点仍保留环境变量覆盖能力（便于接自建网关）：
 *      - 改基址：INTERNET_DEEPSEEK_BASE_URL
 *      - 改路径：INTERNET_DEEPSEEK_SEARCH_PATH / INTERNET_DEEPSEEK_FETCH_PATH
 *
 * ⚠️ 历史缺陷（已修）：旧默认值 `/v1/search`、`/v1/fetch` 在官方并不存在，
 *    网关对未知路由返回 404，被 mapStatus 归为 not_extractable（「网页抓不到」），
 *    导致模型反复更换检索词空转。现修正为 `/v1/tools/search`、`/v1/tools/fetch`。
 *    详见 docs/FIX-internet-endpoint-v0.0.7.md。
 */
const DEEPSEEK: ProviderDef = {
    id: "deepseek",
    label: "DeepSeek",
    keyEnv: "INTERNET_DEEPSEEK_API_KEY",
    apiKey: () => env.INTERNET_DEEPSEEK_API_KEY,
    baseUrl: () => env.INTERNET_DEEPSEEK_BASE_URL,
    // 鉴权头形式：Bearer；空密钥 → {}（R-15：不发送空凭据）
    authHeaders: (key) => (key ? { Authorization: `Bearer ${key}` } : {}),
    search: {
        method: () => "POST",
        path: () => env.INTERNET_DEEPSEEK_SEARCH_PATH,
        // 请求体字段映射：query / count / need_content（R-19：检索语法原样透传，不做拆分）
        //   - count：官方字段名（1–50）。旧实现用 max_results，官方「未知字段忽略」→ 条数静默回落 10，
        //     且结果文本里的「（请求 N 条）」与实际不符。
        //   - need_content=false：不返回网页正文（省带宽）；摘要取 snippet / summary 足够。
        //   - 不上行 ori_question / localization（N-04：不上行用户原始问题与定位信息）。
        body: (a) => ({ query: a.query, count: a.count, need_content: false }),
        // 响应字段映射：兼容 data[] / results[] / 裸数组三种常见形状
        parse: (raw) => {
            const o = asRecord(raw);
            const arr = Array.isArray(o.data)
                ? o.data
                : Array.isArray(o.results)
                  ? o.results
                  : Array.isArray(raw)
                    ? (raw as unknown[])
                    : [];
            const hits: SearchHit[] = [];
            for (const item of arr) {
                const it = asRecord(item);
                const url = pickStr(it, ["url", "link", "href"]);
                if (!url) continue;   // 无链接的条目对模型无用，跳过
                hits.push({
                    title: pickStr(it, ["title", "name"]) || "(无标题)",
                    url,
                    snippet: pickStr(it, ["snippet", "content", "description", "summary"]),
                    publishedAt: pickStr(it, ["published_at", "publishedAt", "date", "publish_time"]),
                    site: pickStr(it, ["site", "source", "site_name"]) || hostOf(url),
                });
            }
            return { hits };
        },
    },
    fetch: {
        method: () => "POST",
        path: () => env.INTERNET_DEEPSEEK_FETCH_PATH,
        // 请求体字段映射：单个 URL（R-28：一次只抓一个）
        body: (a) => ({ url: a.url }),
        // 响应字段映射：兼容 { data: {...} } 包裹与裸对象
        parse: (raw) => {
            const o = asRecord(raw);
            const inner = asRecord(o.data);
            const src = Object.keys(inner).length > 0 ? inner : o;
            return {
                title: pickStr(src, ["title", "name"]),
                text: pickStr(src, ["content", "markdown", "text", "body"]),
            };
        },
    },
};

/**
 * 供应商注册表。
 * R-09：新增一家供应商 = 此处新增一份定义 + 环境变量声明 + 供应商选择项（配置页枚举），
 *       门面文件、工具 schema、工具名、历史格式一律不动。
 */
export const PROVIDERS: Record<string, ProviderDef> = {
    deepseek: DEEPSEEK,
};

/** 合法供应商标识（R-12 文案用） */
export function providerIds(kind?: Kind): string[] {
    return Object.keys(PROVIDERS).filter((id) => {
        if (!kind) return true;
        return PROVIDERS[id]?.[kind] !== undefined;
    });
}

/** 读取当前配置选中的供应商；未识别 → 可读提示并列出合法取值（R-12，不静默失败） */
export function getProvider(
    kind: Kind,
): { provider: ProviderDef } | { error: EnvelopeFail; providerId: string } {
    const envKey = kind === "search" ? "INTERNET_SEARCH_PROVIDER" : "INTERNET_FETCH_PROVIDER";
    const id = (kind === "search" ? env.INTERNET_SEARCH_PROVIDER : env.INTERNET_FETCH_PROVIDER).trim();
    const kindLabel = kind === "search" ? "检索" : "抓取";
    const provider = PROVIDERS[id];
    if (!provider) {
        return {
            providerId: id,
            error: fail(
                "invalid_provider",
                `未识别的${kindLabel}供应商：${id || "(空)"}。合法取值：${providerIds(kind).join(" / ")}。` +
                    `请修改环境变量 ${envKey} 后重试（本问题是配置问题，重试不会成功）。`,
            ),
        };
    }
    if (!provider[kind]) {
        return {
            providerId: id,
            error: fail(
                "invalid_provider",
                `供应商 ${provider.id} 不支持${kindLabel}能力。支持该能力的合法取值：${providerIds(kind).join(" / ")}。` +
                    `请修改环境变量 ${envKey} 后重试。`,
            ),
        };
    }
    return { provider };
}

// ============================================================
// 测试注入点（N-08 / AC-51：测试不得发起真实网络请求）
// ============================================================

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
let sleepImpl: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 注入假上游（传 null 恢复真实 fetch） */
export function setFetchImplForTest(f: FetchLike | null): void {
    fetchImpl = f ?? ((url, init) => fetch(url, init));
}

/** 注入假时钟/跳过退避等待（传 null 恢复真实 setTimeout） */
export function setSleepImplForTest(f: ((ms: number) => Promise<void>) | null): void {
    sleepImpl = f ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

// ============================================================
// 传输层：超时 + 中断 + 重试（R-35 / R-39 / R-40）
// ============================================================

/** 最多重试 2 次（合计最多 3 次请求，R-35 / AC-30） */
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 300;
const RETRY_MAX_MS = 3000;

function joinUrl(base: string, path: string): string {
    const b = base.replace(/\/+$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${b}${p}`;
}

interface RawResult {
    kind: "response" | "timeout" | "cancelled" | "network";
    status?: number;
    headers?: Headers;
    text?: string;
    error?: string;
}

/**
 * 单次请求：超时挂在内部 AbortController 上，用户中断（ctx.signal）转发到同一控制器（R-39/R-40）。
 * 区分「超时」与「用户取消」：前者可重试、后者立即返回 cancelled。
 */
async function requestOnce(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    outer?: AbortSignal,
): Promise<RawResult> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
    }, Math.max(1, timeoutMs));
    const onOuterAbort = () => ctrl.abort();
    if (outer) {
        if (outer.aborted) {
            clearTimeout(timer);
            return { kind: "cancelled" };
        }
        outer.addEventListener("abort", onOuterAbort);
    }
    try {
        const resp = await fetchImpl(url, { ...init, signal: ctrl.signal });
        const text = await resp.text();
        return { kind: "response", status: resp.status, headers: resp.headers, text };
    } catch (err) {
        if (timedOut) return { kind: "timeout" };
        if (outer?.aborted) return { kind: "cancelled" };
        if (err instanceof Error && err.name === "AbortError") return { kind: "cancelled" };
        return { kind: "network", error: err instanceof Error ? err.message : String(err) };
    } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onOuterAbort);
    }
}

/**
 * 状态码 → 结构化错误码 + 可指导行动的文案（§8.5.1）。
 * 关键点：
 *   - 401 恒为 auth_required；403 仅在**密钥为空**时视为 auth_required，否则 blocked_by_policy（R-15）；
 *   - 400 回显上游错误信息，作为模型自我修正的线索（R-36）；
 *   - 所有文案都不含密钥（R-38）。
 */
function mapStatus(
    status: number,
    upstreamText: string,
    provider: ProviderDef,
    keyMissing: boolean,
    kind: Kind | undefined,
    url: string,
): { code: ErrorCode; message: string } {
    const detail = truncate((upstreamText || "").trim(), 300);
    const withDetail = (base: string) => (detail ? `${base} 上游信息：${detail}` : base);
    const keyHint = keyMissing
        ? `当前环境变量 ${provider.keyEnv} 为空，本次请求未携带鉴权头。`
        : `请检查环境变量 ${provider.keyEnv} 的取值是否有效。`;
    const noRetry =
        "这属于配置问题，重试不会成功，请勿重试；若该密钥曾被『清空』，填入有效值即可恢复。";

    switch (status) {
        case 400:
            return {
                code: "invalid_request",
                message: withDetail("参数不合法（400）：请据此修正参数后重试。"),
            };
        case 401:
            return {
                code: "auth_required",
                message: `鉴权失败（auth_required，401）：供应商 ${provider.label} 拒绝当前凭据。${keyHint}${noRetry}`,
            };
        case 402:
            return {
                code: "insufficient_balance",
                message: withDetail(
                    `余额或额度不足（402）：供应商 ${provider.label} 拒绝了本次调用，需充值或提升额度后再试。`,
                ),
            };
        case 403:
            if (keyMissing) {
                return {
                    code: "auth_required",
                    message: `鉴权失败（auth_required，403）：供应商 ${provider.label} 要求鉴权。${keyHint}${noRetry}`,
                };
            }
            return {
                code: "blocked_by_policy",
                message: withDetail(
                    "被安全策略拒绝（blocked_by_policy，403）：目标页面拒绝抓取或供应商拒绝本次请求；可换其他来源，或改用检索摘要作答。",
                ),
            };
        case 404:
            // 404 在两种能力上的语义不同（官方错误表）：
            //   - Fetch ：目标页取不到可用正文（URL 不可用 / 被拦截 / 无可提取 Markdown）→ 原文案正确；
            //   - Search：检索端点不存在（基址或路径配错）远比「搜索无结果」常见——
            //             真实搜索无结果返回的是 200 + 空数组（R-21），**不是** 404。
            //     因此对检索单独补一条「先查端点」的提示，避免模型误判成「网页抓不到」而空转换词。
            if (kind === "search") {
                return {
                    code: "not_extractable",
                    message: withDetail(
                        `检索请求返回 404（not_extractable）：实际请求 ${endpointOf(url)}。` +
                            "搜索引擎不会用 404 表达「没有结果」（那是 200 + 空数组），" +
                            "因此这通常是端点路径与供应商不一致。请核对 INTERNET_DEEPSEEK_BASE_URL 与 " +
                            "INTERNET_DEEPSEEK_SEARCH_PATH（DeepSeek 官方为 /v1/tools/search）后重试；" +
                            "属配置问题，更换检索词不会成功。",
                    ),
                };
            }
            return {
                code: "not_extractable",
                message: withDetail(
                    "无法提取正文（not_extractable，404）：页面可能由 JavaScript 渲染、位于付费墙后或无可读内容。" +
                        "建议改用检索摘要作答；如需完整正文，可后续升级到浏览器类工具。",
                ),
            };
        case 413:
            return {
                code: "too_large",
                message: withDetail("请求体过大（too_large，413）：请缩小请求范围后重试。"),
            };
        case 408:
        case 504:
            return {
                code: "timeout",
                message: withDetail("上游超时（timeout）：可更换检索词或稍后重试。"),
            };
        case 429:
            return {
                code: "rate_limited",
                message: withDetail("被上游限流（rate_limited，429）：请稍后重试。"),
            };
        default:
            if (status >= 500) {
                return {
                    code: "upstream_error",
                    message: withDetail(`上游异常（upstream_error，${status}）。`),
                };
            }
            return {
                code: "upstream_error",
                message: withDetail(`上游返回未预期的状态码 ${status}。`),
            };
    }
}

/** 可重试的错误码：仅超时类与限流类（含 5xx），4xx 业务错误一律不重试（R-35） */
function isRetryable(code: ErrorCode | undefined): boolean {
    return code === "timeout" || code === "rate_limited" || code === "upstream_error";
}

/** 退避时长：优先读 Retry-After（秒），否则指数退避，均设上限 */
function retryDelay(retryAfter: string | null | undefined, attempt: number): number {
    if (retryAfter) {
        const sec = Number(retryAfter);
        if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, RETRY_MAX_MS);
    }
    return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

export interface CallResult {
    ok: boolean;
    code?: ErrorCode;
    message?: string;
    /** 成功时：已解析的响应对象 */
    raw?: unknown;
    /** 实际重试次数（0 表示一次成功） */
    retries: number;
    /** 最终请求的完整 URL（日志用，不含密钥） */
    url: string;
}

/**
 * 统一调用：按供应商 + 端点发请求，带超时、中断、重试与错误映射。
 * 本函数**不抛异常**（网络层异常也被转换为 upstream_error 信封）。
 */
export async function callProvider<A, R>(
    provider: ProviderDef,
    endpoint: EndpointDef<A, R>,
    args: A,
    ctx: ToolContext | undefined,
    /** 能力类别：仅用于错误文案分化（检索 404 指向端点配置，抓取 404 指向页面） */
    kind?: Kind,
): Promise<CallResult> {
    const key = provider.apiKey();
    const keyMissing = key === "";                       // R-11：空串 = 免鉴权
    const url = joinUrl(provider.baseUrl(), endpoint.path());
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...provider.authHeaders(key),                    // R-15：空密钥 → {}，完全省略鉴权头
    };
    const method = endpoint.method();
    const body = method === "GET" ? undefined : JSON.stringify(endpoint.body(args));
    const timeoutMs = env.INTERNET_TIMEOUT_MS;

    let retries = 0;
    let last: CallResult = { ok: false, retries: 0, url };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // 用户已点「停止」：不再发起请求，也不追加后续消息（R-40）
        if (ctx?.signal?.aborted) {
            return {
                ok: false,
                code: "cancelled",
                message: "已取消：用户已停止本次回答，联网请求未发出。",
                retries,
                url,
            };
        }

        const r = await requestOnce(url, { method, headers, body }, timeoutMs, ctx?.signal);

        if (r.kind === "cancelled") {
            return {
                ok: false,
                code: "cancelled",
                message: "已取消：用户已停止本次回答，联网请求被中止。",
                retries,
                url,
            };
        }
        if (r.kind === "timeout") {
            last = {
                ok: false,
                code: "timeout",
                message: `请求超时（超过 ${timeoutMs}ms 未完成）：可更换检索词或稍后重试。`,
                retries,
                url,
            };
        } else if (r.kind === "network") {
            last = {
                ok: false,
                code: "upstream_error",
                message: `请求上游失败（网络层）：${truncate(r.error || "未知错误", 200)}`,
                retries,
                url,
            };
        } else {
            const status = r.status ?? 0;
            if (status >= 200 && status < 300) {
                const parsed = tryParseJson(r.text ?? "");
                if (parsed === null) {
                    return {
                        ok: false,
                        code: "upstream_error",
                        message: `上游响应不是合法 JSON（状态 ${status}），无法解析结果。`,
                        retries,
                        url,
                    };
                }
                return { ok: true, raw: parsed, retries, url };
            }
            const mapped = mapStatus(status, r.text ?? "", provider, keyMissing, kind, url);
            last = { ok: false, code: mapped.code, message: mapped.message, retries, url };
        }

        if (!isRetryable(last.code) || attempt === MAX_RETRIES) break;
        retries++;
        await sleepImpl(retryDelay(r.headers?.get?.("retry-after"), attempt));
    }

    // 重试过则在文案里注明次数（AC-30 要求「已重试 N 次」的明确提示）
    if (!last.ok && retries > 0 && last.message) {
        last.message = `${last.message}（已重试 ${retries} 次）`;
    }
    return last;
}

// ============================================================
// 文本工具与日志（R-43 / R-44）
// ============================================================

/** 截断到 max 字符（含省略号），用于摘要与错误详情 */
export function truncate(text: string, max: number, suffix = "…"): string {
    if (!Number.isFinite(max) || max <= 0) return text;
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** [R-44] 日志中的检索词只保留前缀（不落完整检索词，更不落密钥） */
export function previewQuery(query: string, keep = 12): string {
    const q = query.replace(/\s+/g, " ").trim();
    return q.length <= keep ? q : `${q.slice(0, keep)}…`;
}

export interface CallLogFields {
    tool: "search" | "fetch";
    provider: string;
    status: "ok" | "error";
    elapsedMs: number;
    /** 检索条数；抓取为 null */
    resultCount: number | null;
    /** 回灌给模型的文本字符数 */
    textChars: number;
    code: string | null;
    retried: boolean;
    cacheHit: boolean;
    /**
     * [修订] 本次实际请求的端点（host + path，不含 query 与密钥）；本地未发请求（如续读命中暂存）时为 null。
     * 旧版日志不含 URL，端点配错时只能靠猜（见 docs/FIX-internet-endpoint-v0.0.7.md）。
     */
    endpoint?: string | null;
}

/** [R-43] 每次调用输出一行结构化日志；[R-44] 密钥永不落日志（本函数不接受密钥入参） */
export function logCall(f: CallLogFields): void {
    const line = [
        "[R-43] internet",
        `tool=${f.tool}`,
        `provider=${f.provider}`,
        `endpoint=${f.endpoint ?? "-"}`,
        `status=${f.status}`,
        `elapsed=${f.elapsedMs}ms`,
        `results=${f.resultCount === null ? "-" : f.resultCount}`,
        `chars=${f.textChars}`,
        `code=${f.code ?? "-"}`,
        `retried=${f.retried ? "yes" : "no"}`,
        `cache=${f.cacheHit ? "hit" : "miss"}`,
    ].join("｜");
    console.log(line);
}
