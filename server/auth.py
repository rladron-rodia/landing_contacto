"""
auth.py — sistema de autenticación multi-usuario (v3.2.0).

Provee:
- Password hashing y verificación (bcrypt cost 12)
- Session management DB-backed con sliding TTL (30 días)
- Permission checks por recurso/acción según role
- Decoradores: @require_session, @require_role, @require_permission
- Audit log helper

Architecture notes:
- Coexiste con ADMIN_TOKEN (path legacy, _is_admin en app.py) hasta que
  el primer super_admin set password via /api/auth/bootstrap. Después:
  ADMIN_TOKEN-mode se desactiva via system_settings.bootstrap_done=true.
- Sessions usan cookie HttpOnly+Secure+SameSite=Lax. El cookie value es
  el `id` (32-byte hex) de la fila en `user_sessions`. La validez se
  chequea contra DB en cada request autenticado.
- Sliding TTL: cada request actualiza last_seen_at + expires_at. Sesión
  inactiva > 30 días se invalida.

Roles:
- super_admin: acceso total, gestiona admins y editors
- admin: acceso a todo excepto pestaña Usuarios y gestión de admins.
  Puede invitar/editar/disable solo a editors.
- editor: acceso granular según user_permissions.

Recursos (8 pestañas + 1 meta):
    contacts, stats, games_f2p, games_publishers, site_links,
    delivery, info_columns, analytics, users
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Optional

import bcrypt
from flask import g, jsonify, request

import db

log = logging.getLogger("auth")

# ─── Constantes ──────────────────────────────────────────────────────────────

# Cost factor de bcrypt. 12 = ~250ms por hash en EC2 t4g.micro.
# Default de bcrypt es 12. Subir a 14 = ~1s, demasiado para login UX.
BCRYPT_COST = 12

# Cookie name para session id. HttpOnly + Secure + SameSite=Lax.
SESSION_COOKIE = "monou_session"

# TTL de sesiones. Sliding window: cada request autenticado bumpea expires_at.
SESSION_TTL = timedelta(days=30)

# TTL de invitations. Single-use.
INVITATION_TTL = timedelta(days=7)

# Roles fijos
ROLES = ("super_admin", "admin", "editor")

# Recursos válidos (= pestañas del admin + 'users' meta)
RESOURCES = (
    "contacts",
    "stats",
    "games_f2p",
    "games_publishers",
    "site_links",
    "delivery",
    "info_columns",
    "analytics",
    "users",
)

# Acciones válidas per recurso
ACTIONS = ("read", "write", "delete")


# ─── Password hashing ────────────────────────────────────────────────────────


def hash_password(plain: str) -> str:
    """Bcrypt hash con cost 12. Devuelve string ASCII (puede guardarse en TEXT)."""
    if not plain or len(plain) < 8:
        raise ValueError("password debe tener al menos 8 caracteres")
    if len(plain) > 72:
        # bcrypt trunca silenciosamente a 72 bytes. Mejor explícito.
        raise ValueError("password demasiado largo (max 72 caracteres)")
    salt = bcrypt.gensalt(rounds=BCRYPT_COST)
    return bcrypt.hashpw(plain.encode("utf-8"), salt).decode("ascii")


def verify_password(plain: str, hashed: Optional[str]) -> bool:
    """Compara plain con hashed (bcrypt). False si hashed es None/empty."""
    if not hashed or not plain:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))
    except (ValueError, TypeError):
        # Hash corrupto / formato raro
        return False


# ─── Bootstrap state ─────────────────────────────────────────────────────────


def is_bootstrap_done() -> bool:
    """True si ya hay al menos un super_admin con password set.

    Mientras sea False:
    - ADMIN_TOKEN-mode sigue activo en endpoints existentes
    - /api/auth/login está disponible pero solo si hay users con password
    - /api/auth/bootstrap está disponible (requiere ADMIN_TOKEN)
    """
    if not db.is_enabled():
        return False
    try:
        with db.conn() as c, c.cursor() as cur:
            cur.execute("SELECT bootstrap_done FROM system_settings WHERE id = 1")
            row = cur.fetchone()
            return bool(row and row[0])
    except Exception:
        log.exception("[auth] error leyendo bootstrap state")
        return False


def mark_bootstrap_done() -> None:
    """Marca system_settings.bootstrap_done=true. Idempotente."""
    if not db.is_enabled():
        raise RuntimeError("DB deshabilitada — bootstrap requiere Postgres")
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """UPDATE system_settings
                  SET bootstrap_done = TRUE, updated_at = NOW()
                WHERE id = 1""",
        )


# ─── Users CRUD (low-level) ──────────────────────────────────────────────────


def get_user_by_email(email: str) -> Optional[dict]:
    """Lookup case-insensitive por email. Devuelve dict o None."""
    if not db.is_enabled() or not email:
        return None
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """SELECT id, email, password_hash, full_name, role, status,
                      invited_by, created_via, created_at, updated_at,
                      last_login_at
                 FROM users
                WHERE LOWER(email) = LOWER(%s)
                LIMIT 1""",
            (email,),
        )
        row = cur.fetchone()
        return dict(row) if row else None


def get_user_by_id(user_id: int) -> Optional[dict]:
    """Lookup por id. Devuelve dict o None."""
    if not db.is_enabled() or not user_id:
        return None
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """SELECT id, email, password_hash, full_name, role, status,
                      invited_by, created_via, created_at, updated_at,
                      last_login_at
                 FROM users
                WHERE id = %s
                LIMIT 1""",
            (user_id,),
        )
        row = cur.fetchone()
        return dict(row) if row else None


def create_user(
    email: str,
    password_hash: Optional[str],
    full_name: Optional[str],
    role: str,
    status: str = "active",
    invited_by: Optional[int] = None,
    created_via: str = "invitation",
) -> int:
    """Crea un user. Devuelve id.

    Si password_hash es None → status debería ser 'pending' (invitation flow).
    """
    if role not in ROLES:
        raise ValueError(f"role inválido: {role}")
    if status not in ("active", "disabled", "pending"):
        raise ValueError(f"status inválido: {status}")
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """INSERT INTO users (email, password_hash, full_name, role, status,
                                  invited_by, created_via)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (email.strip(), password_hash, full_name, role, status,
             invited_by, created_via),
        )
        return int(cur.fetchone()["id"])


