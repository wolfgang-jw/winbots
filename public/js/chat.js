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
 * 20. US-4.4 打开历史会话并完整重现：新增静态重现渲染路径（renderHistoryThink/Tools/Message）
 *     与 openSession，复用现有 CSS 类名保证与实时对话显示一致
 * 21. US-4.5 继续对话：openSession 增加 4 处加固（流式守卫 / 统计复位 / 本地历史同步 / 聚焦输入框）
 * 22. US-4.7 新建会话：新增 newSession() 主动分配全新会话并复位界面（F2-8）
 * 23. US-4.8 顶部菜单与多视图：新增 switchView() 在「会话/历史/状态」间切换（F2-9）
 * 24. US-4.8 历史视图：新增 renderSessionList() 渲染会话列表（打开/删除/新建）
 * 25. US-1.3 选中态与视图同步：switchView 增加合法值守卫 + init 末尾显式初始化默认视图
 * 26. US-1.4 导航项链接化：菜单点击拦截左键保留 href + ?view= 初始视图解析 + URL 同步
 * 27. US-2.2 新建入口迁移：顶部菜单「新建会话」动作项绑定点击（新建 + 切回会话视图）
 * 28. US-2.4 入口唯一：删除历史视图旧「新建会话」按钮及其绑定
 * 29. US-2.7 动作项链接化：href 携带 ?view=chat&new=1 + init 解析 ?new=1 进入空白新会话
 * 30. US-3.1 刷新即新会话：init 加载即 newSession()（绕过 sessionStorage 缓存），合并 ?new=1 分支
 * 31. US-HF-5 前端 DSML 兜底过滤：state.dsmlBlocked 声明 + sendStreamRequest 复位 +
 *     updateStreamContent 推送前过滤（最后防线，防止工具调用文本泄漏到界面）
 * 32. US-HF-6 多轮内容显示修复（前端防御）：finish 分支仅在 completed 时置空气泡引用，
 *     避免多轮循环下上游意外多发 finish 导致后续轮次内容被丢弃。
 * 33. [Sprint 5.2 / US-STAB-2] 内容保护：错误分支仅当气泡为空时才移除，非空则保留已生成内容
 * 34. [Sprint 5.2 / US-STAB-3] notice 处理：新增 case "notice"，以非错误样式展示截断提示
 * 35. [配置页 / US-CFG-PAGE-1~8] 配置视图：新增第 4 视图（config），按分组渲染 43 项配置（8 组，含浏览器工具配置与本机命令执行配置），
 *     支持保存（二次确认 + confirm:true）、密钥不回显、逐项错误提示、脏值提醒
 * 36. [批次三 / AP-11、SH-47、SH-48] 会话切换广播 winbots:session-changed（供审批通道跟随当前会话）；
 *     配置视图新增 shell 分组与 enumLabels（枚举项中文显示名）
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
        // [US-4.8] 顶部菜单与多视图元素
        menuItems: document.querySelectorAll(".top-menu__item"),
        viewChat: document.getElementById("view-chat"),
        viewHistory: document.getElementById("view-history"),
        viewStatus: document.getElementById("view-status"),
        // [配置页 / US-CFG-PAGE-1] 配置视图（第 4 视图）
        viewConfig: document.getElementById("view-config"),
        historyList: document.getElementById("history-list"),
        historyEmpty: document.getElementById("history-empty"),
        // [US-2.4] 历史视图旧「新建会话」按钮已删除，此处不再缓存其引用（入口唯一，F3-5）
        // [US-2.2] 顶部菜单「新建会话」动作项（US-2.1 新增）
        topMenuNew: document.getElementById("top-menu-new"),
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
        /** @type {boolean} [US-3.2] 是否处于"排空态" */
        draining: false,
        /** @type {boolean} [US-3.8] 是否已发生"排空超时"（显式超时标记） */
        drainTimedOut: false,
        /** @type {ReturnType<typeof setTimeout>|null} [US-3.2] 排空超时计时器句柄 */
        drainTimer: null,
        /** @type {string|null} [US-3.3] 本次对话请求的唯一标识（requestId） */
        currentRequestId: null,
        /** @type {string} 当前正在累积的助手消息 */
        currentAssistantContent: "",
        /** @type {HTMLElement|null} 当前助手消息的根元素（.message） */
        currentBubbleEl: null,
        /** @type {HTMLElement|null} 当前思考块元素 */
        currentThinkEl: null,
        /** @type {string} 当前正在累积的思考内容 */
        currentThinkContent: "",
        /** @type {HTMLElement|null} 当前信息栏元素 */
        currentInfoEl: null,
        /** @type {HTMLElement|null} 当前工具调用段元素（第 4 段） */
        currentToolEl: null,
        /** @type {string} [US-3.6] 本次回答的模型名（暂存） */
        currentModel: "",
        /** @type {string} [skill / §11] 本次回答由哪个 skill 装配（无则空串） */
        currentSkill: "",
        /** @type {boolean} [US-3.7] 本次回答是否已收尾（幂等标记） */
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
        /** @type {string} [US-4.8] 当前视图：chat / history / status / config */
        currentView: "chat",
        /** @type {boolean} [US-HF-5] 是否处于 DSML 块内（前端兜底过滤状态） */
        dsmlBlocked: false,
        /** @type {string} [批次二 / NB-06、AC-CUE-02] 本轮已收到的 notice 文案（"" 表示本轮没有 notice） */
        currentNoticeText: "",
    };

    // ============================================
    // 工具函数
    // ============================================

    /**
     * 转义 HTML 特殊字符，防止 XSS。
     * @param {string} text
     * @returns {string}
     */
    function escapeHtml(text) {
        // [R-49] 必须连引号一起转义：本函数产物既进文本节点，也进 value="…" / placeholder="…"
        //   / data-*="…" 这类**属性值**。旧实现走 div.textContent → div.innerHTML，只转 & < >
        //   （序列化文本节点不需要转引号），于是 string_array 类设置项（落盘为
        //   ["format","diskpart",…] JSON 文本）会把属性提前闭合：value="["format",…]"
        //   → 浏览器解析出的输入框值只剩 "["。后果：保存时 settings 里凭空多出一条
        //   …deny_list = "["，后端 parseSettingValue 判「必须为合法 JSON 数组文本」→
        //   整次保存 ERR_INVALID_VALUE「存在不合法变更」，而错误落点藏在未展开的
        //   设置项面板里，用户只看到一句摘要（与 R-48 同一表现）。
        //   改为显式字符表替换，顺带省掉一次性 DOM 节点分配。
        const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
        return String(text === null || text === undefined ? "" : text)
            .replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);


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
    /** [skill / C-5] 本轮激活的技能 dir（sessionStorage，不落 .env）；空串 = 不激活 */
    function getActiveSkill() {
        try { return sessionStorage.getItem("winbots.activeSkill") || ""; } catch { return ""; }
    }

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
        // [skill / §11] 有值才拼；无 skill 时字符串与改造前逐字一致（AC-14）
        const skillPart = info.skill ? ` · 🧩 技能：${escapeHtml(info.skill)}` : "";
        if (info.interrupted) {
            summary.innerHTML =
                `<span class="message__info-icon">⏹️</span> 已中断`
                + ` · ${escapeHtml(info.model || "unknown")}`
                + ` · ${formatClock(info.startTime)}`
                + ` · ${formatElapsed(info.elapsedMs)}`
                + ` · 📊 0 tokens`
                + skillPart
                + `<span class="message__info-arrow">▸</span>`;
        } else {
            summary.innerHTML =
                `<span class="message__info-icon">🤖</span> ${escapeHtml(info.model || "unknown")}`
                + ` · ${formatClock(info.startTime)}`
                + ` · ${formatElapsed(info.elapsedMs)}`
                + ` · 📊 ${info.usage.totalTokens} tokens`
                + skillPart
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
            skill: state.currentSkill,   // [skill / §11] 中断态同样要显示来源
        });

        return state.currentInfoEl;
    }

    /**
     * 渲染工具调用段（第 4 段，默认折叠）
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
     * [US-4.4] 静态渲染思考块（历史重现专用，F2-5）。
     * @param {HTMLElement} bubble - 目标气泡元素（.message__bubble）
     * @param {string} thinking - 完整思考文本
     * @returns {HTMLElement|null} 思考块元素；无内容时返回 null
     */
    function renderHistoryThink(bubble, thinking) {
        if (!bubble || !thinking) return null;

        const thinkEl = document.createElement("div");
        thinkEl.className = "message__think";
        thinkEl.style.width = "100%";

        // 标题（可折叠）
        const header = document.createElement("div");
        header.className = "message__think-header";
        header.innerHTML = '<span class="message__think-icon">💭</span> 思考过程'
            + '<span class="message__think-arrow">▸</span>';
        thinkEl.appendChild(header);

        // 主体（默认收起，与实时对话一致）
        const body = document.createElement("div");
        body.className = "message__think-body";
        body.style.display = "none";
        body.textContent = thinking;   // 纯文本，避免 Markdown 干扰
        thinkEl.appendChild(body);

        // 折叠交互
        header.addEventListener("click", () => {
            const arrow = header.querySelector(".message__think-arrow");
            if (body.style.display === "none") {
                body.style.display = "block";
                arrow.textContent = "▾";
            } else {
                body.style.display = "none";
                arrow.textContent = "▸";
            }
        });

        // 插入到气泡最前面（与实时对话一致：思考段在第 1 段）
        bubble.insertBefore(thinkEl, bubble.firstChild);
        return thinkEl;
    }

    /**
     * [US-4.4] 静态渲染工具调用段（历史重现专用，F2-5）。
     * @param {HTMLElement} bubble - 目标气泡元素（.message__bubble）
     * @param {Array<{name:string, arguments?:object, result?:string}>} toolCalls - 工具调用数组
     * @returns {HTMLElement|null} 工具段元素；无调用时返回 null
     */
    function renderHistoryTools(bubble, toolCalls) {
        if (!bubble || !Array.isArray(toolCalls) || toolCalls.length === 0) return null;

        const el = document.createElement("div");
        el.className = "message__tool";

        // 标题（可折叠）
        const header = document.createElement("div");
        header.className = "message__tool-header";
        header.innerHTML = '<span class="message__tool-icon">🔧</span> 工具调用'
            + '<span class="message__tool-arrow">▸</span>';
        el.appendChild(header);

        // 主体（默认收起）
        const body = document.createElement("div");
        body.className = "message__tool-body";
        body.style.display = "none";
        el.appendChild(body);

        // 逐条追加调用信息（名称 + 参数 + 结果）
        for (const tc of toolCalls) {
            const line = document.createElement("div");
            line.className = "message__tool-item";

            let text = `调用：${tc.name}`;
            if (tc.arguments && Object.keys(tc.arguments).length > 0) {
                text += `\n参数：${JSON.stringify(tc.arguments)}`;
            }
            if (tc.result !== undefined) {
                text += `\n结果：${tc.result}`;
            }
            line.textContent = text;
            body.appendChild(line);
        }

        // 折叠交互
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

        // 插入到气泡内、回答段之前（与实时对话一致：工具段在思考段之后、回答段之前）
        const answerEl = bubble.querySelector(".message__answer");
        if (answerEl) {
            bubble.insertBefore(el, answerEl);
        } else {
            bubble.appendChild(el);
        }
        return el;
    }

    /**
     * [US-4.4] 静态渲染一条历史消息（历史重现专用，F2-4/F2-5）。
     * @param {{role:string, content:string|null, meta:object|null}} msg - 历史消息
     * @returns {HTMLElement} 消息根元素（.message）
     */
    function renderHistoryMessage(msg) {
        const role = msg.role === "assistant" ? "assistant"
            : (msg.role === "user" ? "user" : "error");

        // 1. 复用骨架（assistant 会创建「回答段」；user/error 直接渲染正文）
        const el = createMessageEl(role, msg.content || "");
        const bubble = getBubbleOf(el);

        // 2. 非 assistant：仅正文，直接返回
        if (role !== "assistant") {
            return el;
        }

        // 3. 移除流式光标：createMessageEl 会为 assistant 创建 .message__cursor，
        //    历史重现是静态的，不应有闪烁光标（与实时对话完成态一致）。
        const cursor = bubble.querySelector(".message__cursor");
        if (cursor) cursor.remove();

        const meta = msg.meta || {};

        // 4. 思考段（第 1 段）：插到气泡最前
        if (meta.thinking) {
            renderHistoryThink(bubble, meta.thinking);
        }

        // 5. 工具段（第 4 段）：插到回答段之前
        if (Array.isArray(meta.toolCalls) && meta.toolCalls.length > 0) {
            renderHistoryTools(bubble, meta.toolCalls);
        }

        // 6. 信息栏（第 3 段）：追加到气泡末尾
        //    复用 renderInfoBar（其入参为 .message 根元素，内部自行下钻到气泡）
        const usage = meta.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        const elapsedMs = typeof meta.elapsedMs === "number" ? meta.elapsedMs : 0;
        const startTime = meta.startedAt ? new Date(meta.startedAt)
            : new Date(Date.now() - elapsedMs);

        renderInfoBar(el, {
            model: meta.model || "",
            startTime,
            elapsedMs,
            usage,
            raw: meta,
            interrupted: !!meta.interrupted,   // [US-3.6] 中断态信息栏
        });

        // 7. 绑定回答段折叠联动（与 addMessage 中 assistant 的逻辑一致）
        bindAnswerToggle(el);

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
     * [US-4.4] 为助手消息绑定「回答段折叠联动」（从 addMessage 抽取的公共逻辑）。
     * @param {HTMLElement} el - 消息根元素（.message）
     */
    function bindAnswerToggle(el) {
        const answerHeader = el.querySelector(".message__answer-header");
        const answerBody = el.querySelector(".message__answer-body");
        if (!answerHeader || !answerBody) return;

        answerHeader.addEventListener("click", () => {
            const arrow = answerHeader.querySelector(".message__answer-arrow");
            const collapsed = answerBody.style.display === "none";
            if (collapsed) {
                answerBody.style.display = "block";
                arrow.textContent = "▾";

                const thinkEl = el.querySelector(".message__think");
                if (thinkEl) thinkEl.style.display = "";

                const toolEl = el.querySelector(".message__tool");
                if (toolEl) toolEl.style.display = "";

                const infoEl = el.querySelector(".message__info");
                if (infoEl) infoEl.style.display = "";
            } else {
                answerBody.style.display = "none";
                arrow.textContent = "▸";

                const thinkEl = el.querySelector(".message__think");
                if (thinkEl) thinkEl.style.display = "none";

                const toolEl = el.querySelector(".message__tool");
                if (toolEl) toolEl.style.display = "none";

                const infoEl = el.querySelector(".message__info");
                if (infoEl) infoEl.style.display = "none";
            }
        });
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
        // [US-4.4] 逻辑抽取为 bindAnswerToggle，供实时对话与历史重现共用
        if (role === "assistant") {
            bindAnswerToggle(el);
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

        // [US-HF-5] 前端兜底过滤（与后端一致：匹配「竖线 + DSML + 竖线」标记）
        const DSML_OPEN_RE = /[|｜]\s*DSML\s*[|｜]/;
        const DSML_CLOSE_RE = /[|｜]\s*DSML\s*[|｜]/;
        if (!state.dsmlBlocked && DSML_OPEN_RE.test(text)) state.dsmlBlocked = true;
        if (state.dsmlBlocked) {
            if (DSML_CLOSE_RE.test(text)) state.dsmlBlocked = false;
            return;   // 块内不渲染
        }

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
     * @param {boolean} interrupted - 是否为"打断收尾"
     * @returns {boolean} - 本次是否实际执行了收尾
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
     * @param {boolean} visible
     */
    function setStopBtnVisible(visible) {
        if (!$dom.stopBtn) return;
        $dom.stopBtn.hidden = !visible;
    }

    /**
     * [US-3.2 / US-3.8] 启动排空超时兜底。
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
            // [批次三 / AP-11] 通知审批通道跟随当前会话：
            //   审批请求只路由到「命令来源会话」的界面（A 会话的批准只在 A 会话生效）。
            //   这里只广播事实（id 变了），不参与任何审批判定，也不触碰对话主链路。
            try {
                window.dispatchEvent(new CustomEvent("winbots:session-changed", { detail: { sessionId: id } }));
            } catch (err) {
                // 极老浏览器不支持 CustomEvent：审批通道退化为「首屏读 sessionStorage」
            }
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
        // [US-HF-5] 本轮回答开始：复位 DSML 过滤状态，避免上一条回答污染下一条
        state.dsmlBlocked = false;
        // [批次二 / NB-06] 本轮回答开始：复位本轮 notice 文案（终态文案守卫 + 截断抑制判据）
        state.currentNoticeText = "";

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
                    // [skill / C-5] 激活项走请求级入参（不落 .env）；空串 = 不激活任何 skill
                    skill: getActiveSkill(),
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
                                // [skill / §11] 记录来源技能：必须在 finalizeOnce 之前赋值（它立刻渲染信息栏），
                                //   也必须在 state.draining 判断之前（排空路径同样要显示来源）。
                                state.currentSkill = data.skill || "";
                                // [US-3.2] 排空态下：用户已打断，本次回答不应按"正常完成"处理。
                                if (state.draining) {
                                    finishStream();
                                    break;   // 跳出 switch，交由循环退出后的统一收尾处理
                                }

                                // [US-3.7] 正常收尾经统一入口（幂等）
                                finalizeOnce(false);

                                // [批次二 / NB-02、NB-05、NB-07] 终态语义事件：唯一依据是服务端 finish。
                                //   ① 只放在本分支，且已在上面 `if (state.draining) { … break; }` 之后
                                //      —— 用户点「停止」的排空态 / 断连 / 报错都不会走到这里（NB-03 ②③）；
                                //   ② 绝不放进 finalizeOnce()：它同时被排空与 abort 路径调用，
                                //      放进去会让「用户中止」也响一声（NB-03 ②、AC-CUE-03）；
                                //   ③ 轮次标识必须在此刻取值 —— finally 会把 currentRequestId 置 null，
                                //      在延时回调里读会全部变成 "unknown"，一次性闩锁失效（NB-04）；
                                //   ④ 150ms 延时、去重、截断抑制、开关判定全部下沉到 cue.js，
                                //      此处不做任何「光标是否消失 / 按钮是否可用」的渲染状态推断。
                                if (window.WinbotsCue) {
                                    window.WinbotsCue.notifyFinish({
                                        roundId: state.currentRequestId || "unknown",
                                        reason: data.reason || "",
                                    });
                                }

                                // [US-3.6] 暂存模型名
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
                                            skill: state.currentSkill,   // [skill / §11]
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

                                    // [US-HF-6] 信息栏生成后清理当前气泡引用。
                                    //   注意：仅当本次回答确实已收尾（completed=true）时才置空，
                                    //   避免多轮循环下若上游意外多发 finish 导致后续轮次内容被丢弃。
                                    if (state.completed) {
                                        state.currentBubbleEl = null;
                                        state.currentInfoEl = null;
                                        state.currentStartTime = 0;
                                    }
                                }
                                // [批次二 / NB-13、AC-CUE-02] 可见终态文案：提示音不是唯一信号（听障 / 静音 / 共享办公）。
                                //   若本轮已收到 notice（轮次上限截断等），保留 notice 文案不被「✅ 完成」覆盖，
                                //   否则「答案被截断」在界面上就看不到了（AC-CUE-02 后半句）。
                                if (state.currentNoticeText) {
                                    setStatus(`ℹ️ ${state.currentNoticeText}`, "chat-status--notice");
                                } else {
                                    setStatus(`✅ 完成 (${getTimeStr()})`);
                                }
                                break;

                            case "notice":
                                // [Sprint 5.2 / US-STAB-3] 截断/提示类事件（非错误样式）：
                                //   如「已达工具调用轮次上限」。不视为失败，仅提示用户。
                                // [批次二 / NB-06] 记录本轮 notice 文案：终态文案守卫（finish 分支）用
                                state.currentNoticeText = data.message || "";
                                setStatus(`ℹ️ ${data.message}`, "chat-status--notice");

                                // [批次二 / NB-06、AC-CUE-02] 截断类 notice 到达 → 抑制本轮完成音。
                                //   服务端是「finish 先发、notice 后发」（src/routes/chat.ts 第 802 / 812 行），
                                //   二者通常在同一分片内同步处理，因此这里能赶在 150ms 排期发声之前取消。
                                //   非截断类 notice（如「模型未返回正文，本轮已执行工具…」）由 cue.js 内部
                                //   按文案特征忽略，不会漏响正常完成。
                                if (window.WinbotsCue) {
                                    window.WinbotsCue.notifyNotice({
                                        roundId: state.currentRequestId || "unknown",
                                        message: data.message,
                                    });
                                }
                                break;

                            case "error":
                                // [US-3.4] 排空态下：用户已打断，此 error 很可能由"上游取消"引发
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
            if (!state.isStreaming) {
                if (wasDraining) {
                    // [US-3.6] 打断收尾（排空完成）：渲染"已中断"信息栏 + usage 记 0。
                    finalizeOnce(true);
                } else {
                    // 正常收尾：finalizeOnce(false) 只移除光标 + 置位；
                    finalizeOnce(false);
                    setStatus(`✅ 完成 (${getTimeStr()})`);
                }
            }
        } catch (err) {
            // 处理错误
            if (err.name === "AbortError") {
                // [US-3.2 / US-3.8] 区分两种 abort 来源
                clearDrainTimeout();          // [US-3.2] 清理计时器（幂等）

                // [US-3.8] 判定优先使用 drainTimedOut（显式超时标记）
                if (state.drainTimedOut || state.draining) {
                    // [US-3.6] 打断收尾（排空超时）
                    finalizeOnce(true);
                } else {
                    // [US-3.4] 非排空 abort（如页面卸载、外部取消）
                    finalizeOnce(false);
                    setStoppedStatus(false);
                }
                return fullContent; // 取消时返回已累积的内容
            }

            const errorMsg = err.message || String(err);
            setStatus(`❌ 请求失败`, "chat-status--error");

            // [Sprint 5.2 / US-STAB-2] 错误分支内容保护：
            //   原实现无条件 remove() 助手气泡，导致已流式生成的正文/思考/工具
            //   被一并清空。此处改为「仅当气泡为空时才移除」——
            //   非空则保留内容，仅移除流式光标，避免"内容清空"。
            const hasContent = !!state.currentAssistantContent
                || !!state.currentThinkContent
                || !!state.currentToolEl;

            if (state.currentBubbleEl && !hasContent) {
                // 气泡为空（未生成任何内容）：移除空占位气泡
                state.currentBubbleEl.remove();
                state.currentBubbleEl = null;
                state.currentAssistantContent = "";
                state.currentThinkEl = null;
                state.currentThinkContent = "";
                state.currentToolEl = null; // R1：一并清理工具段引用
            } else if (state.currentBubbleEl) {
                // 气泡非空：保留已生成内容，仅移除流式光标
                const cursor = state.currentBubbleEl.querySelector(".message__cursor");
                if (cursor) cursor.remove();
            }

            // 显示错误消息
            addMessage("error", `请求失败: ${errorMsg}`);
        } finally {
            state.isStreaming = false;
            state.abortController = null;
            // [US-3.2] 复位打断相关状态，保证下一轮回答干净
            state.stopRequested = false;
            state.draining = false;
            state.drainTimedOut = false;     // [US-3.8] 复位排空超时标记
            state.currentRequestId = null;   // [US-3.3] 清理本次请求标识

            // [US-3.5] 统一清理"指向旧气泡的流式引用"，确保新消息不串入旧气泡（F3-7）。
            //   原则：**只置引用为 null，绝不 remove() DOM**——
            //         旧气泡及其内容（正文/思考/工具）必须保留（F3-5）。
            state.currentBubbleEl = null;
            state.currentThinkEl = null;
            state.currentThinkContent = "";
            state.currentToolEl = null;
            state.currentInfoEl = null;
            state.currentStartTime = 0;
            state.currentAssistantContent = "";   // [US-3.5] 一并复位累积缓冲
            state.currentModel = "";
        state.currentModel = "";              // [US-3.6] 复位本次回答模型名
        // [C-31] ⚠️ 此处**不得**复位 state.currentSkill：
        //   finish 事件的处理顺序是「set currentSkill → finalizeOnce() → finishStream() → 渲染信息栏」，
        //   若在这里清空，随后渲染信息栏时读到空串，「🧩 技能：X」永远不会显示（实测就是这个 bug）。
        //   来源技能由「新一轮开始」(sendMessage 开头) 复位，生命周期刚好覆盖整轮渲染。
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
        state.currentSkill = "";              // [skill / §11] 复位来源技能（防上一轮串到本轮）
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
     * [US-4.4] 打开一个历史会话并完整重现（F2-4/F2-5）。
     * [US-4.5] 增加 4 处加固：流式守卫 / 统计复位 / 本地历史同步 / 聚焦输入框。
     * @param {string} id - 会话 ID
     * @returns {Promise<boolean>} - 是否成功打开
     */
    async function openSession(id) {
        if (!id) return false;

        // [US-4.5] 防串会话（D1）：流式输出进行中禁止切换会话。
        //   注意：此处**不覆盖状态栏**（避免干扰正在进行的流状态显示），
        //         仅以 console.warn 给出可观测提示。
        if (state.isStreaming) {
            console.warn("[US-4.5] 流式输出进行中，已拒绝切换会话:", id);
            return false;
        }

        try {
            const resp = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`);
            if (resp.status === 404) {
                console.warn("[US-4.4] 会话不存在:", id);
                return false;
            }
            if (!resp.ok) {
                console.warn("[US-4.4] 打开会话失败:", resp.status);
                return false;
            }

            const data = await resp.json();
            const messages = Array.isArray(data.messages) ? data.messages : [];

            // 1. 清空消息区（保留空状态元素引用，但隐藏）
            $dom.messages.querySelectorAll(".message").forEach((n) => n.remove());
            $dom.empty.style.display = messages.length > 0 ? "none" : "flex";

            // [US-4.5] 复位会话累计统计（D2）：会话累计是「按会话」的，
            //   切换会话必须清零，否则汇总栏显示的是上一个会话的数据。
            state.sessionStats.count = 0;
            state.sessionStats.promptTokens = 0;
            state.sessionStats.completionTokens = 0;
            state.sessionStats.totalTokens = 0;
            state.sessionStats.elapsedMs = 0;
            renderSessionSummary();   // 刷新汇总栏（count=0 时清空显示）

            // 2. 逐条静态渲染（完整重现）
            for (const msg of messages) {
                $dom.messages.appendChild(renderHistoryMessage(msg));
            }

            // [US-4.5] 同步本地渲染历史（D3）：用已加载消息重建 state.history，
            //   保证本地历史与当前会话一致（服务端仍持有权威历史，本地仅用于渲染）。
            state.history = messages.map((m) => ({
                role: m.role,
                content: m.content || "",
            }));

            // 3. 更新当前会话 ID（续接该会话）
            state.sessionId = id;
            persistSessionId(id);

            // 4. 滚动到底部
            scrollToBottom();

            // 5. 状态提示
            setStatus(`📂 已打开会话：${data.session?.title || id}`);

            // [US-4.5] 聚焦输入框（D4）：打开会话后可直接续聊，无需手动点击。
            $dom.input.focus();

            return true;
        } catch (e) {
            console.warn("[US-4.4] 打开会话异常:", e);
            return false;
        }
    }

    /**
     * [US-4.7] 新建会话并进入对话（F2-8）。
     *
     * 语义：主动放弃当前会话，分配一个**全新**会话 ID，并把界面复位为空白新会话，
     *       用户可直接开始一段新对话（T-4.7.1 / T-4.7.2）。
     *
     * 关键点（D1 绕过缓存）：
     *   ensureSessionId() 会**优先复用 sessionStorage 缓存**的会话 ID（US-2.3 标签页级隔离），
     *   因此"新建会话"**不能**只把 state.sessionId 置空（会被缓存"复活"），
     *   必须**显式调用** POST /api/chat/session 分配新 ID，并 persistSessionId 覆盖缓存。
     *
     * [US-3.1] 复用点：init() 加载时亦调用本函数，实现"刷新即新会话"。
     *
     * @returns {Promise<boolean>} - 是否成功新建
     */
    async function newSession() {
        // 1. 流式守卫（D2）：输出进行中拒绝新建，避免流写入被清空的界面。
        //    注意：不覆盖状态栏（避免干扰正在进行的流状态显示），仅 console.warn。
        if (state.isStreaming) {
            console.warn("[US-4.7] 流式输出进行中，已拒绝新建会话");
            return false;
        }

        // 2. 清空消息区，显示空状态（新会话无任何消息）
        $dom.messages.querySelectorAll(".message").forEach((n) => n.remove());
        $dom.empty.style.display = "flex";

        // 3. 复位会话累计统计（D3）：新会话从零开始，避免汇总栏残留上个会话数据
        state.sessionStats.count = 0;
        state.sessionStats.promptTokens = 0;
        state.sessionStats.completionTokens = 0;
        state.sessionStats.totalTokens = 0;
        state.sessionStats.elapsedMs = 0;
        renderSessionSummary();

        // 4. 复位本地渲染历史与流式引用（新会话无历史）
        state.history = [];
        state.currentBubbleEl = null;
        state.currentThinkEl = null;
        state.currentThinkContent = "";
        state.currentToolEl = null;
        state.currentInfoEl = null;
        state.currentStartTime = 0;
        state.currentAssistantContent = "";
        state.currentModel = "";
        state.currentSkill = "";
        state.completed = false;

        // 5. 分配全新会话 ID（D1 绕过缓存）：直接调服务端分配接口，
        //    不经 ensureSessionId 的 sessionStorage 缓存分支，确保拿到全新 ID。
        let newId = null;
        try {
            const resp = await fetch(CONFIG.SESSION_ENDPOINT, { method: "POST" });
            if (resp.ok) {
                const data = await resp.json();
                if (data && typeof data.sessionId === "string") {
                    newId = data.sessionId;
                }
            }
        } catch (e) {
            console.warn("[US-4.7] 分配新会话 ID 失败，降级为本地生成:", e);
        }

        // 降级兜底（D4）：接口异常时本地生成，格式与服务端保持一致（sess_<ts36>_<uuid>），
        // 以便降级 ID 亦能通过服务端 isValidSessionId 校验。
        if (!newId) {
            newId = "sess_" + Date.now().toString(36) + "_" + crypto.randomUUID();
        }

        state.sessionId = newId;
        persistSessionId(newId);   // 覆盖 sessionStorage 缓存，防止后续被旧 ID "复活"

        // 6. 状态提示 + 聚焦输入框
        setStatus("✅ 已新建会话，可开始输入", "chat-status--done");
        $dom.input.focus();

        return true;
    }

    // ============================================
    // [US-4.8] 顶部菜单与多视图切换（F2-9）
    // ============================================

    /**
     * [US-4.8] 切换视图（会话 / 历史 / 状态）。
     *
     * 语义：仅切换各视图容器的 hidden 属性与菜单高亮，**不销毁聊天 DOM**，
     *       因此 state.sessionId 与消息区内容保持不变——从会话→历史→会话
     *       仍停留在原会话（AC-3 切换不丢失当前会话上下文）。
     *
     * 关键依赖：CSS 中的 `[hidden] { display: none !important; }` 规则，
     *           否则 .chat-layout / .history-layout 的 display:flex 会覆盖 hidden。
     *
     * [US-1.3] 选中态与视图同步：
     *   - 增加合法值守卫，非法 view 回退 chat，避免三项全不选中导致"视图-选中态错位"（N4）；
     *   - 菜单高亮由下方 toggle(btn.dataset.view === view) 保证"恰好一项选中"。
     *
     * [US-1.4] URL 同步：用 history.replaceState 将当前视图写入 ?view=（不刷新），
     *   使地址栏与视图一致，便于分享/刷新（新标签页经 href 打开亦能解析）。
     *
     * @param {string} view - chat / history / status
     * @returns {boolean} - 是否切换成功
     */
    function switchView(view) {
        // [US-1.3] 合法值守卫：非法 view 回退到 chat，避免全不选中导致"视图-选中态错位"（N4）
        // [配置页 / US-CFG-PAGE-1] 扩为 4 视图
        const VALID_VIEWS = ["chat", "history", "status", "config"];
        if (!VALID_VIEWS.includes(view)) {
            console.warn("[US-1.3] 非法视图，回退到 chat:", view);
            view = "chat";
        }

        state.currentView = view;

        // 1. 切换视图容器显隐（仅切 hidden，不销毁 DOM）
        if ($dom.viewChat) $dom.viewChat.hidden = view !== "chat";
        if ($dom.viewHistory) $dom.viewHistory.hidden = view !== "history";
        if ($dom.viewStatus) $dom.viewStatus.hidden = view !== "status";
        if ($dom.viewConfig) $dom.viewConfig.hidden = view !== "config";   // [配置页 / US-CFG-PAGE-1]

        // 2. 菜单高亮
        //    —— 无需改动：新增第 4 项后自动覆盖，天然满足「恰好一项选中」（AC-STATUS-1）
        $dom.menuItems.forEach((btn) => {
            btn.classList.toggle("top-menu__item--active", btn.dataset.view === view);
        });

        // 3. 切到历史视图时刷新列表
        if (view === "history") {
            renderSessionList();
        }

        // 4. [配置页 / US-CFG-PAGE-1] 切到配置视图时拉取配置（AC-CFG-1）
        if (view === "config") {
            loadConfigView();
        }

        // [US-1.4] 同步 URL（不刷新）：使地址栏与当前视图一致，便于分享/刷新
        try {
            const url = new URL(location.href);
            url.searchParams.set("view", view);
            history.replaceState(null, "", url);
        } catch { /* 忽略 */ }

        return true;
    }

    /**
     * [US-4.8] 渲染历史会话列表（F2-3）。
     *
     * 数据来源：GET /api/chat/sessions（US-4.3），已按最后活动时间倒序。
     * 交互：
     *   - 点击列表项 → openSession(id) 打开并切回会话视图；
     *   - 点击删除按钮 → DELETE /api/chat/sessions/:id（US-4.6）后刷新列表。
     *
     * 安全：标题/时间经 escapeHtml 转义，防止 XSS。
     *
     * @returns {Promise<void>}
     */
    async function renderSessionList() {
        if (!$dom.historyList) return;
        try {
            const resp = await fetch("/api/chat/sessions");
            if (!resp.ok) {
                console.warn("[US-4.8] 加载会话列表失败:", resp.status);
                return;
            }
            const data = await resp.json();
            const sessions = (data && data.sessions) || [];

            // 空态处理
            if (sessions.length === 0) {
                $dom.historyList.innerHTML = "";
                if ($dom.historyEmpty) $dom.historyEmpty.hidden = false;
                return;
            }
            if ($dom.historyEmpty) $dom.historyEmpty.hidden = true;

            // 渲染列表（escapeHtml 转义，防 XSS）
            $dom.historyList.innerHTML = sessions.map((s) => `
                <li class="history-item" data-id="${escapeHtml(s.id)}">
                    <div class="history-item__main">
                        <div class="history-item__title">${escapeHtml(s.title || "新会话")}</div>
                        <div class="history-item__meta">${escapeHtml(s.updatedAtText || "")} · ${s.messageCount} 条消息</div>
                    </div>
                    <button class="history-item__delete" data-id="${escapeHtml(s.id)}">删除</button>
                </li>
            `).join("");

            // 点击列表项打开会话（删除按钮除外）
            $dom.historyList.querySelectorAll(".history-item").forEach((li) => {
                li.addEventListener("click", async (e) => {
                    if (e.target.closest(".history-item__delete")) return;
                    const ok = await openSession(li.dataset.id);
                    if (ok) switchView("chat");
                });
            });

            // 删除按钮
            $dom.historyList.querySelectorAll(".history-item__delete").forEach((btn) => {
                btn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    // [modal] 新增二次确认：会话删除不可恢复。取消则什么都不做（不发请求、不重绘）
                    const ok = await WinbotsConfirm({
                        source: "delete-session",
                        title: "删除历史会话",
                        message: "确认删除这个会话？删除后不可恢复。",
                        okText: "删除",
                        cancelText: "取消",
                        danger: true
                    });
                    if (!ok) return;
                    try {
                        await fetch("/api/chat/sessions/" + encodeURIComponent(btn.dataset.id), {
                            method: "DELETE",
                        });
                    } catch (err) {
                        console.warn("[US-4.8] 删除会话失败:", err);
                    }
                    renderSessionList();   // 刷新列表（[modal] 必须留在 if (!ok) return 之后）
                });
            });
        } catch (e) {
            console.warn("[US-4.8] 加载会话列表异常:", e);
        }
    }

    // ============================================
    // [配置页 / US-CFG-PAGE-1~8] 配置视图
    // ============================================

    /** 配置视图运行时状态（不放入全局 state，避免污染聊天状态机） */
    const configState = {
        /** @type {Array<object>|null} 服务端返回的 items */
        items: null,
        /** @type {boolean} 是否有未保存改动（F-CFG-1） */
        dirty: false,
        /** @type {Set<string>} [需求域 R / R-17、§9.2] 已标记清空的密钥键（保存后生效） */
        clearKeys: new Set(),
        /** [C-11 / §9.3] 本次 GET 拿到的扫描版本；PUT 必须原样带回 */
        scanVersion: "",
        /** [C-11 / §11] 工具树（目录 + 工具组，含门禁状态与设置项） */
        toolTree: [],
        /** [C-11 / §10.2] 底部遗留键 */
        orphanKeys: [],
        /** 待提交的开关变更：节点 id → 布尔（仅记录用户真正改过的） */
        dirToggles: {},
        groupToggles: {},
        /** 待提交的设置项变更在保存时直接从 DOM 收集（见 collectToolChanges），不另存草稿状态 */
        /** 待提交的「恢复默认」（删键）集合 */
        restoreKeys: new Set(),
        /** 已展开的设置项折叠区（"dir:local" / "group:local/shell"） */
        openSettings: new Set(),
        /* ---------- [skill / §12.2] 技能区 ---------- */
        /** @type {Array<object>} 服务端 skillTree（与 toolTree 并列） */
        skillTree: [],
        /** @type {Object<string, boolean>} 待提交的技能开关：dir → 布尔 */
        skillToggles: {},
        /** @type {Array<string>} 扫描告警（层级超限 / 多余文件 / 嵌套冲突） */
        skillWarnings: [],
        /** @type {string} 技能扫描版本（仅展示与排查；PUT 只校验工具的 scanVersion） */
        skillScanVersion: "",
        /** @type {string} 本轮激活的技能 dir（**不落 .env**，存 sessionStorage，C-5） */
        activeSkill: "",
    };

    /** 拉取并渲染配置视图（进入视图 / 保存成功后调用） */
    async function loadConfigView() {
        const box = document.getElementById("config-form");
        if (!box) return;
        box.innerHTML = '<div class="config-loading">加载中…</div>';

        try {
            const resp = await fetch("/api/config", { cache: "no-store" });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            configState.items = data.items || [];
            configState.scanVersion = data.scanVersion || "";
            configState.toolTree = data.toolTree || [];
            configState.orphanKeys = data.orphanKeys || [];
            // [skill] 技能区：与工具树同一份 GET 返回，一次拿全
            configState.skillTree = data.skillTree || [];
            configState.skillWarnings = data.skillWarnings || [];
            configState.skillScanVersion = data.skillScanVersion || "";
            // 激活项从 sessionStorage 恢复（它不落 .env，刷新页面后仍需保持用户选择）
            try { configState.activeSkill = sessionStorage.getItem("winbots.activeSkill") || ""; } catch { /* 忽略 */ }
            // 重新拉取后，先前待提交的工具变更全部作废（服务端已是权威状态）
            configState.dirToggles = {};
            configState.groupToggles = {};
            configState.restoreKeys = new Set();
            renderConfigForm(box);
            bindClearButtons(box);   // [需求域 R / R-17] 绑定密文项「清空」按钮（§9.2）
            setConfigDirty(false);
            renderConfigEnvNotice(data);
        } catch (e) {
            box.innerHTML = `<div class="config-error">加载配置失败：${escapeHtml(String(e.message || e))}</div>`;
        }
    }

    /** 按分组渲染 43 个控件 / 8 组（AC-CFG-1 / 需求 §4.8.2；[批次三 / SH-48] 计数与 CONFIG_KEYS 同步） */
    function renderConfigForm(box) {
        const titles = {
            app: "应用配置", llm: "LLM 配置",
            log: "LLM 对话日志配置", stab: "复杂问题稳定性配置",



        };
        // [C-11] 系统项只剩 4 组（file / internet / browser / shell 已下沉为工具树）；
        //   按数据里实际出现的分组渲染，避免日后新增系统项分组时在页面上「消失」
        const groups = [...new Set((configState.items || []).map((it) => it.group))];

        box.innerHTML = groups.map((g) => {
            const items = (configState.items || []).filter((it) => it.group === g);
            if (items.length === 0) return "";
            return `
              <section class="config-section">
                <h3 class="config-section__title">${escapeHtml(titles[g] || g)}</h3>
                ${items.map((it) => renderConfigItem(it)).join("")}
              </section>`;
        }).join("");

        // 绑定输入事件：任何修改 → 置脏（F-CFG-1）
        // [C-11 / §11 / §10.2] 工具树与遗留键区块接在系统项之后
        box.insertAdjacentHTML(
            "beforeend",
            renderToolSection() + renderSkillSection() + renderOrphanSection(),
        );
        bindToolTreeEvents(box);
        bindSkillTreeEvents(box);

        box.querySelectorAll("[data-config-key]").forEach((el) => {
            el.addEventListener("input", () => setConfigDirty(true));
            el.addEventListener("change", () => setConfigDirty(true));
        });
    }

    /** 单个控件：按 type 映射控件形态（需求 §4.8.2） */
    function renderConfigItem(it) {
        const id = `cfg-${it.key}`;
        let control;
        if (it.type === "bool") {
            control = `<select class="config-input" id="${id}" data-config-key="${it.key}">
                <option value="true"${it.value === "true" ? " selected" : ""}>true</option>
                <option value="false"${it.value === "false" ? " selected" : ""}>false</option>
              </select>`;
        } else if (it.type === "enum") {
            // [批次三 / SH-47 ①] 有 enumLabels 时显示中文（值仍是原始 token，写回 .env 不变），
            //   否则回退显示原始值（既有枚举项行为完全不变）
            const labels = it.enumLabels || {};
            control = `<select class="config-input" id="${id}" data-config-key="${it.key}">
                ${(it.enumValues || []).map((v) =>
                    `<option value="${escapeHtml(v)}"${it.value === v ? " selected" : ""}>${escapeHtml(labels[v] || v)}</option>`).join("")}
              </select>`;
        } else if (it.secret) {
            // AC-CFG-4：不回显明文，占位符显示掩码，留空=不修改
            control = `<input class="config-input" id="${id}" data-config-key="${it.key}"
                type="password" autocomplete="new-password"
                placeholder="${escapeHtml(it.mask || "****")}" value="">`;
        } else {
            const numeric = it.type === "int" ? ' inputmode="numeric"' : "";
            control = `<input class="config-input" id="${id}" data-config-key="${it.key}"
                type="text"${numeric} value="${escapeHtml(String(it.value ?? ""))}">`;
        }

        // [需求域 R / R-17、§9.2] 密文且非必需项 → 「清空」按钮（已设置时可见；标记后换成「撤销」+ 提示）
        //   必需项（如 LLM_API_KEY）不渲染该按钮：界面隐藏与接口拒绝两条必须同时具备（§9.2 约束 4）
        const clearable = !!it.secret && !it.required;
        const marked = clearable && configState.clearKeys.has(it.key);
        const secretActions = clearable
            ? `<div class="config-item__clear-row">
                 <button type="button" class="config-item__clear" data-clear-for="${escapeHtml(it.key)}"${it.hasValue || marked ? "" : " hidden"}>清空</button>
                 <button type="button" class="config-item__undo" data-undo-for="${escapeHtml(it.key)}"${marked ? "" : " hidden"}>撤销</button>
                 <span class="config-item__clear-note" data-clear-note-for="${escapeHtml(it.key)}"${marked ? "" : " hidden"}>已标记清空，保存后生效</span>
               </div>`
            : "";
        const badges = [];
        if (it.restartRequired) badges.push('<span class="config-badge config-badge--restart">需重启</span>');
        if (it.secret && it.hasValue) badges.push('<span class="config-badge config-badge--set">已设置</span>');
        if (it.shadowed) badges.push('<span class="config-badge config-badge--shadow">被系统环境变量覆盖</span>');

        return `
          <div class="config-item">
            <div class="config-item__head">
              <label class="config-item__label" for="${id}">${escapeHtml(it.label)}</label>
              <code class="config-item__key">${escapeHtml(it.key)}</code>
              ${badges.join("")}
            </div>
            ${control}
            ${secretActions}
            <div class="config-item__desc">${escapeHtml(it.desc || "")}</div>
            ${it.shadowed
              ? '<div class="config-item__warn">⚠️ 该系统环境变量已存在，改 <code>.env</code> 需先清除系统环境变量方可生效（只读提示）。</div>'
              : ""}
            <div class="config-item__error" data-error-for="${it.key}" hidden></div>
          </div>`;
    }

    /**
     * [需求域 R / R-17、§9.2] 绑定密文项的「清空 / 撤销」按钮，以及「重新输入非空值自动取消标记」。
     * 说明：清空意图只记录在 configState.clearKeys，保存时以独立 clear 字段提交；
     *       输入框内的空串始终表示「不修改」，两者语义严格区分。
     * @param {HTMLElement} box - 配置表单容器
     */
    function bindClearButtons(box) {
        box.querySelectorAll("[data-clear-for]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const key = btn.dataset.clearFor;
                if (!key) return;
                configState.clearKeys.add(key);
                syncClearUi(key, true);
                setConfigDirty(true);
            });
        });

        box.querySelectorAll("[data-undo-for]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const key = btn.dataset.undoFor;
                if (!key) return;
                configState.clearKeys.delete(key);
                syncClearUi(key, false);
                setConfigDirty(true);
            });
        });

        // §9.2：若重新输入非空值，标记自动取消
        (configState.items || []).forEach((it) => {
            if (!it.secret || it.required) return;
            const input = document.getElementById(`cfg-${it.key}`);
            if (!input) return;
            input.addEventListener("input", () => {
                if (input.value.trim() !== "" && configState.clearKeys.has(it.key)) {
                    configState.clearKeys.delete(it.key);
                    syncClearUi(it.key, false);
                }
            });
        });
    }

    /** 同步某一项的清空标记 UI（输入框禁用、按钮与提示显隐） */
    function syncClearUi(key, marked) {
        const meta = (configState.items || []).find((x) => x.key === key);
        const hasValue = !!(meta && meta.hasValue);
        const input = document.getElementById(`cfg-${key}`);
        const clearBtn = document.querySelector(`[data-clear-for="${key}"]`);
        const undoBtn = document.querySelector(`[data-undo-for="${key}"]`);
        const note = document.querySelector(`[data-clear-note-for="${key}"]`);
        if (input) {
            input.disabled = marked;
            if (marked) input.value = "";
        }
        if (clearBtn) clearBtn.hidden = marked || !hasValue;
        if (undoBtn) undoBtn.hidden = !marked;
        if (note) note.hidden = !marked;
    }

    /** 顶部提示：.env 不存在时告知将自动创建（F-CFG-6 / AC-CFG-9） */
    function renderConfigEnvNotice(data) {
        const el = document.getElementById("config-notice");
        if (!el) return;
        if (data.envExists === false) {
            el.hidden = false;
            el.textContent = `未找到 .env（${data.envPath}），保存时将自动创建。`;
        } else {
            el.hidden = true;
            el.textContent = "";
        }
    }

    /** 置脏/清脏（F-CFG-1/F-CFG-4） */
    function setConfigDirty(dirty) {
        configState.dirty = dirty;
        const badge = document.getElementById("config-dirty");
        const btn = document.getElementById("config-save-btn");
        if (badge) badge.hidden = !dirty;
        if (btn) btn.disabled = !dirty;
    }

    /** 采集改动：仅返回与当前值不同的键；secret 留空则不提交（AC-CFG-4） */
    function collectConfigChanges() {
        const out = {};
        (configState.items || []).forEach((it) => {
            const el = document.getElementById(`cfg-${it.key}`);
            if (!el) return;
            const raw = el.value;
            if (it.secret) {
                if (configState.clearKeys.has(it.key)) return;   // [R-17] 已标记清空 → 只经 clear 字段提交，不进 changes
                if (raw.trim() !== "") out[it.key] = raw.trim();   // 留空 = 不修改
                return;
            }
            const next = String(raw).trim();
            if (next !== String(it.value ?? "")) out[it.key] = next;
        });
        return out;
    }

    /** 保存（AC-CFG-2 / F-CFG-2~F-CFG-5） */
    async function saveConfig() {
        const changes = collectConfigChanges();
        const toolChanges = collectToolChanges();
        const keys = Object.keys(changes);
        // [需求域 R / R-17] 清空项单独收集：与普通修改项分开确认、分开提交（§9.2 互斥校验）
        const clearKeys = [...configState.clearKeys];
        const toolCount = Object.keys(toolChanges.dirToggles).length
            + Object.keys(toolChanges.groupToggles).length
            + Object.keys(toolChanges.settings).length
            + toolChanges.restore.length
            + Object.keys(toolChanges.skillToggles || {}).length;   // [skill] 技能开关也算改动
        if (keys.length === 0 && clearKeys.length === 0 && toolCount === 0) return;

        // 二次确认（列出将被修改的键）
        const confirmParts = [];
        const dirCount = Object.keys(toolChanges.dirToggles).length;
        const groupCount = Object.keys(toolChanges.groupToggles).length;
        if (dirCount + groupCount > 0) {
            confirmParts.push("工具开关：目录 " + dirCount + " 个、工具组 " + groupCount + " 个");
        }
        const settingKeys = Object.keys(toolChanges.settings);
        if (settingKeys.length > 0) confirmParts.push("工具设置项：\n" + settingKeys.join("\n"));
        if (toolChanges.restore.length > 0) {
            confirmParts.push("恢复默认（删键）：\n" + toolChanges.restore.join("\n"));
        }
        if (keys.length > 0) confirmParts.push(`修改：\n${keys.join("\n")}`);
        // [skill / §12.2] 只改技能开关时确认框必须有内容，否则用户看不到将改什么
        const skillToggleKeys = Object.keys(toolChanges.skillToggles || {});
        if (skillToggleKeys.length > 0) {
            confirmParts.push("技能开关：\n" + skillToggleKeys
                .map((d) => `${d} → ${toolChanges.skillToggles[d] ? "开" : "关"}`).join("\n"));
        }
        if (clearKeys.length > 0) confirmParts.push(`清空密钥（保存后写为空值）：\n${clearKeys.join("\n")}`);
        // [modal] 原生 confirm 改页面内确认框：必须 await（同步布尔 → Promise<boolean>）
        const okConfirm = await WinbotsConfirm({
            source: "save-config",
            title: "确认应用变更",
            message: `确认应用以下变更？\n\n${confirmParts.join("\n\n")}\n\n修改前会自动备份 .env。`,
            okText: "应用变更",
            cancelText: "取消",
            danger: false
        });
        if (!okConfirm) return;   // [modal] 取消（含 Esc / 点遮罩）一律不写盘


        // 清空上一次的逐项错误
        document.querySelectorAll("[data-error-for],[data-node-error]").forEach((n) => { n.hidden = true; n.textContent = ""; });
        const tfh = document.getElementById("config-tool-fields");
        if (tfh) { tfh.hidden = true; tfh.textContent = ""; }
        const resultEl = document.getElementById("config-result");
        if (resultEl) resultEl.textContent = "保存中…";

        try {
            const resp = await fetch("/api/config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    confirm: true,
                    scanVersion: configState.scanVersion,   // [§9.3] 版本过期后端会 409
                    changes,
                    clear: clearKeys,
                    dirToggles: toolChanges.dirToggles,
                    groupToggles: toolChanges.groupToggles,
                    settings: toolChanges.settings,
                    restore: toolChanges.restore,
                    skillToggles: toolChanges.skillToggles,   // [skill / §12.2]
                }),
            });
            const data = await resp.json();

            if (resp.status === 409) {
                // [§9.3] 扫描版本过期：工具目录有变化或页面停留过久 → 重扫后让用户重新确认
                if (resultEl) {
                    resultEl.textContent = "⚠️ 工具目录已变化（扫描版本过期），已自动刷新，请复核后重新保存。";
                }
                await loadConfigView();
                return;
            }
            if (!resp.ok) {
                // AC-CFG-3/F-CFG-5：逐项显示原因，**不清空用户已填内容**（含开关节点的落点，见下）
                // 无落点的错误（例如目录/工具组开关被后端拒绝）统一汇总到工具区顶部，绝不静默吞掉
                const toolFieldHolder = document.getElementById("config-tool-fields");
                if (data.fields) {
                    Object.entries(data.fields).forEach(([k, reason]) => {
                        // [R-47] 错误落点有三类：系统项/工具设置项（key = 配置键）、目录节点（key = 目录路径）、工具组（key = 组 id）
                        const box = document.querySelector(`[data-error-for="${k}"]`)
                            || document.querySelector(`[data-node-error="dir:${k}"]`)
                            || document.querySelector(`[data-node-error="group:${k}"]`)
                            || document.querySelector(`[data-skill-error="${k}"]`);   // [skill] 第四类落点：技能节点（key = dir）
                        if (!box) {
                            if (toolFieldHolder) {
                                toolFieldHolder.hidden = false;
                                toolFieldHolder.textContent += (toolFieldHolder.textContent ? "\n" : "")
                                    + "· " + k + "：" + reason;
                            }
                        }
                        if (box) { box.hidden = false; box.textContent = `❌ ${reason}`; revealToolError(box); }
                        // [R-48] 顺手把「工具区顶部汇总」也点亮：摘要里至少给出键名，
                        //   即使落点节点在页面下方也能对上号
                        if (box && toolFieldHolder) {
                            toolFieldHolder.hidden = false;
                            toolFieldHolder.textContent += (toolFieldHolder.textContent ? "\n" : "")
                                + "· " + k + "：" + reason;
                        }
                    });
                }
                if (resultEl) resultEl.textContent = `❌ 保存失败（${data.code || resp.status}）：${data.error || ""}`;
                return;
            }

            // 成功：分组提示（AC-CFG-5 / F-CFG-3）
            const hot = data.hotApplied || [];
            const need = data.restartRequired || [];
            const written = data.written || [];
            const restored = data.restored || [];
            // [C-08 回执] 后端字段是 written / restored（旧前端读的是 data.changed，已废弃）
            const lines = [`✅ 已写入 ${written.length} 项、恢复默认 ${restored.length} 项。`];
            if (restored.length) lines.push(`↩️ 已恢复默认（键已删除）：${restored.join(", ")}`);
            if (Array.isArray(data.managedByValues) && data.managedByValues.length) {
                lines.push(`⚡ 工具配置即时生效（取值层读 .env）：${data.managedByValues.length} 项`);
            }
            if (Array.isArray(data.skippedByWhitelist) && data.skippedByWhitelist.length) {
                lines.push(`⚠️ 未注入进程环境（不在热重载白名单）：${data.skippedByWhitelist.join(", ")}`);
            }
            if (data.backupFile) lines.push(`🗂 备份：data/envbk/${data.backupFile}`);
            if (Array.isArray(data.cleared) && data.cleared.length > 0) lines.push(`🧹 已清空：${data.cleared.join(", ")}`);
            if (data.envCreated) lines.push("🆕 已创建 .env（首次保存）。");
            if (hot.length) lines.push(`⚡ 已立即生效：${hot.join(", ")}`);
            if (need.length) lines.push(`🔁 需重启服务后生效：${need.join(", ")}`);
            if (data.degraded) lines.push(`⚠️ ${data.degraded}`);
            if (resultEl) resultEl.textContent = lines.join("\n");

            configState.clearKeys.clear();   // [R-17] 保存成功后清空标记（服务端已落盘为空值）
            // [C-11] 工具域的待提交变更同样清空：随后 loadConfigView() 会拿到服务端的权威状态
            configState.dirToggles = {};
            configState.groupToggles = {};
            configState.skillToggles = {};           // [skill]
            configState.restoreKeys = new Set();
            await loadConfigView();   // F-CFG-4：重拉使 mask 等派生字段刷新
            setConfigDirty(false);
        } catch (e) {
            if (resultEl) resultEl.textContent = `❌ 请求失败：${String(e.message || e)}`;
        }
    }

    /** 有脏值时离开页面提醒（F-CFG-1） */
    window.addEventListener("beforeunload", (e) => {
        if (configState.dirty) {
            e.preventDefault();
            e.returnValue = "";
        }
    });

    /**
     * 自动调整输入框高度
     */
    /* ============================================
     * [C-11 / 规范 §11] 工具树：目录 → 工具组 → 组设置项
     *   数据来自 GET /api/config 的 toolTree（后端已算好门禁与挂起原因）。
     *   ⚠️ 前端灰显/禁用只是提示，写入端仍会独立复查（§3.5），不得以此当安全边界。
     * ============================================ */

    /** 把嵌套的工具树摊平成数组（渲染与收集都用它） */
    function flattenToolTree(nodes, out) {
        const acc = out || [];
        (nodes || []).forEach((n) => {
            acc.push(n);
            flattenToolTree(n.children, acc);
        });
        return acc;
    }

    /** 折叠区的键："dir:local" / "group:local/shell" */
    function toolNodeDomKey(node) {
        return node.type + ":" + node.id;
    }

    /** 组内可见工具名摘要 */
    function toolNamesText(node) {
        if (!node.tools || node.tools.length === 0) return "（当前无可见工具）";
        return node.tools.map((t) => t.visibleName).join("、");
    }

    /* ============================================================
     * [C-11 / §8.2 / §11] 门禁就地重算
     *   规范要点：父开 → 子级可各自独立开关；父关 → 全部子孙关闭且界面不可操作。
     *   ⚠️ 页面上「灰显/可勾选」只是提示，最终判定仍在后端（§3.5）。
     *     但如果前端不重算，用户勾了父级后子级永远停在 disable，
     *     且会带着「上级已关闭却要开启子级」的草稿提交，被后端判为
     *     ERR_INVALID_VALUE「存在不合法变更」—— 这两件事是同一个根因。
     * ============================================================ */

    /** 节点开关在「当前草稿状态」下的值（本次改过就用草稿，否则用服务端值） */
    function toolNodeDraftOn(node) {
        const map = node.type === "dir" ? configState.dirToggles : configState.groupToggles;
        return Object.prototype.hasOwnProperty.call(map, node.id) ? map[node.id] === true : node.on === true;
    }

    /** 服务端的目录开关快照（id = 目录路径，如 "internet"） */
    function serverDirOnMap() {
        const m = new Map();
        flattenToolTree(configState.toolTree).forEach((n) => {
            if (n.type === "dir") m.set(n.id, n.on === true);
        });
        return m;
    }

    /** 挂起的目录集合（自身加载失败 / 声明非法：其整棵子树不可用） */
    function suspendedDirSet() {
        const s = new Set();
        flattenToolTree(configState.toolTree).forEach((n) => {
            if (n.type === "dir" && n.suspended === true) s.add(n.id);
        });
        return s;
    }

    /** 目录在「当前草稿状态」下是否开启 */
    function dirOnByDraft(path, serverOn) {
        if (Object.prototype.hasOwnProperty.call(configState.dirToggles, path)) {
            return configState.dirToggles[path] === true;
        }
        return serverOn.get(path) === true;
    }

    /**
     * 祖先链状态（不含自身）：null = 全开；"dir_off" = 某层关闭；"dir_suspended" = 某层挂起。
     * 判定顺序与后端 parentChainState/dirChainState 一致（先判挂起、再判开关）。
     */
    function ancestorChainState(node, serverOn, suspendedDirs) {
        const segs = String(node.id || "").split("/").filter((s) => s.length > 0);
        segs.pop();                        // 自身（目录名 / 入口文件名）不算祖先
        let acc = "";
        for (const seg of segs) {
            acc = acc === "" ? seg : acc + "/" + seg;
            if (suspendedDirs.has(acc)) return "dir_suspended";
            if (!dirOnByDraft(acc, serverOn)) return "dir_off";
        }
        return null;
    }


    /**
     * 祖先链在**服务端快照**下是否全开（不含自身）。
     * 只在响应里缺少 `suspended` 字段（旧缓存页面）时用于兜底反推「自身是否挂起」。
     */
    function serverAncestorAllOn(node, serverOn, suspendedDirs) {
        const segs = String(node.id || "").split("/").filter((s) => s.length > 0);
        segs.pop();
        let acc = "";
        for (const seg of segs) {
            acc = acc === "" ? seg : acc + "/" + seg;
            if (suspendedDirs.has(acc)) return false;
            if (serverOn.get(acc) !== true) return false;
        }
        return true;
    }

    /** 节点在「当前草稿状态」下的门禁结果（渲染首屏与交互重算共用同一套判定） */
    function toolNodeGate(node, serverOn, suspendedDirs) {
        const chain = ancestorChainState(node, serverOn, suspendedDirs);


        // [R-50] 「自身挂起」必须是**自身**属性，不能拿服务端的 disabled 反推：
        //   disabled = 祖先没全开 ∨ 自身挂起，而服务端算 disabled 用的是**已保存**的开关值。
        //   一旦用户把父级勾上（草稿里父级变开），chain 立刻变 null，旧写法
        //   `node.disabled === true && chain === null` 就成立 → 把「因上级关闭而灰显」
        //   误判成「自身挂起」→ 子级永远解不了禁。这正是用户看到的
        //   「勾了顶层目录，下一层始终 disable」。
        //   正确口径：有 suspended 字段就只认它（后端恒给布尔值）；缺字段（旧缓存页面）
        //   才退化为「服务端祖先全开却被判 disabled」——此时才只可能是自身挂起。
        const selfSuspended = node.suspended === true
            || (typeof node.suspended !== "boolean"
                && node.disabled === true
                && serverAncestorAllOn(node, serverOn, suspendedDirs));
        const disabled = chain !== null || selfSuspended;
        const reason = selfSuspended
            ? (node.suspendReason || node.reason || "不可用")
            : chain === "dir_suspended" ? "上级目录不可用"
                : chain === "dir_off" ? "上级目录已关闭"
                    : undefined;
        const on = toolNodeDraftOn(node);
        return { disabled, reason, on, available: !disabled && on, selfSuspended };
    }

    /** 节点徽标（首屏与重算共用；避免两处文案漂移） */
    function toolNodeBadgeHtml(node, gate) {
        const badges = [];
        if (gate.disabled) {
            badges.push(`<span class="config-badge config-badge--shadow">${escapeHtml(gate.reason || "不可用")}</span>`);
        } else if (!gate.on) {
            badges.push('<span class="config-badge">已关闭</span>');
        } else {
            badges.push('<span class="config-badge">已开启</span>');
        }
        if (node.type === "group" && gate.available) {
            badges.push(`<span class="config-badge config-badge--set">模型可见 ${(node.tools || []).length} 个</span>`);
        }
        return badges.join("");
    }

    /** 撤掉某目录下「想要开启」的子孙待提交项（父关时子孙一律不可操作，§8.2） */
    function dropEnabledDescendantDrafts(dirId) {
        const prefix = dirId + "/";
        [configState.dirToggles, configState.groupToggles].forEach((map) => {
            Object.keys(map).forEach((k) => {
                if (!k.startsWith(prefix)) return;
                if (map[k] === true) delete map[k];
            });
        });
    }

    /** 就地重算整棵工具树的可勾选 / 灰显 / 徽标状态（不重新请求接口，不丢设置项草稿） */
    function refreshToolGate() {
        const serverOn = serverDirOnMap();
        const suspendedDirs = suspendedDirSet();
        flattenToolTree(configState.toolTree).forEach((node) => {
            const gate = toolNodeGate(node, serverOn, suspendedDirs);
            const domKey = toolNodeDomKey(node);
            const row = document.querySelector(`[data-node-key="${domKey}"]`);
            if (!row) return;

            const toggle = row.querySelector(":scope > .tool-node__head > .tool-node__toggle");
            if (toggle) {
                toggle.checked = gate.on;
                toggle.disabled = gate.disabled;
            }
            const badges = row.querySelector("[data-node-badges]");
            if (badges) badges.innerHTML = toolNodeBadgeHtml(node, gate);
            row.classList.toggle("tool-node--disabled", gate.disabled);

            // 本节点的设置项随门禁一起解禁 / 灰显（节点是平铺渲染的，子孙各走自己的一轮）
            const panel = row.querySelector(`[data-tool-settings="${domKey}"]`);
            if (!panel) return;
            panel.querySelectorAll("[data-tool-setting]").forEach((el) => {
                const key = String(el.id || "").replace(/^cfg-/, "");
                el.disabled = gate.disabled || configState.restoreKeys.has(key);
            });
            panel.querySelectorAll("[data-tool-restore]").forEach((el) => {
                el.disabled = gate.disabled;
            });
        });
    }

    /**
     * 保存流程的两个补丁（R-47 / R-48）：
     * · pruneToolToggleDrafts()：提交前自净，撤掉与门禁矛盾的「开启」草稿；
     * · revealToolError()：把后端返回的逐项原因展开到用户看得见的地方。
     */
    /**
     * [R-48] 把错误提示暴露到可见处。
     * 工具设置项的错误 div 位于「设置项」折叠面板内，面板默认收起（`hidden`）——
     * 于是错误虽然写进了 DOM，用户却看不到，只剩一句「存在不合法变更」。
     * 这里把面板展开、同步箭头，并把该行滚进视口（不做 re-render，避免丢草稿）。
     * @param {HTMLElement} box 错误提示容器
     */
    function revealToolError(box) {
        const holder = box && box.closest ? box.closest("[data-tool-settings]") : null;
        if (holder) {
            const domKey = holder.dataset ? holder.dataset.toolSettings : "";
            if (domKey) {
                holder.hidden = false;
                configState.openSettings.add(domKey);
                const btn = document.querySelector(`[data-tool-expand="${domKey}"]`);
                if (btn) btn.textContent = btn.textContent.replace(/[▾▴]\s*$/, "▴");
            }
        }
        const target = holder || box;
        if (target && target.scrollIntoView) {
            try { target.scrollIntoView({ block: "nearest" }); } catch { /* 老浏览器忽略 */ }
        }
    }

    /** 提交前自净：与门禁矛盾的「开启」草稿一律撤掉（后端仍会独立复查，§3.5）。 */
    function pruneToolToggleDrafts() {
        const serverOn = serverDirOnMap();
        const suspendedDirs = suspendedDirSet();
        flattenToolTree(configState.toolTree).forEach((node) => {
            const map = node.type === "dir" ? configState.dirToggles : configState.groupToggles;
            if (!Object.prototype.hasOwnProperty.call(map, node.id)) return;
            if (map[node.id] !== true) return;
            if (toolNodeGate(node, serverOn, suspendedDirs).disabled) delete map[node.id];
        });
    }

    /** 单个工具设置项控件（按 kind 映射；secret 不回显明文，留空 = 不修改） */
    function renderToolSetting(node, s) {
        const id = "cfg-" + s.key;
        const disabled = node.disabled || s.disabled;
        let control;
        if (s.secret) {
            control = `<input class="config-input" id="${id}" data-tool-setting="1"
                type="password" autocomplete="new-password"${disabled ? " disabled" : ""}
                placeholder="${escapeHtml(s.hasValue ? (s.mask || "****") : "未设置（留空即不修改）")}" value="">`;
        } else if (s.kind === "boolean") {
            control = `<select class="config-input" id="${id}" data-tool-setting="1"${disabled ? " disabled" : ""}>
                <option value="true"${s.value === "true" ? " selected" : ""}>true</option>
                <option value="false"${s.value === "false" ? " selected" : ""}>false</option>
              </select>`;
        } else if (Array.isArray(s.options) && s.options.length > 0) {
            const labels = s.optionLabels || {};
            control = `<select class="config-input" id="${id}" data-tool-setting="1"${disabled ? " disabled" : ""}>
                ${s.options.map((v) => `<option value="${escapeHtml(v)}"${s.value === v ? " selected" : ""}>${escapeHtml(labels[v] || v)}</option>`).join("")}
              </select>`;
        } else {
            const numeric = s.kind === "number" ? ' inputmode="numeric"' : "";
            control = `<input class="config-input" id="${id}" data-tool-setting="1"
                type="text"${numeric}${disabled ? " disabled" : ""} value="${escapeHtml(String(s.value === null || s.value === undefined ? "" : s.value))}">`;
        }
        const range = s.kind === "number" && (s.min !== undefined || s.max !== undefined)
            ? `（${s.min === undefined ? "-∞" : s.min} ~ ${s.max === undefined ? "+∞" : s.max}）`
            : "";
        const badges = [];
        if (s.secret) badges.push('<span class="config-badge config-badge--set">密钥</span>');
        if (s.isDefault === false) badges.push('<span class="config-badge">已改</span>');
        const defText = s.secret ? "（密钥项默认值不展示）" : `默认：${s.defaultValue}`;
        return `
          <div class="config-item config-item--tool">
            <div class="config-item__head">
              <label class="config-item__label" for="${id}">${escapeHtml(s.name)}${escapeHtml(range)}</label>
              <code class="config-item__key">${escapeHtml(s.key)}</code>
              ${badges.join("")}
              <button type="button" class="config-item__clear" data-tool-restore="${escapeHtml(s.key)}"${disabled ? " disabled" : ""}>恢复默认</button>
            </div>
            ${control}
            <div class="config-item__desc">${escapeHtml(s.desc || "")} ${escapeHtml(defText)}</div>
            <div class="config-item__error" data-error-for="${escapeHtml(s.key)}" hidden></div>
          </div>`;
    }

    /** 单个工具节点（目录或工具组） */
    function renderToolNode(node) {
        const domKey = toolNodeDomKey(node);
        const pad = 6 + Math.max(0, (node.depth || 0) - 1) * 16;
        const isGroup = node.type === "group";
        const toggle = `<input type="checkbox" class="tool-node__toggle"
            data-toggle-type="${node.type}" data-toggle-id="${escapeHtml(node.id)}"
            ${node.on ? "checked" : ""}${node.disabled ? " disabled" : ""}>`;
        const badges = toolNodeBadgeHtml(node, {
            disabled: node.disabled,
            on: node.on,
            available: node.available,
            reason: node.reason,
        });
        const detail = [];
        if (isGroup) {
            detail.push(`<div class="tool-node__tools">可见工具：${escapeHtml(toolNamesText(node))}</div>`);
        }
        if (!isGroup && Array.isArray(node.ignored) && node.ignored.length > 0) {
            const text = node.ignored.map((x) => x.name + "（" + x.reason + "）").join("、");
            detail.push(`<div class="tool-node__warn">已忽略：${escapeHtml(text)}</div>`);
        }
        const hasSettings = Array.isArray(node.settings) && node.settings.length > 0;
        const opened = configState.openSettings.has(domKey);
        const settingsBtn = hasSettings
            ? `<button type="button" class="tool-node__expand" data-tool-expand="${escapeHtml(domKey)}">设置项 ${node.settings.length} 项 ${opened ? "▴" : "▾"}</button>`
            : "";
        const settingsBox = hasSettings
            ? `<div class="tool-node__settings" data-tool-settings="${escapeHtml(domKey)}"${opened ? "" : " hidden"}>
                 ${node.settings.map((s) => renderToolSetting(node, s)).join("")}
               </div>`
            : "";
        return `
          <div class="tool-node tool-node--${node.type}${node.disabled ? " tool-node--disabled" : ""}"
               data-node-key="${escapeHtml(domKey)}" style="padding-left:${pad}px">
            <div class="tool-node__head">
              ${toggle}
              <span class="tool-node__name">${escapeHtml(node.name || "(根目录)")}</span>
              <code class="tool-node__id">${escapeHtml(node.id || "/")}</code>
              <span class="tool-node__badges" data-node-badges="1">${badges}</span>
              ${settingsBtn}
            </div>
            ${detail.join("")}
            ${settingsBox}
            <div class="config-item__error" data-node-error="${escapeHtml(domKey)}" hidden></div>
          </div>`;
    }

    /** 工具树整段（含「刷新」按钮：§12 强制重扫） */
    function renderToolSection() {
        const flat = flattenToolTree(configState.toolTree);
        const groupCount = flat.filter((n) => n.type === "group").length;
        const head = `
          <h3 class="config-section__title">
            工具配置（按 目录 → 工具组 逐级开启）
            <button type="button" class="config-btn config-btn--inline" id="config-refresh-tree">🔄 刷新</button>
          </h3>`;
        if (flat.length === 0) {
            return `<section class="config-section">${head}
              <div class="config-item__desc">未扫描到任何工具目录。请确认 <code>etc/tools</code> 下存在入口文件后点「🔄 刷新」。</div>
            </section>`;
        }
        return `<section class="config-section">${head}
          <div class="config-item__desc">
            共 ${groupCount} 个工具组。上级目录关闭时，其下所有工具组一律不可用；保存后立即生效，无需重启。
            私有模块（文件名以 <code>_</code> 开头）的改动需重启进程。
          </div>
          <div class="config-item__error" id="config-tool-fields" hidden></div>
          ${flat.map((n) => renderToolNode(n)).join("")}
        </section>`;
    }

    /* ============================================================
     * [skill / §11、§12.2] 技能区：与「工具配置」平级，按 dir 层级缩进
     *   ⚠️ 必须递归渲染：只靠 flatten 后的平铺列表会让层级在视觉上塌成一条线。
     *   ⚠️ 前端不算门禁、不解析 md：on / status / reason / hint 全部来自 skillTree。
     * ============================================================ */

    function flattenSkillTree(nodes, out) {
        const acc = out || [];
        (nodes || []).forEach((n) => {
            acc.push(n);
            flattenSkillTree(n.children, acc);
        });
        return acc;
    }

    /** 单个技能节点：分类目录只做标题（无开关，N-SK-6）；skill = 开关 + 状态 + 预览 + 激活 */
    function renderSkillNode(node) {
        const pad = 6 + Math.max(0, String(node.dir || "").split("/").length - 1) * 16;

        if (!node.isSkill) {
            const ignored = node.ignored || [];
            const kids = (node.children || []).map((c) => renderSkillNode(c)).join("");
            return `
              <div class="tool-node tool-node--dir" style="padding-left:${pad}px">
                <div class="tool-node__head">
                  <span class="tool-node__name">${escapeHtml(node.segment)}</span>
                  <code class="tool-node__id">${escapeHtml(node.dir)}</code>
                  ${ignored.length > 0
                    ? `<span class="config-badge config-badge--shadow">已忽略 ${ignored.length} 项</span>` : ""}
                </div>
                ${ignored.map((x) => `<div class="tool-node__warn">已忽略：${escapeHtml(x.name)}（${escapeHtml(x.reason)}）</div>`).join("")}
                ${kids}
              </div>`;
        }

        const suspended = node.status === "suspended";
        /* [C-32] 开关的显示值 = 草稿优先（有未提交草稿就显示草稿，否则用服务端值）。
           ⚠️ 原实现只读 node.on：用户勾选后徽标仍写「已关闭」、重绘后 checkbox 还会回退成服务端值，
              看起来像「勾了没反应 / 操作丢了」。草稿状态必须能一眼看见。 */
        const draftOn = configState.skillToggles
            ? configState.skillToggles[node.dir]
            : undefined;
        const shownOn = draftOn === undefined ? node.on : draftOn === true;
        const dirtyMark = (draftOn !== undefined && draftOn !== node.on)
            ? `<span class="config-badge config-badge--shadow">未保存</span>` : "";
        const badge = suspended
            ? `<span class="config-badge config-badge--shadow">挂起：${escapeHtml(node.reason || "未知原因")}</span>`
            : `<span class="config-badge">${shownOn ? "已开启" : "已关闭"}</span>${dirtyMark}`;
        // §11「报警要给出具体怎么改」：hint 独占一行
        const hintLine = suspended && node.hint
            ? `<div class="tool-node__warn">怎么改：${escapeHtml(node.hint)}</div>` : "";
        const extraLine = (node.extraFiles || []).length > 0
            ? `<div class="tool-node__warn">目录内多余文件（已忽略）：${escapeHtml(node.extraFiles.join("、"))}</div>` : "";
        const active = configState.activeSkill === node.dir;

        return `
          <div class="tool-node tool-node--skill${suspended ? " tool-node--disabled" : ""}"
               data-skill-dir="${escapeHtml(node.dir)}" style="padding-left:${pad}px">
            <div class="tool-node__head">
              <input type="checkbox" class="tool-node__toggle" data-skill-toggle="${escapeHtml(node.dir)}"
                     ${shownOn ? " checked" : ""}${suspended ? " disabled" : ""}>
              <span class="tool-node__name">${escapeHtml(node.title || node.segment)}</span>
              <code class="tool-node__id">${escapeHtml(node.dir)}</code>
              <span class="tool-node__badges">${badge}</span>
              <button type="button" class="config-btn config-btn--inline" data-skill-preview="${escapeHtml(node.dir)}">预览</button>
              ${suspended ? "" : `<label class="config-item__desc">
                  <input type="radio" name="active-skill" value="${escapeHtml(node.dir)}"${active ? " checked" : ""}>
                  本轮激活
              </label>`}
            </div>
            <div class="config-item__desc">${escapeHtml(node.summary || "")}</div>
            ${hintLine}
            ${extraLine}
            <div class="config-item__error" data-skill-error="${escapeHtml(node.dir)}" hidden></div>
          </div>`;
    }

    /** 技能区整段（递归渲染根节点，保证层级不塌） */
    function renderSkillSection() {
        const flat = flattenSkillTree(configState.skillTree);
        const skillCount = flat.filter((n) => n.isSkill).length;
        const warns = configState.skillWarnings || [];
        const head = `
          <h3 class="config-section__title">
            技能配置（默认关闭；开启后还要勾选「本轮激活」才生效）
          </h3>`;
        const warnBlock = warns.length > 0
            ? `<div class="tool-node__warn">${warns.map((w) => escapeHtml(w)).join("<br>")}</div>` : "";
        if (skillCount === 0) {
            return `<section class="config-section" id="config-skill-section">${head}
              <div class="config-item__desc">
                未扫描到任何技能。请在 <code>etc/skills/&lt;分类&gt;/&lt;技能名&gt;/SKILL.md</code> 下新建文档后点「🔄 刷新」。
              </div>
              ${warnBlock}
            </section>`;
        }
        return `<section class="config-section" id="config-skill-section">${head}
          <div class="config-item__desc">
            共 ${skillCount} 个技能。开关默认关闭；切换后<b>下一次请求</b>生效（当前回复不受影响）。
            技能只能通过已注册工具做事，涉及写文件 / 执行命令 / 联网的调用一律走审批。
          </div>
          ${warnBlock}
          <div class="config-item__error" id="config-skill-fields" hidden></div>
          ${(configState.skillTree || []).map((n) => renderSkillNode(n)).join("")}
        </section>`;
    }

    /** 绑定技能区交互：开关 / 激活单选 / 预览 */
    function bindSkillTreeEvents(box) {
        // ① 开关：只改草稿，保存时统一提交（与工具开关同一心智模型）
        box.querySelectorAll("[data-skill-toggle]").forEach((el) => {
            el.addEventListener("change", () => {
                const dir = el.dataset.skillToggle;
                if (!dir) return;
                configState.skillToggles[dir] = el.checked;
                setConfigDirty(true);
                // [C-32] 立即把徽标刷成草稿状态：否则用户勾完看不到任何视觉反馈
                //   （徽标只在 renderSkillNode 时按服务端值渲染，不重绘就一直显示旧值）。
                const nodeEl = el.closest(".tool-node--skill");
                const badgeEl = nodeEl ? nodeEl.querySelector(".tool-node__badges") : null;
                if (badgeEl) {
                    const shadow = badgeEl.querySelector(".config-badge--shadow");
                    const base = badgeEl.querySelector(".config-badge:not(.config-badge--shadow)");
                    if (base && !shadow) {   // 非挂起态才改（挂起态显示原因，不可切换）
                        base.textContent = el.checked ? "已开启" : "已关闭";
                        const mark = document.createElement("span");
                        mark.className = "config-badge config-badge--shadow";
                        mark.textContent = "未保存";
                        badgeEl.appendChild(mark);
                    }
                }
            });
        });

        // ② 激活项：单选，同一时刻只有一个；写 sessionStorage（不落 .env，C-5）
        box.querySelectorAll('input[name="active-skill"]').forEach((el) => {
            el.addEventListener("change", () => {
                if (!el.checked) return;
                configState.activeSkill = el.value;
                try { sessionStorage.setItem("winbots.activeSkill", el.value); } catch { /* 忽略 */ }
                // §11：切换必须提示「下一轮生效」，不得暗示立即改变当前回复
                //   ⚠️ 激活项**不进 .env** → 不要触碰 setConfigDirty：
                //      否则会把用户刚改的系统项 / 工具开关一并标成「无未保存更改」，保存按钮变灰。
                const out = document.getElementById("config-result");
                if (out) out.textContent = `✅ 已把「${el.value}」设为本轮激活技能：下一次请求生效（当前回复不受影响）。`;
            });
        });

        // ③ 预览：独立只读接口（§12.5 要求服务端实际拼装后的文本）
        box.querySelectorAll("[data-skill-preview]").forEach((btn) => {
            btn.addEventListener("click", () => openSkillPreview(btn.dataset.skillPreview));
        });
    }

    /* ============================================================
     * [skill / §11、§12.5] 预览浮层：只读展示服务端「实际拼装后」的三层文本
     *   ⚠️ 正文用 DOM API + textContent，禁止 innerHTML 拼用户文本（§12.4 第 3 条）
     *   ⚠️ 支持 Esc 关闭 + 焦点锁定（§12.4 第 2 条）
     * ============================================================ */
    async function openSkillPreview(dir) {
        if (!dir) return;
        const root = document.getElementById("skill-preview-modal");
        const body = document.getElementById("skill-preview-body");
        const title = document.getElementById("skill-preview-title");
        const closeBtn = document.getElementById("skill-preview-close");
        if (!root || !body || !title || !closeBtn) return;

        const addBlock = (label, text) => {
            const h = document.createElement("div");
            h.className = "skill-preview__section";
            h.textContent = label;
            const pre = document.createElement("pre");
            pre.className = "skill-preview__pre";
            pre.textContent = text || "（空）";
            body.appendChild(h);
            body.appendChild(pre);
        };

        body.textContent = "";
        title.textContent = "技能预览 · " + dir;

        let data = null;
        try {
            const resp = await fetch(
                "/api/skills/preview?name=" + encodeURIComponent(dir),
                { cache: "no-store" },
            );
            data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
        } catch (e) {
            // 失败也走同一个页面内浮层（§12.4：禁用 alert / 原生弹窗）
            const w = document.createElement("div");
            w.className = "skill-preview__warn";
            w.textContent = "❌ 预览失败：" + String((e && e.message) || e);
            body.appendChild(w);
        }

        if (data) {
            addBlock("L0（配置页列表里的一句话）", data.l0);
            addBlock("L1（## 目标 / ## 使用时机 → 注入 system）", data.l1);
            addBlock("L2（## 方法 / ## 输出格式 / ## 自检 等 → 注入 system）", data.l2);
            addBlock("最终工具白名单（模型实际能看到的）",
                (data.tools || []).join("\n") || "（未收窄：给全量）");
            if (data.toolsDropped && data.toolsDropped.length > 0) {
                addBlock("被过滤掉的声明（注册表里没有：组被关 / 组挂起 / 名字写错）",
                    data.toolsDropped.join("\n"));
            }
            /* [C-30] 声明了、注册表里也有，但被工具自身 enabled() 挡掉（典型：permission=forbid）。
               必须与 toolsDropped 分开显示，否则用户会误以为「我写了三个工具，怎么只生效两个」。 */
            if (data.toolsSelfDisabled && data.toolsSelfDisabled.length > 0) {
                addBlock("声明了但工具自身条件不成立（如 permission=forbid，需先放开工具权限）",
                    data.toolsSelfDisabled.join("\n"));
            }
            if (data.truncated) {
                const w = document.createElement("div");
                w.className = "skill-preview__warn";
                w.textContent = "⚠️ 该 skill 内容超出预算，注入时已按段落整段截断（见 L2 末尾标注）。";
                body.appendChild(w);
            }
            if (data.hint) {
                const w = document.createElement("div");
                w.className = "skill-preview__warn";
                w.textContent = "怎么改：" + data.hint;
                body.appendChild(w);
            }
        }

        /* 关闭策略（§12.4 第 2 条）：Esc / 点遮罩 / 点「关闭」都能关；焦点锁在按钮上 */
        const backdrop = root.querySelector("[data-skill-preview-close]");
        const prevFocus = document.activeElement;
        const close = () => {
            root.hidden = true;
            document.body.classList.remove("approval-open");
            closeBtn.removeEventListener("click", close);
            if (backdrop) backdrop.removeEventListener("click", close);
            document.removeEventListener("keydown", onKey, true);
            if (prevFocus && typeof prevFocus.focus === "function") {
                try { prevFocus.focus(); } catch { /* 忽略 */ }
            }
        };
        const onKey = (e) => {
            if (e.key === "Escape") { e.preventDefault(); close(); return; }
            if (e.key === "Tab") { e.preventDefault(); closeBtn.focus(); }
        };

        closeBtn.addEventListener("click", close);
        if (backdrop) backdrop.addEventListener("click", close);
        document.addEventListener("keydown", onKey, true);

        root.hidden = false;
        document.body.classList.add("approval-open");
        closeBtn.focus();
    }

    /** 底部遗留键区块（§10.2：只在此处出现，可整体删除） */
    function renderOrphanSection() {
        const keys = configState.orphanKeys || [];
        if (keys.length === 0) return "";
        return `<section class="config-section config-section--orphan">
          <h3 class="config-section__title">🧹 遗留键 ${keys.length}</h3>
          <div class="config-item__desc">
            这些键带受管前缀（<code>TOOLON__</code> / <code>TOOLSET__</code> / <code>etc__tools__</code>），
            但本次扫描没有任何工具声明它们（工具被删除或改名，或键名手写错误）。删除不影响其他键。
          </div>
          <div class="tool-node__tools">
            ${keys.map((k) => `<label class="orphan-row"><input type="checkbox" class="orphan-check" value="${escapeHtml(k)}"> <code>${escapeHtml(k)}</code></label>`).join("")}
          </div>
          <button type="button" class="config-btn" id="config-orphan-delete">删除所选遗留键</button>
          <div class="config-item__error" id="config-orphan-error" hidden></div>
        </section>`;
    }

    /** 绑定工具树交互：开关、设置项展开、恢复默认、刷新、删遗留键 */
    function bindToolTreeEvents(box) {
        box.querySelectorAll("[data-tool-expand]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const key = btn.dataset.toolExpand;
                if (!key) return;
                const panel = box.querySelector(`[data-tool-settings="${key}"]`);
                if (!panel) return;
                const opened = configState.openSettings.has(key);
                if (opened) configState.openSettings.delete(key);
                else configState.openSettings.add(key);
                // opened = 切换前的状态：原本展开 → 收起（hidden=true），反之展开
                panel.hidden = opened;
                // 只切换箭头，不重渲染（重渲染会丢掉尚未保存的草稿值）
                btn.textContent = btn.textContent.replace(/[▾▴]\s*$/, opened ? "▾" : "▴");
            });
        });

        box.querySelectorAll("[data-toggle-type]").forEach((el) => {
            el.addEventListener("change", () => {
                const type = el.dataset.toggleType;
                const id = el.dataset.toggleId;
                if (!type || !id) return;
                if (type === "dir") configState.dirToggles[id] = el.checked;
                else configState.groupToggles[id] = el.checked;
                // 父关 → 全部子孙关闭且界面不可操作（§8.2）：
                //   撤掉子孙里「想要开启」的草稿，否则提交会带上矛盾组合被后端整单拒绝
                if (type === "dir" && !el.checked) dropEnabledDescendantDrafts(id);
                // 就地重算门禁：勾上父级后子孙立刻可勾选，取消父级后立刻灰显（无需刷新页面）
                refreshToolGate();
                setConfigDirty(true);
            });
        });

        box.querySelectorAll("[data-tool-setting]").forEach((el) => {
            el.addEventListener("input", () => setConfigDirty(true));
            el.addEventListener("change", () => setConfigDirty(true));
        });

        box.querySelectorAll("[data-tool-restore]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const key = btn.dataset.toolRestore;
                if (!key) return;
                const input = document.getElementById(`cfg-${key}`);
                if (configState.restoreKeys.has(key)) {
                    configState.restoreKeys.delete(key);
                    btn.textContent = "恢复默认";
                } else {
                    configState.restoreKeys.add(key);
                    if (input) input.value = "";     // 标记恢复默认后清空草稿（保存时走 restore 字段删键）
                    btn.textContent = "撤销恢复";
                }
                // 禁用态交给门禁统一判定：既尊重「已标记恢复默认」，又不会被重新启用
                refreshToolGate();
                setConfigDirty(true);
            });
        });

        const refreshBtn = document.getElementById("config-refresh-tree");
        if (refreshBtn) refreshBtn.addEventListener("click", refreshToolTree);

        const orphanBtn = document.getElementById("config-orphan-delete");
        if (orphanBtn) orphanBtn.addEventListener("click", deleteOrphanKeys);
    }

    /** 收集工具域改动（开关 / 设置项 / 恢复默认），与系统项 changes 分开提交 */
    function collectToolChanges() {
        const settings = {};
        flattenToolTree(configState.toolTree).forEach((node) => {
            (node.settings || []).forEach((s) => {
                if (configState.restoreKeys.has(s.key)) return;   // 走 restore 字段（删键回默认）
                const el = document.getElementById(`cfg-${s.key}`);
                if (!el) return;
                // [R-49 / R-50] 灰显控件里的「差异」一律不是用户改的，不得提交：
                //   ① 上级目录关闭 / 组挂起时输入框是 disabled，用户根本没机会编辑；
                //   ② 属性值一旦被提前闭合（R-49 的引号 bug），DOM 值会退化成残片（如 "["），
                //      与声明值「天然不同」→ 每次保存都凭空多提交一条非法设置项 → 整单 400，
                //      而用户看到的却是与操作无关的「存在不合法变更」。
                if (el.disabled === true) return;
                const next = String(el.value).trim();
                if (s.secret) {
                    if (next !== "") settings[s.key] = next;      // 密钥留空 = 不修改（与系统项同口径）
                    return;
                }
                if (next !== String(s.value === null || s.value === undefined ? "" : s.value)) {
                    settings[s.key] = next;
                }
            });
        });
        // 提交前自净：与门禁矛盾的「开启」类草稿一律撤掉（否则后端整单 400，见 §3.5 / §8.2）
        pruneToolToggleDrafts();
        // [skill / §12.2] 技能开关单独一份：key = skill 的 dir（服务端按 dir 反查 SKILLON__<dir>）
        const skillToggles = {};
        Object.keys(configState.skillToggles).forEach((dir) => {
            skillToggles[dir] = configState.skillToggles[dir] === true;
        });
        return {
            dirToggles: Object.assign({}, configState.dirToggles),
            groupToggles: Object.assign({}, configState.groupToggles),
            settings,
            restore: [...configState.restoreKeys],   // ← 必须保留
            skillToggles,
        };
    }

    /** 重新扫描工具目录（§12 refresh）：只重画工具树，不动系统项已保存值 */
    async function refreshToolTree() {
        // [modal] 仅在 dirty 时确认：短路求值保证「不 dirty 不弹框」
        if (configState.dirty && !(await WinbotsConfirm({
            source: "refresh-tools",
            title: "重新扫描工具目录",
            message: "重新扫描会丢弃当前未保存的更改，继续？",
            okText: "丢弃并重新扫描",
            cancelText: "取消",
            danger: true
        }))) return;
        const resultEl = document.getElementById("config-result");
        try {
            const resp = await fetch("/api/config/refresh", { method: "POST" });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
            configState.scanVersion = data.scanVersion || "";
            configState.toolTree = data.toolTree || [];
            configState.orphanKeys = data.orphanKeys || [];
            // [skill] 刷新同样带回技能树与清理结果
            configState.skillTree = data.skillTree || [];
            configState.skillWarnings = data.skillWarnings || [];
            configState.skillScanVersion = data.skillScanVersion || "";
            configState.dirToggles = {};
            configState.groupToggles = {};
            configState.skillToggles = {};           // [skill]
            configState.restoreKeys = new Set();
            const box = document.getElementById("config-form");
            if (box) renderConfigForm(box);
            setConfigDirty(false);
            const cleaned = data.cleanedSkillKeys || [];
            if (resultEl) {
                resultEl.textContent = "🔄 已重新扫描（工具 " + configState.scanVersion
                    + " / 技能 " + (configState.skillScanVersion || "-") + "）。"
                    + (cleaned.length > 0
                        ? "\n🧹 已自动清理 " + cleaned.length + " 个已删技能的残留键：" + cleaned.join(", ")
                        : "");
            }
        } catch (e) {
            if (resultEl) resultEl.textContent = "❌ 刷新失败：" + String(e.message || e);
        }
    }

    /** 删除所选遗留键（§10.2：独立接口、不备份、不参与保存流程） */
    async function deleteOrphanKeys() {
        const errEl = document.getElementById("config-orphan-error");
        const keys = [...document.querySelectorAll(".orphan-check:checked")].map((el) => el.value);
        if (keys.length === 0) {
            if (errEl) { errEl.hidden = false; errEl.textContent = "❌ 请先勾选要删除的遗留键"; }
            return;
        }
        // [modal] 删除不备份，必须走危险色确认
        if (!(await WinbotsConfirm({
            source: "delete-orphans",
            title: "删除遗留键",
            message: "确认删除以下 " + keys.length + " 个遗留键？\n\n" + keys.join("\n") + "\n\n（删除不备份，可在 data/envbk 的最近备份中找回）",
            okText: "删除",
            cancelText: "取消",
            danger: true
        }))) return;
        try {
            const resp = await fetch("/api/config/orphans", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm: true, keys }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || ("HTTP " + resp.status));
            configState.orphanKeys = data.remaining || [];
            const box = document.getElementById("config-form");
            if (box) renderConfigForm(box);
            const resultEl = document.getElementById("config-result");
            if (resultEl) resultEl.textContent = "🧹 已删除 " + keys.length + " 个遗留键。";
        } catch (e) {
            if (errEl) { errEl.hidden = false; errEl.textContent = "❌ 删除失败：" + String(e.message || e); }
        }
    }

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

        // [US-3.1] 刷新/新开标签页即全新会话（F1-1/F1-2）：
        //   不再调用 ensureSessionId()（其会优先复用 sessionStorage 缓存，
        //   导致刷新后续接旧会话）；改为直接调用 newSession() 强制分配全新会话，
        //   并清空消息区、复位统计与流式引用，使界面处于空白新会话。
        //   注：newSession() 内部已 persistSessionId 覆盖缓存，且含流式守卫（加载时通常无流式）。
        newSession().then((ok) => {
            if (ok) console.log("🆕 已进入全新会话（刷新即新会话）");
        });

        // [US-4.4] 暴露 openSession 供历史列表点击调用
        window.__winbotsOpenSession = openSession;

        // [US-4.7] 暴露 newSession 供「新建会话」按钮调用
        window.__winbotsNewSession = newSession;

        // [US-4.8] 顶部菜单点击切换视图
        // [US-1.4] 链接化：仅拦截普通左键走 SPA 切换；修饰键/中键/右键放行原生行为（新标签页打开）
        $dom.menuItems.forEach((item) => {
            item.addEventListener("click", (e) => {
                if (e.defaultPrevented || e.button !== 0
                    || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                    return;   // 放行：浏览器原生「在新标签页中打开链接」
                }
                e.preventDefault();   // 拦截左键：SPA 内切换，不整页刷新
                switchView(item.dataset.view);
            });
        });

        // [US-2.4] 历史视图旧「新建会话」按钮已删除，其绑定一并移除（入口唯一，F3-5）；
        //          新建入口统一由下方顶部菜单动作项承担。

        // [US-2.2] 顶部菜单「新建会话」动作项：新建 + 切回会话视图（F3-3）
        //   行为与历史视图旧按钮一致：newSession() 内部含流式守卫（F3-6，US-2.5 复用）。
        //   [US-2.7] 链接化后，此处同样需拦截普通左键，放行修饰键/中键/右键原生行为。
        if ($dom.topMenuNew) {
            $dom.topMenuNew.addEventListener("click", async (e) => {
                if (e.defaultPrevented || e.button !== 0
                    || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                    return;   // 放行：浏览器原生「在新标签页中打开链接」
                }
                e.preventDefault();   // 拦截左键：SPA 内新建，不整页刷新
                await newSession();
                switchView("chat");
            });
        }

        // [配置页 / US-CFG-PAGE-2] 绑定保存按钮
        const saveBtn = document.getElementById("config-save-btn");
        if (saveBtn) saveBtn.addEventListener("click", saveConfig);

        // [US-4.8] 暴露 switchView 供手动验证
        window.__winbotsSwitchView = switchView;

        // [US-1.3] 初始化默认视图为「会话」，由 switchView 单一入口驱动
        //   「视图显隐 + 菜单选中态」同步，保证默认选中「会话」（F2-4）。
        // [US-1.4] 支持 ?view= 初始视图：新标签页经 href="/?view=history" 打开后，
        //   加载即进入对应视图（F2-6）。非法/缺省时回退 chat（switchView 内含守卫）。
        const params = new URLSearchParams(location.search);
        const initialView = params.get("view") || "chat";
        switchView(initialView);

        // [US-2.7] ?new=1 语义（F3-8）已由上方 [US-3.1] 的「加载即新建会话」统一覆盖：
        //   无论是否携带 ?new=1，页面加载都会进入全新空白会话，二者天然幂等，
        //   故此处不再重复调用 newSession()，避免加载时分配两次会话 ID。
        //   （保留 params 解析用于 ?view= 初始视图，见上方 [US-1.4]。）

        console.log("🤖 Bots AI Chat 已初始化");
    }

    // DOM 就绪后初始化
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
