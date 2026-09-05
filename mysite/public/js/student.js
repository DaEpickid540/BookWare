// student.js — BookWare Student Portal
import { auth, db } from "./firebase.js";
import { shouldForceLogout, PENDING_JOIN_KEY, readJoinCode } from "./config.js";
import { searchBooks, initCoverFallback } from "./books.js";
import { initTheme, initARIA, applyPreset, initAriaChat, initAriaRecommends, refreshAriaChats, initSettingsModal, openSettingsModal, closeSettingsModal, initStaySignedIn, setAriaAvailability } from "./theme.js";
import { runReadingQuiz } from "./quiz.js";
import { runWelcomeTour } from "./welcome.js";
import { hidePreloader } from "./preloader.js";
import {
  signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  getDocs,
  deleteDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  arrayUnion,
  arrayRemove,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let userData = null;
let studentData = null;
let classTeacherId = null;
let selectedTeacherId = null;
let selectedTeacherName = "";
let _selectedTeacherData = null; // full teacher doc data for selected library
let allBooks = [];
let addedTeacherIds = [];
const bookCache = new Map();
let wishlistListeners = [];

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(msg, type = "info") {
  const c = document.getElementById("toastContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

/** What a teacher wants students to call them.
 *
 *  Teachers set `displayName` themselves in their own portal, because the name
 *  on a school Google account is often not the one a class uses ("Mrs. Chen",
 *  not "Jennifer Chen") and because a legal name can change. `name` is still
 *  the account of record and stays the fallback, so a teacher who has never
 *  touched the setting reads exactly as before.
 *
 *  Every student-facing render of a teacher goes through here. Five call sites
 *  used to read `.name` directly, which is how a rename would have shown up in
 *  four places and not the fifth. */
/** How long a book was out, as a phrase.
 *
 *  Both ends are Firestore Timestamps. Counts whole days by calendar date
 *  rather than by elapsed milliseconds: a book taken out Monday afternoon and
 *  returned Wednesday morning is "2 days" to a student, not the 1.6 that
 *  rounding the raw difference would give. Same-day returns are their own
 *  case, since "0 days" reads as an error. */
function heldFor(dateOut, dateReturned) {
  const toDate = (t) => (t?.toDate ? t.toDate() : t ? new Date(t) : null);
  const a = toDate(dateOut);
  const b = toDate(dateReturned);
  if (!a || !b || isNaN(a) || isNaN(b)) return "";
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((midnight(b) - midnight(a)) / 86400000);
  if (days <= 0) return "Same day";
  if (days === 1) return "1 day";
  if (days < 7) return `${days} days`;
  if (days < 14) return "1 week";
  // Hands over to months at 30, not 60: past that the months branch can never
  // round down to 1, so "1 month" was unreachable and 30 days read "4 weeks".
  if (days < 30) return `${Math.round(days / 7)} weeks`;
  const months = Math.round(days / 30);
  return months === 1 ? "1 month" : `${months} months`;
}

function teacherLabel(t) {
  if (!t) return "Library";
  return (t.displayName || "").trim() || t.name || t.email || "Library";
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
document.getElementById("sidebarToggle")?.addEventListener("click", () => {
  const sb = document.getElementById("sidebar");
  const expanded = sb.classList.toggle("collapsed");
  document
    .getElementById("sidebarToggle")
    ?.setAttribute("aria-expanded", String(!expanded));
});

// ── Page routing (wired immediately — before auth) ────────────────────────────
const PAGE_TITLES = {
  library: "Library",
  locker: "My Locker",
  wishlist: "Wishlist",
  profile: "Profile",
  settings: "Settings",
};

document.querySelectorAll(".nav-item[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
});

// "Add a Code" shortcut on the recommendations placeholder card opens
// Settings, where the class-code input lives. (Was an inline onclick, removed
// so the CSP can drop 'unsafe-inline' for scripts.)
document.getElementById("recPlaceholderAddCodeBtn")
  ?.addEventListener("click", () => showPage("settings"));

function showPage(name) {
  if (name === "settings") { openSettingsModal(); return; }
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.remove("active");
    n.removeAttribute("aria-current");
  });
  document.getElementById(name + "Page")?.classList.add("active");
  // Mark ALL matching nav buttons (sidebar + bottom nav) as active
  document.querySelectorAll(`[data-page="${name}"]`).forEach(btn => {
    btn.classList.add("active");
    btn.setAttribute("aria-current", "page");
  });
  const pt = document.getElementById("pageTitle");
  if (pt) pt.textContent = PAGE_TITLES[name] ?? name;
  if (name === "locker") renderLockerPage();
  if (name === "profile") renderProfilePage();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const _safeReveal = setTimeout(() => {
  document.documentElement.style.visibility = "visible";
}, 5000);

// How long any single start-up read may take before we stop waiting on it and
// try again. A Firestore read that never SETTLES (as opposed to failing) has no
// error to catch: the whole auth handler — role check, studentData, and every
// loader downstream of it — just hangs, and the portal shows nothing until an
// unrelated click fires its own fresh reads. A cold connection routinely makes
// the first read of a session slow while every read after it is instant, so
// retry a couple of times before giving up.
const READ_DEADLINE_MS = 12000;
async function readCritical(promiseFactory, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    let timer;
    try {
      return await Promise.race([
        promiseFactory(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error("the server did not respond"), { code: "bw/timeout" })),
            READ_DEADLINE_MS,
          );
        }),
      ]);
    } catch (err) {
      lastErr = err;
      console.warn(`[student] critical start-up read attempt ${i + 1}/${tries} failed:`, err?.code ?? err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

onAuthStateChanged(auth, async (user) => {
  clearTimeout(_safeReveal);
  if (!user) {
    document.documentElement.style.visibility = "visible";
    window.location.href = "/";
    return;
  }

  try {
    // Maintenance + admin force-logout check. The same document also carries
    // the school-wide ARIA policy, so read it once and use it for both.
    try {
      // One attempt with a deadline — this read is optional (its failure leaves
      // maintenance/ARIA at their safe defaults), it just must not hang.
      const settingsSnap = await readCritical(() => getDoc(doc(db, "admin", "settings")), 1);
      const settings = settingsSnap.exists() ? settingsSnap.data() : {};
      if (settings.maintenanceMode === true) {
        await signOut(auth);
        window.location.href = "/?maintenance=1";
        return;
      }
      if (shouldForceLogout(settingsSnap, user)) {
        await signOut(auth);
        window.location.href = "/";
        return;
      }
      // Unset means allowed — a school that has never touched the switch keeps
      // ARIA, and a failed read below leaves the default (allowed) in place.
      setAriaAvailability(
        settings.ariaStudentsEnabled !== false,
        "ARIA has been turned off for students by a school administrator.",
      );
    } catch (_) {}

    const userRef = doc(db, "users", user.uid);
    let userSnap = await readCritical(() => getDoc(userRef));

    if (!userSnap.exists()) {
      await setDoc(userRef, {
        name: user.displayName ?? "",
        email: user.email ?? "",
        role: "student",
        banned: false,
        class: null,
        createdAt: serverTimestamp(),
      });
      userSnap = await getDoc(userRef);
    }

    const role = userSnap.data().role;
    if (role === "teacher") {
      window.location.href = "/teacher.html";
      return;
    }
    if (role === "admin") {
      window.location.href = "/admin.html";
      return;
    }

    userData = userSnap.data();
    currentUser = user;
    classTeacherId = userData.class ?? null;

    // Ban check
    if (userData.banned) {
      const expiry = userData.banExpiry?.toDate?.();
      if (expiry && expiry < new Date()) {
        await updateDoc(userRef, {
          banned: false,
          banExpiry: null,
          banReason: null,
        });
      } else {
        const days = expiry
          ? Math.ceil((expiry - new Date()) / 86400000)
          : "permanently";
        const reason = userData.banReason ?? "Not specified";
        await signOut(auth);
        window.location.href = `/?banned=1&reason=${encodeURIComponent(
          reason,
        )}&days=${days}`;
        return;
      }
    }

    // Load / create student doc
    const sRef = doc(db, "students", user.uid);
    let sSnap = await readCritical(() => getDoc(sRef));
    if (!sSnap.exists()) {
      await setDoc(sRef, {
        name: user.displayName ?? "",
        email: user.email ?? "",
        currentBook: null,
        wishlist: [],
        wishlistMeta: {},
        banned: false,
      });
      sSnap = await getDoc(sRef);
    }
    studentData = sSnap.data();
    addedTeacherIds = studentData.addedTeachers ?? [];

    await loadMyRecIds();

    // Init UI
    populateTopBar();
    initCoverFallback();
    initTheme();
    initARIA(toast);
    initAriaChat('ariaChatMount', 'student', () => studentData?.readingProfile);
    initAriaRecommends('ariaRecommendsMount', 'student', () => studentData?.readingProfile);
    initSettingsModal();
    initStaySignedIn((stay) => setPersistence(auth, stay ? browserLocalPersistence : browserSessionPersistence));
    setupRetakeQuiz();
    setupReplayIntro();
    setupSignout();
    setupSettingsControls();
    populateSettingsInfo();
    renderWishlist();
    // Must run BEFORE the first library is selected below — it's what makes a
    // Class Only library readable at all for anyone who joined before the
    // membership marker existed.
    await ensureLibraryAccessMarkers();
    await loadTeachers();

    // Welcome toast (once per session)
    if (!sessionStorage.getItem("bw-welcomed")) {
      const first = (currentUser.displayName ?? "").split(" ")[0] || "there";
      setTimeout(
        () =>
          toast(
            `Welcome back, ${esc(first)} <i class='bi bi-hand-wave-fill'></i>`,
            "success",
          ),
        800,
      );
      sessionStorage.setItem("bw-welcomed", "1");
    }

    // Auto-select a linked library. Try each in turn rather than only the
    // first: a class teacher whose account was deleted (or whose doc read
    // fails) used to abort the whole thing, leaving a student who HAS joined
    // libraries staring at the "add a library code" prompts on every card.
    if (!(await autoSelectFirstLibrary())) refreshSidePlaceholders();
    hidePreloader();
    // Sequential per-wishlist-item lookups — not essential to first paint.
    renderNotifications();

    // A class QR code or share link carries the code in ?join= — claim it now,
    // before onboarding, so the intro opens over a library they already have.
    await consumePendingJoinCode();

    // First-run intro slideshow, then the reading-preferences quiz. Both run
    // after the preloader is gone: a modal that opens *behind* the splash
    // screen is exactly how an intro ends up looking like it never fired.
    runFirstRunOnboarding();
  } catch (err) {
    console.error("[student] Init failed:", err);
    document.documentElement.style.visibility = "visible";
    hidePreloader();
    toast(
      `Failed to load student portal: ${
        err.message ?? "unknown error"
      }. Try refreshing.`,
      "danger",
    );
  }
});

// ── Top bar ───────────────────────────────────────────────────────────────────
function populateTopBar() {
  const av = document.getElementById("userAvatar");
  const nameEl = document.getElementById("userDisplayName");
  if (!currentUser) return;
  const display = currentUser.displayName ?? currentUser.email ?? "?";
  const initials = display
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  if (av) av.textContent = initials;
  if (nameEl) nameEl.textContent = display.split(" ")[0];
}

// ── First-run onboarding: intro slideshow, then the reading quiz ──────────────
/** Runs both first-run steps in order, skipping whichever the student has
 *  already seen. Never blocks the portal — it is deliberately not awaited. */
async function runFirstRunOnboarding() {
  await maybeRunWelcomeTour();
  await maybeRunOnboardingQuiz();
}

/** The intro slideshow. Shown once per account; "seen" lives on the student
 *  doc so it follows them across devices and so the admin portal's "Replay
 *  Onboarding" button can actually bring it back. */
async function maybeRunWelcomeTour() {
  if (studentData?.welcomeSeenAt) return;
  await showWelcomeTour();
}

async function showWelcomeTour() {
  await runWelcomeTour("student");
  try {
    await updateDoc(doc(db, "students", currentUser.uid), {
      welcomeSeenAt: serverTimestamp(),
    });
    studentData.welcomeSeenAt = new Date();
  } catch (err) {
    // Not worth interrupting anyone over — worst case the tour shows again.
    console.warn("[student] could not record welcome tour as seen:", err);
  }
}

function setupReplayIntro() {
  const btn = document.getElementById("replayIntroBtn");
  btn?.addEventListener("click", () => {
    closeSettingsModal();
    btn.disabled = true;
    showWelcomeTour().finally(() => { btn.disabled = false; });
  });
}

// ── Reading-preferences quiz (first run + retake) ─────────────────────────────
async function maybeRunOnboardingQuiz() {
  if (studentData?.readingProfile) return; // already taken (or skipped) before
  await runQuizFlow({ silent: false, isFirstRun: true });
}

async function retakeReadingQuiz() {
  await runQuizFlow({ silent: false, isFirstRun: false });
}

async function runQuizFlow({ isFirstRun }) {
  try {
    const answers = await runReadingQuiz('student');
    const profile = answers
      ? { ...answers, completedAt: serverTimestamp() }
      : { skipped: true, skippedAt: serverTimestamp() };
    await updateDoc(doc(db, 'students', currentUser.uid), { readingProfile: profile });
    studentData.readingProfile = profile;
    if (answers) {
      toast(`<i class="bi bi-stars"></i> Thanks! ARIA now knows what you like to read.`, 'success');
      refreshAriaChats();
    } else if (!isFirstRun) {
      toast('No worries; you can take the quiz from here whenever you like.', 'info');
    }
  } catch (err) {
    console.error('[student] Reading quiz failed:', err);
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

// ── Sign out ──────────────────────────────────────────────────────────────────
// Bound at module scope, NOT inside the auth handler. Signing out needs nothing
// but the auth object, yet it used to be wired partway down the start-up chain —
// so anything that threw above it left the user on a page whose Sign Out button
// did nothing. The way out of the app must not depend on the app having loaded.
document
  .getElementById("signoutBar")
  ?.addEventListener("click", () => signOut(auth));
document
  .getElementById("sidebarSignoutBtn")
  ?.addEventListener("click", () => signOut(auth));

function setupSignout() {
  const hint = document.getElementById("signoutEmail");
  if (hint && currentUser) hint.textContent = currentUser.email;
}

// ── Settings: my info ─────────────────────────────────────────────────────────
async function populateSettingsInfo() {
  const emailEl = document.getElementById("settingsEmail");
  if (emailEl) emailEl.textContent = currentUser.email;

  const sec = document.getElementById("myInfoSection");
  if (!sec) return;

  let classText = "Not assigned";
  if (classTeacherId) {
    const tSnap = await getDoc(doc(db, "teachers", classTeacherId));
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
}

// Wired exactly once, at init. populateSettingsInfo() re-runs after a join (to
// refresh the Class row), and binding these there would stack a fresh listener
// on every join — the second one firing a duplicate join for the same code.
function setupSettingsControls() {
  document
    .getElementById("addTeacherCodeBtn")
    ?.addEventListener("click", () => addTeacherByCode());
  document
    .getElementById("teacherCodeInput")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addTeacherByCode();
    });

  // Wishlist-availability alerts toggle (persists to the student doc; honored by
  // renderNotifications). Defaults to on when unset.
  const wishToggle = document.getElementById("notifWishlist");
  if (wishToggle) {
    wishToggle.checked = studentData.notifWishlist !== false;
    wishToggle.addEventListener("change", async () => {
      studentData.notifWishlist = wishToggle.checked;
      try {
        await updateDoc(doc(db, "students", currentUser.uid), {
          notifWishlist: wishToggle.checked,
        });
        renderNotifications();
      } catch (err) {
        console.error("[student] Failed to save notification preference:", err);
        toast("Couldn't save that setting. Try again.", "danger");
      }
    });
  }
}

// ── Teacher code (join library) ───────────────────────────────────────────────
// Guards against a second join running while the first is still in flight. The
// join mutates addedTeacherIds optimistically, so two overlapping runs (a
// double-tapped button, or a ?join= link landing while the student also hits
// Add) could push the same teacher twice and then race on the writes.
let joinInFlight = false;

/** Join a library by class code.
 *  @param {string} [codeArg] code to use instead of the Settings input — this
 *  is how a QR/share link joins without the student typing anything. */
async function addTeacherByCode(codeArg) {
  const input = document.getElementById("teacherCodeInput");
  const code = (codeArg ?? input?.value ?? "").trim().toUpperCase();
  if (!code || joinInFlight) return;

  joinInFlight = true;
  const btn = document.getElementById("addTeacherCodeBtn");
  if (btn) btn.disabled = true;
  try {
    await joinLibraryByCode(code, input);
  } finally {
    joinInFlight = false;
    if (btn) btn.disabled = false;
  }
}

async function joinLibraryByCode(code, input) {
  let teacherId = null,
    classId = null,
    className = "";
  let lookupError = null;

  try {
    // classCodes/{code} is a direct doc-ID lookup — {teacherId, classId} was
    // written when the code was created, so this needs no index and can't be
    // silently blocked by one going missing or still being built.
    const codeSnap = await getDoc(doc(db, "classCodes", code));
    if (codeSnap.exists()) {
      const data = codeSnap.data();
      teacherId = data.teacherId;
      classId = data.classId;
      const classDoc = await getDoc(
        doc(db, "teachers", teacherId, "classes", classId),
      );
      className = classDoc.exists() ? (classDoc.data().name ?? "Class") : "Class";
    }
  } catch (err) {
    // Was silently swallowed — a class-code lookup that fails for a REAL
    // reason (rules regression) looked identical to "no such code," which
    // made this impossible to diagnose from a bug report alone.
    lookupError = err;
    console.error("[student] Class-code lookup failed:", err.code, err.message);
  }

  if (!teacherId) {
    // Legacy fallback. Wrapped because this is a collection QUERY, not a
    // doc-ID get — it can fail on rules or a missing index, and an unhandled
    // rejection here escapes all the way out to the portal's init handler and
    // surfaces as "Failed to load student portal".
    let snap = null;
    try {
      snap = await getDocs(
        query(collection(db, "teachers"), where("inviteCode", "==", code)),
      );
    } catch (err) {
      lookupError ??= err;
      console.error("[student] Legacy invite-code lookup failed:", err.code, err.message);
    }
    if (snap && !snap.empty) {
      teacherId = snap.docs[0].id;
      className = "Class";
      // Legacy teacher-level code. Land the student in a real class anyway:
      // only per-class rosters carry a last-day-of-school date, so the flat
      // `teachers/{id}/students` roster would keep their name and email with no
      // expiry at all. Prefer the teacher's oldest class.
      try {
        const clsSnap = await getDocs(
          collection(db, "teachers", teacherId, "classes"),
        );
        if (!clsSnap.empty) {
          const oldest = clsSnap.docs.sort(
            (a, b) =>
              (a.data().createdAt?.seconds ?? 0) -
              (b.data().createdAt?.seconds ?? 0),
          )[0];
          classId = oldest.id;
          className = oldest.data().name ?? "Class";
        }
      } catch (_) {}
    }
  }

  if (!teacherId) {
    toast(
      lookupError
        ? `Couldn't check that code right now (${esc(lookupError.code ?? lookupError.message ?? "unknown error")}). Try again in a moment.`
        : "Code not found. Double-check with your teacher.",
      "danger",
    );
    return;
  }
  // One teacher, many classes: a student already in Period 1 who is handed
  // Period 2's code still needs the roster write below. Bailing out here on
  // "library already added" (which is what this did) silently dropped them —
  // the library was already listed, so nothing looked wrong, but the teacher
  // never saw them in the second class.
  const alreadyLinked = addedTeacherIds.includes(teacherId);

  if (!alreadyLinked) {
    try {
      await updateDoc(doc(db, "students", currentUser.uid), {
        addedTeachers: arrayUnion(teacherId),
      });
    } catch (err) {
      // Don't leave addedTeacherIds claiming a library the server never
      // recorded — the chip row would show it until reload, then lose it.
      console.error("[student] could not save the joined library:", err);
      toast(
        `Couldn't save that library (${esc(err.code ?? err.message ?? "unknown error")}). Try again.`,
        "danger",
      );
      return;
    }
    addedTeacherIds.push(teacherId);
  }

  const payload = {
    studentId: currentUser.uid,
    name: studentData?.name ?? currentUser.displayName ?? "",
    email: currentUser.email ?? "",
    joinedAt: serverTimestamp(),
    joinedVia: "code",
    // Proof of possession, checked server-side. firestore.rules will not let a
    // student add themselves to a roster unless this resolves — via
    // classCodes/{joinCode}, or the teacher's own legacy inviteCode — to the
    // exact teacher and class being written. Without it the code was a purely
    // client-side formality and anyone could self-enrol into any library.
    joinCode: code,
  };
  // firestore.rules lets a student CREATE their own roster entry but never
  // update one (`allow update: if isAdmin()`), so a blind setDoc over an entry
  // that already exists is a permission-denied — which is what re-scanning a
  // QR code, or joining a teacher's second class, would do. Write only what's
  // actually missing.
  const setIfAbsent = async (ref, data) => {
    if ((await getDoc(ref)).exists()) return;
    await setDoc(ref, data);
  };

  const markerRef = doc(db, "teachers", teacherId, "students", currentUser.uid);
  let rosterError = null;
  try {
    if (classId) {
      await setIfAbsent(
        doc(db, "teachers", teacherId, "classes", classId, "students", currentUser.uid),
        payload,
      );
      // …AND a membership marker on the teacher's flat roster.
      //
      // firestore.rules grants access to a Class Only library by checking
      // `exists(teachers/{tid}/students/{uid})` — the flat roster. Writing only
      // the per-class roster (as this did) meant every student who joined with a
      // class code was denied every book read, checkout, and rental request in
      // any library that wasn't public: they'd see "Joined!" and then an empty
      // or broken library, which is precisely the reported symptom.
      //
      // The marker deliberately carries NO name or email. The class roster is
      // the record with personal data, and it is the one tied to a last day of
      // school; duplicating the PII out here would put a copy of it somewhere
      // with no expiry at all. retention.js deletes the marker alongside the
      // class roster it belongs to.
      await setIfAbsent(markerRef, {
        studentId: currentUser.uid,
        classId,
        joinedAt: serverTimestamp(),
        joinedVia: "code",
        membershipOnly: true,
      });
    } else {
      await setIfAbsent(markerRef, payload);
    }
  } catch (err) {
    rosterError = err;
    console.error("[student] roster write failed:", err);
  }

  if (input) input.value = "";
  if (rosterError) {
    toast(
      `Library added, but your teacher's roster didn't accept the join (${esc(
        rosterError.code ?? rosterError.message ?? "unknown error",
      )}). Checking books out may not work until that is sorted, so let your teacher know.`,
      "danger",
    );
  } else if (alreadyLinked) {
    toast(
      `<i class='bi bi-check2'></i> You're now in ${esc(className)}; this library was already on your list.`,
      "success",
    );
  } else {
    toast(
      `<i class='bi bi-check2'></i> Joined ${esc(className)}! Library added.`,
      "success",
    );
  }
  renderAddedTeachersList();
  await loadTeachers();

  // Actually open the library they just joined. Without this the join only
  // refreshed the chip row — the code is entered from inside the Settings
  // modal, so the student was left looking at Settings with the book list
  // still on its "pick a library" placeholder, and nothing appeared to have
  // happened at all.
  let teacherName = "Library";
  try {
    const tSnap = await getDoc(doc(db, "teachers", teacherId));
    if (tSnap.exists()) teacherName = teacherLabel(tSnap.data());
  } catch (_) {}
  closeSettingsModal();
  showPage("library");
  await setSelectedTeacher(teacherId, teacherName);

  // The notifications banner and the Settings "Class" row were both computed
  // before this library existed, so without these the student is left staring
  // at "Join a library to see notifications" on a page that just joined one.
  renderNotifications();
  populateSettingsInfo();
}

/** Backfill the flat-roster membership marker for libraries this student
 *  joined BEFORE that marker started being written.
 *
 *  Those students are on a class roster but have nothing at
 *  `teachers/{tid}/students/{uid}`, which is the only thing firestore.rules
 *  looks at when deciding whether to serve a Class Only library — so without
 *  this they stay locked out of libraries they legitimately joined until they
 *  re-enter the code. Costs one read per linked library in the healthy case,
 *  and only goes looking through the class rosters when the marker is missing.
 *
 *  Deliberately conservative: the marker is only written when the student is
 *  genuinely listed on one of that teacher's class rosters.
 *
 *  EXPECT THIS TO FAIL for most students now, and that is intended. Finding the
 *  right class means LISTING the teacher's classes, and firestore.rules no
 *  longer lets a non-member do that: a class document carries its own
 *  inviteCode, so anyone able to enumerate classes could read a join code
 *  straight off one and let themselves into the library. Single-document reads
 *  still work, so the ordinary join path is unaffected — it learns classId from
 *  classCodes/{code}.
 *
 *  The loop is already per-teacher try/catch, so a denial here is silent and
 *  harmless; the student simply re-enters their class code, which rebuilds the
 *  marker properly. This only ever mattered for accounts that joined before the
 *  marker existed. */
async function ensureLibraryAccessMarkers() {
  const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  for (const tid of ids) {
    try {
      const markerRef = doc(db, "teachers", tid, "students", currentUser.uid);
      if ((await getDoc(markerRef)).exists()) continue;

      let classId = null;
      const classesSnap = await getDocs(collection(db, "teachers", tid, "classes"));
      for (const c of classesSnap.docs) {
        const entry = await getDoc(
          doc(db, "teachers", tid, "classes", c.id, "students", currentUser.uid),
        );
        if (entry.exists()) { classId = c.id; break; }
      }
      if (!classId) continue; // not on any roster — nothing to grant

      await setDoc(markerRef, {
        studentId: currentUser.uid,
        classId,
        joinedAt: serverTimestamp(),
        joinedVia: "backfill",
        membershipOnly: true,
      });
      console.info("[student] restored library access marker for teacher", tid);
    } catch (err) {
      console.warn("[student] could not verify library access for teacher", tid, err);
    }
  }
}

// ── Joining from a QR code / share link ───────────────────────────────────────
/** Claim a class code carried in `?join=` — either on this URL (an already
 *  signed-in student following the link) or parked by index.html while the
 *  student signed in. Silently does nothing when there's no code. */
async function consumePendingJoinCode() {
  let code = readJoinCode();
  if (code) {
    // Strip it from the address bar so a refresh doesn't re-run the join and
    // so the code isn't left sitting in the student's history.
    history.replaceState(null, "", window.location.pathname);
  } else {
    try {
      code = localStorage.getItem(PENDING_JOIN_KEY) ?? "";
    } catch (_) {
      code = "";
    }
  }
  try { localStorage.removeItem(PENDING_JOIN_KEY); } catch (_) {}
  if (!code) return;
  // A code for a library they're already in reports itself as "already added".
  await addTeacherByCode(code);
}

async function renderAddedTeachersList() {
  const container = document.getElementById("addedTeachersList");
  if (!container) return;
  // Clearing has to happen even when the list is empty. Bailing out early left
  // the just-removed library's row on screen until the next page load, so
  // "Remove" looked like it had done nothing at all.
  container.innerHTML = "";
  if (addedTeacherIds.length === 0) return;
  for (const tid of addedTeacherIds) {
    const snap = await getDoc(doc(db, "teachers", tid));
    if (!snap.exists()) continue;
    const t = snap.data();
    const row = document.createElement("div");
    row.className = "settings-row";
    row.innerHTML = `
      <div>
        <div class='settings-label'>${esc(teacherLabel(t))}'s Library</div>
        <div class='settings-hint'>${esc(t.email)}</div>
      </div>
      <button class='btn btn--ghost btn--sm' style='color:var(--danger);border-color:var(--danger-border)' data-remove='${esc(
        tid,
      )}'>Remove</button>`;
    row.querySelector("[data-remove]")?.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.remove;
      addedTeacherIds = addedTeacherIds.filter((x) => x !== id);
      await updateDoc(doc(db, "students", currentUser.uid), {
        addedTeachers: arrayRemove(id),
      });
      // Remove the roster entry (name + email) from BOTH the legacy flat roster
      // and the per-class rosters. Students who joined with a class code live in
      // classes/{classId}/students, so deleting only the flat doc left their
      // name and email in the teacher's roster forever after they "removed" the
      // library — the student had no way to actually withdraw their data.
      try {
        await deleteDoc(doc(db, "teachers", id, "students", currentUser.uid));
      } catch (_) {}
      try {
        const classesSnap = await getDocs(
          collection(db, "teachers", id, "classes"),
        );
        await Promise.all(
          classesSnap.docs.map((c) =>
            deleteDoc(
              doc(
                db,
                "teachers",
                id,
                "classes",
                c.id,
                "students",
                currentUser.uid,
              ),
            ).catch(() => {}),
          ),
        );
      } catch (_) {}
      toast("Library removed.", "info");
      renderAddedTeachersList();
      await loadTeachers();
    });
    container.appendChild(row);
  }
}

// ── Notifications banner ──────────────────────────────────────────────────────
async function renderNotifications() {
  const inner = document.getElementById("notifBannerInner");
  if (!inner) return;
  inner.innerHTML = "";
  const notifs = [];
  const wishlist = studentData.wishlist ?? [];
  const notifTeacherId = selectedTeacherId ?? classTeacherId;
  const wishlistAlertsOn = studentData.notifWishlist !== false;

  if (wishlistAlertsOn && wishlist.length > 0 && notifTeacherId) {
    for (const bookId of wishlist.slice(0, 5)) {
      try {
        const bSnap = await getDoc(
          doc(db, "teachers", notifTeacherId, "books", bookId),
        );
        if (bSnap.exists() && bSnap.data().status === "available")
          notifs.push({
            text: `"${bSnap.data().title}" is now available`,
            tag: "Library",
          });
      } catch (_) {}
    }
  }

  if (notifTeacherId) {
    const tSnap = await getDoc(doc(db, "teachers", notifTeacherId));
    if (tSnap.exists()) {
      const t = tSnap.data();
      if (t.currentlyReading)
        notifs.push({
          text: `${t.name} is reading "${t.currentlyReading.title}"`,
          tag: "Teacher",
        });
      try {
        const recSnap = await getDocs(
          collection(db, "teachers", notifTeacherId, "recommendations"),
        );
        if (!recSnap.empty)
          notifs.push({
            text: `${t.name} recommended "${recSnap.docs[0].data().bookTitle}"`,
            tag: "Rec",
          });
      } catch (_) {}
    }
  }

  if (notifs.length === 0) {
    const noLib = !classTeacherId && addedTeacherIds.length === 0;
    const div = document.createElement("div");
    div.className = "notif-item";
    div.innerHTML = `<span class='notif-dot notif-dot--dim'></span><span class='notif-text'>${
      noLib ? "Join a library to see notifications." : "No new notifications."
    }</span>`;
    inner.appendChild(div);
  } else {
    notifs.slice(0, 3).forEach((n) => {
      const div = document.createElement("div");
      div.className = "notif-item";
      div.innerHTML = `<span class='notif-dot'></span><div><div class='notif-text'>${esc(
        n.text,
      )}</div><div class='notif-time'>${esc(n.tag)}</div></div>`;
      inner.appendChild(div);
    });
  }
}

// ── Load teachers ─────────────────────────────────────────────────────────────
async function loadTeachers() {
  const teacherListEl = document.getElementById("teacherList");
  if (!teacherListEl) return;

  const ids = new Set();
  if (classTeacherId) ids.add(classTeacherId);
  addedTeacherIds.forEach((id) => ids.add(id));

  if (ids.size === 0) {
    renderNoLibraryCta(teacherListEl);
    await renderAllLibraries();
    return;
  }

  // Fetch the linked teacher docs concurrently rather than one round trip at a
  // time, and keep any read failure attached to its own id instead of letting
  // one rejection abandon the whole list.
  const fetched = await Promise.all(
    [...ids].map(async (tid) => {
      try {
        const snap = await getDoc(doc(db, "teachers", tid));
        return { tid, data: snap.exists() ? snap.data() : null, err: null };
      } catch (err) {
        console.error("[student] could not read teacher", tid, err.code ?? err);
        return { tid, data: null, err };
      }
    }),
  );

  teacherListEl.innerHTML = "";
  for (const { tid, data } of fetched) {
    if (!data) continue;
    const name = teacherLabel(data);
    const btn = document.createElement("button");
    btn.className = "library-chip";
    btn.dataset.tid = tid;
    btn.textContent = name;
    btn.addEventListener("click", () => setSelectedTeacher(tid, name));
    teacherListEl.appendChild(btn);
  }

  // Every linked library failed to resolve — a deleted teacher account, or a
  // read that errored. Previously this silently left an empty box under the
  // "Select a Library" heading with nothing to click and no explanation.
  if (!teacherListEl.childElementCount) {
    const unreadable = fetched.some((f) => f.err);
    renderNoLibraryCta(teacherListEl, unreadable
      ? "Your libraries couldn't be loaded just now. Check your connection and refresh."
      : "The libraries you joined are no longer available. Ask your teacher for a current class code.");
  }
  await renderAllLibraries();
}

/** The empty state for the library selector. Shared so that "you have joined
 *  nothing" and "nothing you joined could be loaded" can never diverge into one
 *  of them rendering a blank panel. */
function renderNoLibraryCta(el, subtitle) {
  el.innerHTML = "";
  const cta = document.createElement("div");
  cta.className = "no-library-cta";
  cta.innerHTML = `
    <div class='no-library-icon'><i class='bi bi-collection-fill'></i></div>
    <div class='no-library-title'>No libraries linked yet</div>
    <div class='no-library-sub'>${esc(subtitle ?? "Ask your teacher for their class code, then add it in Settings.")}</div>
    <button class='btn btn--primary' id='ctaAddLibraryBtn'>Add a Library Code</button>`;
  el.appendChild(cta);
  document.getElementById("ctaAddLibraryBtn")?.addEventListener("click", () => {
    showPage("settings");
    setTimeout(() => {
      document.getElementById("teacherCodeInput")?.scrollIntoView({ behavior: "smooth", block: "center" });
      document.getElementById("teacherCodeInput")?.focus();
    }, 120);
  });
}

// ── All Libraries discovery ───────────────────────────────────────────────────
async function renderAllLibraries() {
  let allLibEl = document.getElementById("allLibrariesSection");
  if (!allLibEl) return;
  allLibEl.innerHTML = "";

  const snap = await getDocs(collection(db, "teachers"));
  if (snap.empty) return;

  const myIds = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const enrolled = all.filter((t) => myIds.has(t.id));
  const publicLibs = all.filter(
    (t) => !myIds.has(t.id) && (t.libraryPublic ?? false),
  );

  if (enrolled.length === 0 && publicLibs.length === 0) return;

  const wrapper = document.createElement("div");
  wrapper.className = "all-libraries-section";

  function buildCard(t) {
    const isLinked = myIds.has(t.id);
    const isPublic = t.libraryPublic ?? false;
    const card = document.createElement("div");
    card.className = "all-lib-card";
    card.innerHTML = `
      <div class='all-lib-name'>${esc(teacherLabel(t))}</div>
      <div class='all-lib-email'>${esc(t.email ?? "")}</div>
      <div class='all-lib-tags'>
        ${
          isLinked
            ? `<span class='alib-badge alib-badge--enrolled'><i class='bi bi-check2'></i> Enrolled</span>`
            : ""
        }
        ${
          isPublic
            ? `<span class='alib-badge alib-badge--public'><i class='bi bi-collection-fill'></i> Public</span>`
            : `<span class='alib-badge alib-badge--classonly'><i class='bi bi-lock-fill'></i> Class Only</span>`
        }
      </div>
      <div class='all-lib-actions'>
        <button class='btn btn--sm alib-browse' data-tid='${esc(
          t.id,
        )}' data-name='${esc(t.name)}'>
          <i class='bi bi-book-fill'></i> Browse
        </button>
        ${
          isPublic && !isLinked
            ? `<button class='btn btn--sm' style='color:var(--info);border-color:rgba(52,152,219,.4)' data-tid='${esc(
                t.id,
              )}' data-name='${esc(t.name)}' data-email='${esc(
                t.email ?? "",
              )}' data-action='request'>
               <i class='bi bi-envelope-fill'></i> Request Access
             </button>`
            : ""
        }
      </div>`;
    card.querySelector(".alib-browse")?.addEventListener("click", (e) => {
      const { tid, name } = e.currentTarget.dataset;
      setSelectedTeacher(tid, name);
    });
    card
      .querySelector('[data-action="request"]')
      ?.addEventListener("click", (e) => {
        const { name, email } = e.currentTarget.dataset;
        const subject = encodeURIComponent("BookWare Library Access Request");
        const body = encodeURIComponent(
          `Hi ${name},\n\nI'd like to join your BookWare class.\n\nMy name: ${
            studentData?.name ?? ""
          }\nEmail: ${currentUser?.email ?? ""}\n\nThank you!`,
        );
        window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
      });
    return card;
  }

  if (enrolled.length > 0) {
    const h = document.createElement("div");
    h.className = "section-label";
    h.style.marginBottom = "10px";
    h.innerHTML =
      '<i class="bi bi-check2" aria-hidden="true"></i> My Libraries';
    wrapper.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "all-lib-grid";
    enrolled.forEach((t) => grid.appendChild(buildCard(t)));
    wrapper.appendChild(grid);
  }

  if (publicLibs.length > 0) {
    const h = document.createElement("div");
    h.className = "section-label";
    h.style.cssText = "margin-bottom:8px;margin-top:18px";
    h.innerHTML =
      '<i class="bi bi-collection-fill" aria-hidden="true"></i> Discover Public Libraries';
    const hint = document.createElement("p");
    hint.className = "empty-state";
    hint.style.marginBottom = "10px";
    hint.textContent =
      "Browse freely. To check a book out, ask the teacher for their class code.";
    wrapper.appendChild(h);
    wrapper.appendChild(hint);
    const grid = document.createElement("div");
    grid.className = "all-lib-grid";
    publicLibs.forEach((t) => grid.appendChild(buildCard(t)));
    wrapper.appendChild(grid);
  }

  allLibEl.appendChild(wrapper);
}

