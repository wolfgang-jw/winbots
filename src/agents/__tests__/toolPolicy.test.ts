/**
 * src/agents/__tests__/toolPolicy.test.ts
 * T1–T19：工具过滤策略（模块 5）。
 *
 * 重点不是「能不能过滤」，而是三件事：
 *   ① 裁决 D-4-1（allow 缺省 = 全部允许，`[]` = 全拒绝）被钉死，
 *      且与技能侧 D-3-1（null = 全禁）**刻意相反**——T2 / T6 并排断言；
 *   ② deny 一票否决（§6.1 第 7 条）不被写成 `allow ∥ !deny`——T8 / T9 专盯；
 *   ③ 匹配对象是 visibleName，通配复用 match.ts，不重复实现——T10 / T11。
 */
import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";

// ⚠️ 【§11.4 #3】import 刻意走门面 `@/agents`（而不是 `../toolPolicy`）：
//    门面若漏转发任何一个符号，本文件在**加载阶段**就炸，而不是等到某条用例才报错。
import {
  denyAllPolicy,
  denyAllToolFilter,
  filterToolsForAgent,
  isToolAllowedByFilter,
  isToolAllowedByPolicy,
  isToolAllowedForAgent,
  resolveToolPolicy,
  toolFilterOf,
  toolNotAllowed,
  toolNotAllowedAgentUnavailable,
  type ToolFilter,
  type ToolPolicy,
  type ToolRef,
} from "@/agents";

/** 被测函数只用到 AgentRecord 的这两个字段，用 Pick 造最小对象即可。 */
type AgentSlice = Pick<AgentRecord, "toolsAllow" | "toolsDeny">;

function agent(patch: Partial<AgentSlice> = {}): AgentSlice {
  return { toolsAllow: null, toolsDeny: [], ...patch };
}

function tool(visibleName: string, callName?: string): ToolRef {
  // callName 默认给一个「点号版」，与真实注册表的形态一致（visible=local__a__b / call=local.a.b）
  const segments = visibleName.split("__");
  return {
    visibleName,
    callName: callName ?? (segments.length > 1 ? segments.join(".") : visibleName),
  };
}

const READ = tool("local__fileRead__read_file");
const SHELL = tool("local__shell__run");
const HTTP = tool("local__http__fetch");

describe("resolveToolPolicy", () => {
  test("T1 allow = null → unrestricted", () => {
    expect(resolveToolPolicy(null).kind).toBe("unrestricted");
  });

  // ── 裁决 D-4-1 的守门人（与技能侧 D-3-1 刻意相反）────────────────────
  test("T2【D-4-1】null = 全部允许；[] = 全部拒绝（两者结果必须不同）", () => {
    const cands = [READ, SHELL, HTTP];

    const pNull = resolveToolPolicy(null);
    const pEmpty = resolveToolPolicy([]);
    expect(pNull.kind).toBe("unrestricted");
    expect(pEmpty.kind).toBe("allowlist");
    // 两者 kind 不同（结构上就区分得开）
    expect(pNull.kind).not.toBe(pEmpty.kind);

    // 语义上：null 全放行，[] 全拒绝 —— 若有人「顺手统一」成技能侧口径，此断言立刻报红
    expect(cands.map((c) => isToolAllowedByPolicy(pNull, [], c))).toEqual([true, true, true]);
    expect(cands.map((c) => isToolAllowedByPolicy(pEmpty, [], c))).toEqual([false, false, false]);
  });

  test("T3 allow = [..] → allowlist，patterns 原样保留", () => {
    const p = resolveToolPolicy(["local__fileRead__*", "local__shell__run"]);
    expect(p.kind).toBe("allowlist");
    if (p.kind === "allowlist") {
      expect(p.patterns).toEqual(["local__fileRead__*", "local__shell__run"]);
    }
  });
});

