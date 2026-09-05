// teacher.js — BookWare Teacher Portal (UI layer).
//
// This file renders and wires the portal. It does NOT talk to Firestore: every
// read and write goes through teacher-api.js. If you find yourself importing
// firebase-firestore here, the logic belongs in teacher-api.js instead.
//
// See ../TEACHER_BACKEND.md for the data model, and ../../CLAUDE.md for how the
// two halves fit together.

import { auth } from './firebase.js';
import { ADMIN_EMAILS, shouldForceLogout, buildJoinUrl, isTeacherEmail as isEmailAllowed } from './config.js';
import { lookupISBN, lookupBarcode, searchBooks, initCoverFallback } from './books.js';
import { startScanner, isScanSupported } from './barcode.js';
import {
  initTheme, initARIA, initAriaChat, initAriaRecommends, refreshAriaChats,
  initSettingsModal, openSettingsModal, closeSettingsModal, initStaySignedIn, setAriaAvailability,
} from './theme.js';
import { runReadingQuiz } from './quiz.js';
import { runWelcomeTour } from './welcome.js';
import { setQrImage } from './qr.js';
import { hidePreloader } from './preloader.js';
import { HISTORY_RETENTION_DAYS } from './retention.js';
import * as api from './teacher-api.js';
import {
  signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ── State ─────────────────────────────────────────────────────────────────────
// Everything here is a cache of what the API last returned. It is never the
// source of truth, and nothing is written to it that wasn't read back from a
// successful call.
let me                   = null;   // { uid, email, role, teacher }
let allBooks             = [];
let allClasses           = [];
let openLoans            = [];     // history rows with dateReturned == null
let recommendations      = [];
let bookSearchResults    = [];
let recGoogleResults     = [];
let readingSearchResults = [];
let recGoogleDebounce    = null;
let stopHistoryWatch     = null;

const teacherData = () => me?.teacher ?? null;

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** One escaped, human-readable line for any error the API can throw. */
function describeError(err) {
  if (!err) return 'unknown error';
  const msg  = err.message ?? String(err);
  const hint = err.hint ? `. ${err.hint}` : '';
  return esc(`${msg}${hint}`);
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

/** Report a failed action. Errors from the API already carry the explanation;
 *  this just puts it somewhere the teacher will see it. */
function toastError(err, type = 'danger') {
  toast(describeError(err), type);
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Panel-level failure state with a way out, so no panel can sit on "Loading…"
 *  forever with nothing to click. */
function renderPanelError(el, what, err) {
  if (!el) return;
  el.innerHTML = `
    <p class='empty-state' style='color:var(--danger)'>
      <i class='bi bi-exclamation-triangle-fill' aria-hidden='true'></i>
      Couldn't load ${esc(what)}: ${describeError(err)}
    </p>`;
  const btn = document.createElement('button');
  btn.className = 'btn btn--sm';
  btn.innerHTML = `<i class='bi bi-arrow-clockwise' aria-hidden='true'></i> Retry`;
  btn.addEventListener('click', () => window.location.reload());
  el.appendChild(btn);
}

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

/** Run one start-up step in isolation.
 *
 *  Start-up is a sequence of independent loads. Run as one chain, the first
 *  failure silently cancelled everything after it — which is what left the
 *  Library tab's panels on "Loading…" until a nav round-trip re-ran them. A
 *  step that fails now names itself and lets the rest of the portal carry on. */
async function step(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[teacher] start-up step "${label}" failed:`, err);
    toast(`Couldn't load ${esc(label)}: ${describeError(err)} <button class="toast-retry" data-retry="1">Retry</button>`, 'danger');
    return null;
  }
}

// Any "Retry" offered in a failure toast just reloads — every start-up step is
// idempotent, and a reload is more reliable than resuming from a partial state.
document.getElementById('toastContainer')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-retry]')) window.location.reload();
});

// ── Sidebar + routing ─────────────────────────────────────────────────────────
document.getElementById('sidebarToggle')?.addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  const collapsed = sb.classList.toggle('collapsed');
  document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(!collapsed));
});

const PAGE_TITLES = {
  library: 'Library', students: 'Students', reading: 'Now Reading',
  recommendations: 'Recommendations', invites: 'Invite Teachers', settings: 'Settings',
};

document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

function showPage(name) {
  if (name === 'settings') { openSettingsModal(); return; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => { n.classList.remove('active'); n.removeAttribute('aria-current'); });
  document.getElementById(name + 'Page')?.classList.add('active');
  document.querySelectorAll(`[data-page="${name}"]`).forEach(btn => {
    btn.classList.add('active');
    btn.setAttribute('aria-current', 'page');
  });
  const pt = document.getElementById('pageTitle');
  if (pt) pt.textContent = PAGE_TITLES[name] ?? name;

  if (name === 'library')         { loadCheckedOut(); startHistoryWatch(); }
  if (name === 'students')        { loadActiveBans(); loadRoster(); loadPendingRequests(); }
  if (name === 'recommendations') { renderRecommendationsList(); renderRecPicker(); renderRecReadingDisplay(); }
  if (name === 'invites')         { loadPastInvites(); }
  if (name === 'reading')         { renderReadingPicker(); renderReadingDisplay(); renderReadingPreview(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Auth + start-up
// ═══════════════════════════════════════════════════════════════════════════

// Bound at module scope, NOT inside the auth handler. The way out of the app
// must never depend on the app having finished loading — wired further down
// the chain, any step that threw above it left Sign Out doing nothing at all.
document.getElementById('signoutBar')?.addEventListener('click', () => signOut(auth));
document.getElementById('sidebarSignoutBtn')?.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) { api.closeTeacherSession(); window.location.href = '/'; return; }
  document.documentElement.style.visibility = 'visible';

  if (!isEmailAllowed(user.email)) { await signOut(auth); window.location.href = '/'; return; }

  // ── Gates ──
  // admin/settings carries both the access gates and the school-wide ARIA
  // policy. Admins are exempt from the gates but not from the ARIA policy, so
  // the read happens for everyone and only the gating is conditional. This
  // never throws — a school that never touched these settings gets defaults.
  const { snap: settingsSnap, settings } = await api.readAdminSettings();
  const isAllowlistedAdmin = ADMIN_EMAILS.includes(user.email?.toLowerCase());
  if (!isAllowlistedAdmin) {
    if (settings.maintenanceMode === true) {
      await signOut(auth);
      alert('BookWare is currently under maintenance. Please check back soon.');
      window.location.href = '/';
      return;
    }
    if (settingsSnap && shouldForceLogout(settingsSnap, user)) {
      await signOut(auth);
      window.location.href = '/';
      return;
    }
  }
  setAriaAvailability(
    settings.ariaTeachersEnabled !== false,
    'ARIA has been turned off for teachers by a school administrator.',
  );

  // ── Session ──
  try {
    const opened = await api.openTeacherSession(user);
    me = api.currentSession();
    if (opened.created) {
      toast(`<i class='bi bi-check2'></i> Teacher workspace created for ${esc(user.email ?? 'your account')}.`, 'success');
    }
  } catch (err) {
    hidePreloader();
    if (err.code === 'bw/not-a-teacher') { await signOut(auth); window.location.href = '/'; return; }
    toastError(err);
    return;
  }

  // ── Chrome that needs nothing but the session ──
  populateTopBar();
  initCoverFallback();
  renderSettings();
  initTheme();
  initARIA(toast);
  initAriaChat('ariaChatMount', 'teacher', () => teacherData()?.readingProfile);
  initAriaRecommends('ariaRecommendsMount', 'teacher', () => teacherData()?.readingProfile);
  initStaySignedIn((stay) => setPersistence(auth, stay ? browserLocalPersistence : browserSessionPersistence));
  initSettingsModal();
  initVisibilityToggle();
  initCheckoutMode();
  setupRetakeQuiz();
  setupReplayIntro();
  setupSignout();
  initBarcodeScan();

  if (!sessionStorage.getItem('bw-welcomed')) {
    const first = (user.displayName ?? '').split(' ')[0] || 'there';
    setTimeout(() => toast(`Welcome back, ${esc(first)} <i class='bi bi-hand-wave-fill'></i>`, 'success'), 800);
    sessionStorage.setItem('bw-welcomed', '1');
  }

  // ── Data ──
  // Only the default-visible Library list has to be ready before the splash
  // comes down; renderLibraryList() badges recommended books, so that pair
  // stays sequential. Everything else has its own placeholder and finishes
  // afterwards — waiting on all of it just moved the complaint from a blank
  // page to a stuck spinner.
  await step('recommendations', () => loadRecommendations());
  await step('your books', () => loadLibrary());
  hidePreloader();

  // Fire-and-forget over the already-loaded portal. Opening a modal while the
  // splash is still up is how an intro ends up looking like it never fired.
  runFirstRunOnboarding();

  // The Library page is active by default, so showPage() never fires for it.
  // Deliberately not awaited and not chained: these read different collections
  // and none needs another's result, so one slow read can't hold the rest on
  // "Loading…".
  // The check-in banner lists the open loans, so it is chained behind them
  // rather than raced against them.
  step('checked-out books', () => loadCheckedOut().then(checkBiweeklyNotification));
  step('checkout history',  () => startHistoryWatch());
  step('now reading',       () => loadCurrentlyReading());

  // Classes drive the Students tab and the class-code cards. They used to sit
  // behind the retention sweep, so on a big library the codes stayed on
  // "Loading classes…" for as long as that took. The sweep goes last.
  await step('classes', () => loadClasses());

  const purged = await api.runRetention();
  if (purged) {
    const bits = [];
    if (purged.students) bits.push(`${plural(purged.students, 'student record')} from ${plural(purged.classes, 'ended class', 'ended classes')}`);
    if (purged.history)  bits.push(`${plural(purged.history, 'checkout record')} over ${Math.round(HISTORY_RETENTION_DAYS / 365)} years old`);
    toast(`<i class='bi bi-shield-check'></i> Auto-deleted ${bits.join(' and ')}.`, 'info');
    await step('classes', () => loadClasses());
  }

  await step('school-year prompt', () => requireSchoolYearEndDates());
});

function setupSignout() {
  const hint = document.getElementById('signoutEmail');
  if (hint && me) hint.textContent = me.email;
}

