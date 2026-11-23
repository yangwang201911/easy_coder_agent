# Agent 优化计划（对照主流 agent：Claude Code / Cursor / Aider / OpenAI Agents）

> 状态图例：⬜ 待做 · 🔄 进行中 · ✅ 完成 · ⏸ 暂停
> 本文档随重构进度持续更新。

## 优化清单

| # | 优化项 | 优先级 | 状态 | 说明 |
|---|--------|--------|------|------|
| 1 | 工具调用并行化（只读并行 / 写串行） | 高 | ✅ | `agent.py` 主循环 |
| 2 | todo / 任务清单工具 | 高 | ✅ | `tools/interact.py` + 主循环注入 |
| 3 | LLM 调用重试 + 指数退避 | 高 | ✅ | `llm/openai_compat.py` |
| 4 | grep_search 换 ripgrep + 上下文行 | 高 | ✅ | `tools/fs.py` |
| 5 | 上下文压缩：micro-compaction + 图片清理 | 中 | ✅ | `context/compression.py` |
| 6 | 浏览器多 tab | 中 | ✅ | `tools/browser.py` |
| 7 | 记忆自动沉淀（turn-end 提取） | 中 | ✅ | `knowledge.py` + `engine.py` |
| 8 | 系统提示注入动态环境信息 | 中 | ✅ | `prompts/builder.py` |
| 9 | web_search 免 key fallback（DuckDuckGo） | 低 | ✅ | `tools/web.py` |
| 10 | 循环检测模糊化（相似参数） | 低 | ✅ | `agent.py` 主循环 |
| 11 | orchestrator 并行波次显式标记 | 低 | ⬜ | `orchestrator/orchestrator.py` |
| 12 | 工具结果缓存（同 turn 重复读取） | 低 | ⬜ | `tools/base.py` |

## 各项细节与实现方案

### 1. 工具调用并行化 ✅
- **问题**：`agent.py` 主循环 `for tc in calls:` 逐个串行执行，一个 step 里多个
  `read_file`/`grep_search` 无法并发，长任务墙钟时间长。
- **实现**：按 `tool.kind == "read"` 分组；>1 个 read 用 `ThreadPoolExecutor`（≤8 并发）
  并行执行，write/exec/network/mcp 保持原顺序串行；结果按原调用顺序回填，
  保证 tool_call_id 对应关系不变。单个 read 工具内联执行（修过一个漏执行的 bug）。
- **验证**：backend 21 passed + GUI 冒烟全绿。

### 2. todo / 任务清单工具 ✅
- **问题**：普通模式（非 plan）跑 20+ 步长任务时模型没有自我跟踪机制，容易跑偏/漏步。
- **实现**：`update_todo` 工具（`tools/interact.py`）：
  - 参数 `todos: [{content, status: pending|in_progress|done}]`，整体替换清单（≤20 项）
  - 清单存 `ToolContext.todos`，每步以**临时 user 消息**追加在消息末尾注入
    （不持久化、不污染历史），全部完成时提示模型给最终答案
  - `todo_updated` 事件推给 GUI（后续可渲染清单面板）
- **验证**：`test_update_todo_tool` 通过。

### 3. LLM 调用重试 + 指数退避 ✅
- **问题**：一次 500/429/网络抖动直接 `LLMError` → 整个 run 结束。
- **实现**：`stream_chat` 建流前重试最多 3 次，仅对可重试错误
  （408/409/429/5xx/连接超时）退避 1.5s→3s→6s；退避期间分片 sleep 保持
  cancel/steer 响应；重试通过 `status` chunk → `warning` 事件通知 GUI。
- **验证**：backend 全绿（重试路径靠代码审查，无现成 mock 服务器测试）。

### 4. grep_search 换 ripgrep ✅
- **问题**：纯 Python 逐文件扫描，大仓库比 `rg` 慢 10-100 倍，无上下文行。
- **实现**：`HAS_RG` 探测系统 ripgrep，有则走 `_grep_rg`（`--line-number --no-heading
  --fixed-strings/-i/-C/--glob`，相对路径输出，60s 超时，退出码 1=无匹配）；
  无则 `_grep_py` fallback（原逻辑 + `context_lines` 上下文行，`-` 标记）。
  新增 `context_lines` 参数（0-10）。
- **验证**：`test_grep_search_with_context`（本机无 rg，覆盖 fallback 路径）。

