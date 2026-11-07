---
name: log_triage
title: 本地日志排查
summary: 从日志文件定位报错根因，输出带证据的四段结论
tools: [local.fileRead.list_directory, local.fileRead.read_file]
version: 2
---

## 目标
用户给出日志路径或贴出报错时，定位根因并给出可直接执行的修复建议。每条结论必须附原始日志行，未证实的推测须标为「推测」。

## 使用时机
- 用户提到「报错」「异常」「日志」「trace」
- 用户贴了堆栈或错误码
- 不适用：用户只是问概念、不涉及具体文件

## 方法

1. **先确认日志文件在哪，不要假设 `data/` 存在**。
   - 工具：`local__fileRead__list_directory`，参数 `path`（用户给的目录，或 `.` 表示工作目录根）。
   - 需要看子目录时传 `recursive: true`、`maxDepth: 2`（默认 5，深了会刷屏）。
   - 结果怎么用：从返回的 `entries` 里挑 `name` 以 `.jsonl` / `.log` 结尾、`type: "file"` 的条目，记下 `path` 与 `size`。

2. **按文件大小决定读法**（`size` 单位字节）：
   - `< 256KB`：直接 `local__fileRead__read_file`，参数 `path`，整文件读。
   - `≥ 256KB`：**必须分段读**，参数 `path` + `startLine`（从 1 起）+ `lineCount`（一次 500～2000 行）。
     - 返回里有 `totalLines`（总行数）与 `nextStartLine`（下一段的 `startLine`，到末尾为 `null`）。
     - **续读时把 `nextStartLine` 原样填进 `startLine`**，不要自己加一。
     - `partialLastLine: true` 表示该行没读全（JSONL 单行极长时会出现）——此时缩小范围或只看该行开头的 `error` 字段。

3. **关键字定位**：用 `local__fileRead__search_in_files`，参数 `keyword`（如 `"error"`、错误码 `E1002`）、`path`（起始目录）。
   - 结果给的是**文件名 + 行号**：直接把这个行号当作第 2 步的 `startLine` 回读上下文，别整文件重读。
   - 需要跨文件扫时调大 `maxFiles`（默认 500）与 `maxFileSize`。

4. **抓字段**：`error` / `createdAt` / `model` / `finishReason` / `userInput`。先筛 `error` 非空的行，再按 `error` 分组计数定位主因。
   - 结果怎么用：分组计数直接作为「证据」段的素材；主因作为「根因」段的结论来源。
   - JSONL 每行是一条 JSON：只看 `error` / `createdAt` / `model` 这几个键，不要把整行原文贴进结论。

5. 对照下面「## 错误码对照」逐条比对，不要凭记忆猜。

6. 敏感内容（`sk-` 打头的键、token、完整用户输入）**只描述形状**（如 `sk-****`）。

## 输出格式
严格四段，每段标题加粗：**症状** / **证据** / **根因** / **建议**。证据段必须引用原始日志行（可截断长行，保留时间戳与 error 字段）。

## 自检
- [ ] 每条结论都有原始日志行支撑
- [ ] 没有把「可能」写成「确定」
- [ ] 建议是可执行的（含具体文件 / 命令）
- [ ] 全程只用了 `local__fileRead__list_directory` / `local__fileRead__read_file` / `local__fileRead__search_in_files`

## 错误码对照
| 码 | 含义 | 常见根因 |
|---|---|---|
| E1001 | 连接被拒 | 对端未监听 / 端口写错 |
| E1002 | 认证失败 | token 过期 / 时钟偏移 |
| E2003 | 序列化失败 | 字段类型不匹配 |
| E5000 | 上游超时 | 依赖服务慢 / 无超时设置 |
