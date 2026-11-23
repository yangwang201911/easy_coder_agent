# 在 RTX 5070 Ti（16GB）+ 32GB 内存上用 Strata 运行 Qwen3.8-Flash-Next

适用机器：RTX 5070 Ti 16GB 显存、32GB 内存。目标：在本机跑 Strata 自带的 Qwen3.8-Flash-Next 量化版本，并让 coder agent 通过 OpenAI 兼容接口使用它。

## 目录导航

1. [结论](#1-结论)
2. [该选哪个版本](#2-该选哪个版本)
3. [安装前检查](#3-安装前检查)
4. [安装](#4-安装)
5. [启动模型](#5-启动模型)
6. [验证](#6-验证)
7. [接入 coder agent](#7-接入-coder-agent)
8. [调优](#8-调优)
9. [常见问题](#9-常见问题)
10. [停止、升级、回滚](#10-停止升级回滚)
11. [依据与未验证项](#11-依据与未验证项)

## 1. 结论

**可以运行，但 32GB 内存下官方只推荐 Coder 版（IQ1_M）。**

- Strata 官方文档：32GB 内存配 12 到 16GB 显存，推荐 Coder；Q2_0、IQ2_XS 在 32GB 内存配 24GB 显存时才算合适。
- Coder 保留每层 512 个专家中的 256 个（每个 token 仍激活 10 个），按代码、智能体和图像数据挑选。作者称保留完整模型 SWE-bench Verified 的 91%、LiveCodeBench 的 99%（作者自测，未独立验证）。
- 代价：官方说明它在代码以外、以及英文以外的语言上较弱，**中文和其他 CJK 文本被明确点名**（有用户报告中文回答出错或循环）。用它做中文对话要留意。
- 它只做编程场景时最合适，与 coder agent 的用途吻合。

## 2. 该选哪个版本

| 版本 | 模型占用（RAM+VRAM） | 内存里的专家 | 32GB 内存 + 16GB 显存 | 备注 |
| --- | ---: | ---: | --- | --- |
| **Coder（IQ1_M）** | 约 29.6GB（第 1 分片） | 约 23GB | **官方推荐** | 代码强，非英语弱 |
| Q2_0 | 37.6GB | 约 34GB | 不推荐，先用 `--plan` 看结果 | 内存装不下，会走低内存模式 |
| IQ2_XS | 39.2GB | 约 35.5GB | 同上 | 比 Q2_0 质量略好 |
| IQ3_XXS | 47.0GB | 约 43GB | 不适合 | 官方说 32GB 内存下只能映射读文件，很慢 |
| IQ3_S | 54.8GB | 约 50GB | 不适合 | |

决策：

1. 先装 **Coder**。
2. 想试保留全部专家的版本（中文更好）时，先运行 `strata launch --plan --family qwen --model iq2_xs`，看它给出的内存方案和速度提示再决定。16GB 显存放不下多少专家，多数专家要从内存或硬盘读取，速度会明显下降。
3. 不要选 Unsloth 的 UD-IQ3_XXS。Strata 只支持 ISTA-DASLab 的量化包，以及 Unsloth 的 UD-IQ4_XS 到 Q8_0 系列，这些对内存要求都远超 32GB。

## 3. 安装前检查

1. **驱动**：RTX 50 系列用 CUDA 13 引擎，**NVIDIA 驱动必须是 580 或更新**。运行 `nvidia-smi` 查看 `Driver Version`，不够就先升级并重启。
2. **磁盘**：模型加辅助文件约 70 到 80GB，另需几 GB 缓存。**放在 NVMe SSD 上**，机械硬盘首次加载会非常慢。
3. **内存**：32GB 偏紧。启动前关闭浏览器等占内存的程序。首次启动会把 35 到 55GB 数据读入内存并锁定一部分给显卡，**电脑可能卡顿 1 到 3 分钟，不要关窗口，等它完成**。
4. **Windows 页面文件**：设为“系统管理”或固定大小（例如 65536MB）。页面文件被关掉或太小时，显存分配可能报错。
5. **显示器接在这块 5070 Ti 上时**：引擎默认为桌面保留约 1.5GB 显存，专家缓存会相应变小。
6. 如果电脑自带集成显卡，可以把显示器接到集成显卡上，把独显留给模型。

## 4. 安装

Strata 现在有两种官方方式，选一种即可。

### 方式 A：终端（推荐，适合配合编程工具）

**Windows PowerShell**：

```powershell
irm -TimeoutSec 120 https://github.com/Niko1221/Strata/releases/latest/download/install.ps1 | iex
```

装完后**打开一个新的终端窗口**再继续。

**Linux**：

```sh
curl -fsSL --connect-timeout 15 --max-time 120 https://github.com/Niko1221/Strata/releases/latest/download/install.sh -o install.sh && sh install.sh
```

如果提示找不到 `strata`，用安装器打印的完整路径（通常是 `~/.local/bin/strata`），或把 `~/.local/bin` 加入 PATH。

确认安装：

```sh
strata --version
strata doctor --live
```

`strata doctor --live` 会列出它识别到的显卡和引擎状态，请确认能看到 5070 Ti。

### 方式 B：桌面版

到 [最新发布页](https://github.com/Niko1221/Strata/releases/latest) 下载安装包（Windows 为 `Strata-<版本>-windows-x64-setup.exe`，无需管理员权限）。首次启动会按你的显卡下载引擎，然后选择模型和存放目录。

## 5. 启动模型

先看计划，**这一步不会下载或修改任何东西**：

```sh
strata launch --plan --family coder --model IQ1_M
```

检查输出里的内存方案、是否进入低内存模式、预估上下文。确认后启动：

```sh
strata launch --family coder --model IQ1_M --context 64k --yes --no-tui
```

说明：

- `--context 64k` 是保守的起点。内存紧张时先别上 128K，确认稳定后再加大（见 [调优](#8-调优)）。
- `--no-tui` 让服务在后台运行。去掉 `--yes --no-tui` 则进入交互向导，按提示选模型、上下文、存放目录。
- 首次启动要下载约 70GB 模型，**可中断，重新运行同一命令会继续**。
- 默认接口地址是 `http://127.0.0.1:8080`，浏览器想开页面可加 `--open`。

常用管理命令：

```sh
strata launch --status      # 查看运行状态
strata launch --stop        # 停止
strata launch ... --restart # 用新参数替换正在运行的实例
```

## 6. 验证

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"strata","messages":[{"role":"user","content":"用 Python 写一个 LRU 缓存"}],"max_tokens":512}'
```

Windows PowerShell 里请用 `curl.exe`，否则会被别名到 `Invoke-WebRequest`。

测速（官方标准基准，约 2 到 4 分钟，需要先让模型加载完，期间关闭占 GPU 的程序）：

```sh
strata bench run --url http://127.0.0.1:8080
```

长上下文召回检查（在源码仓库里运行 `terminal/tools/needle_bench.py`）：

```sh
python terminal/tools/needle_bench.py --url http://127.0.0.1:8080 --lengths 32k,64k --depths 10,50,90 --out needles.json
```

`--lengths` 不要超过你启动时设置的上下文。

## 7. 接入 coder agent

### 7.1 agent 和 Strata 在同一台机器

在 `~/.coder_agent/config.toml` 里：

```toml
[server]
provider = "openai_compat"
base_url = "http://127.0.0.1:8080/v1"
api_key = "EMPTY"
model = "strata"        # Strata 不校验模型名
bypass_proxy = true

[context]
max_tokens = 65536      # 与 strata launch 的 --context 保持一致
```

### 7.2 agent 在另一台机器

**优先用 SSH 隧道**，不要把 8080 暴露到局域网：Strata 默认只监听 127.0.0.1，隧道后 agent 仍使用 `http://127.0.0.1:<本地端口>/v1`。

必须直接暴露时，需要在 `strata-<model>.json` 里设置 `"host": "0.0.0.0"` 和 `"api_key": "<长随机串>"`，并在 Windows 防火墙放行 8080（仅专用网络）。**不设 key 就等于任何人都能用你的模型和工具。** 具体参数请以 `strata launch --help` 为准。

### 7.3 接入后需要注意

- **一次只处理一个请求**。agent 的上下文压缩、记忆提取和子任务会交替请求，每次切换会话都要重读长提示。Strata 默认会复用会话前缀，同一会话的后续请求很快，但频繁切换会话会变慢。
- **思考强度默认是 high**，token 消耗大。在 agent 里把 `[thinking] effort` 设为 `medium` 或 `low`（Strata 接受 `reasoning_effort`）。要硬限制思考长度，可在 `strata-<model>.json` 里加 `"reasoning_budget_tokens": 4096`。
- Strata 把思考内容放在 `reasoning_content` 字段里。请确认你的 agent 能处理这个字段，否则思考内容可能丢失或显示异常（我没有核对 agent 对该字段的处理）。
- 工具调用支持流式返回，并带有格式修复。agent 的 Hermes 和 Qwen 两种文本解析仍会作为后备。
- Coder 版支持图片，但会占约 1.4GB 显存；16GB 显存默认由 CPU 读图（每张约 3 秒），不占显存。agent 的截图工具依赖视觉，需要保持图片开启（不要加 `--vision off`）。

## 8. 调优

| 目的 | 做法 |
| --- | --- |
| 增大上下文 | 重启时改 `--context 128k`。内存紧张时 KV 流式读取每个 token 约占 13.7KB 内存（128K 约 1.7GB），32GB 机器要留余量 |
| 自动调参 | `strata launch ... --tune quick`（或 `thorough`），按本机测几项引擎设置并保留更快的，需要几分钟 |
| 显存不够、启动失败 | 先降低上下文；也可提高 `--vram-reserve-mib`，报“draft head does not fit”时用 `--draft-vocab en`（这两个参数在源码安装文档里确认过，`strata launch` 是否同名请看 `--help`） |
| 内存吃紧、变慢、硬盘灯狂闪 | 关其他程序、降上下文；仍不行就关闭投机解码：`--mtp off`（会变慢但省约 1GB 显存） |
| 想要更快的编码重写 | 默认已启用，无需设置 |
| 与其他程序共用 GPU | 在 `strata-<model>.json` 设 `"idle_unload_s": 600`，空闲 10 分钟自动卸载 |

不要使用的选项：`STRATA_ROUTE_PRIOR`、`STRATA_ROUTE_TAIL_SKIP`。官方实测它们会提速，但在长智能体任务里容易重复输出、结果变差。

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| `NVIDIA driver is too old` | 升级到 580 或更新，重启后重试 |
| 首次启动电脑卡住几分钟 | 正常，在把专家读入内存并锁定，不要关窗口。10 分钟还不恢复才重启 |
| `the engine stopped unexpectedly` | 通常是内存不足（Linux 会杀掉占内存最大的进程）。重发消息即可自动重启；反复出现就关其他程序或降上下文 |
| 输出很慢且硬盘灯狂闪 | 内存不够，专家在读硬盘。关程序、降上下文，或换更小版本 |
| `prompt ... exceeds the context` | 提示比启动时设的上下文长，用更大的 `--context` 重启 |
| `ExpertCache: cudaMalloc failed` 但显存有空 | Windows 页面文件太小，改成系统管理或固定 65536MB |
| `port 8080 is already in use` | Strata 已在运行，用 `strata launch --status` 查看；要并行跑用 `--port 8081` |
| 中文回答质量差或循环 | Coder 的已知限制。改用保留全部专家的版本，或让 agent 的系统提示使用英文 |
| 其他问题 | 运行 `strata doctor --live`，把输出和引擎日志附到 Issue |

## 10. 停止、升级、回滚

```sh
strata launch --stop            # 停止
strata update --check           # 检查更新
strata update                   # 更新（会询问是否先停掉正在运行的模型）
strata components rollback      # 回到上一个引擎
```

模型文件和设置在更新时会保留。

## 11. 依据与未验证项

**依据**（均来自 Strata 官方仓库 `Niko1221/Strata`，2026-11-24 查阅）：

- `docs/MODELS.md`：按内存选型表、Coder 说明、32GB 内存的低内存模式。
- `docs/INSTALL.md`：安装命令、驱动要求、`strata launch` 用法。
- `docs/DETAILS.md`：接口、思考强度、速度表、`--reasoning_budget_tokens`、`--idle-unload` 等配置键。
- `docs/TROUBLESHOOTING.md`：驱动、启动卡顿、页面文件等问题。

**没有验证的内容**：

- **没有在 5070 Ti 加 32GB 上实测**。官方最接近的实测是 RTX 5070（12GB）加 64GB 内存，Coder 短上下文约 55 token/s，128K 上下文约 43 token/s。本机 32GB 内存会进入低内存模式，速度大概率低于这组数字，具体多少未知。
- 官方有一条 RTX 5060 Ti 16GB（Xeon E5-2680 v4）跑 Coder 的社区报告，我没有读到它的具体数值。可以运行 `strata bench run` 后与其对比。
- Coder 的“91% SWE-bench Verified”来自模型作者自述，与 coder agent 的实际任务表现未必一致，建议用你自己的任务做 A/B。
- 我没有核对 `strata launch` 是否提供 `--host`、`--api-key` 参数，局域网暴露请先看 `strata launch --help`。
- 文档里的版本号和命令来自 0.2.20 版的文档，项目更新很快，以 `strata launch --help` 和官方文档为准。
