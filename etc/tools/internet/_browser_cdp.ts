/**
 * etc/tools/internet/_browser_cdp.ts
 * 调试协议传输：连接、请求应答配对、事件订阅、断开检测
 *
 * [需求] BR-09 零第三方依赖；BR-42 在途命令可被放弃；BR-41 连接断开即可见
 * [设计] §3.3-1/2/10、§4「结束顺序①」
 *
 * 说明：运行时自带 WebSocket（Bun 全局对象），因此「帧编解码」由运行时承担，
 *       本文件只做 JSON 消息层面的配对与分发。
 */

export type CdpListener = (params: Record<string, unknown>, sessionId?: string) => void;

/** 连接已关闭时抛出的错误（上层据此归一为「会话失效」而不是普通超时） */
export class CdpClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CdpClosedError";
  }
}

interface PendingEntry {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CdpConnection {
  private readonly ws: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly listeners = new Map<string, Set<CdpListener>>();
  private readonly anyListeners = new Set<CdpListener>();
  private closed = false;
  private closeReason = "";

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev: unknown) => {
      const data = (ev as { data?: unknown }).data;
      this.onMessage(typeof data === "string" ? data : "");
    });
    this.ws.addEventListener("close", () => this.markClosed("连接被关闭"));
    this.ws.addEventListener("error", () => this.markClosed("连接出错"));
  }

  /** 建立连接（带超时；失败即启动/会话失效的上游原因） */
  static open(wsUrl: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise<CdpConnection>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`连接调试地址超时（${timeoutMs}ms）`));
      }, Math.max(1000, timeoutMs));

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("调试地址连接失败（可能被安全策略拦截）"));
      });
      ws.addEventListener("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("调试地址连接被关闭"));
      });
    });
  }

  /** 发一条命令并等待其应答（`sessionId` 用于扁平会话的多目标区分） */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new CdpClosedError(this.closeReason || "连接已关闭"));
    }
    const id = ++this.seq;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const limit = Math.max(1000, timeoutMs);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调试命令超时（${limit}ms）：${method}`));
      }, limit);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 订阅某事件；返回取消订阅函数 */
  on(method: string, listener: CdpListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set<CdpListener>();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** 订阅全部事件（调试/兜底用） */
  onAny(listener: CdpListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get reasonOfClose(): string {
    return this.closeReason;
  }

  /** 主动关闭（会拒绝所有在途命令，并广播 `__closed__`） */
  close(reason = "主动关闭"): void {
    this.markClosed(reason);
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new CdpClosedError(reason));
    }
    this.pending.clear();
    this.dispatch("__closed__", { reason }, undefined);
  }

  private onMessage(raw: string): void {
    if (!raw) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // 非法帧直接丢弃，不影响连接
    }

    const idRaw = msg.id;
    if (typeof idRaw === "number") {
      const entry = this.pending.get(idRaw);
      if (!entry) return;
      this.pending.delete(idRaw);
      if (entry.timer) clearTimeout(entry.timer);
      const errObj = msg.error as { message?: string } | undefined;
      if (errObj) {
        entry.reject(new Error(`${entry.method} 失败：${String(errObj.message ?? "未知原因")}`));
        return;
      }
      const result = (msg.result as Record<string, unknown>) ?? {};
      entry.resolve(result);
      return;
    }

    const method = typeof msg.method === "string" ? msg.method : "";
    if (!method) return;
    const params = (msg.params as Record<string, unknown>) ?? {};
    const sid = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    this.dispatch(method, params, sid);
  }

  private dispatch(method: string, params: Record<string, unknown>, sid: string | undefined): void {
    const set = this.listeners.get(method);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(params, sid);
        } catch (err) {
          console.warn(`⚠️ [browser] 事件处理抛错（已忽略）: ${method}`, err);
        }
      }
    }
    for (const fn of [...this.anyListeners]) {
      try {
        fn(params, sid);
      } catch {
        /* ignore */
      }
    }
  }
}
