/**
 * GET /api/health
 * 
 * 检查 LLM 服务的健康状态
 * 调用 OpenAI 兼容接口的 GET /models 端点验证连通性
 * 
 * 成功响应 (200):
 * {
 *   "status": "ok",
 *   "uptime": 12345.67,
 *   "timestamp": "2024-01-01T00:00:00.000Z",
 *   "latency": 89,
 *   "services": {
 *     "llm": {
 *       "ok": true,
 *       "latency": 89,
 *       "model": "gpt-3.5-turbo",
 *       "api_base": "https://api.openai.com/v1"
 *     }
 *   }
 * }
 * 
 * 异常响应 (200, status: "degraded"):
 * {
 *   "status": "degraded",
 *   "uptime": 12345.67,
 *   "timestamp": "2024-01-01T00:00:00.000Z",
 *   "latency": 5000,
 *   "services": {
 *     "llm": {
 *       "ok": false,
 *       "latency": 5000,
 *       "model": "gpt-3.5-turbo",
 *       "api_base": "https://api.openai.com/v1",
 *       "error": "connect ECONNREFUSED"
 *     }
 *   }
 * }
 */
import { Hono } from "hono";
import { env } from "@/infra/env";

const router = new Hono();

/**
 * LLM 健康检查
 * 调用 OpenAI 兼容接口的 GET /models 端点
 * 检查配置的模型是否可用
 */
async function checkLLM(): Promise<{
    ok: boolean;
    latency: number;
    model: string;
    api_base: string;
    error?: string;
}> {
    const start = Date.now();
    try {
        const url = `${env.LLM_API_BASE.replace(/\/+$/, "")}/models`;

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${env.LLM_API_KEY}`,
            },
        });

        if (!response.ok) {
            return {
                ok: false,
                latency: Date.now() - start,
                model: env.LLM_MODEL,
                api_base: env.LLM_API_BASE,
                error: `HTTP ${response.status}: ${response.statusText}`,
            };
        }

        const data = (await response.json()) as { data?: Array<{ id: string }> };
        const modelAvailable = data.data?.some((m) => m.id === env.LLM_MODEL);

        return {
            ok: modelAvailable ?? true, // 如果无法判断模型列表，默认通过
            latency: Date.now() - start,
            model: env.LLM_MODEL,
            api_base: env.LLM_API_BASE,
            error:
                modelAvailable === false ? `模型 "${env.LLM_MODEL}" 不可用` : undefined,
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            latency: Date.now() - start,
            model: env.LLM_MODEL,
            api_base: env.LLM_API_BASE,
            error: message,
        };
    }
}

router.get("/", async (c) => {
    const start = Date.now();

    // 执行 LLM 健康检查
    const llmResult = await checkLLM();

    return c.json({
        status: llmResult.ok ? "ok" : "degraded",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        latency: Date.now() - start,
        services: {
            llm: llmResult,
        },
    });
});

export default router;