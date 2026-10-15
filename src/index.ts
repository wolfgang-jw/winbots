/**
 * Bots 项目入口文件
 * 
 * 职责：
 * 1. 加载环境变量校验（自动执行）
 * 2. 创建 Hono 应用并注册中间件
 * 3. 挂载所有 API 路由
 * 4. 配置静态文件服务（前端页面）
 * 5. 注册 SIGINT/SIGTERM 优雅关闭
 * 6. 启动 HTTP 服务器
 */
import { Hono } from "hono";
import { resolve } from "path";
import { serveStatic } from "hono/bun";
import { env } from "@/infra/env";
import { errorHandler, notFoundHandler } from "@/middleware/error";
import healthRoute from "@/routes/health";
import chatRoute from "@/routes/chat";
import logRoute from "@/routes/log";   // [Sprint 5.1 / US-LOG-4]
import configRoute from "@/routes/config";   // [配置页 / US-CFG-PAGE-1]
import { openBrowser } from "@/infra/openBrowser";
import { originGuard } from "@/middleware/origin";
import { initDb, closeDb } from "@/infra/db";   // ← [US-4.1] 新增

// ============================================
// 创建应用实例
// ============================================
const app = new Hono();

// ============================================
// 全局中间件
// ============================================
app.onError(errorHandler);
app.notFound(notFoundHandler);
app.use("*", originGuard);

// ============================================
// API 路由
// ============================================
app.route("/api/health", healthRoute);
app.route("/api/chat", chatRoute);
app.route("/api/log", logRoute);         // [Sprint 5.1 / US-LOG-4]
app.route("/api/config", configRoute);   // [配置页 / US-CFG-PAGE-1]

// ============================================
// 静态文件服务（前端页面）
// 所有非 API 路径的请求都尝试从 public/ 目录返回文件
// ============================================
app.use("/*", serveStatic({ root: resolve(import.meta.dir, "../public") }));

// ============================================
// 优雅关闭
// 收到系统信号时，执行清理操作再退出
// ============================================
const gracefulShutdown = async (signal: string) => {
    console.log(`\n📢 收到 ${signal} 信号，正在优雅关闭...`);
    // [US-4.1] 关闭数据库：checkpoint 后 close，确保 WAL 数据落盘（N3）
    closeDb();
    console.log("✅ 服务已关闭，进程退出。");
    process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ============================================
// 启动服务器
// ============================================
const port = env.APP_PORT;

// [US-4.1] 初始化本地数据库（建表 + PRAGMA），保证首个请求前存储就绪
//   若数据目录不可写等问题，在此阶段快速失败，避免运行期才暴露。
initDb();

console.log("\n" + "=".repeat(60));
console.log("🚀 Bots 服务启动成功！");
console.log("=".repeat(60));
console.log(`   监听:      127.0.0.1:${port}（仅本机可访问）`);
console.log(`   地址:      http://localhost:${port}`);
console.log(`   健康检查:  http://localhost:${port}/api/health`);
console.log(`   对话接口:  http://localhost:${port}/api/chat/stream`);
console.log(`   聊天页面:  http://localhost:${port}/`);
console.log(`   状态监控:  http://localhost:${port}/?view=status`);   // [US-STATUS-VIEW-4] 内联视图入口
console.log("=".repeat(60) + "\n");

// 显式启动 HTTP 服务器（返回即代表已开始监听）
// [Sprint 5.2 / US-STAB-1-FIX] 关键修复：SSE 长连接空闲超时
//   Bun.serve 默认 idleTimeout=10s，而 SSE 心跳默认 15s（>10s），
//   导致连接在心跳到达前被 Bun 主动关闭（request timed out after 10 seconds），
//   随后 send() 抛 ERR_INVALID_STATE。此处提升至 Bun 上限 255s。
//   注意：只要有任意字节写出（含心跳注释帧）即重置空闲计时，
//   因此只要 SSE_HEARTBEAT_MS < idleTimeout*1000，连接即可长期保活。
const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: app.fetch,
    idleTimeout: 255,   // [Sprint 5.2 / US-STAB-1-FIX] 秒；Bun 允许的最大值
});

// 启动成功后，自动打开系统默认浏览器（仅触发一次，失败静默降级）
openBrowser(`http://localhost:${port}`);

// 保留默认导出，指向已启动的 server 实例，兼容既有引用方式
export default server;
