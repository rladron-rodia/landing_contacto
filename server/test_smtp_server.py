"""
Servidor SMTP de prueba que escucha en localhost:1025, acepta cualquier
auth/STARTTLS y muestra por consola los correos recibidos. Solo para uso
local — nunca en producción.
"""
import asyncio
import ssl
import os
import tempfile
import subprocess
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword


class PrintHandler:
    async def handle_DATA(self, server, session, envelope):
        print("\n" + "=" * 60)
        print(f"  Correo recibido | mailfrom={envelope.mail_from}")
        print(f"                  | rcpttos={envelope.rcpt_tos}")
        print("=" * 60)
        print(envelope.content.decode("utf8", errors="replace"))
        print("=" * 60 + "\n")
        return "250 Message accepted"


def authenticator(server, session, envelope, mechanism, auth_data):
    # Acepta cualquier credencial — solo para test
    if isinstance(auth_data, LoginPassword):
        print(f"[auth] mechanism={mechanism} login={auth_data.login.decode()}")
    return AuthResult(success=True)


def make_self_signed_cert():
    """Genera un cert autofirmado en /tmp para STARTTLS."""
    crt = "/tmp/smtp_test.crt"
    key = "/tmp/smtp_test.key"
    if not (os.path.exists(crt) and os.path.exists(key)):
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048",
                "-keyout", key, "-out", crt,
                "-days", "1", "-nodes", "-subj", "/CN=localhost",
            ],
            check=True, capture_output=True,
        )
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(crt, key)
    return ctx


def main():
    tls_ctx = make_self_signed_cert()
    controller = Controller(
        PrintHandler(),
        hostname="127.0.0.1",
        port=1025,
        authenticator=authenticator,
        auth_required=True,
        auth_require_tls=True,
        tls_context=tls_ctx,
    )
    controller.start()
    print(">> Test SMTP server listening on 127.0.0.1:1025 (STARTTLS, AUTH=any)")
    try:
        asyncio.get_event_loop().run_forever()
    except KeyboardInterrupt:
        controller.stop()


if __name__ == "__main__":
    main()
