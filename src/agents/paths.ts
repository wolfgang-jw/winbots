/**
 * src/agents/paths.ts
 * agent 目录基准、层级上限、名字规则、uid 生成。
 *
 * ⚠️ 与 src/skills/paths.ts 同样的约束：【零业务依赖】，只 import node:path 与 node:crypto。
 */

import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

/** agent 根目录：<项目根>/etc/agents */
export const AGENTS_ROOT = resolve(import.meta.dir, "../../etc/agents");

/** 唯一配置文件（A6：一个 agent 目录一个 setup.json） */
export const SETUP_FILE = "setup.json";

/** 正文文件（A4：AGENT.md 只放正文） */
export const AGENT_FILE = "AGENT.md";

/**
 * 层级上限 = 3（§3.2 是唯一来源；§12.4 与之同义）。
 * 判据是 path 的段数：etc/agents/a/b/c/setup.json → path = "a/b/c" → 3 段，合法。
 * 超过 3 段 → 不视为 agent，记 warn 并跳过。
 */
export const MAX_AGENT_DEPTH = 3;

/** AGENT.md 体积告警线（12.2 D-F：>32KB 只 warn，不阻断） */
export const AGENT_BODY_WARN_BYTES = 32 * 1024;

/**
 * 【X-1 冲突处置】agent 名字规则**独立于** tools/paths.ts 的 checkName。
 *
 * 为什么不复用 checkName：它的 NAME_RE 是 /^[A-Za-z][A-Za-z0-9_]*$/，**不含连字符**，
 *   而需求 §3.1 / §12.4 明确允许 `-`（^[A-Za-z][A-Za-z0-9_-]{0,31}$）。
 *   复用会导致 `my-agent` 这类合法目录被判 invalid。
 */
export const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const AGENT_NAME_MAX_LEN = 32;

/**
 * 目录名的保留名判定。
 *
 * 【X-2 冲突处置】tools/paths.ts 的 RESERVED_NAMES 含 "default"，
 *   但 etc/agents/default/ 是 D-B 指定的默认 agent 目录。
 *   若照抄 checkName，默认 agent 会永远 invalid —— 这是本步最容易埋的坑。
 *
 * 因此 agent 侧**豁免 default**，其余保留名照旧禁止：
 *   ① 与开关语义冲突的（enabled / on / off / toggle / toolon / toolset / skillon / skillset）
 *   ② 与原型污染相关的（__proto__ / constructor / toString …）
 */
const AGENT_RESERVED_NAMES: ReadonlySet<string> = new Set<string>([
  "__proto__", "constructor", "prototype", "hasownproperty", "isprototypeof",
  "propertyisenumerable", "tocalestring", "tostring", "valueof",
  "enabled", "disabled", "on", "off", "toggle", "toolon", "toolset",
  "skillon", "skillset", "skill", "skills",
  "true", "false", "null", "undefined",
  // ⚠️ 刻意不含 "default"：它是 D-B 的默认 agent 目录名。
]);

export interface AgentNameCheck {
  ok: boolean;
  reason?: string;
}

/** 单段目录名校验（叶子名，不是完整路径） */
export function checkAgentName(name: string): AgentNameCheck {
  if (name.length < 1 || name.length > AGENT_NAME_MAX_LEN) {
    return { ok: false, reason: `长度必须在 1–${AGENT_NAME_MAX_LEN} 之间（当前 ${name.length}）` };
  }
  if (!AGENT_NAME_RE.test(name)) {
    return { ok: false, reason: "必须以字母开头，且只含字母、数字、下划线、连字符" };
  }
  if (name.endsWith("_") || name.endsWith("-")) {
    return { ok: false, reason: "末尾不得为下划线或连字符" };
  }
  if (name.includes("__")) {
    return { ok: false, reason: "不得出现连续双下划线（分隔符保留）" };
  }
  if (AGENT_RESERVED_NAMES.has(name.toLowerCase())) {
    return { ok: false, reason: "属保留名（与开关语义或对象原型相关）" };
  }
  return { ok: true };
}

/**
 * 完整相对路径校验（每段都必须是合法叶子名）。
 * 拒绝：空串、绝对路径、含 `..`、含反斜杠（§12.4 路径安全）。
 */
export function checkAgentPath(path: string): AgentNameCheck {
  if (path.trim() === "") return { ok: false, reason: "路径不得为空" };
  if (path.startsWith("/") || path.startsWith("\\")) return { ok: false, reason: "不得为绝对路径" };
  if (path.includes("\\")) return { ok: false, reason: "不得包含反斜杠" };
  const segs = path.split("/");
  for (const seg of segs) {
    if (seg === "..") return { ok: false, reason: "不得包含 ..（路径穿越）" };
    if (seg === "" || seg === ".") return { ok: false, reason: "路径含空段或 ." };
    const nm = checkAgentName(seg);
    if (!nm.ok) return { ok: false, reason: `段「${seg}」不合规：${nm.reason}` };
  }
  if (segs.length > MAX_AGENT_DEPTH) {
    return { ok: false, reason: `层级超过上限 ${MAX_AGENT_DEPTH}（当前 ${segs.length} 段）` };
  }
  return { ok: true };
}

/** path 的段数（"" → 0） */
export function agentDepth(path: string): number {
  return path === "" ? 0 : path.split("/").filter((s) => s.length > 0).length;
}

/** path 的叶子名（"ops/devops" → "devops"） */
export function agentLeafName(path: string): string {
  const segs = path.split("/").filter((s) => s.length > 0);
  return segs.length === 0 ? "" : (segs[segs.length - 1] as string);
}

/** 【D-B】是否为默认 agent 目录（path 恰为 "default"） */
export function isDefaultAgentPath(path: string): boolean {
  return path === "default";
}

/** uid 格式（ag_ + 8 位小写十六进制） */
export const AGENT_UID_RE = /^ag_[0-9a-f]{8}$/;

export function isAgentUid(v: string): boolean {
  return AGENT_UID_RE.test(v);
}

/**
 * 生成新 uid。【D-J】永不复用：随机 4 字节 → 8 位 hex。
 *
 * 为什么用随机而不是自增：需求要求「生成的 uid 只增不减，删除的不再分配」，
 *   自增需要持久化计数器（多一份状态、多一份并发风险）；随机 4 字节的碰撞概率
 *   在「几十~几百个 agent」的规模下可忽略，且碰撞由扫描期的重复检测兜底（两个都 invalid）。
 */
export function generateAgentUid(): string {
  return `ag_${randomBytes(4).toString("hex")}`;
}
