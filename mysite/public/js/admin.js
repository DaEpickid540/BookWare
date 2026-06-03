// admin.js — BookWare Admin Portal
import { auth, db } from './firebase.js';
import { signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit,
  serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ADMIN_EMAILS = ['sarvin.sukhe@gmail.com', 'daepickid540@gmail.com'];

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser    = null;
let allUsers       = [];
let allBans        = [];
let systemSettings = {};

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4200);
}

// ── Page routing ──────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

function showPage(pageName) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => { n.classList.remove('active'); n.removeAttribute('aria-current'); });
  document.getElementById(pageName + 'Page')?.classList.add('active');
  const btn = document.querySelector(`[data-page="${pageName}"]`);
  btn?.classList.add('active');
  btn?.setAttribute('aria-current', 'page');
  if (pageName === 'users') loadAllUsers();
  if (pageName === 'bans')  loadBans();
  if (pageName === 'debug') loadDebugInfo();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
document.getElementById('logoutAdminBtn')?.addEventListener('click',    () => signOut(auth));
document.getElementById('logoutSettingsBtn')?.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = '/'; return; }
  document.documentElement.style.visibility = 'visible';

  try {
    const userRef  = doc(db, 'users', user.uid);
    const userSnap = await getDoc(userRef);
    const isHardcodedAdmin = ADMIN_EMAILS.includes(user.email?.toLowerCase());

    if (!userSnap.exists() || userSnap.data().role !== 'admin' || !isHardcodedAdmin) {
      // 3-strike auto-ban for non-hardcoded accounts that try to access admin
      if (userSnap.exists() && !isHardcodedAdmin) {
        const ATTEMPT_KEY = `bw-admin-attempts-${user.uid}`;
        const ONE_HOUR    = 3600000;
        const now         = Date.now();
        let attempts = [];
        try { attempts = JSON.parse(localStorage.getItem(ATTEMPT_KEY) || '[]'); } catch (_) {}
        attempts = attempts.filter(t => now - t < ONE_HOUR);
        attempts.push(now);
        localStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempts));
        if (attempts.length >= 3) {
          try { await updateDoc(userRef, { banned: true, banExpiry: Timestamp.fromDate(new Date(now + 86400000)), banReason: 'Repeated unauthorized admin access attempts (auto-ban)', bannedBy: 'system', bannedAt: serverTimestamp() }); } catch (_) {}
          localStorage.removeItem(ATTEMPT_KEY);
          await signOut(auth); window.location.href = '/?banned=admin'; return;
        }
      }
      await signOut(auth); window.location.href = '/'; return;
    }

    currentUser = user;
    const emailEl = document.getElementById('adminEmail');
    if (emailEl) emailEl.textContent = user.email;

    await loadSystemSettings();
    await loadDashboard();
    setupEventListeners();

  } catch (err) {
    console.error('[admin] Init failed:', err);
    toast(`Failed to load admin portal: ${err.message ?? 'unknown error'}. Try refreshing.`, 'danger');
  }
});

// ── System Settings ───────────────────────────────────────────────────────────
async function loadSystemSettings() {
  const snap = await getDoc(doc(db, 'admin', 'settings'));
  systemSettings = snap.exists() ? snap.data() : { maintenanceMode: false, globalBanList: [] };
  const toggle = document.getElementById('maintenanceModeToggle');
  if (toggle) toggle.checked = systemSettings.maintenanceMode ?? false;
  const stat = document.getElementById('statMaintenance');
  if (stat)   stat.textContent = systemSettings.maintenanceMode ? 'ON' : 'OFF';
}

