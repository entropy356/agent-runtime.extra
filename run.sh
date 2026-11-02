#!/usr/bin/env bash
# Starts the harness. Credentials come from a shell fragment that exports AGENT_*.
#   ENV_FILE=/path/to/agent-env.sh ./run.sh
set -e
BASE="$(cd "$(dirname "$0")" && pwd)"
for candidate in "${ENV_FILE:-}" "$BASE/.env"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    set -a
    . "$candidate"
    set +a
  fi
done
export AGENT_RUNTIME_PATH="${AGENT_RUNTIME_PATH:-$BASE/../agent-runtime/demos/demo1-emotion-memory}"
export DYNAMICS_RUNTIME_PATH="${DYNAMICS_RUNTIME_PATH:-$BASE/../pr7-demo2/demos/demo2-memory-dynamics}"
exec python3 "$BASE/server.py"
