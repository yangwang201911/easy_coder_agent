#!/usr/bin/env bash
# bootstrap.sh - 在新机器上一键准备 Ollama 模型库（clone 后运行即可）
#   [1] 拉取基座模型 smtek/Swift-Qwen3.8-27B:map-k4v  -> models/
#   [2] 准备视觉投影器 mmproj                          -> vl/mmproj-*.gguf
#   [3] 构建 VL tag :map-k4v-vl                        (make_vl_tag.sh)
# 用法: bash bootstrap.sh
# 完成后: OLLAMA_MODELS=<本目录>/models ./manage_mtp.sh start
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS="$HERE/models"
VL="$HERE/vl"

# ==================== 可配置区 ====================
MODEL_NAME="smtek/Swift-Qwen3.8-27B:map-k4v"

# 视觉 mmproj 来源（按优先级）：
#   1) MMPROJ_LOCAL: 本地已有 mmproj 的绝对路径（可选，留空则走下载）
#   2) 从 HuggingFace 下载（HF_ENDPOINT 可切换国内镜像）
MMPROJ_LOCAL=""
HF_ENDPOINT="${HF_ENDPOINT:-}"          # 留空则运行时交互询问；可预设 https://hf-mirror.com
MMPROJ_REPO="unsloth/Qwen3.8-27B-GGUF"
MMPROJ_FILENAME="mmproj-F16.gguf"
MMPROJ_FILE="$VL/mmproj-Qwen3.8-27B-F16.gguf"
# 下载需要代理时取消注释：
# export https_proxy=http://child-prc.intel.com:913
# export http_proxy=http://child-prc.intel.com:913
# =================================================

mkdir -p "$MODELS/blobs" "$MODELS/manifests" "$VL"

echo "==> [1/3] 基座模型: $MODEL_NAME -> $MODELS"
if [ -f "$MODELS/manifests/registry.ollama.ai/smtek/Swift-Qwen3.8-27B/map-k4v" ]; then
  echo "    已存在，跳过 pull"
else
  OLLAMA_MODELS="$MODELS" ollama pull "$MODEL_NAME"
fi

echo "==> [2/3] 视觉 mmproj -> $MMPROJ_FILE"
if [ -f "$MMPROJ_FILE" ]; then
  echo "    已存在，跳过"
elif [ -n "$MMPROJ_LOCAL" ] && [ -f "$MMPROJ_LOCAL" ]; then
  echo "    从本地拷贝: $MMPROJ_LOCAL"
  cp -a "$MMPROJ_LOCAL" "$MMPROJ_FILE"
else
  # 未预设 HF_ENDPOINT 时，交互询问是否使用国内镜像
  if [ -z "$HF_ENDPOINT" ]; then
    read -r -p "    网络较慢？使用国内镜像 hf-mirror.com 下载 mmproj？[y/N] " ans
    case "$ans" in
      [yY]|[yY][eE][sS]) HF_ENDPOINT="https://hf-mirror.com" ;;
      *)                 HF_ENDPOINT="https://huggingface.co" ;;
    esac
  fi
  URL="$HF_ENDPOINT/$MMPROJ_REPO/resolve/main/$MMPROJ_FILENAME"
  echo "    从 URL 下载: $URL"
  curl -fL --noproxy '*' -o "$MMPROJ_FILE" "$URL"
fi

echo "==> [3/3] 构建 VL tag (:map-k4v-vl)"
bash "$VL/make_vl_tag.sh"

echo ""
echo "🎉 完成。启动服务:"
echo "   cd $HERE && OLLAMA_MODELS=$MODELS ./manage_mtp.sh start"
echo "   视觉模型: smtek/Swift-Qwen3.8-27B:map-k4v-vl"
