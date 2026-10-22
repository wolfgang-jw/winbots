/**
 * etc/tools/internet/_browser_policy.ts
 * 请求层判定 + 域名名单 + 私有网段 + 脱敏
 *
 * [需求] BR-52 请求层拦截；BR-53 名单（白名单空=不限制但仍拦私网）；BR-57/BR-60 脱敏
 * [设计] §10.1 判定顺序、§10.2 名单、§10.6 脱敏；D-08（新增黑名单项）
 */
import { lookup as dnsLookupCb } from "node:dns";
import { env } from "@/infra/env";
import { truncate } from "./_common";

export type BlockReason =
  | "protocol"
  | "credentials"
  | "ip_private"
  | "blocklist"
  | "not_allowlisted"
  | "dns_private";

export interface Verdict {
  blocked: boolean;
  reason?: BlockReason;
}

const ALLOW: Verdict = Object.freeze({ blocked: false }) as Verdict;
const deny = (reason: BlockReason): Verdict => ({ blocked: true, reason });

/** 页面内资源协议：放行（不是网络访问） */
const INLINE_SCHEMES = new Set<string>(["data:", "blob:", "about:", "javascript:"]);

// ============================================================
// 名单解析（BR-53 / 设计 13.2-4）
// ============================================================

const listCache = new Map<string, string[]>();

/** 按逗号切分、去空白、去重、转小写；非法项告警但不阻断启动 */
export function parseHostList(raw: string): string[] {
  const out: string[] = [];
  for (const seg of String(raw ?? "").split(",")) {
    const h = seg.trim().toLowerCase().replace(/^\.+/, "");
    if (!h) continue;
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)) {
      console.warn(`⚠️ [browser] 域名名单项非法，已忽略: ${h}`);
      continue;
    }
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

function cachedList(raw: string): string[] {
  const key = String(raw ?? "");
  let v = listCache.get(key);
  if (!v) {
    v = parseHostList(key);
    listCache.set(key, v);
  }
  return v;
}

/** 后缀匹配：`example.com` 命中自身与子域，不命中 `notexample.com` */
export function matchHostList(host: string, list: readonly string[]): boolean {
  const h = String(host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!h) return false;
  for (const item of list) {
    if (h === item || h.endsWith(`.${item}`)) return true;
  }
  return false;
}

// ============================================================
// 私有/回环/链路本地判定（BR-52）
// ============================================================

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".").map((x) => Number(x));
  if (p.length !== 4) return null;
  if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}

/** [回环 127/8][私有 10/8、172.16/12、192.168/16][链路本地 169.254/16][CGNAT 100.64/10][未指定 0/8] */
const V4_RANGES: Array<{ base: number; mask: number }> = [
  { base: ipv4ToInt("127.0.0.0")!, mask: 8 },
  { base: ipv4ToInt("10.0.0.0")!, mask: 8 },
  { base: ipv4ToInt("172.16.0.0")!, mask: 12 },
  { base: ipv4ToInt("192.168.0.0")!, mask: 16 },
  { base: ipv4ToInt("169.254.0.0")!, mask: 16 },
  { base: ipv4ToInt("100.64.0.0")!, mask: 10 },
  { base: ipv4ToInt("0.0.0.0")!, mask: 8 },
  { base: ipv4ToInt("192.0.0.0")!, mask: 24 },
  { base: ipv4ToInt("198.18.0.0")!, mask: 15 },
];

/** 解析不了的一律按不安全处理（宁可误拦，不放行） */
export function isPrivateAddress(ip: string): boolean {
  const v = String(ip ?? "").trim().toLowerCase();
  if (!v) return true;

  if (v.includes(":")) {
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80")) return true; // 链路本地
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // ULA fc00::/7
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!); // IPv4 映射
    return false;
  }

  const n = ipv4ToInt(v);
  if (n === null) return true; // 非法 IP 按不安全
  for (const r of V4_RANGES) {
    const size = 2 ** (32 - r.mask);
    const start = Math.floor(r.base / size) * size;
    if (n >= start && n < start + size) return true;
  }
  return false;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

