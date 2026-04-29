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
    return "https://landing-contacto-backend.onrender.com";
  })();
  const TOKEN_KEY = "monou_admin_token";

  // ---------- DOM helpers ----------
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ---------- State ----------
  let allContacts = [];
  let allStats    = [];
  let currentView = "contacts";

  // ---------- Token ----------
  const getToken   = () => localStorage.getItem(TOKEN_KEY) || "";
  const setToken   = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

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

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { "Authorization": `Bearer ${getToken()}` },
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (res.status === 401) { clearToken(); throw new Error("Token inválido"); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json;
  }

  // ---------- View routing ----------
  function showLogin(msg) {
    $("#login-view").classList.remove("hidden");
    $("#login-view").classList.add("flex");
    $("#app-view").classList.add("hidden");
    if (msg) {
      $("#login-error").textContent = msg;
      $("#login-error").classList.remove("hidden");
    } else {
      $("#login-error").classList.add("hidden");
    }
    $("#token-input").focus();
  }

  function showApp() {
    $("#login-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    $("#app-view").classList.add("flex");
    selectView("contacts");
  }

  function selectView(name) {
    currentView = name;
    $$(".nav-btn").forEach(b => {
      b.classList.toggle("nav-item-active", b.dataset.view === name);
    });
    $("#contacts-view").classList.toggle("hidden", name !== "contacts");
    $("#stats-view").classList.toggle("hidden", name !== "stats");
    if (name === "contacts") loadContacts();
    if (name === "stats")    loadStats();
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
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("#token-input").value.trim();
    if (!t) return;
    setToken(t);
    showApp();
  });

  $$(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => selectView(btn.dataset.view));
  });

  $("#logout-btn").addEventListener("click", () => { clearToken(); showLogin(); });

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

  // Modales
  $$(".modal-close").forEach(btn => btn.addEventListener("click", closeAllModals));
  $$(".fixed.inset-0").forEach(m => {
    m.addEventListener("click", (e) => { if (e.target === m) closeAllModals(); });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllModals(); });

  // ---------- Boot ----------
  if (getToken()) showApp();
  else            showLogin();
})();
