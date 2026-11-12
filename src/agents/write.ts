/**
 * src/agents/write.ts
 * agent 目录的写操作（模块 7-A13）。
 *
 * 职责边界：
 *   · 本文件只做「校验 + 落盘」，不读 env、不碰注册表单例、不涉及 HTTP。
 *   · 校验一律复用 paths.ts 的 checkAgentPath，与扫描侧共用同一套规则 ——
 *     否则会出现「写得进去但扫不出来」的鬼目录。
 *
 * ⚠️ setup.json 的字段名以 setup.ts 的 parseAgentSetup **读取键**为唯一准绳：
 *      uid / name / title / description / llm
 *      / skills{ mode, list }      ← 注意是 list，不是 allow；mode 只允许 "allow"
 *      / tools{ allow, deny }      ← allow 缺失 / null / [] 均 = 全禁（BR-1）
 *      / toolSettings{ "<dir>/<group>": { "<name>": 值 } }   ← 工具设置项（需求 D-2）
 *      / limits{ maxRounds }       ← 注意在 limits 下，不是顶层
 *      / memory{ enabled }
 *      / systemBudget
 *    写错任何一个键，生成的文件自己都读不回来（且扫描器判 invalid）。
 *
 * 落盘约定：
 *   ① 先算后写：内容全部在内存里拼好、校验通过后才动磁盘。
 *   ② 覆盖前留 .bak。扫描器只认 AGENT.md 与 setup.json，.bak 不会被当成 agent。
 *   ③ 写完做一次「回读自检」：parseAgentSetup 必须能解析刚写出的内容，否则回滚。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  AGENTS_ROOT, AGENT_FILE, SETUP_FILE, checkAgentPath, AGENT_UID_RE,
  DEFAULT_AGENT_UID, isDefaultAgentPath,
} from "./paths";
import { parseAgentSetup } from "./setup";
import type { AgentSetup } from "./types";

/** 写操作的入参（来自 HTTP body） */
export interface WriteAgentInput {
  /** 相对路径，不含 .md 后缀，例 "ops/devops" */
  path: string;
  /** AGENT.md 正文；undefined 表示「不改动 AGENT.md」 */
  body?: string;
  /** setup.json 的字段；undefined 表示「不改动 setup.json」 */
  setup?: Partial<AgentSetup>;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  /** 归一化后的相对路径 */
  path?: string;
  /** 是否覆盖了已有文件 */
  overwritten?: boolean;
}

/** 反查清单所需的最小 deps（与 scan.ts 的 ScanDeps 同形，但本文件不使用） */
export type { AgentSetup };

/* ============================================================
 * 路径
 * ============================================================ */

/**
 * 归一化用户输入：去空白、去**尾部**斜杠、去 .md 后缀。
 * 前端新建框用户可能手打 "devops.md"、"devops/"，直接报错体验差，归一化更友好；
 * 归一后仍必须过 checkAgentPath。
 *
 * ⚠️ 刻意**不**去掉开头的 "/" 或 "\\"：
 *    以前这里是 `replace(/^\/+|\/+$/g, "")`，会把 "/abs" 归一成 "abs"，
 *    于是 checkAgentPath 的「不得为绝对路径」分支永远走不到 —— 用户输入绝对路径
 *    会被静默改写成相对路径写进 etc/agents，前端还提示「创建成功」。
 *    这既违反 §12.4 路径安全（绝对路径应拒绝而非改写），也掩盖了用户真实意图。
 *    因此只裁尾部，开头一律交给 checkAgentPath 判死。
 */
export function normalizeAgentPath(raw: string): string {
  let p = String(raw ?? "").trim();
  p = p.replace(/\/+$/, "");
  p = p.replace(/\.md$/i, "");
  return p;
}

/** 校验归一后的 path，返回错误原因或 null */
export function validateAgentPath(path: string): string | null {
  const r = checkAgentPath(path);
  return r.ok ? null : (r.reason ?? "路径不合规");
}

