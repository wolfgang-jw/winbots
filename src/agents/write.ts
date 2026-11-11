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
 *      / skills{ mode, list }      ← 注意是 list，不是 allow
 *      / tools{ allow, deny }
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
import { AGENTS_ROOT, AGENT_FILE, SETUP_FILE, checkAgentPath, AGENT_UID_RE } from "./paths";
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

/* ============================================================
 * setup.json 序列化（字段名严格对齐 parseAgentSetup 的读取键）
 * ============================================================ */
export function buildSetupJson(path: string, uid: string, setup: Partial<AgentSetup>): string {
  const leaf = path.split("/").pop() ?? path;

  const out: Record<string, unknown> = { uid, name: leaf };

  if (setup.title !== undefined) out.title = setup.title;
  if (setup.description !== undefined) out.description = setup.description;
  if (setup.llmRef !== undefined) out.llm = setup.llmRef;

  // skills: { mode, list }  ← 键是 list
  if (setup.skillsMode !== undefined || setup.skillsAllow !== undefined) {
    out.skills = {
      ...(setup.skillsMode !== undefined ? { mode: setup.skillsMode } : {}),
      ...(setup.skillsAllow !== undefined ? { list: setup.skillsAllow } : {}),
    };
  }

  // tools: { allow, deny }
  if (setup.toolsAllow !== undefined || setup.toolsDeny !== undefined) {
    out.tools = {
      ...(setup.toolsAllow !== undefined ? { allow: setup.toolsAllow } : {}),
      ...(setup.toolsDeny !== undefined ? { deny: setup.toolsDeny } : {}),
    };
  }

  // limits: { maxRounds }  ← 在 limits 下
  if (setup.maxRounds !== undefined) {
    out.limits = { maxRounds: setup.maxRounds };
  }

  // memory: { enabled }
  if (setup.memoryEnabled !== undefined) {
    out.memory = { enabled: setup.memoryEnabled };
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