def count_active_super_admins() -> int:
    """Cuántos super_admins están active. Usado para guard 'no borrar el último'."""
    if not db.is_enabled():
        return 0
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """SELECT COUNT(*)::int AS n FROM users
                WHERE role = 'super_admin' AND status = 'active'""",
        )
        row = cur.fetchone()
        return int(row["n"]) if row else 0


def update_last_login(user_id: int) -> None:
    """Bumpea last_login_at = NOW()."""
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            "UPDATE users SET last_login_at = NOW() WHERE id = %s",
            (user_id,),
        )


def list_users(include_disabled: bool = True) -> list[dict]:
    """Devuelve todos los users (sin password_hash). Sorted: active first, then by created_at desc.

    include_disabled=False filtra status='disabled'.
    """
    if not db.is_enabled():
        return []
    with db.conn() as c, c.cursor() as cur:
        if include_disabled:
            cur.execute(
                """SELECT u.id, u.email, u.full_name, u.role, u.status,
                          u.invited_by, u.created_via, u.created_at,
                          u.updated_at, u.last_login_at,
                          inv.email AS invited_by_email
                     FROM users u
                LEFT JOIN users inv ON inv.id = u.invited_by
                 ORDER BY (u.status = 'active') DESC,
                          u.created_at DESC""",
            )
        else:
            cur.execute(
                """SELECT u.id, u.email, u.full_name, u.role, u.status,
                          u.invited_by, u.created_via, u.created_at,
                          u.updated_at, u.last_login_at,
                          inv.email AS invited_by_email
                     FROM users u
                LEFT JOIN users inv ON inv.id = u.invited_by
                    WHERE u.status != 'disabled'
                 ORDER BY u.created_at DESC""",
            )
        return [dict(r) for r in cur.fetchall()]


