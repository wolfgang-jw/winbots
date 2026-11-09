/**
 * src/tools/scan.ts
 * 工具目录扫描与注册表（规范 §4 / §5 / §6 / §10）。
 *
 * 职责：
 *   1. 目录树遍历 + 命名筛选（不合规忽略并告警，不替换字符）
 *   2. 入口文件加载（路径 + mtime 后缀，破除模块缓存 → 入口文件热更新）
 *   3. 设置项声明规范化与校验（不合规 → 所属组/目录整体挂起）
 *   4. 键生成 + 全库撞键检测（小写比较）
 *   5. 可见名与键长上限校验
 *   6. 目录指纹、扫描版本标识、遗留键计算
 *
 * 依赖约定（勿破）：本文件对 index.ts / settings.ts **只允许 import type**；
 *   需要触发迁移的地方由 src/tools/index.ts 负责（避免 settings.ts ↔ scan.ts 静态环）。
 */

import { existsSync, readdirSync, statSync } from "fs";
import type { Dirent } from "fs";
import { extname, join, relative } from "path";
import { pathToFileURL } from "url";
import type { Tool } from "./index";
import type { SettingDef, SettingKind } from "@/infra/settings";
import { listJsonCandidateKeys, listUnmappedKeys } from "@/infra/envJson";
import {
  DIR_SETTINGS_FILE, MAX_DIR_DEPTH, MAX_KEY_LEN, MAX_VISIBLE_NAME_LEN,
  TOOLS_ROOT, checkName, computeVersion, dirSettingKey, dirToggleKey,
  groupSettingKey, groupToggleKey, hashText, hasManagedPrefix, isSensitiveName,
  pathSegments, visibleNamePrefix,
} from "./paths";

/* ============================================================
 * 类型
 * ============================================================ */

export type SuspendCode =
  | "load_failed"        // 入口 / 声明文件加载抛错
  | "no_tools_export"    // 入口没有导出 tools 数组
  | "invalid_tool"       // Tool 契约或工具名不合法
  | "invalid_key"        // 设置项键名或定义不合法
  | "key_too_long"       // 键名超过 MAX_KEY_LEN
  | "key_collision"      // 撞键
  | "visible_name_too_long"; // 可见名超过 MAX_VISIBLE_NAME_LEN

export const SUSPEND_LABEL: Record<SuspendCode, string> = {
  load_failed: "入口加载失败",
  no_tools_export: "入口未导出 tools 数组",
  invalid_tool: "工具结构或工具名不合法",
  invalid_key: "设置项键名或定义不合法",
  key_too_long: "键名超过长度上限",
  key_collision: "键名与其他节点撞键",
  visible_name_too_long: "可见名超过长度上限",
};

export interface Suspend {
  code: SuspendCode;
  reason: string;
}

export interface SettingEntry {
  key: string;
  def: SettingDef;
}

/** 目录节点（根目录 path === ""，root 没有开关） */
export interface DirRecord {
  path: string;
  name: string;
  depth: number;
  toggleKey: string;                     // 根为 ""
  settings: Map<string, SettingEntry>;   // 键名 → { 完整键, 定义 }
  children: string[];                    // 子目录 path
  groups: string[];                      // 直属组 id
  ignored: Array<{ name: string; reason: string }>; // 命名不合规被忽略的子项（页面可展示原因）
  suspend: Suspend | null;
}

export interface GroupItem {
  name: string;          // 工具叶子名（≠ 组 id）
  callName: string;      // local.shell.run（内部名 / 展示名）
  visibleName: string;   // local__shell__run（模型可见名）
  tool: Tool;
}

export interface GroupRecord {
  id: string;            // "local/shell"（根级入口为 "shell"）
  dirPath: string;       // "local"（根级为 ""）
  fileBase: string;      // "shell"
  file: string;          // "local/shell.ts"（相对 TOOLS_ROOT）
  visiblePrefix: string; // "local__shell"
  toggleKey: string;     // TOOLON__local__shell
  items: GroupItem[];
  settings: Map<string, SettingEntry>;
  suspend: Suspend | null;
}

export interface ToolRecord {
  callName: string;
  visibleName: string;
  groupId: string;
  tool: Tool;
}

