"""
Servidor Flask para procesar el formulario de contacto de monoulabs.ai
y enviarlo vía AWS SES (boto3 + IAM instance role).

Stack 100% AWS-native desde v3.1.0. Migrado de Resend HTTP API a SES por
boto3 con auth via instance role del EC2 (sin secrets externos).

Variables de entorno:
  DATABASE_URL    -> Postgres connection string (RDS via Secrets Manager)
  ADMIN_TOKEN     -> Bearer para endpoints /api/admin/* (Secrets Manager)
  FLASK_SECRET_KEY-> firma signed tokens recovery + sesiones (Secrets Manager)
  MAIL_FROM       -> remitente, ej. "Monou Labs <noreply@monoulabs.ai>" (Param Store)
  MAIL_TO         -> destinatario(s) separados por coma (Param Store)
  ALLOWED_ORIGIN  -> CORS, "*" o lista separada por coma (Param Store)
  S3_BUCKET       -> bucket de imagenes (Param Store)
  S3_REGION       -> region del bucket (Param Store)
  EMAIL_PROVIDER  -> deprecated en v3.1.0 (era flag transitorio Resend↔SES)

AWS credentials: NO env vars — boto3 las toma del instance metadata via IMDSv2.

SES setup requerido (una vez):
  - Verificar dominio monoulabs.ai con DKIM (3 CNAMEs en Route 53)
  - Custom MAIL FROM domain send.monoulabs.ai (MX + SPF en R53)
  - IAM policy ses:SendEmail al EC2 role
"""

import os
import re
import html
import hmac
import hashlib
import socket
import json
import time
import base64
import secrets
import urllib.request
import urllib.error
from contextlib import contextmanager

from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv

import db  # módulo de persistencia (degrada a no-op si DATABASE_URL no está)
import image_optimizer  # procesamiento Pillow (lazy: solo carga si /upload-image se invoca)
import s3_uploader      # boto3 wrapper (lazy: solo carga si /upload-image se invoca)


# --------------------------------------------------------------------------
# Constantes de validación / hardening
# --------------------------------------------------------------------------

# Tamaño máximo del body aceptado por el servidor (defensa contra DoS de
# payloads gigantes).
#
# v2.7.0: subido de 64 KB a 16 MB para soportar /api/admin/upload-image
# (uploads de imágenes desde el admin). Trade-off: las otras rutas también
# aceptan body hasta 16 MB, pero:
#   - /api/contact valida cada campo vía FIELD_LIMITS (max 4 KB en mensaje),
#     un body grande se rechaza después de parsear JSON. No hay nuevo vector
#     de DoS porque el endpoint ya leía el body completo.
#   - /api/admin/* valida JSON y schemas de DB; bodies grandes fallan.
# El límite real efectivo de las rutas que NO son upload sigue siendo el
# implícito por validación. Si se quisiera per-route en el futuro, ver
# https://flask.palletsprojects.com/en/3.0.x/patterns/fileuploads/
MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB

# Longitudes máximas por campo (validación server-side, no confiar en el cliente)
FIELD_LIMITS = {
    "nombre":   200,
    "email":    320,    # límite RFC 5321 práctico
    "empresa":  200,
    "caso_uso": 200,
    "mensaje":  4000,
}

# Regex tolerante para email (no es RFC-perfecto, pero descarta basura obvia
# sin falsos positivos en correos reales).
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@contextmanager
def force_ipv4():
    """Filtra getaddrinfo a IPv4 solamente durante el bloque.

    Defensivo contra el problema histórico de IPv6 roto en algunos hosts
    de Render. Resend va por HTTPS pero por si acaso lo aplicamos también.
    """
    original = socket.getaddrinfo
    def _ipv4_only(*args, **kwargs):
        return [r for r in original(*args, **kwargs) if r[0] == socket.AF_INET]
    socket.getaddrinfo = _ipv4_only
    try:
        yield
    finally:
        socket.getaddrinfo = original


load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
_origins = [o.strip() for o in ALLOWED_ORIGIN.split(",")] if ALLOWED_ORIGIN != "*" else "*"
CORS(app, resources={r"/api/*": {"origins": _origins}}, supports_credentials=False)

# Rate limiting (defensa contra abuso del formulario / fuerza bruta del admin).
# Storage in-memory: las cuentas son por proceso de gunicorn. Con `-w 2` el
# límite efectivo es ~2x el configurado, lo cual sigue siendo muy útil. Para
# rate limiting estricto habría que migrar a Redis (ver SECURITY-TODO).
def _client_ip():
    """Resuelve la IP real respetando X-Forwarded-For (Render usa proxy)."""
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return get_remote_address()


limiter = Limiter(
    app=app,
    key_func=_client_ip,
    default_limits=["200 per hour"],
    headers_enabled=True,
    storage_uri="memory://",
)


