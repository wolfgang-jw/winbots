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
// getRegistry 在 scan.ts（index.ts 只值导入、未 re-export）
import { getRegistry } from "@/tools/scan";

// ⚠️ 【§11.4 #3】import 刻意走门面 `@/agents`（不是 `@/agents/toolPolicy`），
//    让门面漏转发在测试自身的加载阶段就炸掉。
import { denyAllToolFilter, toolFilterOf, type ToolFilter } from "@/agents";
// [D-16 方案②] 元工具的可见名常量：T26 断言「追加了哪一条」时用它，避免硬编码字符串。
import { L2_TOOL_VISIBLE_NAME } from "@/skills/l2tool";

// ⚠️ 【BR-1 之后的新增前置】工具组开关已改为「每 agent 一份」，由 AsyncLocalStorage
//    承载，**无上下文 = 全关**（保守降级）。测试进程默认没有请求上下文，
//    因此这里必须显式跑在「全组开启」的上下文里，否则注册表全判 dir_off、
//    userNames 为空集，T20 退化成空集全绿（假绿）。
import { agentToolConfigOf } from "@/agents/toolConfig";
import { runWithAgentToolConfig } from "@/infra/toolConfigContext";

/** 从真实注册表提取 agentToolConfigOf 需要的 groups / dirs 形态 */
function registryShape(): {
  groups: Array<{ id: string; dirPath: string; fileBase: string; visiblePrefix: string }>;
  dirs: Array<{ path: string; groups: string[]; children: string[] }>;
} {
  const reg = getRegistry();
  const groups = [...reg.groups.entries()].map(([id, g]) => ({
    id,
    dirPath: g.dirPath,
    fileBase: g.fileBase,
    visiblePrefix: g.visiblePrefix,
  }));
  const dirs = [...reg.dirs.entries()].map(([path, d]) => ({
    path,
    groups: d.groups,
    children: d.children,
  }));
  return { groups, dirs };
}

/**
 * 在「全部工具组显式开启」的上下文下执行 fn（同步用）。
 *
 * 为什么用 ["*"] 而不是 null：BR-1 之后 null = 全禁。["*"] 是「显式全开」，
 * 等价于改造前 env.json 里所有 TOOLON__ 均为 true 的初始态，
 * 也正是 T20 要验证「清单与执行同口径」时需要的基线。
 */
function withAllToolsOn<T>(fn: () => T): T {
  return runWithAgentToolConfig(allToolsCfg(), fn);
}

/** 同上，异步版本（AsyncLocalStorage 会自动跨 await 传播） */
function withAllToolsOnAsync<T>(fn: () => Promise<T>): Promise<T> {
  return runWithAgentToolConfig(allToolsCfg(), fn);
}

/** 构造「全开」配置快照（每次现算，成本可忽略；避免共享可变对象） */
function allToolsCfg() {
  const { groups, dirs } = registryShape();
  return agentToolConfigOf(
    {
      uid: "ag_00000001",
      path: "default",
      toolsAllow: ["*"],
      toolsDeny: [],
      toolSettings: {},
      skillsAllow: [],
    } as never,
    groups,
    dirs,
    [],
  );
}

/**
 * 「全开 + 1 个技能」的判据容器（D-16 方案②）。
 *
 * 为什么要显式给 skillCount：
 *   元工具 skill__get_l2 只在「该 agent 至少 1 个可用技能」时才追加
 *   （没有技能时它点了必然报错，且与 BR-1「仅在配置中列出了的才可用」相悖）。
 *   本文件把「全集 U」定义为含元工具，所以基线必须给 1，否则 T20 的
 *   双向枚举会少掉元工具这条腿。
 */
// ⚠️ 用构造函数产生，不手写对象：`ToolFilter.allows` 的契约是「只由 toolFilterOf /
//    denyAllToolFilter 产生」，单测手写会绕过这条契约（将来 allows 语义若变，这里不会跟着变）。
//    语义上 toolFilterOf({toolsAllow:["*"]}, 1) 与「全开 + 1 技能」完全等价。
const ALL_ON_FILTER: ToolFilter = toolFilterOf({ toolsAllow: ["*"], toolsDeny: [] }, 1);

/** 从清单里取「用户工具」名（排除元工具） */
const isMeta = (name: string) => name.startsWith("skill__");

let baseline: ToolDef[] = [];
/** 全集 U：缺省清单里的全部名字（含元工具，避免 T20 误报） */
let universe: string[] = [];
/** 用户工具名（不含元工具）——降级 / 只收窄 等用例的对象 */
let userNames: string[] = [];

beforeAll(async () => {
  // 顺序不能反：skill 侧的装配依赖工具注册表已就绪
  await ensureToolRegistry({ force: true });
  // ⚠️ 【BR-1 后的关键修正】baseine 必须在「全组开启」的上下文里取。
  //    无上下文 = 全关（保守降级）→ baseline 会是空清单，
  //    于是 T21「不传 opts 与基线一致」变成「空 与 空 一致」的空转（假绿）。
  baseline = withAllToolsOn(() => getToolDefinitions(ALL_ON_FILTER));
  universe = baseline.map((d) => d.function.name);
  userNames = universe.filter((n) => !isMeta(n));
});

