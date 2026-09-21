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
 */

(function () {
    "use strict";

    // ============================================
    // 配置常量
    // ============================================
    const CONFIG = {
        API_ENDPOINT: "/api/chat/stream",
        MAX_HISTORY: 20, // 保留的最大消息历史数
    };

    // ============================================
    // DOM 缓存
    // ============================================
    const $dom = {
        messages: document.getElementById("chat-messages"),
        empty: document.getElementById("chat-empty"),
        input: document.getElementById("chat-input"),
        sendBtn: document.getElementById("chat-send-btn"),
        status: document.getElementById("chat-status"),
        usage: document.getElementById("chat-usage"),
        // R2-1：已删除默认问题行（#chat-suggestions），此处不再缓存其引用
    };

    // ============================================
    // 状态管理
    // ============================================
    const state = {
        /** @type {Array<{role:string, content:string}>} 消息历史 */
        history: [],
        /** @type {boolean} 是否正在接收流式响应 */
        isStreaming: false,
        /** @type {AbortController|null} 用于取消请求 */
        abortController: null,
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
        /** @type {HTMLElement|null} 当前回答段容器（总开关） */
        currentAnswerEl: null,
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
     * @param {{model:string, startTime:Date, elapsedMs:number, usage:object, raw:object}} info
     * @returns {HTMLElement} - 信息栏元素
     */
    function renderInfoBar(messageEl, info) {
        const el = document.createElement("div");
        el.className = "message__info";

        // 摘要行（折叠态可见）
        const summary = document.createElement("div");
        summary.className = "message__info-summary";
        summary.innerHTML =
            `<span class="message__info-icon">🤖</span> ${escapeHtml(info.model || "unknown")}`
            + ` · ${formatClock(info.startTime)}`
            + ` · ${formatElapsed(info.elapsedMs)}`
            + ` · 📊 ${info.usage.totalTokens} tokens`
            + `<span class="message__info-arrow">▸</span>`;
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
        // 注意：currentBubbleEl 不在此处置空，由 finish 分支生成信息栏后再清理
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

    // ============================================
    // 核心：流式请求
    // ============================================

    /**
     * 发送消息并接收流式响应
     * @param {Array<{role:string, content:string}>} messages - 消息历史
     * @returns {Promise<string>} - 返回助手的完整回复内容
     */
    async function sendStreamRequest(messages) {
        // 累积完整的助手回复内容（不会被 finishStream 清空）
        let fullContent = "";

        // 创建 AbortController
        state.abortController = new AbortController();
        const { signal } = state.abortController;

        try {
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

            // 发起流式请求
            const response = await fetch(CONFIG.API_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ messages }),
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
                                // 完成
                                finishStream();
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

            // 流正常结束
            finishStream();
            // 如果还没有收到 finish 事件（可能某些模型不返回 usage）
            if (!fullContent) {
                fullContent = state.currentAssistantContent;
            }
            if (!state.isStreaming) {
                setStatus(`✅ 完成 (${getTimeStr()})`);
            }
        } catch (err) {
            // 处理错误
            if (err.name === "AbortError") {
                setStatus("⏹️ 已取消");
                finishStream();
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

        // 构建消息历史
        state.history.push({ role: "user", content: text });

        // 限制历史长度
        if (state.history.length > CONFIG.MAX_HISTORY) {
            state.history = state.history.slice(-CONFIG.MAX_HISTORY);
        }

        // 会话累计汇总栏由 renderSessionSummary 维护，此处不再清空

        // 发送请求，并将助手的回复加入历史
        state.isStreaming = true;
        sendStreamRequest(state.history).then((assistantContent) => {
            // 请求完成后，将助手的回复加入历史
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

        // R2-1：默认问题行已删除，此处不再绑定 #chat-suggestions 的点击事件

        // 启用输入
        setInputEnabled(true);

        console.log("🤖 Bots AI Chat 已初始化");
    }

    // DOM 就绪后初始化
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
