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
 * 
 * 注意：已去除 MySQL 和 Redis 模块
 */
import { Hono } from "hono";
import { resolve } from "path";
import { serveStatic } from "hono/bun";
import { env } from "@/infra/env";
import { errorHandler, notFoundHandler } from "@/middleware/error";
import healthRoute from "@/routes/health";
import chatRoute from "@/routes/chat";

// ============================================
// 创建应用实例
// ============================================
const app = new Hono();

// ============================================
// 全局中间件
// ============================================
app.onError(errorHandler);
app.notFound(notFoundHandler);

// ============================================
// API 路由
// ============================================
app.route("/api/health", healthRoute);
app.route("/api/chat", chatRoute);

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
    console.log("✅ 服务已关闭，进程退出。");
    process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ============================================
// 启动服务器
// ============================================
const port = env.APP_PORT;

console.log("\n" + "=".repeat(60));
console.log("🚀 Bots 服务启动成功！");
console.log("=".repeat(60));
console.log(`   地址:      http://localhost:${port}`);
console.log(`   健康检查:  http://localhost:${port}/api/health`);
console.log(`   对话接口:  http://localhost:${port}/api/chat/stream`);
console.log(`   聊天页面:  http://localhost:${port}/`);
console.log(`   状态监控:  http://localhost:${port}/status.html`);
console.log("=".repeat(60) + "\n");

export default {
    port,
    fetch: app.fetch,
};
