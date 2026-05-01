#!/bin/bash
llama-server \
  -m "/Users/icehunter/.ollama/models/blobs/sha256-1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a" \
  --gpu-layers 99 \
  --ctx-size 131072 \
  --batch-size 2048 \
  --ubatch-size 512 \
  --flash-attn on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --cache-ram 1024 \
  --threads 8 \
  --threads-batch 8 \
  --parallel 1 \
  --host 0.0.0.0 \
  --port 1234 \
  --alias qwen3-coder
