import { auth, db } from "./firebase.js";
import { searchBooks } from "./books.js";
import {
  signOut,
  onAuthStateChanged,
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

// ─── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let userData = null;
let studentData = null;
let classTeacherId = null;
let selectedTeacherId = null;
let selectedTeacherName = "";
let allBooks = [];
const bookCache = new Map();
let wishlistListeners = [];
let addedTeacherIds = [];

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const teacherListEl = document.getElementById("teacherList");
const searchInputEl = document.getElementById("searchInput");
const bookListEl = document.getElementById("bookList");
const bookListTitleEl = document.getElementById("bookListTitle");
const wishlistEl = document.getElementById("wishlistPanel");
const activeLoansEl = document.getElementById("activeLoans");
const readingLogEl = document.getElementById("readingLog");
const downloadLogBtn = document.getElementById("downloadLogBtn");
const signoutBar = document.getElementById("signoutBar");

// ─── Sidebar collapse ──────────────────────────────────────────────────────────
document.getElementById("sidebarToggle")?.addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
});

// ─── Page routing wired immediately (not waiting for auth) ─────────────────────
// This fixes broken nav links when auth is slow to resolve
document.querySelectorAll(".ni[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
});

// ─── Top-bar avatar + name ─────────────────────────────────────────────────────
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

// ─── Page routing ──────────────────────────────────────────────────────────────
function setupPageRouting() {
  // routing is now wired at parse time above — this is a no-op kept for compat
}

const PAGE_TITLES = {
  library: "Library",
  locker: "My Locker",
  wishlist: "Wishlist",
  profile: "Profile",
  settings: "Settings",
};

function showPage(pageName) {
  document.querySelectorAll(".pg").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".ni").forEach((n) => n.classList.remove("active"));

  document.getElementById(pageName + "Page")?.classList.add("active");
  document.querySelector(`[data-page="${pageName}"]`)?.classList.add("active");

  // Update top-bar title
  const ptEl = document.getElementById("pt");
  if (ptEl) ptEl.textContent = PAGE_TITLES[pageName] ?? pageName;

  // Lazy-load page content on first visit
  if (pageName === "locker") renderLockerPage();
  if (pageName === "profile") renderProfilePage();
}

// ─── Email allowlist ───────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = "@masonohioschools.com";
const ADMIN_EMAILS = ["sarvin.sukhe@gmail.com", "daepickid540@gmail.com"];

function isEmailAllowed(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  return lower.endsWith(ALLOWED_DOMAIN) || ADMIN_EMAILS.includes(lower);
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "/";
    return;
  }

  // Allowlist gate — boot anyone not from the school domain or admin list
  if (!isEmailAllowed(user.email)) {
    await signOut(auth);
    window.location.href = "/";
    return;
  }

  // Maintenance mode check
  try {
    const settingsSnap = await getDoc(doc(db, "admin", "settings"));
    if (settingsSnap.exists() && settingsSnap.data().maintenanceMode === true) {
      await signOut(auth);
      alert("BookWare is currently undergoing maintenance. Please check back soon.");
      window.location.href = "/";
      return;
    }
  } catch (_) { /* if we can't read settings, allow through */ }

  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists() || userSnap.data().role !== "student") {
    await signOut(auth);
    window.location.href = "/";
    return;
  }

  userData = userSnap.data();
  currentUser = user;
  classTeacherId = userData.class ?? null;

  // Auth confirmed — reveal page
  document.body.style.visibility = "visible";

  // Load recommendation IDs for button state
  await loadMyRecIds();

  // ── Ban check ────────────────────────────────────────────────────────────
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
      window.location.href = `/?banned=1&reason=${encodeURIComponent(reason)}&days=${days}`;
      return;
    }
  }

  // ── Load student doc ─────────────────────────────────────────────────────
  let sSnap = await getDoc(doc(db, "students", user.uid));
  if (!sSnap.exists()) {
    // Auto-create student doc for first-time Google sign-in
    await setDoc(doc(db, "students", user.uid), {
      name: user.displayName ?? "",
      email: user.email ?? "",
      currentBook: null,
      wishlist: [],
      wishlistMeta: {},
      banned: false,
    });
    sSnap = await getDoc(doc(db, "students", user.uid));
  }
  studentData = sSnap.data();
  addedTeacherIds = studentData.addedTeachers ?? [];

  // ── Init ─────────────────────────────────────────────────────────────────
  populateTopBar();
  // Welcome toast — shown once per session
  if (!sessionStorage.getItem("bw-welcomed")) {
    const firstName = (currentUser.displayName ?? "").split(" ")[0] || "there";
    setTimeout(() => toast(`Welcome back, ${te(firstName)} <i class="bi bi-hand-wave-fill"></i>`, "success"), 800);
    sessionStorage.setItem("bw-welcomed", "1");
  }
  initTheme();
  initARIA();
  setupSignout();
  populateSettingsInfo();
  renderWishlist();
  await loadTeachers();
  await renderNotifications();

  // Auto-select first available library on load.
  // Prefer classTeacherId (from userData.class), fall back to first addedTeacherId
  const firstTeacherId = classTeacherId ?? addedTeacherIds[0] ?? null;
  if (firstTeacherId) {
    try {
      const tSnap = await getDoc(doc(db, "teachers", firstTeacherId));
      if (tSnap.exists()) await setSelectedTeacher(firstTeacherId, tSnap.data().name);
    } catch (e) {
      console.warn("[student.js] Could not auto-select first library:", e);
    }
  }
});

// ─── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
const te = escHtml; // alias for toast strings

function toast(msg, type = "info") {
  const c = document.getElementById("notificationContainer");
  if (!c) return;
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 300);
  }, 4000);
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString();
}

// ─── Sign out ──────────────────────────────────────────────────────────────────
function setupSignout() {
  signoutBar?.addEventListener("click", () => signOut(auth));
  const hint = document.getElementById("signoutEmail");
  if (hint && currentUser) hint.textContent = currentUser.email;
}

// ─── Theme / Brightness ──────────────────────────────────────────────────────
const BRIGHTNESS_KEY = "bookware-brightness";
const COLOR_KEY = "bookware-color";

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function toHex(v) {
  v = clamp(Math.round(v), 0, 255);
  return "#" + v.toString(16).padStart(2, "0").repeat(3);
}

function brightnessToVars(val) {
  const t = val / 100;
  const base     = lerp(0, 255, t);
  const offAlt   = lerp(16, -8,  t);
  const offLight = lerp(28, -18, t);
  const offCard  = lerp(-8,  8,  t);
  let textV, textMutedV, mutedV;
  if (val <= 45) {
    textV      = lerp(240, 200, val / 45);
    textMutedV = lerp(171, 150, val / 45);
    mutedV     = lerp(122, 140, val / 45);
  } else if (val >= 55) {
    textV      = lerp(200, 26,  (val - 55) / 45);
    textMutedV = lerp(150, 90,  (val - 55) / 45);
    mutedV     = lerp(140, 100, (val - 55) / 45);
  } else {
    textV = 200; textMutedV = 150; mutedV = 140;
  }
  return {
    "--bg":         toHex(base),
    "--bg-alt":     toHex(base + offAlt),
    "--bg-light":   toHex(base + offLight),
    "--card":       toHex(base + offCard),
    "--border":     toHex(base + offAlt * 0.6),
    "--text":       toHex(textV),
    "--text-muted": toHex(textMutedV),
    "--muted":      toHex(mutedV),
  };
}

function brightnessLabel(val) {
  if (val <= 8)  return "Pitch Black";
  if (val <= 22) return "Dark";
  if (val <= 38) return "Dim";
  if (val <= 48) return "Mid Dark";
  if (val <= 52) return "Mid";
  if (val <= 62) return "Mid Light";
  if (val <= 78) return "Light";
  if (val <= 92) return "Bright";
  return "Pure White";
}

function applyBrightness(val) {
  const vars = brightnessToVars(val);
  const html  = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    html.style.setProperty(k, v);
  }
  if (val >= 50) html.setAttribute("data-theme", "light");
  else           html.removeAttribute("data-theme");
  const label = document.getElementById("brightnessLabel");
  if (label) label.textContent = brightnessLabel(val);
}

