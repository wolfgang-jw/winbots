/**
 * src/agents/__tests__/skillPolicy.test.ts
 * S1–S16：技能过滤策略（模块 4）。
 *
 * 重点不是「能不能过滤」，而是三件事：
 *   ① 裁决 D-3-1（null = 全禁）被钉死，且与 [] 结果一致；
 *   ② 白名单只能**收窄**，且本函数不复制全局三条件（S13/S14 对照测试）；
 *   ③ 通配不重复实现，一律复用 match.ts（S16 与 match.test.ts 的 W 系列互为印证）。
 */
import { describe, expect, test } from "bun:test";
import type { AgentRecord, AgentSkillsMode } from "../types";
import {
  filterSkillsForAgent,
  isSkillAllowedByPolicy,
  isSkillAllowedForAgent,
  resolveSkillPolicy,
  type SkillRef,
} from "../skillPolicy";

/** 被测函数只用到 AgentRecord 的这两个字段，用 Pick 造最小对象即可。 */
type AgentSlice = Pick<AgentRecord, "skillsMode" | "skillsAllow">;

function agent(patch: Partial<AgentSlice> = {}): AgentSlice {
  return { skillsMode: "allow", skillsAllow: null, ...patch };
}

function skill(dir: string, name?: string): SkillRef {
  return { dir, name: name ?? (dir.split("/").pop() ?? dir) };
}

/** 全局口径形状（只用于对照，不在被测函数里出现） */
interface GlobalUsable extends SkillRef {
  status: "ok" | "suspended";
  toggleKey: string;
  unavailable?: readonly unknown[];
}

function usable(dir: string, patch: Partial<GlobalUsable> = {}): GlobalUsable {
  return { ...skill(dir), status: "ok", toggleKey: `SKILLON__${dir}`, unavailable: [], ...patch };
}

const A = "examples/log_triage";
const B = "examples/deploy";
const C = "tools/read_file";

describe("resolveSkillPolicy", () => {
  test("S1 mode=all 已被废除（D-1）：类型层已不允许，运行期传入也不会放宽", () => {
    // ⚠️ 两层防线，逐层断言：
    //   ① 类型层：`AgentSkillsMode` 已收窄为字面量 "allow"，下面这行**故意**用
    //      `as` 逃逸才写得出来 —— 若哪天有人把 "all" 加回类型，这条注释就不再成立。
    //   ② 运行期：resolveSkillPolicy 内部 `void mode`，只认 list。
    //      即使上游塞进历史值，也**绝不退化成「不限制」**（安全边界不因脏输入放宽）。
    const legacy = "all" as unknown as AgentSkillsMode;

    const p = resolveSkillPolicy(legacy, null);
    expect(p.kind).toBe("allowlist");
    expect(p.patterns).toEqual([]);
    // list 不再被忽略：传了 ["a"] 就是 ["a"]（旧口径会整块丢弃）
    expect(resolveSkillPolicy(legacy, ["a"]).patterns).toEqual(["a"]);
  });

  test("S2 allow + 非空白名单 → allowlist，patterns 原样保留", () => {
    const p = resolveSkillPolicy("allow", ["examples/*", "tools/read_file"]);
    expect(p.kind).toBe("allowlist");
    if (p.kind === "allowlist") {
      expect(p.patterns).toEqual(["examples/*", "tools/read_file"]);
    }
  });

  test("S3 allow + [] → allowlist 空（全禁），不是 unrestricted", () => {
    const p = resolveSkillPolicy("allow", []);
    expect(p.kind).toBe("allowlist");
    if (p.kind === "allowlist") expect(p.patterns.length).toBe(0);
  });

  test("S4 allow + [\"*\"] → allowlist（全开效果，但 kind 与 unrestricted 不同）", () => {
    const p = resolveSkillPolicy("allow", ["*"]);
    expect(p.kind).toBe("allowlist");
    expect(p.kind).not.toBe("unrestricted");
  });

  // ── 裁决 D-3-1 的守门人 ────────────────────────────────────────────────
  test("S5【D-3-1】allow + null → 空白名单（全禁），绝不是 unrestricted", () => {
    const p = resolveSkillPolicy("allow", null);
    expect(p.kind).toBe("allowlist");
    if (p.kind === "allowlist") expect(p.patterns.length).toBe(0);
  });

  test("S6【D-3-1】null 与 [] 的判定结果完全一致（都全禁）", () => {
    const pNull = resolveSkillPolicy("allow", null);
    const pEmpty = resolveSkillPolicy("allow", []);
    expect(pNull.kind).toBe(pEmpty.kind);
    // 对同一批候选，两者输出必须相同
    const cands = [skill(A), skill(B)];
    expect(filterSkillsForAgent(agent({ skillsAllow: null }), cands)).toEqual(
      filterSkillsForAgent(agent({ skillsAllow: [] }), cands),
    );
    expect(filterSkillsForAgent(agent({ skillsAllow: null }), cands)).toEqual([]);
  });
});

