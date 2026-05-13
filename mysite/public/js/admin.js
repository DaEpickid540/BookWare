import { auth, db } from "./firebase.js";
import {
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── Page Routing ──────────────────────────────────────────────────────────────
function setupPageRouting() {
  document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const page = e.currentTarget.dataset.page;
      showPage(page);
    });
  });
}

function showPage(pageName) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-item")
    .forEach((n) => n.classList.remove("active"));

  const pageEl = document.getElementById(pageName + "Page");
  if (pageEl) {
    pageEl.classList.add("active");
  }

  document.querySelector(`[data-page="${pageName}"]`)?.classList.add("active");
}

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const logoutBtn = document.getElementById("logoutAdminBtn");
const logoutSettingsBtn = document.getElementById("logoutSettingsBtn");
const adminEmail = document.getElementById("adminEmail");

// Dashboard
const statTotalUsers = document.getElementById("statTotalUsers");
const statActiveToday = document.getElementById("statActiveToday");
const statBannedUsers = document.getElementById("statBannedUsers");
const statMaintenance = document.getElementById("statMaintenance");
const refreshStatsBtn = document.getElementById("refreshStatsBtn");
const toggleMaintenanceBtn = document.getElementById("toggleMaintenanceBtn");
const activityFeed = document.getElementById("activityFeed");

// Users
const userSearchInput = document.getElementById("userSearchInput");
const userRoleFilter = document.getElementById("userRoleFilter");
const usersTableContainer = document.getElementById("usersTableContainer");
const refreshUsersBtn = document.getElementById("refreshUsersBtn");

// Bans
const bansList = document.getElementById("bansList");
const createBanBtn = document.getElementById("createBanBtn");

// Settings
const maintenanceModeToggle = document.getElementById("maintenanceModeToggle");
const viewGlobalBansBtn = document.getElementById("viewGlobalBansBtn");
const exportDataBtn = document.getElementById("exportDataBtn");
const logoutAllBtn = document.getElementById("logoutAllBtn");

// Debug
const firestoreStats = document.getElementById("firestoreStats");
const authStats = document.getElementById("authStats");
const errorLog = document.getElementById("errorLog");
const refreshDebugBtn = document.getElementById("refreshDebugBtn");

// Ban Modal
const banModalOverlay = document.getElementById("banModalOverlay");
const banUserEmail = document.getElementById("banUserEmail");
const banReason = document.getElementById("banReason");
const banDuration = document.getElementById("banDuration");
const banModalCancelBtn = document.getElementById("banModalCancelBtn");
const banModalConfirmBtn = document.getElementById("banModalConfirmBtn");

const toastContainer = document.getElementById("toastContainer");

// ─── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let allUsers = [];
let allBans = [];
let systemSettings = {};

// ─── Logout ───────────────────────────────────────────────────────────────────
logoutBtn?.addEventListener("click", () => signOut(auth));
logoutSettingsBtn?.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (!user) window.location.href = "/";
});

// ─── Auth + Initialization ──────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "/";
    return;
  }

  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists() || userSnap.data().role !== "admin") {
    await signOut(auth);
    window.location.href = "/";
    return;
  }

  currentUser = user;
  if (adminEmail) adminEmail.textContent = user.email;

  setupPageRouting();
  await loadSystemSettings();
  await loadDashboard();
  setupEventListeners();
});

// ─── Utilities ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function setStatus(container, msg) {
  if (!container) return;
  container.innerHTML = `<p class="text-muted">${escHtml(msg)}</p>`;
}

// ─── System Settings ────────────────────────────────────────────────────────────
async function loadSystemSettings() {
  const snap = await getDoc(doc(db, "admin", "settings"));
  if (snap.exists()) {
    systemSettings = snap.data();
  } else {
    systemSettings = { maintenanceMode: false, globalBanList: [] };
  }

  if (maintenanceModeToggle) {
    maintenanceModeToggle.checked = systemSettings.maintenanceMode ?? false;
  }
  if (statMaintenance) {
    statMaintenance.textContent = systemSettings.maintenanceMode ? "ON" : "OFF";
  }
}

