/**
 * src/routes/skills.ts
 * 技能的只读查询接口（配置页「预览」与「清单」用，§11 / §12.5 / C-6）。
 *
 *   GET /api/skills/list                        → 精简清单（激活项下拉 + 挂起原因 + 怎么改）
 *   GET /api/skills/preview?name=examples/log_triage[&agent=default]
 *                                               → L0 / L1 / L2 实际注入文本 + 必须工具 + 可见工具
 *
 * 安全：只读。不写 .env、不执行工具。
 * ⚠️ 返回的 title / summary / l1 / l2 均来自用户磁盘文件（不可信文本），
 *    前端必须用 textContent 渲染（§12.4 第 3 条）。
 *
 * ⚠️ [升级版 §3.5 / R1] 预览里的**两个工具栏不可混用**：
 *   · tools        = 本技能 frontmatter 声明的「必须工具」，逐条带可用性（可为空数组）；
 *   · visibleTools = 模型**实际可见**的工具 = getToolDefinitions() 全量（含元工具），
 *                    与「开了哪些技能」无关。
 *   早期实现把 visibleTools 塞进了 tools 栏（用 applyToolWhitelist 收窄），造成两个错：
 *     ① 技能没声明 tools 时（如 hello）白名单短路返回**全量**，被渲染成
 *        「本技能声明的必须工具」，与实际（不依赖任何工具）相反；
 *     ② 声明了 tools 时显示收窄后的交集，与运行时的全量下发**不一致**（预览谎报行为）。
 *   现在 tools 栏直接取 rec.tools 并做可用性判定，visibleTools 栏单独给出全量清单。
 *
 * ⚠️ [工具/技能配置归位 setup.json] 与上一版的重要差异：
 *   工具组开关 / 技能开关 / 工具设置项已改为**每个 agent 一份**（setup.json），
 *   由 AsyncLocalStorage 承载；**无上下文 = 全关**（保守降级）。
 *   因此 visibleTools 与 requiredTools.available 都不再是「与 agent 无关的全局量」：
 *     · 传了 ?agent=<path> → 在该 agent 的上下文里算，语义 =「该 agent 实际会看到什么」；
 *     · 没传              → 无法判定，visibleTools 返回 null 并给出 visibleToolsNote，
 *                           requiredTools.available 一律 false 且 detail 说明原因。
 *                           **绝不**用空数组冒充（那等于谎报「看不到任何工具」）。
 */
import { Hono } from "hono";
import {
  ensureSkillRegistry, getSkillRegistry, previewSkill, checkRequiredTools,
  SKILL_NAME_PATTERN,
} from "@/skills";
import { ensureToolRegistry, getToolDefinitions } from "@/tools";
import { getRegistry } from "@/tools/scan";
import { agentToolConfigOf, getAgentRegistry, filterSkillsForAgent } from "@/agents";
import type { AgentRecord } from "@/agents";
import type { AgentToolConfig } from "@/infra/toolConfigContext";
import { runWithAgentToolConfig } from "@/infra/toolConfigContext";

/**
 * 按 agent 的目录路径（如 "default"）构造它的工具配置快照。
 *
 * 用途：/preview?agent=… 需要回答「这个 agent 实际能看到哪些工具」，
 *   而工具开关是每 agent 一份（ALS 承载），所以必须先把该 agent 的
 *   setup.json 翻译成快照，才能在其上下文里取清单。
 *
 * ⚠️ 只读预览用途：不建立会话绑定、不写任何文件。
 * ⚠️ 找不到 / 配置不可信 → 返回 ok:false（调用方转成「无法判定」说明），
 *    不抛异常、也不静默降级成全开。
 */
