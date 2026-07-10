// admin.js — BookWare Admin Portal
import { auth, db } from './firebase.js';
import { ADMIN_EMAILS } from './config.js';
import { initTheme, initAriaChat, initARIA, initSettingsModal, openSettingsModal, initStaySignedIn } from './theme.js';
import {
  signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser    = null;
let allUsers       = [];
let allBans        = [];
let allInvites        = [];
let allAccessRequests = [];
let _requestsBadgeUnsub = null;
let systemSettings = {};
let allRentals     = [];
let allLibraries   = [];

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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
  // Mark ALL matching nav buttons (sidebar + bottom nav) as active
  document.querySelectorAll(`[data-page="${pageName}"]`).forEach(btn => {
    btn.classList.add('active');
    btn.setAttribute('aria-current', 'page');
  });
  if (pageName === 'users')     loadAllUsers();
  if (pageName === 'bans')      loadBans();
  if (pageName === 'libraries') loadAllLibraries();
  if (pageName === 'rentals')   loadAllRentals();
  if (pageName === 'invites')   { loadAccessRequests(); loadAdminInvites(); }
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
    initARIA(toast);
    initAriaChat('ariaChatMount', 'admin');
    initSettingsModal();
    initStaySignedIn((stay) => setPersistence(auth, stay ? browserLocalPersistence : browserSessionPersistence));
    await loadSystemSettings();
    await loadDashboard();
    setupEventListeners();
    watchPendingRequests();

  } catch (err) {
    console.error('[admin] Init failed:', err);
    toast(`Failed to load admin portal: ${err.message ?? 'unknown error'}. Try refreshing.`, 'danger');
  }
});

// ── System Settings ───────────────────────────────────────────────────────────
async function loadSystemSettings() {
  const snap = await getDoc(doc(db, 'admin', 'settings'));
  systemSettings = snap.exists() ? snap.data() : { maintenanceMode: false };
  const toggle = document.getElementById('maintenanceModeToggle');
  if (toggle) toggle.checked = systemSettings.maintenanceMode ?? false;
  const stat = document.getElementById('statMaintenance');
  if (stat) stat.textContent = systemSettings.maintenanceMode ? 'ON' : 'OFF';
}

async function setMaintenanceMode(enabled) {
  await setDoc(doc(db, 'admin', 'settings'), { maintenanceMode: enabled }, { merge: true });
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
          ${u.role === 'student' || u.role === 'teacher'
            ? `<button class='btn btn--ghost btn--sm' data-action='reset-onboarding' data-uid='${esc(u.uid)}' data-role='${esc(u.role)}' title='Replay the welcome tour and reading quiz next time they sign in'>Replay Onboarding</button>`
            : ''}
          <button class='btn btn--danger btn--sm' data-action='delete' data-uid='${esc(u.uid)}' style='opacity:0.7'>Delete</button>
        </td>
      </tr>`;
  });
  html += `</tbody></table>`;
  container.innerHTML = html;
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      const { action, uid, role } = e.currentTarget.dataset;
      if (action === 'ban')              openBanModal(uid);
      if (action === 'unban')            unbanUser(uid);
      if (action === 'view')             viewUserDetails(uid);
      if (action === 'delete')           deleteUserRecord(uid);
      if (action === 'reset-onboarding') resetUserOnboarding(uid, role);
    });
  });
}

// Clears a user's saved reading profile so the app treats them as brand-new
// again on their next sign-in: the onboarding reading quiz auto-triggers
// exactly like it does for a first-time account (see maybeRunOnboardingQuiz()
// in student.js / teacher.js).
async function resetUserOnboarding(uid, role) {
  const u = allUsers.find(x => x.uid === uid);
  const label = u?.name || u?.email || uid;
  const ok = await appConfirm(
    `Replay the first-time reading quiz for "${label}"? They'll be prompted to take it again next time they sign in, just like a brand-new account.`,
    'Replay', false
  );
  if (!ok) return;
  try {
    const collectionName = role === 'teacher' ? 'teachers' : 'students';
    await updateDoc(doc(db, collectionName, uid), { readingProfile: null });
    toast(`<i class="bi bi-stars"></i> ${esc(label)} will be prompted with the reading quiz again next sign-in.`, 'success');
  } catch (err) {
    toast(`Failed to reset onboarding: ${esc(err.message ?? 'unknown error')}`, 'danger');
  }
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

