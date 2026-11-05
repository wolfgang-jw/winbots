/**
 * src/skills/scan.ts
 * skills 目录扫描与注册表（§5.2 / §8.1 / §8.2）。**只扫描，不注入**（S1 的边界）。
 *
 * 与 src/tools/scan.ts 的差异（§5.3 要求显式记录）：
 *   · 目录里只认 SKILL.md，**永不 import 任何文件**（md 不会被当代码执行）；
 *   · 分类目录没有开关（N-SK-6），每个 skill 只有自身一个 SKILLON__ 键；
 *   · 失败粒度是「单个 skill」，不是整棵子树（§8.1 关键设计）；
 *   · 因此 scanSkillsOnce 是**同步**函数（tools 侧是 async，因为它要 import 入口文件）。
 *
 * ⚠️ 依赖约定：只 import src/tools/scan.ts 的 getRegistry（读已注册工具名）与
 *    src/tools/paths.ts 的 checkName / hashText（零业务依赖），不做反向依赖。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import type { Dirent } from "fs";
import { join } from "path";
import type { SettingDef } from "@/infra/settings";
import { checkName, hashText } from "@/tools/paths";
import { getRegistry } from "@/tools/scan";
import {
  parseFrontmatter, type FrontmatterCode, type SkillSettingDefLike,
} from "./frontmatter";
import { missingSections, splitSections, type Section } from "./markdown";
import {
  MAX_SKILL_DEPTH, SKILL_FILE, SKILLS_ROOT,
  isSkillManagedKey, skillSettingKey, skillToggleKey,
} from "./paths";

/* ============================================================
 * 类型
 * ============================================================ */

export type SkillSuspendCode =
  | FrontmatterCode
  | "nested_skill"
  | "missing_section"
  | "key_collision";

export const SKILL_SUSPEND_LABEL: Record<SkillSuspendCode, string> = {
  parse_failed: "SKILL.md 解析失败",
  invalid_frontmatter: "frontmatter 字段不合法",
  name_mismatch: "name 与目录名不一致",
  unknown_tool: "引用了不存在的工具",
  invalid_settings: "settings 声明不合法",
  nested_skill: "子目录里存在 SKILL.md（违反 N-SK-4）",
  missing_section: "缺少必需段落（## 目标 / ## 方法）",
  key_collision: "键与其他 skill 撞键",
};

/** 挂起原因 + 具体怎么改（§11：报警必须给出「具体怎么改」） */
export const SKILL_SUSPEND_HINT: Record<SkillSuspendCode, string> = {
  parse_failed: "检查 frontmatter 的 YAML 语法：必须以单独一行 --- 开头、单独一行 --- 结束，冒号后要有空格；不支持多行块标量（| / >）与锚点。",
  invalid_frontmatter: "补齐 name / title / summary；title ≤ 20 字、summary ≤ 60 字、两者合计 ≤ 60 字。",
  name_mismatch: "把 frontmatter 的 name 改成与所在目录名完全一致。",
  unknown_tool: "到配置页「工具配置」核对调用名（形如 local.shell.run）；tools 里只能写已注册的工具。",
  invalid_settings: "按 SettingDef 补 kind 与 default；键名形似密钥时必须标 secret: true。",
  nested_skill: "本 skill 的上级目录也是一个 skill（N-SK-4 禁止嵌套）：把本目录移到纯分类目录下，或删掉本目录的 SKILL.md。",
  missing_section: "补上 `## 目标` 与 `## 方法` 两个二级标题段落（标题下必须有正文）。",
  key_collision: "检查是否两个不同目录生成了同一个 SKILLON__ / SKILLSET__ 键，改掉其中一个目录名。",
};

export interface SkillSuspend {
  code: SkillSuspendCode;
  reason: string;
  /** 配置页要展示「具体怎么改」 */
  hint: string;
}