/** 绝对目录：<AGENTS_ROOT>/<path...> */
function absDirOf(path: string): string {
  return join(AGENTS_ROOT, ...path.split("/"));
}

function agentMdOf(path: string): string {
  return join(absDirOf(path), AGENT_FILE);
}

function setupJsonOf(path: string): string {
  return join(absDirOf(path), SETUP_FILE);
}

/**
 * 【D-1】读取某目录当前持有的 uid；目录或 setup.json 不存在时返回 null。
 *
 * ⚠️ 与内部 readExistingUid 的区别：那个接受**文件绝对路径**、仅供 upsert 内部使用；
 *    本函数接受**相对路径**、供对外保护判定使用。刻意不合并 ——
 *    合并会让 upsert 内部多一层重复的路径归一化。
 */
export function readAgentUid(path: string): string | null {
  const sj = setupJsonOf(path);
  if (!existsSync(sj)) return null;
  try {
    const j = JSON.parse(readFileSync(sj, "utf8")) as { uid?: unknown };
    return typeof j.uid === "string" && AGENT_UID_RE.test(j.uid) ? j.uid : null;
  } catch {
    return null;
  }
}

/**
 * 【D-1】写操作的身份守卫（需求文档 C7 / C10 / §4.8 / §4.9）。
 *
 * 只拦两件事，**绝不拦配置内容**（A-1.5f 红线）：
 *   ① 目标是默认智能体，但请求路径不是 default  → 拒绝（C7 禁止改名/移动）
 *   ② 目标是普通智能体，但请求路径是 default    → 拒绝（C10 保留名字）
 *
 * ⚠️ 注意判定方向：①判「uid 是默认 + 路径不是默认」，②判「uid 不是默认 + 路径是默认」。
 *    两个条件互斥，合起来保证「default 路径 ⟺ ag_00000000 身份」的双向唯一。
 *
 * ⚠️ 为什么 ② 用 `isDefaultAgentPath(path)` 而不是前缀匹配：
 *    需求文档 §4.3 明确 `default` 是**精确**保留字，`default2` / `ops/default` 都合法。
 *
 * @param path 归一化后的目标相对路径
 * @returns 拒绝原因；null = 放行
 */
export function guardDefaultAgent(path: string): string | null {
  const existingUid = readAgentUid(path);
  const isSelfDefault = existingUid === DEFAULT_AGENT_UID;

  // ② 保留名字：普通智能体不得占用 default 路径
  //   ⚠️ 判定「是不是自己」用 existingUid：若 default 目录里已是 ag_00000000（编辑默认智能体），
  //      则不拦；只有「default 路径被非默认身份占用」才拦（C10）。
  if (!isSelfDefault && isDefaultAgentPath(path)) {
    return (
      "「default」是默认智能体的保留名字，不能用于创建其它智能体" +
      "（如需新建，请换一个名字）"
    );
  }

  // ① 默认智能体不得改名/移动：其路径必须恒为 default
  //   ⚠️ 这一支的实际覆盖：API 没有「改名」原语（upsertAgent 只按目标路径写），
  //      因此它真正拦住的是「把 default 目录的 setup.json 内容 POST 到一个新路径、
  //      同时希望沿用 uid」这种试图复制默认身份的操作 —— 那会让系统中出现两个
  //      ag_00000000。基于「目标路径上已有 ag_00000000 但路径不是 default」来判。
  if (isSelfDefault && !isDefaultAgentPath(path)) {
    return (
      `默认智能体（uid=${DEFAULT_AGENT_UID}）不允许改名或移动目录，` +
      "路径必须保持为「default」"
    );
  }

  return null;
}

/* ============================================================
 * setup.json 序列化（字段名严格对齐 parseAgentSetup 的读取键）
 * ============================================================ */
