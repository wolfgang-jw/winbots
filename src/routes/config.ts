/**
 * src/routes/config.ts
 * 配置读写接口（配置页唯一入口，规范 §12）
 *
 *   GET    /api/config           读取（读取前先重扫；返回系统项 / 工具树 / 遗留键 / 扫描版本）
 *   PUT    /api/config           写入（目录开关 / 组开关 / 设置项取值 / 恢复默认；校验扫描版本）
 *   POST   /api/config/refresh   刷新（强制重扫，返回新版本标识）
 *   DELETE /api/config/orphans   删除遗留键（独立接口、不备份、不参与保存流程）
 *
 * 安全：写入白名单 = 系统项 ∪ 本次扫描注册的键；值禁换行；不回显/不记录密钥明文。
 * 后端不信任前端：门禁在写入端独立复查（§3.5），前端灰显只是提示。
 *
 * [迁移文档 4.9] 迁移后本文件的对外契约**一字不变**（envPath / envExists / backupDir /
 *   items[].shadowed 全部保留），只有「取值从 .env 文本 → env.json 对象」这一层换了实现。
 */
import { Hono } from "hono";
import { existsSync } from "fs";
import { env, envShadowedBySystem, reloadEnvExcluding } from "@/infra/env";
import {
  CONFIG_KEYS, CONFIG_KEY_SET, buildConfigItems, applyConfigChanges, maskSecret,
  envPath, backupDirPath, deleteUnmappedKeys,
} from "@/infra/configFile";
// [迁移文档 4.9.3 / 第零章 P1] refresh 的残留键清理要读「env.json 的 tools 块 ∪ 顶层 _unmapped」，
//   不再有 .env 文本可解析（readEnvFile / parseEnvText 已在 4.6.2 删除）。
import {
  listJsonCandidateKeys, readUnmapped,
  LLM_NAME_RE, foldLlmName, eqLlmName, findLlmIndex, resolveDefaultLlmName,
  loadEnvJson, saveEnvJson, readEnvJsonRaw,
  type EnvJson, type LlmGroup,
} from "@/infra/envJson";
// [POST /api/config/llm] thinkingMode 的解析与 coerceLlmGroup 同源（零依赖模块）
import { parseThinkingMode } from "@/infra/thinkingMode";
// [FR-LLM-6] 删除 LLM 组前要检查「是否有 agent 引用它」——注册表是唯一权威来源
import { ensureAgentRegistry, type AgentRecord } from "@/agents";
import {
  getRegistry, listOrphanKeys, SUSPEND_LABEL,
  type DirRecord, type GroupRecord, type Registry,
} from "@/tools/scan";
/**
 * ⚠️ 用门面（src/tools/index.ts）而不是直接用 scan.ensureRegistry：
 *  门面里含「托管键缓存刷新」，保证配置页看到的开关状态是最新的。
 */
import { ensureToolRegistry } from "@/tools";
import {
  currentSettingText, defaultValueText, formatSettingValue, parseSettingValue,
  // [FIX-SKILLTOGGLE] 技能树节点的 on 必须用技能侧取值函数：
  //   工具侧 isToggleOn 查 enabledToggles（TOOLON__*），技能键 SKILLON__* 永远不在其中，
  //   会让配置页把白名单里已勾选的技能一律显示为「关闭」。
  isToggleOn, isSkillToggleOn, groupState,
  type SettingDef,
} from "@/infra/settings";
import { hasManagedPrefix, isSensitiveName, pathSegments, isReservedName } from "@/tools/paths";
import type { SettingEntry } from "@/tools/scan";
// [skill / §12.1] 技能注册表：只走门面（§1.2「只 import 门面」），不直连 skills/scan.ts
import {
  ensureSkillRegistry, getSkillRegistry, listStaleSkillKeys, listSkillDeclaredKeys,
  skillSettingKey, SKILL_SUSPEND_LABEL, checkRequiredTools,
  type SkillDirNode, type SkillRecord, type SkillRegistry,
} from "@/skills";

const router = new Hono();

/** 永远需要重启的键（APP_PORT 绑端口，origin.ts 亦在模块级构造白名单） */
const RESTART_KEYS: ReadonlySet<string> = new Set<string>(["APP_PORT"]);

/**
 * 阶段开关：false → 保存后全部改动均提示「需重启」；true → 除 APP_PORT 外热更立即生效。
 * 该常量同时是开关式回滚：改回 false 即立刻退回阶段 A 行为。
 */
const HOT_RELOAD_ENABLED: boolean = true;

function restartKeysFor(changed: string[]): string[] {
  if (!HOT_RELOAD_ENABLED) return changed;
  return changed.filter((k) => RESTART_KEYS.has(k));
}

function allRestartKeys(): ReadonlySet<string> {
  if (!HOT_RELOAD_ENABLED) return new Set(CONFIG_KEYS.map((m) => m.key));
  return RESTART_KEYS;
}

/* ============================================================
 * 视图装配（工具树，§11）
 * ============================================================ */

interface SettingView {
  key: string;
  name: string;
  kind: string;
  desc?: string;
  secret: boolean;
  defaultValue: string;
  /** 当前生效文本；secret 恒为 null（不回显明文） */
  value: string | null;
  mask?: string;
  hasValue?: boolean;
  /** 与默认值一致（= 文件中没有该键，或写了与默认值相同的值） */
  isDefault: boolean;
  min?: number;
  max?: number;
  options?: readonly string[];
  optionLabels?: Record<string, string>;
  disabled: boolean;
  reason?: string;
}

interface ToolNode {
  id: string;
  type: "dir" | "group";
  name: string;
  depth: number;
  /** 自身开关的存储值（目录根恒 true） */
  on: boolean;
  /** 门禁结果（祖先全开 + 自身开 + 未挂起） */
  available: boolean;
  /** 页面是否灰显不可操作（祖先关 / 祖先挂起 / 自身挂起） */
  disabled: boolean;
  reason?: string;
  /**
   * 自身是否挂起（加载失败 / 声明非法）。
   * ⚠️ 前端在勾选父节点后必须**就地重算**子孙门禁（不再请求接口），
   *    若拿不到「自身是否挂起」，就分不清「因为上级关闭而灰显」与「自身挂起」。
   */
  suspended: boolean;
  suspendReason?: string;
  settings: SettingView[];
  tools: Array<{ visibleName: string; name: string }>;
  ignored: Array<{ name: string; reason: string }>;
  children: ToolNode[];
}