function applyColor(color) {
  const html = document.documentElement;
  if (!color || color === "crimson") html.removeAttribute("data-color");
  else                               html.setAttribute("data-color", color);
  document.querySelectorAll(".color-swatch").forEach((s) => {
    s.classList.toggle("active", s.dataset.color === (color || "crimson"));
  });
}

function initTheme() {
  const saved = parseInt(localStorage.getItem(BRIGHTNESS_KEY) ?? "18", 10);
  applyBrightness(saved);
  applyColor(localStorage.getItem(COLOR_KEY) || "crimson");
  const slider = document.getElementById("brightnessSlider");
  if (slider) {
    slider.value = saved;
    slider.addEventListener("input", () => {
      const val = parseInt(slider.value, 10);
      applyBrightness(val);
      localStorage.setItem(BRIGHTNESS_KEY, String(val));
    });
  }
  document.querySelectorAll(".color-swatch").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      applyColor(swatch.dataset.color);
      localStorage.setItem(COLOR_KEY, swatch.dataset.color);
    });
  });
}

// Kept for legacy callers
function applyTheme() {}

// ─── ARIA AI Settings ──────────────────────────────────────────────────────────
const ARIA_ENABLED_KEY = "bw-aria-enabled";
const ARIA_KEY_STORAGE  = "bw-aria-groq-key";

function initARIA() {
  const toggle    = document.getElementById("ariaEnabled");
  const panel     = document.getElementById("ariaSetupPanel");
  const keyInput  = document.getElementById("ariaApiKey");
  const saveBtn   = document.getElementById("ariaSaveKeyBtn");
  if (!toggle || !panel) return;

  // Restore saved state
  const enabled = localStorage.getItem(ARIA_ENABLED_KEY) === "true";
  const savedKey = localStorage.getItem(ARIA_KEY_STORAGE) ?? "";
  toggle.checked = enabled;
  panel.style.display = enabled ? "block" : "none";
  if (keyInput && savedKey) keyInput.value = savedKey;

  toggle.addEventListener("change", () => {
    const on = toggle.checked;
    localStorage.setItem(ARIA_ENABLED_KEY, String(on));
    panel.style.display = on ? "block" : "none";
    toast(on ? "<i class="bi bi-robot"></i> ARIA enabled" : "ARIA disabled", on ? "success" : "info");
  });

  saveBtn?.addEventListener("click", () => {
    const key = keyInput?.value.trim();
    if (!key || !key.startsWith("gsk_")) {
      toast("Key should start with gsk_ — check and try again.", "danger");
      return;
    }
    localStorage.setItem(ARIA_KEY_STORAGE, key);
    toast("<i class="bi bi-check2"></i> Groq key saved — ARIA is ready!", "success");
  });
}

function applyTheme(theme) {
  theme === "light"
    ? document.documentElement.setAttribute("data-theme", "light")
    : document.documentElement.removeAttribute("data-theme");
  document
    .querySelectorAll(".theme-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
}

// ─── Settings: My Info ─────────────────────────────────────────────────────────
async function populateSettingsInfo() {
  // Account email
  const emailEl = document.getElementById("settingsEmail");
  if (emailEl) emailEl.textContent = currentUser.email;

  // My information section
  const sec = document.getElementById("myInfoSection");
  if (!sec) return;

  let classText = "Not assigned";
  if (classTeacherId) {
    const tSnap = await getDoc(doc(db, "teachers", classTeacherId));
    if (tSnap.exists()) classText = tSnap.data().name;
  }

  sec.innerHTML = `
    <div class="settings-row" style="border-top:none">
      <div class="settings-row-label">Full Name</div>
      <span class="text-muted">${escHtml(studentData.name)}</span>
    </div>
    <div class="settings-row">
      <div class="settings-row-label">Email</div>
      <span class="text-muted">${escHtml(currentUser.email)}</span>
    </div>
    <div class="settings-row">
      <div class="settings-row-label">Class</div>
      <span class="text-muted">${escHtml(classText)}</span>
    </div>
    <div class="settings-row">
      <div class="settings-row-label">Account Status</div>
      <span style="color:var(--success);font-size:var(--font-size-sm)">Active</span>
    </div>`;

  // Populate added teachers list
  renderAddedTeachersList();

  // Wire teacher code button
  document
    .getElementById("addTeacherCodeBtn")
    ?.addEventListener("click", addTeacherByCode);
  document
    .getElementById("teacherCodeInput")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addTeacherByCode();
    });
}

// ─── Teacher code ──────────────────────────────────────────────────────────────
async function addTeacherByCode() {
  const input = document.getElementById("teacherCodeInput");
  const code = input?.value.trim().toUpperCase();
  if (!code) return;

  // Search all teachers' classes subcollections for a matching inviteCode.
  // We do a collectionGroup query on "classes" where inviteCode == code.
  let teacherId = null;
  let classId = null;
  let className = "";

  try {
    const { collectionGroup } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const cgSnap = await getDocs(query(collectionGroup(db, "classes"), where("inviteCode", "==", code)));
    if (!cgSnap.empty) {
      const classDoc = cgSnap.docs[0];
      // path: teachers/{teacherId}/classes/{classId}
      const pathParts = classDoc.ref.path.split("/");
      teacherId = pathParts[1];
      classId = pathParts[3];
      className = classDoc.data().name ?? "Class";
    }
  } catch (e) {
    console.warn("[student.js] collectionGroup query failed, falling back:", e);
  }

  // Fallback: query flat inviteCode on teachers doc (legacy + collectionGroup unavailable)
  if (!teacherId) {
    const snap = await getDocs(query(collection(db, "teachers"), where("inviteCode", "==", code)));
    if (!snap.empty) {
      teacherId = snap.docs[0].id;
      className = "Class";
    }
  }

  if (!teacherId) {
    toast("Code not found. Double-check with your teacher.", "danger");
    return;
  }

  if (addedTeacherIds.includes(teacherId)) {
    toast("That library is already added.", "info");
    return;
  }

  addedTeacherIds.push(teacherId);
  await updateDoc(doc(db, "students", currentUser.uid), {
    addedTeachers: arrayUnion(teacherId),
  });

  // Enroll in the specific class roster (or flat roster as fallback)
  const studentPayload = {
    studentId: currentUser.uid,
    name: studentData?.name ?? currentUser.displayName ?? "",
    email: currentUser.email ?? "",
    joinedAt: serverTimestamp(),
    joinedVia: "code",
  };
  try {
    if (classId) {
      await setDoc(doc(db, "teachers", teacherId, "classes", classId, "students", currentUser.uid), studentPayload);
    } else {
      await setDoc(doc(db, "teachers", teacherId, "students", currentUser.uid), studentPayload);
    }
  } catch (e) {
    console.warn("Could not write to teacher roster:", e);
  }

  if (input) input.value = "";
  toast(`<i class="bi bi-check2"></i> Joined ${te(className)}! Library added.`, "success");
  renderAddedTeachersList();
  await loadTeachers();
}

async function renderAddedTeachersList() {
  const container = document.getElementById("addedTeachersList");
  if (!container || addedTeacherIds.length === 0) return;

  container.innerHTML = "";
  for (const tid of addedTeacherIds) {
    const snap = await getDoc(doc(db, "teachers", tid));
    if (!snap.exists()) continue;
    const t = snap.data();
    const row = document.createElement("div");
    row.className = "settings-row";
    row.innerHTML = `
      <div>
        <div class="settings-row-label">${escHtml(t.name)}'s Library</div>
        <div class="settings-row-hint">${escHtml(t.email)}</div>
      </div>
      <button class="btn-ghost" style="font-size:0.72rem;color:var(--danger);border-color:var(--danger)" data-remove="${escHtml(
        tid,
      )}">Remove</button>`;
    row.querySelector("[data-remove]")?.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.remove;
      addedTeacherIds = addedTeacherIds.filter((x) => x !== id);
      await updateDoc(doc(db, "students", currentUser.uid), {
        addedTeachers: arrayRemove(id),
      });
      // Also remove from teacher's roster
      try {
        await deleteDoc(doc(db, "teachers", id, "students", currentUser.uid));
      } catch (e) {
        console.warn("Could not remove from teacher roster:", e);
      }
      toast("Library removed.", "info");
      renderAddedTeachersList();
      await loadTeachers();
    });
    container.appendChild(row);
  }
}

