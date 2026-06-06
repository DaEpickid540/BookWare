// admin.js — BookWare Admin Portal
import { auth, db } from './firebase.js';
import { initTheme, initAriaChat, initSettingsModal, openSettingsModal } from './theme.js';
import { signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit,
  serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ADMIN_EMAILS = ['sarvin.sukhe@gmail.com', 'sarvinsukhe@gmail.com', 'daepickid540@gmail.com'];

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser    = null;
let allUsers       = [];
let allBans        = [];
let systemSettings = {};
let allRentals     = [];
let allLibraries   = [];

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

// Custom confirm modal replacing window.confirm
function appConfirm(msg, okLabel = 'Confirm', danger = true) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirmModalOverlay');
    const msgEl   = document.getElementById('confirmModalMsg');
    const okBtn   = document.getElementById('confirmModalOkBtn');
    const cancelBtn = document.getElementById('confirmModalCancelBtn');
    if (!overlay) { resolve(window.confirm(msg)); return; }
    msgEl.textContent = msg;
    okBtn.textContent = okLabel;
    okBtn.className   = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
    overlay.hidden    = false;
    const cleanup = (result) => {
      overlay.hidden = true;
      okBtn.replaceWith(okBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      resolve(result);
      // Re-bind the new buttons for next use
      document.getElementById('confirmModalOkBtn')?.addEventListener('click', () => {}, { once: true });
      document.getElementById('confirmModalCancelBtn')?.addEventListener('click', () => {}, { once: true });
    };
    const newOk = document.getElementById('confirmModalOkBtn');
    const newCancel = document.getElementById('confirmModalCancelBtn');
    // Use one-time click on the newly-replaced node is tricky — use overlay event delegation instead
    overlay.addEventListener('click', function handler(e) {
      if (e.target === overlay) { overlay.removeEventListener('click', handler); cleanup(false); }
    });
    document.getElementById('confirmModalOkBtn').addEventListener('click', function handler() {
      this.removeEventListener('click', handler);
      cleanup(true);
    }, { once: true });
    document.getElementById('confirmModalCancelBtn').addEventListener('click', function handler() {
      this.removeEventListener('click', handler);
      cleanup(false);
    }, { once: true });
  });
}

// ── Page routing ──────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

function showPage(pageName) {
  if (pageName === 'settings') { openSettingsModal(); return; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => { n.classList.remove('active'); n.removeAttribute('aria-current'); });
  document.getElementById(pageName + 'Page')?.classList.add('active');
  const btn = document.querySelector(`[data-page="${pageName}"]`);
  btn?.classList.add('active');
  btn?.setAttribute('aria-current', 'page');
  if (pageName === 'users')     loadAllUsers();
  if (pageName === 'bans')      loadBans();
  if (pageName === 'libraries') loadAllLibraries();
  if (pageName === 'rentals')   loadAllRentals();
  if (pageName === 'debug')     loadDebugInfo();
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
    const adminEmailEl = document.getElementById('adminEmail');
    if (adminEmailEl) adminEmailEl.textContent = user.email;

    initTheme();
    initAriaChat('ariaChatMount', 'admin');
    initSettingsModal();
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
  if (stat) stat.textContent = systemSettings.maintenanceMode ? 'ON' : 'OFF';
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
  const [usersSnap, bannedSnap, teachersSnap] = await Promise.all([
    getDocs(collection(db, 'users')),
    getDocs(query(collection(db, 'users'), where('banned', '==', true))),
    getDocs(query(collection(db, 'users'), where('role', '==', 'teacher'))),
  ]);
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('statTotalUsers',  usersSnap.size);
  el('statTeachers',    teachersSnap.size);
  el('statBannedUsers', bannedSnap.size);
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
          <div class='activity-meta'>${esc(u.email)} · ${esc(u.banReason || 'Not specified')}</div>
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
      <caption class='sr-only'>User accounts in BookWare</caption>
      <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>`;
  users.forEach(u => {
    const status = u.banned
      ? `<span class='status-indicator banned'><span class='status-dot'></span>Banned</span>`
      : `<span class='status-indicator active'><span class='status-dot'></span>Active</span>`;
    html += `
      <tr>
        <td>${esc(u.email)}</td>
        <td>${esc(u.name ?? '—')}</td>
        <td><span class='chip'>${esc(u.role)}</span></td>
        <td>${status}</td>
        <td>
          <button class='btn btn--ghost btn--sm' data-action='view'  data-uid='${esc(u.uid)}'>View</button>
          ${!u.banned
            ? `<button class='btn btn--danger btn--sm' data-action='ban'    data-uid='${esc(u.uid)}'>Ban</button>`
            : `<button class='btn btn--success btn--sm' data-action='unban' data-uid='${esc(u.uid)}'>Unban</button>`}
          <button class='btn btn--danger btn--sm' data-action='delete' data-uid='${esc(u.uid)}' style='opacity:0.7'>Delete</button>
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
  toast(`${esc(u.name ?? '—')} · ${esc(u.email)} · Role: ${esc(u.role)} · Banned: ${u.banned ? 'Yes' : 'No'}`, 'info');
}