async function setMaintenanceMode(enabled) {
  await setDoc(
    doc(db, "admin", "settings"),
    {
      maintenanceMode: enabled,
      globalBanList: systemSettings.globalBanList ?? [],
    },
    { merge: true },
  );

  systemSettings.maintenanceMode = enabled;
  if (statMaintenance) statMaintenance.textContent = enabled ? "ON" : "OFF";
  showToast(
    `Maintenance mode ${enabled ? "enabled" : "disabled"}`,
    enabled ? "warning" : "success",
  );
}

// ─── Dashboard ──────────────────────────────────────────────────────────────────
async function loadDashboard() {
  await loadSystemStats();
  await loadRecentActivity();
}

async function loadSystemStats() {
  // Total users
  const usersSnap = await getDocs(collection(db, "users"));
  const totalUsers = usersSnap.size;

  // Banned users
  const bannedSnap = await getDocs(
    query(collection(db, "users"), where("banned", "==", true)),
  );
  const bannedCount = bannedSnap.size;

  // Active users (last login in last 24h)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const activeSnap = await getDocs(
    query(collection(db, "users"), where("lastLogin", ">=", yesterday)),
  );
  const activeCount = activeSnap.size;

  if (statTotalUsers) statTotalUsers.textContent = totalUsers;
  if (statActiveToday) statActiveToday.textContent = activeCount;
  if (statBannedUsers) statBannedUsers.textContent = bannedCount;
}

async function loadRecentActivity() {
  if (!activityFeed) return;

  // Load recent bans
  const bansSnap = await getDocs(
    query(
      collection(db, "users"),
      where("banned", "==", true),
      orderBy("updatedAt", "desc"),
      limit(5),
    ),
  );

  if (bansSnap.empty) {
    activityFeed.innerHTML = `<p class="text-muted">No recent activity.</p>`;
    return;
  }

  activityFeed.innerHTML = "";

  bansSnap.forEach((d) => {
    const user = d.data();
    const banDate = user.updatedAt
      ? new Date(user.updatedAt.seconds * 1000).toLocaleDateString()
      : "—";

    const item = document.createElement("div");
    item.className = "panel";
    item.innerHTML = `
      <div class="panel-title">User Banned</div>
      <div class="panel-body">
        <p><strong>${escHtml(user.email)}</strong></p>
        <p class="text-muted">Reason: ${escHtml(
          user.banReason || "Not specified",
        )}</p>
        <p class="text-muted">Date: ${banDate}</p>
      </div>`;

    activityFeed.appendChild(item);
  });
}

// ─── Users Management ───────────────────────────────────────────────────────────
async function loadAllUsers() {
  if (!usersTableContainer) return;
  setStatus(usersTableContainer, "Loading users…");

  const snap = await getDocs(collection(db, "users"));
  allUsers = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));

  renderUsersTable(allUsers);
}