// ─── Notifications banner ──────────────────────────────────────────────────────
async function renderNotifications() {
  const banner = document.getElementById("notifBanner");
  const inner = document.getElementById("notifBannerInner");
  if (!banner || !inner) return;
  inner.innerHTML = "";

  const notifs = [];

  // 1. Any wishlisted books now available?
  const wishlist = studentData.wishlist ?? [];
  const notifTeacherId = selectedTeacherId ?? classTeacherId;
  if (wishlist.length > 0 && notifTeacherId) {
    for (const bookId of wishlist.slice(0, 5)) {
      const bSnap = await getDoc(
        doc(db, "teachers", notifTeacherId, "books", bookId),
      );
      if (bSnap.exists() && bSnap.data().status === "available") {
        notifs.push({
          text: `"${bSnap.data().title}" is now available`,
          time: "Library",
        });
      }
    }
  }

  // 2. Teacher recommendations & now reading
  if (notifTeacherId) {
    const tSnap = await getDoc(doc(db, "teachers", notifTeacherId));
    if (tSnap.exists()) {
      const t = tSnap.data();
      if (t.currentlyReading) {
        notifs.push({
          text: `${escHtml(t.name)} is reading "${escHtml(
            t.currentlyReading.title,
          )}"`,
          time: "Teacher",
        });
      }
      const recSnap = await getDocs(
        collection(db, "teachers", notifTeacherId, "recommendations"),
      );
      if (!recSnap.empty) {
        notifs.push({
          text: `${escHtml(t.name)} recommended "${escHtml(
            recSnap.docs[0].data().bookTitle,
          )}"`,
          time: "Recommendation",
        });
      }
    }
  }

  // Always show the banner — empty state is shown if no notifs

  inner.innerHTML = "";
  if (notifs.length === 0) {
    const noLib = !classTeacherId && addedTeacherIds.length === 0;
    const msg = noLib
      ? "To see notifications, join a library using your teacher's code <i class="bi bi-emoji-smile"></i>"
      : "No new notifications.";
    const div = document.createElement("div");
    div.className = "nr";
    div.innerHTML = `<div class="nd dim"></div><div class="nt" style="color:var(--muted)">${escHtml(
      msg,
    )}</div>`;
    inner.appendChild(div);
  } else {
    notifs.slice(0, 3).forEach((n) => {
      const div = document.createElement("div");
      div.className = "nr";
      div.innerHTML = `
        <div class="nd"></div>
        <div>
          <div class="nt">${escHtml(n.text)}</div>
          <div class="ntm">${escHtml(n.time)}</div>
        </div>`;
      inner.appendChild(div);
    });
  }
}

// ─── Load teachers ─────────────────────────────────────────────────────────────
async function loadTeachers() {
  if (!teacherListEl) return;
  teacherListEl.innerHTML = `<span class="chip-loading">Loading…</span>`;

  // Combine class teacher + added teachers (deduped)
  const ids = new Set();
  if (classTeacherId) ids.add(classTeacherId);
  addedTeacherIds.forEach((id) => ids.add(id));

  // ── No libraries linked yet: show CTA instead of fallback all-teachers ──
  if (ids.size === 0) {
    teacherListEl.innerHTML = "";

    const cta = document.createElement("div");
    cta.className = "no-library-cta";
    cta.innerHTML = `
      <div class="no-library-icon"><i class="bi bi-collection-fill"></i></div>
      <div class="no-library-title">No libraries linked yet</div>
      <div class="no-library-sub">Ask your teacher for their class code, then add it below.</div>
      <button class="btn-primary" id="ctaAddLibraryBtn">Add a Library Code</button>`;
    teacherListEl.appendChild(cta);

    document
      .getElementById("ctaAddLibraryBtn")
      ?.addEventListener("click", () => {
        showPage("settings");
        // scroll to teacher code section
        setTimeout(() => {
          document
            .getElementById("teacherCodeInput")
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
          document.getElementById("teacherCodeInput")?.focus();
        }, 100);
      });

    // Still load the All Libraries discovery section
    await renderAllLibraries();
    return;
  }

  // ── Has libraries: render chips ─────────────────────────────────────────
  teacherListEl.innerHTML = "";
  for (const tid of ids) {
    const snap = await getDoc(doc(db, "teachers", tid));
    if (!snap.exists()) continue;
    const t = snap.data();
    const btn = document.createElement("button");
    btn.className = "btn-role";
    btn.dataset.tid = tid;
    btn.innerHTML = `<span class="btn-role-title">${escHtml(t.name)}</span>`;
    btn.addEventListener("click", () => setSelectedTeacher(tid, t.name));
    teacherListEl.appendChild(btn);
  }

  // Always render All Libraries section below the card
  await renderAllLibraries();
}

// ─── All Libraries discovery section ──────────────────────────────────────────
async function renderAllLibraries() {
  let allLibEl = document.getElementById("allLibrariesSection");
  if (!allLibEl) {
    allLibEl = document.createElement("div");
    allLibEl.id = "allLibrariesSection";
    const r2 = document.querySelector("#libraryPage .r2");
    if (r2) r2.insertAdjacentElement("afterend", allLibEl);
    else document.getElementById("libraryPage")?.appendChild(allLibEl);
  }
  allLibEl.innerHTML = "";

  const snap = await getDocs(collection(db, "teachers"));
  if (snap.empty) return;

  const myIds = new Set();
  if (classTeacherId) myIds.add(classTeacherId);
  addedTeacherIds.forEach((id) => myIds.add(id));

  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const enrolled  = all.filter(t => myIds.has(t.id));
  const publicLib = all.filter(t => !myIds.has(t.id) && (t.libraryPublic ?? false));
  // Class-only libraries the student isn't enrolled in are hidden entirely

  const wrapper = document.createElement("div");
  wrapper.className = "all-libraries-section";

  function buildCard(t) {
    const isLinked = myIds.has(t.id);
    const isPublic = t.libraryPublic ?? false;
    const card = document.createElement("div");
    card.className = "all-lib-card";
    card.innerHTML = `
      <div class="all-lib-name">${escHtml(t.name)}</div>
      <div class="all-lib-email">${escHtml(t.email ?? "")}</div>
      <div class="all-lib-tags">
        ${isLinked ? `<span class="alib-badge linked"><i class="bi bi-check2"></i> Enrolled</span>` : ""}
        ${isPublic
          ? `<span class="alib-badge public"><i class="bi bi-collection-fill"></i> Public</span>`
          : `<span class="alib-badge class-only"><i class="bi bi-lock-fill"></i> Class Only</span>`}
      </div>
      <div class="all-lib-actions">
        <button class="btn-sm alib-browse" data-tid="${escHtml(t.id)}" data-name="${escHtml(t.name)}">
          <i class="bi bi-book-fill"></i> Browse
        </button>
        ${isPublic && !isLinked
          ? `<button class="btn-sm alib-request" data-tid="${escHtml(t.id)}" data-name="${escHtml(t.name)}" data-email="${escHtml(t.email ?? "")}">
               <i class="bi bi-envelope-fill"></i> Request Access
             </button>`
          : ""}
      </div>`;
    card.querySelector(".alib-browse")?.addEventListener("click", (e) => {
      const { tid, name } = e.currentTarget.dataset;
      setSelectedTeacher(tid, name);
      document.querySelector("#libraryPage .c")?.scrollIntoView({ behavior: "smooth" });
    });
    card.querySelector(".alib-request")?.addEventListener("click", (e) => {
      const { name, email } = e.currentTarget.dataset;
      const subject = encodeURIComponent("BookWare Library Access Request");
      const body = encodeURIComponent(
        `Hi ${name},\n\nI'd like to join your BookWare class and borrow books from your library.\n\nMy name: ${studentData?.name ?? ""}\nEmail: ${currentUser?.email ?? ""}\n\nThank you!`
      );
      window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
      toast(`Opening email to ${te(name)}\u2026`, "info");
    });
    return card;
  }

  if (enrolled.length > 0) {
    const h = document.createElement("div");
    h.className = "lbl"; h.style.marginBottom = "10px";
    h.innerHTML = `<i class="bi bi-check2"></i> My Libraries`;
    wrapper.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "all-lib-grid";
    enrolled.forEach(t => grid.appendChild(buildCard(t)));
    wrapper.appendChild(grid);
  }

  if (publicLib.length > 0) {
    const h = document.createElement("div");
    h.className = "lbl"; h.style.cssText = "margin-bottom:10px;margin-top:18px";
    h.innerHTML = `<i class="bi bi-collection-fill"></i> Discover Public Libraries`;
    const hint = document.createElement("p");
    hint.className = "t-hint"; hint.style.marginBottom = "10px";
    hint.textContent = "Browse freely \u2014 ask the teacher for their class code to check out books.";
    wrapper.appendChild(h);
    wrapper.appendChild(hint);
    const grid = document.createElement("div");
    grid.className = "all-lib-grid";
    publicLib.forEach(t => grid.appendChild(buildCard(t)));
    wrapper.appendChild(grid);
  }

  if (enrolled.length === 0 && publicLib.length === 0) {
    const p = document.createElement("p");
    p.className = "text-muted";
    p.textContent = "No libraries available yet.";
    wrapper.appendChild(p);
  }

  allLibEl.appendChild(wrapper);
}