async function deleteUserRecord(uid) {
  const u     = allUsers.find(x => x.uid === uid);
  const label = u?.name || u?.email || uid;
  const ok    = await appConfirm(`Permanently delete "${label}"?\n\nThis removes their BookWare account. Cannot be undone.`, 'Delete', true);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, 'users', uid));
    try { await deleteDoc(doc(db, 'students', uid)); } catch (_) {}
    try { await deleteDoc(doc(db, 'teachers', uid)); } catch (_) {}
    toast(`Deleted ${esc(label)}`, 'success');
    await loadAllUsers();
    await loadSystemStats();
  } catch (err) { toast(`Delete failed: ${esc(err.message)}`, 'danger'); }
}

// ── Libraries ─────────────────────────────────────────────────────────────────
async function loadAllLibraries() {
  const container = document.getElementById('librariesContainer');
  if (!container) return;
  container.innerHTML = `<p class='empty-state'>Loading libraries…</p>`;
  const snap = await getDocs(collection(db, 'teachers'));
  allLibraries = await Promise.all(snap.docs.map(async d => {
    const t = d.data();
    let bookCount = 0;
    try {
      const bSnap = await getDocs(collection(db, 'teachers', d.id, 'books'));
      bookCount = bSnap.size;
    } catch (_) {}
    return { id: d.id, ...t, bookCount };
  }));
  renderLibrariesTable(allLibraries);
}

function renderLibrariesTable(libs) {
  const container = document.getElementById('librariesContainer');
  if (!container) return;
  if (libs.length === 0) { container.innerHTML = `<p class='empty-state'>No libraries found.</p>`; return; }

  const visFilter = document.getElementById('libraryVisFilter')?.value ?? '';
  const filtered  = visFilter
    ? libs.filter(l => visFilter === 'public' ? l.libraryPublic : !l.libraryPublic)
    : libs;

  const searchVal = (document.getElementById('librarySearchInput')?.value ?? '').toLowerCase();
  const displayed = searchVal
    ? filtered.filter(l => l.name?.toLowerCase().includes(searchVal) || l.email?.toLowerCase().includes(searchVal))
    : filtered;

  if (displayed.length === 0) { container.innerHTML = `<p class='empty-state'>No matches.</p>`; return; }

  container.innerHTML = `
    <table class='data-table'>
      <caption class='sr-only'>All teacher libraries</caption>
      <thead><tr><th>Teacher</th><th>Email</th><th>Books</th><th>Visibility</th><th>Approval</th><th>Actions</th></tr></thead>
      <tbody>
        ${displayed.map(l => `
          <tr>
            <td>${esc(l.name ?? '—')}</td>
            <td>${esc(l.email ?? '—')}</td>
            <td>${l.bookCount}</td>
            <td>${l.libraryPublic
              ? `<span class='chip' style='color:var(--info);border-color:rgba(52,152,219,.35)'>Public</span>`
              : `<span class='chip'>Class Only</span>`}</td>
            <td>${l.requireApproval
              ? `<span class='chip' style='color:var(--warning);border-color:rgba(243,156,18,.35)'>Approval On</span>`
              : `<span class='chip'>Instant</span>`}</td>
            <td>
              <button class='btn btn--ghost btn--sm' data-action='view-library' data-tid='${esc(l.id)}' data-name='${esc(l.name ?? '')}'>View Books</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  container.querySelectorAll('[data-action="view-library"]').forEach(btn => {
    btn.addEventListener('click', e => {
      const { tid, name } = e.currentTarget.dataset;
      showLibraryDetail(tid, name);
    });
  });
}

