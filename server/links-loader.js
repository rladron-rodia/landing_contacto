/**
 * links-loader.js — Aplica configuración de site_links (URLs e imágenes
 * de elementos específicos del HTML) desde el backend.
 *
 * Estructura esperada del HTML:
 *
 *   Cualquier elemento con `data-link-key="..."` se identifica como un
 *   target. Dentro de él (o el propio elemento) se buscan:
 *
 *     - [data-link-field="cta"]    → se envuelve / hace clickable a la URL
 *     - [data-link-field="image"]  → se actualiza el src de un <img>
 *                                    (o se inyecta uno reemplazando un <i>)
 *
 * Caché 5min en localStorage. Si el backend falla, queda lo del HTML.
 */

(function () {
  const CACHE_KEY = "monou_site_links_v1";
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

  function applyLinks(links) {
    if (!Array.isArray(links)) return;
    links.forEach(link => {
      if (!link || !link.key) return;
      const containers = document.querySelectorAll(`[data-link-key="${link.key}"]`);
      containers.forEach(container => updateLinkContainer(container, link));
    });
  }

  function updateLinkContainer(container, link) {
    // 1. Imagen — busca elemento con data-link-field="image" o un <i> dentro
    if (link.image_url) {
      let imgEl = container.querySelector('[data-link-field="image"]');
      if (!imgEl) {
        // Buscar contenedor candidato: aspect-* div con un <i> dentro
        const iconHost = container.querySelector('.aspect-square, .aspect-video, [class*="aspect"], [class*="rounded-2xl"]:has(i.fa-solid)');
        if (iconHost) {
          iconHost.innerHTML = "";
          imgEl = document.createElement("img");
          imgEl.setAttribute("data-link-field", "image");
          imgEl.className = "w-full h-full object-cover rounded-2xl";
          iconHost.appendChild(imgEl);
        }
      }
      if (imgEl) {
        imgEl.setAttribute("src", link.image_url);
        imgEl.setAttribute("alt", link.label_es || link.label_en || link.key || "");
      }
    }

    // 2. CTA / link — busca [data-link-field="cta"] o aplica al container completo
    if (link.url) {
      const ctaEl = container.querySelector('[data-link-field="cta"]') || container;
      ctaEl.classList.add("cursor-pointer");
      ctaEl.dataset.linkUrl = link.url;
      ctaEl.onclick = (e) => {
        // Evitar disparar si el click viene de otro link/botón anidado
        if (e.target !== ctaEl && e.target.closest('a[href], button')) return;
        window.open(link.url, "_blank", "noopener,noreferrer");
      };
    }

    // 3. Labels (opcional) — actualiza data-es / data-en si vienen del backend
    if (link.label_es || link.label_en) {
      const labelEls = container.querySelectorAll('[data-link-field="label"]');
      const lang = (document.documentElement.lang || "es").toLowerCase().slice(0, 2);
      labelEls.forEach(el => {
        if (link.label_es) el.setAttribute("data-es", link.label_es);
        if (link.label_en) el.setAttribute("data-en", link.label_en);
        const text = (lang === "en" ? link.label_en : link.label_es)
                  || link.label_es || link.label_en;
        if (text) el.textContent = text;
      });
    }
  }

  function loadFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached || !Array.isArray(cached.links)) return false;
      applyLinks(cached.links);
      return Date.now() - (cached.t || 0) < CACHE_TTL_MS;
    } catch (e) { return false; }
  }

  function saveCache(links) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), links }));
    } catch (e) {}
  }

  async function loadFresh(apiBase) {
    try {
      const url = `${apiBase}/api/site-links?_t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const links = (json && json.links) || [];
      if (links.length) {
        applyLinks(links);
        saveCache(links);
      }
    } catch (err) {
      console.warn("[links-loader] fetch falló:", err.message);
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
