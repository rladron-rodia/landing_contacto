/**
 * delivery-loader.js — Renderiza dinámicamente los items de "Data Formats"
 * y "Delivery Methods" desde el backend (`GET /api/delivery-options`).
 *
 * Estructura esperada del HTML: dos contenedores con
 *   <div data-delivery-list="data_formats">    ...items aquí... </div>
 *   <div data-delivery-list="delivery_methods"> ...items aquí... </div>
 *
 * Cada item se renderiza con esta plantilla (Tailwind):
 *
 *   <div class="flex items-start gap-4 p-4 bg-dark-900/50 rounded-xl border border-white/5">
 *     <i class="${icon} text-xl ${icon_color} mt-1"></i>
 *     <div class="flex-1">
 *       <h4 data-es="..." data-en="..." class="...">Title</h4>
 *       <p  data-es="..." data-en="..." class="...">Description</p>
 *     </div>
 *   </div>
 *
 * El contenido estático del HTML actúa como fallback: solo se reemplaza
 * cuando llegan datos del backend.
 */

(function () {
  const CACHE_KEY = "monou_delivery_v1";
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

  function renderItem(opt, lang) {
    const title = (lang === "en" ? opt.title_en : opt.title_es) || opt.title || "";
    const desc  = (lang === "en" ? opt.description_en : opt.description_es)
               || opt.description_es || opt.description_en || "";
    const icon       = opt.icon || "fa-solid fa-circle";
    const iconColor  = opt.icon_color || "text-brand-400";

    return `
      <div class="flex items-start gap-4 p-4 bg-dark-900/50 rounded-xl border border-white/5"
           data-delivery-slug="${escapeHtml(opt.slug)}">
        <i class="${escapeHtml(icon)} text-xl ${escapeHtml(iconColor)} mt-1"></i>
        <div class="flex-1">
          <h4 data-es="${escapeHtml(opt.title_es || opt.title || "")}"
              data-en="${escapeHtml(opt.title_en || opt.title || "")}"
              class="text-base font-semibold text-white mb-1">${escapeHtml(title)}</h4>
          <p data-es="${escapeHtml(opt.description_es || "")}"
             data-en="${escapeHtml(opt.description_en || "")}"
             class="text-sm text-gray-400">${escapeHtml(desc)}</p>
        </div>
      </div>`;
  }

  function applyOptions(options) {
    if (!Array.isArray(options) || !options.length) return;
    const lang = currentLang();
    // Agrupar por category
    const byCategory = {};
    options.forEach(opt => {
      if (!opt || !opt.category) return;
      (byCategory[opt.category] ||= []).push(opt);
    });
    // Por cada container, renderizar el bloque correspondiente
    Object.entries(byCategory).forEach(([category, items]) => {
      const container = document.querySelector(`[data-delivery-list="${category}"]`);
      if (!container) return;
      // Ordenar por display_order si la API no lo hizo
      items.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
      container.innerHTML = items.map(opt => renderItem(opt, lang)).join("");
    });
  }

  function loadFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached || !Array.isArray(cached.options)) return false;
      applyOptions(cached.options);
      return Date.now() - (cached.t || 0) < CACHE_TTL_MS;
    } catch (e) { return false; }
  }

  function saveCache(options) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), options }));
    } catch (e) {}
  }

  async function loadFresh(apiBase) {
    try {
      const url = `${apiBase}/api/delivery-options?_t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const options = (json && json.options) || [];
      if (options.length) {
        applyOptions(options);
        saveCache(options);
      }
    } catch (err) {
      console.warn("[delivery-loader] fetch falló:", err.message);
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