export function buildSetupJson(path: string, uid: string, setup: Partial<AgentSetup>): string {
  const leaf = path.split("/").pop() ?? path;

  /* 【BUG 修复】兼容两种入参形态：
   *
   *   ① 内部形态（AgentSetup 的字段名）：skillsMode / skillsAllow / toolsAllow /
   *      toolsDeny / maxRounds / memoryEnabled。write.test.ts 与内部调用走这条。
   *   ② 磁盘形态（setup.json 的原始键名）：skills:{mode,list} / tools:{allow,deny} /
   *      limits:{maxRounds} / memory:{enabled}。配置页前端编辑框里贴的就是这种，
   *      直接 POST 上来。
   *
   * 修复前只认 ①，而前端发的是 ②：两者字段名不同 → skills / tools / limits /
   * memory 全被当作 undefined 跳过，**保存后静默丢失**，只剩 systemBudget
   * （唯一两边同名的键）。这是既有缺陷（改造前就存在），
   * 在「新建智能体继承默认配置」后变得致命 —— 继承来的配置一保存就没了。
   *
   * 归一化只补缺、不覆盖：① 已给出时以 ① 为准。
   */
  const raw = setup as unknown as Record<string, any>;
  const pick = <T>(a: T | undefined, b: T | undefined): T | undefined =>
    a !== undefined ? a : b;

  const skillsMode = pick(setup.skillsMode, raw.skills?.mode);
  const skillsAllow = pick(setup.skillsAllow, raw.skills?.list);
  const toolsAllow = pick(setup.toolsAllow, raw.tools?.allow);
  const toolsDeny = pick(setup.toolsDeny, raw.tools?.deny);
  const maxRounds = pick(setup.maxRounds, raw.limits?.maxRounds);
  const memoryEnabled = pick(setup.memoryEnabled, raw.memory?.enabled);
  // llm 同理：磁盘键名是 llm，内部字段名是 llmRef
  const llmRef = pick(setup.llmRef, raw.llm);
  /**
   * [FR-AGP-1] toolSettings：内部字段名与磁盘键名**同名**（`toolSettings`），
   * 但前端的自由 JSON 编辑框也会直接贴磁盘形态，因此这里仍走 pick 归一。
   *
   * ⚠️ 这是本文件最容易「静默丢数据」的一处：`buildSetupJson` 是**白名单式重建**，
   *    没在这里显式输出的键一律被丢弃 —— 前端保存一次，工具设置项就凭空消失。
   *    由 write.test.ts 的往返用例（T-W13）守住。
   */
  const toolSettings = pick(setup.toolSettings, raw.toolSettings);

  const out: Record<string, unknown> = { uid, name: leaf };

  if (setup.title !== undefined) out.title = setup.title;
  if (setup.description !== undefined) out.description = setup.description;
  if (llmRef !== undefined) out.llm = llmRef;

  // skills: { mode, list }  ← 键是 list
  if (skillsMode !== undefined || skillsAllow !== undefined) {
    out.skills = {
      ...(skillsMode !== undefined ? { mode: skillsMode } : {}),
      ...(skillsAllow !== undefined ? { list: skillsAllow } : {}),
    };
  }

  // tools: { allow, deny }
  if (toolsAllow !== undefined || toolsDeny !== undefined) {
    out.tools = {
      ...(toolsAllow !== undefined ? { allow: toolsAllow } : {}),
      ...(toolsDeny !== undefined ? { deny: toolsDeny } : {}),
    };
  }

  // toolSettings: { "<dir>/<group>": { "<name>": 值 } }
  //   ⚠️ 空对象**不写**（等价于缺失），避免 `"toolSettings": {}` 这种噪声
  //   ⚠️ 组与键都按字典序输出，保证同一份配置序列化结果稳定（便于 diff 与备份比对）
  //   ⚠️ 本轮不做「值等于默认值即删键」的瘦身：这里拿不到默认值（需要工具注册表），
  //      由前端在提交前决定是否省略（前端从 GET /api/agents/meta/options 拿到 default）
  if (toolSettings && typeof toolSettings === "object" && Object.keys(toolSettings).length > 0) {
    const sorted: Record<string, Record<string, unknown>> = {};
    for (const g of Object.keys(toolSettings).sort()) {
      const bag = (toolSettings as Record<string, Record<string, unknown>>)[g] ?? {};
      const inner: Record<string, unknown> = {};
      for (const k of Object.keys(bag).sort()) inner[k] = bag[k];
      sorted[g] = inner;
    }
    out.toolSettings = sorted;
  }

  // limits: { maxRounds }  ← 在 limits 下
  if (maxRounds !== undefined) {
    out.limits = { maxRounds };
  }

  // memory: { enabled }
  if (memoryEnabled !== undefined) {
    out.memory = { enabled: memoryEnabled };
  }

  if (setup.systemBudget !== undefined) out.systemBudget = setup.systemBudget;

  return JSON.stringify(out, null, 2) + "\n";
}

