/**
 * src/agents/__tests__/binding.test.ts
 * 第 6 步 · M3 binding.ts 的纯函数单测（T-B1 ~ T-B14）。
 *
 * ⚠️ 为什么全部用**假注册表**：
 *   resolveBinding 的签名是 (uid, snapshot, registry)，注入假表即可覆盖 6 种情形，
 *   无需触碰 etc/agents/（那里当前为空，真扫描测不到 degraded 分支）。
 *   这也是「binding.ts 不接收注册表单例」的直接收益。
 */
import { describe, expect, test } from "bun:test";
import {
    resolveBinding,
    type AgentRecord,
    type AgentRegistry,
    type BindingResolution,
} from "@/agents";
// ⚠️ assembleForRequestMulti 属于 skills 子系统，门面在 @/skills —— 不在 @/agents。
//    第 6 步把它变成了「可选第二参数」（技能过滤钩子），但出口仍在 skills 侧。
import { assembleForRequestMulti } from "@/skills";

/** 造一条最小可用的 ok 记录 */
function rec(over: Partial<AgentRecord> = {}): AgentRecord {
    return {
        uid: "ag_00000001",
        name: "devops",
        path: "devops",
        isDefault: false,
        dir: "/x",
        title: "运维",
        description: "",
        body: "正文",
        bodySize: 6,
        llmRef: null,
        skillsMode: "allow",
        skillsAllow: null,
        toolsAllow: null,
        toolsDeny: [],
        maxRounds: null,
        memoryEnabled: true,
        systemBudget: 9000,
        status: "ok",
        ...over,
    };
}

function reg(records: AgentRecord[]): AgentRegistry {
    return {
        agents: new Map(records.map((r) => [r.uid, r])),
        byPath: new Map(),
        warnings: [],
        fingerprint: "",
        scannedAt: 0,
        failed: false,
    };
}

describe("resolveBinding · 判据顺序", () => {
    test("T-B1 未绑定：null 与空串都走 unbound", () => {
        const r: BindingResolution = resolveBinding(null, null, reg([]));
        expect(r).toEqual({ kind: "unbound" });
        // 空串也必须当未绑定：老库里若有空串脏值，不应触发降级告警
        const r2: BindingResolution = resolveBinding("", null, reg([]));
        expect(r2).toEqual({ kind: "unbound" });
    });

    test("T-B2 正常绑定：kind=bound 且 agent.uid 正确", () => {
        const r = resolveBinding("ag_00000001", "快照", reg([rec()]));
        expect(r.kind).toBe("bound");
        if (r.kind !== "bound") return;
        expect(r.agent.uid).toBe("ag_00000001");
        expect(r.memoryEnabled).toBe(true);
        expect(r.systemBudget).toBe(9000);
        // [第 7 步 A3] bound 分支必须转手 llmRef（不查表，只透传）
        expect(r.llmRef).toBe(r.agent.llmRef);
    });

    test("T-B3 目录被删：uid 不在表 → degraded，reason 含 uid", () => {
        const r = resolveBinding("ag_deadbeef", null, reg([rec()]));
        expect(r.kind).toBe("degraded");
        if (r.kind !== "degraded") return;
        expect(r.reason).toContain("ag_deadbeef");
    });

    test("T-B4 setup 损坏：status=invalid → degraded，reason 含 invalidReason", () => {
        const bad = rec({ status: "invalid", invalidReason: "name 与目录名不一致" });
        const r = resolveBinding("ag_00000001", "快照", reg([bad]));
        expect(r.kind).toBe("degraded");
        if (r.kind !== "degraded") return;
        expect(r.reason).toContain("name 与目录名不一致");
    });

    test("T-B5 uid 重复：注册表里该 uid 的记录状态非法 → degraded", () => {
        // 注册表以 uid 为键：重复 uid 时后写入者覆盖前者（scan.ts 会同时记 warning）。
        // 两条候选记录的 status 都是 invalid → 无论哪条留下了，判定都必须是 degraded。
        const a = rec({ uid: "ag_00000001", path: "a", status: "invalid", invalidReason: "uid 重复" });
        const b = rec({ uid: "ag_00000001", path: "b", status: "invalid", invalidReason: "uid 重复" });
        const r = resolveBinding("ag_00000001", null, reg([a, b]));
        expect(r.kind).toBe("degraded");
    });
});

describe("resolveBinding · 人设快照（A15 核心）", () => {
    test("T-B6 degraded 时 personaText 来自快照", () => {
        const r = resolveBinding("ag_deadbeef", "老快照", reg([]));
        if (r.kind !== "degraded") throw new Error("应 degraded");
        expect(r.personaText).toBe("老快照");
    });

    test("T-B7 degraded 且快照为 null → personaText 为空串（不炸）", () => {
        const r = resolveBinding("ag_deadbeef", null, reg([]));
        if (r.kind !== "degraded") throw new Error("应 degraded");
        expect(r.personaText).toBe("");
    });

    test("T-B8 快照优先于 rec.body（人设冻结，A15 核心）", () => {
        // 快照 = "快照"，当前 AGENT.md 正文 = "正文"；
        // 若实现误用 rec.body，这里会拿到"正文"，A15 的「冻结」即被打破。
        const r = resolveBinding("ag_00000001", "快照", reg([rec({ body: "正文" })]));
        if (r.kind !== "bound") throw new Error("应 bound");
        expect(r.personaText).toBe("快照");
        expect(r.personaText).not.toBe("正文");
    });

    test("T-B8b 快照为 null 时也不回读 rec.body（绑定后新增 AGENT.md 不应生效）", () => {
        const r = resolveBinding("ag_00000001", null, reg([rec({ body: "后来才写的正文" })]));
        if (r.kind !== "bound") throw new Error("应 bound");
        expect(r.personaText).toBe("");
    });
});

