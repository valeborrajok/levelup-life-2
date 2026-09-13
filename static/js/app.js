/*
 * app.js — Controlador de interacción de LevelUp Life.
 *
 * Sin frameworks: fetch + DOM directo. Todo el estado vive en memoria
 * (el objeto `state`) y se vuelve a pedir al backend después de cada
 * acción que lo cambia, así la UI nunca queda desincronizada de la base
 * de datos real.
 */
"use strict";

/* ======================================================================
   Estado y helpers de DOM
   ====================================================================== */
const API = "/api";
const MAX_FINAL_ATTEMPTS = 3; // debe coincidir con services.MAX_FINAL_ATTEMPTS

const state = {
  profile: null,
  quests: [],
  questFilter: "",
  folders: [],
  trees: [],
  currentTreeId: null,
  shopItems: [],
  achievements: [],
  levelConfigs: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escapa texto antes de insertarlo con innerHTML (evita inyección de HTML). */
function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString("es-AR");
}

function formatARS(n) {
  return `$${formatNumber(n)}`;
}

/** "2026-09-09" -> "09/09/2026". Se parsea a mano (sin Date) para evitar
 *  el corrimiento de un día por zona horaria que da `new Date(iso)`. */
function formatDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

/** El backend guarda fechas/horas en UTC "naive" (sin sufijo de zona).
 *  Se le agrega 'Z' para que el navegador la interprete como UTC. */
function formatDateTime(iso) {
  const normalized = iso.includes("Z") || iso.includes("+") ? iso : `${iso.split(".")[0]}Z`;
  const d = new Date(normalized);
  return d.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isImageUrl(value) {
  return /^https?:\/\//i.test(value || "");
}

const CATEGORY_LABELS = {
  diaria: "Diaria",
  semanal: "Semanal",
  campana: "Campaña",
  meta: "Meta",
  evento: "Evento",
};

/* ======================================================================
   Cliente de la API REST
   ====================================================================== */
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch {
    throw new Error("No se pudo conectar con el servidor.");
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* respuesta sin cuerpo */
  }

  if (!res.ok) {
    throw new Error((data && data.error) || "Ocurrió un error inesperado.");
  }
  return data;
}

const Api = {
  getProfile: () => api("/profile"),
  updateProfile: (payload) => api("/profile", { method: "PUT", body: JSON.stringify(payload) }),

  listQuests: (category) => api(category ? `/quests?category=${encodeURIComponent(category)}` : "/quests"),
  createQuest: (payload) => api("/quests", { method: "POST", body: JSON.stringify(payload) }),
  updateQuest: (id, payload) => api(`/quests/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteQuest: (id) => api(`/quests/${id}`, { method: "DELETE" }),
  completeQuest: (id) => api(`/quests/${id}/complete`, { method: "POST" }),

  listFolders: () => api("/folders"),
  createFolder: (payload) => api("/folders", { method: "POST", body: JSON.stringify(payload) }),
  updateFolder: (id, payload) => api(`/folders/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteFolder: (id) => api(`/folders/${id}`, { method: "DELETE" }),

  listTrees: () => api("/skill-trees"),
  createTree: (payload) => api("/skill-trees", { method: "POST", body: JSON.stringify(payload) }),
  updateTree: (id, payload) => api(`/skill-trees/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteTree: (id) => api(`/skill-trees/${id}`, { method: "DELETE" }),

  createBranch: (treeId, payload) =>
    api(`/skill-trees/${treeId}/branches`, { method: "POST", body: JSON.stringify(payload) }),
  deleteBranch: (id) => api(`/branches/${id}`, { method: "DELETE" }),
  resetBranch: (id) => api(`/branches/${id}/reset`, { method: "POST" }),

  createNode: (branchId, payload) => api(`/branches/${branchId}/nodes`, { method: "POST", body: JSON.stringify(payload) }),
  updateNode: (id, payload) => api(`/nodes/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteNode: (id) => api(`/nodes/${id}`, { method: "DELETE" }),
  completeNode: (id) => api(`/nodes/${id}/complete`, { method: "POST" }),
  failNode: (id) => api(`/nodes/${id}/fail`, { method: "POST" }),

  listShop: () => api("/shop"),
  createShopItem: (payload) => api("/shop", { method: "POST", body: JSON.stringify(payload) }),
  updateShopItem: (id, payload) => api(`/shop/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteShopItem: (id) => api(`/shop/${id}`, { method: "DELETE" }),
  purchase: (id) => api(`/shop/${id}/purchase`, { method: "POST" }),
  purchaseLog: () => api("/purchase-log"),
  listAchievements: () => api("/achievements"),
  createAchievement: (payload) => api("/achievements", { method: "POST", body: JSON.stringify(payload) }),
  updateAchievement: (id, payload) => api(`/achievements/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteAchievement: (id) => api(`/achievements/${id}`, { method: "DELETE" }),
  toggleAchievement: (id) => api(`/achievements/${id}/toggle`, { method: "POST" }),
  listLevelConfigs: () => api("/level-configs"),
  createLevelConfig: (payload) => api("/level-configs", { method: "POST", body: JSON.stringify(payload) }),
  updateLevelConfig: (id, payload) => api(`/level-configs/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteLevelConfig: (id) => api(`/level-configs/${id}`, { method: "DELETE" }),
};

/** Envuelve una acción async: si el backend devuelve un GameError (4xx),
 *  el mensaje en español ya viene armado — solo hay que mostrarlo. */
async function runWithToastOnError(fn) {
  try {
    await fn();
  } catch (err) {
    showToast(err.message || "Ocurrió un error.", "error");
  }
}

/* ======================================================================
   Toasts
   ====================================================================== */
function showToast(message, type = "success") {
  const stack = $("#toast-stack");
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <svg aria-hidden="true"><use href="#icon-${type === "success" ? "check" : "warning"}"></use></svg>
    <span>${escapeHTML(message)}</span>
  `;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("is-leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 500); // red de seguridad si el navegador no dispara animationend
  }, 3400);
}

function emptyStateHTML(title, hint) {
  return `
    <div class="empty-state">
      <svg aria-hidden="true"><use href="#icon-warning"></use></svg>
      <p><strong>${escapeHTML(title)}</strong><br>${escapeHTML(hint || "")}</p>
    </div>
  `;
}

/* ======================================================================
   Modal genérico (hoja inferior en mobile, diálogo centrado en desktop)
   ====================================================================== */
const modalOverlay = $("#modal-overlay");
const modalEl = $("#modal");

function openModal({ title, bodyHTML, footerHTML, onMount }) {
  modalEl.innerHTML = `
    <div class="modal__header">
      <h3 class="modal__title" id="modal-title">${escapeHTML(title)}</h3>
      <button class="icon-btn" id="modal-close" type="button" aria-label="Cerrar">
        <svg aria-hidden="true"><use href="#icon-close"></use></svg>
      </button>
    </div>
    <div class="modal__body">${bodyHTML}</div>
    ${footerHTML ? `<div class="modal__footer">${footerHTML}</div>` : ""}
  `;
  modalOverlay.classList.add("is-open");
  $("#modal-close").addEventListener("click", closeModal);
  if (onMount) onMount(modalEl);
}

function closeModal() {
  modalOverlay.classList.remove("is-open");
  modalEl.innerHTML = "";
}

modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalOverlay.classList.contains("is-open")) closeModal();
});

