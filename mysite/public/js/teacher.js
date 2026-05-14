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
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { lookupISBN, searchBooks } from "./books.js";

// ─── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let teacherData = null;
let allBooks = [];
let recommendations = [];
let recGoogleSearchResults = [];
let recGoogleDebounce = null;

// ─── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function toast(msg, type = "info") {
  const c = document.getElementById("notificationContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
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

// ─── Auth ───────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "/";
    return;
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
    toast("Teacher record not found.", "danger");
    return;
  }
  teacherData = teacherSnap.data();

  populateTopBar();
  initTheme();
  renderSettings();
  await loadRecommendations();
  await loadLibrary();
  await loadStudentCode();
  await loadCurrentlyReading();
  initVisibilityToggle();
  checkBiweeklyNotification();
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

// ─── Theme ──────────────────────────────────────────────────────────────────────
const THEME_KEY = "bookware-theme";
function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.theme);
      localStorage.setItem(THEME_KEY, btn.dataset.theme);
    });
  });
}
function applyTheme(t) {
  t === "light"
    ? document.documentElement.setAttribute("data-theme", "light")
    : document.documentElement.removeAttribute("data-theme");
  document
    .querySelectorAll(".theme-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.theme === t));
  document
    .querySelectorAll(".th-btn")
    .forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
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
    badge.textContent = "✓ All teachers";
    badge.style.color = "var(--success)";
  }
  const invChip = document.getElementById("canInviteStatus");
  if (invChip) {
    invChip.textContent = "All teachers can invite";
    invChip.style.color = "var(--success)";
  }
}

// ─── Student invite code ────────────────────────────────────────────────────────
async function loadStudentCode() {
  const snap = await getDoc(doc(db, "teachers", currentUser.uid));
  renderStudentCode(snap.data()?.inviteCode ?? null);
}
function renderStudentCode(code) {
  const el = document.getElementById("studentCodeValue");
  if (el) el.textContent = code ?? "—";
}
document.getElementById("copyStudentCodeBtn")?.addEventListener("click", () => {
  const code = document.getElementById("studentCodeValue")?.textContent;
  if (code && code !== "—")
    navigator.clipboard
      .writeText(code)
      .then(() => toast("✓ Code copied", "success"));
});
document
  .getElementById("refreshStudentCodeBtn")
  ?.addEventListener("click", async () => {
    const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    await updateDoc(doc(db, "teachers", currentUser.uid), {
      inviteCode: newCode,
    });
    renderStudentCode(newCode);
    toast("✓ New code generated — existing students unaffected", "success");
  });

// ─── Library visibility ─────────────────────────────────────────────────────────
function initVisibilityToggle() {
  const toggle = document.getElementById("libraryPublicToggle");
  if (!toggle) return;
  const isPublic = teacherData?.libraryPublic ?? false;
  toggle.checked = isPublic;
  updateVisUI(isPublic);
  toggle.addEventListener("change", async () => {
    updateVisUI(toggle.checked);
    await updateDoc(doc(db, "teachers", currentUser.uid), {
      libraryPublic: toggle.checked,
    });
    toast(
      toggle.checked ? "📖 Library is now public" : "🔒 Library is class-only",
      "success",
    );
  });
}
function updateVisUI(isPublic) {
  const hint = document.getElementById("visibilityHint");
  if (hint)
    hint.textContent = isPublic
      ? "Any student can discover and request books"
      : "Only your class";
}

// ─── ISBN Lookup ────────────────────────────────────────────────────────────────
// ─── Book search (Google Books) — used for adding to library ──────────────────
let bookSearchResults = [];

