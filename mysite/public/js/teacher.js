// teacher.js — BookWare Teacher Portal
import { auth, db } from './firebase.js';
import { lookupISBN, searchBooks } from './books.js';
import { initTheme, initARIA, initAriaChat, initAriaRecommends, refreshAriaChats, initSettingsModal, openSettingsModal, initStaySignedIn } from './theme.js';
import { runReadingQuiz } from './quiz.js';
import {
  signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, onSnapshot, serverTimestamp, Timestamp, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser          = null;
let teacherData          = null;
let allBooks             = [];
let recommendations      = [];
let bookSearchResults    = [];
let recGoogleResults     = [];
let readingSearchResults = [];
let recGoogleDebounce    = null;
let historyUnsubscribe   = null;
let allClasses           = [];

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
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 4200);
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function genCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

// ── Sidebar + routing ─────────────────────────────────────────────────────────
document.getElementById('sidebarToggle')?.addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  const collapsed = sb.classList.toggle('collapsed');
  document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(!collapsed));
});

const PAGE_TITLES = { library: 'Library', students: 'Students', reading: 'Now Reading', recommendations: 'Recommendations', invites: 'Invite Teachers', settings: 'Settings' };

document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

function showPage(name) {
  if (name === 'settings') { openSettingsModal(); return; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => { n.classList.remove('active'); n.removeAttribute('aria-current'); });
  document.getElementById(name + 'Page')?.classList.add('active');
  // Mark ALL matching nav buttons (sidebar + bottom nav) as active
  document.querySelectorAll(`[data-page="${name}"]`).forEach(btn => {
    btn.classList.add('active');
    btn.setAttribute('aria-current', 'page');
  });
  const pt = document.getElementById('pageTitle');
  if (pt) pt.textContent = PAGE_TITLES[name] ?? name;
  if (name === 'students')        { loadCheckedOut(); loadHistory(); loadActiveBans(); loadRoster(); loadPendingRequests(); }
  if (name === 'recommendations') { renderRecommendationsList(); renderRecPicker(); renderRecReadingDisplay(); }
  if (name === 'invites')         { loadPastInvites(); }
  if (name === 'reading')         { renderReadingPicker(); renderReadingDisplay(); renderReadingPreview(); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = '@masonohioschools.com';
const ADMIN_EMAILS   = ['sarvin.sukhe@gmail.com', 'sarvinsukhe@gmail.com', 'daepickid540@gmail.com'];
const isEmailAllowed = email => email?.toLowerCase().endsWith(ALLOWED_DOMAIN) || ADMIN_EMAILS.includes(email?.toLowerCase());

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = '/'; return; }
  document.documentElement.style.visibility = 'visible';

  try {
    if (!isEmailAllowed(user.email)) { await signOut(auth); window.location.href = '/'; return; }

    if (!ADMIN_EMAILS.includes(user.email?.toLowerCase())) {
      try {
        const s = await getDoc(doc(db, 'admin', 'settings'));
        if (s.exists() && s.data().maintenanceMode === true) {
          await signOut(auth);
          alert('BookWare is currently under maintenance. Please check back soon.');
          window.location.href = '/';
          return;
        }
      } catch (_) {}
    }

    const userSnap = await getDoc(doc(db, 'users', user.uid));
    const userRole = userSnap.exists() ? userSnap.data().role : null;
    if (!userSnap.exists() || (userRole !== 'teacher' && userRole !== 'admin')) { await signOut(auth); window.location.href = '/'; return; }

    currentUser   = user;
    const tSnap   = await getDoc(doc(db, 'teachers', user.uid));
    if (!tSnap.exists()) { toast('Teacher record not found. Ask an admin or another teacher for an invite link.', 'danger'); return; }
    teacherData   = tSnap.data();

    populateTopBar();
    if (!sessionStorage.getItem('bw-welcomed')) {
      const first = (currentUser.displayName ?? '').split(' ')[0] || 'there';
      setTimeout(() => toast(`Welcome back, ${esc(first)} <i class='bi bi-hand-wave-fill'></i>`, 'success'), 800);
      sessionStorage.setItem('bw-welcomed', '1');
    }
    renderSettings();
    initTheme();
    initARIA(toast);
    initAriaChat('ariaChatMount', 'teacher', () => teacherData?.readingProfile);
    initAriaRecommends('ariaRecommendsMount', 'teacher', () => teacherData?.readingProfile);
    initStaySignedIn((stay) => setPersistence(auth, stay ? browserLocalPersistence : browserSessionPersistence));
    initSettingsModal();
    setupRetakeQuiz();
    setupSignout();

    // First-time reading-preferences quiz (fire-and-forget — pops up over the
    // already-loaded portal so it never blocks the rest of the page).
    maybeRunOnboardingQuiz();

    await loadRecommendations();
    await loadLibrary();
    await loadStudentCode();
    await loadCurrentlyReading();
    initVisibilityToggle();
    initApprovalToggle();
    checkBiweeklyNotification();

  } catch (err) {
    console.error('[teacher] Init failed:', err);
    toast(`Failed to load teacher portal: ${err.message ?? 'unknown error'}. Try refreshing.`, 'danger');
  }
});

function setupSignout() {
  document.getElementById('signoutBar')?.addEventListener('click', () => signOut(auth));
  const hint = document.getElementById('signoutEmail');
  if (hint && currentUser) hint.textContent = currentUser.email;
}

// ── Reading-preferences quiz (first run + retake) ─────────────────────────────
async function maybeRunOnboardingQuiz() {
  if (teacherData?.readingProfile) return; // already taken (or skipped) before
  await runQuizFlow({ isFirstRun: true });
}

async function retakeReadingQuiz() {
  await runQuizFlow({ isFirstRun: false });
}

async function runQuizFlow({ isFirstRun }) {
  try {
    const answers = await runReadingQuiz('teacher');
    const profile = answers
      ? { ...answers, completedAt: serverTimestamp() }
      : { skipped: true, skippedAt: serverTimestamp() };
    await updateDoc(doc(db, 'teachers', currentUser.uid), { readingProfile: profile });
    teacherData.readingProfile = profile;
    if (answers) {
      toast(`<i class="bi bi-stars"></i> Thanks! ARIA now knows what to recommend for you and your shelves.`, 'success');
      refreshAriaChats();
    } else if (!isFirstRun) {
      toast('No worries — you can take the quiz anytime from here.', 'info');
    }
  } catch (err) {
    console.error('[teacher] Reading quiz failed:', err);
  }
}

function setupRetakeQuiz() {
  const btn = document.getElementById('retakeQuizBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    retakeReadingQuiz().finally(() => { btn.disabled = false; });
  });
}

function populateTopBar() {
  const av     = document.getElementById('userAvatar');
  const nameEl = document.getElementById('userDisplayName');
  const display  = currentUser.displayName ?? currentUser.email ?? '?';
  const initials = display.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  if (av)     av.textContent     = initials;
  if (nameEl) nameEl.textContent = display.split(' ')[0];
}

function renderSettings() {
  const email = currentUser?.email ?? '—';
  const sub   = document.getElementById('settingsEmailSub');
  if (sub) sub.textContent = email;

  const acct = document.getElementById('accountInfoSection');
  if (acct && teacherData) {
    acct.innerHTML = `
      <div class='settings-row' style='border-top:none'>
        <div class='settings-label'>Name</div>
        <span class='muted-text small-text'>${esc(teacherData.name ?? '—')}</span>
      </div>
      <div class='settings-row'>
        <div class='settings-label'>Email</div>
        <span class='muted-text small-text'>${esc(email)}</span>
      </div>
      <div class='settings-row'>
        <div class='settings-label'>Member Since</div>
        <span class='muted-text small-text'>${fmtDate(teacherData.createdAt)}</span>
      </div>`;
  }

  const badge   = document.getElementById('canInviteSettingsBadge');
  const invChip = document.getElementById('canInviteStatus');
  if (badge)   { badge.textContent   = 'All teachers'; badge.style.color   = 'var(--success)'; }
  if (invChip) { invChip.textContent = 'All teachers can invite'; invChip.style.color = 'var(--success)'; }
}

// ── Multi-class system ────────────────────────────────────────────────────────
async function loadClasses() {
  const snap = await getDocs(collection(db, 'teachers', currentUser.uid, 'classes'));
  if (snap.empty) {
    const tSnap     = await getDoc(doc(db, 'teachers', currentUser.uid));
    const legacyCode = tSnap.data()?.inviteCode ?? genCode();
    const classRef  = await addDoc(collection(db, 'teachers', currentUser.uid, 'classes'), { name: 'Period 1', inviteCode: legacyCode, createdAt: serverTimestamp() });
    const oldRoster = await getDocs(collection(db, 'teachers', currentUser.uid, 'students'));
    for (const s of oldRoster.docs) await setDoc(doc(db, 'teachers', currentUser.uid, 'classes', classRef.id, 'students', s.id), s.data());
    allClasses = [{ id: classRef.id, name: 'Period 1', inviteCode: legacyCode, studentCount: oldRoster.size }];
  } else {
    allClasses = await Promise.all(snap.docs.map(async d => {
      const rosterSnap = await getDocs(collection(db, 'teachers', currentUser.uid, 'classes', d.id, 'students'));
      return { id: d.id, ...d.data(), studentCount: rosterSnap.size };
    }));
    allClasses.sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
  }
  renderClassManager();
}

async function loadStudentCode() { await loadClasses(); }

