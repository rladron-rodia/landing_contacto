"""
image_optimizer — utilidades de procesamiento de imágenes con Pillow.

Pipeline estándar para upload desde admin:
    raw bytes → validate_and_load → resize_to_bbox → encode_png + encode_webp

Decisiones de diseño:
- Aceptamos PNG, JPEG, WebP, GIF como inputs (los formatos modernos comunes).
- Salidas siempre PNG optimizado y WebP a calidad 80 (sweet spot tamaño/calidad).
- thumbnail() preserva aspect ratio dentro de un bounding box. Resize directo
  sería más rápido pero deformaría imágenes con aspect ratio distinto al box.
- Mode handling: si el input es RGBA o LA (con alpha) se mantiene; si no, RGB.
  Para WebP eso es relevante porque WebP soporta alpha pero pesa más con él.
- Limites duros (15 MB raw, 5000x5000 dim) para evitar DoS de memoria desde
  uploads maliciosos. Con 5000x5000 RGBA Pillow asigna ~100 MB en RAM.
"""

import io
from typing import Tuple

from PIL import Image, UnidentifiedImageError


# Limites para defensa contra uploads maliciosos
MAX_INPUT_BYTES = 15 * 1024 * 1024     # 15 MB de raw upload
MAX_INPUT_DIMENSIONS = (5000, 5000)    # decode máximo, fallar si excede
DEFAULT_WEBP_QUALITY = 80              # calidad de WebP por default
DEFAULT_WEBP_METHOD = 6                # 0-6, 6 = max compresión, más lento

# Formatos aceptados para input. Pillow soporta más, pero limitamos a los
# que esperamos en producción.
ACCEPTED_INPUT_FORMATS = {"PNG", "JPEG", "WEBP", "GIF"}


class ImageOptimizationError(Exception):
    """Falla en validación o procesamiento de imagen."""
    pass


def validate_and_load(
    raw: bytes,
    max_input_size: int = MAX_INPUT_BYTES,
    max_dimensions: Tuple[int, int] = MAX_INPUT_DIMENSIONS,
) -> Image.Image:
    """Valida raw bytes y devuelve un objeto PIL.Image.

    Lanza ImageOptimizationError si:
    - El input es demasiado grande
    - No es una imagen válida o el formato no está soportado
    - Las dimensiones son sospechosamente grandes
    """
    if not raw:
        raise ImageOptimizationError("upload vacío")

    if len(raw) > max_input_size:
        raise ImageOptimizationError(
            f"archivo demasiado grande: {len(raw):,} bytes "
            f"(máximo {max_input_size:,})"
        )

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()  # fuerza decode completo, captura errores temprano
    except UnidentifiedImageError:
        raise ImageOptimizationError("archivo no es una imagen reconocida")
    except (OSError, ValueError) as e:
        # Encadenamos `from e` para logging via traceback, pero NO incluimos
        # el mensaje original de Pillow en nuestro mensaje porque podría
        # exponer detalles internos (paths, memoria, etc.) al usuario final.
        raise ImageOptimizationError("imagen corrupta o ilegible") from e

    fmt = (img.format or "").upper()
    if fmt not in ACCEPTED_INPUT_FORMATS:
        raise ImageOptimizationError(
            f"formato no soportado: {fmt or 'desconocido'} "
            f"(aceptados: {', '.join(sorted(ACCEPTED_INPUT_FORMATS))})"
        )

    if img.width > max_dimensions[0] or img.height > max_dimensions[1]:
        raise ImageOptimizationError(
            f"dimensiones excesivas: {img.width}x{img.height} "
            f"(máximo {max_dimensions[0]}x{max_dimensions[1]})"
        )

    return img


def resize_to_bbox(img: Image.Image, max_w: int, max_h: int) -> Image.Image:
    """Redimensiona dentro de un bounding box preservando aspect ratio.

    Usa Image.thumbnail (in-place modifier) sobre una copia para no mutar
    el objeto original — útil porque queremos generar PNG y WebP de la
    misma imagen redimensionada.
    """
    if max_w <= 0 or max_h <= 0:
        raise ImageOptimizationError(f"max_w/max_h inválido: {max_w}x{max_h}")

    out = img.copy()
    # v2.7.1: usa el enum Image.Resampling.LANCZOS (compatible con Pillow 9.1+,
    # incluyendo 12.x). El alias antiguo Image.LANCZOS estaba deprecado desde
    # Pillow 10 y fue removido en 12.0.
    out.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    return out


def encode_png(img: Image.Image) -> bytes:
    """Encode como PNG con optimize=True (máxima compresión lossless).

    Si el input es modo P (paletizado, típico de GIF) lo convertimos a
    RGB/RGBA según tenga alpha — PNG soporta paleta pero es raro y
    algunos browsers la renderizan diferente.
    """
    out = img
    if out.mode == "P":
        # Conserva alpha si la paleta tiene transparencia
        if "transparency" in out.info:
            out = out.convert("RGBA")
        else:
            out = out.convert("RGB")
    elif out.mode == "LA":
        out = out.convert("RGBA")
    elif out.mode == "L":
        out = out.convert("RGB")

    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def encode_webp(
    img: Image.Image,
    quality: int = DEFAULT_WEBP_QUALITY,
    method: int = DEFAULT_WEBP_METHOD,
) -> bytes:
    """Encode como WebP con calidad ajustable.

    quality 80 es el sweet spot: ~30-40% del tamaño del PNG con diferencia
    visual imperceptible. quality 100 sería lossless (no necesario para
    web). method 6 da mejor compresión pero tarda más; en upload manual
    desde admin no importa.
    """
    if not (1 <= quality <= 100):
        raise ImageOptimizationError(f"quality debe estar entre 1 y 100, no {quality}")

    out = img
    # WebP no soporta modo P; convertir a RGB/RGBA según alpha
    if out.mode == "P":
        if "transparency" in out.info:
            out = out.convert("RGBA")
        else:
            out = out.convert("RGB")
    elif out.mode == "LA":
        out = out.convert("RGBA")
    elif out.mode == "L":
        out = out.convert("RGB")

    buf = io.BytesIO()
    out.save(buf, format="WEBP", quality=quality, method=method)
    return buf.getvalue()