/* ============================================================
 * [skill / N-2、C-13] 设置项 def 与 dependsOn owner 的双注册表兜底
 * ============================================================ */

/** [skill] 从 skill 注册表查设置项定义（挂起 skill 的 settings 是空 Map → 自然查不到） */
function skillDefOf(key: string): SettingDef | undefined {
  for (const rec of getSkillRegistry().skills.values()) {
    for (const [name, def] of rec.settings) {
      if (skillSettingKey(rec.dir, name) === key) return def;
    }
  }
  return undefined;
}

/** [skill] 统一取 def：先工具、再 skill（两套注册表键前缀不同，互不覆盖） */
function defOf(key: string): SettingDef | undefined {
  return getRegistry().settingDefs.get(key) ?? skillDefOf(key);
}

/**
 * [skill / C-13] `dependsOn` 的 owner（同级设置项表）。
 * `reg.settingOwners` 只由**工具**扫描构建，`SKILLSET__*` 在里面永远查不到。
 */
function skillSettingOwnerOf(key: string): Map<string, SettingEntry> | undefined {
  if (!key.startsWith("SKILLSET__")) return undefined;
  const rest = key.split("__").slice(1);
  const dirSegs = rest.slice(0, -1);            // 最后一段是设置项名，不是目录
  if (dirSegs.length === 0) return undefined;
  const reg = getSkillRegistry();
  for (let cut = dirSegs.length; cut >= 1; cut--) {
    const rec = reg.skills.get(dirSegs.slice(0, cut).join("/"));
    if (!rec) continue;
    const owner = new Map<string, SettingEntry>();
    for (const [name, def] of rec.settings) {
      owner.set(name, { key: skillSettingKey(rec.dir, name), def });
    }
    return owner;
  }
  return undefined;
}

/**
 * [skill / C-22] 遗留键 = `listOrphanKeys(reg)` 减去「存活技能声明的键」。
 *
 * 为什么不在 tools/scan.ts 里改：`tools/paths.ts` / `tools/scan.ts` 是零业务底座，
 * 而 `skills/scan.ts` 反过来要 import `@/tools/scan`，让 tools 侧认 skill 键就成环（§1.2）。
 *
 * [C-3.1 实测缺陷] 还要再减去「本次扫描已注册的工具键」：
 *   `listOrphanKeys` 会把顶层 `_unmapped` 的键一并列出（这是对的，它们是候选残留），
 *   但用户可能手工把某个**合法工具键**写进了 `_unmapped`。这类键：
 *     · 出现在待删除列表里 → 用户勾得上；
 *     · DELETE /orphans 又会以 ERR_NOT_ORPHAN 整批拒绝 → 点了必失败，其余可删键也被连坐。
 *   列表即真相：这里直接不列出来，避免「列出但删不掉」。
 */
function listOrphanKeysExcludingSkills(reg: Registry, sreg: SkillRegistry): string[] {
  const declared = new Set(listSkillDeclaredKeys(sreg).map((k) => k.toLowerCase()));
  const registered = new Set([...reg.registeredKeys].map((k) => k.toLowerCase()));
  return listOrphanKeys(reg).filter(
    (k) => !declared.has(k.toLowerCase()) && !registered.has(k.toLowerCase()),
  );
}

function settingView(key: string, name: string, def: SettingDef, disabled: boolean): SettingView {
  const raw = currentSettingText(key);
  const dtext = defaultValueText(def);
  const isDefault = raw === undefined || raw === dtext;
  const view: SettingView = {
    key, name, kind: def.kind, desc: def.desc,
    secret: def.secret === true,
    defaultValue: dtext,
    value: def.secret === true ? null : (raw ?? dtext),
    isDefault,
    min: def.min, max: def.max, options: def.options, optionLabels: def.optionLabels,
    disabled,
  };
  if (def.secret === true) {
    view.mask = maskSecret(raw ?? "");
    view.hasValue = raw !== undefined && raw !== "";
  }
  return view;
}

/**
 * 目录链的状态（含 dirPath 本身及其全部祖先）：
 *   null            = 全开
 *   "dir_off"       = 某层被关闭
 *   "dir_suspended" = 某层挂起（声明/加载失败）
 */
function dirChainState(
  reg: Registry,
  dirPath: string,
  on: (key: string) => boolean,
): null | "dir_off" | "dir_suspended" {
  let acc = "";
  for (const seg of pathSegments(dirPath)) {
    acc = acc === "" ? seg : `${acc}/${seg}`;
    const d = reg.dirs.get(acc);
    if (!d || d.suspend) return "dir_suspended";
    if (!on(d.toggleKey)) return "dir_off";
  }
  return null;
}

/** 目录节点的**祖先链**状态（不含自身） */
function parentChainState(
  reg: Registry,
  path: string,
  on: (key: string) => boolean,
): null | "dir_off" | "dir_suspended" {
  const segs = path.split("/").filter((s) => s.length > 0);
  segs.pop();
  return dirChainState(reg, segs.join("/"), on);
}

function parentChainOn(reg: Registry, path: string, on: (key: string) => boolean): boolean {
  return parentChainState(reg, path, on) === null;
}