/** Correct the two side cards when no library ended up selected.
 *
 *  Their static markup says "Join a library using your teacher's code" with an
 *  Add a Code button — right for a student with no libraries, wrong and
 *  confusing for one who has several but whose libraries couldn't be opened.
 *  Tell them which situation they're actually in. */
function refreshSidePlaceholders() {
  const hasLibraries = !!classTeacherId || addedTeacherIds.length > 0;
  const rec  = document.getElementById("recCardPlaceholder");
  const read = document.getElementById("readingCardPlaceholder");
  if (!hasLibraries) return; // the default copy is already correct

  if (rec) {
    rec.innerHTML = `
      <div class='section-label'><i class='bi bi-star-fill' aria-hidden='true'></i> Recommended by Your Teacher</div>
      <p class='empty-state'>Pick a library above to see what your teacher recommends.</p>`;
  }
  if (read) {
    read.innerHTML = `
      <div class='section-label'><i class='bi bi-book-fill' aria-hidden='true'></i> Your Teacher Is Reading</div>
      <p class='empty-state'>Pick a library above to see what your teacher is reading.</p>`;
  }
}

/** Open the first linked library that actually resolves. Returns true if one
 *  was selected. */
async function autoSelectFirstLibrary() {
  const ids = [classTeacherId, ...addedTeacherIds].filter(Boolean);
  for (const tid of ids) {
    try {
      const tSnap = await getDoc(doc(db, "teachers", tid));
      if (!tSnap.exists()) continue;
      await setSelectedTeacher(tid, teacherLabel(tSnap.data()));
      return true;
    } catch (err) {
      console.warn("[student] could not open library", tid, err);
    }
  }
  return false;
}

