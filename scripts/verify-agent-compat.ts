/**
 * scripts/verify-agent-compat.ts
 * 模块 8 · 第 1 步：未绑定 agent 路径的**等价差分**脚本。
 *
 * 性质（原文 §三 · 第 1 步说明）：
 *   这是**差分工具，不是正确性断言**。改动前后若都错且错得一致，脚本会通过；
 *   它只回答「结果有没有变」，不回答「结果对不对」。
 *
 * 用法（工作目录必须是 winbots/，否则 @/ 别名解析失败）：
 *   ./.bun/bun.exe scripts/verify-agent-compat.ts --baseline   # 阶段 1：抓基线（改动前跑）
 *   ./.bun/bun.exe scripts/verify-agent-compat.ts              # 阶段 2：比对（改动后跑）
 *
 * 退出码：0 = 完全一致；1 = 有差异（打印不等项）；2 = 输入未固定 / 缺少基线。
 *
 * ⚠️ 本脚本**只读**：不启动 HTTP 服务、不写数据库、不改任何文件（除 baseline.json）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

// ── 被测对象：只 import 纯函数 / 近纯函数；**不 import chat.ts**（避免启动服务与建库） ──
import { env } from "@/infra/env";
import { ensureToolRegistry, getToolDefinitions } from "@/tools";
import {
  ensureSkillRegistry,
  assembleForRequestMulti,
  previewSkill,
  BUDGET_MAX,
  L1_MAX,
  L2_MAX,
} from "@/skills";
// ⚠️ buildThinkingFields 是 src/routes/chat.ts 的 export（**不在** @/infra/thinkingMode），
//    直接 import chat.ts 会把 Hono router、infra/db 一并载入并可能触达 data/winbots.db。
//    本脚本的硬约束是「只读、不建库」，因此这里**逐字复刻**该函数的三行实现，
//    并用 §5.5 注入实验 D 保证复刻版与 chat.ts 版一致（见下）。

/**
 * 逐字复刻自 src/routes/chat.ts 的 buildThinkingFields（约第 198-208 行）。
 * ⚠️ 这是**唯一**一处有意复制业务代码的地方：目的是让脚本不 import chat.ts（避免载入 router / db）。
 *    chat.ts 若改了这四个分支，必须同步改这里 —— 由 §5.5 注入实验 D 兜底。
 */
function buildThinkingFieldsLocal(
  mode: string,
  thinking: boolean,
  effort: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (mode === "effort" || mode === "both") fields.reasoning_effort = effort;
  if (mode === "thinking" || mode === "both") {
    fields.thinking = { type: thinking ? "enabled" : "disabled" };
  }
  return fields;
}

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE = resolve(ROOT, "src/skills/__tests__/fixtures/compat/sessions.json");
const BASELINE = resolve(ROOT, "src/skills/__tests__/fixtures/compat/baseline.json");

interface FixtureSession {
  name: string;
  /** 未绑定 agent 的存量会话：只有 requestId / sessionId / message，**不含任何 agent 字段** */
  requestId: string;
  sessionId: string;
  message: string;
}

interface CaseSnapshot {
  /**
   * 该用例的输入侧标识（message）。
   *
   * ⚠️ 重要事实（第 1 步必须承认的覆盖局限）：
   *   本步的被测函数 `assembleForRequestMulti()` / `getToolDefinitions()` **都不接受会话参数**，
   *   因此三个夹具的**输出快照逐字节相同**。夹具在这里的作用不是「覆盖三条不同路径」，
   *   而是①固化「未绑定 agent」的输入形状；②给第 6 步（建真实 sessions 行）留好插槽。
   *   快照里保留 message，是为了让差异输出能看出「差异发生在哪个用例上」，
   *   以及在将来被测函数接受会话参数后**立刻区分开**。
   */
  inputMessage: string;
  /** ① system 注入文本 */
  systemText: string;
  /** ① 附：技能块明细，便于定位差异来源 */
  skillBlocks: Array<{ dir: string; l1Len: number; l1Truncated: boolean; l2Chars: number }>;
  /** ① 附：previewSkill 口径（走 profile=preview 的 4500 合计上限） */
  preview: Record<string, unknown> | null;
  /** ① 附：notices（chat.ts 会用 notice 事件逐条下发） */
  notices: string[];
  /** ② 工具清单（visibleName，**保持顺序**） */
  toolNames: string[];
  /** ③ 上游请求体 JSON（model / thinking 字段 / tools） */
  requestBody: string;
  /** ④ SSE 事件序列（本步离线可确定的部分：notice… → finish） */
  eventSequence: string[];
}

interface Snapshot {
  /** 决定输出的输入侧取值：两次运行必须一致，否则拒绝比对；**不记录敏感值** */
  inputs: Record<string, unknown>;
  cases: Record<string, CaseSnapshot>;
}

/** 固定输入：任何影响输出的量都要在这里登记（只登记形状与常量，不登记 apiKey） */
function collectInputs(): Record<string, unknown> {
  return {
    budget: { L1_MAX, L2_MAX, BUDGET_MAX },
    thinking: {
      mode: env.LLM_THINKING_MODE,
      thinking: env.LLM_THINKING,
      effort: env.LLM_REASONING_EFFORT,
    },
    model: env.LLM_MODEL,
    fixtureHasAgentField: false, // 占位：若夹具被篡改带入 agent 字段，需人工改这里以暴露
  };
}

