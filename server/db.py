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

CREATE TABLE IF NOT EXISTS games (
    slug           TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    title_es       TEXT,
    title_en       TEXT,
    description_es TEXT,
    description_en TEXT,
    tags_es        TEXT[] NOT NULL DEFAULT '{}',
    tags_en        TEXT[] NOT NULL DEFAULT '{}',
    image_url      TEXT,
    display_order  INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

# Migraciones idempotentes que se ejecutan al boot. ALTER TABLE IF NOT EXISTS
# es soportado en Postgres 9.6+; lo usamos para poder evolucionar el schema
# sin tocar datos existentes.
MIGRATIONS_SQL = """
ALTER TABLE games ADD COLUMN IF NOT EXISTS title_es TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS title_en TEXT;
-- Backfill: si title_es está vacío en filas existentes, copiar desde title
UPDATE games SET title_es = title WHERE title_es IS NULL AND title IS NOT NULL;
UPDATE games SET title_en = title WHERE title_en IS NULL AND title IS NOT NULL;
"""

# Datos iniciales de stats. Las claves nuevas se insertan en cada deploy
# vía init_schema (ON CONFLICT DO NOTHING protege ediciones previas).
STATS_SEED = [
    # Hero principal
    ("capture_hours",     "10k+", "Horas de Captura",          "Capture Hours",            1),
    ("indexed_videos",    "2.5M", "Videos Indexados",          "Indexed Videos",           2),
    ("games_covered",     "50+",  "Juegos Cubiertos",          "Games Covered",            3),
    # Sección "Publishers Games / Volumen Actual"
    ("publishers_videos", "2.2M", "videos indexados",          "indexed videos",          10),
    ("publishers_hours",  "3.8K", "horas de captura total",    "hours of total capture",  11),
]

# Datos iniciales de juegos del carrusel F2P. Mismo patrón:
# se insertan automáticamente al deploy si no existen, no pisan ediciones.
# Tuple: (slug, title, title_es, title_en, description_es, description_en,
#         tags_es, tags_en, image_url, display_order)
# `title` es el fallback cuando title_es/title_en están vacíos (legacy).
GAMES_SEED = [
    ("aventure",      "Aventure",      "Aventura",      "Adventure",
     "Combate en tiempo real, inventario, progresión", "Real-time combat, inventory, progression",
     ["250K sesiones", "1080p"], ["250K sessions", "1080p"],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/monou-attack.png", 1),
    ("simulate",      "Simulate",      "Simulación",    "Simulate",
     "Aventura épica, sistema de misiones",           "Epic adventure, quest system",
     ["180K sesiones", "1080p"], ["180K sessions", "1080p"],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/monou-pacman.png", 2),
    ("puzzle",        "Puzzle",        "Puzzle",        "Puzzle",
     "Exploración de mazmorras, loot",                "Dungeon exploration, loot",
     ["320K sesiones", "1080p"], ["320K sessions", "1080p"],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/monou-bird.png", 3),
    ("strategy",      "Estratégia",    "Estrategia",    "Strategy",
     "Decisiones tácticas, gestión de recursos",      "Tactical decisions, resource management",
     ["180K sesiones", "1080p"], ["180K sessions", "1080p"],
     "", 4),
    ("runner",        "Runner",        "Runner",        "Runner",
     "Construcción de imperios, diplomacia",          "Empire building, diplomacy",
     ["210K sesiones", "1080p"], ["210K sessions", "1080p"],
     "", 5),
    ("tower-defense", "Tower Defense", "Tower Defense", "Tower Defense",
     "Defensa estratégica, oleadas",                  "Strategic defense, waves",
     ["165K sesiones", "1080p"], ["165K sessions", "1080p"],
     "", 6),
    ("puzzle-arcade", "Puzzle Arcade", "Puzzle Arcade", "Puzzle Arcade",
     "Mecánicas clásicas, tiempo limitado",           "Classic mechanics, time-limited",
     ["280K sesiones", "1080p"], ["280K sessions", "1080p"],
     "", 7),
    ("logic-puzzles", "Logic Puzzles", "Puzzles de Lógica", "Logic Puzzles",
     "Lógica deductiva, razonamiento",                "Deductive logic, reasoning",
     ["140K sesiones", "1080p"], ["140K sessions", "1080p"],
     "", 8),
    ("block-puzzle",  "Block Puzzle",  "Puzzle de Bloques", "Block Puzzle",
     "Encaje de piezas, líneas",                      "Piece fitting, lines",
     ["230K sesiones", "1080p"], ["230K sessions", "1080p"],
     "", 9),
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
    """Crea las tablas si no existen + siembra stats faltantes. Idempotente.

    El INSERT ... ON CONFLICT DO NOTHING garantiza que:
      - Las stats nuevas que añades a STATS_SEED se inserten al boot
      - Las stats existentes (con valores ya editados desde el admin) NO se
        sobreescriban — el ON CONFLICT (key) las protege.

    Si necesitas eliminar una stat de forma persistente, bórrala desde el
    admin Y elimina su entrada de STATS_SEED para que no la re-cree el
    siguiente deploy.
    """
    if not is_enabled():
        log.info("[db] DATABASE_URL no definida — Postgres deshabilitado")
        return
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute(SCHEMA_SQL)
            cur.execute(MIGRATIONS_SQL)
            # Seed stats (idempotente)
            cur.executemany(
                """INSERT INTO stats (key, value, label_es, label_en, display_order)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (key) DO NOTHING""",
                STATS_SEED,
            )
            stats_inserted = cur.rowcount
            # Seed games (idempotente)
            cur.executemany(
                """INSERT INTO games (slug, title, title_es, title_en,
                                      description_es, description_en,
                                      tags_es, tags_en, image_url, display_order)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (slug) DO NOTHING""",
                GAMES_SEED,
            )
            games_inserted = cur.rowcount
            log.info("[db] schema+migraciones OK — stats nuevas: %d, games nuevos: %d",
                     stats_inserted, games_inserted)
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


# ---------------------------------------------------------------------------
# Games CRUD (carrusel F2P)
# ---------------------------------------------------------------------------

def list_games(include_meta: bool = False) -> list:
    """Lista todos los juegos ordenados por display_order. Fallback al seed
    en memoria si la DB no está disponible."""
    if not is_enabled():
        return [
            {"slug": s, "title": t, "title_es": tes_, "title_en": ten_,
             "description_es": de, "description_en": den,
             "tags_es": list(tags_es), "tags_en": list(tags_en),
             "image_url": img, "display_order": ord_}
            for (s, t, tes_, ten_, de, den, tags_es, tags_en, img, ord_) in GAMES_SEED
        ]
    cols = ("slug, title, title_es, title_en, "
            "description_es, description_en, "
            "tags_es, tags_en, image_url, display_order")
    if include_meta:
        cols += ", updated_at"
    with conn() as c, c.cursor() as cur:
        cur.execute(f"SELECT {cols} FROM games ORDER BY display_order, slug")
        rows = cur.fetchall()
        if include_meta:
            for r in rows:
                if r.get("updated_at"):
                    r["updated_at"] = r["updated_at"].isoformat()
        return rows


def upsert_game(payload: dict) -> dict:
    """Crea o actualiza un juego por slug."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    slug = (payload.get("slug") or "").strip()
    if not slug:
        raise ValueError("slug requerido")

    title_es = (payload.get("title_es") or "").strip()
    title_en = (payload.get("title_en") or "").strip()
    # title (legacy / fallback): si no viene, usamos title_es; si tampoco,
    # title_en. Permite que el form admin no envíe title si no quiere.
    title = (payload.get("title") or "").strip() or title_es or title_en
    if not title:
        raise ValueError("title (o title_es / title_en) requerido")
    # Si solo hay title pero no title_es / title_en, replicar title en ambos
    if not title_es: title_es = title
    if not title_en: title_en = title

    def _list(v):
        if v is None: return []
        if isinstance(v, list): return [str(x).strip() for x in v if str(x).strip()]
        if isinstance(v, str):  return [s.strip() for s in v.split(",") if s.strip()]
        return []

    desc_es = (payload.get("description_es") or "").strip() or None
    desc_en = (payload.get("description_en") or "").strip() or None
    tags_es = _list(payload.get("tags_es"))
    tags_en = _list(payload.get("tags_en"))
    image_url = (payload.get("image_url") or "").strip() or None
    try:
        display_order = int(payload.get("display_order") or 0)
    except (TypeError, ValueError):
        display_order = 0

    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO games (slug, title, title_es, title_en,
                               description_es, description_en,
                               tags_es, tags_en, image_url, display_order, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (slug) DO UPDATE SET
                title = EXCLUDED.title,
                title_es = EXCLUDED.title_es,
                title_en = EXCLUDED.title_en,
                description_es = EXCLUDED.description_es,
                description_en = EXCLUDED.description_en,
                tags_es = EXCLUDED.tags_es,
                tags_en = EXCLUDED.tags_en,
                image_url = EXCLUDED.image_url,
                display_order = EXCLUDED.display_order,
                updated_at = NOW()
            RETURNING slug, title, title_es, title_en,
                      description_es, description_en,
                      tags_es, tags_en, image_url, display_order, updated_at
            """,
            (slug, title, title_es, title_en, desc_es, desc_en,
             tags_es, tags_en, image_url, display_order),
        )
        row = cur.fetchone()
        if row and row.get("updated_at"):
            row["updated_at"] = row["updated_at"].isoformat()
        return row


def delete_game(slug: str) -> bool:
    """Borra un juego por slug."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    with conn() as c, c.cursor() as cur:
        cur.execute("DELETE FROM games WHERE slug = %s", (slug,))
        return cur.rowcount > 0
