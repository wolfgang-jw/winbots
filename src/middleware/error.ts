/**
 * 全局错误处理中间件
 * 
 * 职责：
 * 1. 捕获路由中未处理的异常（onError）
 * 2. 处理不存在的路由（notFound）
 * 3. 返回统一的 JSON 错误格式
 */
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * 全局异常处理
 * 所有路由中 throw 的错误都会被此函数捕获
 * 
 * 返回格式：
 * {
 *   error: "错误类型",
 *   message: "人类可读的错误描述",
 *   timestamp: "2024-01-01T00:00:00.000Z"
 * }
 */
export const errorHandler: ErrorHandler = (err: Error, c: Context) => {
    console.error("=".repeat(60));
    console.error("❌ 未捕获的错误:");
    console.error("  名称:", err.name);
    console.error("  消息:", err.message);
    console.error("  堆栈:", err.stack);
    console.error("=".repeat(60));

    // 处理 Hono 的 HTTPException（可携带状态码）
    if (err instanceof HTTPException) {
        return c.json(
            {
                error: err.name,
                message: err.message,
                status: err.status,
                timestamp: new Date().toISOString(),
            },
            err.status
        );
    }

    // 通用错误处理（500）
    return c.json(
        {
            error: "InternalServerError",
            message: err.message || "服务器内部错误",
            timestamp: new Date().toISOString(),
        },
        500
    );
};

/**
 * 404 路由处理
 * 当请求的路径不匹配任何路由时调用
 * 
 * 返回格式：
 * {
 *   error: "NotFound",
 *   message: "路径 /api/xxx 不存在",
 *   timestamp: "2024-01-01T00:00:00.000Z"
 * }
 */
export const notFoundHandler: NotFoundHandler = (c: Context) => {
    return c.json(
        {
            error: "NotFound",
            message: `路径 ${c.req.path} 不存在`,
            method: c.req.method,
            timestamp: new Date().toISOString(),
        },
        404
    );
};