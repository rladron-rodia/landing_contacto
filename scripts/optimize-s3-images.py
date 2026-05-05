#!/usr/bin/env python3
"""
optimize-s3-images.py — Reduce el peso de las imágenes pesadas en S3.

Descarga las 4 PNGs grandes del bucket `muestra-imagen`, las redimensiona
a un máximo razonable manteniendo aspect ratio, las re-comprime con la
máxima optimización PNG y las sobrescribe en S3 con el mismo key.

Por qué hacemos esto:
- ChatGPT.png pesaba 2.0 MB para mostrarse a 320x180 — exceso brutal
- monou-attack/pacman/bird igual: PNGs sin redimensionar
- Total payload: 6.2 MB de imágenes en una landing
- PageSpeed Insights mobile lo penaliza con LCP elevado

Cómo correrlo:

    cd ~/Documents/Claude/Projects/landing/Landing
    pip install boto3 Pillow --user
    export AWS_ACCESS_KEY_ID=...
    export AWS_SECRET_ACCESS_KEY=...
    python3 scripts/optimize-s3-images.py

Si ya tienes AWS CLI configurado (`aws configure`), puedes saltarte
los export — boto3 lee las credentials de ~/.aws/credentials automáticamente.

Para probar SIN subir a S3 (dry-run), pasa --dry-run:

    python3 scripts/optimize-s3-images.py --dry-run

Esto descarga, optimiza y guarda localmente en /tmp para que inspecciones
las imágenes optimizadas antes de pisarlas en producción.
"""

import argparse
import io
import os
import sys
import urllib.request
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("ERROR: falta Pillow. Instala con: pip install Pillow --user")
    sys.exit(1)

# boto3 sólo se necesita para el upload real (PUT). El download usa HTTP
# público porque el bucket es public-read. Esto permite correr --dry-run
# sin tener credenciales AWS configuradas.
try:
    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False


BUCKET = "muestra-imagen"
REGION = "us-east-1"
S3_BASE_URL = f"https://{BUCKET}.s3.{REGION}.amazonaws.com"

# Imágenes a optimizar.
# max_w x max_h es el bounding box; PIL.thumbnail() preserva aspect ratio.
# Display real:
#   - ChatGPT.png    — usada como override de un juego (display ~320x180 en card)
#   - monou-attack   — F2P card slide (display 320x180, retina 2x = 640x360)
#   - monou-pacman   — igual
#   - monou-bird     — igual
TARGETS = [
    {"key": "ChatGPT.png",     "max_w": 800, "max_h": 600},
    {"key": "monou-attack.png", "max_w": 800, "max_h": 450},
    {"key": "monou-pacman.png", "max_w": 800, "max_h": 450},
    {"key": "monou-bird.png",   "max_w": 800, "max_h": 450},
]


def fmt_bytes(n):
    """Formatea bytes en KB/MB legibles."""
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.2f} MB"


def download_via_http(key):
    """Descarga vía HTTP público (no requiere credenciales AWS)."""
    url = f"{S3_BASE_URL}/{key}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")
            return r.read()
    except Exception as e:
        raise RuntimeError(f"falló download HTTP de {url}: {e}")


