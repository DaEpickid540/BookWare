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
  addDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  arrayRemove,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { lookupISBN, searchBooks } from "./books.js";

// ─── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let teacherData = null;
let allBooks = [];
let recommendations = [];
let recGoogleSearchResults = [];
let recGoogleDebounce = null;
let historyUnsubscribe = null;

// ─── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// esc() alias for toast strings (same function, named for clarity)
const te = esc;

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toast(msg, type = "info") {
  const c = document.getElementById("notificationContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ─── Sidebar + routing — wired immediately ─────────────────────────────────────
document.getElementById("sidebarToggle")?.addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
});

const PAGE_TITLES = {
  library: "Library",
  students: "Students",
  reading: "Now Reading",
  recommendations: "Recommendations",
  invites: "Invite Teachers",
  settings: "Settings",
};

document.querySelectorAll(".ni[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
});

function showPage(name) {
  document.querySelectorAll(".pg").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".ni").forEach((n) => n.classList.remove("active"));
  document.getElementById(name + "Page")?.classList.add("active");
  document.querySelector(`[data-page="${name}"]`)?.classList.add("active");
  const ptEl = document.getElementById("pt");
  if (ptEl) ptEl.textContent = PAGE_TITLES[name] ?? name;

  if (name === "students") {
    loadCheckedOut();
    loadHistory();
    loadActiveBans();
    loadRoster();
  }
  if (name === "recommendations") {
    renderRecommendationsList();
    renderRecPicker();
    renderRecReadingDisplay();
  }
  if (name === "invites") {
    loadPastInvites();
  }
  if (name === "reading") {
    populateReadingSelect();
    renderReadingDisplay();
    renderReadingPreview();
  }
}

// ─── Email allowlist ───────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = "@masonohioschools.com";
const ADMIN_EMAILS = ["sarvin.sukhe@gmail.com", "daepickid540@gmail.com"];

function isEmailAllowed(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  return lower.endsWith(ALLOWED_DOMAIN) || ADMIN_EMAILS.includes(lower);
}

// ─── Auth ───────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "/"; return; }

  // Reveal immediately — any error below is visible, never a silent gray screen
  document.body.style.visibility = "visible";

  try {
    // Allowlist gate
    if (!isEmailAllowed(user.email)) {
      await signOut(auth);
      window.location.href = "/";
      return;
    }

    // Maintenance mode check (admins bypass)
    if (!ADMIN_EMAILS.includes(user.email?.toLowerCase())) {
      try {
        const settingsSnap = await getDoc(doc(db, "admin", "settings"));
        if (settingsSnap.exists() && settingsSnap.data().maintenanceMode === true) {
          await signOut(auth);
          alert("BookWare is currently undergoing maintenance. Please check back soon.");
          window.location.href = "/";
          return;
        }
      } catch (_) { /* allow through if unreadable */ }
    }

    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (!userSnap.exists() || userSnap.data().role !== "teacher") {
      await signOut(auth);
      window.location.href = "/";
      return;
    }

    currentUser = user;
    const teacherSnap = await getDoc(doc(db, "teachers", user.uid));
    if (!teacherSnap.exists()) {
      toast("Teacher record not found. Ask an admin or another teacher for an invite link.", "danger");
      return;
    }
    teacherData = teacherSnap.data();

  populateTopBar();
  if (!sessionStorage.getItem("bw-welcomed")) {
    const firstName = (currentUser.displayName ?? "").split(" ")[0] || "there";
    setTimeout(() => toast(`Welcome back, ${te(firstName)} <i class="bi bi-hand-wave-fill"></i>`, "success"), 800);
    sessionStorage.setItem("bw-welcomed", "1");
  }
  renderSettings();
  initARIA();
  await loadRecommendations();
  await loadLibrary();
  await loadStudentCode();
  await loadCurrentlyReading();
  initVisibilityToggle();
  checkBiweeklyNotification();
  } catch (err) {
    console.error("[teacher.js] Init failed:", err);
    toast(`Failed to load teacher portal: ${err.message ?? err.code ?? "unknown error"}. Try refreshing.`, "danger");
  }
});

document
  .getElementById("signoutBar")
  ?.addEventListener("click", () => signOut(auth));

// ─── Top bar ────────────────────────────────────────────────────────────────────
function populateTopBar() {
  const av = document.getElementById("userAvatar");
  const nameEl = document.getElementById("userDisplayName");
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

// ─── Theme / Brightness ──────────────────────────────────────────────────────
const BRIGHTNESS_KEY = "bookware-brightness";
const COLOR_KEY      = "bookware-color";
const PRESET_KEY     = "bookware-preset";

const THEME_PRESETS = {
  midnight:  { brightness: 5,  color: "crimson" },
  night:     { brightness: 18, color: "crimson" },
  dusk:      { brightness: 32, color: "sunset"  },
  ash:       { brightness: 52, color: "slate"   },
  parchment: { brightness: 72, color: "sunset"  },
  snow:      { brightness: 95, color: "ocean"   },
};

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

function applyPreset(name) {
  const preset = THEME_PRESETS[name];
  if (!preset) return;
  applyBrightness(preset.brightness);
  applyColor(preset.color);
  localStorage.setItem(BRIGHTNESS_KEY, String(preset.brightness));
  localStorage.setItem(COLOR_KEY, preset.color);
  localStorage.setItem(PRESET_KEY, name);
  const slider = document.getElementById("brightnessSlider");
  if (slider) slider.value = preset.brightness;
  document.querySelectorAll(".theme-preset").forEach((p) =>
    p.classList.toggle("active", p.dataset.preset === name),
  );
}

function initTheme() {
  const saved = parseInt(localStorage.getItem(BRIGHTNESS_KEY) ?? "18", 10);
  applyBrightness(saved);
  applyColor(localStorage.getItem(COLOR_KEY) || "crimson");

  const savedPreset = localStorage.getItem(PRESET_KEY) || "night";
  document.querySelectorAll(".theme-preset").forEach((p) =>
    p.classList.toggle("active", p.dataset.preset === savedPreset),
  );

  const slider = document.getElementById("brightnessSlider");
  if (slider) {
    slider.value = saved;
    slider.addEventListener("input", () => {
      const val = parseInt(slider.value, 10);
      applyBrightness(val);
      localStorage.setItem(BRIGHTNESS_KEY, String(val));
      localStorage.removeItem(PRESET_KEY);
      document.querySelectorAll(".theme-preset").forEach((p) => p.classList.remove("active"));
    });
  }
  document.querySelectorAll(".color-swatch").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      applyColor(swatch.dataset.color);
      localStorage.setItem(COLOR_KEY, swatch.dataset.color);
      localStorage.removeItem(PRESET_KEY);
      document.querySelectorAll(".theme-preset").forEach((p) => p.classList.remove("active"));
    });
  });
  document.querySelectorAll(".theme-preset").forEach((p) => {
    p.addEventListener("click", () => applyPreset(p.dataset.preset));
  });
}

// Kept for legacy callers
function applyTheme() {}

// ─── ARIA AI Settings ──────────────────────────────────────────────────────────
const ARIA_ENABLED_KEY = "bw-aria-enabled";
const ARIA_KEY_STORAGE  = "bw-aria-groq-key";

