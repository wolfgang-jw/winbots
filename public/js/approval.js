/**
 * public/js/approval.js
 * 界面审批通道（批次三 / NH-02 ④、AP-09 ~ AP-25、NB-13、NB-21）
 *
 * 职责：
 *   1. 订阅 GET /api/approvals/stream?sessionId=…（SSE），按 requestId 去重（NB-22③ / AP-25）；
 *   2. 渲染审批弹窗：完整命令原文（等宽 / 可滚动 / 不截断 / 不折叠）+ 绝对工作目录 + 超时 + 来源会话
 *      + 醒目警示；并在同一屏呈现「目的（模型自述，未经核实）/ 风险（系统事实）/ 边界（系统事实）」三段
 *      （AP-09 / AP-21 / AP-22）；
 *   3. 默认选中「拒绝」、初始焦点在拒绝、无倒计时、不存在「回车即允许」、不可 Esc/点外部关闭（AP-10）；
 *   4. 提交决定 → POST /api/approvals/:requestId/decision；重复/过期 → 提示「该请求已结束」（AP-19）；
 *   5. **审批音的唯一触发点**（AP-24）：只在收到 approval_request 事件时调用 WinbotsCue；
 *      绝不依据工具名、档位、命令文本、按钮状态推断「此刻需要授权」（AC-SH-37）；
 *   6. 挂起态持续可见标记（NB-13：「待审批」与「已完成」视觉可区分）。
 *
 * 依赖：window.WinbotsCue（缺失时静默降级，审批流程照常）。
 */