export interface Registry {
  fingerprint: string;
  version: string;
  scannedAt: number;
  dirs: Map<string, DirRecord>;
  groups: Map<string, GroupRecord>;
  /** 可执行工具（仅「未挂起组」的工具；开关状态在执行时实时复查） */
  tools: Map<string, ToolRecord>;
  /** 可见名 → 内部名（含已关闭 / 挂起组：历史记录里的旧名仍要能读回可读名） */
  wireToCall: Map<string, string>;
  /** 键 → 定义（仅未挂起的节点；读取未声明的键必须抛错，§3.1） */
  settingDefs: Map<string, SettingDef>;
  /** 键 → 所属节点的设置项表（用于解析 dependsOn 的同级键，§7.2 成对约束） */
  settingOwners: Map<string, Map<string, SettingEntry>>;
  /** 本次扫描注册的键（写入白名单 / 遗留键判据，§9.1 / §10.1） */
  registeredKeys: Set<string>;
}

/* ============================================================
 * 目录指纹（§4.1）
 * ============================================================ */

export interface FileStamp {
  rel: string;      // 相对 TOOLS_ROOT，正斜杠
  mtimeMs: number;  // 取整
  size: number;
}

/** 遍历 etc/tools 下全部 .ts 文件（跳过 . 开头的目录，如 .trash） */
export function walkTsFiles(): FileStamp[] {
  const out: FileStamp[] = [];
  const stack: string[] = [TOOLS_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;              // 读不到就跳过：单点失败不扩散（§3.6）
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (extname(e.name) !== ".ts") continue;
      try {
        const st = statSync(abs);
        out.push({
          rel: relative(TOOLS_ROOT, abs).replace(/\\/g, "/"),
          mtimeMs: Math.floor(st.mtimeMs),
          size: st.size,
        });
      } catch {
        /* 单文件 stat 失败：忽略该文件（不会进入指纹，也不会被扫描） */
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 目录指纹：文件集合 + mtime + size（加 size 是为了兜住「同一毫秒内二次修改」） */
export function computeFingerprint(files: FileStamp[] = walkTsFiles()): string {
  return hashText(files.map((f) => `${f.rel}|${f.mtimeMs}|${f.size}`).join("\n"));
}

/* ============================================================
 * 模块加载（入口文件热更新，§4.3）
 * ============================================================ */

/**
 * 以「路径 + mtime」为 URL 加载模块。
 *
 * ⚠️ 必须用 pathToFileURL 生成 URL，不能直接拼 `${absPath}?v=${mtime}`：
 *    Windows 下 absPath 含反斜杠（`C:\...\browser.ts`），直接当 URL 会被解析成相对路径 /
 *    非法转义，import 会失败或加载到意料之外的文件（见代码改动文档 R-1）。
 *    私有模块（`_` 前缀）由入口文件以相对路径 import，URL 不带版本 → 走模块缓存 → 不热更（§4.3）。
 */
async function importModule(absPath: string): Promise<Record<string, unknown>> {
  let mtime = 0;
  try {
    mtime = Math.floor(statSync(absPath).mtimeMs);
  } catch {
    /* 取不到 mtime：仍按无后缀加载 */
  }
  const url = `${pathToFileURL(absPath).href}?v=${mtime}`;
  return (await import(url)) as Record<string, unknown>;
}

/* ============================================================
 * 声明校验
 * ============================================================ */

function isValidToolShape(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.description === "string" &&
    !!o.parameters && typeof o.parameters === "object" &&
    typeof o.handler === "function"
  );
}

function checkDefaultValue(kind: SettingKind, v: unknown): string | null {
  switch (kind) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? null : "default 必须为数值";
    case "boolean":
      return typeof v === "boolean" ? null : "default 必须为布尔值";
    case "string":
      return typeof v === "string" ? null : "default 必须为字符串";
    case "string_array":
      return Array.isArray(v) && v.every((x) => typeof x === "string")
        ? null
        : "default 必须为字符串数组";
    default:
      return "kind 不受支持";
  }
}

/**
 * 设置项定义校验（§7.2）：默认值必填、类型仅标量或字符串数组、
 * 嵌套对象 / 其他复合类型直接拒载（返回原因 → 调用方把所属节点整体挂起）。
 */
function validateDefinition(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "定义必须为对象";
  const d = v as Record<string, unknown>;
  const kind = d.kind;
  if (kind !== "string" && kind !== "number" && kind !== "boolean" && kind !== "string_array") {
    return "kind 只能是 string / number / boolean / string_array（不支持嵌套对象与其他复合类型）";
  }
  if (d.default === undefined) return "缺少 default（默认值必填且只读）";
  const badDefault = checkDefaultValue(kind, d.default);
  if (badDefault) return badDefault;
  if (d.secret !== undefined && typeof d.secret !== "boolean") return "secret 必须为布尔值";
  if (d.desc !== undefined && typeof d.desc !== "string") return "desc 必须为字符串";
  if (kind === "number") {
    if (d.min !== undefined && typeof d.min !== "number") return "min 必须为数值";
    if (d.max !== undefined && typeof d.max !== "number") return "max 必须为数值";
    const n = d.default as number;
    if (typeof d.min === "number" && n < d.min) return "default 小于 min";
    if (typeof d.max === "number" && n > d.max) return "default 大于 max";
    if (typeof d.min === "number" && typeof d.max === "number" && d.min > d.max) return "min 不得大于 max";
  }
  if (kind === "string" && d.options !== undefined) {
    if (!Array.isArray(d.options) || d.options.some((x) => typeof x !== "string")) {
      return "options 必须为字符串数组";
    }
    if (!(d.options as string[]).includes(d.default as string)) return "default 不在 options 候选中";
  }
  if (d.dependsOn !== undefined) {
    const dep = d.dependsOn as Record<string, unknown>;
    if (
      !dep || typeof dep.name !== "string" ||
      !Array.isArray(dep.equals) || dep.equals.some((x) => typeof x !== "string")
    ) {
      return "dependsOn 必须形如 { name: string, equals: string[] }";
    }
  }
  return null;
}

interface NormalizedSettings {
  map: Map<string, SettingEntry>;
  errors: string[];
}

/**
 * 把入口文件 / 目录声明文件的 `settings` 导出规范化；errors 非空即表示「该节点整体不可用」（§5 末段）
 *
 * §9.1「拒绝敏感名称」在**这里**做第一道（R-11 定稿）：名字形似密钥却没标 `secret: true`，
 * 说明作者漏了声明 —— 属于「声明不合法」，与其它违规同样挂起该节点，而不是等到用户点保存才 400。
 */
function normalizeSettings(raw: unknown, keyOf: (name: string) => string): NormalizedSettings {
  const map = new Map<string, SettingEntry>();
  const errors: string[] = [];
  if (raw === undefined) return { map, errors };            // 未声明设置项：正常
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("settings 必须是以键名为属性名的普通对象");
    return { map, errors };
  }
  const seen = new Set<string>();
  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    const nm = checkName(name);
    if (!nm.ok) {
      errors.push(`键名 ${name} 不合规：${nm.reason}`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      errors.push(`同一文件内键名重复：${name}`);
      continue;
    }
    seen.add(name.toLowerCase());
    const bad = validateDefinition(def);
    if (bad) {
      errors.push(`键 ${name} 定义不合法：${bad}`);
      continue;
    }
    const fullKey = keyOf(name);
    // §9.1「拒绝敏感名称」的扫描期一道（R-11 定稿）：
    //   形似密钥 + 未标 secret → 声明有误，挂起该节点（配置页会显示原因，作者一看就懂）
    if (isSensitiveName(fullKey) && (def as SettingDef).secret !== true) {
      errors.push(`键 ${name} 名形似密钥，但定义里没有 secret: true（完整键：${fullKey}）`);
      continue;
    }
    map.set(name, { key: fullKey, def: def as SettingDef });
  }
  return { map, errors };
}

