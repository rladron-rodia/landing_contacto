/**
 * stats-loader.js — Lee estadísticas desde el backend (Postgres) e
 * inyecta los valores en los elementos del HTML marcados con
 * `data-stat-value` / `data-stat-label`.
 *
 * Configuración del endpoint (en orden de prioridad):
 *   1. <meta name="api-base" content="https://...">
 *   2. window.MONOU_API_BASE = "..."
 *   3. Auto: localhost → http://localhost:5000 ; prod → backend en Render
 *
 * El backend devuelve:
 *   GET /api/stats → {"ok":true,"stats":[{key,value,label_es,label_en,...}, ...]}
 *
 * Caché en localStorage 5 min para no parpadear entre cargas. Si la API
 * no responde, los valores hardcodeados del HTML se quedan visibles
 * (failsafe).
 */

(function () {
  const CACHE_KEY = "monou_stats_v2";
  const CACHE_TTL_MS = 5 * 60 * 1000;

  // ---------- 1. URL del backend ----------
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

  // ---------- 2. Aplicar al DOM ----------
  function currentLang() {
    return (document.documentElement.lang || "es").toLowerCase().slice(0, 2);
  }

  function applyStats(rows) {
    if (!Array.isArray(rows)) return;
    const lang = currentLang();
    rows.forEach(row => {
      if (!row || !row.key) return;

      const valueEl = document.querySelector(`[data-stat-value="${row.key}"]`);
      if (valueEl && row.value) valueEl.textContent = row.value;

      const labelEl = document.querySelector(`[data-stat-label="${row.key}"]`);
      if (labelEl) {
        if (row.label_es) labelEl.setAttribute("data-es", row.label_es);
        if (row.label_en) labelEl.setAttribute("data-en", row.label_en);
        const text =
          (lang === "en" ? row.label_en : row.label_es) ||
          row.label_es || row.label_en;
        if (text) labelEl.textContent = text;
      }
    });
  }

  // ---------- 3. Caché (evita parpadeo) ----------
  function loadFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached || !Array.isArray(cached.rows)) return false;
      applyStats(cached.rows);
      return Date.now() - (cached.t || 0) < CACHE_TTL_MS;
    } catch (e) { return false; }
  }

  function saveCache(rows) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), rows }));
    } catch (e) { /* quota exceeded, ignore */ }
  }

  // ---------- 4. Fetch fresco ----------
  async function loadFresh(apiBase) {
    try {
      const url = `${apiBase}/api/stats?_t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const rows = (json && json.stats) || [];
      if (rows.length) {
        applyStats(rows);
        saveCache(rows);
      }
    } catch (err) {
      console.warn("[stats-loader] fetch falló:", err.message);
      // El HTML hardcoded se queda como fallback
    }
  }

  // ---------- 5. Init ----------
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