function confirmAction(message, onConfirm, { confirmText = "Eliminar", danger = true } = {}) {
  openModal({
    title: "Confirmar",
    bodyHTML: `<p>${escapeHTML(message)}</p>`,
    footerHTML: `
      <button class="btn btn--ghost" id="confirm-cancel" type="button">Cancelar</button>
      <button class="btn ${danger ? "btn--danger" : "btn--primary"}" id="confirm-ok" type="button">${escapeHTML(confirmText)}</button>
    `,
  });
  $("#confirm-cancel").addEventListener("click", closeModal);
  $("#confirm-ok").addEventListener("click", async () => {
    closeModal();
    await onConfirm();
  });
}

/** Modal reutilizable para pedir un solo campo de texto (nombre de árbol/categoría). */
function openSimpleTextModal({ title, label, placeholder, initialValue = "", saveText = "Guardar", onSave }) {
  const bodyHTML = `
    <div class="form-field">
      <label for="f-simple-text">${escapeHTML(label)}</label>
      <input id="f-simple-text" type="text" maxlength="150" placeholder="${escapeHTML(placeholder || "")}" value="${escapeHTML(initialValue)}" />
    </div>
    <p class="form-error" id="f-simple-error"></p>
  `;
  openModal({
    title,
    bodyHTML,
    footerHTML: `
      <button class="btn btn--ghost" id="simple-cancel" type="button">Cancelar</button>
      <button class="btn btn--primary" id="simple-save" type="button">${escapeHTML(saveText)}</button>
    `,
    onMount: () => $("#f-simple-text").focus(),
  });
  $("#simple-cancel").addEventListener("click", closeModal);
  $("#simple-save").addEventListener("click", async () => {
    const value = $("#f-simple-text").value.trim();
    if (!value) {
      $("#f-simple-error").textContent = "Este campo es obligatorio.";
      return;
    }
    await runWithToastOnError(async () => {
      await onSave(value);
      closeModal();
    });
  });
}

/* ======================================================================
   Perfil (nivel, XP, monedas, nombre y avatar)
   ====================================================================== */
function renderProfile() {
  const p = state.profile;
  if (!p) return;

  $("#level-number").textContent = p.level;
  $("#level-badge").setAttribute("aria-label", `Nivel ${p.level}${p.level_title ? ": " + p.level_title : ""}`);

  const titleIconHTML = p.level_title && p.level_image_url
    ? `<img class="xp-bar__title-icon" src="${escapeHTML(p.level_image_url)}" alt="" />`
    : "";
  $("#xp-bar-title").innerHTML = p.level_title ? `${titleIconHTML}${escapeHTML(p.level_title)}` : "";

  $("#xp-current-label").textContent = `${formatNumber(p.total_xp)} XP`;
  $("#xp-next-label").textContent = p.is_max_level ? "Nivel máximo" : `${formatNumber(p.xp_for_next_level)} XP`;

  // Progreso DENTRO del nivel actual. El umbral de inicio del nivel
  // actual lo manda el backend (xp_for_current_level) — no se asume acá
  // la fórmula matemática, porque con niveles personalizados los
  // umbrales pueden ser cualquier valor arbitrario.
  const span = p.xp_for_next_level - p.xp_for_current_level;
  const progress = p.is_max_level || span <= 0
    ? 100
    : ((p.total_xp - p.xp_for_current_level) / span) * 100;
  $("#xp-bar-fill").style.width = `${Math.max(0, Math.min(100, progress))}%`;

  $("#gold-amount").textContent = formatNumber(p.gold_coins);
  $("#cash-amount").textContent = formatARS(p.real_money_balance);

  $("#profile-name").textContent = p.name || "Sin nombre";
  const avatarEl = $("#profile-avatar");
  if (isImageUrl(p.avatar)) {
    avatarEl.innerHTML = `<img src="${escapeHTML(p.avatar)}" alt="" />`;
  } else {
    avatarEl.textContent = p.avatar || "🙂";
  }

  // Los botones de "Comprar" dependen de si el perfil puede pagarlos.
  if (state.shopItems.length) renderShopList();
}

async function loadProfile() {
  try {
    state.profile = await Api.getProfile();
    renderProfile();
  } catch (err) {
    showToast(err.message || "No se pudo cargar el perfil.", "error");
  }
}

function openEditProfileModal() {
  const p = state.profile || {};
  const bodyHTML = `
    <div class="form-field">
      <label for="f-profile-name">Nombre</label>
      <input id="f-profile-name" type="text" maxlength="60" value="${p.name ? escapeHTML(p.name) : ""}" placeholder="Tu nombre" />
    </div>
    <div class="form-field">
      <label for="f-profile-avatar">Avatar (emoji o URL de imagen)</label>
      <input id="f-profile-avatar" type="text" maxlength="500" value="${p.avatar ? escapeHTML(p.avatar) : ""}" placeholder="🧬 o https://..." />
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="f-profile-xp">XP total</label>
        <input id="f-profile-xp" type="number" min="0" value="${p.total_xp ?? 0}" />
      </div>
      <div class="form-field">
        <label for="f-profile-gold">Gold Coins</label>
        <input id="f-profile-gold" type="number" min="0" value="${p.gold_coins ?? 0}" />
      </div>
    </div>
    <div class="form-field">
      <label for="f-profile-cash">Saldo real ($)</label>
      <input id="f-profile-cash" type="number" value="${p.real_money_balance ?? 0}" />
    </div>
    <p class="modal__hint">Estos valores se pisan directamente (no se suman) — usalo para corregir XP de prueba o ajustar tu saldo real a mano.</p>
    <div class="modal__divider"></div>
    <button class="btn btn--ghost btn--block" id="profile-manage-levels" type="button">Gestionar niveles personalizados</button>
    <p class="form-error" id="f-profile-error"></p>
  `;
  openModal({
    title: "Editar perfil",
    bodyHTML,
    footerHTML: `
      <button class="btn btn--ghost" id="profile-cancel" type="button">Cancelar</button>
      <button class="btn btn--primary" id="profile-save" type="button">Guardar</button>
    `,
    onMount: () => $("#f-profile-name").focus(),
  });

  $("#profile-manage-levels").addEventListener("click", openLevelConfigManagerModal);
  $("#profile-cancel").addEventListener("click", closeModal);
  $("#profile-save").addEventListener("click", async () => {
    const payload = {
      name: $("#f-profile-name").value.trim(),
      avatar: $("#f-profile-avatar").value.trim(),
      total_xp: Number($("#f-profile-xp").value || 0),
      gold_coins: Number($("#f-profile-gold").value || 0),
      real_money_balance: Number($("#f-profile-cash").value || 0),
    };
    await runWithToastOnError(async () => {
      state.profile = await Api.updateProfile(payload);
      renderProfile();
      closeModal();
      showToast("Perfil actualizado.", "success");
    });
  });
}

$("#btn-edit-profile").addEventListener("click", openEditProfileModal);

async function loadLevelConfigs() {
  try {
    state.levelConfigs = await Api.listLevelConfigs();
  } catch (err) {
    showToast(err.message || "No se pudieron cargar los niveles.", "error");
  }
}

function levelConfigRowHTML(cfg) {
  return `
    <div class="folder-row" data-id="${cfg.id}">
      <span class="folder-row__name">
        <strong class="num">Nv. ${cfg.level_number}</strong> — ${escapeHTML(cfg.title || "(sin nombre)")}
        <br /><span class="modal__hint" style="margin-top:2px;">${formatNumber(cfg.xp_threshold)} XP</span>
      </span>
      <div class="folder-row__actions">
        <button class="icon-btn" data-action="edit-level" data-id="${cfg.id}" type="button" aria-label="Editar nivel">
          <svg aria-hidden="true"><use href="#icon-pencil"></use></svg>
        </button>
        <button class="icon-btn icon-btn--danger" data-action="delete-level" data-id="${cfg.id}" type="button" aria-label="Eliminar nivel">
          <svg aria-hidden="true"><use href="#icon-trash"></use></svg>
        </button>
      </div>
    </div>
  `;
}

