/**
 * 通用确认弹窗（modal）
 *
 * 职责：把「问一句话、拿一个布尔」做成页面内 modal，替代 window.confirm。
 * 对外只暴露 window.WinbotsConfirm(opts) -> Promise<boolean>。
 *
 * 与 approval.js（#approval-modal）的关系：零耦合。
 *   - 共享 CSS 结构类（.approval-modal / __backdrop / __panel），视觉一致；
 *   - 关闭策略相反：本模块 Esc / 点遮罩 / 取消均可关闭；
 *   - 不引用、不调用 WinbotsApproval 的任何方法，层级只由 CSS z-index（90 vs 80）表达。
 *
 * 约束：
 *   - 正文一律 textContent，禁止 innerHTML（N-MD-4）；
 *   - Promise 只 resolve 一次，且 done 是「每条目」闭包变量（§5.5）；
 *   - 监听器只在 bind() 里绑一次，render() 内零 addEventListener（§5.5）。
 *
 * [落地修正] 相对 docs/modal-代码修改文档.md 附录 A，本文件包含 §7.2 的 4 处修正：
 *   A. keydown 绑在 document（capture），而非 #confirm-modal —— 否则焦点落在弹窗外时 Esc 关不掉；
 *   B. finish() 只要 root 存在就隐藏，不依赖 refs() 是否完整；
 *   C. 只有「容器整体不存在」才降级原生 confirm；容器在但结构残缺 → 按取消处理（resolve(false)）；
 *   D. refs() 在结构残缺分支清空全部节点引用，避免把监听器绑到游离节点上。
 *   另：滚动锁改为引用计数（scrollLocks），避免与审批弹窗互相解锁。
 */