async function runBookSearch() {
  const isbnInput = document.getElementById("isbnInput");
  const isbnResult = document.getElementById("isbnResult");
  const btn = document.getElementById("lookupIsbnBtn");
  const query = isbnInput.value.trim();
  if (!query) return;

  isbnResult.innerHTML = `<p class="t-hint" style="margin-top:8px">Searching…</p>`;
  btn.disabled = true;

  // If it looks like an ISBN (all digits/dashes, 10-13 chars) do ISBN lookup first
  const isIsbn = /^[\d\-]{9,17}$/.test(query.replace(/\s/g, ""));
  const results = isIsbn
    ? await lookupISBN(query).then((r) => (r ? [r] : []))
    : await searchBooks(query, 8);

  btn.disabled = false;

  if (!results.length) {
    isbnResult.innerHTML = `<p class="t-hint" style="margin-top:8px">No results found. Try a different title or ISBN.</p>`;
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
    const card = document.createElement("div");
    card.className = "book-search-card";
    card.innerHTML = `
      ${
        book.cover
          ? `<img src="${esc(
              book.cover,
            )}" class="book-search-cover" alt="Cover">`
          : `<div class="book-search-cover-ph">📖</div>`
      }
      <div class="book-search-info">
        <div class="book-search-title">${esc(book.title)}</div>
        <div class="book-search-author">${esc(book.author)}</div>
        ${
          book.isbn
            ? `<div class="book-search-isbn">ISBN ${esc(book.isbn)}</div>`
            : ""
        }
        <button class="btn-primary" style="margin-top:8px;font-size:0.66rem;padding:5px 12px" data-idx="${i}">Add to Library</button>
      </div>`;
    card
      .querySelector("button")
      .addEventListener("click", () => addBookToLibrary(i));
    grid.appendChild(card);
  });
  isbnResult.appendChild(grid);
}

async function addBookToLibrary(idx) {
  const book = bookSearchResults[idx];
  if (!book) return;
  await addDoc(collection(db, "teachers", currentUser.uid, "books"), {
    title: book.title,
    author: book.author,
    isbn: book.isbn ?? "",
    coverUrl: book.cover ?? "",
    description: book.description ?? "",
    googleId: book.googleId ?? "",
    status: "available",
    checkedOutBy: null,
    checkedOutAt: null,
    wishlist: [],
  });
  document.getElementById(
    "isbnResult",
  ).innerHTML = `<p class="t-hint" style="margin-top:8px">✓ "${esc(
    book.title,
  )}" added to library.</p>`;
  document.getElementById("isbnInput").value = "";
  bookSearchResults = [];
  await loadLibrary();
  toast(`✓ "${book.title}" added to library`, "success");
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
          : `<div class="t-book-cover-ph">📖</div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(book.title)}</div>
        <div class="t-book-author">${esc(book.author)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px">
          ${
            isOut
              ? `<span class="t-badge checked-out"><span class="t-badge-dot"></span>Checked Out</span>`
              : `<span class="t-badge available"><span class="t-badge-dot"></span>Available</span>`
          }
          ${
            isRec
              ? `<span class="t-badge recommended">⭐ Recommended</span>`
              : ""
          }
        </div>
        <div class="t-book-actions">
          <button class="btn-xs ${isRec ? "starred" : ""}" data-action="${
      isRec ? "unrecommend" : "recommend"
    }" data-id="${esc(book.id)}" data-title="${esc(book.title)}" data-author="${esc(book.author ?? "")}" data-cover="${esc(book.coverUrl ?? "")}">
            ${isRec ? "☆ Unrecommend" : "⭐ Recommend"}
          </button>
          ${
            isOut
              ? `<button class="btn-xs success" data-action="return" data-id="${esc(
                  book.id,
                )}" data-title="${esc(book.title)}">↩ Return</button>`
              : ""
          }
          <button class="btn-xs danger" data-action="delete" data-id="${esc(
            book.id,
          )}" data-title="${esc(book.title)}">🗑 Delete</button>
        </div>
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
  toast(`✓ "${bookTitle}" deleted`, "success");
}

// ─── Mark returned ──────────────────────────────────────────────────────────────
async function validateReturn(bookId, bookTitle) {
  const bookRef = doc(db, "teachers", currentUser.uid, "books", bookId);
  await updateDoc(bookRef, {
    status: "available",
    checkedOutBy: null,
    checkedOutAt: null,
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
  toast(`✓ "${bookTitle}" marked returned`, "success");
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
          : `<div class="t-book-cover-ph">📖</div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(book.title)}</div>
        <div class="t-book-author">${esc(book.author)}</div>
        <div class="t-badge checked-out" style="margin-bottom:5px"><span class="t-badge-dot"></span>${esc(
          studentName,
        )} · Since ${fmtDate(book.checkedOutAt)}</div>
        <button class="btn-xs success" data-action="return" data-id="${esc(
          book.id,
        )}" data-title="${esc(book.title)}">↩ Mark Returned</button>
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
async function loadHistory() {
  const el = document.getElementById("historyList");
  if (!el) return;
  el.innerHTML = `<p class="empty-state">Loading…</p>`;
  const snap = await getDocs(
    collection(db, "teachers", currentUser.uid, "history"),
  );
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
              ? `<span class="t-badge available">Back: ${fmtDate(
                  e.dateReturned,
                )}</span>`
              : `<span class="t-badge checked-out"><span class="t-badge-dot"></span>Still out</span>`
          }
        </div>
      </div>`;
    el.appendChild(row);
  });
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

    let md = `# 📚 BookWare — Checkout Report\n\n`;
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
    toast("✓ Exported as .MD", "success");
  });