async function setSelectedTeacher(tid, name) {
  selectedTeacherId = tid;
  selectedTeacherName = name;
  document
    .querySelectorAll("#teacherList .library-chip")
    .forEach((b) => b.classList.toggle("selected", b.dataset.tid === tid));
  // Cache teacher doc to check requireApproval flag
  try {
    const tSnap = await getDoc(doc(db, "teachers", tid));
    _selectedTeacherData = tSnap.exists() ? tSnap.data() : null;
  } catch (_) {
    _selectedTeacherData = null;
  }
  await loadTeacherBooks(tid);
  // Fire-and-forget: these are sidebar cards (recs + now-reading), not the
  // book list itself, so a caller waiting on this function — including the
  // initial portal load, which reveals the page right after it resolves —
  // shouldn't sit through their several sequential reads too.
  renderTeacherExtras(tid, name);
}

// ── Teacher extras (recs + now reading) ───────────────────────────────────────
// Bumped on every call so a slower earlier render can't overwrite a newer one.
let extrasRun = 0;

async function renderTeacherExtras(tid, name) {
  const myRun = ++extrasRun;
  const tSnap = await getDoc(doc(db, "teachers", tid));
  const t = tSnap.exists() ? tSnap.data() : {};

  // Recommendations card
  const recCard = document.createElement("div");
  recCard.className = "panel-card";
  recCard.id = "recCardPlaceholder";
  recCard.innerHTML = `<div class='section-label'><i class='bi bi-star-fill' aria-hidden='true'></i> Recommended by ${esc(
    name,
  )}</div>`;
  const recSnap = await getDocs(
    collection(db, "teachers", tid, "recommendations"),
  );
  if (recSnap.empty) {
    recCard.innerHTML += `<p class='empty-state'>No recommendations yet.</p>`;
  } else {
    recSnap.forEach((d) => {
      const r = d.data();
      const row = document.createElement("div");
      row.className = "book-row";
      row.innerHTML = `
        ${
          r.coverUrl
            ? `<img src='${esc(r.coverUrl)}' class='book-cover' alt=''>`
            : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`
        }
        <div class='book-info'>
          <div class='book-title'>${esc(r.bookTitle)}</div>
          ${
            r.author
              ? `<div class='book-author'>${esc(r.author)}</div>`
              : `<span class='badge badge--reading'><span class='badge--dot'></span>Recommended</span>`
          }
        </div>`;
      recCard.appendChild(row);
    });
  }

  // Now reading card
  const readCard = document.createElement("div");
  readCard.className = "panel-card";
  readCard.id = "readingCardPlaceholder";
  if (t.currentlyReading) {
    const r = t.currentlyReading;
    readCard.innerHTML = `
      <div class='section-label'><i class='bi bi-book-fill' aria-hidden='true'></i> ${esc(
        name,
      )} Is Reading</div>
      <div class='book-row'>
        ${
          r.coverUrl
            ? `<img src='${esc(
                r.coverUrl,
              )}' class='book-cover' style='border-color:var(--accent)' alt=''>`
            : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`
        }
        <div class='book-info'>
          <div class='book-title'>${esc(r.title)}</div>
          <div class='book-author'>${esc(r.author)}</div>
        </div>
      </div>`;
  } else {
    readCard.innerHTML = `
      <div class='section-label'><i class='bi bi-book-fill' aria-hidden='true'></i> ${esc(
        name,
      )} Is Reading</div>
      <p class='empty-state'>Nothing set yet.</p>`;
  }

  // Two things matter here, and both used to be wrong.
  //
  // 1. Look the placeholders up NOW, not before the awaits above. They were
  //    captured up front, so when two renders overlapped — the initial
  //    auto-select and a join, or two quick chip taps — the second one held a
  //    reference to a node the first had already replaced. replaceWith() on a
  //    detached node does nothing at all, silently, so the newer (correct)
  //    cards were dropped and the teacher's current read never appeared.
  // 2. Bail if a newer render started while this one was waiting, so the
  //    slower of two overlapping runs can't win.
  if (myRun !== extrasRun) return;
  document.getElementById("recCardPlaceholder")?.replaceWith(recCard);
  document.getElementById("readingCardPlaceholder")?.replaceWith(readCard);
}

// ── Skeleton helpers ──────────────────────────────────────────────────────────
function renderSkeletonRows(container, count = 5) {
  container.innerHTML = Array.from(
    { length: count },
    () => `
    <div class='skeleton-book-row'>
      <div class='skeleton skeleton-book-cover'></div>
      <div class='skeleton-book-info'>
        <div class='skeleton skeleton-line-title'></div>
        <div class='skeleton skeleton-line-author'></div>
        <div class='skeleton skeleton-line-badge'></div>
      </div>
    </div>`,
  ).join("");
}

// ── Load teacher books ────────────────────────────────────────────────────────
async function loadTeacherBooks(tid) {
  const bookListEl = document.getElementById("bookList");
  if (!bookListEl) return;
  renderSkeletonRows(bookListEl, 6);

  const myIds = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  const isEnrolled = myIds.has(tid);

  if (!isEnrolled) {
    try {
      const tSnap = await getDoc(doc(db, "teachers", tid));
      if (!tSnap.exists() || !tSnap.data().libraryPublic) {
        bookListEl.innerHTML = `<p class='empty-state'><i class='bi bi-lock-fill'></i> This library is class-only. Ask the teacher for their class code to join.</p>`;
        allBooks = [];
        return;
      }
    } catch (_) {
      bookListEl.innerHTML = `<p class='empty-state'>Could not verify library access.</p>`;
      return;
    }
  }

  let snap;
  try {
    snap = await getDocs(collection(db, "teachers", tid, "books"));
  } catch (err) {
    // Unhandled, this rejected all the way back out through setSelectedTeacher
    // into whatever triggered it — leaving the skeleton rows spinning forever
    // with no message, which is what a freshly-joined student saw whenever the
    // library was Class Only and their roster entry hadn't registered.
    console.error("[student] could not read library books:", err);
    allBooks = [];
    bookListEl.innerHTML = `<p class='empty-state'>Couldn't load this library's books (${esc(
      err.code ?? err.message ?? "unknown error",
    )}). If you have only just joined, refresh the page; if it keeps happening, ask your teacher to re-share their class code.</p>`;
    return;
  }

  if (snap.empty) {
    bookListEl.innerHTML = `<p class='empty-state'>No books in this library yet.</p>`;
    allBooks = [];
    return;
  }

  allBooks = snap.docs.map((d) => {
    const data = { id: d.id, teacherId: tid, ...d.data() };
    bookCache.set(d.id, {
      title: data.title,
      author: data.author,
      isbn: data.isbn,
      coverUrl: data.coverUrl,
      teacherId: tid,
    });
    return data;
  });
  filterAndRenderBooks();
  renderWishlist();
  await setupWishlistNotifications();
}

// ── Search ────────────────────────────────────────────────────────────────────
document
  .getElementById("searchInput")
  ?.addEventListener("input", filterAndRenderBooks);

function filterAndRenderBooks() {
  // `raw` keeps the student's own capitalization for the "no matches" message;
  // `term` is the lowercased form the filter compares against.
  const raw = (document.getElementById("searchInput")?.value ?? "").trim();
  const term = raw.toLowerCase();
  const list = term
    ? allBooks.filter(
        (b) =>
          b.title?.toLowerCase().includes(term) ||
          b.author?.toLowerCase().includes(term) ||
          b.isbn?.toLowerCase().includes(term),
      )
    : allBooks;
  renderBooks(list, raw);
}

// ── Book detail modal ─────────────────────────────────────────────────────────

/** Ask the cover host for a bigger image than the list thumbnail.
 *
 *  Both providers encode the size in the URL, so there is no second lookup to
 *  do. Open Library sizes are S/M/L; Google Books uses a zoom level. Anything
 *  else is returned untouched. The caller must keep the original as an onerror
 *  fallback: Open Library's `?default=false` 404s when it has no large scan,
 *  which is exactly the case a blind swap would turn into a broken image. */
function upscaleCover(url) {
  if (!url) return "";
  if (url.includes("covers.openlibrary.org")) return url.replace(/-M\.jpg/, "-L.jpg");
  // Replacer function, not "$13": that only means "group 1 then a literal 3"
  // because there is no group 13, and it stops meaning that the moment
  // someone adds a capture group.
  if (url.includes("books.google")) return url.replace(/([?&]zoom=)\d/, (_, p) => `${p}3`);
  return url;
}

/** Best available Google Books destination for a book.
 *
 *  `sourceId` is whichever provider the teacher added it from: a Google volume
 *  id, or an Open Library key, which always begins with "/" (e.g. /works/OL1W).
 *  Only the first is addressable on Google Books, so an OL-sourced book falls
 *  through to an ISBN lookup, and a book with neither to a plain search. */
function googleBooksUrl(book) {
  const id = (book.sourceId ?? "").trim();
  if (id && !id.startsWith("/")) {
    return `https://books.google.com/books?id=${encodeURIComponent(id)}`;
  }
  const isbn = (book.isbn ?? "").replace(/[^0-9Xx]/g, "");
  if (isbn) return `https://books.google.com/books?vid=ISBN${encodeURIComponent(isbn)}`;
  const q = [book.title, book.author].filter(Boolean).join(" ");
  return `https://www.google.com/search?tbm=bks&q=${encodeURIComponent(q)}`;
}

let _bookModalLastFocus = null;

function closeBookModal() {
  const modal = document.getElementById("bookModal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.style.overflow = "";
  _bookModalLastFocus?.focus?.();
  _bookModalLastFocus = null;
}

/** Everything the list row has to truncate: the full blurb, the identifiers,
 *  and a way out to Google Books. */
function openBookModal(book) {
  const modal = document.getElementById("bookModal");
  const body  = document.getElementById("bookModalBody");
  if (!modal || !body || !book) return;

  const copies = book.copies ?? 1;
  const out    = book.checkedOutCount ?? (book.status === "checked_out" ? 1 : 0);
  const avail  = copies - out;

  const facts = [
    copies > 1 ? `${avail} of ${copies} copies available` : avail > 0 ? "Available" : "Checked out",
    book.isbn ? `ISBN ${esc(book.isbn)}` : "",
  ].filter(Boolean);

  const big = upscaleCover(book.coverUrl);
  const cover = book.coverUrl
    ? `<img src='${esc(big)}' class='book-modal-cover' alt='Cover of ${esc(book.title)}'
            onerror="this.onerror=null;this.src='${esc(book.coverUrl)}'">`
    : `<div class='book-modal-cover book-modal-cover-ph' aria-hidden='true'><i class='bi bi-book-fill'></i></div>`;

  body.innerHTML = `
    <div class='book-modal-grid'>
      <div>${cover}</div>
      <div>
        <div class='book-modal-title' id='bookModalTitle'>${esc(book.title)}</div>
        <div class='book-modal-author'>${esc(book.author ?? "Unknown author")}</div>
        <div class='book-modal-facts'>${facts.map(f => `<span>${f}</span>`).join("")}</div>
        ${
          book.description
            ? `<div class='book-modal-section-label'>About this book</div>
               <div class='book-modal-desc'>${esc(book.description)}</div>`
            : `<div class='book-modal-desc' style='color:var(--text-3)'>
                 No description was saved for this book. The Google Books page below usually has one.
               </div>`
        }
        <div class='book-modal-actions'>
          <a class='btn btn--sm' href='${esc(googleBooksUrl(book))}' target='_blank' rel='noopener noreferrer'>
            <i class='bi bi-box-arrow-up-right' aria-hidden='true'></i> View on Google Books
          </a>
        </div>
      </div>
    </div>`;

  _bookModalLastFocus = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  document.getElementById("bookModalClose")?.focus();
}

document.getElementById("bookModalClose")?.addEventListener("click", closeBookModal);
// Backdrop click only: a click that started inside the box and drifted out
// while selecting text should not dismiss it.
document.getElementById("bookModal")?.addEventListener("mousedown", (e) => {
  if (e.target.id === "bookModal") closeBookModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeBookModal();
});

// ── Render books ──────────────────────────────────────────────────────────────
function renderBooks(books, searchTerm = "") {
  const bookListEl = document.getElementById("bookList");
  if (!bookListEl) return;
  if (books.length === 0) {
    // "No books match your search" with an empty search box is nonsense — it
    // reads as a broken library rather than an empty one. Say which it is.
    bookListEl.innerHTML = searchTerm
      ? `<p class='empty-state'>No books match “${esc(searchTerm)}”.</p>`
      : selectedTeacherId
      ? `<p class='empty-state'>This library doesn't have any books yet.</p>`
      : `<p class='empty-state'>Pick a library above to browse books.</p>`;
    return;
  }

  const hasBook = !!studentData?.currentBook;
  const wishlist = studentData?.wishlist ?? [];
  const myRecs = studentData?.myRecIds ?? new Set();
  const reading = new Set(
    (studentData?.currentlyReading ?? []).map((r) => r.bookId),
  );
  bookListEl.innerHTML = "";

  books.forEach((book) => {
    const isActive = book.id === studentData?.currentBook;
    const isWished = wishlist.includes(book.id);
    const isReced = myRecs.has ? myRecs.has(book.id) : false;
    const isReading = reading.has(book.id);

    const copies = book.copies ?? 1;
    const out = book.checkedOutCount ?? (book.status === "checked_out" ? 1 : 0);
    const avail = copies - out;

    // Availability comes from the copy count, not the `status` string. On a
    // multi-copy book the two can disagree, and the count is the truth — the
    // badge already reported "1/3 available" while `status` still said
    // checked_out, leaving a visibly-available book with no Check Out button.
    const isAvail = avail > 0;
    const canCheckout = isAvail && !hasBook && !isActive;

    const statusBadge = isActive
      ? `<span class='badge badge--reading badge--dot'>Currently Reading</span>`
      : copies > 1
      ? `<span class='badge ${
          avail > 0 ? "badge--available" : "badge--checked-out"
        }'>${avail}/${copies} available</span>`
      : isAvail
      ? `<span class='badge badge--available'>Available</span>`
      : `<span class='badge badge--checked-out'>Checked Out</span>`;

    // Which checkout mode the teacher chose (Library Settings → How students
    // check out books). Automatic runs the checkout straight away; "Ask me
    // first" routes it through teachers/{tid}/requests for approval.
    const teacherRequiresApproval =
      _selectedTeacherData?.requireApproval ?? false;

    // Every book now carries a checkout control in SOME state. Previously a
    // book that was unavailable, or blocked because the student already had a
    // loan out, rendered either a bare disabled button whose only explanation
    // was a hover tooltip, or nothing at all — which read as "this app has no
    // way to check books out".
    let checkoutBtn = "";
    if (isActive)
      checkoutBtn = `<button class='btn btn--ghost btn--sm' data-action='return' data-id='${esc(
        book.id,
      )}'><i class='bi bi-arrow-return-left' aria-hidden='true'></i> Return Book</button>`;
    else if (canCheckout && teacherRequiresApproval)
      checkoutBtn = `<button class='btn btn--primary btn--sm' data-action='request-checkout' data-id='${esc(
        book.id,
      )}' data-title='${esc(book.title)}' data-cover='${esc(
        book.coverUrl ?? "",
      )}'>
                            <i class='bi bi-send-fill' aria-hidden='true'></i> Ask to Borrow
                          </button>`;
    else if (canCheckout)
      checkoutBtn = `<button class='btn btn--primary btn--sm' data-action='checkout' data-id='${esc(
        book.id,
      )}' data-title='${esc(book.title)}'><i class='bi bi-bag-check-fill' aria-hidden='true'></i> Check Out</button>`;
    else if (isAvail && hasBook)
      checkoutBtn = `<button class='btn btn--sm' disabled>Return your current book first</button>`;
    else
      checkoutBtn = `<button class='btn btn--sm' disabled>All copies are out</button>`;

    const wishBtn = !isActive
      ? `<button class='btn btn--xs ${
          isWished ? "starred" : ""
        }' data-action='${isWished ? "unwishlist" : "wishlist"}' data-id='${esc(
          book.id,
        )}'>${
          isWished
            ? '<i class="bi bi-heart-fill"></i> Wishlisted'
            : '<i class="bi bi-heart"></i> Wishlist'
        }</button>`
      : "";

    const recBtn = `<button class='btn btn--xs ${
      isReced ? "starred" : ""
    }' data-action='${isReced ? "unrecommend" : "recommend"}' data-id='${esc(
      book.id,
    )}' data-title='${esc(book.title)}' data-author='${esc(
      book.author ?? "",
    )}' data-cover='${esc(book.coverUrl ?? "")}'>${
      isReced
        ? '<i class="bi bi-star-fill"></i> Recommended'
        : '<i class="bi bi-star"></i> Recommend'
    }</button>`;

    const readingBtn = !isActive
      ? `<button class='btn btn--xs ${
          isReading ? "starred" : ""
        }' data-action='${
          isReading ? "unset-reading" : "set-reading"
        }' data-id='${esc(book.id)}' data-title='${esc(
          book.title,
        )}' data-author='${esc(book.author ?? "")}' data-cover='${esc(
          book.coverUrl ?? "",
        )}'>${
          isReading
            ? '<i class="bi bi-book-fill"></i> Reading'
            : '<i class="bi bi-book-fill"></i> Set Reading'
        }</button>`
      : "";

    const row = document.createElement("div");
    row.className = "book-row";
    row.setAttribute("role", "listitem");
    // The whole row opens the detail modal, but the row also carries the
    // checkout and wishlist buttons. Those are wired below and call
    // stopPropagation via the closest() guard in the handler, so a click on a
    // button never also opens the modal.
    row.tabIndex = 0;
    row.setAttribute("aria-label", `${book.title}. Open details`);
    row.innerHTML = `
      ${
        book.coverUrl
          ? `<img src='${esc(
              book.coverUrl,
            )}' class='book-cover' alt='Cover of ${esc(
              book.title,
            )}' loading='lazy'>`
          : `<div class='book-cover-ph' aria-hidden='true'><i class='bi bi-book-fill'></i></div>`
      }
      <div class='book-info'>
        <div class='book-title'>${esc(book.title)}</div>
        <div class='book-author'>${esc(book.author ?? "")}</div>
        <div class='book-meta'>${statusBadge}</div>
        ${
          book.description
            ? `<p style='font-size:0.66rem;color:var(--text-3);margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden'>${esc(
                book.description,
              )}</p>`
            : ""
        }
        <div class='book-actions'>${checkoutBtn}${wishBtn}${recBtn}${readingBtn}</div>
      </div>`;

    row
      .querySelector('[data-action="checkout"]')
      ?.addEventListener("click", (e) =>
        requestCheckout(
          e.currentTarget.dataset.id,
          e.currentTarget.dataset.title,
        ),
      );
    row
      .querySelector('[data-action="request-checkout"]')
      ?.addEventListener("click", (e) =>
        submitRentalRequest(
          e.currentTarget.dataset.id,
          e.currentTarget.dataset.title,
          e.currentTarget.dataset.cover,
        ),
      );
    row
      .querySelector('[data-action="return"]')
      ?.addEventListener("click", (e) =>
        initiateReturn(e.currentTarget.dataset.id),
      );
    row
      .querySelector('[data-action="wishlist"]')
      ?.addEventListener("click", (e) =>
        addToWishlist(e.currentTarget.dataset.id),
      );
    row
      .querySelector('[data-action="unwishlist"]')
      ?.addEventListener("click", (e) =>
        removeFromWishlist(e.currentTarget.dataset.id),
      );
    row
      .querySelector('[data-action="recommend"]')
      ?.addEventListener("click", (e) => {
        const d = e.currentTarget.dataset;
        toggleStudentRecommend(d.id, d.title, d.author, d.cover);
      });
    row
      .querySelector('[data-action="unrecommend"]')
      ?.addEventListener("click", (e) => {
        const d = e.currentTarget.dataset;
        toggleStudentRecommend(d.id, d.title, d.author, d.cover);
      });
    row
      .querySelector('[data-action="set-reading"]')
      ?.addEventListener("click", (e) => {
        const d = e.currentTarget.dataset;
        addToCurrentlyReading(d.id, d.title, d.author, d.cover);
      });
    row
      .querySelector('[data-action="unset-reading"]')
      ?.addEventListener("click", (e) =>
        removeFromCurrentlyReading(e.currentTarget.dataset.id),
      );

    // Open the modal from anywhere in the row except the action controls.
    // Checked against the click target rather than bound to a sub-element so
    // new buttons added to .book-actions later are excluded automatically.
    const openFromRow = (e) => {
      if (e.target.closest("button, a")) return;
      openBookModal(book);
    };
    row.addEventListener("click", openFromRow);
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;               // let buttons keep Enter/Space
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openBookModal(book); }
    });

    bookListEl.appendChild(row);
  });
}

// ── Checkout ──────────────────────────────────────────────────────────────────
async function requestCheckout(bookId, bookTitle) {
  if (!currentUser || !selectedTeacherId) {
    toast("Select a library first.", "danger");
    return;
  }

  const myIds = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  if (!myIds.has(selectedTeacherId)) {
    const tSnap = await getDoc(doc(db, "teachers", selectedTeacherId));
    if (!tSnap.exists() || !tSnap.data().libraryPublic) {
      toast(
        "You need to join this teacher's class to check out books.",
        "danger",
      );
      return;
    }
  }

  let bookAuthor = "";
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);

  try {
    await runTransaction(db, async (tx) => {
      const studentRef = doc(db, "students", currentUser.uid);
      const bookRef = doc(db, "teachers", selectedTeacherId, "books", bookId);
      const [sSnap, bSnap] = await Promise.all([
        tx.get(studentRef),
        tx.get(bookRef),
      ]);
      if (!sSnap.exists()) throw new Error("student-not-found");
      if (sSnap.data().currentBook !== null)
        throw new Error("already-has-book");
      if (!bSnap.exists()) throw new Error("book-not-found");
      const bData = bSnap.data();
      bookAuthor = bData.author ?? "";
      const copies = bData.copies ?? 1;
      const out =
        bData.checkedOutCount ?? (bData.status === "checked_out" ? 1 : 0);
      if (out >= copies) throw new Error("unavailable");
      const newCount = out + 1;
      tx.update(bookRef, {
        checkedOutCount: newCount,
        status: newCount >= copies ? "checked_out" : "available",
        checkedOutBy: currentUser.uid,
        checkedOutAt: serverTimestamp(),
        dueDate: Timestamp.fromDate(dueDate),
      });
      tx.update(studentRef, {
        currentBook: bookId,
        currentBookTeacherId: selectedTeacherId,
      });
    });
  } catch (err) {
    const msg =
      err.message === "already-has-book"
        ? "You already have a book checked out."
        : err.message === "unavailable"
        ? "All copies just got taken; someone beat you to it."
        : err.message === "book-not-found"
        ? "This book no longer exists."
        : `Checkout failed: ${err.message}`;
    toast(msg, "danger");
    await loadTeacherBooks(selectedTeacherId);
    return;
  }

  try {
    await addDoc(collection(db, "teachers", selectedTeacherId, "history"), {
      bookId,
      bookTitle,
      author: bookAuthor,
      studentId: currentUser.uid,
      studentName: studentData?.name ?? currentUser.displayName ?? "",
      dateOut: serverTimestamp(),
      dateReturned: null,
    });
  } catch (e) {
    console.error("[student] History write failed:", e?.code ?? e);
    toast(
      "Book checked out, but logging it to your teacher's history failed. Let them know if it doesn't appear.",
      "danger",
    );
  }

  studentData.currentBook = bookId;
  studentData.currentBookTeacherId = selectedTeacherId;
  const bi = allBooks.findIndex((b) => b.id === bookId);
  if (bi !== -1) {
    const bk = allBooks[bi];
    const copies = bk.copies ?? 1;
    const newCount =
      (bk.checkedOutCount ?? (bk.status === "checked_out" ? 1 : 0)) + 1;
    allBooks[bi] = {
      ...bk,
      checkedOutCount: newCount,
      status: newCount >= copies ? "checked_out" : "available",
      checkedOutBy: currentUser.uid,
    };
  }
  filterAndRenderBooks();
  toast(
    `<i class='bi bi-check2'></i> "${esc(
      bookTitle,
    )}" checked out, due back ${dueDate.toLocaleDateString()}`,
    "success",
  );
}

