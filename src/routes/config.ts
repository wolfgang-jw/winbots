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
import { listJsonCandidateKeys, readUnmapped } from "@/infra/envJson";
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
  refreshManagedValues, isToggleOn, groupState,
  type SettingDef,
} from "@/infra/settings";
import { hasManagedPrefix, isSensitiveName, pathSegments } from "@/tools/paths";
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
      on: isToggleOn(rec.toggleKey),
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
  // [skill / C-21] 强制刷新取值缓存，避免「保存后仍显示旧值」
  refreshManagedValues(true);
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
    /** 工具区：按目录层级缩进的树（§11） */
    toolTree: buildToolTree(reg),
    skillTree: buildSkillTree(sreg),
    skillScanVersion: sreg.version,
    skillWarnings: sreg.warnings,
    /** 底部遗留键区块的数据（§10.2） */
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
      refreshManagedValues(true);
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

  /* ③ 开关：先在「本次提交后的状态」上算 delta，再校验门禁 */
  const delta = new Map<string, boolean>();
  const prospectiveOn = (key: string): boolean =>
    (delta.has(key) ? (delta.get(key) as boolean) : isToggleOn(key));

  if (body.dirToggles !== undefined) {
    const map = asObject(body.dirToggles);
    if (!map) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "dirToggles 必须为对象" }, 400);
    for (const [path, v] of Object.entries(map)) {
      const dir = reg.dirs.get(path);
      if (!dir || path === "") { pushInvalid(path, "未知目录节点"); continue; }
      if (typeof v !== "boolean") { pushInvalid(path, "开关值必须为布尔"); continue; }
      if (dir.suspend) { pushInvalid(path, "该目录加载失败，不可操作"); continue; }
      if (v && !parentChainOn(reg, path, prospectiveOn)) {
        pushInvalid(path, "上级目录已关闭，不能开启（父关时全部子孙关闭且不可操作）");
        continue;
      }
      delta.set(dir.toggleKey, v);
    }
  }

  if (body.groupToggles !== undefined) {
    const map = asObject(body.groupToggles);
    if (!map) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "groupToggles 必须为对象" }, 400);
    for (const [gid, v] of Object.entries(map)) {
      const g = reg.groups.get(gid);
      if (!g) { pushInvalid(gid, "未知工具组"); continue; }
      if (typeof v !== "boolean") { pushInvalid(gid, "开关值必须为布尔"); continue; }
      if (g.suspend) { pushInvalid(gid, "该工具组已挂起（加载失败），不可开启"); continue; }
      if (v && !parentChainOn(reg, `${g.dirPath}/x`, prospectiveOn)) {
        // 后端独立复查（§3.5）：祖先目录在「提交后状态」下必须全开
        pushInvalid(gid, "上级目录已关闭，不能开启该工具组");
        continue;
      }
      delta.set(g.toggleKey, v);
    }
  }

  /* [skill / §12.2、N-SK-5] 技能开关：键空间独立（SKILLON__），没有祖先继承（N-SK-6） */
  if (body.skillToggles !== undefined) {
    const mapS = asObject(body.skillToggles);
    if (!mapS) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "skillToggles 必须为对象" }, 400);
    const sregP = getSkillRegistry();
    for (const [dir, v] of Object.entries(mapS)) {
      const recS = sregP.skills.get(dir);
      if (!recS) { pushInvalid(dir, "未知技能（不在本次扫描结果内，请点「刷新」后重试）"); continue; }
      if (typeof v !== "boolean") { pushInvalid(dir, "开关值必须为布尔"); continue; }
      // 挂起技能只允许「关」：关 = 删键（回到默认关闭），不涉及任何门禁放松
      if (recS.status === "suspended" && v) { pushInvalid(dir, "该技能已挂起（声明不合法），不可开启"); continue; }
      delta.set(recS.toggleKey, v);
    }
  }

  /* ④ 设置项取值（写入端校验：类型 / 范围 / 枚举 / 成对约束） */
  if (body.settings !== undefined) {
    const map = asObject(body.settings);
    if (!map) return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "settings 必须为对象" }, 400);
    for (const [key, raw] of Object.entries(map)) {
      // [skill / N-2] 先工具、再 skill：SKILLSET__* 只在 skill 注册表里
      const def = defOf(key);
      if (!def) { pushInvalid(key, "未知或未声明的设置项"); continue; }

      // §9.1「拒绝敏感名称」的写入期一道（R-11 定稿，纵深防御）：
      //   扫描期已就该拦的拦过一次；这里防「声明被绕过 / 新增键忘了标 secret」。
      //   只作用于工具设置项：唯一的系统密钥项 LLM_API_KEY 由 CONFIG_KEYS 的 type:"secret" 管。
      if (isSensitiveName(key) && def.secret !== true) {
        pushInvalid(key, "键名形似密钥，但该设置项未声明 secret: true；请在代码声明处补 secret（或改名）");
        continue;
      }

      // 数组类型允许前端直接给数组；其余一律按字符串
      const text = def.kind === "string_array" && Array.isArray(raw)
        ? JSON.stringify(raw)
        : String(raw ?? "").trim();
      if (def.kind !== "string_array" && /[\r\n]/.test(text)) { pushInvalid(key, "值不能包含换行符"); continue; }

      const parsed = parseSettingValue(def, text);
      if (!parsed.ok) { pushInvalid(key, parsed.reason); continue; }

      // §7.2 成对约束：依赖项取值不在允许集合内时，不允许把本项写成非默认值
      if (def.dependsOn) {
        // [skill / C-13] owner 也要兜底到 skill 注册表：settingOwners 只由工具扫描构建
        const owner = reg.settingOwners.get(key) ?? skillSettingOwnerOf(key);
        const sibling = owner ? [...owner.entries()].find(([n]) => n === def.dependsOn?.name) : undefined;
        const siblingKey = sibling?.[1].key;
        const siblingDef = sibling?.[1].def;
        if (!siblingKey || !siblingDef) {
          pushInvalid(key, `成对约束指向的设置项不存在：${def.dependsOn.name}`);
          continue;
        }
        const pending = typeof map[siblingKey] === "string" ? (map[siblingKey] as string) : undefined;
        const siblingText = pending ?? currentSettingText(siblingKey) ?? defaultValueText(siblingDef);
        const siblingParsed = parseSettingValue(siblingDef, siblingText);
        const siblingValue = siblingParsed.ok ? String(siblingParsed.value) : String(siblingDef.default);
        if (!def.dependsOn.equals.includes(siblingValue)) {
          pushInvalid(key, `该值仅在「${def.dependsOn.name}」为 ${def.dependsOn.equals.join(" / ")} 时有意义`);
          continue;
        }
      }

      const outText = formatSettingValue(def, parsed.value);
      if (outText === defaultValueText(def)) deletes.push(key);   // §9.1：值等于默认值 → 删键
      else writes[key] = outText;
    }
  }

  /* ⑤ 恢复默认（显式删键；等价于把该项改回默认值） */
  if (body.restore !== undefined) {
    if (!Array.isArray(body.restore) || body.restore.some((x) => typeof x !== "string")) {
      return c.json({ ok: false, code: "ERR_INVALID_VALUE", error: "restore 必须为字符串数组" }, 400);
    }
    for (const key of body.restore as string[]) {
      // 设置项与开关都支持「恢复默认」：开关的默认值恒为 false（§8.2），删键即回到关闭
      const isSetting = defOf(key) !== undefined;
      const isToggle = key.startsWith("TOOLON__") && reg.registeredKeys.has(key);
      if (!isSetting && !isToggle) { pushInvalid(key, "未知或未声明的设置项 / 开关"); continue; }
      delete writes[key];
      deletes.push(key);        // 删键 → 回到初始默认（关闭 / 声明里的默认值）
    }
  }

  /* ⑥ 开关 delta 转写盘动作：默认值是常量 false（§8.2），所以「开 → 写 true / 关 → 删键」
   *    正好等价于 §9.1 的「值等于默认值即删键」，不需要再查任何「生效默认值」。
   */
  for (const [key, on] of delta) {
    if (on) {
      writes[key] = "true";
      const i = deletes.indexOf(key);
      if (i >= 0) deletes.splice(i, 1);       // 同一次提交里既 restore 又显式开启 → 以开启为准
    } else {
      delete writes[key];
      deletes.push(key);                      // 关 = 回到默认值 = 删键
    }
  }

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

  /* ⑧ 生效：先刷工具取值缓存（含「删键即恢复默认」），再热更进程内配置（白名单=系统项） */
  refreshManagedValues(true);
  // [§9.1] 白名单 = 系统项 ∪ 本次扫描注册键；托管键不进进程环境（由取值层读 env.json 的 tools 块）
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
  refreshManagedValues(true);
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