async function setSelectedTeacher(tid, name) {
  selectedTeacherId = tid;
  selectedTeacherName = name;

  // Update chip active state
  document
    .querySelectorAll("#teacherList .btn-role")
    .forEach((b) => b.classList.toggle("selected", b.dataset.tid === tid));

  // Update book list title
  if (bookListTitleEl) bookListTitleEl.textContent = `${name}'s Library`;

  // Update active library banner
  let banner = document.getElementById("activeLibraryBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "activeLibraryBanner";
    banner.style.cssText = "display:flex;align-items:center;gap:8px;font-size:0.72rem;color:var(--muted);padding:5px 0 10px;border-bottom:1px solid var(--border);margin-bottom:10px";
    const bookListTitle = bookListTitleEl?.parentElement;
    bookListTitle?.insertAdjacentElement("afterend", banner);
  }
  banner.innerHTML = `<i class="bi bi-collection-fill" style="color:var(--accent)"></i> Viewing <strong style="color:var(--text)">${escHtml(name)}</strong>'s library`;

  await loadTeacherBooks(tid);
  await renderTeacherExtras(tid, name);
}

// ─── Teacher extras (recommended + now reading) ────────────────────────────────
async function renderTeacherExtras(tid, name) {
  // Target the placeholder cards by ID so we swap them in place,
  // preserving the col layout without nuking the container.
  const recPlaceholder = document.getElementById("recCardPlaceholder");
  const readPlaceholder = document.getElementById("readingCardPlaceholder");

  const tSnap = await getDoc(doc(db, "teachers", tid));
  const t = tSnap.exists() ? tSnap.data() : {};

  // ── Recommendations card ─────────────────────────────────────────────────
  const recCard = document.createElement("div");
  recCard.className = "c";
  recCard.id = "recCardPlaceholder"; // keep same ID so next call can find it
  recCard.innerHTML = `<div class="lbl"><i class="bi bi-star-fill"></i> Recommended by ${escHtml(
    name,
  )}</div>`;

  const recSnap = await getDocs(
    collection(db, "teachers", tid, "recommendations"),
  );
  if (recSnap.empty) {
    recCard.innerHTML += `<p class="empty-state">No recommendations yet.</p>`;
  } else {
    recSnap.forEach((d) => {
      const r = d.data();
      const row = document.createElement("div");
      row.className = "br";
      row.innerHTML = `
        ${
          r.coverUrl
            ? `<img src="${escHtml(
                r.coverUrl,
              )}" style="width:28px;height:40px;object-fit:cover;border-radius:2px;border:1px solid var(--border);flex-shrink:0">`
            : `<div class="bc"></div>`
        }
        <div class="bi">
          <div class="bt">${escHtml(r.bookTitle)}</div>
          ${
            r.author
              ? `<div class="bau">${escHtml(r.author)}</div>`
              : `<span class="bx av-b"><span class="bd"></span>Recommended</span>`
          }
        </div>`;
      recCard.appendChild(row);
    });
  }

  // ── Now reading card ─────────────────────────────────────────────────────
  const readCard = document.createElement("div");
  readCard.className = "c";
  readCard.id = "readingCardPlaceholder"; // keep same ID

  if (t.currentlyReading) {
    const r = t.currentlyReading;
    readCard.innerHTML = `
      <div class="lbl"><i class="bi bi-book-fill"></i> ${escHtml(name)} is Reading</div>
      <div class="br" style="padding-top:4px">
        ${
          r.coverUrl
            ? `<img src="${escHtml(
                r.coverUrl,
              )}" style="width:28px;height:40px;object-fit:cover;border-radius:2px;border:1px solid var(--accent);flex-shrink:0">`
            : `<div class="bc" style="border-color:var(--accent)"></div>`
        }
        <div class="bi">
          <div class="bt">${escHtml(r.title)}</div>
          <div class="bau">${escHtml(r.author)}</div>
        </div>
      </div>`;
  } else {
    readCard.innerHTML = `
      <div class="lbl"><i class="bi bi-book-fill"></i> ${escHtml(name)} is Reading</div>
      <p class="empty-state">Nothing set yet.</p>`;
  }

  // Swap placeholders in-place
  recPlaceholder?.replaceWith(recCard);
  readPlaceholder?.replaceWith(readCard);
}

// ─── Load teacher books ─────────────────────────────────────────────────────────
async function loadTeacherBooks(tid) {
  if (!bookListEl) return;
  bookListEl.innerHTML = `<p class="text-muted">Loading books…</p>`;

  // ── Access gate ───────────────────────────────────────────────────────────
  // Students may only load books if they are:
  //   (a) enrolled in this teacher's class, OR
  //   (b) the library is marked public
  const myIds = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  const isEnrolled = myIds.has(tid);

  if (!isEnrolled) {
    // Check whether the library is public before fetching books
    try {
      const tSnap = await getDoc(doc(db, "teachers", tid));
      if (!tSnap.exists() || !tSnap.data().libraryPublic) {
        bookListEl.innerHTML = `<p class="text-muted"><i class="bi bi-lock-fill"></i> This library is class-only. Ask the teacher for their class code to join.</p>`;
        allBooks = [];
        return;
      }
    } catch (e) {
      bookListEl.innerHTML = `<p class="text-muted">Could not verify library access.</p>`;
      return;
    }
  }

  const snap = await getDocs(collection(db, "teachers", tid, "books"));
  if (snap.empty) {
    bookListEl.innerHTML = `<p class="text-muted">No books in this library yet.</p>`;
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

// ─── Search ─────────────────────────────────────────────────────────────────────
searchInputEl?.addEventListener("input", filterAndRenderBooks);

function filterAndRenderBooks() {
  const term = (searchInputEl?.value ?? "").trim().toLowerCase();
  const list = term
    ? allBooks.filter(
        (b) =>
          b.title?.toLowerCase().includes(term) ||
          b.author?.toLowerCase().includes(term) ||
          b.isbn?.toLowerCase().includes(term),
      )
    : allBooks;
  renderBooks(list);
}

// ─── Render books ───────────────────────────────────────────────────────────────
function renderBooks(books) {
  if (!bookListEl) return;
  if (books.length === 0) {
    bookListEl.innerHTML = `<p class="text-muted">No books match your search.</p>`;
    return;
  }

  const hasBook = !!studentData?.currentBook;
  const wishlist = studentData?.wishlist ?? [];
  const myRecs = studentData?.myRecIds ?? new Set();
  const reading = new Set(studentData?.currentlyReading?.map(r => r.bookId) ?? []);
  bookListEl.innerHTML = "";

  books.forEach((book) => {
    const isActive = book.id === studentData?.currentBook;
    const isAvail = book.status === "available";
    const isWished = wishlist.includes(book.id);
    const isReced = myRecs.has ? myRecs.has(book.id) : false;
    const isReading = reading.has(book.id);
    const canCheckout = isAvail && !hasBook && !isActive;

    const badge = isActive
      ? `<span class="badge"><span class="badge-dot"></span>Currently Reading</span>`
      : isAvail
      ? `<span class="chip">Available</span>`
      : `<span class="chip">Checked Out</span>`;

    let action = "";
    if (isActive)
      action = `<button class="btn-ghost" data-action="return"   data-id="${escHtml(
        book.id,
      )}">Return Book</button>`;
    else if (canCheckout)
      action = `<button class="btn-primary" data-action="checkout" data-id="${escHtml(
        book.id,
      )}" data-title="${escHtml(book.title)}">Check Out</button>`;
    else if (isAvail)
      action = `<button class="btn-primary" disabled title="Return your current book first">Check Out</button>`;

    const wishBtn = !isActive
      ? `<button class="btn-ghost" data-action="${
          isWished ? "unwishlist" : "wishlist"
        }" data-id="${escHtml(book.id)}">${
          isWished ? "<i class="bi bi-heart-fill"></i> Wishlisted" : "<i class="bi bi-heart"></i> Wishlist"
        }</button>`
      : "";

    const recBtn = `<button class="btn-ghost" data-action="${
      isReced ? "unrecommend" : "recommend"
    }" data-id="${escHtml(book.id)}" data-title="${escHtml(book.title)}" data-author="${escHtml(book.author ?? "")}" data-cover="${escHtml(book.coverUrl ?? "")}" title="${isReced ? "Remove from your recommendations" : "Add to your recommendations"}">${
      isReced ? "<i class="bi bi-star-fill"></i> Recommended" : "<i class="bi bi-star"></i> Recommend"
    }</button>`;

    const readingBtn = !isActive
      ? `<button class="btn-ghost" data-action="${
          isReading ? "unset-reading" : "set-reading"
        }" data-id="${escHtml(book.id)}" data-title="${escHtml(book.title)}" data-author="${escHtml(book.author ?? "")}" data-cover="${escHtml(book.coverUrl ?? "")}" title="${isReading ? "Remove from currently reading" : "Mark as currently reading"}">${
          isReading ? "<i class="bi bi-book-fill"></i> Reading" : "<i class="bi bi-book-fill"></i> Set Reading"
        }</button>`
      : "";

    const cover = book.coverUrl
      ? `<img src="${escHtml(
          book.coverUrl,
        )}" alt="Cover" class="book-cover-thumb">`
      : "";
    const desc = book.description
      ? `<p class="text-muted book-desc">${escHtml(book.description)}</p>`
      : "";

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      ${cover}
      <div class="panel-title">${escHtml(book.title)}</div>
      <div class="panel-body">
        <p class="text-muted">${escHtml(book.author)}</p>
        <div class="chip-row"><span class="chip">ISBN ${escHtml(
          book.isbn,
        )}</span>${badge}</div>
        ${desc}
        <div class="chip-row">${action}${wishBtn}</div>
        <div class="chip-row" style="margin-top:4px">${recBtn}${readingBtn}</div>
      </div>`;

    panel
      .querySelector("[data-action='checkout']")
      ?.addEventListener("click", (e) =>
        requestCheckout(
          e.currentTarget.dataset.id,
          e.currentTarget.dataset.title,
        ),
      );
    panel
      .querySelector("[data-action='return']")
      ?.addEventListener("click", (e) =>
        initiateReturn(e.currentTarget.dataset.id),
      );
    panel
      .querySelector("[data-action='wishlist']")
      ?.addEventListener("click", (e) =>
        addToWishlist(e.currentTarget.dataset.id),
      );
    panel
      .querySelector("[data-action='unwishlist']")
      ?.addEventListener("click", (e) =>
        removeFromWishlist(e.currentTarget.dataset.id),
      );
    panel
      .querySelector("[data-action='recommend']")
      ?.addEventListener("click", (e) => {
        const d = e.currentTarget.dataset;
        toggleStudentRecommend(d.id, d.title, d.author, d.cover);
      });
    panel
      .querySelector("[data-action='unrecommend']")
      ?.addEventListener("click", (e) => {
        const d = e.currentTarget.dataset;
        toggleStudentRecommend(d.id, d.title, d.author, d.cover);
      });
    panel
      .querySelector("[data-action='set-reading']")
      ?.addEventListener("click", (e) => {
        const d = e.currentTarget.dataset;
        addToCurrentlyReading(d.id, d.title, d.author, d.cover);
      });
    panel
      .querySelector("[data-action='unset-reading']")
      ?.addEventListener("click", (e) => {
        removeFromCurrentlyReading(e.currentTarget.dataset.id);
      });

    bookListEl.appendChild(panel);
  });
}

// ─── Checkout ───────────────────────────────────────────────────────────────────
async function requestCheckout(bookId, bookTitle) {
  if (!currentUser || !selectedTeacherId) {
    alert("Select a teacher's library first.");
    return;
  }

  // Atomic transaction — prevents race condition where two students grab the last copy
  let bookAuthor = "";
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);

  // Verify access before attempting checkout
  const myIds = new Set([classTeacherId, ...addedTeacherIds].filter(Boolean));
  if (!myIds.has(selectedTeacherId)) {
    // Public library — students can browse but must join via class code to check out
    const tSnap = await getDoc(doc(db, "teachers", selectedTeacherId));
    if (!tSnap.exists() || !tSnap.data().libraryPublic) {
      alert("You need to join this teacher's class to check out books.");
      return;
    }
    // Public library — allow checkout but auto-enroll them loosely
    // (they still need a class code to appear on the roster, but can borrow)
  }

  try {
    await runTransaction(db, async (tx) => {
      const studentRef = doc(db, "students", currentUser.uid);
      const bookRef    = doc(db, "teachers", selectedTeacherId, "books", bookId);
      const [studentSnap, bSnap] = await Promise.all([tx.get(studentRef), tx.get(bookRef)]);

      if (!studentSnap.exists())               throw new Error("student-not-found");
      if (studentSnap.data().currentBook !== null) throw new Error("already-has-book");
      if (!bSnap.exists())                     throw new Error("book-not-found");

      const bData = bSnap.data();
      bookAuthor = bData.author ?? "";
      const copies = bData.copies ?? 1;
      const out    = bData.checkedOutCount ?? (bData.status === "checked_out" ? 1 : 0);
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
    const msg = err.message === "already-has-book" ? "You already have a book checked out." :
                err.message === "unavailable"       ? "All copies are now checked out — someone just beat you to it!" :
                err.message === "book-not-found"    ? "This book no longer exists." :
                `Checkout failed: ${err.message}`;
    alert(msg);
    await loadTeacherBooks(selectedTeacherId);
    return;
  }

  // History entry is non-critical — write outside transaction
  try {
    await addDoc(collection(db, "teachers", selectedTeacherId, "history"), {
      bookId, bookTitle,
      author: bookAuthor,
      studentId: currentUser.uid,
      studentName: studentData?.name ?? currentUser.displayName ?? "",
      dateOut: serverTimestamp(),
      dateReturned: null,
    });
  } catch (e) { console.warn("[student.js] History write failed:", e); }

  studentData.currentBook = bookId;
  studentData.currentBookTeacherId = selectedTeacherId;
  filterAndRenderBooks();
  toast(`<i class="bi bi-check2"></i> "${te(bookTitle)}" checked out — due ${dueDate.toLocaleDateString()}`, "success");
}

// ─── Return ─────────────────────────────────────────────────────────────────────
async function initiateReturn(bookId) {
  if (!confirm("Confirm you've handed the book back to your teacher.\n\nYour teacher will finalize the return on their end.")) return;

  const bookTeacherId = studentData.currentBookTeacherId ?? classTeacherId;

  // Mark book available again immediately
  if (bookTeacherId) {
    try {
      const bRef = doc(db, "teachers", bookTeacherId, "books", bookId);
      const bSnap = await getDoc(bRef);
      if (bSnap.exists()) {
        const bData = bSnap.data();
        const copies = bData.copies ?? 1;
        const newCount = Math.max(0, (bData.checkedOutCount ?? 1) - 1);
        await updateDoc(bRef, {
          checkedOutCount: newCount,
          status: newCount === 0 ? "available" : "checked_out",
          checkedOutBy: newCount === 0 ? null : bData.checkedOutBy,
          checkedOutAt: newCount === 0 ? null : bData.checkedOutAt,
          dueDate: newCount === 0 ? null : bData.dueDate,
        });
      }
    } catch (e) {
      console.warn("[student.js] Could not update book status on return:", e);
    }
  }

  await updateDoc(doc(db, "students", currentUser.uid), {
    currentBook: null,
    currentBookTeacherId: null,
  });
  studentData.currentBook = null;
  studentData.currentBookTeacherId = null;
  filterAndRenderBooks();
  if (document.getElementById("lockerPage").classList.contains("active"))
    renderLockerPage();
  toast("<i class="bi bi-check2"></i> Return marked. Teacher will confirm.", "success");
}

// ─── Wishlist ───────────────────────────────────────────────────────────────────
async function addToWishlist(bookId) {
  await updateDoc(doc(db, "students", currentUser.uid), {
    wishlist: arrayUnion(bookId),
  });
  if (!studentData.wishlist) studentData.wishlist = [];
  if (!studentData.wishlist.includes(bookId)) studentData.wishlist.push(bookId);
  renderWishlist();
  filterAndRenderBooks();
  toast("<i class="bi bi-check2"></i> Added to wishlist", "success");
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

// ─── Wishlist book search (Google Books) ──────────────────────────────────────
let wishlistSearchResults = [];

document
  .getElementById("wishlistSearchInput")
  ?.addEventListener("input", async (e) => {
    const q = e.target.value.trim();
    if (!q) {
      wishlistSearchResults = [];
      renderWishlistSearchResults([]);
      return;
    }
    wishlistSearchResults = await searchBooks(q, 6);
    renderWishlistSearchResults(wishlistSearchResults);
  });

function renderWishlistSearchResults(results) {
  const el = document.getElementById("wishlistSearchResults");
  if (!el) return;
  el.innerHTML = "";
  if (!results.length) {
    el.innerHTML = `<p class="empty-state">No results.</p>`;
    return;
  }
  results.forEach((book) => {
    const isWished = (studentData?.wishlist ?? []).includes(book.sourceId);
    const row = document.createElement("div");
    row.className = "br";
    row.innerHTML = `
      ${
        book.cover
          ? `<img src="${escHtml(
              book.cover,
            )}" style="width:28px;height:40px;object-fit:cover;border-radius:2px;border:1px solid var(--border);flex-shrink:0">`
          : `<div class="bc"></div>`
      }
      <div class="bi" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div>
          <div class="bt">${escHtml(book.title)}</div>
          <div class="bau">${escHtml(book.author)}</div>
        </div>
        <button class="btn-xs ${isWished ? "starred" : ""}"
          data-gid="${escHtml(book.sourceId)}"
          data-title="${escHtml(book.title)}"
          data-author="${escHtml(book.author)}"
          data-cover="${escHtml(book.cover)}"
          style="flex-shrink:0">
          ${isWished ? "<i class="bi bi-heart-fill"></i> Wishlisted" : "<i class="bi bi-heart"></i> Wishlist"}
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
        toast(`<i class="bi bi-heart-fill"></i> "${te(title)}" added to wishlist`, "success");
        renderWishlist();
        renderWishlistSearchResults(wishlistSearchResults);
      }
    });
    el.appendChild(row);
  });
}

