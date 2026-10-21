/**
 * tests/repro-tool-platform.ts
 * [需求域 T] 平台工具能力扩展复现脚本（P0-c；不发起任何真实网络请求，N-08 / AC-51）
 *
 * 覆盖条目与断言对象：
 *   T-01 工具契约可选启用判定        → isToolEnabled()：未声明=启用、声明=实时读取
 *   T-02 启用判定变化热更立即生效    → isToolEnabled() 无缓存（连续调用各触发一次谓词）
 *   T-03/T-04 可选上下文 + 中断信号  → executeTool(wireName, args, ctx) 传入 ctx 仍正常；
 *                                      已中断的 signal → cancelled 信封且不启动工具
 *   T-05 命中但禁用 → 结构化返回     → toolError() 信封形状（executeTool 内联调用点见
 *                                      src/tools/index.ts；本期无 enabled 工具，端到端不可测）
 *   T-06 结果总长度兜底              → capToolResult() 纯函数 + executeTool 端到端
 *                                      （超长结果被截断且带原长标注）
 *   T-08 现有 13 个文件工具不变      → getToolDefinitions() 命名空间计数（总数 13 + 2 = 15）
 *
 * 运行（在 winbots/ 目录下）：
 *   bun run tests/repro-tool-platform.ts
 *   成功后退出码 0；任一断言失败退出码 1，并打印失败项。
 *
 * 说明：
 * - 必须先注入 Bun.env 再动态 import：src/infra/env.ts 在模块加载时即校验并固化配置（N-09）。
 * - 端到端截断用例会在工具实际解析的沙箱根（<项目根>/<FILE_ROOT_DIR>，默认 working）
 *   下临时建一个 5000 字符的文本文件，经真实工具 read_file 读取，结束后删除（不污染沙箱）。
 *   ⚠️ 写入目录必须由 env.FILE_ROOT_DIR 推导（与 _shared.getFileRoot() 同源），
 *      写死 "working" 会在 FILE_ROOT_DIR 被覆盖时导致写入点 ≠ 工具读取点（ERR_NOT_FOUND）。
 * - 本脚本不启动假上游、不访问网络：只调用工具层与纯函数。
 */

// ── 1. 注入环境变量（任何业务模块 import 之前）────────────────────────────
Bun.env.APP_PORT = "0";
Bun.env.LLM_API_BASE = "http://127.0.0.1:1/v1";        // 不使用：本脚本不发上游请求
Bun.env.LLM_API_KEY = "test-key-not-used";
Bun.env.LLM_MODEL = "fake-model";
Bun.env.FILE_READ_ENABLED = "true";
Bun.env.FILE_CREATE_ENABLED = "false";
Bun.env.FILE_MODIFY_ENABLED = "false";
Bun.env.LLM_LOG_ENABLED = "false";
Bun.env.TOOL_RESULT_MAX_CHARS = "32000";

const tools = await import("../src/tools/index.ts");
const { env } = await import("../src/infra/env.ts");

const { mkdir, writeFile, unlink, rmdir } = await import("fs/promises");
const { existsSync } = await import("fs");
const { resolve } = await import("path");

// ============================================================
// 断言容器
// ============================================================

interface Check {
    name: string;
    ok: boolean;
    detail: string;
}
const checks: Check[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
    checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
}

