"""
Prueba sin red: ejercita el flujo completo del backend simulando una petición
HTTP al endpoint /api/contact, pero parcheando smtplib para que NO conecte.
Imprime el correo MIME completo que se habría enviado.
"""
import os
import sys
from unittest.mock import patch, MagicMock

# Variables de entorno mínimas para que app.py arranque
os.environ.setdefault("SMTP_USER", "rladron@gmail.com")
os.environ.setdefault("SMTP_PASSWORD", "fake-app-password")
os.environ.setdefault("MAIL_TO", "rodrigo.ladron@monou.gg")
os.environ.setdefault("MAIL_FROM", "rladron@gmail.com")

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

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            captured["host"] = host
            captured["port"] = port
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def ehlo(self): pass
        def starttls(self, context=None): captured["starttls"] = True
        def login(self, user, password):
            captured["login_user"] = user
            captured["login_password_len"] = len(password)
        def send_message(self, msg):
            captured["msg"] = msg

    client = app.app.test_client()
    with patch("smtplib.SMTP", FakeSMTP):
        rv = client.post("/api/contact", json=PAYLOAD)

    print("=" * 60)
    print(" Resultado del endpoint")
    print("=" * 60)
    print(f"Status:  {rv.status_code}")
    print(f"JSON:    {rv.get_json()}")
    print()
    print("=" * 60)
    print(" Conexión SMTP capturada")
    print("=" * 60)
    print(f"host          : {captured.get('host')}")
    print(f"port          : {captured.get('port')}")
    print(f"starttls      : {captured.get('starttls')}")
    print(f"login_user    : {captured.get('login_user')}")
    print(f"password_len  : {captured.get('login_password_len')} chars")
    print()
    print("=" * 60)
    print(" Email MIME que se enviará a Gmail (con creds reales)")
    print("=" * 60)
    msg = captured.get("msg")
    if msg is None:
        print("(no se construyó el mensaje — revisa errores arriba)")
        sys.exit(1)
    print(msg.as_string())


if __name__ == "__main__":
    main()
