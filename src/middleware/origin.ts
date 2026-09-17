/**
 * Origin 来源校验中间件
 *
 * 职责：
 * 1. 对携带 Origin 头的请求进行白名单校验
 * 2. 仅放行本机来源（基于配置端口 APP_PORT 动态构造白名单）
 * 3. 无 Origin 头的请求放行（方案 A：网络层已限制本机，避免误伤命令行/同源导航）
 * 4. 其他来源一律拒绝（403）
 *
 * 说明：本中间件只做"来源校验"，不涉及认证、限流与 CORS 响应头配置。
 */
import type { Context, Next } from "hono";
import { env } from "@/infra/env";

/**
 * 允许的来源白名单（精确匹配，非正则）
 *
 * 基于配置端口 APP_PORT：
 * - 端口为 80：同时放行 http://localhost 与 http://localhost:80
 *   （浏览器访问 80 端口时 Origin 省略端口号，显式 :80 亦兼容）
 * - 其他端口：仅放行 http://localhost:<APP_PORT>
 */
const PORT = env.APP_PORT;
const ALLOWED_ORIGINS = new Set<string>(
    PORT === 80
        ? ["http://localhost", "http://localhost:80"]
        : [`http://localhost:${PORT}`]
);

export async function originGuard(c: Context, next: Next) {
    const origin = c.req.header("Origin");

    // 方案 A：无 Origin 头 → 放行
    if (!origin) {
        return next();
    }

    // 命中白名单 → 放行
    if (ALLOWED_ORIGINS.has(origin)) {
        return next();
    }

    // 其他来源 → 拒绝
    return c.json(
        {
            error: "Forbidden",
            message: `来源 ${origin} 不被允许，仅限本机访问`,
            timestamp: new Date().toISOString(),
        },
        403
    );
}