/* ============================================================
 * 扫描
 * ============================================================ */

function depthOf(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyDirRecord(path: string, name: string, depth: number): DirRecord {
  return {
    path, name, depth,
    toggleKey: path === "" ? "" : dirToggleKey(path),
    settings: new Map(), children: [], groups: [], ignored: [], suspend: null,
  };
}

export function emptyRegistry(fingerprint = ""): Registry {
  return {
    fingerprint,
    version: computeVersion(fingerprint, []),
    scannedAt: Date.now(),
    dirs: new Map<string, DirRecord>([["", emptyDirRecord("", "", 0)]]),
    groups: new Map(),
    tools: new Map(),
    wireToCall: new Map(),
    settingDefs: new Map(),
    settingOwners: new Map(),
    registeredKeys: new Set(),
  };
}

/** dirPath → "local.internet" 形式（内部调用名用点号，与改造前完全一致） */
function nsPrefixOf(dirPath: string): string {
  return dirPath === "" ? "" : `${pathSegments(dirPath).join(".")}.`;
}

/** 单次扫描：全部数据先在本地构造，成功后才由调用方整体替换（§4.4） */
export async function scanOnce(fingerprint: string, files: FileStamp[]): Promise<Registry> {
  const dirs = new Map<string, DirRecord>([["", emptyDirRecord("", "", 0)]]);
  const groups = new Map<string, GroupRecord>();
  const warnings: string[] = [];

  /* ① 目录集合（只由文件路径推导，空目录不建节点） */
  const dirPaths = new Set<string>([""]);
  for (const f of files) {
    const segs = f.rel.split("/");
    segs.pop();
    let acc = "";
    for (const s of segs) {
      acc = acc === "" ? s : `${acc}/${s}`;
      dirPaths.add(acc);
    }
  }

  /* ② 自顶向下建目录节点：名称不合规 / 层级超限 → 整棵子树忽略（§4.2） */
  const ordered = [...dirPaths].sort(
    (a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const path of ordered) {
    if (path === "") continue;
    const name = path.split("/").pop() as string;
    const depth = depthOf(path);
    const parentPath = path.split("/").slice(0, -1).join("/");
    const parent = dirs.get(parentPath);
    if (!parent || parent.suspend) {
      warnings.push(`目录 ${path} 的上级不可用，整棵子树已忽略`);
      continue;
    }
    const nm = checkName(name);
    if (!nm.ok) {
      parent.ignored.push({ name, reason: `目录名不合规：${nm.reason}` });
      warnings.push(`目录 ${path} 命名不合规（${nm.reason}），整棵子树已忽略`);
      continue;
    }
    if (depth > MAX_DIR_DEPTH) {
      parent.ignored.push({ name, reason: `层级超过上限 ${MAX_DIR_DEPTH}` });
      warnings.push(`目录 ${path} 层级超过上限 ${MAX_DIR_DEPTH}，整棵子树已忽略`);
      continue;
    }
    dirs.set(path, emptyDirRecord(path, name, depth));
    parent.children.push(path);
  }

  /* ③ 目录声明文件（不存在 = 正常状态，§7.3） */
  for (const rec of [...dirs.values()]) {
    if (rec.path === "" || rec.suspend) continue;
    const abs = join(TOOLS_ROOT, rec.path, DIR_SETTINGS_FILE);
    if (!existsSync(abs)) continue;
    try {
      const mod = await importModule(abs);
      const { map, errors } = normalizeSettings(mod.settings, (n) => dirSettingKey(rec.path, n));
      if (errors.length > 0) {
        rec.suspend = { code: "invalid_key", reason: errors.join("；") };
        console.warn(
          `⚠️  [scan] 目录声明文件有误（${rec.path}/${DIR_SETTINGS_FILE}）：${errors.join("；")}；` +
          `该目录及其子级全部不可用`,
        );
      } else {
        rec.settings = map;
      }
    } catch (err) {
      rec.suspend = { code: "load_failed", reason: errText(err) };
      console.warn(`⚠️  [scan] 目录声明文件加载失败（${rec.path}/${DIR_SETTINGS_FILE}）：${errText(err)}`);
    }
  }

  /* ④ 入口文件 */
  for (const f of files) {
    const segs = f.rel.split("/");
    const fileName = segs.pop() as string;
    const dirPath = segs.join("/");
    const dir = dirs.get(dirPath);
    if (!dir || dir.suspend) continue;
    if (extname(fileName) !== ".ts") continue;       // 保险：指纹只收集 .ts，这里再挡一次
    if (fileName.startsWith("_")) continue;          // 私有资产：不导入、不进配置页（§4.2）
    const fileBase = fileName.slice(0, -3);
    const nm = checkName(fileBase);
    if (!nm.ok) {
      dir.ignored.push({ name: fileName, reason: nm.reason });
      warnings.push(`入口文件 ${f.rel} 命名不合规（${nm.reason}），已忽略`);
      continue;
    }

    const id = dirPath === "" ? fileBase : `${dirPath}/${fileBase}`;
    const rec: GroupRecord = {
      id, dirPath, fileBase, file: f.rel,
      visiblePrefix: visibleNamePrefix(dirPath, fileBase),
      toggleKey: groupToggleKey(dirPath, fileBase),
      items: [], settings: new Map(), suspend: null,
    };

    let mod: Record<string, unknown>;
    try {
      mod = await importModule(join(TOOLS_ROOT, f.rel));
    } catch (err) {
      rec.suspend = { code: "load_failed", reason: errText(err) };
      // [§11] 挂起的组也必须挂到目录下：配置页要能灰显它并给出「加载失败原因」
      dir.groups.push(id);
      groups.set(id, rec);
      console.warn(`⚠️  [scan] 入口文件加载失败（${f.rel}）：${errText(err)}；该组已挂起`);
      continue;
    }

    /* ④-a 工具：契约、工具名、组内重名、可见名长度 */
    const list = mod.tools;
    if (!Array.isArray(list)) {
      rec.suspend = { code: "no_tools_export", reason: "入口文件未导出 tools 数组" };
      // [§11] 挂起的组也必须挂到目录下：配置页要能灰显它并给出「加载失败原因」
      dir.groups.push(id);
      groups.set(id, rec);
      console.warn(`⚠️  [scan] ${f.rel} 未导出 tools 数组，该组已挂起`);
      continue;
    }
    const items: GroupItem[] = [];
    const toolProblems: string[] = [];
    const seenTool = new Set<string>();
    const nsPrefix = nsPrefixOf(dirPath);
    for (const raw of list) {
      if (!isValidToolShape(raw)) {
        toolProblems.push("存在不符合 Tool 契约的条目（缺 name/description/parameters/handler）");
        continue;
      }
      const tool = raw as Tool;
      // function.name 的网关约束：^[a-zA-Z0-9_-]{1,64}$
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
        toolProblems.push(`工具名不合法：${tool.name}`);
        continue;
      }
      if (seenTool.has(tool.name.toLowerCase())) {
        toolProblems.push(`同一文件内工具名重复：${tool.name}`);
        continue;
      }
      seenTool.add(tool.name.toLowerCase());
      const vis = `${rec.visiblePrefix}__${tool.name}`;
      if (vis.length > MAX_VISIBLE_NAME_LEN) {
        // §8.5：可见名超限 → 该组不可用，原因写进页面与日志；绝不截断（截断后无法反解，见 R-9）
        toolProblems.push(`可见名超长（${vis.length} > ${MAX_VISIBLE_NAME_LEN}）：${vis}`);
        continue;
      }
      items.push({
        name: tool.name,
        callName: `${nsPrefix}${fileBase}.${tool.name}`,
        visibleName: vis,
        tool,
      });
    }
    if (toolProblems.length > 0) {
      const tooLong = toolProblems.some((p) => p.includes("可见名超长"));
      rec.suspend = {
        code: tooLong ? "visible_name_too_long" : "invalid_tool",
        reason: toolProblems.join("；"),
      };
      // [§11] 挂起的组也必须挂到目录下：配置页要能灰显它并给出「加载失败原因」
      dir.groups.push(id);
      groups.set(id, rec);
      console.warn(`⚠️  [scan] ${f.rel}：${rec.suspend.reason}；该组已挂起`);
      continue;
    }
    rec.items = items;

    /* ④-b 组设置项 */
    const { map, errors } = normalizeSettings(mod.settings, (n) => groupSettingKey(dirPath, fileBase, n));
    if (errors.length > 0) {
      rec.suspend = { code: "invalid_key", reason: errors.join("；") };
      // [§11] 挂起的组也必须挂到目录下：配置页要能灰显它并给出「加载失败原因」
      dir.groups.push(id);
      groups.set(id, rec);
      console.warn(`⚠️  [scan] ${f.rel} 的设置项有误：${errors.join("；")}；该组已挂起`);
      continue;
    }
    rec.settings = map;

    groups.set(id, rec);
    dir.groups.push(id);
  }

  /* ⑤ 键长 + 撞键（§6.2：双方均不注册，且两方各自整体不可用） */
  const ownerOf = new Map<string, string>();   // 小写键 → owner id
  const collided = new Set<string>();
  const claim = (key: string, owner: string): void => {
    const low = key.toLowerCase();
    const prev = ownerOf.get(low);
    if (prev === undefined) {
      ownerOf.set(low, owner);
      return;
    }
    if (prev === owner) return;
    collided.add(prev);
    collided.add(owner);
  };

  const overlong = new Set<string>();
  for (const d of dirs.values()) {
    if (d.toggleKey !== "" && d.toggleKey.length > MAX_KEY_LEN) overlong.add(`dir:${d.path}`);
    for (const s of d.settings.values()) {
      if (s.key.length > MAX_KEY_LEN) overlong.add(`dir:${d.path}`);
      claim(s.key, `dir:${d.path}`);
    }
  }
  for (const g of groups.values()) {
    if (g.toggleKey.length > MAX_KEY_LEN) overlong.add(`group:${g.id}`);
    claim(g.toggleKey, `group:${g.id}`);
    for (const s of g.settings.values()) {
      if (s.key.length > MAX_KEY_LEN) overlong.add(`group:${g.id}`);
      claim(s.key, `group:${g.id}`);
    }
  }

  const splitOwner = (owner: string): { kind: string; id: string } => {
    const i = owner.indexOf(":");
    return { kind: owner.slice(0, i), id: owner.slice(i + 1) };
  };

  for (const owner of overlong) {
    const { kind, id } = splitOwner(owner);
    const target = kind === "dir" ? dirs.get(id) : groups.get(id);
    if (target && !target.suspend) {
      target.suspend = { code: "key_too_long", reason: `生成的键超过长度上限 ${MAX_KEY_LEN}` };
      console.warn(`⚠️  [scan] ${owner} 的键名超过 ${MAX_KEY_LEN} 字符，已挂起`);
    }
  }
  for (const owner of collided) {
    const { kind, id } = splitOwner(owner);
    const target = kind === "dir" ? dirs.get(id) : groups.get(id);
    if (target && !target.suspend) {
      // §6.2 只说「双方均不注册」；但若只丢键而保留组，该组会带着缺失的键继续运行，
      // 与 §3.1「声明即契约（未声明的键读取即报错）」冲突 → 整组挂起（见 R-7）
      target.suspend = { code: "key_collision", reason: "键名与其他节点撞键（双方均不注册）" };
      console.warn(`⚠️  [scan] ${owner} 因撞键整体挂起`);
    }
  }

  /* ⑥ 注册（仅「目录链健康 + 自身未挂起」的节点上账） */
  const tools = new Map<string, ToolRecord>();
  const wireToCall = new Map<string, string>();
  const settingDefs = new Map<string, SettingDef>();
  const settingOwners = new Map<string, Map<string, SettingEntry>>();
  const registeredKeys = new Set<string>();

  const dirHealthy = (path: string): boolean => {
    let acc = "";
    for (const seg of pathSegments(path)) {
      acc = acc === "" ? seg : `${acc}/${seg}`;
      const d = dirs.get(acc);
      if (!d || d.suspend) return false;
    }
    return true;
  };

  for (const d of dirs.values()) {
    if (!dirHealthy(d.path)) continue;
    if (d.toggleKey !== "") registeredKeys.add(d.toggleKey);
    for (const s of d.settings.values()) {
      registeredKeys.add(s.key);
      settingDefs.set(s.key, s.def);
      settingOwners.set(s.key, d.settings);
    }
  }
  for (const g of groups.values()) {
    // wireToCall 覆盖「已加载」的组（含被开关关闭的），保证历史记录里的旧名仍能显示可读名
    for (const it of g.items) wireToCall.set(it.visibleName, it.callName);
    if (g.suspend || !dirHealthy(g.dirPath)) continue;
    registeredKeys.add(g.toggleKey);
    for (const s of g.settings.values()) {
      registeredKeys.add(s.key);
      settingDefs.set(s.key, s.def);
      settingOwners.set(s.key, g.settings);
    }
    for (const it of g.items) {
      tools.set(it.callName, {
        callName: it.callName, visibleName: it.visibleName, groupId: g.id, tool: it.tool,
      });
    }
  }

  for (const w of warnings) console.warn(`⚠️  [scan] ${w}`);

  return {
    fingerprint,
    version: computeVersion(fingerprint, registeredKeys),
    scannedAt: Date.now(),
    dirs, groups, tools, wireToCall, settingDefs, settingOwners, registeredKeys,
  };
}

/* ============================================================
 * 单例与重入（§4.1）
 * ============================================================ */

let registry: Registry = emptyRegistry();
let ready = false;
let inflight: Promise<Registry> | null = null;

export function getRegistry(): Registry {
  return registry;
}

export function isRegistryReady(): boolean {
  return ready;
}

/**
 * 目录指纹校验 + 可重入扫描。
 *
 * - 指纹未变且已就绪 → 直接复用（保证每请求只有一次 readdir 量级的开销）
 * - 指纹变化 / 未就绪 → 重扫，成功后**整体替换**（§4.4）
 * - `force` → 无条件重扫（进入配置页、点刷新按钮）
 * - 并发请求共用同一次扫描（in-flight 去重，见 R-14）
 * - 扫描失败 → 清空注册表并保持「未就绪」，下次请求自动重试（保留既有「失败可重试」语义）
 */
export async function ensureRegistry(opts: { force?: boolean } = {}): Promise<Registry> {
  const files = walkTsFiles();
  const fp = computeFingerprint(files);
  if (!opts.force && ready && fp === registry.fingerprint) return registry;
  if (inflight) return inflight;

  const run = (async (): Promise<Registry> => {
    try {
      const next = await scanOnce(fp, files);
      registry = next;   // 整体替换：不保留上一轮的部分结果
      ready = true;
      console.log(
        `🔧 [scan] 注册表已更新｜版本=${next.version}｜指纹=${next.fingerprint}｜` +
        `目录节点=${next.dirs.size - 1}｜工具组=${next.groups.size}｜工具=${next.tools.size}｜键=${next.registeredKeys.size}`,
      );
      return next;
    } catch (err) {
      registry = emptyRegistry(fp);
      ready = false;
      console.error(`❌ [scan] 扫描失败，注册表已清空并将在下次请求重试：${errText(err)}`);
      return registry;
    } finally {
      inflight = null;
    }
  })();

  inflight = run;
  return run;
}

/* ============================================================
 * 遗留键（§10.1）
 * ============================================================ */

/**
 * 遗留键（§10.1）：本应被托管、但当前无人认领的键。
 *
 * 两个来源（迁移文档第零章 P1 / 4.6.5）：
 *   ① `env.json` 的 `tools` 块里、**命中托管前缀但未被本次扫描注册**的键 —— 与迁移前同口径；
 *   ② `env.json` 顶层的 `_unmapped` —— 从 `.env` 迁移时未识别的键（**不按前缀过滤**：
 *      它们本来就是「没被任何规则认领」的键，正是最需要用户核对的那批）。
 *
 * ⚠️ 顶层 `_comment` 之类的备注**不算**遗留键（方案 3.5）。
 */
export function listOrphanKeys(reg: Registry = registry): string[] {
  const registeredLower = new Set([...reg.registeredKeys].map((k) => k.toLowerCase()));
  const unmapped = new Set(listUnmappedKeys());
  const out: string[] = [];
  for (const key of listJsonCandidateKeys()) {
    // ② _unmapped：全部算遗留键（不按前缀过滤）
    if (unmapped.has(key)) { out.push(key); continue; }
    // ① tools 块：只认命中托管前缀的（用户手写的不相干键不算遗留键）
    if (!hasManagedPrefix(key)) continue;
    if (registeredLower.has(key.toLowerCase())) continue;
    out.push(key);
  }
  return [...new Set(out)].sort();
}
