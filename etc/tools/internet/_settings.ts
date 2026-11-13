/**
 * etc/tools/internet/_settings.ts
 * internet 目录共享设置项（规范 §7.1 目录声明文件）
 *
 * 作用域（§7.3）：本目录及其所有子级可读。
 * 用途：通用 HTTP 客户端（http.ts）的部署级安全策略；
 *       浏览器组的域名名单仍在 browser.ts 的组设置项里，两者互不影响。
 *
 * 约定：
 *   · 默认值只在这里写一次（§3.2 单一来源）；
 *   · `_` 前缀 → 扫描器不会把它当入口文件，也不会出现在工具列表里（§4.2）；
 *   · 本文件改动**不支持热更新**（私有模块，§4.3），需重启进程；
 *   · 默认取「保守方向」：block_private_net 默认 true（与 browser 组同口径）。
 */
import type { SettingDef } from "@/infra/settings";

export const settings: Record<string, SettingDef> = {
    blocked_hosts: {
        kind: "string_array",
        default: [],
        desc:
            "禁止访问的主机名（http 组使用）。空 = 不额外限制。" +
            "支持 *.example.com（只命中子域）与 example.com（命中自身及全部子域）。" +
            "内网 / 回环地址由 block_private_net 单独控制。",
    },
    block_private_net: {
        kind: "boolean",
        default: true,
        desc:
            "http 组是否阻断内网 / 回环 / 链路本地地址（含 DNS 解析后的私有地址）。" +
            "默认 true：通用 HTTP 工具很容易被用来探测本机与内网服务（SSRF）。" +
            "仅在明确需要访问内网接口时改为 false。",
    },
};