function initARIA() {
  const toggle   = document.getElementById("ariaEnabled");
  const panel    = document.getElementById("ariaSetupPanel");
  const keyInput = document.getElementById("ariaApiKey");
  const saveBtn  = document.getElementById("ariaSaveKeyBtn");
  if (!toggle || !panel) return;

  const enabled  = localStorage.getItem(ARIA_ENABLED_KEY) === "true";
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

// ─── Settings ───────────────────────────────────────────────────────────────────
function renderSettings() {
  const email = currentUser?.email ?? "—";
  const sub = document.getElementById("settingsEmailSub");
  const sout = document.getElementById("signoutEmail");
  if (sub) sub.textContent = email;
  if (sout) sout.textContent = email;

  const acct = document.getElementById("accountInfoSection");
  if (acct && teacherData) {
    acct.innerHTML = `
      <div class="s-row" style="border-top:none">
        <div class="s-label">Name</div>
        <span class="s-value">${esc(teacherData.name ?? "—")}</span>
      </div>
      <div class="s-row">
        <div class="s-label">Email</div>
        <span class="s-value">${esc(email)}</span>
      </div>
      <div class="s-row">
        <div class="s-label">Member Since</div>
        <span class="s-value">${fmtDate(teacherData.createdAt)}</span>
      </div>`;
  }

  const badge = document.getElementById("canInviteSettingsBadge");
  if (badge) {
    badge.textContent = "<i class="bi bi-check2"></i> All teachers";
    badge.style.color = "var(--success)";
  }
  const invChip = document.getElementById("canInviteStatus");
  if (invChip) {
    invChip.textContent = "All teachers can invite";
    invChip.style.color = "var(--success)";
  }
}

// ─── Multi-Class System ────────────────────────────────────────────────────────
// Each class has its own invite code and roster.
// All classes share the same library (teachers/{uid}/books/).
// Firestore: teachers/{uid}/classes/{classId} = { name, inviteCode, createdAt }
//            teachers/{uid}/classes/{classId}/students/{uid} = { name, email, joinedAt }

let allClasses = []; // [{ id, name, inviteCode, studentCount }]

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function loadClasses() {
  const snap = await getDocs(collection(db, "teachers", currentUser.uid, "classes"));

  // First-time migration: if teacher has old flat inviteCode but no classes, create a default class
  if (snap.empty) {
    const teacherSnap = await getDoc(doc(db, "teachers", currentUser.uid));
    const legacyCode = teacherSnap.data()?.inviteCode ?? genCode();
    const classRef = await addDoc(collection(db, "teachers", currentUser.uid, "classes"), {
      name: "Period 1",
      inviteCode: legacyCode,
      createdAt: serverTimestamp(),
    });
    // Migrate any existing students from flat roster to this class
    const oldRoster = await getDocs(collection(db, "teachers", currentUser.uid, "students"));
    for (const s of oldRoster.docs) {
      await setDoc(doc(db, "teachers", currentUser.uid, "classes", classRef.id, "students", s.id), s.data());
    }
    allClasses = [{ id: classRef.id, name: "Period 1", inviteCode: legacyCode, studentCount: oldRoster.size }];
  } else {
    allClasses = await Promise.all(snap.docs.map(async (d) => {
      const rosterSnap = await getDocs(collection(db, "teachers", currentUser.uid, "classes", d.id, "students"));
      return { id: d.id, ...d.data(), studentCount: rosterSnap.size };
    }));
    allClasses.sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
  }

  renderClassManager();
}

async function loadStudentCode() {
  await loadClasses();
}

function renderClassManager() {
  const container = document.getElementById("classManagerContainer");
  if (!container) return;
  container.innerHTML = "";

  allClasses.forEach((cls) => {
    const card = document.createElement("div");
    card.className = "class-card";
    card.innerHTML = `
      <div class="class-card-header">
        <div>
          <div class="class-card-name" id="cn-${esc(cls.id)}">${esc(cls.name)}</div>
          <div class="class-card-meta">${cls.studentCount} student${cls.studentCount !== 1 ? "s" : ""}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn-xs" data-action="rename" data-cid="${esc(cls.id)}"><i class="bi bi-pencil-fill"></i> Rename</button>
          <button class="btn-xs danger" data-action="delete-class" data-cid="${esc(cls.id)}" data-name="${esc(cls.name)}"><i class="bi bi-trash3-fill"></i></button>
        </div>
      </div>
      <div class="code-box" style="margin-top:8px">
        <span class="code-val class-code-val" id="code-${esc(cls.id)}">${esc(cls.inviteCode)}</span>
        <div class="code-box-btns">
          <button class="btn-sm" data-action="copy-code" data-cid="${esc(cls.id)}">Copy</button>
          <button class="btn-sm" data-action="refresh-code" data-cid="${esc(cls.id)}"><i class="bi bi-arrow-clockwise"></i> New</button>
        </div>
      </div>`;

    card.querySelector("[data-action='rename']").addEventListener("click", () => renameClass(cls.id, cls.name));
    card.querySelector("[data-action='delete-class']").addEventListener("click", () => deleteClass(cls.id, cls.name));
    card.querySelector("[data-action='copy-code']").addEventListener("click", () => {
      navigator.clipboard.writeText(cls.inviteCode).then(() => toast(`<i class="bi bi-check2"></i> Code for ${te(cls.name)} copied`, "success"));
    });
    card.querySelector("[data-action='refresh-code']").addEventListener("click", () => refreshClassCode(cls.id, cls.name));
    container.appendChild(card);
  });

  // Add class button
  const addBtn = document.createElement("button");
  addBtn.className = "btn-sm";
  addBtn.style.marginTop = "10px";
  addBtn.textContent = "+ Add Class / Period";
  addBtn.addEventListener("click", createClass);
  container.appendChild(addBtn);
}

async function createClass() {
  const name = prompt("Class name (e.g. Period 3, English 10B):")?.trim();
  if (!name) return;
  const code = genCode();
  const ref = await addDoc(collection(db, "teachers", currentUser.uid, "classes"), {
    name,
    inviteCode: code,
    createdAt: serverTimestamp(),
  });
  allClasses.push({ id: ref.id, name, inviteCode: code, studentCount: 0, createdAt: { seconds: Date.now() / 1000 } });
  renderClassManager();
  toast(`<i class="bi bi-check2"></i> "${te(name)}" created — code: ${te(code)}`, "success");
}

async function renameClass(classId, oldName) {
  const name = prompt("New name:", oldName)?.trim();
  if (!name || name === oldName) return;
  await updateDoc(doc(db, "teachers", currentUser.uid, "classes", classId), { name });
  const cls = allClasses.find(c => c.id === classId);
  if (cls) cls.name = name;
  renderClassManager();
  if (document.getElementById("studentsPage")?.classList.contains("active")) loadRoster();
  toast(`<i class="bi bi-check2"></i> Renamed to "${te(name)}"`, "success");
}

async function refreshClassCode(classId, className) {
  const code = genCode();
  await updateDoc(doc(db, "teachers", currentUser.uid, "classes", classId), { inviteCode: code });
  const cls = allClasses.find(c => c.id === classId);
  if (cls) cls.inviteCode = code;
  renderClassManager();
  toast(`<i class="bi bi-check2"></i> New code for ${te(className)} — existing students unaffected`, "success");
}

async function deleteClass(classId, className) {
  const roster = await getDocs(collection(db, "teachers", currentUser.uid, "classes", classId, "students"));
  if (roster.size > 0) {
    if (!confirm(`"${className}" has ${roster.size} student${roster.size !== 1 ? "s" : ""}.\n\nDeleting this class removes the roster but keeps the shared library. Students can rejoin via another class code.\n\nContinue?`)) return;
  } else {
    if (!confirm(`Delete class "${className}"? This cannot be undone.`)) return;
  }
  // Remove students from this class
  for (const s of roster.docs) {
    await deleteDoc(doc(db, "teachers", currentUser.uid, "classes", classId, "students", s.id));
  }
  await deleteDoc(doc(db, "teachers", currentUser.uid, "classes", classId));
  allClasses = allClasses.filter(c => c.id !== classId);
  renderClassManager();
  toast(`<i class="bi bi-check2"></i> "${te(className)}" deleted`, "success");
}

// ─── Library visibility ─────────────────────────────────────────────────────────
function initVisibilityToggle() {
  const toggle = document.getElementById("libraryPublicToggle");
  if (!toggle) return;
  const isPublic = teacherData?.libraryPublic ?? false;
  toggle.checked = isPublic;
  updateVisUI(isPublic);
  toggle.addEventListener("change", async () => {
    const nowPublic = toggle.checked;
    updateVisUI(nowPublic);
    await updateDoc(doc(db, "teachers", currentUser.uid), {
      libraryPublic: nowPublic,
    });
    toast(
      nowPublic
        ? `<i class="bi bi-collection-fill"></i> Library is now <strong>Public</strong>`
        : `<i class="bi bi-lock-fill"></i> Library is now <strong>Class Only</strong>`,
      "success",
    );
  });
}

async function updateVisUI(isPublic) {
  const hint   = document.getElementById("visibilityHint");
  const detail = document.getElementById("visibilityDetail");
  const inner  = document.getElementById("visibilityDetailInner");
  if (hint) hint.textContent = isPublic ? "Public — any Mason student can discover" : "Class Only";
  if (!detail || !inner) return;
  if (!isPublic) { detail.style.display = "none"; return; }
  detail.style.display = "block";
  inner.innerHTML = `<span style="color:var(--muted)">Loading stats…</span>`;
  try {
    let enrolled = 0;
    for (const cls of allClasses) {
      const r = await getDocs(collection(db, "teachers", currentUser.uid, "classes", cls.id, "students"));
      enrolled += r.size;
    }
    const books = allBooks.length;
    const out   = allBooks.filter(b => (b.checkedOutCount ?? 0) > 0 || b.status === "checked_out").length;
    inner.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px">
        <div><strong style="color:var(--text)">${enrolled}</strong> enrolled student${enrolled !== 1 ? "s" : ""}</div>
        <div><strong style="color:var(--text)">${books}</strong> book${books !== 1 ? "s" : ""}</div>
        <div><strong style="color:var(--accent)">${out}</strong> checked out</div>
      </div>
      <div style="padding-top:8px;border-top:1px solid var(--border);font-size:0.7rem">
        <i class="bi bi-info-circle"></i> Discoverable to all Mason students — checkout still requires a class code.
      </div>`;
  } catch (e) {
    inner.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> Could not load stats.`;
  }
}

// ─── ISBN Lookup ────────────────────────────────────────────────────────────────
// ─── Book search (Google Books) — used for adding to library ──────────────────
let bookSearchResults = [];

async function runBookSearch() {
  const isbnInput = document.getElementById("isbnInput");
  const isbnResult = document.getElementById("isbnResult");
  const btn = document.getElementById("lookupIsbnBtn");
  if (!isbnInput || !isbnResult || !btn) {
    console.error("[teacher.js] runBookSearch: missing DOM elements");
    return;
  }
  const query = isbnInput.value.trim();
  if (!query) {
    isbnResult.innerHTML = `<p class="t-hint" style="margin-top:8px">Type a title, author, or ISBN to search.</p>`;
    return;
  }

  isbnResult.innerHTML = `<p class="t-hint" style="margin-top:8px">Searching books…</p>`;
  btn.disabled = true;

  let results = [];
  try {
    const isIsbn = /^[\d\-]{9,17}$/.test(query.replace(/\s/g, ""));
    if (isIsbn) {
      const single = await lookupISBN(query);
      results = single ? [single] : [];
    } else {
      results = await searchBooks(query, 8);
    }
  } catch (err) {
    console.error("[teacher.js] Book search threw:", err);
    isbnResult.innerHTML = `<p class="t-hint" style="margin-top:8px;color:var(--danger)">Search error. Check console for details.</p>`;
    btn.disabled = false;
    return;
  }

  btn.disabled = false;

  if (!Array.isArray(results) || results.length === 0) {
    isbnResult.innerHTML = `<p class="t-hint" style="margin-top:8px">No results found for "${esc(
      query,
    )}". Try different keywords.</p>`;
    bookSearchResults = [];
    return;
  }

  bookSearchResults = results;
  renderBookSearchResults(results);
}

function renderBookSearchResults(results) {
  const isbnResult = document.getElementById("isbnResult");
  isbnResult.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "book-search-grid";

  results.forEach((book, i) => {
    // Check if this book already exists in the library (by isbn or sourceId)
    const existing = allBooks.find(
      (b) =>
        (book.isbn && b.isbn === book.isbn) ||
        (book.sourceId && b.sourceId === book.sourceId),
    );
    const existingCopies = existing?.copies ?? 0;

    const card = document.createElement("div");
    card.className = "book-search-card";
    card.innerHTML = `
      ${
        book.cover
          ? `<img src="${esc(book.cover)}" class="book-search-cover" alt="Cover">`
          : `<div class="book-search-cover-ph"><i class="bi bi-book-fill"></i></div>`
      }
      <div class="book-search-info">
        <div class="book-search-title">${esc(book.title)}</div>
        <div class="book-search-author">${esc(book.author)}</div>
        ${book.isbn ? `<div class="book-search-isbn">ISBN ${esc(book.isbn)}</div>` : ""}
        ${existing ? `<div class="book-search-isbn" style="color:var(--success)"><i class="bi bi-check2"></i> Already in library (${existingCopies} cop${existingCopies !== 1 ? "ies" : "y"})</div>` : ""}
        <div class="copy-stepper" style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <button class="btn-xs stepper-dec" data-idx="${i}" style="width:24px;height:24px;padding:0;font-size:1rem;line-height:1">−</button>
          <span class="stepper-val" data-idx="${i}" style="font-size:0.82rem;font-weight:600;min-width:16px;text-align:center">1</span>
          <button class="btn-xs stepper-inc" data-idx="${i}" style="width:24px;height:24px;padding:0;font-size:1rem;line-height:1">+</button>
          <button class="btn-primary stepper-add" data-idx="${i}" data-existing="${existing ? existing.id : ""}" style="font-size:0.66rem;padding:5px 12px;flex:1">
            ${existing ? "Add Copies" : "Add to Library"}
          </button>
        </div>
      </div>`;

    // Stepper logic
    let qty = 1;
    const dec = card.querySelector(".stepper-dec");
    const inc = card.querySelector(".stepper-inc");
    const val = card.querySelector(".stepper-val");
    const addBtn = card.querySelector(".stepper-add");

    dec.addEventListener("click", () => {
      if (qty > 1) { qty--; val.textContent = qty; }
    });
    inc.addEventListener("click", () => {
      if (qty < 20) { qty++; val.textContent = qty; }
    });
    addBtn.addEventListener("click", () =>
      addCopiesToLibrary(i, qty, existing?.id ?? null),
    );

    grid.appendChild(card);
  });
  isbnResult.appendChild(grid);
}

async function addCopiesToLibrary(idx, qty = 1, existingDocId = null) {
  const book = bookSearchResults[idx];
  if (!book) {
    console.warn("[teacher.js] addCopiesToLibrary: no book at index", idx);
    return;
  }
  if (!currentUser?.uid) {
    toast("Not signed in.", "danger");
    return;
  }

  try {
    if (existingDocId) {
      // Increment copies on the existing book doc
      const existingBook = allBooks.find((b) => b.id === existingDocId);
      const currentCopies = existingBook?.copies ?? 1;
      await updateDoc(doc(db, "teachers", currentUser.uid, "books", existingDocId), {
        copies: currentCopies + qty,
      });
    } else {
      // New book — create with copies field
      await addDoc(collection(db, "teachers", currentUser.uid, "books"), {
        title: book.title ?? "",
        author: book.author ?? "",
        isbn: book.isbn ?? "",
        coverUrl: book.cover ?? "",
        description: book.description ?? "",
        sourceId: book.sourceId ?? book.googleId ?? "",
        status: "available",
        copies: qty,
        checkedOutCount: 0,
        checkedOutBy: null,
        checkedOutAt: null,
        wishlist: [],
        addedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    console.error("[teacher.js] addCopiesToLibrary FAILED:", err);
    toast(`Failed to add book: ${te(err.message ?? err.code ?? "unknown")}`, "danger");
    return;
  }

  const qtyLabel = qty === 1 ? "1 copy" : `${qty} copies`;
  document.getElementById("isbnResult").innerHTML = `<p class="t-hint" style="margin-top:8px;color:var(--success)"><i class="bi bi-check2"></i> ${existingDocId ? `Added ${qtyLabel} of` : "Added"} "${esc(book.title)}" to your library.</p>`;
  document.getElementById("isbnInput").value = "";
  bookSearchResults = [];
  await loadLibrary();
  toast(`<i class="bi bi-check2"></i> "${te(book.title)}" — ${qtyLabel} added`, "success");
}

// Quick +1 copy from library list button
async function addSingleCopy(bookId, bookTitle) {
  const book = allBooks.find((b) => b.id === bookId);
  if (!book) return;
  const current = book.copies ?? 1;
  await updateDoc(doc(db, "teachers", currentUser.uid, "books", bookId), {
    copies: current + 1,
  });
  book.copies = current + 1;
  renderLibraryList(allBooks);
  toast(`<i class="bi bi-check2"></i> "${te(bookTitle)}" — now ${current + 1} cop${current + 1 !== 1 ? "ies" : "y"}`, "success");
}

document
  .getElementById("lookupIsbnBtn")
  ?.addEventListener("click", runBookSearch);
document.getElementById("isbnInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runBookSearch();
});

// ─── Load library ───────────────────────────────────────────────────────────────
async function loadLibrary() {
  const listEl = document.getElementById("libraryList");
  const countEl = document.getElementById("libraryCountChip");
  if (!listEl || !currentUser) return;
  listEl.innerHTML = `<p class="empty-state">Loading…</p>`;
  const snap = await getDocs(
    collection(db, "teachers", currentUser.uid, "books"),
  );
  allBooks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (countEl)
    countEl.textContent = `${allBooks.length} book${
      allBooks.length !== 1 ? "s" : ""
    }`;
  renderLibraryList(allBooks);
  populateReadingSelect();
  renderRecPicker();
}

function renderLibraryList(books) {
  const listEl = document.getElementById("libraryList");
  if (!listEl) return;
  if (books.length === 0) {
    listEl.innerHTML = `<p class="empty-state">${
      allBooks.length === 0 ? "No books yet — add one above!" : "No matches."
    }</p>`;
    return;
  }
  listEl.innerHTML = "";
  books.forEach((book) => {
    const isRec = recommendations.some((r) => r.bookId === book.id);
    const isOut = book.status === "checked_out";
    const row = document.createElement("div");
    row.className = "t-book-row";
    row.innerHTML = `
      ${
        book.coverUrl
          ? `<img src="${esc(book.coverUrl)}" class="t-book-cover" alt="Cover">`
          : `<div class="t-book-cover-ph"><i class="bi bi-book-fill"></i></div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(book.title)}</div>
         <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px">
           ${(() => {
             const copies = book.copies ?? 1;
             const out = book.checkedOutCount ?? (book.status === "checked_out" ? 1 : 0);
             const avail = copies - out;
             if (copies <= 1 && out <= 1) {
               return out > 0
                 ? `<span class="t-badge checked-out"><span class="t-badge-dot"></span>Checked Out</span>`
                 : `<span class="t-badge available"><span class="t-badge-dot"></span>Available</span>`;
             }
             return `<span class="t-badge ${avail > 0 ? "available" : "checked-out"}"><span class="t-badge-dot"></span>${avail}/${copies} cop${copies !== 1 ? "ies" : "y"} available</span>`;
           })()}
           ${isRec ? `<span class="t-badge recommended"><i class="bi bi-star-fill"></i> Recommended</span>` : ""}
         </div>
         <div class="t-book-actions">
           <button class="btn-xs ${isRec ? "starred" : ""}" data-action="${isRec ? "unrecommend" : "recommend"}" data-id="${esc(book.id)}" data-title="${esc(book.title)}" data-author="${esc(book.author ?? "")}" data-cover="${esc(book.coverUrl ?? "")}">
             ${isRec ? `<i class="bi bi-star"></i> Unrecommend` : `<i class="bi bi-star-fill"></i> Recommend`}
           </button>
           ${(book.checkedOutCount ?? 0) > 0 || book.status === "checked_out"
             ? `<button class="btn-xs success" data-action="return" data-id="${esc(book.id)}" data-title="${esc(book.title)}"><i class="bi bi-arrow-return-left"></i> Return</button>`
             : ""}
           <button class="btn-xs" data-action="add-copy" data-id="${esc(book.id)}" data-title="${esc(book.title)}" title="Add another physical copy"><i class="bi bi-plus-lg"></i> Copy</button>
           <button class="btn-xs danger" data-action="delete" data-id="${esc(book.id)}" data-title="${esc(book.title)}"><i class="bi bi-trash3-fill"></i> Delete</button>
         </div>
       </div>`;
      </div>`;
    row
      .querySelector("[data-action='recommend']")
      ?.addEventListener("click", (e) =>
        toggleRecommendation(
          e.currentTarget.dataset.id,
          e.currentTarget.dataset.title,
          e.currentTarget.dataset.author,
          e.currentTarget.dataset.cover,
        ),
      );
    row
      .querySelector("[data-action='unrecommend']")
      ?.addEventListener("click", (e) =>
        toggleRecommendation(
          e.currentTarget.dataset.id,
          e.currentTarget.dataset.title,
          e.currentTarget.dataset.author,
          e.currentTarget.dataset.cover,
        ),
      );
    row
      .querySelector("[data-action='return']")
      ?.addEventListener("click", (e) =>
        validateReturn(
          e.currentTarget.dataset.id,
          e.currentTarget.dataset.title,
        ),
      );
    row
      .querySelector("[data-action='delete']")
      ?.addEventListener("click", (e) =>
        deleteBook(e.currentTarget.dataset.id, e.currentTarget.dataset.title),
      );
    row
      .querySelector("[data-action='add-copy']")
      ?.addEventListener("click", (e) =>
        addSingleCopy(e.currentTarget.dataset.id, e.currentTarget.dataset.title),
      );
    listEl.appendChild(row);
  });
}

document
  .getElementById("librarySearchInput")
  ?.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    renderLibraryList(
      allBooks.filter(
        (b) =>
          b.title?.toLowerCase().includes(q) ||
          b.author?.toLowerCase().includes(q) ||
          b.isbn?.includes(q),
      ),
    );
  });