async function showLibraryDetail(tid, name) {
  const container = document.getElementById('librariesContainer');
  container.innerHTML = `
    <div style='display:flex;align-items:center;gap:10px;margin-bottom:16px'>
      <button class='btn btn--ghost btn--sm' id='backToLibraries'><i class='bi bi-arrow-left'></i> All Libraries</button>
      <h2 style='font-family:var(--font-serif);font-size:1.1rem;font-weight:400'>${esc(name)}'s Library</h2>
    </div>
    <p class='empty-state'>Loading books…</p>`;
  document.getElementById('backToLibraries')?.addEventListener('click', () => renderLibrariesTable(allLibraries));

  const snap = await getDocs(collection(db, 'teachers', tid, 'books'));
  if (snap.empty) { container.querySelector('p').textContent = 'No books in this library.'; return; }
  const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  let html = `
    <div style='display:flex;align-items:center;gap:10px;margin-bottom:16px'>
      <button class='btn btn--ghost btn--sm' id='backToLibraries'><i class='bi bi-arrow-left'></i> All Libraries</button>
      <h2 style='font-family:var(--font-serif);font-size:1.1rem;font-weight:400'>${esc(name)}'s Library (${books.length} book${books.length !== 1 ? 's' : ''})</h2>
    </div>
    <table class='data-table'>
      <thead><tr><th>Title</th><th>Author</th><th>Copies</th><th>Status</th></tr></thead>
      <tbody>
        ${books.map(b => {
          const copies = b.copies ?? 1;
          const out    = b.checkedOutCount ?? (b.status === 'checked_out' ? 1 : 0);
          return `<tr>
            <td>${esc(b.title)}</td>
            <td>${esc(b.author ?? '—')}</td>
            <td>${copies}</td>
            <td>${out > 0 ? `<span class='chip' style='color:var(--accent)'>${out}/${copies} out</span>` : `<span class='chip' style='color:var(--success)'>Available</span>`}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  container.innerHTML = html;
  document.getElementById('backToLibraries')?.addEventListener('click', () => renderLibrariesTable(allLibraries));
}

// Library search/filter
function filterLibraries() {
  renderLibrariesTable(allLibraries);
}

// ── Rentals ───────────────────────────────────────────────────────────────────
async function loadAllRentals() {
  const container = document.getElementById('rentalsTableContainer');
  if (!container) return;
  container.innerHTML = `<p class='empty-state'>Loading rentals…</p>`;

  // Fetch all teachers, then all history from each
  const teachersSnap = await getDocs(collection(db, 'teachers'));
  const entries = [];
  await Promise.all(teachersSnap.docs.map(async td => {
    const tName = td.data().name ?? td.id;
    try {
      const hSnap = await getDocs(collection(db, 'teachers', td.id, 'history'));
      hSnap.forEach(d => entries.push({ ...d.data(), id: d.id, teacherId: td.id, teacherName: tName }));
    } catch (_) {}
  }));

  allRentals = entries.sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));

  // Stats
  const now      = new Date();
  const active   = allRentals.filter(e => !e.dateReturned);
  const returned = allRentals.filter(e => !!e.dateReturned);
  const overdue  = active.filter(e => e.dueDate && (e.dueDate.toDate ? e.dueDate.toDate() : new Date(e.dueDate)) < now);

  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('statTotalRentals',    allRentals.length);
  el('statActiveRentals',   active.length);
  el('statOverdueRentals',  overdue.length);
  el('statReturnedRentals', returned.length);

  renderRentalsTable(allRentals);
}