/** 分类目录节点（不含 SKILL.md 的目录；本身无开关，N-SK-6） */
export interface SkillDirNode {
  /** 相对 SKILLS_ROOT 的路径，根为 "" */
  path: string;
  name: string;
  depth: number;
  children: string[];
  skills: string[];
  /** 目录内出现的多余文件（§4.1：忽略并告警，不影响该 skill 生效） */
  extraFiles: string[];
  /** 命名不合规 / 层级超限被忽略的子项（页面可展示原因） */
  ignored: Array<{ name: string; reason: string }>;
}

export interface SkillRecord {
  /** 相对 SKILLS_ROOT 的目录路径（= skill 身份；§4.5 name 必须等于它最后一段） */
  dir: string;
  name: string;
  depth: number;
  toggleKey: string;
  title: string;
  summary: string;
  /** 已归一为 callName（点号）；空数组 = 不收紧白名单（§7.3 第 3 条） */
  tools: string[];
  settings: Map<string, SettingDef>;
  sections: Section[];
  status: "ok" | "suspended";
  suspend: SkillSuspend | null;
  extraFiles: string[];
}

export interface SkillRegistry {
  fingerprint: string;
  version: string;
  scannedAt: number;
  dirs: Map<string, SkillDirNode>;
  skills: Map<string, SkillRecord>;
  /**
   * 本次扫描「磁盘上确认存在 SKILL.md」的目录。
   *
   * ⚠️ **包含挂起的 skill**：挂起 ≠ 删除。
   *   §8.3 的 listStaleSkillKeys 完全依赖这条语义 —— 只要目录还在，它的键就不该被清理。
   */
  existingDirs: Set<string>;
  /** 告警（层级超限 / 多余文件 / 嵌套冲突）；进日志与配置页 */
  warnings: string[];
  /** 根目录读失败 / 工具注册表未就绪 → true；调用方清空注册表，下轮重试（§9 末行） */
  failed: boolean;
}

/* ============================================================
 * 设置项结构转换
 * ============================================================ */

/**
 * SkillSettingDefLike → SettingDef（§4.6 明确「结构复用 infra/settings.ts 的 SettingDef」）。
 *
 * 为什么不直接 `as SettingDef`：字段一个个赋，将来任一侧加字段都会在编译期暴露。
 */
function toSettingDef(d: SkillSettingDefLike): SettingDef {
  const out: SettingDef = { kind: d.kind, default: d.default };
  if (d.desc !== undefined) out.desc = d.desc;
  if (d.secret !== undefined) out.secret = d.secret;
  if (d.min !== undefined) out.min = d.min;
  if (d.max !== undefined) out.max = d.max;
  if (d.options !== undefined) out.options = d.options;
  if (d.optionLabels !== undefined) out.optionLabels = d.optionLabels;
  if (d.dependsOn !== undefined) out.dependsOn = d.dependsOn;
  return out;
}

/* ============================================================
 * 指纹（§6.3：增 / 删 / 改 SKILL.md 都要触发重扫）
 * ============================================================ */

export interface Stamp {
  rel: string;
  mtimeMs: number;
  size: number;
}

let walkFailed = false;

/**
 * 遍历 etc/skills 下全部**文件**（不限扩展名、不限 SKILL.md）：
 *   「新增一个多余文件」也要让指纹变，否则 §4.1 的告警在下一次请求前不会出现。
 * 跳过 `.` 开头的条目（.trash 等）。
 *
 * ⚠️ 超深目录**照样下行**：否则「在最深一层新建 SKILL.md」不触发重扫，
 *    §5.2 的层级告警永远不出现。
 * ⚠️ 根目录本身不存在（首次部署未建 etc/skills）**不算失败**：按空目录处理，
 *    否则每次请求都会重扫 + 打一行错误日志（§16 首次启动前置）。
 */