function renderWishlist() {
  if (!wishlistEl) return;
  const list = studentData?.wishlist ?? [];

  if (list.length === 0) {
    wishlistEl.innerHTML = `<p class="text-muted">Your wishlist is empty. Search for books on the right to add them!</p>`;
    return;
  }

  wishlistEl.innerHTML = "";
  list.forEach((bookId) => {
    const cached = bookCache.get(bookId);
    const meta = studentData?.wishlistMeta?.[bookId];
    const title = cached?.title ?? meta?.title ?? `Book ID: ${bookId.slice(0, 8)}…`;
    const author = cached?.author ?? meta?.author ?? "";
    const coverUrl = cached?.coverUrl ?? meta?.coverUrl ?? "";

    const item = document.createElement("div");
    item.className = "panel";
    item.style.display = "flex";
    item.style.gap = "10px";
    item.style.alignItems = "flex-start";
    item.innerHTML = `
      ${coverUrl ? `<img src="${escHtml(coverUrl)}" alt="Cover" style="width:36px;height:52px;object-fit:cover;border-radius:3px;border:1px solid var(--border);flex-shrink:0">` : `<div style="width:36px;height:52px;background:var(--bg-alt);border-radius:3px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0"><i class="bi bi-book-fill"></i></div>`}
      <div style="flex:1;min-width:0">
        <div class="panel-title" style="margin-bottom:2px">${escHtml(title)}</div>
        <div class="panel-body">
          <span style="font-size:0.75rem;color:var(--muted)">${escHtml(author)}</span>
          <button class="btn-ghost" data-remove="${escHtml(bookId)}" style="margin-left:auto;font-size:0.68rem;padding:3px 8px"><i class="bi bi-x"></i> Remove</button>
        </div>
      </div>`;
    item.querySelector("[data-remove]")?.addEventListener("click", (e) =>
      removeFromWishlist(e.currentTarget.dataset.remove)
    );
    wishlistEl.appendChild(item);
  });
}

