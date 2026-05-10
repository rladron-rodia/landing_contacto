/**
 * Admin dashboard de Monou.gg
 *
 * Dos vistas:
 *   - Contactos: lista los envíos del formulario (GET /api/contacts)
 *   - Estadísticas: CRUD de las cifras de la landing (GET/POST /api/admin/stats)
 *
 * Auto-detecta el backend (localhost vs producción) salvo override:
 *   ?api=https://...   o   <meta name="api-base" content="...">
 */

(function () {
  // ---------- Config ----------
  const API_BASE = (function () {
    const qp = new URLSearchParams(window.location.search).get("api");
    if (qp) return qp.replace(/\/$/, "");
    const meta = document.querySelector('meta[name="api-base"]');
    if (meta && meta.content) return meta.content.trim().replace(/\/$/, "");
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "") {
      return "http://localhost:5000";
    }
    return "https://api.monoulabs.ai";
  })();
  // ---------- DOM helpers ----------
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ---------- State ----------
  let allContacts   = [];
  let allStats      = [];
  let allGames      = [];
  let allPublishers = [];
  let allLinks      = [];
  let allDelivery   = [];
  let allInfoCols   = [];
  let currentView   = "contacts";

  // ---------- Token ----------
  // v3.2.0: sistema multi-usuario.
  // Auth ahora vive en cookies HttpOnly (no accesibles desde JS por diseño).
  // El JS solo conoce el user actual + permissions, populated por GET /api/auth/me
  // al boot. Cuando la cookie expira, /api/auth/me devuelve 401 → showLogin().
  let _currentUser = null;
  let _currentPermissions = {};

  const getCurrentUser = () => _currentUser;
  const getRole = () => (_currentUser && _currentUser.role) || null;
  const isAuthenticated = () => !!_currentUser;
  function hasPermission(resource, action) {
    if (!_currentUser) return false;
    const role = _currentUser.role;
    if (role === "super_admin" || role === "admin") return true;
    const p = _currentPermissions[resource] || {};
    return !!p[`can_${action}`];
  }
  function isRole(...roles) {
    return roles.includes(getRole());
  }

  // Legacy helpers (compat con código que aún las llama mientras migramos):
  const clearToken = () => { _currentUser = null; _currentPermissions = {}; };

  // ---------- Nav labels personalizables (persisten en localStorage) ----------
  const NAV_LABELS_KEY = "monou_nav_labels";

  function readNavLabels() {
    try { return JSON.parse(localStorage.getItem(NAV_LABELS_KEY) || "{}"); }
    catch (e) { return {}; }
  }

  function writeNavLabels(map) {
    try { localStorage.setItem(NAV_LABELS_KEY, JSON.stringify(map)); } catch (e) {}
  }

  function applySavedNavLabels() {
    const saved = readNavLabels();
    document.querySelectorAll(".nav-btn").forEach(btn => {
      const view = btn.dataset.view;
      const labelEl = btn.querySelector(".nav-label");
      if (!labelEl || !view) return;
      // Guardar el label por defecto (para poder restaurarlo)
      if (!btn.dataset.defaultLabel) {
        btn.dataset.defaultLabel = labelEl.textContent.trim();
      }
      if (saved[view]) labelEl.textContent = saved[view];
    });
  }

  function startNavLabelEdit(navBtn) {
    const labelEl = navBtn.querySelector(".nav-label");
    if (!labelEl) return;
    // Si ya hay un input editando, no hacer nada
    if (navBtn.querySelector("input.nav-label-input")) return;

    const view = navBtn.dataset.view;
    const current = labelEl.textContent.trim();
    const defaultLabel = navBtn.dataset.defaultLabel || current;

    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.maxLength = 40;
    input.className = "nav-label-input flex-1 bg-dark-900 border border-brand-500 rounded px-2 py-0.5 text-sm focus:outline-none";
    labelEl.replaceWith(input);
    // Pequeño hack: poner placeholder del default para que el user lo vea
    input.setAttribute("placeholder", defaultLabel);
    input.focus();
    input.select();

    let committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      const value = input.value.trim();
      const map = readNavLabels();
      let finalLabel;
      if (!value) {
        // Empty → reset al default
        delete map[view];
        finalLabel = defaultLabel;
      } else if (value === defaultLabel) {
        // Igual que default → quitar override
        delete map[view];
        finalLabel = defaultLabel;
      } else {
        map[view] = value;
        finalLabel = value;
      }
      writeNavLabels(map);

      const newSpan = document.createElement("span");
      newSpan.className = "nav-label flex-1 truncate";
      newSpan.textContent = finalLabel;
      input.replaceWith(newSpan);
    }

    function cancel() {
      if (committed) return;
      committed = true;
      const newSpan = document.createElement("span");
      newSpan.className = "nav-label flex-1 truncate";
      newSpan.textContent = current;
      input.replaceWith(newSpan);
    }

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    // Bloquea el click del botón mientras se edita
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  // ---------- Utilidades ----------
  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("es-MX", {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }

  // v3.2.0: auth via cookie HttpOnly. credentials:'include' manda la cookie
  // en cross-origin (admin en monoulabs.ai → API en api.monoulabs.ai).
  // Backend setea Access-Control-Allow-Credentials:true (CORS supports_credentials).
  async function api(method, path, body) {
    const opts = {
      method,
      credentials: "include",  // ← envía cookie monou_session cross-origin
      headers: {},
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (res.status === 401) { clearToken(); showLogin(); throw new Error("Sesión expirada"); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || json.reason || `HTTP ${res.status}`);
    }
    return json;
  }

  // ---------- Upload de archivos (multipart) ----------
  // Wrapper aparte de api() porque usa multipart/form-data en lugar de JSON.
  // No setea Content-Type — el browser lo hace automático con el boundary correcto.
  async function apiUpload(path, formData) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    if (res.status === 401) { clearToken(); showLogin(); throw new Error("Sesión expirada"); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json;
  }

  // ---------- Widget reutilizable de upload de imagen ----------
  // Bindea un widget compuesto (file picker + URL input + status + preview) a
  // /api/admin/upload-image. Usado por el modal de games y el de site-links.
  //
  // Args:
  //   fileSel     — selector del <input type="file">
  //   uploadBtn   — selector del botón "Subir archivo" que dispara el picker
  //   urlSel      — selector del <input type="url"> donde queda el png_url
  //   webpSel     — selector del <input type="hidden"> donde queda el webp_url
  //   statusSel   — selector del <p> donde se muestra estado/error
  //   previewSel  — selector del <img> de preview
  //   previewWrap — selector del wrapper del preview (toggle hidden)
  //   folder      — carpeta destino en S3 ("games" | "site-links")
  //   slugSource  — fn () => string, devuelve el slug actual del form
  //   maxW, maxH  — bounding box para optimización
  //   onSuccess   — fn(result), se llama después de actualizar inputs
  function bindImageUpload(opts) {
    const fileEl = $(opts.fileSel);
    const btnEl  = $(opts.uploadBtn);
    if (!fileEl || !btnEl) return;

    btnEl.addEventListener("click", () => fileEl.click());

    fileEl.addEventListener("change", async () => {
      const file = fileEl.files && fileEl.files[0];
      if (!file) return;

      // Validación cliente — defensa en profundidad (el backend ya valida).
      const MAX_BYTES = 15 * 1024 * 1024;
      if (file.size > MAX_BYTES) {
        showStatus(opts.statusSel,
          `Archivo demasiado grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Máximo 15 MB.`,
          "error");
        fileEl.value = "";
        return;
      }
      const acceptedTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
      if (file.type && !acceptedTypes.includes(file.type)) {
        showStatus(opts.statusSel,
          `Tipo no soportado: ${file.type}. Usa PNG, JPG o WebP.`,
          "error");
        fileEl.value = "";
        return;
      }

      // Construir query string con folder + slug + dims
      const slug = (opts.slugSource ? opts.slugSource() : "image") || "image";
      const params = new URLSearchParams({
        folder: opts.folder,
        slug:   slug,
        max_w:  String(opts.maxW || 800),
        max_h:  String(opts.maxH || 600),
      });

      const fd = new FormData();
      fd.append("file", file);

      showStatus(opts.statusSel,
        `Subiendo ${(file.size / 1024 / 1024).toFixed(1)} MB y optimizando...`,
        "loading");
      btnEl.disabled = true;

      try {
        const r = await apiUpload(`/api/admin/upload-image?${params}`, fd);
        // Actualizar inputs URL + WebP
        $(opts.urlSel).value  = r.png_url || "";
        $(opts.webpSel).value = r.webp_url || "";
        // Actualizar preview
        if (opts.previewSel && opts.previewWrap) {
          $(opts.previewSel).src = r.png_url || "";
          $(opts.previewWrap).classList.remove("hidden");
        }
        // Mensaje de éxito con métricas de ahorro
        const savedKB = ((r.original_size - (r.png_size + r.webp_size) / 2) / 1024).toFixed(0);
        showStatus(opts.statusSel,
          `✓ Subido. ${r.dimensions[0]}×${r.dimensions[1]}, ahorro ~${savedKB} KB. PNG + WebP en S3.`,
          "success");
        if (typeof opts.onSuccess === "function") opts.onSuccess(r);
      } catch (err) {
        showStatus(opts.statusSel, `Error: ${err.message}`, "error");
      } finally {
        btnEl.disabled = false;
        fileEl.value = ""; // permite re-subir el mismo archivo si quiere
      }
    });
  }

  // Helper para mostrar estado del widget de upload
  function showStatus(sel, text, kind) {
    const el = $(sel);
    if (!el) return;
    const colors = {
      loading: "text-gray-400",
      success: "text-green-400",
      error:   "text-red-400",
    };
    el.className = `text-xs mt-1 ${colors[kind] || "text-gray-400"}`;
    el.textContent = text;
    el.classList.remove("hidden");
  }

  // ---------- View routing ----------
  function showLogin(msg) {
    $("#login-view").classList.remove("hidden");
    $("#login-view").classList.add("flex");
    $("#bootstrap-view").classList.add("hidden");
    $("#app-view").classList.add("hidden");
    if (msg) {
      $("#login-error").textContent = msg;
      $("#login-error").classList.remove("hidden");
    } else {
      $("#login-error").classList.add("hidden");
    }
    const emailInp = $("#login-email");
    if (emailInp) emailInp.focus();
  }

  function showBootstrap(msg) {
    $("#bootstrap-view").classList.remove("hidden");
    $("#bootstrap-view").classList.add("flex");
    $("#login-view").classList.add("hidden");
    $("#app-view").classList.add("hidden");
    if (msg) {
      $("#bootstrap-error").textContent = msg;
      $("#bootstrap-error").classList.remove("hidden");
    } else {
      $("#bootstrap-error").classList.add("hidden");
    }
  }

  function showApp() {
    $("#login-view").classList.add("hidden");
    $("#bootstrap-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    $("#app-view").classList.add("flex");

    // v3.2.0: gating de la nav según role/permissions
    applyNavGating();

    // Render user info card en sidebar
    renderCurrentUserCard();

    // Default view: contacts si tiene read; sino la primera con read
    const initial = pickInitialView();
    selectView(initial);
  }

  function pickInitialView() {
    const candidates = ["contacts", "stats", "games", "publishers",
                        "links", "delivery", "info", "analytics"];
    const map = {
      contacts: "contacts", stats: "stats", games: "games_f2p",
      publishers: "games_publishers", links: "site_links",
      delivery: "delivery", info: "info_columns", analytics: "analytics",
    };
    for (const v of candidates) {
      if (hasPermission(map[v], "read")) return v;
    }
    // Si es super_admin/admin, fallback users
    if (isRole("super_admin", "admin")) return "users";
    return "contacts";
  }

  function applyNavGating() {
    // Map view → resource
    const map = {
      contacts: "contacts", stats: "stats", games: "games_f2p",
      publishers: "games_publishers", links: "site_links",
      delivery: "delivery", info: "info_columns", analytics: "analytics",
      users: "users",
    };
    $$(".nav-btn").forEach(btn => {
      const view = btn.dataset.view;
      const requiresRole = (btn.dataset.requiresRole || "").split(",").filter(Boolean);
      let visible;
      if (requiresRole.length) {
        visible = requiresRole.includes(getRole());
      } else {
        const resource = map[view] || view;
        visible = hasPermission(resource, "read");
      }
      btn.classList.toggle("hidden", !visible);
    });
  }

  function renderCurrentUserCard() {
    const card = $("#current-user-card");
    const u = getCurrentUser();
    if (!u || !card) return;
    card.classList.remove("hidden");
    $("#current-user-name").textContent = u.full_name || u.email;
    $("#current-user-role").textContent = u.role.replace("_", " ");
  }

  function selectView(name) {
    currentView = name;
    $$(".nav-btn").forEach(b => {
      b.classList.toggle("nav-item-active", b.dataset.view === name);
    });
    $("#contacts-view").classList.toggle("hidden", name !== "contacts");
    $("#stats-view").classList.toggle("hidden", name !== "stats");
    $("#games-view").classList.toggle("hidden", name !== "games");
    $("#publishers-view").classList.toggle("hidden", name !== "publishers");
    $("#links-view").classList.toggle("hidden", name !== "links");
    $("#delivery-view").classList.toggle("hidden", name !== "delivery");
    $("#info-view").classList.toggle("hidden", name !== "info");
    $("#analytics-view").classList.toggle("hidden", name !== "analytics");
    const usersView = $("#users-view");
    if (usersView) usersView.classList.toggle("hidden", name !== "users");
    if (name === "contacts")   loadContacts();
    if (name === "stats")      loadStats();
    if (name === "games")      loadGames();
    if (name === "publishers") loadPublishers();
    if (name === "links")      loadLinks();
    if (name === "delivery")   loadDelivery();
    if (name === "info")       loadInfoColumns();
    if (name === "analytics")  loadAnalytics();
    if (name === "users")      loadUsers();
  }

  // ============================================================
  //   CONTACTOS
  // ============================================================

  function statusTag(status) {
    const cls = status === "emailed" ? "tag-emailed"
              : status === "failed"  ? "tag-failed"
              : "tag-received";
    return `<span class="tag ${cls}">${escapeHtml(status || "received")}</span>`;
  }

  function renderContactRows() {
    const q = ($("#contacts-search").value || "").toLowerCase().trim();
    const status = $("#contacts-status-filter").value;
    const filtered = allContacts.filter(c => {
      if (status && c.status !== status) return false;
      if (!q) return true;
      const blob = `${c.nombre||""} ${c.email||""} ${c.empresa||""}`.toLowerCase();
      return blob.includes(q);
    });

    $("#contacts-count").textContent = `${filtered.length} de ${allContacts.length}`;

    if (!filtered.length) {
      $("#contacts-loading").classList.add("hidden");
      $("#contacts-error").classList.add("hidden");
      $("#contacts-table-wrap").classList.add("hidden");
      $("#contacts-empty").classList.remove("hidden");
      $("#contacts-empty").querySelector("p").textContent = allContacts.length
        ? "Ningún contacto coincide con el filtro."
        : "Aún no hay contactos.";
      return;
    }

    $("#contacts-tbody").innerHTML = filtered.map(c => `
      <tr class="hover:bg-white/5 cursor-pointer" data-id="${c.id}">
        <td class="px-4 py-3 text-gray-500">#${escapeHtml(c.id)}</td>
        <td class="px-4 py-3 text-gray-400 whitespace-nowrap">${fmtDate(c.created_at)}</td>
        <td class="px-4 py-3 font-medium">${escapeHtml(c.nombre || "—")}</td>
        <td class="px-4 py-3 text-brand-400">
          <a href="mailto:${escapeHtml(c.email)}" onclick="event.stopPropagation()" class="hover:underline">
            ${escapeHtml(c.email || "—")}
          </a>
        </td>
        <td class="px-4 py-3 text-gray-300">${escapeHtml(c.empresa || "—")}</td>
        <td class="px-4 py-3 text-gray-300">${escapeHtml(c.caso_uso || "—")}</td>
        <td class="px-4 py-3">${statusTag(c.status)}</td>
      </tr>
    `).join("");
    $("#contacts-loading").classList.add("hidden");
    $("#contacts-empty").classList.add("hidden");
    $("#contacts-error").classList.add("hidden");
    $("#contacts-table-wrap").classList.remove("hidden");
  }

  async function loadContacts() {
    $("#contacts-loading").classList.remove("hidden");
    $("#contacts-empty").classList.add("hidden");
    $("#contacts-error").classList.add("hidden");
    $("#contacts-table-wrap").classList.add("hidden");
    try {
      const json = await api("GET", "/api/contacts?limit=500");
      allContacts = json.contacts || [];
      renderContactRows();
    } catch (err) {
      if (err.message === "Token inválido") return showLogin(err.message);
      $("#contacts-error-msg").textContent = err.message;
      $("#contacts-loading").classList.add("hidden");
      $("#contacts-error").classList.remove("hidden");
    }
  }

  function renderContactDetail(c) {
    $("#contact-modal-body").innerHTML = `
      <dl class="grid grid-cols-3 gap-y-3 gap-x-4">
        <dt class="text-gray-500">ID</dt><dd class="col-span-2">#${escapeHtml(c.id)}</dd>
        <dt class="text-gray-500">Fecha</dt><dd class="col-span-2">${fmtDate(c.created_at)}</dd>
        <dt class="text-gray-500">Estado</dt><dd class="col-span-2">${statusTag(c.status)}</dd>
        <dt class="text-gray-500">Nombre</dt><dd class="col-span-2 font-medium">${escapeHtml(c.nombre || "—")}</dd>
        <dt class="text-gray-500">Email</dt><dd class="col-span-2 text-brand-400">${escapeHtml(c.email || "—")}</dd>
        <dt class="text-gray-500">Empresa</dt><dd class="col-span-2">${escapeHtml(c.empresa || "—")}</dd>
        <dt class="text-gray-500">Caso de uso</dt><dd class="col-span-2">${escapeHtml(c.caso_uso || "—")}</dd>
      </dl>
      <div>
        <p class="text-gray-500 text-xs uppercase mb-2">Mensaje</p>
        <p class="bg-dark-900 border border-white/10 rounded-lg p-4 whitespace-pre-wrap">${escapeHtml(c.mensaje || "(sin mensaje)")}</p>
      </div>
      ${c.error ? `
        <div>
          <p class="text-red-400 text-xs uppercase mb-2">Error de envío</p>
          <p class="bg-red-900/20 border border-red-500/30 rounded-lg p-4 text-xs font-mono whitespace-pre-wrap">${escapeHtml(c.error)}</p>
        </div>` : ""}
    `;
    openModal("#contact-modal");
  }

  function exportContactsCsv() {
    if (!allContacts.length) return;
    const cols = ["id","created_at","nombre","email","empresa","caso_uso","mensaje","status","error"];
    const escape = (v) => {
      const s = (v == null ? "" : String(v)).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = [cols.join(",")]
      .concat(allContacts.map(c => cols.map(k => escape(c[k])).join(",")))
      .join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `monou-contacts-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  //   ESTADÍSTICAS
  // ============================================================

  function renderStatsRows() {
    $("#stats-count").textContent = `${allStats.length}`;
    if (!allStats.length) {
      $("#stats-tbody").innerHTML = `
        <tr><td colspan="7" class="px-4 py-12 text-center text-gray-500">
          No hay estadísticas. Pulsa <strong>Nueva</strong> para crear la primera.
        </td></tr>`;
      $("#stats-loading").classList.add("hidden");
      $("#stats-error").classList.add("hidden");
      $("#stats-table-wrap").classList.remove("hidden");
      return;
    }

    $("#stats-tbody").innerHTML = allStats.map(s => `
      <tr class="hover:bg-white/5">
        <td class="px-4 py-3 text-gray-500">${escapeHtml(s.display_order ?? 0)}</td>
        <td class="px-4 py-3 font-mono text-brand-400 text-xs">${escapeHtml(s.key)}</td>
        <td class="px-4 py-3 text-2xl font-bold">${escapeHtml(s.value)}</td>
        <td class="px-4 py-3 text-gray-300">${escapeHtml(s.label_es || "—")}</td>
        <td class="px-4 py-3 text-gray-300">${escapeHtml(s.label_en || "—")}</td>
        <td class="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">${fmtDate(s.updated_at)}</td>
        <td class="px-4 py-3 text-right whitespace-nowrap">
          <button class="stat-edit text-gray-400 hover:text-brand-400 p-2" data-key="${escapeHtml(s.key)}" title="Editar">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="stat-delete text-gray-400 hover:text-red-400 p-2" data-key="${escapeHtml(s.key)}" title="Borrar">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      </tr>
    `).join("");
    $("#stats-loading").classList.add("hidden");
    $("#stats-error").classList.add("hidden");
    $("#stats-table-wrap").classList.remove("hidden");
  }

  async function loadStats() {
    $("#stats-loading").classList.remove("hidden");
    $("#stats-error").classList.add("hidden");
    $("#stats-table-wrap").classList.add("hidden");
    try {
      const json = await api("GET", "/api/admin/stats");
      allStats = json.stats || [];
      renderStatsRows();
    } catch (err) {
      if (err.message === "Token inválido") return showLogin(err.message);
      $("#stats-error-msg").textContent = err.message;
      $("#stats-loading").classList.add("hidden");
      $("#stats-error").classList.remove("hidden");
    }
  }

  function openStatModal(stat) {
    const isNew = !stat;
    $("#stat-modal-title").textContent = isNew ? "Nueva estadística" : "Editar estadística";
    $("#stat-form-error").classList.add("hidden");
    $("#stat-key").value         = stat ? stat.key : "";
    $("#stat-key").disabled       = !isNew;  // no se puede cambiar la key existente
    $("#stat-value").value         = stat ? stat.value : "";
    $("#stat-label-es").value      = stat ? (stat.label_es || "") : "";
    $("#stat-label-en").value      = stat ? (stat.label_en || "") : "";
    $("#stat-order").value         = stat ? (stat.display_order ?? 0) : 0;
    openModal("#stat-modal");
    setTimeout(() => $("#stat-value").focus(), 0);
  }

  async function submitStatForm(e) {
    e.preventDefault();
    $("#stat-form-error").classList.add("hidden");
    const payload = {
      key:           $("#stat-key").value.trim(),
      value:         $("#stat-value").value.trim(),
      label_es:      $("#stat-label-es").value.trim(),
      label_en:      $("#stat-label-en").value.trim(),
      display_order: parseInt($("#stat-order").value, 10) || 0,
    };
    try {
      await api("POST", "/api/admin/stats", payload);
      closeAllModals();
      // Invalida caché del frontend para que la landing recargue al instante
      try { localStorage.removeItem("monou_stats_v2"); } catch (e) {}
      loadStats();
    } catch (err) {
      $("#stat-form-error").textContent = err.message;
      $("#stat-form-error").classList.remove("hidden");
    }
  }

  async function deleteStat(key) {
    if (!confirm(`¿Borrar la estadística "${key}"?`)) return;
    try {
      await api("DELETE", `/api/admin/stats/${encodeURIComponent(key)}`);
      try { localStorage.removeItem("monou_stats_v2"); } catch (e) {}
      loadStats();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  // ============================================================
  //   Modal helpers
  // ============================================================
  function openModal(sel)  { $(sel).classList.remove("hidden"); }
  function closeAllModals(){ $$(".fixed.inset-0").forEach(m => m.classList.add("hidden")); }

  // ============================================================
  //   Listeners
  // ============================================================
  // v3.2.0: login con email + password (POST /api/auth/login).
  // El backend setea cookie HttpOnly. Frontend solo guarda user + permissions
  // en memoria (rehidratables en cada reload via /api/auth/me).
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#login-error");
    const infoEl = $("#login-info");
    errEl.classList.add("hidden");
    infoEl.classList.add("hidden");

    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    if (!email || !password) return;

    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429) {
        errEl.textContent = "Demasiados intentos, espera unos minutos.";
        errEl.classList.remove("hidden");
        return;
      }
      if (!res.ok || !json.ok) {
        errEl.textContent = "Email o contraseña incorrectos.";
        errEl.classList.remove("hidden");
        return;
      }
      _currentUser = json.user;
      _currentPermissions = json.permissions || {};
      $("#login-password").value = "";
      showApp();
    } catch (err) {
      errEl.textContent = "Error de red. Intentá de nuevo.";
      errEl.classList.remove("hidden");
    }
  });

  // v3.2.0: bootstrap wizard — primer setup usando ADMIN_TOKEN
  $("#bootstrap-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#bootstrap-error");
    const infoEl = $("#bootstrap-info");
    errEl.classList.add("hidden");
    infoEl.classList.add("hidden");

    const token = $("#bootstrap-token").value.trim();
    const email = $("#bootstrap-email").value.trim();
    const fullname = $("#bootstrap-fullname").value.trim();
    const password = $("#bootstrap-password").value;

    if (!token || !email || !fullname || !password) return;
    if (password.length < 8) {
      errEl.textContent = "La contraseña debe tener al menos 8 caracteres.";
      errEl.classList.remove("hidden");
      return;
    }

    infoEl.textContent = "Creando cuenta…";
    infoEl.classList.remove("hidden");

    try {
      const res = await fetch(`${API_BASE}/api/auth/bootstrap`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ email, full_name: fullname, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        infoEl.classList.add("hidden");
        const msg = json.error === "email_already_used" ?
            "Ese email ya está registrado." :
          json.error === "password_too_short" ?
            "Contraseña muy corta (mín 8)." :
          json.error === "unauthorized" ?
            "ADMIN_TOKEN inválido." :
            "No se pudo crear la cuenta. Verificá los datos.";
        errEl.textContent = msg;
        errEl.classList.remove("hidden");
        return;
      }
      _currentUser = json.user;
      _currentPermissions = json.permissions || {};
      // Limpiamos campos sensibles
      $("#bootstrap-token").value = "";
      $("#bootstrap-password").value = "";
      showApp();
    } catch (err) {
      infoEl.classList.add("hidden");
      errEl.textContent = "Error de red. Intentá de nuevo.";
      errEl.classList.remove("hidden");
    }
  });

  // ---------- Forgot token: request magic link ----------
  $("#forgot-token-btn").addEventListener("click", async () => {
    const errEl  = $("#login-error");
    const infoEl = $("#login-info");
    errEl.classList.add("hidden");

    if (!confirm("¿Enviar un enlace de recuperación a tu email registrado?")) {
      return;
    }

    infoEl.textContent = "Enviando…";
    infoEl.classList.remove("hidden");

    try {
      const res = await fetch(`${API_BASE}/api/admin/request-token-recovery`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });
      if (res.status === 429) {
        infoEl.classList.add("hidden");
        errEl.textContent = "Demasiados intentos, espera unos minutos.";
        errEl.classList.remove("hidden");
        return;
      }
      // Backend siempre devuelve 200 con mensaje genérico (no info leak)
      infoEl.textContent =
        "Si la cuenta existe, recibirás un email con el enlace en un momento.";
    } catch (e) {
      infoEl.classList.add("hidden");
      errEl.textContent = "Error de red. Intenta de nuevo.";
      errEl.classList.remove("hidden");
    }
  });

  $$(".nav-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      // Si el click vino del lápiz de editar nombre, abre edición y no navega
      if (e.target.closest(".nav-edit-btn")) {
        e.preventDefault();
        e.stopPropagation();
        startNavLabelEdit(btn);
        return;
      }
      // Si el click vino del input de edición, ignorar (no navegar)
      if (e.target.closest(".nav-label-input")) return;
      selectView(btn.dataset.view);
    });
  });

  // Aplica labels guardados al cargar
  applySavedNavLabels();

  // v3.2.0: logout invalida la session DB-side (revoke cookie + revoke session row)
  $("#logout-btn").addEventListener("click", async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch (e) { /* best-effort */ }
    clearToken();
    showLogin();
  });

  // Contactos
  $("#contacts-refresh").addEventListener("click", loadContacts);
  $("#contacts-export").addEventListener("click", exportContactsCsv);
  $("#contacts-search").addEventListener("input", renderContactRows);
  $("#contacts-status-filter").addEventListener("change", renderContactRows);
  $("#contacts-tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const c = allContacts.find(x => String(x.id) === tr.dataset.id);
    if (c) renderContactDetail(c);
  });

  // Stats
  $("#stats-refresh").addEventListener("click", loadStats);
  $("#stats-new").addEventListener("click", () => openStatModal(null));
  $("#stats-tbody").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".stat-edit");
    const delBtn  = e.target.closest(".stat-delete");
    if (editBtn) {
      const stat = allStats.find(s => s.key === editBtn.dataset.key);
      if (stat) openStatModal(stat);
    } else if (delBtn) {
      deleteStat(delBtn.dataset.key);
    }
  });
  $("#stat-form").addEventListener("submit", submitStatForm);

  // ============================================================
  //   GAMES (carrusel F2P)
  // ============================================================

  function renderGamesRows() {
    $("#games-count").textContent = `${allGames.length}`;
    if (!allGames.length) {
      $("#games-tbody").innerHTML = `
        <tr><td colspan="7" class="px-4 py-12 text-center text-gray-500">
          No hay juegos. Pulsa <strong>Nuevo</strong> para crear el primero.
        </td></tr>`;
      $("#games-loading").classList.add("hidden");
      $("#games-error").classList.add("hidden");
      $("#games-table-wrap").classList.remove("hidden");
      return;
    }
    $("#games-tbody").innerHTML = allGames.map(g => {
      const tagsEs = (g.tags_es || []).join(", ");
      const titleEs = g.title_es || g.title || "";
      const titleEn = g.title_en || g.title || "";
      const titleHtml = titleEs === titleEn
        ? escapeHtml(titleEs)
        : `<div class="font-medium">${escapeHtml(titleEs)}</div>
           <div class="text-gray-500 text-xs italic">${escapeHtml(titleEn)}</div>`;
      const img = g.image_url
        ? `<img src="${escapeHtml(g.image_url)}" alt="" class="w-12 h-8 object-cover rounded">`
        : `<div class="w-12 h-8 bg-dark-900 rounded flex items-center justify-center"><i class="fa-solid fa-image text-gray-600 text-xs"></i></div>`;
      return `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3 text-gray-500">${escapeHtml(g.display_order ?? 0)}</td>
          <td class="px-4 py-3">${img}</td>
          <td class="px-4 py-3 font-mono text-brand-400 text-xs">${escapeHtml(g.slug)}</td>
          <td class="px-4 py-3">${titleHtml}</td>
          <td class="px-4 py-3 text-gray-300 max-w-xs truncate">${escapeHtml(g.description_es || "—")}</td>
          <td class="px-4 py-3 text-xs text-gray-400">${escapeHtml(tagsEs || "—")}</td>
          <td class="px-4 py-3 text-right whitespace-nowrap">
            <button class="game-edit text-gray-400 hover:text-brand-400 p-2" data-slug="${escapeHtml(g.slug)}" title="Editar">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="game-delete text-gray-400 hover:text-red-400 p-2" data-slug="${escapeHtml(g.slug)}" title="Borrar">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join("");
    $("#games-loading").classList.add("hidden");
    $("#games-error").classList.add("hidden");
    $("#games-table-wrap").classList.remove("hidden");
  }

  async function loadGames() {
    $("#games-loading").classList.remove("hidden");
    $("#games-error").classList.add("hidden");
    $("#games-table-wrap").classList.add("hidden");
    try {
      const json = await api("GET", "/api/admin/games?category=f2p");
      allGames = json.games || [];
      renderGamesRows();
    } catch (err) {
      if (err.message === "Token inválido") return showLogin(err.message);
      $("#games-error-msg").textContent = err.message;
      $("#games-loading").classList.add("hidden");
      $("#games-error").classList.remove("hidden");
    }
  }

  function openGameModal(game, defaultCategory) {
    const isNew = !game;
    const cat = game ? (game.category || "f2p") : (defaultCategory || "f2p");
    const titleSuffix = cat === "publishers" ? " (Publisher)" : "";
    $("#game-modal-title").textContent = (isNew ? "Nuevo juego" : "Editar juego") + titleSuffix;
    $("#game-form-error").classList.add("hidden");
    $("#game-slug").value      = game ? game.slug : "";
    $("#game-slug").disabled    = !isNew;
    const fallback = game ? game.title : "";
    $("#game-title-es").value   = game ? (game.title_es || fallback) : "";
    $("#game-title-en").value   = game ? (game.title_en || fallback) : "";
    $("#game-image").value      = game ? (game.image_url || "") : "";
    $("#game-image-webp").value = game ? (game.image_webp_url || "") : "";
    $("#game-link").value       = game ? (game.link_url  || "") : "";
    $("#game-desc-es").value    = game ? (game.description_es || "") : "";
    $("#game-desc-en").value    = game ? (game.description_en || "") : "";
    $("#game-tags-es").value    = game ? (game.tags_es || []).join(", ") : "";
    $("#game-tags-en").value    = game ? (game.tags_en || []).join(", ") : "";
    $("#game-order").value      = game ? (game.display_order ?? 0) : 0;
    $("#game-category").value   = cat;
    refreshGameImagePreview();
    // v2.7.0: limpia status de upload de sesión anterior
    const gameStatus = $("#game-image-status");
    if (gameStatus) gameStatus.classList.add("hidden");
    openModal("#game-modal");
    setTimeout(() => $("#game-title-es").focus(), 0);
  }

  function refreshGameImagePreview() {
    const url = $("#game-image").value.trim();
    const wrap = $("#game-image-preview-wrap");
    const img  = $("#game-image-preview");
    if (url) {
      img.src = url;
      wrap.classList.remove("hidden");
    } else {
      wrap.classList.add("hidden");
    }
  }

  // v2.7.0: cuando el admin edita el URL manualmente, ya no podemos garantizar
  // que el image_webp_url corresponda. Lo limpiamos para no servir un WebP
  // desactualizado en el frontend.
  function clearGameWebpIfUrlChanged() {
    $("#game-image-webp").value = "";
    const status = $("#game-image-status");
    if (status) status.classList.add("hidden");
  }

  async function submitGameForm(e) {
    e.preventDefault();
    $("#game-form-error").classList.add("hidden");
    const titleEs = $("#game-title-es").value.trim();
    const titleEn = $("#game-title-en").value.trim();
    const category = $("#game-category").value || "f2p";
    const payload = {
      slug:            $("#game-slug").value.trim(),
      title_es:        titleEs,
      title_en:        titleEn,
      title:           titleEs || titleEn,  // legacy fallback
      image_url:       $("#game-image").value.trim(),
      image_webp_url:  $("#game-image-webp").value.trim(),  // v2.7.0: WebP fallback
      link_url:        $("#game-link").value.trim(),
      description_es:  $("#game-desc-es").value.trim(),
      description_en:  $("#game-desc-en").value.trim(),
      tags_es:         $("#game-tags-es").value,
      tags_en:         $("#game-tags-en").value,
      category:        category,
      display_order:   parseInt($("#game-order").value, 10) || 0,
    };
    try {
      await api("POST", "/api/admin/games", payload);
      closeAllModals();
      try { localStorage.removeItem("monou_games_v1"); } catch (e) {}
      // Recargar la vista que corresponda
      if (category === "publishers") loadPublishers();
      else                            loadGames();
    } catch (err) {
      $("#game-form-error").textContent = err.message;
      $("#game-form-error").classList.remove("hidden");
    }
  }

  async function deleteGame(slug) {
    if (!confirm(`¿Borrar el juego "${slug}"? Esto NO borra la card del HTML, solo el registro en la DB.`)) return;
    try {
      await api("DELETE", `/api/admin/games/${encodeURIComponent(slug)}`);
      try { localStorage.removeItem("monou_games_v1"); } catch (e) {}
      loadGames();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  // Listeners de games (F2P)
  $("#games-refresh").addEventListener("click", loadGames);
  $("#games-new").addEventListener("click", () => openGameModal(null, "f2p"));
  $("#games-tbody").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".game-edit");
    const delBtn  = e.target.closest(".game-delete");
    if (editBtn) {
      const g = allGames.find(x => x.slug === editBtn.dataset.slug);
      if (g) openGameModal(g);
    } else if (delBtn) {
      deleteGame(delBtn.dataset.slug);
    }
  });
  $("#game-form").addEventListener("submit", submitGameForm);
  $("#game-image").addEventListener("input", () => {
    refreshGameImagePreview();
    clearGameWebpIfUrlChanged();
  });

  // v2.7.0: bind del widget de upload de imagen
  bindImageUpload({
    fileSel:     "#game-image-file",
    uploadBtn:   "#game-image-upload-btn",
    urlSel:      "#game-image",
    webpSel:     "#game-image-webp",
    statusSel:   "#game-image-status",
    previewSel:  "#game-image-preview",
    previewWrap: "#game-image-preview-wrap",
    folder:      "games",
    slugSource:  () => $("#game-slug").value.trim(),
    maxW:        800,
    maxH:        450,
  });

  // ============================================================
  //   PUBLISHERS (juegos AAA)
  // ============================================================

  function renderPublishersRows() {
    $("#publishers-count").textContent = `${allPublishers.length}`;
    if (!allPublishers.length) {
      $("#publishers-tbody").innerHTML = `
        <tr><td colspan="7" class="px-4 py-12 text-center text-gray-500">
          No hay juegos publishers. Pulsa <strong>Nuevo</strong> para crear el primero.
        </td></tr>`;
      $("#publishers-loading").classList.add("hidden");
      $("#publishers-error").classList.add("hidden");
      $("#publishers-table-wrap").classList.remove("hidden");
      return;
    }
    $("#publishers-tbody").innerHTML = allPublishers.map(g => {
      const titleEs = g.title_es || g.title || "";
      const titleEn = g.title_en || g.title || "";
      const titleHtml = titleEs === titleEn
        ? escapeHtml(titleEs)
        : `<div class="font-medium">${escapeHtml(titleEs)}</div>
           <div class="text-gray-500 text-xs italic">${escapeHtml(titleEn)}</div>`;
      const img = g.image_url
        ? `<img src="${escapeHtml(g.image_url)}" alt="" class="w-12 h-12 object-cover rounded">`
        : `<div class="w-12 h-12 bg-dark-900 rounded flex items-center justify-center"><i class="fa-solid fa-image text-gray-600 text-xs"></i></div>`;
      const linkCell = g.link_url
        ? `<a href="${escapeHtml(g.link_url)}" target="_blank" rel="noopener" class="text-brand-400 hover:underline text-xs">↗ link</a>`
        : `<span class="text-gray-600 text-xs">—</span>`;
      return `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3 text-gray-500">${escapeHtml(g.display_order ?? 0)}</td>
          <td class="px-4 py-3">${img}</td>
          <td class="px-4 py-3 font-mono text-brand-400 text-xs">${escapeHtml(g.slug)}</td>
          <td class="px-4 py-3">${titleHtml}</td>
          <td class="px-4 py-3 text-gray-300 max-w-xs truncate">${escapeHtml(g.description_es || "—")}</td>
          <td class="px-4 py-3">${linkCell}</td>
          <td class="px-4 py-3 text-right whitespace-nowrap">
            <button class="publisher-edit text-gray-400 hover:text-brand-400 p-2" data-slug="${escapeHtml(g.slug)}" title="Editar">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="publisher-delete text-gray-400 hover:text-red-400 p-2" data-slug="${escapeHtml(g.slug)}" title="Borrar">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join("");
    $("#publishers-loading").classList.add("hidden");
    $("#publishers-error").classList.add("hidden");
    $("#publishers-table-wrap").classList.remove("hidden");
  }

  async function loadPublishers() {
    $("#publishers-loading").classList.remove("hidden");
    $("#publishers-error").classList.add("hidden");
    $("#publishers-table-wrap").classList.add("hidden");
    try {
      const json = await api("GET", "/api/admin/games?category=publishers");
      allPublishers = json.games || [];
      renderPublishersRows();
    } catch (err) {
      if (err.message === "Token inválido") return showLogin(err.message);
      $("#publishers-error-msg").textContent = err.message;
      $("#publishers-loading").classList.add("hidden");
      $("#publishers-error").classList.remove("hidden");
    }
  }

  async function deletePublisher(slug) {
    if (!confirm(`¿Borrar el juego publisher "${slug}"?`)) return;
    try {
      await api("DELETE", `/api/admin/games/${encodeURIComponent(slug)}`);
      try { localStorage.removeItem("monou_games_v1"); } catch (e) {}
      loadPublishers();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  $("#publishers-refresh").addEventListener("click", loadPublishers);
  $("#publishers-new").addEventListener("click", () => openGameModal(null, "publishers"));
  $("#publishers-tbody").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".publisher-edit");
    const delBtn  = e.target.closest(".publisher-delete");
    if (editBtn) {
      const g = allPublishers.find(x => x.slug === editBtn.dataset.slug);
      if (g) openGameModal(g);
    } else if (delBtn) {
      deletePublisher(delBtn.dataset.slug);
    }
  });

  // ============================================================
  //   SITE LINKS (Configuración URLs)
  // ============================================================

  function renderLinksRows() {
    $("#links-count").textContent = `${allLinks.length}`;
    if (!allLinks.length) {
      $("#links-tbody").innerHTML = `
        <tr><td colspan="7" class="px-4 py-12 text-center text-gray-500">
          No hay enlaces. Pulsa <strong>Nuevo</strong> para crear el primero.
        </td></tr>`;
      $("#links-loading").classList.add("hidden");
      $("#links-error").classList.add("hidden");
      $("#links-table-wrap").classList.remove("hidden");
      return;
    }
    $("#links-tbody").innerHTML = allLinks.map(l => {
      const labelEs = l.label_es || "";
      const labelEn = l.label_en || "";
      const labelHtml = labelEs && labelEn && labelEs !== labelEn
        ? `<div class="font-medium">${escapeHtml(labelEs)}</div>
           <div class="text-gray-500 text-xs italic">${escapeHtml(labelEn)}</div>`
        : escapeHtml(labelEs || labelEn || "—");
      const img = l.image_url
        ? `<img src="${escapeHtml(l.image_url)}" alt="" class="w-12 h-12 object-cover rounded">`
        : `<div class="w-12 h-12 bg-dark-900 rounded flex items-center justify-center"><i class="fa-solid fa-image text-gray-600 text-xs"></i></div>`;
      const urlCell = l.url
        ? `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener" class="text-brand-400 hover:underline text-xs break-all">${escapeHtml(l.url)}</a>`
        : `<span class="text-gray-600 text-xs">— sin URL</span>`;
      return `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3 text-gray-500">${escapeHtml(l.display_order ?? 0)}</td>
          <td class="px-4 py-3">${img}</td>
          <td class="px-4 py-3 font-mono text-brand-400 text-xs">${escapeHtml(l.key)}</td>
          <td class="px-4 py-3">${labelHtml}</td>
          <td class="px-4 py-3 max-w-xs">${urlCell}</td>
          <td class="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">${escapeHtml(l.description || "—")}</td>
          <td class="px-4 py-3 text-right whitespace-nowrap">
            <button class="link-edit text-gray-400 hover:text-brand-400 p-2" data-key="${escapeHtml(l.key)}" title="Editar">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="link-delete text-gray-400 hover:text-red-400 p-2" data-key="${escapeHtml(l.key)}" title="Borrar">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join("");
    $("#links-loading").classList.add("hidden");
    $("#links-error").classList.add("hidden");
    $("#links-table-wrap").classList.remove("hidden");
  }

  async function loadLinks() {
    $("#links-loading").classList.remove("hidden");
    $("#links-error").classList.add("hidden");
    $("#links-table-wrap").classList.add("hidden");
    try {
      const json = await api("GET", "/api/admin/site-links");
      allLinks = json.links || [];
      renderLinksRows();
    } catch (err) {
      if (err.message === "Token inválido") return showLogin(err.message);
      $("#links-error-msg").textContent = err.message;
      $("#links-loading").classList.add("hidden");
      $("#links-error").classList.remove("hidden");
    }
  }

  function refreshLinkImagePreview() {
    const url = $("#link-image").value.trim();
    const wrap = $("#link-image-preview-wrap");
    const img  = $("#link-image-preview");
    if (url) { img.src = url; wrap.classList.remove("hidden"); }
    else     { wrap.classList.add("hidden"); }
  }

  // v2.7.0: al editar el URL manualmente, limpiar el WebP porque ya no aplica.
  function clearLinkWebpIfUrlChanged() {
    $("#link-image-webp").value = "";
    const status = $("#link-image-status");
    if (status) status.classList.add("hidden");
  }

  function openLinkModal(link) {
    const isNew = !link;
    $("#link-modal-title").textContent = isNew ? "Nuevo enlace" : "Editar enlace";
    $("#link-form-error").classList.add("hidden");
    $("#link-key").value         = link ? link.key : "";
    $("#link-key").disabled       = !isNew;
    $("#link-description").value  = link ? (link.description || "") : "";
    $("#link-url").value          = link ? (link.url || "") : "";
    $("#link-image").value        = link ? (link.image_url || "") : "";
    $("#link-image-webp").value   = link ? (link.image_webp_url || "") : "";
    $("#link-label-es").value     = link ? (link.label_es || "") : "";
    $("#link-label-en").value     = link ? (link.label_en || "") : "";
    $("#link-order").value        = link ? (link.display_order ?? 0) : 0;
    refreshLinkImagePreview();
    // v2.7.0: limpia status de upload de sesión anterior
    const linkStatus = $("#link-image-status");
    if (linkStatus) linkStatus.classList.add("hidden");
    openModal("#link-modal");
    setTimeout(() => $("#link-url").focus(), 0);
  }

  async function submitLinkForm(e) {
    e.preventDefault();
    $("#link-form-error").classList.add("hidden");
    const payload = {
      key:            $("#link-key").value.trim(),
      description:    $("#link-description").value.trim(),
      url:            $("#link-url").value.trim(),
      image_url:      $("#link-image").value.trim(),
      image_webp_url: $("#link-image-webp").value.trim(),  // v2.7.0: WebP fallback
      label_es:       $("#link-label-es").value.trim(),
      label_en:       $("#link-label-en").value.trim(),
      display_order:  parseInt($("#link-order").value, 10) || 0,
    };
    try {
      await api("POST", "/api/admin/site-links", payload);
      closeAllModals();
      try { localStorage.removeItem("monou_site_links_v1"); } catch (e) {}
      loadLinks();
    } catch (err) {
      $("#link-form-error").textContent = err.message;
      $("#link-form-error").classList.remove("hidden");
    }
  }

  async function deleteLink(key) {
    if (!confirm(`¿Borrar el enlace "${key}"?`)) return;
    try {
      await api("DELETE", `/api/admin/site-links/${encodeURIComponent(key)}`);
      try { localStorage.removeItem("monou_site_links_v1"); } catch (e) {}
      loadLinks();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  $("#links-refresh").addEventListener("click", loadLinks);
  $("#links-new").addEventListener("click", () => openLinkModal(null));
  $("#links-tbody").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".link-edit");
    const delBtn  = e.target.closest(".link-delete");
    if (editBtn) {
      const l = allLinks.find(x => x.key === editBtn.dataset.key);
      if (l) openLinkModal(l);
    } else if (delBtn) {
      deleteLink(delBtn.dataset.key);
    }
  });
  $("#link-form").addEventListener("submit", submitLinkForm);
  $("#link-image").addEventListener("input", () => {
    refreshLinkImagePreview();
    clearLinkWebpIfUrlChanged();
  });

  // v2.7.0: bind del widget de upload de imagen
  bindImageUpload({
    fileSel:     "#link-image-file",
    uploadBtn:   "#link-image-upload-btn",
    urlSel:      "#link-image",
    webpSel:     "#link-image-webp",
    statusSel:   "#link-image-status",
    previewSel:  "#link-image-preview",
    previewWrap: "#link-image-preview-wrap",
    folder:      "site-links",
    slugSource:  () => $("#link-key").value.trim(),
    maxW:        400,
    maxH:        400,
  });

  // ============================================================
  //   DELIVERY OPTIONS (Data Formats + Delivery Methods)
  // ============================================================

  function categoryLabel(cat) {
    return cat === "data_formats" ? "Data Format"
         : cat === "delivery_methods" ? "Delivery Method"
         : cat;
  }

  function categoryBadge(cat) {
    const cls = cat === "data_formats" ? "bg-brand-500/20 text-brand-400"
              : cat === "delivery_methods" ? "bg-cyan-500/20 text-cyan-400"
              : "bg-gray-700 text-gray-400";
    return `<span class="${cls} px-2 py-1 rounded text-xs font-medium">${escapeHtml(categoryLabel(cat))}</span>`;
  }

  function renderDeliveryRows() {
    $("#delivery-count").textContent = `${allDelivery.length}`;
    if (!allDelivery.length) {
      $("#delivery-tbody").innerHTML = `
        <tr><td colspan="7" class="px-4 py-12 text-center text-gray-500">
          No hay opciones. Pulsa <strong>+ Data Format</strong> o <strong>+ Delivery Method</strong>.
        </td></tr>`;
      $("#delivery-loading").classList.add("hidden");
      $("#delivery-error").classList.add("hidden");
      $("#delivery-table-wrap").classList.remove("hidden");
      return;
    }
    $("#delivery-tbody").innerHTML = allDelivery.map(o => {
      const titleEs = o.title_es || o.title || "";
      const titleEn = o.title_en || o.title || "";
      const titleHtml = titleEs === titleEn
        ? escapeHtml(titleEs)
        : `<div class="font-medium">${escapeHtml(titleEs)}</div>
           <div class="text-gray-500 text-xs italic">${escapeHtml(titleEn)}</div>`;
      const iconHtml = o.icon
        ? `<i class="${escapeHtml(o.icon)} text-xl ${escapeHtml(o.icon_color || "text-brand-400")}"></i>`
        : `<span class="text-gray-600 text-xs">—</span>`;
      return `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3 text-gray-500">${escapeHtml(o.display_order ?? 0)}</td>
          <td class="px-4 py-3">${iconHtml}</td>
          <td class="px-4 py-3 font-mono text-brand-400 text-xs">${escapeHtml(o.slug)}</td>
          <td class="px-4 py-3">${categoryBadge(o.category)}</td>
          <td class="px-4 py-3">${titleHtml}</td>
          <td class="px-4 py-3 text-gray-300 max-w-xs truncate text-xs">${escapeHtml(o.description_es || "—")}</td>
          <td class="px-4 py-3 text-right whitespace-nowrap">
            <button class="delivery-edit text-gray-400 hover:text-brand-400 p-2" data-slug="${escapeHtml(o.slug)}" title="Editar">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="delivery-delete text-gray-400 hover:text-red-400 p-2" data-slug="${escapeHtml(o.slug)}" title="Borrar">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join("");
    $("#delivery-loading").classList.add("hidden");
    $("#delivery-error").classList.add("hidden");
    $("#delivery-table-wrap").classList.remove("hidden");
  }

  async function loadDelivery() {
    $("#delivery-loading").classList.remove("hidden");
    $("#delivery-error").classList.add("hidden");
    $("#delivery-table-wrap").classList.add("hidden");
    try {
      const json = await api("GET", "/api/admin/delivery-options");
      allDelivery = json.options || [];
      renderDeliveryRows();
    } catch (err) {
      if (err.message === "Token inválido") return showLogin(err.message);
      $("#delivery-error-msg").textContent = err.message;
      $("#delivery-loading").classList.add("hidden");
      $("#delivery-error").classList.remove("hidden");
    }
  }

  function refreshDeliveryPreview() {
    const icon  = $("#delivery-icon").value.trim() || "fa-solid fa-circle";
    const color = $("#delivery-icon-color").value || "text-brand-400";
    const titleEs = $("#delivery-title-es").value.trim() || "Título";
    const descEs  = $("#delivery-desc-es").value.trim() || "Descripción";
    $("#delivery-icon-preview").className = `${icon} text-2xl ${color}`;
    $("#delivery-title-preview").textContent = titleEs;
    $("#delivery-desc-preview").textContent  = descEs;
  }

  function openDeliveryModal(opt, defaultCategory) {
    const isNew = !opt;
    const cat = opt ? opt.category : (defaultCategory || "data_formats");
    $("#delivery-modal-title").textContent = (isNew ? "Nuevo: " : "Editar: ") + categoryLabel(cat);
    $("#delivery-form-error").classList.add("hidden");
    $("#delivery-slug").value         = opt ? opt.slug : "";
    $("#delivery-slug").disabled       = !isNew;
    $("#delivery-category").value      = cat;
    const fallback = opt ? opt.title : "";
    $("#delivery-title-es").value     = opt ? (opt.title_es || fallback) : "";
    $("#delivery-title-en").value     = opt ? (opt.title_en || fallback) : "";
    $("#delivery-desc-es").value       = opt ? (opt.description_es || "") : "";
    $("#delivery-desc-en").value       = opt ? (opt.description_en || "") : "";
    $("#delivery-icon").value          = opt ? (opt.icon || "fa-solid fa-circle") : "fa-solid fa-circle";
    $("#delivery-icon-color").value    = opt ? (opt.icon_color || "text-brand-400") : "text-brand-400";
    $("#delivery-order").value         = opt ? (opt.display_order ?? 0) : 0;
    refreshDeliveryPreview();
    openModal("#delivery-modal");
    setTimeout(() => $("#delivery-title-es").focus(), 0);
  }

  async function submitDeliveryForm(e) {
    e.preventDefault();
    $("#delivery-form-error").classList.add("hidden");
    const titleEs = $("#delivery-title-es").value.trim();
    const titleEn = $("#delivery-title-en").value.trim();
    const payload = {
      slug:           $("#delivery-slug").value.trim(),
      category:       $("#delivery-category").value,
      title:          titleEs || titleEn,
      title_es:       titleEs,
      title_en:       titleEn,
      description_es: $("#delivery-desc-es").value.trim(),
      description_en: $("#delivery-desc-en").value.trim(),
      icon:           $("#delivery-icon").value.trim(),
      icon_color:     $("#delivery-icon-color").value,
      display_order:  parseInt($("#delivery-order").value, 10) || 0,
    };
    try {
      await api("POST", "/api/admin/delivery-options", payload);
      closeAllModals();
      try { localStorage.removeItem("monou_delivery_v1"); } catch (e) {}
      loadDelivery();
    } catch (err) {
      $("#delivery-form-error").textContent = err.message;
      $("#delivery-form-error").classList.remove("hidden");
    }
  }

  async function deleteDelivery(slug) {
    if (!confirm(`¿Borrar la opción "${slug}"?`)) return;
    try {
      await api("DELETE", `/api/admin/delivery-options/${encodeURIComponent(slug)}`);
      try { localStorage.removeItem("monou_delivery_v1"); } catch (e) {}
      loadDelivery();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  $("#delivery-refresh").addEventListener("click", loadDelivery);
  $("#delivery-new-data-formats").addEventListener("click",
      () => openDeliveryModal(null, "data_formats"));
  $("#delivery-new-delivery-methods").addEventListener("click",
      () => openDeliveryModal(null, "delivery_methods"));
  $("#delivery-tbody").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".delivery-edit");
    const delBtn  = e.target.closest(".delivery-delete");
    if (editBtn) {
      const o = allDelivery.find(x => x.slug === editBtn.dataset.slug);
      if (o) openDeliveryModal(o);
    } else if (delBtn) {
      deleteDelivery(delBtn.dataset.slug);
    }
  });
  $("#delivery-form").addEventListener("submit", submitDeliveryForm);
  // Preview en vivo al editar cualquier campo
  ["#delivery-icon", "#delivery-icon-color", "#delivery-title-es", "#delivery-desc-es"].forEach(sel => {
    document.querySelector(sel).addEventListener("input", refreshDeliveryPreview);
    document.querySelector(sel).addEventListener("change", refreshDeliveryPreview);
  });

  // ============================================================
  //   INFO COLUMNS (Visual Capture / Available Metadata / Current Volume)
  // ============================================================

  function renderInfoColumnsRows() {
    $("#info-count").textContent = `${allInfoCols.length}`;
    if (!allInfoCols.length) {
      $("#info-tbody").innerHTML = `
        <tr><td colspan="6" class="px-4 py-12 text-center text-gray-500">
          No hay bloques. Pulsa <strong>Nuevo</strong> para crear el primero.
        </td></tr>`;
      $("#info-loading").classList.add("hidden");
      $("#info-error").classList.add("hidden");
      $("#info-table-wrap").classList.remove("hidden");
      return;
    }
    $("#info-tbody").innerHTML = allInfoCols.map(c => {
      const titleEs = c.title_es || "";
      const titleEn = c.title_en || "";
      const titleHtml = titleEs === titleEn
        ? escapeHtml(titleEs)
        : `<div class="font-medium">${escapeHtml(titleEs)}</div>
           <div class="text-gray-500 text-xs italic">${escapeHtml(titleEn)}</div>`;
      const iconHtml = c.icon
        ? `<i class="${escapeHtml(c.icon)} text-xl ${escapeHtml(c.icon_color || "text-brand-400")}"></i>`
        : `<span class="text-gray-600 text-xs">—</span>`;
      const itemsHtml = (c.items_es || []).slice(0, 3).map(i => `
        <div class="text-xs text-gray-400 truncate">• ${escapeHtml(i)}</div>`).join("");
      const more = (c.items_es || []).length > 3 ? `<div class="text-xs text-gray-600">+${c.items_es.length - 3} más</div>` : "";
      return `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3 text-gray-500">${escapeHtml(c.display_order ?? 0)}</td>
          <td class="px-4 py-3">${iconHtml}</td>
          <td class="px-4 py-3 font-mono text-brand-400 text-xs">${escapeHtml(c.slug)}</td>
          <td class="px-4 py-3">${titleHtml}</td>
          <td class="px-4 py-3 max-w-md">${itemsHtml}${more}</td>
          <td class="px-4 py-3 text-right whitespace-nowrap">
            <button class="info-edit text-gray-400 hover:text-brand-400 p-2" data-slug="${escapeHtml(c.slug)}" title="Editar">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="info-delete text-gray-400 hover:text-red-400 p-2" data-slug="${escapeHtml(c.slug)}" title="Borrar">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join("");
    $("#info-loading").classList.add("hidden");
    $("#info-error").classList.add("hidden");
    $("#info-table-wrap").classList.remove("hidden");
  }

  async function loadInfoColumns() {
    $("#info-loading").classList.remove("hidden");
    $("#info-error").classList.add("hidden");
    $("#info-table-wrap").classList.add("hidden");
    try {
      const json = await api("GET", "/api/admin/info-columns");
      allInfoCols = json.columns || [];
      renderInfoColumnsRows();
    } catch (err) {
      if (err.message === "Token inválido") return showLogin(err.message);
      $("#info-error-msg").textContent = err.message;
      $("#info-loading").classList.add("hidden");
      $("#info-error").classList.remove("hidden");
    }
  }

  function refreshInfoPreview() {
    const icon  = $("#info-icon").value.trim() || "fa-solid fa-circle";
    const color = $("#info-icon-color").value || "text-brand-400";
    const titleEs = $("#info-title-es").value.trim() || "Título";
    $("#info-icon-preview").className = `${icon} ${color}`;
    $("#info-title-preview").textContent = titleEs;
    const items = $("#info-items-es").value.split("\n").filter(s => s.trim());
    $("#info-items-preview").innerHTML = items.map(i =>
      `<div class="flex items-start gap-1"><i class="fa-solid fa-check text-brand-500 text-[10px] mt-0.5"></i><span>${escapeHtml(i)}</span></div>`
    ).join("");
  }

  function openInfoModal(col) {
    const isNew = !col;
    $("#info-modal-title").textContent = isNew ? "Nuevo bloque" : "Editar bloque";
    $("#info-form-error").classList.add("hidden");
    $("#info-slug").value         = col ? col.slug : "";
    $("#info-slug").disabled       = !isNew;
    $("#info-title-es").value     = col ? (col.title_es || "") : "";
    $("#info-title-en").value     = col ? (col.title_en || "") : "";
    $("#info-icon").value          = col ? (col.icon || "fa-solid fa-circle") : "fa-solid fa-circle";
    $("#info-icon-color").value    = col ? (col.icon_color || "text-brand-400") : "text-brand-400";
    $("#info-items-es").value      = col ? (col.items_es || []).join("\n") : "";
    $("#info-items-en").value      = col ? (col.items_en || []).join("\n") : "";
    $("#info-order").value         = col ? (col.display_order ?? 0) : 0;
    refreshInfoPreview();
    openModal("#info-modal");
    setTimeout(() => $("#info-title-es").focus(), 0);
  }

  async function submitInfoForm(e) {
    e.preventDefault();
    $("#info-form-error").classList.add("hidden");
    const payload = {
      slug:           $("#info-slug").value.trim(),
      title_es:       $("#info-title-es").value.trim(),
      title_en:       $("#info-title-en").value.trim(),
      icon:           $("#info-icon").value.trim(),
      icon_color:     $("#info-icon-color").value,
      items_es:       $("#info-items-es").value,
      items_en:       $("#info-items-en").value,
      display_order:  parseInt($("#info-order").value, 10) || 0,
    };
    try {
      await api("POST", "/api/admin/info-columns", payload);
      closeAllModals();
      try { localStorage.removeItem("monou_info_columns_v1"); } catch (e) {}
      loadInfoColumns();
    } catch (err) {
      $("#info-form-error").textContent = err.message;
      $("#info-form-error").classList.remove("hidden");
    }
  }

  async function deleteInfoColumn(slug) {
    if (!confirm(`¿Borrar el bloque "${slug}"?`)) return;
    try {
      await api("DELETE", `/api/admin/info-columns/${encodeURIComponent(slug)}`);
      try { localStorage.removeItem("monou_info_columns_v1"); } catch (e) {}
      loadInfoColumns();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  $("#info-refresh").addEventListener("click", loadInfoColumns);
  $("#info-new").addEventListener("click", () => openInfoModal(null));
  $("#info-tbody").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".info-edit");
    const delBtn  = e.target.closest(".info-delete");
    if (editBtn) {
      const c = allInfoCols.find(x => x.slug === editBtn.dataset.slug);
      if (c) openInfoModal(c);
    } else if (delBtn) {
      deleteInfoColumn(delBtn.dataset.slug);
    }
  });
  $("#info-form").addEventListener("submit", submitInfoForm);
  ["#info-icon", "#info-icon-color", "#info-title-es", "#info-items-es"].forEach(sel => {
    document.querySelector(sel).addEventListener("input", refreshInfoPreview);
    document.querySelector(sel).addEventListener("change", refreshInfoPreview);
  });

  // Modales
  $$(".modal-close").forEach(btn => btn.addEventListener("click", closeAllModals));
  $$(".fixed.inset-0").forEach(m => {
    // Tracking de mousedown para evitar cerrar el modal cuando el usuario
    // selecciona texto con drag dentro de un input/textarea y suelta el
    // mouse FUERA del campo (el click resultante tiene target=backdrop
    // pero no es intención de cerrar). Solo se cierra si AMBOS mousedown
    // y click ocurrieron limpios sobre el backdrop.
    let downOnBackdrop = false;
    m.addEventListener("mousedown", (e) => {
      downOnBackdrop = (e.target === m);
    });
    m.addEventListener("click", (e) => {
      if (e.target === m && downOnBackdrop) closeAllModals();
      downOnBackdrop = false;
    });

    // Cualquier evento de teclado que ocurra dentro del modal NO debe
    // burbujear al document. Así protegemos contra cualquier handler global
    // (presente o futuro) que pudiera reaccionar a Cmd/Ctrl/Alt + tecla.
    // Específicamente ignoramos aquí cualquier keydown con modificadores
    // (Cmd+C, Cmd+V, Cmd+X, Cmd+A, etc.) y la dejamos pasar al browser
    // para que maneje el shortcut nativamente.
    m.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        // Permitir el shortcut del browser, pero parar la propagación al
        // document por si algún handler global se confunde
        e.stopPropagation();
      }
    });
  });

  // Handler global de Escape — SOLO cierra si NO hay modificadores y la
  // tecla es exactamente Escape (no, por ejemplo, Cmd presionada con
  // mapping raro de algún teclado).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    closeAllModals();
  });

  // ============================================================
  //   ANALYTICS & GTM (v2.2.0)
  // ============================================================
  let allCtaTags = [];

  async function loadAnalyticsConfig() {
    const statusEl = $("#analytics-config-status");
    statusEl.textContent = "Cargando…";
    try {
      const data = await api("GET", "/api/admin/analytics-config");
      const cfg = (data && data.config) || {};
      $("#ga4-measurement-id").value = cfg.ga4_measurement_id || "";
      $("#ga4-enabled").checked      = !!cfg.ga4_enabled;
      $("#gtm-container-id").value   = cfg.gtm_container_id || "";
      $("#gtm-enabled").checked      = !!cfg.gtm_enabled;
      statusEl.textContent = cfg.updated_at
        ? `Última actualización: ${fmtDate(cfg.updated_at)}`
        : "";
    } catch (e) {
      statusEl.textContent = "Error: " + (e.message || "no se pudo cargar");
      statusEl.classList.add("text-red-400");
    }
  }

  async function saveAnalyticsConfig(e) {
    e.preventDefault();
    const btn = $("#analytics-config-save");
    const statusEl = $("#analytics-config-status");
    statusEl.classList.remove("text-red-400", "text-brand-400");
    btn.disabled = true; btn.classList.add("opacity-60");
    try {
      const payload = {
        ga4_measurement_id: $("#ga4-measurement-id").value.trim(),
        ga4_enabled:        $("#ga4-enabled").checked,
        gtm_container_id:   $("#gtm-container-id").value.trim(),
        gtm_enabled:        $("#gtm-enabled").checked,
      };
      await api("POST", "/api/admin/analytics-config", payload);
      statusEl.textContent = "✓ Configuración guardada";
      statusEl.classList.add("text-brand-400");
      // Forzar refetch en el cliente (clear cache)
      try { localStorage.removeItem("monou_analytics_config_v1"); } catch(_) {}
    } catch (e) {
      statusEl.textContent = "Error: " + (e.message || "no se pudo guardar");
      statusEl.classList.add("text-red-400");
    } finally {
      btn.disabled = false; btn.classList.remove("opacity-60");
    }
  }

  function renderCtaTagsRows() {
    const tbody = $("#cta-tags-tbody");
    if (!allCtaTags.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-gray-500 py-8">Sin CTAs configurados — clic en "Nuevo CTA" para crear el primero.</td></tr>`;
      return;
    }
    tbody.innerHTML = allCtaTags.map(t => `
      <tr class="hover:bg-white/5">
        <td class="px-4 py-3 text-gray-400">${t.display_order || 0}</td>
        <td class="px-4 py-3">
          ${t.enabled
            ? '<span class="text-green-400" title="Activo"><i class="fa-solid fa-circle-check"></i></span>'
            : '<span class="text-gray-600" title="Inactivo"><i class="fa-regular fa-circle"></i></span>'}
        </td>
        <td class="px-4 py-3"><code class="text-xs text-brand-400">${escapeHtml(t.cta_key)}</code></td>
        <td class="px-4 py-3"><code class="text-xs text-gray-400" title="${escapeHtml(t.selector)}">${escapeHtml(t.selector.length > 40 ? t.selector.slice(0, 40) + "…" : t.selector)}</code></td>
        <td class="px-4 py-3"><code class="text-xs text-accent-cyan">${escapeHtml(t.event_name || "cta_click")}</code></td>
        <td class="px-4 py-3 text-gray-400 text-xs">${escapeHtml(t.event_category || "—")}</td>
        <td class="px-4 py-3 text-right">
          <button data-action="edit" data-key="${escapeHtml(t.cta_key)}" class="text-gray-400 hover:text-brand-400 px-2 py-1" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
          <button data-action="delete" data-key="${escapeHtml(t.cta_key)}" class="text-gray-400 hover:text-red-400 px-2 py-1" title="Borrar"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>
    `).join("");
  }

  async function loadCtaTags() {
    const loading = $("#cta-tags-loading");
    const errBox  = $("#cta-tags-error");
    const wrap    = $("#cta-tags-table-wrap");
    loading.classList.remove("hidden");
    errBox.classList.add("hidden");
    wrap.classList.add("hidden");
    try {
      const data = await api("GET", "/api/admin/cta-tags");
      allCtaTags = (data && data.tags) || [];
      $("#cta-tags-count").textContent = `${allCtaTags.length} ${allCtaTags.length === 1 ? "CTA" : "CTAs"}`;
      renderCtaTagsRows();
      loading.classList.add("hidden");
      wrap.classList.remove("hidden");
    } catch (e) {
      loading.classList.add("hidden");
      errBox.classList.remove("hidden");
      $("#cta-tags-error-msg").textContent = e.message || "Error al cargar CTAs";
    }
  }

  function loadAnalytics() {
    loadAnalyticsConfig();
    loadCtaTags();
  }

  function openCtaTagModal(tag) {
    const isEdit = !!tag;
    $("#cta-tag-modal-title").textContent = isEdit ? "Editar CTA tag" : "Nuevo CTA tag";
    $("#cta-tag-form-error").classList.add("hidden");
    $("#cta-key").value             = tag ? tag.cta_key : "";
    $("#cta-key").readOnly          = isEdit;
    $("#cta-key").classList.toggle("opacity-60", isEdit);
    $("#cta-selector").value        = tag ? tag.selector : "";
    $("#cta-event-name").value      = tag ? (tag.event_name || "cta_click") : "cta_click";
    $("#cta-event-label").value     = tag ? (tag.event_label || "") : "";
    $("#cta-event-category").value  = tag ? (tag.event_category || "") : "";
    $("#cta-description").value     = tag ? (tag.description || "") : "";
    $("#cta-enabled").checked       = tag ? !!tag.enabled : true;
    $("#cta-order").value            = tag ? (tag.display_order || 0) : 0;
    $("#cta-tag-modal").classList.remove("hidden");
  }

  $("#cta-tag-new").addEventListener("click", () => openCtaTagModal(null));
  $("#analytics-refresh").addEventListener("click", loadAnalytics);
  $("#analytics-config-form").addEventListener("submit", saveAnalyticsConfig);

  $("#cta-tag-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#cta-tag-form-error");
    errEl.classList.add("hidden");
    const payload = {
      cta_key:         $("#cta-key").value.trim(),
      selector:        $("#cta-selector").value.trim(),
      event_name:      $("#cta-event-name").value.trim() || "cta_click",
      event_label:     $("#cta-event-label").value.trim(),
      event_category:  $("#cta-event-category").value,
      description:     $("#cta-description").value.trim(),
      enabled:         $("#cta-enabled").checked,
      display_order:   parseInt($("#cta-order").value) || 0,
    };
    try {
      await api("POST", "/api/admin/cta-tags", payload);
      $("#cta-tag-modal").classList.add("hidden");
      try { localStorage.removeItem("monou_cta_tags_v1"); } catch(_) {}
      loadCtaTags();
    } catch (e) {
      errEl.textContent = e.message || "Error al guardar";
      errEl.classList.remove("hidden");
    }
  });

  $("#cta-tags-tbody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const key = btn.dataset.key;
    const action = btn.dataset.action;
    if (action === "edit") {
      const tag = allCtaTags.find(t => t.cta_key === key);
      if (tag) openCtaTagModal(tag);
    } else if (action === "delete") {
      if (!confirm(`¿Borrar CTA "${key}"?`)) return;
      try {
        await api("DELETE", `/api/admin/cta-tags/${encodeURIComponent(key)}`);
        try { localStorage.removeItem("monou_cta_tags_v1"); } catch(_) {}
        loadCtaTags();
      } catch (e) {
        alert("Error al borrar: " + (e.message || ""));
      }
    }
  });

  // ============================================================
  //   v3.2.0: Usuarios tab (super_admin/admin)
  // ============================================================
  let _allUsers = [];

  const RESOURCES_LABELS = {
    contacts: "Contactos",
    stats: "Estadísticas",
    games_f2p: "Juegos F2P",
    games_publishers: "Juegos Publishers",
    site_links: "Configuración URLs",
    delivery: "Formatos & Entrega",
    info_columns: "Bloques Info",
    analytics: "Analytics & GTM",
    users: "Usuarios",
  };
  const RESOURCES_ORDER = [
    "contacts", "stats", "games_f2p", "games_publishers",
    "site_links", "delivery", "info_columns", "analytics", "users",
  ];

  async function loadUsers() {
    const tbody = $("#users-tbody");
    tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500">Cargando…</td></tr>`;
    try {
      const json = await api("GET", "/api/users");
      _allUsers = json.users || [];
      $("#users-count").textContent =
        `${_allUsers.length} ${_allUsers.length === 1 ? "usuario" : "usuarios"}`;
      renderUsersRows();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-red-400">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function roleBadge(role) {
    const colors = {
      super_admin: "bg-purple-500/20 text-purple-300 border-purple-500/30",
      admin: "bg-blue-500/20 text-blue-300 border-blue-500/30",
      editor: "bg-gray-500/20 text-gray-300 border-gray-500/30",
    };
    const labels = { super_admin: "super_admin", admin: "admin", editor: "editor" };
    return `<span class="tag border ${colors[role] || ""}">${labels[role] || role}</span>`;
  }

  function statusBadge(status) {
    const colors = {
      active: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
      pending: "bg-amber-500/20 text-amber-300 border-amber-500/30",
      disabled: "bg-red-500/20 text-red-300 border-red-500/30",
    };
    const labels = { active: "activo", pending: "pendiente", disabled: "deshabilitado" };
    return `<span class="tag border ${colors[status] || ""}">${labels[status] || status}</span>`;
  }

  function renderUsersRows() {
    const tbody = $("#users-tbody");
    if (!_allUsers.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500">No hay usuarios.</td></tr>`;
      return;
    }
    const me = getCurrentUser();
    tbody.innerHTML = _allUsers.map(u => {
      const isMe = me && me.id === u.id;
      const canManage = canActorManage(me, u);
      return `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3">
            <div class="font-medium">${escapeHtml(u.email)}</div>
            ${isMe ? '<div class="text-[10px] text-brand-400">(tú)</div>' : ''}
          </td>
          <td class="px-4 py-3 text-gray-300">${escapeHtml(u.full_name || "—")}</td>
          <td class="px-4 py-3">${roleBadge(u.role)}</td>
          <td class="px-4 py-3">${statusBadge(u.status)}</td>
          <td class="px-4 py-3 text-xs text-gray-400">${fmtDate(u.last_login_at)}</td>
          <td class="px-4 py-3 text-xs text-gray-400">${escapeHtml(u.invited_by_email || (u.created_via === 'bootstrap' ? '—' : ''))}</td>
          <td class="px-4 py-3 text-right space-x-1">
            ${canManage ? `
              <button data-action="edit" data-id="${u.id}"
                      class="user-action px-2 py-1 text-xs text-brand-400 hover:bg-brand-500/10 rounded" title="Editar">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
              ${u.status === 'pending' ? `
                <button data-action="resend" data-id="${u.id}"
                        class="user-action px-2 py-1 text-xs text-amber-400 hover:bg-amber-500/10 rounded" title="Reenviar invitación">
                  <i class="fa-solid fa-envelope"></i>
                </button>
              ` : ''}
              ${u.status === 'disabled' ? `
                <button data-action="enable" data-id="${u.id}"
                        class="user-action px-2 py-1 text-xs text-emerald-400 hover:bg-emerald-500/10 rounded" title="Reactivar">
                  <i class="fa-solid fa-circle-check"></i>
                </button>
              ` : `
                <button data-action="disable" data-id="${u.id}"
                        class="user-action px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded" title="Deshabilitar">
                  <i class="fa-solid fa-ban"></i>
                </button>
              `}
            ` : `
              <span class="text-xs text-gray-600">—</span>
            `}
          </td>
        </tr>
      `;
    }).join("");
  }

  // Mirror of can_actor_manage del backend (UI-only check, server hace el authoritative)
  function canActorManage(actor, target) {
    if (!actor || !target) return false;
    if (actor.status !== "active") return false;
    if (actor.role === "editor") return false;
    if (actor.role === "admin") return target.role === "editor";
    if (actor.role === "super_admin") return true;
    return false;
  }

  function buildPermissionsRows(perms) {
    return RESOURCES_ORDER.map(resource => {
      const p = perms[resource] || {};
      return `
        <tr>
          <td class="px-3 py-2 font-medium text-gray-300">${RESOURCES_LABELS[resource]}</td>
          <td class="px-3 py-2 text-center">
            <input type="checkbox" data-perm-resource="${resource}" data-perm-action="read"
                   class="perm-cb" ${p.can_read ? "checked" : ""}>
          </td>
          <td class="px-3 py-2 text-center">
            <input type="checkbox" data-perm-resource="${resource}" data-perm-action="write"
                   class="perm-cb" ${p.can_write ? "checked" : ""}>
          </td>
          <td class="px-3 py-2 text-center">
            <input type="checkbox" data-perm-resource="${resource}" data-perm-action="delete"
                   class="perm-cb" ${p.can_delete ? "checked" : ""}>
          </td>
        </tr>
      `;
    }).join("");
  }

  function readPermissionsFromForm() {
    const out = {};
    RESOURCES_ORDER.forEach(r => {
      out[r] = {
        can_read: $(`input[data-perm-resource="${r}"][data-perm-action="read"]`)?.checked || false,
        can_write: $(`input[data-perm-resource="${r}"][data-perm-action="write"]`)?.checked || false,
        can_delete: $(`input[data-perm-resource="${r}"][data-perm-action="delete"]`)?.checked || false,
      };
    });
    return out;
  }

  function openInviteModal() {
    $("#user-modal-title").textContent = "Invitar usuario";
    $("#user-mode").value = "invite";
    $("#user-id").value = "";
    $("#user-email").value = "";
    $("#user-email").disabled = false;
    $("#user-fullname").value = "";
    $("#user-role").value = "editor";
    $("#user-status-section").classList.add("hidden");
    $("#user-edit-banner").classList.add("hidden");
    $("#user-form-error").classList.add("hidden");
    $("#user-form-submit-label").textContent = "Enviar invitación";
    // Si actor es admin, oculta opciones admin/super_admin
    const actor = getCurrentUser();
    $$("#user-role option").forEach(opt => {
      const restriction = opt.dataset.roleRestriction;
      opt.disabled = restriction && actor.role !== restriction;
      if (opt.disabled) opt.hidden = true;
      else opt.hidden = false;
    });
    $("#user-perms-tbody").innerHTML = buildPermissionsRows({});
    togglePermissionsSection();
    openModal("#user-modal");
    $("#user-email").focus();
  }

  async function openEditModal(userId) {
    try {
      const json = await api("GET", `/api/users/${userId}`);
      const u = json.user;
      const perms = json.permissions || {};
      $("#user-modal-title").textContent = "Editar usuario";
      $("#user-mode").value = "edit";
      $("#user-id").value = u.id;
      $("#user-email").value = u.email;
      $("#user-email").disabled = true;
      $("#user-fullname").value = u.full_name || "";
      $("#user-role").value = u.role;
      $("#user-status").value = u.status;
      $("#user-status-section").classList.remove("hidden");
      $("#user-edit-banner").classList.remove("hidden");
      $("#user-form-error").classList.add("hidden");
      $("#user-form-submit-label").textContent = "Guardar cambios";
      const actor = getCurrentUser();
      $$("#user-role option").forEach(opt => {
        const restriction = opt.dataset.roleRestriction;
        opt.disabled = restriction && actor.role !== restriction;
        if (opt.disabled) opt.hidden = true;
        else opt.hidden = false;
      });
      $("#user-perms-tbody").innerHTML = buildPermissionsRows(perms);
      togglePermissionsSection();
      openModal("#user-modal");
    } catch (e) {
      alert("Error: " + e.message);
    }
  }

  function togglePermissionsSection() {
    const role = $("#user-role").value;
    const section = $("#user-permissions-section");
    section.classList.toggle("hidden", role !== "editor");
  }

  async function submitUserForm(e) {
    e.preventDefault();
    const errEl = $("#user-form-error");
    errEl.classList.add("hidden");
    const mode = $("#user-mode").value;
    const role = $("#user-role").value;
    const fullname = $("#user-fullname").value.trim() || null;
    const permissions = readPermissionsFromForm();

    try {
      if (mode === "invite") {
        const email = $("#user-email").value.trim();
        const payload = {
          email, full_name: fullname, role,
          permissions: role === "editor" ? permissions : null,
        };
        const json = await api("POST", "/api/users/invite", payload);
        $("#user-modal").classList.add("hidden");
        if (json.email_sent) {
          alert(`Invitación enviada a ${email}.`);
        } else {
          alert(`Invitación creada (id=${json.invitation.id.slice(0,8)}…) pero el email FALLÓ. Revisá SES.`);
        }
        loadUsers();
      } else {
        const userId = $("#user-id").value;
        const status = $("#user-status").value;
        const payload = {
          full_name: fullname,
          role,
          status,
          permissions: role === "editor" ? permissions : null,
        };
        await api("PATCH", `/api/users/${userId}`, payload);
        $("#user-modal").classList.add("hidden");
        loadUsers();
      }
    } catch (err) {
      errEl.textContent = err.message || "Error al guardar";
      errEl.classList.remove("hidden");
    }
  }

  async function disableUser(userId) {
    if (!confirm("¿Deshabilitar este usuario? Sus sesiones activas serán cerradas.")) return;
    try {
      await api("DELETE", `/api/users/${userId}`);
      loadUsers();
    } catch (e) { alert("Error: " + e.message); }
  }

  async function enableUser(userId) {
    try {
      await api("PATCH", `/api/users/${userId}`, { status: "active" });
      loadUsers();
    } catch (e) { alert("Error: " + e.message); }
  }

  async function resendInvitation(userId) {
    if (!confirm("¿Reenviar invitación? La invitación anterior queda revocada.")) return;
    try {
      const json = await api("POST", `/api/users/${userId}/resend-invitation`);
      alert(json.email_sent ? "Invitación reenviada." : "Invitación creada pero el email falló (revisar SES).");
    } catch (e) { alert("Error: " + e.message); }
  }

  // Listeners de Usuarios tab
  if ($("#users-refresh")) {
    $("#users-refresh").addEventListener("click", loadUsers);
    $("#users-invite-btn").addEventListener("click", openInviteModal);
    $("#user-form").addEventListener("submit", submitUserForm);
    $("#user-role").addEventListener("change", togglePermissionsSection);
    $("#perms-grant-all").addEventListener("click", () => {
      $$("input.perm-cb").forEach(cb => cb.checked = true);
    });
    $("#perms-clear-all").addEventListener("click", () => {
      $$("input.perm-cb").forEach(cb => cb.checked = false);
    });
    $("#users-tbody").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      const action = btn.dataset.action;
      if (action === "edit") openEditModal(id);
      if (action === "disable") disableUser(id);
      if (action === "enable") enableUser(id);
      if (action === "resend") resendInvitation(id);
    });
  }

  // ---------- Boot (v3.2.0) ----------
  // Flujo:
  //   1. Si bootstrap_done=false → mostrar wizard de bootstrap
  //   2. Sino → GET /api/auth/me (vía cookie). Si OK → showApp(). Si 401 → showLogin()
  //   3. Legacy: ?recover=<id> sigue funcionando como path de fallback
  //      (magic link que el sistema viejo manda). Va a quedar habilitado hasta
  //      que se elimine /api/admin/exchange-recovery en una versión futura.
  (async function boot() {
    const params = new URLSearchParams(window.location.search);
    const recoveryId = params.get("recover");

    // Path legacy: ?recover=<id> (ADMIN_TOKEN-based). Solo válido pre-bootstrap.
    if (recoveryId) {
      window.history.replaceState({}, "", window.location.pathname);
      showLogin();
      const errEl  = $("#login-error");
      const infoEl = $("#login-info");
      infoEl.textContent = "Verificando enlace de recuperación…";
      infoEl.classList.remove("hidden");
      try {
        const res = await fetch(`${API_BASE}/api/admin/exchange-recovery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recovery_id: recoveryId }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.ok && json.admin_token) {
          // Solo funciona si bootstrap_done=false. Tras ello el endpoint
          // del backend retorna 500/401 igual.
          infoEl.classList.add("hidden");
          // Pre-bootstrap: muestra el wizard pre-poblando token
          $("#bootstrap-token").value = json.admin_token;
          showBootstrap();
          return;
        }
        infoEl.classList.add("hidden");
        errEl.textContent = "Enlace inválido o expirado.";
        errEl.classList.remove("hidden");
      } catch (e) {
        infoEl.classList.add("hidden");
        errEl.textContent = "Error de red al validar el enlace.";
        errEl.classList.remove("hidden");
      }
      return;
    }

    // Path normal: chequear bootstrap_done y session.
    try {
      const bsRes = await fetch(`${API_BASE}/api/auth/bootstrap-status`, {
        credentials: "include",
      });
      const bsJson = await bsRes.json().catch(() => ({}));
      if (!bsJson.bootstrap_done) {
        showBootstrap();
        return;
      }
    } catch (e) {
      // Si no podemos chequear el status, default a login
      showLogin();
      return;
    }

    // bootstrap_done=true → intentar /api/auth/me con cookie
    try {
      const meRes = await fetch(`${API_BASE}/api/auth/me`, {
        credentials: "include",
      });
      if (meRes.ok) {
        const meJson = await meRes.json();
        if (meJson.ok && meJson.user) {
          _currentUser = meJson.user;
          _currentPermissions = meJson.permissions || {};
          showApp();
          return;
        }
      }
    } catch (e) { /* network error → login */ }

    showLogin();
  })();
})();
