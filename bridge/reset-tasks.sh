#!/usr/bin/env bash
# reset-tasks.sh — wipe server snapshot + dedupe vault Active.md atomically.
# Run when tasks are doubled and the bridge keeps re-merging the dupes.
#
# Usage:
#   COCKPIT_VAULT_PATH=/mnt/f/Vault \
#   COCKPIT_BACKEND_URL=https://cockpit-os-646650189890.us-central1.run.app \
#   COCKPIT_ADMIN_TOKEN=<token> \
#   bash bridge/reset-tasks.sh

set -euo pipefail

: "${COCKPIT_VAULT_PATH:?required}"
: "${COCKPIT_BACKEND_URL:?required}"
: "${COCKPIT_ADMIN_TOKEN:?required}"

BACKEND="${COCKPIT_BACKEND_URL%/}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

echo "[reset] stopping bridge ..."
systemctl --user stop cockpit-bridge || true

echo "[reset] wiping server snapshot ..."
curl -fsS -X PUT \
  -H "Authorization: Bearer $COCKPIT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tasks":[]}' \
  "$BACKEND/api/tasks/snapshot" > /dev/null
echo "[reset] server snapshot cleared"

echo "[reset] deduping vault Active.md ..."
COCKPIT_VAULT_DRY_RUN=0 node "$SCRIPT_DIR/dedupe-active.mjs"

echo "[reset] starting bridge ..."
systemctl --user start cockpit-bridge

sleep 4
echo "[reset] recent bridge log:"
journalctl --user -u cockpit-bridge -n 8 --no-pager | grep -E "wrote|pushed|task-sync|vault" || true

echo "[reset] done."
