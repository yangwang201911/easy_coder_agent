---
name: strata-qwen38-flashnext-setup
description: 在 Linux 上部署 Strata 并运行 Qwen3.8-Flash-Next。先运行探测脚本检查 GPU、驱动/CUDA、内存、硬盘，再按探测结果列出并推荐 Strata MODELS.md 中的模型，最后完成安装、启动、API 验证与测速。USE FOR：Linux 服务器部署 Strata/Qwen3.8、选择量化版本（IQ3_XXS 等）、接入 coder agent、排查 Strata 启动问题。DO NOT USE FOR：Windows 部署、AMD 显卡、Qwen3.8 以外的模型。
triggers: Strata|Qwen3.8|Flash-Next|IQ3_XXS|IQ3_S|strata launch|部署 Strata|Strata 部署|coder agent 模型
---

# Strata + Qwen3.8-Flash-Next：Linux 部署

适用平台：Linux x86-64，NVIDIA 显卡（RTX 20/30/40/50，或 Tesla V100 等 Volta/Pascal 卡走实验性 CUDA 12 引擎）。Windows 与 AMD 不在本 Skill 范围内；AMD 见 Strata 的 `docs/AMD_HIP.md`。

依据：Strata 官方仓库 `Niko1221/Strata` 的 `docs/MODELS.md`、`docs/TERMINAL_LAUNCH.md`、`docs/INSTALL.md`、`docs/MULTI_GPU.md`、`docs/OLDER_GPUS.md`、`docs/TROUBLESHOOTING.md`（版本 0.2.20）。

本 Skill 目录：`<skill_dir>` 指 `.github/skills/strata-qwen38-flashnext-setup`。

## 目录导航

