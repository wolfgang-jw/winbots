/**
 * src/infra/migrate.ts
 * 存量配置项一次性分流（规范 §9.2）。
 *
 * 判据与去向：
 *   已被组开关语义取代           → **删除，不迁移**（§9.2 表第一行；本次：5 个 *_ENABLED）。
 *                                  它们只表达「旧工具是否可见」，而初始态一律关闭（§8.2），
 *                                  故不写任何等价键；升级后需在配置页重新开启所需工具
 *                                  （替代方案「旧值转成 TOOLON__*」已被否决，理由见文档 §7.2）
 *   同一目录下多个工具组共用     → 下沉为目录设置项（本次：FILE_ROOT_DIR → local）
 *   仅一个工具组使用             → 下沉为该组设置项（其余全部）
 *   被系统模块跨模块读取 / 影响进程 → 保留为系统配置项（不在此表内，保持不动）
 *
 * 细则：目标键已存在则不覆盖；旧值不满足新声明 → 跳过并告警、保留原行；
 *       成功的项在**同一次原子写入**中完成「写新键 + 删旧行」；重复执行无副作用。
 */

import { applyConfigChanges, parseEnvText, readEnvFile } from "./configFile";
import { formatSettingValue, parseSettingValue } from "./settings";
import { getRegistry } from "@/tools/scan";

/**
 * 旧「启用开关」：**删除，不迁移**（§9.2 表第一行）。
 *
 * 为什么不做等价转换（把 `true` 写成 `TOOLON__<节点>=true`）：规范 §8.2 规定初始态全部关闭，
 *   把旧值搬过来等于让历史配置继续左右可用性，与 §15-10「旧启用开关不再影响任何工具的可用性」冲突。
 *   代价是升级后需在配置页重新开启所需工具，已用三处显式提示覆盖
 *   （启动日志 / `.env.example` / README），完整取舍与回滚办法见文档 §7.2。
 */
const DROP_SWITCH_KEYS: readonly string[] = [
  "FILE_READ_ENABLED",
  "FILE_CREATE_ENABLED",
  "FILE_MODIFY_ENABLED",
  "INTERNET_ENABLED",
  "BROWSER_ENABLED",
];

/**
 * 旧键 → 新键（完整托管键）。
 * ⚠️ 这张表是 §9.2 判据的唯一落点：新增/改名的下沉项必须同步这里，否则升级即丢值。
 */
