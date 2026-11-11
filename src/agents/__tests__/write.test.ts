/**
 * src/agents/__tests__/write.test.ts
 * [agent / 第 9 步 · 模块 7-A13] 写操作的单元测试（T-W1 ~ T-W12）
 *
 * ⚠️ 测试边界（重要）：
 *    write.ts 的 AGENTS_ROOT 是**模块级常量**，指向真实的 etc/agents。
 *    因此本文件**不测正向落盘**（那会污染运行时数据、破坏 verify:compat 的空目录前提），
 *    只测：
 *      ① 纯函数（路径归一 / 路径校验 / setup.json 序列化）
 *      ② 负向路径（非法输入必须被拒，且不产生任何文件）
 *    正向落盘由 §十 的浏览器手工验收覆盖。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
    buildSetupJson,
    deleteAgent,
    normalizeAgentPath,
    readAgentFile,
    upsertAgent,
    validateAgentPath,
} from "../write";
import { AGENTS_ROOT } from "../paths";

/* ============================================================
 * T-W1 ~ T-W3  路径归一
 * ============================================================ */

describe("normalizeAgentPath", () => {
    test("T-W1 去尾部斜杠与空白", () => {
        expect(normalizeAgentPath("  ops/devops  ")).toBe("ops/devops");
        expect(normalizeAgentPath("ops/devops/")).toBe("ops/devops");
        expect(normalizeAgentPath("ops/devops///")).toBe("ops/devops");
    });

    test("T-W1b 开头斜杠必须保留（交给 checkAgentPath 拒绝，不得静默改写）", () => {
        // 旧实现 replace(/^\/+|\/+$/g,"") 会把 "/ops/devops/" 变成 "ops/devops"，
        // 导致「不得为绝对路径」分支永不可达 —— 用户输入绝对路径会被悄悄写成相对路径。
        expect(normalizeAgentPath("/ops/devops/")).toBe("/ops/devops");
        expect(normalizeAgentPath("///ops/devops")).toBe("///ops/devops");
        expect(normalizeAgentPath("\\abs")).toBe("\\abs");
        // 归一后仍必须被校验拦下
        expect(validateAgentPath(normalizeAgentPath("/ops/devops"))).not.toBeNull();
    });

    test("T-W2 去掉用户误打的 .md 后缀（前端友好）", () => {
        expect(normalizeAgentPath("devops.md")).toBe("devops");
        expect(normalizeAgentPath("ops/devops.MD")).toBe("ops/devops");
    });

    test("T-W3 空输入归一为空串（交由校验拒绝）", () => {
        expect(normalizeAgentPath("")).toBe("");
        expect(normalizeAgentPath("   ")).toBe("");
        expect(normalizeAgentPath(null as unknown as string)).toBe("");
    });
});

/* ============================================================
 * T-W4 ~ T-W6  路径校验（复用 paths.checkAgentPath，不重复造规则）
 * ============================================================ */

describe("validateAgentPath", () => {
    test("T-W4 合法路径返回 null", () => {
        expect(validateAgentPath("devops")).toBeNull();
        expect(validateAgentPath("ops/devops")).toBeNull();
        expect(validateAgentPath("a/b/c")).toBeNull();     // 3 段 = 上限
        expect(validateAgentPath("my-agent")).toBeNull();  // 连字符合法
        expect(validateAgentPath("default")).toBeNull();   // D-B 默认 agent 目录名
    });

    test("T-W5 路径穿越与绝对路径必须被拒", () => {
        expect(validateAgentPath("")).not.toBeNull();
        expect(validateAgentPath("../escape")).not.toBeNull();
        expect(validateAgentPath("a/../../b")).not.toBeNull();
        expect(validateAgentPath("/etc/passwd")).not.toBeNull();
        expect(validateAgentPath("a\\b")).not.toBeNull();   // 反斜杠
    });

    test("T-W6 超深与非法规段被拒", () => {
        expect(validateAgentPath("a/b/c/d")).not.toBeNull();   // 4 段 > MAX_AGENT_DEPTH
        expect(validateAgentPath("1abc")).not.toBeNull();      // 数字开头
        expect(validateAgentPath("a__b")).not.toBeNull();      // 连续双下划线
        expect(validateAgentPath("__proto__")).not.toBeNull();  // 保留名
    });
});

