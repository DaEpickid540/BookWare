// student.js — BookWare Student Portal
import { auth, db } from './firebase.js';
import { searchBooks } from './books.js';
import { initTheme, initARIA, applyPreset } from './theme.js';
import { signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, deleteDoc, setDoc, updateDoc, addDoc,
  collection, query, where, orderBy, arrayUnion, arrayRemove,
  onSnapshot, runTransaction, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ────────────────────────────────────────────────────────────────────
let currentUser       = null;
let userData          = null;
let studentData       = null;
let classTeacherId    = null;
let selectedTeacherId = null;
let selectedTeacherName = '';
let allBooks          = [];
let addedTeacherIds   = [];
const bookCache       = new Map();
let wishlistListeners = [];

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

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
document.getElementById('sidebarToggle')?.addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  const expanded = sb.classList.toggle('collapsed');
  document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(!expanded));
});

// ── Page routing (wired immediately — before auth) ────────────────────────────
const PAGE_TITLES = { library: 'Library', locker: 'My Locker', wishlist: 'Wishlist', profile: 'Profile', settings: 'Settings' };

document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.remove('active');
    n.removeAttribute('aria-current');
  });
  document.getElementById(name + 'Page')?.classList.add('active');
  const navBtn = document.querySelector(`[data-page="${name}"]`);
  navBtn?.classList.add('active');
  navBtn?.setAttribute('aria-current', 'page');
  const pt = document.getElementById('pageTitle');
  if (pt) pt.textContent = PAGE_TITLES[name] ?? name;
  if (name === 'locker')  renderLockerPage();
  if (name === 'profile') renderProfilePage();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const _safeReveal = setTimeout(() => { document.documentElement.style.visibility = 'visible'; }, 5000);

onAuthStateChanged(auth, async (user) => {
  clearTimeout(_safeReveal);
  if (!user) { document.documentElement.style.visibility = 'visible'; window.location.href = '/'; return; }

  try {
    // Maintenance check
    try {
      const settingsSnap = await getDoc(doc(db, 'admin', 'settings'));
      if (settingsSnap.exists() && settingsSnap.data().maintenanceMode === true) {
        await signOut(auth); window.location.href = '/?maintenance=1'; return;
      }
    } catch (_) {}

    const userRef  = doc(db, 'users', user.uid);
    let   userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      await setDoc(userRef, { name: user.displayName ?? '', email: user.email ?? '', role: 'student', banned: false, class: null, createdAt: serverTimestamp() });
      userSnap = await getDoc(userRef);
    }

    const role = userSnap.data().role;
    if (role === 'teacher') { window.location.href = '/teacher.html'; return; }
    if (role === 'admin')   { window.location.href = '/admin.html';   return; }

    userData       = userSnap.data();
    currentUser    = user;
    classTeacherId = userData.class ?? null;

    // Ban check
    if (userData.banned) {
      const expiry = userData.banExpiry?.toDate?.();
      if (expiry && expiry < new Date()) {
        await updateDoc(userRef, { banned: false, banExpiry: null, banReason: null });
      } else {
        const days   = expiry ? Math.ceil((expiry - new Date()) / 86400000) : 'permanently';
        const reason = userData.banReason ?? 'Not specified';
        await signOut(auth);
        window.location.href = `/?banned=1&reason=${encodeURIComponent(reason)}&days=${days}`;
        return;
      }
    }

    // Load / create student doc
    const sRef  = doc(db, 'students', user.uid);
    let   sSnap = await getDoc(sRef);
    if (!sSnap.exists()) {
      await setDoc(sRef, { name: user.displayName ?? '', email: user.email ?? '', currentBook: null, wishlist: [], wishlistMeta: {}, banned: false });
      sSnap = await getDoc(sRef);
    }
    studentData     = sSnap.data();
    addedTeacherIds = studentData.addedTeachers ?? [];

    await loadMyRecIds();

    // Init UI
    populateTopBar();
    initTheme();
    initARIA(toast);
    setupSignout();
    populateSettingsInfo();
    renderWishlist();
    await loadTeachers();
    await renderNotifications();

    // Welcome toast (once per session)
    if (!sessionStorage.getItem('bw-welcomed')) {
      const first = (currentUser.displayName ?? '').split(' ')[0] || 'there';
      setTimeout(() => toast(`Welcome back, ${esc(first)} <i class='bi bi-hand-wave-fill'></i>`, 'success'), 800);
      sessionStorage.setItem('bw-welcomed', '1');
    }

    // Auto-select first linked library
    const firstId = classTeacherId ?? addedTeacherIds[0] ?? null;
    if (firstId) {
      try {
        const tSnap = await getDoc(doc(db, 'teachers', firstId));
        if (tSnap.exists()) await setSelectedTeacher(firstId, tSnap.data().name);
      } catch (_) {}
    }

  } catch (err) {
    console.error('[student] Init failed:', err);
    document.documentElement.style.visibility = 'visible';
    toast(`Failed to load student portal: ${err.message ?? 'unknown error'}. Try refreshing.`, 'danger');
  }
});

// ── Top bar ───────────────────────────────────────────────────────────────────
function populateTopBar() {
  const av     = document.getElementById('userAvatar');
  const nameEl = document.getElementById('userDisplayName');
  if (!currentUser) return;
  const display  = currentUser.displayName ?? currentUser.email ?? '?';
  const initials = display.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  if (av)     av.textContent     = initials;
  if (nameEl) nameEl.textContent = display.split(' ')[0];
}

// ── Sign out ──────────────────────────────────────────────────────────────────
function setupSignout() {
  document.getElementById('signoutBar')?.addEventListener('click', () => signOut(auth));
  const hint = document.getElementById('signoutEmail');
  if (hint && currentUser) hint.textContent = currentUser.email;
}

// ── Settings: my info ─────────────────────────────────────────────────────────
async function populateSettingsInfo() {
  const emailEl = document.getElementById('settingsEmail');
  if (emailEl) emailEl.textContent = currentUser.email;

  const sec = document.getElementById('myInfoSection');
  if (!sec) return;

  let classText = 'Not assigned';
  if (classTeacherId) {
    const tSnap = await getDoc(doc(db, 'teachers', classTeacherId));
    if (tSnap.exists()) classText = tSnap.data().name;
  }

  sec.innerHTML = `
    <div class='settings-row' style='border-top:none'>
      <div class='settings-label'>Full Name</div>
      <span class='muted-text small-text'>${esc(studentData.name)}</span>
    </div>
    <div class='settings-row'>
      <div class='settings-label'>Email</div>
      <span class='muted-text small-text'>${esc(currentUser.email)}</span>
    </div>
    <div class='settings-row'>
      <div class='settings-label'>Class</div>
      <span class='muted-text small-text'>${esc(classText)}</span>
    </div>
    <div class='settings-row'>
      <div class='settings-label'>Account Status</div>
      <span style='color:var(--success);font-size:0.72rem;font-weight:600'>Active</span>
    </div>`;

  renderAddedTeachersList();

  document.getElementById('addTeacherCodeBtn')?.addEventListener('click', addTeacherByCode);
  document.getElementById('teacherCodeInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') addTeacherByCode(); });
}