async function setMaintenanceMode(enabled) {
  await setDoc(doc(db, 'admin', 'settings'), { maintenanceMode: enabled, globalBanList: systemSettings.globalBanList ?? [] }, { merge: true });
  systemSettings.maintenanceMode = enabled;
  const stat = document.getElementById('statMaintenance');
  if (stat) stat.textContent = enabled ? 'ON' : 'OFF';
  toast(`Maintenance mode ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'danger' : 'success');
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  await loadSystemStats();
  await loadRecentActivity();
}

async function loadSystemStats() {
  const usersSnap   = await getDocs(collection(db, 'users'));
  const bannedSnap  = await getDocs(query(collection(db, 'users'), where('banned', '==', true)));
  const yesterday   = new Date(Date.now() - 86400000);
  let   activeCount = 0;
  try {
    const activeSnap = await getDocs(query(collection(db, 'users'), where('lastLogin', '>=', yesterday)));
    activeCount = activeSnap.size;
  } catch (_) {}

  const statTotalUsers  = document.getElementById('statTotalUsers');
  const statActiveToday = document.getElementById('statActiveToday');
  const statBannedUsers = document.getElementById('statBannedUsers');
  if (statTotalUsers)  statTotalUsers.textContent  = usersSnap.size;
  if (statActiveToday) statActiveToday.textContent = activeCount;
  if (statBannedUsers) statBannedUsers.textContent = bannedSnap.size;
}

async function loadRecentActivity() {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  try {
    const snap = await getDocs(query(collection(db, 'users'), where('banned', '==', true), orderBy('bannedAt', 'desc'), limit(5)));
    if (snap.empty) { feed.innerHTML = `<p class='empty-state'>No recent activity.</p>`; return; }
    feed.innerHTML = '';
    snap.forEach(d => {
      const u    = d.data();
      const item = document.createElement('div');
      item.className = 'activity-item';
      item.innerHTML = `
        <span class='activity-dot'></span>
        <div>
          <div class='activity-label'>User Banned</div>
          <div class='activity-meta'>${esc(u.email)} · Reason: ${esc(u.banReason || 'Not specified')}</div>
        </div>`;
      feed.appendChild(item);
    });
  } catch (_) { feed.innerHTML = `<p class='empty-state'>Could not load activity.</p>`; }
}

// ── Users ─────────────────────────────────────────────────────────────────────
async function loadAllUsers() {
  const container = document.getElementById('usersTableContainer');
  if (!container) return;
  container.innerHTML = `<p class='empty-state'>Loading users…</p>`;
  const snap = await getDocs(collection(db, 'users'));
  allUsers   = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  renderUsersTable(allUsers);
}

function renderUsersTable(users) {
  const container = document.getElementById('usersTableContainer');
  if (!container) return;
  if (users.length === 0) { container.innerHTML = `<p class='empty-state'>No users found.</p>`; return; }
  let html = `
    <table class='data-table'>
      <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>`;
  users.forEach(u => {
    const statusHtml = u.banned
      ? `<span class='status-indicator banned'><span class='status-dot'></span>Banned</span>`
      : `<span class='status-indicator active'><span class='status-dot'></span>Active</span>`;
    html += `
      <tr>
        <td>${esc(u.email)}</td>
        <td>${esc(u.name ?? '—')}</td>
        <td><span class='chip'>${esc(u.role)}</span></td>
        <td>${statusHtml}</td>
        <td>
          <button class='btn btn--ghost btn--sm' data-action='view'  data-uid='${esc(u.uid)}' style='padding:4px 8px'>View</button>
          ${!u.banned
            ? `<button class='btn btn--danger btn--sm' data-action='ban'    data-uid='${esc(u.uid)}' style='padding:4px 8px'>Ban</button>`
            : `<button class='btn btn--success btn--sm' data-action='unban' data-uid='${esc(u.uid)}' style='padding:4px 8px'>Unban</button>`}
          <button class='btn btn--danger btn--sm' data-action='delete' data-uid='${esc(u.uid)}' style='padding:4px 8px;opacity:0.7'>Delete</button>
        </td>
      </tr>`;
  });
  html += `</tbody></table>`;
  container.innerHTML = html;
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      const { action, uid } = e.currentTarget.dataset;
      if (action === 'ban')    openBanModal(uid);
      if (action === 'unban')  unbanUser(uid);
      if (action === 'view')   viewUserDetails(uid);
      if (action === 'delete') deleteUserRecord(uid);
    });
  });
}

function filterUsers() {
  const search = (document.getElementById('userSearchInput')?.value ?? '').toLowerCase();
  const role   = document.getElementById('userRoleFilter')?.value ?? '';
  renderUsersTable(allUsers.filter(u => {
    const matchSearch = (u.email ?? '').toLowerCase().includes(search) || (u.name ?? '').toLowerCase().includes(search);
    const matchRole   = !role || u.role === role;
    return matchSearch && matchRole;
  }));
}

function viewUserDetails(uid) {
  const u = allUsers.find(x => x.uid === uid);
  if (!u) return;
  alert(`User: ${u.name ?? '—'}\nEmail: ${u.email}\nRole: ${u.role}\nBanned: ${u.banned ? 'Yes' : 'No'}`);
}

async function deleteUserRecord(uid) {
  const u     = allUsers.find(x => x.uid === uid);
  const label = u?.name || u?.email || uid;
  if (!confirm(`Permanently delete "${label}"?\n\nThis removes their account from BookWare. Cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, 'users', uid));
    try { await deleteDoc(doc(db, 'students', uid)); } catch (_) {}
    try { await deleteDoc(doc(db, 'teachers', uid)); } catch (_) {}
    toast(`Deleted ${esc(label)}`, 'success');
    await loadAllUsers();
    await loadSystemStats();
  } catch (err) { toast(`Delete failed: ${esc(err.message)}`, 'danger'); }
}

