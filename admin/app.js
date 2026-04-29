/**
 * Admin dashboard de Monou.gg — listado de contactos vía /api/contacts
 *
 * Auto-detecta el backend (localhost vs producción) igual que la landing.
 * Token guardado en localStorage; logout lo borra.
 */

(function () {
  // ---------- Config ----------
  const API_BASE = (function () {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "") {
      return "http://localhost:5000";
    }
    return "https://landing-contacto-backend.onrender.com";
  })();
  const TOKEN_KEY = "monou_admin_token";

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const loginView   = $("#login-view");
  const appView     = $("#app-view");
  const loginForm   = $("#login-form");
  const tokenInput  = $("#token-input");
  const loginError  = $("#login-error");
  const refreshBtn  = $("#refresh-btn");
  const logoutBtn   = $("#logout-btn");
  const exportBtn   = $("#export-btn");
  const retryBtn    = $("#retry-btn");
  const tableWrap   = $("#table-wrapper");
  const tableBody   = $("#table-body");
  const loadingEl   = $("#loading-state");
  const emptyEl     = $("#empty-state");
  const errorEl     = $("#error-state");
  const errorMsgEl  = $("#error-message");
  const countBadge  = $("#count-badge");
  const searchInput = $("#search-input");
  const statusFilter= $("#status-filter");
  const modal       = $("#detail-modal");
  const modalBody   = $("#modal-body");
  const modalClose  = $("#modal-close");

  // ---------- State ----------
  let allContacts = [];

  // ---------- Helpers ----------
  function getToken()  { return localStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

  function showView(view) {
    [loginView, appView].forEach(v => v.classList.add("hidden"));
    view.classList.remove("hidden");
    view.classList.add(view === loginView ? "flex" : "block");
  }

  function showState(state) {
    [loadingEl, emptyEl, errorEl, tableWrap].forEach(el => el.classList.add("hidden"));
    state.classList.remove("hidden");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("es-MX", {
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

  // ---------- API ----------
  async function fetchContacts() {
    const token = getToken();
    if (!token) throw new Error("Sin token");
    const res = await fetch(`${API_BASE}/api/contacts?limit=500`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (res.status === 401) {
      clearToken();
      throw new Error("Token inválido o expirado");
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    return json.contacts || [];
  }

  // ---------- Render ----------
  function statusTag(status) {
    const cls = status === "emailed" ? "tag-emailed"
              : status === "failed"  ? "tag-failed"
              : "tag-received";
    const label = status || "received";
    return `<span class="tag ${cls}">${escapeHtml(label)}</span>`;
  }

  function renderRows() {
    const q = (searchInput.value || "").toLowerCase().trim();
    const status = statusFilter.value;
    const filtered = allContacts.filter(c => {
      if (status && c.status !== status) return false;
      if (!q) return true;
      const blob = `${c.nombre||""} ${c.email||""} ${c.empresa||""}`.toLowerCase();
      return blob.includes(q);
    });

    countBadge.textContent = `${filtered.length} de ${allContacts.length}`;

    if (!filtered.length) {
      showState(emptyEl);
      emptyEl.querySelector("p").textContent = allContacts.length
        ? "Ningún contacto coincide con el filtro."
        : "Aún no hay contactos.";
      return;
    }

    tableBody.innerHTML = filtered.map(c => `
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
    showState(tableWrap);
  }

  function renderDetail(c) {
    modalBody.innerHTML = `
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
        </div>` : ''}
    `;
    modal.classList.remove("hidden");
  }

  // ---------- CSV Export ----------
  function exportCsv() {
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

  // ---------- Flow ----------
  async function load() {
    showState(loadingEl);
    try {
      allContacts = await fetchContacts();
      renderRows();
    } catch (err) {
      if (err.message.includes("Token")) {
        showLogin(err.message);
      } else {
        errorMsgEl.textContent = err.message;
        showState(errorEl);
      }
    }
  }

  function showLogin(msg) {
    showView(loginView);
    if (msg) {
      loginError.textContent = msg;
      loginError.classList.remove("hidden");
    } else {
      loginError.classList.add("hidden");
    }
    tokenInput.focus();
  }

  function showApp() {
    showView(appView);
    appView.classList.remove("hidden");
    appView.classList.add("block");
    load();
  }

  // ---------- Listeners ----------
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = tokenInput.value.trim();
    if (!t) return;
    setToken(t);
    showApp();
  });

  refreshBtn.addEventListener("click", load);
  retryBtn.addEventListener("click", load);
  logoutBtn.addEventListener("click", () => { clearToken(); showLogin(); });
  exportBtn.addEventListener("click", exportCsv);
  searchInput.addEventListener("input", renderRows);
  statusFilter.addEventListener("change", renderRows);

  tableBody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    const c = allContacts.find(x => String(x.id) === id);
    if (c) renderDetail(c);
  });

  modalClose.addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.classList.add("hidden"); });

  // ---------- Boot ----------
  if (getToken()) showApp();
  else            showLogin();
})();
