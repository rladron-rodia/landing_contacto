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
    return "https://api.monoulabs.ai";
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
    reorderCards(games);
  }

  // Reordena las cards del DOM según el `display_order` que viene del admin.
  // Antes el HTML tenía las cards en posiciones fijas y el JS solo parchaba
  // su contenido, así que mover un juego en el admin no se reflejaba en la
  // landing. Ahora reposicionamos físicamente cada card.
  //
  // Maneja 3 layouts:
  //   - Desktop F2P (#carouselTrack): cards repartidas en N .carousel-item;
  //     hacemos flatten + redistribute (mismo número de cards por slide que
  //     había originalmente, asumiendo 3) para que el ordenamiento sea
  //     global, no solo intra-slide.
  //   - Mobile F2P (#ir9pjh) + Publishers (grid único): un solo contenedor
  //     con todas las cards; reordenamos sus hijos in-place y dejamos
  //     cualquier hijo sin data-game-slug (CTA "Ver catálogo") al final.
  function reorderCards(games) {
    if (!Array.isArray(games) || games.length === 0) return;

    const orderMap = new Map();
    games.forEach((g, idx) => {
      if (!g || !g.slug) return;
      const ord = (typeof g.display_order === "number") ? g.display_order : idx;
      orderMap.set(g.slug, ord);
    });

    const cardOrder = (card) => {
      const slug = card.getAttribute("data-game-slug");
      return orderMap.has(slug) ? orderMap.get(slug) : Number.POSITIVE_INFINITY;
    };

    // --- Desktop F2P carousel: flatten + redistribute ---------------------
    const carouselTrack = document.getElementById("carouselTrack");
    if (carouselTrack) {
      const gameSlides = Array.from(carouselTrack.querySelectorAll(".carousel-item"))
        .filter(s => s.querySelector("[data-game-slug]"));
      if (gameSlides.length > 0) {
        const allCards = [];
        gameSlides.forEach(slide => {
          Array.from(slide.querySelectorAll("[data-game-slug]"))
            .forEach(card => allCards.push(card));
        });
        // sort estable: respeta el orden previo para cards con el mismo `order`
        allCards.sort((a, b) => cardOrder(a) - cardOrder(b));
        const grids = gameSlides.map(s => s.querySelector(".grid") || s);
        // Usamos el número de cards del primer slide como capacidad (3 por slide
        // en la implementación actual). Si la API trae más cards de las que
        // caben (3 × N slides), las extra se acumulan en el último slide
        // — no rompe el layout pero el grid se ve apretado; aceptable.
        const firstGridCount = grids[0].querySelectorAll("[data-game-slug]").length || 3;
        allCards.forEach((card, idx) => {
          const slideIdx = Math.min(Math.floor(idx / firstGridCount), grids.length - 1);
          grids[slideIdx].appendChild(card);  // appendChild mueve el nodo, no lo clona
        });
      }
    }

    // --- Resto de contenedores con cards [data-game-slug] ----------------
    // Agrupamos por parentElement. Si el parent ya está dentro de
    // #carouselTrack saltamos (ya lo procesamos arriba).
    const allOtherCards = Array.from(document.querySelectorAll("[data-game-slug]"))
      .filter(c => !c.closest("#carouselTrack"));
    const byParent = new Map();
    allOtherCards.forEach(card => {
      const p = card.parentElement;
      if (!p) return;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(card);
    });
    byParent.forEach((cards, parent) => {
      if (cards.length < 2) return;  // nada que reordenar
      const sorted = cards.slice().sort((a, b) => cardOrder(a) - cardOrder(b));
      // Determinamos punto de anclaje: el primer hijo del parent que NO sea
      // una card de juego. Las cards ordenadas se insertan antes de él,
      // preservando cualquier CTA o elemento extra al final.
      const firstNonGame = Array.from(parent.children)
        .find(c => !c.hasAttribute("data-game-slug")) || null;
      sorted.forEach(card => {
        if (firstNonGame) {
          parent.insertBefore(card, firstNonGame);
        } else {
          parent.appendChild(card);
        }
      });
    });
  }

  function updateCard(card, game, lang) {
    // Title (con i18n: actualiza data-es/data-en y textContent según el idioma)
    const titleEl = card.querySelector('[data-game-field="title"]');
    if (titleEl) {
      const tEs = game.title_es || game.title;
      const tEn = game.title_en || game.title;
      if (tEs) titleEl.setAttribute("data-es", tEs);
      if (tEn) titleEl.setAttribute("data-en", tEn);
      const text = (lang === "en" ? tEn : tEs) || game.title;
      if (text) titleEl.textContent = text;
    }

    // Description
    const descEl = card.querySelector('[data-game-field="description"]');
    if (descEl) {
      if (game.description_es) descEl.setAttribute("data-es", game.description_es);
      if (game.description_en) descEl.setAttribute("data-en", game.description_en);
      const text = (lang === "en" ? game.description_en : game.description_es)
                  || game.description_es || game.description_en;
      if (text) descEl.textContent = text;
    }

    // Tags — sincronizamos el número de <span> con el número de tags que
    // vienen de la API. Antes la card tenía hardcodeados 2 spans y el JS
    // solo actualizaba los existentes, así que el admin podía guardar 3+
    // tags pero la landing solo mostraba 2. Ahora creamos/eliminamos
    // dinámicamente para que aparezcan todos los que se configuren.
    const existingTagEls = Array.from(card.querySelectorAll('[data-game-field="tag"]'));
    const tagsEs = Array.isArray(game.tags_es) ? game.tags_es : [];
    const tagsEn = Array.isArray(game.tags_en) ? game.tags_en : [];
    const tagCount = Math.max(tagsEs.length, tagsEn.length);

    if (tagCount > 0) {
      // Localizar el contenedor: el padre del primer span de tag.
      // Si no existen spans aún (cards sin fallback hardcodeado), buscamos
      // un contenedor opcional marcado con data-game-field="tags".
      let container = existingTagEls.length > 0 ? existingTagEls[0].parentElement : null;
      if (!container) container = card.querySelector('[data-game-field="tags"]');

      if (container) {
        // flex-wrap para que >2 tags no rompan la card mobile (w-64).
        if (tagCount > 2 && !container.classList.contains("flex-wrap")) {
          container.classList.add("flex-wrap", "gap-y-1");
        }

        // Plantilla de className: heredamos del primer span existente para
        // mantener el look-and-feel; si no hay ninguno, usamos el default.
        const tagClassName = existingTagEls[0]
          ? existingTagEls[0].className
          : "px-2 py-1 bg-dark-800 rounded text-gray-400";

        for (let i = 0; i < tagCount; i++) {
          let tag = existingTagEls[i];
          if (!tag) {
            tag = document.createElement("span");
            tag.setAttribute("data-game-field", "tag");
            tag.className = tagClassName;
            container.appendChild(tag);
          }
          tag.setAttribute("data-tag-index", String(i));
          const tagEs = tagsEs[i];
          const tagEn = tagsEn[i];
          if (tagEs) tag.setAttribute("data-es", tagEs);
          if (tagEn) tag.setAttribute("data-en", tagEn);
          const text = (lang === "en" ? tagEn : tagEs) || tagEs || tagEn;
          if (text) tag.textContent = text;
        }

        // Eliminar los spans sobrantes si la API devuelve menos tags
        // que los que había hardcodeados en el HTML.
        for (let i = tagCount; i < existingTagEls.length; i++) {
          existingTagEls[i].remove();
        }
      }
    }

    // Image — algunas cards solo tienen un <i> icon, sin <img>. Si llega
    // una image_url y no hay <img> aún, lo creamos dentro del contenedor
    // aspect-video o aspect-square (Publishers usa cuadrado).
    //
    // v2.7.0: si game.image_webp_url existe, montamos un <picture> con
    // <source type="image/webp"> + <img> fallback PNG. Si solo hay PNG
    // (data legacy), montamos <img> simple como antes (backwards compat).
    if (game.image_url) {
      const altText = game.title_es || game.title_en || game.title || "";
      const container = card.querySelector('.aspect-video, .aspect-square');
      let imgEl = card.querySelector('[data-game-field="image"]');

      if (game.image_webp_url && container) {
        // Render con <picture> (WebP source + PNG fallback en <img>)
        container.innerHTML = "";
        const pic = document.createElement("picture");
        const source = document.createElement("source");
        source.setAttribute("srcset", game.image_webp_url);
        source.setAttribute("type", "image/webp");
        pic.appendChild(source);
        imgEl = document.createElement("img");
        imgEl.setAttribute("data-game-field", "image");
        imgEl.setAttribute("src", game.image_url);
        imgEl.setAttribute("alt", altText);
        imgEl.setAttribute("loading", "lazy");
        imgEl.setAttribute("decoding", "async");
        imgEl.className = "w-full h-full object-cover";
        pic.appendChild(imgEl);
        container.appendChild(pic);
      } else {
        // Legacy: <img> simple (data sin WebP)
        if (!imgEl && container) {
          container.innerHTML = "";
          imgEl = document.createElement("img");
          imgEl.setAttribute("data-game-field", "image");
          imgEl.className = "w-full h-full object-cover";
          container.appendChild(imgEl);
        }
        if (imgEl) {
          imgEl.setAttribute("src", game.image_url);
          imgEl.setAttribute("alt", altText);
        }
      }
    }

    // Link — si la card tiene link_url, hacerla clickable. Abrimos en otra
    // pestaña para no perder al usuario en la landing.
    if (game.link_url) {
      card.classList.add("cursor-pointer");
      card.dataset.gameLinkUrl = game.link_url;
      card.onclick = (e) => {
        // No navegar si el click viene de un link interno o botón
        if (e.target.closest("a, button")) return;
        window.open(game.link_url, "_blank", "noopener,noreferrer");
      };
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