// ============================================================
// 入参预检（同步，不解析 DNS；用于 act/open 的本地拒绝）
// ============================================================

export interface PrecheckOk {
  ok: true;
  url: string;
  host: string;
}

export interface PrecheckFail {
  ok: false;
  verdict: Verdict;
  host: string;
  detail: string;
}

/**
 * [BR-60 / BR-52 / BR-53] 入参 URL 预检：协议 → 凭据 → IP 字面量 → 黑名单 → 白名单。
 * 不做 DNS（DNS 判定在请求层做，避免一次校验拖慢本地拒绝）。
 */
export function precheckUrl(
  raw: unknown,
  opts: { allowNonHttp?: boolean } = {},
): PrecheckOk | PrecheckFail {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, verdict: deny("protocol"), host: "", detail: "地址为空" };
  if (text.length > 8192) {
    return { ok: false, verdict: deny("protocol"), host: "", detail: "地址过长（>8192 字符）" };
  }

  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, verdict: deny("protocol"), host: "", detail: "地址无法解析为合法 URL" };
  }

  // ① 协议
  const proto = u.protocol.toLowerCase();
  if (opts.allowNonHttp && INLINE_SCHEMES.has(proto)) {
    return { ok: true, url: text, host: u.hostname };
  }
  if (proto !== "http:" && proto !== "https:") {
    return {
      ok: false,
      verdict: deny("protocol"),
      host: u.hostname,
      detail: `仅支持 http/https 地址（当前 ${proto || "未知"}）`,
    };
  }

  // ② 凭据（BR-60：地址里不得带用户名/密码）
  if (u.username || u.password) {
    return {
      ok: false,
      verdict: deny("credentials"),
      host: u.hostname,
      detail: "地址中不得包含用户名或密码",
    };
  }

  const host = u.hostname.toLowerCase();

  // ③ IP 字面量
  if (isIpLiteral(host) && env.BROWSER_BLOCK_PRIVATE_NET && isPrivateAddress(host)) {
    return {
      ok: false,
      verdict: deny("ip_private"),
      host,
      detail: `目标为内网/回环地址（${host}）`,
    };
  }

  // ④ 黑名单优先（BR-53）
  if (matchHostList(host, cachedList(env.BROWSER_DOMAIN_BLOCKLIST))) {
    return { ok: false, verdict: deny("blocklist"), host, detail: `主机 ${host} 命中域名黑名单` };
  }

  // ⑤ 白名单非空且不匹配
  const allow = cachedList(env.BROWSER_DOMAIN_ALLOWLIST);
  if (allow.length > 0 && !matchHostList(host, allow)) {
    return { ok: false, verdict: deny("not_allowlisted"), host, detail: `主机 ${host} 不在域名白名单内` };
  }

  return { ok: true, url: text, host };
}

// ============================================================
// 请求层判定（每个请求都过；含 DNS 缓存）
// ============================================================

type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = (host) =>
  new Promise<string[]>((resolve, reject) => {
    dnsLookupCb(host, { all: true }, (err: unknown, addrs: unknown) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const list = Array.isArray(addrs) ? addrs : [];
      const ips = list
        .map((a) => (typeof a === "string" ? a : String((a as { address?: string }).address ?? "")))
        .filter((s) => s.length > 0);
      resolve(ips);
    });
  });

let resolver: Resolver = defaultResolver;

/** [NB-04] DNS 注入点：用例据此断言「内网域名被拦」而不真的解析 */
export function setResolverForTest(f: Resolver | null): void {
  resolver = f ?? defaultResolver;
  dnsCache.clear();
}

const DNS_TTL_MS = 60_000;
const dnsCache = new Map<string, { ips: string[] | null; at: number }>();