/* ============================================================
 * 读取
 * ============================================================ */

export interface AgentFileContent {
  ok: boolean;
  error?: string;
  /** AGENT.md 正文；不存在时为空串 */
  body: string;
  /** setup.json 原文（格式化后）；不存在时为空串 */
  setupJson: string;
  /** setup.json 语法/校验失败原因 */
  setupError?: string;
}

/** 读取一个 agent 目录的两个文件（都不存在也返回 ok:true） */
export function readAgentFile(rawPath: string): AgentFileContent {
  const path = normalizeAgentPath(rawPath);
  const bad = validateAgentPath(path);
  if (bad) return { ok: false, error: bad, body: "", setupJson: "" };

  const mdPath = agentMdOf(path);
  const sjPath = setupJsonOf(path);

  let body = "";
  if (existsSync(mdPath)) {
    try {
      body = readFileSync(mdPath, "utf8");
    } catch (err) {
      return { ok: false, error: `读取 AGENT.md 失败：${errText(err)}`, body: "", setupJson: "" };
    }
  }

  let setupJson = "";
  let setupError: string | undefined;
  if (existsSync(sjPath)) {
    let raw = "";
    try {
      raw = readFileSync(sjPath, "utf8");
    } catch (err) {
      return { ok: false, error: `读取 setup.json 失败：${errText(err)}`, body, setupJson: "" };
    }
    try {
      setupJson = JSON.stringify(JSON.parse(raw), null, 2);
    } catch (err) {
      setupJson = raw; // 语法坏死时原样返回，让用户能手工修
      setupError = `setup.json 不是合法 JSON：${errText(err)}`;
    }
  }

  return { ok: true, body, setupJson, setupError };
}

/* ============================================================
 * 写入
 * ============================================================ */

/**
 * 新建或覆盖一个 agent。
 *
 * 校验顺序：① path 合规 → ② setup 形状 → ③ 落盘 → ④ 回读自检
 * ① ② 失败不产生任何副作用；④ 失败则回滚。
 *
 * ⚠️ isKnownLlm 由调用方注入：llmRef 是否合法必须由路由层判定
 *    （本文件不能 import @/infra/envJson，否则破坏 agents 模块图的纯洁性）。
 */
