/**
 * contact-form.js — Blindaje de integración SMTP independiente del HTML.
 *
 * Este script se conecta al formulario de contacto y lo enruta al backend
 * SMTP, SIN depender de detalles concretos del marcado. Sobrevive a:
 *
 *   - Cambios visuales en la landing (clases, layout, colores)
 *   - Re-exports desde herramientas como Framer/Webflow que pisan ids/names
 *   - Eliminación accidental del atributo `action="javascript:void(0)"`
 *     (lo reimpone en cada submit, para que jamás caiga al `mailto:` viejo)
 *   - Inyección dinámica del formulario tras la carga (MutationObserver)
 *
 * Único requisito mínimo del HTML: que exista un `<form>` con al menos un
 * input de tipo email y un botón de submit. Todo lo demás se autodetecta.
 *
 * Configuración:
 *   - <meta name="api-url" content="https://...">  (override explícito)
 *   - window.MONOU_API_URL = "..."                (override en runtime)
 *   - Auto: localhost → http://localhost:5000/api/contact
 *           prod      → https://landing-contacto-backend.onrender.com/api/contact
 */

(function () {
  // ---------- 1. Resolución de URL del backend ----------
  function resolveApiUrl() {
    if (window.MONOU_API_URL) return window.MONOU_API_URL;
    const meta = document.querySelector('meta[name="api-url"]');
    if (meta && meta.content) return meta.content.trim();
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "") {
      return "http://localhost:5000/api/contact";
    }
    return "https://landing-contacto-backend.onrender.com/api/contact";
  }
  const API_URL = resolveApiUrl();

  // ---------- 2. Localización del formulario (con fallbacks) ----------
  function findForm() {
    // 2.1 ID/selector explícito
    const explicit = document.querySelector(
      "#ixmppy, form[data-form='ixmppy'], form[data-contact-form]"
    );
    if (explicit && explicit.tagName === "FORM") return explicit;

    // 2.2 Form dentro de la sección de contacto
    const section =
      document.getElementById("contacto") ||
      document.getElementById("contact") ||
      document.querySelector("[data-section='contacto']");
    if (section) {
      const f = section.querySelector("form");
      if (f) return f;
    }

    // 2.3 Cualquier form con botón "Enviar/Submit/Send"
    const forms = document.querySelectorAll("form");
    for (const f of forms) {
      const btn = f.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (btn) {
        const t = (btn.textContent || btn.value || "").toLowerCase();
        if (/(enviar|solicit|send|submit|contactar)/.test(t)) return f;
      }
    }

    // 2.4 Si hay UN único form en la página, ese es
    if (forms.length === 1) return forms[0];

    return null;
  }

  // ---------- 3. Localización de campos por heurística ----------
  function findField(form, kind) {
    // Preferencia 1: atributo name explícito
    const byName = form.querySelector(`[name="${kind}"]`);
    if (byName) return byName;

    const fields = form.querySelectorAll("input, select, textarea");
    const matches = (el, regex) => {
      const blob = [
        el.name, el.id, el.placeholder, el.getAttribute("aria-label"),
        // Texto de la <label> asociada
        (el.labels && el.labels[0] && el.labels[0].textContent) || "",
        // data-* (Framer suele añadir data-es / data-en)
        el.dataset.es || "", el.dataset.en || ""
      ].join(" ").toLowerCase();
      return regex.test(blob);
    };

    switch (kind) {
      case "nombre": {
        for (const el of fields) {
          if (el.tagName === "INPUT" && el.type === "text" &&
              matches(el, /(nombre|full name|first name)/)) return el;
        }
        // Primer text input del form
        return form.querySelector('input[type="text"]') || null;
      }
      case "email": {
        return form.querySelector('input[type="email"]') ||
               [...fields].find(el => matches(el, /(email|e-mail|correo)/)) || null;
      }
      case "empresa": {
        for (const el of fields) {
          if (el.tagName === "INPUT" && el.type === "text" &&
              matches(el, /(empresa|company|organi[sz]a)/)) return el;
        }
        return null;
      }
      case "caso_uso": {
        return form.querySelector("select") ||
               [...fields].find(el => matches(el, /(caso|use case|asunto|subject)/)) || null;
      }
      case "mensaje": {
        return form.querySelector("textarea") ||
               [...fields].find(el => matches(el, /(mensaje|message|comentario|comments)/)) || null;
      }
      case "website": {
        return form.querySelector('[name="website"]'); // honeypot
      }
    }
    return null;
  }

  function val(el) { return el ? (el.value || "").trim() : ""; }

  function collect(form) {
    return {
      nombre:   val(findField(form, "nombre")),
      email:    val(findField(form, "email")),
      empresa:  val(findField(form, "empresa")),
      caso_uso: val(findField(form, "caso_uso")),
      mensaje:  val(findField(form, "mensaje")),
      website:  val(findField(form, "website")),
    };
  }

  // ---------- 4. UI helpers ----------
  function setStatus(form, message, type) {
    let box = form.querySelector("[data-status]");
    if (!box) {
      box = document.createElement("p");
      box.setAttribute("data-status", "true");
      box.className = "text-sm text-center mt-3";
      form.appendChild(box);
    }
    box.textContent = message;
    box.style.color =
      type === "error" ? "#ef4444" : type === "ok" ? "#14b8a6" : "#9ca3af";
  }

  // ---------- 5. Bind del submit (idempotente) ----------
  function bind(form) {
    if (form.dataset.contactFormBound === "1") return;
    form.dataset.contactFormBound = "1";

    // Neutralizar action por si vuelve un mailto: tras un re-render
    form.setAttribute("method", "POST");
    if ((form.getAttribute("action") || "").toLowerCase().startsWith("mailto:") ||
        !form.getAttribute("action")) {
      form.setAttribute("action", "javascript:void(0)");
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      // Re-blindar action en cada submit por si algo lo modificó
      if ((form.getAttribute("action") || "").toLowerCase().startsWith("mailto:")) {
        form.setAttribute("action", "javascript:void(0)");
      }

      const data = collect(form);

      if (!data.nombre || !data.email) {
        setStatus(form, "Por favor completa nombre y email.", "error");
        return;
      }

      const submitBtn = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
      const originalLabel = submitBtn ? submitBtn.innerHTML : "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML =
          '<span>Enviando…</span> <i class="fa-solid fa-spinner fa-spin text-sm"></i>';
      }
      setStatus(form, "Enviando solicitud…", "info");

      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) throw new Error(json.error || `Error HTTP ${res.status}`);
        setStatus(form, "¡Gracias! Tu solicitud fue enviada correctamente.", "ok");
        form.reset();
      } catch (err) {
        console.error("[contact-form]", err);
        setStatus(
          form,
          "No se pudo enviar la solicitud. Intenta de nuevo o escríbenos directamente.",
          "error"
        );
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalLabel;
        }
      }
    });
  }

  function tryBind() {
    const form = findForm();
    if (form) bind(form);
    return !!form;
  }

  // ---------- 6. Init + observer para HTML que cambia en runtime ----------
  function init() {
    if (tryBind()) return;
    // Si aún no aparece el form (frameworks que renderizan asíncrono),
    // observa el DOM y reintenta cuando aparezca.
    const observer = new MutationObserver(() => {
      if (tryBind()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Por seguridad, deja de observar tras 30s
    setTimeout(() => observer.disconnect(), 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
