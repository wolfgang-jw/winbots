/**
 * src/routes/skills.ts
 * 技能的只读查询接口（配置页「预览」与「清单」用，§11 / §12.5 / C-6）。
 *
 *   GET /api/skills/list                        → 精简清单（激活项下拉 + 挂起原因 + 怎么改）
 *   GET /api/skills/preview?name=examples/log_triage → L0 / L1 / L2 实际注入文本 + 必须工具 + 可见工具
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
 */
import { Hono } from "hono";
import {
  ensureSkillRegistry, getSkillRegistry, previewSkill, checkRequiredTools,
  SKILL_NAME_PATTERN,
} from "@/skills";
import { ensureToolRegistry, getToolDefinitions } from "@/tools";
import { getRegistry } from "@/tools/scan";
import { isToggleOn } from "@/infra/settings";

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
        on: isToggleOn(r.toggleKey),
        status: r.status,
        // 与 skillTree 同口径：reason 是可读文案，code 单独给出便于前端判断
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

  /* ① 必须工具：技能 frontmatter 里**真正声明**的那些（不是全量清单）。
        p.tools 即 rec.tools（callName 口径）；visibleName 仅供展示，两条都给出便于与请求体 tools 对照。 */
  const required = p.tools;
  const un = checkRequiredTools(required);
  const unMap = new Map(un.map((u) => [u.call, u]));
  const requiredTools = required.map((call) => {
    const bad = unMap.get(call);
    return {
      call,
      visibleName: toolReg.tools.get(call)?.visibleName ?? null,
      available: !bad,
      kind: bad ? bad.kind : null,
      detail: bad ? bad.detail : null,
    };
  });

  /* ② 可见工具：模型本次实际拿到的清单 = getToolDefinitions() 全量（含元工具）。
        ⚠️ 与技能无关（§3.5），仅作对照，**不得**拿去当「必须工具」展示。 */
  const visibleTools = getToolDefinitions().map((d) => d.function.name);

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
    visibleTools,
  });
});

export default router;
