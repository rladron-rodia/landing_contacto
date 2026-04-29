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

CREATE TABLE IF NOT EXISTS stats (
    key            TEXT PRIMARY KEY,
    value          TEXT NOT NULL,
    label_es       TEXT,
    label_en       TEXT,
    display_order  INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

# Datos iniciales de stats. Solo se insertan si la tabla está vacía.
# Para actualizar los valores LIVE, usa el admin en /admin/ → Estadísticas
# (no este seed, que solo aplica cuando la tabla está recién creada).
STATS_SEED = [
    ("capture_hours",  "3.8K", "Horas de Captura Total", "Hours of Total Capture", 1),
    ("indexed_videos", "2.2M", "Videos Indexados",       "Indexed Videos",         2),
    ("games_covered",  "50+",  "Juegos Cubiertos",       "Games Covered",          3),
]


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
    """Crea las tablas si no existen + siembra stats iniciales. Idempotente."""
    if not is_enabled():
        log.info("[db] DATABASE_URL no definida — Postgres deshabilitado")
        return
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute(SCHEMA_SQL)
            # Seed stats solo si la tabla está vacía
            cur.execute("SELECT COUNT(*) AS n FROM stats")
            row = cur.fetchone()
            if row and row.get("n", 0) == 0:
                cur.executemany(
                    """INSERT INTO stats (key, value, label_es, label_en, display_order)
                       VALUES (%s, %s, %s, %s, %s)
                       ON CONFLICT (key) DO NOTHING""",
                    STATS_SEED,
                )
                log.info("[db] stats sembradas con %d filas", len(STATS_SEED))
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


# ---------------------------------------------------------------------------
# Stats CRUD
# ---------------------------------------------------------------------------

def list_stats(include_meta: bool = False) -> list:
    """Lista todas las stats ordenadas por display_order. Si DB no está,
    devuelve el seed en memoria como fallback."""
    if not is_enabled():
        return [
            {"key": k, "value": v, "label_es": le, "label_en": len_, "display_order": ord_}
            for (k, v, le, len_, ord_) in STATS_SEED
        ]
    cols = "key, value, label_es, label_en, display_order"
    if include_meta:
        cols += ", updated_at"
    with conn() as c, c.cursor() as cur:
        cur.execute(f"SELECT {cols} FROM stats ORDER BY display_order, key")
        rows = cur.fetchall()
        if include_meta:
            for r in rows:
                if r.get("updated_at"):
                    r["updated_at"] = r["updated_at"].isoformat()
        return rows


def upsert_stat(payload: dict) -> dict:
    """Crea o actualiza un stat. Devuelve la fila resultante."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    key = (payload.get("key") or "").strip()
    if not key:
        raise ValueError("key requerido")
    value = (payload.get("value") or "").strip()
    if not value:
        raise ValueError("value requerido")
    label_es = (payload.get("label_es") or "").strip() or None
    label_en = (payload.get("label_en") or "").strip() or None
    try:
        display_order = int(payload.get("display_order") or 0)
    except (TypeError, ValueError):
        display_order = 0

    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO stats (key, value, label_es, label_en, display_order, updated_at)
            VALUES (%s, %s, %s, %s, %s, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                label_es = EXCLUDED.label_es,
                label_en = EXCLUDED.label_en,
                display_order = EXCLUDED.display_order,
                updated_at = NOW()
            RETURNING key, value, label_es, label_en, display_order, updated_at
            """,
            (key, value, label_es, label_en, display_order),
        )
        row = cur.fetchone()
        if row and row.get("updated_at"):
            row["updated_at"] = row["updated_at"].isoformat()
        return row


def delete_stat(key: str) -> bool:
    """Borra un stat por key. Devuelve True si borró, False si no existía."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    with conn() as c, c.cursor() as cur:
        cur.execute("DELETE FROM stats WHERE key = %s", (key,))
        return cur.rowcount > 0
