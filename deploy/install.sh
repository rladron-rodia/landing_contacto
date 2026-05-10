#!/bin/bash
# install.sh — runs on EC2 via SSM. Sets up dependencies, extracts artifact,
# installs venv, configures systemd, starts service.
#
# Usage: bash install.sh /tmp/monou-backend-artifact.zip
set -euo pipefail

ARTIFACT="${1:-/tmp/monou-backend-artifact.zip}"
INSTALL_DIR="/opt/monou-backend"
SERVICE_USER="monou"
SERVICE_GROUP="monou"

log() { echo "[install] $(date +%H:%M:%S) $*"; }

if [ ! -f "$ARTIFACT" ]; then
  log "ERROR: artifact $ARTIFACT not found"
  exit 1
fi

# --- 1) System packages ----------------------------------------------------
log "Installing system packages..."
dnf install -y python3.11 python3.11-pip unzip >/dev/null 2>&1

# --- 2) Service user -------------------------------------------------------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating user $SERVICE_USER..."
  useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
fi

# --- 3) Stop existing service if running -----------------------------------
if systemctl is-active --quiet monou-backend.service 2>/dev/null; then
  log "Stopping existing service..."
  systemctl stop monou-backend.service
fi

# --- 4) Atomic install: stage → swap ---------------------------------------
STAGING_DIR="${INSTALL_DIR}.staging"
log "Staging artifact in $STAGING_DIR..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
unzip -q "$ARTIFACT" -d "$STAGING_DIR"

# Validate expected structure
if [ ! -f "$STAGING_DIR/server/app.py" ] || [ ! -f "$STAGING_DIR/server/requirements.txt" ]; then
  log "ERROR: artifact missing server/app.py or server/requirements.txt"
  ls -la "$STAGING_DIR"
  exit 1
fi
if [ ! -f "$STAGING_DIR/deploy/start-monou.sh" ]; then
  log "ERROR: artifact missing deploy/start-monou.sh"
  exit 1
fi

# Backup current install (if exists) and swap atomically
if [ -d "$INSTALL_DIR" ]; then
  log "Backing up current install to ${INSTALL_DIR}.old..."
  rm -rf "${INSTALL_DIR}.old"
  mv "$INSTALL_DIR" "${INSTALL_DIR}.old"
fi
mv "$STAGING_DIR" "$INSTALL_DIR"

# --- 5) Python venv + dependencies -----------------------------------------
log "Creating venv and installing dependencies..."
python3.11 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --upgrade pip wheel --quiet
"$INSTALL_DIR/.venv/bin/pip" install -r "$INSTALL_DIR/server/requirements.txt" --quiet

# --- 6) Permissions --------------------------------------------------------
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/deploy/start-monou.sh"
chmod +x "$INSTALL_DIR/deploy/install.sh"

# --- 7) systemd unit -------------------------------------------------------
log "Installing systemd unit..."
cp "$INSTALL_DIR/deploy/monou-backend.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable monou-backend.service >/dev/null 2>&1

# --- 8) Start service ------------------------------------------------------
log "Starting service..."
systemctl restart monou-backend.service

# --- 9) Wait for active ----------------------------------------------------
for i in {1..30}; do
  if systemctl is-active --quiet monou-backend.service; then
    log "Service is active"
    break
  fi
  sleep 2
done

if ! systemctl is-active --quiet monou-backend.service; then
  log "ERROR: service failed to start"
  systemctl status monou-backend.service --no-pager -l | head -50
  journalctl -u monou-backend.service --no-pager -n 50
  exit 1
fi

# --- 10) Local health check (gunicorn binds to 8080) -----------------------
log "Local health check on 127.0.0.1:8080/api/health..."
for i in {1..15}; do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    log "Local health check OK"
    break
  fi
  sleep 2
done

curl -sS http://127.0.0.1:8080/api/health || log "WARN: local health did not respond — check journalctl"

# --- 11) Cleanup -----------------------------------------------------------
log "Cleaning up..."
rm -rf "${INSTALL_DIR}.old"
rm -f "$ARTIFACT"

log "Install complete"
systemctl status monou-backend.service --no-pager -l | head -10
