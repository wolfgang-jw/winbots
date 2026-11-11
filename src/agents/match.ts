/**
 * src/agents/match.ts
 * 通配匹配的**唯一实现**（§3.1「实现只有一份」）。
 *
 * 匹配口径（§3.1 统一说明，逐条落地）：
 *   · 只支持**末尾** `*`（前缀匹配）；不支持中间 `*`、不支持正则。
 *     → 因此实现上不需要「通配引擎」，只要 endsWith("*") 判定 + startsWith 比较。
 *   · 其余位置出现的 `*` / `.` / `+` 等一律按**普通字符**比较，不解释为正则元字符。
 *   · 多条规则时：任一命中即命中（OR）。
 *
 * ⚠️ 本文件**不含业务语义**：不判断「是否允许」，只回答「这个模式串是否匹配这个值」。
 *    技能白名单（第 3 步）与工具 allow/deny（第 4 步）各自在此之上做策略组合，
 *    「deny 优先于 allow」之类的规则**不在本文件**。
 */

/**
 * 单条模式是否匹配值。
 *
 * @param pattern 形如 `local__fileRead__*` 或 `examples/log_triage`（精确）
 * @param value   形如 `local__fileRead__read_file` 或 `examples/log_triage`
 */
export function matchWildcard(pattern: string, value: string): boolean {
  if (pattern === "") return false;
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    // 只认末尾 *：去掉它做前缀比较。中间/开头的 * 走不到这里，
    // 会被下面的 === 当作普通字符 —— 这正是需求要的「不支持中间 *」。
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === pattern;
}

/**
 * 多条模式中任一命中即 true。
 *
 * @param patterns null / 空数组 → false。
 *   **「不限制」的语义由调用方判断**（null 表示不过滤），不在本函数里把 null 当 true，
 *   否则「白名单为空」与「不限制」就会被混为一谈 —— 那是安全性质错误。
 */
export function matchesAny(patterns: readonly string[] | null, value: string): boolean {
  if (patterns === null) return false;
  for (const p of patterns) {
    if (matchWildcard(p, value)) return true;
  }
  return false;
}