export function upsertAgent(
  input: WriteAgentInput,
  opts: { isKnownLlm?: (n: string) => boolean } = {},
): WriteResult {
  const path = normalizeAgentPath(input.path);
  const bad = validateAgentPath(path);
  if (bad) return { ok: false, error: bad };

  // 【D-1】身份守卫：默认智能体不可改名/移动；default 是保留名字（C7 / C10）。
  //   ⚠️ 必须在任何写盘动作之前 —— 包括 mkdirSync，否则拒绝时仍会留下空目录。
  const guarded = guardDefaultAgent(path);
  if (guarded !== null) return { ok: false, error: guarded };

  if (input.body !== undefined && typeof input.body !== "string") {
    return { ok: false, error: "body 必须是字符串" };
  }
  if (input.setup !== undefined && (typeof input.setup !== "object" || input.setup === null)) {
    return { ok: false, error: "setup 必须是对象" };
  }

  const dir = absDirOf(path);
  const mdPath = agentMdOf(path);
  const sjPath = setupJsonOf(path);

  const mdExists = existsSync(mdPath);
  const sjExists = existsSync(sjPath);
  if (input.body === undefined && input.setup === undefined) {
    return { ok: false, error: "body 与 setup 至少要提供一个" };
  }

  // 若要写 setup.json，先把内容在内存里拼好并自检，避免写出去才发现非法
  let setupText: string | null = null;
  if (input.setup !== undefined) {
    const uid = readExistingUid(sjPath) ?? generateUid();
    setupText = buildSetupJson(path, uid, input.setup);
    const check = parseAgentSetup(setupText, {
      path,
      isKnownLlm: opts.isKnownLlm ?? (() => true),
      mintUid: uid,
    });
    if (!check.ok) {
      return { ok: false, error: `${check.code}：${check.reason}` };
    }
  }

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (input.body !== undefined) {
      if (mdExists) backupFile(mdPath);
      writeFileSync(mdPath, input.body, "utf8");
    }

    if (setupText !== null) {
      if (sjExists) backupFile(sjPath);
      writeFileSync(sjPath, setupText, "utf8");

      // ④ 回读自检：从磁盘读回来再解析一遍
      const back = parseAgentSetup(readFileSync(sjPath, "utf8"), {
        path,
        isKnownLlm: opts.isKnownLlm ?? (() => true),
        mintUid: null,
      });
      if (!back.ok) {
        restoreBackup(sjPath);
        return { ok: false, error: `写出的 setup.json 无法回读（${back.reason}），已回滚` };
      }
    }

    return { ok: true, path, overwritten: mdExists || sjExists };
  } catch (err) {
    return { ok: false, error: `写入失败：${errText(err)}` };
  }
}

/** 删除整个 agent 目录 */
export function deleteAgent(rawPath: string): WriteResult {
  const path = normalizeAgentPath(rawPath);
  const bad = validateAgentPath(path);
  if (bad) return { ok: false, error: bad };

  // 【D-1】删除保护（A-1.5）：当前处于默认身份的智能体不可删除。
  //   ⚠️ 判据是「该目录当前的 uid」，不是「路径是否为 default」——
  //      否则用户把别的 agent 放进 default 就会被误判为不可删。
  if (readAgentUid(path) === DEFAULT_AGENT_UID) {
    return {
      ok: false,
      error:
        `默认智能体（uid=${DEFAULT_AGENT_UID}）不允许删除。` +
        "如需重置其内容，请在配置页编辑配置项或正文。",
    };
  }

  const dir = absDirOf(path);
  if (!existsSync(dir)) return { ok: false, error: "目录不存在" };

  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: `删除失败：${errText(err)}` };
  }
}

/* ============================================================
 * 内部
 * ============================================================ */

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function backupFile(file: string): void {
  try {
    writeFileSync(`${file}.bak`, readFileSync(file));
  } catch {
    /* 备份失败不阻断主流程 */
  }
}

function restoreBackup(file: string): void {
  try {
    if (existsSync(`${file}.bak`)) writeFileSync(file, readFileSync(`${file}.bak`));
    else unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/** 读已有 setup.json 的 uid（覆盖时沿用，避免 uid 漂移） */
function readExistingUid(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf8")) as { uid?: unknown };
    return typeof j.uid === "string" && AGENT_UID_RE.test(j.uid) ? j.uid : null;
  } catch {
    return null;
  }
}

/** 生成 uid（ag_ + 8 位小写 hex，与 paths.ts 的 generateAgentUid 同规则） */
function generateUid(): string {
  return `ag_${randomBytes(4).toString("hex")}`;
}

/** 仅供测试：暴露路径拼装 */
export const __internal = { absDirOf, agentMdOf, setupJsonOf };
