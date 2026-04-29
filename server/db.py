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
    link_url       TEXT,
    category       TEXT NOT NULL DEFAULT 'f2p',
    display_order  INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_links (
    key            TEXT PRIMARY KEY,
    description    TEXT,                  -- descripción para el admin (no se muestra en la landing)
    url            TEXT,                  -- destino del enlace
    image_url      TEXT,                  -- imagen opcional asociada al CTA
    label_es       TEXT,                  -- (opcional) override del texto visible en ES
    label_en       TEXT,                  -- (opcional) override del texto visible en EN
    display_order  INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_options (
    slug           TEXT PRIMARY KEY,
    category       TEXT NOT NULL,          -- 'data_formats' | 'delivery_methods'
    title          TEXT NOT NULL,          -- fallback legacy
    title_es       TEXT,
    title_en       TEXT,
    description_es TEXT,
    description_en TEXT,
    icon           TEXT,                   -- 'fa-solid fa-cloud-arrow-down'
    icon_color     TEXT,                   -- 'text-brand-400'
    display_order  INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS info_columns (
    slug           TEXT PRIMARY KEY,
    title_es       TEXT,
    title_en       TEXT,
    icon           TEXT,                   -- 'fa-solid fa-video'
    icon_color     TEXT,                   -- 'text-accent-cyan'
    items_es       TEXT[] NOT NULL DEFAULT '{}',
    items_en       TEXT[] NOT NULL DEFAULT '{}',
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
ALTER TABLE games ADD COLUMN IF NOT EXISTS link_url TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'f2p';
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

# Datos iniciales de juegos. Tuple:
# (slug, title, title_es, title_en, description_es, description_en,
#  tags_es, tags_en, image_url, link_url, category, display_order)
GAMES_SEED = [
    # ── F2P (carrusel principal) ─────────────────────────────────────
    ("aventure",      "Aventure",      "Aventura",      "Adventure",
     "Combate en tiempo real, inventario, progresión", "Real-time combat, inventory, progression",
     ["250K sesiones", "1080p"], ["250K sessions", "1080p"],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/monou-attack.png",
     "", "f2p", 1),
    ("simulate",      "Simulate",      "Simulación",    "Simulate",
     "Aventura épica, sistema de misiones",           "Epic adventure, quest system",
     ["180K sesiones", "1080p"], ["180K sessions", "1080p"],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/monou-pacman.png",
     "", "f2p", 2),
    ("puzzle",        "Puzzle",        "Puzzle",        "Puzzle",
     "Exploración de mazmorras, loot",                "Dungeon exploration, loot",
     ["320K sesiones", "1080p"], ["320K sessions", "1080p"],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/monou-bird.png",
     "", "f2p", 3),
    ("strategy",      "Estrategia",    "Estrategia",    "Strategy",
     "Decisiones tácticas, gestión de recursos",      "Tactical decisions, resource management",
     ["180K sesiones", "1080p"], ["180K sessions", "1080p"],
     "", "", "f2p", 4),
    ("runner",        "Runner",        "Runner",        "Runner",
     "Construcción de imperios, diplomacia",          "Empire building, diplomacy",
     ["210K sesiones", "1080p"], ["210K sessions", "1080p"],
     "", "", "f2p", 5),
    ("tower-defense", "Tower Defense", "Tower Defense", "Tower Defense",
     "Defensa estratégica, oleadas",                  "Strategic defense, waves",
     ["165K sesiones", "1080p"], ["165K sessions", "1080p"],
     "", "", "f2p", 6),
    ("puzzle-arcade", "Puzzle Arcade", "Puzzle Arcade", "Puzzle Arcade",
     "Mecánicas clásicas, tiempo limitado",           "Classic mechanics, time-limited",
     ["280K sesiones", "1080p"], ["280K sessions", "1080p"],
     "", "", "f2p", 7),
    ("logic-puzzles", "Logic Puzzles", "Puzzles de Lógica", "Logic Puzzles",
     "Lógica deductiva, razonamiento",                "Deductive logic, reasoning",
     ["140K sesiones", "1080p"], ["140K sessions", "1080p"],
     "", "", "f2p", 8),
    ("block-puzzle",  "Block Puzzle",  "Puzzle de Bloques", "Block Puzzle",
     "Encaje de piezas, líneas",                      "Piece fitting, lines",
     ["230K sesiones", "1080p"], ["230K sessions", "1080p"],
     "", "", "f2p", 9),
    # ── Publishers (juegos AAA / populares) ─────────────────────────
    ("minecraft",     "Minecraft",    "Minecraft",    "Minecraft",
     "Mundo Abierto",                                 "Open World",
     [], [],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/minecraft.png",
     "", "publishers", 1),
    ("clash-royale",  "Clash Royale", "Clash Royale", "Clash Royale",
     "Estrategia",                                    "Strategy",
     [], [],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/clashroyale.png",
     "", "publishers", 2),
    ("brawl-stars",   "Brawl Stars",  "Brawl Stars",  "Brawl Stars",
     "MOBA",                                          "MOBA",
     [], [],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/brawlstar.png",
     "", "publishers", 3),
    ("roblox",        "Roblox",       "Roblox",       "Roblox",
     "Mundo Abierto",                                 "Open World",
     [], [],
     "https://muestra-imagen.s3.us-east-1.amazonaws.com/roblox.png",
     "", "publishers", 4),
    # Card especial: catálogo de +40 juegos. Tiene link_url para hacerla clickable.
    ("catalog",       "Catalogo",     "+40 Juegos",   "+40 Games",
     "Catálogo Completo",                             "Complete Catalog",
     [], [],
     "",  # sin imagen — usa el icono "+" del HTML
     "",  # link_url se setea desde el admin
     "publishers", 99),
]

# Datos iniciales de site_links. Misma lógica idempotente que stats/games.
# Tuple: (key, description, url, image_url, label_es, label_en, display_order)
SITE_LINKS_SEED = [
    ("view_full_catalog",
     "CTA del card '+200 Juegos Disponibles' en la sección F2P. La URL controla a dónde lleva el botón. La imagen reemplaza el icono.",
     "",  # url se configura desde el admin
     "",  # image_url se configura desde el admin
     "Ver Catálogo Completo", "View Full Catalog",
     1),
    ("view_examples",
     "Botón 'Ver ejemplos' / 'View examples' del hero. La URL puede ser un anchor interno (#ejemplos) o una URL externa (https://...).",
     "#ejemplos",  # default — anchor interno (comportamiento actual)
     "",            # sin imagen
     "Ver ejemplos", "View examples",
     2),
    ("privacy_terms",
     "Enlace del footer 'Términos de Privacidad' / 'Privacy Terms'. URL del documento de privacidad.",
     "",  # url se configura desde el admin (default '#' inactivo)
     "",
     "Términos de Privacidad", "Privacy Terms",
     10),
    ("data_licenses",
     "Enlace del footer 'Licencias de Datos' / 'Data Licenses'. URL del documento de licencias de datos.",
     "",
     "",
     "Licencias de Datos", "Data Licenses",
     11),
    ("dataset_badge",
     "Badge del hero que anuncia la versión del dataset. Cambia label_es y label_en cuando saques una nueva release (ej: 'Dataset v2.1 ya disponible' / 'Dataset v2.1 now available'). El campo URL no se usa.",
     "",  # sin URL — es solo un badge informativo
     "",  # sin imagen
     "Dataset v2.0 ya disponible", "Dataset v2.0 now available",
     20),
]

# Datos iniciales de delivery_options (Data Formats + Delivery Methods).
# Tuple: (slug, category, title, title_es, title_en, description_es, description_en,
#         icon, icon_color, display_order)
DELIVERY_OPTIONS_SEED = [
    # ── Data Formats ──
    ("json-jsonl",     "data_formats",
     "JSON / JSONL",   "JSON / JSONL", "JSON / JSONL",
     "Metadata estructurada, eventos, timestamps y anotaciones en formato JSON Lines.",
     "Structured metadata, events, timestamps and annotations in JSON Lines format.",
     "fa-solid fa-brackets-curly", "text-brand-400", 1),
    ("custom-format",  "data_formats",
     "Formato Personalizado", "Formato Personalizado", "Custom Format",
     "Adaptamos la estructura de datos a tu stack específico de ML/IA.",
     "We adapt the data structure to your specific ML/AI stack.",
     "fa-solid fa-gears", "text-gray-400", 2),
    # ── Delivery Methods ──
    ("cloud-storage",  "delivery_methods",
     "Cloud Storage",  "Cloud Storage", "Cloud Storage",
     "AWS S3, Google Cloud Storage o Azure Blob con acceso controlado y versionado.",
     "AWS S3, Google Cloud Storage or Azure Blob with controlled access and versioning.",
     "fa-solid fa-cloud-arrow-down", "text-brand-400", 1),
    ("api-rest",       "delivery_methods",
     "API REST",       "API REST", "API REST",
     "Acceso programático con filtros, paginación y streaming de datos en tiempo real.",
     "Programmatic access with filters, pagination and real-time data streaming.",
     "fa-solid fa-plug", "text-accent-cyan", 2),
]

# Datos iniciales de info_columns (las 3 columnas dentro del card grande de
# la sección Publishers: Visual Capture, Available Metadata, Current Volume).
# Tuple: (slug, title_es, title_en, icon, icon_color, items_es, items_en, display_order)
INFO_COLUMNS_SEED = [
    ("visual_capture",
     "Captura Visual", "Visual Capture",
     "fa-solid fa-video", "text-accent-cyan",
     ["Resolución hasta 1080p @ 60fps"],
     ["Resolution up to 1080p @ 60fps"],
     1),
    ("available_metadata",
     "Metadata Disponible", "Available Metadata",
     "fa-solid fa-tags", "text-accent-purple",
     ["Eventos de gameplay detectados",
      "Timestamps de acciones clave",
      "Segmentación por partidas"],
     ["Detected gameplay events",
      "Key action timestamps",
      "Match segmentation"],
     2),
    ("current_volume",
     "Volumen Actual", "Current Volume",
     "fa-solid fa-chart-bar", "text-brand-400",
     ["2.8M videos indexados",
      "3.1K horas de captura total",
      "Actualización semanal"],
     ["2.8M indexed videos",
      "3.1K hours of total capture",
      "Weekly update"],
     3),
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
                                      tags_es, tags_en, image_url,
                                      link_url, category, display_order)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (slug) DO NOTHING""",
                GAMES_SEED,
            )
            games_inserted = cur.rowcount
            # Seed site_links (idempotente)
            cur.executemany(
                """INSERT INTO site_links (key, description, url, image_url,
                                           label_es, label_en, display_order)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (key) DO NOTHING""",
                SITE_LINKS_SEED,
            )
            links_inserted = cur.rowcount
            # Seed delivery_options (idempotente)
            cur.executemany(
                """INSERT INTO delivery_options (slug, category, title, title_es, title_en,
                                                  description_es, description_en,
                                                  icon, icon_color, display_order)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (slug) DO NOTHING""",
                DELIVERY_OPTIONS_SEED,
            )
            delivery_inserted = cur.rowcount
            # Seed info_columns (idempotente)
            cur.executemany(
                """INSERT INTO info_columns (slug, title_es, title_en, icon, icon_color,
                                              items_es, items_en, display_order)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (slug) DO NOTHING""",
                INFO_COLUMNS_SEED,
            )
            info_inserted = cur.rowcount
            log.info("[db] schema+migraciones OK — stats: %d, games: %d, links: %d, delivery: %d, info: %d",
                     stats_inserted, games_inserted, links_inserted, delivery_inserted, info_inserted)
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

def list_games(include_meta: bool = False, category: str = None) -> list:
    """Lista juegos ordenados por display_order. Si `category` viene
    ('f2p' | 'publishers') filtra a solo esos. Fallback al seed en memoria
    si la DB no está disponible."""
    if not is_enabled():
        rows = [
            {"slug": s, "title": t, "title_es": tes_, "title_en": ten_,
             "description_es": de, "description_en": den,
             "tags_es": list(tags_es), "tags_en": list(tags_en),
             "image_url": img, "link_url": lnk, "category": cat,
             "display_order": ord_}
            for (s, t, tes_, ten_, de, den, tags_es, tags_en, img, lnk, cat, ord_) in GAMES_SEED
        ]
        if category:
            rows = [r for r in rows if r["category"] == category]
        return rows
    cols = ("slug, title, title_es, title_en, "
            "description_es, description_en, "
            "tags_es, tags_en, image_url, link_url, category, display_order")
    if include_meta:
        cols += ", updated_at"
    with conn() as c, c.cursor() as cur:
        if category:
            cur.execute(
                f"SELECT {cols} FROM games WHERE category = %s ORDER BY display_order, slug",
                (category,),
            )
        else:
            cur.execute(f"SELECT {cols} FROM games ORDER BY category, display_order, slug")
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
    link_url  = (payload.get("link_url")  or "").strip() or None
    category = (payload.get("category") or "f2p").strip().lower()
    if category not in ("f2p", "publishers"):
        category = "f2p"
    try:
        display_order = int(payload.get("display_order") or 0)
    except (TypeError, ValueError):
        display_order = 0

    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO games (slug, title, title_es, title_en,
                               description_es, description_en,
                               tags_es, tags_en, image_url, link_url,
                               category, display_order, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (slug) DO UPDATE SET
                title = EXCLUDED.title,
                title_es = EXCLUDED.title_es,
                title_en = EXCLUDED.title_en,
                description_es = EXCLUDED.description_es,
                description_en = EXCLUDED.description_en,
                tags_es = EXCLUDED.tags_es,
                tags_en = EXCLUDED.tags_en,
                image_url = EXCLUDED.image_url,
                link_url = EXCLUDED.link_url,
                category = EXCLUDED.category,
                display_order = EXCLUDED.display_order,
                updated_at = NOW()
            RETURNING slug, title, title_es, title_en,
                      description_es, description_en,
                      tags_es, tags_en, image_url, link_url,
                      category, display_order, updated_at
            """,
            (slug, title, title_es, title_en, desc_es, desc_en,
             tags_es, tags_en, image_url, link_url, category, display_order),
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


# ---------------------------------------------------------------------------
# Site links CRUD (configuración de URLs e imágenes en lugares específicos)
# ---------------------------------------------------------------------------

def list_site_links(include_meta: bool = False) -> list:
    """Lista todos los site_links ordenados por display_order. Fallback al
    seed en memoria si la DB no está disponible."""
    if not is_enabled():
        return [
            {"key": k, "description": d, "url": u, "image_url": img,
             "label_es": le, "label_en": len_, "display_order": ord_}
            for (k, d, u, img, le, len_, ord_) in SITE_LINKS_SEED
        ]
    cols = "key, description, url, image_url, label_es, label_en, display_order"
    if include_meta:
        cols += ", updated_at"
    with conn() as c, c.cursor() as cur:
        cur.execute(f"SELECT {cols} FROM site_links ORDER BY display_order, key")
        rows = cur.fetchall()
        if include_meta:
            for r in rows:
                if r.get("updated_at"):
                    r["updated_at"] = r["updated_at"].isoformat()
        return rows


def upsert_site_link(payload: dict) -> dict:
    """Crea o actualiza un site_link por key."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    key = (payload.get("key") or "").strip()
    if not key:
        raise ValueError("key requerido")

    description = (payload.get("description") or "").strip() or None
    url         = (payload.get("url") or "").strip() or None
    image_url   = (payload.get("image_url") or "").strip() or None
    label_es    = (payload.get("label_es") or "").strip() or None
    label_en    = (payload.get("label_en") or "").strip() or None
    try:
        display_order = int(payload.get("display_order") or 0)
    except (TypeError, ValueError):
        display_order = 0

    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO site_links (key, description, url, image_url,
                                    label_es, label_en, display_order, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (key) DO UPDATE SET
                description = EXCLUDED.description,
                url = EXCLUDED.url,
                image_url = EXCLUDED.image_url,
                label_es = EXCLUDED.label_es,
                label_en = EXCLUDED.label_en,
                display_order = EXCLUDED.display_order,
                updated_at = NOW()
            RETURNING key, description, url, image_url, label_es, label_en,
                      display_order, updated_at
            """,
            (key, description, url, image_url, label_es, label_en, display_order),
        )
        row = cur.fetchone()
        if row and row.get("updated_at"):
            row["updated_at"] = row["updated_at"].isoformat()
        return row


def delete_site_link(key: str) -> bool:
    """Borra un site_link por key."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    with conn() as c, c.cursor() as cur:
        cur.execute("DELETE FROM site_links WHERE key = %s", (key,))
        return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Delivery options CRUD (Data Formats + Delivery Methods)
# ---------------------------------------------------------------------------

VALID_DELIVERY_CATEGORIES = ("data_formats", "delivery_methods")


def list_delivery_options(include_meta: bool = False, category: str = None) -> list:
    """Lista todas las opciones de entrega ordenadas por category + display_order.
    Fallback al seed en memoria si la DB no está disponible."""
    if not is_enabled():
        rows = [
            {"slug": s, "category": cat, "title": t,
             "title_es": tes_, "title_en": ten_,
             "description_es": de, "description_en": den,
             "icon": ic, "icon_color": col, "display_order": ord_}
            for (s, cat, t, tes_, ten_, de, den, ic, col, ord_) in DELIVERY_OPTIONS_SEED
        ]
        if category:
            rows = [r for r in rows if r["category"] == category]
        return rows
    cols = ("slug, category, title, title_es, title_en, "
            "description_es, description_en, icon, icon_color, display_order")
    if include_meta:
        cols += ", updated_at"
    with conn() as c, c.cursor() as cur:
        if category:
            cur.execute(
                f"SELECT {cols} FROM delivery_options WHERE category = %s ORDER BY display_order, slug",
                (category,),
            )
        else:
            cur.execute(f"SELECT {cols} FROM delivery_options ORDER BY category, display_order, slug")
        rows = cur.fetchall()
        if include_meta:
            for r in rows:
                if r.get("updated_at"):
                    r["updated_at"] = r["updated_at"].isoformat()
        return rows


def upsert_delivery_option(payload: dict) -> dict:
    """Crea o actualiza una opción de entrega por slug."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    slug = (payload.get("slug") or "").strip()
    if not slug:
        raise ValueError("slug requerido")

    title_es = (payload.get("title_es") or "").strip()
    title_en = (payload.get("title_en") or "").strip()
    title    = (payload.get("title") or "").strip() or title_es or title_en
    if not title:
        raise ValueError("title (o title_es/title_en) requerido")
    if not title_es: title_es = title
    if not title_en: title_en = title

    category = (payload.get("category") or "").strip().lower()
    if category not in VALID_DELIVERY_CATEGORIES:
        raise ValueError(f"category debe ser uno de: {VALID_DELIVERY_CATEGORIES}")

    desc_es    = (payload.get("description_es") or "").strip() or None
    desc_en    = (payload.get("description_en") or "").strip() or None
    icon       = (payload.get("icon") or "").strip() or None
    icon_color = (payload.get("icon_color") or "").strip() or None
    try:
        display_order = int(payload.get("display_order") or 0)
    except (TypeError, ValueError):
        display_order = 0

    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO delivery_options (slug, category, title, title_es, title_en,
                                           description_es, description_en, icon, icon_color,
                                           display_order, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (slug) DO UPDATE SET
                category = EXCLUDED.category,
                title = EXCLUDED.title,
                title_es = EXCLUDED.title_es,
                title_en = EXCLUDED.title_en,
                description_es = EXCLUDED.description_es,
                description_en = EXCLUDED.description_en,
                icon = EXCLUDED.icon,
                icon_color = EXCLUDED.icon_color,
                display_order = EXCLUDED.display_order,
                updated_at = NOW()
            RETURNING slug, category, title, title_es, title_en,
                      description_es, description_en, icon, icon_color,
                      display_order, updated_at
            """,
            (slug, category, title, title_es, title_en, desc_es, desc_en,
             icon, icon_color, display_order),
        )
        row = cur.fetchone()
        if row and row.get("updated_at"):
            row["updated_at"] = row["updated_at"].isoformat()
        return row


def delete_delivery_option(slug: str) -> bool:
    """Borra una opción de entrega por slug."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    with conn() as c, c.cursor() as cur:
        cur.execute("DELETE FROM delivery_options WHERE slug = %s", (slug,))
        return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Info columns CRUD
# ---------------------------------------------------------------------------

def list_info_columns(include_meta: bool = False) -> list:
    """Lista todas las columnas de info ordenadas por display_order. Fallback
    al seed en memoria si la DB no está disponible."""
    if not is_enabled():
        return [
            {"slug": s, "title_es": tes_, "title_en": ten_, "icon": ic,
             "icon_color": col, "items_es": list(ies), "items_en": list(ien),
             "display_order": ord_}
            for (s, tes_, ten_, ic, col, ies, ien, ord_) in INFO_COLUMNS_SEED
        ]
    cols = ("slug, title_es, title_en, icon, icon_color, items_es, items_en, display_order")
    if include_meta:
        cols += ", updated_at"
    with conn() as c, c.cursor() as cur:
        cur.execute(f"SELECT {cols} FROM info_columns ORDER BY display_order, slug")
        rows = cur.fetchall()
        if include_meta:
            for r in rows:
                if r.get("updated_at"):
                    r["updated_at"] = r["updated_at"].isoformat()
        return rows


def upsert_info_column(payload: dict) -> dict:
    """Crea o actualiza una columna de info por slug."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    slug = (payload.get("slug") or "").strip()
    if not slug:
        raise ValueError("slug requerido")

    title_es = (payload.get("title_es") or "").strip() or None
    title_en = (payload.get("title_en") or "").strip() or None
    icon       = (payload.get("icon") or "").strip() or None
    icon_color = (payload.get("icon_color") or "").strip() or None

    def _items(v):
        if v is None: return []
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        if isinstance(v, str):
            # Aceptamos newlines o lineas literales
            return [s.strip() for s in v.splitlines() if s.strip()]
        return []

    items_es = _items(payload.get("items_es"))
    items_en = _items(payload.get("items_en"))
    try:
        display_order = int(payload.get("display_order") or 0)
    except (TypeError, ValueError):
        display_order = 0

    with conn() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO info_columns (slug, title_es, title_en, icon, icon_color,
                                       items_es, items_en, display_order, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (slug) DO UPDATE SET
                title_es = EXCLUDED.title_es,
                title_en = EXCLUDED.title_en,
                icon = EXCLUDED.icon,
                icon_color = EXCLUDED.icon_color,
                items_es = EXCLUDED.items_es,
                items_en = EXCLUDED.items_en,
                display_order = EXCLUDED.display_order,
                updated_at = NOW()
            RETURNING slug, title_es, title_en, icon, icon_color,
                      items_es, items_en, display_order, updated_at
            """,
            (slug, title_es, title_en, icon, icon_color, items_es, items_en, display_order),
        )
        row = cur.fetchone()
        if row and row.get("updated_at"):
            row["updated_at"] = row["updated_at"].isoformat()
        return row


def delete_info_column(slug: str) -> bool:
    """Borra una columna de info por slug."""
    if not is_enabled():
        raise RuntimeError("DB no está habilitada")
    with conn() as c, c.cursor() as cur:
        cur.execute("DELETE FROM info_columns WHERE slug = %s", (slug,))
        return cur.rowcount > 0