// ─── Delete book ────────────────────────────────────────────────────────────────
async function deleteBook(bookId, bookTitle) {
  if (!confirm(`Permanently delete "${bookTitle}"? This cannot be undone.`))
    return;
  await deleteDoc(doc(db, "teachers", currentUser.uid, "books", bookId));
  allBooks = allBooks.filter((b) => b.id !== bookId);
  renderLibraryList(allBooks);
  const chip = document.getElementById("libraryCountChip");
  if (chip)
    chip.textContent = `${allBooks.length} book${
      allBooks.length !== 1 ? "s" : ""
    }`;
  toast(`<i class="bi bi-check2"></i> "${te(bookTitle)}" deleted`, "success");
}

// ─── Mark returned ──────────────────────────────────────────────────────────────
async function validateReturn(bookId, bookTitle) {
  const bookRef = doc(db, "teachers", currentUser.uid, "books", bookId);
  const bSnap = await getDoc(bookRef);
  const bData = bSnap.exists() ? bSnap.data() : {};
  const newCount = Math.max(0, (bData.checkedOutCount ?? 1) - 1);
  await updateDoc(bookRef, {
    checkedOutCount: newCount,
    status: newCount === 0 ? "available" : "checked_out",
    checkedOutBy: newCount === 0 ? null : bData.checkedOutBy,
    checkedOutAt: newCount === 0 ? null : bData.checkedOutAt,
    dueDate: newCount === 0 ? null : bData.dueDate,
  });
  const q = query(
    collection(db, "teachers", currentUser.uid, "history"),
    where("bookId", "==", bookId),
    where("dateReturned", "==", null),
  );
  const snap = await getDocs(q);
  if (!snap.empty)
    await updateDoc(snap.docs[0].ref, { dateReturned: serverTimestamp() });
  await loadLibrary();
  if (document.getElementById("studentsPage")?.classList.contains("active")) {
    loadCheckedOut();
    loadHistory();
  }
  toast(`<i class="bi bi-check2"></i> "${te(bookTitle)}" marked returned`, "success");
}