/** 安全 JSON 解析（解析失败返回 null，不抛错） */
function parseJson(text: string): Record<string, unknown> | null {
    try {
        const v: unknown = JSON.parse(text);
        return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

// ============================================================
// 主流程
// ============================================================

// [修订 / T-06 端到端] 沙箱根必须与工具实现同源：
//   etc/tools/local/_shared.ts 的 getFileRoot() = <项目根>/<env.FILE_ROOT_DIR>。
//   原先写死 "../working"，一旦 FILE_ROOT_DIR 被环境变量/配置页覆盖，写入点与工具读取点
//   不一致，真实工具 read_file 返回 ERR_NOT_FOUND（本次实测即 84 字节的错误信封）。
const WORKING_DIR = resolve(import.meta.dir, "..", env.FILE_ROOT_DIR);
const TMP_REL = ".t-domain-repro.txt";
const TMP_FILE = resolve(WORKING_DIR, TMP_REL);
let createdWorkingDir = false;

try {
    // ── 0. 加载注册表（幂等；把 etc/tools 下真实工具装进来）────────────
    await tools.loadTools();

    // ── 1. T-08 / AC-18 / AC-20：现有 13 个文件工具全部在列表中 ─────────
    const defs = tools.getToolDefinitions();
    // [修订 / 需求域 R] R 域新增 2 个联网工具，模型可见总数为 13 + 2 = 15。
    //   T-08 原意是「原有 13 个文件工具不因启用判定/长度兜底而消失」，
    //   故总数断言改为 15，并由下一条「按命名空间计数」的断言守住原意。
    check("T-08｜模型可见工具数 = 13 + 2 = 15", defs.length === 15, defs.length);
    const names = defs.map((d) => d.function.name);
    check(
        "T-08｜全部符合 ^[a-zA-Z0-9_-]{1,64}$",
        names.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)),
        names.filter((n) => !/^[a-zA-Z0-9_-]{1,64}$/.test(n)),
    );
    check("T-08｜含 local__common__get_current_time", names.includes("local__common__get_current_time"), names.length);
    check("T-08｜无重名", new Set(names).size === names.length, new Set(names).size);
    // [修订] AC-20：未声明 enabled 的 13 个原有工具必须全部保留。
    //   原断言用 `defs.length === 13` 表达，R 域新增工具后必然失败（且 detail 打印的是
    //   fileRead 的 5，与失败语义无关，易误读）。改为按命名空间计数，与总数解耦：
    //   common 1 + fileRead 5 + fileModify 4 + fileNew 3 = 13。
    const countInNamespace = (ns: string): number =>
        names.filter((n) => n.startsWith(`${ns}__`)).length;
    const legacyCounts = {
        "local__common": countInNamespace("local__common"),
        "local__fileRead": countInNamespace("local__fileRead"),
        "local__fileModify": countInNamespace("local__fileModify"),
        "local__fileNew": countInNamespace("local__fileNew"),
    };
    check(
        "T-08｜无 enabled 谓词的现有 13 个工具全部保留（AC-20）",
        legacyCounts["local__common"] === 1 &&
            legacyCounts["local__fileRead"] === 5 &&
            legacyCounts["local__fileModify"] === 4 &&
            legacyCounts["local__fileNew"] === 3 &&
            names.includes("local__fileRead__read_file"),
        legacyCounts,
    );
    // AC-14 对照：没有 enabled 谓词时，两次快照必须完全一致（进程未重启）
    const defs2 = tools.getToolDefinitions();
    check(
        "T-02｜两次快照一致（无 enabled 工具时列表稳定）",
        JSON.stringify(defs.map((d) => d.function.name)) === JSON.stringify(defs2.map((d) => d.function.name)),
        defs2.length,
    );

    // ── 2. T-01：isToolEnabled 的三种输入 ─────────────────────────────
    check("T-01｜未声明 enabled → 启用", tools.isToolEnabled({}) === true, "true");

    let flag = true;
    const toggled = { enabled: () => flag };
    const first = tools.isToolEnabled(toggled);
    flag = false;
    const second = tools.isToolEnabled(toggled);
    flag = true;
    const third = tools.isToolEnabled(toggled);
    check(
        "T-01/T-02｜谓词结果翻转即刻反映（true→false→true，无重启）",
        first === true && second === false && third === true,
        { first, second, third },
    );

    let calls = 0;
    const counted = { enabled: () => { calls++; return true; } };
    tools.isToolEnabled(counted);
    tools.isToolEnabled(counted);
    check("T-02｜每次判定都实时调用谓词（不缓存）", calls === 2, calls);

    const throwing = {
        enabled: () => {
            throw new Error("boom");
        },
    };
    let threw = false;
    let throwingResult = true;
    try {
        throwingResult = tools.isToolEnabled(throwing);
    } catch {
        threw = true;
    }
    check("T-01｜谓词抛错 → 按已禁用处理且不向调用方抛错", threw === false && throwingResult === false, {
        threw,
        throwingResult,
    });

    // ── 3. T-05：结构化错误信封形状 ───────────────────────────────────
    const disabledEnvelope = parseJson(tools.toolError("tool_disabled", "工具 X 当前已禁用，本次未执行。"));
    check(
        "T-05｜禁用信封为 { ok:false, error:{ code, message } }",
        disabledEnvelope?.ok === false &&
            (disabledEnvelope?.error as { code?: string } | undefined)?.code === "tool_disabled",
        disabledEnvelope,
    );

    // ── 4. T-06：capToolResult 纯函数 ─────────────────────────────────
    const long = "x".repeat(500);
    const capped = tools.capToolResult(long, 100);
    check("T-06｜超长截断后长度不超过上限", capped.length <= 100, capped.length);
    check("T-06｜截断标注含原长与上限", capped.includes("已截断") && capped.includes("500") && capped.includes("100"), capped.slice(-90));
    check("T-06｜未超限原样返回", tools.capToolResult("short", 100) === "short", tools.capToolResult("short", 100));
    check("T-06｜上限 <=0 视为不限制", tools.capToolResult(long, 0) === long, tools.capToolResult(long, 0).length);

    // ── 5. T-03/T-04：executeTool 的上下文与中断 ───────────────────────
    const okCtx = new AbortController().signal;
    const normal = parseJson(
        await tools.executeTool("local__common__get_current_time", {}, { signal: okCtx, sessionId: "sess_repro" }),
    );
    check(
        "T-03｜现有单参 handler 传 ctx 后仍正常（AC-16 回归）",
        // get_current_time 返回 { iso, local, timezone }（非 ok() 包裹），据此判定工具确实执行了
        typeof normal?.iso === "string" && typeof normal?.timezone === "string",
        normal,
    );

    const unknown = parseJson(await tools.executeTool("nope__nope__nope", {}));
    check("T-04｜未知工具仍返回既有错误形状（行为未变）", typeof unknown?.error === "string", unknown);

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = parseJson(
        await tools.executeTool("local__common__get_current_time", {}, { signal: aborted.signal }),
    );
    check(
        "T-04｜已中断的 signal → cancelled 信封（工具未启动）",
        cancelled?.ok === false &&
            (cancelled?.error as { code?: string } | undefined)?.code === "cancelled",
        cancelled,
    );

    // ── 6. T-06 端到端：超长结果经 executeTool 出口被截断 ──────────────
    //    造一个 5000 字符的文本文件，用真实工具 read_file 读取（JSON 结果 > 5000 字符）
    const hadWorkingDir = existsSync(WORKING_DIR);
    await mkdir(WORKING_DIR, { recursive: true });
    createdWorkingDir = !hadWorkingDir;
    await writeFile(TMP_FILE, "T".repeat(5000), "utf-8");

    const baselineRaw = await tools.executeTool("local__fileRead__read_file", { path: TMP_REL });
    const baseline = parseJson(baselineRaw);
    check(
        "T-06｜基线：读取未被截断且结果超过 5000 字符",
        baseline?.ok === true && baselineRaw.length > 5000,
        `${baselineRaw.length} @ ${TMP_FILE}`,
    );

    env.TOOL_RESULT_MAX_CHARS = 1000;      // 模拟配置收紧上限（热更同一路径）
    const cappedRaw = await tools.executeTool("local__fileRead__read_file", { path: TMP_REL });
    env.TOOL_RESULT_MAX_CHARS = 32000;     // 还原

    check("T-06｜端到端：出口结果长度不超过上限", cappedRaw.length <= 1000, cappedRaw.length);
    check(
        "T-06｜端到端：截断带标注（原长可见）",
        cappedRaw.includes("已截断") && cappedRaw.includes(String(baselineRaw.length)),
        cappedRaw.slice(-90),
    );

    try {
        await unlink(TMP_FILE);
        if (createdWorkingDir) await rmdir(WORKING_DIR).catch(() => undefined);
    } catch {
        /* 清理失败不影响断言结果 */
    }
} catch (err) {
    check("执行未抛异常", false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    try {
        await unlink(TMP_FILE);
    } catch {
        /* ignore */
    }
}

// ============================================================
// 结果汇总
// ============================================================
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
    console.log(`${c.ok ? "✅" : "❌"} ${c.name} → ${c.detail}`);
}
console.log("-".repeat(60));
console.log(`共 ${checks.length} 项断言，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length > 0) process.exit(1);