function buildToolTree(reg: Registry): ToolNode[] {
  const buildGroup = (gid: string, chainOn: boolean): ToolNode => {
    const g = reg.groups.get(gid) as GroupRecord;
    const disabled = !chainOn || g.suspend !== null;
    const suspendText = g.suspend
      ? `加载失败：${SUSPEND_LABEL[g.suspend.code]}（${g.suspend.reason}）`
      : undefined;
    return {
      id: gid,
      type: "group",
      name: `${g.fileBase}.ts`,
      depth: g.dirPath === "" ? 1 : g.dirPath.split("/").length + 1,
      on: isToggleOn(g.toggleKey),
      available: groupState(gid).available,
      disabled,
      suspended: g.suspend !== null,
      suspendReason: suspendText,
      reason: suspendText ?? (chainOn ? undefined : "上级目录已关闭"),
      settings: [...g.settings.entries()].map(([name, s]) => settingView(s.key, name, s.def, disabled)),
      tools: g.items.map((it) => ({ visibleName: it.visibleName, name: it.name })),
      ignored: [],
      children: [],
    };
  };

  const buildDir = (path: string): ToolNode => {
    const d = reg.dirs.get(path) as DirRecord;
    const chain = parentChainState(reg, path, isToggleOn);
    const selfOn = isToggleOn(d.toggleKey);
    const disabled = chain !== null || d.suspend !== null;
    const suspendText = d.suspend
      ? `加载失败：${SUSPEND_LABEL[d.suspend.code]}${d.suspend.reason ? `（${d.suspend.reason}）` : ""}`
      : undefined;
    return {
      id: path,
      type: "dir",
      name: d.name,
      depth: d.depth,
      on: selfOn,
      available: !disabled && selfOn,
      disabled,
      suspended: d.suspend !== null,
      suspendReason: suspendText,
      reason: suspendText ?? (chain === "dir_suspended" ? "上级目录不可用"
        : chain === "dir_off" ? "上级目录已关闭"
          : undefined),
      settings: [...d.settings.entries()].map(([name, s]) => settingView(s.key, name, s.def, disabled)),
      tools: [],
      ignored: d.ignored,
      children: d.children.map(buildDir).concat(d.groups.map((gid) => buildGroup(gid, !disabled && selfOn))),
    };
  };

  const root = reg.dirs.get("");
  const rootGroups = (root?.groups ?? []).map((gid) => buildGroup(gid, true));
  // [§11] 根级入口文件的组同样要显示
  return [...(root?.children ?? []).map(buildDir), ...rootGroups];
}

/* ============================================================
 * [skill / §12.1] skillTree：与 toolTree 并列返回
 * ============================================================ */

interface SkillNode {
  key: string;
  segment: string;
  dir: string;
  isSkill: boolean;
  on: boolean;
  status: "ok" | "suspended";
  reason: string | null;
  hint: string | null;
  title: string;
  summary: string;
  settings: SettingView[];
  extraFiles: string[];
  ignored: Array<{ name: string; reason: string }>;
  /** [升级版 §3.3] 必须工具中当前不可用的 callName 列表（空 = 全部可用） */
  unavailableTools: string[];
  /** [升级版 §3.3] 一行「怎么改」提示；无不可用项时为 null */
  unavailableHint: string | null;
  children: SkillNode[];
}

function skillSettingsView(rec: SkillRecord, disabled: boolean): SettingView[] {
  return [...rec.settings.entries()].map(([name, def]) =>
    settingView(skillSettingKey(rec.dir, name), name, def, disabled),
  );
}

function buildSkillTree(sreg: SkillRegistry): SkillNode[] {
  const buildSkill = (rec: SkillRecord): SkillNode => {
    const dis = rec.status === "suspended";
    // [升级版 §4.4 风险 3] 这里**只读**、不回填：回填留给装配路径（assembleForRequestMulti），
    //   配置页不能顺手改注册表状态（否则「打开配置页」会改运行时可见性）。
    const unavail = rec.status === "ok" ? checkRequiredTools(rec.tools) : [];
    return {
      key: rec.toggleKey,
      segment: rec.name,
      dir: rec.dir,
      isSkill: true,
      // [FIX-SKILLTOGGLE] 技能侧取值（enabledSkillToggles），不能用工具侧 isToggleOn
      on: isSkillToggleOn(rec.toggleKey),
      status: rec.status,
      reason: rec.suspend ? SKILL_SUSPEND_LABEL[rec.suspend.code] : null,
      hint: rec.suspend ? rec.suspend.hint : null,
      title: rec.title,
      summary: rec.summary,
      settings: skillSettingsView(rec, dis),
      extraFiles: rec.extraFiles,
      ignored: [],
      // [升级版 §3.3] 装配期的同一套判定（checkRequiredTools）在此复用：口径一致，
      //   让「配置页为什么这个技能没生效」与「运行时 notice」说得是同一件事。
      unavailableTools: unavail.map((u) => u.call),
      unavailableHint: unavail.length > 0
        ? `必须工具不可用：${unavail.map((u) => `${u.call}（${u.detail}）`).join("；")}`
        : null,
      children: [],
    };
  };

  const buildDirNode = (path: string): SkillNode => {
    const d = sreg.dirs.get(path);
    if (!d) {
      return {
        key: "", segment: path, dir: path, isSkill: false, on: false, status: "ok",
        reason: null, hint: null, title: "", summary: "", settings: [],
        extraFiles: [], ignored: [], unavailableTools: [], unavailableHint: null, children: [],
      };
    }
    return {
      key: "",
      segment: d.name,
      dir: path,
      isSkill: false,
      on: false,
      status: "ok",
      reason: null,
      hint: null,
      title: "",
      summary: "",
      settings: [],
      extraFiles: d.extraFiles,
      ignored: d.ignored,
      unavailableTools: [],
      unavailableHint: null,
      children: [
        ...d.children.map(buildDirNode),
        ...d.skills
          .map((dir) => sreg.skills.get(dir))
          .filter((r): r is SkillRecord => r !== undefined)
          .map(buildSkill),
      ],
    };
  };

  const root = sreg.dirs.get("");
  return (root?.children ?? []).map(buildDirNode);
}

/* ============================================================
 * GET /api/config —— 读取前先重扫（§4.1 / §12）
 * ============================================================ */

