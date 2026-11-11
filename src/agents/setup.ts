/**
 * src/agents/setup.ts
 * setup.json 的解析与字段校验（§3.1 字段表 / §3.2 扫描策略）。
 *
 * ⚠️ **纯函数**：不知道磁盘、不知道注册表。
 *   - 文件内容由调用方读好传入；
 *   - 「合法 llm 名字集合」由调用方以 isKnownLlm 回调注入（【X-3 处置】）。
 *     本文件**绝不** import @/infra/env 或 @/infra/envJson：
 *     那会把配置单例拉进 agents 的模块图，第 2 步「不接线」就破功了。
 */
import type { AgentSetup, SetupResult } from "./types";
import { agentLeafName, AGENT_UID_RE } from "./paths";

/** 默认值（§3.1 字段表的「缺省」列） */
export const SYSTEM_BUDGET_DEFAULT = 9000;
export const MAX_ROUNDS_MIN = 1;
export const MAX_ROUNDS_MAX = 32;

export interface ParseSetupOpts {
  /**
   * 该 setup 所在目录的完整相对路径（如 "ops/devops"）。
   * 用于 name 一致性校验：setup.json 的 name 必须等于**叶子名**（§12.4）。
   */
  path: string;
  /** 合法 llm 名字集合（来自 env.json 的 llm[].name）；返回 false 即 unknown_llm */
  isKnownLlm: (name: string) => boolean;
  /**
   * 【D-J】uid 缺失时的补写值。
   * 由扫描器生成并**由扫描器负责落盘**；本函数只把它写进返回值。
   * 传 null 表示「不允许补写」→ 缺 uid 视为 invalid_setup。
   */
  mintUid: string | null;
}

/** 标量字段读取辅助：非期望类型一律报可读原因，不做隐式转换 */
function bad(field: string, expect: string, got: unknown): string {
  const g = got === null ? "null" : Array.isArray(got) ? "数组" : typeof got;
  return `字段 ${field} 必须是${expect}（当前 ${g}）`;
}

/** 字符串数组校验；返回 null 表示合法 */
function checkStringArray(v: unknown, field: string): string | null {
  if (!Array.isArray(v)) return bad(field, "字符串数组", v);
  for (const x of v) {
    if (typeof x !== "string") return `${field} 里存在非字符串项（${typeof x}）`;
  }
  return null;
}

/**
 * 解析并校验 setup.json。
 * 一次只报第一个错误（与 parseFrontmatter 一致）：一次喷 10 条反而不知道先改哪个。
 */
