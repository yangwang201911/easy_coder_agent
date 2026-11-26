#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

# ==================== 用户配置区 ====================
# 默认值（可被 .gguf_selected 覆盖，由 download 子命令生成）
# MODEL_PATH="${SCRIPT_DIR}/../../unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q6_K.gguf"
MODEL_PATH="${SCRIPT_DIR}/../../unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf"
SERVED_MODEL_NAME="qwen3.8-27b"

# 上下文长度（改这个值会触发重新导入）
NUM_CTX="131072"

# 视觉（VL）开关：留空=download 时交互询问；1=启用(需 mmproj)；0=纯文本
WANT_VL="${WANT_VL:-}"
MMPROJ_FILE="${SCRIPT_DIR}/vl/mmproj-Qwen3.8-27B-F16.gguf"

# GGUF 下载源（HuggingFace）
GGUF_REPO="unsloth/Qwen3.8-27B-GGUF"
GGUF_BASENAME="Qwen3.8-27B-UD"
GGUF_DIR="${SCRIPT_DIR}/../../unsloth/Qwen3.8-27B-GGUF"
HF_ENDPOINT="${HF_ENDPOINT:-}"

# 若 download 子命令已生成选择配置，覆盖上面的默认
GGUF_CONFIG="${SCRIPT_DIR}/.gguf_selected"
[ -f "$GGUF_CONFIG" ] && source "$GGUF_CONFIG"

# 可选量化清单（针对 16GB 显存，如 5070 Ti）：量化|大小(约)|推荐num_ctx|说明
QUANT_LIST=(
  "Q8_0|27.5GB|8192|精度最高；16GB 需大量 CPU 卸载，很慢"
  "Q6_K|22.5GB|8192|16GB 需 CPU 卸载，慢"
  "Q5_K_M|19.5GB|8192|16GB 需 CPU 卸载，慢"
  "Q4_K_M|16.8GB|8192|16GB 偏紧，仅 8K 上下文"
  "Q4_K_S|15.8GB|8192|16GB 偏紧，仅 8K 上下文"
  "Q3_K_M|13.8GB|16384|16GB 可用，16K 上下文"
  "Q3_K_S|12.3GB|24576|16GB 可用，24K 上下文"
  "IQ3_XS|13.2GB|16384|★16GB 推荐，16K 上下文"
  "IQ3_XXS|12.6GB|24576|★16GB 推荐，24K 上下文"
  "IQ2_XXS|10.8GB|32768|16GB 宽松，32K 上下文"
  "Q2_K|10.2GB|32768|16GB 宽松，32K 上下文；精度损失较大"
)

# 思考模式开关 (true: 开启思考, false: 关闭思考)
ENABLE_THINKING="false"

export OLLAMA_FLASH_ATTENTION=true

# 临时路径配置
export LOCAL_TMP=${SCRIPT_DIR}/tmp
mkdir -p ${LOCAL_TMP}
export TMPDIR=${LOCAL_TMP}

# 思考模式底层环境变量配置 (控制 llama-server 推理核心层)
if [ "$ENABLE_THINKING" = "false" ]; then
    export LLAMA_ARG_REASONING="off"
    export LLAMA_ARG_THINK_BUDGET="0"
    export LLAMA_ARG_THINK="none"
else
    unset LLAMA_ARG_REASONING
    unset LLAMA_ARG_THINK_BUDGET
    unset LLAMA_ARG_THINK
fi

# --- 设置显卡与 Vulkan 禁用 ---
export CUDA_VISIBLE_DEVICES=0
# export OLLAMA_VULKAN=false

# 服务地址配置
. "$SCRIPT_DIR/../../common/utils.sh"

ServerIP="$(get_host_ip)"
PORT="${OLLAMA_PORT:-8000}"
# 客户端走回环地址，避免 0.0.0.0 被公司代理拦截；服务本身监听 0.0.0.0
export OLLAMA_HOST="127.0.0.1:${PORT}"
export OLLAMA_KEEP_ALIVE="-1"

LOG_FILE="${SCRIPT_DIR}/ollama_server.log"
PID_FILE="${SCRIPT_DIR}/ollama_server.pid"
MODELFILE_PATH="${SCRIPT_DIR}/Modelfile"
MODEL_FINGERPRINT_CACHE="${SCRIPT_DIR}/.ollama_model_fingerprint"
# ====================================================