router.get("/", async (c) => {
  // §4.1 进入配置页即重扫
  // [skill] 技能扫描要读工具注册表判断 unknown_tool，所以必须排在工具扫描之后
  await ensureToolRegistry({ force: true });
  await ensureSkillRegistry({ force: true });

  const reg = getRegistry();
  const sreg = getSkillRegistry();
  const items = buildConfigItems(
    allRestartKeys(),
    envShadowedBySystem,
    HOT_RELOAD_ENABLED
      ? ((k: string) => (env as unknown as Record<string, unknown>)[k])
      : undefined,
  );
  c.header("Cache-Control", "no-store");   // 防浏览器缓存导致「保存后仍显示旧值」
  return c.json({
    ok: true,
    envPath: envPath(),
    envExists: existsSync(envPath()),
    backupDir: backupDirPath(),
    restartRequiredKeys: [...allRestartKeys()],
    hotReloadEnabled: HOT_RELOAD_ENABLED,
    /** 系统配置项（保持不变的表单语义） */
    items,
    /** 扫描版本标识：PUT 必须原样带回（§9.3） */
    scanVersion: reg.version,
    /* [工具/技能配置归位 setup.json] `toolTree` / `skillTree` / `skillScanVersion` /
     * `skillWarnings` 已删除：工具开关、工具设置项、技能开关不再有「全局一份」的来源，
     * 它们现在属于各 agent 的 setup.json，改由「智能体编辑」弹窗（GET /api/agents/meta/options）
     * 读取与修改。本接口只保留系统项（env.json 的 app / log / stab / llm）。 */
    /** 底部遗留键区块的数据（§10.2）：D-4 决定保留，供人工清理 _unmapped */
    orphanKeys: listOrphanKeysExcludingSkills(reg, sreg),
  });
});

/* ============================================================
 * POST /api/config/refresh —— 强制重扫（§12「刷新」）
 * ============================================================ */

router.post("/refresh", async (c) => {
  // 先工具后技能（技能扫描要读工具注册表判断 unknown_tool）
  await ensureToolRegistry({ force: true });
  await ensureSkillRegistry({ force: true });
  const _s = getSkillRegistry();
  const reg = getRegistry();

  // [skill / §6.5、C-9] 只清理「磁盘上已不存在 SKILL.md」的 skill 键；挂起但存在的 skill 键不删
  //   ⚠️ 迁移后（4.9.3）「文件里的全部键」= env.json 的 tools 块 ∪ 顶层 _unmapped
  const allKeys = new Set<string>(listJsonCandidateKeys());
  const staleR = listStaleSkillKeys([...allKeys], _s);
  const cleanedR: string[] = [];
  if (staleR.length > 0) {
    const resR = applyConfigChanges({ changes: {}, deleteKeys: staleR, allowDeleteKeys: new Set(staleR) });
    if (resR.ok) {
      cleanedR.push(...resR.deleted);
    } else {
      console.warn("⚠️  [skill] 残留键清理失败：" + String(resR.error ?? ""));
    }
  }
  return c.json({
    ok: true,
    scanVersion: reg.version,
    toolTree: buildToolTree(reg),
    skillScanVersion: _s.version,
    skillWarnings: _s.warnings,
    cleanedSkillKeys: cleanedR,
    skillTree: buildSkillTree(_s),
    orphanKeys: listOrphanKeysExcludingSkills(reg, _s),
  });
});

/* ============================================================
 * PUT /api/config —— 三类变更 + 恢复默认（§12）
 * ============================================================ */

