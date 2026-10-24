#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${IMAGE:-yashchauhan008/glob-server:latest}"

echo "Building & pushing $IMAGE"
docker buildx build \
  --platform linux/amd64 \
  -f Dockerfile \
  -t "$IMAGE" \
  --push .

echo "Pushed. On the VPS run ~/glob/server-up.sh (from the vps/ folder) to pull and restart."