function openLevelConfigManagerModal() {
  const rowsHTML = state.levelConfigs.length
    ? state.levelConfigs.map(levelConfigRowHTML).join("")
    : `<p class="branch-empty">Sin niveles personalizados todavía — se usa la fórmula matemática por defecto.</p>`;

  openModal({
    title: "Niveles personalizados",
    bodyHTML: `
      <p class="modal__hint">En cuanto agregués el primer nivel acá, reemplaza la fórmula matemática por completo para siempre (hasta que borres todos de nuevo).</p>
      <div class="folder-rows" id="level-rows" style="margin-top: var(--space-3);">${rowsHTML}</div>
    `,
    footerHTML: `<button class="btn btn--primary btn--block" id="level-add" type="button">+ Nuevo nivel</button>`,
  });

  $("#level-rows").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const config = state.levelConfigs.find((c) => c.id === id);
    if (!config) return;

    if (btn.dataset.action === "edit-level") {
      openLevelFormModal(config);
    } else if (btn.dataset.action === "delete-level") {
      confirmAction(`¿Eliminar el nivel "${config.title || "Nv. " + config.level_number}"?`, async () => {
        await runWithToastOnError(async () => {
          await Api.deleteLevelConfig(id);
          await loadLevelConfigs();
          await loadProfile();
          showToast("Nivel eliminado.", "success");
          openLevelConfigManagerModal();
        });
      });
    }
  });

  $("#level-add").addEventListener("click", () => openLevelFormModal());
}

function openLevelFormModal(config = null) {
  const isEdit = !!config;
  const bodyHTML = `
    <div class="form-field">
      <label for="f-level-threshold">Umbral de XP</label>
      <input id="f-level-threshold" type="number" min="0" value="${config ? config.xp_threshold : ""}" placeholder="Ej: 5000" />
    </div>
    <div class="form-field">
      <label for="f-level-title">Nombre del nivel (opcional)</label>
      <input id="f-level-title" type="text" maxlength="150" value="${config && config.title ? escapeHTML(config.title) : ""}" placeholder="Ej: Estudiante Avanzado" />
    </div>
    <div class="form-field">
      <label for="f-level-image">URL de imagen/ícono (opcional)</label>
      <input id="f-level-image" type="text" maxlength="500" value="${config && config.image_url ? escapeHTML(config.image_url) : ""}" placeholder="https://..." />
    </div>
    <p class="form-error" id="f-level-error"></p>
  `;
  openModal({
    title: isEdit ? "Editar nivel" : "Nuevo nivel",
    bodyHTML,
    footerHTML: `
      <button class="btn btn--ghost" id="level-cancel" type="button">Cancelar</button>
      <button class="btn btn--primary" id="level-save" type="button">${isEdit ? "Guardar cambios" : "Crear nivel"}</button>
    `,
    onMount: () => $("#f-level-threshold").focus(),
  });

  $("#level-cancel").addEventListener("click", () => openLevelConfigManagerModal());
  $("#level-save").addEventListener("click", async () => {
    const rawThreshold = $("#f-level-threshold").value;
    const threshold = Number(rawThreshold);
    if (rawThreshold === "" || threshold < 0) {
      $("#f-level-error").textContent = "El umbral de XP es obligatorio y no puede ser negativo.";
      return;
    }
    const payload = {
      xp_threshold: threshold,
      title: $("#f-level-title").value.trim(),
      image_url: $("#f-level-image").value.trim(),
    };
    await runWithToastOnError(async () => {
      if (isEdit) {
        await Api.updateLevelConfig(config.id, payload);
        showToast("Nivel actualizado.", "success");
      } else {
        await Api.createLevelConfig(payload);
        showToast("Nivel creado.", "success");
      }
      await loadLevelConfigs();
      await loadProfile();
      openLevelConfigManagerModal();
    });
  });
}

/* ======================================================================
   Misiones
   ====================================================================== */
function questCardHTML(q) {
  const done = q.is_completed;
  const dueHTML = q.due_date ? `<span class="tag">Vence: ${formatDate(q.due_date)}</span>` : "";
  const styleAttr = q.color ? ` style="border-left-color:${escapeHTML(q.color)}"` : "";
  const iconBadgeHTML = q.icon ? `<span class="quest-card__icon-badge">${escapeHTML(q.icon)}</span>` : "";
  return `
    <article class="quest-card ${done ? "quest-card--done" : ""}" data-id="${q.id}"${styleAttr}>
      <button
        class="quest-check"
        data-action="complete-quest"
        data-id="${q.id}"
        ${done ? "disabled" : ""}
        type="button"
        aria-label="${done ? "Misión completada" : "Marcar como completada"}"
      >
        <svg aria-hidden="true"><use href="#icon-check"></use></svg>
      </button>
      ${iconBadgeHTML}
      <div class="quest-card__body">
        <p class="quest-card__title">${escapeHTML(q.title)}</p>
        <div class="quest-card__meta">
          <span class="tag">${CATEGORY_LABELS[q.category] || q.category}</span>
          ${dueHTML}
          <span class="reward-pill reward-pill--xp">+${q.xp_reward} XP</span>
          <span class="reward-pill reward-pill--gold">
            <svg aria-hidden="true"><use href="#icon-coin"></use></svg>+${q.gold_reward}
          </span>
        </div>
      </div>
      <div class="quest-card__actions">
        <button class="icon-btn" data-action="edit-quest" data-id="${q.id}" type="button" aria-label="Editar misión">
          <svg aria-hidden="true"><use href="#icon-pencil"></use></svg>
        </button>
        <button class="icon-btn icon-btn--danger" data-action="delete-quest" data-id="${q.id}" type="button" aria-label="Eliminar misión">
          <svg aria-hidden="true"><use href="#icon-trash"></use></svg>
        </button>
      </div>
    </article>
  `;
}

function renderQuestList() {
  const listEl = $("#quest-list");
  if (state.quests.length === 0) {
    listEl.innerHTML = emptyStateHTML("No hay misiones en esta categoría.", "Creá una con el botón +.");
    return;
  }
  listEl.innerHTML = state.quests.map(questCardHTML).join("");
}

async function loadQuests() {
  const listEl = $("#quest-list");
  listEl.innerHTML = `<div class="loading-spinner" role="status" aria-label="Cargando misiones"></div>`;
  try {
    state.quests = await Api.listQuests(state.questFilter);
    renderQuestList();
  } catch (err) {
    listEl.innerHTML = emptyStateHTML("No se pudieron cargar las misiones.", err.message);
  }
}