router.put("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, code: "ERR_ILLEGAL_CHARS", error: "请求体不是合法 JSON" }, 400);
  }

  // ① 硬前置：confirm === true（沿用既有确认约定）
  if (body.confirm !== true) {
    return c.json({ ok: false, code: "ERR_NO_CONFIRM", error: "修改配置需显式确认（confirm: true）" }, 400);
  }

  // [skill / C-14] 先保证技能注册表就绪：PUT 可能先于任何 GET 到达（脚本 / 直接 curl）。
  //   若不先扫描，skillKeys 为空 → SKILLON__ / SKILLSET__ 被判「未知配置项」→ 整单 400。
  await ensureToolRegistry();
  await ensureSkillRegistry();

  // ② 扫描版本校验（§9.3）：不一致即拒绝，避免基于过期键集合写入
  const reg = getRegistry();
  const scanVersion = typeof body.scanVersion === "string" ? body.scanVersion : "";
  if (scanVersion !== reg.version) {
    return c.json({
      ok: false, code: "ERR_SCAN_STALE",
      error: "扫描版本已过期（工具目录有变化或页面停留过久），请点「刷新」后重新提交",
    }, 409);
  }

  const writes: Record<string, string> = {};
  const deletes: string[] = [];
  /* ③ [工具/技能配置归位 setup.json] dirToggles / groupToggles / settings / skillToggles / restore
   *    —— 这五类字段已**整体迁移到各 agent 的 setup.json**（见代码文档 4.9②）。
   *    出现即 400，且**不静默忽略**：静默忽略会让人以为「保存成功」，
   *    实际改动一个字都没写进磁盘。前端（配置页）已删除这些控件，正常不会触发。
   */
  const MIGRATED_FIELDS = ["dirToggles", "groupToggles", "settings", "skillToggles", "restore"] as const;
  const hitMigrated = MIGRATED_FIELDS.filter(
    (f) => body[f] !== undefined && body[f] !== null,
  );
  if (hitMigrated.length > 0) {
    return c.json(
      {
        ok: false,
        code: "ERR_MIGRATED_TO_AGENT",
        error:
          `工具/技能配置（${hitMigrated.join(" / ")}）已迁移到各智能体的 setup.json，` +
          "请在「智能体编辑」弹窗中修改该智能体的工具配置与技能配置。",
        migratedFields: [...hitMigrated],
      },
      400,
    );
  }

  const invalid: Array<{ key: string; reason: string }> = [];
  const pushInvalid = (key: string, reason: string): void => { invalid.push({ key, reason }); };

  const asObject = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

  /* ① 系统项 */
  if (body.changes !== undefined) {
    const changes = asObject(body.changes);
    if (!changes) return c.json({ ok: false, code: "ERR_EMPTY_CHANGES", error: "changes 必须为对象" }, 400);
    for (const [k, v] of Object.entries(changes)) {
      if (!CONFIG_KEY_SET.has(k)) { pushInvalid(k, "未知配置项（不在系统白名单内）"); continue; }
      if (typeof v !== "string") { pushInvalid(k, "配置值必须为字符串"); continue; }
      if (/[\r\n]/.test(v)) { pushInvalid(k, "值不能包含换行符"); continue; }
      const meta = CONFIG_KEYS.find((m) => m.key === k);
      if (!meta) { pushInvalid(k, "未知配置项（不在系统白名单内）"); continue; }
      if (meta.secret && v.trim() === "") continue;        // 密钥留空 = 不修改（AC-CFG-4）
      writes[k] = v.trim();
    }
  }

  // ② 系统密文清空项：必须走 applyConfigChanges 的 clearKeys 通道（R-17）。
  //    不能塞进 changes 写空串——changes 会先过 validateValue，密文空串被判「不能为空」导致整个保存 400。
  const clearList: string[] = [];
  if (body.clear !== undefined) {
    if (!Array.isArray(body.clear) || body.clear.some((x) => typeof x !== "string")) {
      return c.json({ ok: false, code: "ERR_INVALID_CLEAR", error: "clear 必须为字符串数组" }, 400);
    }
    for (const k of new Set((body.clear as string[]).map((x) => x.trim()).filter((x) => x !== ""))) {
      if (!CONFIG_KEY_SET.has(k)) { pushInvalid(k, "只有系统密文项支持清空（工具设置项请用「恢复默认」）"); continue; }
      clearList.push(k); // 白名单与「仅密文项可清空」在写入端独立复查（§3.5）
    }
  }

  /* ③（已删除）：dirToggles / groupToggles / skillToggles 的处理已整体移除，
   *   见上方 ERR_MIGRATED_TO_AGENT 拦截。这里不再计算 delta / prospectiveOn。 */

  /* ③/④/⑤/⑥（已删除）：工具设置项（settings）、开关 delta、restore 全部迁移到 setup.json，
   *   已在上方由 ERR_MIGRATED_TO_AGENT 拦截。此处只剩系统项（changes / clear）走 env.json。
   */

  if (invalid.length > 0) {
    const fields: Record<string, string> = {};
    for (const it of invalid) fields[it.key] = it.reason;
    return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "存在不合法变更", fields }, 400);
  }
  if (Object.keys(writes).length === 0 && deletes.length === 0 && clearList.length === 0) {
    return c.json({ ok: false, code: "ERR_EMPTY_CHANGES", error: "没有实际改动（密钥留空视为不修改）" }, 400);
  }

  /* ⑦ 写盘（一次原子写入；白名单 = 系统项 ∪ 本次扫描注册键 ∪ skill 键） */
  const skillKeysW = new Set<string>();
  for (const recW of getSkillRegistry().skills.values()) {
    skillKeysW.add(recW.toggleKey);
    for (const nameW of recW.settings.keys()) skillKeysW.add(skillSettingKey(recW.dir, nameW));
  }
  const result = applyConfigChanges({
    changes: writes, clearKeys: clearList,
    deleteKeys: deletes,
    allowedKeys: new Set([...reg.registeredKeys, ...skillKeysW]),
  });
  if (!result.ok) {
    if (result.invalid) {
      const fields: Record<string, string> = {};
      for (const it of result.invalid) fields[it.key] = it.reason;
      return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "存在不合法配置值", fields }, 400);
    }
    return c.json({ ok: false, code: "ERR_WRITE_FAILED", error: result.error || "写入 env.json 失败" }, 500);
  }

  /* ⑧ 生效：热更进程内配置（白名单=系统项）。
   *   ⚠️ 不再有 refreshManagedValues()：工具/技能配置已不在 env.json，
   *      也就没有「全局托管键缓存」可刷；每个请求按所绑 agent 的 record 构造上下文。
   */
  const reload = HOT_RELOAD_ENABLED
    ? reloadEnvExcluding(["APP_PORT"], reg.registeredKeys)
    : { applied: [] as string[], skipped: [] as string[], managed: [] as string[] };

  const writtenSystem = result.written.filter((k) => CONFIG_KEY_SET.has(k));
  return c.json({
    ok: true,
    scanVersion: reg.version,
    /** 已写入（§11 保存结果提示第一类） */
    written: result.written,
    /** 已恢复默认（键已删除）（§11 保存结果提示第二类） */
    restored: result.deleted,
    hotApplied: reload.applied,
    cleared: clearList.filter((k) => result.written.includes(k)), // cleared = 已清空的系统密文项（R-17）
    /** 名单外（用户手写、非托管前缀）的键：未进入进程配置 */
    skippedByWhitelist: reload.skipped,
    /** 托管键（工具开关 / 设置项）：不进进程环境，由取值层读 env.json 的 tools 块生效 */
    managedByValues: reload.managed,
    restartRequired: restartKeysFor(writtenSystem),
    backupFile: result.backupFile,
    envCreated: result.envCreated,
    degraded: result.degraded === true ? "写入未使用原子重命名（已回退为覆盖写）" : undefined,
  });
});

/* ============================================================
 * [FR-LLM-1~6 / BR-6] LLM 组管理：GET / PUT / DELETE /api/config/llm
 *
 * ⚠️ 这三条路由**不走** applyConfigChanges：它按扁平键名白名单遍历 CONFIG_KEYS，
 *    `llm[2].model` 没有对应键名（第 2 组起根本不在映射表里）。
 *    这里统一走 readEnvJsonRaw() → 改目标组 → saveEnvJson()，
 *    并依赖 serializeEnvJson 的「按 name 取基底」保证其他组（含未知字段）不丢（BR-5）。
 * ⚠️ 组名定位一律大小写不敏感（foldLlmName / findLlmIndex，BR-6），**未命中不回退**。
 * ============================================================ */

/** LLM 组的对前端视图（**不含 key 原文**，FR-LLM-3） */
interface LlmGroupView {
  name: string;
  base: string;
  model: string;
  thinkingMode: string;
  thinking: boolean;
  reasoningEffort: string;
  /** 密钥掩码（无值时 "****"） */
  keyMask: string;
  hasKey: boolean;
  /** 是否默认组（后端判定，前端不得按下标推断，FR-LLM-5） */
  isDefault: boolean;
}

function llmGroupView(g: LlmGroup, defaultName: string): LlmGroupView {
  return {
    name: g.name,
    base: g.base,
    model: g.model,
    thinkingMode: g.thinkingMode ?? "",
    thinking: g.thinking === true,
    reasoningEffort: g.reasoningEffort ?? "",
    keyMask: maskSecret(g.key ?? ""),
    hasKey: typeof g.key === "string" && g.key !== "",
    isDefault: eqLlmName(g.name, defaultName),
  };
}