// ─── Locker page ───────────────────────────────────────────────────────────────
async function renderLockerPage() {
  await renderActiveLoans();
  await renderReadingLog();
}

async function renderActiveLoans() {
  if (!activeLoansEl) return;

  const bookId = studentData.currentBook;
  if (!bookId) {
    activeLoansEl.innerHTML = `<p class="text-muted">No active loans. Check out a book from the Library!</p>`;
    return;
  }

  // Use the stored teacher ID for the book (more accurate than just classTeacherId)
  const bookTeacherId = studentData.currentBookTeacherId ?? classTeacherId;

  let book = bookCache.get(bookId);
  let bookSnap = null;
  if (bookTeacherId) {
    bookSnap = await getDoc(doc(db, "teachers", bookTeacherId, "books", bookId));
    if (bookSnap.exists()) {
      book = bookSnap.data();
      bookCache.set(bookId, { ...book, teacherId: bookTeacherId });
    }
  }

  // Due date logic
  let dueLabel = "";
  let isOverdue = false;
  if (book?.dueDate) {
    const due = book.dueDate.toDate ? book.dueDate.toDate() : new Date(book.dueDate);
    const today = new Date();
    const diffDays = Math.ceil((due - today) / 86400000);
    if (diffDays < 0) {
      isOverdue = true;
      dueLabel = `<i class="bi bi-exclamation-triangle-fill"></i> Overdue by ${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? "s" : ""}`;
    } else if (diffDays === 0) {
      dueLabel = "<i class="bi bi-calendar-event-fill"></i> Due today!";
    } else {
      dueLabel = `<i class="bi bi-calendar-event-fill"></i> Due in ${diffDays} day${diffDays !== 1 ? "s" : ""} (${due.toLocaleDateString()})`;
    }
  }

  const cover = book?.coverUrl
    ? `<img src="${escHtml(book.coverUrl)}" alt="Cover" style="width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:4px;border:1px solid var(--accent)">`
    : `<div style="width:100%;aspect-ratio:2/3;background:var(--card);border-radius:4px;border:1px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:1.6rem"><i class="bi bi-book-fill"></i></div>`;

  activeLoansEl.innerHTML = "";
  const card = document.createElement("div");
  card.className = "book-card";
  card.innerHTML = `
    <div class="book-card-cover">${cover}</div>
    <div class="book-card-title">${escHtml(book?.title ?? bookId)}</div>
    <div class="book-card-author">${escHtml(book?.author ?? "")}</div>
    <span class="bx co-b" style="display:inline-flex;gap:4px;font-size:0.62rem;padding:2px 8px;border-radius:9px;margin:6px 0;background:rgba(231,76,60,.1);color:var(--accent);border:1px solid rgba(231,76,60,.2)">
      Checked Out
    </span>
    ${dueLabel ? `<div style="font-size:0.72rem;margin:4px 0 6px;color:${isOverdue ? "var(--danger)" : "var(--muted)"};font-weight:${isOverdue ? "600" : "400"}">${escHtml(dueLabel)}</div>` : ""}
    <button class="btn-ghost" style="width:100%;margin-top:8px;font-size:0.72rem" id="returnBtnLocker">Returned It</button>`;



  card
    .querySelector("#returnBtnLocker")
    ?.addEventListener("click", () => initiateReturn(bookId));
  activeLoansEl.appendChild(card);
}