function renderRentalsTable(entries) {
  const container = document.getElementById('rentalsTableContainer');
  if (!container) return;
  const statusFilter = document.getElementById('rentalsStatusFilter')?.value ?? '';
  const now = new Date();
  let filtered = entries;
  if (statusFilter === 'active')   filtered = entries.filter(e => !e.dateReturned);
  if (statusFilter === 'returned') filtered = entries.filter(e => !!e.dateReturned);
  if (statusFilter === 'overdue')  filtered = entries.filter(e => !e.dateReturned && e.dueDate && (e.dueDate.toDate ? e.dueDate.toDate() : new Date(e.dueDate)) < now);

  if (filtered.length === 0) { container.innerHTML = `<p class='empty-state'>No rentals found.</p>`; return; }
  container.innerHTML = `
    <table class='data-table'>
      <caption class='sr-only'>Rental history across all teachers</caption>
      <thead><tr><th>Book</th><th>Student</th><th>Teacher Library</th><th>Date Out</th><th>Due Date</th><th>Returned</th></tr></thead>
      <tbody>
        ${filtered.slice(0, 200).map(e => {
          const dueDate  = e.dueDate ? (e.dueDate.toDate ? e.dueDate.toDate() : new Date(e.dueDate)) : null;
          const isOverdue = !e.dateReturned && dueDate && dueDate < now;
          return `<tr>
            <td>${esc(e.bookTitle)}</td>
            <td>${esc(e.studentName ?? '—')}</td>
            <td>${esc(e.teacherName)}</td>
            <td>${fmtDate(e.dateOut)}</td>
            <td style='color:${isOverdue ? 'var(--danger)' : 'inherit'}'>${dueDate ? fmtDate(e.dueDate) : '—'}${isOverdue ? ' ⚠' : ''}</td>
            <td>${e.dateReturned
              ? `<span class='chip' style='color:var(--success)'>${fmtDate(e.dateReturned)}</span>`
              : `<span class='chip' style='color:var(--accent)'>Active</span>`}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${filtered.length > 200 ? `<p class='empty-state' style='margin-top:8px'>Showing first 200 of ${filtered.length} records.</p>` : ''}`;
}

function exportRentalsCSV() {
  const rows  = [['Book','Author','Student','Teacher Library','Date Out','Due Date','Date Returned','Status']];
  const now   = new Date();
  allRentals.forEach(e => {
    const dueDate  = e.dueDate ? (e.dueDate.toDate ? e.dueDate.toDate() : new Date(e.dueDate)) : null;
    const isOverdue = !e.dateReturned && dueDate && dueDate < now;
    rows.push([
      e.bookTitle ?? '',
      e.author ?? '',
      e.studentName ?? '',
      e.teacherName ?? '',
      fmtDate(e.dateOut),
      dueDate ? dueDate.toLocaleDateString() : '',
      e.dateReturned ? fmtDate(e.dateReturned) : '',
      e.dateReturned ? 'Returned' : isOverdue ? 'Overdue' : 'Active',
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a   = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `bookware-rentals-${new Date().toISOString().slice(0,10)}.csv`,
  });
  a.click(); URL.revokeObjectURL(a.href);
  toast('<i class="bi bi-check2"></i> Rentals exported as CSV', 'success');
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
    const isPermanent = !banExpiry;
    const expiryStr = isPermanent ? 'Permanent' : banExpiry > new Date() ? `Expires ${banExpiry.toLocaleDateString()}` : 'Expired';
    const entry = document.createElement('div');
    entry.className = 'ban-entry';
    entry.innerHTML = `
      <div>
        <div class='ban-email'>${esc(u.email)}</div>
        <div class='ban-detail'>
          ${esc(u.name ?? '—')} · Reason: ${esc(u.banReason || 'Not specified')} · ${expiryStr}
          ${isPermanent ? `<span style='color:var(--danger);font-weight:600;margin-left:4px'>PERMANENT</span>` : ''}
        </div>
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
  let banExpiry = null;
  if (duration === '24h')      banExpiry = new Date(Date.now() + 86400000);
  else if (duration === '7d')  banExpiry = new Date(Date.now() + 7 * 86400000);
  else if (duration === '30d') banExpiry = new Date(Date.now() + 30 * 86400000);
  // permanent: banExpiry stays null

  await updateDoc(doc(db, 'users', uid), {
    banned: true, banReason: reason,
    banExpiry: banExpiry ? Timestamp.fromDate(banExpiry) : null,
    updatedAt: serverTimestamp(),
  });
  toast(`User banned${banExpiry ? ` until ${banExpiry.toLocaleDateString()}` : ' permanently'}`, 'danger');
  await loadBans(); await loadAllUsers(); await loadSystemStats();
}