function openQuestModal(quest = null) {
  const isEdit = !!quest;
  const bodyHTML = `
    <div class="form-field">
      <label for="f-title">Título</label>
      <input id="f-title" type="text" maxlength="200" value="${quest ? escapeHTML(quest.title) : ""}" placeholder="Ej: Repasar apuntes de Álgebra" />
    </div>
    <div class="form-field">
      <label for="f-category">Categoría</label>
      <select id="f-category">
        ${Object.entries(CATEGORY_LABELS)
          .map(([value, label]) => `<option value="${value}" ${quest && quest.category === value ? "selected" : ""}>${label}</option>`)
          .join("")}
      </select>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="f-xp">XP</label>
        <input id="f-xp" type="number" min="0" value="${quest ? quest.xp_reward : 10}" />
      </div>
      <div class="form-field">
        <label for="f-gold">Gold Coins</label>
        <input id="f-gold" type="number" min="0" value="${quest ? quest.gold_reward : 5}" />
      </div>
    </div>
    <div class="form-field">
      <label for="f-due">Fecha límite (opcional — para Campaña)</label>
      <input id="f-due" type="date" value="${quest && quest.due_date ? quest.due_date : ""}" />
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="f-quest-icon">Emoji (opcional)</label>
        <input id="f-quest-icon" type="text" maxlength="8" value="${quest && quest.icon ? escapeHTML(quest.icon) : ""}" placeholder="📚" />
      </div>
      <div class="form-field">
        <label for="f-quest-color">Color (opcional)</label>
        <input id="f-quest-color" type="color" value="${(quest && quest.color) || "#9b8cff"}" />
      </div>
    </div>
    <p class="form-error" id="f-error"></p>
  `;
  openModal({
    title: isEdit ? "Editar misión" : "Nueva misión",
    bodyHTML,
    footerHTML: `
      <button class="btn btn--ghost" id="quest-cancel" type="button">Cancelar</button>
      <button class="btn btn--primary" id="quest-save" type="button">${isEdit ? "Guardar cambios" : "Crear misión"}</button>
    `,
    onMount: () => $("#f-title").focus(),
  });

  $("#quest-cancel").addEventListener("click", closeModal);
  $("#quest-save").addEventListener("click", async () => {
    const title = $("#f-title").value.trim();
    if (!title) {
      $("#f-error").textContent = "El título es obligatorio.";
      return;
    }
    const payload = {
      title,
      category: $("#f-category").value,
      xp_reward: Number($("#f-xp").value || 0),
      gold_reward: Number($("#f-gold").value || 0),
      due_date: $("#f-due").value || null,
      icon: $("#f-quest-icon").value.trim(),
      color: $("#f-quest-color").value,
    };
    await runWithToastOnError(async () => {
      if (isEdit) {
        await Api.updateQuest(quest.id, payload);
        showToast("Misión actualizada.", "success");
      } else {
        await Api.createQuest(payload);
        showToast("Misión creada.", "success");
      }
      closeModal();
      await loadQuests();
    });
  });
}

async function handleCompleteQuest(quest) {
  await runWithToastOnError(async () => {
    const result = await Api.completeQuest(quest.id);
    state.profile = result.profile;
    renderProfile();
    await loadQuests();
    showToast(`¡Misión completada! +${quest.xp_reward} XP · +${quest.gold_reward} oro`, "success");
  });
}

$("#quest-filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  $$(".filter-chip", $("#quest-filters")).forEach((c) => {
    c.classList.remove("is-active");
    c.setAttribute("aria-selected", "false");
  });
  chip.classList.add("is-active");
  chip.setAttribute("aria-selected", "true");
  state.questFilter = chip.dataset.category;
  loadQuests();
});

$("#quest-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const quest = state.quests.find((q) => q.id === id);
  if (!quest) return;

  if (btn.dataset.action === "complete-quest") {
    handleCompleteQuest(quest);
  } else if (btn.dataset.action === "edit-quest") {
    openQuestModal(quest);
  } else if (btn.dataset.action === "delete-quest") {
    confirmAction(`¿Eliminar la misión "${quest.title}"?`, async () => {
      await runWithToastOnError(async () => {
        await Api.deleteQuest(id);
        await loadQuests();
        showToast("Misión eliminada.", "success");
      });
    });
  }
});

$("#btn-new-quest").addEventListener("click", () => openQuestModal());

/* ======================================================================
   Categorías (Folders) que agrupan árboles de habilidades
   ====================================================================== */
async function loadFolders() {
  try {
    state.folders = await Api.listFolders();
  } catch (err) {
    showToast(err.message || "No se pudieron cargar las categorías.", "error");
  }
}

function folderRowHTML(folder) {
  return `
    <div class="folder-row" data-id="${folder.id}">
      <span class="folder-row__name">${escapeHTML(folder.name)}</span>
      <div class="folder-row__actions">
        <button class="icon-btn" data-action="rename-folder" data-id="${folder.id}" type="button" aria-label="Renombrar categoría">
          <svg aria-hidden="true"><use href="#icon-pencil"></use></svg>
        </button>
        <button class="icon-btn icon-btn--danger" data-action="delete-folder" data-id="${folder.id}" type="button" aria-label="Eliminar categoría">
          <svg aria-hidden="true"><use href="#icon-trash"></use></svg>
        </button>
      </div>
    </div>
  `;
}

function openFoldersManagerModal() {
  const rowsHTML = state.folders.length
    ? state.folders.map(folderRowHTML).join("")
    : `<p class="branch-empty">Todavía no creaste ninguna categoría.</p>`;

  openModal({
    title: "Categorías",
    bodyHTML: `<div class="folder-rows" id="folder-rows">${rowsHTML}</div>`,
    footerHTML: `<button class="btn btn--primary btn--block" id="folder-add" type="button">+ Nueva categoría</button>`,
  });

  $("#folder-rows").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) return;

    if (btn.dataset.action === "rename-folder") {
      openSimpleTextModal({
        title: "Renombrar categoría",
        label: "Nombre",
        initialValue: folder.name,
        saveText: "Guardar",
        onSave: async (name) => {
          await Api.updateFolder(id, { name });
          await loadFolders();
          await loadTrees();
          showToast("Categoría actualizada.", "success");
          openFoldersManagerModal();
        },
      });
    } else if (btn.dataset.action === "delete-folder") {
      confirmAction(
        `¿Eliminar la categoría "${folder.name}"? Los árboles que tiene no se borran — quedan sin categoría.`,
        async () => {
          await runWithToastOnError(async () => {
            await Api.deleteFolder(id);
            await loadFolders();
            await loadTrees();
            showToast("Categoría eliminada.", "success");
            openFoldersManagerModal();
          });
        }
      );
    }
  });

  $("#folder-add").addEventListener("click", () => {
    openSimpleTextModal({
      title: "Nueva categoría",
      label: "Nombre",
      placeholder: "Ej: Universidad",
      saveText: "Crear",
      onSave: async (name) => {
        await Api.createFolder({ name });
        await loadFolders();
        await loadTrees();
        showToast("Categoría creada.", "success");
        openFoldersManagerModal();
      },
    });
  });
}

/* ======================================================================
   Árbol de habilidades
   ====================================================================== */
function currentTree() {
  return state.trees.find((t) => t.id === state.currentTreeId) || null;
}

function findNodeById(nodeId) {
  const tree = currentTree();
  if (!tree) return null;
  for (const branch of tree.branches) {
    const found = branch.nodes.find((n) => n.id === nodeId);
    if (found) return found;
  }
  return null;
}

/** Prioriza señales de estado (bloqueado/completado) sobre la
 *  personalización: un emoji lindo nunca debería tapar si algo está
 *  bloqueado o ya resuelto. Para 'available'/'failed' sí se respeta el
 *  emoji elegido, con el tipo de nodo como respaldo. */
function nodeIconContent(node) {
  if (node.status === "locked") return `<svg aria-hidden="true"><use href="#icon-lock"></use></svg>`;
  if (node.status === "completed") return `<svg aria-hidden="true"><use href="#icon-check"></use></svg>`;
  if (node.icon) return `<span class="node__emoji">${escapeHTML(node.icon)}</span>`;
  if (node.node_type === "bonus") return `<svg aria-hidden="true"><use href="#icon-star"></use></svg>`;
  if (node.node_type === "recovery") return `<svg aria-hidden="true"><use href="#icon-retry"></use></svg>`;
  if (node.status === "failed") return `<svg aria-hidden="true"><use href="#icon-warning"></use></svg>`;
  return "";
}