function renderUsersTable(users) {
  if (!usersTableContainer) return;

  if (users.length === 0) {
    setStatus(usersTableContainer, "No users found.");
    return;
  }

  let html = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Name</th>
          <th>Role</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>`;

  users.forEach((user) => {
    const status = user.banned
      ? `<span class="status-indicator banned"><span class="status-dot"></span>Banned</span>`
      : `<span class="status-indicator active"><span class="status-dot"></span>Active</span>`;

    html += `
      <tr>
        <td>${escHtml(user.email)}</td>
        <td>${escHtml(user.name)}</td>
        <td><span class="chip">${escHtml(user.role)}</span></td>
        <td>${status}</td>
        <td>
          <button class="btn-ghost" data-action="view" data-uid="${escHtml(
            user.uid,
          )}" style="padding: 4px 8px; font-size: 0.75rem;">View</button>
          ${
            !user.banned
              ? `<button class="btn-danger" data-action="ban" data-uid="${escHtml(
                  user.uid,
                )}" style="padding: 4px 8px; font-size: 0.75rem;">Ban</button>`
              : `<button class="btn-success" data-action="unban" data-uid="${escHtml(
                  user.uid,
                )}" style="padding: 4px 8px; font-size: 0.75rem;">Unban</button>`
          }
        </td>
      </tr>`;
  });

  html += `</tbody></table>`;
  usersTableContainer.innerHTML = html;

  // Attach event listeners
  usersTableContainer.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const action = e.currentTarget.dataset.action;
      const uid = e.currentTarget.dataset.uid;

      if (action === "ban") openBanModal(uid);
      if (action === "unban") unbanUser(uid);
      if (action === "view") viewUserDetails(uid);
    });
  });
}

function viewUserDetails(uid) {
  const user = allUsers.find((u) => u.uid === uid);
  if (!user) return;

  alert(
    `User: ${user.name}\nEmail: ${user.email}\nRole: ${user.role}\nBanned: ${
      user.banned ? "Yes" : "No"
    }`,
  );
}

// ─── Banning System ─────────────────────────────────────────────────────────────
async function loadBans() {
  if (!bansList) return;
  setStatus(bansList, "Loading bans…");

  const snap = await getDocs(
    query(collection(db, "users"), where("banned", "==", true)),
  );

  if (snap.empty) {
    setStatus(bansList, "No active bans.");
    allBans = [];
    return;
  }

  allBans = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  renderBansList();
}

function renderBansList() {
  if (!bansList) return;

  bansList.innerHTML = "";

  allBans.forEach((user) => {
    const banExpiry = user.banExpiry
      ? new Date(user.banExpiry.seconds * 1000)
      : null;
    const now = new Date();
    const expiryStr =
      banExpiry && banExpiry > now
        ? `Expires: ${banExpiry.toLocaleDateString()}`
        : "Permanent";

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="panel-title">${escHtml(user.email)}</div>
      <div class="panel-body">
        <p class="text-muted">Name: ${escHtml(user.name)}</p>
        <p class="text-muted">Reason: ${escHtml(
          user.banReason || "Not specified",
        )}</p>
        <p class="text-muted">${expiryStr}</p>
        <button class="btn-ghost" data-action="revoke" data-uid="${escHtml(
          user.uid,
        )}" style="margin-top: 12px;">Revoke Ban</button>
      </div>`;

    panel
      .querySelector("[data-action]")
      .addEventListener("click", () => unbanUser(user.uid));
    bansList.appendChild(panel);
  });
}

function openBanModal(uid) {
  banUserEmail.value = allUsers.find((u) => u.uid === uid)?.email ?? "";
  banUserEmail.dataset.uid = uid;
  banModalOverlay.classList.remove("hidden");
}

async function banUser(uid, reason, duration) {
  const banExpiry =
    duration === "permanent"
      ? null
      : new Date(Date.now() + (duration === "24h" ? 24 : 7) * 60 * 60 * 1000);

  await updateDoc(doc(db, "users", uid), {
    banned: true,
    banReason: reason,
    banExpiry: banExpiry ? Timestamp.fromDate(banExpiry) : null,
    updatedAt: serverTimestamp(),
  });

  showToast(`User banned for ${duration}`, "warning");
  await loadBans();
  await loadAllUsers();
  await loadSystemStats();
}

async function unbanUser(uid) {
  const confirmed = confirm("Revoke this ban?");
  if (!confirmed) return;

  await updateDoc(doc(db, "users", uid), {
    banned: false,
    banReason: null,
    banExpiry: null,
  });

  showToast("Ban revoked", "success");
  await loadBans();
  await loadAllUsers();
  await loadSystemStats();
}

