/**
 * src/agents/scan.ts
 * agent 目录扫描与注册表（模块 1 主体）。
 *
 * 照搬 src/skills/scan.ts 的成熟做法：指纹校验、in-flight 去重、单点失败不扩散、单例。
 * 但有**三处刻意不同**（照抄会出错）：
 *
 *   差异 1【X-4】不检查工具注册表是否就绪。
 *     agent 的 llmRef 校验只依赖「合法 llm 名字集合」，与工具无关。
 *     照抄 skills 的「工具表为空就跳过」会导致：工具尚未扫描时 agent 列表整批消失。
 *
 *   差异 2【X-2 / X-1】名字校验用 agents/paths.ts 的 checkAgentName，不用 tools 的 checkName。
 *     原因见 paths.ts 的注释（连字符 + default 保留名）。
 *
 *   差异 3 超深目录**只跳过自身**，不连坐子树。
 *     skills 侧「整棵子树连坐」是因为 skill 目录下不能再有 skill（N-SK-4 嵌套禁令）；
 *     agent 侧没有这条禁令，a/b/c/d/ 超深只说明它自己不是 agent，
 *     不应连带忽略同层的 a/b/c/（那是合法的 3 段 agent）。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { hashText } from "@/tools/paths";
import type { AgentRecord, AgentRegistry } from "./types";
import {
  AGENTS_ROOT, AGENT_BODY_WARN_BYTES, AGENT_FILE, SETUP_FILE, MAX_AGENT_DEPTH, AGENT_UID_RE,
  agentDepth, agentLeafName, checkAgentName, generateAgentUid, isDefaultAgentPath,
} from "./paths";
import { parseAgentSetup, SYSTEM_BUDGET_DEFAULT } from "./setup";

/* ============================================================
 * 类型
 * ============================================================ */

export interface Stamp {
  rel: string;
  mtimeMs: number;
  size: number;
}

/** 扫描所需的注入项（全部由调用方提供，本文件不读配置） */
export interface ScanDeps {
  /** 合法 llm 名字集合；返回 false → 该 agent 的 llmRef 判 unknown_llm */
  isKnownLlm: (name: string) => boolean;
  /**
   * 是否允许补写缺失的 uid（D-J 一次性迁移）。
   * 单测传 false 得到可预期的结果；运行期传 true。
   */
  mintUid: boolean;
}

/* ============================================================
 * 遍历与指纹
 * ============================================================ */

let walkFailed = false;

/**
 * 遍历 etc/agents 下全部文件（不限扩展名）。
 * 为什么要把「非 setup.json / AGENT.md」也纳入指纹：新增一个多余文件也应触发重扫，
 * 否则配置页的多余文件告警要等到下次别的改动才出现（与 skills 侧同口径）。
 *
 * ⚠️ 跳过多余文件本身，但仍参与指纹 —— 参与指纹的是「有没有变」，不是「用不用它」。
 */