function nodeHTML(node) {
  const styleAttr = node.color ? ` style="--node-accent:${escapeHTML(node.color)}"` : "";
  const footer =
    node.attempt_number > 1
      ? `<span class="node__attempt">Llamado ${node.attempt_number}</span>`
      : `<span class="node__reward">+${node.xp_reward} XP</span>`;
  return `
    <div class="node-stop">
      <button
        type="button"
        class="node node--${node.status} node--${node.node_type} node--clickable"
        data-action="open-node"
        data-node-id="${node.id}"${styleAttr}
      >
        <span class="node__dot">${nodeIconContent(node)}</span>
        <span class="node__label">${escapeHTML(node.title)}</span>
        ${footer}
      </button>
    </div>
  `;
}

function nodeChainHTML(nodes) {
  return `
    <div class="node-chain">
      ${nodes
        .map((node, i) => {
          const connector = i > 0 ? `<div class="node-connector ${nodes[i - 1].status === "completed" ? "is-complete" : ""}"></div>` : "";
          return connector + nodeHTML(node);
        })
        .join("")}
    </div>
  `;
}

function branchHTML(branch) {
  return `
    <div class="branch" data-branch-id="${branch.id}">
      <div class="branch__header">
        <div>
          <div class="branch__title-row">
            <span class="branch__title">${escapeHTML(branch.name)}</span>
            ${branch.times_reset > 0 ? `<span class="branch__reset-badge">Recursada x${branch.times_reset}</span>` : ""}
          </div>
          <p class="branch__progress-label">${branch.progress_percent}% completado</p>
        </div>
        <div class="branch__actions">
          <button class="icon-btn" data-action="add-node" data-branch-id="${branch.id}" type="button" aria-label="Agregar nodo">
            <svg aria-hidden="true"><use href="#icon-plus"></use></svg>
          </button>
          <button class="icon-btn" data-action="reset-branch" data-branch-id="${branch.id}" type="button" aria-label="Recursar rama">
            <svg aria-hidden="true"><use href="#icon-retry"></use></svg>
          </button>
          <button class="icon-btn icon-btn--danger" data-action="delete-branch" data-branch-id="${branch.id}" type="button" aria-label="Eliminar rama">
            <svg aria-hidden="true"><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </div>
      <div class="branch__bar"><div class="branch__bar-fill" style="width:${branch.progress_percent}%"></div></div>
      ${branch.nodes.length === 0 ? `<p class="branch-empty">Todavía no hay nodos en esta rama.</p>` : nodeChainHTML(branch.nodes)}
    </div>
  `;
}

function renderTreeSelect() {
  const select = $("#tree-select");
  const groups = new Map(); // folderId ("none" si no tiene) -> { label, trees[] }

  state.folders.forEach((f) => groups.set(String(f.id), { label: f.name, trees: [] }));
  groups.set("none", { label: "Sin categoría", trees: [] });

  state.trees.forEach((t) => {
    const key = t.folder_id != null ? String(t.folder_id) : "none";
    if (!groups.has(key)) groups.set(key, { label: "Sin categoría", trees: [] });
    groups.get(key).trees.push(t);
  });

  select.innerHTML = [...groups.values()]
    .filter((g) => g.trees.length)
    .map(
      (g) => `
      <optgroup label="${escapeHTML(g.label)}">
        ${g.trees
          .map((t) => `<option value="${t.id}" ${t.id === state.currentTreeId ? "selected" : ""}>${escapeHTML(t.name)}</option>`)
          .join("")}
      </optgroup>`
    )
    .join("");
}

function renderBranches() {
  const container = $("#branch-list");
  const tree = currentTree();
  if (!tree) return;
  if (tree.branches.length === 0) {
    container.innerHTML = emptyStateHTML("Este árbol todavía no tiene ramas.", "Agregá una con el botón + Rama.");
    return;
  }
  container.innerHTML = tree.branches.map(branchHTML).join("");
}

async function loadTrees() {
  const container = $("#branch-list");
  container.innerHTML = `<div class="loading-spinner" role="status" aria-label="Cargando árbol"></div>`;
  try {
    state.trees = await Api.listTrees();
    renderTreeSelect();

    if (state.trees.length === 0) {
      state.currentTreeId = null;
      container.innerHTML = emptyStateHTML("Todavía no creaste ningún árbol.", "Creá uno con el botón +.");
      return;
    }
    if (!state.currentTreeId || !state.trees.some((t) => t.id === state.currentTreeId)) {
      state.currentTreeId = state.trees[0].id;
      renderTreeSelect();
    }
    renderBranches();
  } catch (err) {
    container.innerHTML = emptyStateHTML("No se pudo cargar el árbol.", err.message);
  }
}

function openNodeModal(node) {
  const isFinal = /final/i.test(node.title);
  const canComplete = node.status === "available" || node.status === "failed";
  const canFail = node.status === "available" && node.node_type !== "bonus" && node.node_type !== "recovery";

  const statusLabels = { locked: "Bloqueado", available: "Disponible", completed: "Completado", failed: "Fallado" };
  const typeHint =
    node.node_type === "bonus"
      ? "Nodo bonus: no bloquea el avance de la rama."
      : node.node_type === "recovery"
      ? "Recuperatorio — si se vuelve a fallar, hay que recursar la rama."
      : "";
  const attemptHint = node.attempt_number > 1 ? `Intento N.º ${node.attempt_number} de ${MAX_FINAL_ATTEMPTS} llamados.` : "";

  const bodyHTML = `
    <p><strong>${node.icon ? escapeHTML(node.icon) + " " : ""}${escapeHTML(node.title)}</strong></p>
    <p class="modal__hint">Estado: ${statusLabels[node.status] || node.status}${typeHint ? " — " + typeHint : ""}</p>
    ${attemptHint ? `<p class="modal__hint">${attemptHint}</p>` : ""}
    <p class="modal__hint">Recompensa: +${node.xp_reward} XP · +${node.gold_reward} Gold Coins</p>
    <div class="modal__divider"></div>
    <p class="modal__section-title">Apariencia</p>
    <div class="form-row">
      <div class="form-field">
        <label for="f-node-icon">Emoji</label>
        <input id="f-node-icon" type="text" maxlength="8" value="${node.icon ? escapeHTML(node.icon) : ""}" placeholder="🧪" />
      </div>
      <div class="form-field">
        <label for="f-node-color">Color</label>
        <input id="f-node-color" type="color" value="${node.color || "#9b8cff"}" />
      </div>
    </div>
  `;

  const buttons = [];
  if (canComplete) buttons.push(`<button class="btn btn--primary" id="node-complete" type="button">Completar</button>`);
  if (canFail) buttons.push(`<button class="btn btn--danger" id="node-fail" type="button">Fallé</button>`);
  buttons.push(`<button class="btn btn--ghost" id="node-appearance-save" type="button">Guardar apariencia</button>`);
  buttons.push(
    `<button class="icon-btn icon-btn--danger" id="node-delete" type="button" aria-label="Eliminar nodo"><svg aria-hidden="true"><use href="#icon-trash"></use></svg></button>`
  );

  openModal({ title: "Nodo", bodyHTML, footerHTML: buttons.join("") });

  const completeBtn = $("#node-complete");
  if (completeBtn) {
    completeBtn.addEventListener("click", async () => {
      closeModal();
      await runWithToastOnError(async () => {
        const result = await Api.completeNode(node.id);
        state.profile = result.profile;
        renderProfile();
        await loadTrees();
        showToast(`¡Nodo completado! +${node.xp_reward} XP · +${node.gold_reward} oro`, "success");
      });
    });
  }

  const failBtn = $("#node-fail");
  if (failBtn) {
    failBtn.addEventListener("click", () => {
      const willReset = isFinal && node.attempt_number >= MAX_FINAL_ATTEMPTS;
      const message = willReset
        ? `Fallar "${node.title}" agota los ${MAX_FINAL_ATTEMPTS} llamados: la rama entera se recursa (tu XP y oro no se tocan). ¿Continuar?`
        : `¿Marcar "${node.title}" como fallado? No te bloquea seguir con el resto de la rama.`;
      closeModal();
      confirmAction(
        message,
        async () => {
          await runWithToastOnError(async () => {
            const result = await Api.failNode(node.id);
            await loadTrees();
            showToast(
              result.reset
                ? "Se agotaron los llamados: la rama se recursó."
                : `Se generó "${result.new_node.title}".`,
              "success"
            );
          });
        },
        { confirmText: "Fallé", danger: true }
      );
    });
  }

  $("#node-appearance-save").addEventListener("click", async () => {
    const icon = $("#f-node-icon").value.trim();
    const color = $("#f-node-color").value;
    await runWithToastOnError(async () => {
      await Api.updateNode(node.id, { icon, color });
      closeModal();
      await loadTrees();
      showToast("Apariencia actualizada.", "success");
    });
  });

  $("#node-delete").addEventListener("click", () => {
    confirmAction(`¿Eliminar el nodo "${node.title}"?`, async () => {
      await runWithToastOnError(async () => {
        await Api.deleteNode(node.id);
        await loadTrees();
        showToast("Nodo eliminado.", "success");
      });
    });
  });
}