// ── Access Requests ───────────────────────────────────────────────────────────

/** Live badge on the Invites nav button showing pending request count */
function watchPendingRequests() {
  if (_requestsBadgeUnsub) _requestsBadgeUnsub();
  _requestsBadgeUnsub = onSnapshot(
    query(collection(db, 'accessRequests'), where('status', '==', 'pending')),
    (snap) => {
      const count = snap.docs.length;
      ['invitesBadge', 'requestsCountBadge', 'settingsRequestsBadge'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = count;
        el.hidden = count === 0;
      });
    },
    (err) => console.warn('[admin] watchPendingRequests error:', err)
  );
}

async function loadAccessRequests() {
  const el = document.getElementById('adminRequestsList');
  if (!el) return;
  el.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const snap = await getDocs(query(
      collection(db, 'accessRequests'),
      where('status', '==', 'pending'),
      orderBy('requestedAt', 'asc')
    ));
    allAccessRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAccessRequests(allAccessRequests);
  } catch (err) {
    console.error('[admin] loadAccessRequests failed:', err);
    el.innerHTML = '<p class="empty-state" style="color:var(--danger)">Failed to load requests.</p>';
  }
}

function renderAccessRequests(requests) {
  const el = document.getElementById('adminRequestsList');
  if (!el) return;
  if (!requests.length) {
    el.innerHTML = '<p class="empty-state">No pending access requests.</p>';
    return;
  }
  el.innerHTML = requests.map(r => {
    const time = r.requestedAt?.toDate?.()
      ? r.requestedAt.toDate().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
      : '—';
    const initials = esc((r.name || r.email || '?')[0].toUpperCase());
    const avatar = r.photoURL
      ? `<img src="${esc(r.photoURL)}" alt="" style="width:34px;height:34px;border-radius:50%;object-fit:cover;background:var(--bg-inset);flex-shrink:0" />`
      : `<div style="width:34px;height:34px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:#fff;flex-shrink:0">${initials}</div>`;
    return `
      <div class="ban-entry" role="listitem">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
          ${avatar}
          <div style="min-width:0">
            <div class="ban-email">${esc(r.name || '—')}</div>
            <div class="ban-detail">${esc(r.email || '—')} · Requested ${time}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn--sm btn--success" data-req-action="approve" data-req-id="${esc(r.id)}">
            <i class="bi bi-check-lg" aria-hidden="true"></i> Approve
          </button>
          <button class="btn btn--sm btn--danger" data-req-action="deny" data-req-id="${esc(r.id)}">
            <i class="bi bi-x-lg" aria-hidden="true"></i> Deny
          </button>
        </div>
      </div>`;
  }).join('');
  bindAccessRequestButtons(el, requests);
}

// Attach approve/deny handlers via delegation. Request data comes from the
// in-memory `requests` array keyed by id — never interpolated into markup, so a
// crafted display name can't inject anything.
function bindAccessRequestButtons(container, requests) {
  const byId = new Map(requests.map(r => [r.id, r]));
  container.querySelectorAll('[data-req-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = byId.get(btn.dataset.reqId);
      if (!r) return;
      if (btn.dataset.reqAction === 'approve') {
        approveAccessRequest(r.id, r.name || '', r.email || '', r.photoURL || '');
      } else {
        denyAccessRequest(r.id, r.name || '');
      }
    });
  });
}

async function approveAccessRequest(uid, name, email, photoURL) {
  if (!uid) return;
  try {
    await setDoc(doc(db, 'users', uid), {
      name:      name  || '',
      email:     email || '',
      role:      'teacher',
      banned:    false,
      class:     null,
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'teachers', uid), {
      name:         name  || '',
      email:        email || '',
      ...(photoURL ? { photoURL } : {}),
      createdAt:    serverTimestamp(),
      canInvite:    true,
      libraryPublic:false,
    });
    await updateDoc(doc(db, 'accessRequests', uid), {
      status:     'approved',
      reviewedBy: currentUser.uid,
      reviewedAt: serverTimestamp(),
    });
    toast(`${name || email} approved as teacher.`, 'success');
    loadAccessRequests();
  } catch (err) {
    console.error('[admin] approveAccessRequest failed:', err);
    toast(`Failed to approve: ${err.message ?? 'unknown error'}`, 'danger');
  }
}