/**
 * [FR-LLM-6 新增] `POST /api/config/llm` —— 新建一个 LLM 组。
 *
 * 文档原只列 GET/PUT/DELETE（因为 PRD 把"新增"写进了配置页功能需求）。
 * 但 PUT 的语义是「按已存在的组名改」，无法表达新增，故补一条 POST。
 * 校验：name 合法（LLM_NAME_RE + 非保留名）、**折叠后不重名**（BR-6 约束 1）、
 *       base/model/key 非空。
 */
router.post("/llm", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, code: "ERR_ILLEGAL_CHARS", error: "请求体不是合法 JSON" }, 400);
  }

  const str = (k: string): string => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const name = str("name");
  const base = str("base");
  const model = str("model");
  const key = str("key");

  if (!name) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "组名不能为空" }, 400);
  if (!LLM_NAME_RE.test(name)) {
    return c.json(
      { ok: false, code: "ERR_INVALID_NAME", error: `组名不合法：须匹配 ${LLM_NAME_RE}` },
      400,
    );
  }
  // 与 coerceLlmGroup 同口径：保留名一律拒绝（第零章 P3）
  if (isReservedName(name)) {
    return c.json(
      { ok: false, code: "ERR_INVALID_NAME", error: `「${name}」是保留名，不能作为 LLM 组名` },
      400,
    );
  }
  if (!base) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "接口地址（base）不能为空" }, 400);
  if (!model) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "模型名（model）不能为空" }, 400);
  if (!key) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "密钥（key）不能为空" }, 400);

  let envObj: EnvJson;
  try {
    envObj = loadEnvJson();
  } catch (e) {
    return c.json(
      { ok: false, code: "ERR_ENV_INVALID", error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }

  // BR-6 约束 1：拒绝「折叠后重名」（否则 main 与 Main 可共存，按名查找行为不确定）
  if (findLlmIndex(envObj, name) >= 0) {
    return c.json(
      { ok: false, code: "ERR_LLM_DUPLICATE", error: `已存在同名 LLM 组（不区分大小写）：${name}` },
      409,
    );
  }

  const group: LlmGroup = { name, base, key, model };
  const mode = str("thinkingMode");
  if (mode) {
    // 与 coerceLlmGroup 同口径：非法值回退 none，而不是把任意字符串塞进类型
    group.thinkingMode = parseThinkingMode(mode);
  }
  if (typeof body.thinking === "boolean") group.thinking = body.thinking;
  const effort = str("reasoningEffort");
  if (effort) group.reasoningEffort = effort;

  const next: EnvJson = JSON.parse(JSON.stringify(envObj));
  next.llm.push(group);
  const w = saveEnvJson(next);
  if (!w.ok) {
    return c.json({ ok: false, code: "ERR_WRITE_FAILED", error: w.error || "写入 env.json 失败" }, 500);
  }
  return c.json({ ok: true, name, backupFile: w.backupFile });
});