describe("isSkillAllowedByPolicy / isSkillAllowedForAgent", () => {
  test("S7 已无「放行一切」的形态：空白名单对任何技能都不放行", () => {
    // ⚠️ 旧的 S7 断言 unrestricted 全放行，其载体是已废除的 mode=all（D-1）。
    //    现在**唯一**的「全开」表达是显式 ["*"]，所以这里改为并排断言两者：
    const legacy = "all" as unknown as AgentSkillsMode;
    const pEmpty = resolveSkillPolicy(legacy, null);
    expect(isSkillAllowedByPolicy(pEmpty, skill(A))).toBe(false);
    expect(isSkillAllowedByPolicy(pEmpty, skill("any/thing"))).toBe(false);

    // 显式 ["*"] 才全开
    const pStar = resolveSkillPolicy("allow", ["*"]);
    expect(isSkillAllowedByPolicy(pStar, skill(A))).toBe(true);
    expect(isSkillAllowedByPolicy(pStar, skill("any/thing"))).toBe(true);
  });

  test("S8 allowlist 精确模式只命中自身", () => {
    const p = resolveSkillPolicy("allow", ["examples/log_triage"]);
    expect(isSkillAllowedByPolicy(p, skill("examples/log_triage"))).toBe(true);
    expect(isSkillAllowedByPolicy(p, skill("examples/log_triage2"))).toBe(false);
  });

  test("S9 便捷函数 isSkillAllowedForAgent 与 policy 版同源", () => {
    const a = agent({ skillsAllow: ["examples/*"] });
    expect(isSkillAllowedForAgent(a, skill(A))).toBe(true);
    expect(isSkillAllowedForAgent(a, skill(C))).toBe(false);
  });

  test("S10 白名单匹配的是 dir 而非 name（D-3-3）", () => {
    // dir 与 name 不同的候选：写 dir 模式能命中，写 name 模式不能
    const cand = skill("examples/log_triage", "log_triage");
    expect(isSkillAllowedForAgent(agent({ skillsAllow: ["examples/*"] }), cand)).toBe(true);
    expect(isSkillAllowedForAgent(agent({ skillsAllow: ["log_triage"] }), cand)).toBe(false);
  });
});

