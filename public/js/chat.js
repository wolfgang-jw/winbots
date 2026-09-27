/**
 * Bots AI 对话 - 前端逻辑
 *
 * 职责：
 * 1. 管理聊天界面交互（输入、发送、清空）
 * 2. 通过 Fetch API 的流式读取（ReadableStream）消费 SSE 数据
 * 3. 实时渲染流式文本到消息气泡
 * 4. 支持 Markdown 风格的代码块渲染
 * 5. 显示使用统计信息
 * 6. R3 回答可观测性：三段结构（思考 / 回答 / 信息栏）+ 会话汇总
 * 7. R1 工具调用可见：新增第 4 段「工具调用」（默认收起）
 * 8. R2 界面细节修正：删除默认问题行、固定行宽、折叠联动修正
 * 9. US-2.1 会话唯一标识：新建会话时获取唯一 sessionId 并随请求携带
 * 10. US-2.2 服务端持有会话历史：发送单条 message，历史由服务端持有
 * 11. US-2.3 会话隔离：当前会话 ID 用 sessionStorage 做标签页级隔离
 * 12. US-3.1 打断入口：AI 输出中提供「停止」入口（显隐联动 + 触发点）
 * 13. US-3.2 优雅停止：打断后不切断本地流，继续接收在途数据直至排空完成
 * 14. US-3.3 上游取消：打断时另发带外取消请求，取消上游模型请求（停止未来）
 * 15. US-3.4 打断状态提示：打断过程/结果以「已停止」提示，显式非错误样式
 * 16. US-3.5 打断内容保留与状态复位：收尾时统一清理流式引用，保证旧内容保留、新消息不串入旧气泡
 * 17. US-3.6 打断 usage 记 0 与信息栏：被打断回答补「已中断」信息栏，usage 记 0 且不累加
 * 18. US-3.7 防重复收尾：新增 completed 幂等标记 + finalizeOnce 统一收尾入口，保证同一次回答只收尾一次
 * 19. US-3.8 排空超时兜底：新增 drainTimedOut 显式超时标记，使「排空超时」可识别、可观测、可断言
 */