async function denyAccessRequest(uid, name) {
  if (!uid) return;
  const ok = await appConfirm(`Deny access request from ${name || uid}? They can re-request later.`, 'Deny', true);
  if (!ok) return;
  try {
    await updateDoc(doc(db, 'accessRequests', uid), {
      status:     'denied',
      reviewedBy: currentUser.uid,
      reviewedAt: serverTimestamp(),
    });
    toast('Access request denied.', 'success');
    loadAccessRequests();
  } catch (err) {
    console.error('[admin] denyAccessRequest failed:', err);
    toast(`Failed to deny: ${err.message ?? 'unknown error'}`, 'danger');
  }
}

// ── Invites ───────────────────────────────────────────────────────────────
let _adminLastInviteLink  = '';
let _adminLastInviteEmail = '';

async function loadAdminInvites() {
  const el = document.getElementById('adminInvitesList');
  if (!el) return;
  el.innerHTML = `<p class='empty-state'>Loading…</p>`;
  try {
    const snap = await getDocs(query(collection(db, 'invites'), orderBy('createdAt', 'desc'), limit(200)));
    allInvites = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAdminInvitesList(allInvites);
  } catch (err) {
    el.innerHTML = `<p class='empty-state'>Could not load invites: ${esc(err.message)}</p>`;
  }
}

function renderAdminInvitesList(invites) {
  const el = document.getElementById('adminInvitesList');
  if (!el) return;
  if (!invites.length) {
    el.innerHTML = `<p class='empty-state'>No invites yet — create the first one above.</p>`;
    return;
  }
  el.innerHTML = '';
  const now = new Date();
  invites.forEach(inv => {
    const expDate  = inv.expiresAt?.toDate?.();
    const expired  = expDate && expDate < now;
    const isActive = !inv.used && !inv.revoked && !expired;
    const link     = `${window.location.origin}/teacher-signup.html?token=${inv.id}`;

    const statusBadge = inv.used
      ? `<span class='status-indicator active' style='font-size:0.72rem'><span class='status-dot'></span>Used</span>`
      : inv.revoked
      ? `<span class='status-indicator banned' style='font-size:0.72rem'><span class='status-dot'></span>Revoked</span>`
      : expired
      ? `<span class='status-indicator' style='font-size:0.72rem;opacity:0.5'><span class='status-dot'></span>Expired</span>`
      : `<span class='status-indicator active' style='font-size:0.72rem;color:var(--accent)'><span class='status-dot' style='background:var(--accent)'></span>Active</span>`;

    const entry = document.createElement('div');
    entry.className = 'ban-entry';
    entry.style.cssText = 'flex-wrap:wrap;gap:8px;align-items:flex-start';
    entry.innerHTML = `
      <div style='flex:1;min-width:180px'>
        <div class='ban-email'>${inv.recipientEmail
          ? esc(inv.recipientEmail)
          : '<em style="opacity:0.65">Open invite (any school email)</em>'}</div>
        <div class='ban-detail'>
          By ${esc(inv.createdByName ?? '—')} ·
          Created ${fmtDate(inv.createdAt)} ·
          Expires ${expDate ? expDate.toLocaleDateString() : '—'}
          ${inv.claimedBy ? ' · <strong>Claimed</strong>' : ''}
        </div>
        <div style='margin-top:6px'>${statusBadge}</div>
        <div class='admin-invite-qr' hidden style='margin-top:10px'>
          <img src='' alt='QR code for invite'
               style='width:130px;height:130px;background:#fff;padding:5px;border-radius:7px;display:block'>
          <p class='ban-detail' style='margin-top:4px'>Scan with phone camera to open invite</p>
        </div>
      </div>
      <div style='display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start'>
        ${isActive ? `
          <button class='btn btn--ghost btn--sm' data-action='copy-link' data-link='${esc(link)}'
                  title='Copy invite link' aria-label='Copy invite link'>
            <i class='bi bi-clipboard' aria-hidden='true'></i>
          </button>
          <button class='btn btn--ghost btn--sm' data-action='show-qr' data-link='${esc(link)}'
                  title='Toggle QR code' aria-label='Toggle QR code'>
            <i class='bi bi-qr-code' aria-hidden='true'></i>
          </button>
          <button class='btn btn--danger btn--sm' data-action='revoke' data-id='${esc(inv.id)}'>
            Revoke
          </button>
        ` : ''}
      </div>`;
    el.appendChild(entry);
  });

  el.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { action, link, id } = btn.dataset;
      if (action === 'copy-link') {
        navigator.clipboard.writeText(link)
          .then(() => toast('<i class="bi bi-check2"></i> Link copied', 'success'))
          .catch(() => toast(`Copy failed — link: ${link}`, 'info'));
      }
      if (action === 'show-qr') {
        const entry = btn.closest('.ban-entry');
        const qrDiv = entry?.querySelector('.admin-invite-qr');
        const qrImg = qrDiv?.querySelector('img');
        if (!qrDiv) return;
        qrDiv.hidden = !qrDiv.hidden;
        if (!qrDiv.hidden && qrImg && !qrImg.src) {
          qrImg.src = `https://chart.googleapis.com/chart?chs=200x200&cht=qr&chl=${encodeURIComponent(link)}&choe=UTF-8`;
        }
      }
      if (action === 'revoke') revokeAdminInvite(id);
    });
  });
}

