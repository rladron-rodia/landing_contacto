/**
 * server/cms-landing-loader.js
 *
 * Único loader del landing monoulabs.ai (v8+).
 * Pega al backend de platform-deploy para hidratar en runtime:
 *   - KPIs del hero (live-metrics)
 *   - Categorías F2P del carrusel con juegos+thumbnails
 *   - Delivery options
 *   - Info columns (Dataset Intelligence)
 *   - Site links (footer)
 *
 * Backend: configurable via <meta name="api-base" content="https://..."> en el head.
 *   - default staging: https://staging.internal.monou.gg
 *   - prod:            https://internal.monou.gg
 *
 * Markers del HTML que este script busca y rellena:
 *   data-live-metric="sessions_total"      → inner text con el valor del endpoint
 *   data-category-slug="carreras"          → se actualiza color, orden, sessions, hours, games wall
 *   data-category-field="sessions"         → inner text con cached_sessions formateado
 *   data-info-column (TODO)
 *   data-delivery-list                      (TODO)
 */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────────────
  var meta = document.querySelector('meta[name="api-base"]');
  var API_BASE = (meta && meta.content) || 'https://staging.internal.monou.gg';
  API_BASE = API_BASE.replace(/\/+$/, '');
  var CD = API_BASE + '/api/public/cms-landing';

  // ─── Utils ────────────────────────────────────────────────────────────
  function fmt(n) {
    if (n === null || n === undefined) return null;
    if (typeof n === 'string') n = parseFloat(n);
    if (!isFinite(n)) return null;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/,'') + 'M+';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K+';
    return String(n);
  }
  function fmtHours(h) {
    if (h === null || h === undefined) return null;
    h = parseFloat(h);
    if (!isFinite(h)) return null;
    if (h >= 1000) return (h / 1000).toFixed(1).replace(/\.0$/,'') + 'K h';
    return Math.round(h) + ' h';
  }
  function text(el, v) {
    if (el && v !== null && v !== undefined && v !== '') el.textContent = String(v);
  }
  function get(url) {
    return fetch(url, { credentials: 'omit', mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.json();
      });
  }

  // ─── Live metrics hero ────────────────────────────────────────────────
  function loadLiveMetrics() {
    get(CD + '/live-metrics').then(function (data) {
      var m = (data && data.metrics) || {};
      document.querySelectorAll('[data-live-metric]').forEach(function (el) {
        var key = el.getAttribute('data-live-metric');
        var val = m[key];
        if (val === null || val === undefined) return;
        // if numeric, format; otherwise use raw (admin value_text like "330K+")
        var formatted = (typeof val === 'number') ? fmt(val) : val;
        text(el, formatted);
      });
    }).catch(function () { /* silent — fallback already in markup */ });
  }

  // ─── Categorías + wall de juegos ──────────────────────────────────────
  function loadCategorias() {
    get(CD + '/categorias-with-games').then(function (data) {
      var cats = (data && data.categorias) || [];
      cats.forEach(function (c) {
        document.querySelectorAll('[data-category-slug="' + c.slug + '"]').forEach(function (card) {
          // sessions / hours / games_count
          card.querySelectorAll('[data-category-field="sessions"]').forEach(function (el) {
            text(el, fmt(c.cached_sessions));
          });
          card.querySelectorAll('[data-category-field="hours"]').forEach(function (el) {
            text(el, fmtHours(c.cached_hours));
          });
          card.querySelectorAll('[data-category-field="games_count"]').forEach(function (el) {
            text(el, c.cached_games !== null ? c.cached_games : null);
          });
          // title override
          card.querySelectorAll('[data-category-field="title"]').forEach(function (el) {
            if (c.title_es) el.setAttribute('data-es', c.title_es);
            if (c.title_en) el.setAttribute('data-en', c.title_en);
            // only update visible text if page is in matching lang
            var curr = document.documentElement.lang || 'es';
            text(el, curr === 'en' ? c.title_en : c.title_es);
          });
          // wall of games: swap FA icons with real thumbnails when available
          var wall = card.querySelector('.game-wall[data-category-slug-wall="' + c.slug + '"]');
          if (wall && Array.isArray(c.games) && c.games.length) {
            var slots = wall.querySelectorAll('.game-tile');
            c.games.slice(0, slots.length).forEach(function (g, i) {
              var slot = slots[i];
              if (!g.thumbnail_url || !slot) return;
              // replace icon with <img>
              slot.innerHTML = '';
              var img = document.createElement('img');
              img.src = g.thumbnail_url;
              img.alt = g.title || g.slug;
              img.loading = 'lazy';
              img.decoding = 'async';
              slot.appendChild(img);
            });
          }
        });
      });
    }).catch(function () { /* silent — fallback FA icons stay */ });
  }

  // ─── Site links (footer + CTAs) ───────────────────────────────────────
  function loadSiteLinks() {
    get(CD + '/site-links').then(function (data) {
      var links = (data && data.links) || [];
      links.forEach(function (l) {
        document.querySelectorAll('[data-link-key="' + l.key + '"]').forEach(function (a) {
          if (l.url && a.tagName === 'A') a.setAttribute('href', l.url);
          if (l.external) a.setAttribute('target', '_blank');
          var labelEl = a.querySelector('[data-link-field="label"]');
          var target = labelEl || a;
          if (l.label_es) target.setAttribute('data-es', l.label_es);
          if (l.label_en) target.setAttribute('data-en', l.label_en);
          var curr = document.documentElement.lang || 'es';
          if ((curr === 'en' ? l.label_en : l.label_es) && target === a) {
            // skip overwriting if the <a> has children
          }
        });
      });
    }).catch(function () {});
  }

  // ─── Form de contacto → POST al backend CMS Landing ───────────────────
  function wireContactForm() {
    var form = document.getElementById('ixmppy');
    if (!form) return;

    // Localiza elementos del form (si no están, bail silencioso)
    var submitBtn = form.querySelector('button[type="submit"]');
    var helpText  = document.getElementById('contacto-form-help');

    form.setAttribute('action', 'javascript:void(0)');
    form.setAttribute('novalidate', 'novalidate');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (submitBtn) submitBtn.disabled = true;
      if (helpText) helpText.textContent = 'Enviando…';

      // Lee campos tolerando IDs/nombres que puedan variar
      function val(key) {
        var el = form.querySelector('[name="' + key + '"]') || form.querySelector('#contact-' + key);
        return el ? (el.value || '').trim() : '';
      }

      var payload = {
        nombre:   val('nombre'),
        email:    val('email'),
        empresa:  val('empresa'),
        caso_uso: val('caso_uso'),
        mensaje:  val('mensaje'),
        lang:     document.documentElement.lang || 'es',
        website:  val('website'),      // honeypot
      };

      // utm_* desde la URL si vienen
      try {
        var params = new URLSearchParams(window.location.search);
        ['utm_source','utm_medium','utm_campaign'].forEach(function (k) {
          var v = params.get(k);
          if (v) payload[k] = v;
        });
      } catch (_e) {}

      fetch(CD + '/contact', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
        })
        .then(function (r) {
          if (r.ok) {
            form.reset();
            if (helpText) helpText.textContent = (payload.lang === 'en')
              ? '✓ Request received. We reply within 24 hours.'
              : '✓ Solicitud recibida. Respondemos en menos de 24 horas.';
            try { if (window.gtag) window.gtag('event', 'cms_landing_contact_submit', { ok: true }); } catch (_e) {}
          } else {
            if (helpText) helpText.textContent = (payload.lang === 'en')
              ? 'Error. Please try again later.'
              : 'Error al enviar. Intenta de nuevo en unos momentos.';
            try { if (window.gtag) window.gtag('event', 'cms_landing_contact_submit', { ok: false, status: r.status }); } catch (_e) {}
          }
        })
        .catch(function () {
          if (helpText) helpText.textContent = (document.documentElement.lang === 'en')
            ? 'Network error. Please try again.'
            : 'Error de red. Intenta de nuevo.';
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────
  function boot() {
    loadLiveMetrics();
    loadCategorias();
    loadSiteLinks();
    wireContactForm();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