### 5. 上下文压缩增强 ✅
- **问题**：只有全量 LLM 摘要一种粒度；历史里的 screenshot data_url 是 token 大户。
- **实现**：micro-compaction（旧 tool output 截断到 600 字符）原本已有；
  新增 `strip_old_images`（旧消息图片替换为 `[image removed to save context]`，
  保留最近 1 张），接入 `SummarizeStrategy` 全部三个 step。
- **验证**：`test_strip_old_images`；backend 23 passed。

### 6. 浏览器多 tab ✅
- **问题**：全局单 `_page`，无法同时看两个页面。
- **实现**：`_pages` 列表 + `_tab` 活动索引（`_page` 变为 property）；
  新增 `browser_new_tab`（开新 tab 并切换，走 network 审批）和
  `browser_switch_tab`（1-based 切回旧 tab，返回快照）；`browser_close` 关全部。
- **验证**：`test_browser_flow` 扩展了 new_tab/switch_tab/越界 断言（本机有 chromium，真实跑通）。

### 7. 记忆自动沉淀 ✅
- **问题**：memory 只在启动时读入 prompt，依赖模型自觉调用 `remember`。
- **实现**：`knowledge.extract_memory`（thinking off、max_tokens=300，要求模型回
  JSON 数组 ≤3 条）；`engine.submit` 在 turn `done` 后起后台 daemon 线程执行
  （不占 turn 锁、不阻塞回复），保存成功发 `memory_saved` 事件；
  配置开关 `agent.memory_extraction`（默认开）；全程 best-effort 不抛异常。
- **验证**：`test_extract_memory`（保存/去重/空/坏 JSON 不抛）。

### 8. 系统提示动态环境信息 ✅
- **问题**：`prompts/builder.py` 纯静态。
- **实现**：新增 `environment` section（默认开），`build()` 末尾追加
  `# Environment`：当前时间、OS/平台、git 分支 + 未提交标记
  （`_git_info` 5s 超时，非 git 目录静默跳过）。
- **验证**：`test_environment_block_in_system_prompt`（git/非 git/关闭开关）；
  backend 25 passed。

### 9. web_search 免 key fallback ✅
- **问题**：未配置 SEARXNG_URL / BRAVE_API_KEY 直接报错。
- **实现**：`_duckduckgo`（`html.duckduckgo.com/html/` 公开端点，正则提取
  `result__a`/`result__snippet`，解包 `/l/?uddg=` 重定向）作为第三级 fallback；
  无结果时返回友好消息而非报错。
- **验证**：`test_search_ddg_fallback`（mock `_http_get`，覆盖重定向解包/无结果）。

### 10. 循环检测模糊化 ✅
- **问题**：只检测参数逐字相同的重复调用，抓不住"换个路径再试一次"的打转。
- **实现**：同工具 + 参数相似度（SequenceMatcher > 0.85）+ 已出现 ≥2 次即计 strike，
  错误信息提示"nearly identical"。
- **验证**：backend 全绿。

### 11. orchestrator 并行波次 ⬜
- **问题**：按文件 hint 猜并行，hint 缺失时全部串行。
- **方案**：planner 显式输出 `parallel_safe` 标记。

### 12. 工具结果缓存 ⬜
- **问题**：同 turn 重复 `read_file` 同一段重复消耗 token。
- **方案**：`(path, mtime, range)` → 结果缓存，命中返回 "(unchanged, see earlier read)"。

## 日志

- 2026-11-23：创建本文档，列出 12 项优化。
- 2026-11-23：#1（并行工具）、#3（LLM 重试）、#10（模糊循环检测）完成；
  修复并行分组中单个 read 工具漏执行的 bug。
- 2026-11-23：#2（update_todo 工具 + 每步清单注入）完成。
  验证：backend 21 passed，GUI 冒烟全绿（proj_switch/ctxmenu 为存量失败）。
  已提交 6e41f58。
- 2026-11-23：#4（grep 换 ripgrep + context_lines）完成。
  验证：backend 22 passed。已提交 b0b0c59。
- 2026-11-23：#5（压缩时清理旧图片，保留最近 1 张）完成。
  验证：backend 23 passed。已提交 185e871。
- 2026-11-23：#6（浏览器多 tab：browser_new_tab / browser_switch_tab）完成。
  验证：backend 23 passed（浏览器 E2E 真实跑通）。已提交 5edabfe。
- 2026-11-23：#7（turn 结束后台自动提取记忆，memory_saved 事件）完成。
  验证：backend 24 passed。已提交 893075e。
- 2026-11-23：#8（系统提示注入 # Environment：时间/OS/git 分支）完成。
  验证：backend 25 passed。