(function () {
    "use strict";

    // ============================================
    // 配置常量
    // ============================================
    const CONFIG = {
        API_ENDPOINT: "/api/chat/stream",
        SESSION_ENDPOINT: "/api/chat/session",   // [US-2.1] 会话 ID 获取接口
        MAX_HISTORY: 20, // 保留的最大消息历史数（US-2.2 起仅用于本地渲染）
        // [US-2.2] 请求体改为 { sessionId, message }，历史由服务端持有
        // [US-2.3] 当前活跃会话 ID 的存储键。
        // 使用 sessionStorage（标签页级隔离）而非 localStorage（跨标签页共享），
        // 确保同一浏览器多标签页各自持有独立会话，避免串会话（F1-3）。
        SESSION_STORAGE_KEY: "winbots.currentSessionId",
        // [US-3.2] 打断后排空超时（毫秒）。
        // 语义：用户点击"停止"后，前端不切断本地流，继续接收在途数据；
        //       若在此时长内仍未读到流结束（服务端未关流），则强制收尾，避免界面卡死。
        // 取值：需求文档"待确认事项 4"建议 3000ms。
        DRAIN_TIMEOUT_MS: 3000,
        // [US-3.3] 带外取消接口：打断时另发此请求，取消对应上游模型请求（止损）。
        CANCEL_ENDPOINT: "/api/chat/cancel",
    };

    // ============================================
    // DOM 缓存
    // ============================================
    const $dom = {
        messages: document.getElementById("chat-messages"),
        empty: document.getElementById("chat-empty"),
        input: document.getElementById("chat-input"),
        sendBtn: document.getElementById("chat-send-btn"),
        stopBtn: document.getElementById("chat-stop-btn"),   // [US-3.1] 打断入口
        status: document.getElementById("chat-status"),
        usage: document.getElementById("chat-usage"),
        // R2-1：已删除默认问题行（#chat-suggestions），此处不再缓存其引用
    };

    // ============================================
    // 状态管理
    // ============================================
    const state = {
        /** @type {string|null} 当前会话的唯一标识（US-2.1） */
        sessionId: null,
        /** @type {Array<{role:string, content:string}>} 消息历史 */
        history: [],
        /** @type {boolean} 是否正在接收流式响应 */
        isStreaming: false,
        /** @type {AbortController|null} 用于取消请求 */
        abortController: null,
        /** @type {boolean} [US-3.1] 用户是否已请求打断（打断入口标志） */
        stopRequested: false,
        /**
         * @type {boolean} [US-3.2] 是否处于"排空态"。
         * 语义：已请求打断，正在继续接收并显示在途数据（③④⑤ 段），
         *       直至读取到流结束（done）或排空超时。
         * 默认 false；打断时置 true；收尾时复位 false。
         */
        draining: false,
        /**
         * @type {boolean} [US-3.8] 是否已发生"排空超时"（显式超时标记）。
         * 语义：与 draining 正交——draining 表示"用户是否打断"，本字段表示
         *       "打断后是否已超过排空超时被强制收尾"。
         *   - 打断时随 draining 一并保持 false；仅在超时回调中置 true；
         *   - catch 的 AbortError 分支据此判定"超时中断"，稳定走打断收尾
         *     （渲染"已中断"信息栏），不因 draining 的时序复位而丢失；
         *   - finally 复位为 false，保证下一轮干净。
         * 与 draining 的区别：draining 决定"以何种方式收尾"，本字段决定
         *   "是否由超时触发收尾"，二者语义正交、不可互相替代。
         */
        drainTimedOut: false,
        /**
         * @type {ReturnType<typeof setTimeout>|null} [US-3.2] 排空超时计时器句柄。
         * 打断时启动；排空完成/超时/收尾时清理，避免定时器泄漏。
         */
        drainTimer: null,
        /**
         * @type {string|null} [US-3.3] 本次对话请求的唯一标识（requestId）。
         * 语义：发起 /stream 时生成并随请求体发送；打断时据此调用取消接口，
         *       取消对应的上游模型请求。请求结束后清空。
         */
        currentRequestId: null,
        /** @type {string} 当前正在累积的助手消息 */
        currentAssistantContent: "",
        /**
         * @type {HTMLElement|null} 当前助手消息的根元素（.message）
         * 注意：这是 .message 根节点，真正的气泡是它内部的 .message__bubble。
         * 插入思考段/信息栏时必须下钻到 .message__bubble，否则会插到 .message
         * 上，与头像、气泡一起被 .message 的横向 flex 排成一行。
         */
        currentBubbleEl: null,
        /** @type {HTMLElement|null} 当前思考块元素（无思考内容时为 null） */
        currentThinkEl: null,
        /** @type {string} 当前正在累积的思考内容 */
        currentThinkContent: "",
        /** @type {HTMLElement|null} 当前信息栏元素 */
        currentInfoEl: null,
        /** @type {HTMLElement|null} 当前工具调用段元素（第 4 段） */
        currentToolEl: null,
        /**
         * @type {HTMLElement|null} 当前回答段容器（总开关）
         * @deprecated [US-3.5] 该字段自引入以来从未被赋值/读取/复位，属历史遗留死字段。
         *   回答段容器现由 createMessageEl() 内局部创建（answerEl），无需全局引用。
         *   保留声明仅为避免潜在外部引用报错；建议后续 US 或重构时移除。
         */
        currentAnswerEl: null,
        /**
         * @type {string} [US-3.6] 本次回答的模型名（暂存）。
         * 语义：正常路径由 finish 事件的 raw.model 提供；但"打断路径可能收不到 finish"，
         *       故在流处理中提前暂存，供打断信息栏（F3-9）兜底使用。
         * 每轮回答开始时复位为空串；收尾（finally / sendMessage）一并复位。
         */
        currentModel: "",
        /**
         * @type {boolean} [US-3.7] 本次回答是否已收尾（幂等标记，防重复收尾）。
         * 语义：为"同一次回答"引入的显式收尾标记，保证"正常结束"与"打断收尾"
         *       不会对同一次回答重复执行（F3-11）。
         *   - 每轮回答开始时复位为 false（sendStreamRequest 开头）；
         *   - 任一收尾路径经 finalizeOnce() 实际收尾后置为 true；
         *   - 其余收尾路径检测到 true 即跳过，天然幂等；
         *   - finally 兜底复位为 false，保证下一轮干净。
         * 与 draining 的区别：draining 决定"以何种方式收尾"（正常/打断），
         *   completed 决定"是否还需要收尾"，二者语义正交、不可互相替代。
         */
        completed: false,
        /** @type {number} 本次回答开始时间（performance.now()） */
        currentStartTime: 0,
        /** @type {{count:number, promptTokens:number, completionTokens:number, totalTokens:number, elapsedMs:number}} 会话累计统计 */
        sessionStats: {
            count: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            elapsedMs: 0,
        },
    };

    // ============================================
    // 工具函数
    // ============================================

    /**
     * 转义 HTML 特殊字符，防止 XSS
     * @param {string} text
     * @returns {string}
     */
    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * 简单的 Markdown 渲染（支持代码块和内联代码）
     * @param {string} text - 原始文本
     * @returns {string} - 渲染后的 HTML
     */
    function renderMarkdown(text) {
        if (!text) return "";

        let html = escapeHtml(text);

        // 代码块 ```code``` → <pre><code>
        html = html.replace(
            /```(\w*)\n([\s\S]*?)```/g,
            (_, lang, code) => {
                const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
                return `<pre><code${langClass}>${code.trim()}</code></pre>`;
            }
        );

        // 内联代码 `code` → <code>
        html = html.replace(/`([^`]+)`/g, (_, code) => {
            return `<code>${escapeHtml(code)}</code>`;
        });

        // 换行转 <br>
        html = html.replace(/\n/g, "<br>");

        return html;
    }

    /**
     * 格式化 Token 使用统计
     * @param {{promptTokens:number, completionTokens:number, totalTokens:number}} usage
     * @returns {string}
     */
    function formatUsage(usage) {
        if (!usage) return "";
        return `📊 输入: ${usage.promptTokens} tokens · 输出: ${usage.completionTokens} tokens · 共计: ${usage.totalTokens} tokens`;
    }

    /**
     * 获取当前时间字符串
     * @returns {string}
     */
    function getTimeStr() {
        return new Date().toLocaleTimeString("zh-CN");
    }

    /**
     * 格式化时刻为 时:分:秒
     * @param {Date} date
     * @returns {string} 如 "14:32:05"
     */
    function formatClock(date) {
        const p = (n) => String(n).padStart(2, "0");
        return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
    }

    /**
     * 格式化耗时为 X.XXs
     * @param {number} ms - 毫秒
     * @returns {string} 如 "3.21s"
     */
    function formatElapsed(ms) {
        return (ms / 1000).toFixed(2) + "s";
    }

    /**
     * 获取指定 .message 根元素内真正的气泡元素（.message__bubble）
     * 思考段 / 回答段 / 信息栏三段都必须挂在气泡内部，才能随气泡纵向堆叠；
     * 若挂到 .message 上，会与头像、气泡一起被 .message 的横向 flex 排成一行。
     * @param {HTMLElement} messageEl - .message 根元素
     * @returns {HTMLElement} - .message__bubble 元素（找不到时回退为 messageEl）
     */
    function getBubbleOf(messageEl) {
        if (!messageEl) return null;
        return messageEl.querySelector(".message__bubble") || messageEl;
    }

    /**
     * 渲染单条信息栏（第 3 段，默认折叠）
     * @param {HTMLElement} messageEl - 目标消息根元素（.message）
     * @param {{model:string, startTime:Date, elapsedMs:number, usage:object, raw:object, interrupted?:boolean}} info
     * @returns {HTMLElement} - 信息栏元素
     */
    function renderInfoBar(messageEl, info) {
        const el = document.createElement("div");
        el.className = "message__info";
        // [US-3.6] 中断态附加类名，用于样式区分（非错误色，见 style.css）
        if (info.interrupted) {
            el.classList.add("message__info--interrupted");
        }

        // 摘要行（折叠态可见）
        const summary = document.createElement("div");
        summary.className = "message__info-summary";
        // [US-3.6] 中断态：显示"已中断"标识 + token 记 0；正常态：保持原样。
        if (info.interrupted) {
            summary.innerHTML =
                `<span class="message__info-icon">⏹️</span> 已中断`
                + ` · ${escapeHtml(info.model || "unknown")}`
                + ` · ${formatClock(info.startTime)}`
                + ` · ${formatElapsed(info.elapsedMs)}`
                + ` · 📊 0 tokens`
                + `<span class="message__info-arrow">▸</span>`;
        } else {
            summary.innerHTML =
                `<span class="message__info-icon">🤖</span> ${escapeHtml(info.model || "unknown")}`
                + ` · ${formatClock(info.startTime)}`
                + ` · ${formatElapsed(info.elapsedMs)}`
                + ` · 📊 ${info.usage.totalTokens} tokens`
                + `<span class="message__info-arrow">▸</span>`;
        }
        el.appendChild(summary);

        // 详情体（展开态显示全部字段，格式化 JSON）
        const body = document.createElement("pre");
        body.className = "message__info-body";
        body.style.display = "none";
        body.textContent = JSON.stringify(info.raw || {}, null, 2);
        el.appendChild(body);

        // 折叠交互（独立生效，不影响其他两段）
        summary.addEventListener("click", () => {
            const arrow = summary.querySelector(".message__info-arrow");
            if (body.style.display === "none") {
                body.style.display = "block";
                arrow.textContent = "▾";
            } else {
                body.style.display = "none";
                arrow.textContent = "▸";
            }
        });

        // 关键修复：下钻到真正的 .message__bubble 再追加，确保信息栏位于气泡内部（第 3 段）
        const bubble = getBubbleOf(messageEl);
        bubble.appendChild(el);
        return el;
    }

    /**
     * [US-3.6] 渲染"已中断"信息栏（F3-9）。
     *
     * 语义：用户打断后，为被打断的回答补一条信息栏，展示：
     *   - "已中断"标识（区别于正常完成的"🤖 模型名"）；
     *   - 模型名（来自 state.currentModel，缺失时显示 unknown）；
     *   - 开始时刻与耗时（来自 state.currentStartTime）；
     *   - token 记为 0（F3-8：不估算、不累加）。
     *
     * 关键约束：
     *   1. **必须在 US-3.5 的 finally 清理之前调用**（依赖 currentBubbleEl / currentStartTime）；
     *   2. **只读 state，不写 state.sessionStats**（打断回答不计入会话累计，F3-8）；
     *   3. 复用 renderInfoBar（同一套折叠交互与详情体），仅通过 info.interrupted 区分展示。
     *
     * @returns {HTMLElement|null} 信息栏元素；无气泡时返回 null
     */
    function renderInterruptedInfoBar() {
        // 无气泡（极端情况）→ 不渲染，避免抛错
        if (!state.currentBubbleEl) return null;

        // 计算耗时（前端计时，R3.4）；currentStartTime 为 0 时耗时记 0
        const elapsedMs = state.currentStartTime
            ? performance.now() - state.currentStartTime
            : 0;
        const startTime = new Date(Date.now() - elapsedMs);

        // usage 全 0（F3-8：不估算、不累加）
        const zeroUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        // 复用 renderInfoBar，通过 interrupted 标记切换摘要行展示
        state.currentInfoEl = renderInfoBar(state.currentBubbleEl, {
            model: state.currentModel || "unknown",
            startTime,
            elapsedMs,
            usage: zeroUsage,
            raw: { interrupted: true, usage: zeroUsage },
            interrupted: true,   // [US-3.6] 中断标记：renderInfoBar 据此显示"已中断"
        });

        return state.currentInfoEl;
    }

    /**
     * 渲染工具调用段（第 4 段，默认折叠）
     * 插入到气泡内、回答段之前（思考段之后），不破坏三段纵向堆叠
     * @param {HTMLElement} messageEl - .message 根元素
     * @param {{name:string, arguments:object, result?:string}} info
     * @returns {HTMLElement}
     */
    function renderToolCall(messageEl, info) {
        // 复用同一个工具段（同一次回答可能多次 tool_call 事件）
        let el = state.currentToolEl;
        if (!el) {
            el = document.createElement("div");
            el.className = "message__tool";

            const header = document.createElement("div");
            header.className = "message__tool-header";
            header.innerHTML =
                '<span class="message__tool-icon">🔧</span> 工具调用'
                + '<span class="message__tool-arrow">▸</span>';
            el.appendChild(header);

            const body = document.createElement("div");
            body.className = "message__tool-body";
            body.style.display = "none"; // 默认收起
            el.appendChild(body);

            // 折叠交互（独立生效）
            header.addEventListener("click", () => {
                const arrow = header.querySelector(".message__tool-arrow");
                if (body.style.display === "none") {
                    body.style.display = "block";
                    arrow.textContent = "▾";
                } else {
                    body.style.display = "none";
                    arrow.textContent = "▸";
                }
            });

            // 插入到气泡内、回答段之前
            const bubble = getBubbleOf(messageEl);
            const answerEl = bubble.querySelector(".message__answer");
            if (answerEl) {
                bubble.insertBefore(el, answerEl);
            } else {
                bubble.appendChild(el);
            }
            state.currentToolEl = el;
        }

        // 追加本次调用信息（名称 + 参数 + 结果）
        const body = el.querySelector(".message__tool-body");
        const line = document.createElement("div");
        line.className = "message__tool-item";

        let text = `调用：${info.name}`;
        if (info.arguments && Object.keys(info.arguments).length > 0) {
            text += `\n参数：${JSON.stringify(info.arguments)}`;
        }
        if (info.result !== undefined) {
            text += `\n结果：${info.result}`;
        }
        line.textContent = text;
        body.appendChild(line);

        return el;
    }

    /**
     * 渲染会话汇总栏（宏观度量，R3.3）
     * 数据来源：state.sessionStats（与单条信息栏同口径）
     */
    function renderSessionSummary() {
        const s = state.sessionStats;
        if (s.count === 0) {
            $dom.usage.textContent = "";
            return;
        }
        $dom.usage.textContent =
            `📊 会话累计 · ${s.count} 次回答`
            + ` · 输入 ${s.promptTokens} / 输出 ${s.completionTokens} / 共计 ${s.totalTokens} tokens`
            + ` · 总耗时 ${(s.elapsedMs / 1000).toFixed(1)}s`;
    }

    // ============================================
    // DOM 操作函数
    // ============================================

    /**
     * 创建消息元素
     * @param {string} role - user / assistant / error
     * @param {string} content - 消息内容
     * @returns {HTMLElement} - 消息 DOM 元素
     */
    function createMessageEl(role, content) {
        const avatarMap = {
            user: "👤",
            assistant: "🤖",
            error: "⚠️",
        };

        const div = document.createElement("div");
        div.className = `message message--${role}`;

        // 头像
        const avatar = document.createElement("div");
        avatar.className = "message__avatar";
        avatar.textContent = avatarMap[role] || "❓";
        div.appendChild(avatar);

        // 气泡
        const bubble = document.createElement("div");
        bubble.className = "message__bubble";

        if (role === "assistant") {
            // R3 布局兜底：内联样式强制气泡纵向堆叠，避免 CSS 缓存/优先级导致三段横排
            bubble.style.display = "flex";
            bubble.style.flexDirection = "column";
            bubble.style.alignItems = "stretch";
            bubble.style.gap = "10px";
            // R2-2 固定行宽：不再设置内联 width，交由 CSS 的 flex:1 1 auto; width:0; 控制，
            // 避免内联样式覆盖 CSS 导致固定宽度失效或溢出。

            // 回答段容器（总开关）：标题 + 正文 + 光标
            const answerEl = document.createElement("div");
            answerEl.className = "message__answer";
            answerEl.style.display = "flex";
            answerEl.style.flexDirection = "column";
            answerEl.style.width = "100%";

            // 回答段标题（可点击折叠，作为三段总开关）
            const answerHeader = document.createElement("div");
            answerHeader.className = "message__answer-header";
            answerHeader.innerHTML = '<span class="message__answer-icon">📝</span> 回答内容'
                + '<span class="message__answer-arrow">▾</span>';
            answerEl.appendChild(answerHeader);

            // 回答段主体（正文 + 光标）
            const answerBody = document.createElement("div");
            answerBody.className = "message__answer-body";

            const contentSpan = document.createElement("span");
            contentSpan.className = "message__content";
            contentSpan.innerHTML = renderMarkdown(content || "");
            answerBody.appendChild(contentSpan);

            const cursor = document.createElement("span");
            cursor.className = "message__cursor";
            answerBody.appendChild(cursor);

            answerEl.appendChild(answerBody);
            bubble.appendChild(answerEl);
        } else {
            // 用户/错误消息：直接渲染
            bubble.innerHTML = renderMarkdown(content);
        }

        div.appendChild(bubble);
        return div;
    }

    /**
     * 添加消息到列表
     * @param {string} role
     * @param {string} content
     * @returns {HTMLElement} - 消息 DOM 元素
     */
    function addMessage(role, content) {
        // 隐藏空状态
        $dom.empty.style.display = "none";
        // R2-1：默认问题行已删除，此处不再操作 #chat-suggestions 的显隐

        const el = createMessageEl(role, content);
        $dom.messages.appendChild(el);

        // 助手消息：为回答段标题绑定折叠联动（回答段为三段总开关）
        if (role === "assistant") {
            const answerHeader = el.querySelector(".message__answer-header");
            const answerBody = el.querySelector(".message__answer-body");
            if (answerHeader && answerBody) {
                answerHeader.addEventListener("click", () => {
                    const arrow = answerHeader.querySelector(".message__answer-arrow");
                    const collapsed = answerBody.style.display === "none";
                    if (collapsed) {
                        // 展开回答段：仅展开回答段；思考段/工具段/信息栏恢复"区块可见"，
                        // 但保持各自 body 的原有展开/收起状态（不强制展开）
                        answerBody.style.display = "block";
                        arrow.textContent = "▾";

                        const thinkEl = el.querySelector(".message__think");
                        if (thinkEl) thinkEl.style.display = "";

                        const toolEl = el.querySelector(".message__tool");
                        if (toolEl) toolEl.style.display = "";

                        const infoEl = el.querySelector(".message__info");
                        if (infoEl) infoEl.style.display = "";
                    } else {
                        // 折叠回答段：思考段 + 工具段 + 信息栏段整体不可见（含标题行）
                        answerBody.style.display = "none";
                        arrow.textContent = "▸";

                        // 隐藏思考段整个区块（含标题行）
                        const thinkEl = el.querySelector(".message__think");
                        if (thinkEl) thinkEl.style.display = "none";

                        // 隐藏工具调用段整个区块（含标题行，R1 第 4 段）
                        const toolEl = el.querySelector(".message__tool");
                        if (toolEl) toolEl.style.display = "none";

                        // 隐藏信息栏整个区块（含摘要行）
                        const infoEl = el.querySelector(".message__info");
                        if (infoEl) infoEl.style.display = "none";
                    }
                });
            }
        }

        // 滚动到底部
        scrollToBottom();

        return el;
    }

    /**
     * 滚动消息列表到底部
     */
    function scrollToBottom() {
        requestAnimationFrame(() => {
            $dom.messages.scrollTop = $dom.messages.scrollHeight;
        });
    }

    /**
     * 更新当前流式消息的内容
     * @param {string} text - 追加的文本片段
     */
    function updateStreamContent(text) {
        if (!state.currentBubbleEl) return;

        state.currentAssistantContent += text;

        const contentSpan = state.currentBubbleEl.querySelector(".message__content");
        if (contentSpan) {
            contentSpan.innerHTML = renderMarkdown(state.currentAssistantContent);
        }

        scrollToBottom();
    }

    /**
     * 更新当前思考块的内容（无思考块时自动创建）
     * @param {string} text - 追加的思考文本片段
     */
    function updateThinkContent(text) {
        if (!state.currentBubbleEl) return;

        // 累积思考内容
        state.currentThinkContent += text;

        // 首次收到思考内容时，创建思考块（插入到气泡最前面）
        if (!state.currentThinkEl) {
            const thinkEl = document.createElement("div");
            thinkEl.className = "message__think";
            // R3 布局兜底：思考段占满整行
            thinkEl.style.width = "100%";

            // 思考块标题（可点击折叠）
            const header = document.createElement("div");
            header.className = "message__think-header";
            header.innerHTML = '<span class="message__think-icon">💭</span> 思考过程'
                + '<span class="message__think-arrow">▾</span>';
            header.addEventListener("click", () => {
                const body = thinkEl.querySelector(".message__think-body");
                const arrow = thinkEl.querySelector(".message__think-arrow");
                if (body.style.display === "none") {
                    body.style.display = "block";
                    arrow.textContent = "▾";
                } else {
                    body.style.display = "none";
                    arrow.textContent = "▸";
                }
            });
            thinkEl.appendChild(header);

            // 思考内容主体
            const body = document.createElement("div");
            body.className = "message__think-body";
            thinkEl.appendChild(body);

            // 关键修复：下钻到真正的 .message__bubble 再插入最前面，
            // 确保思考段位于气泡内部（第 1 段），而非挂在 .message 上与头像横排。
            const bubble = getBubbleOf(state.currentBubbleEl);
            bubble.insertBefore(thinkEl, bubble.firstChild);
            state.currentThinkEl = thinkEl;
        }

        // 更新思考内容（纯文本，避免 Markdown 干扰）
        const body = state.currentThinkEl.querySelector(".message__think-body");
        if (body) {
            body.textContent = state.currentThinkContent;
        }

        scrollToBottom();
    }

    /**
     * 完成思考块（收起思考块，保持可展开）
     */
    function finishThink() {
        // 保留思考块（默认收起，用户可点击展开查看）
        if (state.currentThinkEl) {
            const body = state.currentThinkEl.querySelector(".message__think-body");
            const arrow = state.currentThinkEl.querySelector(".message__think-arrow");
            if (body) body.style.display = "none";
            if (arrow) arrow.textContent = "▸";
        }
        state.currentThinkEl = null;
        state.currentThinkContent = "";
    }

    /**
     * 完成流式响应（移除光标）
     */
    function finishStream() {
        if (!state.currentBubbleEl) return;

        const cursor = state.currentBubbleEl.querySelector(".message__cursor");
        if (cursor) {
            cursor.remove();
        }
        state.currentAssistantContent = "";

        finishThink();
        // [US-3.5] currentBubbleEl 的置空已统一收敛到 sendStreamRequest 的 finally 中，
        //          覆盖正常/排空/超时/错误全部路径，避免打断路径遗漏导致串写。
        //          此处仅负责"移除光标 + 收起思考"，不触碰气泡引用。
    }

    /**
     * [US-3.7] 统一收尾入口（幂等，防重复收尾，F3-11）。
     *
     * 语义：同一次回答的收尾动作（移除光标 + 渲染信息栏 + 终态提示）
     *       必须"只执行一次"。本函数是所有收尾路径的唯一入口：
     *         - case "finish" 正常路径（P1）
     *         - 循环退出后（P4）
     *         - catch 的 AbortError 分支（P5 / P6）
     *
     * 幂等机制：
     *   1. 进入时检查 state.completed，若已为 true 直接返回（不重复收尾）；
     *   2. 执行收尾体后置 state.completed = true；
     *   3. state.completed 的生命周期与"一次回答"对齐（轮初/轮末复位）。
     *
     * 关键约束：
     *   - 必须在 US-3.5 的 finally 清理之前调用（依赖 currentBubbleEl / currentStartTime）；
     *   - 本函数只读 state、不写 sessionStats（usage 记 0 由 US-3.6 保证）；
     *   - 不修改任何既有收尾动作的"内容"，仅将其收敛到一处并加幂等保护。
     *
     * @param {boolean} interrupted - 是否为"打断收尾"：
     *        true  → 渲染"已中断"信息栏 + "⏹️ 已停止"提示（US-3.4/3.6）；
     *        false → 正常收尾（信息栏与"✅ 完成"由调用方在收尾前/后处理，见第三章）。
     * @returns {boolean} - 本次是否实际执行了收尾（true=执行；false=已收尾过，跳过）
     */
    function finalizeOnce(interrupted) {
        // 幂等保护：已收尾则直接返回，避免重复渲染信息栏 / 重复提示（F3-11）
        if (state.completed) return false;

        // 标记为已收尾（先置位，防止收尾体内部再次触发收尾路径造成递归/重入）
        state.completed = true;

        // 统一收尾体：
        // 1) 移除光标、收起思考块（幂等：cursor 已移除时 querySelector 返回 null）
        finishStream();

        // 2) 终态展示
        if (interrupted) {
            // 打断收尾：渲染"已中断"信息栏（US-3.6）+ "已停止"提示（US-3.4）
            renderInterruptedInfoBar();
            setStoppedStatus();
        } else {
            // 正常收尾：终态提示由调用方负责（保持原"✅ 完成"逻辑不变，零回归）
            //   说明：正常路径的信息栏 + usage 累加在 case "finish" 内已完成，
            //         此处不重复处理，仅确保收尾动作只执行一次。
        }

        return true;
    }

    /**
     * 设置状态文本
     * @param {string} text - 状态文本
     * @param {string} className - 额外 CSS 类名
     */
    function setStatus(text, className) {
        $dom.status.textContent = text;
        $dom.status.className = "chat-status" + (className ? " " + className : "");
    }

    /**
     * [US-3.4] 设置"打断/停止"状态提示（统一入口，显式非错误样式）。
     *
     * 语义（F3-4）：打断过程与结果以"已停止/已中断"提示，**不得呈现为错误**。
     *   - 统一文案：终态固定为 "⏹️ 已停止"，可选追加时间；
     *   - 显式样式：固定使用 "chat-status--stopped"（非错误色），
     *     不再依赖 .chat-status 的默认灰色（把"非错误"从隐式约定变为显式契约）；
     *   - 集中收口：所有打断相关提示均经此函数，避免文案/样式再次分散。
     *
     * @param {boolean} [withTime=true] - 是否追加当前时间（终态默认追加）
     */
    function setStoppedStatus(withTime = true) {
        const text = withTime
            ? `⏹️ 已停止 (${getTimeStr()})`
            : "⏹️ 已停止";
        setStatus(text, "chat-status--stopped");
    }

    /**
     * 设置使用统计
     * @param {string} text
     */
    function setUsage(text) {
        $dom.usage.textContent = text;
    }

    /**
     * 清空使用统计
     */
    function clearUsage() {
        $dom.usage.textContent = "";
    }

    /**
     * 设置输入状态
     * @param {boolean} enabled
     */
    function setInputEnabled(enabled) {
        $dom.input.disabled = !enabled;
        $dom.sendBtn.disabled = !enabled;
        if (enabled) {
            $dom.input.focus();
        }
    }

    /**
     * [US-3.1] 控制「停止」入口的显隐。
     * 仅在 AI 流式输出进行中显示，非输出状态隐藏。
     * @param {boolean} visible
     */
    function setStopBtnVisible(visible) {
        if (!$dom.stopBtn) return;
        $dom.stopBtn.hidden = !visible;
    }

    /**
     * [US-3.2 / US-3.8] 启动排空超时兜底。
     *
     * 语义：打断后若在 CONFIG.DRAIN_TIMEOUT_MS 内仍未读到流结束（服务端未关流），
     *       则强制收尾，避免读取循环永久阻塞、界面卡死。
     *
     * 超时动作：
     *   1. 置显式超时标记 state.drainTimedOut = true（US-3.8），
     *      使"排空超时"可被 catch 分支稳定识别（不依赖 draining 的时序）；
     *   2. 记录超时日志（含 requestId，便于观测）；
     *   3. 主动取消本地读取器（释放底层连接），让读取循环尽快退出。
     *
     * 实现说明：本函数只负责"计时"与"超时后取消读取器"，
     *           真正的收尾（移除光标、复位状态）由读取循环退出后的统一逻辑完成，
     *           避免收尾逻辑分散在多处导致重复执行（呼应 US-3.7 防重复收尾）。
     */
    function startDrainTimeout() {
        clearDrainTimeout(); // 防重复：先清理旧计时器
        state.drainTimer = setTimeout(() => {
            state.drainTimer = null;
            // 超时仍未排空完成 → 主动取消本地读取器，让读取循环尽快退出
            if (!state.draining || !state.abortController) return;

            // [US-3.8] 置显式超时标记（先于 abort，确保 catch 能识别本次为超时中断）
            state.drainTimedOut = true;
            console.warn(
                `[US-3.8] 排空超时(${CONFIG.DRAIN_TIMEOUT_MS}ms)，强制收尾`,
                state.currentRequestId || ""
            );
            state.abortController.abort();
        }, CONFIG.DRAIN_TIMEOUT_MS);
    }

    /**
     * [US-3.2] 清理排空超时计时器（幂等）。
     */
    function clearDrainTimeout() {
        if (state.drainTimer) {
            clearTimeout(state.drainTimer);
            state.drainTimer = null;
        }
    }

    /**
     * [US-3.3] 生成一个请求标识（requestId）。
     * 用于带外取消：随 /stream 请求发送，打断时据此取消对应上游请求。
     * 格式：req_<时间戳36进制>_<UUID>，与 sessionId 风格一致，保证唯一性。
     * @returns {string}
     */
    function generateRequestId() {
        try {
            return "req_" + Date.now().toString(36) + "_" + crypto.randomUUID();
        } catch {
            // 极端环境无 crypto.randomUUID 时降级（唯一性略降，但可用）
            return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
        }
    }

    /**
     * [US-3.3] 发送带外取消请求（停止未来）。
     *
     * 语义：用户打断时调用。**不切断本地流**，而是另发一个独立请求，
     *       携带 requestId，服务端据此 abort() 对应的上游模型请求。
     *
     * 容错：取消是"尽力而为"的操作，任何失败（网络错误、404、超时）
     *       均**静默忽略**，不弹错误、不阻塞本地排空（US-3.2 继续读在途数据）。
     *
     * @param {string|null} requestId
     */
    function sendCancelRequest(requestId) {
        if (!requestId) return;
        // 独立请求：不绑定 state.abortController，避免与本地流共用信号；
        // 使用 keepalive 提升页面卸载/切换时的送达率（可选，现代浏览器支持）。
        fetch(CONFIG.CANCEL_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId }),
            keepalive: true,
        }).catch((e) => {
            // 取消失败不影响本地排空，静默记录即可
            console.warn("[US-3.3] 发送取消请求失败（已忽略）:", e);
        });
    }

    /**
     * [US-3.1 / US-3.2 / US-3.3 / US-3.4] 用户点击「停止」入口。
     *
     * US-3.1：记录打断意图（stopRequested）并给出即时反馈。
     * US-3.2：进入"排空态"（draining），**不切断本地流**，
     *         继续接收并显示在途数据（③④⑤ 段），直至流结束或排空超时。
     * US-3.3：发送带外取消请求（停止未来），取消上游模型请求。
     * US-3.4：即时反馈文案统一为"正在停止…"，并显式使用非错误样式。
     *
     * 注意（与 US-3.3 的边界）：
     *   - 本函数**不调用** abortController.abort()，以保证本地流继续读取；
     *   - "停止未来"（取消上游模型请求）由 US-3.3 通过**带外取消请求**实现，
     *     本地流读取不受影响。
     */
    function requestStop() {
        // 非输出状态：无操作（防御性）
        if (!state.isStreaming) return;
        // 防重复：已请求过则不重复触发（呼应 US-3.7）
        if (state.stopRequested) return;

        // 1. 记录打断意图（US-3.1）
        state.stopRequested = true;

        // 2. 进入排空态（US-3.2）：读取循环据此继续消费在途数据
        state.draining = true;

        // 3. [US-3.4] 即时反馈：提示"正在停止…"，显式使用非错误样式；
        //    同时隐藏停止入口避免重复点击。
        setStatus("⏹️ 正在停止…", "chat-status--stopped");
        setStopBtnVisible(false);

        // 4. 启动排空超时兜底（US-3.2 / US-3.8）：超时未排空则强制收尾
        startDrainTimeout();

        // 5. [US-3.3] 发送带外取消请求（停止未来）：
        //    不切断本地流（US-3.2 继续读在途数据），而是另发独立请求取消上游。
        sendCancelRequest(state.currentRequestId);
    }

    // ============================================
    // 核心：流式请求
    // ============================================

    /**
     * [US-2.3] 将当前会话 ID 保存到本标签页（sessionStorage）。
     * 使用 sessionStorage 而非 localStorage，保证标签页之间互不共享，避免串会话。
     * @param {string} id
     */
    function persistSessionId(id) {
        try {
            sessionStorage.setItem(CONFIG.SESSION_STORAGE_KEY, id);
        } catch (e) {
            console.warn("保存本标签页会话 ID 失败:", e);
        }
    }

    /**
     * 获取（或初始化）当前会话的唯一 ID（US-2.1）
     * 调用服务端 /api/chat/session 接口分配一个全局唯一 ID。
     * 失败时降级为本地生成，保证对话不因会话接口异常而中断。
     * [US-2.3] 优先复用本标签页已保存的会话 ID（sessionStorage 标签页级隔离）。
     * @returns {Promise<string>} 会话 ID
     */
    async function ensureSessionId() {
        if (state.sessionId) return state.sessionId;

        // [US-2.3] 优先复用本标签页已保存的会话 ID（sessionStorage 标签页级隔离）。
        try {
            const cached = sessionStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
            if (cached) {
                state.sessionId = cached;
                return state.sessionId;
            }
        } catch (e) {
            console.warn("读取本标签页会话 ID 失败:", e);
        }

        try {
            const resp = await fetch(CONFIG.SESSION_ENDPOINT, { method: "POST" });
            if (resp.ok) {
                const data = await resp.json();
                if (data && typeof data.sessionId === "string") {
                    state.sessionId = data.sessionId;
                    persistSessionId(state.sessionId);   // [US-2.3] 写回本标签页
                    return state.sessionId;
                }
            }
        } catch (e) {
            console.warn("获取会话 ID 失败，降级为本地生成:", e);
        }
        // 降级：本地生成，格式与服务端保持一致（sess_<ts36>_<uuid>），
        // 以便降级 ID 亦能通过服务端 isValidSessionId 校验。
        // crypto.randomUUID 为浏览器内置，现代浏览器均支持。
        state.sessionId = "sess_" + Date.now().toString(36) + "_" + crypto.randomUUID();
        persistSessionId(state.sessionId);               // [US-2.3] 写回本标签页
        return state.sessionId;
    }

    /**
     * 发送单条消息并接收流式响应（US-2.2：历史由服务端持有）
     * @param {string} message - 本次用户消息内容（单条）
     * @returns {Promise<string>} - 返回助手的完整回复内容
     */
    async function sendStreamRequest(message) {
        // 累积完整的助手回复内容（不会被 finishStream 清空）
        let fullContent = "";

        // [US-3.7] 本轮回答开始：复位收尾标记，保证本轮收尾不被上一轮误跳过。
        state.completed = false;
        // [US-3.8] 本轮回答开始：复位排空超时标记，保证本轮超时判定不被上一轮污染。
        state.drainTimedOut = false;

        // 创建 AbortController
        state.abortController = new AbortController();
        const { signal } = state.abortController;

        try {
            // [US-2.1] 确保会话 ID 已就绪（懒获取，避免首次请求时 sessionId 为空）
            await ensureSessionId();

            setStatus("🤔 AI 思考中...", "chat-status--thinking");
            setInputEnabled(false);

            // 添加一个空的助手消息占位
            state.currentAssistantContent = "";
            state.currentBubbleEl = addMessage("assistant", "");

            // 重置思考状态
            state.currentThinkEl = null;
            state.currentThinkContent = "";
            state.currentToolEl = null; // R1：重置工具段引用，避免串到上一条消息

            // 记录本次回答开始时间（前端计时，R3.4）
            state.currentStartTime = performance.now();

            // [US-3.3] 生成本次请求标识，随请求体发送，供带外取消定位。
            state.currentRequestId = generateRequestId();

            // 发起流式请求（US-2.2：只发单条 message，历史由服务端持有）
            const response = await fetch(CONFIG.API_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                // [US-3.3] 请求体新增 requestId
                body: JSON.stringify({
                    sessionId: state.sessionId,
                    message,
                    requestId: state.currentRequestId,
                }),
                signal,
            });

            if (!response.ok) {
                // 尝试解析错误信息
                let errorMsg = `HTTP ${response.status}`;
                try {
                    const errData = await response.json();
                    errorMsg = errData.error || errorMsg;
                } catch {
                    // 忽略 JSON 解析错误
                }
                throw new Error(errorMsg);
            }

            // 获取可读流
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            // 读取流
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // 解码并处理
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || ""; // 保留未完成的行

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: ")) continue;

                    try {
                        const data = JSON.parse(trimmed.slice(6));

                        switch (data.type) {
                            case "tool_call":
                                // R1：工具调用发生/结果（默认收起，可展开）
                                if (state.currentBubbleEl) {
                                    renderToolCall(state.currentBubbleEl, {
                                        name: data.name,
                                        arguments: data.arguments,
                                        result: data.result, // 执行前为 undefined
                                    });
                                }
                                break;
                            case "think":
                                // 思考内容（自适应显示，无则不渲染）
                                updateThinkContent(data.content);
                                break;
                            case "text":
                                updateStreamContent(data.content);
                                fullContent += data.content; // 同步累积到 fullContent
                                break;

                            case "finish":
                                // [US-3.2] 排空态下：用户已打断，本次回答不应按"正常完成"处理。
                                //   - 跳过"✅ 完成"提示（避免与循环退出后的"⏹️ 已停止"冲突/闪烁）；
                                //   - 跳过 usage 累加（被打断回答 usage 记 0，详见 US-3.6）。
                                //   注意：仍执行 finishStream() 移除光标，保证视觉收尾。
                                if (state.draining) {
                                    finishStream();
                                    break;   // 跳出 switch，交由循环退出后的统一收尾处理
                                }

                                // [US-3.7] 正常收尾经统一入口（幂等）：
                                //   移除光标 + 置 completed=true，防止循环退出后 P4 重复收尾。
                                //   注：信息栏 + usage 累加 + "✅ 完成" 仍在下方按原逻辑执行（零回归）。
                                finalizeOnce(false);

                                // [US-3.6] 暂存模型名：正常路径用于信息栏；若本轮随后被打断，
                                //          亦可作为打断信息栏的模型名来源（打断可能无 finish）。
                                if (data.raw && data.raw.model) {
                                    state.currentModel = data.raw.model;
                                }

                                if (data.usage) {
                                    // 计算耗时（前端计时，R3.4）
                                    const elapsedMs = state.currentStartTime
                                        ? performance.now() - state.currentStartTime
                                        : 0;
                                    const startTime = new Date(Date.now() - elapsedMs);

                                    // 生成单条信息栏（第 3 段，默认折叠）
                                    if (state.currentBubbleEl) {
                                        state.currentInfoEl = renderInfoBar(state.currentBubbleEl, {
                                            model: data.raw?.model || "",
                                            startTime,
                                            elapsedMs,
                                            usage: data.usage,
                                            raw: data.raw,
                                        });
                                    }

                                    // 累加会话统计（与单条信息栏同口径，R3.3.3）
                                    state.sessionStats.count += 1;
                                    state.sessionStats.promptTokens += data.usage.promptTokens || 0;
                                    state.sessionStats.completionTokens += data.usage.completionTokens || 0;
                                    state.sessionStats.totalTokens += data.usage.totalTokens || 0;
                                    state.sessionStats.elapsedMs += elapsedMs;

                                    // 刷新会话汇总栏
                                    renderSessionSummary();

                                    // 信息栏生成后清理当前气泡引用
                                    state.currentBubbleEl = null;
                                    state.currentInfoEl = null;
                                    state.currentStartTime = 0;
                                }
                                setStatus(`✅ 完成 (${getTimeStr()})`);
                                break;

                            case "error":
                                // [US-3.4] 排空态下：用户已打断，此 error 很可能由"上游取消"引发，
                                //   不应呈现为错误（F3-4：打断不得呈现为错误）。
                                //   处理：仅移除光标（视觉收尾），跳过错误 UI；
                                //         终态提示交由循环退出后的统一收尾（setStoppedStatus）给出。
                                if (state.draining) {
                                    finishStream();
                                    break;   // 跳出 switch，继续 while 读取在途数据
                                }

                                // 非打断态：真实错误，保持原逻辑不变（红色错误样式）
                                finishStream();
                                setStatus(`❌ 错误: ${data.message}`, "chat-status--error");
                                break;
                        }
                    } catch (e) {
                        // 忽略解析错误
                        console.warn("SSE 解析错误:", e, line);
                    }
                }
            }

            // 流结束（done === true）：
            //   - 正常结束：未打断，走原收尾；
            //   - 排空完成：已打断（draining），在途数据已全部消费，同样收尾。
            // 两种情况在此统一收尾，天然避免重复（呼应 US-3.7）。
            const wasDraining = state.draining;   // [US-3.2] 记录是否为"打断后排空结束"

            // 排空完成：清理超时计时器（避免定时器在收尾后仍触发）
            clearDrainTimeout();                  // [US-3.2]

            // 如果还没有收到 finish 事件（可能某些模型不返回 usage）
            // 注意：必须在 finalizeOnce 之前完成——finalizeOnce 内部 finishStream()
            //       会清空 state.currentAssistantContent。
            if (!fullContent) {
                fullContent = state.currentAssistantContent;
            }

            // [US-3.7] 统一收尾（幂等）：
            //   - 若 P1 已收尾（completed=true）→ finalizeOnce 直接跳过，避免重复；
            //   - 若尚未收尾（如无 finish 事件）→ 此处完成收尾。
            if (!state.isStreaming) {
                // [US-3.4] 排空完成 → 统一"已停止"提示（非错误样式）；
                //           正常完成 → 保持原"✅ 完成"不变。
                if (wasDraining) {
                    // [US-3.6] 打断收尾（排空完成）：渲染"已中断"信息栏 + usage 记 0。
                    //   注意：必须在 finally 清理 currentBubbleEl/currentStartTime 之前执行！
                    //   本函数只读 state、不写 sessionStats（F3-8：不累加）。
                    finalizeOnce(true);
                } else {
                    // 正常收尾：finalizeOnce(false) 只移除光标 + 置位；
                    //   终态提示按原逻辑给出（零回归）。
                    finalizeOnce(false);
                    setStatus(`✅ 完成 (${getTimeStr()})`);
                }
            }
        } catch (err) {
            // 处理错误
            if (err.name === "AbortError") {
                // [US-3.2 / US-3.8] 区分两种 abort 来源：
                //   (a) 排空超时兜底触发的 abort：此时 drainTimedOut === true（US-3.8 显式标记），
                //       或 draining === true（US-3.2 兜底判定），
                //       说明"打断后未能及时排空"，直接收尾即可，不重复提示；
                //   (b) 其他 abort（如页面卸载、外部取消）：按原逻辑处理。
                // 注意：US-3.2 自身**不主动 abort 本地流**（除超时兜底），
                //       "停止未来"由 US-3.3 的带外取消请求完成，故此处分支
                //       在 US-3.2 阶段主要用于承接"排空超时"。
                clearDrainTimeout();          // [US-3.2] 清理计时器（幂等）

                // [US-3.7] 统一收尾（幂等）：
                //   - 排空超时（drainTimedOut/draining=true）→ 打断收尾（信息栏 + "已停止"）；
                //   - 非排空 abort（页面卸载等）→ 仅收尾提示，不渲染"已中断"信息栏。
                // [US-3.8] 判定优先使用 drainTimedOut（显式超时标记），
                //          避免 draining 在时序上被提前复位而丢失"已中断"信息栏。
                if (state.drainTimedOut || state.draining) {
                    // [US-3.6] 打断收尾（排空超时）：渲染"已中断"信息栏 + usage 记 0。
                    //   同样必须在 finally 清理之前执行。
                    finalizeOnce(true);
                } else {
                    // [US-3.4] 非排空 abort（如页面卸载、外部取消）：
                    //          同样以"已停止"呈现，避免"已取消"措辞不统一。
                    //   注：非排空 abort 不属于"用户打断排空"，不渲染"已中断"信息栏。
                    finalizeOnce(false);
                    setStoppedStatus(false);
                }
                return fullContent; // 取消时返回已累积的内容
            }

            const errorMsg = err.message || String(err);
            setStatus(`❌ 请求失败`, "chat-status--error");

            // 移除空的助手消息
            if (state.currentBubbleEl) {
                state.currentBubbleEl.remove();
                state.currentBubbleEl = null;
                state.currentAssistantContent = "";
                state.currentThinkEl = null;
                state.currentThinkContent = "";
                state.currentToolEl = null; // R1：一并清理工具段引用
            }

            // 显示错误消息
            addMessage("error", `请求失败: ${errorMsg}`);
        } finally {
            state.isStreaming = false;
            state.abortController = null;
            // [US-3.2] 复位打断相关状态，保证下一轮回答干净：
            //   - stopRequested：US-3.1 遗留未复位，此处补齐；
            //   - draining：排空态复位；
            //   - drainTimer：清理超时计时器，避免泄漏。
            state.stopRequested = false;
            state.draining = false;
            state.drainTimedOut = false;     // [US-3.8] 复位排空超时标记
            state.currentRequestId = null;   // [US-3.3] 清理本次请求标识

            // [US-3.5] 统一清理"指向旧气泡的流式引用"，确保新消息不串入旧气泡（F3-7）。
            //   背景：这些引用原先仅在"正常 finish 分支生成信息栏后"清理，
            //         打断路径（排空 finish / 排空 error / 循环退出 / 超时 catch）
            //         不会走到该清理点，导致引用残留、跨轮串写。
            //   原则：**只置引用为 null，绝不 remove() DOM**——
            //         旧气泡及其内容（正文/思考/工具）必须保留（F3-5）。
            //   幂等：与正常 finish 分支的既有清理重复执行无害。
            state.currentBubbleEl = null;
            state.currentThinkEl = null;
            state.currentThinkContent = "";
            state.currentToolEl = null;
            state.currentInfoEl = null;
            state.currentStartTime = 0;
            state.currentAssistantContent = "";   // [US-3.5] 一并复位累积缓冲
            state.currentModel = "";              // [US-3.6] 复位本次回答模型名
            state.completed = false;              // [US-3.7] 兜底复位收尾标记

            clearDrainTimeout();
            setStopBtnVisible(false);     // [US-3.1] 流结束隐藏「停止」入口
            setInputEnabled(true);
        }

        // 返回完整的助手回复内容
        return fullContent;
    }

    // ============================================
    // 发送消息逻辑
    // ============================================

    /**
     * 发送用户消息
     */
    function sendMessage() {
        const text = $dom.input.value.trim();
        if (!text || state.isStreaming) return;

        // 清空输入框
        $dom.input.value = "";
        autoResizeInput();

        // 添加用户消息
        addMessage("user", text);

        // [US-2.2] 本地历史仅用于界面渲染，不再发送给服务端
        state.history.push({ role: "user", content: text });

        // 限制本地历史长度（仅影响本地渲染，服务端另有 MAX_HISTORY 上限）
        if (state.history.length > CONFIG.MAX_HISTORY) {
            state.history = state.history.slice(-CONFIG.MAX_HISTORY);
        }

        // 会话累计汇总栏由 renderSessionSummary 维护，此处不再清空

        // [US-2.2] 发送单条消息（历史由服务端持有），并将助手回复加入本地历史
        state.isStreaming = true;
        state.stopRequested = false;      // [US-3.1] 新一轮回答重置打断标志
        state.draining = false;           // [US-3.2] 新一轮回答重置排空态
        state.drainTimedOut = false;      // [US-3.8] 新一轮回答重置排空超时标记

        // [US-3.5] 新一轮开始前，清空"指向上一轮气泡的流式引用"，
        //   消除 sendMessage → sendStreamRequest 引用复位点之间的时序窗口，
        //   确保新消息绝不串入旧气泡（F3-7 / T-3.5.3）。
        //   注：sendStreamRequest 开头仍会再次复位（幂等），此处为提前兜底。
        state.currentBubbleEl = null;
        state.currentThinkEl = null;
        state.currentThinkContent = "";
        state.currentToolEl = null;
        state.currentInfoEl = null;
        state.currentStartTime = 0;
        state.currentAssistantContent = "";   // [US-3.5] 一并复位累积缓冲
        state.currentModel = "";              // [US-3.6] 复位本次回答模型名
        state.completed = false;              // [US-3.7] 新一轮复位收尾标记

        setStopBtnVisible(true);          // [US-3.1] 显示「停止」入口
        sendStreamRequest(text).then((assistantContent) => {
            // 请求完成后，将助手的回复加入本地历史（供界面渲染）
            if (assistantContent) {
                state.history.push({
                    role: "assistant",
                    content: assistantContent,
                });
            }
        });
    }

    /**
     * 自动调整输入框高度
     */
    function autoResizeInput() {
        $dom.input.style.height = "auto";
        $dom.input.style.height = Math.min($dom.input.scrollHeight, 150) + "px";
    }

    // ============================================
    // 初始化
    // ============================================

    function init() {
        // 输入框自动调整高度
        $dom.input.addEventListener("input", autoResizeInput);

        // Enter 发送（Shift+Enter 换行）
        $dom.input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // 发送按钮点击
        $dom.sendBtn.addEventListener("click", sendMessage);

        // [US-3.1] 停止按钮点击（打断入口）
        if ($dom.stopBtn) {
            $dom.stopBtn.addEventListener("click", requestStop);
        }

        // R2-1：默认问题行已删除，此处不再绑定 #chat-suggestions 的点击事件

        // 启用输入
        setInputEnabled(true);

        // [US-2.1] 预获取会话 ID（异步，不阻塞界面初始化）
        ensureSessionId().then((id) => {
            console.log("🆔 当前会话 ID:", id);
        });

        console.log("🤖 Bots AI Chat 已初始化");
    }

    // DOM 就绪后初始化
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
