#!/usr/bin/env bash
# scripts/dev.sh — bring up the full flodex stack in a tmux session.
#
# Windows (Ctrl-b then 0–4):
#   0 coordinator  — registry on :8000
#   1 mock-tee     — Claude-backed node on :7777 (needs ANTHROPIC_API_KEY)
#   2 local        — llama.cpp-backed node on :7778 (needs FLODEX_LLAMA_MODEL)
#   3 dashboard    — Next.js dashboard on :3000
#   4 client       — shell with example flodex CLI commands preloaded
#
# Reads .env from the repo root if present. Re-run to re-attach.
# Pass --kill to tear it down.

set -euo pipefail

SESSION="flodex"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage: ${0##*/} [--kill|--help]

Starts a tmux session named '$SESSION' with 5 named windows. Re-running
attaches to the existing session; --kill tears it down.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --kill)
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    echo "killed session '$SESSION'"
    exit 0
    ;;
  "" ) ;;
  *) usage; exit 1 ;;
esac

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux not installed (brew install tmux / apt install tmux)" >&2
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
fi

cd "$ROOT"

# Export .env entries so child processes inherit them.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

# --- session: coordinator ---
tmux new-session -d -s "$SESSION" -n coordinator -c "$ROOT"
tmux send-keys -t "$SESSION:coordinator" 'cargo run -p coordinator' C-m

# --- window 1: mock-tee node ---
tmux new-window -t "$SESSION:" -n mock-tee -c "$ROOT"
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  tmux send-keys -t "$SESSION:mock-tee" \
    'echo "ANTHROPIC_API_KEY not set — add it to .env to enable the mock-tee backend."' C-m
else
  tmux send-keys -t "$SESSION:mock-tee" \
    'FLODEX_COORDINATOR=http://127.0.0.1:8000 FLODEX_NODE_PRICE_MOCK_TEE=0.005 cargo run -p node' C-m
fi

# --- window 2: local llama.cpp node ---
tmux new-window -t "$SESSION:" -n local -c "$ROOT"
if [ -z "${FLODEX_LLAMA_MODEL:-}" ]; then
  tmux send-keys -t "$SESSION:local" \
    'echo "FLODEX_LLAMA_MODEL not set — add a spec to .env to enable the local backend."; echo "Example: FLODEX_LLAMA_MODEL=hf://bartowski/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf"' C-m
elif ! command -v llama-server >/dev/null 2>&1; then
  tmux send-keys -t "$SESSION:local" \
    'echo "llama-server not on PATH — brew install llama.cpp (or build llama.cpp from source)."' C-m
else
  # Escape single quotes in the model spec for safe injection into send-keys.
  MODEL_ESC=${FLODEX_LLAMA_MODEL//\'/\'\\\'\'}
  tmux send-keys -t "$SESSION:local" \
    "FLODEX_COORDINATOR=http://127.0.0.1:8000 FLODEX_NODE_ADDR=127.0.0.1:7778 FLODEX_NODE_PRICE_LOCAL=0 FLODEX_LLAMA_MODEL='$MODEL_ESC' cargo run -p node" C-m
fi

# --- window 3: dashboard ---
tmux new-window -t "$SESSION:" -n dashboard -c "$ROOT"
tmux send-keys -t "$SESSION:dashboard" 'bun run dash' C-m

# --- window 4: client shell with hints ---
tmux new-window -t "$SESSION:" -n client -c "$ROOT"
tmux send-keys -t "$SESSION:client" 'cat <<'\''HINT'\''
flodex client — example commands:

  bun run apps/client/src/index.ts \
    --coordinator http://127.0.0.1:8000 -b mock-tee \
    send "what time is it and summarize https://example.com"

  bun run apps/client/src/index.ts \
    --coordinator http://127.0.0.1:8000 -b local --max-price 0 \
    send "explain ECDH briefly"

navigation:
  Ctrl-b 0/1/2/3/4   switch to coordinator / mock-tee / local / dashboard / client
  Ctrl-b d           detach (session keeps running)
  scripts/dev.sh --kill   stop everything
HINT' C-m

tmux select-window -t "$SESSION:client"
exec tmux attach -t "$SESSION"
