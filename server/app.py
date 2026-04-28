"""
Servidor Flask para procesar el formulario de contacto del frame "ixmppy"
y enviarlo por SMTP de Gmail.

Variables de entorno requeridas (defínelas en un archivo .env o exportalas):
  SMTP_HOST     -> smtp.gmail.com
  SMTP_PORT     -> 587 (TLS) o 465 (SSL)
  SMTP_MODE     -> "tls" o "ssl"
  SMTP_USER     -> rladron@gmail.com
  SMTP_PASSWORD -> Contraseña de aplicación (App Password de Google)
  MAIL_TO       -> destinatario(s) separados por coma
  MAIL_FROM     -> remitente (por lo general igual a SMTP_USER)
  ALLOWED_ORIGIN -> origen permitido para CORS (ej: http://localhost:8000)

Importante: Gmail YA NO acepta la contraseña normal de la cuenta.
Debes generar una "Contraseña de aplicación" en
https://myaccount.google.com/apppasswords (requiere verificación en 2 pasos).
"""

import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
CORS(app, resources={r"/api/*": {"origins": ALLOWED_ORIGIN}})


def send_email(payload: dict) -> None:
    """Construye el correo y lo envía vía SMTP de Gmail."""
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_mode = os.getenv("SMTP_MODE", "tls").lower()
    smtp_user = os.environ["SMTP_USER"]
    smtp_pass = os.environ["SMTP_PASSWORD"]
    mail_to = os.getenv("MAIL_TO", smtp_user)
    mail_from = os.getenv("MAIL_FROM", smtp_user)

    nombre = payload.get("nombre", "").strip()
    email = payload.get("email", "").strip()
    empresa = payload.get("empresa", "").strip()
    caso_uso = payload.get("caso_uso", "").strip()
    mensaje = payload.get("mensaje", "").strip()

    subject = f"[Monou.gg] Nueva solicitud de {nombre or 'sin nombre'}"
    body_text = (
        "Nueva solicitud recibida desde la landing de Monou.gg\n"
        "------------------------------------------------------\n"
        f"Nombre completo : {nombre}\n"
        f"Email corporativo: {email}\n"
        f"Empresa/Org.    : {empresa}\n"
        f"Caso de uso     : {caso_uso}\n"
        f"Mensaje         :\n{mensaje}\n"
    )

    body_html = f"""\
<html>
  <body style="font-family: Inter, Arial, sans-serif; color:#0B0E14;">
    <h2 style="color:#0d9488;">Nueva solicitud — Monou.gg</h2>
    <table cellpadding="6" style="border-collapse:collapse;">
      <tr><td><b>Nombre</b></td><td>{nombre}</td></tr>
      <tr><td><b>Email</b></td><td>{email}</td></tr>
      <tr><td><b>Empresa</b></td><td>{empresa}</td></tr>
      <tr><td><b>Caso de uso</b></td><td>{caso_uso}</td></tr>
    </table>
    <h3>Mensaje</h3>
    <p style="white-space:pre-wrap;">{mensaje}</p>
  </body>
</html>"""

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("Monou.gg Landing", mail_from))
    msg["To"] = mail_to
    if email:
        msg["Reply-To"] = email
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="monou.gg")
    msg.set_content(body_text)
    msg.add_alternative(body_html, subtype="html")

    context = ssl.create_default_context()

    if smtp_mode == "ssl" or smtp_port == 465:
        # Puerto 465 - SSL implícito
        with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context, timeout=20) as server:
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
    else:
        # Puerto 587 - STARTTLS
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)


@app.route("/api/contact", methods=["POST"])
def contact():
    data = request.get_json(silent=True) or request.form.to_dict()

    # Validación mínima
    required = ["nombre", "email"]
    missing = [f for f in required if not (data.get(f) or "").strip()]
    if missing:
        return jsonify({"ok": False, "error": f"Campos requeridos: {', '.join(missing)}"}), 400

    # Anti-bot: campo honeypot. Si viene relleno, fingimos éxito.
    if (data.get("website") or "").strip():
        return jsonify({"ok": True}), 200

    try:
        send_email(data)
    except smtplib.SMTPAuthenticationError:
        return jsonify({"ok": False, "error": "Autenticación SMTP fallida. Revisa SMTP_USER / App Password."}), 500
    except Exception as exc:
        app.logger.exception("Error enviando correo")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500

    return jsonify({"ok": True, "message": "Correo enviado"}), 200


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "monou-contact"}), 200


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