/**
 * 清单里的名字集合（用真实函数求得）
 *
 * ⚠️ 必须在「全组开启」上下文内调用：函数体内的 getToolDefinitions 会逐组查
 *    groupState → isToggleOn → AsyncLocalStorage。脱离上下文会全判 dir_off。
 *    本函数**不会**自己包上下文（那会掩盖调用方漏包的问题）：调用方必须显式包
 *    withAllToolsOn / withAllToolsOnAsync。
 */
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
    // ⚠️ 【BR-1 后的必要前置】整个用例体必须跑在「全组开启」的上下文内。
    //    否则 getToolDefinitions / executeTool 内部的 groupState 会全判 dir_off，
    //    清单恒空、执行恒 tool_disabled，4 组判据全部空转（可能「假绿」）。
    await withAllToolsOnAsync(async () => {
    // 依赖前置：注册表里必须真有一批用户工具，否则本用例会「空集全绿」而无意义
    expect(userNames.length).toBeGreaterThan(0);

    const first = userNames[0];
    // ⚠️ 前置：first 必须是**用户工具**（不是 skill__* 元工具）。
    //    否则 deny=[first] 会变成「禁一个元工具」，而那本来就不受过滤 → 该组判据空转。
    expect(isMeta(first)).toBe(false);

    // 4 组判据：【§11.4 #4】必须含 deny 反向用例，否则端到端从未验证 deny 优先
    //   ⚠️ BR-1 之后 `allow: null` = 全禁，已无法表达「不限制」。
    //      原有的「allow=null（不限制）」组改为「allow=[*]（显式全开）」，语义等价、口径合规。
    //      另加一组「allow=null（全禁）」作为**新语义**的反向对照 —— 它必须收窄到 0 个用户工具。
    const cases: Array<{ label: string; filter: ToolFilter }> = [
      // [D-16 方案②] 前 3 组给 skillCount: 1（有技能 ⇒ 元工具出现）；全禁组给 0
      //   （全禁时技能侧同样全拒，不该还给出「读技能手册」的入口）。
      //   下面的双向枚举**只考察用户工具**（跳过 skill__* 元工具）：元工具不受 allow/deny 约束，
      //   把它纳入「4 组判据」只会因为它的豁免而误报，那是另一个维度的断言（见 T26）。
      { label: "allow=[*]（显式全开）", filter: toolFilterOf({ toolsAllow: ["*"], toolsDeny: [] }, 1) },
      { label: "allow=[首个用户工具]", filter: toolFilterOf({ toolsAllow: [first], toolsDeny: [] }, 1) },
      { label: "deny=[首个用户工具]", filter: toolFilterOf({ toolsAllow: ["*"], toolsDeny: [first] }, 1) },
      { label: "allow=null（全禁）", filter: toolFilterOf({ toolsAllow: null, toolsDeny: [] }, 0) },
    ];

    // ⚠️ 每组判据都必须**真的产生收窄**，否则「双向成立」是平凡结论（空集也能全绿）。
    //    · allow=[*]：语义上「不限制」，不收窄 —— 它的作用是证明
    //      「不放宽」与「清单=执行」在无收窄时也一致；
    //    · allow=[首个用户工具] / deny=[首个用户工具] / allow=null：收窄后清单里的
    //      **用户工具数**必须严格小于全集的用户工具数（用用户工具计数，避免被不受过滤的元工具干扰）。
    //      allow=null 在新语义下应为 0。
    const narrowCases = new Set(["allow=[首个用户工具]", "deny=[首个用户工具]", "allow=null（全禁）"]);
    const noNarrowCases = new Set(["allow=[*]（显式全开）"]);

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
      // 新语义的硬断言：null 必须与 [] 同义 → 一个用户工具都不剩
      if (label === "allow=null（全禁）") {
        expect(listedUserCount).toBe(0);
      }

      for (const name of universe) {
        // [D-16 方案②] 跳过元工具：它不受 allow/deny 约束（豁免），
        //   纳入「4 组判据」的双向枚举只会因豁免而误报。它是否追加由 T26 单独验。
        if (isMeta(name)) continue;
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
    });
  }, 60_000);
});

