/**
 * src/agents/__tests__/prompt.test.ts
 * 模块 3（system 三段式装配）单测：T-P1 ~ T-P9 + T-P8b + T-P10。
 *
 * ⚠️ 本套测试**只测纯函数**：不启动服务、不读磁盘、不建库。
 */
import { describe, expect, test } from "bun:test";
import { buildSystemText, fitSystemBudget } from "@/agents";
import { BUDGET_MAX, L2_MAX } from "@/skills";
import type { BuildSystemParts, PersonaPart } from "@/agents";

const P = (text: string): PersonaPart => ({ text });
const partsOf = (o: Partial<BuildSystemParts>): BuildSystemParts => ({
  persona: null,
  skillText: "",
  baseText: "",
  ...o,
});

describe("buildSystemText · 三段顺序（T-P1）", () => {
  test("齐全时严格按 人设 → 技能 → 基础 拼接", () => {
    const r = buildSystemText(partsOf({ persona: P("人设"), skillText: "技能", baseText: "基础" }));
    expect(r.systemText).toBe("人设\n\n技能\n\n基础");
    expect(r.parts).toEqual({ persona: true, skill: true, base: true });
  });
});

describe("buildSystemText · 空段不留分隔符（T-P2/T-P3/T-P4）", () => {
  test("persona=null：不以分隔符开头", () => {
    const r = buildSystemText(partsOf({ skillText: "技能", baseText: "基础" }));
    expect(r.systemText).toBe("技能\n\n基础");
    expect(r.systemText.startsWith("\n")).toBe(false);
    expect(r.parts.persona).toBe(false);
  });

  test("skillText=''：不产生连续空行", () => {
    const r = buildSystemText(partsOf({ persona: P("人设"), baseText: "基础" }));
    expect(r.systemText).toBe("人设\n\n基础");
    expect(r.systemText.includes("\n\n\n")).toBe(false);
    expect(r.parts.skill).toBe(false);
  });

  test("baseText=''：结尾不带分隔符", () => {
    const r = buildSystemText(partsOf({ persona: P("人设"), skillText: "技能" }));
    expect(r.systemText).toBe("人设\n\n技能");
    expect(r.systemText.endsWith("\n")).toBe(false);
    expect(r.parts.base).toBe(false);
  });
});

describe("buildSystemText · 全空（T-P5，A8 兼容门禁）", () => {
  test("三段全空 ⇒ 严格 ''（不是 '\\n\\n'，也不靠 trim 兜底）", () => {
    const r = buildSystemText(partsOf({}));
    expect(r.systemText).toBe("");
    expect(r.systemText.length).toBe(0);
    expect(r.parts).toEqual({ persona: false, skill: false, base: false });
    expect(r.totalChars).toBe(0);
  });

  test("persona 为空串（非 null）同样不注入", () => {
    const r = buildSystemText(partsOf({ persona: { text: "" } }));
    expect(r.systemText).toBe("");
    expect(r.parts.persona).toBe(false);
  });
});

describe("buildSystemText · 计数（T-P6）", () => {
  test("totalChars 只累计段正文，不含分隔符", () => {
    const r = buildSystemText(partsOf({ persona: P("AA"), skillText: "BBB", baseText: "C" }));
    // "AA"(2) + "BBB"(3) + "C"(1) = 6；分隔符共 4 个字符不计入
    expect(r.totalChars).toBe(6);
    expect(r.systemText.length).toBe(10);
  });
});

describe("fitSystemBudget · 预算（T-P7/T-P8）", () => {
  test("空输入原样返回，且不被标注污染", () => {
    const r = fitSystemBudget("");
    expect(r.systemText).toBe("");
    expect(r.truncated).toBe(false);
    expect(r.omitted).toEqual([]);
    expect(r.originalChars).toBe(0);
  });

  test("未超预算时逐字不变", () => {
    const text = "短文本";
    const r = fitSystemBudget(text);
    expect(r.systemText).toBe(text);
    expect(r.truncated).toBe(false);
  });

  test("远超预算 ⇒ 截断，含标注，omitted 非空", () => {
    // 单段无 "## " → 整段作为一个 Section，超 L2_MAX(3000) 被挡下
    const text = "x".repeat(BUDGET_MAX + 1000);
    const r = fitSystemBudget(text);
    expect(r.truncated).toBe(true);
    expect(r.omitted.length).toBeGreaterThan(0);
    expect(r.systemText).toContain("已截断");
    expect(r.originalChars).toBe(text.length);
    // ⚠️ 截断后不得等于原文（防「标注了但没裁」）
    expect(r.systemText).not.toBe(text);
  });

  test("多段超长 ⇒ 只丢尾部段落，前面的段仍在（T-P8b，R-5-1）", () => {
    // 3 个 "## " 段落，每段 ~2000 字，合计 > L2_MAX(3000)
    const per = 2000;
    expect(per * 3).toBeGreaterThan(L2_MAX);
    const sec = (n: number) => `## 段${n}\n` + "y".repeat(per);
    const text = [sec(1), sec(2), sec(3)].join("\n\n");
    const r = fitSystemBudget(text);
    expect(r.truncated).toBe(true);
    // ⚠️ 关键：第一段必须还在输出里。若整段丢弃，这里会红 —— 正是 R-5-1 的守卫。
    expect(r.systemText).toContain("## 段1");
    expect(r.omitted.length).toBeGreaterThan(0);
    // 末段应被丢弃（按段累加超限即停）
    expect(r.systemText).not.toContain("## 段3");
  });
});

describe("fitSystemBudget · 未超限时逐字节等价（T-P10，V9 主门禁的前提）", () => {
  test("真实形态的 systemText（含 ### 技能块与 ## 目标/使用时机）不超限时原样返回", () => {
    // 复刻 assembleForRequestMulti() 的拼接形态：
    //   L0 引导 + "### 技能：X（dir）" + "## 目标..." + "## 使用时机..." + "依赖工具：..."
    // 注意 "### 技能：" 是三个 #，splitSections 的 /^##[ \t]+/ 不会把它当段边界。
    const text = [
      "【可用技能】以下技能已开启，请按下列规则使用：\n① …\n② …\n- 打个招呼（hello）：寒暄用",
      [
        "### 技能：打个招呼（examples/hello）",
        "## 目标\n用一句话问候用户。",
        "## 使用时机\n打招呼时使用。",
        "依赖工具：无",
      ].join("\n\n"),
      [
        "### 技能：本地日志排查（examples/log_triage）",
        "## 目标\n从日志定位根因。",
        "## 使用时机\n用户贴出报错时。",
      ].join("\n\n"),
    ].join("\n\n");

    const r = fitSystemBudget(text);
    // ⚠️ 这是 V9 绿的前提：切段 + 拼回必须**逐字节**还原原文。
    expect(r.truncated).toBe(false);
    expect(r.systemText).toBe(text);
    expect(r.omitted).toEqual([]);
    expect(r.originalChars).toBe(text.length);
  });
});

describe("门面转发（T-P9）", () => {
  test("两个函数可从 @/agents 取到（类型由 tsc 保证）", () => {
    expect(typeof buildSystemText).toBe("function");
    expect(typeof fitSystemBudget).toBe("function");
  });
});
