/**
 * src/agents/llmResolve.ts
 * agent 的 LLM 解析（模块 6a）。按 name 在 env.json 的 llm[] 中查表。
 *
 * ⚠️ 本文件**不 import 任何 @/infra/***。
 *    llm[] 由调用方注入（chat.ts 从 loadEnvJson() 取，单测直接传字面量）。
 *    理由与 binding.ts 同：agents/ 一旦在运行期依赖 infra，verify-agent-compat.ts
 *    载入 @/agents 就会连带执行 envJson 的模块级副作用（读文件 / 迁移 / 注册默认值），
 *    那会让第 1 步的等价基线脚本本身改变行为。
 *
 * ⚠️ 本文件只做「查表」，**不做**：
 *    · 不问「该名字是否合法」——合法性已在 setup.ts 的 unknown_llm 判过（F5）；
 *    · 不改 env 单例、不写文件、不缓存任何状态。
 *
 * ⚠️ [BR-2] **不再回退**：指名未命中一律返回 null，由调用方按「该 agent 失效」处理。
 *    只保留「名字为空 → 取第一组」这一条等价路径（BR-3：未绑定会话走默认组）。
 */
import type { LlmGroup } from "@/infra/envJson";

/**
 * [BR-6] LLM 组名的**比较口径**：ASCII 折叠（仅折叠 A-Z）+ trim。
 *
 * ⚠️ 与 `@/infra/envJson` 的 `foldLlmName()` **必须逐字同口径**。
 *    本文件不 import infra（见文件头注释），故在此保留一份等价实现；
 *    两处的单测都断言 `İ` / `main` / ` MAIN ` 的结果一致（V-12、V-14）。
 * ⚠️ 不用 `toLowerCase()`：它会做 Unicode 大小写映射。
 * ⚠️ 折叠**只用于比较**，绝不用于存储或回写。
 */
function foldName(s: string): string {
  return String(s ?? "").trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** 解析后的 LLM 连接参数（chat.ts 直接消费，字段名刻意与 env.LLM_* 一一对应）。 */
export interface ResolvedLlm {
  /** 命中的组名；未指定而取第一组时为 null（便于日志区分「真的命中」与「缺省」） */
  name: string | null;
  base: string;
  key: string;
  model: string;
  thinking: boolean;
  reasoningEffort: string;
  thinkingMode: string;
  /**
   * [BR-2] 恒为 false，保留仅为兼容既有消费方（chat.ts 的日志分支 / 单测）。
   * 删除判据 4 后本字段不再有任何赋值路径为 true —— 回退行为已彻底移除。
   */
  fallback: boolean;
}

/** llmRef 的缺省来源：env 里展平的那一组（即默认组）的名字约定。 */
export const DEFAULT_LLM_NAME = "main";

/**
 * 按 name 在 llm[] 中查表。
 *
 * 判据顺序（不可交换）：
 *   1. llm 为空                  → 返回 null（调用方决定怎么兜，本函数不抛）
 *   2. name 为空 / null / ""     → 取 groups[0]（等价路径：agent 没指定 → 默认组，BR-3）
 *   3. 找到同名项（大小写不敏感） → 用它（**同名取第一个**，见 D-7-3）
 *   4. 找不到                    → **返回 null**（BR-2：不回退，调用方判为失效）
 *
 * @param groups env.json 的 llm[]（调用方注入；必须非空才有意义）
 * @param name   agent 的 llmRef；null / "" = 未指定
 * @param warn   [已废弃] 原用于「未命中回退」告警。保留形参以避免改调用方签名，
 *               本函数**不再调用它**（回退路径已删除，无告警可言）。
 */
export function resolveLlm(
  groups: readonly LlmGroup[],
  name: string | null | undefined,
  _warn?: (msg: string) => void,
): ResolvedLlm | null {
  if (!Array.isArray(groups) || groups.length === 0) return null;

  // ⚠️ noUncheckedIndexedAccess=true（tsconfig）：groups[0] 的类型是 LlmGroup | undefined，
  //    上面已判 length===0，这里的 first 恒有值；用 ?? null 而不是 ! 断言，
  //    避免将来有人把 length 判据改掉后留下「静默 undefined」。
  const first = groups[0];
  if (!first) return null;

  const pick = (g: LlmGroup): ResolvedLlm => ({
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
    fallback: false,
  });

  // 判据 2：未指定 → 等价路径，直接取第一组（BR-3：未绑定会话走默认组）
  const want = (name ?? "").trim();
  if (want === "") return pick(first);

  // 判据 3：同名取第一个（find 天然如此）；比较口径 = BR-6 大小写不敏感
  const fold = foldName(want);
  const hit = groups.find((g) => foldName(g.name) === fold);
  if (hit) return pick(hit);

  // 判据 4【BR-2】：未命中 → 不再回退到第一组，返回 null 表示「该 agent 的 LLM 失效」。
  //   ⚠️ 这里**刻意不 warn**：失效的呈现由调用方（注册表 invalid / 请求拒绝）负责，
  //     本函数保持纯查表语义、不产生副作用（与其「不抛、不写」的既有约定一致）。
  return null;
}
