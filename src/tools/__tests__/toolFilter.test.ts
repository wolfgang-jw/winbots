/**
 * src/tools/__tests__/toolFilter.test.ts
 * T20–T26：清单与执行同口径（A10）——在**真实注册表**上验证。
 *
 * 为什么放在 src/tools/__tests__（而不是 src/agents/__tests__）：
 *   本文件需要真实注册表（`@/tools` 的值导入）。若塞进 agents/，agents 目录下就会出现
 *   对执行域的值依赖，与「agents 纯函数不依赖 tools」的取向冲突。
 *   代价是验证时要多跑一条 `bun test src/tools`（不是新增 npm 脚本）。
 *
 * ⚠️ 本文件的重点是 T20（双向枚举）：它验证的不是功能，而是「清单与执行没有分叉」。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  executeTool,
  getToolDefinitions,
  ensureToolRegistry,
  type ToolDef,
} from "@/tools";

// ⚠️ 【§11.4 #3】import 刻意走门面 `@/agents`（不是 `@/agents/toolPolicy`），
//    让门面漏转发在测试自身的加载阶段就炸掉。
import { denyAllToolFilter, toolFilterOf, type ToolFilter } from "@/agents";

/** 从清单里取「用户工具」名（排除元工具） */
const isMeta = (name: string) => name.startsWith("skill__");

let baseline: ToolDef[] = [];
let baselineJson = "";
/** 全集 U：缺省清单里的全部名字（含元工具，避免 T20 误报） */
let universe: string[] = [];
/** 用户工具名（不含元工具）——降级 / 只收窄 等用例的对象 */
let userNames: string[] = [];

beforeAll(async () => {
  // 顺序不能反：skill 侧的装配依赖工具注册表已就绪
  await ensureToolRegistry({ force: true });
  baseline = getToolDefinitions();
  baselineJson = JSON.stringify(baseline);
  universe = baseline.map((d) => d.function.name);
  userNames = universe.filter((n) => !isMeta(n));
});

/** 清单里的名字集合（用真实函数求得） */
function visibleNames(filter?: ToolFilter): Set<string> {
  return new Set(getToolDefinitions(filter).map((d) => d.function.name));
}

/** 执行一次，返回结构化错误码（成功则为 null） */
async function codeOf(name: string, filter?: ToolFilter): Promise<string | null> {
  const raw = await executeTool(name, {}, undefined, filter);
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: { code?: string } };
    return parsed.error?.code ?? null;
  } catch {
    // 非 JSON（工具真的执行成功并返回了文本）→ 视为无错误码
    return null;
  }
}

describe("T20 双向枚举（不可裁的强制门禁）", () => {
  test("对 4 组判据：(name ∈ 清单) ⟺ (执行不返回 tool_not_allowed)", async () => {
    // 依赖前置：注册表里必须真有一批用户工具，否则本用例会「空集全绿」而无意义
    expect(userNames.length).toBeGreaterThan(0);

    const first = userNames[0];
    // ⚠️ 前置：first 必须是**用户工具**（不是 skill__* 元工具）。
    //    否则 deny=[first] 会变成「禁一个元工具」，而那本来就不受过滤 → 该组判据空转。
    expect(isMeta(first)).toBe(false);

    // 4 组判据：【§11.4 #4】必须含 deny 反向用例，否则端到端从未验证 deny 优先
    const cases: Array<{ label: string; filter: ToolFilter }> = [
      { label: "allow=null（不限制）", filter: toolFilterOf({ toolsAllow: null, toolsDeny: [] }) },
      { label: "allow=[*]", filter: toolFilterOf({ toolsAllow: ["*"], toolsDeny: [] }) },
      { label: "allow=[首个用户工具]", filter: toolFilterOf({ toolsAllow: [first], toolsDeny: [] }) },
      { label: "deny=[首个用户工具]", filter: toolFilterOf({ toolsAllow: null, toolsDeny: [first] }) },
    ];

    // ⚠️ 每组判据都必须**真的产生收窄**，否则「双向成立」是平凡结论（空集也能全绿）。
    //    · allow=null / allow=[*]：语义上就是「不限制」，不收窄 —— 它们的作用是证明
    //      「不放宽」与「清单=执行」在无收窄时也一致；
    //    · allow=[首个用户工具] / deny=[首个用户工具]：收窄后清单里的**用户工具数**
    //      必须严格小于全集的用户工具数（用用户工具计数，避免被不受过滤的元工具干扰）。
    const narrowCases = new Set(["allow=[首个用户工具]", "deny=[首个用户工具]"]);
    const noNarrowCases = new Set(["allow=null（不限制）", "allow=[*]"]);

    for (const { label, filter } of cases) {
      const listed = visibleNames(filter);
      const listedUserCount = userNames.filter((n) => listed.has(n)).length;
      if (narrowCases.has(label)) {
        expect(listedUserCount).toBeLessThan(userNames.length);
      }
      if (noNarrowCases.has(label)) {
        // 不收窄 → 用户工具一个不少（元工具本来就不受影响）
        expect(listedUserCount).toBe(userNames.length);
      }

      for (const name of universe) {
        const code = await codeOf(name, filter);
        // 归一：它是否「被判定为未授权」（只有 tool_not_allowed 算）
        const wasNotAllowed = code === "tool_not_allowed";
        // 事实：它是否出现在本轮清单里（由真实的 getToolDefinitions 求得）
        const inList = listed.has(name);

        // ⚠️ 【§11.4 #1】断言串**只保留 name 与 code**：label 只作循环变量、绝不进入比较串。
        //    若把 label 拼进两侧，一旦有人把「先算 observed 再比较」写歪，
        //    正反两个方向会同时成立 → 用例永远绿（T20 是唯一不可裁的门禁，不能有假绿可能）。
        //
        // ⚠️ 【实施期复检 #1】两侧必须是**两个独立事实**，不能把期望值从同一行推出来：
        //    曾写成 `if (inList) … else …` 再在 else 里断言 `${name} → ${code}` === `… tool_not_allowed`，
        //    而 `inList` 本身又来自 `code === "tool_not_allowed"` → 期望值由观测值推出，
        //    第二重 toEqual 也退化成恒真（假绿）。现改为固定常数 "tool_not_allowed"：
        //    清单里没有 → 执行**必须**报它；清单里有 → 执行**不得**报它。
        const NEVER_ALLOWED = "tool_not_allowed";
        if (wasNotAllowed) {
          // 报了未授权 → 它本轮就不该在清单里
          expect(`${name} → ${inList}`).toBe(`${name} → false`);
          expect(!inList).toBe(true);
        } else {
          // 没报未授权 → 它本轮就必须在清单里（清单与执行不得分叉）
          expect(`${name} → ${inList}`).toBe(`${name} → true`);
          expect(inList).toBe(true);
        }

        // 独立的第二重断言（与上面的拼接串无关）：确认「未授权」这个词只对应这一个码，
        // 也就是说 codeOf 的归一没有把别的错误码也算成未授权。
        expect(wasNotAllowed).toBe(code === NEVER_ALLOWED);
        // 并且：清单里的工具一定没有卡在「授权」这一关（可能是别的错误，但不是未授权）
        if (inList) expect(code).not.toBe(NEVER_ALLOWED);
      }
    }
  }, 60_000);
});

