/**
 * src/agents/__tests__/llmResolve.test.ts
 * 第 7 步（模块 6a：LLM 解析）单测 T-L1 ~ T-L12。
 *
 * ⚠️ 不要 import @/infra/env.ts —— 它有模块级副作用（读真实 env.json、可能 process.exit(1)）。
 *    T-L12 的「口径对表」用手写字面量断言，不引真文件。
 */
import { describe, test, expect } from "bun:test";
import { resolveLlm, DEFAULT_LLM_NAME, type ResolvedLlm } from "@/agents";
import type { LlmGroup } from "@/infra/envJson";

/** 一条基线组：7 个字段全给出（用于命中类断言）。 */
const g = (over: Partial<LlmGroup> = {}): LlmGroup => ({
    name: "main",
    base: "https://api.example.com",
    key: "sk-main",
    model: "model-main",
    thinking: false,
    reasoningEffort: "high",
    thinkingMode: "none",
    ...over,
});

const groups = (): LlmGroup[] => [
    g(),
    g({ name: "second", base: "https://b.example.com", key: "sk-b", model: "model-b" }),
];

/** 捕获告警的 warn 桩。 */
const spyWarn = () => {
    const calls: string[] = [];
    const fn = (m: string) => { calls.push(m); };
    return { calls, fn };
};

describe("resolveLlm / T-L1 命中", () => {
    test("llmRef 命中第二组时，六个连接字段全部来自该组", () => {
        const r = resolveLlm(groups(), "second");
        expect(r).not.toBeNull();
        expect(r!.name).toBe("second");
        expect(r!.base).toBe("https://b.example.com");
        expect(r!.key).toBe("sk-b");
        expect(r!.model).toBe("model-b");
        expect(r!.fallback).toBe(false);
    });
});

describe("resolveLlm / T-L2 ~ T-L3 等价路径", () => {
    test("T-L2：llmRef = null 取第一组且不告警", () => {
        const w = spyWarn();
        const r = resolveLlm(groups(), null, w.fn);
        expect(r!.name).toBe("main");
        expect(r!.base).toBe("https://api.example.com");
        expect(r!.fallback).toBe(false);
        expect(w.calls).toHaveLength(0);
    });

    test("T-L3：llmRef = '' / 全空白 等同未指定", () => {
        for (const v of ["", "   ", "\t\n"]) {
            const w = spyWarn();
            const r = resolveLlm(groups(), v, w.fn);
            expect(r!.name).toBe("main");
            expect(r!.fallback).toBe(false);
            expect(w.calls).toHaveLength(0);
        }
    });
});

describe("resolveLlm / T-L4 未命中【BR-2：不再回退】", () => {
    test("返回 null（不回退到第一组、不告警）", () => {
        const w = spyWarn();
        const r = resolveLlm(groups(), "nope", w.fn);
        expect(r).toBeNull();
        expect(w.calls).toHaveLength(0);
    });
});

describe("resolveLlm / T-L5 重名取第一个", () => {
    test("两个同名组时取先出现的（与 env.ts 的 llm[0] 口径一致）", () => {
        const w = spyWarn();
        const dup: LlmGroup[] = [
            g({ name: "dup", base: "https://a" }),
            g({ name: "dup", base: "https://b" }),
        ];
        const r = resolveLlm(dup, "dup", w.fn);
        expect(r!.base).toBe("https://a");
        expect(r!.fallback).toBe(false);
        expect(w.calls).toHaveLength(0);
    });
});

describe("resolveLlm / T-L6 llm[] 为空", () => {
    test("返回 null 且不抛", () => {
        expect(resolveLlm([], "main")).toBeNull();
        expect(resolveLlm([], null)).toBeNull();
    });
});

describe("resolveLlm / T-L7 ~ T-L8 可选字段缺省与透传", () => {
    test("T-L7：三个可选字段缺省 → thinking=false / effort=high / mode=''", () => {
        const bare: LlmGroup = { name: "m", base: "b", key: "k", model: "mo" };
        const r = resolveLlm([bare], null);
        expect(r!.thinking).toBe(false);
        expect(r!.reasoningEffort).toBe("high");
        // 刻意留空，缺省由调用方用 env.LLM_THINKING_MODE 兜（缺省值单一来源）
        expect(r!.thinkingMode).toBe("");
    });

    test("T-L8：显式给出时原样透传", () => {
        const full = g({ thinking: true, reasoningEffort: "low", thinkingMode: "both" });
        const r = resolveLlm([full], null);
        expect(r!.thinking).toBe(true);
        expect(r!.reasoningEffort).toBe("low");
        expect(r!.thinkingMode).toBe("both");
    });
});