export function walkSkillFiles(): Stamp[] {
  const out: Stamp[] = [];
  walkFailed = false;
  if (!existsSync(SKILLS_ROOT)) return out;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: SKILLS_ROOT, rel: "" }];
  while (stack.length > 0) {
    const cur = stack.pop() as { abs: string; rel: string };
    let entries: Dirent[];
    try {
      entries = readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      // 根目录存在但读不到（权限等）→ 交给调用方重试；子目录读不到：单点失败不扩散
      if (cur.rel === "") walkFailed = true;
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(cur.abs, e.name);
      const rel = cur.rel === "" ? e.name : `${cur.rel}/${e.name}`;
      if (e.isDirectory()) {
        stack.push({ abs, rel });             // 永远下行
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = statSync(abs);
        out.push({ rel, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
      } catch {
        /* 取不到 stat：忽略该文件（不进入指纹，也不会被扫描） */
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * 指纹：文件集合 + mtime + size（加 size 兜住「同一毫秒内二次修改」，与 tools 侧同口径）。
 *
 * ⚠️ [C-15] 默认参数仅供单测；`ensureSkillRegistry` 一律**显式传 files**，
 *    否则每请求会多做一次全目录 readdir + stat。
 */
export function computeSkillFingerprint(files: Stamp[] = walkSkillFiles()): string {
  return hashText(files.map((f) => `${f.rel}|${f.mtimeMs}|${f.size}`).join("\n"));
}

/* ============================================================
 * 扫描
 * ============================================================ */

function depthOf(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}

function emptyDir(path: string): SkillDirNode {
  return {
    path,
    name: path === "" ? "" : (path.split("/").pop() as string),
    depth: depthOf(path),
    children: [],
    skills: [],
    extraFiles: [],
    ignored: [],
  };
}

export function emptySkillRegistry(fingerprint = ""): SkillRegistry {
  return {
    fingerprint,
    version: `sv_${hashText(`${fingerprint}|`)}`,
    scannedAt: Date.now(),
    dirs: new Map([["", emptyDir("")]]),
    skills: new Map(),
    existingDirs: new Set(),
    warnings: [],
    failed: false,
  };
}

/**
 * 单次扫描（**同步**；见文件头「与 tools/scan.ts 的差异」）。
 * 全部数据先在本地构造，成功后才由调用方整体替换（照抄 tools/scan.ts 手法）。
 */
export function scanSkillsOnce(fingerprint: string, files: Stamp[]): SkillRegistry {
  const reg = emptySkillRegistry(fingerprint);

  /* ⓪ 工具注册表未就绪的保护
   *   若调用方忘了先 ensureToolRegistry()，knownTools 会是空集 →
   *   所有带 tools 的 skill 都会挂 unknown_tool。这里直接跳过本轮，交给下次重试。
   */
  const toolReg = getRegistry();
  if (toolReg.tools.size === 0 && toolReg.groups.size === 0) {
    console.warn("⚠️  [skill-scan] 工具注册表为空（尚未扫描），本轮跳过 skill 扫描，下次请求重试");
    return { ...reg, failed: true };
  }
  /** 已注册工具名（callName 点号形式；wireToCall 的 key 是可见名，也收进来做 C-7 的兼容） */
  const knownTools = new Set<string>([
    ...toolReg.tools.keys(),
    ...toolReg.wireToCall.keys(),
  ]);

  /* ① 目录集合（只由文件路径推导；空目录不建节点） */
  const dirPaths = new Set<string>([""]);
  for (const f of files) {
    const segs = f.rel.split("/");
    segs.pop();
    let acc = "";
    for (const s of segs) {
      if (s === "") continue;
      acc = acc === "" ? s : `${acc}/${s}`;
      dirPaths.add(acc);
    }
  }

  /* ② 自顶向下建目录节点：命名不合规 / 层级超限 → 整棵子树忽略并告警（§5.2） */
  const ordered = [...dirPaths].sort(
    (a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const path of ordered) {
    if (path === "") continue;
    const name = path.split("/").pop() as string;
    const depth = depthOf(path);
    const parent = reg.dirs.get(path.split("/").slice(0, -1).join("/"));
    // ✅ 上级没建节点 = 已被忽略/超限 → 整棵子树连坐
    //   （不能用 parent.ignored 判：它只记直接子项，孙项判不到）
    if (!parent) continue;
    const nm = checkName(name);
    if (!nm.ok) {
      parent.ignored.push({ name, reason: `目录名不合规：${nm.reason}` });
      reg.warnings.push(`skill 目录 ${path} 命名不合规（${nm.reason}），整棵子树已忽略`);
      continue;
    }
    if (depth > MAX_SKILL_DEPTH) {
      parent.ignored.push({ name, reason: `层级超过上限 ${MAX_SKILL_DEPTH}` });
      reg.warnings.push(`skill 目录 ${path} 层级超过 ${MAX_SKILL_DEPTH}，整棵子树已忽略`);
      continue;
    }
    reg.dirs.set(path, emptyDir(path));
    parent.children.push(path);
  }

  /* ③ 按目录归拢文件：有 SKILL.md = skill；没有 = 分类目录 */
  const byDir = new Map<string, { sk: boolean; extra: string[] }>();
  for (const f of files) {
    const segs = f.rel.split("/");
    const file = segs.pop() as string;
    const dir = segs.join("/");
    const slot = byDir.get(dir) ?? { sk: false, extra: [] };
    if (file === SKILL_FILE) slot.sk = true;
    else slot.extra.push(file);
    byDir.set(dir, slot);
  }
  for (const [dir, slot] of byDir) {
    const node = reg.dirs.get(dir);
    if (!node) continue;                            // 已被忽略的子树
    node.extraFiles = slot.extra.sort();
    if (slot.extra.length > 0) {
      // §4.1：忽略并告警，**不影响该 skill 生效**
      reg.warnings.push(`skill 目录 ${dir || "/"} 内存在 SKILL.md 以外的文件（已忽略）：${node.extraFiles.join("、")}`);
    }
    if (slot.sk) reg.existingDirs.add(dir);
  }

  /* ④ 嵌套冲突（N-SK-4）：
   *   skill 目录下不得再含 SKILL.md → **子目录那条**挂起，父 skill 不受影响（C-12）。
   */
  const nestedChildDirs = new Set<string>();
  const existing = [...reg.existingDirs];
  for (const dir of existing) {
    for (const other of existing) {
      if (other !== dir && other.startsWith(`${dir}/`)) nestedChildDirs.add(other);
    }
  }

  /* ⑤ 逐 skill 解析 + 校验（失败粒度 = 单个 skill） */
  const sortedDirs = [...reg.existingDirs].sort();
  for (const dir of sortedDirs) {
    const node = reg.dirs.get(dir);
    if (!node) continue;
    const name = dir.split("/").pop() as string;
    const rec: SkillRecord = {
      dir,
      name,
      depth: depthOf(dir),
      toggleKey: skillToggleKey(dir),
      title: "",
      summary: "",
      tools: [],
      settings: new Map(),
      sections: [],
      status: "ok",
      suspend: null,
      extraFiles: node.extraFiles,
    };
    node.skills.push(dir);

    const fail = (code: SkillSuspendCode, reason: string): void => {
      rec.status = "suspended";
      rec.suspend = { code, reason, hint: SKILL_SUSPEND_HINT[code] };
      reg.warnings.push(`skill ${dir} 已挂起（${code}）：${reason}`);
    };

    // 嵌套：**子目录那条**挂起，父 skill 不受影响
    if (nestedChildDirs.has(dir)) {
      const parentDir = dir.split("/").slice(0, -1).join("/");
      fail(
        "nested_skill",
        `上级目录 ${parentDir} 也是一个 skill，本 skill 按 N-SK-4 挂起（skill 目录下不得再含 SKILL.md）`,
      );
      reg.skills.set(dir, rec);
      continue;
    }

    let text: string;
    try {
      text = readFileSync(join(SKILLS_ROOT, dir, SKILL_FILE), "utf-8");
    } catch (err) {
      fail("parse_failed", `读取失败：${err instanceof Error ? err.message : String(err)}`);
      reg.skills.set(dir, rec);
      continue;
    }

    // 只传纯存在性判断（归一已在 parseFrontmatter 内部完成，不要二次归一）
    const fm = parseFrontmatter(text, dir, (one) => knownTools.has(one));
    if (!fm.ok) {
      fail(fm.code, fm.reason);
      reg.skills.set(dir, rec);
      continue;
    }

    const sections = splitSections(fm.body);
    const missing = missingSections(sections);
    if (missing.length > 0) {
      fail("missing_section", `缺少必需段落：${missing.map((h) => `## ${h}`).join("、")}`);
      reg.skills.set(dir, rec);
      continue;
    }

    rec.title = fm.data.title;
    rec.summary = fm.data.summary;
    rec.tools = fm.data.tools;
    rec.sections = sections;
    for (const [k, def] of Object.entries(fm.data.settings)) rec.settings.set(k, toSettingDef(def));
    reg.skills.set(dir, rec);
  }

  /* ⑥ 撞键检测（小写比较；后注册者让位 → 挂起 key_collision） */
  const ownerOf = new Map<string, string>();
  for (const rec of [...reg.skills.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))) {
    const keys = [rec.toggleKey, ...[...rec.settings.keys()].map((n) => skillSettingKey(rec.dir, n))];
    for (const key of keys) {
      const low = key.toLowerCase();
      const prev = ownerOf.get(low);
      if (prev === undefined) ownerOf.set(low, rec.dir);
      else if (prev !== rec.dir && !rec.suspend) {
        rec.status = "suspended";
        rec.suspend = {
          code: "key_collision",
          reason: `键 ${key} 已被 skill ${prev} 占用`,
          hint: SKILL_SUSPEND_HINT.key_collision,
        };
        reg.warnings.push(`skill ${rec.dir} 因撞键整体挂起（${key}）`);
      }
    }
  }

  for (const w of reg.warnings) console.warn(`⚠️  [skill-scan] ${w}`);

  return {
    ...reg,
    version: `sv_${hashText(`${fingerprint}|${[...reg.skills.keys()].sort().join(",")}`)}`,
  };
}

/* ============================================================
 * 单例与重入（照抄 tools/scan.ts 的 in-flight 去重）
 * ============================================================ */

let registry: SkillRegistry = emptySkillRegistry();
let ready = false;
let inflight: Promise<SkillRegistry> | null = null;

export function getSkillRegistry(): SkillRegistry {
  return registry;
}

export function isSkillRegistryReady(): boolean {
  return ready;
}

/**
 * 指纹校验 + 可重入扫描。
 *   · 指纹未变且已就绪 → 复用（每请求只有一次 readdir 量级开销）；
 *   · `force` → 无条件重扫（配置页打开 / 点刷新 / 预览）；
 *   · 并发请求共用同一次扫描（in-flight 去重）；
 *   · 扫描抛错 → 清空注册表并保持「未就绪」，下轮重试（§9 末行）。
 */
export async function ensureSkillRegistry(opts: { force?: boolean } = {}): Promise<SkillRegistry> {
  // [C-15] 只遍历一次目录：结果同时喂给 scanSkillsOnce 与 computeSkillFingerprint
  const files = walkSkillFiles();
  const fp = computeSkillFingerprint(files);
  if (!opts.force && ready && !walkFailed && fp === registry.fingerprint) return registry;
  if (inflight) return inflight;

  const run = (async (): Promise<SkillRegistry> => {
    try {
      const next = scanSkillsOnce(fp, files);
      // ✅ 展开赋值：v0.1 曾写 next.bumpFailed(...)（不存在的方法）→ 运行期 TypeError
      registry = { ...next, failed: next.failed || walkFailed };
      ready = !registry.failed;
      const suspended = [...next.skills.values()].filter((r) => r.suspend).length;
      console.log(
        `🧩 [skill-scan] 注册表已更新｜版本=${next.version}｜指纹=${next.fingerprint}｜` +
        `目录=${next.dirs.size - 1}｜skill=${next.skills.size}（挂起 ${suspended}）`,
      );
      return registry;
    } catch (err) {
      registry = emptySkillRegistry(fp);
      ready = false;
      console.error(
        `❌ [skill-scan] 扫描失败，注册表已清空并将在下次请求重试：` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return registry;
    } finally {
      inflight = null;
    }
  })();

  inflight = run;
  return run;
}

/**
 * [§6.5 / C-9] 计算「应当自动清理」的 skill 残留键。
 *
 * 两条同时满足才删：
 *   ① 键命中 SKILLON__ / SKILLSET__ 前缀；
 *   ② 该键所属的 skill 目录在**本次扫描后已不存在**（不在 existingDirs 里）。
 *
 * ⚠️ 绝不删「挂起但仍存在」的 skill 的键：挂起 ≠ 删除。
 * ⚠️ 绝不碰 TOOLON__ / TOOLSET__ / etc__tools__（AC-18）。
 *
 * 键 → 目录的判定：目录名不允许含 `__`（checkName 已挡），按 `__` 切分无歧义。
 *   SKILLON__a__b        → 目录候选 ["a","b"]
 *   SKILLSET__a__b__k    → 目录候选 ["a","b"]（最后一段是设置项名，不是目录）
 */
export function listStaleSkillKeys(
  keys: Iterable<string>,
  reg: SkillRegistry = registry,
): string[] {
  const alive = reg.existingDirs;
  const out: string[] = [];
  for (const key of keys) {
    if (!isSkillManagedKey(key)) continue;
    const rest = key.split("__").slice(1);            // 去掉 SKILLON / SKILLSET 前缀
    if (rest.length === 0) continue;
    const dirSegs = key.startsWith("SKILLSET__") ? rest.slice(0, -1) : rest;
    if (dirSegs.length === 0) continue;
    let matched = false;
    // 从最长前缀往短试：任一前缀命中 existingDirs 即视为「仍然存在」
    for (let cut = dirSegs.length; cut >= 1; cut--) {
      if (alive.has(dirSegs.slice(0, cut).join("/"))) { matched = true; break; }
    }
    if (!matched) out.push(key);
  }
  return out.sort();
}

/**
 * [C-22] 每个**存活** skill 声明的键（开关键 + 全部设置项键）。
 *
 * 用途：`listOrphanKeys()` 的判据是「命中托管前缀 且 未被工具注册表注册」，
 *   而 skill 键永远不在工具注册表里 → C-20 把 skill 前缀并入托管前缀后，
 *   存活技能的键会被整批误判成「遗留键」（可一键删掉正在用的开关）。
 *   本函数给出「必须从遗留键里减掉」的集合。
 *
 * ⚠️ 只保护存活（未挂起且解析成功）的 skill：挂起的 skill 声明的设置项并不可信
 *    （可能是非法声明），而它的**开关键**仍被 `existingDirs` 保护着不被自动清理（C-9）。
 * ⚠️ 已删除 skill 的残留键不在这里，交给 `listStaleSkillKeys` 自动清理。
 */
export function listSkillDeclaredKeys(reg: SkillRegistry = registry): string[] {
  const out: string[] = [];
  for (const rec of reg.skills.values()) {
    if (rec.status !== "ok") continue;
    out.push(rec.toggleKey);
    for (const name of rec.settings.keys()) out.push(skillSettingKey(rec.dir, name));
  }
  return out;
}
