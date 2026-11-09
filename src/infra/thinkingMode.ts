/**
 * src/infra/thinkingMode.ts
 * 「思考字段下发方式」的常量与纯函数（从 src/infra/env.ts 原样搬出）。
 *
 * ⚠️ 为什么单独成文件（迁移文档 4.1.1 / 4.3.1）：
 *    定义迁移后，`envJson.ts` 需要 `parseThinkingMode`，而 `env.ts` 又要 import `envJson.ts`；
 *    若这些定义还留在 `env.ts` 里，就会形成 `envJson ⇄ env` 的环依赖，
 *    Bun 直跑时报「Cannot access before initialization」。
 *    本文件**零依赖**（不 import 任何业务模块），由 `env.ts` 转发（`export * from "./thinkingMode"`），
 *    对外导出面与迁移前完全一致，调用方一行不用改。
 */

/**
 * [需求域 C / C-04] 思考相关字段的下发方式。
 * 取值固定为四值枚举，不得用单一布尔表达「只发开关 / 只发强度」两种语义。
 */
export type ThinkingMode = "none" | "effort" | "thinking" | "both";

/** 合法取值（顺序即配置页下拉顺序） */
export const THINKING_MODES: readonly ThinkingMode[] = ["none", "effort", "thinking", "both"];

/** 默认值：均不下发（C-05：接入非 DeepSeek 的 OpenAI 兼容服务商时不因未知字段被拒） */
export const DEFAULT_THINKING_MODE: ThinkingMode = "none";

/**
 * [需求域 C / C-04、C-07] 解析「思考字段下发方式」。
 * 缺失 / 非法 / 大小写不符一律回退默认值 none：
 * §9.1 约束——新增配置项不得加入必填校验，缺失时回退默认值而非退出进程。
 */
export function parseThinkingMode(raw: string | undefined): ThinkingMode {
  const v = (raw ?? "").trim().toLowerCase();
  return (THINKING_MODES as readonly string[]).includes(v)
    ? (v as ThinkingMode)
    : DEFAULT_THINKING_MODE;
}

/** 各取值的中文说明（启动日志与配置页描述共用同一措辞，C-07 一致性） */
export const THINKING_MODE_LABEL: Record<ThinkingMode, string> = {
  none: "均不下发",
  effort: "仅下发推理强度",
  thinking: "仅下发思考开关",
  both: "两者都下发",
};