// ── Bans ──────────────────────────────────────────────────────────────────────
async function loadBans() {
  const el = document.getElementById('bansList');
  if (!el) return;
  el.innerHTML = `<p class='empty-state'>Loading bans…</p>`;
  const snap = await getDocs(query(collection(db, 'users'), where('banned', '==', true)));
  if (snap.empty) { el.innerHTML = `<p class='empty-state'>No active bans.</p>`; allBans = []; return; }
  allBans = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  el.innerHTML = '';
  allBans.forEach(u => {
    const banExpiry = u.banExpiry ? new Date(u.banExpiry.seconds * 1000) : null;
    const expiryStr = banExpiry && banExpiry > new Date() ? `Expires: ${banExpiry.toLocaleDateString()}` : 'Permanent / Expired';
    const entry = document.createElement('div');
    entry.className = 'ban-entry';
    entry.innerHTML = `
      <div>
        <div class='ban-email'>${esc(u.email)}</div>
        <div class='ban-detail'>Name: ${esc(u.name ?? '—')} · Reason: ${esc(u.banReason || 'Not specified')} · ${expiryStr}</div>
      </div>
      <button class='btn btn--success btn--sm' data-uid='${esc(u.uid)}'>Revoke Ban</button>`;
    entry.querySelector('button')?.addEventListener('click', e => unbanUser(e.currentTarget.dataset.uid));
    el.appendChild(entry);
  });
}

function openBanModal(uid) {
  const overlay  = document.getElementById('banModalOverlay');
  const emailEl  = document.getElementById('banUserEmail');
  if (!overlay || !emailEl) return;
  emailEl.value          = allUsers.find(u => u.uid === uid)?.email ?? '';
  emailEl.dataset.uid    = uid;
  overlay.hidden         = false;
}

async function banUser(uid, reason, duration) {
  const banExpiry = duration === 'permanent' ? null
    : new Date(Date.now() + (duration === '24h' ? 86400000 : 7 * 86400000));
  await updateDoc(doc(db, 'users', uid), { banned: true, banReason: reason, banExpiry: banExpiry ? Timestamp.fromDate(banExpiry) : null, updatedAt: serverTimestamp() });
  toast(`User banned for ${duration}`, 'danger');
  await loadBans();
  await loadAllUsers();
  await loadSystemStats();
}

async function unbanUser(uid) {
  if (!confirm('Revoke this ban?')) return;
  await updateDoc(doc(db, 'users', uid), { banned: false, banReason: null, banExpiry: null });
  toast('Ban revoked', 'success');
  await loadBans();
  await loadAllUsers();
  await loadSystemStats();
}

// ── Debug ─────────────────────────────────────────────────────────────────────
async function loadDebugInfo() {
  await loadFirestoreStats();
  await loadAuthStats();
}

