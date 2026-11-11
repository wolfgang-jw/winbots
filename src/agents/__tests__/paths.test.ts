/**
 * src/agents/__tests__/paths.test.ts
 * P1–P8：名字 / 路径 / uid 规则。
 *
 * 其中 P1（default 合法）与 P2（连字符合法）是【X-2 / X-1】的**回归门禁**：
 * 它们守的是「不复用 tools/paths.ts 的 checkName」这个决定。
 * 若日后有人「顺手统一」成 checkName，这两条会立刻报红。
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_UID_RE, agentDepth, agentLeafName, checkAgentName, checkAgentPath,
  generateAgentUid, isAgentUid, isDefaultAgentPath, MAX_AGENT_DEPTH,
} from "../paths";

describe("checkAgentName", () => {
  test("P1 default 是合法名（X-2 回归：不照抄 checkName）", () => {
    expect(checkAgentName("default").ok).toBe(true);
  });

  test("P2 连字符合法（X-1 回归：不照抄 NAME_RE）", () => {
    expect(checkAgentName("my-agent").ok).toBe(true);
    expect(checkAgentName("ops-1").ok).toBe(true);
  });

  test("P3 其余保留名仍生效", () => {
    expect(checkAgentName("enabled").ok).toBe(false);
    expect(checkAgentName("off").ok).toBe(false);
    expect(checkAgentName("toString").ok).toBe(false);
    expect(checkAgentName("skills").ok).toBe(false);
  });

  test("P4 连续双下划线非法", () => {
    expect(checkAgentName("a__b").ok).toBe(false);
  });

  test("补充：首字符数字 / 空串 / 末尾连字符或下划线 / 超长", () => {
    expect(checkAgentName("1abc").ok).toBe(false);
    expect(checkAgentName("").ok).toBe(false);
    expect(checkAgentName("abc-").ok).toBe(false);
    expect(checkAgentName("abc_").ok).toBe(false);
    expect(checkAgentName("a".repeat(33)).ok).toBe(false);
    expect(checkAgentName("a".repeat(32)).ok).toBe(true);
  });
});

describe("checkAgentPath", () => {
  test("P5 路径穿越被拒", () => {
    expect(checkAgentPath("../../etc").ok).toBe(false);
    expect(checkAgentPath("a/../b").ok).toBe(false);
  });

  test("P6 超过 MAX_AGENT_DEPTH 段被拒（用常量而非写死 4）", () => {
    const tooDeep = Array.from({ length: MAX_AGENT_DEPTH + 1 }, (_, i) => `a${i}`).join("/");
    expect(checkAgentPath(tooDeep).ok).toBe(false);
    const justOk = Array.from({ length: MAX_AGENT_DEPTH }, (_, i) => `a${i}`).join("/");
    expect(checkAgentPath(justOk).ok).toBe(true);
  });

  test("P7 两段路径合法", () => {
    expect(checkAgentPath("ops/devops").ok).toBe(true);
    expect(checkAgentPath("default").ok).toBe(true);
  });

  test("补充：绝对路径 / 反斜杠 / 空段被拒", () => {
    expect(checkAgentPath("/abs").ok).toBe(false);
    expect(checkAgentPath("a\\b").ok).toBe(false);
    expect(checkAgentPath("a//b").ok).toBe(false);
    expect(checkAgentPath("").ok).toBe(false);
  });
});

describe("uid", () => {
  test("P8 generateAgentUid × 1000 全部合规且无重复", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const u = generateAgentUid();
      expect(AGENT_UID_RE.test(u)).toBe(true);
      expect(isAgentUid(u)).toBe(true);
      seen.add(u);
    }
    expect(seen.size).toBe(1000);
  });

  test("isAgentUid 拒绝大写 hex 与错误前缀", () => {
    expect(isAgentUid("ag_7F3A9C21")).toBe(false);
    expect(isAgentUid("AG_7f3a9c21")).toBe(false);
    expect(isAgentUid("ag_7f3a9c2")).toBe(false);
  });
});

describe("路径辅助", () => {
  test("agentDepth / agentLeafName / isDefaultAgentPath", () => {
    expect(agentDepth("")).toBe(0);
    expect(agentDepth("ops")).toBe(1);
    expect(agentDepth("ops/devops")).toBe(2);
    expect(agentLeafName("ops/devops")).toBe("devops");
    expect(agentLeafName("devops")).toBe("devops");
    expect(agentLeafName("")).toBe("");
    expect(isDefaultAgentPath("default")).toBe(true);
    expect(isDefaultAgentPath("ops/default")).toBe(false);
  });
});