router.get("/llm", async (c) => {
  let j: EnvJson;
  try {
    j = loadEnvJson();
  } catch (e) {
    return c.json(
      { ok: false, code: "ERR_ENV_INVALID", error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
  // 默认组名：字段缺失/指向不存在组时，resolveDefaultLlmName / eqLlmName 不应让列表打不开，
  //   故这里宽松处理（拿不到就当没有默认组），真正的致命判定在启动期（D-1）。
  let defaultName = "";
  try {
    defaultName = resolveDefaultLlmName(j);
  } catch {
    defaultName = "";
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    ok: true,
    items: j.llm.map((g) => llmGroupView(g, defaultName)),
    /** 默认组名（原样大小写）；无有效默认组时为空串，前端据此提示"配置有误" */
    defaultLlm: j.llm.some((g) => eqLlmName(g.name, defaultName)) ? defaultName : "",
  });
});

router.put("/llm/:name", async (c) => {
  const pathName = c.req.param("name") ?? "";

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, code: "ERR_ILLEGAL_CHARS", error: "请求体不是合法 JSON" }, 400);
  }

  // ① 定位目标组（大小写不敏感，未命中 404，**不回退**到默认组）
  let envObj: EnvJson;
  try {
    envObj = loadEnvJson();
  } catch (e) {
    return c.json(
      { ok: false, code: "ERR_ENV_INVALID", error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
  const idx = findLlmIndex(envObj, pathName);
  if (idx < 0) {
    return c.json(
      { ok: false, code: "ERR_LLM_NOT_FOUND", error: `没有名为「${pathName}」的 LLM 组` },
      404,
    );
  }
  const current = envObj.llm[idx] as LlmGroup;

  // ② 请求体带 name 且与路径参数折叠后不等 → 拒绝（改名不支持，FR-LLM-4）
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string" || !eqLlmName(body.name, current.name)) {
      return c.json(
        {
          ok: false,
          code: "ERR_LLM_RENAME_FORBIDDEN",
          error: `LLM 组名不支持修改（路径「${current.name}」与请求体「${String(body.name)}」不一致）`,
        },
        400,
      );
    }
  }

  // ③ 逐字段收集变更
  const strField = (
    key: string,
    allowEmpty: boolean,
  ): { ok: true; value?: string; changed: boolean } | { ok: false; reason: string } => {
    const v = body[key];
    if (v === undefined || v === null) return { ok: true, changed: false };
    if (typeof v !== "string") return { ok: false, reason: `${key} 必须是字符串` };
    const t = v.trim();
    if (!allowEmpty && t === "") return { ok: false, reason: `${key} 不能为空` };
    return { ok: true, value: t, changed: t !== (current as unknown as Record<string, string>)[key] };
  };

  const fields: Record<string, string> = {};
  const changed: string[] = [];

  for (const key of ["base", "model"] as const) {
    const r = strField(key, false);
    if (!r.ok) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: r.reason }, 400);
    if (r.changed && r.value !== undefined) { fields[key] = r.value; changed.push(key); }
  }
  // 密钥：缺省 / 空串 = 不修改（留空语义与配置页历史行为一致）；非空 = 覆盖
  if (body.key !== undefined && body.key !== null) {
    if (typeof body.key !== "string") {
      return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "key 必须是字符串" }, 400);
    }
    if (body.key.trim() !== "") {
      fields.key = body.key.trim();
      changed.push("key");
    }
  }

  // thinkingMode / reasoningEffort：允许显式空串表示「回退默认值」
  for (const key of ["thinkingMode", "reasoningEffort"] as const) {
    const r = strField(key, true);
    if (!r.ok) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: r.reason }, 400);
    if (r.changed && r.value !== undefined) { fields[key] = r.value; changed.push(key); }
  }

  // thinking：布尔
  if (body.thinking !== undefined && body.thinking !== null) {
    if (typeof body.thinking !== "boolean") {
      return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "thinking 必须是布尔值" }, 400);
    }
    if (body.thinking !== current.thinking) { fields.thinking = String(body.thinking); changed.push("thinking"); }
  }

  if (changed.length === 0) {
    return c.json({ ok: false, code: "ERR_EMPTY_CHANGES", error: "没有实际改动（key 留空视为不修改）" }, 400);
  }

  // ④ 落盘：直接改原始对象再 saveEnvJson（serializeEnvJson 按 name 取基底保留未知字段）
  const raw = readEnvJsonRaw();
  if (!raw || !Array.isArray(raw.llm)) {
    return c.json({ ok: false, code: "ERR_ENV_INVALID", error: "env.json 的 llm 结构异常" }, 500);
  }
  const rawIdx = findLlmIndex({ ...envObj, llm: raw.llm as unknown as LlmGroup[] }, current.name);
  if (rawIdx < 0) {
    return c.json({ ok: false, code: "ERR_LLM_NOT_FOUND", error: "目标组在原始文件中消失，请刷新后重试" }, 409);
  }
  const rawGroup = (raw.llm as Record<string, unknown>[])[rawIdx] as Record<string, unknown>;
  for (const k of changed) {
    if (k === "thinking") rawGroup.thinking = body.thinking;   // 布尔，不做字符串化
    else rawGroup[k] = fields[k];
  }

  // 用「规整后的对象」落盘：saveEnvJson 的 obj 是规整结果，raw 只用于保留未知字段/备注。
  //   这里把改动同步回 envObj，保证 obj 与 raw 一致。
  const next: EnvJson = JSON.parse(JSON.stringify(envObj));
  const target = next.llm[idx] as LlmGroup & Record<string, unknown>;
  for (const k of changed) {
    if (k === "thinking") {
      target.thinking = body.thinking as boolean;
    } else if (k === "thinkingMode" || k === "reasoningEffort") {
      // 空串 = 「回退默认值」= 删掉该字段（瘦身口径：值等于默认值即不写）
      const v = fields[k];
      if (v === "" || v === undefined) delete target[k];
      else if (k === "thinkingMode") target.thinkingMode = parseThinkingMode(v);
      else target.reasoningEffort = v;
      // raw 侧同样删除空串键，避免 serializeEnvJson 以 raw 为基底时把它带回来
      if ((v === "" || v === undefined) && rawGroup) delete rawGroup[k];
    } else {
      (target as unknown as Record<string, string>)[k] = fields[k] as string;
    }
  }
  // 让 serializeEnvJson 用改过的 raw（含 unknown 字段）做基底
  const w = saveEnvJson(next, { raw: raw as Record<string, unknown> });

  if (!w.ok) {
    return c.json({ ok: false, code: "ERR_WRITE_FAILED", error: w.error || "写入 env.json 失败" }, 500);
  }

  // ⑤ 生效：改到默认组会影响 env.LLM_*，必须热更一次（APP_PORT 恒跳过）
  const isDefaultGroup = eqLlmName(current.name, (() => {
    try { return resolveDefaultLlmName(next); } catch { return ""; }
  })());
  let hotApplied: string[] = [];
  if (isDefaultGroup) {
    const reload = reloadEnvExcluding(["APP_PORT"]);
    hotApplied = reload.applied;
  }

  return c.json({
    ok: true,
    name: current.name,
    /** 本次变更摘要（不依赖 reloadEnvExcluding 的 applied：非默认组的改动不在其中） */
    changed,
    hotApplied,
    needRestart: false,
    isDefault: isDefaultGroup,
    backupFile: w.backupFile,
  });
});

