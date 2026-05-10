#!/bin/bash
# deploy-frontend.sh — sync frontend (HTML/CSS/JS/fonts) to S3 + invalidate CloudFront.
#
# Complementa a deploy.sh (que solo deploya el backend a EC2).
#
# Lo que hace:
#   1. Sync de assets/ con Cache-Control 1 año (immutable)
#   2. Sync de index.html, sitemap.xml, etc. con Cache-Control 5 min
#   3. Sync de admin/ con Cache-Control 5 min
#   4. Invalidación CloudFront de "/*" para que browsers vean los cambios
#
# Usage:
#   ./deploy-frontend.sh             # deploy all
#   ./deploy-frontend.sh --dry-run   # mostrar qué subiría sin hacer cambios
#
# Requires AWS_PROFILE=monou-prod (sourced via monou-vars.sh).
set -euo pipefail

# --- Config ----------------------------------------------------------------
AWS_PROFILE="${AWS_PROFILE:-monou-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
BUCKET="${FRONTEND_BUCKET:-monoulabs-landing-prod}"
DIST_ID="${DIST_ID:-E1XWJ852NOX2OQ}"
AWS_FLAGS="--profile $AWS_PROFILE --region $AWS_REGION"

LONG_CACHE='public, max-age=31536000, immutable'    # 1 año
SHORT_CACHE='public, max-age=300, must-revalidate'  # 5 min

# Source vars from monou-vars.sh if available (for INSTANCE_ID, DIST_ID, etc.)
if [ -f "$HOME/aws-monou-migration/monou-vars.sh" ]; then
  # shellcheck source=/dev/null
  source "$HOME/aws-monou-migration/monou-vars.sh" 2>/dev/null || true
fi

DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN="--dryrun"
  echo "*** DRY-RUN MODE ***"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

echo "=========================================="
echo "  Frontend deploy → s3://$BUCKET"
echo "=========================================="
echo "  Profile:        $AWS_PROFILE"
echo "  Distribution:   $DIST_ID"
echo "=========================================="

# --- 1) Long-cache assets (1 año immutable) -------------------------------
# El bucket usa Object Ownership = Bucket owner enforced; sin ACL.
# CloudFront sirve via OAC, no necesita objetos públicos.
echo
echo "[1/4] Sync assets/ con cache de 1 año..."
aws s3 sync ./assets/ "s3://$BUCKET/assets/" \
  --cache-control "$LONG_CACHE" \
  --delete \
  $AWS_FLAGS \
  $DRY_RUN \
  --no-progress

# --- 2) Short-cache HTML/meta files (5 min) -------------------------------
echo
echo "[2/4] Sync HTML/meta con cache corto..."
for f in index.html sitemap.xml robots.txt llms.txt CNAME; do
  if [ -f "$f" ]; then
    case "$f" in
      *.html) ct="text/html; charset=utf-8" ;;
      *.xml)  ct="application/xml" ;;
      *.txt|CNAME) ct="text/plain; charset=utf-8" ;;
    esac
    if [ -z "$DRY_RUN" ]; then
      aws s3 cp "$f" "s3://$BUCKET/$f" \
        --cache-control "$SHORT_CACHE" \
        --content-type "$ct" \
        $AWS_FLAGS \
        --no-progress
      echo "    ✓ $f"
    else
      echo "    [dry] $f → $ct"
    fi
  fi
done

# og-preview.png raíz (preview social) — long cache porque rara vez cambia
if [ -f og-preview.png ]; then
  if [ -z "$DRY_RUN" ]; then
    aws s3 cp og-preview.png "s3://$BUCKET/og-preview.png" \
      --cache-control "$LONG_CACHE" \
      --content-type "image/png" \
      $AWS_FLAGS \
      --no-progress
    echo "    ✓ og-preview.png"
  fi
fi

# --- 3) Admin (HTML + JS, cache corto) ------------------------------------
echo
echo "[3/4] Sync admin/ con cache corto..."
aws s3 sync ./admin/ "s3://$BUCKET/admin/" \
  --cache-control "$SHORT_CACHE" \
  --delete \
  $AWS_FLAGS \
  $DRY_RUN \
  --no-progress

# --- 4) CloudFront invalidation -------------------------------------------
echo
if [ -n "$DRY_RUN" ]; then
  echo "[4/4] [dry] CloudFront invalidation skipped"
else
  echo "[4/4] CloudFront invalidation..."
  INV_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$DIST_ID" \
    --paths "/*" \
    $AWS_FLAGS \
    --query 'Invalidation.Id' --output text)
  echo "    Invalidation ID: $INV_ID (toma ~2 min)"
fi

echo
echo "=========================================="
echo "  Frontend deploy complete."
echo "=========================================="
echo "  Verify with:"
echo "    curl -sI https://monoulabs.ai/ | grep -i cache"
echo "    curl -sI https://monoulabs.ai/assets/js/games-loader.js | grep -i cache"
