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

# 视觉（VL）开关：留空=运行时交互询问；true=强制跳过(只要文本)；false=强制启用
SKIP_VISION="${SKIP_VISION:-}"

# 视觉 mmproj 来源（按优先级）：
#   1) MMPROJ_LOCAL: 本地已有 mmproj 的绝对路径（可选，留空则走下载）
#   2) 从 HuggingFace 下载（HF_ENDPOINT 可切换国内镜像）
MMPROJ_LOCAL=""
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"   # 国内镜像；海外可设为 https://huggingface.co
MMPROJ_REPO="unsloth/Qwen3.8-27B-GGUF"
MMPROJ_FILENAME="mmproj-F16.gguf"
MMPROJ_FILE="$VL/mmproj-Qwen3.8-27B-F16.gguf"
# 下载需要代理时取消注释：
# export https_proxy=http://child-prc.intel.com:913
# export http_proxy=http://child-prc.intel.com:913
# =================================================

mkdir -p "$MODELS/blobs" "$MODELS/manifests" "$VL"

# ollama CLI 只与运行中的服务通信，系统服务可能用别的模型目录，故起一个私有临时服务
TMP_PORT="${BOOTSTRAP_OLLAMA_PORT:-11500}"
TMP_PID=""
trap '[ -n "$TMP_PID" ] && kill "$TMP_PID" 2>/dev/null; true' EXIT
start_tmp_server() {
  [ -n "$TMP_PID" ] && return 0
  if ss -tln 2>/dev/null | grep -q ":${TMP_PORT} "; then
    echo "[!] 临时端口 $TMP_PORT 已被占用，请设置 BOOTSTRAP_OLLAMA_PORT"; exit 1
  fi
  export OLLAMA_MODELS="$MODELS" OLLAMA_HOST="127.0.0.1:${TMP_PORT}" CUDA_VISIBLE_DEVICES="" OLLAMA_VULKAN=false
  ollama serve >"$HERE/tmp/bootstrap_serve.log" 2>&1 &
  TMP_PID=$!
  for _ in $(seq 1 30); do
    curl -sf "http://${OLLAMA_HOST}/api/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "[!] 临时 ollama 服务启动失败，见 $HERE/tmp/bootstrap_serve.log"; exit 1
}
mkdir -p "$HERE/tmp"

echo "==> [1/3] 基座模型: $MODEL_NAME -> $MODELS"
BASE_MF="$MODELS/manifests/registry.ollama.ai/smtek/Swift-Qwen3.8-27B/map-k4v"
# manifest 在仓库里但 blobs 可能缺失(被 gitignore)，需逐层校验
base_ready() {
  [ -f "$BASE_MF" ] && python3 - "$BASE_MF" "$MODELS/blobs" <<'PY'
import json, os, sys
m = json.load(open(sys.argv[1]))
ds = [m["config"]["digest"]] + [l["digest"] for l in m["layers"]]
sys.exit(0 if all(os.path.isfile(os.path.join(sys.argv[2], d.replace(":", "-"))) or os.path.isfile(os.path.join(sys.argv[2], d.split(":")[1])) for d in ds) else 1)
PY
}
if base_ready; then
  echo "    blobs 完整，跳过 pull"
else
  start_tmp_server
  ollama pull "$MODEL_NAME"
fi

# ---------- 视觉能力开关（一次性询问，可用 SKIP_VISION 预设） ----------
if [ -n "$SKIP_VISION" ]; then
  case "$SKIP_VISION" in
    true|1|yes|y|on)  ENABLE_VL=0 ;;
    false|0|no|n|off) ENABLE_VL=1 ;;
    *) echo "[!] SKIP_VISION 取值无效: $SKIP_VISION，改为交互询问"; ENABLE_VL="" ;;
  esac
else
  ENABLE_VL=""
fi
if [ -z "$ENABLE_VL" ]; then
  read -r -p "==> 是否需要视觉（VL）能力？[Y/n]  (n = 只要文本模型，跳过 mmproj) " ans
  case "$ans" in
    [nN]|[nN][oO]) ENABLE_VL=0 ;;
    *)             ENABLE_VL=1 ;;
  esac
fi

if [ "$ENABLE_VL" = "1" ]; then
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
    curl -fL -o "$MMPROJ_FILE" "$URL"
  fi

  echo "==> [3/3] 构建 VL tag (:map-k4v-vl)"
  start_tmp_server
  OLLAMA_TMP_SERVER=1 bash "$VL/make_vl_tag.sh"
else
  echo "==> [2/3][3/3] 跳过视觉（VL）准备，仅提供文本模型 :map-k4v"
fi

echo ""
echo "🎉 完成。启动服务:"
echo "   cd $HERE && ./manage_mtp.sh start        # 文本模型"
[ "$ENABLE_VL" = "1" ] && echo "   cd $HERE && VL=1 ./manage_mtp.sh start   # 视觉模型"
if [ "$ENABLE_VL" = "1" ]; then
  echo "   视觉模型: smtek/Swift-Qwen3.8-27B:map-k4v-vl"
else
  echo "   文本模型: smtek/Swift-Qwen3.8-27B:map-k4v"
fi
