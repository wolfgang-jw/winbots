/**
 * Bots 系统状态监控 - 前端逻辑
 *
 * 职责：
 * 1. 定时调用 /api/health 获取系统状态
 * 2. 更新概览卡片和 LLM 服务卡片的数据
 * 3. 支持手动刷新
 * 4. 显示自动刷新倒计时
 *
 * 注意：已去除 MySQL 和 Redis 渲染逻辑
 */

(function ($) {
  "use strict";

  // ============================================
  // 配置常量
  // ============================================
  const CONFIG = {
    REFRESH_INTERVAL: 10000, // 自动刷新间隔（毫秒）
    API_ENDPOINT: "/api/health",
    DEGRADED_THRESHOLD: 500, // 延迟超过此值视为"缓慢"（毫秒）
  };

  // ============================================
  // 状态管理
  // ============================================
  const state = {
    countdown: CONFIG.REFRESH_INTERVAL / 1000,
    isFirstLoad: true,
    timerId: null,
    countdownTimerId: null,
  };

  // ============================================
  // DOM 缓存（提升性能）
  // ============================================
  const $dom = {
    systemStatus: $("#system-status"),
    uptime: $("#uptime"),
    totalLatency: $("#total-latency"),
    updateTime: $("#update-time"),
    refreshText: $("#refresh-text"),

    llmBadge: $("#llm-badge"),
    llmLatency: $("#llm-latency"),
    llmModel: $("#llm-model"),
    llmApiBase: $("#llm-api-base"),
  };

  // ============================================
  // 工具函数
  // ============================================

  /**
   * 格式化运行时间
   * @param {number} seconds - 运行秒数
   * @returns {string} - 可读的时间字符串
   */
  function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(days + "天");
    if (hours > 0) parts.push(hours + "时");
    if (minutes > 0) parts.push(minutes + "分");
    parts.push(secs + "秒");

    return parts.join("");
  }

  /**
   * 格式化延迟显示
   * @param {number} ms - 延迟毫秒数
   * @returns {string} - 带单位的延迟字符串
   */
  function formatLatency(ms) {
    if (ms < 0) return "-";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(2) + "s";
  }

  /**
   * 获取状态徽章的 CSS 类名
   * @param {boolean} ok - 是否正常
   * @returns {string} - CSS 类名
   */
  function getBadgeClass(ok) {
    if (ok === true) return "ok";
    if (ok === false) return "error";
    return "检测中";
  }

  /**
   * 获取状态徽章文本
   * @param {boolean} ok - 是否正常
   * @returns {string} - 显示文本
   */
  function getBadgeText(ok) {
    if (ok === true) return "✅ 正常";
    if (ok === false) return "❌ 异常";
    return "检测中";
  }

  // ============================================
  // 数据渲染函数
  // ============================================

  /**
   * 渲染概览卡片
   * @param {object} data - /api/health 返回的数据
   */
  function renderOverview(data) {
    // 系统状态
    const statusText = data.status === "ok" ? "✅ 正常运行" : "⚠️ 部分异常";
    $dom.systemStatus.text(statusText);
    $dom.systemStatus
      .removeClass("ok degraded error")
      .addClass(data.status === "ok" ? "ok" : "degraded");

    // 运行时间
    $dom.uptime.text(formatUptime(data.uptime));

    // 总延迟
    $dom.totalLatency.text(formatLatency(data.latency));

    // 更新时间
    const now = new Date();
    $dom.updateTime.text(now.toLocaleTimeString("zh-CN"));
  }

  /**
   * 渲染 LLM 服务卡片
   * @param {object} llm - llm 服务状态数据
   */
  function renderLlm(llm) {
    $dom.llmBadge
      .removeClass("ok error 检测中")
      .addClass(getBadgeClass(llm.ok))
      .text(getBadgeText(llm.ok));

    $dom.llmLatency.text(formatLatency(llm.latency));
    $dom.llmModel.text(llm.model || "-");
    $dom.llmApiBase.text(llm.api_base || "-");
  }

  /**
   * 渲染错误信息
   * @param {string} service - 服务名称
   * @param {string} errorMsg - 错误消息
   */
  function renderError(service, errorMsg) {
    const $card = $('.service-card[data-service="' + service + '"]');
    let $errorEl = $card.find(".service-card__error");

    if ($errorEl.length === 0) {
      $errorEl = $('<div class="service-card__error"></div>');
      $card.find(".service-card__body").append($errorEl);
    }

    $errorEl.text("⚠️ " + errorMsg);
  }

  /**
   * 清除错误信息
   * @param {string} service - 服务名称
   */
  function clearError(service) {
    $('.service-card[data-service="' + service + '"]')
      .find(".service-card__error")
      .remove();
  }

  // ============================================
  // 核心数据获取函数
  // ============================================

  /**
   * 从后端获取健康状态数据并更新页面
   */
  function fetchHealthData() {
    // 显示加载状态
    if (state.isFirstLoad) {
      $dom.systemStatus.text("检测中...");
    }

    $.ajax({
      url: CONFIG.API_ENDPOINT,
      method: "GET",
      dataType: "json",
      timeout: 15000,
      success: function (data) {
        state.isFirstLoad = false;

        // 渲染概览
        renderOverview(data);

        // 渲染各服务
        const services = data.services || {};

        // LLM（唯一保留的服务）
        if (services.llm) {
          renderLlm(services.llm);
          if (!services.llm.ok && services.llm.error) {
            renderError("llm", services.llm.error);
          } else {
            clearError("llm");
          }
        }
      },
      error: function (jqXHR, textStatus, errorThrown) {
        state.isFirstLoad = false;

        // 网络错误处理
        const errorMsg = textStatus === "timeout"
          ? "请求超时"
          : "请求失败: " + (errorThrown || textStatus);

        $dom.systemStatus.text("❌ 连接失败").addClass("error");

        // LLM 标记为异常
        const $badge = $("#llm-badge");
        $badge.removeClass("ok error 检测中").addClass("error").text("❌ 异常");
        renderError("llm", errorMsg);
      },
    });
  }

  // ============================================
  // 倒计时更新
  // ============================================

  /**
   * 更新倒计时显示
   */
  function updateCountdown() {
    if (state.countdown <= 0) {
      state.countdown = CONFIG.REFRESH_INTERVAL / 1000;
    }

    $dom.refreshText.text("⏱️ " + state.countdown + "秒后自动刷新");
    state.countdown--;
  }

  // ============================================
  // 初始化与定时器管理
  // ============================================

  /**
   * 启动定时刷新
   */
  function startAutoRefresh() {
    // 清除旧定时器
    stopAutoRefresh();

    // 立即执行一次
    fetchHealthData();

    // 设置定时器
    state.timerId = setInterval(fetchHealthData, CONFIG.REFRESH_INTERVAL);
    state.countdownTimerId = setInterval(updateCountdown, 1000);
  }

  /**
   * 停止定时刷新
   */
  function stopAutoRefresh() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    if (state.countdownTimerId) {
      clearInterval(state.countdownTimerId);
      state.countdownTimerId = null;
    }
  }

  /**
   * 手动刷新
   */
  function manualRefresh() {
    state.countdown = CONFIG.REFRESH_INTERVAL / 1000;
    $dom.refreshText.text("🔄 正在刷新...");
    fetchHealthData();
  }

  // ============================================
  // 页面就绪后初始化
  // ============================================
  $(document).ready(function () {
    // 绑定手动刷新按钮
    $("#refresh-btn").on("click", manualRefresh);

    // 启动自动刷新
    startAutoRefresh();
  });
})(jQuery);