// ── Teacher code (join library) ───────────────────────────────────────────────
async function addTeacherByCode() {
  const input = document.getElementById('teacherCodeInput');
  const code  = input?.value.trim().toUpperCase();
  if (!code) return;

  let teacherId = null, classId = null, className = '';

  try {
    const { collectionGroup } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const cgSnap = await getDocs(query(collectionGroup(db, 'classes'), where('inviteCode', '==', code)));
    if (!cgSnap.empty) {
      const classDoc = cgSnap.docs[0];
      const parts = classDoc.ref.path.split('/');
      teacherId = parts[1]; classId = parts[3];
      className = classDoc.data().name ?? 'Class';
    }
  } catch (_) {}

  if (!teacherId) {
    const snap = await getDocs(query(collection(db, 'teachers'), where('inviteCode', '==', code)));
    if (!snap.empty) { teacherId = snap.docs[0].id; className = 'Class'; }
  }

  if (!teacherId) { toast('Code not found. Double-check with your teacher.', 'danger'); return; }
  if (addedTeacherIds.includes(teacherId)) { toast('That library is already added.', 'info'); return; }

  addedTeacherIds.push(teacherId);
  await updateDoc(doc(db, 'students', currentUser.uid), { addedTeachers: arrayUnion(teacherId) });

  const payload = { studentId: currentUser.uid, name: studentData?.name ?? currentUser.displayName ?? '', email: currentUser.email ?? '', joinedAt: serverTimestamp(), joinedVia: 'code' };
  try {
    if (classId) await setDoc(doc(db, 'teachers', teacherId, 'classes', classId, 'students', currentUser.uid), payload);
    else         await setDoc(doc(db, 'teachers', teacherId, 'students', currentUser.uid), payload);
  } catch (_) {}

  if (input) input.value = '';
  toast(`<i class='bi bi-check2'></i> Joined ${esc(className)}! Library added.`, 'success');
  renderAddedTeachersList();
  await loadTeachers();
}