async function createAdminInvite() {
  const emailInput  = document.getElementById('adminInviteEmailInput');
  const output      = document.getElementById('adminInviteOutput');
  const qrContainer = document.getElementById('adminInviteQrContainer');
  const qrImg       = document.getElementById('adminInviteQrImg');
  const emailBtn    = document.getElementById('adminEmailInviteBtn');
  const email       = (emailInput?.value.trim() ?? '').toLowerCase();

  // Email is optional; if provided it must look valid
  if (email && !email.includes('@')) {
    toast('Enter a valid email address or leave blank for an open invite.', 'danger');
    return;
  }

  const expiresAt = new Date(Date.now() + 7 * 86400000);
  try {
    const ref = await addDoc(collection(db, 'invites'), {
      recipientEmail: email,
      used:           false,
      revoked:        false,
      expiresAt:      Timestamp.fromDate(expiresAt),
      createdBy:      currentUser.uid,
      createdByName:  currentUser.displayName ?? 'Admin',
      createdByRole:  'admin',
      createdAt:      serverTimestamp(),
    });
    const link = `${window.location.origin}/teacher-signup.html?token=${ref.id}`;
    _adminLastInviteLink  = link;
    _adminLastInviteEmail = email;

    await navigator.clipboard.writeText(link).catch(() => {});
    if (output) output.innerHTML = `
      <div style='background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;
                  padding:12px;font-size:0.78rem;word-break:break-all;font-family:monospace;
                  margin-top:4px'>${esc(link)}</div>
      <p class='settings-hint' style='margin-top:8px'>
        <i class='bi bi-check2'></i> Copied! Valid 7 days${email
          ? ` · locked to ${esc(email)}`
          : ' · open — any school account can claim'}.
      </p>`;

    if (qrImg && qrContainer) {
      qrImg.src = `https://chart.googleapis.com/chart?chs=220x220&cht=qr&chl=${encodeURIComponent(link)}&choe=UTF-8`;
      qrContainer.hidden = false;
    }
    if (emailBtn) emailBtn.hidden = !email; // only show email button if there's a recipient

    if (emailInput) emailInput.value = '';
    toast(`<i class='bi bi-check2'></i> Invite created &amp; copied`, 'success');
    loadAdminInvites();
  } catch (err) {
    toast(`Failed to create invite: ${esc(err.message ?? 'unknown')}`, 'danger');
  }
}

