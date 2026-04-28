"""
Prueba sin red: ejercita el flujo completo del backend simulando una petición
HTTP al endpoint /api/contact, pero parcheando urllib.request para que NO
conecte a Resend. Imprime el cuerpo JSON exacto que se habría enviado.
"""
import os
import sys
import json
from unittest.mock import patch, MagicMock

# Variables de entorno mínimas para que app.py arranque
os.environ.setdefault("RESEND_API_KEY", "re_test_fake_key_for_dry_run")
os.environ.setdefault("MAIL_TO", "rladron@gmail.com")
os.environ.setdefault("MAIL_FROM", "Monou.gg Landing <onboarding@resend.dev>")

import app  # importa nuestro Flask app

PAYLOAD = {
    "nombre": "Rodrigo Ladron",
    "email": "rladron@gmail.com",
    "empresa": "Monou.gg",
    "caso_uso": "world-models",
    "mensaje": "Quiero datasets de gameplay para entrenar un world model.",
}


def main():
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
    print(" Resultado del endpoint")
    print("=" * 60)
    print(f"Status:  {rv.status_code}")
    print(f"JSON:    {rv.get_json()}")
    print()
    print("=" * 60)
    print(" Petición HTTP capturada hacia Resend")
    print("=" * 60)
    print(f"URL          : {captured.get('url')}")
    print(f"Method       : {captured.get('method')}")
    print(f"Auth header  : {captured.get('headers', {}).get('Authorization', '')[:25]}...")
    print(f"Content-Type : {captured.get('headers', {}).get('Content-type')}")
    print(f"Timeout      : {captured.get('timeout')}s")
    print()
    print("=" * 60)
    print(" Cuerpo JSON enviado a Resend")
    print("=" * 60)
    body = captured.get("body")
    if body is None:
        print("(no se envió body — revisa errores arriba)")
        sys.exit(1)
    print(json.dumps(body, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
