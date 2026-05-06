"""
Prueba sin red: ejercita el flujo completo del backend simulando peticiones
HTTP, pero parcheando las dependencias externas (Resend HTTP, S3 boto3) para
que NO se conecten. Imprime resultados detallados.

Cubre:
  1. /api/contact          — flujo completo (form -> Resend mock)
  2. /api/admin/upload-image — flujo completo (multipart -> Pillow -> S3 mock)

Correr con: python3 test_dry_run.py
"""
import os
import sys
import io
import json
from unittest.mock import patch, MagicMock

# Variables de entorno mínimas para que app.py arranque
os.environ.setdefault("RESEND_API_KEY", "re_test_fake_key_for_dry_run")
os.environ.setdefault("MAIL_TO", "rladron@gmail.com")
os.environ.setdefault("MAIL_FROM", "Monou.gg Landing <onboarding@resend.dev>")
os.environ.setdefault("ADMIN_TOKEN", "test-admin-token-dry-run")
os.environ.setdefault("S3_BUCKET", "test-bucket-dry-run")
os.environ.setdefault("S3_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "AKIATEST")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "secret-test")

import app  # importa nuestro Flask app

PAYLOAD = {
    "nombre": "Rodrigo Ladron",
    "email": "rladron@gmail.com",
    "empresa": "Monou.gg",
    "caso_uso": "world-models",
    "mensaje": "Quiero datasets de gameplay para entrenar un world model.",
}


def test_contact_form():
    """Suite 1: /api/contact dispara petición a Resend con el cuerpo correcto."""
    captured = {}

    class FakeResponse:
        def __init__(self, body=b'{"id":"fake-message-id-12345"}', code=200):
            self._body = body
            self.code = code
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def read(self): return self._body

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["headers"] = dict(req.header_items())
        captured["body"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        return FakeResponse()

    client = app.app.test_client()
    with patch("urllib.request.urlopen", fake_urlopen):
        rv = client.post("/api/contact", json=PAYLOAD)

    print("=" * 60)
    print(" Suite 1 — /api/contact (form → Resend mocked)")
    print("=" * 60)
    print(f"Status:  {rv.status_code}")
    print(f"JSON:    {rv.get_json()}")
    print()
    print("Petición HTTP capturada hacia Resend:")
    print(f"  URL          : {captured.get('url')}")
    print(f"  Method       : {captured.get('method')}")
    print(f"  Auth header  : {captured.get('headers', {}).get('Authorization', '')[:25]}...")
    print(f"  Content-Type : {captured.get('headers', {}).get('Content-type')}")
    print(f"  Timeout      : {captured.get('timeout')}s")
    body = captured.get("body")
    if body is None:
        print("  (no se envió body — revisa errores arriba)")
        return False
    print(f"  Body subject : {body.get('subject', '')[:50]}")
    print(f"  Body to      : {body.get('to')}")
    return rv.status_code == 200


def _make_test_png(width=1200, height=900):
    """Genera un PNG de prueba en memoria (gradiente RGB)."""
    from PIL import Image
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    for x in range(width):
        for y in range(height):
            pixels[x, y] = (x % 256, y % 256, (x + y) % 256)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)  # PNG sin optimizar = más grande
    return buf.getvalue()


def test_upload_image_unauthorized():
    """Suite 2.1: /api/admin/upload-image rechaza sin Bearer token."""
    print("=" * 60)
    print(" Suite 2.1 — upload sin auth → 401")
    print("=" * 60)
    client = app.app.test_client()
    rv = client.post("/api/admin/upload-image",
                     data={"file": (io.BytesIO(b"fake"), "test.png")},
                     content_type="multipart/form-data")
    print(f"Status: {rv.status_code} (esperado 401)")
    print(f"Body:   {rv.get_json()}")
    return rv.status_code == 401


def test_upload_image_no_file():
    """Suite 2.2: /api/admin/upload-image rechaza sin campo 'file'."""
    print("=" * 60)
    print(" Suite 2.2 — upload sin file → 400")
    print("=" * 60)
    client = app.app.test_client()
    rv = client.post("/api/admin/upload-image",
                     headers={"Authorization": "Bearer test-admin-token-dry-run"})
    print(f"Status: {rv.status_code} (esperado 400)")
    print(f"Body:   {rv.get_json()}")
    return rv.status_code == 400


def test_upload_image_invalid_format():
    """Suite 2.3: /api/admin/upload-image rechaza archivo que no es imagen."""
    print("=" * 60)
    print(" Suite 2.3 — upload de texto (no imagen) → 400")
    print("=" * 60)
    client = app.app.test_client()
    rv = client.post("/api/admin/upload-image",
                     headers={"Authorization": "Bearer test-admin-token-dry-run"},
                     data={"file": (io.BytesIO(b"not an image, just text"), "fake.txt")},
                     content_type="multipart/form-data")
    print(f"Status: {rv.status_code} (esperado 400)")
    print(f"Body:   {rv.get_json()}")
    return rv.status_code == 400


def test_upload_image_happy_path():
    """Suite 2.4: /api/admin/upload-image procesa PNG real y mockea S3 boto3."""
    print("=" * 60)
    print(" Suite 2.4 — upload PNG real, S3 mocked")
    print("=" * 60)

    captured_uploads = []

    class FakeS3Client:
        def put_object(self, **kwargs):
            captured_uploads.append({
                "Bucket": kwargs["Bucket"],
                "Key": kwargs["Key"],
                "ContentType": kwargs["ContentType"],
                "BodyLen": len(kwargs["Body"]),
                "CacheControl": kwargs["CacheControl"],
            })
            return {}

    # Genera un PNG de 1200x900 (~1 MB no optimizado)
    png_bytes = _make_test_png(1200, 900)
    print(f"PNG de entrada: {len(png_bytes):,} bytes ({len(png_bytes)/1024:.1f} KB)")

    client = app.app.test_client()
    with patch("s3_uploader._get_client", return_value=FakeS3Client()):
        rv = client.post(
            "/api/admin/upload-image?folder=games&slug=test-aventure&max_w=800&max_h=450",
            headers={"Authorization": "Bearer test-admin-token-dry-run"},
            data={"file": (io.BytesIO(png_bytes), "aventure.png")},
            content_type="multipart/form-data",
        )

    print(f"Status: {rv.status_code} (esperado 200)")
    body = rv.get_json()
    if body and body.get("ok"):
        print(f"  png_url        : {body['png_url']}")
        print(f"  webp_url       : {body['webp_url']}")
        print(f"  original_size  : {body['original_size']:,} bytes")
        print(f"  png_size       : {body['png_size']:,} bytes")
        print(f"  webp_size      : {body['webp_size']:,} bytes")
        print(f"  dimensions     : {body['dimensions']}")
        print(f"  reduction_pct  : {body['reduction_pct']}%")
    else:
        print(f"  Body: {body}")

    print(f"\nUploads capturados a S3 (mock): {len(captured_uploads)}")
    for u in captured_uploads:
        print(f"  - s3://{u['Bucket']}/{u['Key']}")
        print(f"    Content-Type: {u['ContentType']}, body: {u['BodyLen']:,} bytes")
        print(f"    Cache-Control: {u['CacheControl']}")

    return (
        rv.status_code == 200
        and body is not None
        and body.get("ok") is True
        and len(captured_uploads) == 2
        and any(u["Key"].endswith(".png") for u in captured_uploads)
        and any(u["Key"].endswith(".webp") for u in captured_uploads)
    )


def main():
    results = []
    print()
    results.append(("contact form", test_contact_form()))
    print()
    results.append(("upload no auth", test_upload_image_unauthorized()))
    print()
    results.append(("upload no file", test_upload_image_no_file()))
    print()
    results.append(("upload invalid", test_upload_image_invalid_format()))
    print()
    results.append(("upload happy", test_upload_image_happy_path()))
    print()

    print("=" * 60)
    print(" Resumen")
    print("=" * 60)
    failed = 0
    for name, ok in results:
        status = "OK  " if ok else "FAIL"
        print(f"  [{status}] {name}")
        if not ok:
            failed += 1
    print()
    if failed:
        print(f"✗ {failed} test(s) fallaron")
        sys.exit(1)
    else:
        print("✓ Todos los tests pasaron")


if __name__ == "__main__":
    main()