def update_user(user_id: int, full_name: Optional[str] = None,
                role: Optional[str] = None,
                status: Optional[str] = None) -> Optional[dict]:
    """Update fields opcionales de un user. Devuelve user actualizado o None.

    Nota: NO toca password_hash (eso solo en password change endpoint).
    NO valida guard rails — el caller (endpoint) debe chequear:
      - No demote último super_admin
      - No disable último super_admin
      - admin no toca otros admins/super_admins
    """
    fields = []
    params = []
    if full_name is not None:
        fields.append("full_name = %s")
        params.append(full_name)
    if role is not None:
        if role not in ROLES:
            raise ValueError(f"role inválido: {role}")
        fields.append("role = %s")
        params.append(role)
    if status is not None:
        if status not in ("active", "disabled", "pending"):
            raise ValueError(f"status inválido: {status}")
        fields.append("status = %s")
        params.append(status)
    if not fields:
        return get_user_by_id(user_id)
    fields.append("updated_at = NOW()")
    params.append(user_id)
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            f"UPDATE users SET {', '.join(fields)} WHERE id = %s",
            params,
        )
    return get_user_by_id(user_id)


def can_actor_manage(actor: dict, target: dict) -> tuple[bool, str]:
    """¿`actor` puede gestionar (edit/disable/delete) a `target`?

    Reglas:
    - super_admin: puede gestionar a cualquiera EXCEPTO editar su propio rol
      o disable a sí mismo si es el último super_admin active.
    - admin: SOLO puede gestionar editors. NO puede tocar otros admins ni
      super_admins.
    - editor: nunca puede gestionar a nadie (rejected antes de llegar acá).

    Returns (allowed: bool, reason: str). reason='' si allowed.
    """
    if not actor or not target:
        return False, "missing_actor_or_target"
    if actor.get("status") != "active":
        return False, "actor_not_active"

    actor_role = actor.get("role")
    target_role = target.get("role")

    if actor_role == "editor":
        return False, "editors_cannot_manage_users"

    if actor_role == "admin":
        # Admin solo puede tocar editors
        if target_role != "editor":
            return False, "admin_can_only_manage_editors"
        return True, ""

    if actor_role == "super_admin":
        # Super_admin tiene casi todo permitido. Las restricciones específicas
        # (último super_admin, no auto-democión) se chequean en el endpoint.
        return True, ""

    return False, "unknown_role"


# ─── Invitations ─────────────────────────────────────────────────────────────


def create_invitation(email: str, full_name: Optional[str], role: str,
                       permissions: Optional[dict],
                       invited_by: int) -> dict:
    """Crea invitation y devuelve dict con id (token) + expires_at.

    permissions = {resource: {can_read, can_write, can_delete}, ...} o None.
    Aplica solo a editors; ignored para super_admin/admin.
    """
    if role not in ROLES:
        raise ValueError(f"role inválido: {role}")
    token = secrets.token_hex(32)
    expires = datetime.now(timezone.utc) + INVITATION_TTL
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """INSERT INTO user_invitations
                   (id, email, full_name, role, permissions,
                    invited_by, expires_at)
               VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)
               RETURNING id, email, role, expires_at, created_at""",
            (token, email.strip(), full_name, role,
             json.dumps(permissions) if permissions else None,
             invited_by, expires),
        )
        row = cur.fetchone()
        return dict(row)


def get_invitation(token: str, *, include_expired: bool = False) -> Optional[dict]:
    """Lookup invitation por token. None si no existe.

    Incluye `invited_by_email` y `invited_by_name` para mostrar en la UI
    pública del accept page.

    include_expired=False (default) filtra expired/accepted/revoked. Útil
    para el endpoint público (no leakear info de invitations stale).
    """
    if not db.is_enabled() or not token:
        return None
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """SELECT i.id, i.email, i.full_name, i.role, i.permissions,
                      i.invited_by, i.expires_at, i.accepted_at,
                      i.revoked_at, i.created_at,
                      inv.email AS invited_by_email,
                      inv.full_name AS invited_by_name
                 FROM user_invitations i
            LEFT JOIN users inv ON inv.id = i.invited_by
                WHERE i.id = %s
                LIMIT 1""",
            (token,),
        )
        row = cur.fetchone()
        if not row:
            return None
        inv = dict(row)
        if not include_expired:
            now = datetime.now(timezone.utc)
            if (inv["accepted_at"] is not None or
                inv["revoked_at"] is not None or
                inv["expires_at"] < now):
                return None
        return inv


