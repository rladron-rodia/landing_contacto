"""
Persistencia de contactos en Postgres.

Diseñado para no romper si DATABASE_URL no está configurado: en ese caso
todas las funciones se vuelven no-op y el formulario sigue enviando
correos como antes (degradación elegante para entornos de desarrollo
locales sin Postgres).
"""

import os
import logging
from contextlib import contextmanager
from typing import Optional

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("db")

DATABASE_URL = os.getenv("DATABASE_URL")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS contacts (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nombre       TEXT NOT NULL,
    email        TEXT NOT NULL,
    empresa      TEXT,
    caso_uso     TEXT,
    mensaje      TEXT,
    ip           INET,
    user_agent   TEXT,
    referer      TEXT,
    status       TEXT NOT NULL DEFAULT 'received',  -- received | emailed | failed
    error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_email      ON contacts (email);
CREATE INDEX IF NOT EXISTS idx_contacts_status     ON contacts (status);
"""


def is_enabled() -> bool:
    return bool(DATABASE_URL)


@contextmanager
def conn():
    """Yield a psycopg connection. Autocommit ON. Use as `with conn() as c:`."""
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL no está configurada")
    # sslmode=require por defecto si la URL no lo trae (Render lo requiere)
    url = DATABASE_URL
    if "sslmode=" not in url:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}sslmode=require"
    with psycopg.connect(url, row_factory=dict_row, autocommit=True) as c:
        yield c


def init_schema() -> None:
    """Crea las tablas si no existen. Idempotente. Llamar al boot."""
    if not is_enabled():
        log.info("[db] DATABASE_URL no definida — Postgres deshabilitado")
        return
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute(SCHEMA_SQL)
        log.info("[db] schema OK")
    except Exception:
        log.exception("[db] error inicializando schema")


def insert_contact(payload: dict, meta: Optional[dict] = None) -> Optional[int]:
    """Inserta un contacto y devuelve su id, o None si DB deshabilitada/falla."""
    if not is_enabled():
        return None
    meta = meta or {}
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute(
                """
                INSERT INTO contacts
                    (nombre, email, empresa, caso_uso, mensaje,
                     ip, user_agent, referer, status)
                VALUES
                    (%(nombre)s, %(email)s, %(empresa)s, %(caso_uso)s, %(mensaje)s,
                     %(ip)s, %(user_agent)s, %(referer)s, 'received')
                RETURNING id
                """,
                {
                    "nombre":     (payload.get("nombre") or "").strip(),
                    "email":      (payload.get("email") or "").strip(),
                    "empresa":    (payload.get("empresa") or "").strip() or None,
                    "caso_uso":   (payload.get("caso_uso") or "").strip() or None,
                    "mensaje":    (payload.get("mensaje") or "").strip() or None,
                    "ip":         meta.get("ip"),
                    "user_agent": meta.get("user_agent"),
                    "referer":    meta.get("referer"),
                },
            )
            row = cur.fetchone()
            return row["id"] if row else None
    except Exception:
        log.exception("[db] error insertando contacto")
        return None


def mark_status(contact_id: int, status: str, error: Optional[str] = None) -> None:
    """Actualiza el estado de un contacto (emailed | failed)."""
    if not is_enabled() or not contact_id:
        return
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute(
                "UPDATE contacts SET status=%s, error=%s WHERE id=%s",
                (status, error, contact_id),
            )
    except Exception:
        log.exception("[db] error marcando status")


def list_contacts(limit: int = 100) -> list:
    """Lista los últimos N contactos."""
    if not is_enabled():
        return []
    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            SELECT id, created_at, nombre, email, empresa, caso_uso,
                   mensaje, status, error
            FROM contacts
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        return cur.fetchall()