router.delete("/llm/:name", async (c) => {
  const pathName = c.req.param("name") ?? "";

  let envObj: EnvJson;
  try {
    envObj = loadEnvJson();
  } catch (e) {
    return c.json(
      { ok: false, code: "ERR_ENV_INVALID", error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
  const idx = findLlmIndex(envObj, pathName);
  if (idx < 0) {
    return c.json(
      { ok: false, code: "ERR_LLM_NOT_FOUND", error: `没有名为「${pathName}」的 LLM 组` },
      404,
    );
  }
  const target = envObj.llm[idx] as LlmGroup;

  // ① D-2：只剩 1 组时不允许删（0 组 = 所有 agent 必然无效的崩溃态）
  if (envObj.llm.length <= 1) {
    return c.json(
      {
        ok: false,
        code: "ERR_LLM_LAST_GROUP",
        error: "至少需要保留 1 个 LLM 组：不允许删除最后一个组",
      },
      400,
    );
  }

  // ② 默认组受保护（改默认组后才能删）
  let defaultName = "";
  try { defaultName = resolveDefaultLlmName(envObj); } catch { defaultName = ""; }
  if (eqLlmName(target.name, defaultName)) {
    return c.json(
      {
        ok: false,
        code: "ERR_LLM_IS_DEFAULT",
        error: `「${target.name}」是默认 LLM 组，不能直接删除：请先把 app.defaultLlm 改为其他组`,
      },
      400,
    );
  }

  // ③ 引用检查：任何 agent 的 llmRef 指向它 → 拒绝并返回引用清单（FR-LLM-6）
  let referencing: AgentRecord[] = [];
  try {
    const reg = await ensureAgentRegistry({
      ...scanDepsForLlm(),
    });
    referencing = [...reg.agents.values()].filter(
      (r) => typeof r.llmRef === "string" && r.llmRef !== "" && eqLlmName(r.llmRef, target.name),
    );
  } catch (e) {
    // 注册表不可用时保守拒绝：宁可不删，也不能删掉正在被引用的组
    return c.json(
      {
        ok: false,
        code: "ERR_AGENT_REGISTRY_UNAVAILABLE",
        error: `无法检查 agent 引用（${e instanceof Error ? e.message : String(e)}），已保守拒绝删除`,
      },
      503,
    );
  }
  if (referencing.length > 0) {
    return c.json(
      {
        ok: false,
        code: "ERR_LLM_IN_USE",
        error: `「${target.name}」正被 ${referencing.length} 个智能体引用，不能删除`,
        agents: referencing.map((r) => ({ uid: r.uid, name: r.name, path: r.path, llmRef: r.llmRef })),
      },
      409,
    );
  }

  // ④ 删除并落盘
  const next: EnvJson = JSON.parse(JSON.stringify(envObj));
  next.llm = next.llm.filter((_, i) => i !== idx);
  const w = saveEnvJson(next);
  if (!w.ok) {
    return c.json({ ok: false, code: "ERR_WRITE_FAILED", error: w.error || "写入 env.json 失败" }, 500);
  }
  return c.json({ ok: true, name: target.name, remaining: next.llm.map((g) => g.name), backupFile: w.backupFile });
});

/**
 * [FR-LLM-6] 删除前的注册表刷新用 deps。
 * 与 routes/agents.ts 的 scanDeps 同口径（[BR-6] 折叠），但**不**补写 uid：
 * 配置页的删除动作不应顺手改 agent 文件。
 */
function scanDepsForLlm() {
  const names = new Set<string>();
  try {
    for (const g of loadEnvJson().llm ?? []) {
      if (g && typeof g.name === "string" && g.name !== "") names.add(foldLlmName(g.name));
    }
  } catch {
    /* ignore */
  }
  return {
    isKnownLlm: (n: string) => names.size === 0 || names.has(foldLlmName(n)),
    mintUid: false,
  };
}

/* ============================================================
 * DELETE /api/config/orphans —— 遗留键独立删除（§10.2）
 * ============================================================ */

router.delete("/orphans", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, code: "ERR_ILLEGAL_CHARS", error: "请求体不是合法 JSON" }, 400);
  }
  if (body.confirm !== true) {
    return c.json({ ok: false, code: "ERR_NO_CONFIRM", error: "删除遗留键需显式确认（confirm: true）" }, 400);
  }
  if (!Array.isArray(body.keys) || body.keys.some((x) => typeof x !== "string")) {
    return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "keys 必须为字符串数组" }, 400);
  }

  const reg = getRegistry();
  const registered = new Set([...reg.registeredKeys].map((k) => k.toLowerCase()));
  // [skill / C-22] 存活技能声明的键同样是「在用的键」，不能按遗留键删除
  const sregD = getSkillRegistry();
  for (const kd of listSkillDeclaredKeys(sregD)) registered.add(kd.toLowerCase());

  // [第零章 P1] `_unmapped` 里的键**刻意不命中** hasManagedPrefix，也不在任何白名单里，
  //   因此不能走 applyConfigChanges（会 100% 被判「不允许删除」），走 deleteUnmappedKeys。
  const unmappedSet = new Set(Object.keys(unmappedKeysSafe()));

  const targets: string[] = [];
  const unmappedTargets: string[] = [];
  // [C-3.1] 「已被本次扫描注册」的键不删，但要**跳过而不是整批 400**：
  //   否则用户一次勾了 N 个残留键，只要其中混进 1 个合法键，其余 N-1 个也一起删不掉。
  const skipped: string[] = [];
  for (const raw of body.keys as string[]) {
    const key = raw.trim();
    if (key === "") continue;
    if (registered.has(key.toLowerCase())) {
      skipped.push(key);
      continue;
    }
    if (unmappedSet.has(key)) {
      // 顶层 _unmapped：走到这里说明它未被本次扫描注册（已注册的上面已 skipped）
      unmappedTargets.push(key);
      continue;
    }
    if (!hasManagedPrefix(key)) {
      return c.json({ ok: false, code: "ERR_NOT_MANAGED_KEY", error: `不是托管键，拒绝删除：${key}` }, 400);
    }
    targets.push(key);
  }
  if (targets.length === 0 && unmappedTargets.length === 0) {
    // 全部键都被判定为「已注册」时，给出可读原因（而不是笼统的「未提供要删除的遗留键」）
    if (skipped.length > 0) {
      return c.json({ ok: false, code: "ERR_NOT_ORPHAN", error: `该键已被本次扫描注册，不能按遗留键删除：${skipped.join(", ")}` }, 400);
    }
    return c.json({ ok: false, code: "ERR_EMPTY_CHANGES", error: "未提供要删除的遗留键" }, 400);
  }

  // §10.2：删除不备份、走独立接口、不参与保存流程
  // 白名单（R-24）：遗留键按定义**不在** registeredKeys 里，只能放进 allowDeleteKeys。
  const deleted: string[] = [];
  if (targets.length > 0) {
    const res = applyConfigChanges({
      changes: {},
      deleteKeys: targets,
      allowDeleteKeys: new Set(targets),
      skipBackup: true,
    });
    if (!res.ok) {
      return c.json({ ok: false, code: "ERR_WRITE_FAILED", error: res.error || "删除失败" }, 500);
    }
    deleted.push(...res.deleted);
  }
  if (unmappedTargets.length > 0) {
    deleted.push(...deleteUnmappedKeys(unmappedTargets));
  }
  return c.json({
    ok: true,
    deleted,
    // [C-3.1] 被判定「已注册」而跳过的键：前端据此提示用户，而不是让整批失败
    skipped,
    remaining: listOrphanKeysExcludingSkills(getRegistry(), getSkillRegistry()),
  });
});

/** 顶层 `_unmapped` 的键名（读不到就返回空表：删除接口不该因为文件坏而 500，先让它能删别的） */
function unmappedKeysSafe(): Record<string, unknown> {
  try {
    return readUnmapped();
  } catch {
    return {};
  }
}

export default router;