async function unbanUser(uid) {
  const ok = await appConfirm('Revoke this ban? The user will regain full access immediately.', 'Revoke', false);
  if (!ok) return;
  await updateDoc(doc(db, 'users', uid), { banned: false, banReason: null, banExpiry: null });
  toast('Ban revoked', 'success');
  await loadBans(); await loadAllUsers(); await loadSystemStats();
}

// ── Debug ─────────────────────────────────────────────────────────────────────
async function loadDebugInfo() {
  await Promise.all([loadFirestoreStats(), loadAuthStats()]);
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
  const ok = await appConfirm('Export all user data as JSON? This may be large.', 'Export', false);
  if (!ok) return;
  const snap = await getDocs(collection(db, 'users'));
  const data = { exportedAt: new Date().toISOString(), users: snap.docs.map(d => ({ uid: d.id, ...d.data() })) };
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })),
    download: `bookware-export-${Date.now()}.json`,
  });
  a.click(); URL.revokeObjectURL(a.href);
  toast('Data exported', 'success');
}

async function forceLogoutAll() {
  const ok = await appConfirm('This would force-logout all users. This feature requires a Cloud Function on the server side and is not yet implemented.', 'Understood', false);
}

// ── Event Listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  document.getElementById('refreshStatsBtn')?.addEventListener('click',     async () => { await loadSystemStats(); await loadRecentActivity(); toast('Stats refreshed', 'success'); });
  document.getElementById('toggleMaintenanceBtn')?.addEventListener('click', () => setMaintenanceMode(!systemSettings.maintenanceMode));
  document.getElementById('userSearchInput')?.addEventListener('input',      filterUsers);
  document.getElementById('userRoleFilter')?.addEventListener('change',      filterUsers);
  document.getElementById('refreshUsersBtn')?.addEventListener('click',      loadAllUsers);
  document.getElementById('refreshLibrariesBtn')?.addEventListener('click',  loadAllLibraries);
  document.getElementById('librarySearchInput')?.addEventListener('input',   filterLibraries);
  document.getElementById('libraryVisFilter')?.addEventListener('change',    filterLibraries);
  document.getElementById('refreshRentalsBtn')?.addEventListener('click',    loadAllRentals);
  document.getElementById('rentalsStatusFilter')?.addEventListener('change', () => renderRentalsTable(allRentals));
  document.getElementById('exportRentalsBtn')?.addEventListener('click',     exportRentalsCSV);
  document.getElementById('createBanBtn')?.addEventListener('click',         () => openBanModal(''));
  document.getElementById('refreshDebugBtn')?.addEventListener('click',      loadDebugInfo);
  document.getElementById('exportDataBtn')?.addEventListener('click',        exportAllData);
  document.getElementById('logoutAllBtn')?.addEventListener('click',         forceLogoutAll);
  document.getElementById('viewGlobalBansBtn')?.addEventListener('click',    () => showPage('bans'));
  document.getElementById('maintenanceModeToggle')?.addEventListener('change', e => setMaintenanceMode(e.target.checked));

  // Ban modal
  const overlay   = document.getElementById('banModalOverlay');
  document.getElementById('banModalCancelBtn')?.addEventListener('click',  () => { if (overlay) overlay.hidden = true; });
  document.getElementById('banModalCancelBtn2')?.addEventListener('click', () => { if (overlay) overlay.hidden = true; });
  document.getElementById('banModalConfirmBtn')?.addEventListener('click', async () => {
    const uid      = document.getElementById('banUserEmail')?.dataset.uid;
    const reason   = document.getElementById('banReason')?.value;
    const duration = document.getElementById('banDuration')?.value;
    if (!reason || !duration) { toast('Please fill all fields', 'danger'); return; }
    if (!uid && !document.getElementById('banUserEmail')?.value) { toast('No user selected', 'danger'); return; }
    let targetUid = uid;
    if (!targetUid) {
      const email = document.getElementById('banUserEmail')?.value.trim();
      const snap  = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
      if (snap.empty) { toast('User not found with that email', 'danger'); return; }
      targetUid = snap.docs[0].id;
    }
    await banUser(targetUid, reason, duration);
    if (overlay) overlay.hidden = true;
    document.getElementById('banUserEmail').value = '';
    document.getElementById('banReason').value    = '';
    document.getElementById('banDuration').value  = '24h';
  });
  overlay?.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; });

  // Initial page loads
  loadAllUsers();
  loadBans();
}