1. [执行规则（Agent 必读）](#1-执行规则agent-必读)
2. [阶段 1：环境探测](#2-阶段-1环境探测)
3. [阶段 2：硬性门槛检查](#3-阶段-2硬性门槛检查)
4. [阶段 3：列出模型并推荐](#4-阶段-3列出模型并推荐)
5. [阶段 4：选择 GPU](#5-阶段-4选择-gpu)
6. [阶段 5：安装 Strata](#6-阶段-5安装-strata)
7. [阶段 6：生成计划（不改动系统）](#7-阶段-6生成计划不改动系统)
8. [阶段 7：启动模型](#8-阶段-7启动模型)
9. [阶段 8：API 验证](#9-阶段-8api-验证)
10. [阶段 9：测速与质量检查](#10-阶段-9测速与质量检查)
11. [阶段 10：接入 coder agent](#11-阶段-10接入-coder-agent)
12. [阶段 11：日常管理、停止与升级](#12-阶段-11日常管理停止与升级)
13. [故障排查](#13-故障排查)
14. [依据与未验证项](#14-依据与未验证项)

## 1. 执行规则（Agent 必读）

1. **安装、启动、停止、写配置文件前必须得到用户确认。** 用 `vscode_askQuestions` 提问，不要自行决定。
2. **不结束他人在 GPU 上的进程。** 显卡被占用时选其他卡，或请用户协调。
3. **GPU 序号统一用 `nvidia-smi` 的编号，并固定 `CUDA_DEVICE_ORDER=PCI_BUS_ID`。** 启动后用总线号核对（阶段 8.1）。
4. **不设 API key 不暴露到局域网。** 默认 `--access local`。
5. **每个阶段结束都输出该阶段的结果表**，再进入下一阶段。
6. 命令失败时先查第 13 章，不要盲目重试。

## 2. 阶段 1：环境探测

### 2.1 运行探测脚本

只读，不修改系统：

```bash
bash <skill_dir>/scripts/detect_hardware.sh
```

脚本覆盖：系统与内核、GPU 序号/型号/总线号/显存/利用率/驱动、计算能力、驱动支持的 CUDA 上限、nvcc（可选）、CPU 与 NUMA、总内存与可用内存、容器内存上限、磁盘（ROTA）、Strata 是否已装、8080 端口、github.com 与 huggingface.co 连通性。

### 2.2 解读结果

把输出整理成下表，交给用户确认：

| 项目 | 从哪里读 | 本次结果（填写） |
| --- | --- | --- |
| 系统 | `PRETTY_NAME`、内核 | |
| GPU 型号、序号、总线号 | `nvidia-smi` 的 `index`、`pci.bus_id` | |
| 每张卡的显存总量、空闲、利用率 | `memory.total`、`memory.free`、`utilization.gpu` | |
| 计算能力 | `compute_cap` | |
| 驱动版本 | `driver_version` | |
| CUDA 版本（驱动支持的上限） | `driver CUDA ceiling` | |
| nvcc（可选） | `nvcc` 行 | 不是必需，引擎为预编译包 |
| CPU 与 NUMA | `Model name`、`Socket`、`NUMA node(s)` | |
| 总内存、可用内存 | `MemTotal`、`MemAvailable`（换算为 GiB） | |
| 容器内存上限 | `cgroup memory.max`（若有） | |
| 模型存放盘 | `df` 的剩余空间，`lsblk` 的 `ROTA`（1=机械盘，0=SSD） | |
| 已安装 Strata | `strata --version` | |
| 8080 端口 | `8080: free/busy` | |
| 外网 | `github.com`、`huggingface.co` | |

## 3. 阶段 2：硬性门槛检查

逐条判断。任一条“停止”即不能继续，先告知用户原因。

| 检查项 | 通过条件 | 不通过时 |
| --- | --- | --- |
| NVIDIA 显卡 | 至少一张 NVIDIA 卡 | **停止**。无可用 NVIDIA 卡时 Strata 不支持（AMD 见 `docs/AMD_HIP.md`） |
| 驱动（RTX 20 及更新） | 驱动 ≥ 580，使用 CUDA 13 引擎 | 驱动 575.51–579.x：可用 `--cuda 12` 走 CUDA 12 引擎；< 575.51：**停止**，需管理员升级驱动 |
| 驱动（V100 / P100 等） | 驱动 ≥ 575.51，使用实验性 CUDA 12 引擎 | 同上；V100 只有社区报告，需告知用户为实验性 |
| 计算能力 | ≥ 7.5 走默认引擎；7.0 及以下走 CUDA 12 引擎 | 在阶段 6 的计划输出中核对引擎类型 |
| 显存 | 目标卡显存 ≥ 12 GB | < 12 GB：只考虑 Inkling-2-Mini SQ-10（见阶段 3）；< 8 GB：**停止** |
| 可用内存 | 按阶段 3 的表确定推荐档位 | 低于 30 GiB：只能用 Inkling-2-Mini |
| 模型存放盘 | 剩余 ≥ 100 GB，**优先 SSD（ROTA=0）** | 盘剩余不足：换盘或用 `--data-dir` 指定其他位置。机械盘可用，但首次加载慢，见 13 章 |
| 端口 | 8080 空闲 | 被占用：改用 `--port 8081`，或确认是否已有 Strata 在运行（`strata launch --status`） |
| 外网 | github.com、huggingface.co 可达 | 不可达：设置代理后重测，例如 `export https_proxy=http://<proxy>:<port>` |

## 4. 阶段 3：列出模型并推荐

### 4.1 Qwen3.8-Flash-Next 可选版本

数据来自 `docs/MODELS.md` 的“Will it fit?”与“Pick by memory”。

“最低可用内存” = 专家占用 + 约 10 GB（系统余量），是官方给出的放置条件。推荐时再加 4 GB 余量。

| 版本 | `strata launch` 参数 | 下载大小 | 内存中的专家 | 最低可用内存 | 备注 |
| --- | --- | ---: | ---: | ---: | --- |
| ISTA Q2_0 | `--family qwen --model q2_0` | 66.4 GB | 约 34 GB | 约 44 GB | 最快，质量略低 |
| ISTA IQ2_XS | `--family qwen --model iq2_xs` | 68.0 GB | 约 35.5 GB | 约 46 GB | 比 Q2_0 质量略好 |
| ISTA IQ3_XXS | `--family qwen --model iq3_xxs` | 75.8 GB | 约 43 GB | 约 53 GB | **本 Skill 的目标版本** |
| ISTA IQ3_S | `--family qwen --model iq3_s` | 83.6 GB | 约 50 GB | 约 60 GB | 质量最好，64 GB 机器需关闭其他程序 |
| Coder IQ1_M | `--family coder --model IQ1_M` | 约 58 GB（估算：两分片 29.6 + 28.8） | 约 23 GB | 约 33 GB | 只保留一半专家，偏代码，中文弱 |
| Swift 1.5 IQ2_XS | `--family swift --model iq2_xs` | 同 ISTA IQ2_XS | 同 IQ2_XS | 同 IQ2_XS | 微调版，思考更短；许可证不同 |
| Gyro-S | `--family gyro --model Gyro-S` | 58.5 GB | 合计 27.6 GB（显存+内存） | 按 MD 为最省内存 | 质量较低，速度较慢，从不作为默认 |
| Gyro-M | `--family gyro --model Gyro-M` | 92.0 GB | 合计 35 GB | 按 MD | 质量接近 IQ3_XXS，显存少约 20% |
| Unsloth UD-IQ4_XS | `--family unsloth --model UD-IQ4_XS` | 94 GB | 约 55 GiB | 规划约 72 GB | 4 位以上，质量更高，内存需求大 |
| Unsloth UD-Q4_K_XL | `--family unsloth --model UD-Q4_K_XL` | 111 GB | 约 72 GiB | 规划约 88 GB | 同上 |
| Unsloth UD-Q5_K_XL | `--family unsloth --model UD-Q5_K_XL` | 158 GB | 约 92 GiB | 规划约 108 GB | 同上 |
| Unsloth UD-Q6_K_XL | `--family unsloth --model UD-Q6_K_XL` | 169 GB | 约 102 GiB | 规划约 118 GB | 同上 |
| Unsloth Q8_0 | `--family unsloth --model Q8_0` | 188 GB | 约 120 GiB | 规划约 136 GB | 参考质量 |
| NVFP4 | `--family nvfp4 --model NVFP4` | 128 GB（另有 NVFP4-QAD 102 GB，需 110 GB 临时盘） | 需约 80 GB 内存保留全部专家 | 约 80 GB | 仅 NVIDIA，RTX 50 有 FP4 张量核心 |

注意：

- “专家占用”是 Strata 文档的估算值，不是保证。Unsloth 系列的内存规划值来自 `docs/MODELS.md` 的 “RAM setup plans for”。
- 多卡不降低内存需求，只提高速度或显存容量。
- **不要选 Unsloth 的 UD-IQ3_XXS。** Strata 的 `--family unsloth` 只覆盖 UD-IQ4_XS 到 Q8_0。IQ3_XXS 请用 ISTA 版（`--family qwen --model iq3_xxs`）。

### 4.2 其他家族（内存或显存不足时的备选）

| 版本 | 参数 | 下载/占用 | 最低建议 | 备注 |
| --- | --- | --- | --- | --- |
| Qwen3.6-35B-A3B UD-Q4_K_XL | `--family qwen36 --model UD-Q4_K_XL` | 22.9 GB；规划 32 GB 内存 | 32 GB 内存 + 16 GB 显存 | NVIDIA 与 AMD；Intel Arc 与 Mac 引擎不支持 |
| Qwen3.6-35B-A3B UD-Q6_K_XL | `--family qwen36 --model UD-Q6_K_XL` | 32.6 GB；规划 44 GB 内存 | | |
| Qwen3.6-35B-A3B Q8_0 | `--family qwen36 --model Q8_0` | 37.8 GB；规划 52 GB 内存 | | |
| Inkling-2-Mini SQ-10 | `--family inkling-2-mini --model SQ-10` | 10.5 GB | 12 GB 显存，或 4–8 GB 混合 | 显存小时的首选 |
| Inkling-2-Mini SQ-15 | `--family inkling-2-mini --model SQ-15` | 14.3 GB | 16 GB 显存 | |
| Inkling-2-Mini SQ-20 | `--family inkling-2-mini --model SQ-20` | 19.3 GB | 24 GB 显存或 32 GB 统一内存 | |
| Hy4-Flash SQ-64 | `--family hy4-flash --model SQ-64` | 62.0 GB + 67.6 GB 查表 | 64 GB 内存 + 8 GB 显存 | 专用引擎 |
| Hy4-Flash SQ-96 / SQ-128 | `--family hy4-flash --model SQ-96` | 89.6 / 113.7 GB | 96 / 128 GB 内存 | |

### 4.3 推荐规则

用阶段 1 的 `MemAvailable`（换算为 GiB）作为 A，取最大单卡显存作为 V。按顺序判断，**第一条命中即为推荐**。

| 条件 | 推荐 | 备选 |
| --- | --- | --- |
| A ≥ 57 GiB 且 V ≥ 12 GB | **ISTA IQ3_XXS**（本 Skill 目标） | IQ3_S（A ≥ 64 时）；Unsloth UD-Q4_K_XL（A ≥ 92 时，需显式选择） |
| 50 ≤ A < 57 GiB 且 V ≥ 12 GB | ISTA IQ2_XS | Q2_0 |
| 48 ≤ A < 50 GiB 且 V ≥ 12 GB | ISTA Q2_0 | Coder IQ1_M |
| 37 ≤ A < 48 GiB 且 V ≥ 12 GB | Coder IQ1_M（官方推荐的 32 GB 内存档位） | Qwen3.6-35B-A3B UD-Q4_K_XL |
| 33 ≤ A < 37 GiB | Coder IQ1_M，需先关闭其他程序 | Gyro-S |
| 30 ≤ A < 33 GiB | Gyro-S | Inkling-2-Mini（按显存选 SQ-10/15/20） |
| A < 30 GiB | Inkling-2-Mini（按显存选） | Qwen3.6-35B-A3B（需 A ≥ 32） |
| V < 12 GB（任何 A） | Inkling-2-Mini SQ-10 | 其余 Qwen3.8 版本不推荐，并告知用户速度会明显下降 |

推荐后附带的建议：

- 默认上下文 **64K**。在 64 GB 机器上 128K 可在稳定后再加（阶段 7 说明）。
- 默认并发 **1**（`--parallel 1`）。
- 若 `MemAvailable` 接近推荐档位下限，告知用户先关闭浏览器等占内存的程序，再启动。

### 4.4 向用户提问

使用 `vscode_askQuestions` 让用户确认：

1. 模型：推荐项作为第一选项，备选项列在后面。
2. 上下文：`64k`（推荐）、`32k`、`128k`。
3. 存放目录：机械盘路径，或 NVMe 上的目录（推荐，若剩余空间足够）。
4. 是否开启局域网访问（默认否）。

## 5. 阶段 4：选择 GPU

1. 候选卡：空闲显存 ≥ 12 GB、利用率低的卡。工作区若有 GPU 选择规则（例如 `detect_service` 的 `copilot-instructions.md`：3090 优先，其次 V100），按该规则选。
2. 固定总线顺序，避免 CUDA 默认的“最快优先”与 `nvidia-smi` 序号不一致：

   ```bash
   export CUDA_DEVICE_ORDER=PCI_BUS_ID
   ```

3. 记下所选卡的 `nvidia-smi` 序号（记为 N）。后续用 `strata launch --gpu N`。`docs/MULTI_GPU.md` 说明 `--gpu` 使用 `nvidia-smi` 的编号。
4. 不要同时设置 `CUDA_VISIBLE_DEVICES` 与 `--gpu`，避免二次映射。是否与 `--gpu` 冲突，**未验证**，仅使用其一。

## 6. 阶段 5：安装 Strata

安装器不需要 root，装在用户目录。

```bash
curl -fsSL --connect-timeout 15 --max-time 120 https://github.com/Niko1221/Strata/releases/latest/download/install.sh -o install.sh && sh install.sh
```

若提示找不到 `strata`，用安装器打印的完整路径（通常 `~/.local/bin/strata`），或把 `~/.local/bin` 加入 `PATH`。

确认：

```bash
strata --version
strata doctor --live
```

`strata doctor --live` 会列出它识别到的显卡和引擎状态。确认能看到阶段 4 选中的卡。引擎包会在第一次 `strata launch` 时按显卡自动下载，并校验签名。

## 7. 阶段 6：生成计划（不改动系统）

先检查端口：

```bash
ss -ltn | grep -q ':8080 ' && echo "8080 busy" || echo "8080 free"
```

生成计划（**不下载、不修改**）。以下以 IQ3_XXS、64K、GPU N、模型目录 `<MODEL_DIR>` 为例，按阶段 2–3 的结果替换：

```bash
strata launch --plan --family qwen --model iq3_xxs --context 64k --gpu <N> --data-dir <MODEL_DIR>
```

逐项核对计划输出：

| 核对项 | 期望 |
| --- | --- |
| 选中的卡 | 与阶段 4 的 N 一致 |
| 引擎类型 | 与阶段 2 的驱动/计算能力一致（CUDA 13，或 V100 的 CUDA 12） |
| 下载量 | 约 76 GB 分片 + 约 6 GB MTP 草稿层 |
| 内存方案 | 专家放内存，不是低内存模式（低内存模式会从 SSD 读专家，很慢） |
| 上下文与显存 | 64K 下显存够用，计划没有报 “LOW” 或 “does not fit” |

若计划显示低内存模式，或选中的卡不对：**停止**，告知用户，回到阶段 3 重选。

## 8. 阶段 7：启动模型

计划核对通过且用户确认后启动：

```bash
export CUDA_DEVICE_ORDER=PCI_BUS_ID
strata launch --family qwen --model iq3_xxs --context 64k --gpu <N> \
  --data-dir <MODEL_DIR> --port 8080 --access local --parallel 1 \
  --save-preset iq3xxs-64k --yes --no-tui
```

说明：

- `--access local`：只监听 `127.0.0.1`，默认值。局域网访问见阶段 10。
- `--save-preset`：保存预设，之后可用 `strata launch --preset iq3xxs-64k --no-tui` 重启。
- 首次启动要下载约 82 GB，可中断，重跑同一命令会续传。下载完后要把约 43 GB 专家读入内存并锁定，期间机器可能变卡，**不要关终端**。
- 启动中的状态：

  ```bash
  strata launch --status
  free -g
  ```

- 若磁盘是机械盘，首次加载会很慢。Strata 在内存够放查表时会自动把 28.8 GB 的 n-gram 查表读进内存（`--ple-io ram`）。

## 9. 阶段 8：API 验证

### 9.1 绑定到了正确的卡（必做）

```bash
nvidia-smi --query-gpu=index,name,pci.bus_id --format=csv
nvidia-smi --query-compute-apps=pid,process_name,used_memory,gpu_bus_id --format=csv
```

在第二条输出中找到 Strata 引擎进程，其 `gpu_bus_id` 必须等于所选卡的 `pci.bus_id`。不一致则立即 `strata launch --stop`，并检查 `CUDA_DEVICE_ORDER` 与 `--gpu` 参数。

### 9.2 健康检查与模型列表

```bash
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/v1/models
```

`/health` 应返回已加载状态；`/v1/models` 应列出一个模型。

### 9.3 对话测试

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"strata","messages":[{"role":"user","content":"用 Python 写一个 LRU 缓存，只输出代码"}],"max_tokens":512}'
```

`model` 字段不会被校验，填 `strata` 即可。

### 9.4 工具调用测试

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"strata",
    "messages":[{"role":"user","content":"现在北京时间几点？请调用工具。"}],
    "tools":[{"type":"function","function":{"name":"get_time","description":"获取指定城市的当前时间","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
    "max_tokens":256
  }'
```

应在返回的 `tool_calls` 中看到 `get_time`，参数包含 `city`。

### 9.5 Python 客户端测试

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="none")
r = client.chat.completions.create(model="strata", messages=[{"role": "user", "content": "Hello!"}])
print(r.choices[0].message.content)
```

### 9.6 Strata 自带的连接检查（可选）

```bash
strata connect --check
```

会发一次提示和一次工具调用，检查接口是否正常。输出中若含 “Failed” 按第 13 章处理。

## 10. 阶段 9：测速与质量检查

### 10.1 测速

```bash
strata bench run --url http://127.0.0.1:8080
```

需要先让模型加载完，期间不要运行其他占 GPU 的程序。约 2–4 分钟。把结果填入下表：

| 指标 | 结果 | 与 Strata 文档对比 |
| --- | --- | --- |
| 解码速度（tok/s，短上下文） | | |
| 预填充速度（tok/s，4K 提示） | | |
| 首 token 延迟（16K 提示） | | |

Strata 文档的参考数据（均为旧版本或其他硬件，仅作量级参考）：RTX 5070 12 GB + 64 GB 内存 + IQ3_XXS 约 62 tok/s（短上下文）。

### 10.2 长上下文召回（可选）

需要 Strata 源码仓库中的 `terminal/tools/needle_bench.py`。如果没有，跳过此项，并告知用户：

```bash
python terminal/tools/needle_bench.py --url http://127.0.0.1:8080 --lengths 32k,64k --depths 10,50,90 --out needles.json
```

`--lengths` 不要超过启动时的 `--context`。

### 10.3 质量抽查

用 2–3 个代表性任务（例如代码生成、中文问答、工具调用）手动检查输出，记录是否正确。中文质量差或输出循环时，见第 13 章。

## 11. 阶段 10：接入 coder agent

### 11.1 agent 与 Strata 在同一台机器

在 `~/.coder_agent/config.toml` 中：

```toml
[server]
provider = "openai_compat"
base_url = "http://127.0.0.1:8080/v1"
api_key = "EMPTY"
model = "strata"
bypass_proxy = true

[context]
max_tokens = 65536
```

`max_tokens` 应与 `--context` 一致。

也可以用 `strata connect` 查看并自动写入支持的工具配置（OpenCode、Codex CLI、Claude Code 等）：

```bash
strata connect opencode           # 打印配置
strata connect opencode --write   # 写入前询问，会备份被替换的文件
```

### 11.2 agent 在另一台机器（局域网或隧道）

优先使用 SSH 隧道：

```bash
ssh -N -L 18080:127.0.0.1:8080 <服务器>
```

agent 使用 `http://127.0.0.1:18080/v1`。

必须直接暴露时，需要用户明确同意，并设置 key：

```bash
strata launch --preset iq3xxs-64k --access lan --new-key --no-tui --restart
strata launch --show-key
```

`--access` 可选 `local`、`lan`、`cloudflare`、`tailscale`。**不设 key 等于任何能访问端口的人都能用模型和工具。** 在防火墙放行端口时只开放给需要的网段。

### 11.3 接入后注意事项

- 同一时间处理一个请求（`--parallel 1`）。agent 的压缩、记忆提取和子任务会交替请求，频繁切换会话会变慢。
- 思考强度默认 high，token 消耗大。在 agent 里设 `reasoning_effort` 为 `medium` 或 `low`。要硬限制思考长度，在 `strata-<model>.json` 中加 `"reasoning_budget_tokens": 4096`。
- 思考内容放在 `reasoning_content` 字段。确认 agent 能处理，否则思考内容会丢失或显示异常（未核对）。
- 图片：24 GB 及以上显存默认由显卡读图（约 1–1.4 GB 显存，0.1–0.5 秒/张）；更小的卡由 CPU 读图（约 3 秒/张）。agent 需要截图能力时保持图片开启，不要加 `--vision off`。

## 12. 阶段 11：日常管理、停止与升级

```bash
strata launch --status                              # 状态
strata launch --stop                                # 停止，释放显存
strata launch --preset iq3xxs-64k --no-tui          # 用保存的预设启动
strata launch --list-presets                        # 查看预设
strata launch --show-key                            # 显示 key（若设置了）
strata update --check                               # 检查引擎更新
strata update                                       # 更新（会询问是否先停掉模型）
strata components rollback                          # 回到上一个引擎
```

更新前先看 `strata update --check` 的输出。更新后若驱动下限变化，需要重新执行阶段 2。

## 13. 故障排查

| 现象 | 处理 |
| --- | --- |
| `NVIDIA driver is too old` | 驱动低于引擎要求。按阶段 2 升级驱动（需管理员），或 `--cuda 12`（若驱动 ≥ 575.51） |
| `Strata couldn't find an engine for this computer` | 运行 `strata update --check` 与 `strata doctor --live`；确认卡型与驱动满足阶段 2 |
| 计划或启动选中了另一张卡 | 立即 `strata launch --stop`，检查 `CUDA_DEVICE_ORDER=PCI_BUS_ID`，重做 8.1 |
| 首次启动机器卡住几分钟 | 正常，在读入并锁定专家。10 分钟仍无响应才重启 |
| `the engine stopped unexpectedly (exit code ...)` | 多为内存不足。查 `sudo dmesg \| grep -i -E 'killed process\|out of memory'`（需要管理员）。关其他程序或降上下文。重发消息会自动重启 |
| Linux 上 `exit code -9`，但没有 OOM 记录 | 检查 `ulimit -R`。若非 0，桌面会话设置了实时 CPU 限制，安装 `rtkit`，或用 `systemd-run --user --collect -p LimitRTTIME=infinity -- strata serve ...` 启动 |
| 输出很慢且硬盘灯狂闪 | 内存不够，专家在读盘。关程序、降上下文，或换更小版本 |
| 进程处于 D 状态、卡在读查表 | 机械盘随机读跟不上。内存够时用 `--ple-io ram`，或把模型移到 NVMe |
| `prompt ... exceeds the context` | 提示比 `--context` 长，用更大的 `--context` 加 `--restart` 重启 |
| `port 8080 is already in use` | 确认是否已有 Strata（`strata launch --status`）；要并行运行用 `--port 8081` |
| V100 上启动失败或引擎提示 CUDA 12 | V100 走实验性 CUDA 12 引擎，属预期。若失败，记录日志并告知用户 |
| 中文回答差或循环（Coder） | Coder 的已知限制。改用 ISTA 版本，或让 agent 的系统提示用英文 |
| 其他问题 | 运行 `strata doctor --live`，把输出和引擎日志（`strata-<model>.log`）附到 Issue，不要附 API key |

## 14. 依据与未验证项

**依据**：

- `docs/MODELS.md`：版本列表、占用估算、推荐档位。
- `docs/TERMINAL_LAUNCH.md`：`strata launch` 参数、预设、`strata connect`。
- `docs/INSTALL.md`：安装命令与驱动要求。
- `docs/MULTI_GPU.md`：`--gpu` 的编号规则。
- `docs/OLDER_GPUS.md`：V100 与 Pascal 的 CUDA 12 引擎、驱动下限 575.51。
- `docs/TROUBLESHOOTING.md`：启动、内存、驱动问题。

**未验证**：

- 本 Skill 的推荐阈值（第 4.3 节）是根据 MODELS.md 的估算数字推导的，不是 Strata 官方规则。
- `--gpu` 与 `CUDA_DEVICE_ORDER=PCI_BUS_ID` 的组合是否按预期工作，未实测。
- 在 V100 上运行 IQ3_XXS 的速度与稳定性，未实测。
- `--cuda 12` 是否在 Terminal 版 `strata launch` 中可用，文档只在源码安装的说明中出现。以 `strata launch --help` 为准。
- Coder 的“91% SWE-bench Verified”来自模型作者自述，与 coder agent 实际任务表现未必一致，建议用用户自己的任务做 A/B。
- 文档版本为 0.2.20，项目更新很快，以 `strata launch --help` 和官方文档为准。