const DOWN_SINK: ReadonlyArray<readonly [string, string]> = [
  // ── local 目录项（文件工具与 shell 共用）
  ["FILE_ROOT_DIR", "etc__tools__local__file_root_dir"],

  // ── local/fileRead 组项
  ["FILE_READ_DEFAULT_LINES", "TOOLSET__local__fileRead__default_lines"],

  // ── local/shell 组项（15 项）
  ["SHELL_PERMISSION", "TOOLSET__local__shell__permission"],
  ["SHELL_APPROVAL_WAIT_MS", "TOOLSET__local__shell__approval_wait_ms"],
  ["SHELL_SESSION_MEMORY_ENABLED", "TOOLSET__local__shell__session_memory_enabled"],
  ["SHELL_ALLOW_ALL_OPTION", "TOOLSET__local__shell__allow_all_option"],
  ["SHELL_DENY_COOLDOWN_MS", "TOOLSET__local__shell__deny_cooldown_ms"],
  ["SHELL_TYPE", "TOOLSET__local__shell__type"],
  ["SHELL_TIMEOUT_DEFAULT_MS", "TOOLSET__local__shell__timeout_default_ms"],
  ["SHELL_TIMEOUT_MAX_MS", "TOOLSET__local__shell__timeout_max_ms"],
  ["SHELL_OUTPUT_MAX_CHARS", "TOOLSET__local__shell__output_max_chars"],
  ["SHELL_MAX_COMMAND_CHARS", "TOOLSET__local__shell__max_command_chars"],
  ["SHELL_MAX_CONCURRENCY", "TOOLSET__local__shell__max_concurrency"],
  ["SHELL_UTF8_UNIFY", "TOOLSET__local__shell__utf8_unify"],
  ["SHELL_DENY_LIST", "TOOLSET__local__shell__deny_list"],
  ["SHELL_ALLOW_LIST", "TOOLSET__local__shell__allow_list"],
  ["SHELL_EXTRA_ENV_KEYS", "TOOLSET__local__shell__extra_env_keys"],

  // ── internet/web 组项（13 项）
  ["INTERNET_SEARCH_PROVIDER", "TOOLSET__internet__web__search_provider"],
  ["INTERNET_FETCH_PROVIDER", "TOOLSET__internet__web__fetch_provider"],
  ["INTERNET_DEEPSEEK_API_KEY", "TOOLSET__internet__web__deepseek_api_key"],
  ["INTERNET_DEEPSEEK_BASE_URL", "TOOLSET__internet__web__deepseek_base_url"],
  ["INTERNET_DEEPSEEK_SEARCH_PATH", "TOOLSET__internet__web__deepseek_search_path"],
  ["INTERNET_DEEPSEEK_FETCH_PATH", "TOOLSET__internet__web__deepseek_fetch_path"],
  ["INTERNET_DEFAULT_COUNT", "TOOLSET__internet__web__default_count"],
  ["INTERNET_TIMEOUT_MS", "TOOLSET__internet__web__timeout_ms"],
  ["INTERNET_FETCH_MAX_CHARS", "TOOLSET__internet__web__fetch_max_chars"],
  ["INTERNET_STORE_TTL_S", "TOOLSET__internet__web__store_ttl_s"],
  ["INTERNET_STORE_MAX_ITEMS_PER_SESSION", "TOOLSET__internet__web__store_max_items_per_session"],
  ["INTERNET_STORE_MAX_CHARS_PER_ITEM", "TOOLSET__internet__web__store_max_chars_per_item"],
  ["INTERNET_STORE_MAX_CHARS_TOTAL", "TOOLSET__internet__web__store_max_chars_total"],

  // ── internet/browser 组项（24 项，BROWSER_ENABLED 已废弃不在表内）
  ["BROWSER_EXECUTABLE_PATH", "TOOLSET__internet__browser__executable_path"],
  ["BROWSER_HEADLESS", "TOOLSET__internet__browser__headless"],
  ["BROWSER_FOREGROUND_ON_OPEN", "TOOLSET__internet__browser__foreground_on_open"],
  ["BROWSER_DEBUG_PORT", "TOOLSET__internet__browser__debug_port"],
  ["BROWSER_PROFILE_MODE", "TOOLSET__internet__browser__profile_mode"],
  ["BROWSER_PROFILE_DIR", "TOOLSET__internet__browser__profile_dir"],
  ["BROWSER_SESSION_TTL_S", "TOOLSET__internet__browser__session_ttl_s"],
  ["BROWSER_MAX_SESSIONS", "TOOLSET__internet__browser__max_sessions"],
  ["BROWSER_MAX_TABS", "TOOLSET__internet__browser__max_tabs"],
  ["BROWSER_ACTION_TIMEOUT_MS", "TOOLSET__internet__browser__action_timeout_ms"],
  ["BROWSER_NAV_TIMEOUT_MS", "TOOLSET__internet__browser__nav_timeout_ms"],
  ["BROWSER_STABLE_WINDOW_MS", "TOOLSET__internet__browser__stable_window_ms"],
  ["BROWSER_SNAPSHOT_MAX_ELEMENTS", "TOOLSET__internet__browser__snapshot_max_elements"],
  ["BROWSER_SNAPSHOT_MAX_CHARS", "TOOLSET__internet__browser__snapshot_max_chars"],
  ["BROWSER_EXTRACT_MAX_CHARS", "TOOLSET__internet__browser__extract_max_chars"],
  ["BROWSER_EXTRACT_MAX_ELEMENTS", "TOOLSET__internet__browser__extract_max_elements"],
  ["BROWSER_MAX_ACTIONS", "TOOLSET__internet__browser__max_actions"],
  ["BROWSER_DOMAIN_ALLOWLIST", "TOOLSET__internet__browser__domain_allowlist"],
  ["BROWSER_DOMAIN_BLOCKLIST", "TOOLSET__internet__browser__domain_blocklist"],
  ["BROWSER_BLOCK_PRIVATE_NET", "TOOLSET__internet__browser__block_private_net"],
  ["BROWSER_ALLOW_DOWNLOAD", "TOOLSET__internet__browser__allow_download"],
  ["BROWSER_ALLOW_UPLOAD", "TOOLSET__internet__browser__allow_upload"],
  ["BROWSER_DRAG_STEPS", "TOOLSET__internet__browser__drag_steps"],
  ["BROWSER_TYPE_DELAY_MS", "TOOLSET__internet__browser__type_delay_ms"],
];

let migrated = false;

/**
 * 旧值是「逗号分隔文本」的键：迁移时先切分成数组再校验（R-12）。
 * 这些项在新声明里是 `string_array`（§7.2 支持数组，且数组以 JSON 文本持久化），
 * 若直接拿 "format,diskpart,…" 去按数组校验会被拒 → 旧值被跳过、用户以为迁移成功。
 * `SHELL_ALLOW_LIST` 的旧默认值 `none` 表示「未启用」，迁移时视为空数组；空串同样视为空数组。
 */
const COMMA_LIST_KEYS: ReadonlySet<string> = new Set([
  "SHELL_DENY_LIST",
  "SHELL_ALLOW_LIST",
  "SHELL_EXTRA_ENV_KEYS",
  "BROWSER_DOMAIN_ALLOWLIST",
  "BROWSER_DOMAIN_BLOCKLIST",
]);