// ─── Students: Checked Out ──────────────────────────────────────────────────────
async function loadCheckedOut() {
  const el = document.getElementById("checkedOutList");
  if (!el) return;
  el.innerHTML = `<p class="empty-state">Loading…</p>`;
  const checkedOut = allBooks.filter((b) => b.status === "checked_out");
  if (checkedOut.length === 0) {
    el.innerHTML = `<p class="empty-state">No books currently out.</p>`;
    return;
  }
  el.innerHTML = "";
  for (const book of checkedOut) {
    let studentName = "Unknown";
    if (book.checkedOutBy) {
      try {
        const s = await getDoc(doc(db, "students", book.checkedOutBy));
        if (s.exists()) studentName = s.data().name ?? studentName;
      } catch (_) {}
    }
    const row = document.createElement("div");
    row.className = "t-book-row";
    row.innerHTML = `
      ${
        book.coverUrl
          ? `<img src="${esc(book.coverUrl)}" class="t-book-cover" alt="Cover">`
          : `<div class="t-book-cover-ph"><i class="bi bi-book-fill"></i></div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(book.title)}</div>
        <div class="t-book-author">${esc(book.author)}</div>
        <div class="t-badge checked-out" style="margin-bottom:5px"><span class="t-badge-dot"></span>${esc(
          studentName,
        )} · Since ${fmtDate(book.checkedOutAt)}${
          book.dueDate && book.dueDate.toDate() < new Date()
            ? ` <span style="color:var(--danger);font-weight:600"><i class="bi bi-exclamation-triangle-fill"></i> OVERDUE</span>`
            : book.dueDate
            ? ` · Due ${fmtDate(book.dueDate)}`
            : ""
        }</div>
        <button class="btn-xs success" data-action="return" data-id="${esc(
          book.id,
        )}" data-title="${esc(book.title)}"><i class="bi bi-arrow-return-left"></i> Mark Returned</button>
      </div>`;
    row
      .querySelector("[data-action='return']")
      ?.addEventListener("click", (e) =>
        validateReturn(
          e.currentTarget.dataset.id,
          e.currentTarget.dataset.title,
        ),
      );
    el.appendChild(row);
  }
}

// ─── Students: History ──────────────────────────────────────────────────────────
function loadHistory() {
  const el = document.getElementById("historyList");
  if (!el) return;

  // Tear down any existing listener before re-attaching
  if (historyUnsubscribe) { historyUnsubscribe(); historyUnsubscribe = null; }

  el.innerHTML = `<p class="empty-state">Loading…</p>`;

  historyUnsubscribe = onSnapshot(
    collection(db, "teachers", currentUser.uid, "history"),
    (snap) => {
      if (snap.empty) {
        el.innerHTML = `<p class="empty-state">No history yet.</p>`;
        return;
      }
      const entries = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
      el.innerHTML = "";
      entries.forEach((e) => {
        const row = document.createElement("div");
        row.className = "t-book-row";
        row.innerHTML = `
          <div class="t-book-info">
            <div class="t-book-title">${esc(e.bookTitle)}</div>
            <div class="t-book-author">${esc(e.studentName)}</div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:3px">
              <span class="t-badge available">Out: ${fmtDate(e.dateOut)}</span>
              ${
                e.dateReturned
                  ? `<span class="t-badge available">Back: ${fmtDate(e.dateReturned)}</span>`
                  : `<span class="t-badge checked-out"><span class="t-badge-dot"></span>Still out</span>`
              }
            </div>
          </div>`;
        el.appendChild(row);
      });
    },
    (err) => {
      console.error("[teacher.js] History listener error:", err);
      el.innerHTML = `<p class="empty-state">Could not load history.</p>`;
    },
  );
}

// ─── Export .MD ─────────────────────────────────────────────────────────────────
// Styled MD: table with Book, Author, Teacher, Student, Date Out, Date Returned
document
  .getElementById("exportCheckoutsBtn")
  ?.addEventListener("click", async () => {
    const histSnap = await getDocs(
      collection(db, "teachers", currentUser.uid, "history"),
    );
    const entries = histSnap.docs
      .map((d) => d.data())
      .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
    const tName = teacherData?.name ?? "Teacher";

    let md = `# <i class="bi bi-collection-fill"></i> BookWare — Checkout Report\n\n`;
    md += `**Teacher:** ${tName}  \n`;
    md += `**Generated:** ${new Date().toLocaleString()}  \n\n`;
    md += `---\n\n`;

    // Currently out
    const active = allBooks.filter((b) => b.status === "checked_out");
    md += `## Currently Checked Out\n\n`;
    if (active.length === 0) {
      md += `*No books currently checked out.*\n\n`;
    } else {
      md += `| Book | Author | Teacher | Student | Date Out |\n`;
      md += `|------|--------|---------|---------|----------|\n`;
      for (const book of active) {
        const e = entries.find((x) => x.bookId === book.id && !x.dateReturned);
        md += `| ${book.title} | ${book.author ?? "—"} | ${tName} | ${
          e?.studentName ?? "—"
        } | ${fmtDate(e?.dateOut ?? null)} |\n`;
      }
      md += "\n";
    }

    // Full history
    md += `## Full History\n\n`;
    if (entries.length === 0) {
      md += `*No history yet.*\n`;
    } else {
      md += `| Book | Author | Teacher | Student | Date Out | Date Returned |\n`;
      md += `|------|--------|---------|---------|----------|---------------|\n`;
      entries.forEach((e) => {
        md += `| ${e.bookTitle} | ${e.author ?? "—"} | ${tName} | ${
          e.studentName
        } | ${fmtDate(e.dateOut)} | ${
          e.dateReturned ? fmtDate(e.dateReturned) : "Not yet returned"
        } |\n`;
      });
    }
    md += `\n---\n*Generated by BookWare · Mason High School*\n`;

    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tName.replace(/\s+/g, "_")}_checkouts_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("<i class="bi bi-check2"></i> Exported as .MD", "success");
  });

