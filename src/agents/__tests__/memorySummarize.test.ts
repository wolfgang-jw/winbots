/**
 * src/agents/__tests__/memorySummarize.test.ts
 * 第 8 步 · 模块 6b 的纯逻辑单测（T-P1 ~ T-P8）。
 *
 * ⚠️ 本文件**不建库、不发网络请求**：只测提示词拼装与输出解析。
 *    LLM 调用（callSummarizeLlm）的 HTTP 行为靠集成手测，不在此处 mock fetch
 *    （mock 全局 fetch 会污染其它测试文件，bun test 同进程运行）。
 */
import { describe, expect, test } from "bun:test";

import {
    buildSummarizePrompt,
    parseSummarizeOutput,
} from "@/agents/memorySummarize";

describe("提示词拼装（T-P1 ~ T-P4）", () => {
    test("T-P1 含 system + user 两条，且 user 里带已有事实与新增对话", () => {
        const msgs = buildSummarizePrompt({
            previousFacts: "- 用户喜欢深色主题",
            messages: [
                { seq: 1, role: "user", content: "我住在杭州" },
                { seq: 2, role: "assistant", content: "好的" },
            ],
        });
        expect(msgs.length).toBe(2);
        expect(msgs[0]!.role).toBe("system");
        expect(msgs[1]!.role).toBe("user");
        expect(msgs[1]!.content).toContain("- 用户喜欢深色主题");
        expect(msgs[1]!.content).toContain("[#1 user] 我住在杭州");
        expect(msgs[1]!.content).toContain("[#2 assistant] 好的");
    });

    test("T-P2 无已有事实时显示「（无）」，不出现 undefined / null", () => {
        const msgs = buildSummarizePrompt({
            previousFacts: null,
            messages: [{ seq: 1, role: "user", content: "hi" }],
        });
        expect(msgs[1]!.content).toContain("（无）");
        expect(msgs[1]!.content).not.toContain("undefined");
        expect(msgs[1]!.content).not.toContain("null");
    });

    test("T-P3 超长单条消息被截断并标注", () => {
        const long = "x".repeat(500);
        const msgs = buildSummarizePrompt({
            previousFacts: null,
            messages: [{ seq: 7, role: "user", content: long }],
            perMessageMaxChars: 100,
        });
        expect(msgs[1]!.content).toContain("…（已截断）");
        // 截断后不应出现 500 个 x
        expect(msgs[1]!.content.length).toBeLessThan(500);
    });

    test("T-P4 content 为 null 时不产出字面量 null", () => {
        const msgs = buildSummarizePrompt({
            previousFacts: null,
            messages: [{ seq: 3, role: "assistant", content: null }],
        });
        expect(msgs[1]!.content).toContain("[#3 assistant]");
        expect(msgs[1]!.content).not.toContain("null");
    });
});

describe("输出解析（T-P5 ~ T-P8）", () => {
    test("T-P5 NONE 视为无事实", () => {
        expect(parseSummarizeOutput("NONE")).toBeNull();
        expect(parseSummarizeOutput("none")).toBeNull();
        expect(parseSummarizeOutput("  NONE  ")).toBeNull();
    });

    test("T-P6 空串 / null / undefined 视为无事实", () => {
        expect(parseSummarizeOutput("")).toBeNull();
        expect(parseSummarizeOutput("   ")).toBeNull();
        expect(parseSummarizeOutput(null)).toBeNull();
        expect(parseSummarizeOutput(undefined)).toBeNull();
    });

    test("T-P7 代码围栏被剥离，内容原样保留", () => {
        const raw = "```markdown\n- 用户是后端工程师\n- 喜欢 Rust\n```";
        const out = parseSummarizeOutput(raw);
        expect(out).toBe("- 用户是后端工程师\n- 喜欢 Rust");
        expect(out).not.toContain("```");
    });

    test("T-P8 超长输出被截断并标注", () => {
        const long = "- 事实条目\n".repeat(500);
        const out = parseSummarizeOutput(long, 100);
        expect(out).not.toBeNull();
        expect(out!.length).toBeLessThan(long.length);
        expect(out).toContain("…（已截断）");
    });
});
