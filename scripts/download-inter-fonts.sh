#!/usr/bin/env bash
# download-inter-fonts.sh
#
# Descarga los 3 weights de Inter (400, 600, 700) en formato woff2 desde
# Fontsource via jsDelivr CDN, y los guarda en assets/fonts/.
#
# Esto reemplaza la dependencia de Google Fonts (fonts.googleapis.com) por
# self-hosting, eliminando ~750ms de render-blocking detectado por PageSpeed.
#
# Uso:
#   ./scripts/download-inter-fonts.sh
#
# El index.html ya tiene los @font-face definidos apuntando a estas rutas:
#   assets/fonts/inter-400.woff2
#   assets/fonts/inter-600.woff2
#   assets/fonts/inter-700.woff2

set -euo pipefail

# Cambiar a la raíz del repo (asume que el script vive en /scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FONTS_DIR="$REPO_ROOT/assets/fonts"

mkdir -p "$FONTS_DIR"

# Fontsource v5 — Inter latin subset (~12 KB cada uno, optimal para web)
BASE_URL="https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin"

WEIGHTS=(400 600 700)

echo "═══════════════════════════════════════════════════════"
echo " Descargando Inter font weights desde jsDelivr (Fontsource)"
echo " Destino: $FONTS_DIR/"
echo "═══════════════════════════════════════════════════════"

for weight in "${WEIGHTS[@]}"; do
  url="${BASE_URL}-${weight}-normal.woff2"
  out="${FONTS_DIR}/inter-${weight}.woff2"

  printf "  → Inter %s normal ... " "$weight"

  if curl -sL -f -o "$out" "$url"; then
    size=$(stat -f%z "$out" 2>/dev/null || stat -c%s "$out" 2>/dev/null)
    if [ "$size" -gt 1000 ]; then
      printf "✓ %s bytes\n" "$size"
    else
      printf "✗ archivo muy pequeño (%s bytes), borrando\n" "$size"
      rm -f "$out"
      exit 1
    fi
  else
    printf "✗ falló descarga\n"
    exit 1
  fi
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo " ✓ Descarga completa. Archivos en assets/fonts/:"
ls -la "$FONTS_DIR"/inter-*.woff2
echo ""
echo " Siguiente paso: commit + push los .woff2 al repo"
echo "   git add assets/fonts/inter-*.woff2"
echo "   git commit -m 'chore(perf): self-host Inter font weights 400/600/700'"
echo "═══════════════════════════════════════════════════════"