// ─── Bi-weekly notification ─────────────────────────────────────────────────────
// Shown once every 14 days: lists all currently checked-out books
function checkBiweeklyNotification() {
  const KEY = `bookware-biweekly-${currentUser.uid}`;
  const last = localStorage.getItem(KEY);
  const now = Date.now();
  const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
  if (last && now - parseInt(last) < TWO_WEEKS) return;

  const show = async () => {
    const checkedOut = allBooks.filter((b) => b.status === "checked_out");
    const banner = document.getElementById("biweeklyBanner");
    const content = document.getElementById("biweeklyContent");
    if (!banner || !content) return;

    // Build the markdown report
    const tName = teacherData?.name ?? "Teacher";
    const tEmail = currentUser?.email ?? "";
    const now = new Date();
    let md = `# <i class="bi bi-collection-fill"></i> BookWare — Bi-Weekly Library Report\n\n`;
    md += `**Teacher:** ${tName}  \n`;
    md += `**Generated:** ${now.toLocaleString()}  \n\n---\n\n`;

    if (checkedOut.length === 0) {
      md += `All books are currently available. No outstanding loans.\n`;
    } else {
      md += `## Currently Checked Out (${checkedOut.length} book${checkedOut.length !== 1 ? "s" : ""})\n\n`;
      md += `| Book | Author | Student | Checked Out | Due Date | Status |\n`;
      md += `|------|--------|---------|-------------|----------|--------|\n`;

      for (const book of checkedOut) {
        let studentName = "—";
        if (book.checkedOutBy) {
          try {
            const s = await getDoc(doc(db, "students", book.checkedOutBy));
            if (s.exists()) studentName = s.data().name ?? studentName;
          } catch (_) {}
        }
        const dueDate = book.dueDate?.toDate?.();
        const isOverdue = dueDate && dueDate < now;
        const dueDateStr = dueDate ? dueDate.toLocaleDateString() : "—";
        const status = isOverdue ? "<i class="bi bi-exclamation-triangle-fill"></i> OVERDUE" : "<i class="bi bi-check2"></i> Active";
        md += `| ${book.title} | ${book.author ?? "—"} | ${studentName} | ${fmtDate(book.checkedOutAt)} | ${dueDateStr} | ${status} |\n`;
      }
    }
    md += `\n---\n*Generated by BookWare · Mason High School*\n`;

    // Show the banner with summary + action buttons
    const overdueCount = checkedOut.filter(b => b.dueDate?.toDate?.() < now).length;
    content.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
        ${checkedOut.map(b => `
          <span style="font-size:0.72rem;color:var(--muted);background:var(--bg-alt);border:1px solid var(--border);border-radius:6px;padding:3px 9px">
            ${esc(b.title)}
          </span>`).join("")}
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <p class="t-hint" style="margin:0">${checkedOut.length} book${checkedOut.length !== 1 ? "s" : ""} out${overdueCount > 0 ? ` · <strong style="color:var(--danger)">${overdueCount} overdue</strong>` : ""}.</p>
        <button class="btn-sm" id="biweeklyEmailBtn"><i class="bi bi-envelope-fill"></i> Email Report to Myself</button>
        <button class="btn-sm" id="biweeklyDownloadBtn"><i class="bi bi-arrow-down"></i> Download .MD</button>
        <button class="btn-ghost" id="biweeklyDismissBtn" style="font-size:0.72rem">Dismiss</button>
      </div>`;

    banner.style.display = "block";
    localStorage.setItem(KEY, String(Date.now()));

    // Email button — opens mailto with the report in the body
    document.getElementById("biweeklyEmailBtn")?.addEventListener("click", () => {
      const subject = encodeURIComponent(`BookWare Library Report — ${now.toLocaleDateString()}`);
      // mailto body has a 2000-char limit in most clients, so we send a summary and tell them to download
      const bodyLines = [
        `Hi ${tName},`,
        ``,
        `Here is your BookWare bi-weekly library summary as of ${now.toLocaleDateString()}:`,
        ``,
        `Books currently checked out: ${checkedOut.length}`,
        overdueCount > 0 ? `<i class="bi bi-exclamation-triangle-fill"></i> Overdue: ${overdueCount}` : `No overdue books.`,
        ``,
        ...checkedOut.map(b => `• ${b.title} (${b.author ?? "—"})`),
        ``,
        `Download the full .MD report from BookWare for a complete table with student names and due dates.`,
        ``,
        `— BookWare · Mason High School`,
      ];
      const body = encodeURIComponent(bodyLines.join("\n"));
      window.location.href = `mailto:${tEmail}?subject=${subject}&body=${body}`;
      toast("<i class="bi bi-check2"></i> Opening email client…", "success");
    });

    // Download button
    document.getElementById("biweeklyDownloadBtn")?.addEventListener("click", () => {
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bookware-report-${now.toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
      toast("<i class="bi bi-check2"></i> Report downloaded", "success");
    });

    // Dismiss
    document.getElementById("biweeklyDismissBtn")?.addEventListener("click", () => {
      banner.style.display = "none";
    });
  };

  setTimeout(show, 1500);
}

// ─── Student Roster ────────────────────────────────────────────────────────────
async function loadRoster() {
  const listEl = document.getElementById("rosterList");
  const countEl = document.getElementById("rosterCount");
  if (!listEl || !currentUser) return;

  listEl.innerHTML = `<p class="empty-state">Loading roster…</p>`;
  try {
    if (allClasses.length === 0) await loadClasses();

    let totalStudents = 0;
    listEl.innerHTML = "";

    for (const cls of allClasses) {
      const snap = await getDocs(collection(db, "teachers", currentUser.uid, "classes", cls.id, "students"));
      const students = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      totalStudents += students.length;

      // Class header
      const header = document.createElement("div");
      header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;padding-bottom:6px;border-bottom:1px solid var(--border)";
      header.innerHTML = `
        <div style="font-size:0.78rem;font-weight:600;color:var(--text)">${esc(cls.name)}</div>
        <span style="font-size:0.68rem;color:var(--muted)">${students.length} student${students.length !== 1 ? "s" : ""} · Code: <code style="font-size:0.68rem">${esc(cls.inviteCode)}</code></span>`;
      listEl.appendChild(header);

      if (students.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.style.marginBottom = "6px";
        empty.textContent = "No students yet — share the code above.";
        listEl.appendChild(empty);
        continue;
      }

      students.forEach((s) => {
        const row = document.createElement("div");
        row.className = "t-book-row";
        row.innerHTML = `
          <div class="t-book-cover-ph" style="width:32px;height:32px;border-radius:50%;font-size:0.62rem">${esc(
            (s.name ?? "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()
          )}</div>
          <div class="t-book-info">
            <div class="t-book-title">${esc(s.name ?? "Unknown")}</div>
            <div class="t-book-author">${esc(s.email ?? "")}</div>
            <div class="t-book-actions">
              <button class="btn-xs danger" data-sid="${esc(s.id)}" data-cid="${esc(cls.id)}" data-name="${esc(s.name ?? "")}">Remove</button>
            </div>
          </div>`;
        row.querySelector("button").addEventListener("click", (e) => {
          removeStudent(e.currentTarget.dataset.sid, e.currentTarget.dataset.name, e.currentTarget.dataset.cid);
        });
        listEl.appendChild(row);
      });
    }

    if (countEl) countEl.textContent = `${totalStudents} student${totalStudents !== 1 ? "s" : ""} total`;
    if (totalStudents === 0 && allClasses.length === 0) {
      listEl.innerHTML = `<p class="empty-state">No classes yet. Add one above.</p>`;
    }
  } catch (err) {
    console.error("[teacher.js] loadRoster failed:", err);
    listEl.innerHTML = `<p class="empty-state" style="color:var(--danger)">Failed to load roster: ${esc(err.message ?? "")}</p>`;
  }
}

async function removeStudent(sid, name, classId) {
  if (!confirm(`Remove ${name || "this student"} from class?\n\nThey can rejoin with the class code.`)) return;
  try {
    await deleteDoc(doc(db, "teachers", currentUser.uid, "classes", classId, "students", sid));
    // Update student's addedTeachers only if they're in no other class of this teacher
    const otherClasses = allClasses.filter(c => c.id !== classId);
    let stillInAnotherClass = false;
    for (const c of otherClasses) {
      const s = await getDoc(doc(db, "teachers", currentUser.uid, "classes", c.id, "students", sid));
      if (s.exists()) { stillInAnotherClass = true; break; }
    }
    if (!stillInAnotherClass) {
      try {
        await updateDoc(doc(db, "students", sid), { addedTeachers: arrayRemove(currentUser.uid) });
      } catch (e) { console.warn("Could not update student doc:", e); }
    }
    toast(`Removed ${te(name)} from class`, "success");
    loadRoster();
  } catch (err) {
    console.error("[teacher.js] removeStudent failed:", err);
    toast(`Failed: ${te(String(err.message ?? err))}`, "danger");
  }
}

// ─── Bans ───────────────────────────────────────────────────────────────────────
document.getElementById("issueBanBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("banStudentEmail")?.value.trim();
  const days = parseInt(document.getElementById("banDays")?.value);
  const reason = document.getElementById("banReason")?.value.trim();

  if (!email || !days || !reason) {
    toast("Fill in email, days, and reason.", "danger");
    return;
  }

  // Find student by email
  const snap = await getDocs(
    query(collection(db, "users"), where("email", "==", email)),
  );
  if (snap.empty) {
    toast("Student not found with that email.", "danger");
    return;
  }

  const studentDoc = snap.docs[0];
  const studentUid = studentDoc.id;
  const banExpiry = Timestamp.fromDate(
    new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  );

  await updateDoc(doc(db, "users", studentUid), {
    banned: true,
    banExpiry,
    banReason: reason,
    bannedBy: currentUser.uid,
    bannedAt: serverTimestamp(),
  });

  document.getElementById("banStudentEmail").value = "";
  document.getElementById("banDays").value = "";
  document.getElementById("banReason").value = "";

  toast(
    `<i class="bi bi-exclamation-triangle-fill"></i> ${email} banned for ${days} day${days !== 1 ? "s" : ""}`,
    "success",
  );
  loadActiveBans();
});

async function loadActiveBans() {
  const el = document.getElementById("activeBansList");
  if (!el) return;

  // Query for students banned by this teacher
  const snap = await getDocs(
    query(
      collection(db, "users"),
      where("bannedBy", "==", currentUser.uid),
      where("banned", "==", true),
    ),
  );

  if (snap.empty) {
    el.innerHTML = `<p class="t-hint">No active bans.</p>`;
    return;
  }

  el.innerHTML = "";
  snap.docs.forEach((d) => {
    const u = d.data();
    const row = document.createElement("div");
    row.className = "ban-item";
    row.innerHTML = `
      <div>
        <div class="ban-name">${esc(u.name ?? u.email)}</div>
        <div class="ban-meta">${esc(u.email)} · Expires ${fmtDate(
      u.banExpiry,
    )}</div>
        <div class="ban-reason">Reason: ${esc(u.banReason)}</div>
      </div>
      <button class="btn-xs success" data-uid="${esc(d.id)}" data-name="${esc(
      u.name ?? u.email,
    )}">Lift Ban</button>`;
    row.querySelector("button")?.addEventListener("click", async (e) => {
      const { uid, name } = e.currentTarget.dataset;
      await updateDoc(doc(db, "users", uid), {
        banned: false,
        banExpiry: null,
        banReason: null,
        bannedBy: null,
      });
      toast(`<i class="bi bi-check2"></i> Ban lifted for ${te(name)}`, "success");
      loadActiveBans();
    });
    el.appendChild(row);
  });
}