describe("T21 不传 opts 时行为逐字节不变", () => {
  test("getToolDefinitions() === getToolDefinitions(undefined)（且均不含元工具）", () => {
    // ⚠️ 必须在同一个「全组开启」上下文内比较，否则两边都是空清单 → 平凡相等（假绿）。
    // [D-16 方案②] 「不传 opts」的含义现在更明确：不知道技能数 ⇒ skillCount 缺省 0
    //   ⇒ **不追加元工具**。这是刻意的保守方向（漏传只会少给元工具）。
    //   故本用例不再拿 baseline（含元工具）做全等比较，改为：
    //     ① 两个「不传 opts」的调用彼此逐字节相同（这条与改造前一致）；
    //     ② 二者的用户工具部分与 baseline 的用户工具部分相同（元工具除外）；
    //     ③ 二者都不含元工具。
    withAllToolsOn(() => {
      const a = getToolDefinitions();
      const b = getToolDefinitions(undefined);
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      // ② 用户工具部分与基线一致（元工具是唯一允许的差异）
      expect(a.map((d) => d.function.name).filter((n) => !isMeta(n)))
        .toEqual(userNames);
      // ③ 无 opts ⇒ 无元工具
      expect(a.some((d) => isMeta(d.function.name))).toBe(false);
      // 额外的非空性断言：防止上面几条在「全空」时也成立
      expect(baseline.length).toBeGreaterThan(0);
      expect(userNames.length).toBeGreaterThan(0);
    });
  });
});

describe("T22 只收窄、不放宽", () => {
  test("任意判据下的清单都是缺省清单的子集（含 deny 与降级）", () => {
    // ⚠️ 必须在全开上下文内：否则缺省清单为空，子集断言平凡成立（假绿）
    withAllToolsOn(() => {
    const all = new Set(universe);
    const filters: ToolFilter[] = [
      // ⚠️ BR-1 后 null = 全禁，不再是「不限制的基准」。
      //    这条继续保留是有意的：它验证「null 的清单也是全集的子集」（而不是空集以外的东西）。
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
});

describe("T23 降级全拒绝", () => {
  test("denyAllToolFilter()：用户工具全部不在清单，且执行报 tool_not_allowed", async () => {
    // ⚠️ 必须在全开上下文内：降级要验的是「agent 判据把已开启的工具全拒」，
    //    若组本身就是关的，清单为空与 denies 无关，用例失去意义。
    await withAllToolsOnAsync(async () => {
      const listed = visibleNames(denyAllToolFilter());
      for (const name of userNames) {
        expect(listed.has(name)).toBe(false);
        expect(await codeOf(name, denyAllToolFilter())).toBe("tool_not_allowed");
      }
    });
  }, 60_000);
});

describe("T24 / T25 未注册名的报错码", () => {
  test("T24 未注册名 + 容器不放行 → tool_not_allowed（不是 tool_not_found）", async () => {
    // 未注册名的判定顺序（未授权先于不存在）与组开关无关，但仍放进上下文，
    // 保持与其它用例同口径、避免将来实现调整后出现口径分歧。
    await withAllToolsOnAsync(async () => {
      expect(await codeOf("local__not_exist__x", denyAllToolFilter())).toBe("tool_not_allowed");
    });
  });

  test("T25 未注册名 + 容器缺省 → tool_not_found（未被吞掉）", async () => {
    await withAllToolsOnAsync(async () => {
      expect(await codeOf("local__not_exist__x", undefined)).toBe("tool_not_found");
    });
  });
});

describe("T26 元工具 skill__get_l2 的条件性追加（D-16 方案②）", () => {
  test("skillCount ≥ 1 → 追加；skillCount = 0 / 缺省 → 不追加；降级 → 不追加", () => {
    // 背景：skill__get_l2 的唯一用途是读技能 L2 手册。该 agent 没有任何技能时，
    //   它照旧出现在清单里等于给模型一个点了必然报错的入口，
    //   也与 BR-1「仅在配置中列出了的才可用」相悖。故改为「至少 1 个技能才追加」。
    withAllToolsOn(() => {
      const metaName = (list: { function: { name: string } }[]) =>
        list.map((d) => d.function.name).filter(isMeta);

      // ① 有 1 个技能 → 追加，且恰好 1 条（不因多次调用累积重复）
      const withSkill = metaName(getToolDefinitions(ALL_ON_FILTER));
      expect(withSkill).toEqual([L2_TOOL_VISIBLE_NAME]);

      // ② skillCount: 0 → 不追加
      expect(metaName(getToolDefinitions({ ...ALL_ON_FILTER, skillCount: 0 }))).toEqual([]);

      // ③ 缺省（不填 skillCount）→ 不追加。这是刻意的保守方向：
      //    漏传只少给元工具，不会凭空空出一张工具面。
      //    用解构剔除 skillCount（而不是手写对象字面量），以确保这条真的在验「缺省」，
      //    且仍然走构造函数的产物。
      const { skillCount: _omit, ...filterNoCount } = ALL_ON_FILTER;
      expect(metaName(getToolDefinitions(filterNoCount))).toEqual([]);

      // ④ 降级（denyAllToolFilter）自带 skillCount: 0 → 不追加
      expect(metaName(getToolDefinitions(denyAllToolFilter()))).toEqual([]);

      // ⑤ 用户工具面不受此条件影响（元工具之外完全一致）
      const stripMeta = (l: { function: { name: string } }[]) =>
        l.map((d) => d.function.name).filter((n) => !isMeta(n));
      expect(stripMeta(getToolDefinitions(ALL_ON_FILTER)))
        .toEqual(stripMeta(getToolDefinitions({ ...ALL_ON_FILTER, skillCount: 0 })));
    });
  });
});