def accept_invitation(token: str, password: str,
                      ip: Optional[str] = None,
                      user_agent: Optional[str] = None) -> tuple[Optional[dict], Optional[str], Optional[str]]:
    """Acepta invitation: crea user, aplica perms, marca aceptada, crea session.

    Returns (user_dict, session_id, error). Si error != None, los otros son None.
    error codes: 'not_found', 'already_accepted', 'expired', 'revoked',
                 'email_taken', 'password_too_short', 'password_invalid'.
    """
    if not password or len(password) < 8:
        return None, None, "password_too_short"
    if len(password) > 72:
        return None, None, "password_invalid"

    inv = get_invitation(token, include_expired=True)
    if not inv:
        return None, None, "not_found"

    if inv["accepted_at"] is not None:
        return None, None, "already_accepted"
    if inv["revoked_at"] is not None:
        return None, None, "revoked"
    if inv["expires_at"] < datetime.now(timezone.utc):
        return None, None, "expired"

    # Verifica que el email no esté ya en uso (race entre invite y accept)
    existing = get_user_by_email(inv["email"])
    if existing:
        return None, None, "email_taken"

    try:
        password_hash = hash_password(password)
    except ValueError:
        return None, None, "password_invalid"

    # Transacción: crear user + perms + mark accepted en una sola op
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """INSERT INTO users (email, password_hash, full_name, role, status,
                                  invited_by, created_via)
               VALUES (%s, %s, %s, %s, 'active', %s, 'invitation')
               RETURNING id""",
            (inv["email"].strip(), password_hash, inv["full_name"],
             inv["role"], inv["invited_by"]),
        )
        user_id = int(cur.fetchone()["id"])

        # Aplica permissions snapshot solo si role='editor'
        if inv["role"] == "editor" and inv["permissions"]:
            perms = inv["permissions"]
            # permissions JSONB → ya viene parsed como dict
            for resource, p in perms.items():
                if resource not in RESOURCES:
                    continue
                cur.execute(
                    """INSERT INTO user_permissions
                           (user_id, resource, can_read, can_write, can_delete)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (user_id, resource,
                     bool(p.get("can_read", False)),
                     bool(p.get("can_write", False)),
                     bool(p.get("can_delete", False))),
                )

        # Mark invitation accepted
        cur.execute(
            "UPDATE user_invitations SET accepted_at = NOW() WHERE id = %s",
            (token,),
        )

    user = get_user_by_id(user_id)
    update_last_login(user_id)
    sid = create_session(user_id, ip=ip, user_agent=user_agent)
    return user, sid, None


def set_user_password(user_id: int, new_password: str) -> None:
    """Cambia la password_hash del user. NO crea sesión.

    Caller debe revocar sesiones existentes si es un reset (force re-login).
    """
    if not new_password or len(new_password) < 8:
        raise ValueError("password debe tener al menos 8 caracteres")
    pw_hash = hash_password(new_password)
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """UPDATE users
                  SET password_hash = %s, updated_at = NOW()
                WHERE id = %s""",
            (pw_hash, user_id),
        )


# ─── Password reset (forgot/reset) ───────────────────────────────────────────
#
# Diseño signed-stateless similar al de admin token recovery legacy, pero
# con user_id incluido en el payload para que cada usuario pueda recuperar
# SU propia password (no compartida).
#
# Token format: base64url(payload + "." + hmac_sha256(payload))
#   payload = "<user_id>:<expires_unix>:<nonce>"
#
# Single-use logical: aunque el token sea válido para todo su TTL, el
# endpoint /reset-password revoca todas las sesiones del user y cambia la
# password — efectivamente invalidando cualquier reuso del mismo link.

PASSWORD_RESET_TTL_SECONDS = 15 * 60  # 15 min


def _flask_secret_bytes() -> bytes:
    """FLASK_SECRET_KEY como bytes para HMAC. Raise si no está configurado."""
    secret = os.getenv("FLASK_SECRET_KEY", "").encode()
    if len(secret) < 16:
        raise RuntimeError(
            "FLASK_SECRET_KEY missing or shorter than 16 bytes — "
            "password reset disabled")
    return secret


def generate_password_reset_token(user_id: int,
                                   ttl_seconds: int = PASSWORD_RESET_TTL_SECONDS) -> str:
    """Genera token signed con user_id en payload."""
    expires = int(time.time()) + int(ttl_seconds)
    nonce = secrets.token_urlsafe(16)
    payload = f"{int(user_id)}:{expires}:{nonce}".encode("ascii")
    sig = hmac.new(_flask_secret_bytes(), payload, hashlib.sha256).digest()
    raw = payload + b"." + sig
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def validate_password_reset_token(token: str) -> tuple[Optional[int], Optional[str]]:
    """Devuelve (user_id, error_code). error_code='' si válido.

    error_code: 'missing'|'malformed'|'bad_signature'|'expired'|
                'server_misconfigured'
    """
    if not token or not isinstance(token, str):
        return None, "missing"
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception:
        return None, "malformed"
    if b"." not in raw:
        return None, "malformed"
    payload, sig = raw.rsplit(b".", 1)
    try:
        expected = hmac.new(_flask_secret_bytes(), payload,
                             hashlib.sha256).digest()
    except RuntimeError:
        return None, "server_misconfigured"
    if not hmac.compare_digest(sig, expected):
        return None, "bad_signature"
    try:
        parts = payload.decode("ascii").split(":", 2)
        user_id = int(parts[0])
        expires = int(parts[1])
    except Exception:
        return None, "malformed"
    if time.time() > expires:
        return None, "expired"
    return user_id, None


def revoke_invitation(token: str) -> bool:
    """Marca invitation como revoked. Devuelve True si existía y se actualizó."""
    if not db.is_enabled() or not token:
        return False
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """UPDATE user_invitations
                  SET revoked_at = NOW()
                WHERE id = %s
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL""",
            (token,),
        )
        return cur.rowcount > 0


def list_pending_invitations_for_email(email: str) -> list[dict]:
    """Lista invitations pendientes para un email (no accepted, no revoked, no expired)."""
    if not db.is_enabled() or not email:
        return []
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """SELECT id, email, role, expires_at, created_at
                 FROM user_invitations
                WHERE LOWER(email) = LOWER(%s)
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > NOW()
             ORDER BY created_at DESC""",
            (email,),
        )
        return [dict(r) for r in cur.fetchall()]


# ─── Permissions ─────────────────────────────────────────────────────────────


def get_user_permissions(user_id: int) -> dict:
    """Devuelve mapping {resource: {can_read, can_write, can_delete}}.

    Para super_admin/admin: returns full permissions por convención (no per-row).
    Para editor: lee de user_permissions; recursos faltantes = sin acceso.
    """
    user = get_user_by_id(user_id)
    if not user:
        return {}
    role = user["role"]
    if role == "super_admin":
        # Super admin tiene todo, incluso 'users'
        return {r: {"can_read": True, "can_write": True, "can_delete": True}
                for r in RESOURCES}
    if role == "admin":
        # Admin: todo excepto write/delete en users (solo invita editors).
        # 'users.read' = puede ver lista. 'users.write' = puede invitar
        # editors (la lógica anti-escalada se aplica en el endpoint).
        # 'users.delete' = puede disable editors solamente.
        out = {r: {"can_read": True, "can_write": True, "can_delete": True}
               for r in RESOURCES}
        return out
    # Editor: lee de DB
    perms = {r: {"can_read": False, "can_write": False, "can_delete": False}
             for r in RESOURCES}
    if not db.is_enabled():
        return perms
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """SELECT resource, can_read, can_write, can_delete
                 FROM user_permissions
                WHERE user_id = %s""",
            (user_id,),
        )
        for row in cur.fetchall():
            r = row["resource"]
            if r in RESOURCES:
                perms[r] = {
                    "can_read": bool(row["can_read"]),
                    "can_write": bool(row["can_write"]),
                    "can_delete": bool(row["can_delete"]),
                }
    return perms


def has_permission(user: dict, resource: str, action: str) -> bool:
    """Chequea si el user tiene action sobre resource.

    super_admin: siempre True (incluso users).
    admin: True para todo excepto: NO puede tocar otros admins ni super_admins.
    editor: lee de user_permissions.
    """
    if not user or user.get("status") != "active":
        return False
    if resource not in RESOURCES or action not in ACTIONS:
        return False
    role = user["role"]
    if role == "super_admin":
        return True
    if role == "admin":
        # Admin puede todo. Las restricciones específicas (no escalar privilegios
        # tocando otros admins/super_admins) se aplican en los endpoints, no aquí.
        return True
    # editor
    perms = get_user_permissions(user["id"])
    return bool(perms.get(resource, {}).get(f"can_{action}", False))


def set_user_permissions(user_id: int, perms: dict) -> None:
    """Reemplaza completamente las permissions de un editor.

    perms = {resource: {can_read, can_write, can_delete}, ...}

    Usa upsert (ON CONFLICT DO UPDATE) para entries existentes y elimina
    recursos que no aparecen en `perms` (mantiene la tabla en sync con
    la UI sin permissions zombie de configs anteriores).
    """
    if not db.is_enabled():
        return
    with db.conn() as c, c.cursor() as cur:
        # Borra todas las perms del user (será reemplazado completamente)
        cur.execute("DELETE FROM user_permissions WHERE user_id = %s",
                    (user_id,))
        # Inserta las nuevas
        for resource, p in perms.items():
            if resource not in RESOURCES:
                continue
            cur.execute(
                """INSERT INTO user_permissions
                       (user_id, resource, can_read, can_write, can_delete)
                   VALUES (%s, %s, %s, %s, %s)""",
                (user_id, resource,
                 bool(p.get("can_read", False)),
                 bool(p.get("can_write", False)),
                 bool(p.get("can_delete", False))),
            )


# ─── Sessions ────────────────────────────────────────────────────────────────


def create_session(user_id: int, ip: Optional[str] = None,
                   user_agent: Optional[str] = None) -> str:
    """Crea sesión, devuelve session_id (32-byte hex = 64 chars).

    El caller debe set este id como cookie HttpOnly+Secure+SameSite=Lax.
    """
    sid = secrets.token_hex(32)
    expires = datetime.now(timezone.utc) + SESSION_TTL
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """INSERT INTO user_sessions
                   (id, user_id, expires_at, ip_address, user_agent)
               VALUES (%s, %s, %s, %s, %s)""",
            (sid, user_id, expires, ip, user_agent),
        )
    return sid


def validate_session(session_id: str) -> Optional[dict]:
    """Valida session_id y devuelve dict con user info, o None si inválida.

    Side effect: bumpea last_seen_at y expires_at (sliding TTL) si válida.
    """
    if not session_id or not db.is_enabled():
        return None
    now = datetime.now(timezone.utc)
    new_expires = now + SESSION_TTL
    with db.conn() as c, c.cursor() as cur:
        # Combo: validate + slide TTL en una sola query (atomic)
        cur.execute(
            """UPDATE user_sessions
                  SET last_seen_at = %s, expires_at = %s
                WHERE id = %s
                  AND expires_at > %s
                RETURNING user_id""",
            (now, new_expires, session_id, now),
        )
        row = cur.fetchone()
        if not row:
            return None
        user = get_user_by_id(int(row["user_id"]))
        if not user or user.get("status") != "active":
            # User deshabilitado/borrado: invalidar sesión
            cur.execute("DELETE FROM user_sessions WHERE id = %s", (session_id,))
            return None
        return user


def revoke_session(session_id: str) -> None:
    """Borra una sesión (logout)."""
    if not session_id or not db.is_enabled():
        return
    with db.conn() as c, c.cursor() as cur:
        cur.execute("DELETE FROM user_sessions WHERE id = %s", (session_id,))


def revoke_all_sessions(user_id: int) -> int:
    """Revoca todas las sesiones de un user (force logout). Devuelve count."""
    if not db.is_enabled():
        return 0
    with db.conn() as c, c.cursor() as cur:
        cur.execute("DELETE FROM user_sessions WHERE user_id = %s",
                    (user_id,))
        return cur.rowcount


def cleanup_expired_sessions() -> int:
    """Borra sesiones expiradas. Llamar periódicamente (cron / cleanup job)."""
    if not db.is_enabled():
        return 0
    with db.conn() as c, c.cursor() as cur:
        cur.execute("DELETE FROM user_sessions WHERE expires_at < NOW()")
        return cur.rowcount


# ─── Audit log ───────────────────────────────────────────────────────────────


def audit(action: str, user_id: Optional[int] = None,
          resource_type: Optional[str] = None,
          resource_id: Optional[str] = None,
          metadata: Optional[dict] = None,
          ip: Optional[str] = None) -> None:
    """Registra una acción en audit_log. No re-raise — logging best-effort."""
    if not db.is_enabled():
        return
    try:
        with db.conn() as c, c.cursor() as cur:
            cur.execute(
                """INSERT INTO audit_log
                       (user_id, action, resource_type, resource_id,
                        metadata, ip_address)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (user_id, action, resource_type, resource_id,
                 json.dumps(metadata) if metadata else None, ip),
            )
    except Exception:
        log.exception("[audit] error registrando %s", action)