// ─── Recommendations ────────────────────────────────────────────────────────────
async function loadRecommendations() {
  const snap = await getDocs(
    collection(db, "teachers", currentUser.uid, "recommendations"),
  );
  recommendations = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function toggleRecommendation(
  bookId,
  bookTitle,
  author = "",
  coverUrl = "",
) {
  const existing = recommendations.find((r) => r.bookId === bookId);
  if (existing) {
    await deleteDoc(
      doc(db, "teachers", currentUser.uid, "recommendations", existing.id),
    );
    recommendations = recommendations.filter((r) => r.bookId !== bookId);
    toast(`<i class="bi bi-star"></i> "${te(bookTitle)}" unrecommended`, "info");
  } else {
    const ref = await addDoc(
      collection(db, "teachers", currentUser.uid, "recommendations"),
      { bookId, bookTitle, author, coverUrl, createdAt: serverTimestamp() },
    );
    recommendations.push({ id: ref.id, bookId, bookTitle, author, coverUrl });
    toast(`<i class="bi bi-star-fill"></i> "${te(bookTitle)}" recommended`, "success");
  }
  renderLibraryList(allBooks);
  if (
    document.getElementById("recommendationsPage")?.classList.contains("active")
  ) {
    renderRecommendationsList();
    renderRecPicker();
  }
}

function renderRecommendationsList() {
  const el = document.getElementById("recommendationsList");
  if (!el) return;
  if (recommendations.length === 0) {
    el.innerHTML = `<p class="empty-state">No recommendations yet. Search the right panel to add books.</p>`;
    return;
  }
  el.innerHTML = "";
  recommendations.forEach((rec) => {
    const book = allBooks.find((b) => b.id === rec.bookId);
    const coverUrl = rec.coverUrl || book?.coverUrl || "";
    const author = rec.author || book?.author || "";
    const row = document.createElement("div");
    row.className = "t-book-row";
    row.innerHTML = `
      ${
        coverUrl
          ? `<img src="${esc(coverUrl)}" class="t-book-cover" alt="Cover">`
          : `<div class="t-book-cover-ph"><i class="bi bi-book-fill"></i></div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(rec.bookTitle)}</div>
        ${author ? `<div class="t-book-author">${esc(author)}</div>` : ""}
        <button class="btn-xs danger" style="margin-top:5px" data-id="${esc(
          rec.bookId,
        )}" data-title="${esc(
      rec.bookTitle,
    )}" data-action="unrecommend"><i class="bi bi-star"></i> Remove</button>
      </div>`;
    row
      .querySelector("[data-action='unrecommend']")
      ?.addEventListener("click", (e) =>
        toggleRecommendation(
          e.currentTarget.dataset.id,
          e.currentTarget.dataset.title,
        ),
      );
    el.appendChild(row);
  });
}

function renderRecPicker() {
  const el = document.getElementById("recPickerList");
  const q = (
    document.getElementById("recSearchInput")?.value ?? ""
  ).toLowerCase();
  if (!el) return;

  const filtered = allBooks.filter(
    (b) =>
      !q ||
      b.title?.toLowerCase().includes(q) ||
      b.author?.toLowerCase().includes(q),
  );

  el.innerHTML = "";

  if (filtered.length > 0) {
    if (q && recGoogleSearchResults.length > 0) {
      const hdr = document.createElement("p");
      hdr.className = "t-hint";
      hdr.style.marginBottom = "6px";
      hdr.textContent = "Your Library:";
      el.appendChild(hdr);
    }
    filtered.forEach((book) => {
      const isRec = recommendations.some((r) => r.bookId === book.id);
      const row = document.createElement("div");
      row.className = "t-book-row";
      row.innerHTML = `
        ${
          book.coverUrl
            ? `<img src="${esc(
                book.coverUrl,
              )}" class="t-book-cover" alt="Cover">`
            : `<div class="t-book-cover-ph"><i class="bi bi-book-fill"></i></div>`
        }
        <div class="t-book-info" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="min-width:0">
            <div class="t-book-title">${esc(book.title)}</div>
            <div class="t-book-author">${esc(book.author)}</div>
          </div>
          <button class="btn-xs ${isRec ? "starred" : ""}" data-action="${
        isRec ? "unrecommend" : "recommend"
      }" data-id="${esc(book.id)}" data-title="${esc(
        book.title,
      )}" data-author="${esc(book.author ?? "")}" data-cover="${esc(
        book.coverUrl ?? "",
      )}" style="flex-shrink:0">
            ${isRec ? "<i class="bi bi-star-fill"></i> Starred" : "<i class="bi bi-star"></i> Star"}
          </button>
        </div>`;
      row.querySelector("button")?.addEventListener("click", (e) => {
        const { id, title, author, cover } = e.currentTarget.dataset;
        toggleRecommendation(id, title, author, cover);
      });
      el.appendChild(row);
    });
  }

  if (recGoogleSearchResults.length > 0) {
    const gHdr = document.createElement("p");
    gHdr.className = "t-hint";
    gHdr.style.margin = "10px 0 6px";
    gHdr.textContent = "From Google Books:";
    el.appendChild(gHdr);

    recGoogleSearchResults.forEach((book) => {
      const isRec = recommendations.some((r) => r.bookId === book.sourceId);
      const row = document.createElement("div");
      row.className = "t-book-row";
      row.innerHTML = `
        ${
          book.cover
            ? `<img src="${esc(book.cover)}" class="t-book-cover" alt="Cover">`
            : `<div class="t-book-cover-ph"><i class="bi bi-book-fill"></i></div>`
        }
        <div class="t-book-info" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="min-width:0">
            <div class="t-book-title">${esc(book.title)}</div>
            <div class="t-book-author">${esc(book.author)}</div>
          </div>
          <button class="btn-xs ${isRec ? "starred" : ""}" data-action="${
        isRec ? "unrecommend" : "recommend"
      }" data-id="${esc(book.sourceId)}" data-title="${esc(
        book.title,
      )}" data-author="${esc(book.author ?? "")}" data-cover="${esc(
        book.cover ?? "",
      )}" style="flex-shrink:0">
            ${isRec ? "<i class="bi bi-star-fill"></i> Starred" : "<i class="bi bi-star"></i> Star"}
          </button>
        </div>`;
      row.querySelector("button")?.addEventListener("click", (e) => {
        const { id, title, author, cover } = e.currentTarget.dataset;
        toggleRecommendation(id, title, author, cover);
      });
      el.appendChild(row);
    });
  }

  if (filtered.length === 0 && recGoogleSearchResults.length === 0) {
    el.innerHTML = `<p class="empty-state">${
      allBooks.length === 0
        ? "No books in library yet. Search above to recommend any book."
        : q
        ? "Searching Google Books…"
        : "No matches."
    }</p>`;
  }
}

document.getElementById("recSearchInput")?.addEventListener("input", () => {
  clearTimeout(recGoogleDebounce);
  renderRecPicker();
  const q = document.getElementById("recSearchInput")?.value.trim();
  if (q && q.length >= 2) {
    recGoogleDebounce = setTimeout(async () => {
      const results = await searchBooks(q, 6);
      recGoogleSearchResults = results.filter(
        (b) =>
          !allBooks.some(
            (lb) => lb.title?.toLowerCase() === b.title?.toLowerCase(),
          ),
      );
      renderRecPicker();
    }, 600);
  } else {
    recGoogleSearchResults = [];
  }
});

// ─── Now Reading ────────────────────────────────────────────────────────────────
async function loadCurrentlyReading() {
  const snap = await getDoc(doc(db, "teachers", currentUser.uid));
  currentUser._reading = snap.exists()
    ? snap.data().currentlyReading ?? null
    : null;
  renderReadingDisplay();
  renderReadingPreview();
  renderRecReadingDisplay();
}

let readingSearchResults = [];

function populateReadingSelect() {
  // Now reading uses a search box + your library books, not a plain select.
  // Called after library loads — populate the search UI if it exists.
  renderReadingPicker();
}

function renderReadingPicker() {
  const listEl = document.getElementById("readingPickerList");
  if (!listEl) return;
  // Show library books first
  listEl.innerHTML = "";
  if (allBooks.length === 0 && readingSearchResults.length === 0) {
    listEl.innerHTML = `<p class="t-hint">No books in your library yet. Search for one above.</p>`;
    return;
  }
  const toShow =
    readingSearchResults.length > 0
      ? readingSearchResults
      : allBooks.map((b) => ({
          isLibrary: true,
          bookId: b.id,
          title: b.title,
          author: b.author,
          cover: b.coverUrl ?? "",
          isbn: b.isbn ?? "",
        }));
  toShow.forEach((book, i) => {
    const row = document.createElement("div");
    row.className = "t-book-row";
    row.innerHTML = `
      ${
        book.cover
          ? `<img src="${esc(book.cover)}" class="t-book-cover" alt="Cover">`
          : `<div class="t-book-cover-ph"><i class="bi bi-book-fill"></i></div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(book.title)}</div>
        <div class="t-book-author">${esc(book.author)}</div>
        <button class="btn-xs success" style="margin-top:4px" data-idx="${i}" data-is-library="${
      book.isLibrary ? "1" : "0"
    }"><i class="bi bi-book-fill"></i> Set as Reading</button>
      </div>`;
    row
      .querySelector("button")
      .addEventListener("click", (e) =>
        setReading(i, e.currentTarget.dataset.isLibrary === "1"),
      );
    listEl.appendChild(row);
  });
}