async function renderReadingLog() {
  if (!readingLogEl) return;

  // Look in teacher history for entries where studentId == currentUser.uid
  const entries = [];
  const teacherIds = new Set();
  if (classTeacherId) teacherIds.add(classTeacherId);
  addedTeacherIds.forEach((id) => teacherIds.add(id));

  for (const tid of teacherIds) {
    const snap = await getDocs(
      query(
        collection(db, "teachers", tid, "history"),
        where("studentId", "==", currentUser.uid),
      ),
    );
    snap.forEach((d) => entries.push({ ...d.data(), teacherId: tid }));
  }

  if (entries.length === 0) {
    readingLogEl.innerHTML = `<p class="text-muted">No reading history yet.</p>`;
    return;
  }

  // Sort newest first, skip the active loan
  const history = entries
    .filter((e) => e.dateReturned !== null)
    .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));

  readingLogEl.innerHTML = "";
  history.forEach((e) => {
    const card = document.createElement("div");
    card.className = "book-card faded";
    const cached = bookCache.values().find
      ? [...bookCache.values()].find((b) => b.title === e.bookTitle)
      : null;
    const cover = cached?.coverUrl
      ? `<img src="${escHtml(
          cached.coverUrl,
        )}" alt="Cover" style="width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:4px">`
      : `<div style="width:100%;aspect-ratio:2/3;background:var(--card);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:1.6rem"><i class="bi bi-book-fill"></i></div>`;
    card.innerHTML = `
      <div class="book-card-cover">${cover}</div>
      <div class="book-card-title">${escHtml(e.bookTitle)}</div>
      <div class="book-card-author">${escHtml(e.studentName ?? "")}</div>
      <span style="font-size:0.62rem;color:var(--muted);display:block;margin-top:6px">Returned ${fmtDate(
        e.dateReturned,
      )}</span>`;
    readingLogEl.appendChild(card);
  });
}

// ─── Download reading log ──────────────────────────────────────────────────────
downloadLogBtn?.addEventListener("click", async () => {
  const entries = [];
  const ids = new Set();
  if (classTeacherId) ids.add(classTeacherId);
  addedTeacherIds.forEach((id) => ids.add(id));

  for (const tid of ids) {
    const tSnap = await getDoc(doc(db, "teachers", tid));
    const tName = tSnap.exists() ? tSnap.data().name : tid;
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
  const now = new Date().toLocaleDateString();
  let md = `# Reading Log — ${studentData.name}\n\n**Exported:** ${now}\n\n`;
  md += `| Book | Teacher Library | Date Out | Date Returned |\n`;
  md += `|------|----------------|----------|---------------|\n`;
  sorted.forEach((e) => {
    md += `| ${e.bookTitle} | ${e.teacherName} | ${fmtDate(e.dateOut)} | ${
      e.dateReturned ? fmtDate(e.dateReturned) : "Currently checked out"
    } |\n`;
  });
  md += `\n---\n_Generated by BookWare · Mason High School_\n`;

  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `reading-log-${studentData.name
    .replace(/\s+/g, "-")
    .toLowerCase()}.md`;
  a.click();
  URL.revokeObjectURL(url);
  toast("<i class="bi bi-check2"></i> Reading log downloaded", "success");
});

// ─── Profile page ──────────────────────────────────────────────────────────────
async function renderProfilePage() {
  await renderProfileCurrentBook();
  await renderReadingStats();
  await renderSimilarReaders();
  await renderMyRecommendations();
}

async function renderProfileCurrentBook() {
  const el = document.getElementById("profileCurrentBook");
  if (!el) return;

  const list = studentData.currentlyReading ?? [];
  const checkedOut = studentData.currentBook;

  if (list.length === 0 && !checkedOut) {
    el.innerHTML = `<p class="text-muted">Not reading anything right now. Hit <i class="bi bi-book-fill"></i> Set Reading on any library book!</p>`;
    return;
  }

  const limitColor = list.length >= READING_LIMIT ? "var(--danger)" : "var(--muted)";
  el.innerHTML = `<div style="font-size:0.68rem;color:${limitColor};margin-bottom:8px;font-weight:${list.length >= READING_LIMIT ? "600" : "400"}">${list.length}/${READING_LIMIT} books${list.length >= READING_LIMIT ? " — list full" : ""}</div>`;

  // Show checked-out book first if present
  if (checkedOut) {
    let book = bookCache.get(checkedOut);
    if (!book && (studentData.currentBookTeacherId ?? classTeacherId)) {
      const tid = studentData.currentBookTeacherId ?? classTeacherId;
      const snap = await getDoc(doc(db, "teachers", tid, "books", checkedOut));
      if (snap.exists()) { book = snap.data(); bookCache.set(checkedOut, book); }
    }
    const card = document.createElement("div");
    card.className = "panel";
    card.style.cssText = "display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;border-color:var(--accent)";
    card.innerHTML = `
      ${book?.coverUrl ? `<img src="${escHtml(book.coverUrl)}" style="width:36px;height:52px;object-fit:cover;border-radius:3px;border:1px solid var(--border);flex-shrink:0" alt="Cover">` : `<div style="width:36px;height:52px;background:var(--bg-alt);border-radius:3px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0"><i class="bi bi-book-fill"></i></div>`}
      <div style="flex:1;min-width:0">
        <div class="panel-title" style="margin-bottom:2px">${escHtml(book?.title ?? checkedOut)}</div>
        <div style="font-size:0.72rem;color:var(--muted)">${escHtml(book?.author ?? "")}</div>
        <span class="badge" style="margin-top:6px;display:inline-flex;font-size:0.6rem"><span class="badge-dot"></span>Checked Out</span>
      </div>`;
    el.appendChild(card);
  }

  // Personal reading list
  list.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "panel";
    card.style.cssText = "display:flex;gap:10px;align-items:flex-start;margin-bottom:8px";
    card.innerHTML = `
      ${entry.coverUrl ? `<img src="${escHtml(entry.coverUrl)}" style="width:36px;height:52px;object-fit:cover;border-radius:3px;border:1px solid var(--border);flex-shrink:0" alt="Cover">` : `<div style="width:36px;height:52px;background:var(--bg-alt);border-radius:3px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0"><i class="bi bi-book-fill"></i></div>`}
      <div style="flex:1;min-width:0">
        <div class="panel-title" style="margin-bottom:2px">${escHtml(entry.bookTitle)}</div>
        <div style="font-size:0.72rem;color:var(--muted);display:flex;align-items:center;gap:8px">
          <span>${escHtml(entry.author ?? "")}</span>
          <button class="btn-ghost" data-remove="${escHtml(entry.bookId)}" style="font-size:0.68rem;padding:2px 7px;margin-left:auto"><i class="bi bi-x"></i></button>
        </div>
      </div>`;
    card.querySelector("[data-remove]")?.addEventListener("click", (e) =>
      removeFromCurrentlyReading(e.currentTarget.dataset.remove)
    );
    el.appendChild(card);
  });
}