describe("T21 不传 opts 时行为逐字节不变", () => {
  test("getToolDefinitions() === getToolDefinitions(undefined) === 基线", () => {
    expect(getToolDefinitions()).toEqual(getToolDefinitions(undefined));
    expect(JSON.stringify(getToolDefinitions())).toBe(baselineJson);
    expect(JSON.stringify(getToolDefinitions(undefined))).toBe(baselineJson);
  });
});

describe("T22 只收窄、不放宽", () => {
  test("任意判据下的清单都是缺省清单的子集（含 deny 与降级）", () => {
    const all = new Set(universe);
    const filters: ToolFilter[] = [
      toolFilterOf({ toolsAllow: null, toolsDeny: [userNames[0]] }),
      toolFilterOf({ toolsAllow: ["*"], toolsDeny: [] }),
      toolFilterOf({ toolsAllow: [userNames[0]], toolsDeny: [] }),
      toolFilterOf({ toolsAllow: ["local__不存在的组__*"], toolsDeny: [] }),
      denyAllToolFilter(),
    ];
    for (const f of filters) {
      for (const name of visibleNames(f)) {
        expect(all.has(name)).toBe(true);
      }
    }
  });
});

describe("T23 降级全拒绝", () => {
  test("denyAllToolFilter()：用户工具全部不在清单，且执行报 tool_not_allowed", async () => {
    const listed = visibleNames(denyAllToolFilter());
    for (const name of userNames) {
      expect(listed.has(name)).toBe(false);
      expect(await codeOf(name, denyAllToolFilter())).toBe("tool_not_allowed");
    }
  }, 60_000);
});

describe("T24 / T25 未注册名的报错码", () => {
  test("T24 未注册名 + 容器不放行 → tool_not_allowed（不是 tool_not_found）", async () => {
    expect(await codeOf("local__not_exist__x", denyAllToolFilter())).toBe("tool_not_allowed");
  });

  test("T25 未注册名 + 容器缺省 → tool_not_found（未被吞掉）", async () => {
    expect(await codeOf("local__not_exist__x", undefined)).toBe("tool_not_found");
  });
});

describe("T26 元工具现状被钉住", () => {
  test("缺省清单含 skill__* 元工具；降级下仍存在（元工具不经 agent 过滤）", () => {
    const meta = baseline.map((d) => d.function.name).filter(isMeta);
    // 缺省清单里必须有元工具
    expect(meta.length).toBeGreaterThan(0);

    // ⚠️ 本步**不改**元工具的归属（属第 5 / 6 步）。
    //    若有人顺手把元工具也过滤掉，这条立刻报红，逼他先去改文档 §11.3 的归属决定。
    const listedOnDenyAll = visibleNames(denyAllToolFilter());
    for (const m of meta) expect(listedOnDenyAll.has(m)).toBe(true);
  });
});
