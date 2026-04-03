#!/usr/bin/env bash
# Render (Ubuntu) build: Node for Vite, Poppler for pdf2image, Python deps.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg poppler-utils

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

npm ci
npm run build

pip install -r requirements.txt