function openNodeFormModal(branchId) {
  const bodyHTML = `
    <div class="form-field">
      <label for="f-node-title">Título</label>
      <input id="f-node-title" type="text" maxlength="200" placeholder="Ej: Aprobar Parcial 1" />
    </div>
    <div class="form-field">
      <label for="f-node-type">Tipo</label>
      <select id="f-node-type">
        <option value="regular">Regular</option>
        <option value="bonus">Bonus (opcional, no bloquea)</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="f-node-xp">XP</label>
        <input id="f-node-xp" type="number" min="0" value="20" />
      </div>
      <div class="form-field">
        <label for="f-node-gold">Gold Coins</label>
        <input id="f-node-gold" type="number" min="0" value="15" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="f-node-icon">Emoji (opcional)</label>
        <input id="f-node-icon" type="text" maxlength="8" placeholder="🧪" />
      </div>
      <div class="form-field">
        <label for="f-node-color">Color (opcional)</label>
        <input id="f-node-color" type="color" value="#9b8cff" />
      </div>
    </div>
    <p class="modal__hint">
      Tip: si el título contiene la palabra "final", ese nodo sigue el sistema de llamados (hasta 3 intentos antes de recursar la rama).
      Los recuperatorios/llamados no se crean acá — aparecen solos al marcar un nodo como fallado.
    </p>
    <p class="form-error" id="f-node-error"></p>
  `;
  openModal({
    title: "Nuevo nodo",
    bodyHTML,
    footerHTML: `
      <button class="btn btn--ghost" id="node-form-cancel" type="button">Cancelar</button>
      <button class="btn btn--primary" id="node-form-save" type="button">Crear nodo</button>
    `,
    onMount: () => $("#f-node-title").focus(),
  });

  $("#node-form-cancel").addEventListener("click", closeModal);
  $("#node-form-save").addEventListener("click", async () => {
    const title = $("#f-node-title").value.trim();
    if (!title) {
      $("#f-node-error").textContent = "El título es obligatorio.";
      return;
    }
    await runWithToastOnError(async () => {
      await Api.createNode(branchId, {
        title,
        node_type: $("#f-node-type").value,
        xp_reward: Number($("#f-node-xp").value || 0),
        gold_reward: Number($("#f-node-gold").value || 0),
        icon: $("#f-node-icon").value.trim(),
        color: $("#f-node-color").value,
      });
      closeModal();
      await loadTrees();
      showToast("Nodo creado.", "success");
    });
  });
}

function openTreeModal(tree = null) {
  const isEdit = !!tree;
  const folderOptions = [
    `<option value="">Sin categoría</option>`,
    ...state.folders.map(
      (f) => `<option value="${f.id}" ${tree && tree.folder_id === f.id ? "selected" : ""}>${escapeHTML(f.name)}</option>`
    ),
  ].join("");

  const bodyHTML = `
    <div class="form-field">
      <label for="f-tree-name">Nombre</label>
      <input id="f-tree-name" type="text" maxlength="150" value="${tree ? escapeHTML(tree.name) : ""}" placeholder="Ej: Piano" />
    </div>
    <div class="form-field">
      <label for="f-tree-folder">Categoría</label>
      <select id="f-tree-folder">${folderOptions}</select>
    </div>
    <button type="button" class="btn btn--ghost btn--small" id="tree-manage-folders">Gestionar categorías</button>
    <p class="form-error" id="f-tree-error"></p>
  `;

  const footerButtons = [`<button class="btn btn--ghost" id="tree-cancel" type="button">Cancelar</button>`];
  if (isEdit) {
    footerButtons.push(`<button class="btn btn--danger" id="tree-delete" type="button">Eliminar árbol</button>`);
  }
  footerButtons.push(`<button class="btn btn--primary" id="tree-save" type="button">${isEdit ? "Guardar cambios" : "Crear árbol"}</button>`);

  openModal({
    title: isEdit ? "Editar árbol" : "Nuevo árbol de habilidades",
    bodyHTML,
    footerHTML: footerButtons.join(""),
    onMount: () => $("#f-tree-name").focus(),
  });

  $("#tree-cancel").addEventListener("click", closeModal);
  $("#tree-manage-folders").addEventListener("click", () => openFoldersManagerModal());

  const deleteBtn = $("#tree-delete");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      confirmAction(`¿Eliminar el árbol "${tree.name}" y todas sus ramas y nodos?`, async () => {
        await runWithToastOnError(async () => {
          await Api.deleteTree(tree.id);
          state.currentTreeId = null;
          await loadTrees();
          showToast("Árbol eliminado.", "success");
        });
      });
    });
  }

  $("#tree-save").addEventListener("click", async () => {
    const name = $("#f-tree-name").value.trim();
    if (!name) {
      $("#f-tree-error").textContent = "El nombre es obligatorio.";
      return;
    }
    const folderValue = $("#f-tree-folder").value;
    const payload = { name, folder_id: folderValue ? Number(folderValue) : null };
    await runWithToastOnError(async () => {
      if (isEdit) {
        await Api.updateTree(tree.id, payload);
        showToast("Árbol actualizado.", "success");
      } else {
        const created = await Api.createTree(payload);
        state.currentTreeId = created.id;
        showToast("Árbol creado.", "success");
      }
      closeModal();
      await loadTrees();
    });
  });
}

$("#tree-select").addEventListener("change", (e) => {
  state.currentTreeId = Number(e.target.value);
  renderBranches();
});

$("#btn-new-tree").addEventListener("click", () => openTreeModal());

$("#btn-edit-tree").addEventListener("click", () => {
  const tree = currentTree();
  if (!tree) {
    showToast("Primero creá un árbol de habilidades.", "error");
    return;
  }
  openTreeModal(tree);
});

