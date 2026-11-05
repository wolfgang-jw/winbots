/**
 * src/skills/tools.ts
 * 工具白名单交集（§7.3 / N-SK-8）。
 *
 * ⚠️ 未知工具名在**扫描期**就已挂起整条 skill（§7.3），所以这里拿到的 tools 一定都已注册；
 *    但本函数仍然只做 filter，**绝不做任何 push** —— 这是安全红线。
 */
import type { ToolDef } from "@/tools";
import { getRegistry } from "@/tools/scan";
import { groupState } from "@/infra/settings";

export interface WhitelistResult {
  list: ToolDef[];
  /** 本次是否真的收窄了（用于日志与预览） */
  narrowed: boolean;
  /**
   * 声明了但**不可用**：注册表里没有该名字（名字写错），或所属组当前不可用
   * （TOOLON__ 关 / 上级目录关 / 组挂起）。
   * 这两类都归这里，因为用户要改的都是「开关或名字」，不是工具自身权限（C-36）。
   */
  dropped: string[];
  /**
   * 声明了、组可用，但**被工具自身 enabled() 挡掉**
   * （典型：local/shell 的 permission=forbid）。
   * 必须与 dropped 分开报：这一类的解法是「放开该工具自身条件」，不是「去开组开关」。
   */
  selfDisabled: string[];
}

export function applyToolWhitelist(list: ToolDef[], callNames: string[]): WhitelistResult {
  if (!Array.isArray(callNames) || callNames.length === 0) {
    return { list, narrowed: false, dropped: [], selfDisabled: [] };
  }
  const reg = getRegistry();
  // callName（点号）→ visibleName（双下划线）：ToolDef.function.name 用的是 visibleName
  const visible = new Set<string>();
  const dropped: string[] = [];
  for (const call of callNames) {
    const rec = reg.tools.get(call);
    if (rec) visible.add(rec.visibleName);
    else dropped.push(call);
  }
  const narrowedList = list.filter((d) => visible.has(d.function.name));
  // 注册表里有、可见清单里没有 → 两种可能，必须分开报（C-36）：
  //   ① 所属组当前不可用（TOOLON__ 关闭 / 目录关闭 / 组挂起）→ 归 dropped，因为用户要改的是「开关」；
  //   ② 组可用但工具自身 enabled() 为 false（典型：local/shell 的 permission=forbid）→ selfDisabled。
  //   早期实现把两种都塞进 selfDisabled 并只提示「放开工具权限」，组被关时会误导用户去改档位。
  const selfDisabled: string[] = [];
  for (const call of callNames) {
    const rec = reg.tools.get(call);
    if (!rec) continue;
    if (narrowedList.some((d) => d.function.name === rec.visibleName)) continue;
    const st = rec.groupId ? groupState(rec.groupId) : null;
    if (st && !st.available) dropped.push(call);
    else selfDisabled.push(call);
  }
  console.log(
    `🧰 [skill-tools] 白名单收窄：全量 ${list.length} → ${narrowedList.length}` +
    `（声明 ${callNames.length} 个` +
    `${dropped.length > 0 ? `，不可用 ${dropped.length} 个：${dropped.join("、")}` : ""}` +
    `${selfDisabled.length > 0 ? `，自身条件不成立 ${selfDisabled.length} 个：${selfDisabled.join("、")}` : ""}）`,
  );
  return { list: narrowedList, narrowed: true, dropped, selfDisabled };
}
