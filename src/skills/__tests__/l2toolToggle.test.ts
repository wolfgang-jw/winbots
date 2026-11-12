/**
 * src/skills/__tests__/l2toolToggle.test.ts
 * [FIX-SKILLTOGGLE] 回归测试：`skill__get_l2` 必须读**技能侧**开关集合（enabledSkillToggles）。
 *
 * 背景（实测复现的缺陷）：
 *   `skills/l2tool.ts` 曾用 `isToggleOn(rec.toggleKey)` 判开关，而 `isToggleOn` 查的是
 *   **工具侧**集合 `enabledToggles`（键为 `TOOLON__*`）。技能键 `SKILLON__*` 永远不在其中，
 *   于是：L0 系统提示里**已装配出**该技能（assemble 走 isSkillToggleOn → true），
 *   但模型一调 `skill__get_l2` 就恒返回 `skill_disabled`，并抛出误导性的
 *   「SKILLON__examples__hello=false，请到配置页开启」。
 *   同一缺陷也出现在 `routes/config.ts::buildSkillTree`，使配置页把已勾选技能显示为关闭。
 *
 * 本文件守住的断言（缺陷回归的红线）：
 *   ① 白名单命中 → resolveL2 返回正文（**不是** skill_disabled）；
 *   ② 白名单未命中 → skill_disabled；
 *   ③ 两个集合相互独立：技能键只在 enabledSkillToggles 里，绝不出现在 enabledToggles。
 *
 * 为什么放在 src/skills/__tests__：
 *   与 toolFilter.test.ts 同理，本文件需要真实注册表（`@/skills`、`@/tools` 的值导入）。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { runWithAgentToolConfig } from "@/infra/toolConfigContext";
import { isSkillToggleOn, isToggleOn } from "@/infra/settings";
import { agentToolConfigOf } from "@/agents";
import { ensureToolRegistry } from "@/tools";
import { getRegistry } from "@/tools/scan";
import { ensureSkillRegistry, getSkillRegistry } from "@/skills";
import { resolveL2 } from "@/skills/l2tool";

/** 注册表形状（与 toolFilter.test.ts 的 registryShape 同口径） */
function registryShape() {
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
 * 构造配置快照。
 * skillsAllow 传 `null` 表示「不列任何技能」（BR-2：null 与 [] 同义，均为全禁）。
 *
 * ⚠️ 第 4 参 skillDirs 必须是**真实技能目录**：agentToolConfigOf 正是靠它
 *    把 `skillsAllow` 的匹配结果翻译成 SKILLON__ 键。传空数组会让
 *    enabledSkillToggles 恒为空，测试①会假失败。
 */
function cfgWith(skillsAllow: string[] | null) {
  const { groups, dirs } = registryShape();
  const skillDirs = [...getSkillRegistry().skills.keys()].sort();
  return agentToolConfigOf(
    {
      uid: "ag_00000001",
      path: "test",
      toolsAllow: ["*"],
      toolsDeny: [],
      toolSettings: {},
      skillsAllow,
    } as never,
    groups,
    dirs,
    skillDirs,
  );
}

/** 从真实注册表里取第一个技能目录（不硬编码 examples/hello，避免夹具改名即失效） */
function firstSkillDir(): string {
  const reg = getSkillRegistry();
  const dirs = [...reg.skills.values()]
    .filter((r) => r.status === "ok")
    .map((r) => r.dir)
    .sort();
  if (dirs.length === 0) throw new Error("注册表里没有任何可用技能，无法测试");
  return dirs[0]!;
}

let skillDir = "";
let skillKey = "";

beforeAll(async () => {
  // 顺序不能反：技能注册表依赖工具注册表先就绪（checkRequiredTools 要查工具）
  await ensureToolRegistry({ force: true });
  await ensureSkillRegistry({ force: true });
  const reg = getSkillRegistry();
  skillDir = firstSkillDir();
  skillKey = reg.skills.get(skillDir)!.toggleKey;
});

describe("[FIX-SKILLTOGGLE] skill__get_l2 读技能侧开关", () => {
  test("① 白名单命中 → resolveL2 返回正文，不报 skill_disabled", () => {
    const out = runWithAgentToolConfig(cfgWith([skillDir]), () => resolveL2(skillDir));
    // 关键断言：缺陷复现时这里会是 {"ok":false,"error":{"code":"skill_disabled",...}}
    expect(out).not.toContain("skill_disabled");
    expect(out).not.toContain("未开启");
    // 通过校验后应落到「身份行 + 正文」或「没有 L2 正文」的提示，二者都是成功路径
    expect(out.length).toBeGreaterThan(0);
  });

  test("② 白名单未列该技能 → skill_disabled", () => {
    const out = runWithAgentToolConfig(cfgWith([]), () => resolveL2(skillDir));
    expect(out).toContain("skill_disabled");
  });

  test("③ 无请求上下文（降级）→ skill_disabled，绝不放行", () => {
    const out = resolveL2(skillDir);
    expect(out).toContain("skill_disabled");
  });

  test("④ 两个开关集合相互独立：技能键不进 enabledToggles", () => {
    runWithAgentToolConfig(cfgWith([skillDir]), () => {
      // 技能侧为 true
      expect(isSkillToggleOn(skillKey)).toBe(true);
      // 工具侧对同一个技能键必须为 false —— 这正是原缺陷的根源
      expect(isToggleOn(skillKey)).toBe(false);
    });
  });
});