function renderClassManager() {
  const container = document.getElementById('classManagerContainer');
  if (!container) return;
  container.innerHTML = '';
  allClasses.forEach(cls => {
    const card = document.createElement('div');
    card.className = 'class-card';
    card.innerHTML = `
      <div class='class-card-header'>
        <div>
          <div class='class-card-name'>${esc(cls.name)}</div>
          <div class='class-card-meta'>${cls.studentCount} student${cls.studentCount !== 1 ? 's' : ''}</div>
        </div>
        <div style='display:flex;gap:6px;align-items:center'>
          <button class='btn btn--xs' data-action='rename' data-cid='${esc(cls.id)}'><i class='bi bi-pencil-fill'></i> Rename</button>
          <button class='btn btn--xs danger' data-action='delete-class' data-cid='${esc(cls.id)}' data-name='${esc(cls.name)}'><i class='bi bi-trash3-fill'></i></button>
        </div>
      </div>
      <div class='code-box'>
        <span class='code-val'>${esc(cls.inviteCode)}</span>
        <div class='code-box-btns'>
          <button class='btn btn--sm' data-action='copy-code' data-cid='${esc(cls.id)}'>Copy</button>
          <button class='btn btn--sm' data-action='refresh-code' data-cid='${esc(cls.id)}'><i class='bi bi-arrow-clockwise'></i> New</button>
        </div>
      </div>`;
    card.querySelector('[data-action="rename"]')?.addEventListener('click', () => renameClass(cls.id, cls.name));
    card.querySelector('[data-action="delete-class"]')?.addEventListener('click', () => deleteClass(cls.id, cls.name));
    card.querySelector('[data-action="copy-code"]')?.addEventListener('click', () => {
      navigator.clipboard.writeText(cls.inviteCode).then(() => toast(`<i class='bi bi-check2'></i> Code for ${esc(cls.name)} copied`, 'success'));
    });
    card.querySelector('[data-action="refresh-code"]')?.addEventListener('click', () => refreshClassCode(cls.id, cls.name));
    container.appendChild(card);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn--ghost btn--sm';
  addBtn.style.marginTop = '10px';
  addBtn.innerHTML = '<i class="bi bi-plus-lg"></i> Add Class / Period';
  addBtn.addEventListener('click', createClass);
  container.appendChild(addBtn);
}

async function createClass() {
  const name = prompt('Class name (e.g. Period 3, English 10B):')?.trim();
  if (!name) return;
  const code = genCode();
  const ref  = await addDoc(collection(db, 'teachers', currentUser.uid, 'classes'), { name, inviteCode: code, createdAt: serverTimestamp() });
  allClasses.push({ id: ref.id, name, inviteCode: code, studentCount: 0, createdAt: { seconds: Date.now() / 1000 } });
  renderClassManager();
  toast(`<i class='bi bi-check2'></i> "${esc(name)}" created — code: ${esc(code)}`, 'success');
}

async function renameClass(classId, oldName) {
  const name = prompt('New name:', oldName)?.trim();
  if (!name || name === oldName) return;
  await updateDoc(doc(db, 'teachers', currentUser.uid, 'classes', classId), { name });
  const cls = allClasses.find(c => c.id === classId);
  if (cls) cls.name = name;
  renderClassManager();
  if (document.getElementById('studentsPage')?.classList.contains('active')) loadRoster();
  toast(`<i class='bi bi-check2'></i> Renamed to "${esc(name)}"`, 'success');
}

async function refreshClassCode(classId, className) {
  const code = genCode();
  await updateDoc(doc(db, 'teachers', currentUser.uid, 'classes', classId), { inviteCode: code });
  const cls = allClasses.find(c => c.id === classId);
  if (cls) cls.inviteCode = code;
  renderClassManager();
  toast(`<i class='bi bi-check2'></i> New code for ${esc(className)} — existing students unaffected`, 'success');
}

async function deleteClass(classId, className) {
  const roster = await getDocs(collection(db, 'teachers', currentUser.uid, 'classes', classId, 'students'));
  const confirmMsg = roster.size > 0
    ? `"${className}" has ${roster.size} student${roster.size !== 1 ? 's' : ''}.\n\nDeleting removes the roster but keeps the shared library. Students can rejoin via another class code.\n\nContinue?`
    : `Delete class "${className}"? This cannot be undone.`;
  if (!confirm(confirmMsg)) return;
  for (const s of roster.docs) await deleteDoc(doc(db, 'teachers', currentUser.uid, 'classes', classId, 'students', s.id));
  await deleteDoc(doc(db, 'teachers', currentUser.uid, 'classes', classId));
  allClasses = allClasses.filter(c => c.id !== classId);
  renderClassManager();
  toast(`<i class='bi bi-check2'></i> "${esc(className)}" deleted`, 'success');
}

// ── Library visibility ────────────────────────────────────────────────────────
function initVisibilityToggle() {
  const toggle = document.getElementById('libraryPublicToggle');
  if (!toggle) return;
  const isPublic = teacherData?.libraryPublic ?? false;
  toggle.checked = isPublic;
  updateVisUI(isPublic);
  toggle.addEventListener('change', async () => {
    const nowPublic = toggle.checked;
    updateVisUI(nowPublic);
    await updateDoc(doc(db, 'teachers', currentUser.uid), { libraryPublic: nowPublic });
    toast(nowPublic
      ? `<i class='bi bi-collection-fill'></i> Library is now <strong>Public</strong>`
      : `<i class='bi bi-lock-fill'></i> Library is now <strong>Class Only</strong>`, 'success');
  });
}

async function updateVisUI(isPublic) {
  const hint   = document.getElementById('visibilityHint');
  const detail = document.getElementById('visibilityDetail');
  if (hint) hint.textContent = isPublic ? 'Public — any Mason student can discover' : 'Class Only';
  if (!detail) return;
  if (!isPublic) { detail.hidden = true; return; }
  detail.hidden = false;
  detail.innerHTML = `<span class='muted-text small-text'>Loading stats…</span>`;
  try {
    let enrolled = 0;
    for (const cls of allClasses) {
      const r = await getDocs(collection(db, 'teachers', currentUser.uid, 'classes', cls.id, 'students'));
      enrolled += r.size;
    }
    const books = allBooks.length;
    const out   = allBooks.filter(b => (b.checkedOutCount ?? 0) > 0 || b.status === 'checked_out').length;
    detail.innerHTML = `
      <div style='display:flex;gap:16px;flex-wrap:wrap;font-size:0.72rem;color:var(--text-3);padding:10px 12px;background:var(--bg-inset);border-radius:var(--r-sm)'>
        <span><strong style='color:var(--text)'>${enrolled}</strong> enrolled student${enrolled !== 1 ? 's' : ''}</span>
        <span><strong style='color:var(--text)'>${books}</strong> book${books !== 1 ? 's' : ''}</span>
        <span><strong style='color:var(--accent)'>${out}</strong> checked out</span>
      </div>
      <p class='muted-text small-text' style='margin-top:8px'><i class='bi bi-info-circle'></i> Discoverable to all Mason students — checkout still requires a class code.</p>`;
  } catch (_) {
    detail.innerHTML = `<p class='empty-state'><i class='bi bi-exclamation-triangle-fill'></i> Could not load stats.</p>`;
  }
}

// ── Checkout approval toggle ──────────────────────────────────────────────────
function initApprovalToggle() {
  const toggle = document.getElementById('requireApprovalToggle');
  if (!toggle) return;
  toggle.checked = teacherData?.requireApproval ?? false;
  toggle.addEventListener('change', async () => {
    const on = toggle.checked;
    await updateDoc(doc(db, 'teachers', currentUser.uid), { requireApproval: on });
    teacherData.requireApproval = on;
    toast(on
      ? `<i class='bi bi-hourglass-split'></i> Checkout approval <strong>enabled</strong> — students will request, you approve`
      : `<i class='bi bi-lightning-fill'></i> Checkout approval <strong>disabled</strong> — students check out instantly`,
      'success');
  });
}

// ── Pending checkout requests ─────────────────────────────────────────────────
async function loadPendingRequests() {
  const card     = document.getElementById('pendingRequestsCard');
  const listEl   = document.getElementById('pendingRequestsList');
  const countEl  = document.getElementById('pendingRequestsCount');
  if (!card || !listEl) return;

  const snap     = await getDocs(
    query(collection(db, 'teachers', currentUser.uid, 'requests'), where('status', '==', 'pending'))
  );

  if (snap.empty) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  if (countEl) countEl.textContent = `${snap.size} pending`;
  listEl.innerHTML = '';

  for (const d of snap.docs) {
    const req  = { id: d.id, ...d.data() };
    const book = allBooks.find(b => b.id === req.bookId);
    const row  = document.createElement('div');
    row.className = 'request-card';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      ${(book?.coverUrl || req.coverUrl) ? `<img src='${esc(book?.coverUrl ?? req.coverUrl)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='flex:1;min-width:0'>
        <div class='book-title'>${esc(req.bookTitle)}</div>
        <div class='book-author'>Requested by <strong>${esc(req.studentName)}</strong> · ${fmtDate(req.requestedAt)}</div>
      </div>
      <div style='display:flex;gap:6px;flex-shrink:0'>
        <button class='btn btn--xs success' data-action='approve' data-reqid='${esc(req.id)}' data-bookid='${esc(req.bookId)}' data-studentid='${esc(req.studentId)}' data-booktitle='${esc(req.bookTitle)}'>
          <i class='bi bi-check2'></i> Approve
        </button>
        <button class='btn btn--xs danger' data-action='deny' data-reqid='${esc(req.id)}'>
          <i class='bi bi-x'></i> Deny
        </button>
      </div>`;
    row.querySelector('[data-action="approve"]')?.addEventListener('click', e => {
      const { reqid, bookid, studentid, booktitle } = e.currentTarget.dataset;
      approveRequest(reqid, bookid, studentid, booktitle);
    });
    row.querySelector('[data-action="deny"]')?.addEventListener('click', e => {
      denyRequest(e.currentTarget.dataset.reqid);
    });
    listEl.appendChild(row);
  }
}

async function approveRequest(reqId, bookId, studentId, bookTitle) {
  const bookRef    = doc(db, 'teachers', currentUser.uid, 'books', bookId);
  const studentRef = doc(db, 'students', studentId);
  const reqRef     = doc(db, 'teachers', currentUser.uid, 'requests', reqId);

  try {
    const [bSnap, sSnap] = await Promise.all([getDoc(bookRef), getDoc(studentRef)]);
    if (!bSnap.exists())  { toast('Book not found.', 'danger'); return; }
    if (!sSnap.exists())  { toast('Student not found.', 'danger'); return; }
    if (sSnap.data().currentBook) { toast('Student already has a book checked out.', 'danger'); return; }

    const bData  = bSnap.data();
    const copies = bData.copies ?? 1;
    const out    = bData.checkedOutCount ?? (bData.status === 'checked_out' ? 1 : 0);
    if (out >= copies) { toast('All copies are checked out.', 'danger'); return; }

    const dueDate  = new Date();
    dueDate.setDate(dueDate.getDate() + 14);
    const newCount = out + 1;

    await Promise.all([
      updateDoc(bookRef, { checkedOutCount: newCount, status: newCount >= copies ? 'checked_out' : 'available', checkedOutBy: studentId, checkedOutAt: serverTimestamp(), dueDate: Timestamp.fromDate(dueDate) }),
      updateDoc(studentRef, { currentBook: bookId, currentBookTeacherId: currentUser.uid }),
      updateDoc(reqRef, { status: 'approved', respondedAt: serverTimestamp() }),
    ]);
    await addDoc(collection(db, 'teachers', currentUser.uid, 'history'), {
      bookId, bookTitle, author: bData.author ?? '',
      studentId, studentName: sSnap.data().name ?? '',
      dateOut: serverTimestamp(), dateReturned: null,
    });
    toast(`<i class='bi bi-check2'></i> Approved — "${esc(bookTitle)}" checked out`, 'success');
  } catch (err) {
    toast(`Approval failed: ${esc(err.message ?? 'unknown')}`, 'danger');
    return;
  }
  await loadLibrary();
  loadPendingRequests();
  if (document.getElementById('studentsPage')?.classList.contains('active')) { loadCheckedOut(); loadHistory(); }
}

async function denyRequest(reqId) {
  await updateDoc(doc(db, 'teachers', currentUser.uid, 'requests', reqId), {
    status: 'denied', respondedAt: serverTimestamp(),
  });
  toast('Request denied.', 'info');
  loadPendingRequests();
}

// ── Book search + add library ─────────────────────────────────────────────────
document.getElementById('lookupIsbnBtn')?.addEventListener('click', runBookSearch);
document.getElementById('isbnInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') runBookSearch(); });

async function runBookSearch() {
  const input    = document.getElementById('isbnInput');
  const resultEl = document.getElementById('isbnResult');
  const btn      = document.getElementById('lookupIsbnBtn');
  if (!input || !resultEl || !btn) return;
  const q = input.value.trim();
  if (!q) { resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px'>Type a title, author, or ISBN to search.</p>`; return; }
  resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px'>Searching…</p>`;
  btn.disabled = true;
  let results = [];
  try {
    const isIsbn = /^[\d\-]{9,17}$/.test(q.replace(/\s/g, ''));
    if (isIsbn) {
      const single = await lookupISBN(q);
      results = single ? [single] : [];
    } else {
      results = await searchBooks(q, 8);
    }
  } catch (err) {
    resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px;color:var(--danger)'>Search error. Check console.</p>`;
    btn.disabled = false; return;
  }
  btn.disabled = false;
  if (!results?.length) { resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px'>No results for "${esc(q)}". Try different keywords.</p>`; bookSearchResults = []; return; }
  bookSearchResults = results;
  renderBookSearchResults(results);
}

function renderBookSearchResults(results) {
  const resultEl = document.getElementById('isbnResult');
  resultEl.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'book-search-grid';
  results.forEach((book, i) => {
    const existing      = allBooks.find(b => (book.isbn && b.isbn === book.isbn) || (book.sourceId && b.sourceId === book.sourceId));
    const existingCopies = existing?.copies ?? 0;
    const card = document.createElement('div');
    card.className = 'book-search-card';
    card.innerHTML = `
      ${book.cover ? `<img src='${esc(book.cover)}' class='book-search-cover' alt='Cover' loading='lazy'>` : `<div class='book-search-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-search-info'>
        <div class='book-search-title'>${esc(book.title)}</div>
        <div class='book-search-author'>${esc(book.author)}</div>
        ${book.isbn ? `<div class='book-search-isbn'>ISBN ${esc(book.isbn)}</div>` : ''}
        ${existing ? `<div class='book-search-isbn' style='color:var(--success)'><i class='bi bi-check2'></i> In library (${existingCopies} cop${existingCopies !== 1 ? 'ies' : 'y'})</div>` : ''}
        <div class='copy-stepper'>
          <button class='btn btn--xs stepper-dec'>−</button>
          <span class='stepper-val'>1</span>
          <button class='btn btn--xs stepper-inc'>+</button>
          <button class='btn btn--primary btn--sm stepper-add' data-existing='${esc(existing?.id ?? '')}'>
            ${existing ? 'Add Copies' : 'Add to Library'}
          </button>
        </div>
      </div>`;
    let qty = 1;
    const dec    = card.querySelector('.stepper-dec');
    const inc    = card.querySelector('.stepper-inc');
    const valEl  = card.querySelector('.stepper-val');
    const addBtn = card.querySelector('.stepper-add');
    dec.addEventListener('click', () => { if (qty > 1)  { qty--; valEl.textContent = qty; } });
    inc.addEventListener('click', () => { if (qty < 20) { qty++; valEl.textContent = qty; } });
    addBtn.addEventListener('click', () => addCopiesToLibrary(i, qty, existing?.id ?? null));
    grid.appendChild(card);
  });
  resultEl.appendChild(grid);
}

async function addCopiesToLibrary(idx, qty = 1, existingDocId = null) {
  const book = bookSearchResults[idx];
  if (!book || !currentUser?.uid) return;
  try {
    if (existingDocId) {
      const existingBook    = allBooks.find(b => b.id === existingDocId);
      const currentCopies   = existingBook?.copies ?? 1;
      await updateDoc(doc(db, 'teachers', currentUser.uid, 'books', existingDocId), { copies: currentCopies + qty });
    } else {
      await addDoc(collection(db, 'teachers', currentUser.uid, 'books'), {
        title: book.title ?? '', author: book.author ?? '', isbn: book.isbn ?? '',
        coverUrl: book.cover ?? '', description: book.description ?? '',
        sourceId: book.sourceId ?? '', status: 'available',
        copies: qty, checkedOutCount: 0, checkedOutBy: null, checkedOutAt: null,
        wishlist: [], addedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    toast(`Failed to add book: ${esc(err.message ?? 'unknown')}`, 'danger'); return;
  }
  const qtyLabel = qty === 1 ? '1 copy' : `${qty} copies`;
  document.getElementById('isbnResult').innerHTML = `<p class='muted-text small-text' style='margin-top:8px;color:var(--success)'><i class='bi bi-check2'></i> ${existingDocId ? `Added ${qtyLabel} of` : 'Added'} "${esc(book.title)}" to your library.</p>`;
  document.getElementById('isbnInput').value = '';
  bookSearchResults = [];
  await loadLibrary();
  toast(`<i class='bi bi-check2'></i> "${esc(book.title)}" — ${qtyLabel} added`, 'success');
}

async function addSingleCopy(bookId, bookTitle) {
  const book = allBooks.find(b => b.id === bookId);
  if (!book) return;
  const current = book.copies ?? 1;
  await updateDoc(doc(db, 'teachers', currentUser.uid, 'books', bookId), { copies: current + 1 });
  book.copies = current + 1;
  renderLibraryList(allBooks);
  toast(`<i class='bi bi-check2'></i> "${esc(bookTitle)}" — now ${current + 1} cop${current + 1 !== 1 ? 'ies' : 'y'}`, 'success');
}

// Remove a single copy — e.g. a copy got damaged/lost.
async function removeSingleCopy(bookId, bookTitle) {
  const book = allBooks.find(b => b.id === bookId);
  if (!book) return;
  const current = book.copies ?? 1;
  const out     = book.checkedOutCount ?? (book.status === 'checked_out' ? 1 : 0);

  if (current <= 1) {
    toast(`Only one copy left — use Delete to remove "${esc(bookTitle)}" entirely.`, 'info');
    return;
  }
  if (current - 1 < out) {
    toast(`Can't reduce below the ${out} copy(ies) currently checked out. Have them returned first.`, 'danger');
    return;
  }
  if (!confirm(`Remove one copy of "${bookTitle}"?\n\n${current} → ${current - 1} copies. Use this when a copy is damaged or lost.`)) return;

  const next = current - 1;
  await updateDoc(doc(db, 'teachers', currentUser.uid, 'books', bookId), {
    copies: next,
    // keep status consistent if it was fully checked out
    status: out >= next ? 'checked_out' : 'available',
  });
  book.copies = next;
  renderLibraryList(allBooks);
  toast(`<i class='bi bi-check2'></i> "${esc(bookTitle)}" — now ${next} cop${next !== 1 ? 'ies' : 'y'}`, 'success');
}

// ── Skeleton helpers ──────────────────────────────────────────────────────────
function renderSkeletonRows(container, count = 5) {
  container.innerHTML = Array.from({ length: count }, () => `
    <div class='skeleton-book-row'>
      <div class='skeleton skeleton-book-cover'></div>
      <div class='skeleton-book-info'>
        <div class='skeleton skeleton-line-title'></div>
        <div class='skeleton skeleton-line-author'></div>
        <div class='skeleton skeleton-line-badge'></div>
      </div>
    </div>`).join('');
}

// ── Load library ──────────────────────────────────────────────────────────────
async function loadLibrary() {
  const listEl  = document.getElementById('libraryList');
  const countEl = document.getElementById('libraryCountChip');
  if (!listEl || !currentUser) return;
  renderSkeletonRows(listEl, 6);
  const snap = await getDocs(collection(db, 'teachers', currentUser.uid, 'books'));
  allBooks   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (countEl) countEl.textContent = `${allBooks.length} book${allBooks.length !== 1 ? 's' : ''}`;
  renderLibraryList(allBooks);
  renderReadingPicker();
  renderRecPicker();
}

function renderLibraryList(books) {
  const listEl = document.getElementById('libraryList');
  if (!listEl) return;
  if (books.length === 0) {
    listEl.innerHTML = `<p class='empty-state'>${allBooks.length === 0 ? 'No books yet — add one above!' : 'No matches.'}</p>`;
    return;
  }
  listEl.innerHTML = '';
  books.forEach(book => {
    const isRec   = recommendations.some(r => r.bookId === book.id);
    const copies  = book.copies ?? 1;
    const out     = book.checkedOutCount ?? (book.status === 'checked_out' ? 1 : 0);
    const avail   = copies - out;
    const badgeClass = avail > 0 ? 't-badge t-badge--available' : 't-badge t-badge--checked-out';
    const badgeTxt   = copies > 1 ? `${avail}/${copies} cop${copies !== 1 ? 'ies' : 'y'} available` : (out > 0 ? 'Checked Out' : 'Available');

    const row = document.createElement('div');
    row.className = 'book-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      ${book.coverUrl ? `<img src='${esc(book.coverUrl)}' class='book-cover' alt='Cover of ${esc(book.title)}' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'>
        <div class='book-title'>${esc(book.title)}</div>
        <div class='book-author'>${esc(book.author ?? '')}</div>
        <div style='display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px'>
          <span class='${badgeClass}'>${badgeTxt}</span>
          ${isRec ? `<span class='t-badge t-badge--recommended'><i class='bi bi-star-fill'></i> Recommended</span>` : ''}
        </div>
        <div class='book-actions'>
          <button class='btn btn--xs ${isRec ? 'starred' : ''}' data-action='${isRec ? 'unrecommend' : 'recommend'}' data-id='${esc(book.id)}' data-title='${esc(book.title)}' data-author='${esc(book.author ?? '')}' data-cover='${esc(book.coverUrl ?? '')}'>
            ${isRec ? '<i class="bi bi-star"></i> Unrecommend' : '<i class="bi bi-star-fill"></i> Recommend'}
          </button>
          ${out > 0 ? `<button class='btn btn--xs success' data-action='return' data-id='${esc(book.id)}' data-title='${esc(book.title)}'><i class='bi bi-arrow-return-left'></i> Return</button>` : ''}
          <button class='btn btn--xs' data-action='add-copy' data-id='${esc(book.id)}' data-title='${esc(book.title)}' title='Add a copy'><i class='bi bi-plus-lg'></i> Copy</button>
          ${copies > 1 ? `<button class='btn btn--xs' data-action='remove-copy' data-id='${esc(book.id)}' data-title='${esc(book.title)}' title='Remove a copy (damaged/lost)'><i class='bi bi-dash-lg'></i> Copy</button>` : ''}
          <button class='btn btn--xs danger' data-action='delete' data-id='${esc(book.id)}' data-title='${esc(book.title)}'><i class='bi bi-trash3-fill'></i> Delete</button>
        </div>
      </div>`;
    row.querySelector('[data-action="recommend"]')?.addEventListener('click',   e => { const d = e.currentTarget.dataset; toggleRecommendation(d.id, d.title, d.author, d.cover); });
    row.querySelector('[data-action="unrecommend"]')?.addEventListener('click', e => { const d = e.currentTarget.dataset; toggleRecommendation(d.id, d.title, d.author, d.cover); });
    row.querySelector('[data-action="return"]')?.addEventListener('click',      e => validateReturn(e.currentTarget.dataset.id, e.currentTarget.dataset.title));
    row.querySelector('[data-action="delete"]')?.addEventListener('click',      e => deleteBook(e.currentTarget.dataset.id, e.currentTarget.dataset.title));
    row.querySelector('[data-action="add-copy"]')?.addEventListener('click',    e => addSingleCopy(e.currentTarget.dataset.id, e.currentTarget.dataset.title));
    row.querySelector('[data-action="remove-copy"]')?.addEventListener('click', e => removeSingleCopy(e.currentTarget.dataset.id, e.currentTarget.dataset.title));
    listEl.appendChild(row);
  });
}

document.getElementById('librarySearchInput')?.addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  renderLibraryList(allBooks.filter(b => b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q) || b.isbn?.includes(q)));
});

async function deleteBook(bookId, bookTitle) {
  if (!confirm(`Permanently delete "${bookTitle}"? This cannot be undone.`)) return;
  await deleteDoc(doc(db, 'teachers', currentUser.uid, 'books', bookId));
  allBooks = allBooks.filter(b => b.id !== bookId);
  renderLibraryList(allBooks);
  const chip = document.getElementById('libraryCountChip');
  if (chip) chip.textContent = `${allBooks.length} book${allBooks.length !== 1 ? 's' : ''}`;
  toast(`<i class='bi bi-check2'></i> "${esc(bookTitle)}" deleted`, 'success');
}

async function validateReturn(bookId, bookTitle) {
  const bookRef = doc(db, 'teachers', currentUser.uid, 'books', bookId);
  const bSnap   = await getDoc(bookRef);
  const bData   = bSnap.exists() ? bSnap.data() : {};
  const newCount = Math.max(0, (bData.checkedOutCount ?? 1) - 1);

  // Find the outstanding checkout in history first — tells us which student to free.
  const q    = query(collection(db, 'teachers', currentUser.uid, 'history'), where('bookId', '==', bookId), where('dateReturned', '==', null));
  const snap = await getDocs(q);
  const histDoc   = snap.empty ? null : snap.docs[0];
  const studentId = histDoc?.data()?.studentId ?? bData.checkedOutBy ?? null;

  await updateDoc(bookRef, { checkedOutCount: newCount, status: newCount === 0 ? 'available' : 'checked_out', checkedOutBy: newCount === 0 ? null : bData.checkedOutBy, checkedOutAt: newCount === 0 ? null : bData.checkedOutAt, dueDate: newCount === 0 ? null : bData.dueDate });

  // Close the history log entry → shows "returned"
  if (histDoc) await updateDoc(histDoc.ref, { dateReturned: serverTimestamp() });

  // Clear the student's current book so they stop showing a phantom/missing book.
  // Guarded so a newer checkout by the same student isn't wiped.
  if (studentId) {
    try {
      const sRef  = doc(db, 'students', studentId);
      const sSnap = await getDoc(sRef);
      if (sSnap.exists() && sSnap.data().currentBook === bookId) {
        await updateDoc(sRef, { currentBook: null, currentBookTeacherId: null });
      }
    } catch (e) { console.warn('[teacher] could not clear student currentBook:', e?.code ?? e); }
  }

  await loadLibrary();
  if (document.getElementById('studentsPage')?.classList.contains('active')) { loadCheckedOut(); loadHistory(); }
  toast(`<i class='bi bi-check2'></i> "${esc(bookTitle)}" marked returned`, 'success');
}

// ── Students: Checked Out ─────────────────────────────────────────────────────
async function loadCheckedOut() {
  const el = document.getElementById('checkedOutList');
  if (!el) return;
  el.innerHTML = `<p class='empty-state'>Loading…</p>`;
  const checkedOut = allBooks.filter(b => b.status === 'checked_out');
  if (checkedOut.length === 0) { el.innerHTML = `<p class='empty-state'>No books currently out.</p>`; return; }
  el.innerHTML = '';
  for (const book of checkedOut) {
    let studentName = 'Unknown';
    if (book.checkedOutBy) {
      try { const s = await getDoc(doc(db, 'students', book.checkedOutBy)); if (s.exists()) studentName = s.data().name ?? studentName; } catch (_) {}
    }
    const dueDate  = book.dueDate?.toDate?.() ?? null;
    const isOverdue = dueDate && dueDate < new Date();
    const row = document.createElement('div');
    row.className = 'book-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      ${book.coverUrl ? `<img src='${esc(book.coverUrl)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'>
        <div class='book-title'>${esc(book.title)}</div>
        <div class='book-author'>${esc(book.author ?? '')}</div>
        <div style='display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px'>
          <span class='t-badge t-badge--checked-out'>${esc(studentName)} · Since ${fmtDate(book.checkedOutAt)}${isOverdue ? ` <strong style='color:var(--danger)'><i class='bi bi-exclamation-triangle-fill'></i> OVERDUE</strong>` : dueDate ? ` · Due ${fmtDate(book.dueDate)}` : ''}</span>
        </div>
        <button class='btn btn--xs success' data-action='return' data-id='${esc(book.id)}' data-title='${esc(book.title)}'><i class='bi bi-arrow-return-left'></i> Mark Returned</button>
      </div>`;
    row.querySelector('[data-action="return"]')?.addEventListener('click', e => validateReturn(e.currentTarget.dataset.id, e.currentTarget.dataset.title));
    el.appendChild(row);
  }
}

// ── Students: History (real-time) ─────────────────────────────────────────────
function loadHistory() {
  const el = document.getElementById('historyList');
  if (!el) return;
  if (historyUnsubscribe) { historyUnsubscribe(); historyUnsubscribe = null; }
  el.innerHTML = `<p class='empty-state'>Loading…</p>`;
  historyUnsubscribe = onSnapshot(collection(db, 'teachers', currentUser.uid, 'history'), snap => {
    if (snap.empty) { el.innerHTML = `<p class='empty-state'>No history yet.</p>`; return; }
    const entries = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
    el.innerHTML = '';
    entries.forEach(e => {
      const row = document.createElement('div');
      row.className = 'book-row';
      row.setAttribute('role', 'listitem');
      row.innerHTML = `
        <div class='book-info'>
          <div class='book-title'>${esc(e.bookTitle)}</div>
          <div class='book-author'>${esc(e.studentName)}</div>
          <div style='display:flex;gap:5px;flex-wrap:wrap;margin-top:4px'>
            <span class='t-badge t-badge--available'>Out: ${fmtDate(e.dateOut)}</span>
            ${e.dateReturned ? `<span class='t-badge t-badge--available'>Back: ${fmtDate(e.dateReturned)}</span>` : `<span class='t-badge t-badge--checked-out'>Still out</span>`}
          </div>
        </div>`;
      el.appendChild(row);
    });
  }, err => { console.error('[teacher] History listener:', err); el.innerHTML = `<p class='empty-state'>Could not load history.</p>`; });
}

// ── Export .MD ────────────────────────────────────────────────────────────────
document.getElementById('exportCheckoutsMdBtn')?.addEventListener('click', async () => {
  const histSnap = await getDocs(collection(db, 'teachers', currentUser.uid, 'history'));
  const entries  = histSnap.docs.map(d => d.data()).sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
  const tName    = teacherData?.name ?? 'Teacher';
  let md = `# BookWare — Checkout Report\n\n**Teacher:** ${tName}  \n**Generated:** ${new Date().toLocaleString()}  \n\n---\n\n`;
  const active = allBooks.filter(b => b.status === 'checked_out');
  md += `## Currently Checked Out\n\n`;
  if (active.length === 0) { md += `*No books currently checked out.*\n\n`; }
  else {
    md += `| Book | Author | Student | Date Out |\n|------|--------|---------|----------|\n`;
    for (const book of active) {
      const e = entries.find(x => x.bookId === book.id && !x.dateReturned);
      md += `| ${book.title} | ${book.author ?? '—'} | ${e?.studentName ?? '—'} | ${fmtDate(e?.dateOut ?? null)} |\n`;
    }
    md += '\n';
  }
  md += `## Full History\n\n`;
  if (entries.length === 0) { md += `*No history yet.*\n`; }
  else {
    md += `| Book | Author | Student | Date Out | Date Returned |\n|------|--------|---------|----------|---------------|\n`;
    entries.forEach(e => { md += `| ${e.bookTitle} | ${e.author ?? '—'} | ${e.studentName} | ${fmtDate(e.dateOut)} | ${e.dateReturned ? fmtDate(e.dateReturned) : 'Not yet returned'} |\n`; });
  }
  md += `\n---\n*Generated by BookWare · Mason High School*\n`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `${tName.replace(/\s+/g, '_')}_checkouts_${Date.now()}.md` });
  a.click(); URL.revokeObjectURL(a.href);
  toast(`<i class='bi bi-check2'></i> Exported as .MD`, 'success');
});

// ── Export CSV ────────────────────────────────────────────────────────────────
document.getElementById('exportCheckoutsCsvBtn')?.addEventListener('click', async () => {
  const histSnap = await getDocs(collection(db, 'teachers', currentUser.uid, 'history'));
  const entries  = histSnap.docs.map(d => d.data()).sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
  const tName    = teacherData?.name ?? 'Teacher';
  const rows     = [['Book Title','Author','Student','Date Out','Due Date','Date Returned','Status']];
  const now      = new Date();
  entries.forEach(e => {
    const dueDate   = e.dueDate ? (e.dueDate.toDate ? e.dueDate.toDate() : new Date(e.dueDate)) : null;
    const isOverdue = !e.dateReturned && dueDate && dueDate < now;
    rows.push([
      e.bookTitle ?? '',
      e.author ?? '',
      e.studentName ?? '',
      fmtDate(e.dateOut),
      dueDate ? dueDate.toLocaleDateString() : '',
      e.dateReturned ? fmtDate(e.dateReturned) : '',
      e.dateReturned ? 'Returned' : isOverdue ? 'Overdue' : 'Active',
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a   = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `${(tName).replace(/\s+/g, '_')}_checkouts_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click(); URL.revokeObjectURL(a.href);
  toast(`<i class='bi bi-check2'></i> Exported as .CSV`, 'success');
});

// ── Export PDF (clean red/gray theme, baked-in & non-editable) ─────────────────
document.getElementById('exportCheckoutsPdfBtn')?.addEventListener('click', async (ev) => {
  const btn  = ev.currentTarget;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class='bi bi-hourglass-split'></i> Building…`;
  try {
    // Lazy-load jsPDF + autotable only when actually exporting
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm');
    const atMod     = (await import('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/+esm')).default;
    const autoTable = typeof atMod === 'function' ? atMod : atMod.default;

    const histSnap = await getDocs(collection(db, 'teachers', currentUser.uid, 'history'));
    const entries  = histSnap.docs.map(d => d.data()).sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
    const tName    = teacherData?.name ?? 'Teacher';
    const recSet   = new Set(recommendations.map(r => r.bookId));
    const now      = new Date();

    // Locked theme — these colours are written into the file and can't be changed after export
    const RED   = [231, 76, 60];
    const GRAY  = [110, 110, 128];
    const DARK  = [40, 40, 46];
    const ALT   = [244, 244, 247];

    const doc    = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageW  = doc.internal.pageSize.getWidth();
    const margin = 40;

    // Header band
    doc.setFillColor(...RED);
    doc.rect(0, 0, pageW, 68, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');  doc.setFontSize(20);
    doc.text('BookWare', margin, 32);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(12);
    doc.text('Checkout Report', margin, 50);

    // Subheader
    doc.setTextColor(...GRAY); doc.setFontSize(10);
    doc.text(`Teacher: ${tName}`, margin, 88);
    doc.text(`Generated: ${now.toLocaleString()}`, margin, 102);
    doc.setDrawColor(...RED); doc.setLineWidth(1.5);
    doc.line(margin, 112, pageW - margin, 112);

    // Font-independent vector check mark centred in a cell
    const drawTick = (cell) => {
      const cx = cell.x + cell.width / 2, cy = cell.y + cell.height / 2;
      doc.setDrawColor(...RED); doc.setLineWidth(1.4);
      doc.line(cx - 4, cy + 0.5, cx - 1, cy + 3.5);
      doc.line(cx - 1, cy + 3.5, cx + 4.5, cy - 3.5);
    };

    const headStyles = { fillColor: RED, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 };
    const bodyStyles = { textColor: DARK, fontSize: 9, cellPadding: 5 };
    const altRows    = { fillColor: ALT };

    // ── Currently checked out ──
    const active = allBooks.filter(b => b.status === 'checked_out');
    const activeRows = active.map(book => {
      const e = entries.find(x => x.bookId === book.id && !x.dateReturned);
      return { title: book.title ?? '—', author: book.author ?? '—', student: e?.studentName ?? '—', out: fmtDate(e?.dateOut ?? null), rec: recSet.has(book.id) };
    });
    doc.setTextColor(...DARK); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text('Currently Checked Out', margin, 138);
    autoTable(doc, {
      startY: 148, margin: { left: margin, right: margin },
      head: [['Book', 'Author', 'Student', 'Date Out', 'Rec.']],
      body: activeRows.length ? activeRows.map(r => [r.title, r.author, r.student, r.out, '']) : [['No books currently checked out.', '', '', '', '']],
      headStyles, bodyStyles, alternateRowStyles: altRows,
      columnStyles: { 4: { halign: 'center', cellWidth: 34 } },
      didDrawCell: (d) => { if (d.section === 'body' && d.column.index === 4 && activeRows[d.row.index]?.rec) drawTick(d.cell); },
    });

    // ── Full history ──
    const histRows = entries.map(e => ({ title: e.bookTitle ?? '—', author: e.author ?? '—', student: e.studentName ?? '—', out: fmtDate(e.dateOut), back: e.dateReturned ? fmtDate(e.dateReturned) : 'Not yet returned', rec: recSet.has(e.bookId) }));
    const y2 = (doc.lastAutoTable?.finalY ?? 160) + 24;
    doc.setTextColor(...DARK); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text('Full History', margin, y2);
    autoTable(doc, {
      startY: y2 + 10, margin: { left: margin, right: margin },
      head: [['Book', 'Author', 'Student', 'Out', 'Returned', 'Rec.']],
      body: histRows.length ? histRows.map(r => [r.title, r.author, r.student, r.out, r.back, '']) : [['No history yet.', '', '', '', '', '']],
      headStyles, bodyStyles, alternateRowStyles: altRows,
      columnStyles: { 5: { halign: 'center', cellWidth: 34 } },
      didDrawCell: (d) => { if (d.section === 'body' && d.column.index === 5 && histRows[d.row.index]?.rec) drawTick(d.cell); },
    });

    // ── Footer with page numbers + recommended legend ──
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      const h = doc.internal.pageSize.getHeight();
      doc.setDrawColor(...GRAY); doc.setLineWidth(0.5);
      doc.line(margin, h - 36, pageW - margin, h - 36);
      // legend tick
      doc.setDrawColor(...RED); doc.setLineWidth(1.2);
      doc.line(margin, h - 24, margin + 3, h - 21);
      doc.line(margin + 3, h - 21, margin + 8, h - 27);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GRAY);
      doc.text('= recommended title', margin + 13, h - 22);
      doc.text('Generated by BookWare · Mason High School', margin, h - 10);
      doc.text(`Page ${i} of ${pages}`, pageW - margin, h - 10, { align: 'right' });
    }

    doc.save(`${tName.replace(/\s+/g, '_')}_checkouts_${now.toISOString().slice(0, 10)}.pdf`);
    toast(`<i class='bi bi-check2'></i> Exported as .PDF`, 'success');
  } catch (err) {
    console.error('[teacher] PDF export failed:', err);
    toast(`PDF export failed: ${esc(err.message ?? 'unknown')}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
});

// ── Class Roster ──────────────────────────────────────────────────────────────
async function loadRoster() {
  const listEl  = document.getElementById('rosterList');
  const countEl = document.getElementById('rosterCount');
  if (!listEl || !currentUser) return;
  listEl.innerHTML = `<p class='empty-state'>Loading roster…</p>`;
  try {
    if (allClasses.length === 0) await loadClasses();
    let totalStudents = 0;
    listEl.innerHTML  = '';
    for (const cls of allClasses) {
      const snap     = await getDocs(collection(db, 'teachers', currentUser.uid, 'classes', cls.id, 'students'));
      const students = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
      totalStudents  += students.length;
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;padding-bottom:6px;border-bottom:1px solid var(--border)';
      header.innerHTML = `<div class='settings-label' style='margin:0'>${esc(cls.name)}</div><span class='muted-text small-text'>${students.length} student${students.length !== 1 ? 's' : ''} · Code: <code style='font-size:0.65rem'>${esc(cls.inviteCode)}</code></span>`;
      listEl.appendChild(header);
      if (students.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state'; empty.style.marginBottom = '6px';
        empty.textContent = 'No students yet — share the code above.';
        listEl.appendChild(empty); continue;
      }
      students.forEach(s => {
        const row = document.createElement('div');
        row.className = 'book-row';
        row.setAttribute('role', 'listitem');
        row.innerHTML = `
          <div class='book-cover-ph' style='width:32px;height:32px;border-radius:50%;font-size:0.6rem;font-weight:700'>${esc((s.name ?? '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase())}</div>
          <div class='book-info' style='display:flex;align-items:center;gap:8px'>
            <div style='flex:1;min-width:0'>
              <div class='book-title'>${esc(s.name ?? 'Unknown')}</div>
              <div class='book-author'>${esc(s.email ?? '')}</div>
            </div>
            <button class='btn btn--xs danger' data-sid='${esc(s.id)}' data-cid='${esc(cls.id)}' data-name='${esc(s.name ?? '')}'>Remove</button>
          </div>`;
        row.querySelector('button')?.addEventListener('click', e => removeStudent(e.currentTarget.dataset.sid, e.currentTarget.dataset.name, e.currentTarget.dataset.cid));
        listEl.appendChild(row);
      });
    }
    if (countEl) countEl.textContent = `${totalStudents} student${totalStudents !== 1 ? 's' : ''} total`;
    if (totalStudents === 0 && allClasses.length === 0) listEl.innerHTML = `<p class='empty-state'>No classes yet. Add one above.</p>`;
  } catch (err) {
    console.error('[teacher] loadRoster failed:', err);
    listEl.innerHTML = `<p class='empty-state' style='color:var(--danger)'>Failed to load roster: ${esc(err.message ?? '')}</p>`;
  }
}

async function removeStudent(sid, name, classId) {
  if (!confirm(`Remove ${name || 'this student'} from class?\n\nThey can rejoin with the class code.`)) return;
  try {
    await deleteDoc(doc(db, 'teachers', currentUser.uid, 'classes', classId, 'students', sid));
    const otherClasses = allClasses.filter(c => c.id !== classId);
    let stillIn = false;
    for (const c of otherClasses) {
      const s = await getDoc(doc(db, 'teachers', currentUser.uid, 'classes', c.id, 'students', sid));
      if (s.exists()) { stillIn = true; break; }
    }
    if (!stillIn) {
      try { await updateDoc(doc(db, 'students', sid), { addedTeachers: arrayRemove(currentUser.uid) }); } catch (_) {}
    }
    toast(`Removed ${esc(name)} from class`, 'success');
    loadRoster();
  } catch (err) {
    toast(`Failed: ${esc(String(err.message ?? err))}`, 'danger');
  }
}

// ── Bans ──────────────────────────────────────────────────────────────────────
document.getElementById('issueBanBtn')?.addEventListener('click', async () => {
  const email  = document.getElementById('banStudentEmail')?.value.trim();
  const days   = parseInt(document.getElementById('banDays')?.value);
  const reason = document.getElementById('banReason')?.value.trim();
  if (!email || !days || !reason) { toast('Fill in email, days, and reason.', 'danger'); return; }
  const snap = await getDocs(query(collection(db, 'users'), where('email', '==', email)));
  if (snap.empty) { toast('Student not found with that email.', 'danger'); return; }
  const studentDoc = snap.docs[0];
  const banExpiry  = Timestamp.fromDate(new Date(Date.now() + days * 86400000));
  await updateDoc(doc(db, 'users', studentDoc.id), { banned: true, banExpiry, banReason: reason, bannedBy: currentUser.uid, bannedAt: serverTimestamp() });
  document.getElementById('banStudentEmail').value = '';
  document.getElementById('banDays').value         = '';
  document.getElementById('banReason').value       = '';
  toast(`<i class='bi bi-exclamation-triangle-fill'></i> ${esc(email)} banned for ${days} day${days !== 1 ? 's' : ''}`, 'success');
  loadActiveBans();
});

async function loadActiveBans() {
  const el = document.getElementById('activeBansList');
  if (!el) return;
  const snap = await getDocs(query(collection(db, 'users'), where('bannedBy', '==', currentUser.uid), where('banned', '==', true)));
  if (snap.empty) { el.innerHTML = `<p class='muted-text small-text'>No active bans.</p>`; return; }
  el.innerHTML = '';
  snap.docs.forEach(d => {
    const u   = d.data();
    const row = document.createElement('div');
    row.className = 'ban-item';
    row.innerHTML = `
      <div>
        <div class='ban-name'>${esc(u.name ?? u.email)}</div>
        <div class='ban-meta'>${esc(u.email)} · Expires ${fmtDate(u.banExpiry)}</div>
        <div class='ban-reason'>Reason: ${esc(u.banReason)}</div>
      </div>
      <button class='btn btn--xs success' data-uid='${esc(d.id)}' data-name='${esc(u.name ?? u.email)}'>Lift Ban</button>`;
    row.querySelector('button')?.addEventListener('click', async (e) => {
      const { uid, name } = e.currentTarget.dataset;
      await updateDoc(doc(db, 'users', uid), { banned: false, banExpiry: null, banReason: null, bannedBy: null });
      toast(`<i class='bi bi-check2'></i> Ban lifted for ${esc(name)}`, 'success');
      loadActiveBans();
    });
    el.appendChild(row);
  });
}

// ── Recommendations ───────────────────────────────────────────────────────────
async function loadRecommendations() {
  const snap = await getDocs(collection(db, 'teachers', currentUser.uid, 'recommendations'));
  recommendations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function toggleRecommendation(bookId, bookTitle, author = '', coverUrl = '') {
  const existing = recommendations.find(r => r.bookId === bookId);
  if (existing) {
    await deleteDoc(doc(db, 'teachers', currentUser.uid, 'recommendations', existing.id));
    recommendations = recommendations.filter(r => r.bookId !== bookId);
    toast(`<i class='bi bi-star'></i> "${esc(bookTitle)}" unrecommended`, 'info');
  } else {
    const ref = await addDoc(collection(db, 'teachers', currentUser.uid, 'recommendations'), { bookId, bookTitle, author, coverUrl, createdAt: serverTimestamp() });
    recommendations.push({ id: ref.id, bookId, bookTitle, author, coverUrl });
    toast(`<i class='bi bi-star-fill'></i> "${esc(bookTitle)}" recommended`, 'success');
  }
  renderLibraryList(allBooks);
  if (document.getElementById('recommendationsPage')?.classList.contains('active')) { renderRecommendationsList(); renderRecPicker(); }
}

function renderRecommendationsList() {
  const el = document.getElementById('recommendationsList');
  if (!el) return;
  if (recommendations.length === 0) { el.innerHTML = `<p class='empty-state'>No recommendations yet. Search the right panel to add books.</p>`; return; }
  el.innerHTML = '';
  recommendations.forEach(rec => {
    const book    = allBooks.find(b => b.id === rec.bookId);
    const coverUrl = rec.coverUrl || book?.coverUrl || '';
    const author  = rec.author   || book?.author   || '';
    const row = document.createElement('div');
    row.className = 'book-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      ${coverUrl ? `<img src='${esc(coverUrl)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'>${esc(rec.bookTitle)}</div>
          ${author ? `<div class='book-author'>${esc(author)}</div>` : ''}
        </div>
        <button class='btn btn--xs danger' data-id='${esc(rec.bookId)}' data-title='${esc(rec.bookTitle)}'><i class='bi bi-star'></i> Remove</button>
      </div>`;
    row.querySelector('button')?.addEventListener('click', e => toggleRecommendation(e.currentTarget.dataset.id, e.currentTarget.dataset.title));
    el.appendChild(row);
  });
}

function renderRecPicker() {
  const el = document.getElementById('recPickerList');
  const q  = (document.getElementById('recSearchInput')?.value ?? '').toLowerCase();
  if (!el) return;
  const filtered = allBooks.filter(b => !q || b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q));
  el.innerHTML = '';

  if (filtered.length > 0) {
    if (q && recGoogleResults.length > 0) {
      const hdr = document.createElement('p');
      hdr.className = 'muted-text small-text'; hdr.style.marginBottom = '6px';
      hdr.textContent = 'Your Library:';
      el.appendChild(hdr);
    }
    filtered.forEach(book => {
      const isRec = recommendations.some(r => r.bookId === book.id);
      const row   = document.createElement('div');
      row.className = 'book-row';
      row.innerHTML = `
        ${book.coverUrl ? `<img src='${esc(book.coverUrl)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
        <div class='book-info' style='display:flex;align-items:center;justify-content:space-between;gap:10px'>
          <div style='min-width:0'><div class='book-title'>${esc(book.title)}</div><div class='book-author'>${esc(book.author ?? '')}</div></div>
          <button class='btn btn--xs ${isRec ? 'starred' : ''}' data-action='${isRec ? 'unrecommend' : 'recommend'}' data-id='${esc(book.id)}' data-title='${esc(book.title)}' data-author='${esc(book.author ?? '')}' data-cover='${esc(book.coverUrl ?? '')}' style='flex-shrink:0'>
            ${isRec ? '<i class="bi bi-star-fill"></i> Starred' : '<i class="bi bi-star"></i> Star'}
          </button>
        </div>`;
      row.querySelector('button')?.addEventListener('click', e => { const d = e.currentTarget.dataset; toggleRecommendation(d.id, d.title, d.author, d.cover); });
      el.appendChild(row);
    });
  }

  if (recGoogleResults.length > 0) {
    const gHdr = document.createElement('p');
    gHdr.className = 'muted-text small-text'; gHdr.style.margin = '10px 0 6px';
    gHdr.textContent = 'From Google Books:';
    el.appendChild(gHdr);
    recGoogleResults.forEach(book => {
      const isRec = recommendations.some(r => r.bookId === book.sourceId);
      const row   = document.createElement('div');
      row.className = 'book-row';
      row.innerHTML = `
        ${book.cover ? `<img src='${esc(book.cover)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
        <div class='book-info' style='display:flex;align-items:center;justify-content:space-between;gap:10px'>
          <div style='min-width:0'><div class='book-title'>${esc(book.title)}</div><div class='book-author'>${esc(book.author ?? '')}</div></div>
          <button class='btn btn--xs ${isRec ? 'starred' : ''}' data-action='${isRec ? 'unrecommend' : 'recommend'}' data-id='${esc(book.sourceId)}' data-title='${esc(book.title)}' data-author='${esc(book.author ?? '')}' data-cover='${esc(book.cover ?? '')}' style='flex-shrink:0'>
            ${isRec ? '<i class="bi bi-star-fill"></i> Starred' : '<i class="bi bi-star"></i> Star'}
          </button>
        </div>`;
      row.querySelector('button')?.addEventListener('click', e => { const d = e.currentTarget.dataset; toggleRecommendation(d.id, d.title, d.author, d.cover); });
      el.appendChild(row);
    });
  }

  if (filtered.length === 0 && recGoogleResults.length === 0) {
    el.innerHTML = `<p class='empty-state'>${allBooks.length === 0 ? 'No books in library yet.' : q ? 'Searching Google Books…' : 'No matches.'}</p>`;
  }
}

document.getElementById('recSearchInput')?.addEventListener('input', () => {
  clearTimeout(recGoogleDebounce);
  renderRecPicker();
  const q = document.getElementById('recSearchInput')?.value.trim();
  if (q && q.length >= 2) {
    recGoogleDebounce = setTimeout(async () => {
      const results   = await searchBooks(q, 6);
      recGoogleResults = results.filter(b => !allBooks.some(lb => lb.title?.toLowerCase() === b.title?.toLowerCase()));
      renderRecPicker();
    }, 600);
  } else { recGoogleResults = []; }
});

// ── Now Reading ───────────────────────────────────────────────────────────────
async function loadCurrentlyReading() {
  const snap = await getDoc(doc(db, 'teachers', currentUser.uid));
  currentUser._reading = snap.exists() ? snap.data().currentlyReading ?? null : null;
  renderReadingDisplay();
  renderReadingPreview();
  renderRecReadingDisplay();
}

function renderReadingPicker() {
  const listEl = document.getElementById('readingPickerList');
  if (!listEl) return;
  listEl.innerHTML = '';
  const toShow = readingSearchResults.length > 0
    ? readingSearchResults
    : allBooks.map(b => ({ isLibrary: true, bookId: b.id, title: b.title, author: b.author, cover: b.coverUrl ?? '', isbn: b.isbn ?? '' }));
  if (toShow.length === 0) { listEl.innerHTML = `<p class='empty-state'>No books in your library yet. Search for one above.</p>`; return; }
  toShow.forEach((book, i) => {
    const row = document.createElement('div');
    row.className = 'book-row';
    row.innerHTML = `
      ${book.cover ? `<img src='${esc(book.cover)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'><div class='book-title'>${esc(book.title)}</div><div class='book-author'>${esc(book.author ?? '')}</div></div>
        <button class='btn btn--xs success' data-idx='${i}' data-is-library='${book.isLibrary ? '1' : '0'}'><i class='bi bi-book-fill'></i> Set as Reading</button>
      </div>`;
    row.querySelector('button')?.addEventListener('click', e => setReading(parseInt(e.currentTarget.dataset.idx), e.currentTarget.dataset.isLibrary === '1'));
    listEl.appendChild(row);
  });
}

async function runReadingSearch() {
  const q   = document.getElementById('readingSearchInput')?.value.trim();
  const btn = document.getElementById('readingSearchBtn');
  if (!q) { readingSearchResults = []; renderReadingPicker(); return; }
  if (btn) btn.disabled = true;
  readingSearchResults = (await searchBooks(q, 6)).map(b => ({ ...b, cover: b.cover, isLibrary: false }));
  if (btn) btn.disabled = false;
  renderReadingPicker();
}

document.getElementById('readingSearchBtn')?.addEventListener('click', runReadingSearch);
document.getElementById('readingSearchInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') runReadingSearch(); });

async function setReading(idx, isLibrary) {
  const toShow = readingSearchResults.length > 0
    ? readingSearchResults
    : allBooks.map(b => ({ isLibrary: true, bookId: b.id, title: b.title, author: b.author, cover: b.coverUrl ?? '' }));
  const book = toShow[idx];
  if (!book) return;
  const reading = { title: book.title, author: book.author ?? '', coverUrl: book.cover ?? '' };
  if (isLibrary && book.bookId) reading.bookId = book.bookId;
  await updateDoc(doc(db, 'teachers', currentUser.uid), { currentlyReading: reading });
  currentUser._reading = reading;
  renderReadingDisplay(); renderReadingPreview(); renderRecReadingDisplay();
  toast(`<i class='bi bi-book-fill'></i> Now reading: "${esc(book.title)}"`, 'success');
}

function renderReadingDisplay() {
  const el = document.getElementById('currentlyReadingDisplay');
  if (!el) return;
  const r = currentUser._reading;
  if (!r) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class='book-row' style='margin-top:10px'>
      ${r.coverUrl ? `<img src='${esc(r.coverUrl)}' class='book-cover' style='border-color:var(--accent)' alt=''>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'><div class='book-title'>${esc(r.title)}</div><div class='book-author'>${esc(r.author)}</div></div>
    </div>`;
}

function renderReadingPreview() {
  const el = document.getElementById('readingPreview');
  if (!el) return;
  const r = currentUser._reading;
  if (!r) { el.innerHTML = `<p class='empty-state'>Nothing set yet.</p>`; return; }
  el.innerHTML = `
    <p class='muted-text small-text' style='margin-bottom:10px'>Students see this on the Library page:</p>
    <div class='book-row'>
      ${r.coverUrl ? `<img src='${esc(r.coverUrl)}' class='book-cover' style='border-color:var(--accent)' alt=''>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'><div class='book-title'>${esc(r.title)}</div><div class='book-author'>${esc(r.author)}</div></div>
    </div>`;
}

async function clearCurrentlyReading() {
  await updateDoc(doc(db, 'teachers', currentUser.uid), { currentlyReading: null });
  currentUser._reading = null;
  renderReadingDisplay(); renderReadingPreview(); renderRecReadingDisplay();
  toast('Currently reading cleared.', 'info');
}

document.getElementById('clearCurrentlyReadingBtn')?.addEventListener('click', clearCurrentlyReading);

function renderRecReadingDisplay() {
  const el = document.getElementById('recReadingDisplay');
  if (!el) return;
  const r = currentUser._reading;
  if (!r) { el.innerHTML = `<p class='empty-state'>Nothing set yet.</p>`; return; }
  el.innerHTML = `
    <div class='book-row'>
      ${r.coverUrl ? `<img src='${esc(r.coverUrl)}' class='book-cover' alt=''>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'><div class='book-title'>${esc(r.title)}</div><div class='book-author'>${esc(r.author)}</div></div>
    </div>`;
}

let recReadingDebounce = null;

async function runRecReadingSearch() {
  const q   = document.getElementById('recReadingInput')?.value.trim();
  const btn = document.getElementById('recReadingSearchBtn');
  if (!q) return;
  if (btn) btn.disabled = true;
  const results = (await searchBooks(q, 6)).map(b => ({ ...b, cover: b.cover, isLibrary: false }));
  if (btn) btn.disabled = false;
  const listEl = document.getElementById('recReadingResults');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!results.length) { listEl.innerHTML = `<p class='empty-state'>No results.</p>`; return; }
  results.forEach((book, i) => {
    const row = document.createElement('div');
    row.className = 'book-row';
    row.innerHTML = `
      ${book.cover ? `<img src='${esc(book.cover)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'><div class='book-title'>${esc(book.title)}</div><div class='book-author'>${esc(book.author ?? '')}</div></div>
        <button class='btn btn--xs success' data-idx='${i}'><i class='bi bi-book-fill'></i> Set</button>
      </div>`;
    row.querySelector('button')?.addEventListener('click', async (e) => {
      const b = results[parseInt(e.currentTarget.dataset.idx)];
      const reading = { title: b.title, author: b.author ?? '', coverUrl: b.cover ?? '' };
      await updateDoc(doc(db, 'teachers', currentUser.uid), { currentlyReading: reading });
      currentUser._reading = reading;
      renderReadingDisplay(); renderReadingPreview(); renderRecReadingDisplay();
      toast(`<i class='bi bi-book-fill'></i> Now reading: "${esc(b.title)}"`, 'success');
      listEl.innerHTML = '';
    });
    listEl.appendChild(row);
  });
}

document.getElementById('recReadingSearchBtn')?.addEventListener('click', runRecReadingSearch);
document.getElementById('recReadingInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') runRecReadingSearch(); });
document.getElementById('recClearReadingBtn')?.addEventListener('click', clearCurrentlyReading);

// ── Invite Teachers ───────────────────────────────────────────────────────────
// Stores the last generated invite link for email-share button
let _lastInviteLink = '';
let _lastInviteEmail = '';

document.getElementById('createInviteBtn')?.addEventListener('click', async () => {
  const emailInput   = document.getElementById('inviteEmailInput');
  const output       = document.getElementById('inviteOutput');
  const qrContainer  = document.getElementById('inviteQrContainer');
  const qrImg        = document.getElementById('inviteQrImg');
  const emailBtn     = document.getElementById('emailInviteBtn');
  const email        = emailInput?.value.trim().toLowerCase();
  if (!email || !email.includes('@')) { toast('Enter a valid email address.', 'danger'); return; }

  const expiresAt = new Date(Date.now() + 7 * 86400000);
  try {
    const ref = await addDoc(collection(db, 'invites'), {
      recipientEmail: email,
      used:           false,
      revoked:        false,
      expiresAt:      Timestamp.fromDate(expiresAt),
      createdBy:      currentUser.uid,
      createdByName:  teacherData?.name ?? currentUser.displayName ?? 'Teacher',
      createdByRole:  'teacher',
      createdAt:      serverTimestamp(),
    });
    const link = `${window.location.origin}/teacher-signup.html?token=${ref.id}`;
    _lastInviteLink  = link;
    _lastInviteEmail = email;

    await navigator.clipboard.writeText(link).catch(() => {});
    if (output) output.innerHTML = `
      <div class='invite-link-box'>${esc(link)}</div>
      <p class='muted-text small-text' style='margin-top:8px'>
        <i class='bi bi-check2'></i> Link copied! Valid 7 days — locked to ${esc(email)}
      </p>`;

    // Show QR code via Google Charts API
    if (qrImg && qrContainer) {
      const qrUrl = `https://chart.googleapis.com/chart?chs=240x240&cht=qr&chl=${encodeURIComponent(link)}&choe=UTF-8`;
      qrImg.src       = qrUrl;
      qrImg.alt       = 'QR code for invite link';
      qrContainer.hidden = false;
    }

    // Show email share button
    if (emailBtn) emailBtn.hidden = false;

    if (emailInput) emailInput.value = '';
    toast(`<i class='bi bi-check2'></i> Invite link created &amp; copied`, 'success');
    loadPastInvites();
  } catch (err) {
    toast(`Failed to create invite: ${esc(err.message ?? 'unknown')}`, 'danger');
  }
});

// Email share button
document.getElementById('emailInviteBtn')?.addEventListener('click', () => {
  if (!_lastInviteLink) return;
  const tName   = teacherData?.name ?? 'a teacher';
  const subject = encodeURIComponent('You\'ve been invited to BookWare');
  const body    = encodeURIComponent(
    `Hi,\n\nYou've been invited to join BookWare as a teacher at Mason High School.\n\n` +
    `Click the link below to create your account:\n${_lastInviteLink}\n\n` +
    `This invite is locked to ${_lastInviteEmail} and expires in 7 days.\n\n— ${tName}`
  );
  window.open(`mailto:${_lastInviteEmail}?subject=${subject}&body=${body}`);
  toast(`<i class='bi bi-envelope-fill'></i> Opening email client…`, 'info');
});

async function loadPastInvites() {
  const el = document.getElementById('pastInvitesList');
  if (!el) return;
  el.innerHTML = `<p class='empty-state'>Loading…</p>`;
  try {
    const snap = await getDocs(query(collection(db, 'invites'), where('createdBy', '==', currentUser.uid)));
    if (snap.empty) { el.innerHTML = `<p class='empty-state'>No invites sent yet.</p>`; return; }
    const now     = new Date();
    const invites = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
      const aActive = !a.used && !a.revoked && a.expiresAt?.toDate?.() > now;
      const bActive = !b.used && !b.revoked && b.expiresAt?.toDate?.() > now;
      if (aActive !== bActive) return bActive ? 1 : -1;
      return (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0);
    });
    el.innerHTML = '';
    invites.forEach(inv => {
      const expDate  = inv.expiresAt?.toDate?.();
      const expired  = expDate && expDate < now;
      const isActive = !inv.used && !inv.revoked && !expired;
      const link     = `${window.location.origin}/teacher-signup.html?token=${inv.id}`;

      const statusBadge = inv.used
        ? `<span class='t-badge'>Used</span>`
        : inv.revoked
        ? `<span class='t-badge' style='color:var(--danger)'>Revoked</span>`
        : expired
        ? `<span class='t-badge' style='opacity:0.5'>Expired</span>`
        : `<span class='t-badge t-badge--available'>Active · Expires ${fmtDate(inv.expiresAt)}</span>`;

      const row = document.createElement('div');
      row.className = 'book-row';
      row.innerHTML = `
        <div class='book-info' style='flex:1;min-width:0'>
          <div class='book-title'>${esc(inv.recipientEmail || 'Open invite')}</div>
          <div style='display:flex;gap:6px;flex-wrap:wrap;margin-top:4px'>${statusBadge}</div>
          <div class='teacher-invite-qr' hidden style='margin-top:10px'>
            <img src='' alt='QR code'
                 style='width:120px;height:120px;background:#fff;padding:5px;border-radius:7px;display:block'>
            <p class='muted-text small-text' style='margin-top:4px'>Scan to open invite</p>
          </div>
        </div>
        <div style='display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap'>
          ${isActive ? `
            <button class='btn btn--ghost btn--sm' data-action='copy' data-link='${esc(link)}'
                    title='Copy link' aria-label='Copy invite link'><i class='bi bi-clipboard'></i></button>
            <button class='btn btn--ghost btn--sm' data-action='qr' data-link='${esc(link)}'
                    title='QR code' aria-label='Show QR code'><i class='bi bi-qr-code'></i></button>
            <button class='btn btn--danger btn--sm' data-action='revoke' data-id='${esc(inv.id)}'>
              Revoke
            </button>
          ` : ''}
        </div>`;
      el.appendChild(row);
    });

    el.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { action, link, id } = btn.dataset;
        if (action === 'copy') {
          navigator.clipboard.writeText(link)
            .then(() => toast('<i class="bi bi-check2"></i> Link copied', 'success'))
            .catch(() => toast(`Copy failed — link: ${link}`, 'info'));
        }
        if (action === 'qr') {
          const row    = btn.closest('.book-row');
          const qrDiv  = row?.querySelector('.teacher-invite-qr');
          const qrImg  = qrDiv?.querySelector('img');
          if (!qrDiv) return;
          qrDiv.hidden = !qrDiv.hidden;
          if (!qrDiv.hidden && qrImg && !qrImg.src) {
            qrImg.src = `https://chart.googleapis.com/chart?chs=180x180&cht=qr&chl=${encodeURIComponent(link)}&choe=UTF-8`;
          }
        }
        if (action === 'revoke') {
          if (!confirm('Revoke this invite? The link will stop working immediately.')) return;
          try {
            await updateDoc(doc(db, 'invites', id), {
              revoked:   true,
              revokedAt: serverTimestamp(),
              revokedBy: currentUser.uid,
            });
            toast('Invite revoked', 'success');
            loadPastInvites();
          } catch (err) {
            toast(`Revoke failed: ${esc(err.message)}`, 'danger');
          }
        }
      });
    });
  } catch (err) {
    el.innerHTML = `<p class='empty-state'>Could not load invites: ${esc(err.message)}</p>`;
  }
}

// ── Bi-weekly notification ────────────────────────────────────────────────────
function checkBiweeklyNotification() {
  const KEY      = `bookware-biweekly-${currentUser.uid}`;
  const last     = localStorage.getItem(KEY);
  const TWO_WEEKS = 14 * 86400000;
  if (last && Date.now() - parseInt(last) < TWO_WEEKS) return;

  const show = async () => {
    const checkedOut = allBooks.filter(b => b.status === 'checked_out');
    const banner     = document.getElementById('biweeklyBanner');
    const content    = document.getElementById('biweeklyContent');
    if (!banner || !content) return;
    const now        = new Date();
    const overdueCount = checkedOut.filter(b => b.dueDate?.toDate?.() < now).length;
    content.innerHTML = `
      <div style='display:flex;flex-wrap:wrap;gap:7px;margin-top:8px'>
        ${checkedOut.map(b => `<span class='count-badge'>${esc(b.title)}</span>`).join('')}
      </div>
      <div style='margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center'>
        <p class='muted-text small-text'>${checkedOut.length} book${checkedOut.length !== 1 ? 's' : ''} out${overdueCount > 0 ? ` · <strong style='color:var(--danger)'>${overdueCount} overdue</strong>` : ''}.</p>
        <button class='btn btn--sm' id='biweeklyDownloadBtn'><i class='bi bi-download'></i> Download .MD</button>
        <button class='btn btn--ghost btn--sm' id='biweeklyDismissBtn'>Dismiss</button>
      </div>`;
    banner.hidden = false;
    localStorage.setItem(KEY, String(Date.now()));

    document.getElementById('biweeklyDownloadBtn')?.addEventListener('click', async () => {
      const tName = teacherData?.name ?? 'Teacher';
      let md = `# BookWare — Bi-Weekly Library Report\n\n**Teacher:** ${tName}  \n**Generated:** ${now.toLocaleString()}  \n\n---\n\n`;
      if (checkedOut.length === 0) { md += 'All books are currently available.\n'; }
      else {
        md += `## Currently Checked Out\n\n| Book | Author | Student | Checked Out | Due Date | Status |\n|------|--------|---------|-------------|----------|--------|\n`;
        for (const book of checkedOut) {
          let studentName = '—';
          if (book.checkedOutBy) { try { const s = await getDoc(doc(db, 'students', book.checkedOutBy)); if (s.exists()) studentName = s.data().name ?? '—'; } catch (_) {} }
          const dueDate  = book.dueDate?.toDate?.();
          const isOverdue = dueDate && dueDate < now;
          md += `| ${book.title} | ${book.author ?? '—'} | ${studentName} | ${fmtDate(book.checkedOutAt)} | ${dueDate ? dueDate.toLocaleDateString() : '—'} | ${isOverdue ? 'OVERDUE' : 'Active'} |\n`;
        }
      }
      md += `\n---\n*Generated by BookWare · Mason High School*\n`;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `bookware-report-${now.toISOString().slice(0, 10)}.md` });
      a.click(); URL.revokeObjectURL(a.href);
      toast('<i class="bi bi-check2"></i> Report downloaded', 'success');
    });

    document.getElementById('biweeklyDismissBtn')?.addEventListener('click', () => { banner.hidden = true; });
  };

  setTimeout(show, 1800);
}