# 精准校验服务进程
is_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null && ps -p "$PID" -o args= | grep -q "ollama serve"; then
            return 0
        else
            rm -f "$PID_FILE"
        fi
    fi
    return 1
}

# 等待 API 服务就绪
wait_for_server() {
    echo "[+] 等待 Ollama API 服务初始化..."
    for i in {1..15}; do
        if curl -sf "http://${OLLAMA_HOST}/api/version" >/dev/null 2>&1; then
            echo "[✓] Ollama API 服务就绪！"
            return 0
        fi
        sleep 1
    done
    echo "[!] 错误：服务未能在 15 秒内响应，请检查日志: $LOG_FILE"
    return 1
}

# 判断模型是否已在 Ollama 仓库中（通过官方 CLI，跨版本/跨 OLLAMA_MODELS 稳定）
model_exists_in_ollama() {
    local target="$SERVED_MODEL_NAME"
    case "$target" in
        *:*) ;;
        *)   target="${target}:latest" ;;
    esac
    ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$target"
}

# 计算"快速指纹"：不读整个 20 GB，只读头尾 1 MB
# 组合：大小 + mtime + inode + 头尾 sha256 + 模型名 + num_ctx
# 换量化 / 换文件 / 改 num_ctx / 改模型名 都会让指纹变化
compute_model_fingerprint() {
    local f="$MODEL_PATH"
    [ -f "$f" ] || { echo "MISSING"; return 1; }

    local size mtime ino head_sha tail_sha tail_start
    size=$(stat -c '%s' "$f" 2>/dev/null) || return 1
    mtime=$(stat -c '%Y' "$f" 2>/dev/null) || return 1
    ino=$(stat -c '%i' "$f" 2>/dev/null) || return 1

    head_sha=$(head -c 1048576 "$f" 2>/dev/null | sha256sum | awk '{print $1}')
    tail_start=$(( size > 1048576 ? size - 1048576 : 0 ))
    tail_sha=$(tail -c +$((tail_start + 1)) "$f" 2>/dev/null | sha256sum | awk '{print $1}')

    printf '%s|%s|%s|%s|%s|%s|%s|%s\n' \
        "$size" "$mtime" "$ino" "$head_sha" "$tail_sha" \
        "$SERVED_MODEL_NAME" "$NUM_CTX" "$WANT_VL"
}

# 判断缓存是否仍然有效
model_cache_valid() {
    # 1) Ollama 仓库里必须有这个模型
    model_exists_in_ollama || return 1

    # 2) 指纹缓存文件必须存在
    [ -f "$MODEL_FINGERPRINT_CACHE" ] || return 1

    # 3) 当前指纹必须与缓存一致
    local current cached
    current=$(compute_model_fingerprint) || return 1
    cached=$(cat "$MODEL_FINGERPRINT_CACHE" 2>/dev/null)
    [ -n "$cached" ] && [ "$current" = "$cached" ]
}

save_model_fingerprint() {
    compute_model_fingerprint > "$MODEL_FINGERPRINT_CACHE"
}

check_and_import_model() {
    if [ ! -f "$MODEL_PATH" ]; then
        echo "[!] 错误：GGUF 模型文件不存在，请检查路径: $MODEL_PATH"
        exit 1
    fi

    echo "[+] 正在针对当前 GGUF 文件生成 Modelfile (num_ctx ${NUM_CTX}) 并导入..."
    {
      echo "FROM ${MODEL_PATH}"
      echo "PARAMETER num_ctx ${NUM_CTX}"
      if [ "$WANT_VL" = "1" ] && [ -f "$MMPROJ_FILE" ]; then
        echo "PARAMETER mmproj ${MMPROJ_FILE}"
      fi
    } > "$MODELFILE_PATH"

    ollama create "$SERVED_MODEL_NAME" -f "$MODELFILE_PATH"
    if [ $? -eq 0 ]; then
        echo "[✓] 模型 ${SERVED_MODEL_NAME} 导入/更新成功！"
    else
        echo "[!] 模型导入失败，详细信息请查看日志: cat $LOG_FILE"
        exit 1
    fi
}