def cleanup_old_audit_logs(retention_days: int = 90) -> int:
    """Borra audit_log entries > retention_days. Cron nocturno."""
    if not db.is_enabled():
        return 0
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """DELETE FROM audit_log
                WHERE created_at < NOW() - (%s || ' days')::INTERVAL""",
            (retention_days,),
        )
        return cur.rowcount


# ─── Request integration helpers ─────────────────────────────────────────────


def get_session_id_from_request(req) -> Optional[str]:
    """Lee el cookie SESSION_COOKIE del request."""
    return req.cookies.get(SESSION_COOKIE)


def get_current_user(req=None) -> Optional[dict]:
    """Devuelve el user del session cookie, o None.

    Usa Flask `g` para cachear dentro del request (evita N hits a DB
    si varias decorators chequean perms en la misma request).
    """
    if req is None:
        req = request
    # Cache per-request via Flask g
    if hasattr(g, "_auth_user"):
        return g._auth_user
    sid = get_session_id_from_request(req)
    user = validate_session(sid) if sid else None
    g._auth_user = user
    return user


def _client_ip(req) -> Optional[str]:
    """Best-effort client IP. ALB pasa X-Forwarded-For."""
    xff = req.headers.get("X-Forwarded-For")
    if xff:
        # XFF puede ser "client, proxy1, proxy2" — primero es el client
        return xff.split(",")[0].strip()
    return req.remote_addr