async function renderAddedTeachersList() {
  const container = document.getElementById('addedTeachersList');
  if (!container || addedTeacherIds.length === 0) return;
  container.innerHTML = '';
  for (const tid of addedTeacherIds) {
    const snap = await getDoc(doc(db, 'teachers', tid));
    if (!snap.exists()) continue;
    const t   = snap.data();
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div>
        <div class='settings-label'>${esc(t.name)}'s Library</div>
        <div class='settings-hint'>${esc(t.email)}</div>
      </div>
      <button class='btn btn--ghost btn--sm' style='color:var(--danger);border-color:var(--danger-border)' data-remove='${esc(tid)}'>Remove</button>`;
    row.querySelector('[data-remove]')?.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.remove;
      addedTeacherIds = addedTeacherIds.filter(x => x !== id);
      await updateDoc(doc(db, 'students', currentUser.uid), { addedTeachers: arrayRemove(id) });
      try { await deleteDoc(doc(db, 'teachers', id, 'students', currentUser.uid)); } catch (_) {}
      toast('Library removed.', 'info');
      renderAddedTeachersList();
      await loadTeachers();
    });
    container.appendChild(row);
  }
}

// ── Notifications banner ──────────────────────────────────────────────────────
async function renderNotifications() {
  const inner = document.getElementById('notifBannerInner');
  if (!inner) return;
  inner.innerHTML = '';
  const notifs = [];
  const wishlist     = studentData.wishlist ?? [];
  const notifTeacherId = selectedTeacherId ?? classTeacherId;

  if (wishlist.length > 0 && notifTeacherId) {
    for (const bookId of wishlist.slice(0, 5)) {
      try {
        const bSnap = await getDoc(doc(db, 'teachers', notifTeacherId, 'books', bookId));
        if (bSnap.exists() && bSnap.data().status === 'available')
          notifs.push({ text: `"${bSnap.data().title}" is now available`, tag: 'Library' });
      } catch (_) {}
    }
  }

  if (notifTeacherId) {
    const tSnap = await getDoc(doc(db, 'teachers', notifTeacherId));
    if (tSnap.exists()) {
      const t = tSnap.data();
      if (t.currentlyReading) notifs.push({ text: `${t.name} is reading "${t.currentlyReading.title}"`, tag: 'Teacher' });
      try {
        const recSnap = await getDocs(collection(db, 'teachers', notifTeacherId, 'recommendations'));
        if (!recSnap.empty) notifs.push({ text: `${t.name} recommended "${recSnap.docs[0].data().bookTitle}"`, tag: 'Rec' });
      } catch (_) {}
    }
  }

  if (notifs.length === 0) {
    const noLib = !classTeacherId && addedTeacherIds.length === 0;
    const div = document.createElement('div');
    div.className = 'notif-item';
    div.innerHTML = `<span class='notif-dot notif-dot--dim'></span><span class='notif-text'>${noLib ? 'Join a library to see notifications.' : 'No new notifications.'}</span>`;
    inner.appendChild(div);
  } else {
    notifs.slice(0, 3).forEach(n => {
      const div = document.createElement('div');
      div.className = 'notif-item';
      div.innerHTML = `<span class='notif-dot'></span><div><div class='notif-text'>${esc(n.text)}</div><div class='notif-time'>${esc(n.tag)}</div></div>`;
      inner.appendChild(div);
    });
  }
}

// ── Load teachers ─────────────────────────────────────────────────────────────
async function loadTeachers() {
  const teacherListEl = document.getElementById('teacherList');
  if (!teacherListEl) return;

  const ids = new Set();
  if (classTeacherId) ids.add(classTeacherId);
  addedTeacherIds.forEach(id => ids.add(id));

  if (ids.size === 0) {
    teacherListEl.innerHTML = '';
    const cta = document.createElement('div');
    cta.className = 'no-library-cta';
    cta.innerHTML = `
      <div class='no-library-icon'><i class='bi bi-collection-fill'></i></div>
      <div class='no-library-title'>No libraries linked yet</div>
      <div class='no-library-sub'>Ask your teacher for their class code, then add it in Settings.</div>
      <button class='btn btn--primary' id='ctaAddLibraryBtn'>Add a Library Code</button>`;
    teacherListEl.appendChild(cta);
    document.getElementById('ctaAddLibraryBtn')?.addEventListener('click', () => {
      showPage('settings');
      setTimeout(() => { document.getElementById('teacherCodeInput')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.getElementById('teacherCodeInput')?.focus(); }, 120);
    });
    await renderAllLibraries();
    return;
  }

  teacherListEl.innerHTML = '';
  for (const tid of ids) {
    const snap = await getDoc(doc(db, 'teachers', tid));
    if (!snap.exists()) continue;
    const t   = snap.data();
    const btn = document.createElement('button');
    btn.className   = 'library-chip';
    btn.dataset.tid = tid;
    btn.textContent = t.name;
    btn.addEventListener('click', () => setSelectedTeacher(tid, t.name));
    teacherListEl.appendChild(btn);
  }
  await renderAllLibraries();
}

// ── All Libraries discovery ───────────────────────────────────────────────────
async function renderAllLibraries() {
  let allLibEl = document.getElementById('allLibrariesSection');
  if (!allLibEl) return;
  allLibEl.innerHTML = '';

  const snap = await getDocs(collection(db, 'teachers'));
  if (snap.empty) return;

  const myIds    = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  const all      = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const enrolled = all.filter(t => myIds.has(t.id));
  const publicLibs = all.filter(t => !myIds.has(t.id) && (t.libraryPublic ?? false));

  if (enrolled.length === 0 && publicLibs.length === 0) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'all-libraries-section';

  function buildCard(t) {
    const isLinked = myIds.has(t.id);
    const isPublic = t.libraryPublic ?? false;
    const card = document.createElement('div');
    card.className = 'all-lib-card';
    card.innerHTML = `
      <div class='all-lib-name'>${esc(t.name)}</div>
      <div class='all-lib-email'>${esc(t.email ?? '')}</div>
      <div class='all-lib-tags'>
        ${isLinked ? `<span class='alib-badge alib-badge--enrolled'><i class='bi bi-check2'></i> Enrolled</span>` : ''}
        ${isPublic ? `<span class='alib-badge alib-badge--public'><i class='bi bi-collection-fill'></i> Public</span>`
                   : `<span class='alib-badge alib-badge--classonly'><i class='bi bi-lock-fill'></i> Class Only</span>`}
      </div>
      <div class='all-lib-actions'>
        <button class='btn btn--sm alib-browse' data-tid='${esc(t.id)}' data-name='${esc(t.name)}'>
          <i class='bi bi-book-fill'></i> Browse
        </button>
        ${isPublic && !isLinked
          ? `<button class='btn btn--sm' style='color:var(--info);border-color:rgba(52,152,219,.4)' data-tid='${esc(t.id)}' data-name='${esc(t.name)}' data-email='${esc(t.email ?? '')}' data-action='request'>
               <i class='bi bi-envelope-fill'></i> Request Access
             </button>`
          : ''}
      </div>`;
    card.querySelector('.alib-browse')?.addEventListener('click', (e) => {
      const { tid, name } = e.currentTarget.dataset;
      setSelectedTeacher(tid, name);
    });
    card.querySelector('[data-action="request"]')?.addEventListener('click', (e) => {
      const { name, email } = e.currentTarget.dataset;
      const subject = encodeURIComponent('BookWare Library Access Request');
      const body    = encodeURIComponent(`Hi ${name},\n\nI'd like to join your BookWare class.\n\nMy name: ${studentData?.name ?? ''}\nEmail: ${currentUser?.email ?? ''}\n\nThank you!`);
      window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
    });
    return card;
  }

  if (enrolled.length > 0) {
    const h = document.createElement('div');
    h.className = 'section-label'; h.style.marginBottom = '10px';
    h.innerHTML = '<i class="bi bi-check2" aria-hidden="true"></i> My Libraries';
    wrapper.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'all-lib-grid';
    enrolled.forEach(t => grid.appendChild(buildCard(t)));
    wrapper.appendChild(grid);
  }

  if (publicLibs.length > 0) {
    const h = document.createElement('div');
    h.className = 'section-label'; h.style.cssText = 'margin-bottom:8px;margin-top:18px';
    h.innerHTML = '<i class="bi bi-collection-fill" aria-hidden="true"></i> Discover Public Libraries';
    const hint = document.createElement('p');
    hint.className = 'empty-state'; hint.style.marginBottom = '10px';
    hint.textContent = 'Browse freely — ask the teacher for their class code to check out books.';
    wrapper.appendChild(h); wrapper.appendChild(hint);
    const grid = document.createElement('div');
    grid.className = 'all-lib-grid';
    publicLibs.forEach(t => grid.appendChild(buildCard(t)));
    wrapper.appendChild(grid);
  }

  allLibEl.appendChild(wrapper);
}

async function setSelectedTeacher(tid, name) {
  selectedTeacherId   = tid;
  selectedTeacherName = name;
  document.querySelectorAll('#teacherList .library-chip').forEach(b =>
    b.classList.toggle('selected', b.dataset.tid === tid)
  );
  await loadTeacherBooks(tid);
  await renderTeacherExtras(tid, name);
}

