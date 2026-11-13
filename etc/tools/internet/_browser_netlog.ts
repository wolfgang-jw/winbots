/**
 * etc/tools/internet/_browser_netlog.ts
 * 网络抓包：CDP Network 域事件订阅、环形缓冲、按标签过滤、正文按需拉取
 *
 * [新增需求] 让浏览器工具具备「抓包」能力：模型可读取页面发出的真实请求
 *   （URL / 方法 / 状态码 / 请求头 / 响应头 / 请求体 / 响应体片段 / 时序）。
 *
 * 设计要点（逐条对应既有代码的约束，改动前请先读这里）：
 *   ① Network.enable 是**页面级**命令：必须像 Fetch.enable 一样在 initTab→enableTabPolicies
 *      里逐标签开启，否则新标签/弹窗的请求一个都抓不到（与 BR-24/BR-52 同一个坑）。
 *   ② 事件监听必须**先于** Network.enable 注册（与 P-32 同一顺序要求），否则开抓瞬间的
 *      那批请求无人接收，丢首屏。
 *   ③ 响应正文只能在**请求结束之后**用 Network.getResponseBody 拉，且必须带该请求所属标签的
 *      sessionId —— 切标签后活跃标签已变，用 cmd() 会拉错标签的正文（静默错页）。
 *   ④ 缓冲是**有界**的（环形），且正文默认**不落缓冲**：只存 requestId，读取时按需拉取，
 *      避免长会话把内存撑爆、也避免把敏感响应体长期留在进程里。
 *   ⑤ 抓包是**只读**能力：不拦截、不修改、不重放任何请求，与 Fetch 的放行/阻断互不干扰。
 *      （Network.enable 与 Fetch.enable 可同时开启，Chrome 允许，二者职责不同。）
 *   ⑥ 本模块被 _browser_driver.ts 引用，属于**私有模块**：改动后必须重启进程才生效。
 */

export interface NetEntry {
  /** CDP requestId（仅在本次会话内有效） */
  id: string;
  /** 发出该请求的标签 */
  targetSessionId: string;
  url: string;
  method: string;
  /** 请求资源类型：document / xhr / fetch / script / image ... */
  resourceType: string;
  /** 请求开始时间（Unix ms） */
  startedAt: number;
  /** 结束时间（Unix ms）；0 表示尚未结束（进行中） */
  endedAt: number;
  status: number;
  statusText: string;
  mimeType: string;
  /** 请求头（已脱敏：Cookie / Authorization 等只保留是否存在） */
  requestHeaders: Record<string, string>;
  /** 响应头（已脱敏） */
  responseHeaders: Record<string, string>;
  /** 请求体（仅文本类，已截断；二进制/超大不保留） */
  requestBody: string;
  /** 请求体被省略的原因；空串表示没有省略 */
  requestBodyOmit: string;
  /** 失败原因（CDP loadingFailed 的 errorText）；空串表示未失败 */
  failed: string;
  /** 发起者类型（script / parser / preflight ...） */
  initiator: string;
}

/** 单条请求体 / 正文缓存上限（字符）；超出只保留前缀并标注 */
const BODY_KEEP_MAX = 8_000;
/** 请求头里需要脱敏的字段（小写比较） */
const SECRET_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

function lower(k: string): string {
  return k.toLowerCase();
}

/** 头部脱敏：只保留「有/无」，不把凭证回灌给模型 */
export function maskHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (SECRET_HEADERS.has(lower(k))) {
      out[k] = "«已脱敏»";
    } else {
      out[k] = String(v).slice(0, 300);
    }
  }
  return out;
}

/**
 * 有界环形缓冲。
 * 用数组 + 覆盖最旧元素（而非 shift）避免 O(n) 搬移；逻辑顺序用游标还原。
 */
export class NetRing {
  private readonly cap: number;
  private items: NetEntry[] = [];
  private byId = new Map<string, NetEntry>();
  /** 单调递增序号：用于「只要新增」的增量读取 */
  private seq = 0;

  constructor(capacity: number) {
    this.cap = Math.max(10, Math.min(2000, Math.trunc(capacity) || 300));
  }

  get capacity(): number {
    return this.cap;
  }

  get size(): number {
    return this.items.length;
  }

  /** 追加一条；返回其 seq（供增量游标） */
  push(e: NetEntry): number {
    this.items.push(e);
    this.byId.set(e.id, e);
    if (this.items.length > this.cap) {
      const dropped = this.items.splice(0, this.items.length - this.cap);
      for (const d of dropped) {
        // 只在该 id 仍指向被丢弃的那条时才删（避免误删同 id 的新条目）
        if (this.byId.get(d.id) === d) this.byId.delete(d.id);
      }
    }
    this.seq += 1;
    return this.seq;
  }

  get(id: string): NetEntry | undefined {
    return this.byId.get(id);
  }

  /** 逻辑顺序快照（旧 → 新） */
  all(): NetEntry[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
    this.byId.clear();
    // D-7：游标必须随缓冲一起归零。否则 clear 后 cursor 仍是旧值，
    // 模型拿旧 cursor 去 after_seq 增量读时，since() 会静默返回空数组
    // （oldestSeq = seq+1 使 afterSeq+1 < oldestSeq 为假，skip 取到末尾），
    // 表现为“抓包明明有新请求却读不到”，且没有任何报错。
    this.seq = 0;
  }