async function loadFirestoreStats() {
  const el = document.getElementById('firestoreStats');
  if (!el) return;
  const [users, students, teachers, admins] = await Promise.all([
    getDocs(collection(db, 'users')),
    getDocs(query(collection(db, 'users'), where('role', '==', 'student'))),
    getDocs(query(collection(db, 'users'), where('role', '==', 'teacher'))),
    getDocs(query(collection(db, 'users'), where('role', '==', 'admin'))),
  ]);
  el.innerHTML = `
    <tr><td>Total Users</td><td>${users.size}</td></tr>
    <tr><td>Students</td><td>${students.size}</td></tr>
    <tr><td>Teachers</td><td>${teachers.size}</td></tr>
    <tr><td>Admins</td><td>${admins.size}</td></tr>`;
}

async function loadAuthStats() {
  const el = document.getElementById('authStats');
  if (!el) return;
  const banned = await getDocs(query(collection(db, 'users'), where('banned', '==', true)));
  el.innerHTML = `
    <tr><td>Banned Users</td><td>${banned.size}</td></tr>
    <tr><td>Last Updated</td><td>${new Date().toLocaleTimeString()}</td></tr>`;
}

// ── Danger Zone ───────────────────────────────────────────────────────────────
async function exportAllData() {
  if (!confirm('Export all data as JSON? This may be large.')) return;
  const snap = await getDocs(collection(db, 'users'));
  const data = { exportedAt: new Date().toISOString(), users: snap.docs.map(d => ({ uid: d.id, ...d.data() })) };
  const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: `bookware-export-${Date.now()}.json` });
  a.click(); URL.revokeObjectURL(a.href);
  toast('Data exported', 'success');
}

function forceLogoutAll() {
  if (!confirm('Force logout ALL users? This cannot be undone.')) return;
  toast('Force logout all users would require Cloud Functions', 'danger');
}

// ── Event Listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  document.getElementById('refreshStatsBtn')?.addEventListener('click',  async () => { await loadSystemStats(); toast('Stats refreshed', 'success'); });
  document.getElementById('toggleMaintenanceBtn')?.addEventListener('click', () => setMaintenanceMode(!systemSettings.maintenanceMode));
  document.getElementById('userSearchInput')?.addEventListener('input',  filterUsers);
  document.getElementById('userRoleFilter')?.addEventListener('change',  filterUsers);
  document.getElementById('refreshUsersBtn')?.addEventListener('click',  loadAllUsers);
  document.getElementById('createBanBtn')?.addEventListener('click',     () => openBanModal(''));
  document.getElementById('refreshDebugBtn')?.addEventListener('click',  loadDebugInfo);
  document.getElementById('exportDataBtn')?.addEventListener('click',    exportAllData);
  document.getElementById('logoutAllBtn')?.addEventListener('click',     forceLogoutAll);
  document.getElementById('viewGlobalBansBtn')?.addEventListener('click',() => showPage('bans'));
  document.getElementById('maintenanceModeToggle')?.addEventListener('change', e => setMaintenanceMode(e.target.checked));

  // Ban modal
  const overlay      = document.getElementById('banModalOverlay');
  const cancelBtn    = document.getElementById('banModalCancelBtn');
  const cancelBtn2   = document.getElementById('banModalCancelBtn2');
  const confirmBtn   = document.getElementById('banModalConfirmBtn');
  cancelBtn?.addEventListener('click',  () => { if (overlay) overlay.hidden = true; });
  cancelBtn2?.addEventListener('click', () => { if (overlay) overlay.hidden = true; });
  confirmBtn?.addEventListener('click', async () => {
    const uid      = document.getElementById('banUserEmail')?.dataset.uid;
    const reason   = document.getElementById('banReason')?.value;
    const duration = document.getElementById('banDuration')?.value;
    if (!reason || !duration) { toast('Please fill all fields', 'danger'); return; }
    if (!uid) { toast('No user selected', 'danger'); return; }
    await banUser(uid, reason, duration);
    if (overlay) overlay.hidden = true;
    document.getElementById('banUserEmail').value = '';
    document.getElementById('banReason').value    = '';
    document.getElementById('banDuration').value  = '24h';
  });

  overlay?.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });

  // Initial page loads
  loadAllUsers();
  loadBans();
  loadDebugInfo();
}