warmup_model() {
    echo "[+] 正在发送 API 请求将模型预加载至 GPU 显存..."
    curl -sf --max-time 900 "http://${OLLAMA_HOST}/api/generate" -d "{
      \"model\": \"${SERVED_MODEL_NAME}\",
      \"prompt\": \"warmup\",
      \"keep_alive\": -1
    }" > /dev/null

    if [ $? -eq 0 ]; then
        echo "[✓] 模型已成功预热并常驻显存！"
    else
        echo "[!] 预热请求发送失败，请检查服务状态。"
    fi
}

case "$1" in
    start)
        if is_running; then
            echo "[!] Ollama 服务已经在运行中，PID: $(cat $PID_FILE)"
            exit 1
        fi

        if ss -tlnp 2>/dev/null | grep -q ":${PORT} " || netstat -tlnp 2>/dev/null | grep -q ":${PORT} "; then
            echo "[!] 端口 $PORT 已被占用，请先排查占用端口的进程。"
            exit 1
        fi

        # 思考模式控制环境变量 (底层 llama-server 推理核心层)
        if [ "$ENABLE_THINKING" = "false" ]; then
            echo "[+] 思考模式 : 关闭 (LLAMA_ARG_REASONING=off, LLAMA_ARG_THINK_BUDGET=0)"
            export LLAMA_ARG_REASONING="off"
            export LLAMA_ARG_THINK_BUDGET="0"
            export LLAMA_ARG_THINK="none"
        else
            echo "[+] 思考模式 : 开启 (LLAMA_ARG_REASONING=auto)"
            unset LLAMA_ARG_REASONING
            unset LLAMA_ARG_THINK_BUDGET
            unset LLAMA_ARG_THINK
        fi

        echo "[+] 正在启动 Ollama 服务 (CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES})..."
        echo "[+] 服务地址: http://${ServerIP}:${PORT}"
        echo "[+] 日志输出: $LOG_FILE"

        OLLAMA_HOST="0.0.0.0:${PORT}" nohup ollama serve > "$LOG_FILE" 2>&1 &
        PID=$!
        echo $PID > "$PID_FILE"

        if ! wait_for_server; then
            rm -f "$PID_FILE"
            exit 1
        fi

        # 缓存命中：模型已存在且文件/参数未变 -> 跳过 GGUF 导入
        if model_cache_valid; then
            echo "[✓] 模型 ${SERVED_MODEL_NAME} 指纹未变且已存在，跳过导入（缓存命中）。"
        else
            echo "[+] 模型文件或参数有变化，重新执行 ollama create ..."
            check_and_import_model
            save_model_fingerprint
        fi

        warmup_model

        echo "[✓] Ollama 服务运行中，PID: $PID"
        ;;

    stop)
        if ! is_running; then
            echo "[!] Ollama 服务未运行。"
            exit 0
        fi

        PID=$(cat "$PID_FILE")
        echo "[-] 正在停止 Ollama 服务 (PID: $PID)..."
        kill "$PID" 2>/dev/null || true

        for i in {1..10}; do
            if ! kill -0 "$PID" 2>/dev/null; then break; fi
            sleep 1
            echo -n "."
        done
        echo ""

        if kill -0 "$PID" 2>/dev/null; then
            echo "[-] 进程未响应，正在强制终止..."
            kill -9 "$PID" 2>/dev/null || true
        fi

        rm -f "$PID_FILE"
        echo "[✓] 服务已停止，显存已释放。"
        ;;

    restart)
        $0 stop
        sleep 2
        $0 start
        ;;

    status)
        if is_running; then
            echo "[✓] Ollama 服务正在运行，PID: $(cat $PID_FILE)"
            curl -s "http://$OLLAMA_HOST/v1/models" | grep -q "$SERVED_MODEL_NAME" && echo "[✓] 模型 ${SERVED_MODEL_NAME} 已就绪！" || echo "[!] 模型尚未加载或初始化中..."
            if model_cache_valid; then
                echo "[✓] 指纹缓存：有效（下次 start 会跳过导入）"
            else
                echo "[!] 指纹缓存：缺失或失效（下次 start 会重新导入）"
            fi
        else
            echo "[!] Ollama 服务未运行。"
        fi
        ;;

    log)
        tail -f "$LOG_FILE"
        ;;

    download)
        echo "可选量化（针对 16GB 显存，如 5070 Ti）:"
        echo "  编号  量化        大小(约)   推荐num_ctx   说明"
        for i in "${!QUANT_LIST[@]}"; do
          IFS='|' read -r q size ctx note <<< "${QUANT_LIST[$i]}"
          printf "  %-4s %-10s %-10s %-13s %s\n" "$((i+1))" "$q" "$size" "$ctx" "$note"
        done
        read -r -p "选择量化编号 [默认 9=IQ3_XXS]: " pick
        pick="${pick:-9}"
        if ! [[ "$pick" =~ ^[0-9]+$ ]] || [ "$pick" -lt 1 ] || [ "$pick" -gt "${#QUANT_LIST[@]}" ]; then
          echo "[!] 无效编号: $pick"
          exit 1
        fi
        IFS='|' read -r QUANT QUANT_SIZE QUANT_CTX QUANT_NOTE <<< "${QUANT_LIST[$((pick-1))]}"
        echo "[+] 已选: $QUANT (大小约 $QUANT_SIZE, num_ctx=$QUANT_CTX)"

        # 视觉开关（未预设则询问）
        if [ -z "$WANT_VL" ]; then
          read -r -p "启用视觉（VL）？[Y/n] " vans
          case "$vans" in [nN]*) WANT_VL=0 ;; *) WANT_VL=1 ;; esac
        fi

        # 镜像源（未预设则询问）
        if [ -z "$HF_ENDPOINT" ]; then
          read -r -p "网络较慢？用国内镜像 hf-mirror.com 下载？[y/N] " ans
          case "$ans" in [yY]*) HF_ENDPOINT="https://hf-mirror.com" ;; *) HF_ENDPOINT="https://huggingface.co" ;; esac
        fi

        # 下载 mmproj（若启用视觉且本地没有）
        if [ "$WANT_VL" = "1" ] && [ ! -f "$MMPROJ_FILE" ]; then
          echo "[+] 下载 mmproj -> $MMPROJ_FILE"
          mkdir -p "$(dirname "$MMPROJ_FILE")"
          curl -fL --noproxy '*' -o "$MMPROJ_FILE" "$HF_ENDPOINT/$GGUF_REPO/resolve/main/mmproj-F16.gguf" || { echo "[!] mmproj 下载失败"; exit 1; }
        fi

        # 下载 GGUF
        mkdir -p "$GGUF_DIR"
        MODEL_PATH="$GGUF_DIR/${GGUF_BASENAME}-${QUANT}.gguf"
        URL="$HF_ENDPOINT/$GGUF_REPO/resolve/main/${GGUF_BASENAME}-${QUANT}.gguf"
        if [ -f "$MODEL_PATH" ]; then
          echo "    已存在，跳过下载: $MODEL_PATH"
        else
          echo "    从 URL 下载: $URL"
          curl -fL --noproxy '*' -o "$MODEL_PATH" "$URL" || { echo "[!] GGUF 下载失败: $URL"; exit 1; }
        fi

        # 写选择配置（供 start 使用）
        NUM_CTX="$QUANT_CTX"
        cat > "$GGUF_CONFIG" <<EOF
MODEL_PATH="$MODEL_PATH"
NUM_CTX=$NUM_CTX
WANT_VL=$WANT_VL
QUANT=$QUANT
EOF
        echo "[✓] 配置已写入 $GGUF_CONFIG (量化=$QUANT, num_ctx=$NUM_CTX, VL=$WANT_VL)"
        echo "    下一步: $0 start"
        if [ "$WANT_VL" = "1" ]; then
          echo "    提示: 若 ollama create 报 mmproj 错误，说明当前 Ollama 不支持 PARAMETER mmproj，"
          echo "          请升级 Ollama（5070 Ti/Blackwell 本就需要新版）或用 manifest 方式挂视觉。"
        fi
        ;;

    *)
        echo "使用方法: $0 {download|start|stop|restart|status|log}"
        echo "  download  列出量化清单(含 IQ3+大小)并下载，自动定 num_ctx"
        exit 1
        ;;
esac