async function resolveCached(host: string): Promise<string[] | null> {
  const hit = dnsCache.get(host);
  const t = Date.now();
  if (hit && t - hit.at < DNS_TTL_MS) return hit.ips;
  try {
    const ips = await resolver(host);
    dnsCache.set(host, { ips, at: t });
    return ips;
  } catch {
    dnsCache.set(host, { ips: null, at: t }); // 解析失败缓存空，避免每个请求都打 DNS
    return null;
  }
}

/**
 * [BR-52] 逐个请求判定（判定顺序即设计 §10.1）。
 * data/blob/about 放行（页面内资源）；其余协议拒绝。
 */
export async function judgeRequestUrl(raw: string): Promise<Verdict> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return deny("protocol");
  }
  const proto = u.protocol.toLowerCase();
  if (INLINE_SCHEMES.has(proto)) return ALLOW;
  if (proto !== "http:" && proto !== "https:") return deny("protocol");

  const host = u.hostname.toLowerCase();

  // IP 字面量：无需 DNS
  if (isIpLiteral(host)) {
    if (env.BROWSER_BLOCK_PRIVATE_NET && isPrivateAddress(host)) return deny("ip_private");
    return ALLOW;
  }

  const block = cachedList(env.BROWSER_DOMAIN_BLOCKLIST);
  if (block.length > 0 && matchHostList(host, block)) return deny("blocklist");
  const allow = cachedList(env.BROWSER_DOMAIN_ALLOWLIST);
  if (allow.length > 0 && !matchHostList(host, allow)) return deny("not_allowlisted");

  // 私有网段阻断：解析主机名后判定（DNS 重绑定只能尽力，登记为已知缺口）
  if (env.BROWSER_BLOCK_PRIVATE_NET) {
    const ips = await resolveCached(host);
    if (ips && ips.some((ip) => isPrivateAddress(ip))) return deny("dns_private");
  }
  return ALLOW;
}

/** 请求层命中时的中文原因（写审计日志与结果追加行都要用） */
export function reasonLabel(reason?: BlockReason): string {
  switch (reason) {
    case "protocol":
      return "协议不允许";
    case "credentials":
      return "地址含凭据";
    case "ip_private":
      return "内网/回环地址";
    case "blocklist":
      return "域名黑名单";
    case "not_allowlisted":
      return "不在域名白名单";
    case "dns_private":
      return "解析到内网地址";
    default:
      return "策略阻断";
  }
}

// ============================================================
// 脱敏（BR-57 / BR-60 / BR-50）
// ============================================================

/** [BR-57] 日志里的 URL 只保留 host + path（不带 query，防令牌泄露） */
export function urlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return "-";
  }
}

/**
 * [BR-57] 会话内密码明文精确替换（精确匹配，不做通配，避免误伤正文）。
 * 只在「整形文本 / 写日志 / 拼错误文案」前调用。
 */
export function createMasker(secrets: Iterable<string>): (text: string) => string {
  const list = [...secrets].filter((s) => typeof s === "string" && s.length >= 4);
  if (list.length === 0) return (t) => t;
  return (text: string) => {
    let out = text;
    for (const s of list) out = out.split(s).join("****");
    return out;
  };
}

/** [BR-50] 日志里的输入文本只保留前 20 字符 */
export function previewText(text: string, keep = 20): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= keep ? t : `${t.slice(0, keep)}…`;
}

/** 结果文本里其它输入框的值统一 40 字符截断（BR-29） */
export function previewValue(value: string, keep = 40): string {
  return truncate(String(value ?? ""), keep);
}

// ============================================================
// 下载 / 上传（BR-54）
// ============================================================

export function downloadAllowed(): boolean {
  return env.BROWSER_ALLOW_DOWNLOAD === true;
}

export function uploadAllowed(): boolean {
  return env.BROWSER_ALLOW_UPLOAD === true;
}
