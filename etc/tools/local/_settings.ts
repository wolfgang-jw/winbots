/**
 * etc/tools/local/_settings.ts
 * local 目录共享设置项（规范 §7.1 目录声明文件）
 *
 * 作用域（§7.3）：本目录及其所有子级可读 —— 文件工具（fileRead / fileNew / fileModify）
 *   与 shell 都用得到「沙箱总目录」，所以它是**目录项**而不是某个组的组项。
 *
 * 约定：
 *   · 默认值只在这里写一次（§3.2 单一来源），配置页与其他接口都不得修改默认值；
 *   · `_` 前缀 → 扫描器不会把它当入口文件，也不会出现在工具列表里（§4.2）；
 *   · 本文件改动**不支持热更新**（私有模块，§4.3），需重启进程。
 */
import type { SettingDef } from "@/infra/settings";

export const settings: Record<string, SettingDef> = {
  file_root_dir: {
    kind: "string",
    default: "working",
    desc:
      "文件工具的总操作目录（相对项目根）。所有文件读写都被限制在该目录内，" +
      "回收站 .trash 也在其中。改动后下一次工具调用即生效。",
  },
};
