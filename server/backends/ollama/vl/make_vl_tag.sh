#!/usr/bin/env bash
# 给 smtek/Swift-Qwen3.8-27B:map-k4v 挂上 F16 mmproj, 生成新 tag :map-k4v-vl
# 原理: Ollama 用 manifest 的 layers 描述模型组成, projector 层即 mmproj。
#       0.32.15 的 CLI 不支持 PARAMETER mmproj, 故直接写 manifest(标准格式)。
# 用法: bash make_vl_tag.sh   (mmproj 需已就位: 本目录 mmproj-Qwen3.8-27B-F16.gguf)
set -euo pipefail
M="$(cd "$(dirname "${BASH_SOURCE[0]}")/../models" && pwd)"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mmproj-Qwen3.8-27B-F16.gguf"
TAG=map-k4v-vl

[ -f "$SRC" ] || { echo "mmproj 源文件不存在: $SRC (先运行 bootstrap.sh 下载)"; exit 1; }

# 动态计算 mmproj 的 sha256 与大小（兼容任意来源的 mmproj，不再写死）
DIGEST="sha256:$(sha256sum "$SRC" | cut -d' ' -f1)"
SIZE=$(stat -c%s "$SRC" 2>/dev/null || stat -f%z "$SRC")
DST="$M/blobs/${DIGEST#sha256:}"

# 1. mmproj 作为 blob 放进 blobs/（按 sha256 命名, 与 manifest digest 对应）
mkdir -p "$M/blobs"
if [ ! -f "$DST" ]; then
  echo "copying mmproj blob -> $DST"
  cp "$SRC" "$DST"
fi
echo "blob ok: $DIGEST (size=$SIZE)"

# 2. 基于原 manifest 生成新 tag 的 manifest: 原 layers + projector 层
DIGEST="$DIGEST" SIZE="$SIZE" python3 - "$M" "$TAG" <<'EOF'
import json, sys, os
M, tag = sys.argv[1], sys.argv[2]
digest = os.environ["DIGEST"]; size = int(os.environ["SIZE"])
src = f"{M}/manifests/registry.ollama.ai/smtek/Swift-Qwen3.8-27B/map-k4v"
dst = f"{M}/manifests/registry.ollama.ai/smtek/Swift-Qwen3.8-27B/{tag}"
man = json.load(open(src))
mm = {"mediaType": "application/vnd.ollama.image.projector",
      "digest": digest, "size": size}
if not any(l.get("digest") == digest for l in man["layers"]):
    man["layers"].append(mm)
json.dump(man, open(dst, "w"), indent=1)
print("manifest written:", dst)
EOF

# 3. 校验
OLLAMA_MODELS="$M" ollama show "smtek/Swift-Qwen3.8-27B:$TAG" 2>&1 | head -20 || true
