/**
 * src/agents/__tests__/scan.test.ts
 * A1–A12：目录扫描（构造临时目录树，不依赖真实 etc/agents）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  computeAgentFingerprint, scanAgentsOnce, walkAgentFiles,
  ensureAgentRegistry, resetAgentRegistryForTest, agentRegistryStateForTest,
} from "../scan";
import type { ScanDeps } from "../scan";
import type { AgentRecord, AgentRegistry } from "../types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agents-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const KNOWN_LLM = (n: string): boolean => n === "main";
const DEPS: ScanDeps = { isKnownLlm: KNOWN_LLM, mintUid: false };

/** 造一个 agent 目录 */
function makeAgent(path: string, setup: Record<string, unknown> | string, body?: string): void {
  const abs = join(root, path);
  mkdirSync(abs, { recursive: true });
  const text = typeof setup === "string" ? setup : JSON.stringify(setup, null, 2);
  writeFileSync(join(abs, "setup.json"), text, "utf-8");
  if (body !== undefined) writeFileSync(join(abs, "AGENT.md"), body, "utf-8");
}

function scan(deps: ScanDeps = DEPS): AgentRegistry {
  const files = walkAgentFiles(root);
  return scanAgentsOnce(root, computeAgentFingerprint(files), files, deps);
}

/** 按 path 取记录（仅当它 status=ok 时才有 byPath 映射） */
function okByPath(reg: AgentRegistry, path: string): AgentRecord | undefined {
  const uid = reg.byPath.get(path);
  return uid === undefined ? undefined : reg.agents.get(uid);
}