  /**
   * 取「比 afterSeq 更新的」条目。
   * 缓冲是环形的，afterSeq 可能已被覆盖 → 此时退化为返回全部（并让调用方据 truncated 判断）。
   */
  since(afterSeq: number): { list: NetEntry[]; dropped: boolean } {
    const total = this.seq;
    const have = this.items.length;
    const oldestSeq = total - have + 1;
    if (afterSeq <= 0) return { list: this.all(), dropped: false };
    if (afterSeq + 1 < oldestSeq) {
      return { list: this.all(), dropped: true };
    }
    const skip = afterSeq + 1 - oldestSeq;
    return { list: this.items.slice(Math.max(0, skip)), dropped: false };
  }

  get cursor(): number {
    return this.seq;
  }
}

/**
 * 抓包会话状态：每会话一份，挂在 BrowserDriver 私有字段上。
 *
 * ⚠️ 为什么不挂在 Session 上：抓包必须在**驱动层**接收 CDP 事件（事件只在 CdpConnection 上），
 *   而 Session 层拿不到事件。驱动是每会话一个实例，挂在这里等价于每会话一份。
 */
export class NetCapture {
  readonly ring: NetRing;
  /** 是否已对某个标签执行过 Network.enable */
  private enabledTabs = new Set<string>();
  /** 每个标签收到的响应体拉取开关（按需；见 captureBody） */
  private bodyWanted = new Set<string>();

  constructor(capacity: number) {
    this.ring = new NetRing(capacity);
  }

  markEnabled(sessionId: string): void {
    this.enabledTabs.add(sessionId);
  }

  isEnabled(sessionId: string): boolean {
    return this.enabledTabs.has(sessionId);
  }

  wantBodyOf(requestId: string): void {
    this.bodyWanted.add(requestId);
  }

  bodyWantedOf(requestId: string): boolean {
    return this.bodyWanted.has(requestId);
  }

  clearBodyWants(): void {
    this.bodyWanted.clear();
  }
}

/** 从 CDP 的 Network.requestWillBeSent 事件里取一条新条目 */
export function entryFromRequestWillBeSent(
  params: Record<string, unknown>,
  targetSessionId: string,
  now: number,
): NetEntry | null {
  const requestId = typeof params.requestId === "string" ? params.requestId : "";
  const req = (params.request as Record<string, unknown> | undefined) ?? {};
  const url = typeof req.url === "string" ? req.url : "";
  if (!requestId || !url) return null;

  const method = typeof req.method === "string" ? req.method : "GET";
  const resourceType = typeof params.type === "string" ? params.type : "";
  const postData = typeof req.postData === "string" ? req.postData : "";
  let requestBody = "";
  let requestBodyOmit = "";
  if (postData) {
    if (postData.length > BODY_KEEP_MAX) {
      requestBody = postData.slice(0, BODY_KEEP_MAX);
      requestBodyOmit = `请求体过长（${postData.length} 字符），只保留前 ${BODY_KEEP_MAX} 字符`;
    } else {
      requestBody = postData;
    }
  } else if (params.hasPostData === true) {
    requestBodyOmit = "请求体为二进制或大型表单数据，未保留";
  }

  const headers = maskHeaders(req.headers as Record<string, unknown> | undefined);

  return {
    id: requestId,
    targetSessionId,
    url,
    method,
    resourceType,
    startedAt: Math.round(
      typeof params.wallTime === "number" ? params.wallTime * 1000 : now,
    ),
    endedAt: 0,
    status: 0,
    statusText: "",
    mimeType: "",
    requestHeaders: headers,
    responseHeaders: {},
    requestBody,
    requestBodyOmit,
    failed: "",
    initiator: describeInitiator(params.initiator),
  };
}

function describeInitiator(raw: unknown): string {
  const o = raw as { type?: unknown } | undefined;
  const t = typeof o?.type === "string" ? o.type : "";
  return t;
}

/** 从 Network.responseReceived 里把状态码/头/类型补进条目 */
export function applyResponse(
  entry: NetEntry,
  params: Record<string, unknown>,
  now: number,
): void {
  const resp = (params.response as Record<string, unknown> | undefined) ?? {};
  entry.status = typeof resp.status === "number" ? resp.status : 0;
  entry.statusText = typeof resp.statusText === "string" ? resp.statusText : "";
  entry.mimeType = typeof resp.mimeType === "string" ? resp.mimeType : "";
  entry.responseHeaders = maskHeaders(resp.headers as Record<string, unknown> | undefined);
  if (typeof params.type === "string" && params.type) entry.resourceType = params.type;
  if (!entry.endedAt) entry.endedAt = now;
}

/** 判断某条响应是否值得拉正文（避免去拉图片/字体等二进制） */
export function isTextual(mime: string): boolean {
  const m = mime.toLowerCase();
  if (!m) return false;
  return (
    m.includes("json") ||
    m.includes("text") ||
    m.includes("xml") ||
    m.includes("javascript") ||
    m.includes("x-www-form-urlencoded") ||
    m.includes("graphql")
  );
}
