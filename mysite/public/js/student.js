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
  collection,
  query,
  where,
  orderBy,
  arrayUnion,
  arrayRemove,
  onSnapshot,
  serverTimestamp,
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
      alert(
        `Account suspended.\n\nReason: ${reason}\nDuration: ${days} days\n\nContact your teacher or administrator.`,
      );
      await signOut(auth);
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
  initTheme();
  setupSignout();
  populateSettingsInfo();
  renderWishlist();
  await loadTeachers();
  await renderNotifications();

  // Auto-select class teacher
  if (classTeacherId) {
    const tSnap = await getDoc(doc(db, "teachers", classTeacherId));
    if (tSnap.exists())
      await setSelectedTeacher(classTeacherId, tSnap.data().name);
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

function toast(msg, type = "info") {
  const c = document.getElementById("notificationContainer");
  if (!c) return;
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
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

// ─── Theme ─────────────────────────────────────────────────────────────────────
const THEME_KEY = "bookware-theme";

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.theme);
      localStorage.setItem(THEME_KEY, btn.dataset.theme);
      toast(`Theme set to ${btn.dataset.theme}`, "success");
    });
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

  // Teachers store their invite code on teachers/{uid}.inviteCode
  // Query for a teacher whose inviteCode matches
  const snap = await getDocs(
    query(collection(db, "teachers"), where("inviteCode", "==", code)),
  );

  if (snap.empty) {
    toast("Code not found. Check with your teacher.", "danger");
    return;
  }

  const teacherId = snap.docs[0].id;
  if (addedTeacherIds.includes(teacherId)) {
    toast("That library is already added.", "info");
    return;
  }

  addedTeacherIds.push(teacherId);
  await updateDoc(doc(db, "students", currentUser.uid), {
    addedTeachers: arrayUnion(teacherId),
  });

  // Also enroll in the teacher's roster so the teacher sees this student
  try {
    await setDoc(doc(db, "teachers", teacherId, "students", currentUser.uid), {
      studentId: currentUser.uid,
      name: studentData?.name ?? currentUser.displayName ?? "",
      email: currentUser.email ?? "",
      joinedAt: serverTimestamp(),
      joinedVia: "code",
    });
  } catch (e) {
    console.warn("Could not write to teacher roster:", e);
  }

  if (input) input.value = "";
  toast(`✓ Library added!`, "success");
  renderAddedTeachersList();
  await loadTeachers(); // refresh the library selector
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
  if (wishlist.length > 0 && classTeacherId) {
    for (const bookId of wishlist.slice(0, 5)) {
      const bSnap = await getDoc(
        doc(db, "teachers", classTeacherId, "books", bookId),
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
  if (classTeacherId) {
    const tSnap = await getDoc(doc(db, "teachers", classTeacherId));
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
        collection(db, "teachers", classTeacherId, "recommendations"),
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
      ? "To see notifications, join a library using your teacher's code 🙂"
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
      <div class="no-library-icon">📚</div>
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
  // Inject below the library card, before teacherExtras
  let allLibEl = document.getElementById("allLibrariesSection");
  if (!allLibEl) {
    allLibEl = document.createElement("div");
    allLibEl.id = "allLibrariesSection";
    // Insert after the left card (.c) inside the r2 grid
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

  const wrapper = document.createElement("div");
  wrapper.className = "all-libraries-section";
  wrapper.innerHTML = `<div class="lbl" style="margin-bottom:10px">All Libraries</div>`;

  const grid = document.createElement("div");
  grid.className = "all-lib-grid";

  all.forEach((t) => {
    const isLinked = myIds.has(t.id);
    const isPublic = t.libraryPublic ?? false;

    const card = document.createElement("div");
    card.className = "all-lib-card";
    card.innerHTML = `
      <div class="all-lib-name">${escHtml(t.name)}</div>
      <div class="all-lib-email">${escHtml(t.email ?? "")}</div>
      <div class="all-lib-tags">
        ${isLinked ? `<span class="alib-badge linked">Linked</span>` : ""}
        ${
          isPublic
            ? `<span class="alib-badge public">Public</span>`
            : `<span class="alib-badge class-only">Class Only</span>`
        }
      </div>
      <div class="all-lib-actions">
        ${
          isLinked
            ? `<button class="btn-sm alib-browse" data-tid="${escHtml(
                t.id,
              )}" data-name="${escHtml(t.name)}">Browse</button>`
            : isPublic
            ? `<button class="btn-sm alib-browse" data-tid="${escHtml(
                t.id,
              )}" data-name="${escHtml(t.name)}">Browse</button>
               <button class="btn-sm alib-request" style="margin-left:6px" data-tid="${escHtml(
                 t.id,
               )}" data-name="${escHtml(t.name)}" data-email="${escHtml(
                t.email ?? "",
              )}">Request</button>`
            : `<span class="alib-locked">Class Only</span>`
        }
      </div>`;

    // Browse button → selects and loads that teacher's books at top
    card.querySelector(".alib-browse")?.addEventListener("click", (e) => {
      const { tid, name } = e.currentTarget.dataset;
      setSelectedTeacher(tid, name);
      document
        .querySelector("#libraryPage .c")
        ?.scrollIntoView({ behavior: "smooth" });
    });

    // Request Access → open mailto with context
    card.querySelector(".alib-request")?.addEventListener("click", (e) => {
      const { name, email } = e.currentTarget.dataset;
      const subject = encodeURIComponent(`BookWare Library Access Request`);
      const body = encodeURIComponent(
        `Hi ${name},\n\nI\'d like to request access to borrow books from your BookWare library.\n\nMy name: ${
          studentData?.name ?? ""
        }\nEmail: ${currentUser?.email ?? ""}\n\nThank you!`,
      );
      window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
      toast(`Opening email to ${name}…`, "info");
    });

    grid.appendChild(card);
  });

  wrapper.appendChild(grid);
  allLibEl.appendChild(wrapper);
}

async function setSelectedTeacher(tid, name) {
  selectedTeacherId = tid;
  selectedTeacherName = name;

  document
    .querySelectorAll("#teacherList .btn-role")
    .forEach((b) => b.classList.toggle("selected", b.dataset.tid === tid));

  if (bookListTitleEl) bookListTitleEl.textContent = `${name}'s Books`;
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
  recCard.innerHTML = `<div class="lbl">⭐ Recommended by ${escHtml(
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
      <div class="lbl">📖 ${escHtml(name)} is Reading</div>
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
      <div class="lbl">📖 ${escHtml(name)} is Reading</div>
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
  bookListEl.innerHTML = "";

  books.forEach((book) => {
    const isActive = book.id === studentData?.currentBook;
    const isAvail = book.status === "available";
    const isWished = wishlist.includes(book.id);
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
          isWished ? "♥ Wishlisted" : "♡ Wishlist"
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

    bookListEl.appendChild(panel);
  });
}

// ─── Checkout ───────────────────────────────────────────────────────────────────
async function requestCheckout(bookId, bookTitle) {
  if (!currentUser || !selectedTeacherId) {
    alert("Select a teacher's library first.");
    return;
  }

  const fresh = await getDoc(doc(db, "students", currentUser.uid));
  if (fresh.data().currentBook !== null) {
    alert("You already have a book checked out.");
    return;
  }

  const bSnap = await getDoc(
    doc(db, "teachers", selectedTeacherId, "books", bookId),
  );
  if (!bSnap.exists() || bSnap.data().status !== "available") {
    alert("This book is no longer available.");
    await loadTeacherBooks(selectedTeacherId);
    return;
  }

  await updateDoc(doc(db, "students", currentUser.uid), {
    currentBook: bookId,
  });
  studentData.currentBook = bookId;
  filterAndRenderBooks();
  toast(`✓ Checkout requested for "${bookTitle}"`, "success");
}

// ─── Return ─────────────────────────────────────────────────────────────────────
async function initiateReturn(bookId) {
  if (!confirm("Confirm you've handed the book back to your teacher.")) return;
  await updateDoc(doc(db, "students", currentUser.uid), { currentBook: null });
  studentData.currentBook = null;
  filterAndRenderBooks();
  if (document.getElementById("lockerPage").classList.contains("active"))
    renderLockerPage();
  toast("✓ Return marked. Teacher will finalise.", "success");
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
  toast("✓ Added to wishlist", "success");
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
          ${isWished ? "♥ Wishlisted" : "♡ Wishlist"}
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
        toast(`♥ "${title}" added to wishlist`, "success");
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
    wishlistEl.innerHTML = `<p class="text-muted">Your wishlist is empty. Add books from the Library page!</p>`;
    return;
  }

  wishlistEl.innerHTML = "";
  list.forEach((bookId) => {
    const cached = bookCache.get(bookId);
    const title = cached?.title ?? `Book ID: ${bookId.slice(0, 8)}…`;
    const author = cached?.author ?? "";

    const item = document.createElement("div");
    item.className = "panel";
    item.innerHTML = `
      <div class="panel-title">${escHtml(title)}</div>
      <div class="panel-body">
        <span>${escHtml(author)}</span>
        <button class="btn-ghost" data-remove="${escHtml(
          bookId,
        )}" style="margin-left:auto">Remove</button>
      </div>`;
    item
      .querySelector("[data-remove]")
      ?.addEventListener("click", (e) =>
        removeFromWishlist(e.currentTarget.dataset.remove),
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

  let book = bookCache.get(bookId);
  if (!book && classTeacherId) {
    const snap = await getDoc(
      doc(db, "teachers", classTeacherId, "books", bookId),
    );
    if (snap.exists()) {
      book = snap.data();
      bookCache.set(bookId, { ...book, teacherId: classTeacherId });
    }
  }

  const isPending = book?.status === "available";
  const cover = book?.coverUrl
    ? `<img src="${escHtml(
        book.coverUrl,
      )}" alt="Cover" style="width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:4px;border:1px solid var(--accent)">`
    : `<div style="width:100%;aspect-ratio:2/3;background:var(--card);border-radius:4px;border:1px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:1.6rem">📖</div>`;

  activeLoansEl.innerHTML = "";
  const card = document.createElement("div");
  card.className = "book-card";
  card.innerHTML = `
    <div class="book-card-cover">${cover}</div>
    <div class="book-card-title">${escHtml(book?.title ?? bookId)}</div>
    <div class="book-card-author">${escHtml(book?.author ?? "")}</div>
    <span class="bx co-b" style="display:inline-flex;gap:4px;font-size:0.62rem;padding:2px 8px;border-radius:9px;margin:6px 0;background:rgba(231,76,60,.1);color:var(--accent);border:1px solid rgba(231,76,60,.2)">
      ${isPending ? "Pending" : "Checked Out"}
    </span>
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
      : `<div style="width:100%;aspect-ratio:2/3;background:var(--card);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:1.6rem">📖</div>`;
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
  toast("✓ Reading log downloaded", "success");
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

  const bookId = studentData.currentBook;
  if (!bookId) {
    el.innerHTML = `<div class="panel-body"><p class="text-muted">No book checked out right now.</p></div>`;
    return;
  }

  let book = bookCache.get(bookId);
  if (!book && classTeacherId) {
    const snap = await getDoc(
      doc(db, "teachers", classTeacherId, "books", bookId),
    );
    if (snap.exists()) book = snap.data();
  }

  const cover = book?.coverUrl
    ? `<img src="${escHtml(
        book.coverUrl,
      )}" alt="Cover" style="height:80px;width:auto;border-radius:4px;border:1px solid var(--accent)">`
    : "";

  el.innerHTML = `
    <div style="display:flex;gap:12px;align-items:flex-start;margin-top:4px">
      ${cover}
      <div>
        <div style="font-size:.84rem;color:var(--text);font-weight:500;margin-bottom:3px">${escHtml(
          book?.title ?? bookId,
        )}</div>
        <div style="font-size:.7rem;color:var(--muted)">${escHtml(
          book?.author ?? "",
        )}</div>
        <span class="badge" style="margin-top:8px;display:inline-flex"><span class="badge-dot"></span>Currently Reading</span>
      </div>
    </div>`;
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

  el.innerHTML = `
    <div class="sb2"><div class="sn">${totalRead}</div><div class="sl">Books Read</div></div>
    <div class="sb2"><div class="sn">${wishlisted}</div><div class="sl">Wishlisted</div></div>
    <div class="sb2"><div class="sn">${active}</div><div class="sl">Active Loan</div></div>
    <div class="sb2"><div class="sn">0</div><div class="sl">Overdue</div></div>`;
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

async function renderMyRecommendations() {
  const el = document.getElementById("myRecommendations");
  if (!el) return;

  const snap = await getDocs(
    collection(db, "students", currentUser.uid, "recommendations"),
  );
  if (snap.empty) {
    el.innerHTML = `<p class="text-muted">No recommendations yet. Add books you loved!</p>`;
    return;
  }

  el.innerHTML = "";
  snap.forEach((d) => {
    const r = d.data();
    const div = document.createElement("div");
    div.className = "panel";
    div.innerHTML = `
      <div class="panel-title">⭐ ${escHtml(r.bookTitle)}</div>
      <div class="panel-body"><p class="text-muted">${escHtml(
        r.author ?? "",
      )}</p></div>`;
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
          toast(`📚 "${book.title}" is now available!`, "success");
        }
      },
    );
    wishlistListeners.push(unsubscribe);
  });
}
