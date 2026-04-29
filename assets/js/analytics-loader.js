/**
 * analytics-loader.js (v2.2.0) — Inyecta GA4 / GTM dinámicamente y bindea
 * eventos custom a los CTAs configurados desde el admin.
 *
 * Flujo:
 *   1. Fetch /api/analytics-config (GA4 ID + GTM ID + toggles)
 *   2. Si ga4_enabled → inyecta gtag.js + dispara config
 *   3. Si gtm_enabled → inyecta el container de GTM (head + body noscript)
 *   4. Fetch /api/cta-tags (lista de CTAs activos)
 *   5. Para cada tag: bindea click/submit/view al selector → push a dataLayer
 *
 * Caché localStorage 5min para reducir round-trips. Si el backend falla,
 * el sitio sigue funcionando sin tracking (degradación elegante).
 *
 * No depende de loaders previos — corre con `defer` desde el head.
 */

(function () {
  const CONFIG_CACHE_KEY = "monou_analytics_config_v1";
  const TAGS_CACHE_KEY   = "monou_cta_tags_v1";
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

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.t > CACHE_TTL_MS) return null;
      return obj.v;
    } catch (_) { return null; }
  }
  function writeCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); }
    catch (_) {}
  }

  // ─────────────────────────────────────────────────────────────────
  //  GA4 (gtag.js) injection
  // ─────────────────────────────────────────────────────────────────
  function injectGA4(measurementId) {
    if (!measurementId || !/^G-/i.test(measurementId)) return;
    if (window.__monouGA4Loaded) return;
    window.__monouGA4Loaded = true;

    // Stub gtag antes de que gtag.js cargue (Google lo recomienda)
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag("js", new Date());
    gtag("config", measurementId, { anonymize_ip: true, send_page_view: true });

    // Cargar el script async (no bloquea render)
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(s);
  }

  // ─────────────────────────────────────────────────────────────────
  //  GTM (Tag Manager) injection — head snippet + body noscript
  // ─────────────────────────────────────────────────────────────────
  function injectGTM(containerId) {
    if (!containerId || !/^GTM-/i.test(containerId)) return;
    if (window.__monouGTMLoaded) return;
    window.__monouGTMLoaded = true;

    // Head snippet (inicializa dataLayer y carga gtm.js async)
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
    document.head.appendChild(s);

    // Body noscript fallback (para usuarios sin JS — opcional pero estándar de GTM)
    if (document.body) {
      const ns = document.createElement("noscript");
      const ifr = document.createElement("iframe");
      ifr.src = `https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(containerId)}`;
      ifr.height = 0; ifr.width = 0; ifr.style.cssText = "display:none;visibility:hidden";
      ns.appendChild(ifr);
      document.body.insertBefore(ns, document.body.firstChild);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  CTA event binding
  // ─────────────────────────────────────────────────────────────────
  function pushDataLayer(payload) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
  }

  function bindCTATag(tag) {
    if (!tag || !tag.selector) return 0;
    let nodes = [];
    try { nodes = document.querySelectorAll(tag.selector); }
    catch (e) {
      console.warn("[analytics] selector inválido:", tag.cta_key, tag.selector, e);
      return 0;
    }
    if (!nodes.length) return 0;

    nodes.forEach(node => {
      // Evitar binds duplicados si el loader corre 2 veces
      if (node.dataset.monouCtaBound === tag.cta_key) return;
      node.dataset.monouCtaBound = tag.cta_key;

      // Si el selector matchea un <form>, escuchar 'submit' en lugar de 'click'
      const isForm = node.tagName === "FORM" || tag.event_name === "form_submit";
      const eventType = isForm ? "submit" : "click";

      node.addEventListener(eventType, function (e) {
        const payload = {
          event:           tag.event_name || "cta_click",
          event_category:  tag.event_category || "engagement",
          event_label:     tag.event_label || tag.cta_key,
          cta_key:         tag.cta_key,
          // Texto visible del CTA (truncado a 100 chars)
          cta_text: (node.innerText || node.value || "").trim().slice(0, 100),
          // URL destino (si es <a>)
          cta_href: node.href || null,
          // Sección padre más cercana
          cta_section: (node.closest("section[id]") || {}).id || null,
        };
        pushDataLayer(payload);
        // GA4 directo si está cargado (gtag enviará automáticamente al GA4 conectado)
        if (typeof window.gtag === "function") {
          window.gtag("event", payload.event, {
            event_category: payload.event_category,
            event_label:    payload.event_label,
            cta_key:        payload.cta_key,
            cta_section:    payload.cta_section,
          });
        }
      }, { passive: true });
    });

    return nodes.length;
  }

  function bindAllTags(tags) {
    if (!Array.isArray(tags)) return;
    let total = 0, bound = 0;
    tags.forEach(t => {
      total++;
      const n = bindCTATag(t);
      if (n > 0) bound++;
    });
    if (window.__monouAnalyticsDebug) {
      console.log(`[analytics] CTAs bindeados: ${bound}/${total}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  Boot
  // ─────────────────────────────────────────────────────────────────
  async function boot() {
    const apiBase = resolveApiBase();

    // Config (GA4/GTM IDs) — se aplica ASAP para no perder eventos del page_view
    let config = readCache(CONFIG_CACHE_KEY);
    if (!config) {
      try {
        const r = await fetch(`${apiBase}/api/analytics-config?_t=${Date.now()}`, { cache: "no-store" });
        const data = await r.json();
        if (data && data.ok && data.config) {
          config = data.config;
          writeCache(CONFIG_CACHE_KEY, config);
        }
      } catch (e) {
        if (window.__monouAnalyticsDebug) console.warn("[analytics] error fetch config:", e);
      }
    }
    if (config) {
      if (config.ga4_enabled && config.ga4_measurement_id) injectGA4(config.ga4_measurement_id);
      if (config.gtm_enabled && config.gtm_container_id)   injectGTM(config.gtm_container_id);
    }

    // CTAs — se bindean cuando el DOM está listo
    const applyTags = async () => {
      let tags = readCache(TAGS_CACHE_KEY);
      if (!tags) {
        try {
          const r = await fetch(`${apiBase}/api/cta-tags?_t=${Date.now()}`, { cache: "no-store" });
          const data = await r.json();
          if (data && data.ok && Array.isArray(data.tags)) {
            tags = data.tags;
            writeCache(TAGS_CACHE_KEY, tags);
          }
        } catch (e) {
          if (window.__monouAnalyticsDebug) console.warn("[analytics] error fetch tags:", e);
        }
      }
      if (tags) bindAllTags(tags);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", applyTags, { once: true });
    } else {
      applyTags();
    }
  }

  // Activar logs de diagnóstico con: localStorage.setItem("monouAnalyticsDebug","1")
  if (localStorage.getItem("monouAnalyticsDebug") === "1") {
    window.__monouAnalyticsDebug = true;
  }

  boot();
})();
