/**
 * src/agents/__tests__/setup.test.ts
 * S1–S10：setup.json 解析与字段校验（纯函数，不碰磁盘）。
 */
import { describe, expect, test } from "bun:test";
import { parseAgentSetup } from "../setup";
import type { ParseSetupOpts } from "../setup";

const KNOWN = (n: string): boolean => n === "main";

function opts(over: Partial<ParseSetupOpts> = {}): ParseSetupOpts {
  return { path: "devops", isKnownLlm: KNOWN, mintUid: null, ...over };
}

describe("parseAgentSetup", () => {
  test("S1 完整合法 setup 字段逐个对上", () => {
    const raw = JSON.stringify({
      uid: "ag_00000001",
      name: "devops",
      title: "运维",
      description: "运维助手",
      llm: "main",
      skills: { mode: "allow", list: ["examples/hello"] },
      tools: { allow: ["local__fileRead__*"], deny: ["local__fileModify__delete_path"] },
      limits: { maxRounds: 12 },
      memory: { enabled: false },
      systemBudget: 8000,
    });
    const r = parseAgentSetup(raw, opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.uid).toBe("ag_00000001");
    expect(r.data.name).toBe("devops");
    expect(r.data.title).toBe("运维");
    expect(r.data.llmRef).toBe("main");
    expect(r.data.skillsMode).toBe("allow");
    expect(r.data.skillsAllow).toEqual(["examples/hello"]);
    expect(r.data.toolsAllow).toEqual(["local__fileRead__*"]);
    expect(r.data.toolsDeny).toEqual(["local__fileModify__delete_path"]);
    expect(r.data.maxRounds).toBe(12);
    expect(r.data.memoryEnabled).toBe(false);
    expect(r.data.systemBudget).toBe(8000);
  });

  test("S2 坏 JSON → parse_failed", () => {
    const r = parseAgentSetup('{ "name": ', opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("parse_failed");
  });

  test("S3 顶层是数组 → invalid_setup", () => {
    const r = parseAgentSetup("[1,2]", opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_setup");
  });

  test("S4 缺 name → invalid_setup，原因含 name", () => {
    const r = parseAgentSetup(JSON.stringify({ uid: "ag_00000001" }), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_setup");
    expect(r.reason).toContain("name");
  });

  test("S5 name ≠ 叶子名 → name_mismatch", () => {
    const r = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "ops" }),
      opts({ path: "devops" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("name_mismatch");
  });

  test("S6 llm 不在合法集合 → unknown_llm，原因含 gpt5", () => {
    const r = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops", llm: "gpt5" }),
      opts(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unknown_llm");
    expect(r.reason).toContain("gpt5");
  });

  test("S7 缺 uid 且 mintUid=null → invalid_setup", () => {
    const r = parseAgentSetup(JSON.stringify({ name: "devops", llm: "main" }), opts({ mintUid: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_setup");
    expect(r.reason).toContain("uid");
  });

  test("S8 缺 uid 且 mintUid 有值 → ok 且 uid 已写入", () => {
    const r = parseAgentSetup(
      JSON.stringify({ name: "devops", llm: "main" }),
      opts({ mintUid: "ag_00000001" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.uid).toBe("ag_00000001");
  });

  test("S9 maxRounds 钳制到 1–32", () => {
    const hi = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops", llm: "main", limits: { maxRounds: 999 } }),
      opts(),
    );
    expect(hi.ok).toBe(true);
    if (hi.ok) expect(hi.data.maxRounds).toBe(32);

    const lo = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops", llm: "main", limits: { maxRounds: 0 } }),
      opts(),
    );
    expect(lo.ok).toBe(true);
    if (lo.ok) expect(lo.data.maxRounds).toBe(1);
  });

  test("S10 systemBudget<=0 报错；memory 缺省为 true", () => {
    const bad = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops", llm: "main", systemBudget: 0 }),
      opts(),
    );
    expect(bad.ok).toBe(false);

    const ok = parseAgentSetup(JSON.stringify({ uid: "ag_00000001", name: "devops", llm: "main" }), opts());
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.memoryEnabled).toBe(true);
      expect(ok.data.systemBudget).toBe(9000);
      expect(ok.data.skillsAllow).toBeNull();
      expect(ok.data.toolsAllow).toBeNull();
      expect(ok.data.toolsDeny).toEqual([]);
      expect(ok.data.maxRounds).toBeNull();
    }
  });

  test("补充：uid 格式非法 → invalid_setup；BOM 可解析", () => {
    const badUid = parseAgentSetup(
      JSON.stringify({ uid: "AG_00000001", name: "devops", llm: "main" }),
      opts(),
    );
    expect(badUid.ok).toBe(false);

    const bom = parseAgentSetup(
      "\uFEFF" + JSON.stringify({ uid: "ag_00000001", name: "devops", llm: "main" }),
      opts(),
    );
    expect(bom.ok).toBe(true);
  });

  test("补充：skills.mode 非法 / 数组里混非字符串 → invalid_setup", () => {
    const badMode = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops", skills: { mode: "none" } }),
      opts(),
    );
    expect(badMode.ok).toBe(false);

    const badList = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops", skills: { list: [1] } }),
      opts(),
    );
    expect(badList.ok).toBe(false);
  });

  test("补充：多层路径的 name 必须等于叶子名", () => {
    const r = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops", llm: "main" }),
      opts({ path: "ops/devops" }),
    );
    expect(r.ok).toBe(true);
  });

  /* [BR-1] llm 由「可选」改为「必填」—— 以下 4 条守住新语义 */
  test("S11 缺 llm → invalid_setup，原因含 llm（BR-1）", () => {
    const r = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops" }),
      opts(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_setup");
    expect(r.reason).toContain("llm");
  });

  test("S12 llm 为 null / 空串 / 非字符串 → invalid_setup（BR-1）", () => {
    for (const v of [null, "", "   ", 42, {}, []]) {
      const r = parseAgentSetup(
        JSON.stringify({ uid: "ag_00000001", name: "devops", llm: v }),
        opts(),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_setup");
    }
  });

  test("S13 llm 大小写不敏感由注入方决定：MAIN 在 KNOWN 折叠后可通过（BR-6）", () => {
    const foldKnown = (n: string): boolean => n.trim().toLowerCase() === "main";
    const r = parseAgentSetup(
      JSON.stringify({ uid: "ag_00000001", name: "devops", llm: "MAIN" }),
      opts({ isKnownLlm: foldKnown }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.llmRef).toBe("MAIN");   // 保留原大小写，不折叠存储
  });
});
