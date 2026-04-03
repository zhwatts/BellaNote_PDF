#!/usr/bin/env bash
# Render native build: no apt (filesystem is read-only). Node comes from
# package.json engines (see Render Node docs); then Vite → static/, then pip.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm ci
npm run build
pip install -r requirements.txt