describe("isToolAllowedByPolicy：匹配口径", () => {
  const pRead = resolveToolPolicy(["local__fileRead__*"]);

  test("T4 精确匹配只命中自身，不命中同前缀更长名", () => {
    const p = resolveToolPolicy(["local__shell__run"]);
    expect(isToolAllowedByPolicy(p, [], tool("local__shell__run"))).toBe(true);
    // 精确模式退化为 === 比较：local__shell__run2 不命中
    expect(isToolAllowedByPolicy(p, [], tool("local__shell__run2"))).toBe(false);
  });

  test("T5 前缀通配（末尾 *）命中", () => {
    expect(isToolAllowedByPolicy(pRead, [], tool("local__fileRead__read_file"))).toBe(true);
    expect(isToolAllowedByPolicy(pRead, [], tool("local__fileRead__list_files"))).toBe(true);
    // 不同组不命中
    expect(isToolAllowedByPolicy(pRead, [], tool("local__fileWrite__write"))).toBe(false);
  });

  test("T6【D-4-1】allow = [] → 任何工具都拒绝", () => {
    const p = resolveToolPolicy([]);
    expect([READ, SHELL, HTTP].map((c) => isToolAllowedByPolicy(p, [], c))).toEqual([
      false, false, false,
    ]);
  });

  test("T7 deny 一票否决：unrestricted 下也生效", () => {
    const p = resolveToolPolicy(null);
    const deny = ["local__shell__*"];
    expect(isToolAllowedByPolicy(p, deny, SHELL)).toBe(false);
    expect(isToolAllowedByPolicy(p, deny, READ)).toBe(true);
    expect(isToolAllowedByPolicy(p, deny, HTTP)).toBe(true);
  });

  // ── §6.1 第 7 条：deny 优先于 allow ──────────────────────────────────
  test("T8【§6.1 第 7 条】allow 与 deny 同时命中 → 拒绝", () => {
    // allow 的 local__* 覆盖了 shell，deny 又点名 shell → deny 胜
    const p = resolveToolPolicy(["local__*"]);
    expect(isToolAllowedByPolicy(p, ["local__shell__run"], SHELL)).toBe(false);
    // 同一条 allow 下，未被 deny 的仍放行
    expect(isToolAllowedByPolicy(p, ["local__shell__run"], READ)).toBe(true);
  });

  test("T9【反证】判定不是 `allow ∥ !deny`（若写反，T8 会变 true）", () => {
    // 用口径与 T8 相同的一组数据，显式断言结果为 false 且「不是 true」。
    // 写成 allow ∥ !deny 时：allow=true → 整体 true（deny 形同摆设）→ 这里必须报红。
    const p = resolveToolPolicy(["local__*"]);
    const observed = isToolAllowedByPolicy(p, ["local__shell__run"], SHELL);
    expect(observed).not.toBe(true);
    expect(observed).toBe(false);
  });

  test("T10 匹配对象是 visibleName 而非 callName（D-4-4）", () => {
    // READ 的 callName 是 local.fileRead.read_file
    expect(READ.callName).toBe("local.fileRead.read_file");
    // 用点号写模式 → 不命中（这正是「从需求抄白名单」该用的下划线形式）
    const pDot = resolveToolPolicy(["local.fileRead.*"]);
    expect(isToolAllowedByPolicy(pDot, [], READ)).toBe(false);
    // 用双下划线写 → 命中
    const pUnderscore = resolveToolPolicy(["local__fileRead__*"]);
    expect(isToolAllowedByPolicy(pUnderscore, [], READ)).toBe(true);
    // deny 侧同理：点号写不生效、下划线写生效
    expect(isToolAllowedByPolicy(resolveToolPolicy(null), ["local.fileRead.*"], READ)).toBe(true);
    expect(isToolAllowedByPolicy(resolveToolPolicy(null), ["local__fileRead__*"], READ)).toBe(false);
  });

  test("T11 中间 * 不当通配（复用 match.ts 口径）", () => {
    const cand = tool("examples__log_triage");
    expect(isToolAllowedByPolicy(resolveToolPolicy(["examples*ples__log_triage"]), [], cand)).toBe(false);
    // 末尾 * 才是通配
    expect(isToolAllowedByPolicy(resolveToolPolicy(["examples__log*"]), [], cand)).toBe(true);
  });
});

