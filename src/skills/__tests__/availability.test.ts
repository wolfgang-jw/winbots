/**
 * src/skills/__tests__/availability.test.ts
 * 可用性判定单测（升级版 §3.4）。
 *
 * ⚠️ 这里只测**纯判定**与「空入参恒可用」这条不可动摇的约束。
 *    需要真实 etc/tools 状态的用例（组开关关 / 组挂起 / permission=forbid）
 *    属端到端，见文档 §9.3 用例 3 / 3b：改 .env 后点「🔄 刷新」，观察 L0 与 notice。
 */
import { describe, expect, test } from "bun:test";
import { checkRequiredTools } from "../availability";

describe("checkRequiredTools", () => {
  test("空清单 = 不依赖任何工具 → 恒可用", () => {
    expect(checkRequiredTools([])).toEqual([]);
  });

  test("名字不存在 → not_registered，且提示可能是名字写错", () => {
    const out = checkRequiredTools(["local.nope.run"]);
    expect(out.length).toBe(1);
    const first = out[0] as { call: string; kind: string; detail: string };
    expect(first.call).toBe("local.nope.run");
    expect(first.kind).toBe("not_registered");
    expect(first.detail).toContain("不在工具注册表中");
  });

  test("返回的 kind 只在允许集合内（不出现拼写漂移）", () => {
    const allowed = new Set(["not_registered", "group_off", "suspended", "self_disabled"]);
    for (const u of checkRequiredTools(["local.nope.run"])) {
      expect(allowed.has(u.kind)).toBe(true);
    }
  });

  test("多个必须工具：逐个判定，互不影响", () => {
    const out = checkRequiredTools(["local.nope.one", "local.nope.two"]);
    expect(out.length).toBe(2);
  });
});