// ── Rental request submission ─────────────────────────────────────────────────
async function submitRentalRequest(bookId, bookTitle, coverUrl) {
  if (!currentUser || !selectedTeacherId) {
    toast("Select a library first.", "danger");
    return;
  }
  try {
    // Check if student already has a pending request for this book
    const existing = await getDocs(
      query(
        collection(db, "teachers", selectedTeacherId, "requests"),
        where("studentId", "==", currentUser.uid),
        where("bookId", "==", bookId),
        where("status", "==", "pending"),
      ),
    );
    if (!existing.empty) {
      toast("You already have a pending request for this book.", "info");
      return;
    }

    await addDoc(collection(db, "teachers", selectedTeacherId, "requests"), {
      bookId,
      bookTitle,
      coverUrl: coverUrl ?? "",
      studentId: currentUser.uid,
      studentName: studentData?.name ?? currentUser.displayName ?? "",
      studentEmail: currentUser.email ?? "",
      status: "pending",
      requestedAt: serverTimestamp(),
      respondedAt: null,
    });
    toast(
      `<i class='bi bi-send-fill'></i> Request sent for "${esc(
        bookTitle,
      )}" sent, now waiting on teacher approval`,
      "success",
    );
    if (document.getElementById("lockerPage")?.classList.contains("active"))
      renderLockerPage();
  } catch (err) {
    toast(`Request failed: ${esc(err.message ?? "unknown")}`, "danger");
  }
}