$("#btn-new-branch").addEventListener("click", () => {
  if (!state.currentTreeId) {
    showToast("Primero creá un árbol de habilidades.", "error");
    return;
  }
  openSimpleTextModal({
    title: "Nueva rama",
    label: "Nombre",
    placeholder: "Ej: Álgebra",
    saveText: "Crear",
    onSave: async (name) => {
      await Api.createBranch(state.currentTreeId, { name });
      await loadTrees();
      showToast("Rama creada.", "success");
    },
  });
});

$("#branch-list").addEventListener("click", (e) => {
  const nodeBtn = e.target.closest('[data-action="open-node"]');
  if (nodeBtn) {
    const node = findNodeById(Number(nodeBtn.dataset.nodeId));
    if (node) openNodeModal(node);
    return;
  }

  const actionBtn = e.target.closest("button[data-action]");
  if (!actionBtn) return;
  const branchId = Number(actionBtn.dataset.branchId);

  if (actionBtn.dataset.action === "add-node") {
    openNodeFormModal(branchId);
  } else if (actionBtn.dataset.action === "reset-branch") {
    confirmAction(
      "¿Recursar esta rama? El progreso vuelve a 0% — tu XP y oro ya ganados no se tocan.",
      async () => {
        await runWithToastOnError(async () => {
          await Api.resetBranch(branchId);
          await loadTrees();
          showToast("Rama recursada.", "success");
        });
      },
      { confirmText: "Recursar", danger: true }
    );
  } else if (actionBtn.dataset.action === "delete-branch") {
    confirmAction("¿Eliminar esta rama y todos sus nodos?", async () => {
      await runWithToastOnError(async () => {
        await Api.deleteBranch(branchId);
        await loadTrees();
        showToast("Rama eliminada.", "success");
      });
    });
  }
});

/* ======================================================================
   Tienda de recompensas
   ====================================================================== */
function shopCardHTML(item) {
  const p = state.profile;
  const canAfford = !!p && p.gold_coins >= item.gold_cost && p.real_money_balance >= item.cash_cost;
  return `
    <article class="shop-card" data-id="${item.id}">
      <div class="shop-card__top">
        <span class="shop-card__name">${escapeHTML(item.name)}</span>
        <div class="shop-card__manage">
          <button class="icon-btn" data-action="edit-item" data-id="${item.id}" type="button" aria-label="Editar ítem">
            <svg aria-hidden="true"><use href="#icon-pencil"></use></svg>
          </button>
          <button class="icon-btn icon-btn--danger" data-action="delete-item" data-id="${item.id}" type="button" aria-label="Eliminar ítem">
            <svg aria-hidden="true"><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </div>
      <div class="shop-card__costs">
        <span class="reward-pill reward-pill--gold">
          <svg aria-hidden="true"><use href="#icon-coin"></use></svg>${item.gold_cost}
        </span>
        ${
          item.cash_cost > 0
            ? `<span class="reward-pill" style="color:var(--accent-silver)">
                 <svg aria-hidden="true"><use href="#icon-cash"></use></svg>${formatARS(item.cash_cost)}
               </span>`
            : ""
        }
      </div>
      <div class="shop-card__footer">
        <button class="btn btn--gold btn--small" data-action="buy-item" data-id="${item.id}" type="button" ${canAfford ? "" : "disabled"}>
          Comprar
        </button>
      </div>
    </article>
  `;
}

function renderShopList() {
  const listEl = $("#shop-list");
  if (state.shopItems.length === 0) {
    listEl.innerHTML = emptyStateHTML("Todavía no hay ítems en la tienda.", "Agregá uno con el botón +.");
    return;
  }
  listEl.innerHTML = state.shopItems.map(shopCardHTML).join("");
}

async function loadShop() {
  const listEl = $("#shop-list");
  listEl.innerHTML = `<div class="loading-spinner" role="status" aria-label="Cargando tienda"></div>`;
  try {
    state.shopItems = await Api.listShop();
    renderShopList();
  } catch (err) {
    listEl.innerHTML = emptyStateHTML("No se pudo cargar la tienda.", err.message);
  }
}

function openShopItemModal(item = null) {
  const isEdit = !!item;
  const bodyHTML = `
    <div class="form-field">
      <label for="f-item-name">Nombre</label>
      <input id="f-item-name" type="text" maxlength="200" value="${item ? escapeHTML(item.name) : ""}" placeholder="Ej: Comprar un helado" />
    </div>
    <div class="form-row">
      <div class="form-field">
        <label for="f-item-gold">Costo en Gold Coins</label>
        <input id="f-item-gold" type="number" min="0" value="${item ? item.gold_cost : 100}" />
      </div>
      <div class="form-field">
        <label for="f-item-cash">Costo en $ real</label>
        <input id="f-item-cash" type="number" min="0" value="${item ? item.cash_cost : 0}" />
      </div>
    </div>
    <p class="form-error" id="f-item-error"></p>
  `;
  openModal({
    title: isEdit ? "Editar ítem" : "Nuevo ítem",
    bodyHTML,
    footerHTML: `
      <button class="btn btn--ghost" id="item-cancel" type="button">Cancelar</button>
      <button class="btn btn--primary" id="item-save" type="button">${isEdit ? "Guardar cambios" : "Crear ítem"}</button>
    `,
    onMount: () => $("#f-item-name").focus(),
  });

  $("#item-cancel").addEventListener("click", closeModal);
  $("#item-save").addEventListener("click", async () => {
    const name = $("#f-item-name").value.trim();
    if (!name) {
      $("#f-item-error").textContent = "El nombre es obligatorio.";
      return;
    }
    const payload = {
      name,
      gold_cost: Number($("#f-item-gold").value || 0),
      cash_cost: Number($("#f-item-cash").value || 0),
    };
    await runWithToastOnError(async () => {
      if (isEdit) {
        await Api.updateShopItem(item.id, payload);
        showToast("Ítem actualizado.", "success");
      } else {
        await Api.createShopItem(payload);
        showToast("Ítem creado.", "success");
      }
      closeModal();
      await loadShop();
    });
  });
}

$("#shop-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const item = state.shopItems.find((i) => i.id === id);
  if (!item) return;

  if (btn.dataset.action === "buy-item") {
    const costLabel = `${item.gold_cost} oro${item.cash_cost > 0 ? ` + ${formatARS(item.cash_cost)}` : ""}`;
    confirmAction(
      `¿Comprar "${item.name}" por ${costLabel}?`,
      async () => {
        await runWithToastOnError(async () => {
          const result = await Api.purchase(id);
          state.profile = result.profile;
          renderProfile();
          await loadShop();
          showToast(`Compraste "${item.name}".`, "success");
        });
      },
      { confirmText: "Comprar", danger: false }
    );
  } else if (btn.dataset.action === "edit-item") {
    openShopItemModal(item);
  } else if (btn.dataset.action === "delete-item") {
    confirmAction(`¿Eliminar "${item.name}" de la tienda?`, async () => {
      await runWithToastOnError(async () => {
        await Api.deleteShopItem(id);
        await loadShop();
        showToast("Ítem eliminado.", "success");
      });
    });
  }
});

$("#btn-new-item").addEventListener("click", () => openShopItemModal());

/* --- Historial de compras (colapsable) --- */
function purchaseLogRowHTML(entry) {
  const costParts = [];
  if (entry.gold_spent > 0) costParts.push(`${entry.gold_spent} oro`);
  if (entry.cash_spent > 0) costParts.push(formatARS(entry.cash_spent));
  return `
    <div class="purchase-log__row">
      <span>${escapeHTML(entry.item_name)}</span>
      <span>
        <span class="num">${costParts.join(" + ")}</span><br />
        <time>${formatDateTime(entry.purchased_at)}</time>
      </span>
    </div>
  `;
}