async function captureCase(fx: FixtureSession): Promise<CaseSnapshot> {
  // ── ① system 文本：与 chat.ts 同一调用、同一入参（无参数） ──
  //    ⚠️ 无会话参数 → 三个用例的此段必然相同（见 CaseSnapshot.inputMessage 的说明）
  const asm = assembleForRequestMulti();

  // ── ② 工具清单：与 chat.ts 同一调用点（请求边界取一次） ──
  const toolDefs = getToolDefinitions();

  // ── ③ 上游请求体：复刻 chat.ts baseBody 的构造（只吃 env，无 agent） ──
  const baseBody = {
    model: env.LLM_MODEL,
    ...buildThinkingFieldsLocal(env.LLM_THINKING_MODE, env.LLM_THINKING, env.LLM_REASONING_EFFORT),
  };
  const requestBody = JSON.stringify({ ...baseBody, tools: toolDefs });

  // ── ④ 事件序列：本步离线可确定的部分（notices → finish） ──
  const eventSequence = [
    ...asm.notices.map((n) => `notice:${n}`),
    "finish:reason=stop",
  ];

  // ── ① 附：preview 口径（对参与装配的技能逐个取） ──
  const preview: Record<string, unknown> | null = asm.skills.length
    ? Object.fromEntries(
        asm.skills.map((s) => {
          const p = previewSkill(s.dir);
          return [
            s.dir,
            {
              l1: p.l1,
              l2: p.l2,
              truncated: p.truncated,
              omitted: p.omitted,
              sessionChars: p.sessionChars,
            },
          ];
        }),
      )
    : null;

  return {
    inputMessage: fx.message,
    systemText: asm.systemText,
    skillBlocks: asm.skills.map((s) => ({
      dir: s.dir,
      l1Len: s.l1.length,
      l1Truncated: s.l1Truncated,
      l2Chars: s.l2Chars,
    })),
    preview,
    notices: asm.notices,
    toolNames: toolDefs.map((d) => d.function.name),
    requestBody,
    eventSequence,
  };
}

async function capture(): Promise<Snapshot> {
  // 注册表就绪：顺序不能反（skill 校验要读工具注册表判断 unknown_tool）
  await ensureToolRegistry();
  await ensureSkillRegistry({ force: true });

  const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as { sessions: FixtureSession[] };
  const cases: Record<string, CaseSnapshot> = {};
  for (const fx of parsed.sessions) cases[fx.name] = await captureCase(fx);
  return { inputs: collectInputs(), cases };
}

/** 深比对：返回不等项描述（空数组 = 完全一致） */
function diff(a: unknown, b: unknown, path = ""): string[] {
  if (a === b) return [];
  if (typeof a !== typeof b || a === null || b === null) {
    return [`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return [`${path}: 类型不同（array / object）`];
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [`${path}: 长度 ${a.length} ≠ ${b.length}`];
    return a.flatMap((x, i) => diff(x, b[i], `${path}[${i}]`));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    return [
      ...diff(ka, kb, `${path}.keys`),
      ...ka.flatMap((k) => diff(oa[k], ob[k], `${path}.${k}`)),
    ];
  }
  // 字符串：定位第一个不同字符，改一个空格也能看见
  if (typeof a === "string" && typeof b === "string") {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const ctx = (s: string) => s.slice(Math.max(0, i - 30), i + 30);
    return [
      `${path}: 首个差异在第 ${i} 字\n    基线…${ctx(a)}…\n    当前…${ctx(b)}…`,
    ];
  }
  return [`${path}: ${String(a)} ≠ ${String(b)}`];
}

async function main(): Promise<number> {
  const writeBaseline = process.argv.includes("--baseline");
  const snap = await capture();

  if (writeBaseline) {
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify(snap, null, 2) + "\n", "utf8");
    const first = Object.values(snap.cases)[0];
    console.log(`✅ 基线已写入 ${BASELINE}`);
    console.log(
      `   用例 ${Object.keys(snap.cases).length} 个；工具 ${first ? first.toolNames.length : 0} 条`,
    );
    return 0;
  }

  if (!existsSync(BASELINE)) {
    console.error(`❌ 找不到基线 ${BASELINE}；请先跑 --baseline（须在改动前）`);
    return 2;
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Snapshot;

  // 输入未固定 → 退出 2，避免输出成堆假差异
  const inputDiff = diff(baseline.inputs, snap.inputs, "inputs");
  if (inputDiff.length > 0) {
    console.error("❌ 输入未固定（两次运行的 env / 配置形状不同），拒绝比对：");
    for (const d of inputDiff) console.error("   - " + d);
    return 2;
  }

  const diffs = diff(baseline.cases, snap.cases, "cases");
  if (diffs.length === 0) {
    console.log(
      `✅ 等价基线全绿：${Object.keys(snap.cases).length} 个用例，四类比对面逐字节一致`,
    );
    return 0;
  }
  console.error(`❌ 发现 ${diffs.length} 处不等：`);
  for (const d of diffs) console.error("   - " + d);
  return 1;
}

main().then((code) => process.exit(code));
