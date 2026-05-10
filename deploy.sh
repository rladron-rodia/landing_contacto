#!/bin/bash
# deploy.sh — orchestrate deploy of monou-backend to AWS EC2.
#
# Usage:
#   ./deploy.sh                # deploy current HEAD (uses git describe for version)
#   ./deploy.sh v2.2.1-aws     # deploy a specific tag/branch (must be checked out)
#
# Env vars (with sensible defaults):
#   INSTANCE_ID         — EC2 instance to deploy to
#   DEPLOY_S3_BUCKET    — S3 bucket for deployment artifacts (default: monou-deploy-artifacts-prod)
#   AWS_PROFILE         — AWS CLI profile (default: monou-prod)
#   AWS_REGION          — default us-east-1
set -euo pipefail

# --- Config ----------------------------------------------------------------
INSTANCE_ID="${INSTANCE_ID:-}"
DEPLOY_S3_BUCKET="${DEPLOY_S3_BUCKET:-monou-deploy-artifacts-prod}"
AWS_PROFILE="${AWS_PROFILE:-monou-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Source vars from monou-vars.sh if available
if [ -z "$INSTANCE_ID" ] && [ -f "$HOME/aws-monou-migration/monou-vars.sh" ]; then
  # shellcheck source=/dev/null
  source "$HOME/aws-monou-migration/monou-vars.sh" 2>/dev/null || true
fi

if [ -z "${INSTANCE_ID:-}" ]; then
  echo "ERROR: INSTANCE_ID not set. Either:"
  echo "  - Source ~/aws-monou-migration/monou-vars.sh, or"
  echo "  - Export INSTANCE_ID=i-xxxxxx before running"
  exit 1
fi

VERSION="${1:-$(git describe --tags --always --dirty 2>/dev/null || echo "manual-$(date +%Y%m%d-%H%M%S)")}"
ARTIFACT="monou-backend-${VERSION}.zip"
S3_KEY="artifacts/${ARTIFACT}"
AWS_FLAGS="--profile $AWS_PROFILE --region $AWS_REGION"

echo "=========================================="
echo "  Monou Backend Deploy"
echo "=========================================="
echo "  Version:    $VERSION"
echo "  Instance:   $INSTANCE_ID"
echo "  Bucket:     $DEPLOY_S3_BUCKET"
echo "  Region:     $AWS_REGION"
echo "=========================================="

# --- 1) Build artifact -----------------------------------------------------
echo
echo "[1/5] Building artifact..."

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/build"
cp -R "$REPO_ROOT/server" "$TMPDIR/build/"
cp -R "$REPO_ROOT/deploy" "$TMPDIR/build/"

# Cleanup junk
find "$TMPDIR/build" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$TMPDIR/build" -type d -name ".venv" -exec rm -rf {} + 2>/dev/null || true
find "$TMPDIR/build" -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
find "$TMPDIR/build" -name "*.pyc" -delete 2>/dev/null || true
find "$TMPDIR/build" -name ".DS_Store" -delete 2>/dev/null || true

(cd "$TMPDIR/build" && zip -qr "$TMPDIR/$ARTIFACT" .)

SIZE=$(du -h "$TMPDIR/$ARTIFACT" | cut -f1)
echo "      Built: $TMPDIR/$ARTIFACT ($SIZE)"

# --- 2) Upload to S3 -------------------------------------------------------
echo
echo "[2/5] Uploading to s3://$DEPLOY_S3_BUCKET/$S3_KEY ..."
aws s3 cp "$TMPDIR/$ARTIFACT" "s3://$DEPLOY_S3_BUCKET/$S3_KEY" $AWS_FLAGS

# --- 3) Trigger SSM Run Command --------------------------------------------
echo
echo "[3/5] Triggering deploy on $INSTANCE_ID..."

# Build the remote commands as a JSON array of strings
# Each string is a shell command run by AWS-RunShellScript on the EC2
read -r -d '' COMMANDS <<EOF || true
set -euo pipefail
echo "[remote] downloading artifact..."
aws s3 cp s3://$DEPLOY_S3_BUCKET/$S3_KEY /tmp/$ARTIFACT
echo "[remote] extracting install.sh..."
mkdir -p /tmp/monou-extract
unzip -q -o /tmp/$ARTIFACT -d /tmp/monou-extract
echo "[remote] running install.sh..."
bash /tmp/monou-extract/deploy/install.sh /tmp/$ARTIFACT
echo "[remote] cleaning extract dir..."
rm -rf /tmp/monou-extract
echo "[remote] DONE"
EOF

CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "Deploy monou-backend $VERSION" \
  --parameters "{\"commands\":[$(echo "$COMMANDS" | python3 -c 'import sys, json; print(json.dumps(sys.stdin.read()))')]}" \
  --cloud-watch-output-config "CloudWatchOutputEnabled=true" \
  $AWS_FLAGS \
  --query 'Command.CommandId' --output text)

echo "      Command ID: $CMD_ID"

# --- 4) Poll command -------------------------------------------------------
echo
echo "[4/5] Waiting for command to complete..."

while true; do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "$CMD_ID" \
    --instance-id "$INSTANCE_ID" \
    $AWS_FLAGS \
    --query 'Status' --output text 2>/dev/null || echo "Pending")

  printf "      %s — %s\n" "$(date +%H:%M:%S)" "$STATUS"

  case "$STATUS" in
    Success)
      echo
      echo "      ✓ Remote install succeeded"
      break
      ;;
    Failed|Cancelled|TimedOut)
      echo
      echo "      ✗ Deploy FAILED with status: $STATUS"
      echo
      echo "--- stdout ---"
      aws ssm get-command-invocation \
        --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" $AWS_FLAGS \
        --query 'StandardOutputContent' --output text
      echo
      echo "--- stderr ---"
      aws ssm get-command-invocation \
        --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" $AWS_FLAGS \
        --query 'StandardErrorContent' --output text
      exit 1
      ;;
  esac
  sleep 10
done

# Show final stdout (last 40 lines)
echo
echo "--- Remote stdout (last 40 lines) ---"
aws ssm get-command-invocation \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" $AWS_FLAGS \
  --query 'StandardOutputContent' --output text | tail -40

# --- 5) Validate ALB target health -----------------------------------------
echo
echo "[5/5] Validating ALB target health..."

TG_ARN=$(aws elbv2 describe-target-groups --names monou-backend-tg \
  $AWS_FLAGS --query 'TargetGroups[0].TargetGroupArn' --output text)

for i in {1..30}; do
  STATE=$(aws elbv2 describe-target-health \
    --target-group-arn "$TG_ARN" \
    $AWS_FLAGS \
    --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text 2>/dev/null || echo "unknown")
  REASON=$(aws elbv2 describe-target-health \
    --target-group-arn "$TG_ARN" \
    $AWS_FLAGS \
    --query 'TargetHealthDescriptions[0].TargetHealth.Reason' --output text 2>/dev/null || echo "")

  printf "      %s — %s%s\n" "$(date +%H:%M:%S)" "$STATE" \
    "$([ -n "$REASON" ] && [ "$REASON" != "None" ] && echo " ($REASON)" || echo "")"

  if [ "$STATE" = "healthy" ]; then
    echo
    echo "      ✓ Target healthy"
    break
  fi
  sleep 10
done

echo
echo "=========================================="
echo "  Deploy complete: $VERSION"
echo "=========================================="
