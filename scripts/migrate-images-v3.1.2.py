#!/usr/bin/env python3
"""
migrate_images_v312.py — Migración one-off para v3.1.2.

Mueve 8 imágenes desde el bucket legacy `muestra-imagen` (compartido,
sin optimizar, PNGs de 600KB-2MB) → bucket prod `monou-landing-images-prod`
con pipeline de optimización del backend (resize + WebP + PNG).

Produce:
    - 8 pares <slug>-<hash8>.{webp,png} en monou-landing-images-prod
    - SQL UPDATE statements para 4 filas (3 games + 1 site_link)
    - HTML <picture> snippets para 10 referencias en index.html

Imágenes y bounding boxes:
    | filename         | display    | retina 2x | bbox usado |
    |------------------|------------|-----------|------------|
    | monou-attack.png | 320×180    | 640×360   | 640×360    |
    | monou-pacman.png | 320×180    | 640×360   | 640×360    |
    | monou-bird.png   | 320×180    | 640×360   | 640×360    |
    | minecraft.png    | 200×200    | 400×400   | 400×400    |
    | clashroyale.png  | 200×200    | 400×400   | 400×400    |
    | brawlstar.png    | 200×200    | 400×400   | 400×400    |
    | roblox.png       | 200×200    | 400×400   | 400×400    |
    | ChatGPT.png      | (site_link)| 400×400   | 400×400    |

Cómo correrlo:

    cd ~/Documents/Claude/Projects/landing/Landing
    source ~/aws-monou-migration/monou-vars.sh   # set AWS_PROFILE=monou-prod
    python3 outputs/migrate_images_v312.py

    # Para dry-run (no sube a S3, no escribe SQL):
    python3 outputs/migrate_images_v312.py --dry-run

Decisiones:
- Hash es sha256 de los bytes WebP optimizados, primeros 8 hex chars.
  Permite cache busting cuando se re-optimiza la misma imagen.
- WebP quality 80 (sweet spot tamaño/calidad). PNG sirve solo como
  fallback para Safari < 14 y crawlers que no soportan WebP.
- Cache-Control 1 año immutable (las URLs cambian al cambiar contenido,
  por el hash, así que safe).
- Bucket monou-landing-images-prod ya existe (creado en Fase 4 con OAC),
  solo necesita PUT permissions del IAM user que corre el script.
"""

import argparse
import hashlib
import io
import json
import sys
import urllib.request
from pathlib import Path

# ─── Config ──────────────────────────────────────────────────────────────────

SOURCE_BUCKET_BASE = "https://muestra-imagen.s3.us-east-1.amazonaws.com"
DEST_BUCKET = "monou-landing-images-prod"
DEST_REGION = "us-east-1"
DEST_BASE = f"https://{DEST_BUCKET}.s3.{DEST_REGION}.amazonaws.com"

# Pipeline de imágenes a migrar.
# slug = key prefix dentro del bucket dest (también nombre lógico)
# bbox = (max_w, max_h) bounding box para resize
IMAGES = [
    # F2P carousel — 320×180 displayed, 2x retina = 640×360
    {"src_key": "monou-attack.png", "slug": "games/monou-attack", "bbox": (640, 360)},
    {"src_key": "monou-pacman.png", "slug": "games/monou-pacman", "bbox": (640, 360)},
    {"src_key": "monou-bird.png",   "slug": "games/monou-bird",   "bbox": (640, 360)},
    # Publishers — 200×200 displayed, 2x retina = 400×400
    {"src_key": "minecraft.png",    "slug": "publishers/minecraft",   "bbox": (400, 400)},
    {"src_key": "clashroyale.png",  "slug": "publishers/clashroyale", "bbox": (400, 400)},
    {"src_key": "brawlstar.png",    "slug": "publishers/brawlstar",   "bbox": (400, 400)},
    {"src_key": "roblox.png",       "slug": "publishers/roblox",      "bbox": (400, 400)},
    # Site link icon (ChatGPT)
    {"src_key": "ChatGPT.png",      "slug": "site-links/chatgpt",     "bbox": (400, 400)},
]

# DB rows que necesitan UPDATE (slug → src_filename).
# Tabla "games":
DB_UPDATES_GAMES = {
    "brawl-stars":  "brawlstar.png",
    "clash-royale": "clashroyale.png",
    "roblox":       "roblox.png",
}
# Tabla "site_links":
DB_UPDATES_SITE_LINKS = {
    "view_full_catalog": "ChatGPT.png",
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

def fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.2f} MB"


def download(src_key: str) -> bytes:
    """Descarga via HTTP público (muestra-imagen es public-read)."""
    url = f"{SOURCE_BUCKET_BASE}/{src_key}"
    print(f"  ↓ download {url}")
    with urllib.request.urlopen(url, timeout=30) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status} de {url}")
        return r.read()