async function renderReadingStats() {
  const el = document.getElementById("readingStats");
  if (!el) return;

  // Count history entries for this student
  let totalRead = 0;
  const ids = new Set();
  if (classTeacherId) ids.add(classTeacherId);
  addedTeacherIds.forEach((id) => ids.add(id));

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

  // Check if current book is overdue
  let overdueCount = 0;
  if (studentData.currentBook && studentData.currentBookTeacherId) {
    try {
      const bSnap = await getDoc(doc(db, "teachers", studentData.currentBookTeacherId, "books", studentData.currentBook));
      if (bSnap.exists() && bSnap.data().dueDate) {
        const due = bSnap.data().dueDate.toDate();
        if (due < new Date()) overdueCount = 1;
      }
    } catch (_) {}
  }

  el.innerHTML = `
    <div class="sb2"><div class="sn">${totalRead}</div><div class="sl">Books Read</div></div>
    <div class="sb2"><div class="sn">${wishlisted}</div><div class="sl">Wishlisted</div></div>
    <div class="sb2"><div class="sn">${active}</div><div class="sl">Active Loan</div></div>
    <div class="sb2"><div class="sn" style="color:${overdueCount > 0 ? "var(--danger)" : "inherit"}">${overdueCount}</div><div class="sl">Overdue</div></div>`;
}

async function renderSimilarReaders() {
  const el = document.getElementById("similarReaders");
  if (!el) return;

  // Find other students in same class who have overlapping wishlist/history
  // Simple approach: students who share the same classTeacherId
  if (!classTeacherId) {
    el.innerHTML = `<p class="text-muted">Join a class to see similar readers.</p>`;
    return;
  }

  const snap = await getDocs(
    query(collection(db, "students"), where("class", "==", classTeacherId)),
  );

  const others = snap.docs.filter((d) => d.id !== currentUser.uid).slice(0, 6);

  if (others.length === 0) {
    el.innerHTML = `<p class="text-muted">No other students in your class yet.</p>`;
    return;
  }

  el.innerHTML = "";
  others.forEach((d) => {
    const s = d.data();
    const initials = (s.name ?? "?")
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    const card = document.createElement("div");
    card.className = "similar-card";
    card.innerHTML = `
      <div class="similar-avatar">${escHtml(initials)}</div>
      <div class="similar-name">${escHtml(
        s.name?.split(" ")[0] ?? "Student",
      )} ${escHtml((s.name?.split(" ")[1] ?? "")[0] ?? "")}.</div>
      <div class="similar-books">${
        s.currentBook ? "Currently reading" : "No active loan"
      }</div>`;
    el.appendChild(card);
  });
}

// ─── Student Recommendations ───────────────────────────────────────────────────
const READING_LIMIT = 6;

async function loadMyRecIds() {
  const snap = await getDocs(collection(db, "students", currentUser.uid, "recommendations"));
  const ids = new Set(snap.docs.map(d => d.data().bookId));
  studentData.myRecIds = ids;
}

async function toggleStudentRecommend(bookId, bookTitle, author, coverUrl) {
  const ids = studentData.myRecIds ?? new Set();
  const snap = await getDocs(collection(db, "students", currentUser.uid, "recommendations"));
  const existing = snap.docs.find(d => d.data().bookId === bookId);

  if (existing) {
    await deleteDoc(doc(db, "students", currentUser.uid, "recommendations", existing.id));
    ids.delete(bookId);
    toast(`<i class="bi bi-star"></i> Removed "${te(bookTitle)}" from recommendations`, "info");
  } else {
    const ref = await addDoc(collection(db, "students", currentUser.uid, "recommendations"), {
      bookId, bookTitle, author: author ?? "", coverUrl: coverUrl ?? "",
      addedAt: serverTimestamp(),
    });
    ids.add(bookId);
    toast(`<i class="bi bi-star-fill"></i> "${te(bookTitle)}" added to recommendations`, "success");
  }
  studentData.myRecIds = ids;
  filterAndRenderBooks();
  if (document.getElementById("profilePage")?.classList.contains("active"))
    renderMyRecommendations();
}

// ─── Student Currently Reading List (up to 6 books) ───────────────────────────
async function addToCurrentlyReading(bookId, bookTitle, author, coverUrl) {
  const current = studentData.currentlyReading ?? [];
  if (current.find(r => r.bookId === bookId)) {
    toast("Already in your reading list.", "info");
    return;
  }
  if (current.length >= READING_LIMIT) {
    toast(`Reading list is full (max ${READING_LIMIT} books). Remove one first.`, "danger");
    return;
  }
  const entry = { bookId, bookTitle, author: author ?? "", coverUrl: coverUrl ?? "" };
  const updated = [...current, entry];
  await updateDoc(doc(db, "students", currentUser.uid), { currentlyReading: updated });
  studentData.currentlyReading = updated;
  filterAndRenderBooks();
  if (document.getElementById("profilePage")?.classList.contains("active"))
    renderProfileCurrentBook();
  toast(`<i class="bi bi-book-fill"></i> "${te(bookTitle)}" added to your reading list`, "success");
}

async function removeFromCurrentlyReading(bookId) {
  const current = studentData.currentlyReading ?? [];
  const updated = current.filter(r => r.bookId !== bookId);
  await updateDoc(doc(db, "students", currentUser.uid), { currentlyReading: updated });
  studentData.currentlyReading = updated;
  filterAndRenderBooks();
  if (document.getElementById("profilePage")?.classList.contains("active"))
    renderProfileCurrentBook();
  toast("<i class="bi bi-book-fill"></i> Removed from reading list", "info");
}

async function renderMyRecommendations() {
  const el = document.getElementById("myRecommendations");
  if (!el) return;

  const snap = await getDocs(collection(db, "students", currentUser.uid, "recommendations"));
  if (snap.empty) {
    el.innerHTML = `<p class="text-muted">No recommendations yet. Hit <i class="bi bi-star"></i> Recommend on any book in the library!</p>`;
    return;
  }

  el.innerHTML = "";
  snap.forEach((d) => {
    const r = d.data();
    const div = document.createElement("div");
    div.className = "panel";
    div.style.display = "flex";
    div.style.gap = "10px";
    div.style.alignItems = "flex-start";
    div.innerHTML = `
      ${r.coverUrl ? `<img src="${escHtml(r.coverUrl)}" style="width:36px;height:52px;object-fit:cover;border-radius:3px;border:1px solid var(--border);flex-shrink:0" alt="Cover">` : `<div style="width:36px;height:52px;background:var(--bg-alt);border-radius:3px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0"><i class="bi bi-star-fill"></i></div>`}
      <div style="flex:1;min-width:0">
        <div class="panel-title" style="margin-bottom:2px"><i class="bi bi-star-fill"></i> ${escHtml(r.bookTitle)}</div>
        <div style="font-size:0.75rem;color:var(--muted);display:flex;align-items:center;gap:8px">
          <span>${escHtml(r.author ?? "")}</span>
          <button class="btn-ghost" data-recid="${escHtml(d.id)}" style="font-size:0.68rem;padding:2px 7px;margin-left:auto"><i class="bi bi-x"></i> Remove</button>
        </div>
      </div>`;
    div.querySelector("[data-recid]")?.addEventListener("click", async (e) => {
      await deleteDoc(doc(db, "students", currentUser.uid, "recommendations", e.currentTarget.dataset.recid));
      if (studentData.myRecIds) studentData.myRecIds.delete(r.bookId);
      filterAndRenderBooks();
      renderMyRecommendations();
    });
    el.appendChild(div);
  });
}

// ─── Wishlist notifications (real-time) ────────────────────────────────────────
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
        if (book.status === "available" && !studentData.currentBook) {
          toast(`<i class="bi bi-collection-fill"></i> "${te(book.title)}" is now available!`, "success");
        }
      },
    );
    wishlistListeners.push(unsubscribe);
  });
}