$("#purchase-log-toggle").addEventListener("click", async () => {
  const toggle = $("#purchase-log-toggle");
  const listEl = $("#purchase-log-list");

  if (listEl.classList.contains("is-open")) {
    listEl.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    return;
  }

  toggle.setAttribute("aria-expanded", "true");
  listEl.classList.add("is-open");
  listEl.innerHTML = `<div class="loading-spinner" role="status" aria-label="Cargando historial"></div>`;
  try {
    const logs = await Api.purchaseLog();
    listEl.innerHTML = logs.length
      ? logs.map(purchaseLogRowHTML).join("")
      : `<p class="branch-empty">Todavía no hiciste ninguna compra.</p>`;
  } catch (err) {
    listEl.innerHTML = emptyStateHTML("No se pudo cargar el historial.", err.message);
  }
});

/* ======================================================================
   Logros (vitrina manual de trofeos)
   ====================================================================== */
function achievementCardHTML(a) {
  const locked = !a.is_unlocked;
  const mediaHTML = a.image_url
    ? `<img src="${escapeHTML(a.image_url)}" alt="" />`
    : `<svg aria-hidden="true"><use href="#icon-trophy"></use></svg>`;
  const dateHTML = a.is_unlocked && a.unlocked_at
    ? `Desbloqueado el ${formatDateTime(a.unlocked_at)}`
    : "Todavía bloqueado";
  return `
    <article class="achievement-card ${locked ? "achievement-card--locked" : ""}" data-id="${a.id}">
      <div class="achievement-card__top">
        <div class="achievement-card__media">${mediaHTML}</div>
        <div class="achievement-card__info">
          <p class="achievement-card__title">${escapeHTML(a.title)}</p>
          ${a.description ? `<p class="achievement-card__desc">${escapeHTML(a.description)}</p>` : ""}
        </div>
        <div class="achievement-card__manage">
          <button class="icon-btn" data-action="edit-achievement" data-id="${a.id}" type="button" aria-label="Editar logro">
            <svg aria-hidden="true"><use href="#icon-pencil"></use></svg>
          </button>
          <button class="icon-btn icon-btn--danger" data-action="delete-achievement" data-id="${a.id}" type="button" aria-label="Eliminar logro">
            <svg aria-hidden="true"><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </div>
      <div class="achievement-card__footer">
        <span class="achievement-card__date">${dateHTML}</span>
        <button class="btn btn--small ${locked ? "btn--gold" : "btn--ghost"}" data-action="toggle-achievement" data-id="${a.id}" type="button">
          ${locked ? "Desbloquear" : "Bloquear"}
        </button>
      </div>
    </article>
  `;
}

function renderAchievementList() {
  const listEl = $("#achievement-list");
  if (state.achievements.length === 0) {
    listEl.innerHTML = emptyStateHTML("Todavía no cargaste ningún logro.", "Creá uno con el botón +.");
    return;
  }
  listEl.innerHTML = state.achievements.map(achievementCardHTML).join("");
}

async function loadAchievements() {
  const listEl = $("#achievement-list");
  listEl.innerHTML = `<div class="loading-spinner" role="status" aria-label="Cargando logros"></div>`;
  try {
    state.achievements = await Api.listAchievements();
    renderAchievementList();
  } catch (err) {
    listEl.innerHTML = emptyStateHTML("No se pudieron cargar los logros.", err.message);
  }
}

function openAchievementModal(achievement = null) {
  const isEdit = !!achievement;
  const bodyHTML = `
    <div class="form-field">
      <label for="f-ach-title">Título</label>
      <input id="f-ach-title" type="text" maxlength="150" value="${achievement ? escapeHTML(achievement.title) : ""}" placeholder="Ej: Licenciado en Bioinformática" />
    </div>
    <div class="form-field">
      <label for="f-ach-desc">Descripción (opcional)</label>
      <input id="f-ach-desc" type="text" maxlength="500" value="${achievement && achievement.description ? escapeHTML(achievement.description) : ""}" placeholder="Cómo lo conseguiste" />
    </div>
    <div class="form-field">
      <label for="f-ach-image">URL de imagen (opcional)</label>
      <input id="f-ach-image" type="text" maxlength="500" value="${achievement && achievement.image_url ? escapeHTML(achievement.image_url) : ""}" placeholder="https://..." />
    </div>
    <p class="modal__hint">Sin imagen, se muestra un ícono de trofeo por defecto. El desbloqueo se maneja aparte, con el botón de la tarjeta.</p>
    <p class="form-error" id="f-ach-error"></p>
  `;
  openModal({
    title: isEdit ? "Editar logro" : "Nuevo logro",
    bodyHTML,
    footerHTML: `
      <button class="btn btn--ghost" id="ach-cancel" type="button">Cancelar</button>
      <button class="btn btn--primary" id="ach-save" type="button">${isEdit ? "Guardar cambios" : "Crear logro"}</button>
    `,
    onMount: () => $("#f-ach-title").focus(),
  });

  $("#ach-cancel").addEventListener("click", closeModal);
  $("#ach-save").addEventListener("click", async () => {
    const title = $("#f-ach-title").value.trim();
    if (!title) {
      $("#f-ach-error").textContent = "El título es obligatorio.";
      return;
    }
    const payload = {
      title,
      description: $("#f-ach-desc").value.trim(),
      image_url: $("#f-ach-image").value.trim(),
    };
    await runWithToastOnError(async () => {
      if (isEdit) {
        await Api.updateAchievement(achievement.id, payload);
        showToast("Logro actualizado.", "success");
      } else {
        await Api.createAchievement(payload);
        showToast("Logro creado.", "success");
      }
      closeModal();
      await loadAchievements();
    });
  });
}

$("#achievement-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const achievement = state.achievements.find((a) => a.id === id);
  if (!achievement) return;

  if (btn.dataset.action === "toggle-achievement") {
    runWithToastOnError(async () => {
      const updated = await Api.toggleAchievement(id);
      showToast(updated.is_unlocked ? `¡Logro desbloqueado: "${updated.title}"!` : "Logro bloqueado de nuevo.", "success");
      await loadAchievements();
    });
  } else if (btn.dataset.action === "edit-achievement") {
    openAchievementModal(achievement);
  } else if (btn.dataset.action === "delete-achievement") {
    confirmAction(`¿Eliminar el logro "${achievement.title}"?`, async () => {
      await runWithToastOnError(async () => {
        await Api.deleteAchievement(id);
        await loadAchievements();
        showToast("Logro eliminado.", "success");
      });
    });
  }
});

$("#btn-new-achievement").addEventListener("click", () => openAchievementModal());

/* ======================================================================
   Navegación
   ====================================================================== */
function switchView(view) {
  $$(".view").forEach((v) => v.classList.remove("is-active"));
  $(`#view-${view}`).classList.add("is-active");
  $$(".nav-tabs__item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
}

$$(".nav-tabs__item").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

/* ======================================================================
   Service worker (offline shell) — ver static/js/sw.js
   ====================================================================== */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* si falla (ej. en desarrollo sin HTTPS), la app sigue funcionando igual */
    });
  });
}

/* ======================================================================
   Arranque
   ====================================================================== */
async function init() {
  await loadProfile();
  await loadFolders();
  await Promise.all([loadQuests(), loadTrees(), loadShop(), loadAchievements(), loadLevelConfigs()]);
  registerServiceWorker();
}

init();
