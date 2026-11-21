#!/usr/bin/env bash
# 手动给 smtek/Swift-Qwen3.8-27B:map-k4v 挂上 F16 mmproj, 生成新 tag :map-k4v-vl
# 原理: Ollama 用 manifest 的 layers 描述模型组成, projector 层即 mmproj。
#       0.32.15 的 CLI 不支持 PARAMETER mmproj, 故直接写 manifest(标准格式)。
# 用法: sudo bash make_vl_tag.sh
set -euo pipefail
M=/mnt/data_nvme1n1p1/xiping_workpath/my_coder_agent/server/ollama_models
SRC=$M/mmproj/mmproj-Qwen3.8-27B-F16.gguf
TAG=map-k4v-vl
DST=$M/blobs/sha256-cb0a71fe9b84af2552fc6260acf8e9773a29d115c683aba01c72a7ac537b212b

[ -f "$SRC" ] || { echo "mmproj 源文件不存在: $SRC"; exit 1; }

# 1. mmproj 作为 blob 放进 blobs/(按 sha256 命名, 与 manifest digest 对应)
if [ ! -f "$DST" ]; then
  echo "copying mmproj blob..."
  cp "$SRC" "$DST"
fi
echo "blob ok: $(sha256sum "$DST" | cut -c1-16)..."

# 2. 基于原 manifest 生成新 tag 的 manifest: 原 layers + projector 层
python3 - "$M" "$TAG" <<'EOF'
import json, sys, os
M, tag = sys.argv[1], sys.argv[2]
src = f"{M}/manifests/registry.ollama.ai/smtek/Swift-Qwen3.8-27B/map-k4v"
dst = f"{M}/manifests/registry.ollama.ai/smtek/Swift-Qwen3.8-27B/{tag}"
man = json.load(open(src))
mm = {"mediaType": "application/vnd.ollama.image.projector",
      "digest": "sha256:cb0a71fe9b84af2552fc6260acf8e9773a29d115c683aba01c72a7ac537b212b",
      "size": 927607008}
if not any(l.get("digest") == mm["digest"] for l in man["layers"]):
    man["layers"].append(mm)
json.dump(man, open(dst, "w"), indent=1)
print("manifest written:", dst)
EOF

# 3. 校验
ollama show "smtek/Swift-Qwen3.8-27B:$TAG" 2>&1 | head -20 || true