# Devuelve 413 limpio si el body excede MAX_CONTENT_LENGTH (Flask lanza
# RequestEntityTooLarge antes incluso de leer el body).
@app.errorhandler(413)
def _payload_too_large(_e):
    return jsonify({"ok": False, "error": "payload demasiado grande"}), 413


@app.errorhandler(429)
def _rate_limited(_e):
    return jsonify({"ok": False, "error": "demasiadas solicitudes, intenta más tarde"}), 429


# Headers de seguridad mínimos en TODA respuesta de la API.
# La landing se sirve desde GitHub Pages (otro host), así que CSP no aplica
# acá; lo importante es que ningún navegador "snifee" los JSON como otra cosa,
# y que las respuestas con datos sensibles (admin) no se cacheen.
@app.after_request
def _security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    # No cachear respuestas de endpoints admin (contienen datos sensibles)
    if request.path.startswith("/api/admin") or request.path == "/api/contacts":
        resp.headers["Cache-Control"] = "no-store"
    return resp


# Inicializa el schema de la DB al boot (idempotente, no falla si no hay DB)
db.init_schema()


# --------------------------------------------------------------------------
# Errores específicos del envío de correo
# --------------------------------------------------------------------------

class EmailError(Exception):
    """Falla al enviar correo (genérico)."""


class EmailAuthError(EmailError):
    """API key rechazada por el proveedor."""


class EmailValidationError(EmailError):
    """El proveedor rechazó los datos del correo (ej. dominio no verificado,
    destinatario no permitido en plan free)."""


# --------------------------------------------------------------------------
# Envío de email vía AWS SES (boto3 + IAM instance role)
#
# Stack 100% AWS-native: las credenciales las toma boto3 automáticamente del
# instance metadata (IAM role del EC2). Necesita IAM policy `ses:SendEmail`
# sobre el identity ARN del dominio.
#
# Setup en SES (una vez):
#   - Verificar dominio monoulabs.ai con DKIM (3 CNAMEs en Route 53)
#   - Configurar custom MAIL FROM domain `send.monoulabs.ai` (MX + SPF en R53)
#   - Account fuera del sandbox (production access)
#
# Migración previa: este código reemplazó la integración con Resend HTTP API
# en v3.1.0 (ver CHANGELOG.md).
# --------------------------------------------------------------------------


def _email_routing() -> tuple:
    """Devuelve (mail_from, mail_to_list). Lanza si MAIL_TO está vacío."""
    mail_from = os.getenv("MAIL_FROM", "Monou Labs <noreply@monoulabs.ai>").strip()
    mail_to_raw = os.getenv("MAIL_TO", "")
    mail_to = [t.strip() for t in mail_to_raw.split(",") if t.strip()]
    if not mail_to:
        raise EmailError("MAIL_TO no está configurada")
    return mail_from, mail_to


def _send_via_ses(mail_from, mail_to, subject, body_text, body_html,
                  reply_to=None):
    """Envia via AWS SES usando boto3 + IAM instance role."""
    try:
        import boto3
        from botocore.exceptions import ClientError, BotoCoreError
    except ImportError:
        raise EmailError("boto3 no esta disponible para SES")

    region = os.getenv("AWS_DEFAULT_REGION",
                       os.getenv("AWS_REGION", "us-east-1"))
    ses = boto3.client("ses", region_name=region)

    kwargs = {
        "Source": mail_from,
        "Destination": {"ToAddresses": mail_to},
        "Message": {
            "Subject": {"Data": subject, "Charset": "UTF-8"},
            "Body": {
                "Text": {"Data": body_text, "Charset": "UTF-8"},
                "Html": {"Data": body_html, "Charset": "UTF-8"},
            },
        },
    }
    if reply_to:
        kwargs["ReplyToAddresses"] = [reply_to]

    try:
        response = ses.send_email(**kwargs)
        return {"id": response["MessageId"], "provider": "ses"}
    except ClientError as e:
        code = e.response["Error"].get("Code", "Unknown")
        msg = e.response["Error"].get("Message", str(e))
        if code == "MessageRejected":
            raise EmailValidationError(f"SES rechazo: {code}: {msg}")
        if code in ("AccessDenied", "SignatureDoesNotMatch",
                    "InvalidClientTokenId", "ExpiredToken"):
            raise EmailAuthError(f"SES auth fallida: {code}: {msg}")
        raise EmailError(f"SES error: {code}: {msg}")
    except BotoCoreError as e:
        raise EmailError(f"SES boto error: {e}")