// ─── Bi-weekly notification ─────────────────────────────────────────────────────
// Shown once every 14 days: lists all currently checked-out books
function checkBiweeklyNotification() {
  const KEY = `bookware-biweekly-${currentUser.uid}`;
  const last = localStorage.getItem(KEY);
  const now = Date.now();
  const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
  if (last && now - parseInt(last) < TWO_WEEKS) return;

  // Wait until books have loaded
  const show = () => {
    const checkedOut = allBooks.filter((b) => b.status === "checked_out");
    if (checkedOut.length === 0) return;
    const banner = document.getElementById("biweeklyBanner");
    const content = document.getElementById("biweeklyContent");
    if (!banner || !content) return;
    content.innerHTML = `
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px">
        ${checkedOut
          .map(
            (b) => `
          <span style="font-size:0.72rem;color:var(--muted);background:var(--bg-inset);border:1px solid var(--border);border-radius:6px;padding:3px 9px">
            ${esc(b.title)}
          </span>`,
          )
          .join("")}
      </div>
      <p class="t-hint" style="margin-top:8px">${checkedOut.length} book${
      checkedOut.length !== 1 ? "s" : ""
    } currently out. Go to <strong>Students</strong> to view details.</p>`;
    banner.style.display = "block";
    localStorage.setItem(KEY, String(now));
  };

  // Give loadLibrary time to resolve
  setTimeout(show, 1500);
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
    `⚠️ ${email} banned for ${days} day${days !== 1 ? "s" : ""}`,
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
      toast(`✓ Ban lifted for ${name}`, "success");
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

async function toggleRecommendation(bookId, bookTitle, author = "", coverUrl = "") {
  const existing = recommendations.find((r) => r.bookId === bookId);
  if (existing) {
    await deleteDoc(
      doc(db, "teachers", currentUser.uid, "recommendations", existing.id),
    );
    recommendations = recommendations.filter((r) => r.bookId !== bookId);
    toast(`☆ "${bookTitle}" unrecommended`, "info");
  } else {
    const ref = await addDoc(
      collection(db, "teachers", currentUser.uid, "recommendations"),
      { bookId, bookTitle, author, coverUrl, createdAt: serverTimestamp() },
    );
    recommendations.push({ id: ref.id, bookId, bookTitle, author, coverUrl });
    toast(`⭐ "${bookTitle}" recommended`, "success");
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
          : `<div class="t-book-cover-ph">📖</div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(rec.bookTitle)}</div>
        ${author ? `<div class="t-book-author">${esc(author)}</div>` : ""}
        <button class="btn-xs danger" style="margin-top:5px" data-id="${esc(
          rec.bookId,
        )}" data-title="${esc(rec.bookTitle)}" data-action="unrecommend">☆ Remove</button>
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
            ? `<img src="${esc(book.coverUrl)}" class="t-book-cover" alt="Cover">`
            : `<div class="t-book-cover-ph">📖</div>`
        }
        <div class="t-book-info" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="min-width:0">
            <div class="t-book-title">${esc(book.title)}</div>
            <div class="t-book-author">${esc(book.author)}</div>
          </div>
          <button class="btn-xs ${isRec ? "starred" : ""}" data-action="${
        isRec ? "unrecommend" : "recommend"
      }" data-id="${esc(book.id)}" data-title="${esc(book.title)}" data-author="${esc(
        book.author ?? "",
      )}" data-cover="${esc(book.coverUrl ?? "")}" style="flex-shrink:0">
            ${isRec ? "⭐ Starred" : "☆ Star"}
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
      const isRec = recommendations.some((r) => r.bookId === book.googleId);
      const row = document.createElement("div");
      row.className = "t-book-row";
      row.innerHTML = `
        ${
          book.cover
            ? `<img src="${esc(book.cover)}" class="t-book-cover" alt="Cover">`
            : `<div class="t-book-cover-ph">📖</div>`
        }
        <div class="t-book-info" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="min-width:0">
            <div class="t-book-title">${esc(book.title)}</div>
            <div class="t-book-author">${esc(book.author)}</div>
          </div>
          <button class="btn-xs ${isRec ? "starred" : ""}" data-action="${
        isRec ? "unrecommend" : "recommend"
      }" data-id="${esc(book.googleId)}" data-title="${esc(book.title)}" data-author="${esc(
        book.author ?? "",
      )}" data-cover="${esc(book.cover ?? "")}" style="flex-shrink:0">
            ${isRec ? "⭐ Starred" : "☆ Star"}
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
          : `<div class="t-book-cover-ph">📖</div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(book.title)}</div>
        <div class="t-book-author">${esc(book.author)}</div>
        <button class="btn-xs success" style="margin-top:4px" data-idx="${i}" data-is-library="${
      book.isLibrary ? "1" : "0"
    }">📖 Set as Reading</button>
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
    bookId: book.bookId ?? book.googleId ?? "",
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
  toast(`📖 Now reading: ${book.title}`, "success");
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
    toast("✓ Cleared", "info");
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
document
  .getElementById("recReadingInput")
  ?.addEventListener("keydown", (e) => {
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
    toast("✓ Cleared", "info");
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
          : `<div class="t-book-cover-ph">📖</div>`
      }
      <div class="t-book-info">
        <div class="t-book-title">${esc(book.title)}</div>
        <div class="t-book-author">${esc(book.author)}</div>
        <button class="btn-xs success" style="margin-top:4px" data-idx="${i}">📖 Set as Reading</button>
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
    bookId: book.bookId ?? book.googleId ?? "",
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
  toast(`📖 Now reading: ${book.title}`, "success");
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
          ? `<img src="${esc(r.coverUrl)}" class="reading-set-cover" alt="Cover">`
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
// One-time UUID link stored in Firestore invites collection.
// teacher-signup.html reads ?token=, validates it, and creates the account.
document
  .getElementById("createInviteBtn")
  ?.addEventListener("click", async () => {
    const outputEl = document.getElementById("inviteOutput");
    // All teachers can invite — no permission check needed
    outputEl.innerHTML = `<p class="t-hint" style="margin-top:10px">Generating…</p>`;
    const token = crypto.randomUUID();
    const expiresAt = Timestamp.fromDate(
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    );
    await setDoc(doc(db, "invites", token), {
      createdBy: currentUser.uid,
      createdAt: serverTimestamp(),
      expiresAt,
      used: false,
    });
    const url = `${
      window.location.origin
    }/teacher-signup.html?token=${encodeURIComponent(token)}`;
    outputEl.innerHTML = `
    <div class="invite-link-box">
      <input id="generatedInviteUrl" value="${esc(url)}" readonly />
      <button class="btn-sm" id="copyInviteBtn">Copy</button>
    </div>
    <p class="t-hint" style="margin-top:6px">Expires in 7 days · One-time use · Send to the new teacher</p>`;
    document.getElementById("copyInviteBtn")?.addEventListener("click", () => {
      navigator.clipboard
        .writeText(url)
        .then(() => toast("✓ Link copied", "success"));
    });
    await loadPastInvites();
    toast("✓ Invite link generated", "success");
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
      el.innerHTML = `<p class="empty-state">No invites yet.</p>`;
      return;
    }
    const invites = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort(
        (a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0),
      );
    el.innerHTML = "";
    invites.forEach((inv) => {
      const expired = inv.expiresAt?.toDate
        ? inv.expiresAt.toDate() < new Date()
        : false;
      const state = inv.used ? "used" : expired ? "expired" : "active";
      const label = inv.used ? "Used" : expired ? "Expired" : "Active";
      const row = document.createElement("div");
      row.className = "invite-row";
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <span class="inv-dot ${state}"></span>
          <div>
            <div class="invite-token">Token: <code style="font-size:0.68rem">${esc(
              inv.id.slice(0, 14),
            )}…</code></div>
            <div class="invite-meta">Created ${fmtDate(
              inv.createdAt,
            )} · Expires ${fmtDate(inv.expiresAt)}</div>
          </div>
        </div>
        <span style="font-size:0.64rem;color:var(--${
          state === "active"
            ? "success"
            : state === "expired"
            ? "danger"
            : "muted"
        })">${label}</span>`;
      el.appendChild(row);
    });
  } catch (_) {
    el.innerHTML = `<p class="empty-state">Could not load invites.</p>`;
  }
}
