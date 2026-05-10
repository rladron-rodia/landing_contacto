#!/bin/bash
# fix-cache-headers.sh — Apply correct Cache-Control headers to existing S3 objects.
#
# Why this exists:
#   PageSpeed Insights flagged "Usar tiempos de vida de caché eficientes —
#   Ahorro estimado de 219 KiB" para fonts/JS/CSS porque CloudFront/browsers
#   asumen 1h por defecto cuando no hay Cache-Control en el origin.
#
# What it does:
#   Updates Cache-Control metadata on existing S3 objects WITHOUT re-uploading
#   the content (uses --metadata-directive REPLACE). Idempotent — safe to
#   re-run as many times as needed.
#
# Strategy:
#   - assets/{css,fonts,js,img}/* → 1 año immutable. Estos archivos cambian
#     vía hash en filename (Tailwind tiene minify, JS no — ver TODO).
#   - admin/* HTML/JS → 5 min (cambian con releases admin)
#   - index.html, sitemap.xml, robots.txt → 5 min (frontend dinámico-ish)
#
# Usage:
#   ./scripts/fix-cache-headers.sh
#
# Requires AWS_PROFILE=monou-prod (sourced via monou-vars.sh).
#
# Después de correr, hay que invalidar CloudFront para que los browsers
# capten los headers nuevos:
#   aws cloudfront create-invalidation --distribution-id E1XWJ852NOX2OQ --paths "/*"
set -euo pipefail

# --- Config ----------------------------------------------------------------
AWS_PROFILE="${AWS_PROFILE:-monou-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
BUCKET="${FRONTEND_BUCKET:-monoulabs-landing-prod}"
DIST_ID="${DIST_ID:-E1XWJ852NOX2OQ}"
AWS_FLAGS="--profile $AWS_PROFILE --region $AWS_REGION"

LONG_CACHE='public, max-age=31536000, immutable'   # 1 año
SHORT_CACHE='public, max-age=300, must-revalidate' # 5 min

echo "=========================================="
echo "  Fix Cache-Control headers en S3"
echo "=========================================="
echo "  Bucket: $BUCKET"
echo "  Profile: $AWS_PROFILE"
echo "=========================================="

# --- 1) Long-cache directories (assets/) ----------------------------------
# Para cada prefix, pasamos --metadata-directive REPLACE para que S3
# re-genere el ETag pero conserve el content-md5. content-type NO se pasa,
# así que S3 mantiene el guess original (image/png, text/javascript, etc.)
fix_long_cache() {
  local prefix="$1"
  local content_type="$2"
  echo
  echo "[+] $prefix → $LONG_CACHE"
  aws s3 cp "s3://$BUCKET/$prefix" "s3://$BUCKET/$prefix" \
    --recursive \
    --metadata-directive REPLACE \
    --cache-control "$LONG_CACHE" \
    --content-type "$content_type" \
    $AWS_FLAGS \
    --no-progress
}

# JS bundles
fix_long_cache "assets/js/" "application/javascript; charset=utf-8"

# CSS
fix_long_cache "assets/css/" "text/css; charset=utf-8"

# Fonts (woff2)
fix_long_cache "assets/fonts/" "font/woff2"

# Imágenes (logos, og-preview, etc — no incluye games/ ni publishers/
# que ahora viven en monou-landing-images-prod)
fix_long_cache "assets/img/" "image/png"

# --- 2) Short-cache files (HTML root + meta) ------------------------------
# index.html cambia con cada release; tiene que invalidarse rápido.
echo
echo "[+] index.html, sitemap.xml, robots.txt, llms.txt → $SHORT_CACHE"

for f in index.html sitemap.xml robots.txt llms.txt CNAME; do
  if aws s3 ls "s3://$BUCKET/$f" $AWS_FLAGS >/dev/null 2>&1; then
    # Detectar content-type apropiado
    case "$f" in
      *.html) ct="text/html; charset=utf-8" ;;
      *.xml)  ct="application/xml" ;;
      *.txt)  ct="text/plain; charset=utf-8" ;;
      CNAME)  ct="text/plain; charset=utf-8" ;;
    esac
    aws s3 cp "s3://$BUCKET/$f" "s3://$BUCKET/$f" \
      --metadata-directive REPLACE \
      --cache-control "$SHORT_CACHE" \
      --content-type "$ct" \
      $AWS_FLAGS \
      --no-progress
    echo "    ✓ $f"
  else
    echo "    - $f (no existe en bucket)"
  fi
done

# --- 3) Admin (HTML + JS) -------------------------------------------------
# El HTML tiene cache corto (cambia con releases), pero los .js de admin
# son referenciados por <script src="..."> sin hash, así que también
# corto cache para evitar stale-bundle bugs durante releases.
echo
echo "[+] admin/ → $SHORT_CACHE"
aws s3 cp "s3://$BUCKET/admin/" "s3://$BUCKET/admin/" \
  --recursive \
  --metadata-directive REPLACE \
  --cache-control "$SHORT_CACHE" \
  $AWS_FLAGS \
  --no-progress \
  --exclude "*" --include "*.html" --include "*.js" --include "*.css" || true

# --- 4) CloudFront invalidation -------------------------------------------
echo
echo "=========================================="
echo "  CloudFront invalidation"
echo "=========================================="
INV_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  $AWS_FLAGS \
  --query 'Invalidation.Id' --output text)
echo "  Invalidation ID: $INV_ID"
echo "  Esperando ~2 min para que browsers vean los nuevos headers..."
echo "  Verifica con:"
echo "    curl -sI https://monoulabs.ai/assets/js/games-loader.js | grep -i cache"
echo "    Esperado: cache-control: public, max-age=31536000, immutable"
echo

echo "=========================================="
echo "  Done."
echo "=========================================="
