/**
 * stats-loader.js — Lee estadísticas desde un Google Sheet publicado como CSV
 * y las inyecta en los elementos del HTML marcados con `data-stat-value` o
 * `data-stat-label`.
 *
 * Configuración:
 *   - <meta name="stats-csv-url" content="https://docs.google.com/.../pub?output=csv">
 *     (recomendado — fácil de cambiar sin tocar JS)
 *   - O bien window.MONOU_STATS_CSV_URL = "..."  (override en runtime)
 *
 * Estructura esperada del Sheet:
 *
 *   key             | value | label_es           | label_en
 *   capture_hours   | 10k+  | Horas de Captura   | Capture Hours
 *   indexed_videos  | 2.5M  | Videos Indexados   | Indexed Videos
 *   games_covered   | 50+   | Juegos Cubiertos   | Games Covered
 *
 * Mínimo: las columnas `key` y `value`. Las columnas `label_es` / `label_en`
 * son opcionales — si las pones, también se actualizan los rótulos.
 *
 * Caché en localStorage para no parpadear entre cargas.
 * Si el Sheet falla, los valores hardcodeados del HTML se quedan visibles.
 */

(function () {
  const CACHE_KEY = "monou_stats_v1";
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — siguiente refresh es del backend

  // ---------- 1. URL del sheet ----------
  function getSheetUrl() {
    if (window.MONOU_STATS_CSV_URL) return window.MONOU_STATS_CSV_URL;
    const meta = document.querySelector('meta[name="stats-csv-url"]');
    return meta && meta.content ? meta.content.trim() : null;
  }

  // ---------- 2. CSV parser (tolerante a comillas dobles) ----------
  function parseCsv(text) {
    const rows = [];
    let cur = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i + 1];
      if (inQuotes) {
        if (c === '"' && next === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { field += c; }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") { cur.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
          if (field !== "" || cur.length) { cur.push(field); rows.push(cur); }
          cur = []; field = "";
          if (c === "\r" && next === "\n") i++;
        } else { field += c; }
      }
    }
    if (field !== "" || cur.length) { cur.push(field); rows.push(cur); }
    if (!rows.length) return [];
    const headers = rows.shift().map(h => h.trim().toLowerCase());
    return rows.map(cells => {
      const o = {};
      headers.forEach((h, i) => o[h] = (cells[i] || "").trim());
      return o;
    }).filter(r => r.key);
  }

  // ---------- 3. Aplicar al DOM ----------
  function currentLang() {
    return (document.documentElement.lang || "es").toLowerCase().slice(0, 2);
  }

  function applyStats(rows) {
    if (!Array.isArray(rows)) return;
    const lang = currentLang();
    rows.forEach(row => {
      if (!row.key) return;

      // Valor (la cifra grande)
      const valueEl = document.querySelector(`[data-stat-value="${row.key}"]`);
      if (valueEl && row.value) valueEl.textContent = row.value;

      // Etiqueta (con i18n: actualiza data-es/data-en y el texto visible)
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

  // ---------- 4. Caché para evitar parpadeo ----------
  function loadFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached || !Array.isArray(cached.rows)) return false;
      // Aplica caché aunque esté vencida — el fetch fresco la actualizará
      applyStats(cached.rows);
      return Date.now() - (cached.t || 0) < CACHE_TTL_MS;
    } catch (e) { return false; }
  }

  function saveCache(rows) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), rows }));
    } catch (e) { /* quota exceeded, ignore */ }
  }

  // ---------- 5. Fetch fresco ----------
  async function loadFresh(url) {
    try {
      // Cache-buster para que Google sirva la versión más reciente
      const sep = url.includes("?") ? "&" : "?";
      const res = await fetch(`${url}${sep}_t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const csv = await res.text();
      const rows = parseCsv(csv);
      if (!rows.length) throw new Error("CSV vacío o mal formado");
      applyStats(rows);
      saveCache(rows);
    } catch (err) {
      console.warn("[stats-loader] fetch falló:", err.message);
    }
  }

  // ---------- 6. Init ----------
  function init() {
    const url = getSheetUrl();
    if (!url) {
      console.info("[stats-loader] sin <meta name=stats-csv-url> — usando valores del HTML");
      return;
    }
    loadFromCache();
    loadFresh(url);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