(function () {
    "use strict";

    var warnedFallback = false;

    var state = {
        open: false,
        queue: [],          // [{ opts, resolve }]
        lastFocus: null,
        activeSource: null, // 当前显示框的 source（同源连点忽略用）
        current: null,      // 当前条目 { opts, resolve, done }
        scrollLocks: 0      // 引用计数：审批框与确认框可能同时需要锁滚动
    };

    // ---------- DOM 引用 ----------
    var root = null;
    var backdrop = null;
    var titleEl = null;
    var messageEl = null;
    var cancelBtn = null;
    var okBtn = null;
    var bound = false;

    // ---------- 滚动锁（引用计数） ----------
    function acquireScrollLock() {
        state.scrollLocks += 1;
        if (state.scrollLocks === 1) document.body.classList.add("approval-open");
    }

    function releaseScrollLock() {
        if (state.scrollLocks > 0) state.scrollLocks -= 1;
        if (state.scrollLocks === 0) document.body.classList.remove("approval-open");
    }

    // 缺少 source 时不要用 title 判等，视为「不同来源」进队列。
    // 纯函数：warn 只由 WinbotsConfirm 入口调一次（§6.2 第 6 条）。
    function normalizeSource(opts) {
        if (opts && typeof opts.source === "string" && opts.source !== "") {
            return opts.source;
        }
        return null; // null 永不与任何 source 相等 → 不会误判同源
    }

    /** 容器是否存在于当前文档（用于区分「缺失 → 降级」与「残缺 → 按取消」） */
    function rootExists() {
        return !!document.getElementById("confirm-modal");
    }

    /**
     * 每次都按「当前文档」重新取引用：容器可能被外部删除后重建（AC-16 / AC-20 场景）。
     * 返回 true 表示结构完整、可安全渲染；返回 false 时调用方必须区分
     * 「容器不存在」（走降级）与「容器残缺」（按取消处理）。
     */
    function refs() {
        var prev = root;
        root = document.getElementById("confirm-modal");
        if (!root) {
            backdrop = null;
            titleEl = null;
            messageEl = null;
            cancelBtn = null;
            okBtn = null;
            bound = false;
            return false;
        }

        backdrop = root.querySelector(".approval-modal__backdrop");
        titleEl = root.querySelector("#confirm-modal-title");
        messageEl = root.querySelector("#confirm-modal-message");
        cancelBtn = root.querySelector(".confirm-modal__btn--cancel");
        // 确认按钮用「不含修饰类」的稳定类定位，避免 --ok / --danger 切换后取不到
        okBtn = root.querySelector(".confirm-modal__btn--primary");

        if (!(backdrop && titleEl && messageEl && cancelBtn && okBtn)) {
            // [修正 D] 结构残缺时清空全部引用：否则后续 bind() 会拿游离节点做「先摘再挂」
            backdrop = null;
            titleEl = null;
            messageEl = null;
            cancelBtn = null;
            okBtn = null;
            bound = false;
            return false;
        }

        // 只在「容器节点真的换了」时才重新绑定，避免每次调用都重复 addEventListener
        if (prev !== root) {
            bound = false;
            bind();
        }
        return true;
    }

    // ---------- 队列 ----------
    function drain() {
        if (state.open) return;
        var next = state.queue.shift();
        if (!next) return;
        show(next.opts, next.resolve);
    }

    function finish(result) {
        // done 检查与置位放在所有副作用之前（§6.2 第 5 条）
        var cur = state.current;
        if (!cur || cur.done) return;
        cur.done = true;

        state.current = null;
        state.open = false;
        state.activeSource = null;

        // 关闭 UI：[修正 B] 只要 root 存在就隐藏，即使子节点已被删
        refs();
        if (root) root.hidden = true;
        releaseScrollLock();

        // 还原焦点
        var lf = state.lastFocus;
        state.lastFocus = null;
        if (lf && typeof lf.focus === "function" && document.contains(lf)) {
            try { lf.focus(); } catch (e) { /* 忽略 */ }
        }

        cur.resolve(result);
        drain();
    }

    // ---------- 渲染（可多次调用，禁止 addEventListener） ----------
    function render(opts) {
        var o = opts || {};
        titleEl.textContent = o.title == null ? "" : String(o.title);
        messageEl.textContent = o.message == null ? "" : String(o.message);

        // --ok 与 --danger 严格互斥；--primary 恒在（AC-19）
        var danger = o.danger === true;
        okBtn.classList.toggle("confirm-modal__btn--ok", !danger);
        okBtn.classList.toggle("confirm-modal__btn--danger", danger);
        okBtn.textContent = o.okText == null ? "确认" : String(o.okText);
        cancelBtn.textContent = o.cancelText == null ? "取消" : String(o.cancelText);

        okBtn.disabled = false;
        cancelBtn.disabled = false;
    }

    function show(opts, resolve) {
        state.open = true;
        state.lastFocus = document.activeElement;
        state.activeSource = normalizeSource(opts);
        var entry = { opts: opts, resolve: resolve, done: false };
        state.current = entry;

        try {
            render(opts);
            root.hidden = false;
            acquireScrollLock();
            // 默认焦点在「取消」，danger 时亦然（N-MD-7）
            cancelBtn.focus();
        } catch (err) {
            console.warn("[modal] 渲染失败，按取消处理:", err);
            // [修正 E] 先把本条目标记成已结算，再复位全局状态：
            //   否则清掉 state.current 后 done 标记随之丢失，后续 decide() 可能二次 resolve。
            entry.done = true;
            state.current = null;
            state.open = false;
            state.activeSource = null;
            refs();
            if (root) root.hidden = true;
            releaseScrollLock();
            resolve(false);   // fail-safe
            drain();          // 继续消化队列，别让后续请求卡死
        }
    }

    // ---------- 事件（每个容器节点只绑一次） ----------
    function decide(result) {
        var cur = state.current;
        if (!cur || cur.done) return;
        // 立刻禁用，防双击
        if (okBtn) okBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        finish(result);
    }

    // 具名 handler（关键）：addEventListener 的幂等性依赖「同一 type + 同一 listener 引用」，
    // 若写成内联匿名函数，反复调用 bind() 会真的叠加多份处理器。
    function onCancelClick() { decide(false); }
    function onOkClick() { decide(true); }
    function onBackdropClick(e) { if (e.target === backdrop) decide(false); }
    function onKeydown(e) {
        if (!state.open) return;

        if (e.key === "Escape") {
            e.preventDefault();
            decide(false);
            return;
        }

        if (e.key === "Tab") {
            var first = cancelBtn;
            var last = okBtn;
            if (!root || !first || !last) return;
            var active = document.activeElement;
            if (e.shiftKey) {
                if (active === first || !root.contains(active)) { e.preventDefault(); last.focus(); }
            } else {
                if (active === last || !root.contains(active)) { e.preventDefault(); first.focus(); }
            }
        }
    }

    /**
     * [修正 A] 4 个点击处理器挂在各自节点上，keydown 挂在 document（capture）：
     * 焦点一旦落到弹窗之外，挂在 root 上的 keydown 根本收不到事件（AC-6 / AC-8 会失败）。
     * 全部是具名函数，且绑定前先摘，因此重复进入天然幂等（AC-21）。
     */
    function bind() {
        if (bound) return;
        if (!root || !backdrop || !cancelBtn || !okBtn) return;
        bound = true;

        cancelBtn.removeEventListener("click", onCancelClick);
        okBtn.removeEventListener("click", onOkClick);
        backdrop.removeEventListener("click", onBackdropClick);
        document.removeEventListener("keydown", onKeydown, true);

        cancelBtn.addEventListener("click", onCancelClick);
        okBtn.addEventListener("click", onOkClick);
        backdrop.addEventListener("click", onBackdropClick);
        document.addEventListener("keydown", onKeydown, true);
    }

    // ---------- 对外接口 ----------
    window.WinbotsConfirm = function (opts) {
        var o = opts || {};

        // 每次调用都按当前文档重新取引用（容器可能被外部删除 / 重建）
        if (!refs()) {
            // [修正 C] 区分两种语义
            if (rootExists()) {
                // 容器在、但结构残缺（子节点被删）→ 按取消处理，绝不降级成原生 confirm
                // （否则用户点「确定」就会照样发请求 / 照样删键）
                console.warn("[modal] #confirm-modal 结构残缺，按取消处理");
                return Promise.resolve(false);
            }
            if (!warnedFallback) {
                warnedFallback = true;
                console.warn("[modal] 缺少 #confirm-modal 容器，降级为原生 confirm");
            }
            return Promise.resolve(window.confirm(o.message == null ? "" : String(o.message)));
        }

        var src = normalizeSource(o);
        if (src === null) {
            console.warn("[modal] 缺少 opts.source，按独立来源处理");
        }

        // 同源连点：直接忽略（不弹第二个框、不排队）。src 为 null 时永不判同源。
        if (state.open && src !== null && state.activeSource === src) {
            return Promise.resolve(false);
        }

        return new Promise(function (resolve) {
            if (!state.open) {
                show(o, resolve);
            } else {
                state.queue.push({ opts: o, resolve: resolve });
            }
        });
    };

    // 首屏取一次引用（脚本在 </body> 前加载，此时 DOM 已就绪，通常会直接成功）
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () { refs(); });
    } else {
        refs();
    }
})();