export function parseAgentSetup(raw: string, opts: ParseSetupOpts): SetupResult {
  /* ① JSON 语法 */
  let doc: unknown;
  try {
    doc = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    return {
      ok: false,
      code: "parse_failed",
      reason: `setup.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, code: "invalid_setup", reason: "setup.json 顶层必须是一个对象" };
  }
  const o = doc as Record<string, unknown>;

  /* ② name：必需 + 必须等于目录叶子名（§12.4「避免两处真相」） */
  if (typeof o.name !== "string" || o.name.trim() === "") {
    return { ok: false, code: "invalid_setup", reason: "缺少 name（必需，必须等于所在目录名）" };
  }
  const name = o.name.trim();
  const leaf = agentLeafName(opts.path);
  if (name !== leaf) {
    return {
      ok: false,
      code: "name_mismatch",
      reason: `setup.json 的 name（${name}）与目录叶子名（${leaf}）不一致`,
    };
  }

  /* ③ uid：【D-J】必需；缺失时按 mintUid 补写，否则 invalid */
  let uid: string;
  if (o.uid === undefined || o.uid === null || o.uid === "") {
    if (opts.mintUid === null) {
      return { ok: false, code: "invalid_setup", reason: "缺少 uid（必需，形如 ag_7f3a9c21）" };
    }
    uid = opts.mintUid;
  } else if (typeof o.uid !== "string") {
    return { ok: false, code: "invalid_setup", reason: bad("uid", "字符串", o.uid) };
  } else {
    uid = o.uid.trim();
    if (!AGENT_UID_RE.test(uid)) {
      return {
        ok: false,
        code: "invalid_setup",
        reason: `uid「${uid}」格式非法：必须是 ag_ + 8 位小写十六进制`,
      };
    }
  }

  /* ④ title / description：可选，仅展示 */
  if (o.title !== undefined && typeof o.title !== "string") {
    return { ok: false, code: "invalid_setup", reason: bad("title", "字符串", o.title) };
  }
  if (o.description !== undefined && typeof o.description !== "string") {
    return { ok: false, code: "invalid_setup", reason: bad("description", "字符串", o.description) };
  }
  const title = typeof o.title === "string" ? o.title : "";
  const description = typeof o.description === "string" ? o.description : "";

  /* ⑤ llm：可选；出现时必须在合法集合里（【X-3】注入判定） */
  let llmRef: string | null = null;
  if (o.llm !== undefined && o.llm !== null) {
    if (typeof o.llm !== "string" || o.llm.trim() === "") {
      return { ok: false, code: "invalid_setup", reason: bad("llm", "非空字符串", o.llm) };
    }
    llmRef = o.llm.trim();
    if (!opts.isKnownLlm(llmRef)) {
      // §3.2：不静默回退默认组（与「引用不存在的工具就挂起」同原则）
      return {
        ok: false,
        code: "unknown_llm",
        reason: `llm「${llmRef}」未在 env.json 的 llm[] 中定义`,
      };
    }
  }

  /* ⑥ skills：{ mode, list } */
  let skillsMode: "allow" | "all" = "allow";
  let skillsAllow: string[] | null = null;
  if (o.skills !== undefined) {
    if (!o.skills || typeof o.skills !== "object" || Array.isArray(o.skills)) {
      return { ok: false, code: "invalid_setup", reason: "skills 必须是对象 { mode, list }" };
    }
    const s = o.skills as Record<string, unknown>;
    if (s.mode !== undefined) {
      if (s.mode !== "allow" && s.mode !== "all") {
        return { ok: false, code: "invalid_setup", reason: "skills.mode 只能是 allow / all" };
      }
      skillsMode = s.mode;
    }
    if (s.list !== undefined && s.list !== null) {
      const e = checkStringArray(s.list, "skills.list");
      if (e) return { ok: false, code: "invalid_setup", reason: e };
      skillsAllow = (s.list as string[]).slice();
    }
  }

  /* ⑦ tools：{ allow?, deny? } */
  let toolsAllow: string[] | null = null;
  let toolsDeny: string[] = [];
  if (o.tools !== undefined) {
    if (!o.tools || typeof o.tools !== "object" || Array.isArray(o.tools)) {
      return { ok: false, code: "invalid_setup", reason: "tools 必须是对象 { allow, deny }" };
    }
    const t = o.tools as Record<string, unknown>;
    if (t.allow !== undefined && t.allow !== null) {
      const e = checkStringArray(t.allow, "tools.allow");
      if (e) return { ok: false, code: "invalid_setup", reason: e };
      toolsAllow = (t.allow as string[]).slice();
    }
    if (t.deny !== undefined && t.deny !== null) {
      const e = checkStringArray(t.deny, "tools.deny");
      if (e) return { ok: false, code: "invalid_setup", reason: e };
      toolsDeny = (t.deny as string[]).slice();
    }
  }

  /* ⑧ limits.maxRounds：可选，钳制 1–32（§3.1） */
  let maxRounds: number | null = null;
  if (o.limits !== undefined) {
    if (!o.limits || typeof o.limits !== "object" || Array.isArray(o.limits)) {
      return { ok: false, code: "invalid_setup", reason: "limits 必须是对象 { maxRounds }" };
    }
    const l = o.limits as Record<string, unknown>;
    if (l.maxRounds !== undefined && l.maxRounds !== null) {
      if (typeof l.maxRounds !== "number" || !Number.isFinite(l.maxRounds)) {
        return { ok: false, code: "invalid_setup", reason: bad("limits.maxRounds", "数值", l.maxRounds) };
      }
      // 钳制而不是报错：§3.1 写「钳制在 1–32」，钳制是既定口径
      const n = Math.trunc(l.maxRounds);
      maxRounds = Math.min(MAX_ROUNDS_MAX, Math.max(MAX_ROUNDS_MIN, n));
    }
  }

  /* ⑨ memory.enabled：默认 true */
  let memoryEnabled = true;
  if (o.memory !== undefined) {
    if (!o.memory || typeof o.memory !== "object" || Array.isArray(o.memory)) {
      return { ok: false, code: "invalid_setup", reason: "memory 必须是对象 { enabled }" };
    }
    const m = o.memory as Record<string, unknown>;
    if (m.enabled !== undefined) {
      if (typeof m.enabled !== "boolean") {
        return { ok: false, code: "invalid_setup", reason: bad("memory.enabled", "布尔值", m.enabled) };
      }
      memoryEnabled = m.enabled;
    }
  }

  /* ⑩ systemBudget：默认 9000 */
  let systemBudget = SYSTEM_BUDGET_DEFAULT;
  if (o.systemBudget !== undefined) {
    if (typeof o.systemBudget !== "number" || !Number.isFinite(o.systemBudget) || o.systemBudget <= 0) {
      return { ok: false, code: "invalid_setup", reason: bad("systemBudget", "正数", o.systemBudget) };
    }
    systemBudget = Math.trunc(o.systemBudget);
  }

  const data: AgentSetup = {
    uid, name, title, description, llmRef,
    skillsMode, skillsAllow, toolsAllow, toolsDeny,
    maxRounds, memoryEnabled, systemBudget,
  };
  return { ok: true, data };
}
