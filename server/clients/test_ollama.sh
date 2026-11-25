
# curl -s -X POST http://<YOUR_SERVER_IP>:8000/v1/chat/completions \
#   -H "Content-Type: application/json" \
#   -d '{
#     "model": "qwen3.8-27b",
#     "messages": [
#       {"role": "user", "content": "请用 100 字左右解释一下什么是张量并行。"}
#     ],
#     "stream": false
#   }'

source vllm-env/bin/activate
# pip install openai

python test_ollama.py