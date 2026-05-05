"""
Servidor Flask para procesar el formulario de contacto del frame "ixmppy"
y enviarlo vía la API HTTP de Resend (https://resend.com).

Por qué Resend en lugar de SMTP de Gmail:
  Render free tier bloquea outbound SMTP (puertos 25/465/587 → timeout).
  Resend va por HTTPS (puerto 443), que nunca se filtra.

Variables de entorno:
  RESEND_API_KEY  -> API key generada en https://resend.com/api-keys
  MAIL_FROM       -> remitente. Ejemplos:
                       "Monou.gg Landing <onboarding@resend.dev>"  (default sin verificar dominio)
                       "Monou.gg <contacto@monou.gg>"              (requiere monou.gg verificado en Resend)
  MAIL_TO         -> destinatario(s) separados por coma
  ALLOWED_ORIGIN  -> CORS, "*" o lista separada por coma
  DATABASE_URL    -> Postgres (opcional; si falta, no se guardan contactos)
  ADMIN_TOKEN     -> token Bearer para listar contactos vía /api/contacts

Limitación del plan free de Resend SIN dominio verificado:
  - From debe ser onboarding@resend.dev (no puedes usar tu propio dominio)
  - Solo puedes enviar TO el email con el que registraste la cuenta de Resend
  Para producción real: verifica monou.gg en https://resend.com/domains y
  cambia MAIL_FROM a contacto@monou.gg (o el alias que prefieras).
"""

import os
import re
import html
import hmac
import socket
import json
import urllib.request
import urllib.error
from contextlib import contextmanager

from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv

import db  # módulo de persistencia (degrada a no-op si DATABASE_URL no está)


# --------------------------------------------------------------------------
# Constantes de validación / hardening
# --------------------------------------------------------------------------

# Tamaño máximo del body aceptado por el servidor (defensa contra DoS de
# payloads gigantes). 64 KB es holgado para un formulario de contacto.
MAX_CONTENT_LENGTH = 64 * 1024  # 64 KB

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
# Envío vía Resend
# --------------------------------------------------------------------------

RESEND_ENDPOINT = "https://api.resend.com/emails"


def send_email(payload: dict) -> dict:
    """Envía el correo a través de Resend.

    Devuelve el JSON de la respuesta (incluye `id` del mensaje en Resend).
    Lanza EmailAuthError / EmailValidationError / EmailError según el caso.
    """
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    if not api_key:
        raise EmailError("RESEND_API_KEY no está configurada")

    mail_from = os.getenv("MAIL_FROM",
                          "Monou.gg Landing <onboarding@resend.dev>").strip()
    mail_to_raw = os.getenv("MAIL_TO", "")
    mail_to = [t.strip() for t in mail_to_raw.split(",") if t.strip()]
    if not mail_to:
        raise EmailError("MAIL_TO no está configurada")

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
    subject = f"[Monou.gg] Nueva solicitud de {subj_name}"
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
      <tr><td><b>Nombre</b></td><td>{e_nombre}</td></tr>
      <tr><td><b>Email</b></td><td>{e_email}</td></tr>
      <tr><td><b>Empresa</b></td><td>{e_empresa}</td></tr>
      <tr><td><b>Caso de uso</b></td><td>{e_caso_uso}</td></tr>
    </table>
    <h3>Mensaje</h3>
    <p style="white-space:pre-wrap;">{e_mensaje}</p>
  </body>
</html>"""

    body = {
        "from": mail_from,
        "to": mail_to,
        "subject": subject,
        "text": body_text,
        "html": body_html,
    }
    # Sanitiza reply_to: sólo si tiene forma de email y no contiene CRLF.
    # Defensa secundaria contra header injection (Resend ya escapa JSON, pero
    # mejor no enviarles basura).
    safe_reply = re.sub(r"[\r\n]+", "", email)
    if safe_reply and EMAIL_RE.match(safe_reply):
        body["reply_to"] = safe_reply

    req = urllib.request.Request(
        RESEND_ENDPOINT,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "monou-landing-backend/1.0",
        },
        method="POST",
    )

    with force_ipv4():
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                try:
                    return json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    return {"raw": raw}
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            if e.code in (401, 403):
                raise EmailAuthError(
                    f"Resend rechazó la API key (HTTP {e.code}): {err_body}")
            if e.code == 422:
                raise EmailValidationError(
                    f"Resend rechazó el correo (HTTP 422): {err_body}")
            raise EmailError(f"Resend HTTP {e.code}: {err_body}")
        except urllib.error.URLError as e:
            raise EmailError(f"Error de red llamando a Resend: {e.reason}")


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
        "email_provider": "resend",
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


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
