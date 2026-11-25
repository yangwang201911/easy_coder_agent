#!/usr/bin/env bash
# 验证 VL 版模型是否接受图片输入(在本机运行, 需能访问 <YOUR_SERVER_IP>:8000)
# 用法: bash server/mmproj/verify_vl.sh [model_tag]
set -u
MODEL="${1:-smtek/Swift-Qwen3.8-27B:map-k4v-vl}"
SERVER_IP="${2:-<YOUR_SERVER_IP>}"
IMG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
curl -s --noproxy '*' -m 120 "http://${SERVER_IP}:8000/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"用一句话描述这张图\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,$IMG\"}}]}]}"
echo
