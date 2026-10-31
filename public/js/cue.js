/**
 * public/js/cue.js
 * 批次二：回答完成提示音 answer_done + cue 机制
 * 依据：docs/REQUIREMENTS.md 第 3 章（NB-01 ~ NB-20 / AC-CUE-01 ~ AC-CUE-09）
 *
 * 设计要点：
 *  1) 两层结构（NB-15）：
 *     语义层 createCueController —— 只吃「终态语义事件」与开关偏好，负责一次性闩锁、
 *       截断抑制、1000ms 间隔合并、审批音仲裁占位；不含任何 DOM / 音频代码。
 *     适配层 createWebAudioPlayer —— 把 (cue 名称, 序号, 起始偏移) 合成成声音；
 *       可注入假实现，用例全程不发声。
 *  2) 零依赖零素材（NB-09 / NH-G-01）：只用浏览器自带 WebAudio 振荡器合成。
 *  3) 150ms 延时用「音频时钟偏移」实现，不用 setTimeout / requestAnimationFrame：
 *     后台标签页的 timer 会被节流到 ≥1s、rAF 会被暂停，二者都会把播放推出 200ms 之外（NB-05）。
 *  4) 静默降级（NB-11）：任何异常只吞掉，不抛错、不提示、不重试、不申请权限。
 *  5) 批次三起 approval_pending 已接线：唯一触发源是界面收到的 approval_request 事件（AP-24）。
 *     本文件**不**从工具名 / 权限档位 / 命令文本 / 按钮状态推断「此刻需要授权」——
 *     推断等于在客户端复制一遍服务端授权策略，两份策略必然漂移（AC-SH-37）。
 */