async function runReadingSearch() {
  const q = document.getElementById("readingSearchInput")?.value.trim();
  if (!q) {
    readingSearchResults = [];
    renderReadingPicker();
    return;
  }
  const btn = document.getElementById("readingSearchBtn");
  if (btn) btn.disabled = true;
  readingSearchResults = (await searchBooks(q, 6)).map((b) => ({
    ...b,
    cover: b.cover,
    isLibrary: false,
  }));
  if (btn) btn.disabled = false;
  renderReadingPicker();
}

async function setReading(idx, isLibrary) {
  let book;
  const toShow =
    readingSearchResults.length > 0
      ? readingSearchResults
      : allBooks.map((b) => ({
          isLibrary: true,
          bookId: b.id,
          title: b.title,
          author: b.author,
          cover: b.coverUrl ?? "",
        }));
  book = toShow[idx];
  if (!book) return;
  const reading = {
    bookId: book.bookId ?? book.sourceId ?? "",
    title: book.title,
    author: book.author,
    coverUrl: book.cover ?? "",
    updatedAt: serverTimestamp(),
  };
  await setDoc(
    doc(db, "teachers", currentUser.uid),
    { currentlyReading: reading },
    { merge: true },
  );
  currentUser._reading = reading;
  renderReadingDisplay();
  renderReadingPreview();
  toast(`<i class="bi bi-book-fill"></i> Now reading: ${te(book.title)}`, "success");
}

document
  .getElementById("readingSearchBtn")
  ?.addEventListener("click", runReadingSearch);
document
  .getElementById("readingSearchInput")
  ?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runReadingSearch();
  });
// setCurrentlyReadingBtn doesn't exist in new HTML — no-op kept for compat

document
  .getElementById("clearCurrentlyReadingBtn")
  ?.addEventListener("click", async () => {
    await updateDoc(doc(db, "teachers", currentUser.uid), {
      currentlyReading: null,
    });
    currentUser._reading = null;
    renderReadingDisplay();
    renderReadingPreview();
    renderRecReadingDisplay();
    toast("<i class="bi bi-check2"></i> Cleared", "info");
  });

function renderReadingDisplay() {
  const el = document.getElementById("currentlyReadingDisplay");
  if (!el) return;
  const r = currentUser?._reading;
  if (!r) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="reading-set-card">
      ${
        r.coverUrl
          ? `<img src="${esc(
              r.coverUrl,
            )}" class="reading-set-cover" alt="Cover">`
          : ""
      }
      <div>
        <div class="reading-set-title">${esc(r.title)}</div>
        <div class="reading-set-author">${esc(r.author)}</div>
        <div class="reading-set-note">Visible to students in your library</div>
      </div>
    </div>`;
}

function renderReadingPreview() {
  const el = document.getElementById("readingPreview");
  if (!el) return;
  const r = currentUser?._reading;
  if (!r) {
    el.innerHTML = `<p class="empty-state">Nothing set yet.</p>`;
    return;
  }
  el.innerHTML = `
    <div class="reading-preview-card">
      ${
        r.coverUrl
          ? `<img src="${esc(
              r.coverUrl,
            )}" style="height:80px;width:auto;border-radius:4px;border:1px solid var(--border);flex-shrink:0" alt="Cover">`
          : ""
      }
      <div>
        <div class="reading-preview-label">Now Reading</div>
        <div class="reading-preview-title">${esc(r.title)}</div>
        <div class="reading-preview-author">${esc(r.author)}</div>
      </div>
    </div>`;
}

// ─── Recommendations page: Currently Reading quick-set ──────────────────────────
document
  .getElementById("recReadingSearchBtn")
  ?.addEventListener("click", runRecReadingSearch);
document.getElementById("recReadingInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runRecReadingSearch();
});
document
  .getElementById("recClearReadingBtn")
  ?.addEventListener("click", async () => {
    await updateDoc(doc(db, "teachers", currentUser.uid), {
      currentlyReading: null,
    });
    currentUser._reading = null;
    renderRecReadingDisplay();
    renderReadingDisplay();
    renderReadingPreview();
    toast("<i class="bi bi-check2"></i> Cleared", "info");
  });

async function runRecReadingSearch() {
  const q = document.getElementById("recReadingInput")?.value.trim();
  if (!q) return;
  const btn = document.getElementById("recReadingSearchBtn");
  if (btn) btn.disabled = true;

  const [gResults, lFiltered] = await Promise.all([
    searchBooks(q, 4),
    Promise.resolve(
      allBooks
        .filter(
          (b) =>
            b.title?.toLowerCase().includes(q.toLowerCase()) ||
            b.author?.toLowerCase().includes(q.toLowerCase()),
        )
        .slice(0, 3)
        .map((b) => ({
          isLibrary: true,
          bookId: b.id,
          title: b.title,
          author: b.author,
          cover: b.coverUrl ?? "",
        })),
    ),
  ]);

  if (btn) btn.disabled = false;

  const combined = [
    ...lFiltered,
    ...gResults.map((b) => ({ ...b, isLibrary: false })),
  ];
  renderRecReadingResults(combined);
}

function renderRecReadingResults(results) {
  const el = document.getElementById("recReadingResults");
  if (!el) return;
  if (!results.length) {
    el.innerHTML = `<p class="t-hint">No results found.</p>`;
    return;
  }
  el.innerHTML = "";
  results.forEach((book, i) => {
    const row = document.createElement("div");
    row.className = "t-book-row";
    row.innerHTML = `
      ${
        book.cover
          ? `<img src="${esc(book.cover)}" class="t-book-cover" alt="Cover">`
          : `<div class="t-book-cover-ph"><i class="bi bi-book-fill"></i></div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(book.title)}</div>
        <div class="t-book-author">${esc(book.author)}</div>
        <button class="btn-xs success" style="margin-top:4px" data-idx="${i}"><i class="bi bi-book-fill"></i> Set as Reading</button>
      </div>`;
    row
      .querySelector("button")
      .addEventListener("click", () => setReadingFromRecPage(results, i));
    el.appendChild(row);
  });
}

