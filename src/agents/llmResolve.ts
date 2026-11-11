/**
 * src/agents/llmResolve.ts
 * agent 的 LLM 解析（模块 6a）。按 name 在 env.json 的 llm[] 中查表，未命中回退。
 *
 * ⚠️ 本文件**不 import 任何 @/infra/***。
 *    llm[] 由调用方注入（chat.ts 从 loadEnvJson() 取，单测直接传字面量）。
 *    理由与 binding.ts 同：agents/ 一旦在运行期依赖 infra，verify-agent-compat.ts
 *    载入 @/agents 就会连带执行 envJson 的模块级副作用（读文件 / 迁移 / 注册默认值），
 *    那会让第 1 步的等价基线脚本本身改变行为。
 *
 * ⚠️ 本文件只做「查表 + 回退」，**不做**：
 *    · 不问「该名字是否合法」——合法性已在 setup.ts 的 unknown_llm 判过（F5）；
 *    · 不改 env 单例、不写文件、不缓存任何状态。
 */
import type { LlmGroup } from "@/infra/envJson";

/** 解析后的 LLM 连接参数（chat.ts 直接消费，字段名刻意与 env.LLM_* 一一对应）。 */
export interface ResolvedLlm {
  /** 命中的组名；回退时为 null（便于日志区分「真的命中」与「回退」） */
  name: string | null;
  base: string;
  key: string;
  model: string;
  thinking: boolean;
  reasoningEffort: string;
  thinkingMode: string;
  /** 是否发生了回退（未命中时 true） */
  fallback: boolean;
}

/** llmRef 的缺省来源：env 里展平的那一组（即 llm[0]）的名字约定。 */
export const DEFAULT_LLM_NAME = "main";

/**
 * 按 name 在 llm[] 中查表。
 *
 * 判据顺序（不可交换）：
 *   1. llm 为空                     → 返回 null（调用方决定怎么兜，本函数不抛）
 *   2. name 为空 / null / ""        → 取 groups[0]（等价路径：agent 没指定）
 *   3. 找到同名项                   → 用它（**同名取第一个**，见 D-7-3）
 *   4. 找不到                       → 取 groups[0] 且 fallback = true
 *
 * @param groups env.json 的 llm[]（调用方注入；必须非空才有意义）
 * @param name   agent 的 llmRef；null / "" = 未指定
 * @param warn   告警回调（默认 console.warn）；单测注入以捕获文案
 */
export function resolveLlm(
  groups: readonly LlmGroup[],
  name: string | null | undefined,
  warn: (msg: string) => void = (m) => console.warn(m),
): ResolvedLlm | null {
  if (!Array.isArray(groups) || groups.length === 0) return null;

  // ⚠️ noUncheckedIndexedAccess=true（tsconfig）：groups[0] 的类型是 LlmGroup | undefined，
  //    上面已判 length===0，这里的 first 恒有值；用 ?? null 而不是 ! 断言，
  //    避免将来有人把 length 判据改掉后留下「静默 undefined」。
  const first = groups[0];
  if (!first) return null;

  const pick = (g: LlmGroup, fallback: boolean): ResolvedLlm => ({
    name: g.name ?? null,
    base: g.base,
    key: g.key,
    model: g.model,
    thinking: g.thinking === true,
    // 与 env.ts 的 toEnvConfig 保持同一口径：缺省 "high"
    reasoningEffort: g.reasoningEffort || "high",
    /**
     * ⚠️ 缺省写 ""（而不是 "none"）——缺省值只在 env.ts 存一份。
     *    原样透传 setup.json / env.json 里的值，env 层的缺省由调用方（chat.ts）兜。
     *    若在此写死 "none"，将来 env.ts 的 DEFAULT_THINKING_MODE 改动时这里不会跟着变，
     *    agent 路径与 env.LLM_* 路径会悄悄分叉（env.ts 头注释明令禁止双源）。
     */
    thinkingMode: g.thinkingMode ?? "",
    fallback,
  });

  // 判据 2：未指定 → 等价路径，直接取第一组（与 env.LLM_* 完全一致）
  const want = (name ?? "").trim();
  if (want === "") return pick(first, false);

  // 判据 3：同名取第一个（find 天然如此；与 env.ts 的 llm[0] 语义对齐）
  const hit = groups.find((g) => g.name === want);
  if (hit) return pick(hit, false);

  // 判据 4：未命中 → 回退到第一组，且必须告警（不静默）
  warn(
    `⚠️  [llm] agent 指定的 llm「${want}」未在 env.json 的 llm[] 中找到，` +
    `本轮回退为「${first.name ?? "(未命名)"}」`,
  );
  return pick(first, true);
}