describe("resolveLlm / T-L9 名字前后空格", () => {
    test("trim 后匹配", () => {
        const r = resolveLlm(groups(), " second ");
        expect(r!.name).toBe("second");
        expect(r!.fallback).toBe(false);
    });
});

describe("resolveLlm / T-L10 首组无名字时【BR-2：未命中即 null】", () => {
    test("第一组 name 为 undefined 时，未命中返回 null，不抛不告警", () => {
        const w = spyWarn();
        const noName: LlmGroup = { name: undefined as unknown as string, base: "b", key: "k", model: "m" };
        const r = resolveLlm([noName], "missing", w.fn);
        expect(r).toBeNull();
        expect(w.calls).toHaveLength(0);
    });
});

describe("resolveLlm / T-L13 [BR-6] 名字大小写不敏感", () => {
    test("组名 main，llmRef 写 MAIN / Main / ' main ' 均命中 main", () => {
        for (const v of ["MAIN", "Main", " main ", "mAiN"]) {
            const r = resolveLlm(groups(), v);
            expect(r).not.toBeNull();
            expect(r!.name).toBe("main");
            expect(r!.fallback).toBe(false);
        }
    });

    test("组名本身是大写时，小写 llmRef 也能命中", () => {
        const up = [g({ name: "Main", base: "https://up" })];
        const r = resolveLlm(up, "main");
        expect(r!.name).toBe("Main");
        expect(r!.base).toBe("https://up");
    });

    test("折叠只折叠 A-Z：İ 不会被折成 i", () => {
        const odd: LlmGroup[] = [g({ name: "İd", base: "https://dot" })];
        expect(resolveLlm(odd, "id")).toBeNull();
        // 原文仍可精确命中
        expect(resolveLlm(odd, "İd")!.base).toBe("https://dot");
    });
});

describe("resolveLlm / T-L11 命中路径不误报告警", () => {
    test("命中与等价路径均不调用 warn", () => {
        const w = spyWarn();
        resolveLlm(groups(), null, w.fn);
        resolveLlm(groups(), "main", w.fn);
        resolveLlm(groups(), "second", w.fn);
        expect(w.calls).toHaveLength(0);
    });
});

describe("resolveLlm / T-L12 与 env.ts 口径对表", () => {
    test("unbound 时（name=null）六个字段与 env.ts 展平 llm[0] 的取法逐一相等", () => {
        // 手工模拟 env.ts 的 toEnvConfig 对 llm[0] 的取法：
        //   base/key/model 直取；thinking === true；reasoningEffort || "high"；
        //   thinkingMode 原样（env 层缺省由 DEFAULT_THINKING_MODE 兜，这里刻意不参与）
        const first = g({
            name: DEFAULT_LLM_NAME,
            base: "https://api.deepseek.com",
            key: "sk-x",
            model: "deepseek-chat",
            thinking: true,
            reasoningEffort: "high",
            thinkingMode: "both",
        });
        const r = resolveLlm([first], null) as ResolvedLlm;

        expect(r.base).toBe(first.base);
        expect(r.key).toBe(first.key);
        expect(r.model).toBe(first.model);
        expect(r.thinking).toBe(first.thinking === true);
        expect(r.reasoningEffort).toBe(first.reasoningEffort || "high");
        expect(r.thinkingMode).toBe(first.thinkingMode ?? "");
    });

    test("缺省口径：reasoningEffort 与 thinkingMode 的兜底与 env.ts 一致", () => {
        const bare: LlmGroup = { name: "main", base: "b", key: "k", model: "m" };
        const r = resolveLlm([bare], null) as ResolvedLlm;
        // env.ts 用 || "high"
        expect(r.reasoningEffort).toBe(bare.reasoningEffort || "high");
        // env.ts 对 thinkingMode 用 ?? DEFAULT（此处留空，由 chat.ts 兜）
        expect(r.thinkingMode).toBe(bare.thinkingMode ?? "");
    });
});