describe("filterSkillsForAgent", () => {
  test("S11 allowlist：命中的保留，未命中的剔除", () => {
    const out = filterSkillsForAgent(
      agent({ skillsAllow: ["examples/*"] }),
      [skill(A), skill(B), skill(C)],
    );
    expect(out.map((s) => s.dir)).toEqual([A, B]);
  });

  test("S12 保持输入顺序（不重排，避免与 assemble 的两套秩序）", () => {
    const input = [skill(C), skill(A), skill(B)];
    const out = filterSkillsForAgent(agent({ skillsAllow: ["*"] }), input);
    expect(out.map((s) => s.dir)).toEqual([C, A, B]);
  });

  // ── 与全局口径的对照测试（本步最重要的一组）──────────────────────────
  test("S13【对照】agent 过滤是全局集合的**子集**，绝不放大", () => {
    // 全局口径（assemble.ts:281）先筛出候选集
    const all = [
      usable(A),
      usable(B, { status: "suspended" }),          // 全局关掉
      usable(C, { toggleKey: "SKILLON__off" }),    // 全局开关未开
      usable("tools/x", { unavailable: [{}] }),    // 工具缺失
    ];
    const globalOk = all.filter(
      (r) => r.status === "ok" && r.toggleKey !== "SKILLON__off" && (r.unavailable ?? []).length === 0,
    );
    expect(globalOk.map((s) => s.dir)).toEqual([A]);

    // 即便 agent 白名单写 "*"（最宽），也只能在 globalOk 里取子集
    const out = filterSkillsForAgent(agent({ skillsAllow: ["*"] }), globalOk);
    expect(out.map((s) => s.dir)).toEqual([A]);

    // 反证：若把全部技能直接喂进来（跳过全局过滤），agent 层不会替全局把关 ——
    // 这是刻意的职责划分，说明「先全局、后 agent」的顺序不能反。
    const wide = filterSkillsForAgent(agent({ skillsAllow: ["*"] }), all);
    expect(wide.length).toBe(all.length);
    // 因此第 5 步必须先全局过滤，本函数不承担该职责（见文档铁律 2）
  });

  test("S14【对照】显式 [\"*\"] 时不做任何收窄（等价于不接 agent 的现状）", () => {
    // ⚠️ 旧版本用 mode="all" 表达「不接 agent」。D-1 废除该模式后，
    //    唯一等价的表达是显式 ["*"]（「不接 agent」= 不设置白名单 = 全放行）。
    const globalOk = [usable(A), usable(C)];
    const out = filterSkillsForAgent(agent({ skillsMode: "allow", skillsAllow: ["*"] }), globalOk);
    expect(out.map((s) => s.dir)).toEqual(globalOk.map((s) => s.dir));

    // 而**空白名单**（null）在新语义下是全禁，与上面形成对照 ——
    //   这一对并排断言正是 BR-2 的核心：省略 ≠ 不限制。
    const none = filterSkillsForAgent(agent({ skillsMode: "allow", skillsAllow: null }), globalOk);
    expect(none).toEqual([]);
  });

  test("S15 空候选集 → 空输出（不崩、不隐式放行）", () => {
    expect(filterSkillsForAgent(agent({ skillsAllow: ["*"] }), [])).toEqual([]);
  });

  test("S16 通配复用 match.ts：末尾 * 前缀命中，中间 * 按字面", () => {
    // 与 match.test.ts 的 W1/W4 互为印证，若这里另写一套实现就会不一致
    const cands = [skill("examples/log_triage"), skill("examples/log_triage2"), skill("examples/x")];
    expect(
      filterSkillsForAgent(agent({ skillsAllow: ["examples/log*"] }), cands).map((s) => s.dir),
    ).toEqual(["examples/log_triage", "examples/log_triage2"]);
    // 中间 * 不当通配
    expect(
      filterSkillsForAgent(agent({ skillsAllow: ["examples/*/triage"] }), cands),
    ).toEqual([]);
  });

  test("S17【D-3-4】记录语义：前缀 * 会命中同前缀更长路径（技能侧不保证段边界）", () => {
    // "examples/log*" 命中 examples/log_triage2 是正确行为（用户确实写了 *），
    // 但需求 §3.1「不会误伤」的论证只对工具侧（__ 分隔符）成立，技能侧不适用。
    const out = filterSkillsForAgent(
      agent({ skillsAllow: ["examples/log*"] }),
      [skill("examples/log_triage"), skill("examples/log_triage2")],
    );
    expect(out.length).toBe(2);
  });
});
