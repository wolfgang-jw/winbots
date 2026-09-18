/**
 * 跨平台"打开默认浏览器"工具
 *
 * 职责：
 * 1. 按当前操作系统选择合适的"打开 URL"命令
 * 2. 以非阻塞方式调起系统默认浏览器
 * 3. 任何失败（无图形界面 / 无默认浏览器 / 命令异常）均静默降级
 *
 * 约束：本函数绝不抛出异常、绝不终止进程，仅记录日志。
 */
import { spawn } from "child_process";

/**
 * 使用系统默认浏览器打开指定 URL。
 *
 * @param url 要打开的完整 URL（如 http://localhost:3001）
 */
export function openBrowser(url: string): void {
    try {
        const platform = process.platform;

        // 按平台选择命令与参数
        // - Windows: cmd /c start "" "<url>"（空标题参数避免把 URL 当作窗口标题）
        // - macOS:   open <url>
        // - 其他:    xdg-open <url>
        let command: string;
        let args: string[];

        if (platform === "win32") {
            command = "cmd";
            args = ["/c", "start", "", url];
        } else if (platform === "darwin") {
            command = "open";
            args = [url];
        } else {
            command = "xdg-open";
            args = [url];
        }

        // 非阻塞调起：detached + unref，不等待、不占用主进程
        const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
        });
        child.unref();

        // 命令级失败（如命令不存在）静默降级
        child.on("error", (err) => {
            console.warn(`⚠️  自动打开浏览器失败（不影响服务）: ${err.message}`);
        });
    } catch (err) {
        // 兜底：任何异常都不得影响服务
        console.warn(
            `⚠️  自动打开浏览器失败（不影响服务）: ${err instanceof Error ? err.message : String(err)
            }`
        );
    }
}
