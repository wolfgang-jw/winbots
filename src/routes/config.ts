/**
 * src/routes/config.ts
 * 配置读写接口（配置页专用）
 *
 * 挂载点：/api/config
 *   - GET  /api/config        读取 15 项配置（密钥不回显）
 *   - PUT  /api/config        修改配置并写回 .env（需 confirm: true）
 *
 * 安全：仅写入白名单键；值禁换行；不回显/不记录密钥明文（需求 §4.7）。
 */
import { Hono } from "hono";
import { existsSync } from "fs";
import { env, envShadowedBySystem, reloadEnvExcluding } from "@/infra/env";
import {
  CONFIG_KEYS,
  CONFIG_KEY_SET,
  ENV_PATH,
  BACKUP_DIR,
  buildConfigItems,
  applyConfigChanges,
} from "@/infra/configFile";

const router = new Hono();

/** 永远需要重启的键（需求 §4.3：APP_PORT 绑端口，origin.ts 亦在模块级构造白名单） */
const RESTART_KEYS: ReadonlySet<string> = new Set<string>(["APP_PORT"]);

/**
 * 阶段开关（需求 §1.3）：
 *   - false → 阶段 A：保存后全部改动均提示「需重启」；
 *   - true  → 阶段 B：除 APP_PORT 外，改动保存后热更立即生效（§4.6）。
 * 该常量同时是开关式回滚：改回 false 即立刻退回阶段 A 行为。
 */
const HOT_RELOAD_ENABLED: boolean = true;

/** 阶段 A → 全部需重启；阶段 B → 仅 APP_PORT */
function restartKeysFor(changed: string[]): string[] {
  if (!HOT_RELOAD_ENABLED) return changed;
  return changed.filter((k) => RESTART_KEYS.has(k));
}

/** 当前「需重启」的键集合（GET 用） */
function allRestartKeys(): ReadonlySet<string> {
  if (!HOT_RELOAD_ENABLED) return new Set(CONFIG_KEYS.map((m) => m.key));
  return RESTART_KEYS;
}

// GET /api/config —— 读取全部配置（只读，无副作用，不写日志）
router.get("/", (c) => {
  const items = buildConfigItems(
    allRestartKeys(),
    envShadowedBySystem,
    HOT_RELOAD_ENABLED ? ((k: string) => (env as unknown as Record<string, unknown>)[k]) : undefined,
  );
  c.header("Cache-Control", "no-store");   // 防浏览器缓存导致"保存后仍显示旧值"
  return c.json({
    ok: true,
    envPath: ENV_PATH,
    envExists: existsSync(ENV_PATH),
    backupDir: BACKUP_DIR,
    restartRequiredKeys: [...allRestartKeys()],
    hotReloadEnabled: HOT_RELOAD_ENABLED,
    items,
  });
});

// PUT /api/config —— 修改配置并写回 .env
router.put("/", async (c) => {
  // ① 解析 body
  let body: { confirm?: unknown; changes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: "ERR_ILLEGAL_CHARS", error: "请求体不是合法 JSON" }, 400);
  }

  // ② 硬前置：confirm === true（沿用 log.ts 的确认约定，需求 §4.7 S2）
  if (body?.confirm !== true) {
    return c.json(
      { ok: false, code: "ERR_NO_CONFIRM", error: "修改配置需显式确认（confirm: true）" },
      400,
    );
  }

  // ③ changes 必须为非空对象
  const changes = body.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return c.json({ ok: false, code: "ERR_EMPTY_CHANGES", error: "changes 必须为对象" }, 400);
  }
  const entries = Object.entries(changes as Record<string, unknown>);
  if (entries.length === 0) {
    return c.json({ ok: false, code: "ERR_EMPTY_CHANGES", error: "changes 不能为空" }, 400);
  }

  // ④ 归一化 + 拦未知键与非法字符
  const normalized: Record<string, string> = {};
  const unknown: string[] = [];
  for (const [k, v] of entries) {
    if (!CONFIG_KEY_SET.has(k)) { unknown.push(k); continue; }
    if (typeof v !== "string") {
      return c.json(
        { ok: false, code: "ERR_INVALID_VALUE", error: `配置值必须为字符串：${k}` },
        400,
      );
    }
    if (/[\r\n]/.test(v)) {
      return c.json(
        { ok: false, code: "ERR_ILLEGAL_CHARS", error: `值不能包含换行符：${k}` },
        400,
      );
    }
    const meta = CONFIG_KEYS.find((m) => m.key === k)!;
    // secret 且留空 → 语义为"不修改"，直接剔除（AC-CFG-4）
    if (meta.secret && v.trim() === "") continue;
    normalized[k] = v.trim();
  }
  if (unknown.length > 0) {
    return c.json(
      { ok: false, code: "ERR_UNKNOWN_KEY", error: `不允许的配置项：${unknown.join(", ")}` },
      400,
    );
  }
  if (Object.keys(normalized).length === 0) {
    return c.json(
      { ok: false, code: "ERR_EMPTY_CHANGES", error: "没有实际改动（密钥留空视为不修改）" },
      400,
    );
  }

  // ⑤ 校验 + 备份 + 写盘
  const result = applyConfigChanges(normalized);
  if (!result.ok) {
    if (result.invalid) {
      const fields: Record<string, string> = {};
      for (const it of result.invalid) fields[it.key] = it.reason;
      return c.json(
        { ok: false, code: "ERR_INVALID_VALUE", error: "存在不合法配置值", fields },
        400,
      );
    }
    // 错误摘要可能含路径，但**不含任何配置值**（需求 §4.4.2 约束 4）
    return c.json(
      { ok: false, code: "ERR_WRITE_FAILED", error: result.error || "写入 .env 失败" },
      500,
    );
  }

  // ⑥ 阶段 B：热更新（批 3 打开开关后生效，见 §4）
  let hotApplied: string[] = [];
  if (HOT_RELOAD_ENABLED) {
    hotApplied = reloadEnvExcluding(["APP_PORT"]);   // APP_PORT 永不热更（§4.2）
  }

  const changed = result.changed;
  return c.json({
    ok: true,
    changed,
    hotApplied,
    restartRequired: restartKeysFor(changed),
    backupFile: result.backupFile,
    envCreated: result.envCreated,
    degraded: result.degraded === true ? "写入未使用原子重命名（已回退为覆盖写）" : undefined,
  });
});

export default router;
