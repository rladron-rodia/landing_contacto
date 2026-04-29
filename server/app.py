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
import socket
import json
import urllib.request
import urllib.error
from contextlib import contextmanager

from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv

import db  # módulo de persistencia (degrada a no-op si DATABASE_URL no está)


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

ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
_origins = [o.strip() for o in ALLOWED_ORIGIN.split(",")] if ALLOWED_ORIGIN != "*" else "*"
CORS(app, resources={r"/api/*": {"origins": _origins}}, supports_credentials=False)

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

    body = {
        "from": mail_from,
        "to": mail_to,
        "subject": subject,
        "text": body_text,
        "html": body_html,
    }
    if email:
        body["reply_to"] = email

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
    return {
        "ip": ip,
        "user_agent": req.headers.get("User-Agent"),
        "referer": req.headers.get("Referer"),
    }


@app.route("/api/contact", methods=["POST"])
def contact():
    data = request.get_json(silent=True) or request.form.to_dict()

    required = ["nombre", "email"]
    missing = [f for f in required if not (data.get(f) or "").strip()]
    if missing:
        return jsonify({"ok": False, "error": f"Campos requeridos: {', '.join(missing)}"}), 400

    if (data.get("website") or "").strip():
        # Honeypot lleno: fingimos éxito sin tocar nada
        return jsonify({"ok": True}), 200

    contact_id = db.insert_contact(data, _client_meta(request))

    try:
        send_email(data)
    except EmailAuthError as exc:
        app.logger.error("Resend auth: %s", exc)
        db.mark_status(contact_id, "failed", str(exc))
        return jsonify({"ok": False, "error": "Autenticación con el proveedor de correo fallida."}), 500
    except EmailValidationError as exc:
        app.logger.error("Resend validation: %s", exc)
        db.mark_status(contact_id, "failed", str(exc))
        return jsonify({"ok": False, "error": "El proveedor rechazó el correo (verifica dominio o destinatario)."}), 500
    except EmailError as exc:
        app.logger.error("Resend error: %s", exc)
        db.mark_status(contact_id, "failed", str(exc))
        return jsonify({"ok": False, "error": f"Error enviando correo: {exc}"}), 500
    except Exception as exc:
        app.logger.exception("Error inesperado enviando correo")
        db.mark_status(contact_id, "failed", str(exc))
        return jsonify({"ok": False, "error": f"Error interno: {exc}"}), 500

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
    """Valida el header Authorization Bearer contra ADMIN_TOKEN."""
    token = os.getenv("ADMIN_TOKEN", "")
    auth = req.headers.get("Authorization", "")
    return bool(token) and auth == f"Bearer {token}"


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
    """Devuelve la lista de juegos para la landing. Público, sin auth."""
    return jsonify({"ok": True, "games": db.list_games(include_meta=False)}), 200


@app.route("/api/admin/games", methods=["GET"])
def admin_list_games():
    """Lista games con metadatos para el admin."""
    if not _is_admin(request):
        return _unauthorized()
    return jsonify({"ok": True, "games": db.list_games(include_meta=True)}), 200


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


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
