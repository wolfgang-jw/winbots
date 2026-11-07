/**
 * src/skills/availability.ts
 * 技能可用性判定（升级版 §3.3）。**纯读**：不 push 工具、不改配置、不打可见清单日志。
 *
 * 工具可用 = 已注册 ∧ 祖先目录全开 ∧ 组开关开 ∧ 组未挂起 ∧ 工具自身 enabled() 为 true
 *   ⚠️ 审批不影响可用性：审批发生在调用时，不在装配时。
 *
 * ⚠️ 依赖约定：
 *   · 只用 @/tools/scan 的 getRegistry() 与 @/infra/settings 的 groupState()（与
 *     skills/tools.ts 的判定**同一份口径**），**不引 @/tools/index** ——
 *     否则与 tools/index.ts → @/skills/l2tool 形成环。
 *   · scan.ts 反向引本文件的类型必须用 `import type`——**这条只在 `skills` 内部成立**：
 *     scan.ts 与 availability.ts 之间没有值依赖，`import type` 由 tsc 擦除即可。
 *     ⚠️ 但**跨 `skills ⇄ tools/index` 的环不能靠 `import type` 断**（Bun 直跑 .ts
 *     不保证擦除，见 l2tool.ts 头注释与升级版文档 §2.1「断环口径」）。
 */
import { getRegistry, SUSPEND_LABEL } from "@/tools/scan";
import { groupState } from "@/infra/settings";

export type UnavailableKind = "not_registered" | "group_off" | "suspended" | "self_disabled";

export interface UnavailableTool {
  /** 技能里写的 callName（点号形式，如 local.shell.run） */
  call: string;
  kind: UnavailableKind;
  /** 一行说明，含「怎么改」 */
  detail: string;
}

/** 与 src/tools/index.ts 的 isToolEnabled 同语义（此处内联，避免 skills → tools/index 反向依赖） */
function enabledNow(tool: { enabled?: () => boolean }): boolean {
  if (typeof tool.enabled !== "function") return true;
  try {
    return tool.enabled() !== false;
  } catch {
    return false;
  }
}

/**
 * 判定「必须工具」里哪些当前不可用。
 *
 * @param callNames 技能 frontmatter 的 tools（已归一为 callName）
 * @returns 不可用清单；空数组 = 全部可用（**空入参恒为可用**，即「不依赖任何工具」）
 */
export function checkRequiredTools(callNames: string[]): UnavailableTool[] {
  if (!Array.isArray(callNames) || callNames.length === 0) return [];
  const reg = getRegistry();
  const out: UnavailableTool[] = [];

  for (const call of callNames) {
    const rec = reg.tools.get(call);
    if (!rec) {
      // reg.tools 只含「未挂起组」的工具 → 组挂起时这里查不到。
      // 必须反查组，否则会误导用户去「改名字」，而不是「修工具组」。
      // GroupRecord.id 是 local/shell，callName 是 local.shell.run → 先点号化再前缀匹配。
      const owner = [...reg.groups.values()].find(
        (g) => g.suspend !== null && call.startsWith(`${g.id.replace(/\//g, ".")}.`),
      );
      out.push(
        owner
          ? {
              call,
              kind: "suspended",
              detail: `${call} 所属工具组 ${owner.id} 加载失败（${suspendLabel(owner.suspend?.code)}），请先修复该工具组再重试`,
            }
          : {
              call,
              kind: "not_registered",
              detail: `${call} 不在工具注册表中：名字写错，或该工具文件加载失败`,
            },
      );
      continue;
    }
    if (!rec.groupId) {
      // 无 groupId 的工具按「不参与组门禁」处理（与 tools/scan 的语义一致）
      if (!enabledNow(rec.tool)) {
        out.push({
          call,
          kind: "self_disabled",
          detail: `${call} 自身启用条件不成立（如 permission=forbid）：请放开该工具自身的权限档位`,
        });
      }
      continue;
    }
    const st = groupState(rec.groupId);
    if (!st.available) {
      out.push(
        st.reason === "suspended"
          ? {
              call,
              kind: "suspended",
              detail: `${call} 所属工具组 ${rec.groupId} 加载失败，请先修复该工具组再重试`,
            }
          : {
              call,
              kind: "group_off",
              detail: `${call} 所属工具组 ${rec.groupId} 当前关闭（${
                st.reason === "dir_off" ? "上级目录或组开关为关" : "组开关为关"
              }）：请到配置页「工具配置」打开上级目录与其组开关`,
            },
      );
      continue;
    }
    if (!enabledNow(rec.tool)) {
      out.push({
        call,
        kind: "self_disabled",
        detail: `${call} 自身启用条件不成立（如 permission=forbid）：请放开该工具自身的权限档位`,
      });
    }
  }
  return out;
}

/** 挂起码 → 可读标签（挂起码是工具侧的 SuspendCode，未知时原样回显） */
function suspendLabel(code: string | undefined): string {
  if (!code) return "未知原因";
  const table = SUSPEND_LABEL as Record<string, string | undefined>;
  return table[code] ?? code;
}