export function walkAgentFiles(root: string = AGENTS_ROOT): Stamp[] {
  const out: Stamp[] = [];
  walkFailed = false;
  if (!existsSync(root)) return out;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
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
      if (e.name.startsWith(".")) continue;          // .trash / .uid-index.json 等一律忽略
      const abs = join(cur.abs, e.name);
      const rel = cur.rel === "" ? e.name : `${cur.rel}/${e.name}`;
      if (e.isDirectory()) {
        stack.push({ abs, rel });
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = statSync(abs);
        out.push({ rel, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
      } catch {
        /* 取不到 stat：忽略该文件（不进入指纹） */
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 指纹：文件集合 + mtime + size（加 size 兜住「同一毫秒内二次修改」） */
export function computeAgentFingerprint(files: Stamp[]): string {
  return hashText(files.map((f) => `${f.rel}|${f.mtimeMs}|${f.size}`).join("\n"));
}

/* ============================================================
 * 扫描
 * ============================================================ */

export function emptyAgentRegistry(fingerprint = ""): AgentRegistry {
  return {
    agents: new Map(),
    byPath: new Map(),
    warnings: [],
    fingerprint,
    scannedAt: Date.now(),
    failed: false,
  };
}

/** 读取 AGENT.md；不存在返回空串（正文是可选的，判据是 setup.json） */
function readBody(dir: string): { text: string; bytes: number } {
  try {
    const text = readFileSync(join(dir, AGENT_FILE), "utf-8");
    return { text, bytes: Buffer.byteLength(text, "utf-8") };
  } catch {
    return { text: "", bytes: 0 };
  }
}

/**
 * 单次扫描（同步）。
 *
 * 判据（§12.4 判定规则）：
 *   含 setup.json            → agent 目录，停止下钻
 *   不含且还有子目录          → 分类目录，继续下钻
 *   不含且无子目录            → 忽略（残留空目录），记 warning
 *   depth > MAX_AGENT_DEPTH  → 跳过自身（差异 3）
 */
export function scanAgentsOnce(
  root: string,
  fingerprint: string,
  files: Stamp[],
  deps: ScanDeps,
): AgentRegistry {
  const reg = emptyAgentRegistry(fingerprint);
  const warn = (m: string): void => { reg.warnings.push(m); };

  /* ① 按目录归拢文件：有 setup.json 的目录 = agent 候选 */
  const byDir = new Map<string, Set<string>>();
  for (const f of files) {
    const segs = f.rel.split("/");
    const file = segs.pop() as string;
    const dir = segs.join("/");
    const slot = byDir.get(dir) ?? new Set<string>();
    slot.add(file);
    byDir.set(dir, slot);
  }

  /* ② 逐候选目录校验 */
  const candidates: string[] = [];
  for (const [dir, set] of byDir) {
    if (!set.has(SETUP_FILE)) continue;
    // 差异 3：超深只跳过自身（用常量，不写死 3 —— 否则 M2 的「单一来源」承诺就破了）
    const depth = agentDepth(dir);
    if (depth > MAX_AGENT_DEPTH) {
      warn(`agent 目录 ${dir} 层级超过上限 ${MAX_AGENT_DEPTH}，已跳过（不视为 agent）`);
      continue;
    }
    // 每一段都必须是合法名字（防止 a/b 里某段违规）
    const segs = dir.split("/");
    let badSeg: string | null = null;
    for (const s of segs) {
      const nm = checkAgentName(s);
      if (!nm.ok) { badSeg = `${s}（${nm.reason}）`; break; }
    }
    if (badSeg !== null) {
      warn(`agent 目录 ${dir} 命名不合规：${badSeg}，已跳过`);
      continue;
    }
    candidates.push(dir);
  }
  candidates.sort();

  /* ③ 残留空目录告警
   *
   * ⚠️ 说明（老实交代）：`allDirs` 的元素全部由某个文件的路径前缀产出，
   *    因此每个元素必然至少有一个后代文件 —— 下面的 `hasDescendant` 在**当前实现下恒为 true**，
   *    本段实际上**不会产生任何告警**。
   *
   *    之所以保留：`walkAgentFiles` 只返回文件，空目录根本不会进入 `files`，
   *    所以「残留空目录」这件事在纯文件遍历下**不可观测**。
   *    若将来改为同时收集目录戳（或在 walk 中直接记空目录），这段判定就是现成的落点。
   *    不删是为了让后来者清楚「这里想过、结论是不可观测」，而不是以为漏了。
   *
   *    对外承诺：`AgentRegistry.warnings` 当前**不含**「残留空目录」这一类。测试 A10 已按此校准。
   */
  const allDirs = new Set<string>();
  for (const f of files) {
    const segs = f.rel.split("/");
    segs.pop();
    for (let i = 1; i <= segs.length; i++) {
      allDirs.add(segs.slice(0, i).join("/"));
    }
  }
  for (const d of allDirs) {
    if (byDir.has(d)) continue;                       // 该目录自己有文件 → 不是空目录
    let hasDescendant = false;
    const prefix = `${d}/`;
    for (const f of files) {
      if (f.rel.startsWith(prefix)) { hasDescendant = true; break; }
    }
    if (hasDescendant) continue;
    warn(`目录 ${d} 内既无 setup.json 也无任何文件，已忽略（可能是残留空目录）`);
  }

  /* ④ 逐个解析 setup.json */
  const raw: AgentRecord[] = [];
  for (const dir of candidates) {
    const abs = join(root, dir);
    const leaf = agentLeafName(dir);

    // uid 补写：仅当 deps.mintUid 为 true
    const mintUid = deps.mintUid ? generateAgentUid() : null;

    let setupText: string;
    try {
      setupText = readFileSync(join(abs, SETUP_FILE), "utf-8");
    } catch (err) {
      raw.push(invalidRecord(dir, abs, leaf, `读取 setup.json 失败：${err instanceof Error ? err.message : String(err)}`));
      warn(`agent ${dir} 读取 setup.json 失败，标记 invalid`);
      continue;
    }

    const parsed = parseAgentSetup(setupText, {
      path: dir,
      isKnownLlm: deps.isKnownLlm,
      mintUid,
    });
    if (!parsed.ok) {
      // uid 能抢救就抢救：parseAgentSetup 的失败返回不带 uid，但原文里可能有合法值。
      // 保留了 uid，配置页才能按 uid 定位到这条 invalid 记录（否则 key 是空串）。
      //
      // ⚠️ parse_failed 例外：JSON 都解析不了，从原文正则扫出来的 uid 是**不可信的**
      //   （可能落在注释、残缺字符串或重复键里）。不可信来源的数据不进 key，
      //   一律置空，这类坏文件只按 path 索引。
      const salvaged = parsed.code === "parse_failed" ? "" : salvageUid(setupText);
      raw.push(invalidRecord(dir, abs, leaf, `${parsed.code}: ${parsed.reason}`, salvaged));
      warn(`agent ${dir} 校验失败（${parsed.code}）：${parsed.reason}`);
      continue;
    }

    const s = parsed.data;
    const body = readBody(abs);

    /* D-J 补写：真有缺 uid 且允许补写时，改文件（一次性） */
    if (mintUid !== null && s.uid === mintUid) {
      const written = writeUidBack(abs, setupText, mintUid);
      if (written.ok) {
        console.log(`🆔 [agent-scan] 已为 ${dir} 补写 uid=${mintUid}`);
      } else {
        // 补写失败不阻断：本次运行期仍可用内存里的 uid，只是下次扫描会再补一次
        warn(`agent ${dir} 的 uid 补写失败（${written.reason}），本次运行期使用临时 uid=${mintUid}`);
      }
    }

    if (body.bytes > AGENT_BODY_WARN_BYTES) {
      // 12.2 D-F：>32KB 只 warn，不 invalid（不阻断创建会话）
      warn(`agent ${dir} 的 AGENT.md 体积 ${body.bytes} 字节 > ${AGENT_BODY_WARN_BYTES}，建议精简（不阻断）`);
    }

    raw.push({
      uid: s.uid,
      name: s.name,
      path: dir,
      isDefault: isDefaultAgentPath(dir),
      dir: abs,
      title: s.title,
      description: s.description,
      body: body.text,
      bodySize: body.bytes,
      llmRef: s.llmRef,
      skillsMode: s.skillsMode,
      skillsAllow: s.skillsAllow,
      toolsAllow: s.toolsAllow,
      toolsDeny: s.toolsDeny,
      maxRounds: s.maxRounds,
      memoryEnabled: s.memoryEnabled,
      systemBudget: s.systemBudget,
      status: "ok",
    });
  }

  /* ⑤ uid 重复检测（R-18）：两个目录同 uid → **两个都 invalid** */
  const uidCount = new Map<string, AgentRecord[]>();
  for (const r of raw) {
    if (r.status !== "ok") continue;
    const arr = uidCount.get(r.uid) ?? [];
    arr.push(r);
    uidCount.set(r.uid, arr);
  }
  for (const [uid, list] of uidCount) {
    if (list.length <= 1) continue;
    const paths = list.map((r) => r.path).join("、");
    warn(`uid ${uid} 被多个 agent 使用（${paths}），全部标记 invalid`);
    for (const r of list) {
      r.status = "invalid";
      r.invalidReason = `uid ${uid} 被多个 agent 共用（${paths}）`;
    }
  }

  /* ⑥ 落表。key = uid；invalid 的也进表（配置页要能看到原因） */
  for (const r of raw) {
    // uid 重复时用 path 兜底做 Map key，否则后写者会覆盖先写者，导致「只剩一条 invalid」
    const key = reg.agents.has(r.uid) ? `${r.uid}#${r.path}` : r.uid;
    reg.agents.set(key, r);
    if (r.status === "ok") reg.byPath.set(r.path, r.uid);
  }

  for (const w of reg.warnings) console.warn(`⚠️  [agent-scan] ${w}`);
  return reg;
}

/**
 * 从原文里尽力取出合法 uid（仅用于 invalid 记录的身份标识）。
 *
 * 只认字符串字段且格式合规；解析失败就返回 ""，绝不因为抢救 uid 再抛一次错。
 *
 * ⚠️ 调用约定：**parse_failed 时不要调用本函数**。
 *   坏 JSON 走 catch 返回 ""，但残片可能落在注释/残缺串里 ——
 *   由调用点显式排除 parse_failed，不把「是否可信」的判断塞进本函数。
 */
function salvageUid(raw: string): string {
  try {
    const doc = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "";
    const v = (doc as Record<string, unknown>).uid;
    return typeof v === "string" && AGENT_UID_RE.test(v) ? v : "";
  } catch {
    return "";
  }
}

/**
 * 构造一条 invalid 记录（字段给安全默认值，配置页只展示原因）。
 *
 * uid 尽力保留：调用方能从原文里抢救出合法 uid 时就传进来。
 * 否则 uid 为空串，Map 的 key 会是 ""，配置页/调用方就无法按 uid 定位这条记录。
 */
function invalidRecord(dir: string, abs: string, leaf: string, reason: string, uid = ""): AgentRecord {
  return {
    uid,
    name: leaf,
    path: dir,
    isDefault: isDefaultAgentPath(dir),
    dir: abs,
    title: "",
    description: "",
    body: "",
    bodySize: 0,
    llmRef: null,
    skillsMode: "allow",
    skillsAllow: null,
    toolsAllow: null,
    toolsDeny: [],
    maxRounds: null,
    memoryEnabled: true,
    systemBudget: SYSTEM_BUDGET_DEFAULT,
    status: "invalid",
    invalidReason: reason,
  };
}

/**
 * 把 uid 写回 setup.json（D-J 一次性迁移）。
 *
 * 刻意做成「读原文 → 解析 → 插入 uid → 序列化」而不是「整体重写」：
 *   整体重写会丢掉用户的键顺序与未知字段（配置以文件为准、跟 git 走）。
 *   这里用 JSON.parse 再 JSON.stringify 会重排顺序 —— 因此改为**文本级插入**：
 *   在第一个 `{` 之后插入 `"uid": "ag_xxxx",`。
 *
 * ⚠️ 文本级插入只处理「顶层对象且尚无 uid」的情形；
 *    若原文不是以 `{` 开头（理论上前面的 JSON.parse 已挡住），直接放弃补写。
 */
function writeUidBack(abs: string, originalText: string, uid: string): { ok: boolean; reason?: string } {
  try {
    const trimmed = originalText.replace(/^\uFEFF/, "");
    const brace = trimmed.indexOf("{");
    if (brace === -1) return { ok: false, reason: "找不到顶层 {" };
    const head = trimmed.slice(0, brace + 1);
    const rest = trimmed.slice(brace + 1);
    const nl = rest.startsWith("\n") ? "\n" : "";
    const indentMatch = /\n([ \t]+)"/.exec(rest);
    const indent = indentMatch ? (indentMatch[1] as string) : "  ";
    const next = `${head}${nl}${indent}"uid": "${uid}",${rest}`;
    writeFileSync(join(abs, SETUP_FILE), next, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/* ============================================================
 * 单例与重入（照搬 skills/scan.ts 的 in-flight 去重）
 * ============================================================ */

let registry: AgentRegistry = emptyAgentRegistry();
let ready = false;
let inflight: Promise<AgentRegistry> | null = null;

export function getAgentRegistry(): AgentRegistry {
  return registry;
}

export function isAgentRegistryReady(): boolean {
  return ready;
}

/**
 * 指纹校验 + 可重入扫描。
 *   · 指纹未变且已就绪 → 复用；
 *   · `force` → 无条件重扫；
 *   · 并发请求共用同一次扫描（in-flight 去重）；
 *   · 扫描抛错 → 清空注册表并保持「未就绪」，下轮重试。
 *
 * ⚠️ 【X-4】这里**没有**「工具注册表未就绪就跳过」的分支 —— agent 扫描不依赖工具。
 */
export async function ensureAgentRegistry(
  deps: ScanDeps,
  opts: { force?: boolean } = {},
): Promise<AgentRegistry> {
  const files = walkAgentFiles();
  const fp = computeAgentFingerprint(files);
  if (!opts.force && ready && !walkFailed && fp === registry.fingerprint) return registry;
  if (inflight) return inflight;

  const run = (async (): Promise<AgentRegistry> => {
    try {
      const next = scanAgentsOnce(AGENTS_ROOT, fp, files, deps);
      registry = { ...next, failed: next.failed || walkFailed };
      ready = !registry.failed;
      const okCount = [...next.agents.values()].filter((r) => r.status === "ok").length;
      console.log(
        `🤖 [agent-scan] 注册表已更新｜指纹=${next.fingerprint}｜` +
        `agent=${next.agents.size}（ok ${okCount}，invalid ${next.agents.size - okCount}）`,
      );
      return registry;
    } catch (err) {
      registry = emptyAgentRegistry(fp);
      ready = false;
      console.error(
        `❌ [agent-scan] 扫描失败，注册表已清空并将在下次请求重试：` +
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

/** 仅供单测：重置单例 */
export function resetAgentRegistryForTest(): void {
  registry = emptyAgentRegistry();
  ready = false;
  inflight = null;
}