# ─── Decorators ──────────────────────────────────────────────────────────────


def _unauthorized_json():
    return jsonify({"ok": False, "error": "unauthorized"}), 401


def _forbidden_json():
    return jsonify({"ok": False, "error": "forbidden"}), 403


def require_session(fn):
    """Endpoint requiere session válida. Carga user en g._auth_user."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = get_current_user(request)
        if not user:
            return _unauthorized_json()
        return fn(*args, **kwargs)
    return wrapper


def require_role(*allowed_roles):
    """Endpoint requiere session + role en allowed_roles."""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = get_current_user(request)
            if not user:
                return _unauthorized_json()
            if user.get("role") not in allowed_roles:
                return _forbidden_json()
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def require_permission(resource: str, action: str):
    """Endpoint requiere session + permiso (resource, action)."""
    if resource not in RESOURCES:
        raise ValueError(f"resource inválido: {resource}")
    if action not in ACTIONS:
        raise ValueError(f"action inválido: {action}")
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = get_current_user(request)
            if not user:
                return _unauthorized_json()
            if not has_permission(user, resource, action):
                return _forbidden_json()
            return fn(*args, **kwargs)
        return wrapper
    return decorator


# ─── Cookie helpers ──────────────────────────────────────────────────────────


def set_session_cookie(response, session_id: str, max_age: Optional[int] = None):
    """Mete el cookie en la response.

    Defaults seguros: HttpOnly + Secure + SameSite=Lax. En dev local
    (FLASK_ENV=development) se baja Secure=False para que funcione sobre HTTP.
    """
    if max_age is None:
        max_age = int(SESSION_TTL.total_seconds())
    is_prod = os.getenv("FLASK_ENV", "production") == "production"
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        max_age=max_age,
        httponly=True,
        secure=is_prod,        # cookie SOLO sobre HTTPS en prod
        samesite="Lax",        # bloquea CSRF cross-site sin matar UX same-site
        path="/",
    )


def clear_session_cookie(response):
    """Borra el cookie (logout)."""
    response.delete_cookie(SESSION_COOKIE, path="/")