// ── Render rental request status (locker page) ────────────────────────────────
async function renderRentalRequests() {
  const section = document.getElementById("rentalRequestsSection");
  const listEl = document.getElementById("rentalRequestsList");
  if (!section || !listEl) return;

  const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  const requests = [];
  for (const tid of ids) {
    try {
      const snap = await getDocs(
        query(
          collection(db, "teachers", tid, "requests"),
          where("studentId", "==", currentUser.uid),
        ),
      );
      snap.forEach((d) =>
        requests.push({ ...d.data(), id: d.id, teacherId: tid }),
      );
    } catch (_) {}
  }

  // Only show if there are any requests at all
  if (requests.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  // Sort: pending first, then by date desc
  const sorted = requests.sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") return -1;
    if (a.status !== "pending" && b.status === "pending") return 1;
    return (b.requestedAt?.seconds ?? 0) - (a.requestedAt?.seconds ?? 0);
  });

  listEl.innerHTML = "";
  sorted.slice(0, 10).forEach((req) => {
    const statusClass =
      req.status === "approved"
        ? "badge--approved"
        : req.status === "denied"
        ? "badge--denied"
        : "badge--pending";
    const statusLabel =
      req.status === "approved"
        ? "Approved"
        : req.status === "denied"
        ? "Denied"
        : "Pending";
    const cardClass =
      req.status === "approved"
        ? "request-card--approved"
        : req.status === "denied"
        ? "request-card--denied"
        : "";
    const item = document.createElement("div");
    item.className = `request-card ${cardClass}`;
    item.setAttribute("role", "listitem");
    item.innerHTML = `
      ${
        req.coverUrl
          ? `<img src='${esc(
              req.coverUrl,
            )}' class='book-cover' alt='' loading='lazy'>`
          : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`
      }
      <div class='book-info'>
        <div class='book-title'>${esc(req.bookTitle)}</div>
        <div class='book-author' style='margin-bottom:5px'>Requested ${fmtDate(
          req.requestedAt,
        )}</div>
        <span class='badge ${statusClass}'>${statusLabel}</span>
        ${
          req.status === "approved"
            ? `<span class='muted-text small-text' style='margin-left:8px'>Check your Active Loans below</span>`
            : ""
        }
      </div>`;
    listEl.appendChild(item);
  });
}

