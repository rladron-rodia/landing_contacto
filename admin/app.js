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
  let allContacts   = [];
  let allStats      = [];
  let allGames      = [];
  let allPublishers = [];
  let allLinks      = [];
  let allDelivery   = [];
  let allInfoCols   = [];
  let currentView   = "contacts";

  // ---------- Token ----------
  const getToken   = () => localStorage.getItem(TOKEN_KEY) || "";
  const setToken   = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

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
    $("#games-view").classList.toggle("hidden", name !== "games");
    $("#publishers-view").classList.toggle("hidden", name !== "publishers");
    $("#links-view").classList.toggle("hidden", name !== "links");
    $("#delivery-view").classList.toggle("hidden", name !== "delivery");
    $("#info-view").classList.toggle("hidden", name !== "info");
    if (name === "contacts")   loadContacts();
    if (name === "stats")      loadStats();
    if (name === "games")      loadGames();
    if (name === "publishers") loadPublishers();
    if (name === "links")      loadLinks();
    if (name === "delivery")   loadDelivery();
    if (name === "info")       loadInfoColumns();
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
    $("#game-link").value       = game ? (game.link_url  || "") : "";
    $("#game-desc-es").value    = game ? (game.description_es || "") : "";
    $("#game-desc-en").value    = game ? (game.description_en || "") : "";
    $("#game-tags-es").value    = game ? (game.tags_es || []).join(", ") : "";
    $("#game-tags-en").value    = game ? (game.tags_en || []).join(", ") : "";
    $("#game-order").value      = game ? (game.display_order ?? 0) : 0;
    $("#game-category").value   = cat;
    refreshGameImagePreview();
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

  async function submitGameForm(e) {
    e.preventDefault();
    $("#game-form-error").classList.add("hidden");
    const titleEs = $("#game-title-es").value.trim();
    const titleEn = $("#game-title-en").value.trim();
    const category = $("#game-category").value || "f2p";
    const payload = {
      slug:           $("#game-slug").value.trim(),
      title_es:       titleEs,
      title_en:       titleEn,
      title:          titleEs || titleEn,  // legacy fallback
      image_url:      $("#game-image").value.trim(),
      link_url:       $("#game-link").value.trim(),
      description_es: $("#game-desc-es").value.trim(),
      description_en: $("#game-desc-en").value.trim(),
      tags_es:        $("#game-tags-es").value,
      tags_en:        $("#game-tags-en").value,
      category:       category,
      display_order:  parseInt($("#game-order").value, 10) || 0,
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
  $("#game-image").addEventListener("input", refreshGameImagePreview);

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

  function openLinkModal(link) {
    const isNew = !link;
    $("#link-modal-title").textContent = isNew ? "Nuevo enlace" : "Editar enlace";
    $("#link-form-error").classList.add("hidden");
    $("#link-key").value         = link ? link.key : "";
    $("#link-key").disabled       = !isNew;
    $("#link-description").value  = link ? (link.description || "") : "";
    $("#link-url").value          = link ? (link.url || "") : "";
    $("#link-image").value        = link ? (link.image_url || "") : "";
    $("#link-label-es").value     = link ? (link.label_es || "") : "";
    $("#link-label-en").value     = link ? (link.label_en || "") : "";
    $("#link-order").value        = link ? (link.display_order ?? 0) : 0;
    refreshLinkImagePreview();
    openModal("#link-modal");
    setTimeout(() => $("#link-url").focus(), 0);
  }

  async function submitLinkForm(e) {
    e.preventDefault();
    $("#link-form-error").classList.add("hidden");
    const payload = {
      key:           $("#link-key").value.trim(),
      description:   $("#link-description").value.trim(),
      url:           $("#link-url").value.trim(),
      image_url:     $("#link-image").value.trim(),
      label_es:      $("#link-label-es").value.trim(),
      label_en:      $("#link-label-en").value.trim(),
      display_order: parseInt($("#link-order").value, 10) || 0,
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
  $("#link-image").addEventListener("input", refreshLinkImagePreview);

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
    // Right-click (context menu) en el backdrop NO debe cerrar
    m.addEventListener("contextmenu", (e) => {
      // Si el contextmenu es sobre un input/textarea/select, dejar pasar
      // (el browser muestra Cortar/Copiar/Pegar nativos)
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
        // No prevent default; permite que el menú nativo aparezca
        return;
      }
    });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllModals(); });

  // ---------- Boot ----------
  if (getToken()) showApp();
  else            showLogin();
})();