function populateTopBar() {
  const av      = document.getElementById('userAvatar');
  const nameEl  = document.getElementById('userDisplayName');
  const display = auth.currentUser?.displayName ?? me?.email ?? '?';
  const initials = display.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  if (av)     av.textContent     = initials;
  if (nameEl) nameEl.textContent = display.split(' ')[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// First-run onboarding
// ═══════════════════════════════════════════════════════════════════════════

async function runFirstRunOnboarding() {
  await maybeRunWelcomeTour();
  await maybeRunOnboardingQuiz();
}

async function maybeRunWelcomeTour() {
  if (teacherData()?.welcomeSeenAt) return;
  await showWelcomeTour();
}

async function showWelcomeTour() {
  // welcome.js holds no Firestore import, so the display-name step is handed
  // the save function from here. Passing nothing would give the old tour.
  await runWelcomeTour('teacher', {
    nameStep: {
      initial:  teacherData()?.displayName ?? '',
      fallback: teacherData()?.name || 'your account name',
      onSave:   (value) => api.setDisplayName(value),
    },
  });
  // The tour can have just written displayName, and the Settings panel may
  // already have been rendered with the old value.
  renderSettings();
  // Worst case the tour shows once more — not worth a visible error.
  try { await api.markWelcomeSeen(); } catch (err) { console.warn('[teacher] could not record the tour as seen:', err); }
}

function setupReplayIntro() {
  const btn = document.getElementById('replayIntroBtn');
  btn?.addEventListener('click', () => {
    closeSettingsModal();
    btn.disabled = true;
    showWelcomeTour().finally(() => { btn.disabled = false; });
  });
}

async function maybeRunOnboardingQuiz() {
  if (teacherData()?.readingProfile) return;   // already taken (or skipped)
  await runQuizFlow({ isFirstRun: true });
}

async function runQuizFlow({ isFirstRun }) {
  try {
    const answers = await runReadingQuiz('teacher');
    const profile = answers ? { ...answers, completedAt: new Date() } : { skipped: true, skippedAt: new Date() };
    await api.setReadingProfile(profile);
    if (answers) {
      toast(`<i class="bi bi-stars"></i> Thanks! ARIA now knows what to recommend for you and your shelves.`, 'success');
      refreshAriaChats();
    } else if (!isFirstRun) {
      toast('No worries; you can take the quiz from here whenever you like.', 'info');
    }
  } catch (err) {
    console.error('[teacher] reading quiz failed:', err);
    toastError(err);
  }
}

function setupRetakeQuiz() {
  const btn = document.getElementById('retakeQuizBtn');
  btn?.addEventListener('click', () => {
    btn.disabled = true;
    runQuizFlow({ isFirstRun: false }).finally(() => { btn.disabled = false; });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings panel
// ═══════════════════════════════════════════════════════════════════════════

function renderSettings() {
  const t     = teacherData();
  const email = me?.email ?? '—';
  const sub   = document.getElementById('settingsEmailSub');
  if (sub) sub.textContent = email;

  const acct = document.getElementById('accountInfoSection');
  if (acct && t) {
    acct.innerHTML = `
      <div class='settings-row' style='border-top:none'>
        <div class='settings-label'>Account Name</div>
        <span class='muted-text small-text'>${esc(t.name ?? '—')}</span>
      </div>
      <div class='settings-row'>
        <div class='settings-label'>Email</div>
        <span class='muted-text small-text'>${esc(email)}</span>
      </div>
      <div class='settings-row'>
        <div class='settings-label'>Member Since</div>
        <span class='muted-text small-text'>${fmtDate(t.createdAt)}</span>
      </div>
      <div class='settings-row settings-row--col'>
        <div>
          <div class='settings-label'>Display Name</div>
          <div class='settings-hint'>
            What students see on their library list and join emails. Leave it
            blank to use your account name; change it whenever you like.
          </div>
        </div>
        <div class='aria-key-row-input'>
          <input type='text' id='displayNameInput' class='text-input' maxlength='60'
                 autocomplete='off' aria-label='Display name'
                 placeholder='${esc(t.name ?? 'Your name')}'
                 value='${esc(t.displayName ?? '')}' />
          <button type='button' class='btn btn--sm' id='displayNameSaveBtn'>Save</button>
        </div>
        <div class='settings-hint' id='displayNamePreview' style='margin-top:6px'></div>
      </div>`;
    wireDisplayName();
  }

  const badge   = document.getElementById('canInviteSettingsBadge');
  const invChip = document.getElementById('canInviteStatus');
  if (badge)   { badge.textContent   = 'All teachers'; badge.style.color   = 'var(--success)'; }
  if (invChip) { invChip.textContent = 'All teachers can invite'; invChip.style.color = 'var(--success)'; }

  renderRetentionBadges();
}

/** Display-name row: live preview of the student-side label, plus save.
 *
 *  The preview matters more than it looks. The field is empty for anyone who
 *  has never set one, and an empty box next to "Display Name" reads as "your
 *  students see nothing" rather than "your students see your account name".
 *  Showing the resolved label removes that guess. */
function wireDisplayName() {
  const input = document.getElementById('displayNameInput');
  const btn   = document.getElementById('displayNameSaveBtn');
  const prev  = document.getElementById('displayNamePreview');
  if (!input || !btn) return;

  // Same fallback order as teacherLabel() in student.js. The two are separate
  // portals with no shared module, so this has to be kept in step by hand.
  // Matches setDisplayName() in teacher-api.js and tidyName() in welcome.js:
  // the preview must show the value that will actually be stored.
  const resolve = v => String(v ?? '').trim().replace(/\s+/g, ' ')
    || teacherData()?.name || 'Library';
  const paint   = () => {
    if (prev) prev.textContent = `Students see: ${resolve(input.value)}`;
  };
  paint();
  input.addEventListener('input', paint);

  btn.addEventListener('click', async () => {
    const wanted = input.value;
    btn.disabled = true;
    try {
      const saved = await api.setDisplayName(wanted);
      input.value = saved;
      paint();
      toast(
        saved
          ? `<i class='bi bi-check2'></i> Students now see "${esc(saved)}"`
          : `<i class='bi bi-check2'></i> Display name cleared; students see your account name`,
        'success',
      );
    } catch (err) {
      toast(`Couldn't save your display name: ${describeError(err)}`, 'danger');
    } finally {
      btn.disabled = false;
    }
  });

  input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
}

/** Show the teacher concretely when their student data disappears, rather than
 *  only stating the policy in the abstract. */
function renderRetentionBadges() {
  const rosterEl  = document.getElementById('rosterRetentionBadge');
  const historyEl = document.getElementById('historyRetentionBadge');

  if (rosterEl) {
    const dated = allClasses.filter(c => c.endDate);
    if (!allClasses.length) {
      rosterEl.textContent = 'No classes yet';
      rosterEl.style.color = '';
    } else if (!dated.length) {
      rosterEl.textContent = 'No date set';
      rosterEl.style.color = 'var(--danger)';
    } else {
      const next = dated.map(c => api.endOfDay(c.endDate)).filter(Boolean).sort((a, b) => a - b)[0];
      rosterEl.textContent = `Next: ${fmtDate(next)}`;
      rosterEl.style.color = 'var(--success)';
    }
  }

  if (historyEl) {
    historyEl.textContent = `${Math.round(HISTORY_RETENTION_DAYS / 365)} years`;
    historyEl.style.color = 'var(--success)';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// School-year end date (the data-retention control)
// ═══════════════════════════════════════════════════════════════════════════
// Every class must carry a last day of school. On that date the roster (student
// names + emails) is deleted and firestore.rules stops serving it, so a teacher
// keeps no student data past the year they taught them.

/** Default suggestion: next June 4th (typical Mason last day). */
function defaultEndDate() {
  const now  = new Date();
  const year = now.getMonth() > 5 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-06-04`;
}

/** A stored endDate as a YYYY-MM-DD value for <input type="date">. */
function endDateInputValue(endDate) {
  const d = api.endOfDay(endDate);
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Prompt for a last day of school on every class that lacks one. */
async function requireSchoolYearEndDates() {
  const modal = document.getElementById('schoolYearModal');
  const list  = document.getElementById('schoolYearClassList');
  const save  = document.getElementById('schoolYearSaveBtn');
  const later = document.getElementById('schoolYearLaterBtn');
  const hint  = document.getElementById('schoolYearHint');
  if (!modal || !list || !save) return;

  // Asked once already this session — don't trap the teacher out of every other
  // feature on every page. The roster stays flagged in Settings regardless.
  if (sessionStorage.getItem('bw-schoolyear-dismissed')) return;

  const missing = allClasses.filter(c => !c.endDate);
  if (!missing.length) { modal.hidden = true; return; }

  if (later) later.onclick = () => {
    sessionStorage.setItem('bw-schoolyear-dismissed', '1');
    modal.hidden = true;
  };

  const today = todayISO();
  list.innerHTML = missing.map(c => `
    <div class='settings-row'>
      <div>
        <div class='settings-label'>${esc(c.name)}</div>
        <div class='settings-hint'>${plural(c.studentCount ?? 0, 'student')}</div>
      </div>
      <input type='date' class='text-input school-year-input' style='max-width:190px'
             data-cid='${esc(c.id)}' min='${today}' value='${defaultEndDate()}'
             aria-label='Last day of school for ${esc(c.name)}' />
    </div>`).join('');
  modal.hidden = false;

  save.onclick = async () => {
    const inputs = [...list.querySelectorAll('.school-year-input')];
    const fail = (m) => { if (hint) { hint.textContent = m; hint.style.color = 'var(--danger)'; } };
    if (inputs.some(i => !i.value))          return fail('Pick a date for every class.');
    if (inputs.some(i => i.value < today))   return fail("The last day of school can't be in the past.");

    save.disabled = true;
    if (hint) { hint.textContent = 'Saving…'; hint.style.color = ''; }
    try {
      for (const input of inputs) {
        const stamp = await api.setClassEndDate(input.dataset.cid, input.value);
        const cls = allClasses.find(c => c.id === input.dataset.cid);
        if (cls) cls.endDate = stamp;
      }
      modal.hidden = true;
      renderClassManager();
      toast(`<i class='bi bi-shield-check'></i> Last day of school saved; rosters delete themselves on that date.`, 'success');
    } catch (err) {
      fail(`Save failed: ${describeError(err)}`);
    } finally {
      save.disabled = false;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Classes
// ═══════════════════════════════════════════════════════════════════════════

async function loadClasses() {
  const container = document.getElementById('classManagerContainer');
  if (container && !container.children.length) {
    container.innerHTML = `<p class='empty-state loading-state'>Loading classes…</p>`;
  }
  try {
    allClasses = await api.listClasses();
  } catch (err) {
    if (container) renderPanelError(container, 'your classes', err);
    throw err;
  }
  renderClassManager();
  refreshVisibilityStats();
}

function renderClassManager() {
  const container = document.getElementById('classManagerContainer');
  if (!container) return;
  container.innerHTML = '';

  allClasses.forEach(cls => {
    const card = document.createElement('div');
    card.className = 'class-card';
    const endLabel = cls.endDate
      ? `Roster auto-deletes ${esc(endDateInputValue(cls.endDate))}`
      : '<span style="color:var(--danger)">No last day of school set</span>';

    card.innerHTML = `
      <div class='class-card-header'>
        <div>
          <div class='class-card-name'>${esc(cls.name)}</div>
          <div class='class-card-meta'>${plural(cls.studentCount ?? 0, 'student')}</div>
          <div class='class-card-meta' style='display:flex;align-items:center;gap:6px;margin-top:2px'>
            <i class='bi bi-shield-lock-fill' aria-hidden='true'></i> ${endLabel}
            <button class='btn btn--xs' data-action='end-date'>Change</button>
          </div>
        </div>
        <div style='display:flex;gap:6px;align-items:center'>
          <button class='btn btn--xs' data-action='rename'><i class='bi bi-pencil-fill'></i> Rename</button>
          <button class='btn btn--xs danger' data-action='delete-class'><i class='bi bi-trash3-fill'></i></button>
        </div>
      </div>
      <div class='code-box'>
        <span class='code-val'>${esc(cls.inviteCode ?? '—')}</span>
        <div class='code-box-btns'>
          <button class='btn btn--sm' data-action='copy-code'>Copy</button>
          <button class='btn btn--sm' data-action='share'><i class='bi bi-qr-code'></i> Link &amp; QR</button>
          <button class='btn btn--sm' data-action='refresh-code'><i class='bi bi-arrow-clockwise'></i> New</button>
        </div>
      </div>
      <!-- Same code, two easier ways to hand it out: a link students can tap and
           a QR they can scan. Both land on "/?join=CODE", which fills the code
           in for them (see consumePendingJoinCode in student.js). -->
      <div class='join-share' hidden>
        <div class='join-share-url' data-join-url></div>
        <div class='join-share-body'>
          <img class='join-share-qr' alt='QR code to join ${esc(cls.name)}' src='' />
          <div class='join-share-actions'>
            <button class='btn btn--sm' data-action='copy-link'><i class='bi bi-clipboard'></i> Copy link</button>
            <button class='btn btn--sm' data-action='email-link'><i class='bi bi-envelope-fill'></i> Share by email</button>
            <p class='join-share-hint'>Project the QR code, or send the link. Students who follow it sign in and join <strong>${esc(cls.name)}</strong> automatically, with no code to type in.</p>
          </div>
        </div>
      </div>
      ${cls.codeLive === false ? `
        <div class='class-code-dead' role='alert'>
          <i class='bi bi-exclamation-triangle-fill' aria-hidden='true'></i>
          <span>
            <strong>Students can't join with this code yet.</strong>
            It isn't registered for lookup${cls.codeError ? `: <code>${esc(cls.codeError)}</code>` : ''}.
          </span>
          <button class='btn btn--xs' data-action='fix-code'>Retry</button>
        </div>` : ''}`;

    const on = (action, handler) => card.querySelector(`[data-action="${action}"]`)?.addEventListener('click', handler);
    const joinUrl = cls.inviteCode ? buildJoinUrl(cls.inviteCode) : '';

    on('fix-code', async (e) => {
      e.currentTarget.disabled = true;
      const res = await api.ensureClassCodeMapping(cls.inviteCode, cls.id, { createdAt: cls.createdAt });
      cls.codeLive = res.live; cls.codeError = res.error; cls.inviteCode = res.code;
      toast(res.live
        ? `<i class='bi bi-check2'></i> Code ${esc(res.code)} is live; students can join with it now`
        : `Still failing: ${esc(res.error ?? 'unknown')}`, res.live ? 'success' : 'danger');
      renderClassManager();
    });
    on('rename',       () => renameClass(cls));
    on('delete-class', () => deleteClass(cls));
    on('end-date',     () => editClassEndDate(cls));
    on('refresh-code', () => refreshClassCode(cls));
    on('copy-code',    () => copyText(cls.inviteCode, `Code for ${cls.name} copied`));
    on('copy-link',    () => copyText(joinUrl, `Join link for ${cls.name} copied`));
    on('email-link',   () => shareJoinLinkByEmail(cls, joinUrl));

    const shareBox   = card.querySelector('.join-share');
    const shareQr    = shareBox?.querySelector('.join-share-qr');
    const shareUrlEl = shareBox?.querySelector('[data-join-url]');
    if (shareUrlEl) shareUrlEl.textContent = joinUrl;
    on('share', () => {
      if (!shareBox) return;
      shareBox.hidden = !shareBox.hidden;
      // Generate the QR lazily — the library is a ~40 KB import and most page
      // loads never open one of these panels.
      if (!shareBox.hidden && shareQr && !shareQr.dataset.qrReady) setQrImage(shareQr, joinUrl, 240);
    });

    container.appendChild(card);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn--ghost btn--sm';
  addBtn.style.marginTop = '10px';
  addBtn.innerHTML = '<i class="bi bi-plus-lg"></i> Add Class / Period';
  addBtn.addEventListener('click', createClass);
  container.appendChild(addBtn);

  // Settings renders before classes load, so refresh the retention summary
  // whenever the class list changes.
  renderRetentionBadges();
}

function copyText(text, successMsg) {
  if (!text) return;
  navigator.clipboard.writeText(text)
    .then(() => toast(`<i class='bi bi-check2'></i> ${esc(successMsg)}`, 'success'))
    .catch(() => toast(`Copy failed. Here it is to copy by hand: ${esc(text)}`, 'info'));
}

function shareJoinLinkByEmail(cls, joinUrl) {
  const subject = encodeURIComponent(`Join our BookWare class library: ${cls.name}`);
  const body = encodeURIComponent(
    `Hi,\n\nUse this link to join our classroom library on BookWare:\n${joinUrl}\n\n` +
    `Sign in with your school Google account and you'll be added to ${cls.name} automatically.\n\n` +
    `If the link doesn't work, sign in at ${window.location.origin} and enter the class code ${cls.inviteCode} under Settings → Teacher Libraries.\n\n` +
    `– ${teacherName()}`,
  );
  window.open(`mailto:?subject=${subject}&body=${body}`);
}

/** Ask for a date in YYYY-MM-DD, validating before it reaches the API. */
function promptForEndDate(message, initial) {
  const val = prompt(message, initial)?.trim();
  if (!val) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || !api.endOfDay(val)) {
    toast('Date must look like 2027-06-04.', 'danger');
    return null;
  }
  if (val < todayISO()) { toast('That date is in the past.', 'danger'); return null; }
  return val;
}

async function createClass() {
  const name = prompt('Class name (e.g. Period 3, English 10B):')?.trim();
  if (!name) return;

  // Required: a class cannot exist without a deletion date for its roster.
  const endDate = promptForEndDate(
    `Last day of school for "${name}" (YYYY-MM-DD).\n\n` +
    `On this date the roster, meaning student names and emails, is deleted automatically ` +
    `and you lose access to it.`,
    defaultEndDate(),
  );
  if (!endDate) { toast('Class not created: a last day of school is required.', 'danger'); return; }

  try {
    const cls = await api.createClass({ name, endDate });
    allClasses.push(cls);
    renderClassManager();
    toast(cls.codeLive
      ? `<i class='bi bi-check2'></i> "${esc(name)}" created, code: ${esc(cls.inviteCode)}`
      : `"${esc(name)}" created, but its code isn't usable yet (${esc(cls.codeError ?? 'unknown')}). See the warning on the class.`,
      cls.codeLive ? 'success' : 'danger');
  } catch (err) { toastError(err); }
}

async function renameClass(cls) {
  const name = prompt('New name:', cls.name)?.trim();
  if (!name || name === cls.name) return;
  try {
    await api.renameClass(cls.id, name);
    cls.name = name;
    renderClassManager();
    if (document.getElementById('studentsPage')?.classList.contains('active')) loadRoster();
    toast(`<i class='bi bi-check2'></i> Renamed to "${esc(name)}"`, 'success');
  } catch (err) { toastError(err); }
}

async function editClassEndDate(cls) {
  const val = promptForEndDate(
    `Last day of school for "${cls.name}" (YYYY-MM-DD).\n\n` +
    `The roster is deleted automatically on this date.`,
    endDateInputValue(cls.endDate) || defaultEndDate(),
  );
  if (!val) return;
  try {
    cls.endDate = await api.setClassEndDate(cls.id, val);
    renderClassManager();
    toast(`<i class='bi bi-check2'></i> Roster for "${esc(cls.name)}" now deletes on ${esc(val)}`, 'success');
  } catch (err) { toastError(err); }
}

async function refreshClassCode(cls) {
  try {
    const oldCode = cls.inviteCode;
    cls.inviteCode = await api.rotateClassCode(cls.id, oldCode);
    cls.codeLive = true;
    cls.codeError = null;
    renderClassManager();
    toast(`<i class='bi bi-check2'></i> New code for ${esc(cls.name)}; existing students are unaffected`, 'success');
  } catch (err) { toastError(err); }
}

async function deleteClass(cls) {
  const count = cls.studentCount ?? 0;
  const msg = count > 0
    ? `"${cls.name}" has ${plural(count, 'student')}.\n\nDeleting removes the roster but keeps the shared library. Students can rejoin via another class code.\n\nContinue?`
    : `Delete class "${cls.name}"? This cannot be undone.`;
  if (!confirm(msg)) return;
  try {
    await api.deleteClass(cls.id, cls.inviteCode);
    allClasses = allClasses.filter(c => c.id !== cls.id);
    renderClassManager();
    toast(`<i class='bi bi-check2'></i> "${esc(cls.name)}" deleted`, 'success');
  } catch (err) { toastError(err); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Library visibility + checkout mode
// ═══════════════════════════════════════════════════════════════════════════

function initVisibilityToggle() {
  const toggle = document.getElementById('libraryPublicToggle');
  if (!toggle) return;
  const isPublic = teacherData()?.libraryPublic === true;
  toggle.checked = isPublic;
  updateVisUI(isPublic);

  toggle.addEventListener('change', async () => {
    const nowPublic = toggle.checked;
    updateVisUI(nowPublic);                       // optimistic
    try {
      await api.setLibraryPublic(nowPublic);
    } catch (err) {
      toggle.checked = !nowPublic;                // revert on failure — the old
      updateVisUI(!nowPublic);                    // code left the switch lying
      toastError(err);
      return;
    }
    toast(nowPublic
      ? `<i class='bi bi-collection-fill'></i> Library is now <strong>Public</strong>`
      : `<i class='bi bi-lock-fill'></i> Library is now <strong>Class Only</strong>`, 'success');
  });
}

/** Re-render the public-library stats line from whatever is currently loaded.
 *  The toggle is wired before any data arrives — without this the line reads
 *  "0 enrolled students, 0 books" until the next reload. */
function refreshVisibilityStats() {
  if (document.getElementById('libraryPublicToggle')?.checked) updateVisUI(true);
}

function updateVisUI(isPublic) {
  const hint   = document.getElementById('visibilityHint');
  const detail = document.getElementById('visibilityDetail');
  if (hint) hint.textContent = isPublic ? 'Public: any Mason student can discover it' : 'Class Only';
  if (!detail) return;
  if (!isPublic) { detail.hidden = true; return; }

  // Counts come from data already loaded — no extra reads. The old version
  // re-read every class roster in full just to render this line.
  detail.hidden = false;
  const enrolled = allClasses.reduce((n, c) => n + (c.studentCount ?? 0), 0);
  const books    = allBooks.length;
  const out      = allBooks.filter(b => api.outCount(b) > 0).length;
  detail.innerHTML = `
    <div style='display:flex;gap:16px;flex-wrap:wrap;font-size:0.72rem;color:var(--text-3);padding:10px 12px;background:var(--bg-inset);border-radius:var(--r-sm)'>
      <span><strong style='color:var(--text)'>${enrolled}</strong> enrolled student${enrolled !== 1 ? 's' : ''}</span>
      <span><strong style='color:var(--text)'>${books}</strong> book${books !== 1 ? 's' : ''}</span>
      <span><strong style='color:var(--accent)'>${out}</strong> checked out</span>
    </div>
    <p class='muted-text small-text' style='margin-top:8px'><i class='bi bi-info-circle'></i> Discoverable to all Mason students, though checkout still requires a class code.</p>`;
}

// Two named modes rather than one "Require Checkout Approval" switch whose off
// state said nothing about what students could actually do. Stored as the same
// `requireApproval` boolean, so existing libraries keep their setting.
//
//   Automatic     (false) — the student's Check Out button runs the checkout
//                 transaction directly (requestCheckout in student.js).
//   Ask me first  (true)  — the button files a request; approveRequest() below
//                 performs the checkout and writes the loan record.
function initCheckoutMode() {
  const picker = document.querySelector('.mode-picker');
  if (!picker) return;

  const paint = (requireApproval) => {
    picker.querySelectorAll('.mode-opt').forEach(btn => {
      const isOn = (btn.dataset.mode === 'approval') === requireApproval;
      btn.classList.toggle('mode-opt--active', isOn);
      btn.setAttribute('aria-checked', String(isOn));
    });
  };
  paint(teacherData()?.requireApproval === true);

  picker.querySelectorAll('.mode-opt').forEach(btn => {
    btn.addEventListener('click', async () => {
      const wantApproval = btn.dataset.mode === 'approval';
      if ((teacherData()?.requireApproval === true) === wantApproval) return;
      paint(wantApproval);                        // optimistic
      try {
        await api.setRequireApproval(wantApproval);
      } catch (err) {
        paint(teacherData()?.requireApproval === true);
        toastError(err);
        return;
      }
      toast(wantApproval
        ? `<i class='bi bi-person-check-fill'></i> Students now <strong>request</strong> books; approve them on the Students tab`
        : `<i class='bi bi-lightning-charge-fill'></i> Students can now <strong>check out books themselves</strong>`,
        'success');
      if (wantApproval) loadPendingRequests();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Pending checkout requests
// ═══════════════════════════════════════════════════════════════════════════

async function loadPendingRequests() {
  const card    = document.getElementById('pendingRequestsCard');
  const listEl  = document.getElementById('pendingRequestsList');
  const countEl = document.getElementById('pendingRequestsCount');
  if (!card || !listEl) return;

  let requests;
  try {
    requests = await api.listPendingRequests();
  } catch (err) {
    card.hidden = false;
    renderPanelError(listEl, 'checkout requests', err);
    return;
  }

  if (!requests.length) { card.hidden = true; return; }
  card.hidden = false;
  if (countEl) countEl.textContent = `${requests.length} pending`;
  listEl.innerHTML = '';

  requests.forEach(req => {
    const book = allBooks.find(b => b.id === req.bookId);
    const cover = book?.coverUrl || req.coverUrl || '';
    const row = document.createElement('div');
    row.className = 'request-card';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      ${cover ? `<img src='${esc(cover)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='flex:1;min-width:0'>
        <div class='book-title'>${esc(req.bookTitle)}</div>
        <div class='book-author'>Requested by <strong>${esc(req.studentName)}</strong> · ${fmtDate(req.requestedAt)}</div>
      </div>
      <div style='display:flex;gap:6px;flex-shrink:0'>
        <button class='btn btn--xs success' data-action='approve'><i class='bi bi-check2'></i> Approve</button>
        <button class='btn btn--xs danger'  data-action='deny'><i class='bi bi-x'></i> Deny</button>
      </div>`;

    row.querySelector('[data-action="approve"]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.approveRequest({ requestId: req.id, bookId: req.bookId, studentId: req.studentId });
        toast(`<i class='bi bi-check2'></i> Approved: "${esc(req.bookTitle)}" is checked out`, 'success');
      } catch (err) {
        e.currentTarget.disabled = false;
        toastError(err);
        return;
      }
      await refreshAfterLoanChange();
      loadPendingRequests();
    });

    row.querySelector('[data-action="deny"]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.denyRequest(req.id);
        toast('Request denied.', 'info');
        loadPendingRequests();
      } catch (err) {
        e.currentTarget.disabled = false;
        toastError(err);
      }
    });

    listEl.appendChild(row);
  });
}

/** Everything that has to be re-read after a checkout or a return. The history
 *  panel is a live listener, so it updates itself. */
async function refreshAfterLoanChange() {
  await loadLibrary();
  await loadCheckedOut();
}

// ═══════════════════════════════════════════════════════════════════════════
// Book search + adding to the library
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById('lookupIsbnBtn')?.addEventListener('click', runBookSearch);
document.getElementById('isbnInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') runBookSearch(); });

async function runBookSearch() {
  const input    = document.getElementById('isbnInput');
  const resultEl = document.getElementById('isbnResult');
  const btn      = document.getElementById('lookupIsbnBtn');
  if (!input || !resultEl || !btn) return;

  const q = input.value.trim();
  if (!q) {
    resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px'>Type a title, author, or ISBN to search.</p>`;
    return;
  }
  resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px'>Searching…</p>`;
  btn.disabled = true;

  let results = [];
  try {
    const isIsbn = /^[\d\-]{9,17}$/.test(q.replace(/\s/g, ''));
    results = isIsbn ? [await lookupISBN(q)].filter(Boolean) : await searchBooks(q, 8);
  } catch (err) {
    console.error('[teacher] book search failed:', err);
    resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px;color:var(--danger)'>Search failed: ${esc(err?.message ?? 'try again')}.</p>`;
    return;
  } finally {
    btn.disabled = false;
  }

  if (!results.length) {
    resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px'>No results for "${esc(q)}". Try different keywords.</p>`;
    bookSearchResults = [];
    return;
  }
  bookSearchResults = results;
  renderBookSearchResults(results);
}

function renderBookSearchResults(results) {
  const resultEl = document.getElementById('isbnResult');
  resultEl.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'book-search-grid';

  results.forEach((book, i) => {
    const existing       = api.findExistingBook(book, allBooks);
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
          <button class='btn btn--primary btn--sm stepper-add'>${existing ? 'Add Copies' : 'Add to Library'}</button>
        </div>
      </div>`;

    let qty = 1;
    const valEl  = card.querySelector('.stepper-val');
    const addBtn = card.querySelector('.stepper-add');
    card.querySelector('.stepper-dec').addEventListener('click', () => { if (qty > 1)  { qty--; valEl.textContent = qty; } });
    card.querySelector('.stepper-inc').addEventListener('click', () => { if (qty < 20) { qty++; valEl.textContent = qty; } });
    addBtn.addEventListener('click', () => { addBtn.disabled = true; addCopiesToLibrary(i, qty).finally(() => { addBtn.disabled = false; }); });
    grid.appendChild(card);
  });

  resultEl.appendChild(grid);
}

async function addCopiesToLibrary(idx, qty = 1) {
  const book = bookSearchResults[idx];
  if (!book) return;

  // Re-check against the CURRENT library rather than trusting the match made
  // when these results were rendered. The search panel can sit on screen while
  // the library changes underneath it, and a stale "no match" there is exactly
  // what created a duplicate entry.
  const existing = api.findExistingBook(book, allBooks);

  try {
    if (existing) await api.adjustCopies(existing.id, qty);
    else          await api.addBook(book, qty);
  } catch (err) { toastError(err); return; }

  const qtyLabel = plural(qty, 'copy', 'copies');
  const resultEl = document.getElementById('isbnResult');
  if (resultEl) {
    resultEl.innerHTML = `<p class='muted-text small-text' style='margin-top:8px;color:var(--success)'><i class='bi bi-check2'></i> ${existing ? `Added ${qtyLabel} of` : 'Added'} "${esc(book.title)}" to your library.</p>`;
  }
  const input = document.getElementById('isbnInput');
  if (input) input.value = '';
  bookSearchResults = [];

  await loadLibrary();
  toast(`<i class='bi bi-check2'></i> ${qtyLabel} of "${esc(book.title)}" added`, 'success');
}

// ═══════════════════════════════════════════════════════════════════════════
// Barcode scanning
//
// Same destination as the search box above — findExistingBook(), then either
// adjustCopies() or addBook() — reached by pointing a camera at a back cover
// instead of typing. That shared ending is the point: scanning a book already
// on the shelf raises its copy count, exactly as searching for it does, rather
// than starting a second entry for the Merge button to clean up later.
//
// The camera itself lives in barcode.js; this half is modal chrome and the
// decision about what to write.
// ═══════════════════════════════════════════════════════════════════════════

let scanStop      = null;   // stop() from the running scanner, null when idle
let scanBook      = null;   // the book currently shown in the result pane
let scanQty       = 1;
let scanLastFocus = null;
let scanLookupFor = '';     // ISBN whose lookup is in flight, '' when none

function setScanStatus(msg, kind = '') {
  const el = document.getElementById('scanStatus');
  if (!el) return;
  el.innerHTML = msg;
  el.className = `scan-status${kind ? ` scan-status--${kind}` : ''}`;
}

/** Stop the camera. Idempotent, and called from every exit path — the capture
 *  light stays on and the track stays live until this runs, which on a phone is
 *  both alarming and a battery drain. */
function stopScanner() {
  try { scanStop?.(); } catch (err) { console.warn('[teacher] scanner stop failed:', err); }
  scanStop = null;
}

function showScanPane(which) {
  const stage  = document.getElementById('scanStage');
  const result = document.getElementById('scanResult');
  if (stage)  stage.hidden  = which !== 'stage';
  if (result) result.hidden = which !== 'result';
  // The hidden pane stays in the DOM, so the two headings need distinct ids and
  // the dialog has to be re-pointed at whichever one is showing. Reusing one id
  // across both left aria-labelledby resolving to the hidden element, and a
  // screen reader announced "Scan a barcode" over the book it had just found.
  document.getElementById('scanModal')?.setAttribute(
    'aria-labelledby', which === 'result' ? 'scanResultHeading' : 'scanModalHeading',
  );
}

async function beginScanning() {
  const video = document.getElementById('scanVideo');
  if (!video) return;

  stopScanner();                       // never leave two streams running
  showScanPane('stage');
  scanBook = null;
  setScanStatus('Starting the camera…');

  try {
    scanStop = await startScanner({
      video,
      onReady:   () => setScanStatus('Looking for a barcode…'),
      onCode:    (isbn) => { handleScannedIsbn(isbn); },
      onNonBook: () => setScanStatus(
        "That barcode isn't a book — book barcodes start 978 or 979. Try the one on the back cover.",
      ),
      onError:   (err) => { stopScanner(); setScanStatus(describeError(err), 'error'); },
    });
  } catch (err) {
    // Not a toast: the modal is covering the screen, so the explanation has to
    // be inside it or nobody reads it.
    setScanStatus(describeError(err), 'error');
  }
}

/** A barcode decoded and passed the ISBN check. Look the book up and show it.
 *
 *  The camera stops for the duration. Leaving it running would keep firing on
 *  the same cover behind the modal's result pane, and every hit would race the
 *  lookup already in flight. */
async function handleScannedIsbn(isbn) {
  if (scanLookupFor) return;           // already resolving one
  scanLookupFor = isbn;
  stopScanner();
  setScanStatus(`Found ${esc(isbn)} — looking it up…`);

  let book = null;
  try {
    book = await lookupBarcode(isbn);
  } catch (err) {
    console.error('[teacher] barcode lookup failed:', err);
    renderScanMiss(isbn, "That lookup didn't come back. Check your connection and try again.");
    scanLookupFor = '';
    return;
  }
  scanLookupFor = '';

  if (!book) { renderScanMiss(isbn); return; }
  scanBook = book;
  scanQty  = 1;
  renderScanResult(book);
}

/** No catalogue has this barcode. A real outcome, not a failure: a book
 *  processed by a school library often carries a locally printed barcode that
 *  Google and Open Library have never seen. Offer the manual route out. */
function renderScanMiss(isbn, why = '') {
  const el = document.getElementById('scanResult');
  if (!el) return;
  el.innerHTML = `
    <h2 class='book-modal-title' id='scanResultHeading'>No match for that barcode</h2>
    <p class='book-modal-desc'>
      ${why ? `${esc(why)}<br><br>` : ''}
      Nothing in Google Books or Open Library is listed under
      <strong>${esc(isbn)}</strong>. Library-processed copies often carry a
      barcode the school printed itself, which no catalogue knows about.
    </p>
    <div class='book-modal-actions'>
      <button class='btn btn--primary btn--sm' id='scanAgainBtn' type='button'>
        <i class='bi bi-upc-scan' aria-hidden='true'></i> Scan another
      </button>
      <button class='btn btn--sm' id='scanSearchInsteadBtn' type='button'>
        <i class='bi bi-search' aria-hidden='true'></i> Search by title instead
      </button>
    </div>`;
  showScanPane('result');

  document.getElementById('scanAgainBtn')?.addEventListener('click', beginScanning);
  document.getElementById('scanSearchInsteadBtn')?.addEventListener('click', () => {
    closeScanModal();
    const input = document.getElementById('isbnInput');
    if (input) { input.value = ''; input.focus(); }
  });
  document.getElementById('scanAgainBtn')?.focus();
}

/** Cover, blurb, and the copies pill.
 *
 *  `existing` is looked up here for display only. The write path re-checks it
 *  against the live library — see confirmScanAdd(). */
function renderScanResult(book) {
  const el = document.getElementById('scanResult');
  if (!el || !book) return;

  const existing = api.findExistingBook(book, allBooks);
  const have     = existing?.copies ?? 0;

  const cover = book.cover
    ? `<img src='${esc(book.cover)}' class='book-modal-cover book-cover' alt='Cover of ${esc(book.title)}'>`
    : `<div class='book-modal-cover book-modal-cover-ph'><i class='bi bi-book-fill' aria-hidden='true'></i></div>`;

  const facts = [
    book.isbn      ? `ISBN ${esc(book.isbn)}`       : '',
    book.published ? esc(String(book.published))    : '',
    book.publisher ? esc(book.publisher)            : '',
    book.pageCount ? `${book.pageCount} pages`      : '',
  ].filter(Boolean);

  el.innerHTML = `
    <div class='book-modal-grid'>
      <div>${cover}</div>
      <div>
        <div class='book-modal-title' id='scanResultHeading'>${esc(book.title)}</div>
        <div class='book-modal-author'>${esc(book.author || 'Unknown author')}</div>
        ${facts.length ? `<div class='book-modal-facts'>${facts.map(f => `<span>${f}</span>`).join('')}</div>` : ''}
        ${existing ? `
          <div class='scan-dupe-note'>
            <i class='bi bi-check-circle-fill' aria-hidden='true'></i>
            <span>Already on your shelf — ${plural(have, 'copy', 'copies')}. Adding here
            raises that count instead of creating a second entry.</span>
          </div>` : ''}
        ${book.description
          ? `<div class='book-modal-section-label'>About this book</div>
             <div class='book-modal-desc'>${esc(book.description)}</div>`
          : `<div class='book-modal-desc' style='color:var(--text-3)'>
               Google Books has no description for this edition.
             </div>`}

        <div class='copy-pill-row'>
          <span class='copy-pill-label'>Copies to add</span>
          <div class='copy-pill' role='group' aria-label='Number of copies to add'>
            <button type='button' class='copy-pill-btn' id='scanQtyDec' aria-label='One fewer copy'>&minus;</button>
            <span class='copy-pill-val' id='scanQtyVal' role='status' aria-live='polite'>1</span>
            <button type='button' class='copy-pill-btn' id='scanQtyInc' aria-label='One more copy'>+</button>
          </div>
        </div>

        <div class='book-modal-actions'>
          <button class='btn btn--primary btn--sm' id='scanAddBtn' type='button'>
            <i class='bi bi-plus-lg' aria-hidden='true'></i>
            <span id='scanAddLabel'></span>
          </button>
          <button class='btn btn--sm' id='scanAgainBtn' type='button'>
            <i class='bi bi-upc-scan' aria-hidden='true'></i> Scan another
          </button>
        </div>
      </div>
    </div>`;

  showScanPane('result');
  syncScanQty(Boolean(existing));

  document.getElementById('scanQtyDec')?.addEventListener('click', () => setScanQty(scanQty - 1, Boolean(existing)));
  document.getElementById('scanQtyInc')?.addEventListener('click', () => setScanQty(scanQty + 1, Boolean(existing)));
  document.getElementById('scanAgainBtn')?.addEventListener('click', beginScanning);
  document.getElementById('scanAddBtn')?.addEventListener('click', confirmScanAdd);
  document.getElementById('scanAddBtn')?.focus();
}

/** Copy counts are physical objects on a shelf; 20 at once is already generous
 *  and matches the search panel's stepper. The cap exists so a stuck + button
 *  or a leaned-on key can't write 400 copies of one paperback. */
const SCAN_MAX_COPIES = 20;

function setScanQty(next, existing) {
  scanQty = Math.min(SCAN_MAX_COPIES, Math.max(1, next));
  syncScanQty(existing);
}

function syncScanQty(existing) {
  const val = document.getElementById('scanQtyVal');
  if (val) val.textContent = String(scanQty);
  const dec = document.getElementById('scanQtyDec');
  const inc = document.getElementById('scanQtyInc');
  if (dec) dec.disabled = scanQty <= 1;
  if (inc) inc.disabled = scanQty >= SCAN_MAX_COPIES;
  const label = document.getElementById('scanAddLabel');
  if (label) {
    label.textContent = existing
      ? `Add ${plural(scanQty, 'copy', 'copies')}`
      : scanQty === 1 ? 'Add to Library' : `Add ${plural(scanQty, 'copy', 'copies')}`;
  }
}

async function confirmScanAdd() {
  const book = scanBook;
  if (!book) return;
  const btn = document.getElementById('scanAddBtn');
  if (btn) btn.disabled = true;

  // Re-checked against the CURRENT library rather than against the match made
  // when this pane was rendered. The modal can sit open for a while — a whole
  // stack of books gets scanned through it — and the shelf changes underneath
  // it, including from the teacher's own previous scan. A stale "no match"
  // here is precisely what creates a duplicate entry.
  const existing = api.findExistingBook(book, allBooks);
  const qty      = scanQty;

  try {
    if (existing) await api.adjustCopies(existing.id, qty);
    else          await api.addBook(book, qty);
  } catch (err) {
    toastError(err);
    if (btn) btn.disabled = false;
    return;
  }

  // Before scanning the next book, so its duplicate check sees this write.
  await loadLibrary();

  toast(
    `<i class='bi bi-check2'></i> ${plural(qty, 'copy', 'copies')} of "${esc(book.title)}" ${existing ? 'added' : 'added to your library'}`,
    'success',
  );
  setScanStatus(
    `<i class='bi bi-check2'></i> Added "${esc(book.title)}". Ready for the next book.`,
    'ok',
  );
  scanBook = null;
  beginScanning();
}

function openScanModal() {
  const modal = document.getElementById('scanModal');
  if (!modal) return;
  scanLastFocus = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  document.getElementById('scanModalClose')?.focus();
  beginScanning();
}

function closeScanModal() {
  const modal = document.getElementById('scanModal');
  if (!modal || modal.hidden) return;
  stopScanner();
  scanBook      = null;
  scanLookupFor = '';
  modal.hidden = true;
  document.body.style.overflow = '';
  scanLastFocus?.focus?.();
  scanLastFocus = null;
}

function initBarcodeScan() {
  const row = document.getElementById('scanRow');
  const btn = document.getElementById('scanBarcodeBtn');
  if (!row || !btn) return;

  // A Scan button on a desktop with no webcam, or on a page served over plain
  // http where getUserMedia never resolves, is a button that does nothing. Show
  // it only where it can work; the search box above covers everywhere else.
  if (!isScanSupported()) return;
  row.hidden = false;

  btn.addEventListener('click', openScanModal);
  document.getElementById('scanModalClose')?.addEventListener('click', closeScanModal);

  // Backdrop only: a click that began inside the box and drifted out while
  // selecting a blurb should not dismiss the whole thing.
  document.getElementById('scanModal')?.addEventListener('mousedown', (e) => {
    if (e.target.id === 'scanModal') closeScanModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeScanModal();
  });
  // Bfcache-safe: `unload` never fires on iOS, and a backgrounded tab holding a
  // live camera track is the one thing guaranteed to get this feature blamed
  // for a dead battery.
  window.addEventListener('pagehide', stopScanner);
}

document.getElementById('mergeDuplicatesBtn')?.addEventListener('click', async (e) => {
  const groups = api.findDuplicateGroups(allBooks);
  if (!groups.length) { toast('No duplicate books found.', 'info'); return; }
  const extra = groups.reduce((n, g) => n + g.length - 1, 0);
  if (!confirm(
    `${groups.length} book${groups.length !== 1 ? 's are' : ' is'} listed more than once.\n\n` +
    `Merge them into one entry each? Copy counts are added together, so nothing is lost: ` +
    `${plural(extra, 'duplicate entry', 'duplicate entries')} will be removed.`
  )) return;

  e.currentTarget.disabled = true;
  try {
    const { merged, skipped } = await api.mergeDuplicateBooks(allBooks);
    await loadLibrary();
    await loadCheckedOut();
    toast(skipped
      ? `<i class='bi bi-check2'></i> Merged ${plural(merged, 'duplicate entry', 'duplicate entries')}. ${skipped} skipped, because those have copies checked out on more than one entry.`
      : `<i class='bi bi-check2'></i> Merged ${plural(merged, 'duplicate entry', 'duplicate entries')}.`,
      merged ? 'success' : 'info');
  } catch (err) {
    toastError(err);
  } finally {
    e.currentTarget.disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Import a library from a spreadsheet
// ═══════════════════════════════════════════════════════════════════════════
// Two steps on purpose: parse and SHOW what was found, then import only once
// the teacher confirms. Dropping several hundred books onto a shelf silently,
// off one file-picker click, is not something you want to be wrong about.

let pendingImport = null;

document.getElementById('importPickBtn')?.addEventListener('click', () => {
  document.getElementById('importFileInput')?.click();
});

document.getElementById('importFileInput')?.addEventListener('change', async (e) => {
  const file = e.currentTarget.files?.[0];
  e.currentTarget.value = '';            // so re-picking the same file re-fires
  if (!file) return;

  const out = document.getElementById('importResult');
  if (out) out.innerHTML = `<p class='muted-text small-text' style='margin-top:8px'>Reading ${esc(file.name)}…</p>`;

  let parsed;
  try {
    const { parseLibraryFile } = await import('./spreadsheet.js');
    parsed = await parseLibraryFile(file);
  } catch (err) {
    console.error('[teacher] import parse failed:', err);
    if (out) {
      out.innerHTML = `<p class='empty-state' style='color:var(--danger);margin-top:8px'>
        <i class='bi bi-exclamation-triangle-fill' aria-hidden='true'></i>
        ${esc(err?.message ?? 'Could not read that file')}${err?.hint ? `. ${esc(err.hint)}` : ''}
      </p>`;
    }
    return;
  }

  pendingImport = parsed;
  renderImportPreview(file, parsed);
});

function renderImportPreview(file, parsed) {
  const out = document.getElementById('importResult');
  if (!out) return;
  const s = parsed.stats;

  if (!parsed.entries.length) {
    out.innerHTML = `<p class='empty-state' style='margin-top:8px'>No books found in "${esc(parsed.sheetName)}".</p>`;
    return;
  }

  // How many of these are already on the shelf, so the teacher sees up front
  // whether this is an add or a top-up.
  const alreadyHere = parsed.entries.filter(e => api.findExistingBook(e, allBooks)).length;
  const sample = parsed.entries.slice(0, 4)
    .map(e => `${esc(e.title)}${e.copies > 1 ? ` <span class='muted-text'>×${e.copies}</span>` : ''}`)
    .join(', ');

  out.innerHTML = `
    <div class='settings-row settings-row--col' style='border-top:1px solid var(--border);margin-top:10px;padding-top:10px'>
      <div class='settings-label'>${esc(file.name)}</div>
      <div class='settings-hint' style='margin-bottom:8px'>
        Sheet <strong>${esc(parsed.sheetName)}</strong> · ${plural(s.rows, 'row')} →
        <strong>${plural(s.books, 'book')}</strong> (${plural(s.copies, 'copy', 'copies')})<br>
        ${s.withIsbn} with ISBN · ${s.withCover} with a cover
        ${alreadyHere ? `<br><strong>${plural(alreadyHere, 'book')}</strong> already on your shelf; those gain copies rather than being added twice.` : ''}
        ${s.checkedOut ? `<br>${plural(s.checkedOut, 'copy', 'copies')} marked checked out in the file will import as <strong>available</strong>, because the borrowers aren't BookWare students.` : ''}
        ${s.skipped ? `<br>${plural(s.skipped, 'row')} skipped for having no title.` : ''}
      </div>
      <p class='muted-text small-text' style='margin-bottom:8px'>e.g. ${sample}${parsed.entries.length > 4 ? ' …' : ''}</p>
      <div style='display:flex;gap:6px;flex-wrap:wrap'>
        <button class='btn btn--primary btn--sm' id='importConfirmBtn'>
          <i class='bi bi-download' aria-hidden='true'></i> Import ${plural(s.books, 'book')}
        </button>
        <button class='btn btn--ghost btn--sm' id='importCancelBtn'>Cancel</button>
      </div>
      <div id='importProgress' class='muted-text small-text' style='margin-top:8px'></div>
    </div>`;

  document.getElementById('importCancelBtn')?.addEventListener('click', () => {
    pendingImport = null;
    out.innerHTML = '';
  });
  document.getElementById('importConfirmBtn')?.addEventListener('click', runImport);
}

async function runImport(ev) {
  if (!pendingImport) return;
  const btn      = ev.currentTarget;
  const cancel   = document.getElementById('importCancelBtn');
  const progress = document.getElementById('importProgress');
  btn.disabled = true;
  if (cancel) cancel.disabled = true;
  btn.innerHTML = `<i class='bi bi-hourglass-split' aria-hidden='true'></i> Importing…`;

  try {
    const result = await api.importBooks(pendingImport.entries, {
      onProgress: (done, total) => {
        if (progress) progress.textContent = `Writing ${done} of ${total}…`;
      },
    });
    pendingImport = null;
    const out = document.getElementById('importResult');
    if (out) {
      out.innerHTML = `<p class='muted-text small-text' style='margin-top:8px;color:var(--success)'>
        <i class='bi bi-check2' aria-hidden='true'></i>
        Added ${plural(result.created, 'new book')}${result.updated ? `, topped up ${plural(result.updated, 'existing book')}` : ''}
        for ${plural(result.copiesAdded, 'copy', 'copies')} in total.
      </p>`;
    }
    toast(`<i class='bi bi-check2'></i> Imported ${plural(result.created + result.updated, 'book')}`, 'success');
    await loadLibrary();
  } catch (err) {
    console.error('[teacher] import failed:', err);
    toastError(err);
    btn.disabled = false;
    if (cancel) cancel.disabled = false;
    btn.innerHTML = `<i class='bi bi-download' aria-hidden='true'></i> Retry import`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Library list
// ═══════════════════════════════════════════════════════════════════════════

async function loadLibrary() {
  const listEl  = document.getElementById('libraryList');
  const countEl = document.getElementById('libraryCountChip');
  if (!listEl) return;
  renderSkeletonRows(listEl, 6);

  try {
    allBooks = await api.listBooks();
  } catch (err) {
    // Unhandled, this left six shimmering placeholders on screen permanently,
    // which reads as "still loading" rather than "this failed".
    renderPanelError(listEl, 'your books', err);
    throw err;
  }

  if (countEl) countEl.textContent = plural(allBooks.length, 'book');

  // Offer the cleanup only when there is something to clean up.
  const mergeBtn = document.getElementById('mergeDuplicatesBtn');
  if (mergeBtn) {
    const dupes = api.findDuplicateGroups(allBooks);
    mergeBtn.hidden = dupes.length === 0;
    mergeBtn.innerHTML = `<i class="bi bi-union" aria-hidden="true"></i> Merge ${dupes.length} duplicate${dupes.length !== 1 ? 's' : ''}`;
  }

  renderLibraryList(allBooks);
  renderReadingPicker();
  renderRecPicker();
  refreshVisibilityStats();
}

function renderLibraryList(books) {
  const listEl = document.getElementById('libraryList');
  if (!listEl) return;
  lastRenderedBooks = books;
  // Drop selections for books that no longer exist (deleted, or merged away),
  // otherwise a stale id lingers and the count reads higher than the list.
  const live = new Set(allBooks.map(b => b.id));
  [...selectedBookIds].forEach(id => { if (!live.has(id)) selectedBookIds.delete(id); });

  if (!books.length) {
    listEl.innerHTML = `<p class='empty-state'>${allBooks.length === 0 ? 'No books yet; add one above.' : 'No matches.'}</p>`;
    renderBulkBar();
    return;
  }
  listEl.innerHTML = '';

  books.forEach(book => {
    const isRec  = recommendations.some(r => r.bookId === book.id);
    const copies = book.copies ?? 1;
    const out    = api.outCount(book);
    const avail  = copies - out;
    const badgeClass = avail > 0 ? 't-badge t-badge--available' : 't-badge t-badge--checked-out';
    const badgeTxt   = copies > 1
      ? `${avail}/${copies} cop${copies !== 1 ? 'ies' : 'y'} available`
      : (out > 0 ? 'Checked Out' : 'Available');

    const row = document.createElement('div');
    row.className = 'book-row' + (selectedBookIds.has(book.id) ? ' is-selected' : '');
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <input type='checkbox' class='book-row-check' data-action='select'
             ${selectedBookIds.has(book.id) ? 'checked' : ''}
             aria-label='Select ${esc(book.title)}'>
      ${book.coverUrl ? `<img src='${esc(book.coverUrl)}' class='book-cover' alt='Cover of ${esc(book.title)}' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'>
        <div class='book-title'>${esc(book.title)}</div>
        <div class='book-author'>${esc(book.author ?? '')}</div>
        <div class='book-meta'>
          <span class='${badgeClass}'>${badgeTxt}</span>
          ${isRec ? `<span class='t-badge t-badge--recommended'><i class='bi bi-star-fill'></i> Recommended</span>` : ''}
        </div>
        <div class='book-actions'>
          <button class='btn btn--xs ${isRec ? 'starred' : ''}' data-action='rec'>
            ${isRec ? '<i class="bi bi-star"></i> Unrecommend' : '<i class="bi bi-star-fill"></i> Recommend'}
          </button>
          ${out > 0 ? `<button class='btn btn--xs success' data-action='return'><i class='bi bi-arrow-return-left'></i> Return</button>` : ''}
          <button class='btn btn--xs' data-action='add-copy' title='Add a copy'><i class='bi bi-plus-lg'></i> Copy</button>
          ${copies > 1 ? `<button class='btn btn--xs' data-action='remove-copy' title='Remove copies (damaged/lost)'><i class='bi bi-dash-lg'></i> Copy</button>` : ''}
          <button class='btn btn--xs danger' data-action='delete'><i class='bi bi-trash3-fill'></i> Delete</button>
        </div>
      </div>`;

    const on = (action, handler) => row.querySelector(`[data-action="${action}"]`)?.addEventListener('click', handler);
    on('rec',         () => toggleRecommendation({ bookId: book.id, bookTitle: book.title, author: book.author ?? '', coverUrl: book.coverUrl ?? '' }));
    on('return',      () => returnFromLibraryRow(book));
    on('delete',      () => deleteBook(book));
    on('add-copy',    () => changeCopies(book, +1));
    on('remove-copy', () => removeCopiesPrompt(book));
    row.querySelector('[data-action="select"]')?.addEventListener('change', (e) => {
      if (e.currentTarget.checked) selectedBookIds.add(book.id);
      else selectedBookIds.delete(book.id);
      row.classList.toggle('is-selected', e.currentTarget.checked);
      renderBulkBar();
    });
    listEl.appendChild(row);
  });

  renderBulkBar();
}

// ═══════════════════════════════════════════════════════════════════════════
// Bulk selection
// ═══════════════════════════════════════════════════════════════════════════
// Two different things get called "bulk delete", and both exist:
//   • several DIFFERENT books at once — tick rows, Delete selected
//   • several COPIES of one book — the − Copy button asks how many
// A spreadsheet import can drop hundreds of books on a shelf at once, so
// undoing that a single click at a time was never going to be usable.

/** Ids currently ticked. Survives re-renders (search, refresh) so a filter
 *  change doesn't silently drop part of a selection the teacher made. */
const selectedBookIds = new Set();

/** What the list last rendered. Every bulk action is scoped to these, so a
 *  teacher can never delete something the search filter is hiding from them. */
let lastRenderedBooks = [];
const shownIds = () => lastRenderedBooks.map(b => b.id);

function renderBulkBar() {
  const bar     = document.getElementById('bulkBar');
  const listEl  = document.getElementById('libraryList');
  const countEl = document.getElementById('bulkCount');
  const allBox  = document.getElementById('bulkSelectAll');
  if (!bar || !listEl) return;

  const shown    = shownIds();
  const selected = shown.filter(id => selectedBookIds.has(id));
  bar.hidden = selected.length === 0;
  listEl.classList.toggle('selecting', selected.length > 0);

  if (countEl) {
    const copies = selected.reduce((n, id) => n + (allBooks.find(b => b.id === id)?.copies ?? 1), 0);
    countEl.textContent = `${plural(selected.length, 'book')} selected · ${plural(copies, 'copy', 'copies')}`;
  }
  if (allBox) {
    allBox.checked = shown.length > 0 && selected.length === shown.length;
    allBox.indeterminate = selected.length > 0 && selected.length < shown.length;
  }
}

document.getElementById('bulkSelectAll')?.addEventListener('change', (e) => {
  const shown = shownIds();
  if (e.currentTarget.checked) shown.forEach(id => selectedBookIds.add(id));
  else                         shown.forEach(id => selectedBookIds.delete(id));
  renderLibraryList(lastRenderedBooks);
});

document.getElementById('bulkClearBtn')?.addEventListener('click', () => {
  selectedBookIds.clear();
  renderLibraryList(lastRenderedBooks);
});

document.getElementById('bulkDeleteBtn')?.addEventListener('click', async (e) => {
  const ids = shownIds().filter(id => selectedBookIds.has(id));
  if (!ids.length) return;
  const titles = ids.map(id => allBooks.find(b => b.id === id)?.title).filter(Boolean);
  const preview = titles.slice(0, 5).join('\n  • ');
  const more    = titles.length > 5 ? `\n  …and ${titles.length - 5} more` : '';
  if (!confirm(`Permanently delete ${plural(ids.length, 'book')}?\n\n  • ${preview}${more}\n\nThis cannot be undone. Checkout history is kept.`)) return;

  e.currentTarget.disabled = true;
  try {
    await api.deleteBooks(ids);
    ids.forEach(id => selectedBookIds.delete(id));
    toast(`<i class='bi bi-check2'></i> Deleted ${plural(ids.length, 'book')}`, 'success');
    await loadLibrary();
  } catch (err) {
    toastError(err);
  } finally {
    e.currentTarget.disabled = false;
  }
});

/** Remove several copies of one book in a single action. */
async function removeCopiesPrompt(book) {
  const copies = book.copies ?? 1;
  const out    = api.outCount(book);
  const spare  = copies - out;
  if (spare < 1) {
    toast(`Every copy of "${esc(book.title)}" is checked out. Have a copy returned first.`, 'info');
    return;
  }
  const answer = prompt(
    `Remove how many copies of "${book.title}"?\n\n` +
    `${copies} on the shelf, ${out} checked out: up to ${spare} can go.\n` +
    `Use this when copies are damaged or lost.`,
    '1');
  if (answer === null) return;
  const n = parseInt(answer, 10);
  if (!Number.isFinite(n) || n < 1) { toast('Enter a whole number of copies.', 'danger'); return; }
  if (n > spare) { toast(`Only ${plural(spare, 'copy', 'copies')} can be removed right now.`, 'danger'); return; }
  if (n === copies) {
    if (!confirm(`That removes every copy of "${book.title}".\n\nDelete the book entirely instead?`)) return;
    return deleteBook(book, { skipConfirm: true });
  }
  await changeCopies(book, -n);
}

document.getElementById('librarySearchInput')?.addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  renderLibraryList(allBooks.filter(b =>
    b.title?.toLowerCase().includes(q) ||
    b.author?.toLowerCase().includes(q) ||
    b.isbn?.includes(q)));
});

async function changeCopies(book, delta) {
  if (delta < 0 && !confirm(`Remove one copy of "${book.title}"?\n\n${book.copies ?? 1} → ${(book.copies ?? 1) - 1} copies. Use this when a copy is damaged or lost.`)) return;
  try {
    const next = await api.adjustCopies(book.id, delta);
    book.copies = next;
    renderLibraryList(allBooks);
    toast(`<i class='bi bi-check2'></i> "${esc(book.title)}" now has ${next} cop${next !== 1 ? 'ies' : 'y'}`, 'success');
  } catch (err) {
    // "last copy" and "copies still out" are expected outcomes, not failures.
    toastError(err, err.code === 'bw/last-copy' ? 'info' : 'danger');
  }
}

async function deleteBook(book, { skipConfirm = false } = {}) {
  if (!skipConfirm && !confirm(`Permanently delete "${book.title}"? This cannot be undone.`)) return;
  try {
    await api.deleteBook(book.id);
    allBooks = allBooks.filter(b => b.id !== book.id);
    renderLibraryList(allBooks);
    const chip = document.getElementById('libraryCountChip');
    if (chip) chip.textContent = plural(allBooks.length, 'book');
    toast(`<i class='bi bi-check2'></i> "${esc(book.title)}" deleted`, 'success');
  } catch (err) { toastError(err); }
}

/** The Return button on a library row.
 *
 *  A book row is a book, not a loan, so with several copies out there is no
 *  single "the" return to process — which is precisely what the old single
 *  `checkedOutBy` field papered over, silently returning whichever borrower
 *  happened to be last. Resolve it against the open loans instead, and send
 *  the teacher to the list when it is genuinely ambiguous. */
async function returnFromLibraryRow(book) {
  const loans = openLoans.filter(l => l.bookId === book.id);
  if (loans.length === 1) return doReturn(loans[0]);
  if (loans.length > 1) {
    toast(`${loans.length} copies of "${esc(book.title)}" are out; pick the right student under <strong>Checked Out</strong>.`, 'info');
    showPage('library');
    document.getElementById('checkedOutList')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  // Counter says out, no loan row to match. Happens for checkouts that predate
  // the history log, or when a student's own (separate) history write failed.
  if (!confirm(`There's no checkout record for "${book.title}", but a copy is marked out.\n\nRecord it as returned anyway?`)) return;
  try {
    await api.reconstructReturn(book.id);
    toast(`<i class='bi bi-check2'></i> "${esc(book.title)}" marked returned`, 'success');
    await refreshAfterLoanChange();
  } catch (err) { toastError(err); }
}

async function doReturn(loan) {
  try {
    await api.returnLoan(loan.id);
    toast(`<i class='bi bi-check2'></i> "${esc(loan.bookTitle)}" marked returned`, 'success');
  } catch (err) { toastError(err); return; }
  await refreshAfterLoanChange();
}

// ═══════════════════════════════════════════════════════════════════════════
// Checked out
// ═══════════════════════════════════════════════════════════════════════════
// One row per LOAN, not per book. With several copies of a title out, a
// per-book list could only ever name one borrower — the other students, and
// their overdue dates, were invisible.

async function loadCheckedOut() {
  const el = document.getElementById('checkedOutList');
  if (!el) return;
  el.innerHTML = `<p class='empty-state loading-state'>Loading…</p>`;

  try {
    openLoans = await api.listOpenLoans({ withBorrowerStatus: true });
  } catch (err) {
    renderPanelError(el, 'checked-out books', err);
    return;
  }

  if (!openLoans.length) { el.innerHTML = `<p class='empty-state'>No books currently out.</p>`; return; }

  const now = new Date();
  el.innerHTML = '';

  // Books the student says they've handed back come first — those are waiting
  // on the teacher. Then soonest due, so the nudges are near the top.
  const ordered = [...openLoans].sort((a, b) =>
    (Number(b.saysReturned) - Number(a.saysReturned)) ||
    ((a.dueDate?.seconds ?? 0) - (b.dueDate?.seconds ?? 0)));

  ordered.forEach(loan => {
    const book      = allBooks.find(b => b.id === loan.bookId);
    const cover     = loan.coverUrl || book?.coverUrl || '';
    const dueDate   = loan.dueDate?.toDate?.() ?? null;
    const isOverdue = dueDate && dueDate < now;

    const row = document.createElement('div');
    row.className = 'book-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      ${cover ? `<img src='${esc(cover)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'>
        <div class='book-title'>${esc(loan.bookTitle)}</div>
        <div class='book-author'>${esc(loan.author ?? book?.author ?? '')}</div>
        <div style='display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px'>
          <span class='t-badge t-badge--checked-out'>${esc(loan.studentName || 'Unknown student')} · Since ${fmtDate(loan.dateOut)}${
            isOverdue ? ` <strong style='color:var(--danger)'><i class='bi bi-exclamation-triangle-fill'></i> OVERDUE</strong>`
                      : dueDate ? ` · Due ${fmtDate(loan.dueDate)}` : ''}</span>
          ${loan.saysReturned ? `<span class='return-flag'><i class='bi bi-arrow-return-left' aria-hidden='true'></i> ${esc(loan.studentName || 'The student')} says they handed it back</span>` : ''}
        </div>
        <button class='btn btn--xs ${loan.saysReturned ? 'btn--primary' : 'success'}' data-action='return'>
          <i class='bi bi-arrow-return-left'></i> ${loan.saysReturned ? 'Confirm Return' : 'Mark Returned'}
        </button>
      </div>`;
    row.querySelector('[data-action="return"]')?.addEventListener('click', (e) => {
      e.currentTarget.disabled = true;
      doReturn(loan);
    });
    el.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// History (live)
// ═══════════════════════════════════════════════════════════════════════════

function startHistoryWatch() {
  const el = document.getElementById('historyList');
  if (!el) return;
  stopHistoryWatch?.();
  el.innerHTML = `<p class='empty-state loading-state'>Loading…</p>`;

  stopHistoryWatch = api.watchHistory({
    onError: (err) => renderPanelError(el, 'checkout history', err),
    onData: (entries) => {
      if (!entries.length) { el.innerHTML = `<p class='empty-state'>No history yet.</p>`; return; }
      el.innerHTML = '';
      entries.forEach(e => {
        const row = document.createElement('div');
        row.className = 'book-row';
        row.setAttribute('role', 'listitem');
        row.innerHTML = `
          <div class='book-info'>
            <div class='book-title'>${esc(e.bookTitle)}</div>
            <div class='book-author'>${esc(e.studentName || '—')}</div>
            <div style='display:flex;gap:5px;flex-wrap:wrap;margin-top:4px'>
              <span class='t-badge t-badge--available'>Out: ${fmtDate(e.dateOut)}</span>
              ${e.dateReturned
                ? `<span class='t-badge t-badge--available'>Back: ${fmtDate(e.dateReturned)}</span>`
                : `<span class='t-badge t-badge--checked-out'>Still out</span>`}
            </div>
          </div>`;
        el.appendChild(row);
      });
    },
  });
}

// Drop the listener when the page goes away, so a sign-out doesn't leave a
// subscription running against a signed-out session.
window.addEventListener('pagehide', () => stopHistoryWatch?.());

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

function downloadBlob(content, mime, filename) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([content], { type: mime })),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// Prefers the display name: this feeds the class-invite email students
// receive and the report headers, both of which should say whatever the
// teacher chose to be called.
const teacherName = () => (teacherData()?.displayName || '').trim()
  || teacherData()?.name || 'Teacher';
const fileStem    = () => teacherName().replace(/\s+/g, '_');

document.getElementById('exportCheckoutsMdBtn')?.addEventListener('click', async () => {
  try {
    const entries = await api.listHistory();
    const active  = entries.filter(e => !e.dateReturned);
    let md = `# BookWare Checkout Report\n\n**Teacher:** ${teacherName()}  \n**Generated:** ${new Date().toLocaleString()}  \n\n---\n\n`;

    md += `## Currently Checked Out\n\n`;
    if (!active.length) md += `*No books currently checked out.*\n\n`;
    else {
      md += `| Book | Author | Student | Date Out | Due |\n|------|--------|---------|----------|-----|\n`;
      active.forEach(e => {
        md += `| ${e.bookTitle} | ${e.author ?? '—'} | ${e.studentName ?? '—'} | ${fmtDate(e.dateOut)} | ${fmtDate(e.dueDate)} |\n`;
      });
      md += '\n';
    }

    md += `## Full History\n\n`;
    if (!entries.length) md += `*No history yet.*\n`;
    else {
      md += `| Book | Author | Student | Date Out | Date Returned |\n|------|--------|---------|----------|---------------|\n`;
      entries.forEach(e => {
        md += `| ${e.bookTitle} | ${e.author ?? '—'} | ${e.studentName ?? '—'} | ${fmtDate(e.dateOut)} | ${e.dateReturned ? fmtDate(e.dateReturned) : 'Not yet returned'} |\n`;
      });
    }
    md += `\n---\n*Generated by BookWare · Mason High School*\n`;

    downloadBlob(md, 'text/markdown', `${fileStem()}_checkouts_${Date.now()}.md`);
    toast(`<i class='bi bi-check2'></i> Exported as .MD`, 'success');
  } catch (err) { toastError(err); }
});

document.getElementById('exportCheckoutsCsvBtn')?.addEventListener('click', async () => {
  try {
    const entries = await api.listHistory();
    const now  = new Date();
    const rows = [['Book Title', 'Author', 'Student', 'Date Out', 'Due Date', 'Date Returned', 'Status']];
    entries.forEach(e => {
      const due       = e.dueDate?.toDate?.() ?? null;
      const isOverdue = !e.dateReturned && due && due < now;
      rows.push([
        e.bookTitle ?? '', e.author ?? '', e.studentName ?? '',
        fmtDate(e.dateOut), due ? due.toLocaleDateString() : '',
        e.dateReturned ? fmtDate(e.dateReturned) : '',
        e.dateReturned ? 'Returned' : isOverdue ? 'Overdue' : 'Active',
      ]);
    });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    downloadBlob(csv, 'text/csv', `${fileStem()}_checkouts_${new Date().toISOString().slice(0, 10)}.csv`);
    toast(`<i class='bi bi-check2'></i> Exported as .CSV`, 'success');
  } catch (err) { toastError(err); }
});

document.getElementById('exportCheckoutsPdfBtn')?.addEventListener('click', async (ev) => {
  const btn  = ev.currentTarget;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class='bi bi-hourglass-split'></i> Building…`;
  try {
    // Lazy — jsPDF is ~300 KB and most sessions never export.
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm');
    const atMod     = (await import('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/+esm')).default;
    const autoTable = typeof atMod === 'function' ? atMod : atMod.default;

    const entries = await api.listHistory();
    const active  = entries.filter(e => !e.dateReturned);
    const recSet  = new Set(recommendations.map(r => r.bookId));
    const now     = new Date();

    // Locked theme — these colours are written into the file.
    const RED = [231, 76, 60], GRAY = [110, 110, 128], DARK = [40, 40, 46], ALT = [244, 244, 247];

    const pdf   = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageW = pdf.internal.pageSize.getWidth();
    const margin = 40;

    pdf.setFillColor(...RED);
    pdf.rect(0, 0, pageW, 68, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');   pdf.setFontSize(20); pdf.text('BookWare', margin, 32);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(12); pdf.text('Checkout Report', margin, 50);

    pdf.setTextColor(...GRAY); pdf.setFontSize(10);
    pdf.text(`Teacher: ${teacherName()}`, margin, 88);
    pdf.text(`Generated: ${now.toLocaleString()}`, margin, 102);
    pdf.setDrawColor(...RED); pdf.setLineWidth(1.5);
    pdf.line(margin, 112, pageW - margin, 112);

    // Font-independent vector check mark, centred in a cell.
    const drawTick = (cell) => {
      const cx = cell.x + cell.width / 2, cy = cell.y + cell.height / 2;
      pdf.setDrawColor(...RED); pdf.setLineWidth(1.4);
      pdf.line(cx - 4, cy + 0.5, cx - 1, cy + 3.5);
      pdf.line(cx - 1, cy + 3.5, cx + 4.5, cy - 3.5);
    };

    const headStyles = { fillColor: RED, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 };
    const bodyStyles = { textColor: DARK, fontSize: 9, cellPadding: 5 };
    const altRows    = { fillColor: ALT };

    pdf.setTextColor(...DARK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13);
    pdf.text('Currently Checked Out', margin, 138);
    autoTable(pdf, {
      startY: 148, margin: { left: margin, right: margin },
      head: [['Book', 'Author', 'Student', 'Date Out', 'Rec.']],
      body: active.length
        ? active.map(e => [e.bookTitle ?? '—', e.author ?? '—', e.studentName ?? '—', fmtDate(e.dateOut), ''])
        : [['No books currently checked out.', '', '', '', '']],
      headStyles, bodyStyles, alternateRowStyles: altRows,
      columnStyles: { 4: { halign: 'center', cellWidth: 34 } },
      didDrawCell: (d) => { if (d.section === 'body' && d.column.index === 4 && recSet.has(active[d.row.index]?.bookId)) drawTick(d.cell); },
    });

    const y2 = (pdf.lastAutoTable?.finalY ?? 160) + 24;
    pdf.setTextColor(...DARK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13);
    pdf.text('Full History', margin, y2);
    autoTable(pdf, {
      startY: y2 + 10, margin: { left: margin, right: margin },
      head: [['Book', 'Author', 'Student', 'Out', 'Returned', 'Rec.']],
      body: entries.length
        ? entries.map(e => [e.bookTitle ?? '—', e.author ?? '—', e.studentName ?? '—', fmtDate(e.dateOut), e.dateReturned ? fmtDate(e.dateReturned) : 'Not yet returned', ''])
        : [['No history yet.', '', '', '', '', '']],
      headStyles, bodyStyles, alternateRowStyles: altRows,
      columnStyles: { 5: { halign: 'center', cellWidth: 34 } },
      didDrawCell: (d) => { if (d.section === 'body' && d.column.index === 5 && recSet.has(entries[d.row.index]?.bookId)) drawTick(d.cell); },
    });

    const pages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      pdf.setPage(i);
      const h = pdf.internal.pageSize.getHeight();
      pdf.setDrawColor(...GRAY); pdf.setLineWidth(0.5);
      pdf.line(margin, h - 36, pageW - margin, h - 36);
      pdf.setDrawColor(...RED); pdf.setLineWidth(1.2);
      pdf.line(margin, h - 24, margin + 3, h - 21);
      pdf.line(margin + 3, h - 21, margin + 8, h - 27);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(...GRAY);
      pdf.text('= recommended title', margin + 13, h - 22);
      pdf.text('Generated by BookWare · Mason High School', margin, h - 10);
      pdf.text(`Page ${i} of ${pages}`, pageW - margin, h - 10, { align: 'right' });
    }

    pdf.save(`${fileStem()}_checkouts_${now.toISOString().slice(0, 10)}.pdf`);
    toast(`<i class='bi bi-check2'></i> Exported as .PDF`, 'success');
  } catch (err) {
    console.error('[teacher] PDF export failed:', err);
    toastError(err);
  } finally {
    btn.disabled  = false;
    btn.innerHTML = orig;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Class roster
// ═══════════════════════════════════════════════════════════════════════════

async function loadRoster() {
  const listEl  = document.getElementById('rosterList');
  const countEl = document.getElementById('rosterCount');
  if (!listEl) return;
  listEl.innerHTML = `<p class='empty-state loading-state'>Loading roster…</p>`;

  try {
    if (!allClasses.length) await loadClasses();
  } catch (err) {
    renderPanelError(listEl, 'your classes', err);
    return;
  }

  if (!allClasses.length) { listEl.innerHTML = `<p class='empty-state'>No classes yet. Add one above.</p>`; return; }

  listEl.innerHTML = '';
  let totalStudents = 0;

  for (const cls of allClasses) {
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;padding-bottom:6px;border-bottom:1px solid var(--border)';

    // Past its last day of school, firestore.rules stops serving this roster to
    // the teacher. A denied read here is the retention policy working, not a
    // failure — render it as such instead of as a red error.
    if (cls.expired) {
      header.innerHTML = `<div class='settings-label' style='margin:0'>${esc(cls.name)}</div><span class='muted-text small-text'><i class='bi bi-shield-lock-fill'></i> School year ended</span>`;
      listEl.appendChild(header);
      const note = document.createElement('p');
      note.className = 'empty-state';
      note.style.marginBottom = '6px';
      note.textContent = `Roster deleted on ${fmtDate(api.endOfDay(cls.endDate))}: student names and emails are no longer retained for this class.`;
      listEl.appendChild(note);
      continue;
    }

    const { students, readable } = await api.listRoster(cls.id);
    // The counts on the class cards are captured at portal load, so a student
    // joining while the page is open never showed up there. This read is the
    // live truth — reuse it.
    if (readable) cls.studentCount = students.length;
    totalStudents += students.length;

    header.innerHTML = `<div class='settings-label' style='margin:0'>${esc(cls.name)}</div><span class='muted-text small-text'>${plural(students.length, 'student')} · Code: <code style='font-size:0.65rem'>${esc(cls.inviteCode ?? '—')}</code></span>`;
    listEl.appendChild(header);

    if (!students.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.style.marginBottom = '6px';
      empty.textContent = readable
        ? 'No students yet; share the code above.'
        : 'This roster could not be read.';
      listEl.appendChild(empty);
      continue;
    }

    students.forEach(s => {
      const initials = (s.name ?? '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const row = document.createElement('div');
      row.className = 'book-row';
      row.setAttribute('role', 'listitem');
      row.innerHTML = `
        <div class='book-cover-ph' style='width:32px;height:32px;border-radius:50%;font-size:0.6rem;font-weight:700'>${esc(initials)}</div>
        <div class='book-info' style='display:flex;align-items:center;gap:8px'>
          <div style='flex:1;min-width:0'>
            <div class='book-title'>${esc(s.name ?? 'Unknown')}</div>
            <div class='book-author'>${esc(s.email ?? '')}</div>
          </div>
          <button class='btn btn--xs danger' data-action='remove'>Remove</button>
        </div>`;
      row.querySelector('[data-action="remove"]')?.addEventListener('click', () => removeStudent(cls, s));
      listEl.appendChild(row);
    });
  }

  if (countEl) countEl.textContent = `${plural(totalStudents, 'student')} total`;
  renderClassManager();   // push the freshly-counted numbers onto the cards
}

async function removeStudent(cls, student) {
  const name = student.name || 'this student';
  if (!confirm(`Remove ${name} from ${cls.name}?\n\nThey can rejoin with the class code.`)) return;
  try {
    await api.removeStudentFromClass(cls.id, student.id, allClasses.map(c => c.id));
    toast(`<i class='bi bi-check2'></i> Removed ${esc(name)} from ${esc(cls.name)}`, 'success');
    loadRoster();
  } catch (err) { toastError(err); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bans
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById('issueBanBtn')?.addEventListener('click', async (e) => {
  const emailEl  = document.getElementById('banStudentEmail');
  const daysEl   = document.getElementById('banDays');
  const reasonEl = document.getElementById('banReason');
  const email    = emailEl?.value.trim();
  const days     = parseInt(daysEl?.value, 10);
  const reason   = reasonEl?.value.trim();
  if (!email || !days || !reason) { toast('Fill in email, days, and reason.', 'danger'); return; }

  e.currentTarget.disabled = true;
  try {
    const student = await api.findStudentByEmail(email);
    await api.banStudent({ studentUid: student.id, days, reason });
    emailEl.value = ''; daysEl.value = ''; reasonEl.value = '';
    toast(`<i class='bi bi-exclamation-triangle-fill'></i> ${esc(email)} banned for ${plural(days, 'day')}`, 'success');
    loadActiveBans();
  } catch (err) {
    toastError(err);
  } finally {
    e.currentTarget.disabled = false;
  }
});

async function loadActiveBans() {
  const el = document.getElementById('activeBansList');
  if (!el) return;
  el.innerHTML = `<p class='muted-text small-text loading-state'>Loading…</p>`;

  let bans;
  try {
    bans = await api.listActiveBans();
  } catch (err) {
    renderPanelError(el, 'active bans', err);
    return;
  }
  if (!bans.length) { el.innerHTML = `<p class='muted-text small-text'>No active bans.</p>`; return; }

  el.innerHTML = '';
  bans.forEach(u => {
    const row = document.createElement('div');
    row.className = 'ban-item';
    row.innerHTML = `
      <div>
        <div class='ban-name'>${esc(u.name ?? u.email)}</div>
        <div class='ban-meta'>${esc(u.email)} · Expires ${fmtDate(u.banExpiry)}</div>
        <div class='ban-reason'>Reason: ${esc(u.banReason)}</div>
      </div>
      <button class='btn btn--xs success' data-action='lift'>Lift Ban</button>`;
    row.querySelector('[data-action="lift"]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.liftBan(u.id);
        toast(`<i class='bi bi-check2'></i> Ban lifted for ${esc(u.name ?? u.email)}`, 'success');
        loadActiveBans();
      } catch (err) {
        e.currentTarget.disabled = false;
        toastError(err);
      }
    });
    el.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Recommendations
// ═══════════════════════════════════════════════════════════════════════════

async function loadRecommendations() {
  recommendations = await api.listRecommendations();
}

/** Star or unstar a book. `bookId` is a library document id for a shelf book,
 *  or a Google volume id for one that isn't on the shelf yet — `source` records
 *  which, so the library badge only ever matches real library books. */
async function toggleRecommendation({ bookId, bookTitle, author = '', coverUrl = '', source = 'library' }) {
  const existing = recommendations.find(r => r.bookId === bookId);
  try {
    if (existing) {
      await api.removeRecommendation(existing.id);
      recommendations = recommendations.filter(r => r.id !== existing.id);
      toast(`<i class='bi bi-star'></i> "${esc(bookTitle)}" unrecommended`, 'info');
    } else {
      const rec = await api.addRecommendation({ bookId, bookTitle, author, coverUrl, source });
      recommendations.push(rec);
      toast(`<i class='bi bi-star-fill'></i> "${esc(bookTitle)}" recommended`, 'success');
    }
  } catch (err) { toastError(err); return; }

  renderLibraryList(allBooks);
  if (document.getElementById('recommendationsPage')?.classList.contains('active')) {
    renderRecommendationsList();
    renderRecPicker();
  }
}

function renderRecommendationsList() {
  const el = document.getElementById('recommendationsList');
  if (!el) return;
  if (!recommendations.length) {
    el.innerHTML = `<p class='empty-state'>No recommendations yet. Search the right panel to add books.</p>`;
    return;
  }
  el.innerHTML = '';
  recommendations.forEach(rec => {
    const book     = allBooks.find(b => b.id === rec.bookId);
    const coverUrl = rec.coverUrl || book?.coverUrl || '';
    const author   = rec.author   || book?.author   || '';
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
        <button class='btn btn--xs danger' data-action='remove'><i class='bi bi-star'></i> Remove</button>
      </div>`;
    row.querySelector('[data-action="remove"]')?.addEventListener('click',
      () => toggleRecommendation({ bookId: rec.bookId, bookTitle: rec.bookTitle }));
    el.appendChild(row);
  });
}

/** One starrable row, used for both library books and Google Books results. */
function recRow(entry) {
  const isRec = recommendations.some(r => r.bookId === entry.bookId);
  const row = document.createElement('div');
  row.className = 'book-row';
  row.innerHTML = `
    ${entry.coverUrl ? `<img src='${esc(entry.coverUrl)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
    <div class='book-info' style='display:flex;align-items:center;justify-content:space-between;gap:10px'>
      <div style='min-width:0'>
        <div class='book-title'>${esc(entry.bookTitle)}</div>
        <div class='book-author'>${esc(entry.author ?? '')}</div>
      </div>
      <button class='btn btn--xs ${isRec ? 'starred' : ''}' data-action='star' style='flex-shrink:0'>
        ${isRec ? '<i class="bi bi-star-fill"></i> Starred' : '<i class="bi bi-star"></i> Star'}
      </button>
    </div>`;
  row.querySelector('[data-action="star"]')?.addEventListener('click', () => toggleRecommendation(entry));
  return row;
}

function renderRecPicker() {
  const el = document.getElementById('recPickerList');
  if (!el) return;
  const q = (document.getElementById('recSearchInput')?.value ?? '').toLowerCase();
  const filtered = allBooks.filter(b => !q || b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q));
  el.innerHTML = '';

  if (filtered.length) {
    if (q && recGoogleResults.length) {
      const hdr = document.createElement('p');
      hdr.className = 'muted-text small-text';
      hdr.style.marginBottom = '6px';
      hdr.textContent = 'Your Library:';
      el.appendChild(hdr);
    }
    filtered.forEach(b => el.appendChild(recRow({
      bookId: b.id, bookTitle: b.title, author: b.author ?? '', coverUrl: b.coverUrl ?? '', source: 'library',
    })));
  }

  if (recGoogleResults.length) {
    const hdr = document.createElement('p');
    hdr.className = 'muted-text small-text';
    hdr.style.margin = '10px 0 6px';
    hdr.textContent = 'From Google Books:';
    el.appendChild(hdr);
    recGoogleResults.forEach(b => el.appendChild(recRow({
      bookId: b.sourceId, bookTitle: b.title, author: b.author ?? '', coverUrl: b.cover ?? '', source: 'google',
    })));
  }

  if (!filtered.length && !recGoogleResults.length) {
    el.innerHTML = `<p class='empty-state'>${allBooks.length === 0 ? 'No books in library yet.' : q ? 'Searching Google Books…' : 'No matches.'}</p>`;
  }
}

document.getElementById('recSearchInput')?.addEventListener('input', () => {
  clearTimeout(recGoogleDebounce);
  renderRecPicker();
  const q = document.getElementById('recSearchInput')?.value.trim();
  if (!q || q.length < 2) { recGoogleResults = []; return; }
  recGoogleDebounce = setTimeout(async () => {
    try {
      const results = await searchBooks(q, 6);
      recGoogleResults = results.filter(b => !allBooks.some(lb => lb.title?.toLowerCase() === b.title?.toLowerCase()));
      renderRecPicker();
    } catch (err) { console.warn('[teacher] Google Books search failed:', err); }
  }, 600);
});

// ═══════════════════════════════════════════════════════════════════════════
// Now Reading
// ═══════════════════════════════════════════════════════════════════════════
// The current read lives on the teacher document the portal already loaded, not
// on a second fire-and-forget fetch. That old arrangement raced the UI: click
// "Now Reading" fast enough and the page rendered "Nothing set yet." over a
// book that was, in fact, set, and stayed wrong until a reload.

const currentReading = () => teacherData()?.currentlyReading ?? null;

async function saveCurrentlyReading(reading) {
  await api.setCurrentlyReading(reading);
  renderReadingDisplay();
  renderReadingPreview();
  renderRecReadingDisplay();
  renderReadingPicker();
}

function loadCurrentlyReading() {
  renderReadingDisplay();
  renderReadingPreview();
  renderRecReadingDisplay();
}

/** The picker shows search results when there are any, otherwise the shelf. */
function readingCandidates() {
  return readingSearchResults.length
    ? readingSearchResults
    : allBooks.map(b => ({ isLibrary: true, bookId: b.id, title: b.title, author: b.author, cover: b.coverUrl ?? '' }));
}

function renderReadingPicker() {
  const listEl = document.getElementById('readingPickerList');
  if (!listEl) return;
  const toShow = readingCandidates();
  if (!toShow.length) {
    listEl.innerHTML = `<p class='empty-state'>No books in your library yet. Search for one above.</p>`;
    return;
  }
  listEl.innerHTML = '';
  const current = currentReading();

  toShow.forEach((book, i) => {
    // Mark whichever entry is already the current read, so the picker reflects
    // the state instead of offering "Set as Reading" on the book that is set.
    const key       = api.normBookKey(book.title);
    const isCurrent = !!current && !!key && api.normBookKey(current.title) === key;
    const row = document.createElement('div');
    row.className = 'book-row';
    row.innerHTML = `
      ${book.cover ? `<img src='${esc(book.cover)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'>${esc(book.title)}</div>
          <div class='book-author'>${esc(book.author ?? '')}</div>
        </div>
        <button class='btn btn--xs ${isCurrent ? 'starred' : 'success'}' data-action='set' ${isCurrent ? 'disabled' : ''}>
          <i class='bi bi-book-fill'></i> ${isCurrent ? 'Currently Reading' : 'Set as Reading'}
        </button>
      </div>`;
    row.querySelector('[data-action="set"]')?.addEventListener('click', () => setReading(toShow[i]));
    listEl.appendChild(row);
  });
}

async function setReading(book) {
  if (!book) return;
  const reading = { title: book.title ?? '', author: book.author ?? '', coverUrl: book.cover ?? '' };
  if (book.isLibrary && book.bookId) reading.bookId = book.bookId;
  try {
    await saveCurrentlyReading(reading);
    toast(`<i class='bi bi-book-fill'></i> Now reading: "${esc(book.title)}"`, 'success');
  } catch (err) { toastError(err); }
}

async function runReadingSearch() {
  const q   = document.getElementById('readingSearchInput')?.value.trim();
  const btn = document.getElementById('readingSearchBtn');
  if (!q) { readingSearchResults = []; renderReadingPicker(); return; }
  if (btn) btn.disabled = true;
  try {
    readingSearchResults = (await searchBooks(q, 6)).map(b => ({ ...b, isLibrary: false }));
  } catch (err) {
    toast(`Search failed: ${esc(err?.message ?? 'try again')}`, 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
  renderReadingPicker();
}

document.getElementById('readingSearchBtn')?.addEventListener('click', runReadingSearch);
document.getElementById('readingSearchInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') runReadingSearch(); });

function readingCard(r, { style = '' } = {}) {
  return `
    <div class='book-row' ${style ? `style='${style}'` : ''}>
      ${r.coverUrl ? `<img src='${esc(r.coverUrl)}' class='book-cover' style='border-color:var(--accent)' alt=''>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info'>
        <div class='book-title'>${esc(r.title)}</div>
        <div class='book-author'>${esc(r.author)}</div>
      </div>
    </div>`;
}

function renderReadingDisplay() {
  const el = document.getElementById('currentlyReadingDisplay');
  if (!el) return;
  const r = currentReading();
  // A blank area under the Clear button reads as a failed render rather than as
  // "you haven't picked anything".
  el.innerHTML = r
    ? readingCard(r, { style: 'margin-top:10px' })
    : `<p class='empty-state' style='margin-top:10px'>No current read set; pick one from the list above.</p>`;
}

function renderReadingPreview() {
  const el = document.getElementById('readingPreview');
  if (!el) return;
  const r = currentReading();
  el.innerHTML = r
    ? `<p class='muted-text small-text' style='margin-bottom:10px'>Students see this on the Library page:</p>${readingCard(r)}`
    : `<p class='empty-state'>Nothing set yet.</p>`;
}

function renderRecReadingDisplay() {
  const el = document.getElementById('recReadingDisplay');
  if (!el) return;
  const r = currentReading();
  el.innerHTML = r ? readingCard(r) : `<p class='empty-state'>Nothing set yet.</p>`;
}

async function clearCurrentlyReading() {
  if (!currentReading()) { toast('Nothing set to clear.', 'info'); return; }
  try {
    await saveCurrentlyReading(null);
    toast('Currently reading cleared.', 'info');
  } catch (err) { toastError(err); }
}

document.getElementById('clearCurrentlyReadingBtn')?.addEventListener('click', clearCurrentlyReading);
document.getElementById('recClearReadingBtn')?.addEventListener('click', clearCurrentlyReading);

async function runRecReadingSearch() {
  const q      = document.getElementById('recReadingInput')?.value.trim();
  const btn    = document.getElementById('recReadingSearchBtn');
  const listEl = document.getElementById('recReadingResults');
  if (!q || !listEl) return;
  if (btn) btn.disabled = true;

  let results = [];
  try {
    results = await searchBooks(q, 6);
  } catch (err) {
    toast(`Search failed: ${esc(err?.message ?? 'try again')}`, 'danger');
    return;
  } finally {
    if (btn) btn.disabled = false;
  }

  listEl.innerHTML = '';
  if (!results.length) { listEl.innerHTML = `<p class='empty-state'>No results.</p>`; return; }

  results.forEach(book => {
    const row = document.createElement('div');
    row.className = 'book-row';
    row.innerHTML = `
      ${book.cover ? `<img src='${esc(book.cover)}' class='book-cover' alt='' loading='lazy'>` : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`}
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'>${esc(book.title)}</div>
          <div class='book-author'>${esc(book.author ?? '')}</div>
        </div>
        <button class='btn btn--xs success' data-action='set'><i class='bi bi-book-fill'></i> Set</button>
      </div>`;
    row.querySelector('[data-action="set"]')?.addEventListener('click', async () => {
      await setReading({ ...book, isLibrary: false });
      listEl.innerHTML = '';
    });
    listEl.appendChild(row);
  });
}

document.getElementById('recReadingSearchBtn')?.addEventListener('click', runRecReadingSearch);
document.getElementById('recReadingInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') runRecReadingSearch(); });

// ═══════════════════════════════════════════════════════════════════════════
// Teacher invites
// ═══════════════════════════════════════════════════════════════════════════

let lastInviteLink  = '';
let lastInviteEmail = '';

const inviteLinkFor = (id) => `${window.location.origin}/teacher-signup.html?token=${id}`;

document.getElementById('createInviteBtn')?.addEventListener('click', async (ev) => {
  const emailInput  = document.getElementById('inviteEmailInput');
  const output      = document.getElementById('inviteOutput');
  const qrContainer = document.getElementById('inviteQrContainer');
  const qrImg       = document.getElementById('inviteQrImg');
  const emailBtn    = document.getElementById('emailInviteBtn');

  ev.currentTarget.disabled = true;
  try {
    const { id, email, days } = await api.createInvite(emailInput?.value ?? '');
    const link = inviteLinkFor(id);
    lastInviteLink  = link;
    lastInviteEmail = email;

    await navigator.clipboard.writeText(link).catch(() => {});
    if (output) output.innerHTML = `
      <div class='invite-link-box'>${esc(link)}</div>
      <p class='muted-text small-text' style='margin-top:8px'>
        <i class='bi bi-check2'></i> Link copied. It is valid for ${days} days and locked to ${esc(email)}
      </p>`;
    if (qrImg && qrContainer) {
      setQrImage(qrImg, link, 240);
      qrImg.alt = 'QR code for invite link';
      qrContainer.hidden = false;
    }
    if (emailBtn) emailBtn.hidden = false;
    if (emailInput) emailInput.value = '';
    toast(`<i class='bi bi-check2'></i> Invite link created &amp; copied`, 'success');
    loadPastInvites();
  } catch (err) {
    toastError(err);
  } finally {
    ev.currentTarget.disabled = false;
  }
});

document.getElementById('emailInviteBtn')?.addEventListener('click', () => {
  if (!lastInviteLink) return;
  const subject = encodeURIComponent("You've been invited to BookWare");
  const body = encodeURIComponent(
    `Hi,\n\nYou've been invited to join BookWare as a teacher at Mason High School.\n\n` +
    `Click the link below to create your account:\n${lastInviteLink}\n\n` +
    `This invite is locked to ${lastInviteEmail} and expires in 7 days.\n\n– ${teacherName()}`,
  );
  window.open(`mailto:${lastInviteEmail}?subject=${subject}&body=${body}`);
  toast(`<i class='bi bi-envelope-fill'></i> Opening email client…`, 'info');
});

async function loadPastInvites() {
  const el = document.getElementById('pastInvitesList');
  if (!el) return;
  el.innerHTML = `<p class='empty-state loading-state'>Loading…</p>`;

  let invites;
  try {
    invites = await api.listInvites();
  } catch (err) {
    renderPanelError(el, 'your invites', err);
    return;
  }
  if (!invites.length) { el.innerHTML = `<p class='empty-state'>No invites sent yet.</p>`; return; }

  el.innerHTML = '';
  invites.forEach(inv => {
    const link = inviteLinkFor(inv.id);
    const statusBadge = inv.used
      ? `<span class='t-badge'>Used</span>`
      : inv.revoked
      ? `<span class='t-badge' style='color:var(--danger)'>Revoked</span>`
      : inv.expired
      ? `<span class='t-badge' style='opacity:0.5'>Expired</span>`
      : `<span class='t-badge t-badge--available'>Active · Expires ${fmtDate(inv.expiresAt)}</span>`;

    const row = document.createElement('div');
    row.className = 'book-row';
    row.innerHTML = `
      <div class='book-info' style='flex:1;min-width:0'>
        <div class='book-title'>${esc(inv.recipientEmail || 'Open invite')}</div>
        <div style='display:flex;gap:6px;flex-wrap:wrap;margin-top:4px'>${statusBadge}</div>
        <div class='teacher-invite-qr' hidden style='margin-top:10px'>
          <img src='' alt='QR code' style='width:120px;height:120px;background:#fff;padding:5px;border-radius:7px;display:block'>
          <p class='muted-text small-text' style='margin-top:4px'>Scan to open invite</p>
        </div>
      </div>
      <div style='display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap'>
        ${inv.active ? `
          <button class='btn btn--ghost btn--sm' data-action='copy' title='Copy link' aria-label='Copy invite link'><i class='bi bi-clipboard'></i></button>
          <button class='btn btn--ghost btn--sm' data-action='qr' title='QR code' aria-label='Show QR code'><i class='bi bi-qr-code'></i></button>
          <button class='btn btn--danger btn--sm' data-action='revoke'>Revoke</button>` : ''}
      </div>`;

    const on = (action, handler) => row.querySelector(`[data-action="${action}"]`)?.addEventListener('click', handler);
    on('copy', () => copyText(link, 'Link copied'));
    on('qr', () => {
      const qrDiv = row.querySelector('.teacher-invite-qr');
      const qrImg = qrDiv?.querySelector('img');
      if (!qrDiv) return;
      qrDiv.hidden = !qrDiv.hidden;
      if (!qrDiv.hidden && qrImg && !qrImg.dataset.qrReady) setQrImage(qrImg, link, 180);
    });
    on('revoke', async (e) => {
      if (!confirm('Revoke this invite? The link will stop working immediately.')) return;
      e.currentTarget.disabled = true;
      try {
        await api.revokeInvite(inv.id);
        toast('Invite revoked', 'success');
        loadPastInvites();
      } catch (err) {
        e.currentTarget.disabled = false;
        toastError(err);
      }
    });

    el.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Bi-weekly check-in banner
// ═══════════════════════════════════════════════════════════════════════════

function checkBiweeklyNotification() {
  const KEY       = `bookware-biweekly-${me?.uid}`;
  const TWO_WEEKS = 14 * 86400000;
  const last      = localStorage.getItem(KEY);
  if (last && Date.now() - parseInt(last, 10) < TWO_WEEKS) return;

  setTimeout(() => {
    const banner  = document.getElementById('biweeklyBanner');
    const content = document.getElementById('biweeklyContent');
    if (!banner || !content) return;

    const now     = new Date();
    const overdue = openLoans.filter(l => (l.dueDate?.toDate?.() ?? null) < now).length;

    content.innerHTML = `
      <div style='display:flex;flex-wrap:wrap;gap:7px;margin-top:8px'>
        ${openLoans.map(l => `<span class='count-badge'>${esc(l.bookTitle)}</span>`).join('')}
      </div>
      <div style='margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center'>
        <p class='muted-text small-text'>${plural(openLoans.length, 'book')} out${overdue > 0 ? ` · <strong style='color:var(--danger)'>${overdue} overdue</strong>` : ''}.</p>
        <button class='btn btn--sm' id='biweeklyDownloadBtn'><i class='bi bi-download'></i> Download .MD</button>
        <button class='btn btn--ghost btn--sm' id='biweeklyDismissBtn'>Dismiss</button>
      </div>`;
    banner.hidden = false;
    localStorage.setItem(KEY, String(Date.now()));

    document.getElementById('biweeklyDownloadBtn')?.addEventListener('click', () => {
      let md = `# BookWare Bi-Weekly Library Report\n\n**Teacher:** ${teacherName()}  \n**Generated:** ${now.toLocaleString()}  \n\n---\n\n`;
      if (!openLoans.length) md += 'All books are currently available.\n';
      else {
        md += `## Currently Checked Out\n\n| Book | Author | Student | Checked Out | Due Date | Status |\n|------|--------|---------|-------------|----------|--------|\n`;
        openLoans.forEach(l => {
          const due       = l.dueDate?.toDate?.() ?? null;
          const isOverdue = due && due < now;
          md += `| ${l.bookTitle} | ${l.author ?? '—'} | ${l.studentName || '—'} | ${fmtDate(l.dateOut)} | ${due ? due.toLocaleDateString() : '—'} | ${isOverdue ? 'OVERDUE' : 'Active'} |\n`;
        });
      }
      md += `\n---\n*Generated by BookWare · Mason High School*\n`;
      downloadBlob(md, 'text/markdown', `bookware-report-${now.toISOString().slice(0, 10)}.md`);
      toast('<i class="bi bi-check2"></i> Report downloaded', 'success');
    });

    document.getElementById('biweeklyDismissBtn')?.addEventListener('click', () => { banner.hidden = true; });
  }, 1800);
}