// ── Return ────────────────────────────────────────────────────────────────────
async function initiateReturn(bookId) {
  if (
    !confirm(
      "Confirm you've handed the book back to your teacher.\n\nYour teacher will finalize the return on their end.",
    )
  )
    return;
  // Note: we intentionally do NOT decrement the book's copy count here.
  // The teacher finalizes the return on their end (validateReturn), which is the
  // single authority for the copy count + history log — this prevents a
  // double-decrement when both sides act on the same checkout.
  await updateDoc(doc(db, "students", currentUser.uid), {
    currentBook: null,
    currentBookTeacherId: null,
  });
  studentData.currentBook = null;
  studentData.currentBookTeacherId = null;
  filterAndRenderBooks();
  if (document.getElementById("lockerPage")?.classList.contains("active"))
    renderLockerPage();
  toast(
    `<i class='bi bi-check2'></i> Return marked. Teacher will confirm.`,
    "success",
  );
}

// ── Wishlist ──────────────────────────────────────────────────────────────────
async function addToWishlist(bookId) {
  await updateDoc(doc(db, "students", currentUser.uid), {
    wishlist: arrayUnion(bookId),
  });
  if (!studentData.wishlist) studentData.wishlist = [];
  if (!studentData.wishlist.includes(bookId)) studentData.wishlist.push(bookId);
  renderWishlist();
  filterAndRenderBooks();
  toast(`<i class='bi bi-check2'></i> Added to wishlist`, "success");
}

