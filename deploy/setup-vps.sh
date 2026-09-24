#!/usr/bin/env bash
#
# One-shot setup for running the JEV bot 24/7 on a Debian/Ubuntu VPS.
#
# Run from the repo root AFTER you have put a valid .env in place:
#   bash deploy/setup-vps.sh
#
# Optional overrides:
#   SERVICE_NAME=jev-bot SERVICE_USER=$(whoami) WEB_PORT=3000 bash deploy/setup-vps.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-jev-bot}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
WEB_PORT="${WEB_PORT:-3000}"

echo "==> Repo:    $REPO_DIR"
echo "==> Service: $SERVICE_NAME (user: $SERVICE_USER)"

# --- Node 20+ ---------------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "${major:-0}" -ge 20 ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  echo "==> Installing Node.js 20 (NodeSource)"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "ERROR: no apt-get; install Node 20+ manually and re-run." >&2
    exit 1
  fi
fi
echo "==> node $(node -v) / npm $(npm -v)"

# --- .env -------------------------------------------------------------------
cd "$REPO_DIR"
if [ ! -f .env ]; then
  echo "ERROR: $REPO_DIR/.env is missing." >&2
  echo "       Create it first (copy .env.example) and add your keys." >&2
  exit 1
fi
chmod 600 .env
grep -q '^WEB_HOST=' .env || echo "WEB_HOST=127.0.0.1" >> .env
grep -q '^WEB_PORT=' .env || echo "WEB_PORT=${WEB_PORT}" >> .env

# --- deps -------------------------------------------------------------------
echo "==> npm ci (needs devDependencies: tsx/typescript)"
npm ci
npm run typecheck

# --- systemd ----------------------------------------------------------------
NPM_BIN="$(command -v npm)"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
echo "==> Writing $UNIT"
sudo tee "$UNIT" >/dev/null <<UNIT
[Unit]
Description=Polymarket JEV trading bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_DIR}
ExecStart=${NPM_BIN} run web
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"
sleep 3
echo "==> Status"
sudo systemctl --no-pager --full status "$SERVICE_NAME" | head -n 12 || true
echo
echo "==> Last logs"
journalctl -u "$SERVICE_NAME" -n 20 --no-pager || true
echo
echo "Done. Useful commands:"
echo "  journalctl -u ${SERVICE_NAME} -f        # follow logs"
echo "  sudo systemctl restart ${SERVICE_NAME}  # after .env/code changes"
echo "  Dashboard: ssh -L ${WEB_PORT}:127.0.0.1:${WEB_PORT} ${SERVICE_USER}@<vps-ip>"
echo "             then open http://127.0.0.1:${WEB_PORT}"