async function setReadingFromRecPage(results, idx) {
  const book = results[idx];
  if (!book) return;
  const reading = {
    bookId: book.bookId ?? book.sourceId ?? "",
    title: book.title,
    author: book.author,
    coverUrl: book.cover ?? "",
    updatedAt: serverTimestamp(),
  };
  await setDoc(
    doc(db, "teachers", currentUser.uid),
    { currentlyReading: reading },
    { merge: true },
  );
  currentUser._reading = reading;
  const resultsEl = document.getElementById("recReadingResults");
  if (resultsEl) resultsEl.innerHTML = "";
  const inputEl = document.getElementById("recReadingInput");
  if (inputEl) inputEl.value = "";
  renderRecReadingDisplay();
  renderReadingDisplay();
  renderReadingPreview();
  toast(`<i class="bi bi-book-fill"></i> Now reading: ${book.title}`, "success");
}

function renderRecReadingDisplay() {
  const el = document.getElementById("recReadingDisplay");
  if (!el) return;
  const r = currentUser?._reading;
  if (!r) {
    el.innerHTML = `<p class="t-hint">Nothing set. Search below to set what you're reading.</p>`;
    return;
  }
  el.innerHTML = `
    <div class="reading-set-card">
      ${
        r.coverUrl
          ? `<img src="${esc(
              r.coverUrl,
            )}" class="reading-set-cover" alt="Cover">`
          : ""
      }
      <div>
        <div class="reading-set-title">${esc(r.title)}</div>
        <div class="reading-set-author">${esc(r.author)}</div>
        <div class="reading-set-note">Visible to students in your library</div>
      </div>
    </div>`;
}

// ─── Invite Teachers ────────────────────────────────────────────────────────────
// Invites are locked to a specific recipient email — only that address can use them.
const ALLOWED_INVITE_DOMAIN = "@masonohioschools.com";
const ADMIN_INVITE_EMAILS   = ["sarvin.sukhe@gmail.com", "daepickid540@gmail.com"];

function isAllowedInviteEmail(email) {
  const lower = (email ?? "").toLowerCase().trim();
  return lower.endsWith(ALLOWED_INVITE_DOMAIN) || ADMIN_INVITE_EMAILS.includes(lower);
}

document
  .getElementById("createInviteBtn")
  ?.addEventListener("click", async () => {
    const emailInput     = document.getElementById("inviteEmailInput");
    const outputEl       = document.getElementById("inviteOutput");
    const recipientEmail = emailInput?.value.trim().toLowerCase();

    if (!recipientEmail) {
      outputEl.innerHTML = `<p class="t-hint" style="color:var(--danger);margin-top:8px"><i class="bi bi-exclamation-triangle-fill"></i> Enter the recipient's email first.</p>`;
      emailInput?.focus();
      return;
    }
    if (!isAllowedInviteEmail(recipientEmail)) {
      outputEl.innerHTML = `<p class="t-hint" style="color:var(--danger);margin-top:8px"><i class="bi bi-exclamation-triangle-fill"></i> Only <strong>@masonohioschools.com</strong> addresses can be invited.</p>`;
      emailInput?.focus();
      return;
    }

    outputEl.innerHTML = `<p class="t-hint" style="margin-top:10px">Generating…</p>`;

    // Block duplicate active invites for the same address
    try {
      const existing = await getDocs(
        query(collection(db, "invites"),
          where("recipientEmail", "==", recipientEmail),
          where("used", "==", false)
        )
      );
      const active = existing.docs.filter(d => {
        const exp = d.data().expiresAt?.toDate?.();
        return !exp || exp > new Date();
      });
      if (active.length > 0) {
        outputEl.innerHTML = `<p class="t-hint" style="color:var(--warning);margin-top:8px"><i class="bi bi-exclamation-triangle-fill"></i> An active invite for <strong>${esc(recipientEmail)}</strong> already exists. Revoke it or wait for it to expire first.</p>`;
        return;
      }
    } catch (e) {
      console.warn("[teacher.js] Duplicate invite check failed:", e);
    }

    const token     = crypto.randomUUID();
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    await setDoc(doc(db, "invites", token), {
      createdBy:      currentUser.uid,
      createdByName:  teacherData?.name ?? currentUser.displayName ?? "",
      createdByEmail: currentUser.email ?? "",
      recipientEmail,
      createdAt: serverTimestamp(),
      expiresAt,
      used: false,
    });

    const url         = `${window.location.origin}/teacher-signup.html?token=${encodeURIComponent(token)}`;
    const mailSubject = encodeURIComponent("You're invited to join BookWare — Mason High School");
    const mailBody    = encodeURIComponent(
      `Hi,

You've been invited to join BookWare, the Mason High School library system.

` +
      `Click the link below to create your teacher account (valid for 7 days, one-time use):

` +
      `${url}

` +
      `Sign in with your school Google account and your library will be ready to go.

` +
      `— ${teacherData?.name ?? "A colleague"} via BookWare`
    );
    const mailtoHref = `mailto:${recipientEmail}?subject=${mailSubject}&body=${mailBody}`;

    outputEl.innerHTML = `
      <div style="margin-top:12px;padding:12px 14px;background:var(--bg-alt);border:1px solid var(--border);border-radius:var(--radius)">
        <div style="font-size:0.72rem;color:var(--muted);margin-bottom:8px">
          <i class="bi bi-lock-fill" style="color:var(--success)"></i>
          Invite locked to <strong style="color:var(--text)">${esc(recipientEmail)}</strong> — only that account can use it
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="generatedInviteUrl" value="${esc(url)}" readonly
            style="flex:1;font-size:0.68rem;font-family:monospace;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text)" />
          <button class="btn-sm" id="copyInviteBtn"><i class="bi bi-clipboard2-fill"></i> Copy</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
          <a class="btn-primary" href="${esc(mailtoHref)}" style="font-size:0.72rem;padding:6px 14px;text-decoration:none">
            <i class="bi bi-envelope-fill"></i> Open in Mail App
          </a>
          <span style="font-size:0.68rem;color:var(--muted)">
            <i class="bi bi-clock"></i> Expires in 7 days · One-time use
          </span>
        </div>
      </div>`;

    document.getElementById("copyInviteBtn")?.addEventListener("click", () => {
      navigator.clipboard.writeText(url)
        .then(() => toast(`<i class="bi bi-check2"></i> Link for ${te(recipientEmail)} copied`, "success"));
    });

    if (emailInput) emailInput.value = "";
    await loadPastInvites();
    toast(`<i class="bi bi-check2"></i> Invite generated for ${te(recipientEmail)}`, "success");
  });
async function loadPastInvites() {
  const el = document.getElementById("pastInvitesList");
  if (!el) return;
  el.innerHTML = `<p class="empty-state">Loading…</p>`;
  try {
    const q = query(
      collection(db, "invites"),
      where("createdBy", "==", currentUser.uid),
    );
    const snap = await getDocs(q);
    if (snap.empty) {
      el.innerHTML = `<p class="empty-state">No invites sent yet.</p>`;
      return;
    }
    const invites = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
    el.innerHTML = "";
    invites.forEach((inv) => {
      const expired = inv.expiresAt?.toDate ? inv.expiresAt.toDate() < new Date() : false;
      const state   = inv.used ? "used" : expired ? "expired" : "active";
      const label   = inv.used ? "Used" : expired ? "Expired" : "Active";
      const canRevoke = state === "active";
      const row = document.createElement("div");
      row.className = "invite-row";
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
          <span class="inv-dot ${state}"></span>
          <div style="min-width:0">
            <div class="invite-token" style="font-weight:600;font-size:0.76rem">
              ${esc(inv.recipientEmail ?? "Unknown recipient")}
            </div>
            <div class="invite-meta">
              Created ${fmtDate(inv.createdAt)} · Expires ${fmtDate(inv.expiresAt)}
              ${inv.used ? ` · Used by ${esc(inv.claimedBy ? "account" : "?")}` : ""}
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <span style="font-size:0.64rem;color:var(--${state === "active" ? "success" : state === "expired" ? "danger" : "muted"})">${label}</span>
          ${canRevoke ? `<button class="btn-xs danger" data-revoke="${esc(inv.id)}" style="padding:2px 8px;font-size:0.66rem">Revoke</button>` : ""}
        </div>`;
      row.querySelector("[data-revoke]")?.addEventListener("click", async (e) => {
        const tid = e.currentTarget.dataset.revoke;
        if (!confirm("Revoke this invite? The link will stop working immediately.")) return;
        try {
          await updateDoc(doc(db, "invites", tid), { used: true, revokedAt: serverTimestamp(), revokedBy: currentUser.uid });
          toast("<i class=\"bi bi-check2\"></i> Invite revoked", "success");
          loadPastInvites();
        } catch (err) {
          toast(`Failed to revoke: ${te(err.message)}`, "danger");
        }
      });
      el.appendChild(row);
    });
  } catch (_) {
    el.innerHTML = `<p class="empty-state">Could not load invites.</p>`;
  }
}
