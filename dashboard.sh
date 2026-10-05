#!/usr/bin/env bash
# Dashboard launcher (shared engine, used as a git submodule).
# The engine lives in this folder, the project configuration
# (dashboard.json) lives in the calling project: it is resolved from
# the current working directory first, then from the engine folder.
# Preflight checks (deps, config) so a missing `npm install` fails
# with a clear message instead of a raw Node stack trace.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SCRIPT_FILE="$ROOT_DIR/dashboard.mjs"
if [[ -f "$(pwd)/dashboard.json" ]]; then
    CONFIG_FILE="$(pwd)/dashboard.json"
else
    CONFIG_FILE="$ROOT_DIR/dashboard.json"
fi

MIN_NODE_MAJOR_VERSION=18
NVM_NODE_VERSIONS_DIR="$HOME/.nvm/versions/node"

fail() {
    printf '[dashboard] %s\n' "$1" >&2
    if [[ -t 0 ]]; then
        printf '[dashboard] Press Enter to close.\n' >&2
        read -r || true
    fi
    exit 1
}

log() {
    printf '[dashboard] %s\n' "$1"
}

node_major_version() {
    local raw_version="$1"
    if [[ "$raw_version" =~ ^v([0-9]+) ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
        return 0
    fi
    return 1
}

# The desktop entry runs outside any login shell, so PATH may only expose
# an outdated system node: pick a node new enough for dashboard.mjs,
# falling back to the newest nvm-installed version when needed.
ensure_supported_node() {
    if command -v node >/dev/null 2>&1; then
        local current_major=""
        current_major="$(node_major_version "$(node --version 2>/dev/null || true)" || true)"
        if [[ -n "$current_major" && "$current_major" -ge "$MIN_NODE_MAJOR_VERSION" ]]; then
            return 0
        fi
        log "Ignoring PATH node $(node --version 2>/dev/null || echo unknown): v$MIN_NODE_MAJOR_VERSION or newer is required."
    fi
    if [[ -d "$NVM_NODE_VERSIONS_DIR" ]]; then
        local latest_bin=""
        latest_bin="$(ls -d "$NVM_NODE_VERSIONS_DIR"/v*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
        if [[ -n "$latest_bin" && -x "$latest_bin/node" ]]; then
            export PATH="$latest_bin:$PATH"
            log "Using node $(node --version) from nvm."
            return 0
        fi
    fi
    return 1
}

ensure_supported_node || fail "No node v$MIN_NODE_MAJOR_VERSION or newer found in PATH or $NVM_NODE_VERSIONS_DIR."

[[ -f "$SCRIPT_FILE" ]] || fail "Missing script file: $SCRIPT_FILE"
[[ -f "$CONFIG_FILE" ]] || fail "Missing config file: $CONFIG_FILE (copy and adapt dashboard.json first)"

for dep in blessed tail kill-port; do
    node -e "import('$dep')" >/dev/null 2>&1 \
        || fail "Missing dependency '$dep'. Run: npm install"
done

printf '[dashboard] Starting dashboard...\n'
# No exec: on a non-zero exit the terminal stays open (when interactive)
# so a startup crash is visible instead of flashing and closing.
set +e
node "$SCRIPT_FILE"
NODE_EXIT_CODE=$?
set -e
if [[ "$NODE_EXIT_CODE" -ne 0 ]]; then
    printf '[dashboard] Exited with code %s.\n' "$NODE_EXIT_CODE" >&2
    if [[ -t 0 ]]; then
        printf '[dashboard] Press Enter to close.\n' >&2
        read -r || true
    fi
fi
exit "$NODE_EXIT_CODE"
