#!/bin/bash
# start-monou.sh — fetch secrets/params from AWS, then exec gunicorn.
# Runs as ExecStart of monou-backend.service systemd unit.
set -euo pipefail

# --- HOME workaround -------------------------------------------------------
# systemd has ProtectHome=true, so /home/monou is unreadable. libpq looks
# at $HOME/.postgresql/postgresql.crt for an optional client cert and gets
# EACCES on /home, masking the actual connect. Point HOME to /tmp (PrivateTmp=true).
export HOME=/tmp

# --- Region detection via IMDSv2 -------------------------------------------
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
export AWS_DEFAULT_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/region)

# --- Secrets Manager (sensitive) -------------------------------------------
DB_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id monou/prod/database --query SecretString --output text)
APP_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id monou/prod/app --query SecretString --output text)

export DATABASE_URL=$(echo "$DB_SECRET" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
export RESEND_API_KEY=$(echo "$APP_SECRET" | python3 -c "import sys,json; print(json.load(sys.stdin)['RESEND_API_KEY'])")
export ADMIN_TOKEN=$(echo "$APP_SECRET" | python3 -c "import sys,json; print(json.load(sys.stdin)['ADMIN_TOKEN'])")
export FLASK_SECRET_KEY=$(echo "$APP_SECRET" | python3 -c "import sys,json; print(json.load(sys.stdin)['FLASK_SECRET_KEY'])")

# --- Parameter Store (non-secret config) -----------------------------------
export MAIL_FROM=$(aws ssm get-parameter --name /monou/prod/MAIL_FROM --query 'Parameter.Value' --output text)
export MAIL_TO=$(aws ssm get-parameter --name /monou/prod/MAIL_TO --query 'Parameter.Value' --output text)
export ALLOWED_ORIGIN=$(aws ssm get-parameter --name /monou/prod/ALLOWED_ORIGIN --query 'Parameter.Value' --output text)
export S3_BUCKET=$(aws ssm get-parameter --name /monou/prod/S3_BUCKET --query 'Parameter.Value' --output text)
export S3_REGION=$(aws ssm get-parameter --name /monou/prod/S3_REGION --query 'Parameter.Value' --output text)

# --- Static config ---------------------------------------------------------
export PORT=8080
export PYTHONUNBUFFERED=1
export FLASK_ENV=production

# --- Activate venv and exec gunicorn ---------------------------------------
APP_DIR="/opt/monou-backend"
source "${APP_DIR}/.venv/bin/activate"
cd "${APP_DIR}/server"

exec gunicorn \
  --workers 2 \
  --bind "0.0.0.0:${PORT}" \
  --access-logfile - \
  --error-logfile - \
  --log-level info \
  --timeout 60 \
  --graceful-timeout 30 \
  app:app