describe("scanAgentsOnce", () => {
  test("A1 单个正常 agent：status ok、字段正确、byPath 有映射", () => {
    makeAgent("devops", {
      uid: "ag_00000001", name: "devops", title: "运维", llm: "main",
      skills: { mode: "allow", list: ["examples/hello"] },
      tools: { allow: ["local__fileRead__*"], deny: ["local__fileModify__delete_path"] },
      limits: { maxRounds: 12 }, memory: { enabled: false }, systemBudget: 8000,
    }, "# 角色\n");
    const reg = scan();
    const rec = reg.agents.get("ag_00000001");
    expect(rec?.status).toBe("ok");
    expect(rec?.title).toBe("运维");
    expect(rec?.path).toBe("devops");
    expect(rec?.maxRounds).toBe(12);
    expect(rec?.memoryEnabled).toBe(false);
    expect(rec?.systemBudget).toBe(8000);
    expect(rec?.body).toBe("# 角色\n");
    expect(reg.byPath.get("devops")).toBe("ag_00000001");
  });

  test("A2 分类目录（只有子 agent，无自身 setup.json）不产生记录，也不报空目录", () => {
    makeAgent("ops/devops", { uid: "ag_00000001", name: "devops" });
    const reg = scan();
    expect(reg.agents.size).toBe(1);
    expect(reg.byPath.has("ops")).toBe(false);
    expect(reg.warnings.some((w) => w.includes("目录 ops"))).toBe(false);
  });

  test("A3 default/ 目录 → isDefault true（X-2 端到端回归）", () => {
    makeAgent("default", { uid: "ag_0000000a", name: "default" });
    const reg = scan();
    const rec = reg.agents.get("ag_0000000a");
    expect(rec?.status).toBe("ok");
    expect(rec?.isDefault).toBe(true);
    expect(reg.warnings.some((w) => w.includes("命名不合规"))).toBe(false);
  });

  test("A4 坏 JSON → invalid，invalidReason 以 parse_failed: 开头", () => {
    makeAgent("broken", '{ "name": ');
    const reg = scan();
    const rec = [...reg.agents.values()].find((r) => r.path === "broken");
    expect(rec?.status).toBe("invalid");
    expect(rec?.invalidReason?.startsWith("parse_failed:")).toBe(true);
    expect(reg.byPath.has("broken")).toBe(false);
  });

  test("A4b parse_failed 时不采信原文里长得像 uid 的残片（key 必须是空串）", () => {
    // 坏 JSON，但文本里残留一个格式完全合法的 uid。
    // JSON 都解析不了，这个值不可信（可能来自注释/残缺串），不得进 Map key。
    makeAgent("badjson", '{ "uid": "ag_00000099", "name": ');
    const reg = scan();
    expect(reg.agents.has("ag_00000099")).toBe(false);
    const rec = reg.agents.get("");
    expect(rec?.status).toBe("invalid");
    expect(rec?.uid).toBe("");
    expect(rec?.path).toBe("badjson");
    expect(rec?.invalidReason?.startsWith("parse_failed:")).toBe(true);
  });

  test("A4c 对照：JSON 合法但字段错时，uid 仍被保留（与 A4b 的差异是有意为之）", () => {
    makeAgent("validjson", { uid: "ag_00000098", name: "validjson", llm: "nope" });
    const reg = scan();
    const rec = reg.agents.get("ag_00000098");
    expect(rec?.status).toBe("invalid");
    expect(rec?.invalidReason).toContain("unknown_llm");
  });

  test("A5 name 与目录名不符 → invalid，原因含 name_mismatch", () => {
    makeAgent("devops", { uid: "ag_00000002", name: "ops" });
    const reg = scan();
    const rec = [...reg.agents.values()].find((r) => r.path === "devops");
    expect(rec?.status).toBe("invalid");
    expect(rec?.invalidReason).toContain("name_mismatch");
  });

  test("A6 超深目录被跳过，但同级合法 3 段 agent 仍 ok（差异 3：不连坐）", () => {
    makeAgent("a/b/c", { uid: "ag_00000003", name: "c" });          // 3 段，合法
    makeAgent("a/b/c/d", { uid: "ag_00000004", name: "d" });        // 4 段，超限
    const reg = scan();
    expect(reg.byPath.get("a/b/c")).toBe("ag_00000003");
    expect(reg.byPath.has("a/b/c/d")).toBe(false);
    expect([...reg.agents.values()].some((r) => r.path === "a/b/c/d")).toBe(false);
    expect(reg.warnings.some((w) => w.includes("层级超过上限 3"))).toBe(true);
  });

  test("A7 不同路径同名不同 uid → 两条并存，互不覆盖", () => {
    makeAgent("ops/devops", { uid: "ag_00000011", name: "devops" });
    makeAgent("dev/devops", { uid: "ag_00000012", name: "devops" });
    const reg = scan();
    expect(reg.agents.get("ag_00000011")?.path).toBe("ops/devops");
    expect(reg.agents.get("ag_00000012")?.path).toBe("dev/devops");
    expect(reg.byPath.get("ops/devops")).toBe("ag_00000011");
    expect(reg.byPath.get("dev/devops")).toBe("ag_00000012");
  });

  test("A8 两个目录同 uid → 两个都 invalid，且两条记录都保留", () => {
    makeAgent("one", { uid: "ag_00000021", name: "one" });
    makeAgent("two", { uid: "ag_00000021", name: "two" });
    const reg = scan();
    const both = [...reg.agents.values()].filter((r) => r.uid === "ag_00000021");
    expect(both.length).toBe(2);
    expect(both.every((r) => r.status === "invalid")).toBe(true);
    expect(both.every((r) => (r.invalidReason ?? "").includes("被多个 agent 共用"))).toBe(true);
    expect(reg.byPath.size).toBe(0);
    expect(reg.warnings.some((w) => w.includes("被多个 agent 使用"))).toBe(true);
  });

  test("A9 只有 AGENT.md 没有 setup.json → 不产生 agent", () => {
    const abs = join(root, "bodyonly");
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, "AGENT.md"), "# 只有正文\n", "utf-8");
    const reg = scan();
    expect(reg.agents.size).toBe(0);
  });

  test("A10 中间分类目录（有子 agent）不报空目录告警", () => {
    // 造一个两层树：deep 本身没有 setup.json，但有子目录，属分类目录
    makeAgent("deep/x_agent", { uid: "ag_00000031", name: "x_agent" });
    const reg = scan();
    // deep 是中间分类目录（有文件），不告警
    expect(reg.warnings.some((w) => w.includes("目录 deep 内既无 setup.json"))).toBe(false);
    expect(reg.byPath.get("deep/x_agent")).toBe("ag_00000031");
  });

  test("A10b 真正读不到的根目录不崩，failed 由 ensure 层置位（此处只验证空树）", () => {
    const empty = mkdtempSync(join(tmpdir(), "agents-empty-"));
    try {
      const files = walkAgentFiles(empty);
      const reg = scanAgentsOnce(empty, computeAgentFingerprint(files), files, DEPS);
      expect(reg.agents.size).toBe(0);
      expect(reg.failed).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("A11 缺 uid 且 mintUid=true → 文件里真的写入了 uid，且仍是合法 JSON", () => {
    makeAgent("legacy", { name: "legacy", title: "老目录" });
    const reg = scan({ isKnownLlm: KNOWN_LLM, mintUid: true });
    const rec = [...reg.agents.values()].find((r) => r.path === "legacy");
    expect(rec?.status).toBe("ok");
    expect(rec?.uid).toMatch(/^ag_[0-9a-f]{8}$/);

    const onDisk = JSON.parse(readFileSync(join(root, "legacy", "setup.json"), "utf-8")) as {
      uid?: string; name?: string; title?: string;
    };
    expect(onDisk.uid).toBe(rec?.uid as string);
    expect(onDisk.name).toBe("legacy");
    expect(onDisk.title).toBe("老目录");
  });

  test("A12 改 setup.json 后指纹变化", () => {
    makeAgent("devops", { uid: "ag_00000001", name: "devops" }, "# v1\n");
    const fp1 = computeAgentFingerprint(walkAgentFiles(root));
    writeFileSync(join(root, "devops", "setup.json"), JSON.stringify({ uid: "ag_00000001", name: "devops", title: "改" }, null, 2), "utf-8");
    // 显式推进 mtime，避免同毫秒内写入被 floor 掉
    const t = new Date(Date.now() + 2000);
    utimesSync(join(root, "devops", "setup.json"), t, t);
    const fp2 = computeAgentFingerprint(walkAgentFiles(root));
    expect(fp1).not.toBe(fp2);
  });

  test("补充：命名不合规的目录被跳过并告警", () => {
    // 注意：Bad_Name 是【合法】名（大写字母允许、无连续下划线、无连字符），
    // 用它验证「非法名被跳过」会误判。真正的非法名要含连续下划线。
    makeAgent("bad__name", { uid: "ag_00000071", name: "bad__name" });
    const reg = scan();
    expect(reg.agents.size).toBe(0);
    expect(reg.warnings.some((w) => w.includes("命名不合规"))).toBe(true);
  });

  test("补充：AGENT.md 超过 32KB 只告警，仍为 ok", () => {
    makeAgent("big", { uid: "ag_00000041", name: "big" }, "x".repeat(33 * 1024));
    const reg = scan();
    const rec = reg.agents.get("ag_00000041");
    expect(rec?.status).toBe("ok");
    expect(reg.warnings.some((w) => w.includes("体积"))).toBe(true);
  });

  test("补充：llm 不在集合 → invalid，原因含 unknown_llm", () => {
    makeAgent("withllm", { uid: "ag_00000051", name: "withllm", llm: "gpt5" });
    const reg = scan();
    const rec = reg.agents.get("ag_00000051");
    expect(rec?.status).toBe("invalid");
    expect(rec?.invalidReason).toContain("unknown_llm");
  });

  test("补充：点开头的文件/目录被忽略，不进指纹", () => {
    makeAgent("devops", { uid: "ag_00000001", name: "devops" });
    writeFileSync(join(root, ".hidden.json"), "{}", "utf-8");
    const files = walkAgentFiles(root);
    expect(files.some((f) => f.rel.startsWith("."))).toBe(false);
  });

  test("补充：okByPath 帮手可用（防止 helpers 未使用）", () => {
    makeAgent("solo", { uid: "ag_00000061", name: "solo" });
    const reg = scan();
    expect(okByPath(reg, "solo")?.uid).toBe("ag_00000061");
    expect(okByPath(reg, "nope")).toBeUndefined();
  });
});

/* ============================================================
 * E-1 回归：ensureAgentRegistry 的 in-flight 去重不能「粘住」
 *
 * 缺陷现场：`const run = (async () => {...})(); inflight = run;`
 *   scanAgentsOnce 是同步的 → IIFE 一路跑到 finally 把 inflight 清成 null，
 *   之后 `inflight = run` 又把一个已 resolve 的 Promise 塞回去。
 *   结果 inflight 永久非 null，后续请求全部命中 `if (inflight) return inflight`，
 *   拿到第一次扫描的陈旧注册表 → 新增/删除 agent 永远看不到。
 *
 * 这三条用例锁住三件事：
 *   1. 一次扫描结束后 inflight 必须清空（否则下一次就被劫持）
 *   2. 连续两次调用都能正常完成（不会挂在一个旧 Promise 上）
 *   3. 文件系统变化后注册表会真的重扫（指纹驱动）
 * ============================================================ */
describe("ensureAgentRegistry 单例（E-1 回归）", () => {
  test("E1-1 扫描结束后 inflight 必须清空", async () => {
    resetAgentRegistryForTest();
    await ensureAgentRegistry(DEPS);
    expect(agentRegistryStateForTest().inflight).toBe(false);
  });

  test("E1-2 连续两次调用都能完成，且第二次不被旧 Promise 劫持", async () => {
    resetAgentRegistryForTest();
    const a = await ensureAgentRegistry(DEPS);
    const b = await ensureAgentRegistry(DEPS);
    // 两次都返回了注册表（没有挂起、没有抛错）
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(agentRegistryStateForTest().inflight).toBe(false);
    expect(agentRegistryStateForTest().ready).toBe(true);
  });

  test("E1-3 并发调用合并为一次扫描，结束后 inflight 仍清空", async () => {
    resetAgentRegistryForTest();
    const [x, y] = await Promise.all([
      ensureAgentRegistry(DEPS),
      ensureAgentRegistry(DEPS),
    ]);
    expect(x).toBe(y);                        // in-flight 去重生效：同一个对象
    expect(agentRegistryStateForTest().inflight).toBe(false);
  });
});