// ── Teacher extras (recs + now reading) ───────────────────────────────────────
async function renderTeacherExtras(tid, name) {
  const recPlaceholder  = document.getElementById('recCardPlaceholder');
  const readPlaceholder = document.getElementById('readingCardPlaceholder');
  const tSnap = await getDoc(doc(db, 'teachers', tid));
  const t     = tSnap.exists() ? tSnap.data() : {};

  // Recommendations card
  const recCard = document.createElement('div');
  recCard.className = 'panel-card';
  recCard.id        = 'recCardPlaceholder';
  recCard.innerHTML = `<div class='section-label'><i class='bi bi-star-fill' aria-hidden='true'></i> Recommended by ${esc(name)}</div>`;
  const recSnap = await getDocs(collection(db, 'teachers', tid, 'recommendations'));
  if (recSnap.empty) {
    recCard.innerHTML += `<p class='empty-state'>No recommendations yet.</p>`;
  } else {
    recSnap.forEach(d => {
      const r = d.data();
      const row = document.createElement('div');
      row.className = 'book-row';
      row.innerHTML = `
        ${r.coverUrl ? `<img src='${esc(r.coverUrl)}' class='book-cover' alt=''>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
        <div class='book-info'>
          <div class='book-title'>${esc(r.bookTitle)}</div>
          ${r.author ? `<div class='book-author'>${esc(r.author)}</div>` : `<span class='badge badge--reading'><span class='badge--dot'></span>Recommended</span>`}
        </div>`;
      recCard.appendChild(row);
    });
  }

  // Now reading card
  const readCard = document.createElement('div');
  readCard.className = 'panel-card';
  readCard.id        = 'readingCardPlaceholder';
  if (t.currentlyReading) {
    const r = t.currentlyReading;
    readCard.innerHTML = `
      <div class='section-label'><i class='bi bi-book-fill' aria-hidden='true'></i> ${esc(name)} is Reading</div>
      <div class='book-row'>
        ${r.coverUrl ? `<img src='${esc(r.coverUrl)}' class='book-cover' style='border-color:var(--accent)' alt=''>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
        <div class='book-info'>
          <div class='book-title'>${esc(r.title)}</div>
          <div class='book-author'>${esc(r.author)}</div>
        </div>
      </div>`;
  } else {
    readCard.innerHTML = `
      <div class='section-label'><i class='bi bi-book-fill' aria-hidden='true'></i> ${esc(name)} is Reading</div>
      <p class='empty-state'>Nothing set yet.</p>`;
  }

  recPlaceholder?.replaceWith(recCard);
  readPlaceholder?.replaceWith(readCard);
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

// ── Load teacher books ────────────────────────────────────────────────────────
async function loadTeacherBooks(tid) {
  const bookListEl = document.getElementById('bookList');
  if (!bookListEl) return;
  renderSkeletonRows(bookListEl, 6);

  const myIds    = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  const isEnrolled = myIds.has(tid);

  if (!isEnrolled) {
    try {
      const tSnap = await getDoc(doc(db, 'teachers', tid));
      if (!tSnap.exists() || !tSnap.data().libraryPublic) {
        bookListEl.innerHTML = `<p class='empty-state'><i class='bi bi-lock-fill'></i> This library is class-only. Ask the teacher for their class code to join.</p>`;
        allBooks = []; return;
      }
    } catch (_) {
      bookListEl.innerHTML = `<p class='empty-state'>Could not verify library access.</p>`;
      return;
    }
  }

  const snap = await getDocs(collection(db, 'teachers', tid, 'books'));
  if (snap.empty) {
    bookListEl.innerHTML = `<p class='empty-state'>No books in this library yet.</p>`;
    allBooks = []; return;
  }

  allBooks = snap.docs.map(d => {
    const data = { id: d.id, teacherId: tid, ...d.data() };
    bookCache.set(d.id, { title: data.title, author: data.author, isbn: data.isbn, coverUrl: data.coverUrl, teacherId: tid });
    return data;
  });
  filterAndRenderBooks();
  renderWishlist();
  await setupWishlistNotifications();
}

// ── Search ────────────────────────────────────────────────────────────────────
document.getElementById('searchInput')?.addEventListener('input', filterAndRenderBooks);

function filterAndRenderBooks() {
  const term = (document.getElementById('searchInput')?.value ?? '').trim().toLowerCase();
  const list = term ? allBooks.filter(b => b.title?.toLowerCase().includes(term) || b.author?.toLowerCase().includes(term) || b.isbn?.toLowerCase().includes(term)) : allBooks;
  renderBooks(list);
}

// ── Render books ──────────────────────────────────────────────────────────────
function renderBooks(books) {
  const bookListEl = document.getElementById('bookList');
  if (!bookListEl) return;
  if (books.length === 0) { bookListEl.innerHTML = `<p class='empty-state'>No books match your search.</p>`; return; }

  const hasBook  = !!studentData?.currentBook;
  const wishlist = studentData?.wishlist ?? [];
  const myRecs   = studentData?.myRecIds ?? new Set();
  const reading  = new Set((studentData?.currentlyReading ?? []).map(r => r.bookId));
  bookListEl.innerHTML = '';

  books.forEach(book => {
    const isActive   = book.id === studentData?.currentBook;
    const isAvail    = book.status === 'available';
    const isWished   = wishlist.includes(book.id);
    const isReced    = myRecs.has ? myRecs.has(book.id) : false;
    const isReading  = reading.has(book.id);
    const canCheckout = isAvail && !hasBook && !isActive;

    const copies = book.copies ?? 1;
    const out    = book.checkedOutCount ?? (book.status === 'checked_out' ? 1 : 0);
    const avail  = copies - out;

    const statusBadge = isActive
      ? `<span class='badge badge--reading badge--dot'>Currently Reading</span>`
      : copies > 1
      ? `<span class='badge ${avail > 0 ? "badge--available" : "badge--checked-out"}'>${avail}/${copies} available</span>`
      : isAvail
      ? `<span class='badge badge--available'>Available</span>`
      : `<span class='badge badge--checked-out'>Checked Out</span>`;

    let checkoutBtn = '';
    if (isActive)      checkoutBtn = `<button class='btn btn--ghost btn--sm' data-action='return'   data-id='${esc(book.id)}'>Return Book</button>`;
    else if (canCheckout) checkoutBtn = `<button class='btn btn--primary btn--sm' data-action='checkout' data-id='${esc(book.id)}' data-title='${esc(book.title)}'>Check Out</button>`;
    else if (isAvail)  checkoutBtn = `<button class='btn btn--primary btn--sm' disabled title='Return your current book first'>Check Out</button>`;

    const wishBtn = !isActive
      ? `<button class='btn btn--xs ${isWished ? 'starred' : ''}' data-action='${isWished ? "unwishlist" : "wishlist"}' data-id='${esc(book.id)}'>${isWished ? '<i class="bi bi-heart-fill"></i> Wishlisted' : '<i class="bi bi-heart"></i> Wishlist'}</button>`
      : '';

    const recBtn = `<button class='btn btn--xs ${isReced ? 'starred' : ''}' data-action='${isReced ? "unrecommend" : "recommend"}' data-id='${esc(book.id)}' data-title='${esc(book.title)}' data-author='${esc(book.author ?? '')}' data-cover='${esc(book.coverUrl ?? '')}'>${isReced ? '<i class="bi bi-star-fill"></i> Recommended' : '<i class="bi bi-star"></i> Recommend'}</button>`;

    const readingBtn = !isActive
      ? `<button class='btn btn--xs ${isReading ? 'starred' : ''}' data-action='${isReading ? "unset-reading" : "set-reading"}' data-id='${esc(book.id)}' data-title='${esc(book.title)}' data-author='${esc(book.author ?? '')}' data-cover='${esc(book.coverUrl ?? '')}'>${isReading ? '<i class="bi bi-book-fill"></i> Reading' : '<i class="bi bi-book-fill"></i> Set Reading'}</button>`
      : '';

    const row = document.createElement('div');
    row.className = 'book-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      ${book.coverUrl ? `<img src='${esc(book.coverUrl)}' class='book-cover' alt='Cover of ${esc(book.title)}' loading='lazy'>` : `<div class='book-cover-ph' aria-hidden='true'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'>
        <div class='book-title'>${esc(book.title)}</div>
        <div class='book-author'>${esc(book.author ?? '')}</div>
        <div style='display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px'>${statusBadge}</div>
        ${book.description ? `<p style='font-size:0.66rem;color:var(--text-3);margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden'>${esc(book.description)}</p>` : ''}
        <div class='book-actions'>${checkoutBtn}${wishBtn}</div>
        <div class='book-actions' style='margin-top:4px'>${recBtn}${readingBtn}</div>
      </div>`;

    row.querySelector('[data-action="checkout"]')?.addEventListener('click', e  => requestCheckout(e.currentTarget.dataset.id, e.currentTarget.dataset.title));
    row.querySelector('[data-action="return"]')?.addEventListener('click',   e  => initiateReturn(e.currentTarget.dataset.id));
    row.querySelector('[data-action="wishlist"]')?.addEventListener('click', e  => addToWishlist(e.currentTarget.dataset.id));
    row.querySelector('[data-action="unwishlist"]')?.addEventListener('click',e => removeFromWishlist(e.currentTarget.dataset.id));
    row.querySelector('[data-action="recommend"]')?.addEventListener('click', e => { const d = e.currentTarget.dataset; toggleStudentRecommend(d.id, d.title, d.author, d.cover); });
    row.querySelector('[data-action="unrecommend"]')?.addEventListener('click',e => { const d = e.currentTarget.dataset; toggleStudentRecommend(d.id, d.title, d.author, d.cover); });
    row.querySelector('[data-action="set-reading"]')?.addEventListener('click', e => { const d = e.currentTarget.dataset; addToCurrentlyReading(d.id, d.title, d.author, d.cover); });
    row.querySelector('[data-action="unset-reading"]')?.addEventListener('click',e => removeFromCurrentlyReading(e.currentTarget.dataset.id));

    bookListEl.appendChild(row);
  });
}

// ── Checkout ──────────────────────────────────────────────────────────────────
async function requestCheckout(bookId, bookTitle) {
  if (!currentUser || !selectedTeacherId) { toast('Select a library first.', 'danger'); return; }

  const myIds = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  if (!myIds.has(selectedTeacherId)) {
    const tSnap = await getDoc(doc(db, 'teachers', selectedTeacherId));
    if (!tSnap.exists() || !tSnap.data().libraryPublic) {
      toast('You need to join this teacher\'s class to check out books.', 'danger');
      return;
    }
  }

  let bookAuthor = '';
  const dueDate  = new Date();
  dueDate.setDate(dueDate.getDate() + 14);

  try {
    await runTransaction(db, async (tx) => {
      const studentRef = doc(db, 'students', currentUser.uid);
      const bookRef    = doc(db, 'teachers', selectedTeacherId, 'books', bookId);
      const [sSnap, bSnap] = await Promise.all([tx.get(studentRef), tx.get(bookRef)]);
      if (!sSnap.exists())                   throw new Error('student-not-found');
      if (sSnap.data().currentBook !== null)  throw new Error('already-has-book');
      if (!bSnap.exists())                   throw new Error('book-not-found');
      const bData  = bSnap.data();
      bookAuthor   = bData.author ?? '';
      const copies = bData.copies ?? 1;
      const out    = bData.checkedOutCount ?? (bData.status === 'checked_out' ? 1 : 0);
      if (out >= copies) throw new Error('unavailable');
      const newCount = out + 1;
      tx.update(bookRef, { checkedOutCount: newCount, status: newCount >= copies ? 'checked_out' : 'available', checkedOutBy: currentUser.uid, checkedOutAt: serverTimestamp(), dueDate: Timestamp.fromDate(dueDate) });
      tx.update(studentRef, { currentBook: bookId, currentBookTeacherId: selectedTeacherId });
    });
  } catch (err) {
    const msg = err.message === 'already-has-book' ? 'You already have a book checked out.'
              : err.message === 'unavailable'       ? 'All copies just got taken — someone beat you to it!'
              : err.message === 'book-not-found'    ? 'This book no longer exists.'
              : `Checkout failed: ${err.message}`;
    toast(msg, 'danger');
    await loadTeacherBooks(selectedTeacherId);
    return;
  }

  try {
    await addDoc(collection(db, 'teachers', selectedTeacherId, 'history'), {
      bookId, bookTitle, author: bookAuthor,
      studentId: currentUser.uid, studentName: studentData?.name ?? currentUser.displayName ?? '',
      dateOut: serverTimestamp(), dateReturned: null,
    });
  } catch (e) { console.error('[student] History write failed:', e?.code ?? e); }

  studentData.currentBook = bookId;
  studentData.currentBookTeacherId = selectedTeacherId;
  const bi = allBooks.findIndex(b => b.id === bookId);
  if (bi !== -1) {
    const bk = allBooks[bi];
    const copies   = bk.copies ?? 1;
    const newCount = (bk.checkedOutCount ?? (bk.status === 'checked_out' ? 1 : 0)) + 1;
    allBooks[bi]   = { ...bk, checkedOutCount: newCount, status: newCount >= copies ? 'checked_out' : 'available', checkedOutBy: currentUser.uid };
  }
  filterAndRenderBooks();
  toast(`<i class='bi bi-check2'></i> "${esc(bookTitle)}" checked out — due ${dueDate.toLocaleDateString()}`, 'success');
}

// ── Return ────────────────────────────────────────────────────────────────────
async function initiateReturn(bookId) {
  if (!confirm('Confirm you\'ve handed the book back to your teacher.\n\nYour teacher will finalize the return on their end.')) return;
  const bookTeacherId = studentData.currentBookTeacherId ?? classTeacherId;
  if (bookTeacherId) {
    try {
      const bRef  = doc(db, 'teachers', bookTeacherId, 'books', bookId);
      const bSnap = await getDoc(bRef);
      if (bSnap.exists()) {
        const bData    = bSnap.data();
        const newCount = Math.max(0, (bData.checkedOutCount ?? 1) - 1);
        await updateDoc(bRef, { checkedOutCount: newCount, status: newCount === 0 ? 'available' : 'checked_out', checkedOutBy: newCount === 0 ? null : bData.checkedOutBy, checkedOutAt: newCount === 0 ? null : bData.checkedOutAt, dueDate: newCount === 0 ? null : bData.dueDate });
      }
    } catch (_) {}
  }
  await updateDoc(doc(db, 'students', currentUser.uid), { currentBook: null, currentBookTeacherId: null });
  studentData.currentBook = null;
  studentData.currentBookTeacherId = null;
  filterAndRenderBooks();
  if (document.getElementById('lockerPage')?.classList.contains('active')) renderLockerPage();
  toast(`<i class='bi bi-check2'></i> Return marked. Teacher will confirm.`, 'success');
}

// ── Wishlist ──────────────────────────────────────────────────────────────────
async function addToWishlist(bookId) {
  await updateDoc(doc(db, 'students', currentUser.uid), { wishlist: arrayUnion(bookId) });
  if (!studentData.wishlist) studentData.wishlist = [];
  if (!studentData.wishlist.includes(bookId)) studentData.wishlist.push(bookId);
  renderWishlist(); filterAndRenderBooks();
  toast(`<i class='bi bi-check2'></i> Added to wishlist`, 'success');
}

async function removeFromWishlist(bookId) {
  await updateDoc(doc(db, 'students', currentUser.uid), { wishlist: arrayRemove(bookId) });
  studentData.wishlist = (studentData.wishlist ?? []).filter(id => id !== bookId);
  renderWishlist(); filterAndRenderBooks();
  toast('Removed from wishlist', 'info');
}

// Wishlist search (Google Books)
let wishlistSearchResults = [];

let wishlistSearchDebounce = null;
document.getElementById('wishlistSearchInput')?.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  if (!q) { wishlistSearchResults = []; renderWishlistSearchResults([]); clearTimeout(wishlistSearchDebounce); return; }
  clearTimeout(wishlistSearchDebounce);
  wishlistSearchDebounce = setTimeout(async () => {
    wishlistSearchResults = await searchBooks(q, 6);
    renderWishlistSearchResults(wishlistSearchResults);
  }, 400);
});

function renderWishlistSearchResults(results) {
  const el = document.getElementById('wishlistSearchResults');
  if (!el) return;
  el.innerHTML = '';
  if (!results.length) { el.innerHTML = `<p class='empty-state'>No results.</p>`; return; }
  results.forEach(book => {
    const isWished = (studentData?.wishlist ?? []).includes(book.sourceId);
    const row = document.createElement('div');
    row.className = 'book-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      ${book.cover ? `<img src='${esc(book.cover)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;justify-content:space-between;gap:8px'>
        <div style='min-width:0'>
          <div class='book-title'>${esc(book.title)}</div>
          <div class='book-author'>${esc(book.author)}</div>
        </div>
        <button class='btn btn--xs ${isWished ? 'starred' : ''}' data-gid='${esc(book.sourceId)}' data-title='${esc(book.title)}' data-author='${esc(book.author)}' data-cover='${esc(book.cover)}' style='flex-shrink:0'>
          ${isWished ? '<i class="bi bi-heart-fill"></i> Wishlisted' : '<i class="bi bi-heart"></i> Wishlist'}
        </button>
      </div>`;
    row.querySelector('button')?.addEventListener('click', async (ev) => {
      const { gid, title, author, cover } = ev.currentTarget.dataset;
      if (isWished) {
        await removeFromWishlist(gid);
      } else {
        await updateDoc(doc(db, 'students', currentUser.uid), { wishlist: arrayUnion(gid), [`wishlistMeta.${gid}`]: { title, author, coverUrl: cover } });
        if (!studentData.wishlist) studentData.wishlist = [];
        if (!studentData.wishlist.includes(gid)) studentData.wishlist.push(gid);
        if (!studentData.wishlistMeta) studentData.wishlistMeta = {};
        studentData.wishlistMeta[gid] = { title, author, coverUrl: cover };
        toast(`<i class='bi bi-heart-fill'></i> "${esc(title)}" added to wishlist`, 'success');
        renderWishlist();
        renderWishlistSearchResults(wishlistSearchResults);
      }
    });
    el.appendChild(row);
  });
}

function renderWishlist() {
  const wishlistEl = document.getElementById('wishlistPanel');
  if (!wishlistEl) return;
  const list = studentData?.wishlist ?? [];
  if (list.length === 0) { wishlistEl.innerHTML = `<p class='empty-state'>Your wishlist is empty. Search for books on the right to add them!</p>`; return; }
  wishlistEl.innerHTML = '';
  list.forEach(bookId => {
    const cached  = bookCache.get(bookId);
    const meta    = studentData?.wishlistMeta?.[bookId];
    const title   = cached?.title    ?? meta?.title    ?? `Book ID: ${bookId.slice(0, 8)}…`;
    const author  = cached?.author   ?? meta?.author   ?? '';
    const coverUrl = cached?.coverUrl ?? meta?.coverUrl ?? '';
    const item = document.createElement('div');
    item.className = 'book-row';
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      ${coverUrl ? `<img src='${esc(coverUrl)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'>${esc(title)}</div>
          <div class='book-author'>${esc(author)}</div>
        </div>
        <button class='btn btn--xs' data-remove='${esc(bookId)}'><i class='bi bi-x'></i> Remove</button>
      </div>`;
    item.querySelector('[data-remove]')?.addEventListener('click', e => removeFromWishlist(e.currentTarget.dataset.remove));
    wishlistEl.appendChild(item);
  });
}

// ── Locker page ───────────────────────────────────────────────────────────────
async function renderLockerPage() {
  await renderActiveLoans();
  await renderReadingLog();
}

async function renderActiveLoans() {
  const el = document.getElementById('activeLoans');
  if (!el) return;
  const bookId = studentData.currentBook;
  if (!bookId) { el.innerHTML = `<p class='empty-state'>No active loans. Check out a book from the Library!</p>`; return; }

  const bookTeacherId = studentData.currentBookTeacherId ?? classTeacherId;
  let book = bookCache.get(bookId);
  if (bookTeacherId) {
    try {
      const bSnap = await getDoc(doc(db, 'teachers', bookTeacherId, 'books', bookId));
      if (bSnap.exists()) { book = bSnap.data(); bookCache.set(bookId, { ...book, teacherId: bookTeacherId }); }
    } catch (_) {}
  }

  let dueLabel = '', isOverdue = false;
  if (book?.dueDate) {
    const due     = book.dueDate.toDate ? book.dueDate.toDate() : new Date(book.dueDate);
    const diffDays = Math.ceil((due - new Date()) / 86400000);
    if (diffDays < 0) { isOverdue = true; dueLabel = `<i class='bi bi-exclamation-triangle-fill'></i> Overdue by ${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''}`; }
    else if (diffDays === 0) { dueLabel = "<i class='bi bi-calendar-event-fill'></i> Due today!"; }
    else { dueLabel = `<i class='bi bi-calendar-event-fill'></i> Due in ${diffDays} day${diffDays !== 1 ? 's' : ''} (${due.toLocaleDateString()})`; }
  }

  el.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'book-card-grid';
  const card = document.createElement('div');
  card.className = 'book-card book-card--active';
  card.setAttribute('role', 'listitem');
  card.innerHTML = `
    <div class='book-card-cover'>
      ${book?.coverUrl ? `<img src='${esc(book.coverUrl)}' alt='Cover of ${esc(book?.title ?? '')}' loading='lazy'>` : `<i class='bi bi-book-fill' aria-hidden='true'></i>`}
    </div>
    <div class='book-card-title'>${esc(book?.title ?? bookId)}</div>
    <div class='book-card-author'>${esc(book?.author ?? '')}</div>
    <span class='badge badge--checked-out badge--dot' style='display:inline-flex;margin:6px 0'>Checked Out</span>
    ${dueLabel ? `<div style='font-size:0.69rem;margin:4px 0 6px;color:${isOverdue ? 'var(--danger)' : 'var(--text-3)'};font-weight:${isOverdue ? '600' : '400'}'>${dueLabel}</div>` : ''}
    <button class='btn btn--ghost btn--sm' style='width:100%;margin-top:8px' id='returnBtnLocker'>Returned It</button>`;
  card.querySelector('#returnBtnLocker')?.addEventListener('click', () => initiateReturn(bookId));
  grid.appendChild(card);
  el.appendChild(grid);
}

async function renderReadingLog() {
  const el = document.getElementById('readingLog');
  if (!el) return;
  const entries = [];
  const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  for (const tid of ids) {
    try {
      const snap = await getDocs(query(collection(db, 'teachers', tid, 'history'), where('studentId', '==', currentUser.uid)));
      snap.forEach(d => entries.push({ ...d.data(), teacherId: tid }));
    } catch (_) {}
  }
  const history = entries.filter(e => e.dateReturned !== null).sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
  if (history.length === 0) { el.innerHTML = `<p class='empty-state'>No reading history yet.</p>`; return; }
  el.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'book-card-grid';
  history.forEach(e => {
    const cached = [...bookCache.values()].find(b => b.title === e.bookTitle);
    const card   = document.createElement('div');
    card.className = 'book-card book-card--faded';
    card.setAttribute('role', 'listitem');
    card.innerHTML = `
      <div class='book-card-cover'>
        ${cached?.coverUrl ? `<img src='${esc(cached.coverUrl)}' alt='' loading='lazy'>` : `<i class='bi bi-book-fill' aria-hidden='true'></i>`}
      </div>
      <div class='book-card-title'>${esc(e.bookTitle)}</div>
      <div style='font-size:0.63rem;color:var(--text-3);margin-top:4px'>Returned ${fmtDate(e.dateReturned)}</div>`;
    grid.appendChild(card);
  });
  el.appendChild(grid);
}

// Download reading log
document.getElementById('downloadLogBtn')?.addEventListener('click', async () => {
  const entries = [];
  const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  for (const tid of ids) {
    const tSnap = await getDoc(doc(db, 'teachers', tid));
    const tName = tSnap.exists() ? tSnap.data().name : tid;
    const hSnap = await getDocs(query(collection(db, 'teachers', tid, 'history'), where('studentId', '==', currentUser.uid)));
    hSnap.forEach(d => entries.push({ ...d.data(), teacherName: tName }));
  }
  const sorted = entries.sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
  let md = `# Reading Log — ${studentData.name}\n\n**Exported:** ${new Date().toLocaleDateString()}\n\n`;
  md += `| Book | Teacher Library | Date Out | Date Returned |\n`;
  md += `|------|----------------|----------|---------------|\n`;
  sorted.forEach(e => { md += `| ${e.bookTitle} | ${e.teacherName} | ${fmtDate(e.dateOut)} | ${e.dateReturned ? fmtDate(e.dateReturned) : 'Currently checked out'} |\n`; });
  md += `\n---\n_Generated by BookWare · Mason High School_\n`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `reading-log-${studentData.name.replace(/\s+/g, '-').toLowerCase()}.md` });
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`<i class='bi bi-check2'></i> Reading log downloaded`, 'success');
});

// ── Profile page ──────────────────────────────────────────────────────────────
async function renderProfilePage() {
  await renderProfileCurrentBook();
  await renderReadingStats();
  await renderSimilarReaders();
  await renderMyRecommendations();
}

const READING_LIMIT = 6;

async function renderProfileCurrentBook() {
  const el = document.getElementById('profileCurrentBook');
  if (!el) return;
  const list     = studentData.currentlyReading ?? [];
  const checkedOut = studentData.currentBook;
  if (list.length === 0 && !checkedOut) { el.innerHTML = `<p class='empty-state'>Not reading anything right now. Hit <i class='bi bi-book-fill'></i> Set Reading on any library book!</p>`; return; }

  const limitColor = list.length >= READING_LIMIT ? 'var(--danger)' : 'var(--text-3)';
  el.innerHTML = `<div style='font-size:0.68rem;color:${limitColor};margin-bottom:8px;font-weight:${list.length >= READING_LIMIT ? '600' : '400'}'>${list.length}/${READING_LIMIT} books${list.length >= READING_LIMIT ? ' — list full' : ''}</div>`;

  if (checkedOut) {
    let book = bookCache.get(checkedOut);
    if (!book && (studentData.currentBookTeacherId ?? classTeacherId)) {
      const tid   = studentData.currentBookTeacherId ?? classTeacherId;
      const snap  = await getDoc(doc(db, 'teachers', tid, 'books', checkedOut));
      if (snap.exists()) { book = snap.data(); bookCache.set(checkedOut, book); }
    }
    const card = document.createElement('div');
    card.className = 'book-row';
    card.style.cssText = 'border:1px solid var(--accent);border-radius:var(--r);padding:10px;margin-bottom:8px';
    card.innerHTML = `
      ${book?.coverUrl ? `<img src='${esc(book.coverUrl)}' class='book-cover' alt=''>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'>
        <div class='book-title'>${esc(book?.title ?? checkedOut)}</div>
        <div class='book-author'>${esc(book?.author ?? '')}</div>
        <span class='badge badge--reading badge--dot' style='margin-top:6px;display:inline-flex'>Checked Out</span>
      </div>`;
    el.appendChild(card);
  }

  list.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'book-row';
    card.style.cssText = 'border:1px solid var(--border);border-radius:var(--r);padding:10px;margin-bottom:8px';
    card.innerHTML = `
      ${entry.coverUrl ? `<img src='${esc(entry.coverUrl)}' class='book-cover' alt=''>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'>${esc(entry.bookTitle)}</div>
          <div class='book-author'>${esc(entry.author ?? '')}</div>
        </div>
        <button class='btn btn--xs' data-remove='${esc(entry.bookId)}'><i class='bi bi-x'></i></button>
      </div>`;
    card.querySelector('[data-remove]')?.addEventListener('click', e => removeFromCurrentlyReading(e.currentTarget.dataset.remove));
    el.appendChild(card);
  });
}

async function renderReadingStats() {
  const el = document.getElementById('readingStats');
  if (!el) return;
  let totalRead = 0;
  const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  for (const tid of ids) {
    const snap = await getDocs(query(collection(db, 'teachers', tid, 'history'), where('studentId', '==', currentUser.uid)));
    totalRead += snap.size;
  }
  const wishlisted = (studentData.wishlist ?? []).length;
  const active     = studentData.currentBook ? 1 : 0;
  let overdueCount = 0;
  if (studentData.currentBook && studentData.currentBookTeacherId) {
    try {
      const bSnap = await getDoc(doc(db, 'teachers', studentData.currentBookTeacherId, 'books', studentData.currentBook));
      if (bSnap.exists() && bSnap.data().dueDate?.toDate() < new Date()) overdueCount = 1;
    } catch (_) {}
  }
  el.innerHTML = `
    <div class='stat-box'><div class='stat-number'>${totalRead}</div><div class='stat-label'>Books Read</div></div>
    <div class='stat-box'><div class='stat-number'>${wishlisted}</div><div class='stat-label'>Wishlisted</div></div>
    <div class='stat-box'><div class='stat-number'>${active}</div><div class='stat-label'>Active Loan</div></div>
    <div class='stat-box'><div class='stat-number' style='color:${overdueCount > 0 ? 'var(--danger)' : 'inherit'}'>${overdueCount}</div><div class='stat-label'>Overdue</div></div>`;
}

async function renderSimilarReaders() {
  const el = document.getElementById('similarReaders');
  if (!el) return;
  if (!classTeacherId) { el.innerHTML = `<p class='empty-state'>Join a class to see similar readers.</p>`; return; }
  const snap   = await getDocs(query(collection(db, 'students'), where('class', '==', classTeacherId)));
  const others = snap.docs.filter(d => d.id !== currentUser.uid).slice(0, 6);
  if (others.length === 0) { el.innerHTML = `<p class='empty-state'>No other students in your class yet.</p>`; return; }
  el.innerHTML = '';
  others.forEach(d => {
    const s        = d.data();
    const initials = (s.name ?? '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const card     = document.createElement('div');
    card.className = 'reader-card';
    card.innerHTML = `
      <div class='reader-avatar'>${esc(initials)}</div>
      <div class='reader-name'>${esc(s.name?.split(' ')[0] ?? 'Student')} ${esc((s.name?.split(' ')[1] ?? '')[0] ?? '')}.</div>
      <div class='reader-status'>${s.currentBook ? 'Currently reading' : 'No active loan'}</div>`;
    el.appendChild(card);
  });
}

// ── Student recommendations ───────────────────────────────────────────────────
async function loadMyRecIds() {
  const snap = await getDocs(collection(db, 'students', currentUser.uid, 'recommendations'));
  studentData.myRecIds = new Set(snap.docs.map(d => d.data().bookId));
}

async function toggleStudentRecommend(bookId, bookTitle, author, coverUrl) {
  const snap     = await getDocs(collection(db, 'students', currentUser.uid, 'recommendations'));
  const existing = snap.docs.find(d => d.data().bookId === bookId);
  if (existing) {
    await deleteDoc(doc(db, 'students', currentUser.uid, 'recommendations', existing.id));
    studentData.myRecIds?.delete(bookId);
    toast(`<i class='bi bi-star'></i> Removed "${esc(bookTitle)}" from recommendations`, 'info');
  } else {
    await addDoc(collection(db, 'students', currentUser.uid, 'recommendations'), { bookId, bookTitle, author: author ?? '', coverUrl: coverUrl ?? '', addedAt: serverTimestamp() });
    studentData.myRecIds?.add(bookId);
    toast(`<i class='bi bi-star-fill'></i> "${esc(bookTitle)}" added to recommendations`, 'success');
  }
  filterAndRenderBooks();
  if (document.getElementById('profilePage')?.classList.contains('active')) renderMyRecommendations();
}

async function addToCurrentlyReading(bookId, bookTitle, author, coverUrl) {
  const current = studentData.currentlyReading ?? [];
  if (current.find(r => r.bookId === bookId)) { toast('Already in your reading list.', 'info'); return; }
  if (current.length >= READING_LIMIT) { toast(`Reading list is full (max ${READING_LIMIT} books). Remove one first.`, 'danger'); return; }
  const updated = [...current, { bookId, bookTitle, author: author ?? '', coverUrl: coverUrl ?? '' }];
  await updateDoc(doc(db, 'students', currentUser.uid), { currentlyReading: updated });
  studentData.currentlyReading = updated;
  filterAndRenderBooks();
  if (document.getElementById('profilePage')?.classList.contains('active')) renderProfileCurrentBook();
  toast(`<i class='bi bi-book-fill'></i> "${esc(bookTitle)}" added to your reading list`, 'success');
}

async function removeFromCurrentlyReading(bookId) {
  const updated = (studentData.currentlyReading ?? []).filter(r => r.bookId !== bookId);
  await updateDoc(doc(db, 'students', currentUser.uid), { currentlyReading: updated });
  studentData.currentlyReading = updated;
  filterAndRenderBooks();
  if (document.getElementById('profilePage')?.classList.contains('active')) renderProfileCurrentBook();
  toast('Removed from reading list', 'info');
}

async function renderMyRecommendations() {
  const el = document.getElementById('myRecommendations');
  if (!el) return;
  const snap = await getDocs(collection(db, 'students', currentUser.uid, 'recommendations'));
  if (snap.empty) { el.innerHTML = `<p class='empty-state'>No recommendations yet. Hit <i class='bi bi-star'></i> Recommend on any book in the library!</p>`; return; }
  el.innerHTML = '';
  snap.forEach(d => {
    const r    = d.data();
    const item = document.createElement('div');
    item.className = 'book-row';
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      ${r.coverUrl ? `<img src='${esc(r.coverUrl)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-star-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'><i class='bi bi-star-fill' style='color:var(--accent);font-size:0.65rem'></i> ${esc(r.bookTitle)}</div>
          <div class='book-author'>${esc(r.author ?? '')}</div>
        </div>
        <button class='btn btn--xs' data-recid='${esc(d.id)}' data-bookid='${esc(r.bookId)}'><i class='bi bi-x'></i> Remove</button>
      </div>`;
    item.querySelector('[data-recid]')?.addEventListener('click', async (e) => {
      await deleteDoc(doc(db, 'students', currentUser.uid, 'recommendations', e.currentTarget.dataset.recid));
      studentData.myRecIds?.delete(e.currentTarget.dataset.bookid);
      filterAndRenderBooks();
      renderMyRecommendations();
    });
    el.appendChild(item);
  });
}

// ── Wishlist notifications (real-time) ────────────────────────────────────────
async function setupWishlistNotifications() {
  const wishlist = studentData?.wishlist ?? [];
  wishlistListeners.forEach(u => u());
  wishlistListeners = [];
  if (!selectedTeacherId || wishlist.length === 0) return;
  wishlist.forEach(bookId => {
    const unsubscribe = onSnapshot(doc(db, 'teachers', selectedTeacherId, 'books', bookId), snap => {
      if (!snap.exists()) return;
      const book = snap.data();
      if (book.status === 'available' && !studentData.currentBook)
        toast(`<i class='bi bi-collection-fill'></i> "${esc(book.title)}" is now available!`, 'success');
    });
    wishlistListeners.push(unsubscribe);
  });
}