// ─── Event Listeners ────────────────────────────────────────────────────────────
function setupEventListeners() {
  // Dashboard
  refreshStatsBtn?.addEventListener("click", async () => {
    await loadSystemStats();
    showToast("Stats refreshed", "success");
  });

  toggleMaintenanceBtn?.addEventListener("click", async () => {
    await setMaintenanceMode(!systemSettings.maintenanceMode);
  });

  // Users
  userSearchInput?.addEventListener("input", filterUsers);
  userRoleFilter?.addEventListener("change", filterUsers);
  refreshUsersBtn?.addEventListener("click", loadAllUsers);

  // Bans
  createBanBtn?.addEventListener("click", () => openBanModal(""));
  banModalCancelBtn?.addEventListener("click", () => {
    banModalOverlay.classList.add("hidden");
  });

  banModalConfirmBtn?.addEventListener("click", async () => {
    const uid = banUserEmail.dataset.uid;
    const reason = banReason.value;
    const duration = banDuration.value;

    if (!reason || !duration) {
      showToast("Please fill all fields", "warning");
      return;
    }

    await banUser(uid, reason, duration);
    banModalOverlay.classList.add("hidden");
    banUserEmail.value = "";
    banReason.value = "";
    banDuration.value = "24h";
  });

  // Settings
  maintenanceModeToggle?.addEventListener("change", (e) => {
    setMaintenanceMode(e.currentTarget.checked);
  });

  exportDataBtn?.addEventListener("click", exportAllData);
  logoutAllBtn?.addEventListener("click", forceLogoutAll);

  // Debug
  refreshDebugBtn?.addEventListener("click", loadDebugInfo);

  // Initial loads
  loadAllUsers();
  loadBans();
  loadDebugInfo();
}

function filterUsers() {
  const searchTerm = (userSearchInput?.value ?? "").toLowerCase();
  const roleFilter = userRoleFilter?.value ?? "";

  const filtered = allUsers.filter((user) => {
    const matchesSearch =
      user.email.toLowerCase().includes(searchTerm) ||
      user.name.toLowerCase().includes(searchTerm);
    const matchesRole = !roleFilter || user.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  renderUsersTable(filtered);
}

// ─── Debug Info ─────────────────────────────────────────────────────────────────
async function loadDebugInfo() {
  await loadFirestoreStats();
  await loadAuthStats();
}

async function loadFirestoreStats() {
  if (!firestoreStats) return;

  const users = await getDocs(collection(db, "users"));
  const students = await getDocs(
    query(collection(db, "users"), where("role", "==", "student")),
  );
  const teachers = await getDocs(
    query(collection(db, "users"), where("role", "==", "teacher")),
  );
  const admins = await getDocs(
    query(collection(db, "users"), where("role", "==", "admin")),
  );

  let html = `
    <tr><td>Total Users</td><td>${users.size}</td></tr>
    <tr><td>Students</td><td>${students.size}</td></tr>
    <tr><td>Teachers</td><td>${teachers.size}</td></tr>
    <tr><td>Admins</td><td>${admins.size}</td></tr>
  `;

  firestoreStats.innerHTML = html;
}

async function loadAuthStats() {
  if (!authStats) return;

  const banned = await getDocs(
    query(collection(db, "users"), where("banned", "==", true)),
  );

  let html = `
    <tr><td>Banned Users</td><td>${banned.size}</td></tr>
    <tr><td>Last Updated</td><td>${new Date().toLocaleTimeString()}</td></tr>
  `;

  authStats.innerHTML = html;
}

// ─── Danger Zone ────────────────────────────────────────────────────────────────
async function exportAllData() {
  const confirmed = confirm("Export all data as JSON? This may be large.");
  if (!confirmed) return;

  const usersSnap = await getDocs(collection(db, "users"));
  const data = {
    exportedAt: new Date().toISOString(),
    users: usersSnap.docs.map((d) => ({ uid: d.id, ...d.data() })),
  };

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bookware-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast("Data exported", "success");
}

async function forceLogoutAll() {
  const confirmed = confirm("Force logout ALL users? This cannot be undone.");
  if (!confirmed) return;

  // In production, would need a Cloud Function to invalidate all sessions
  // For now, just show a message
  showToast("Force logout all users would require Cloud Functions", "warning");
}
