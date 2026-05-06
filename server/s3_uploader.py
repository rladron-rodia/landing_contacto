"""
s3_uploader — wrapper de boto3 para upload a S3 con políticas estándar.

Uso desde el endpoint de upload:
    url = s3_uploader.upload(key, body, content_type="image/png")

Decisiones de diseño:
- Cliente boto3 lazy-init y cacheado en módulo. Render reusa el process,
  evita rehacer handshake TLS por cada request.
- Cache-Control "public, max-age=31536000, immutable" porque las URLs de
  imágenes incluyen un hash del contenido (immutable safe).
- Sin ACL en put_object — el bucket tiene Object Ownership = Bucket owner
  enforced (config moderna desde 2023), la visibilidad pública la maneja
  el bucket policy. Si pasáramos ACL="public-read" boto3 lanzaría
  AccessControlListNotSupported.
- Las credenciales se leen vía boto3 default chain (env vars > ~/.aws/credentials >
  IAM role). En Render quedan en env vars AWS_ACCESS_KEY_ID y AWS_SECRET_ACCESS_KEY
  como secrets.

Configuración esperada vía env vars:
    S3_BUCKET             — nombre del bucket destino (ej. monou-landing-images-prod)
    S3_REGION             — región AWS (ej. us-east-1)
    AWS_ACCESS_KEY_ID     — credencial del IAM user dedicado
    AWS_SECRET_ACCESS_KEY — credencial del IAM user dedicado
"""

import os
from typing import Optional

# boto3 es ~10 MB y solo se importa si el endpoint se invoca, para no inflar
# el cold start de Render con la dependencia si nadie usa upload.
_boto3 = None
_botocore_exc = None


def _lazy_imports():
    """Importa boto3 sólo cuando se necesita (lazy)."""
    global _boto3, _botocore_exc
    if _boto3 is None:
        import boto3 as _b
        from botocore.exceptions import ClientError, BotoCoreError
        _boto3 = _b
        _botocore_exc = (ClientError, BotoCoreError)
    return _boto3, _botocore_exc


class S3UploadError(Exception):
    """Falla en el upload a S3 (red, credenciales o permisos)."""
    pass


_s3_client = None


def _get_client():
    """Singleton del cliente boto3. Falla si no hay credenciales."""
    global _s3_client
    if _s3_client is None:
        boto3, _ = _lazy_imports()
        region = os.getenv("S3_REGION", "us-east-1")
        _s3_client = boto3.client("s3", region_name=region)
    return _s3_client


def upload(
    key: str,
    body: bytes,
    content_type: str,
    cache_max_age: int = 31536000,  # 1 año
    bucket: Optional[str] = None,
) -> str:
    """Sube bytes a S3 y devuelve la URL pública.

    Args:
        key: ruta dentro del bucket (ej. "games/aventure-a3b2c1.png")
        body: contenido raw
        content_type: ej. "image/png", "image/webp"
        cache_max_age: segundos de Cache-Control max-age
        bucket: nombre del bucket; si es None se lee de env S3_BUCKET

    Returns:
        URL pública del objeto subido.

    Raises:
        S3UploadError: si falta S3_BUCKET, falla la red, o falta permiso PUT.
    """
    bucket_name = bucket or os.getenv("S3_BUCKET", "")
    if not bucket_name:
        raise S3UploadError("S3_BUCKET no está configurado en env vars")

    region = os.getenv("S3_REGION", "us-east-1")
    _, exc_types = _lazy_imports()

    try:
        client = _get_client()
        client.put_object(
            Bucket=bucket_name,
            Key=key,
            Body=body,
            ContentType=content_type,
            CacheControl=f"public, max-age={cache_max_age}, immutable",
        )
    except exc_types as e:
        raise S3UploadError(f"S3 put_object falló: {e}")

    # URL pública directa. No usamos signed URLs porque las imágenes son
    # públicas (bucket policy lo permite).
    return f"https://{bucket_name}.s3.{region}.amazonaws.com/{key}"


def is_configured() -> bool:
    """Devuelve True si las env vars necesarias están seteadas."""
    return bool(
        os.getenv("S3_BUCKET")
        and os.getenv("AWS_ACCESS_KEY_ID")
        and os.getenv("AWS_SECRET_ACCESS_KEY")
    )
