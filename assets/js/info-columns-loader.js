/**
 * info-columns-loader.js — Renderiza dinámicamente las 3 columnas de info
 * dentro del card grande en la sección Publishers (Visual Capture, Available
 * Metadata, Current Volume) desde el backend (`GET /api/info-columns`).
 *
 * Estructura esperada del HTML: cada columna marcada con
 *   <div data-info-column="visual_capture">    ...contenido... </div>
 *   <div data-info-column="available_metadata"> ...contenido... </div>
 *   <div data-info-column="current_volume">    ...contenido... </div>
 *
 * El loader REEMPLAZA por completo el contenido de cada columna con un
 * <h3> + título + icono + <ul> con los items. El HTML estático actúa como
 * fallback si el backend falla.
 */

(function () {
  const CACHE_KEY = "monou_info_columns_v1";
  const CACHE_TTL_MS = 5 * 60 * 1000;

  function resolveApiBase() {
    if (window.MONOU_API_BASE) return window.MONOU_API_BASE.replace(/\/$/, "");
    const meta = document.querySelector('meta[name="api-base"]');
    if (meta && meta.content) return meta.content.trim().replace(/\/$/, "");
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "") {
      return "http://localhost:5000";
    }
    return "https://landing-contacto-backend.onrender.com";
  }

  function currentLang() {
    return (document.documentElement.lang || "es").toLowerCase().slice(0, 2);
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }

  function applyColumns(columns) {
    if (!Array.isArray(columns)) return;
    const lang = currentLang();
    columns.forEach(col => {
      if (!col || !col.slug) return;
      const container = document.querySelector(`[data-info-column="${col.slug}"]`);
      if (!container) return;

      const titleEs = col.title_es || "";
      const titleEn = col.title_en || "";
      const titleText = (lang === "en" ? titleEn : titleEs) || titleEs || titleEn;
      const icon       = col.icon || "fa-solid fa-circle";
      const iconColor  = col.icon_color || "text-brand-400";
      const itemsEs    = Array.isArray(col.items_es) ? col.items_es : [];
      const itemsEn    = Array.isArray(col.items_en) ? col.items_en : [];

      const itemsHtml = itemsEs.map((es, i) => {
        const en = itemsEn[i] || es;
        const text = (lang === "en" ? en : es) || es;
        return `
          <li class="flex items-start gap-2">
            <i class="fa-solid fa-check text-brand-500 mt-1 flex-shrink-0"></i>
            <span data-es="${escapeHtml(es)}" data-en="${escapeHtml(en)}">${escapeHtml(text)}</span>
          </li>`;
      }).join("");

      container.innerHTML = `
        <h3 class="text-lg font-bold text-white mb-4 flex items-center gap-2">
          <i class="${escapeHtml(icon)} ${escapeHtml(iconColor)}"></i>
          <span data-es="${escapeHtml(titleEs)}" data-en="${escapeHtml(titleEn)}">${escapeHtml(titleText)}</span>
        </h3>
        <ul class="space-y-3 text-sm text-gray-400">
          ${itemsHtml}
        </ul>`;
    });
  }

  function loadFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached || !Array.isArray(cached.columns)) return false;
      applyColumns(cached.columns);
      return Date.now() - (cached.t || 0) < CACHE_TTL_MS;
    } catch (e) { return false; }
  }

  function saveCache(columns) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), columns }));
    } catch (e) {}
  }

  async function loadFresh(apiBase) {
    try {
      const url = `${apiBase}/api/info-columns?_t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const columns = (json && json.columns) || [];
      if (columns.length) {
        applyColumns(columns);
        saveCache(columns);
      }
    } catch (err) {
      console.warn("[info-columns-loader] fetch falló:", err.message);
    }
  }

  function init() {
    const apiBase = resolveApiBase();
    loadFromCache();
    loadFresh(apiBase);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
