# my_coder_agent / server

基于开源模型 + 多种推理后端（vLLM / Ollama / OVMS）的本地编码环境。
本目录按「**一个推理后端一个自包含目录**」组织，脚本、文档同目录；**模型权重不入库，用脚本下载**，便于理解与迁移。

## 目录导航

- [目录结构](#目录结构)
- [快速开始](#快速开始)
  - [vLLM](#vllm)
  - [Ollama（含视觉）](#ollama含视觉)
  - [OVMS](#ovms)
- [测试客户端](#测试客户端)
- [迁移指南（clone 即用）](#迁移指南clone-即用)
- [文档](#文档)

## 目录结构

```
server/
├── README.md                  # 本文件（导航入口）
├── backends/                  # ★ 每个推理后端一个自包含目录
│   ├── vllm/
│   │   ├── manage.sh          #   启动/停止/日志/状态
│   │   └── download_model.sh  #   下载 vLLM 模型
│   ├── ollama/
│   │   ├── bootstrap.sh       #   ★ 一键下载基座模型 + 视觉 mmproj + 构建 VL tag
│   │   ├── manage_gguf.sh     #   GGUF 直载（unsloth/Qwen3.8-27B）
│   │   ├── manage_mtp.sh      #   自包含模型库 + MTP 投机解码
│   │   ├── models/            #   自包含 Ollama 模型库（blobs/manifests，脚本下载，不入库）
│   │   └── vl/                #   VL 视觉变体（make_vl_tag.sh + mmproj，mmproj 不入库）
│   └── ovms/
│       ├── manage.sh          #   OpenVINO Model Server（文本）
│       └── manage_vlm.sh      #   OpenVINO Model Server（VLM）
├── clients/                   # 测试客户端（OpenAI 兼容 / Ollama / OVMS）
├── common/                    # 跨后端共享（utils.sh、Docker+GPU 安装）
└── docs/                      # 各后端详细文档
```

> 模型权重（`unsloth/`、`OpenVINO/`、`Qwen/`、`vllm-env/`、`ollama/models/blobs`）
> 均**不入库**，按需下载；各 `manage.sh` 通过 `../../` 相对路径引用。

## 快速开始

### vLLM

```bash
cd backends/vllm
./manage.sh start      # 启动
./manage.sh log        # 查看日志
./manage.sh status     # 检查状态
./manage.sh stop       # 停止
```

### Ollama（含视觉）

```bash
cd backends/ollama
./bootstrap.sh         # 首次：一键下载基座模型 + 视觉 mmproj，并构建 :map-k4v-vl
./manage_mtp.sh start  # 启动（文本 + 视觉）
# 视觉模型名: smtek/Swift-Qwen3.8-27B:map-k4v-vl
```

### OVMS

```bash
cd backends/ovms
./manage.sh start      # 文本
./manage_vlm.sh start  # VLM
```

## 测试客户端

```bash
cd clients
python test_openai_client.py   # OpenAI 兼容接口（任意后端）
python test_ollama.py          # Ollama
python test_ovms.py <img> -p "描述"   # OVMS VLM
```

## 迁移指南（clone 即用）

- **clone 即用**：`git clone <repo>` 后，模型权重不在库中（仅脚本/文档，<100KB）。
  在目标机器运行 `server/backends/ollama/bootstrap.sh`，自动完成：
  1. `ollama pull smtek/Swift-Qwen3.8-27B:map-k4v` → `backends/ollama/models/`
  2. 下载/拷贝视觉 mmproj → `backends/ollama/vl/`
  3. `make_vl_tag.sh` 构建 `:map-k4v-vl`
  然后 `./manage_mtp.sh start` 即可提供与源机一致的 **ollama + Qwen3.8-27B + 视觉** 服务。
- **mmproj 来源**：默认从 HuggingFace 下载（运行时询问是否用国内镜像 `hf-mirror.com`，
  或预设 `HF_ENDPOINT` 环境变量）；也可在 `bootstrap.sh` 顶部设 `MMPROJ_LOCAL` 指向本地现成 mmproj。
- **只迁移工具链**：clone 仓库即可，无需搬运任何 `.gguf`。

## 文档

- [docs/cline-llamacpp.md](docs/cline-llamacpp.md) — Cline + llama.cpp / OVMS（Intel iGPU）
- [docs/ovms.md](docs/ovms.md) — Cline + OVMS
- [docs/clients.md](docs/clients.md) — 测试客户端说明