describe("filterToolsForAgent / 容器构造", () => {
  test("T12 保持输入顺序（不重排）", () => {
    const input = [SHELL, READ, HTTP];
    const out = filterToolsForAgent(agent({ toolsAllow: ["local__*"] }), input);
    expect(out.map((t) => t.visibleName)).toEqual(
      [SHELL, READ, HTTP].map((t) => t.visibleName),
    );
  });

  test("T13 空候选集 → 空输出（不崩、不隐式放行）", () => {
    expect(filterToolsForAgent(agent({ toolsAllow: ["*"] }), [])).toEqual([]);
  });

  test("T14 toolFilterOf().allows 与 isToolAllowedForAgent 逐项相等", () => {
    const a = agent({ toolsAllow: ["local__fileRead__*"], toolsDeny: ["local__shell__run"] });
    const filter: ToolFilter = toolFilterOf(a);
    const cands = [READ, SHELL, HTTP];
    const viaFilter = cands.map((c) => filter.allows(c));
    const viaAgent = cands.map((c) => isToolAllowedForAgent(a, c));
    expect(viaFilter).toEqual(viaAgent);
    // 同时确认语义本身没错（allowlist 命中 read，deny 挡住 shell，http 未在白名单）
    expect(viaAgent).toEqual([true, false, false]);
  });

  test("T15 denyAllToolFilter().allows 恒 false，且与 denyAllPolicy 同源", () => {
    const f = denyAllToolFilter();
    expect([READ, SHELL, HTTP].map((c) => f.allows(c))).toEqual([false, false, false]);
    // 与 denyAllPolicy 的判定一致（两份「全拒绝」不得分叉）
    const p: ToolPolicy = denyAllPolicy();
    expect([READ, SHELL, HTTP].map((c) => isToolAllowedByPolicy(p, [], c))).toEqual([
      false, false, false,
    ]);
    // 降级容器的字面形态与 §12.1 一致（第 6 步要能反查配置）
    expect(f.toolsAllow).toEqual([]);
    expect(f.toolsDeny).toEqual([]);
  });

  test("T16 isToolAllowedByFilter(undefined, x) 恒 true（兼容路径不受影响）", () => {
    expect([READ, SHELL, HTTP].map((c) => isToolAllowedByFilter(undefined, c))).toEqual([
      true, true, true,
    ]);
    // 给了容器则只认容器
    expect(isToolAllowedByFilter(denyAllToolFilter(), READ)).toBe(false);
  });
});

describe("tool_not_allowed 信封", () => {
  test("T17 两个信封形状正确，code 一致，message 含 agent", () => {
    for (const raw of [toolNotAllowed("local__shell__run"), toolNotAllowedAgentUnavailable()]) {
      const env = JSON.parse(raw) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe("tool_not_allowed");
      expect(env.error.message).toContain("agent");
    }
    // ① 带名字时消息里应出现该名字（便于模型定位）；不传名字也不能崩
    expect(toolNotAllowed("local__shell__run")).toContain("local__shell__run");
    expect(() => toolNotAllowed()).not.toThrow();
  });

  test("T18【D-4-2】两条 message 都不含「新建会话」", () => {
    expect(toolNotAllowed("local__x__y")).not.toContain("新建会话");
    expect(toolNotAllowedAgentUnavailable()).not.toContain("新建会话");
  });
});

describe("门面转发", () => {
  // 【§11.4 #3】逐一断言 10 个符号 + 3 个类型都在 @/agents 上可取到。
  // 只断言 3 个的话，门面漏转发其余符号时这条用例发现不了（只会在别处编译报错，指向不明）。
  test("T19 10 个函数符号 + 3 个类型均从 @/agents 取到且类型正确", () => {
    const fns = [
      resolveToolPolicy,
      denyAllPolicy,
      isToolAllowedByPolicy,
      isToolAllowedForAgent,
      filterToolsForAgent,
      toolFilterOf,
      denyAllToolFilter,
      isToolAllowedByFilter,
      toolNotAllowed,
      toolNotAllowedAgentUnavailable,
    ];
    // 恰好 10 个，且全部是 function
    expect(fns.length).toBe(10);
    for (const f of fns) expect(typeof f).toBe("function");

    // 容器的 allows 必须是 function（它是 A10 的唯一判定入口）
    expect(typeof toolFilterOf(agent()).allows).toBe("function");

    // 类型转发也要真的可用：下面这几行编译不过就说明 type 漏转发了
    const policy: ToolPolicy = resolveToolPolicy(null);
    const filter: ToolFilter = denyAllToolFilter();
    const ref: ToolRef = READ;
    expect(policy.kind).toBe("unrestricted");
    expect(filter.allows(ref)).toBe(false);
  });
});