describe("resolveBinding · 工具判据（degraded 不带 toolFilter）", () => {
    test("T-B9 degraded 分支没有 toolFilter 字段（类型层强制）", () => {
        const r = resolveBinding("ag_deadbeef", null, reg([]));
        // 这是刻意设计：degraded 不带 toolFilter，迫使 chat.ts 显式改用 denyAllToolFilter()
        expect("toolFilter" in r).toBe(false);
    });

    test("T-B10 bound 且 toolsAllow=null → allows 恒 false（BR-1：null = 全禁）", () => {
        // ⚠️ 旧断言是「null → 恒 true（D-4-1 不限制）」，该裁决已作废。
        //    改造后 null 与 [] 同义（全禁），与技能侧 BR-2 同口径。
        const r = resolveBinding("ag_00000001", null, reg([rec({ toolsAllow: null })]));
        if (r.kind !== "bound") throw new Error("应 bound");
        expect(r.toolFilter.allows({ visibleName: "local__fileRead__read_file", callName: "x" })).toBe(false);
        expect(r.toolFilter.allows({ visibleName: "任意__不存在", callName: "y" })).toBe(false);
    });

    test("T-B10b bound 且 toolsAllow=[\"*\"] → allows 恒 true（显式全开）", () => {
        // 「全开」现在只能显式表达；这条与 T-B10 并排，钉住「null ≠ 不限制」
        const r = resolveBinding("ag_00000001", null, reg([rec({ toolsAllow: ["*"] })]));
        if (r.kind !== "bound") throw new Error("应 bound");
        expect(r.toolFilter.allows({ visibleName: "local__fileRead__read_file", callName: "x" })).toBe(true);
        expect(r.toolFilter.allows({ visibleName: "任意__不存在", callName: "y" })).toBe(true);
    });

    test("T-B11 bound 且 toolsAllow=[] → allows 恒 false（全拒）", () => {
        const r = resolveBinding("ag_00000001", null, reg([rec({ toolsAllow: [] })]));
        if (r.kind !== "bound") throw new Error("应 bound");
        expect(r.toolFilter.allows({ visibleName: "local__fileRead__read_file", callName: "x" })).toBe(false);
    });

    test("T-B11b deny 一票否决", () => {
        // ⚠️ allow 用 ["*"] 而非 null：BR-1 后 null 全禁，deny 就测不出独立效果了
        const r = resolveBinding(
            "ag_00000001",
            null,
            reg([rec({ toolsAllow: ["*"], toolsDeny: ["local__fileRead__*"] })]),
        );
        if (r.kind !== "bound") throw new Error("应 bound");
        expect(r.toolFilter.allows({ visibleName: "local__fileRead__read_file", callName: "x" })).toBe(false);
    });
});

describe("assembleForRequestMulti · 技能白名单（A10 同口径）", () => {
    test("T-B12 全禁过滤器 → skills 与 l0 同时为空", () => {
        const r = assembleForRequestMulti(undefined, () => false);
        expect(r.skills.length).toBe(0);
        expect(r.l0.length).toBe(0);
        expect(r.systemText).toBe("");
    });

    test("T-B13 只放行 hello → l0 里只有 hello（A10 清单与执行同口径）", () => {
        const r = assembleForRequestMulti(undefined, (c) => c.dir === "examples/hello");
        // ① 技能块：只能有 hello
        for (const s of r.skills) expect(s.dir).toBe("examples/hello");
        // ② L0 清单：每个条目的 name 必须是 hello（唯一同名 → 用短名，不是 dir）
        for (const it of r.l0) expect(it.name).toBe("hello");
        // ③ 两者必须同口径：有 l0 条目 ⇔ 有技能块
        expect(r.l0.length).toBe(r.skills.length);
    });

    test("T-B14 缺省（单参）与显式恒真过滤器逐字节相同（A8 等价证明）", () => {
        // 这是「不改签名语义」这个承诺的可执行证据：
        // 只断言「不报错」是不够的，必须证明两种调用产出完全一致。
        const a = assembleForRequestMulti();
        const b = assembleForRequestMulti(undefined, () => true);
        expect(a.systemText).toBe(b.systemText);
        expect(a.skillNames).toEqual(b.skillNames);
        expect(a.l0).toEqual(b.l0);
        expect(a.notices).toEqual(b.notices);
        expect(a.diag).toBe(b.diag);
    });
});