def send_email(payload: dict) -> dict:
    """Envia email del contact form via AWS SES.

    Devuelve dict con 'id' del MessageId de SES y 'provider': 'ses'.
    Lanza EmailAuthError / EmailValidationError / EmailError según el caso.
    """
    mail_from, mail_to = _email_routing()

    nombre   = (payload.get("nombre")   or "").strip()
    email    = (payload.get("email")    or "").strip()
    empresa  = (payload.get("empresa")  or "").strip()
    caso_uso = (payload.get("caso_uso") or "").strip()
    mensaje  = (payload.get("mensaje")  or "").strip()

    # Escape HTML de TODO input antes de interpolarlo en body_html.
    # Sin esto, un atacante puede inyectar <script>, <img onerror=…>, o
    # encadenar tags que rompan el correo en el cliente del destinatario.
    e_nombre   = html.escape(nombre,   quote=True)
    e_email    = html.escape(email,    quote=True)
    e_empresa  = html.escape(empresa,  quote=True)
    e_caso_uso = html.escape(caso_uso, quote=True)
    e_mensaje  = html.escape(mensaje,  quote=True)

    # Subject: removemos saltos de línea para evitar header injection en SMTP.
    subj_name = re.sub(r"[\r\n]+", " ", nombre)[:120] or "sin nombre"
    subject = f"[Monou Labs] Nueva solicitud de {subj_name}"
    body_text = (
        "Nueva solicitud recibida desde la landing de Monou Labs\n"
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
    <h2 style="color:#0d9488;">Nueva solicitud — Monou Labs</h2>
    <table cellpadding="6" style="border-collapse:collapse;">
      <tr><td><b>Nombre</b></td><td>{e_nombre}</td></tr>
      <tr><td><b>Email</b></td><td>{e_email}</td></tr>
      <tr><td><b>Empresa</b></td><td>{e_empresa}</td></tr>
      <tr><td><b>Caso de uso</b></td><td>{e_caso_uso}</td></tr>
    </table>
    <h3>Mensaje</h3>
    <p style="white-space:pre-wrap;">{e_mensaje}</p>
  </body>
</html>"""

    # Sanitiza reply_to: sólo si tiene forma de email y no contiene CRLF.
    safe_reply = re.sub(r"[\r\n]+", "", email)
    reply_to = safe_reply if (safe_reply and EMAIL_RE.match(safe_reply)) else None

    return _send_via_ses(mail_from, mail_to, subject, body_text, body_html,
                         reply_to=reply_to)


# --------------------------------------------------------------------------
# Endpoints HTTP
# --------------------------------------------------------------------------

def _client_meta(req):
    """Extrae IP, user-agent y referer del request (respetando X-Forwarded-For)."""
    fwd = req.headers.get("X-Forwarded-For", "")
    ip = (fwd.split(",")[0].strip() if fwd else req.remote_addr) or None
    # Trunca user-agent y referer para no almacenar cadenas absurdamente largas
    ua = (req.headers.get("User-Agent") or "")[:500] or None
    ref = (req.headers.get("Referer") or "")[:500] or None
    return {"ip": ip, "user_agent": ua, "referer": ref}


def _validate_contact_payload(data: dict):
    """Valida campos del formulario. Devuelve (data_truncada, error_msg)."""
    if not isinstance(data, dict):
        return None, "payload inválido"

    required = ["nombre", "email"]
    missing = [f for f in required if not (data.get(f) or "").strip()]
    if missing:
        return None, f"Campos requeridos: {', '.join(missing)}"

    # Trunca cada campo a su límite (truncar es más amable que rechazar; al
    # mismo tiempo MAX_CONTENT_LENGTH ya bloqueó payloads abusivos).
    cleaned = {}
    for field, limit in FIELD_LIMITS.items():
        v = (data.get(field) or "")
        if not isinstance(v, str):
            return None, f"campo '{field}' debe ser texto"
        cleaned[field] = v.strip()[:limit]

    if not EMAIL_RE.match(cleaned["email"]):
        return None, "email inválido"

    # Honeypot pasa tal cual
    cleaned["website"] = (data.get("website") or "").strip()
    return cleaned, None


@app.route("/api/contact", methods=["POST"])
@limiter.limit("5 per minute; 30 per hour; 100 per day")
def contact():
    raw = request.get_json(silent=True) or request.form.to_dict()
    data, err = _validate_contact_payload(raw)
    if err:
        return jsonify({"ok": False, "error": err}), 400

    if data["website"]:
        # Honeypot lleno: fingimos éxito sin tocar nada (no logueamos al bot)
        return jsonify({"ok": True}), 200

    contact_id = db.insert_contact(data, _client_meta(request))

    try:
        send_email(data)
    except EmailAuthError:
        app.logger.error("Resend auth fallida (contact_id=%s)", contact_id)
        db.mark_status(contact_id, "failed", "auth")
        return jsonify({"ok": False, "error": "Autenticación con el proveedor de correo fallida."}), 500
    except EmailValidationError:
        app.logger.error("Resend validation rechazada (contact_id=%s)", contact_id)
        db.mark_status(contact_id, "failed", "validation")
        return jsonify({"ok": False, "error": "El proveedor rechazó el correo (verifica dominio o destinatario)."}), 500
    except EmailError as exc:
        # Sólo loguea la clase del error, no el mensaje (puede contener PII)
        app.logger.error("Resend error %s (contact_id=%s)", type(exc).__name__, contact_id)
        db.mark_status(contact_id, "failed", "send_error")
        return jsonify({"ok": False, "error": "No se pudo enviar el correo."}), 500
    except Exception:
        app.logger.exception("Error inesperado enviando correo (contact_id=%s)", contact_id)
        db.mark_status(contact_id, "failed", "internal")
        return jsonify({"ok": False, "error": "Error interno."}), 500

    db.mark_status(contact_id, "emailed")
    return jsonify({"ok": True, "message": "Correo enviado", "id": contact_id}), 200


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "service": "monou-contact",
        "db": db.is_enabled(),
        "email_provider": "ses",
    }), 200


def _is_admin(req) -> bool:
    """Valida el header Authorization Bearer contra ADMIN_TOKEN.

    Usa hmac.compare_digest para evitar timing attacks (la comparación de
    strings con `==` revela cuántos chars coinciden por la duración de la
    operación, lo que permite recuperar el token byte a byte).
    """
    token = os.getenv("ADMIN_TOKEN", "")
    if not token:
        return False
    auth = req.headers.get("Authorization", "")
    expected = f"Bearer {token}"
    # compare_digest necesita strings/bytes de igual tipo y maneja cualquier
    # longitud sin filtrar info por timing.
    return hmac.compare_digest(auth, expected)


def _unauthorized():
    return jsonify({"ok": False, "error": "unauthorized"}), 401


@app.route("/api/contacts", methods=["GET"])
def list_contacts():
    """Lista los últimos contactos. Protegido con Bearer token (ADMIN_TOKEN)."""
    if not _is_admin(request):
        return _unauthorized()
    try:
        limit = min(int(request.args.get("limit", 100)), 1000)
    except ValueError:
        limit = 100
    rows = db.list_contacts(limit=limit)
    for r in rows:
        if r.get("created_at"):
            r["created_at"] = r["created_at"].isoformat()
    return jsonify({"ok": True, "count": len(rows), "contacts": rows}), 200


# --------------------------------------------------------------------------
# Admin token recovery — magic link via email (público, rate-limited)
#
# Flujo:
#   1) Cliente hace POST /api/admin/request-token-recovery (sin auth)
#   2) Backend genera recovery_id firmado HMAC con FLASK_SECRET_KEY (15 min)
#   3) Backend envía email a MAIL_TO con link https://.../admin/?recover=<id>
#   4) Cliente abre el link → frontend hace POST /api/admin/exchange-recovery
#      con el recovery_id → backend valida y devuelve ADMIN_TOKEN
#   5) Frontend autollena el form y entra al admin
#
# El recovery_id es signed-stateless (no necesitamos DB ni state compartido).
# Se puede usar múltiples veces dentro de los 15 min — aceptable porque sólo
# llega via email a MAIL_TO.
# --------------------------------------------------------------------------

RECOVERY_EXPIRES_IN_SECONDS = 15 * 60


def _recovery_secret() -> bytes:
    """Devuelve FLASK_SECRET_KEY como bytes para HMAC."""
    secret = os.getenv("FLASK_SECRET_KEY", "").encode()
    if len(secret) < 16:
        raise RuntimeError(
            "FLASK_SECRET_KEY missing or shorter than 16 bytes — recovery disabled")
    return secret


def _generate_recovery_id(expires_in: int = RECOVERY_EXPIRES_IN_SECONDS) -> str:
    """Genera token firmado: base64url(payload + '.' + hmac_sha256(payload))."""
    expires_at = int(time.time()) + int(expires_in)
    nonce = secrets.token_urlsafe(16)
    payload = f"{expires_at}:{nonce}".encode("ascii")
    sig = hmac.new(_recovery_secret(), payload, hashlib.sha256).digest()
    raw = payload + b"." + sig
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _validate_recovery_id(token: str) -> tuple[bool, str]:
    """Devuelve (valid, error_code). error_code es '' si valid=True."""
    if not token or not isinstance(token, str):
        return False, "missing"
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception:
        return False, "malformed"
    if b"." not in raw:
        return False, "malformed"
    payload, sig = raw.rsplit(b".", 1)
    try:
        expected_sig = hmac.new(
            _recovery_secret(), payload, hashlib.sha256).digest()
    except RuntimeError:
        return False, "server_misconfigured"
    if not hmac.compare_digest(sig, expected_sig):
        return False, "bad_signature"
    try:
        expires_at_str, _nonce = payload.decode("ascii").split(":", 1)
        expires_at = int(expires_at_str)
    except Exception:
        return False, "malformed"
    if time.time() > expires_at:
        return False, "expired"
    return True, ""


def _send_simple_email(subject: str, body_text: str, body_html: str) -> dict:
    """Helper para emails non-contact-form (token recovery, alertas internas)."""
    mail_from, mail_to = _email_routing()
    return _send_via_ses(mail_from, mail_to, subject, body_text, body_html,
                         reply_to=None)


@app.route("/api/admin/request-token-recovery", methods=["POST"])
@limiter.limit("3 per hour; 1 per 5 minutes")
def request_token_recovery():
    """Genera recovery link y lo envía a MAIL_TO. Siempre retorna 200 (no leak)."""
    if not os.getenv("ADMIN_TOKEN") or not os.getenv("FLASK_SECRET_KEY"):
        app.logger.warning(
            "Recovery request received but ADMIN_TOKEN or FLASK_SECRET_KEY missing")
        return jsonify({
            "ok": True,
            "message": "Si la cuenta existe, recibirás un correo en breve."
        }), 200

    try:
        recovery_id = _generate_recovery_id()
    except RuntimeError as e:
        app.logger.error(f"Recovery generation failed: {e}")
        return jsonify({
            "ok": True,
            "message": "Si la cuenta existe, recibirás un correo en breve."
        }), 200

    # URL absoluta — usamos monoulabs.ai como host canónico de admin.
    recovery_url = f"https://monoulabs.ai/admin/?recover={recovery_id}"

    subject = "[Monou Labs] Recuperación de acceso al admin"
    body_text = (
        "Solicitaste recuperar tu acceso al admin de Monou Labs.\n\n"
        f"Haz click en este enlace en los próximos 15 minutos para acceder:\n"
        f"{recovery_url}\n\n"
        "Si no solicitaste esto, ignora este correo. "
        "El enlace expira en 15 minutos.\n"
    )
    body_html = f"""\
<html>
  <body style="font-family: Inter, Arial, sans-serif; color:#0B0E14;">
    <h2 style="color:#0d9488;">Recuperación de acceso — Monou Labs</h2>
    <p>Solicitaste recuperar tu acceso al admin.</p>
    <p style="margin: 24px 0;">
      <a href="{recovery_url}"
         style="background:#14b8a6;color:#fff;padding:12px 24px;
                text-decoration:none;border-radius:8px;display:inline-block;">
        Acceder al admin
      </a>
    </p>
    <p style="font-size:12px;color:#666;">
      El enlace expira en 15 minutos. Si no solicitaste esto, ignora este correo.
    </p>
    <p style="font-size:12px;color:#666;">
      Si el botón no funciona, copia y pega esta URL:<br>
      <code style="word-break:break-all;">{recovery_url}</code>
    </p>
  </body>
</html>"""

    try:
        _send_simple_email(subject, body_text, body_html)
    except EmailError as e:
        app.logger.error(f"Failed to send recovery email: {e}")
        # Aún así retornamos 200 para no leakear si MAIL_TO existe.

    return jsonify({
        "ok": True,
        "message": "Si la cuenta existe, recibirás un correo en breve."
    }), 200


@app.route("/api/admin/exchange-recovery", methods=["POST"])
@limiter.limit("10 per hour; 5 per 5 minutes")
def exchange_recovery():
    """Valida recovery_id y devuelve ADMIN_TOKEN para auto-login."""
    data = request.get_json(silent=True) or {}
    recovery_id = (data.get("recovery_id") or "").strip()

    valid, err = _validate_recovery_id(recovery_id)
    if not valid:
        return jsonify({"ok": False, "error": "invalid_or_expired"}), 401

    token = os.getenv("ADMIN_TOKEN", "")
    if not token:
        return jsonify({"ok": False, "error": "admin_not_configured"}), 500

    return jsonify({"ok": True, "admin_token": token}), 200


# ---------------------------------------------------------------------------
# Stats — endpoint público (lo consume la landing) y admin CRUD
# ---------------------------------------------------------------------------

@app.route("/api/stats", methods=["GET"])
def get_stats():
    """Devuelve las stats activas para la landing. Público, sin auth."""
    rows = db.list_stats(include_meta=False)
    return jsonify({"ok": True, "stats": rows}), 200


@app.route("/api/admin/stats", methods=["GET"])
def admin_list_stats():
    """Lista stats con metadatos (display_order, updated_at) para el admin."""
    if not _is_admin(request):
        return _unauthorized()
    return jsonify({"ok": True, "stats": db.list_stats(include_meta=True)}), 200


@app.route("/api/admin/stats", methods=["POST"])
def admin_upsert_stat():
    """Crea o actualiza un stat. Body JSON: {key, value, label_es?, label_en?, display_order?}."""
    if not _is_admin(request):
        return _unauthorized()
    data = request.get_json(silent=True) or {}
    try:
        row = db.upsert_stat(data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("Error guardando stat")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    return jsonify({"ok": True, "stat": row}), 200


@app.route("/api/admin/stats/<key>", methods=["DELETE"])
def admin_delete_stat(key):
    """Borra un stat por key."""
    if not _is_admin(request):
        return _unauthorized()
    try:
        deleted = db.delete_stat(key)
    except Exception as exc:
        app.logger.exception("Error borrando stat")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    if not deleted:
        return jsonify({"ok": False, "error": "not found"}), 404
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Games (carrusel F2P) — endpoint público y admin CRUD
# ---------------------------------------------------------------------------

@app.route("/api/games", methods=["GET"])
def get_games():
    """Devuelve la lista de juegos para la landing. Público, sin auth.
    Acepta ?category=f2p|publishers (omitido = todos)."""
    category = request.args.get("category")
    return jsonify({"ok": True, "games": db.list_games(include_meta=False, category=category)}), 200


@app.route("/api/admin/games", methods=["GET"])
def admin_list_games():
    """Lista games con metadatos para el admin. Acepta ?category=..."""
    if not _is_admin(request):
        return _unauthorized()
    category = request.args.get("category")
    return jsonify({"ok": True, "games": db.list_games(include_meta=True, category=category)}), 200


@app.route("/api/admin/games", methods=["POST"])
def admin_upsert_game():
    """Crea o actualiza un juego."""
    if not _is_admin(request):
        return _unauthorized()
    data = request.get_json(silent=True) or {}
    try:
        row = db.upsert_game(data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("Error guardando game")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    return jsonify({"ok": True, "game": row}), 200


@app.route("/api/admin/games/<slug>", methods=["DELETE"])
def admin_delete_game(slug):
    """Borra un juego por slug."""
    if not _is_admin(request):
        return _unauthorized()
    try:
        deleted = db.delete_game(slug)
    except Exception as exc:
        app.logger.exception("Error borrando game")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    if not deleted:
        return jsonify({"ok": False, "error": "not found"}), 404
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Site links — endpoint público y admin CRUD
# ---------------------------------------------------------------------------

@app.route("/api/site-links", methods=["GET"])
def get_site_links():
    """Devuelve los enlaces/imágenes configurables del sitio. Público."""
    return jsonify({"ok": True, "links": db.list_site_links(include_meta=False)}), 200


@app.route("/api/admin/site-links", methods=["GET"])
def admin_list_site_links():
    """Lista site_links con metadatos para el admin."""
    if not _is_admin(request):
        return _unauthorized()
    return jsonify({"ok": True, "links": db.list_site_links(include_meta=True)}), 200


@app.route("/api/admin/site-links", methods=["POST"])
def admin_upsert_site_link():
    """Crea o actualiza un site_link."""
    if not _is_admin(request):
        return _unauthorized()
    data = request.get_json(silent=True) or {}
    try:
        row = db.upsert_site_link(data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("Error guardando site_link")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    return jsonify({"ok": True, "link": row}), 200


@app.route("/api/admin/site-links/<key>", methods=["DELETE"])
def admin_delete_site_link(key):
    """Borra un site_link por key."""
    if not _is_admin(request):
        return _unauthorized()
    try:
        deleted = db.delete_site_link(key)
    except Exception as exc:
        app.logger.exception("Error borrando site_link")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    if not deleted:
        return jsonify({"ok": False, "error": "not found"}), 404
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Delivery options (Data Formats + Delivery Methods)
# ---------------------------------------------------------------------------

@app.route("/api/delivery-options", methods=["GET"])
def get_delivery_options():
    """Lista las opciones de entrega para la landing. Público.
    Acepta ?category=data_formats|delivery_methods (omitido = todas)."""
    category = request.args.get("category")
    return jsonify({"ok": True, "options": db.list_delivery_options(include_meta=False, category=category)}), 200


@app.route("/api/admin/delivery-options", methods=["GET"])
def admin_list_delivery_options():
    if not _is_admin(request):
        return _unauthorized()
    category = request.args.get("category")
    return jsonify({"ok": True, "options": db.list_delivery_options(include_meta=True, category=category)}), 200


@app.route("/api/admin/delivery-options", methods=["POST"])
def admin_upsert_delivery_option():
    if not _is_admin(request):
        return _unauthorized()
    data = request.get_json(silent=True) or {}
    try:
        row = db.upsert_delivery_option(data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("Error guardando delivery_option")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    return jsonify({"ok": True, "option": row}), 200


@app.route("/api/admin/delivery-options/<slug>", methods=["DELETE"])
def admin_delete_delivery_option(slug):
    if not _is_admin(request):
        return _unauthorized()
    try:
        deleted = db.delete_delivery_option(slug)
    except Exception as exc:
        app.logger.exception("Error borrando delivery_option")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    if not deleted:
        return jsonify({"ok": False, "error": "not found"}), 404
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Info columns (Visual Capture / Available Metadata / Current Volume)
# ---------------------------------------------------------------------------

@app.route("/api/info-columns", methods=["GET"])
def get_info_columns():
    """Lista las columnas info para la landing. Público."""
    return jsonify({"ok": True, "columns": db.list_info_columns(include_meta=False)}), 200


@app.route("/api/admin/info-columns", methods=["GET"])
def admin_list_info_columns():
    if not _is_admin(request):
        return _unauthorized()
    return jsonify({"ok": True, "columns": db.list_info_columns(include_meta=True)}), 200


@app.route("/api/admin/info-columns", methods=["POST"])
def admin_upsert_info_column():
    if not _is_admin(request):
        return _unauthorized()
    data = request.get_json(silent=True) or {}
    try:
        row = db.upsert_info_column(data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("Error guardando info_column")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    return jsonify({"ok": True, "column": row}), 200


@app.route("/api/admin/info-columns/<slug>", methods=["DELETE"])
def admin_delete_info_column(slug):
    if not _is_admin(request):
        return _unauthorized()
    try:
        deleted = db.delete_info_column(slug)
    except Exception as exc:
        app.logger.exception("Error borrando info_column")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    if not deleted:
        return jsonify({"ok": False, "error": "not found"}), 404
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# v2.2.0 — Analytics config (GA4 + GTM) y CTA tags
# ---------------------------------------------------------------------------

@app.route("/api/analytics-config", methods=["GET"])
def get_analytics_config_public():
    """Config pública para que el loader del cliente sepa qué cargar.
    Solo retorna lo necesario para el frontend (NO retorna metadata sensible)."""
    cfg = db.get_analytics_config()
    return jsonify({
        "ok": True,
        "config": {
            "ga4_measurement_id": cfg.get("ga4_measurement_id") if cfg.get("ga4_enabled") else None,
            "ga4_enabled":        bool(cfg.get("ga4_enabled")),
            "gtm_container_id":   cfg.get("gtm_container_id") if cfg.get("gtm_enabled") else None,
            "gtm_enabled":        bool(cfg.get("gtm_enabled")),
        },
    }), 200


@app.route("/api/admin/analytics-config", methods=["GET"])
def admin_get_analytics_config():
    if not _is_admin(request):
        return _unauthorized()
    return jsonify({"ok": True, "config": db.get_analytics_config()}), 200


@app.route("/api/admin/analytics-config", methods=["POST"])
def admin_upsert_analytics_config():
    if not _is_admin(request):
        return _unauthorized()
    data = request.get_json(silent=True) or {}
    try:
        row = db.upsert_analytics_config(data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("Error guardando analytics_config")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    return jsonify({"ok": True, "config": row}), 200


@app.route("/api/cta-tags", methods=["GET"])
def get_cta_tags():
    """Lista pública de CTA tags activos para que el loader los bindee."""
    return jsonify({"ok": True, "tags": db.list_cta_tags(include_meta=False, only_enabled=True)}), 200


@app.route("/api/admin/cta-tags", methods=["GET"])
def admin_list_cta_tags():
    if not _is_admin(request):
        return _unauthorized()
    return jsonify({"ok": True, "tags": db.list_cta_tags(include_meta=True, only_enabled=False)}), 200


@app.route("/api/admin/cta-tags", methods=["POST"])
def admin_upsert_cta_tag():
    if not _is_admin(request):
        return _unauthorized()
    data = request.get_json(silent=True) or {}
    try:
        row = db.upsert_cta_tag(data)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("Error guardando cta_tag")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    return jsonify({"ok": True, "tag": row}), 200


@app.route("/api/admin/cta-tags/<cta_key>", methods=["DELETE"])
def admin_delete_cta_tag(cta_key):
    if not _is_admin(request):
        return _unauthorized()
    try:
        deleted = db.delete_cta_tag(cta_key)
    except Exception as exc:
        app.logger.exception("Error borrando cta_tag")
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500
    if not deleted:
        return jsonify({"ok": False, "error": "not found"}), 404
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Image upload — admin sube imágenes que se optimizan y suben a S3 (v2.7.0)
#
# Flujo:
#   1. Admin POST con multipart/form-data, campo `file`
#   2. Backend valida (formato, tamaño, dimensiones)
#   3. Optimiza con Pillow:
#        - Resize a max_w x max_h (default 800x600)
#        - Genera PNG optimizado (lossless, fallback)
#        - Genera WebP quality 80 (~30% del peso del PNG)
#   4. Sube ambos al bucket S3 dedicado (monou-landing-images-prod)
#   5. Devuelve las dos URLs públicas para que el frontend use <picture>
#
# Seguridad:
#   - Auth: Bearer ADMIN_TOKEN (mismo que el resto de /api/admin/*)
#   - Rate limit: hereda el default de 200/hour por IP del Limiter global
#   - File size: enforced por MAX_CONTENT_LENGTH (16 MB) + image_optimizer
#   - Format check: magic bytes vía Pillow (no confiamos en filename ext)
#   - S3 key: incluye hash SHA-256 del contenido → idempotente y unguessable
# ---------------------------------------------------------------------------

# Slugs válidos en la URL key de S3. Limita a chars seguros y URL-friendly.
_SLUG_CLEAN_RE = re.compile(r"[^a-z0-9-]+")
_VALID_FOLDERS = {"games", "site-links", "uploads"}  # whitelist de carpetas en S3


@app.route("/api/admin/upload-image", methods=["POST"])
@limiter.limit("30 per hour")  # más estricto que el default por costo S3
def admin_upload_image():
    """Sube una imagen, la optimiza, y devuelve URLs PNG + WebP en S3.

    Multipart form fields:
        file (required) — el archivo de imagen

    Query params (todos opcionales):
        folder=games|site-links|uploads — carpeta destino en S3 (default: uploads)
        slug=<slug-base>                — base del nombre (default: "image")
        max_w=<int>                     — bounding box ancho (default: 800)
        max_h=<int>                     — bounding box alto (default: 600)
        quality=<int>                   — calidad WebP 1-100 (default: 80)

    Response 200:
        {
          "ok": true,
          "png_url":       "https://...amazonaws.com/games/aventure-a3b2c1d4.png",
          "webp_url":      "https://...amazonaws.com/games/aventure-a3b2c1d4.webp",
          "original_size": 2073856,
          "png_size":      156432,
          "webp_size":     48372,
          "dimensions":    [800, 450]
        }

    Response 400 / 401 / 500:
        { "ok": false, "error": "..." }
    """
    if not _is_admin(request):
        return _unauthorized()

    # Sanity check: si las env vars de S3 no están seteadas, devolvemos error
    # claro en vez de fallar con stack trace de boto3.
    if not s3_uploader.is_configured():
        return jsonify({
            "ok": False,
            "error": "S3 no configurado: faltan env vars S3_BUCKET, AWS_ACCESS_KEY_ID o AWS_SECRET_ACCESS_KEY",
        }), 500

    # 1. Validar que viene un archivo
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"ok": False, "error": "campo 'file' faltante o vacío"}), 400

    raw = f.read()
    original_size = len(raw)

    # 2. Parsear query params con defaults sensatos
    folder = request.args.get("folder", "uploads").strip().lower()
    if folder not in _VALID_FOLDERS:
        return jsonify({
            "ok": False,
            "error": f"folder inválido: {folder!r} (permitidos: {sorted(_VALID_FOLDERS)})",
        }), 400

    slug_raw = (request.args.get("slug", "image") or "image").strip().lower()
    slug = _SLUG_CLEAN_RE.sub("-", slug_raw).strip("-")[:50] or "image"

    try:
        max_w = int(request.args.get("max_w", 800))
        max_h = int(request.args.get("max_h", 600))
        quality = int(request.args.get("quality", image_optimizer.DEFAULT_WEBP_QUALITY))
    except ValueError:
        return jsonify({"ok": False, "error": "max_w/max_h/quality deben ser enteros"}), 400

    if not (16 <= max_w <= 4000) or not (16 <= max_h <= 4000):
        return jsonify({
            "ok": False,
            "error": "max_w y max_h deben estar entre 16 y 4000",
        }), 400

    # 3. Validar y procesar la imagen
    try:
        img = image_optimizer.validate_and_load(raw)
        img_resized = image_optimizer.resize_to_bbox(img, max_w, max_h)
        png_bytes = image_optimizer.encode_png(img_resized)
        webp_bytes = image_optimizer.encode_webp(img_resized, quality=quality)
    except image_optimizer.ImageOptimizationError as exc:
        # Log con detalle (admin lo ve en Render logs) pero respuesta genérica
        # para evitar exposición de detalles internos via CodeQL "Information
        # exposure through an exception".
        app.logger.warning("Falló validación/optimización de imagen: %s", exc)
        return jsonify({
            "ok": False,
            "error": "imagen inválida o no procesable (revisa formato, tamaño y dimensiones)",
        }), 400
    except Exception:
        app.logger.exception("Error inesperado procesando imagen")
        return jsonify({"ok": False, "error": "error interno procesando imagen"}), 500

    # 4. Generar key S3 con hash del contenido (idempotente)
    content_hash = hashlib.sha256(png_bytes).hexdigest()[:8]
    base_key = f"{folder}/{slug}-{content_hash}"
    png_key = f"{base_key}.png"
    webp_key = f"{base_key}.webp"

    # 5. Subir a S3 (PNG primero; si falla, no subimos el WebP)
    try:
        png_url = s3_uploader.upload(png_key, png_bytes, "image/png")
        webp_url = s3_uploader.upload(webp_key, webp_bytes, "image/webp")
    except s3_uploader.S3UploadError as exc:
        # exception() captura traceback completo en Render logs.
        # Respuesta genérica al cliente para no exponer detalles internos
        # (CodeQL: "Information exposure through an exception").
        app.logger.exception("Falló upload a S3: %s", exc)
        return jsonify({
            "ok": False,
            "error": "upload a S3 falló (revisa logs del backend)",
        }), 502
    except Exception:
        app.logger.exception("Error inesperado subiendo a S3")
        return jsonify({"ok": False, "error": "error interno subiendo a S3"}), 500

    return jsonify({
        "ok": True,
        "png_url": png_url,
        "webp_url": webp_url,
        "original_size": original_size,
        "png_size": len(png_bytes),
        "webp_size": len(webp_bytes),
        "dimensions": [img_resized.width, img_resized.height],
        "reduction_pct": round(
            (1 - (len(png_bytes) + len(webp_bytes)) / (2 * original_size)) * 100, 1
        ) if original_size else 0,
    }), 200


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