function buildAgentToolConfigByPath(
  agentPath: string,
): { ok: true; cfg: AgentToolConfig; rec: AgentRecord } | { ok: false; error: string } {
  const reg = getAgentRegistry();
  const uid = reg.byPath.get(agentPath);
  const rec = uid === undefined ? undefined : reg.agents.get(uid);
  if (!rec) return { ok: false, error: `agent 不存在：${agentPath}` };
  // 配置不可信的 agent（scan 时已判 invalid）不参与预览，避免拿半解析结果误导人
  if (rec.status !== "ok") {
    return {
      ok: false,
      error: `agent 配置不可用：${agentPath}（${rec.invalidReason ?? "配置无效"}）`,
    };
  }

  const toolReg = getRegistry();
  const skillReg = getSkillRegistry();
  return {
    ok: true,
    cfg: agentToolConfigOf(
      rec,
      [...toolReg.groups.values()].map((g) => ({
        id: g.id, dirPath: g.dirPath, fileBase: g.fileBase, visiblePrefix: g.visiblePrefix,
      })),
      [...toolReg.dirs.values()].map((d) => ({
        path: d.path, groups: [...d.groups], children: [...d.children],
      })),
      [...skillReg.skills.values()].map((s) => s.dir),
    ),
    // [D-16 方案②] 一并回传 record：preview 要用它算「该 agent 实际可用技能数」，
    //   以决定元工具 skill__get_l2 是否应出现在 visibleTools 里（与主链路同口径）。
    rec,
  };
}

// ⚠️ 改造后**不再**有「全局技能开关」：技能是否可用由某个 agent 的 setup.json 决定，
//    而本文件本身不持有 agent 上下文（只有 /preview 带 ?agent= 时才临时建立）。
//    因此 /list 不再回 `on` 字段。

const router = new Hono();

/**
 * [skill / C-25] 两个接口都先 ensureToolRegistry() 再 ensureSkillRegistry({ force: true })：
 *   ① 扫描层明确要求工具注册表就绪，否则本轮跳过扫描（failed: true）；
 *   ② 预览必须反映**磁盘现在的内容** —— 只加 HTTP no-store 不够，
 *      ensureSkillRegistry() 在「指纹未变」时复用内存注册表，
 *      而预览场景恰恰可能是「改完 md 立刻点预览」（指纹变了，但 ready 且 inflight 复用旧值的窗口）。
 *      这两个接口只由配置页调用，重扫成本可接受。
 */
async function scanNow(): Promise<void> {
  await ensureToolRegistry();
  await ensureSkillRegistry({ force: true });
}

router.get("/list", async (c) => {
  await scanNow();
  const reg = getSkillRegistry();
  c.header("Cache-Control", "no-store");
  return c.json({
    ok: true,
    skillScanVersion: reg.version,
    skills: [...reg.skills.values()]
      .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
      .map((r) => ({
        dir: r.dir,
        name: r.name,
        title: r.title,
        summary: r.summary,
        // ⚠️ 已移除 `on` 字段：改造后没有「全局技能开关」，
        //    某个技能对某个 agent 是否可用，只能在该 agent 的 setup.json 里看。
        status: r.status,
        // reason 是可读文案，code 单独给出便于前端判断
        reason: r.suspend ? r.suspend.reason : null,
        code: r.suspend ? r.suspend.code : null,
        hint: r.suspend ? r.suspend.hint : null,
      })),
    warnings: reg.warnings,
  });
});