def optimize_one(s3, target, dry_run=False):
    """Descarga, optimiza, opcionalmente sube de vuelta a S3."""
    key = target["key"]
    max_w = target["max_w"]
    max_h = target["max_h"]

    print(f"\n→ {key}")

    # 1. Descargar (HTTP público, no requiere creds)
    try:
        original_bytes = download_via_http(key)
    except RuntimeError as e:
        print(f"  ✗ {e}")
        return None

    original_size = len(original_bytes)
    print(f"  Original: {fmt_bytes(original_size)}")

    # 2. Cargar con PIL
    img = Image.open(io.BytesIO(original_bytes))
    orig_dims = img.size
    print(f"  Dimensiones: {orig_dims[0]}x{orig_dims[1]} -> max {max_w}x{max_h}")

    # 3. Redimensionar manteniendo aspect ratio
    img.thumbnail((max_w, max_h), Image.LANCZOS)
    new_dims = img.size

    # 4. Optimizar y guardar en buffer
    out = io.BytesIO()
    # Si es PNG con alpha, mantener; si es RGB, también PNG.
    save_kwargs = {"format": "PNG", "optimize": True}
    img.save(out, **save_kwargs)
    new_bytes = out.getvalue()
    new_size = len(new_bytes)
    reduction = (1 - new_size / original_size) * 100
    print(
        f"  Optimizado: {new_dims[0]}x{new_dims[1]}, "
        f"{fmt_bytes(new_size)} ({reduction:.1f}% menos)"
    )

    # 5. Acción según modo
    if dry_run:
        # Guardar a /tmp para inspección
        out_path = Path("/tmp") / f"optimized_{key}"
        out_path.write_bytes(new_bytes)
        print(f"  [dry-run] Guardado en {out_path} — inspecciónalo antes de subir")
    else:
        # Subir a S3 sobrescribiendo.
        # NOTA: el bucket tiene Object Ownership = Bucket owner enforced
        # (default desde 2023), que deshabilita ACLs. La visibilidad pública
        # se hereda del bucket policy, no por ACL por objeto.
        s3.put_object(
            Bucket=BUCKET,
            Key=key,
            Body=new_bytes,
            ContentType="image/png",
            CacheControl="public, max-age=31536000, immutable",  # 1 año
        )
        print(f"  ✓ Subido a s3://{BUCKET}/{key}")

    return {"key": key, "before": original_size, "after": new_size}


def main():
    parser = argparse.ArgumentParser(description="Optimiza imágenes pesadas en S3")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="No sube a S3, solo descarga y guarda optimizadas en /tmp",
    )
    args = parser.parse_args()

    print("═══════════════════════════════════════════════════════════")
    print(f" Optimización de imágenes S3 — bucket: {BUCKET}")
    print(f" Modo: {'DRY-RUN (descarga HTTP + guarda local, no toca S3)' if args.dry_run else 'PRODUCCIÓN (sobrescribe S3)'}")
    print("═══════════════════════════════════════════════════════════")

    # Cliente S3 sólo se inicializa para upload real
    s3 = None
    if not args.dry_run:
        if not BOTO3_AVAILABLE:
            print("\nERROR: boto3 no instalado. Para upload real: pip install boto3 --user")
            sys.exit(1)
        try:
            s3 = boto3.client("s3", region_name=REGION)
            s3.head_bucket(Bucket=BUCKET)
        except NoCredentialsError:
            print("\nERROR: no hay credenciales AWS configuradas.")
            print("Opciones:")
            print("  1. export AWS_ACCESS_KEY_ID=... y AWS_SECRET_ACCESS_KEY=...")
            print("  2. ejecuta `aws configure` para guardar en ~/.aws/credentials")
            print("\nTIP: si solo querías ver el resultado, corre con --dry-run")
            print("     (no requiere credenciales AWS).")
            sys.exit(1)
        except ClientError as e:
            print(f"\nERROR accediendo al bucket: {e}")
            sys.exit(1)

    # Procesar cada target
    results = []
    for t in TARGETS:
        try:
            r = optimize_one(s3, t, dry_run=args.dry_run)
            if r:
                results.append(r)
        except Exception as e:
            print(f"  ✗ FALLO: {e}")

    # Resumen
    print("\n═══════════════════════════════════════════════════════════")
    print(" Resumen")
    print("═══════════════════════════════════════════════════════════")
    total_before = sum(r["before"] for r in results)
    total_after = sum(r["after"] for r in results)
    saved = total_before - total_after
    pct = (1 - total_after / total_before) * 100 if total_before else 0
    for r in results:
        red = (1 - r["after"] / r["before"]) * 100
        print(f"  {r['key']:28} {fmt_bytes(r['before']):>10} -> {fmt_bytes(r['after']):>10} ({red:5.1f}% menos)")
    print("  " + "─" * 56)
    print(f"  {'TOTAL':28} {fmt_bytes(total_before):>10} -> {fmt_bytes(total_after):>10} ({pct:.1f}% menos)")
    print(f"  Ahorro: {fmt_bytes(saved)}")

    if args.dry_run:
        print("\n[dry-run] Inspecciona /tmp/optimized_*.png. Si todo OK, corre")
        print("          el script SIN --dry-run para sobrescribir en S3.")
    else:
        print("\n✓ Listo. Cloudflare/browsers traerán las nuevas versiones inmediatamente")
        print("  (S3 cambia ETags al sobrescribir). Corre PageSpeed para verificar.")


if __name__ == "__main__":
    main()
