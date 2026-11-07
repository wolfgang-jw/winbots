/**
 * src/skills/__tests__/assemble-multi.test.ts
 * 多技能装配单测（升级版 §4.4 / §9.2）。
 *
 * 覆盖：空注册表 → systemText === ""；单技能 → 含 L1 正文；
 *      无 tools 技能 → **无**依赖工具行；未开启 → 不装配且不提示；
 *      挂起 / 必须工具不可用 → 不进 L0 且 notices 有说明；
 *      两技能 → L0 两行、技能块按名排序；同名歧义 → L0 用完整目录路径。
 *
 * ⚠️ 用 AssembleDeps 注入假注册表，不碰真实扫描、不读 .env。
 *    「必须工具可用性」走**真实** checkRequiredTools：所以那条用例故意用一个
 *    不存在的工具名（local.nope.run），断言它被判为不可用。
 */
import { describe, expect, test } from "bun:test";
import { assembleForRequestMulti, type AssembleDeps } from "../assemble";
import type { SkillRecord, SkillRegistry } from "../scan";

/** 造一条最小可用的技能记录（只填装配关心的字段） */
function rec(partial: Partial<SkillRecord> & { dir: string; name: string }): SkillRecord {
  return {
    depth: partial.dir.split("/").length,
    toggleKey: `SKILLON__${partial.dir.replace(/\//g, "__")}`,
    title: partial.name,
    summary: `摘要-${partial.name}`,
    tools: [],
    settings: new Map(),
    sections: [
      { heading: "目标", text: `## 目标\n做 ${partial.name} 这件事。` },
      { heading: "方法", text: `## 方法\n1. 按步骤执行 ${partial.name}。` },
    ],
    status: "ok",
    suspend: null,
    extraFiles: [],
    ...partial,
  };
}

/** 全部开关打开、注册表为给定技能集的 deps */
function deps(skills: SkillRecord[], on: (key: string) => boolean = () => true): AssembleDeps {
  const reg: SkillRegistry = {
    fingerprint: "test",
    version: "sv_test",
    scannedAt: Date.now(),
    dirs: new Map(),
    skills: new Map(skills.map((r) => [r.dir, r])),
    existingDirs: new Set(skills.map((r) => r.dir)),
    warnings: [],
    failed: false,
  };
  return { isToggleOn: (k) => on(k), getRegistry: () => reg };
}

describe("assembleForRequestMulti", () => {
  test("空注册表 → systemText 为空串、无 notice", () => {
    const a = assembleForRequestMulti(deps([]));
    expect(a.systemText).toBe("");
    expect(a.notices).toEqual([]);
    expect(a.skillNames).toEqual([]);
  });

  test("单技能（无 tools）→ 含 L1 正文，且**没有**「依赖工具」行", () => {
    const a = assembleForRequestMulti(deps([rec({ dir: "examples/hello", name: "hello" })]));
    expect(a.skillNames).toEqual(["hello"]);
    expect(a.systemText).toContain("做 hello 这件事。");
    expect(a.systemText).not.toContain("依赖工具：");
    // L2 不进 system（由元工具按需取）
    expect(a.systemText).not.toContain("按步骤执行 hello");
  });

  test("L0 引导是新版三句（带元工具提示），不是旧的「按名称显式激活」", () => {
    const a = assembleForRequestMulti(deps([rec({ dir: "examples/hello", name: "hello" })]));
    expect(a.systemText).toContain("skill__get_l2");
    expect(a.systemText).not.toContain("按名称显式激活");
  });

  test("未开启的技能不参与装配，且**不发 notice**（用户本来就没开）", () => {
    const r = rec({ dir: "examples/hello", name: "hello" });
    const a = assembleForRequestMulti(deps([r], () => false));
    expect(a.skillNames).toEqual([]);
    expect(a.systemText).toBe("");
    expect(a.notices).toEqual([]);
  });

  test("挂起技能：已开启 → 不进 L0，且 notices 有 1 条", () => {
    const r = rec({
      dir: "examples/broken",
      name: "broken",
      status: "suspended",
      suspend: { code: "missing_section", reason: "缺 ## 方法", hint: "补上" },
    });
    const a = assembleForRequestMulti(deps([r]));
    expect(a.skillNames).toEqual([]);
    expect(a.notices.length).toBe(1);
    expect(a.notices[0]).toContain("已挂起");
  });

  test("两技能 → L0 两行且按名字字典序；技能块同样有序", () => {
    const a = assembleForRequestMulti(
      deps([
        rec({ dir: "examples/zzz", name: "zzz" }),
        rec({ dir: "examples/aaa", name: "aaa" }),
      ]),
    );
    expect(a.skillNames).toEqual(["aaa", "zzz"]);
    expect(a.l0.map((s) => s.name)).toEqual(["aaa", "zzz"]);
    expect(a.systemText.indexOf("### 技能：aaa")).toBeLessThan(a.systemText.indexOf("### 技能：zzz"));
  });

  test("同名歧义 → L0 改用完整目录路径（否则调元工具会 ambiguous_skill）", () => {
    const a = assembleForRequestMulti(
      deps([rec({ dir: "a/dup", name: "dup" }), rec({ dir: "b/dup", name: "dup" })]),
    );
    expect(a.l0.map((s) => s.name)).toEqual(["a/dup", "b/dup"]);
  });

  test("必须工具不可用的技能不进 L0，且 notice 说明缺哪个工具", () => {
    // 用一个不存在的工具名，让真实 checkRequiredTools 判为 not_registered
    const r = rec({ dir: "examples/need", name: "need", tools: ["local.nope.run"] });
    const a = assembleForRequestMulti(deps([r]));
    expect(a.skillNames).toEqual([]);
    expect(a.l0.length).toBe(0);
    expect(a.notices.length).toBe(1);
    expect(a.notices[0]).toContain("local.nope.run");
    expect(a.notices[0]).toContain("必须工具不可用");
  });
});
