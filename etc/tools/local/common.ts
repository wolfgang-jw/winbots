/**
 * etc/tools/local/common.ts
 * 通用本机工具集（单文件多工具）
 *
 * 契约：每个工具文件必须默认或具名导出 tools: Tool[]
 * 调用路径由「相对 etc/tools/ 的目录路径 + 工具 name」生成，
 * 本文件工具调用路径为：local.common.get_current_time
 */
import type { Tool } from "@/tools";

export const tools: Tool[] = [
    {
        name: "get_current_time",
        description: "获取当前日期与时间。当用户询问现在几点、今天日期等实时时间信息时调用。",
        // 本期无参数（R1.2.1）
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
        handler: async () => {
            const now = new Date();
            // 使用服务器本地时区，返回人类可读 + 结构化信息
            return {
                iso: now.toISOString(),
                local: now.toLocaleString("zh-CN", { hour12: false }),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            };
        },
    },
];