def optimize(raw: bytes, bbox):
    """Devuelve (png_bytes, webp_bytes, dims) usando Pillow."""
    from PIL import Image
    img = Image.open(io.BytesIO(raw))
    img.load()
    img.thumbnail(bbox, Image.Resampling.LANCZOS)

    # Modo handling
    out_img = img
    if out_img.mode == "P":
        out_img = out_img.convert("RGBA" if "transparency" in out_img.info else "RGB")
    elif out_img.mode == "LA":
        out_img = out_img.convert("RGBA")
    elif out_img.mode == "L":
        out_img = out_img.convert("RGB")

    # PNG
    pbuf = io.BytesIO()
    out_img.save(pbuf, format="PNG", optimize=True)
    png_bytes = pbuf.getvalue()

    # WebP (calidad 80, method 6 max compresión)
    wbuf = io.BytesIO()
    out_img.save(wbuf, format="WEBP", quality=80, method=6)
    webp_bytes = wbuf.getvalue()

    return png_bytes, webp_bytes, out_img.size


def upload(s3, key: str, body: bytes, content_type: str):
    s3.put_object(
        Bucket=DEST_BUCKET,
        Key=key,
        Body=body,
        ContentType=content_type,
        CacheControl="public, max-age=31536000, immutable",
    )


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="No sube a S3, solo guarda en /tmp/v312/")
    args = parser.parse_args()

    print("═" * 70)
    print(f" Migración v3.1.2 — muestra-imagen → {DEST_BUCKET}")
    print(f" Modo: {'DRY-RUN (no toca S3)' if args.dry_run else 'PRODUCCIÓN'}")
    print("═" * 70)

    s3 = None
    if not args.dry_run:
        try:
            import boto3
            from botocore.exceptions import NoCredentialsError, ClientError
        except ImportError:
            print("ERROR: pip install boto3 Pillow --break-system-packages")
            sys.exit(1)
        try:
            s3 = boto3.client("s3", region_name=DEST_REGION)
            s3.head_bucket(Bucket=DEST_BUCKET)
        except NoCredentialsError:
            print("\nERROR: no hay credenciales AWS. Activa monou-prod profile:")
            print("  source ~/aws-monou-migration/monou-vars.sh")
            sys.exit(1)
        except ClientError as e:
            print(f"\nERROR head_bucket {DEST_BUCKET}: {e}")
            sys.exit(1)
    else:
        Path("/tmp/v312").mkdir(exist_ok=True)

    # Mapping resultado: src_key → {slug, hash, png_url, webp_url, sizes}
    results = {}

    for img in IMAGES:
        src_key = img["src_key"]
        slug = img["slug"]
        bbox = img["bbox"]
        print(f"\n→ {src_key} (bbox {bbox[0]}×{bbox[1]})")

        try:
            raw = download(src_key)
            print(f"  Original: {fmt_bytes(len(raw))}")
            png_b, webp_b, dims = optimize(raw, bbox)
            print(f"  Resized:  {dims[0]}×{dims[1]}")
            print(f"  PNG out:  {fmt_bytes(len(png_b))} "
                  f"({(1 - len(png_b)/len(raw))*100:.1f}% menos)")
            print(f"  WebP out: {fmt_bytes(len(webp_b))} "
                  f"({(1 - len(webp_b)/len(raw))*100:.1f}% menos)")

            # Hash del WebP (versionado de cache)
            content_hash = hashlib.sha256(webp_b).hexdigest()[:8]
            png_key = f"{slug}-{content_hash}.png"
            webp_key = f"{slug}-{content_hash}.webp"

            if args.dry_run:
                Path(f"/tmp/v312/{Path(png_key).name}").write_bytes(png_b)
                Path(f"/tmp/v312/{Path(webp_key).name}").write_bytes(webp_b)
                print(f"  [dry-run] /tmp/v312/{Path(png_key).name}")
                print(f"  [dry-run] /tmp/v312/{Path(webp_key).name}")
            else:
                upload(s3, png_key, png_b, "image/png")
                upload(s3, webp_key, webp_b, "image/webp")
                print(f"  ✓ {DEST_BASE}/{png_key}")
                print(f"  ✓ {DEST_BASE}/{webp_key}")

            results[src_key] = {
                "slug": slug,
                "hash": content_hash,
                "png_key": png_key,
                "webp_key": webp_key,
                "png_url": f"{DEST_BASE}/{png_key}",
                "webp_url": f"{DEST_BASE}/{webp_key}",
                "raw_size": len(raw),
                "png_size": len(png_b),
                "webp_size": len(webp_b),
                "dims": dims,
            }
        except Exception as e:
            print(f"  ✗ FALLÓ: {e}")

    # ─── Resumen ──────────────────────────────────────────────────────────
    print("\n" + "═" * 70)
    print(" Resumen")
    print("═" * 70)
    total_raw = sum(r["raw_size"] for r in results.values())
    total_webp = sum(r["webp_size"] for r in results.values())
    total_png = sum(r["png_size"] for r in results.values())
    print(f"  Imágenes:  {len(results)}/{len(IMAGES)}")
    print(f"  Original:  {fmt_bytes(total_raw)}")
    print(f"  Total PNG: {fmt_bytes(total_png)}")
    if total_raw > 0:
        print(f"  Total WebP:{fmt_bytes(total_webp)} "
              f"({(1 - total_webp/total_raw)*100:.1f}% menos vs original)")
    else:
        print("  Total WebP: 0 B (no se procesó ninguna imagen)")
        print("\n  ⚠ Ninguna imagen se descargó. Verifica acceso a")
        print(f"    {SOURCE_BUCKET_BASE}/<imagen>.png desde tu red.")
        sys.exit(2)

    # ─── Output: SQL ──────────────────────────────────────────────────────
    sql_lines = ["-- Genera por outputs/migrate_images_v312.py", ""]
    sql_lines.append("BEGIN;")
    sql_lines.append("")
    sql_lines.append("-- GAMES")
    for slug, src_filename in DB_UPDATES_GAMES.items():
        if src_filename not in results:
            sql_lines.append(f"-- SKIP {slug}: {src_filename} no migrada")
            continue
        url = results[src_filename]["png_url"]
        sql_lines.append(
            f"UPDATE games SET image_url = '{url}' WHERE slug = '{slug}';"
        )
    sql_lines.append("")
    sql_lines.append("-- SITE_LINKS")
    for key, src_filename in DB_UPDATES_SITE_LINKS.items():
        if src_filename not in results:
            sql_lines.append(f"-- SKIP {key}: {src_filename} no migrada")
            continue
        url = results[src_filename]["png_url"]
        sql_lines.append(
            f"UPDATE site_links SET image_url = '{url}' WHERE key = '{key}';"
        )
    sql_lines.append("")
    sql_lines.append("COMMIT;")

    sql_path = Path(__file__).parent / "v312-db-updates.sql"
    sql_path.write_text("\n".join(sql_lines))
    print(f"\n  ✓ SQL escrito: {sql_path}")

    # ─── Output: HTML snippets ────────────────────────────────────────────
    html_lines = ["# v3.1.2 — Replacements para index.html\n"]
    html_lines.append("# Cada bloque tiene `OLD:` (lo que está actualmente)")
    html_lines.append("# y `NEW:` (lo que debe quedar).\n")

    # Mapeo src_filename → display dims usadas en HTML
    HTML_REPLACEMENTS = {
        "monou-attack.png": ("320", "180"),
        "monou-pacman.png": ("320", "180"),
        "monou-bird.png":   ("320", "180"),
        "minecraft.png":    ("200", "200"),
        "clashroyale.png":  ("200", "200"),
        "brawlstar.png":    ("200", "200"),
        "roblox.png":       ("200", "200"),
    }

    for src_filename, (w, h) in HTML_REPLACEMENTS.items():
        if src_filename not in results:
            continue
        r = results[src_filename]
        old_url = f"{SOURCE_BUCKET_BASE}/{src_filename}"
        html_lines.append(f"\n## {src_filename}")
        html_lines.append(f"OLD: src=\"{old_url}\"")
        html_lines.append(f"NEW src (PNG fallback): {r['png_url']}")
        html_lines.append(f"NEW srcset (WebP):      {r['webp_url']}")

    out_md = Path(__file__).parent / "v312-html-replacements.md"
    out_md.write_text("\n".join(html_lines))
    print(f"  ✓ HTML map escrito: {out_md}")

    # ─── JSON: snapshot completo ──────────────────────────────────────────
    json_path = Path(__file__).parent / "v312-results.json"
    json_path.write_text(json.dumps(results, indent=2))
    print(f"  ✓ JSON escrito:     {json_path}")

    print("\nNext:")
    print("  1. psql -h 127.0.0.1 -p 55432 -U monou_admin -d monou_contacts -f outputs/v312-db-updates.sql")
    print("  2. Aplicar replacements en index.html (ver v312-html-replacements.md)")
    print("  3. Actualizar server/db.py GAMES_SEED + SITE_LINKS_SEED")
    print("  4. ./deploy.sh v3.1.2")
    print("  5. PageSpeed test mobile + desktop")


if __name__ == "__main__":
    main()
