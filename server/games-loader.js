/**
 * games-loader.js — Lee los juegos del carrusel F2P desde el backend
 * (`GET /api/games`) e inyecta los valores en los elementos del HTML
 * marcados con `data-game-slug` y `data-game-field`.
 *
 * Estructura esperada del HTML (cada card del carrusel):
 *
 *   <div data-game-slug="aventure">
 *     <img data-game-field="image" src="...">
 *     <h4  data-game-field="title">Aventure</h4>
 *     <p   data-game-field="description"
 *          data-es="..." data-en="...">...</p>
 *     <span data-game-field="tag" data-tag-index="0"
 *           data-es="250K sesiones" data-en="250K sessions">...</span>
 *     <span data-game-field="tag" data-tag-index="1">1080p</span>
 *   </div>
 *
 * Las cards desktop y mobile pueden tener el mismo `data-game-slug`;
 * el JS las actualiza todas en una pasada. Caché 5 min en localStorage.
 */

(function () {
  const CACHE_KEY = "monou_games_v1";
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

  function applyGames(games) {
    if (!Array.isArray(games)) return;
    const lang = currentLang();
    games.forEach(game => {
      if (!game || !game.slug) return;
      const cards = document.querySelectorAll(`[data-game-slug="${game.slug}"]`);
      cards.forEach(card => updateCard(card, game, lang));
    });
  }

  function updateCard(card, game, lang) {
    // Title
    const titleEl = card.querySelector('[data-game-field="title"]');
    if (titleEl && game.title) titleEl.textContent = game.title;

    // Description
    const descEl = card.querySelector('[data-game-field="description"]');
    if (descEl) {
      if (game.description_es) descEl.setAttribute("data-es", game.description_es);
      if (game.description_en) descEl.setAttribute("data-en", game.description_en);
      const text = (lang === "en" ? game.description_en : game.description_es)
                  || game.description_es || game.description_en;
      if (text) descEl.textContent = text;
    }

    // Tags (por índice)
    const tagEls = card.querySelectorAll('[data-game-field="tag"]');
    tagEls.forEach(tag => {
      const idx = parseInt(tag.dataset.tagIndex || "0", 10);
      const tagEs = game.tags_es && game.tags_es[idx];
      const tagEn = game.tags_en && game.tags_en[idx];
      if (tagEs) tag.setAttribute("data-es", tagEs);
      if (tagEn) tag.setAttribute("data-en", tagEn);
      const text = (lang === "en" ? tagEn : tagEs) || tagEs || tagEn;
      if (text) tag.textContent = text;
    });

    // Image
    const imgEl = card.querySelector('[data-game-field="image"]');
    if (imgEl && game.image_url) {
      imgEl.setAttribute("src", game.image_url);
      imgEl.setAttribute("alt", game.title || "");
    }
  }

  function loadFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached || !Array.isArray(cached.games)) return false;
      applyGames(cached.games);
      return Date.now() - (cached.t || 0) < CACHE_TTL_MS;
    } catch (e) { return false; }
  }

  function saveCache(games) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), games }));
    } catch (e) {}
  }

  async function loadFresh(apiBase) {
    try {
      const url = `${apiBase}/api/games?_t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const games = (json && json.games) || [];
      if (games.length) {
        applyGames(games);
        saveCache(games);
      }
    } catch (err) {
      console.warn("[games-loader] fetch falló:", err.message);
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