(function (global) {
    "use strict";

    /* ============================================================
     * 一、cue 规格（NB-09 / NB-10）
     * ------------------------------------------------------------
     * 三个维度同时区分（NB-10 要求至少两维，本方案三维全不同）：
     *           节奏型         音高音区              时长
     *  完成音   down-2 两音下行 440 ~ 660Hz（中音区） 240ms（≤300ms）
     *  审批音   pulse-3 三连脉冲 1046.5Hz（高音区）   360ms（≤500ms）
     *  音量：完成音峰值 1.0 > 审批音 0.8（NB-10：审批音不得高于完成音）
     *        包络 = 8ms 起音 + 保持段 + 指数释放（见二、ENVELOPE）：
     *        保持段把能量撑住，是「听起来更响」的主要来源；
     *        完成音在音量 100% 时峰值恰为 1.0（0 dBFS）：单独一条提示音不会削波，
     *        但与其它声音（在放的音乐 / 另一个标签页 / 同批次的审批音）叠加时，
     *        系统混音仍可能削波 → 想留余量把 answer_done.peakGain 调回 0.8（-1.9 dBFS）。
     * ============================================================ */
    var CUE_SPECS = {
        answer_done: {
            cueName: "answer_done",
            waveform: "sine",
            notes: [
                { freq: 659.25, startMs: 0, durMs: 90 },      // E5
                { freq: 440.00, startMs: 110, durMs: 120 }    // A4（下行四度）
            ],
            peakGain: 1,      // 原 0.18（偏小）× 音量 100% = 1.0（0dBFS）：单条不削波，与其它声音叠加可能削波
            sustain: 0.55,       // 保持段占单音时长的比例（"实心"程度，见 ENVELOPE）
            totalMs: 240,
            rhythm: "down-2",
            pitchBand: "mid",
            desc: "低唤起、两音下行"
        },
        approval_pending: {
            cueName: "approval_pending",
            waveform: "triangle",
            notes: [
                { freq: 1046.50, startMs: 0, durMs: 80 },     // C6
                { freq: 1046.50, startMs: 140, durMs: 80 },   // C6
                { freq: 1046.50, startMs: 280, durMs: 80 }    // C6
            ],
            peakGain: 0.8,      // 原 0.14；严格低于完成音 1.0（NB-10「审批音不得高于完成音」）
            sustain: 0.45,       // 脉冲要短促：保持段比例比完成音更低
            totalMs: 360,
            rhythm: "pulse-3",
            pitchBand: "high",
            desc: "高唤起、三连脉冲"
        }
    };

    /* 时序与仲裁常量（全部可断言，NB-15） */
    var TIMING = {
        PLAY_DELAY_MS: 150,          // NB-05：允许区间 100 ~ 200ms
        MIN_GAP_MS: 1000,            // NB-04 / NB-22⑤：1000ms 内不叠加
        APPROVAL_REPEAT_MS: 30000,   // NB-22②（批次三使用，批次二不触发）
        APPROVAL_MAX_GROUPS: 3       // NB-22②（批次三使用，批次二不触发）
    };

    /* 包络参数（可断言）。改这里会直接改变「听起来多响」，改动需同步文档 §12 */
    var ENVELOPE = {
        ATTACK_MS: 8,           // 起音时长：太短会爆音，太长会削弱「敲一下」的清晰度
        SUSTAIN_FALLBACK: 0.5,  // 规格未声明 sustain 时的兜底比例
        MIN_RELEASE_MS: 12      // 释放段最短时长：保证 exponentialRamp 有可用时间窗
    };

    /** 偏好存本地（NB-12）；键名带项目前缀，避免与其他页面冲突 */
    var STORAGE_KEY = "winbots.cue.prefs";
    var DEFAULT_PREFS = { enabled: true, answer: true, approval: true, volume: 0.6 };

    /** 轮次预算耗尽的 finish.reason（服务端 src/routes/chat.ts 第 803 行） */
    var TRUNCATED_FINISH_REASONS = ["max_tool_rounds"];
    /** 轮次预算耗尽的 notice 文案特征（服务端 src/routes/chat.ts 第 812 行固定文案） */
    var TRUNCATION_NOTICE_RE = /已达工具调用轮次上限/;

    function clamp01(n) {
        var v = Number(n);
        if (!isFinite(v)) return 0;
        return Math.max(0, Math.min(1, v));
    }

    /* ============================================================
     * 二、偏好读写（NB-12 / NB-14 / NB-19）
     * ============================================================ */
    function loadPrefs() {
        var prefs = {
            enabled: DEFAULT_PREFS.enabled,
            answer: DEFAULT_PREFS.answer,
            approval: DEFAULT_PREFS.approval,
            volume: DEFAULT_PREFS.volume
        };
        try {
            var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
            if (!raw) return prefs;
            var o = JSON.parse(raw);
            if (o && typeof o === "object") {
                if (typeof o.enabled === "boolean") prefs.enabled = o.enabled;
                if (typeof o.answer === "boolean") prefs.answer = o.answer;
                if (typeof o.approval === "boolean") prefs.approval = o.approval;
                if (o.volume !== undefined && o.volume !== null) prefs.volume = clamp01(o.volume);
            }
        } catch (e) {
            // 读取失败（隐私模式 / 配额 / 脏数据）→ 全用默认值，且不回写，避免反复抛错
        }
        return prefs;
    }

    function savePrefs(prefs) {
        try {
            global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
                enabled: !!prefs.enabled,
                answer: !!prefs.answer,
                approval: !!prefs.approval,
                volume: clamp01(prefs.volume)
            }));
            return true;
        } catch (e) {
            return false;   // 存不了就只在本页生效，不提示（NB-11 同样的静默原则）
        }
    }

    /* ============================================================
     * 三、适配层：WebAudio 合成播放器（NB-09 / NB-10 / NB-11）
     * ============================================================ */
    function createWebAudioPlayer(options) {
        var opt = options || {};
        var getVolume = opt.getVolume || function () { return DEFAULT_PREFS.volume; };
        var Ctor = global.AudioContext || global.webkitAudioContext;
        var ctx = null;
        var unavailable = !Ctor;          // 没有 WebAudio → 永久静默降级，不重试（NB-11）
        var lastGroup = null;             // 最近一组（供 cancel 使用）

        function ensureContext() {
            if (ctx || unavailable) return ctx;
            try {
                ctx = new Ctor();
            } catch (e) {
                unavailable = true;
                ctx = null;
            }
            return ctx;
        }

        function dispose(group) {
            if (!group) return;
            for (var i = 0; i < group.oscillators.length; i++) {
                var osc = group.oscillators[i];
                try { osc.stop(); } catch (e) { /* 已停止 */ }
                try { osc.disconnect(); } catch (e) { /* 已断开 */ }
            }
            try { group.master.disconnect(); } catch (e) { /* 已断开 */ }
        }

        /**
         * 播放一组 cue。
         * @param {string} cueName       cue 名称（answer_done / approval_pending）
         * @param {number} seq           序号（批次三的重复组用到 1..3；完成音恒为 1）
         * @param {number} startOffsetMs 相对当前的起始偏移（毫秒），由语义层给出 150
         * @returns {boolean} 是否成功排期（失败一律静默，NB-11）
         */
        function play(cueName, seq, startOffsetMs) {
            try {
                var spec = CUE_SPECS[cueName];
                if (!spec) return false;

                var ac = ensureContext();
                if (!ac) return false;

                // 自动播放策略：只有上下文真正 running 时才排期。
                // 若在这里「先排期、等恢复后补响」，恢复可能发生在几十秒后 —— 那比不响更糟。
                if (ac.state !== "running" && typeof ac.resume === "function") {
                    try {
                        var p = ac.resume();
                        if (p && typeof p.catch === "function") p.catch(function () { });
                    } catch (e) { /* 忽略 */ }
                }
                if (ac.state !== "running") return false;

                var offsetSec = Math.max(0, Number(startOffsetMs) || 0) / 1000;
                var t0 = ac.currentTime + offsetSec + 0.01;   // 多留 10ms，让排期远离「当前时刻」
                var master = ac.createGain();
                master.gain.value = clamp01(getVolume()) * spec.peakGain;
                master.connect(ac.destination);

                var oscillators = [];
                for (var i = 0; i < spec.notes.length; i++) {
                    var note = spec.notes[i];
                    var osc = ac.createOscillator();
                    var env = ac.createGain();
                    osc.type = spec.waveform;
                    osc.frequency.value = note.freq;

                    var startAt = t0 + note.startMs / 1000;
                    var endAt = startAt + note.durMs / 1000;
                    var attackMs = Math.min(ENVELOPE.ATTACK_MS, note.durMs * 0.25);
                    var attackAt = startAt + attackMs / 1000;
                    var sustainRatio = (typeof spec.sustain === "number")
                        ? spec.sustain : ENVELOPE.SUSTAIN_FALLBACK;
                    // 保持段结束点：既不超过「留足释放时间」的上限，也不早于起音结束点，
                    // 保证 startAt < attackAt <= holdUntil < endAt 严格递增（否则 WebAudio 抛错）
                    var holdUntil = startAt + (note.durMs * sustainRatio) / 1000;
                    var releaseFloor = endAt - ENVELOPE.MIN_RELEASE_MS / 1000;
                    if (holdUntil > releaseFloor) holdUntil = releaseFloor;
                    if (holdUntil < attackAt) holdUntil = attackAt;

                    // 包络：起音 → 满幅保持 → 指数释放。
                    // 原实现是「起音后立刻指数掉到底」：90ms 的音约 20ms 就衰减殆尽，
                    // 整段能量只剩峰值的 ~23%，听感像「哒」一声 —— 这是「声音偏小」的主因。
                    env.gain.setValueAtTime(0.0001, startAt);             // 不设 0：exponential 不接受 0
                    env.gain.linearRampToValueAtTime(1, attackAt);        // 8ms 起音，防爆音
                    env.gain.setValueAtTime(1, holdUntil);                // 保持满幅（关键：别提前掉包）
                    env.gain.exponentialRampToValueAtTime(0.0001, endAt);  // 指数释放，无爆音

                    osc.connect(env);
                    env.connect(master);
                    osc.start(startAt);
                    osc.stop(endAt + 0.02);
                    oscillators.push(osc);
                }

                var group = { cueName: cueName, seq: seq, oscillators: oscillators, master: master };
                lastGroup = group;
                // 组结束后释放节点（不依赖 onended，避免个别浏览器差异）
                global.setTimeout(function () { dispose(group); },
                    Math.round(offsetSec * 1000) + spec.totalMs + 300);
                return true;
            } catch (e) {
                return false;   // NB-11：静默降级
            }
        }

        /** 取消最近一组（仅用于截断抑制；审批音仲裁在批次三也会用） */
        function cancel() {
            try {
                if (!lastGroup) return false;
                var g = lastGroup;
                lastGroup = null;
                dispose(g);
                return true;
            } catch (e) {
                return false;
            }
        }

        /** 首个用户手势时静默解锁（不弹提示、不申请权限，NB-11） */
        function bindUnlock() {
            if (unavailable) return;

            function off() {
                global.removeEventListener("pointerdown", onGesture, true);
                global.removeEventListener("keydown", onGesture, true);
            }

            function onGesture() {
                var ac = ensureContext();
                if (ac && ac.state !== "running" && typeof ac.resume === "function") {
                    try {
                        var p = ac.resume();
                        if (p && typeof p.catch === "function") p.catch(function () { });
                    } catch (e) { /* 忽略 */ }
                }
                if (ac && ac.state === "running") off();   // resume 是异步的，第一次可能还没生效
            }

            global.addEventListener("pointerdown", onGesture, true);
            global.addEventListener("keydown", onGesture, true);
        }

        return { play: play, cancel: cancel, bindUnlock: bindUnlock };
    }

    /* ============================================================
     * 四、语义层：去重 / 仲裁 / 开关（NB-01 ~ NB-06、NB-14、NB-15）
     * ============================================================ */
    function createCueController(deps) {
        var d = deps || {};
        var player = d.player || createWebAudioPlayer();
        var getPrefs = d.getPrefs || loadPrefs;
        var log = d.log || function () { };
        var now = d.now || function () {
            return (global.performance && typeof global.performance.now === "function")
                ? global.performance.now()
                : Date.now();
        };

        // [批次三 / NB-15] 定时器可注入：用例用虚拟时钟覆盖 30s 重复与 1000ms 间隔
        var setTimer = d.setTimer || function (fn, ms) { return global.setTimeout(fn, ms); };
        var clearTimer = d.clearTimer || function (h) { global.clearTimeout(h); };

        var st = {
            latchedRoundId: null,     // NB-04 一次性闩锁：已消费终态的轮次
            suppressedRoundId: null,  // NB-06：命中截断的轮次
            lastPlayAt: null,         // NB-04：上一次「排期播放」的时刻
            lastScheduled: null,      // { roundId, cueName }：最近一次成功排期
            approvalPending: false,   // NB-21 / NB-22⑤：是否有仍挂起的审批请求（由 approvals 派生）
            playedCount: 0,           // 便于手工/用例观察
            // [批次三 / AP-25] 审批音状态：requestId → { requestId, played, timers, settled }
            approvals: {},
            approvalQueue: [],        // NB-22④：按请求到达顺序排队（相邻间隔 ≥ MIN_GAP_MS）
            finishedApprovals: {},    // NB-22③：已结束的 requestId（防重渲染/重连重复计数）
            approvalSeq: 0            // 请求到达序（仅用于日志与排查）
        };

        function isTruncatedFinish(reason) {
            return TRUNCATED_FINISH_REASONS.indexOf(String(reason || "")) >= 0;
        }

        /**
         * 终态语义事件：正常完成。调用方只允许在 SSE 的 finish 分支、且非排空态时调用。
         * @param {{roundId:string, reason:string}} evt
         * @returns {string} 处理结果（供用例断言）
         */
        function notifyFinish(evt) {
            var e = evt || {};
            var roundId = e.roundId || "unknown";

            // NB-04：同一轮恰好一次。轮次标识缺失时不闩锁，避免把后续轮次全部吃掉
            if (roundId !== "unknown") {
                if (st.latchedRoundId === roundId) return "ignored_duplicate";
                st.latchedRoundId = roundId;
            }

            // NB-06 / AC-CUE-02：轮次预算耗尽（答案被截断）不播
            if (isTruncatedFinish(e.reason) || (roundId !== "unknown" && st.suppressedRoundId === roundId)) {
                log("[cue] 本轮为截断终态，不播完成音:", roundId, e.reason);
                return "suppressed_truncated";
            }

            return playCue("answer_done", roundId, TIMING.PLAY_DELAY_MS, 1);
        }

        /**
         * 截断类 notice：抑制本轮完成音（NB-06）。
         * 只认「已达工具调用轮次上限」这一类；B-03 的「模型未返回正文…」属正常完成，必须继续响。
         * @param {{roundId:string, message:string}} evt
         */
        function notifyNotice(evt) {
            var e = evt || {};
            var msg = String(e.message || "");
            if (!TRUNCATION_NOTICE_RE.test(msg)) return "ignored";

            var roundId = e.roundId
                || (st.lastScheduled && st.lastScheduled.roundId)
                || st.latchedRoundId
                || "unknown";
            st.suppressedRoundId = roundId;

            // 已排期但尚未发声（finish 与 notice 同批到达，相差通常 <1ms）→ 取消
            if (st.lastScheduled && st.lastScheduled.roundId === roundId
                && st.lastScheduled.cueName === "answer_done") {
                if (typeof player.cancel === "function") player.cancel();
                st.lastScheduled = null;
                // 本轮实际没有发声，不占用 1000ms 合并窗口（否则紧接着的下一轮会被误合并掉）
                st.lastPlayAt = null;
            }
            log("[cue] 截断 notice 到达，抑制本轮完成音:", roundId);
            return "suppressed";
        }

        /**
         * 开关判定 + 间隔策略 + 实际排期。
         * @param {string} cueName  answer_done / approval_pending
         * @param {string} refId    完成音=轮次标识；审批音=requestId（AP-19 的一次性标识）
         * @param {number} delayMs  起始偏移（毫秒）：完成音固定 150（NB-05）；审批音 0 或顺延值
         * @param {number} seq      序号（NB-15：审批音重复组 1..3；完成音恒为 1）
         */
        function playCue(cueName, refId, delayMs, seq) {
            var prefs = getPrefs();

            // NB-12 / NB-14：主开关与子开关各自独立生效
            if (!prefs.enabled) return "skipped_master_off";
            if (cueName === "answer_done" && !prefs.answer) return "skipped_answer_off";
            if (cueName === "approval_pending" && !prefs.approval) return "skipped_approval_off";

            // NB-21 / NB-22⑤ 仲裁：挂起审批期间**禁播**完成音，且直接丢弃、不延迟补播
            if (cueName === "answer_done" && st.approvalPending) return "dropped_approval_pending";

            var t = now();
            var offset = Math.max(0, Number(delayMs) || 0);

            // NB-04：完成音两次终态不足 1000ms 时合并为一次（丢弃后一次）
            // NB-22④：审批音**不丢弃**，改为顺延到 ≥1000ms（由调用方计算 delayMs）
            if (cueName === "answer_done"
                && st.lastPlayAt !== null
                && (t - st.lastPlayAt) < TIMING.MIN_GAP_MS) {
                return "dropped_min_gap";
            }

            var ok = false;
            try {
                ok = player.play(cueName, seq || 1, offset) !== false;
            } catch (e) {
                ok = false;                     // NB-11：播放失败不影响任何流程
            }

            if (ok) {
                // 只有「确实排期成功」才占用 1000ms 窗口：
                // 播放失败不占用，否则会连累下一次（漏响可接受，连续漏响没必要）
                st.lastPlayAt = t + offset;     // 记录**实际发声时刻**，顺延过的也算
                st.lastScheduled = { roundId: refId, cueName: cueName };
                st.playedCount++;
            } else {
                st.lastScheduled = null;
            }

            log("[cue] 排期", cueName, ok ? "成功" : "失败(静默)",
                "ref=" + refId, "延时=" + offset + "ms", "序号=" + (seq || 1));
            return ok ? "played" : "play_failed_silent";
        }

        /* ============================================================
         * 四之二、审批音：触发 / 排队 / 重复 / 仲裁（NB-21 / NB-22 / AP-24 / AP-25）
         * ------------------------------------------------------------
         * 关键点：
         *  · 首组**立即**播（偏移 0），与完成音的 150ms 收尾延时不同；
         *  · 仍挂起则每 30s 一组，最多 3 组（含首组）；
         *  · 用户决定 / 取消 / 超时 / 断连 → 立即停止重复；
         *  · 同一 requestId 只计一次（重渲染、轮询、重连都不重复）；
         *  · 多会话同时挂起按到达顺序排队，相邻两组间隔 ≥1000ms（顺延，不丢弃）。
         * ============================================================ */

        function hasPendingApproval() {
            for (var k in st.approvals) {
                if (Object.prototype.hasOwnProperty.call(st.approvals, k)) return true;
            }
            return false;
        }

        function clearApprovalTimers(s) {
            for (var i = 0; i < s.timers.length; i++) {
                try { clearTimer(s.timers[i]); } catch (e) { /* 已清理 */ }
            }
            s.timers = [];
        }

        /**
         * 审批请求挂起：**唯一入口**（AP-24）。
         * 调用方只允许在收到 approval_request 事件时调用，不得据其它信号推断。
         * @param {{requestId:string}} evt
         */
        function notifyApprovalRequest(evt) {
            var e = evt || {};
            var id = String(e.requestId || "");
            if (!id) return "ignored_no_id";

            // AP-25 / NB-22③：同一请求不因重渲染、轮询刷新、断线重连重复计数
            if (st.approvals[id] || st.finishedApprovals[id]) return "ignored_duplicate";

            st.approvalSeq++;
            st.approvals[id] = {
                requestId: id,
                order: st.approvalSeq,
                played: 0,
                timers: [],
                settled: false
            };
            st.approvalPending = true;          // NB-21 / NB-22⑤：挂起期间禁播完成音
            st.approvalQueue.push(id);          // NB-22④：按到达顺序排队
            log("[cue] 收到审批请求，加入审批音队列:", id);
            return drainApprovalQueue();
        }

        /**
         * 审批请求结束：决定 / 取消 / 超时 / 断连都必须调用（NB-22②「立即停止」）。
         * @param {{requestId:string}} evt
         */
        function notifyApprovalSettled(evt) {
            var e = evt || {};
            var id = String(e.requestId || "");
            var s = st.approvals[id];

            if (!s) {
                if (id) st.finishedApprovals[id] = true;   // 记下来，防止迟到的重复事件再响一次
                return "ignored_unknown";
            }
            clearApprovalTimers(s);
            s.settled = true;
            delete st.approvals[id];
            st.finishedApprovals[id] = true;

            for (var i = st.approvalQueue.length - 1; i >= 0; i--) {
                if (st.approvalQueue[i] === id) st.approvalQueue.splice(i, 1);
            }
            st.approvalPending = hasPendingApproval();
            log("[cue] 审批已结束，停止重复:", id, "仍有挂起=" + st.approvalPending);
            return "settled";
        }

        /**
         * 队列出队播放。
         * NB-22④：相邻两组间隔 ≥ MIN_GAP_MS —— 不满足时**顺延**（不是丢弃）。
         */
        function drainApprovalQueue() {
            if (st.approvalQueue.length === 0) return "idle";

            var id = st.approvalQueue[0];
            var s = st.approvals[id];
            if (!s || s.settled) {
                st.approvalQueue.shift();
                return drainApprovalQueue();
            }

            var prefs = getPrefs();
            // NB-14 / NB-22⑥：关闭审批音 → 不播，但挂起状态与视觉标记完全不受影响
            if (!prefs.enabled || !prefs.approval) {
                st.approvalQueue.shift();
                s.played = TIMING.APPROVAL_MAX_GROUPS;   // 视为已播完，避免开关打开后补播旧请求
                return "skipped_approval_off";
            }

            var delay = 0;                       // AP-24：首组「立即播放」
            if (st.lastPlayAt !== null) {
                var gap = now() - st.lastPlayAt;
                if (gap < TIMING.MIN_GAP_MS) delay = TIMING.MIN_GAP_MS - gap;
            }

            s.played += 1;
            var result = playCue("approval_pending", id, delay, s.played);
            st.approvalQueue.shift();

            if (result === "played") scheduleApprovalRepeat(s);
            return result;
        }

        /** NB-22②：仍挂起且用户无交互 → 间隔 repeatMs 再排一组，最多 APPROVAL_MAX_GROUPS 组 */
        function scheduleApprovalRepeat(s) {
            if (s.settled || s.played >= TIMING.APPROVAL_MAX_GROUPS) return;

            var handle = setTimer(function () {
                if (s.settled || s.played >= TIMING.APPROVAL_MAX_GROUPS) return;
                // 通过队列重新排队：与其它请求的播放仍然保持 ≥1000ms 间隔（NB-22④）
                st.approvalQueue.push(s.requestId);
                drainApprovalQueue();
            }, TIMING.APPROVAL_REPEAT_MS);

            s.timers.push(handle);
        }

        return {
            notifyFinish: notifyFinish,
            notifyNotice: notifyNotice,
            // [批次三 / AP-24] 审批音的两个入口（只由 approval.js 在收到事件时调用）
            notifyApprovalRequest: notifyApprovalRequest,
            notifyApprovalSettled: notifyApprovalSettled,
            inspect: function () {
                var ids = [];
                for (var k in st.approvals) {
                    if (Object.prototype.hasOwnProperty.call(st.approvals, k)) ids.push(k);
                }
                return {
                    latchedRoundId: st.latchedRoundId,
                    suppressedRoundId: st.suppressedRoundId,
                    lastPlayAt: st.lastPlayAt,
                    playedCount: st.playedCount,
                    approvalPending: st.approvalPending,
                    pendingApprovals: ids,              // 当前仍挂起的 requestId
                    approvalQueue: st.approvalQueue.slice(),
                    approvalGroups: ids.map(function (k) { return st.approvals[k].played; })
                };
            }
        };
    }

    /* ============================================================
     * 五、设置面板绑定（NB-12 / NB-14 / NB-13 冗余说明）
     * ============================================================ */
    function initCueUi() {
        var root = document.getElementById("cue-settings");
        if (!root) return null;   // HTML 未落地时不报错，提示音照常工作（默认全开）

        var toggle = document.getElementById("cue-settings-toggle");
        var panel = document.getElementById("cue-settings-panel");
        var masterEl = document.getElementById("cue-enabled");
        var answerEl = document.getElementById("cue-answer");
        var approvalEl = document.getElementById("cue-approval");
        var volumeEl = document.getElementById("cue-volume");
        var volumeText = document.getElementById("cue-volume-text");

        var prefs = loadPrefs();

        function render() {
            if (masterEl) masterEl.checked = !!prefs.enabled;
            if (answerEl) answerEl.checked = !!prefs.answer;
            if (approvalEl) approvalEl.checked = !!prefs.approval;
            var pct = Math.round(clamp01(prefs.volume) * 100);
            if (volumeEl) volumeEl.value = String(pct);
            if (volumeText) volumeText.textContent = pct + "%";
            // NB-14：子开关各自独立，不随主开关禁用/隐藏
        }

        function commit() {
            savePrefs(prefs);
            render();
        }

        if (masterEl) masterEl.addEventListener("change", function () {
            prefs.enabled = !!masterEl.checked; commit();
        });
        if (answerEl) answerEl.addEventListener("change", function () {
            prefs.answer = !!answerEl.checked; commit();
        });
        if (approvalEl) approvalEl.addEventListener("change", function () {
            var wasOn = !!prefs.approval;
            prefs.approval = !!approvalEl.checked; commit();

            // [批次三 / NB-22⑥] 关闭审批音：一次性告知「此后挂起期间只剩视觉提示」。
            //   ① 不阻止关闭（不弹 confirm、不弹二次窗）；② 不重复告知（只在「开→关」这一刻显示一行文字）。
            var note = document.getElementById("cue-approval-off-note");
            if (note) {
                if (wasOn && !prefs.approval) {
                    note.hidden = false;
                    note.textContent = "已关闭授权请求提示音：此后命令挂起期间只剩视觉提示（顶部待审批标记），可能错过需要确认的命令。";
                } else if (prefs.approval) {
                    note.hidden = true;
                    note.textContent = "";
                }
            }
        });
        if (volumeEl) volumeEl.addEventListener("input", function () {
            prefs.volume = clamp01(Number(volumeEl.value) / 100); commit();
        });

        function setOpen(open) {
            if (panel) panel.hidden = !open;
            if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
        }

        if (toggle) {
            toggle.addEventListener("click", function (e) {
                e.preventDefault();
                setOpen(!!(panel && panel.hidden));
            });
        }
        // 点击面板外部关闭
        document.addEventListener("click", function (e) {
            if (!panel || panel.hidden) return;
            if (root.contains(e.target)) return;
            setOpen(false);
        });
        // Esc 关闭
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && panel && !panel.hidden) setOpen(false);
        });

        render();
        setOpen(false);
        return { reload: render };
    }

    /* ============================================================
     * 六、引导与对外接口
     * ============================================================ */
    var player = createWebAudioPlayer({
        getVolume: function () { return loadPrefs().volume; }   // 每次现读，改音量立即生效
    });
    var controller = createCueController({ player: player, getPrefs: loadPrefs });

    function boot() {
        initCueUi();
        player.bindUnlock();   // 首个用户手势静默解锁音频上下文
    }

    global.WinbotsCue = {
        CUE_SPECS: CUE_SPECS,
        TIMING: TIMING,
        // 语义层/适配层的注入点（NB-15）：用例自建 controller + 假 player，全程不发声
        createCueController: createCueController,
        createWebAudioPlayer: createWebAudioPlayer,
        loadPrefs: loadPrefs,
        savePrefs: savePrefs,
        // 页面运行时实例：只接收「终态语义事件」，不含任何 play / 审批音入口
        notifyFinish: controller.notifyFinish,
        notifyNotice: controller.notifyNotice,
        // [批次三 / AP-24] 审批音入口：调用方只允许是 approval.js 的 approval_request 处理分支
        notifyApprovalRequest: controller.notifyApprovalRequest,
        notifyApprovalSettled: controller.notifyApprovalSettled,
        inspect: controller.inspect
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})(window);