async function revokeAdminInvite(inviteId) {
  const ok = await appConfirm(
    'Revoke this invite? The link will stop working immediately.',
    'Revoke', true
  );
  if (!ok) return;
  try {
    await updateDoc(doc(db, 'invites', inviteId), {
      revoked:   true,
      revokedAt: serverTimestamp(),
      revokedBy: currentUser.uid,
    });
    toast('Invite revoked', 'success');
    loadAdminInvites();
  } catch (err) {
    toast(`Revoke failed: ${esc(err.message)}`, 'danger');
  }
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

// Force every non-admin session to re-authenticate. We stamp a `sessionEpoch`
// on admin/settings; the student and teacher portals compare it against the
// user's Firebase `lastSignInTime` on load and sign out anyone who logged in
// before the stamp. It takes effect the next time each client loads or its auth
// state refreshes (there is no server to revoke tokens instantly without a
// Cloud Function), and admins are never affected.
async function forceLogoutAll() {
  const ok = await appConfirm(
    'Force all students and teachers to sign in again? Their sessions end the next time their app loads. Admins are not affected.',
    'Force Re-login', true
  );
  if (!ok) return;
  try {
    await setDoc(doc(db, 'admin', 'settings'), { sessionEpoch: serverTimestamp() }, { merge: true });
    toast('All non-admin users will be signed out on their next app load.', 'success');
  } catch (err) {
    toast(`Failed: ${esc(err.message ?? 'unknown error')}`, 'danger');
  }
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
  document.getElementById('exportDataBtn')?.addEventListener('click',         exportAllData);
  document.getElementById('exportDataBtnSettings')?.addEventListener('click', exportAllData);
  document.getElementById('logoutAllBtn')?.addEventListener('click',         forceLogoutAll);
  document.getElementById('viewGlobalBansBtn')?.addEventListener('click',    () => showPage('bans'));
  document.getElementById('refreshInvitesBtn')?.addEventListener('click',   loadAdminInvites);
  document.getElementById('adminCreateInviteBtn')?.addEventListener('click', createAdminInvite);
  document.getElementById('adminEmailInviteBtn')?.addEventListener('click',  () => {
    if (!_adminLastInviteLink) return;
    const subject = encodeURIComponent("You've been invited to BookWare");
    const body    = encodeURIComponent(
      `Hi,\n\nYou've been invited to join BookWare as a teacher at Mason High School.\n\n` +
      `Click the link below to create your account:\n${_adminLastInviteLink}\n\n` +
      `${_adminLastInviteEmail ? `This invite is locked to ${_adminLastInviteEmail}.\n` : ''}` +
      `It expires in 7 days.\n\n— BookWare Admin`
    );
    window.open(`mailto:${_adminLastInviteEmail}?subject=${subject}&body=${body}`);
    toast('<i class="bi bi-envelope-fill"></i> Opening email client…', 'info');
  });
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

  // Add User modal
  document.getElementById('addUserBtn')?.addEventListener('click',  openAddUserModal);
  document.getElementById('addUserCloseBtn')?.addEventListener('click', closeAddUserModal);
  document.getElementById('addUserOverlay')?.addEventListener('click', e => { if (e.target.id === 'addUserOverlay') closeAddUserModal(); });
  document.getElementById('addUserSubmitBtn')?.addEventListener('click', submitAddUser);

  // Settings modal: load requests when it opens
  document.getElementById('settingsPage')?.addEventListener('transitionend', () => {}, { once: false });
  // Use MutationObserver to detect when settings modal becomes visible
  const settingsEl = document.getElementById('settingsPage');
  if (settingsEl) {
    new MutationObserver(() => {
      if (!settingsEl.hidden) loadSettingsRequests();
    }).observe(settingsEl, { attributeFilter: ['hidden'] });
  }

  // Initial page loads
  loadAllUsers();
  loadBans();
}

// ── Settings modal: access requests panel ─────────────────────────────────────
async function loadSettingsRequests() {
  const el = document.getElementById('settingsRequestsList');
  if (!el) return;
  el.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const snap = await getDocs(query(
      collection(db, 'accessRequests'),
      where('status', '==', 'pending'),
      orderBy('requestedAt', 'asc')
    ));
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!requests.length) { el.innerHTML = '<p class="empty-state">No pending access requests.</p>'; return; }
    el.innerHTML = requests.map(r => {
      const time = r.requestedAt?.toDate?.()
        ? r.requestedAt.toDate().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
        : '—';
      const initials = esc((r.name || r.email || '?')[0].toUpperCase());
      const avatar = r.photoURL
        ? `<img src="${esc(r.photoURL)}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
        : `<div style="width:32px;height:32px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:#fff;flex-shrink:0">${initials}</div>`;
      return `
        <div class="ban-entry" role="listitem">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            ${avatar}
            <div style="min-width:0">
              <div class="ban-email">${esc(r.name || '—')}</div>
              <div class="ban-detail">${esc(r.email || '—')} · ${time}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn--sm btn--success" data-req-action="approve" data-req-id="${esc(r.id)}">
              <i class="bi bi-check-lg"></i> Approve
            </button>
            <button class="btn btn--sm btn--danger" data-req-action="deny" data-req-id="${esc(r.id)}">
              <i class="bi bi-x-lg"></i> Deny
            </button>
          </div>
        </div>`;
    }).join('');
    bindAccessRequestButtons(el, requests);
  } catch (err) {
    console.error('[admin] loadSettingsRequests failed:', err);
    el.innerHTML = '<p class="empty-state" style="color:var(--danger)">Failed to load.</p>';
  }
}

// ── Add User ──────────────────────────────────────────────────────────────────
// Admin enters one or more emails → a pendingUsers record is created for each.
// The account is auto-provisioned the first time that person signs in with Google
// (claimed in auth.js completeLogin via consumePendingUser).
function openAddUserModal() {
  const overlay = document.getElementById('addUserOverlay');
  if (overlay) {
    overlay.hidden = false;
    document.getElementById('addUserEmails').value = '';
    document.getElementById('addUserRole').value   = 'student';
    document.getElementById('addUserStatus').textContent = '';
    document.getElementById('addUserBtnLabel').textContent = 'Add User';
    document.getElementById('addUserSubmitBtn').disabled = false;
    document.getElementById('addUserEmails').focus();
  }
}
function closeAddUserModal() {
  const overlay = document.getElementById('addUserOverlay');
  if (overlay) overlay.hidden = true;
}

const _emailKey = (email) => email.toLowerCase().trim().replace(/\./g, '_');
const _isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function submitAddUser() {
  const raw       = document.getElementById('addUserEmails').value;
  const role      = document.getElementById('addUserRole').value;
  const statusEl  = document.getElementById('addUserStatus');
  const submitBtn = document.getElementById('addUserSubmitBtn');
  const btnLabel  = document.getElementById('addUserBtnLabel');

  // Parse: split on newlines, commas, semicolons, or whitespace
  const emails = [...new Set(
    raw.split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean)
  )];

  if (!emails.length) {
    statusEl.textContent = 'Please enter at least one email address.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  const invalid = emails.filter(e => !_isValidEmail(e));
  if (invalid.length) {
    statusEl.innerHTML = `<span style="color:var(--danger)">Invalid email${invalid.length > 1 ? 's' : ''}: ${invalid.map(e => esc(e)).join(', ')}</span>`;
    return;
  }

  statusEl.textContent = '';
  submitBtn.disabled = true;
  btnLabel.innerHTML = `<span style="opacity:0.7">Adding ${emails.length}…</span>`;

  let ok = 0;
  const failed = [];
  for (const email of emails) {
    try {
      await setDoc(doc(db, 'pendingUsers', _emailKey(email)), {
        email,                       // stored lowercased — matched on sign-in
        role,
        createdBy: currentUser.uid,
        createdAt: serverTimestamp(),
      });
      ok++;
    } catch (err) {
      console.error('[admin] addUser failed for', email, err);
      failed.push(email);
    }
  }

  const roleLabel = role === 'teacher' ? 'teacher' : 'student';
  if (ok) {
    statusEl.innerHTML =
      `<span style="color:var(--success)">✓ Added ${ok} ${roleLabel}${ok > 1 ? 's' : ''}.</span> ` +
      `They'll get an account automatically on first Google sign-in.` +
      (failed.length ? `<br><span style="color:var(--danger)">Failed: ${failed.map(e => esc(e)).join(', ')}</span>` : '');
    toast(`Added ${ok} ${roleLabel}${ok > 1 ? 's' : ''}`, 'success');
    document.getElementById('addUserEmails').value = '';
  } else {
    statusEl.innerHTML = `<span style="color:var(--danger)">Failed to add users. Check the console.</span>`;
  }

  submitBtn.disabled = false;
  btnLabel.textContent = 'Add More';
}