async function removeFromWishlist(bookId) {
  await updateDoc(doc(db, "students", currentUser.uid), {
    wishlist: arrayRemove(bookId),
  });
  studentData.wishlist = (studentData.wishlist ?? []).filter(
    (id) => id !== bookId,
  );
  renderWishlist();
  filterAndRenderBooks();
  toast("Removed from wishlist", "info");
}

// Wishlist search (Google Books)
let wishlistSearchResults = [];

let wishlistSearchDebounce = null;
document
  .getElementById("wishlistSearchInput")
  ?.addEventListener("input", (e) => {
    const q = e.target.value.trim();
    if (!q) {
      wishlistSearchResults = [];
      renderWishlistSearchResults([]);
      clearTimeout(wishlistSearchDebounce);
      return;
    }
    clearTimeout(wishlistSearchDebounce);
    wishlistSearchDebounce = setTimeout(async () => {
      wishlistSearchResults = await searchBooks(q, 6);
      renderWishlistSearchResults(wishlistSearchResults);
    }, 400);
  });

function renderWishlistSearchResults(results) {
  const el = document.getElementById("wishlistSearchResults");
  if (!el) return;
  el.innerHTML = "";
  if (!results.length) {
    el.innerHTML = `<p class='empty-state'>No results.</p>`;
    return;
  }
  results.forEach((book) => {
    const isWished = (studentData?.wishlist ?? []).includes(book.sourceId);
    const row = document.createElement("div");
    row.className = "book-row";
    row.setAttribute("role", "listitem");
    row.innerHTML = `
      ${
        book.cover
          ? `<img src='${esc(
              book.cover,
            )}' class='book-cover' alt='' loading='lazy'>`
          : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`
      }
      <div class='book-info' style='display:flex;align-items:center;justify-content:space-between;gap:8px'>
        <div style='min-width:0'>
          <div class='book-title'>${esc(book.title)}</div>
          <div class='book-author'>${esc(book.author)}</div>
        </div>
        <button class='btn btn--xs ${
          isWished ? "starred" : ""
        }' data-gid='${esc(book.sourceId)}' data-title='${esc(
      book.title,
    )}' data-author='${esc(book.author)}' data-cover='${esc(
      book.cover,
    )}' style='flex-shrink:0'>
          ${
            isWished
              ? '<i class="bi bi-heart-fill"></i> Wishlisted'
              : '<i class="bi bi-heart"></i> Wishlist'
          }
        </button>
      </div>`;
    row.querySelector("button")?.addEventListener("click", async (ev) => {
      const { gid, title, author, cover } = ev.currentTarget.dataset;
      if (isWished) {
        await removeFromWishlist(gid);
      } else {
        await updateDoc(doc(db, "students", currentUser.uid), {
          wishlist: arrayUnion(gid),
          [`wishlistMeta.${gid}`]: { title, author, coverUrl: cover },
        });
        if (!studentData.wishlist) studentData.wishlist = [];
        if (!studentData.wishlist.includes(gid)) studentData.wishlist.push(gid);
        if (!studentData.wishlistMeta) studentData.wishlistMeta = {};
        studentData.wishlistMeta[gid] = { title, author, coverUrl: cover };
        toast(
          `<i class='bi bi-heart-fill'></i> "${esc(title)}" added to wishlist`,
          "success",
        );
        renderWishlist();
        renderWishlistSearchResults(wishlistSearchResults);
      }
    });
    el.appendChild(row);
  });
}

function renderWishlist() {
  const wishlistEl = document.getElementById("wishlistPanel");
  if (!wishlistEl) return;
  const list = studentData?.wishlist ?? [];
  if (list.length === 0) {
    wishlistEl.innerHTML = `<p class='empty-state'>Your wishlist is empty. Use the search panel to find books and add them.</p>`;
    return;
  }
  wishlistEl.innerHTML = "";
  list.forEach((bookId) => {
    const cached = bookCache.get(bookId);
    const meta = studentData?.wishlistMeta?.[bookId];
    const title =
      cached?.title ?? meta?.title ?? `Book ID: ${bookId.slice(0, 8)}…`;
    const author = cached?.author ?? meta?.author ?? "";
    const coverUrl = cached?.coverUrl ?? meta?.coverUrl ?? "";
    const item = document.createElement("div");
    item.className = "book-row";
    item.setAttribute("role", "listitem");
    item.innerHTML = `
      ${
        coverUrl
          ? `<img src='${esc(
              coverUrl,
            )}' class='book-cover' alt='' loading='lazy'>`
          : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`
      }
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'>${esc(title)}</div>
          <div class='book-author'>${esc(author)}</div>
        </div>
        <button class='btn btn--xs' data-remove='${esc(
          bookId,
        )}'><i class='bi bi-x'></i> Remove</button>
      </div>`;
    item
      .querySelector("[data-remove]")
      ?.addEventListener("click", (e) =>
        removeFromWishlist(e.currentTarget.dataset.remove),
      );
    wishlistEl.appendChild(item);
  });
}

// ── Locker page ───────────────────────────────────────────────────────────────
async function renderLockerPage() {
  await renderRentalRequests();
  await renderActiveLoans();
  await renderReadingLog();
}

async function renderActiveLoans() {
  const el = document.getElementById("activeLoans");
  if (!el) return;
  const bookId = studentData.currentBook;
  if (!bookId) {
    // A book they've marked returned but the teacher hasn't confirmed yet is
    // neither an active loan nor history, so it used to disappear entirely the
    // moment they tapped "Returned It" — no confirmation, no trace, nothing to
    // show a teacher who says the book is still out against their name.
    const pending = await findAwaitingReturnConfirmation();
    el.innerHTML = pending.length
      ? ""
      : `<p class='empty-state'>No active loans. Check out a book from the Library!</p>`;
    pending.forEach((e) => {
      const card = document.createElement("div");
      card.className = "book-row";
      card.setAttribute("role", "listitem");
      card.innerHTML = `
        <div class='book-cover-ph'><i class='bi bi-hourglass-split'></i></div>
        <div class='book-info'>
          <div class='book-title'>${esc(e.bookTitle)}</div>
          <div class='book-author'>Handed back; waiting for your teacher to confirm</div>
          <span class='badge badge--pending'>Awaiting confirmation</span>
        </div>`;
      el.appendChild(card);
    });
    return;
  }

  const bookTeacherId = studentData.currentBookTeacherId ?? classTeacherId;
  let book = bookCache.get(bookId);
  if (bookTeacherId) {
    try {
      const bSnap = await getDoc(
        doc(db, "teachers", bookTeacherId, "books", bookId),
      );
      if (bSnap.exists()) {
        book = bSnap.data();
        bookCache.set(bookId, { ...book, teacherId: bookTeacherId });
      }
    } catch (_) {}
  }

  let dueLabel = "",
    isOverdue = false;
  if (book?.dueDate) {
    const due = book.dueDate.toDate
      ? book.dueDate.toDate()
      : new Date(book.dueDate);
    const diffDays = Math.ceil((due - new Date()) / 86400000);
    if (diffDays < 0) {
      isOverdue = true;
      dueLabel = `<i class='bi bi-exclamation-triangle-fill'></i> Overdue by ${Math.abs(
        diffDays,
      )} day${Math.abs(diffDays) !== 1 ? "s" : ""}`;
    } else if (diffDays === 0) {
      dueLabel = "<i class='bi bi-calendar-event-fill'></i> Due today!";
    } else {
      dueLabel = `<i class='bi bi-calendar-event-fill'></i> Due in ${diffDays} day${
        diffDays !== 1 ? "s" : ""
      } (${due.toLocaleDateString()})`;
    }
  }

  el.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "book-card-grid";
  const card = document.createElement("div");
  card.className = "book-card book-card--active";
  card.setAttribute("role", "listitem");
  card.innerHTML = `
    <div class='book-card-cover'>
      ${
        book?.coverUrl
          ? `<img src='${esc(book.coverUrl)}' alt='Cover of ${esc(
              book?.title ?? "",
            )}' loading='lazy'>`
          : `<i class='bi bi-book-fill' aria-hidden='true'></i>`
      }
    </div>
    <div class='book-card-title'>${esc(book?.title ?? bookId)}</div>
    <div class='book-card-author'>${esc(book?.author ?? "")}</div>
    <span class='badge badge--checked-out badge--dot' style='display:inline-flex;margin:6px 0'>Checked Out</span>
    ${
      dueLabel
        ? `<div style='font-size:0.69rem;margin:4px 0 6px;color:${
            isOverdue ? "var(--danger)" : "var(--text-3)"
          };font-weight:${isOverdue ? "600" : "400"}'>${dueLabel}</div>`
        : ""
    }
    <button class='btn btn--ghost btn--sm' style='width:100%;margin-top:8px' id='returnBtnLocker'>Returned It</button>`;
  card
    .querySelector("#returnBtnLocker")
    ?.addEventListener("click", () => initiateReturn(bookId));
  grid.appendChild(card);
  el.appendChild(grid);
}

/** Open checkout rows (dateReturned still null) for books this student is no
 *  longer holding — i.e. they pressed "Returned It" and the teacher hasn't
 *  signed it off yet. */
async function findAwaitingReturnConfirmation() {
  const out = [];
  const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  for (const tid of ids) {
    try {
      const snap = await getDocs(
        query(
          collection(db, "teachers", tid, "history"),
          where("studentId", "==", currentUser.uid),
        ),
      );
      snap.forEach((d) => {
        const e = d.data();
        if (!e.dateReturned && e.bookId !== studentData.currentBook) {
          out.push({ ...e, teacherId: tid });
        }
      });
    } catch (_) {}
  }
  return out;
}

async function renderReadingLog() {
  const el = document.getElementById("readingLog");
  if (!el) return;
  const entries = [];
  const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  for (const tid of ids) {
    try {
      const snap = await getDocs(
        query(
          collection(db, "teachers", tid, "history"),
          where("studentId", "==", currentUser.uid),
        ),
      );
      snap.forEach((d) => entries.push({ ...d.data(), teacherId: tid }));
    } catch (_) {}
  }
  const history = entries
    .filter((e) => e.dateReturned !== null)
    .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
  if (history.length === 0) {
    el.innerHTML = `<p class='empty-state'>No reading history yet.</p>`;
    return;
  }
  el.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "book-card-grid";
  history.forEach((e) => {
    const cached = [...bookCache.values()].find((b) => b.title === e.bookTitle);
    const held = heldFor(e.dateOut, e.dateReturned);
    const card = document.createElement("div");
    card.className = "book-card book-card--faded";
    card.setAttribute("role", "listitem");
    card.innerHTML = `
      <div class='book-card-cover'>
        ${
          cached?.coverUrl
            ? `<img src='${esc(cached.coverUrl)}' alt='' loading='lazy'>`
            : `<i class='bi bi-book-fill' aria-hidden='true'></i>`
        }
      </div>
      <div class='book-card-title'>${esc(e.bookTitle)}</div>
      <div style='font-size:0.63rem;color:var(--text-3);margin-top:4px'>Returned ${fmtDate(
        e.dateReturned,
      )}</div>
      ${
        held
          ? `<div style='font-size:0.63rem;color:var(--text-3);margin-top:2px'><i class='bi bi-clock-history' aria-hidden='true'></i> Kept ${esc(
              held,
            )}</div>`
          : ""
      }`;
    grid.appendChild(card);
  });
  el.appendChild(grid);
}

// Download reading log
document
  .getElementById("downloadLogBtn")
  ?.addEventListener("click", async () => {
    const entries = [];
    const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
    for (const tid of ids) {
      const tSnap = await getDoc(doc(db, "teachers", tid));
      const tName = tSnap.exists() ? teacherLabel(tSnap.data()) : tid;
      const hSnap = await getDocs(
        query(
          collection(db, "teachers", tid, "history"),
          where("studentId", "==", currentUser.uid),
        ),
      );
      hSnap.forEach((d) => entries.push({ ...d.data(), teacherName: tName }));
    }
    const sorted = entries.sort(
      (a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0),
    );
    let md = `# Reading Log: ${
      studentData.name
    }\n\n**Exported:** ${new Date().toLocaleDateString()}\n\n`;
    md += `| Book | Teacher Library | Date Out | Date Returned | Kept For |\n`;
    md += `|------|----------------|----------|---------------|----------|\n`;
    sorted.forEach((e) => {
      md += `| ${e.bookTitle} | ${e.teacherName} | ${fmtDate(e.dateOut)} | ${
        e.dateReturned ? fmtDate(e.dateReturned) : "Currently checked out"
      } | ${e.dateReturned ? heldFor(e.dateOut, e.dateReturned) : '—'} |\n`;
    });
    md += `\n---\n_Generated by BookWare · Mason High School_\n`;
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })),
      download: `reading-log-${studentData.name
        .replace(/\s+/g, "-")
        .toLowerCase()}.md`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`<i class='bi bi-check2'></i> Reading log downloaded`, "success");
  });

// ── Profile page ──────────────────────────────────────────────────────────────
async function renderProfilePage() {
  await renderProfileCurrentBook();
  await renderReadingStats();
  await renderMyRecommendations();
}

const READING_LIMIT = 6;

async function renderProfileCurrentBook() {
  const el = document.getElementById("profileCurrentBook");
  if (!el) return;
  const list = studentData.currentlyReading ?? [];
  const checkedOut = studentData.currentBook;
  if (list.length === 0 && !checkedOut) {
    el.innerHTML = `<p class='empty-state'>Not reading anything right now. Hit <i class='bi bi-book-fill'></i> Set Reading on any library book!</p>`;
    return;
  }

  const limitColor =
    list.length >= READING_LIMIT ? "var(--danger)" : "var(--text-3)";
  el.innerHTML = `<div style='font-size:0.68rem;color:${limitColor};margin-bottom:8px;font-weight:${
    list.length >= READING_LIMIT ? "600" : "400"
  }'>${list.length}/${READING_LIMIT} books${
    list.length >= READING_LIMIT ? " · list full" : ""
  }</div>`;

  if (checkedOut) {
    let book = bookCache.get(checkedOut);
    if (!book && (studentData.currentBookTeacherId ?? classTeacherId)) {
      const tid = studentData.currentBookTeacherId ?? classTeacherId;
      const snap = await getDoc(doc(db, "teachers", tid, "books", checkedOut));
      if (snap.exists()) {
        book = snap.data();
        bookCache.set(checkedOut, book);
      }
    }
    const card = document.createElement("div");
    card.className = "book-row";
    card.style.cssText =
      "border:1px solid var(--accent);border-radius:var(--r);padding:10px;margin-bottom:8px";
    card.innerHTML = `
      ${
        book?.coverUrl
          ? `<img src='${esc(book.coverUrl)}' class='book-cover' alt=''>`
          : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`
      }
      <div class='book-info'>
        <div class='book-title'>${esc(book?.title ?? checkedOut)}</div>
        <div class='book-author'>${esc(book?.author ?? "")}</div>
        <span class='badge badge--reading badge--dot' style='margin-top:6px;display:inline-flex'>Checked Out</span>
      </div>`;
    el.appendChild(card);
  }

  list.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "book-row";
    card.style.cssText =
      "border:1px solid var(--border);border-radius:var(--r);padding:10px;margin-bottom:8px";
    card.innerHTML = `
      ${
        entry.coverUrl
          ? `<img src='${esc(entry.coverUrl)}' class='book-cover' alt=''>`
          : `<div class='book-cover-ph'><i class='bi bi-book-fill'></i></div>`
      }
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'>${esc(entry.bookTitle)}</div>
          <div class='book-author'>${esc(entry.author ?? "")}</div>
        </div>
        <button class='btn btn--xs' data-remove='${esc(
          entry.bookId,
        )}'><i class='bi bi-x'></i></button>
      </div>`;
    card
      .querySelector("[data-remove]")
      ?.addEventListener("click", (e) =>
        removeFromCurrentlyReading(e.currentTarget.dataset.remove),
      );
    el.appendChild(card);
  });
}