/* ============================================================
 * T-W7 ~ T-W9  setup.json 序列化（字段名必须能被 parseAgentSetup 读回）
 * ============================================================ */

describe("buildSetupJson", () => {
    test("T-W7 最小形态只含 uid 与 name", () => {
        const text = buildSetupJson("ops/devops", "ag_7f3a9c21", {});
        const obj = JSON.parse(text);
        expect(obj.uid).toBe("ag_7f3a9c21");
        expect(obj.name).toBe("devops");        // name = 叶子名（§12.4）
        expect(obj.skills).toBeUndefined();
        expect(obj.tools).toBeUndefined();
    });

    test("T-W8 skills 用 list、limits 包 maxRounds、memory 包 enabled（与 parseAgentSetup 读取键一致）", () => {
        const text = buildSetupJson("ops/devops", "ag_7f3a9c21", {
            skillsMode: "allow",
            skillsAllow: ["hello", "log_triage"],
            maxRounds: 8,
            memoryEnabled: false,
        });
        const obj = JSON.parse(text);

        // 键名逐字对齐 setup.ts：skills.list / limits.maxRounds / memory.enabled
        expect(obj.skills.mode).toBe("allow");
        expect(obj.skills.list).toEqual(["hello", "log_triage"]);
        expect(obj.skills.allow).toBeUndefined();        // 不能写成 allow
        expect(obj.limits.maxRounds).toBe(8);
        expect(obj.maxRounds).toBeUndefined();           // 不能写在顶层
        expect(obj.memory.enabled).toBe(false);
    });

    test("T-W9 tools 允许 null（= 不限制）并保留 deny", () => {
        const text = buildSetupJson("devops", "ag_7f3a9c21", {
            toolsAllow: null,
            toolsDeny: ["shell_exec"],
        });
        const obj = JSON.parse(text);
        expect(obj.tools.allow).toBeNull();
        expect(obj.tools.deny).toEqual(["shell_exec"]);
    });
});

/* ============================================================
 * T-W10  负向：非法输入必须被拒，且不产生任何文件
 * ============================================================ */

describe("upsertAgent / deleteAgent 负向路径", () => {
    test("T-W10 非法路径一律拒绝且不落盘", () => {
        const bad = ["", "../escape", "/abs", "a/b/c/d", "1bad"];

        // 落盘判据：调用前后 etc/agents 的**顶层条目集合**必须完全不变。
        //
        // 为什么不写 expect(existsSync(join(AGENTS_ROOT, p))).toBe(false)：
        //   那个断言只在「目录本来就干净」时才有意义 —— 环境里只要有同名残留，
        //   就会误报失败（T-W10 第一次变红就是这么红的），而且它证明不了
        //   「本次调用没落盘」，只能证明「此刻这个路径不存在」。
        //   快照法直接回答「本次调用有没有改变磁盘」，不依赖环境初始状态。
        const before = readdirSync(AGENTS_ROOT).sort();

        for (const p of bad) {
            const r = upsertAgent({ path: p, body: "x" });
            expect(r.ok).toBe(false);
            expect(r.error).toBeTruthy();
        }

        const d = deleteAgent("../escape");
        expect(d.ok).toBe(false);

        const after = readdirSync(AGENTS_ROOT).sort();
        expect(after).toEqual(before);
    });

    test("T-W11 body 与 setup 都不给时报错", () => {
        const r = upsertAgent({ path: "sometestagent" });
        expect(r.ok).toBe(false);
        expect(r.error).toContain("至少");
    });

    test("T-W12 读不存在的目录返回空内容而非报错", () => {
        const r = readAgentFile("nonexistent/agent");
        expect(r.ok).toBe(true);
        expect(r.body).toBe("");
        expect(r.setupJson).toBe("");
    });
});