(function (global) {
    "use strict";

    var CONFIG = {
        STREAM_ENDPOINT: "/api/approvals/stream",
        PENDING_ENDPOINT: "/api/approvals/pending",
        DECISION_PREFIX: "/api/approvals/",
        SESSION_STORAGE_KEY: "winbots.currentSessionId",
        POLL_FALLBACK_MS: 2000      // SSE 彻底失败时的短轮询间隔（VS-03 降级）
    };

    /** 界面 5 个选项（值必须与 src/routes/approval.ts 的 DECISION_MAP 一致） */
    var OPTIONS = [
        { value: "deny", text: "拒绝（不执行）", cls: "approval-option--deny" },
        { value: "allow_once_command", text: "仅当次允许 · 仅当前命令", cls: "" },
        { value: "allow_once_all", text: "仅当次允许 · 所有命令（与上一项等价，不留记忆）", cls: "" },
        { value: "allow_session_command", text: "本会话都允许 · 仅当前命令", cls: "" },
        { value: "allow_session_all", text: "本会话都允许 · 所有命令（⚠️ 本会话内不再询问任何命令）", cls: "approval-option--danger" }
    ];

    var state = {
        sessionId: null,
        source: null,          // EventSource
        pending: {},           // requestId → 请求体
        order: [],             // 到达顺序（先到先弹）
        current: null,         // 正在展示的 requestId
        submitting: false,
        pollTimer: null
    };

    function byId(id) { return document.getElementById(id); }

    /** 用小工具创建元素：所有动态文本走 textContent，天然防 XSS（intent 属不可信文本，AP-22） */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    /* ============================================================
     * 一、通道（SSE + 快照去重 + 轮询降级）
     * ============================================================ */

    function connect(sessionId) {
        if (!sessionId || sessionId === state.sessionId) return;
        disconnect();
        state.sessionId = sessionId;

        if (typeof global.EventSource !== "function") {
            startPolling();                 // 极老浏览器：直接走短轮询
            return;
        }
        try {
            var es = new global.EventSource(
                CONFIG.STREAM_ENDPOINT + "?sessionId=" + encodeURIComponent(sessionId)
            );
            state.source = es;
            es.onopen = function () { stopPolling(); };
            es.onmessage = function (e) {
                var data;
                try { data = JSON.parse(e.data); } catch (err) { return; }
                handleEvent(data);
            };
            es.onerror = function () {
                // EventSource 会自己重连；若已被彻底关闭（readyState=2）则启动轮询兜底。
                // 两条通道都用 requestId 去重，因此不会重复弹窗、也不会重复计数（NB-22③）。
                if (es.readyState === 2) startPolling();
            };
        } catch (err) {
            startPolling();
        }
    }

    function disconnect() {
        stopPolling();
        if (state.source) {
            try { state.source.close(); } catch (e) { /* 已关闭 */ }
            state.source = null;
        }
        state.sessionId = null;
    }

    function handleEvent(data) {
        if (!data || typeof data.type !== "string") return;
        if (data.type === "approval_snapshot") {
            var list = data.requests || [];
            for (var i = 0; i < list.length; i++) onRequest(list[i]);
            return;
        }
        if (data.type === "approval_request") { onRequest(data.request); return; }
        if (data.type === "approval_settled") { onSettled(data.requestId, data.outcome); return; }
    }

    /** [AP-24] 唯一触发源：approval_request 事件。这里也是唯一调用 notifyApprovalRequest 的地方。 */
    function onRequest(req) {
        if (!req || !req.requestId) return;
        if (state.pending[req.requestId]) return;          // 重连快照 / 轮询刷新 → 去重
        state.pending[req.requestId] = req;
        state.order.push(req.requestId);

        // 听觉提示（附加通道；不替代可见告知，也不构成审批入口）
        if (global.WinbotsCue && typeof global.WinbotsCue.notifyApprovalRequest === "function") {
            global.WinbotsCue.notifyApprovalRequest({ requestId: req.requestId });
        }
        renderPendingBar();
        renderNext();
    }

    function onSettled(requestId, outcome) {
        if (!requestId) return;
        delete state.pending[requestId];
        var idx = state.order.indexOf(requestId);
        if (idx >= 0) state.order.splice(idx, 1);

        if (global.WinbotsCue && typeof global.WinbotsCue.notifyApprovalSettled === "function") {
            global.WinbotsCue.notifyApprovalSettled({ requestId: requestId, outcome: outcome });
        }
        if (state.current === requestId) closeModal();
        renderPendingBar();
        renderNext();
    }

    /* ---------- 短轮询降级（VS-03 未定案时仍可用；与 SSE 共用去重键） ---------- */

    function startPolling() {
        if (state.pollTimer) return;
        state.pollTimer = global.setInterval(pollOnce, CONFIG.POLL_FALLBACK_MS);
        pollOnce();
    }

    function stopPolling() {
        if (state.pollTimer) {
            global.clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    function pollOnce() {
        if (!state.sessionId) return;
        fetch(CONFIG.PENDING_ENDPOINT + "?sessionId=" + encodeURIComponent(state.sessionId), { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data || !data.requests) return;
                var seen = {};
                for (var i = 0; i < data.requests.length; i++) {
                    var req = data.requests[i];
                    seen[req.requestId] = true;
                    onRequest(req);
                }
                // 轮询下发现「服务端已经没有它了」→ 视为已结束（决定 / 超时 / 取消 / 断连）
                for (var id in state.pending) {
                    if (Object.prototype.hasOwnProperty.call(state.pending, id) && !seen[id]) {
                        onSettled(id, "unknown");
                    }
                }
            })
            .catch(function () { /* 轮询失败不提示（NB-11 同样的克制） */ });
    }

    /* ============================================================
     * 二、弹窗渲染（AP-09 / AP-10 / AP-21 / AP-22）
     * ============================================================ */

    function renderNext() {
        if (state.current) return;                 // 已有弹窗：等它结束
        if (state.order.length === 0) return;
        var id = state.order[0];
        var req = state.pending[id];
        if (!req) { state.order.shift(); return renderNext(); }
        state.current = id;
        renderModal(req);
    }

    function renderModal(req) {
        var modal = byId("approval-modal");
        if (!modal) return;                        // HTML 未落地：不报错（审批仍可由接口完成）

        // 清空上一次内容（只保留结构）
        var panel = modal.querySelector(".approval-modal__panel");
        if (!panel) return;
        panel.innerHTML = "";

        var title = el("div", "approval-modal__title", "⏳ 有命令等待你的授权");
        title.id = "approval-modal-title";          // 与容器上的 aria-labelledby 对应（无障碍）
        panel.appendChild(title);

        // ① 元信息：来源会话 / 绝对工作目录 / 超时（AP-09 ②③④）
        var meta = el("div", "approval-modal__meta");
        meta.appendChild(el("span", "", "来源会话：" + (req.sessionTitle || req.sessionId || "（未知）")));
        meta.appendChild(el("span", "", "工作目录：" + req.cwd));
        meta.appendChild(el("span", "", "超时：" + req.timeoutMs + "ms"));
        meta.appendChild(el("span", "", "权限档位：" + req.permission));
        // [skill / C-23] 来源技能：仅在本轮确实由某个 skill 装配时渲染（字段缺省则不渲染，避免出现空标签）
        if (req.skill) meta.appendChild(el("span", "approval-modal__skill", "来源技能：" + req.skill));
        panel.appendChild(meta);

        // ② 完整命令原文：等宽、可滚动、**不截断、不折叠**（AP-09 ①）
        panel.appendChild(el("div", "approval-modal__label", "将要执行的命令（原文，逐字符执行）"));
        var pre = el("pre", "approval-modal__command", req.command);
        pre.setAttribute("tabindex", "0");
        panel.appendChild(pre);

        // ③ 醒目提示（AP-09 ⑤）
        panel.appendChild(
            el(
                "div",
                "approval-modal__warn",
                "命令将以服务进程权限在本机真实执行，可能修改或删除文件，无法撤销。"
            )
        );
        if (req.destructiveHint) {
            // AP-10：命中疑似破坏性特征只追加一行警示，不自动跳过、也不自动选「拒绝」
            panel.appendChild(el("div", "approval-modal__destructive", "⚠️ 该命令命中疑似破坏性特征，请确认目标与影响范围。"));
        }

        // ④ 三段告知（AP-21 / AP-22）：视觉区隔的独立区块，风险与边界不得被折叠或缩短
        panel.appendChild(
            buildBlock("approval-block--intent", "目的", req.intent, "模型自述，未经核实")
        );
        panel.appendChild(buildBlock("approval-block--risk", "风险", req.risk, "系统生成"));
        panel.appendChild(buildBlock("approval-block--boundary", "边界", req.boundary, "系统生成"));

        // ⑤ 选项（AP-10：默认选中「拒绝」；AP-15：全放开选项由服务端开关控制）
        var optionsBox = el("div", "approval-modal__options");
        for (var i = 0; i < OPTIONS.length; i++) {
            var opt = OPTIONS[i];
            if (opt.value === "allow_session_all" && req.allowAllOption === false) continue;
            var label = el("label", "approval-option" + (opt.cls ? " " + opt.cls : ""));
            var radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "approval-choice";
            radio.value = opt.value;
            radio.checked = opt.value === "deny";      // 默认拒绝
            label.appendChild(radio);
            label.appendChild(el("span", "", opt.text));
            optionsBox.appendChild(label);
        }
        panel.appendChild(optionsBox);

        // ⑥ 底部：告知块版本号 + 提交按钮（按钮文案不写「允许」，避免误点）
        var footer = el("div", "approval-modal__footer");
        footer.appendChild(el("span", "approval-modal__version", "告知块版本 " + (req.noticeVersion || "-")));
        var submitBtn = el("button", "approval-modal__submit", "提交决定");
        submitBtn.type = "button";
        submitBtn.addEventListener("click", function () { submitDecision(req.requestId); });
        footer.appendChild(submitBtn);
        panel.appendChild(footer);

        panel.appendChild(el("div", "approval-modal__error", "")).setAttribute("hidden", "hidden");

        modal.hidden = false;
        // AP-10：初始焦点落在「拒绝」上；不存在「回车即允许」
        var denyRadio = optionsBox.querySelector('input[value="deny"]');
        if (denyRadio) {
            try { denyRadio.focus(); } catch (e) { /* 忽略 */ }
        }
        document.body.classList.add("approval-open");
    }

    function buildBlock(cls, title, text, badge) {
        var sec = el("section", "approval-block " + cls);
        var head = el("h4", "approval-block__title", title);
        if (badge) head.appendChild(el("span", "approval-block__badge", badge));
        sec.appendChild(head);
        sec.appendChild(el("p", "approval-block__text", text || "（空）"));
        return sec;
    }

    function closeModal() {
        var modal = byId("approval-modal");
        if (modal) modal.hidden = true;
        document.body.classList.remove("approval-open");
        state.current = null;
        state.submitting = false;
    }

    /* ============================================================
     * 三、提交决定（AP-19）
     * ============================================================ */

    function submitDecision(requestId) {
        if (state.submitting) return;
        var checked = document.querySelector('input[name="approval-choice"]:checked');
        if (!checked) return;

        var panel = document.querySelector("#approval-modal .approval-modal__panel");
        var errBox = panel ? panel.querySelector(".approval-modal__error") : null;
        var submitBtn = panel ? panel.querySelector(".approval-modal__submit") : null;

        state.submitting = true;
        if (submitBtn) submitBtn.disabled = true;
        if (errBox) { errBox.hidden = true; errBox.textContent = ""; }

        fetch(CONFIG.DECISION_PREFIX + encodeURIComponent(requestId) + "/decision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true, decision: checked.value })
        })
            .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
            .then(function (res) {
                if (res.status === 200 && res.body && res.body.ok) {
                    // 决定已受理：等 approval_settled 事件关闭弹窗（避免「本地关了、服务端还在等」）
                    // 若 1.5s 内没收到事件（例如 SSE 已断），本地也关掉，服务端已按超时/断连自行结算。
                    global.setTimeout(function () {
                        if (state.current === requestId) {
                            onSettled(requestId, "allowed_or_denied");
                        }
                    }, 1500);
                    return;
                }
                if (res.status === 409) {
                    if (errBox) { errBox.hidden = false; errBox.textContent = "该请求已结束"; }
                    global.setTimeout(function () { onSettled(requestId, "closed"); }, 1200);
                    return;
                }
                if (errBox) {
                    errBox.hidden = false;
                    errBox.textContent = (res.body && (res.body.error || res.body.code)) || "提交失败，请重试";
                }
                state.submitting = false;
                if (submitBtn) submitBtn.disabled = false;
            })
            .catch(function () {
                if (errBox) { errBox.hidden = false; errBox.textContent = "提交失败（网络错误），请重试"; }
                state.submitting = false;
                if (submitBtn) submitBtn.disabled = false;
            });
    }

    /* ============================================================
     * 四、挂起态持续可见标记（NB-13）
     * ============================================================ */

    function renderPendingBar() {
        var bar = byId("approval-pending-bar");
        if (!bar) return;
        var n = state.order.length;
        if (n === 0) {
            bar.hidden = true;
            bar.textContent = "";
            return;
        }
        bar.hidden = false;
        bar.textContent = "⏳ 有 " + n + " 条命令等待你的授权（待审批，不是已完成）";
        bar.onclick = function () {
            var modal = byId("approval-modal");
            if (modal && !modal.hidden) {
                var denyRadio = modal.querySelector('input[value="deny"]');
                if (denyRadio) denyRadio.focus();
            }
        };
    }

    /* ============================================================
     * 五、引导与对外接口
     * ============================================================ */

    function boot() {
        // 弹窗常驻容器：拦截 Enter（除提交按钮）与 Esc，避免「误按回车即允许」/「Esc 逃逸后忘了决定」
        var modal = byId("approval-modal");
        if (modal) {
            modal.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.preventDefault();          // AP-10：不允许用 Esc 关掉弹窗
                    return;
                }
                if (e.key === "Enter" && e.target && e.target.tagName !== "BUTTON") {
                    e.preventDefault();          // 不存在「回车即允许」
                }
            });
        }

        // 会话切换（新建 / 打开历史）时跟随：审批只出现在命令来源会话的界面（AP-11）
        global.addEventListener("winbots:session-changed", function (e) {
            var sid = e && e.detail && e.detail.sessionId;
            if (sid) connect(sid);
        });

        // 首屏：沿用本标签页已保存的会话 ID（chat.js 的 newSession 会随后再广播一次）
        var cached = null;
        try { cached = global.sessionStorage.getItem(CONFIG.SESSION_STORAGE_KEY); } catch (err) { cached = null; }
        if (cached) connect(cached);

        renderPendingBar();
    }

    global.WinbotsApproval = {
        connect: connect,
        disconnect: disconnect,
        inspect: function () {
            return { sessionId: state.sessionId, current: state.current, pending: state.order.slice() };
        }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})(window);
