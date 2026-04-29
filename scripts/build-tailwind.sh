#!/usr/bin/env bash
# Recompila Tailwind cuando cambian las clases en index.html o assets/js/.
# Output: assets/css/tailwind.min.css (~25 KB minificado).
# Uso: ./scripts/build-tailwind.sh

set -e
cd "$(dirname "$0")/.."

if ! command -v npx >/dev/null 2>&1; then
  echo "npm/npx no encontrado. Instala Node primero: brew install node"
  exit 1
fi

echo "→ Instalando tailwindcss localmente (si falta)..."
npm install --silent --no-audit --no-fund tailwindcss@3.4.17 2>/dev/null || true

cat > /tmp/tw-input.css <<CSS
@tailwind base;
@tailwind components;
@tailwind utilities;
CSS

cat > /tmp/tw-config.js <<JS
module.exports = {
  content: ['./index.html', './assets/js/*.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      colors: {
        brand: { 50:'#f0fdfa',100:'#ccfbf1',200:'#99f6e4',300:'#5eead4',400:'#2dd4bf',500:'#14b8a6',600:'#0d9488',700:'#0f766e',800:'#115e59',900:'#134e4a',950:'#042f2e' },
        dark:  { 900:'#0B0E14', 800:'#151A23', 700:'#1F2937' },
        accent:{ purple:'#A855F7', cyan:'#22D3EE' }
      },
      backgroundImage: {
        'grid-pattern': "linear-gradient(to right, #1F2937 1px, transparent 1px), linear-gradient(to bottom, #1F2937 1px, transparent 1px)",
        'radial-glow': 'radial-gradient(circle at center, rgba(34, 211, 238, 0.15) 0%, rgba(11, 14, 20, 0) 70%)'
      }
    }
  }
};
JS

echo "→ Compilando Tailwind..."
npx tailwindcss -c /tmp/tw-config.js -i /tmp/tw-input.css -o assets/css/tailwind.min.css --minify

SIZE=$(wc -c < assets/css/tailwind.min.css)
echo "✓ assets/css/tailwind.min.css: $SIZE bytes ($(($SIZE / 1024)) KB)"
