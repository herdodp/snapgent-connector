#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -u

cd "$(dirname "$0")" || exit 1

BRIDGE_PORT="${ZS_BRIDGE_PORT:-17613}"
mkdir -p logs 2>/dev/null || true
LOG_FILE="logs/start.log"

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG_FILE" 2>/dev/null || true
}

pause_and_exit() {
    echo
    if [ -t 0 ]; then
        read -n 1 -s -r -p "Press any key to close this window..."
        echo
    fi
    exit "${1:-0}"
}

echo
echo "  === Snapgent Bridge (Linux) ==="
echo
log "===== Linux_Start.sh launched ====="

if [ ! -f "./bridge.py" ]; then
    echo "  ERROR: bridge.py is missing. Extract the complete Snapgent release first."
    log "FATAL: bridge.py not found."
    pause_and_exit 1
fi

echo "  [1/4] Looking for Python 3.9+..."
PY=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
        "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
        PY="$candidate"
        break
    fi
done

if [ -z "$PY" ]; then
    echo "  ERROR: Python 3.9 or newer was not found. Install Python 3 and try again."
    log "FATAL: no Python 3.9+ found."
    pause_and_exit 1
fi
echo "        Found: $("$PY" --version 2>&1)"

echo "  [2/4] Checking websockets library..."
if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
    echo "        Installing the bridge dependency..."
    if ! "$PY" -m pip install --user websockets >/dev/null 2>&1 ||
        ! "$PY" -c "import websockets" >/dev/null 2>&1; then
        VENV_DIR=".venv-snapgent"
        if [ ! -x "$VENV_DIR/bin/python" ]; then
            if ! "$PY" -m venv "$VENV_DIR"; then
                echo "  ERROR: Could not install websockets or create a local Python environment."
                echo "  Install python3-venv for your Linux distribution, then retry."
                log "FATAL: websockets installation and venv creation failed."
                pause_and_exit 1
            fi
        fi
        PY="$VENV_DIR/bin/python"
        if ! "$PY" -m pip install websockets; then
            echo "  ERROR: Could not install the websockets dependency."
            log "FATAL: websockets installation in local venv failed."
            pause_and_exit 1
        fi
    fi
fi
if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
    echo "  ERROR: websockets is still unavailable for $PY."
    log "FATAL: websockets import failed after installation."
    pause_and_exit 1
fi

echo "  [3/4] Detecting VS Code, Roblox Studio, and EffectCraft..."
if ! "$PY" "./setup-config.py"; then
    echo "  ERROR: MCP configuration failed. See the message above."
    log "MCP auto-configuration failed."
    pause_and_exit 1
fi

echo "  [4/4] Starting bridge..."
if command -v lsof >/dev/null 2>&1; then
    OLD_PIDS="$(lsof -ti "tcp:$BRIDGE_PORT" -s TCP:LISTEN 2>/dev/null || true)"
    for old_pid in $OLD_PIDS; do
        OLD_COMMAND="$(ps -p "$old_pid" -o args= 2>/dev/null || true)"
        case "$OLD_COMMAND" in
            *bridge.py*)
                echo "        Replacing previous Snapgent bridge (pid $old_pid)..."
                log "Stopping previous Snapgent bridge pid $old_pid."
                kill -TERM "$old_pid" 2>/dev/null || true
                ;;
            *)
                echo "  ERROR: port $BRIDGE_PORT is already in use by another process."
                echo "  Close that process or set ZS_BRIDGE_PORT, then try again."
                log "FATAL: port $BRIDGE_PORT belongs to a non-Snapgent process."
                pause_and_exit 1
                ;;
        esac
    done
    if [ -n "${OLD_PIDS:-}" ]; then sleep 1; fi
fi

echo
echo "  Keep this window open while using Snapgent."
echo
log "Launching bridge.py with $PY"
"$PY" bridge.py
BRIDGE_EXIT=$?
log "bridge exited with code $BRIDGE_EXIT"

if [ "$BRIDGE_EXIT" -ne 0 ]; then
    echo "  Bridge stopped with error code $BRIDGE_EXIT. See logs/start.log."
else
    echo "  Bridge stopped normally."
fi
pause_and_exit "$BRIDGE_EXIT"
