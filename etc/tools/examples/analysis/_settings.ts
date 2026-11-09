/**
 * etc/tools/examples/analysis/_settings.ts
 * analysis 目录共享设置项（规范 §7.1 目录声明文件）
 *
 * 作用域（§7.3）：本目录及其所有子级可读。
 *
 * 约定：
 *   · 默认值只在这里写一次（§3.2 单一来源），配置页与其他接口都不得修改默认值；
 *   · `_` 前缀 → 扫描器不会把它当入口文件，也不会出现在工具列表里（§4.2）；
 *   · 本文件改动**不支持热更新**（私有模块，§4.3），需重启进程。
 */
import type { SettingDef } from "@/infra/settings";

export const settings: Record<string, SettingDef> = {
    data_root_dir: {
        kind: "string",
        default: "working",
        desc:
            "分析类工具的数据目录（相对项目根）。PCA 工具只读写该目录内的文件，" +
            "与文件工具的总操作目录（etc__tools__local__file_root_dir）相互独立。" +
            "改动后下一次工具调用即生效。",
    },
};
