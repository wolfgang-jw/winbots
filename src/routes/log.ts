/**
 * src/routes/log.ts
 * LLM 对话日志查询与清理接口（Sprint 5.1 / US-LOG-4）
 *
 * 挂载点：/api/log
 *   - GET    /api/log/logs?limit=100  按时间倒序列出日志摘要
 *   - GET    /api/log/logs/:index     读取单条日志详情（JSONL 以行序号定位）
 *   - DELETE /api/log/logs            清空全部日志（需 confirm: true）
 *
 * 设计说明：
 * - 仅本地文件读取，无 SQL 注入面；路径来自配置（env.LLM_LOG_FILE），不接受用户输入路径。
 * - 开关关闭时日志文件为空，查询自然返回空列表。
 * - 清空为破坏性操作，需显式确认（与项目破坏性操作风格一致）。
 */
import { Hono } from "hono";
import { listLlmLogs, getLlmLog, clearLlmLogs } from "@/infra/llmLog";

const router = new Hono();

// GET /api/log/logs?limit=100 —— 按时间倒序列出日志摘要
router.get("/logs", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "100", 10) || 100, 500);
    return c.json({ logs: listLlmLogs(limit) });
});

// GET /api/log/logs/:index —— 单条日志详情（JSONL 以行序号定位）
router.get("/logs/:index", (c) => {
    const index = parseInt(c.req.param("index"), 10);
    if (!Number.isFinite(index)) return c.json({ error: "日志序号非法" }, 400);
    const log = getLlmLog(index);
    if (!log) return c.json({ error: "日志不存在" }, 404);
    return c.json({ log });
});

// DELETE /api/log/logs —— 清空全部日志（需确认）
router.delete("/logs", async (c) => {
    let confirm = false;
    try {
        confirm = (await c.req.json())?.confirm === true;
    } catch {
        /* 无 body 或非法 JSON：视为未确认 */
    }
    if (!confirm) return c.json({ error: "清空日志需显式确认（confirm: true）" }, 400);
    const deleted = clearLlmLogs();
    return c.json({ ok: true, deleted });
});

export default router;
