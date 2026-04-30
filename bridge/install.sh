#!/usr/bin/env bash
# Cockpit Bridge installer — idempotent.
#
# What it does:
#   1. Installs npm deps if needed
#   2. Drops the systemd --user unit file in ~/.config/systemd/user/
#   3. Enables linger so the service runs even when you're not logged in
#   4. Reloads systemd, enables + restarts the service
#   5. Tails the last 20 log lines so you can confirm it's healthy
#
# Run from inside WSL Ubuntu:
#   cd ~/cockpit-os/bridge && bash install.sh
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/cockpit-bridge.service"

echo "[install] bridge dir: $BRIDGE_DIR"
echo "[install] user:       $USER_NAME"

# 1. npm install if node_modules missing
if [ ! -d "$BRIDGE_DIR/node_modules" ]; then
  echo "[install] installing npm deps…"
  ( cd "$BRIDGE_DIR" && npm install --omit=dev )
else
  echo "[install] npm deps already installed"
fi

# 2. Make sure socat is available (tunnels Windows Ollama into WSL)
if ! command -v socat >/dev/null 2>&1; then
  echo "[install] installing socat (sudo)…"
  sudo apt-get update -qq
  sudo apt-get install -y socat
fi

# 3. Drop the unit file
mkdir -p "$SERVICE_DIR"
cp "$BRIDGE_DIR/cockpit-bridge.service" "$SERVICE_FILE"
echo "[install] wrote $SERVICE_FILE"

# 4. Enable linger so the service runs at boot, before login, and after logout.
# Requires sudo. Idempotent.
if ! loginctl show-user "$USER_NAME" 2>/dev/null | grep -q "Linger=yes"; then
  echo "[install] enabling linger for $USER_NAME (sudo)…"
  sudo loginctl enable-linger "$USER_NAME"
else
  echo "[install] linger already enabled"
fi

# 5. Reload + (re)start
systemctl --user daemon-reload
systemctl --user enable cockpit-bridge.service
systemctl --user restart cockpit-bridge.service

sleep 2

echo
echo "[install] status:"
systemctl --user --no-pager status cockpit-bridge.service | head -12 || true
echo
echo "[install] last 20 log lines:"
journalctl --user -u cockpit-bridge -n 20 --no-pager || true
echo
echo "[install] done. Tail logs with:"
echo "  journalctl --user -u cockpit-bridge -f"
