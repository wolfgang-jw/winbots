/**
 * Bots AI 对话 - 前端逻辑
 *
 * 职责：
 * 1. 管理聊天界面交互（输入、发送、清空）
 * 2. 通过 Fetch API 的流式读取（ReadableStream）消费 SSE 数据
 * 3. 实时渲染流式文本到消息气泡
 * 4. 支持 Markdown 风格的代码块渲染
 * 5. 显示使用统计信息
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
        suggestions: document.getElementById("chat-suggestions"),
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
        /** @type {HTMLElement|null} 当前助手的消息气泡元素 */
        currentBubbleEl: null,
        /** @type {HTMLElement|null} 当前思考块元素（无思考内容时为 null） */
        currentThinkEl: null,
        /** @type {string} 当前正在累积的思考内容 */
        currentThinkContent: "",
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
            // 助手消息：先放内容占位，后续流式追加
            const contentSpan = document.createElement("span");
            contentSpan.className = "message__content";
            contentSpan.innerHTML = renderMarkdown(content || "");
            bubble.appendChild(contentSpan);

            // 添加闪烁光标
            const cursor = document.createElement("span");
            cursor.className = "message__cursor";
            bubble.appendChild(cursor);
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
        // 显示快捷提示词
        $dom.suggestions.style.display = "flex";

        const el = createMessageEl(role, content);
        $dom.messages.appendChild(el);

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

            // 插入到气泡的最前面（在正文内容之前）
            state.currentBubbleEl.insertBefore(thinkEl, state.currentBubbleEl.firstChild);
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
        state.currentBubbleEl = null;
        state.currentAssistantContent = "";

        finishThink();
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
                                    setUsage(formatUsage(data.usage));
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

        // 清空使用统计
        clearUsage();

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

        // 快捷提示词点击
        $dom.suggestions.addEventListener("click", (e) => {
            const btn = e.target.closest(".chat-suggestion-btn");
            if (!btn) return;
            const prompt = btn.dataset.prompt;
            if (prompt) {
                $dom.input.value = prompt;
                autoResizeInput();
                sendMessage();
            }
        });

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