router.get("/preview", async (c) => {
  await scanNow();
  // 预览内容会随 SKILL.md 变化，必须禁缓存，否则改完 md 看到的还是旧预览
  c.header("Cache-Control", "no-store");
  const name = (c.req.query("name") || "").trim();
  if (name === "") return c.json({ ok: false, error: "缺少 name 参数" }, 400);
  // 形状校验：让 400 的语义更准确，也避免把奇怪输入带进注册表查询
  if (!SKILL_NAME_PATTERN.test(name)) {
    return c.json({ ok: false, error: "name 形状不合法（应为 examples/log_triage 这样）" }, 400);
  }
  const p = previewSkill(name);
  if (!p.found) return c.json({ ok: false, error: `skill 不存在：${name}` }, 404);
  const toolReg = getRegistry();

  /* ── ① 必须工具 / ② 可见工具：两者都依赖 groupState（= 读 ALS 里的 agent 配置）──
        所以它们必须在**同一个 agent 上下文**里算，不能一个在外一个在内。 */

  /** 该技能 frontmatter 里**真正声明**的必须工具（callName 口径） */
  const required = p.tools;

  type RequiredTool = {
    call: string;
    visibleName: string | null;
    available: boolean;
    kind: string | null;
    detail: string | null;
  };

  let requiredTools: RequiredTool[] = [];
  let visibleTools: string[] | null = null;
  let visibleToolsNote: string | null = null;

  /** 在 agent 上下文内真正求值（available 才有意义） */
  const computeAll = (rec: AgentRecord): void => {
    // ① 必须工具：逐条查注册表 + groupState
    const un = checkRequiredTools(required);
    const unMap = new Map(un.map((u) => [u.call, u]));
    requiredTools = required.map((call) => {
      const bad = unMap.get(call);
      return {
        call,
        visibleName: toolReg.tools.get(call)?.visibleName ?? null,
        available: !bad,
        kind: bad ? bad.kind : null,
        detail: bad ? bad.detail : null,
      };
    });
    // ② 可见工具：**全组开启**时的工具全集 ∪ 条件性元工具（仅作对照，不是该 agent 的白名单结果）。
    //   ⚠️ 这里刻意传 `allows: () => true`：preview 的用途是「这个技能需要哪些工具、它们健康吗」，
    //      它回答的是「若开关都开着，模型能看到什么」。若改成按该 agent 的 toolsAllow 收窄，
    //      一个 `allow: ["local__*"]` 的 agent 预览某个依赖 internet 的技能时会看到空清单，
    //      反而看不出「是工具没开还是被白名单挡了」。要看某 agent 的**真实**工具面，
    //      用 `/api/agents`（含 toolsAllow）或聊天页的 T-VIS 日志。
    //   ⚠️ 唯一与主链路同口径的部分是 skillCount：元工具是否追加必须一致，
    //      否则 preview 会展示一个模型其实拿不到的 skill__get_l2。
    //   [D-16 方案②] 元工具只在「该 agent 至少 1 个可用技能」时出现，
    //     故这里必须与 chat.ts 用同一口径（filterSkillsForAgent 数技能），
    //     否则 preview 会展示一个模型其实拿不到的 skill__get_l2。
    const usableSkills = [...getSkillRegistry().skills.values()].map((s) => ({
      dir: s.dir,
      name: s.dir.split("/").pop() ?? s.dir,
    }));
    const skillCount = filterSkillsForAgent(rec, usableSkills).length;
    visibleTools = getToolDefinitions({ toolsAllow: null, toolsDeny: [], allows: () => true, skillCount })
      .map((d) => d.function.name);
  };

  /** 无法判定时：不谎报「可用」，也不谎报「工具坏了」 */
  const markUnknown = (note: string): void => {
    requiredTools = required.map((call) => ({
      call,
      visibleName: toolReg.tools.get(call)?.visibleName ?? null,
      available: false,
      kind: null,
      detail: note,
    }));
  };

  const agentPath = (c.req.query("agent") || "").trim();
  if (agentPath === "") {
    visibleToolsNote =
      "未指定 agent，无法判定实际可见工具（工具开关是每个 agent 一份）。请加 ?agent=<path>。";
    markUnknown(visibleToolsNote);
  } else {
    const cfgR = buildAgentToolConfigByPath(agentPath);
    if (!cfgR.ok) {
      visibleToolsNote = cfgR.error;
      markUnknown(cfgR.error);
    } else {
      runWithAgentToolConfig(cfgR.cfg, () => computeAll(cfgR.rec));
    }
  }

  return c.json({
    ok: true,
    l0: p.l0,
    l1: p.l1,
    l2: p.l2,
    truncated: p.truncated,
    sessionChars: p.sessionChars,
    omitted: p.omitted,
    status: p.status,
    reason: p.reason,
    hint: p.hint,
    // 「本技能声明的必须工具」（空数组 = 不依赖任何工具，如 hello）
    tools: requiredTools,
    // 「模型实际可见工具」（全量 ∪ 元工具），仅作对照
    //   ⚠️ 指定了 ?agent= 才有值；null = 无法判定（见 visibleToolsNote）。
    //      前端必须区分「null（不知道）」与「[]（确实是空）」。
    visibleTools,
    visibleToolsNote,
  });
});

export default router;