async function renderReadingStats() {
  const el = document.getElementById("readingStats");
  if (!el) return;
  let totalRead = 0;
  const ids = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  for (const tid of ids) {
    const snap = await getDocs(
      query(
        collection(db, "teachers", tid, "history"),
        where("studentId", "==", currentUser.uid),
      ),
    );
    totalRead += snap.size;
  }
  const wishlisted = (studentData.wishlist ?? []).length;
  const active = studentData.currentBook ? 1 : 0;
  let overdueCount = 0;
  if (studentData.currentBook && studentData.currentBookTeacherId) {
    try {
      const bSnap = await getDoc(
        doc(
          db,
          "teachers",
          studentData.currentBookTeacherId,
          "books",
          studentData.currentBook,
        ),
      );
      if (bSnap.exists() && bSnap.data().dueDate?.toDate() < new Date())
        overdueCount = 1;
    } catch (_) {}
  }
  el.innerHTML = `
    <div class='stat-box'><div class='stat-number'>${totalRead}</div><div class='stat-label'>Books Read</div></div>
    <div class='stat-box'><div class='stat-number'>${wishlisted}</div><div class='stat-label'>Wishlisted</div></div>
    <div class='stat-box'><div class='stat-number'>${active}</div><div class='stat-label'>Active Loan</div></div>
    <div class='stat-box'><div class='stat-number' style='color:${
      overdueCount > 0 ? "var(--danger)" : "inherit"
    }'>${overdueCount}</div><div class='stat-label'>Overdue</div></div>`;
}

// NOTE: "Similar Readers" was removed intentionally. Showing classmates would
// require students to read each other's `students/{uid}` records, which the
// Firestore rules (correctly) forbid to protect student privacy. Enforcing that
// on the client while leaving the door open on the server would be a false sense
// of privacy, so the feature is gone rather than faked.

// ── Student recommendations ───────────────────────────────────────────────────
async function loadMyRecIds() {
  const snap = await getDocs(
    collection(db, "students", currentUser.uid, "recommendations"),
  );
  studentData.myRecIds = new Set(snap.docs.map((d) => d.data().bookId));
}

async function toggleStudentRecommend(bookId, bookTitle, author, coverUrl) {
  const snap = await getDocs(
    collection(db, "students", currentUser.uid, "recommendations"),
  );
  const existing = snap.docs.find((d) => d.data().bookId === bookId);
  if (existing) {
    await deleteDoc(
      doc(db, "students", currentUser.uid, "recommendations", existing.id),
    );
    studentData.myRecIds?.delete(bookId);
    toast(
      `<i class='bi bi-star'></i> Removed "${esc(
        bookTitle,
      )}" from recommendations`,
      "info",
    );
  } else {
    await addDoc(
      collection(db, "students", currentUser.uid, "recommendations"),
      {
        bookId,
        bookTitle,
        author: author ?? "",
        coverUrl: coverUrl ?? "",
        addedAt: serverTimestamp(),
      },
    );
    studentData.myRecIds?.add(bookId);
    toast(
      `<i class='bi bi-star-fill'></i> "${esc(
        bookTitle,
      )}" added to recommendations`,
      "success",
    );
  }
  filterAndRenderBooks();
  if (document.getElementById("profilePage")?.classList.contains("active"))
    renderMyRecommendations();
}

async function addToCurrentlyReading(bookId, bookTitle, author, coverUrl) {
  const current = studentData.currentlyReading ?? [];
  if (current.find((r) => r.bookId === bookId)) {
    toast("Already in your reading list.", "info");
    return;
  }
  if (current.length >= READING_LIMIT) {
    toast(
      `Reading list is full (max ${READING_LIMIT} books). Remove one first.`,
      "danger",
    );
    return;
  }
  const updated = [
    ...current,
    { bookId, bookTitle, author: author ?? "", coverUrl: coverUrl ?? "" },
  ];
  if (!(await saveCurrentlyReading(updated))) return;
  toast(
    `<i class='bi bi-book-fill'></i> "${esc(
      bookTitle,
    )}" added to your reading list`,
    "success",
  );
}

async function removeFromCurrentlyReading(bookId) {
  const updated = (studentData.currentlyReading ?? []).filter(
    (r) => r.bookId !== bookId,
  );
  if (!(await saveCurrentlyReading(updated))) return;
  toast("Removed from reading list", "info");
}

/** Persist the student's reading list and refresh everything that shows it.
 *  Returns false (and says so) when the write failed — this used to be an
 *  unguarded await, so a rejected write left the button looking dead: no
 *  toast, no list change, nothing in the UI to explain it. */
async function saveCurrentlyReading(list) {
  try {
    await updateDoc(doc(db, "students", currentUser.uid), {
      currentlyReading: list,
    });
  } catch (err) {
    console.error("[student] could not save reading list:", err);
    toast(
      `Couldn't update your reading list (${esc(err.code ?? err.message ?? "unknown error")}). Try again.`,
      "danger",
    );
    return false;
  }
  studentData.currentlyReading = list;
  filterAndRenderBooks();
  // Render unconditionally: the card is cheap to rebuild, and gating on "is the
  // Profile tab open right now" is how it ended up showing a stale list.
  renderProfileCurrentBook();
  return true;
}

async function renderMyRecommendations() {
  const el = document.getElementById("myRecommendations");
  if (!el) return;
  const snap = await getDocs(
    collection(db, "students", currentUser.uid, "recommendations"),
  );
  if (snap.empty) {
    el.innerHTML = `<p class='empty-state'>No recommendations yet. Hit <i class='bi bi-star'></i> Recommend on any book in the library!</p>`;
    return;
  }
  el.innerHTML = "";
  snap.forEach((d) => {
    const r = d.data();
    const item = document.createElement("div");
    item.className = "book-row";
    item.setAttribute("role", "listitem");
    item.innerHTML = `
      ${
        r.coverUrl
          ? `<img src='${esc(
              r.coverUrl,
            )}' class='book-cover' alt='' loading='lazy'>`
          : `<div class='book-cover-ph'><i class='bi bi-star-fill'></i></div>`
      }
      <div class='book-info' style='display:flex;align-items:center;gap:8px'>
        <div style='flex:1;min-width:0'>
          <div class='book-title'><i class='bi bi-star-fill' style='color:var(--accent);font-size:0.65rem'></i> ${esc(
            r.bookTitle,
          )}</div>
          <div class='book-author'>${esc(r.author ?? "")}</div>
        </div>
        <button class='btn btn--xs' data-recid='${esc(
          d.id,
        )}' data-bookid='${esc(
      r.bookId,
    )}'><i class='bi bi-x'></i> Remove</button>
      </div>`;
    item.querySelector("[data-recid]")?.addEventListener("click", async (e) => {
      await deleteDoc(
        doc(
          db,
          "students",
          currentUser.uid,
          "recommendations",
          e.currentTarget.dataset.recid,
        ),
      );
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
  wishlistListeners.forEach((u) => u());
  wishlistListeners = [];
  if (!selectedTeacherId || wishlist.length === 0) return;
  wishlist.forEach((bookId) => {
    const unsubscribe = onSnapshot(
      doc(db, "teachers", selectedTeacherId, "books", bookId),
      (snap) => {
        if (!snap.exists()) return;
        const book = snap.data();
        if (book.status === "available" && !studentData.currentBook)
          toast(
            `<i class='bi bi-collection-fill'></i> "${esc(
              book.title,
            )}" is now available!`,
            "success",
          );
      },
    );
    wishlistListeners.push(unsubscribe);
  });
}