/**
 * 幂等入口：只在进程内第一次成功扫描后执行一次。
 * @returns true = 已完成（含「无旧键可迁」）；false = 写盘失败，调用方应保持「未完成」以便下次重试
 */
export async function runLegacyMigration(): Promise<boolean> {
  if (migrated) return true;
  migrated = true;                          // 先置位：防并发重入（失败时在末尾复位）

  try {
    return await doMigrate();
  } catch (err) {
    console.warn(`⚠️  [migrate] 迁移异常（${err instanceof Error ? err.message : String(err)}），下次启动将重试`);
    migrated = false;
    return false;
  }
}

async function doMigrate(): Promise<boolean> {
  const reg = getRegistry();
  const fileMap = parseEnvText(readEnvFile().text);

  const writes: Record<string, string> = {};
  const deletes: string[] = [];
  const skipped: string[] = [];

  // ① 旧「启用开关」：**删除，不迁移**（§9.2 表第一行）。只删行，不写任何等价的新键。
  //    删掉后所有节点的开关都回到 §8.2 的初始默认（关闭），用户按需在配置页开启。
  const droppedLegacy = DROP_SWITCH_KEYS.filter((k) => fileMap.has(k));
  if (droppedLegacy.length > 0) {
    deletes.push(...droppedLegacy);
    console.log(
      `🚚 [migrate] 删除 ${droppedLegacy.length} 个已废弃的旧启用开关（§9.2「删除，不迁移」）：` +
      `${droppedLegacy.join(", ")}。旧开关表达的「是否可见」不迁移 → 所有目录 / 工具组回到初始关闭，` +
      `请到配置页 › 工具配置项 中重新开启需要的工具（详见 README）。`,
    );
  }

  // ② 下沉键：写新键 + 删旧行（同一次原子写入）
  for (const [oldKey, newKey] of DOWN_SINK) {
    if (!fileMap.has(oldKey)) continue;
    const oldValue = fileMap.get(oldKey) as string;
    const def = reg.settingDefs.get(newKey);
    if (!def) {
      // 目标键未注册（例如该工具组已被删除 / 挂起）→ 不动旧行，交给「遗留键」区块处理
      skipped.push(oldKey);
      continue;
    }
    // 旧值格式归一（逗号分隔文本 → JSON 数组文本），见 COMMA_LIST_KEYS
    const oldText = COMMA_LIST_KEYS.has(oldKey)
      ? JSON.stringify(
          oldValue.split(",").map((s) => s.trim())
            .filter((s) => s !== "" && s.toLowerCase() !== "none"),
        )
      : oldValue;
    const parsed = parseSettingValue(def, oldText);
    if (!parsed.ok) {
      skipped.push(oldKey);
      console.warn(`⚠️  [migrate] ${oldKey} 的旧值不满足新声明（${parsed.reason}），已跳过并保留原行`);
      continue;
    }
    if (fileMap.has(newKey)) {
      skipped.push(oldKey);   // 目标键已存在：以用户当前值为准，不覆盖
      continue;
    }
    writes[newKey] = formatSettingValue(def, parsed.value);
    deletes.push(oldKey);
  }

  if (Object.keys(writes).length === 0 && deletes.length === 0) {
    if (skipped.length > 0) {
      console.log(`ℹ️  [migrate] 有 ${skipped.length} 个旧键已跳过（目标键已存在或值不合法），未做改动`);
    }
    return true;
  }

  // 白名单（R-24）：**写入侧**与**删除侧**分开给。
  //   ⚠️ 旧键（FILE_ROOT_DIR / FILE_READ_ENABLED …）已被移出 CONFIG_KEYS，
  //      按定义不在注册表里；不放进 allowDeleteKeys 就会被判成「不允许删除」→ ok:false →
  //      migrated 一直为 false → 每个请求重试、永不成功。
  const res = applyConfigChanges({
    changes: writes,
    deleteKeys: deletes,
    allowedKeys: reg.registeredKeys,
    allowDeleteKeys: new Set(deletes),
  });
  if (!res.ok) {
    console.warn(`⚠️  [migrate] 迁移写入失败（${res.error ?? "见接口校验错误"}），下次启动将重试`);
    migrated = false;
    return false;
  }
  // ['工具/技能配置归位 setup.json'] 不再有全局托管键缓存可刷：
  //   工具/技能配置已迁到各 agent 的 setup.json（见 infra/toolConfigContext.ts）。
  //   这里只做迁移写入，运行期每次请求按所绑 agent 的 record 构造上下文。
  console.log(
    `🚚 [migrate] 存量配置已分流：写入 ${res.written.length} 个新键、清除 ${res.deleted.length} 个旧行` +
    `${skipped.length > 0 ? `、跳过 ${skipped.length} 个` : ""}（备份 ${res.backupFile ?? "无"}）`,
  );
  return true;
}
