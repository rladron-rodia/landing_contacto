/**
 * contact-form.js
 *
 * Conecta el formulario del frame "ixmppy" (sección #contacto) con el backend
 * Flask que envía el correo vía SMTP de Gmail.
 *
 * Cómo usar en el HTML:
 *   1) Asegúrate de que tu <form> tenga id="ixmppy" o reemplaza el selector.
 *   2) Asegúrate de que cada <input>/<select>/<textarea> tenga el atributo
 *      name="..." correspondiente:
 *         - name="nombre"
 *         - name="email"
 *         - name="empresa"
 *         - name="caso_uso"
 *         - name="mensaje"
 *      (Opcional) un input oculto name="website" como honeypot anti-bot.
 *   3) Antes de </body> añade:
 *         <script src="server/contact-form.js" defer></script>
 *
 * Configuración: cambia API_URL si el backend corre en otro host/puerto.
 */

(function () {
  const API_URL = window.MONOU_API_URL || "http://localhost:5000/api/contact";
  const FORM_SELECTOR = "#ixmppy, form#ixmppy, [data-form='ixmppy']";

  function findForm() {
    // 1) Por id/selector explícito
    let form = document.querySelector(FORM_SELECTOR);
    if (form && form.tagName === "FORM") return form;

    // 2) Fallback: el primer form dentro de la sección de contacto
    const contactSection =
      document.getElementById("contacto") ||
      document.getElementById("contact") ||
      document.querySelector("[data-section='contacto']");
    if (contactSection) {
      form = contactSection.querySelector("form");
      if (form) return form;
    }

    // 3) Último recurso: el primer form de la página
    return document.querySelector("form");
  }

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

  function getValueByNameOrIndex(form, name, fallbackIndex) {
    const byName = form.querySelector(`[name="${name}"]`);
    if (byName) return byName.value || "";
    // Fallback por orden de aparición si los inputs no tienen name
    const fields = form.querySelectorAll("input, select, textarea");
    return fields[fallbackIndex] ? fields[fallbackIndex].value || "" : "";
  }

  function collect(form) {
    return {
      nombre: getValueByNameOrIndex(form, "nombre", 0).trim(),
      email: getValueByNameOrIndex(form, "email", 1).trim(),
      empresa: getValueByNameOrIndex(form, "empresa", 2).trim(),
      caso_uso: getValueByNameOrIndex(form, "caso_uso", 3).trim(),
      mensaje: getValueByNameOrIndex(form, "mensaje", 4).trim(),
      website: getValueByNameOrIndex(form, "website", 99).trim(), // honeypot
    };
  }

  function init() {
    const form = findForm();
    if (!form) {
      console.warn("[contact-form] No se encontró el formulario.");
      return;
    }

    // Evita el envío nativo a mailto:
    form.setAttribute("action", "javascript:void(0)");
    form.setAttribute("method", "POST");

    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      const data = collect(form);

      if (!data.nombre || !data.email) {
        setStatus(form, "Por favor completa nombre y email.", "error");
        return;
      }

      const submitBtn = form.querySelector('button[type="submit"], button:not([type])');
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

        if (!res.ok || !json.ok) {
          throw new Error(json.error || `Error HTTP ${res.status}`);
        }

        setStatus(form, "¡Gracias! Tu solicitud fue enviada correctamente.", "ok");
        form.reset();
      } catch (err) {
        console.error("[contact-form] Error:", err);
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
