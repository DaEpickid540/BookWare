import { auth, db } from "./firebase.js";
import {
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  getDocs,
  updateDoc,
  collection,
  arrayUnion, // added: wishlist add
  arrayRemove, // added: wishlist remove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const logoutBtn = document.getElementById("logoutStudent");
const profileEl = document.getElementById("profilePanel"); // new
const currentBookEl = document.getElementById("currentBookPanel");
const wishlistEl = document.getElementById("wishlistPanel");
const teacherListEl = document.getElementById("teacherList"); // new
const searchInputEl = document.getElementById("searchInput"); // new
const bookListEl = document.getElementById("bookList");
const bookListTitleEl = document.getElementById("bookListTitle"); // new

// ─── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let studentData = null; // students/{uid} doc
let classTeacherId = null; // users/{uid}/class — used for current book lookup
let selectedTeacherId = null; // library currently being browsed
let selectedTeacherName = "";
let allBooks = []; // books loaded for selectedTeacherId
// bookCache: bookId → { title, author, isbn, coverUrl, teacherId }
// allows wishlist to show titles without extra queries
const bookCache = new Map();

// ─── Logout ───────────────────────────────────────────────────────────────────
logoutBtn?.addEventListener("click", () => signOut(auth));

// ─── Auth guard ───────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
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

  const userData = userSnap.data();
  currentUser = user;
  classTeacherId = userData.class ?? null;

  // Load students/{uid} — schema: { name, email, currentBook, wishlist, banned }
  const studentSnap = await getDoc(doc(db, "students", user.uid));
  if (!studentSnap.exists()) {
    setStatus(
      currentBookEl,
      "Student record not found. Contact your teacher.",
      "error",
    );
    return;
  }
  studentData = studentSnap.data();

  renderProfile(userData);
  await renderCurrentBook();
  renderWishlist();
  await loadTeachers();

  // Auto-select the student's assigned class teacher
  if (classTeacherId) {
    const tSnap = await getDoc(doc(db, "teachers", classTeacherId));
    const tName = tSnap.exists() ? tSnap.data().name : "My Teacher";
    await setSelectedTeacher(classTeacherId, tName);
  }
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function setStatus(container, msg, type = "info") {
  if (!container) return;
  container.innerHTML = `<p class="text-muted">${escHtml(msg)}</p>`;
}

// Minimal HTML escaping to prevent XSS from API / Firestore data in innerHTML
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Profile ──────────────────────────────────────────────────────────────────
function renderProfile(userData) {
  if (!profileEl) return;
  profileEl.innerHTML = `
    <div class="panel-title">My Profile</div>
    <div class="panel-body">
      <strong>${escHtml(studentData.name)}</strong>
      <p class="text-muted">${escHtml(userData.email)}</p>
      <div class="chip-row">
        <span class="chip">Student</span>
        ${
          classTeacherId
            ? `<span class="chip">Class Assigned</span>`
            : `<span class="chip">No Class Assigned</span>`
        }
        ${
          studentData.banned
            ? `<span class="badge"><span class="badge-dot"></span>Account Suspended</span>`
            : ""
        }
      </div>
    </div>`;
}

// ─── Teacher list ─────────────────────────────────────────────────────────────
// teachers collection: allow read: if true ✓ (public read)
async function loadTeachers() {
  if (!teacherListEl) return;
  setStatus(teacherListEl, "Loading teachers…");

  const snap = await getDocs(collection(db, "teachers"));

  if (snap.empty) {
    setStatus(teacherListEl, "No teachers found.");
    return;
  }

  teacherListEl.innerHTML = "";

  snap.forEach((d) => {
    const t = d.data();
    const btn = document.createElement("button");
    btn.className = "btn-role";
    btn.dataset.tid = d.id;
    btn.dataset.name = t.name;
    btn.innerHTML = `
      <div class="btn-role-label">Teacher</div>
      <div class="btn-role-title">${escHtml(t.name)}</div>
      <div class="btn-role-desc">${escHtml(t.email)}</div>`;
    btn.addEventListener("click", () => setSelectedTeacher(d.id, t.name));
    teacherListEl.appendChild(btn);
  });
}

// ─── Select teacher + load their library ──────────────────────────────────────
async function setSelectedTeacher(tid, name) {
  selectedTeacherId = tid;
  selectedTeacherName = name;

  // Highlight selected teacher button
  document.querySelectorAll("#teacherList .btn-role").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.tid === tid);
  });

  if (bookListTitleEl) bookListTitleEl.textContent = `${name}'s Library`;
  await loadTeacherBooks(tid);
}

// ─── Load all books for a teacher ─────────────────────────────────────────────
// teachers/{teacherId}/books: allow read: if true ✓ (public read)
// Loads ALL statuses so student can see what's available vs checked out
async function loadTeacherBooks(tid) {
  if (!bookListEl) return;
  setStatus(bookListEl, "Loading books…");

  const snap = await getDocs(collection(db, "teachers", tid, "books"));

  if (snap.empty) {
    setStatus(bookListEl, "No books in this library yet.");
    allBooks = [];
    return;
  }

  allBooks = snap.docs.map((d) => {
    const data = { id: d.id, teacherId: tid, ...d.data() };
    // Cache book metadata for wishlist title resolution
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
  // Re-render wishlist now that cache may have resolved previously unknown IDs
  renderWishlist();
}

// ─── Search ───────────────────────────────────────────────────────────────────
searchInputEl?.addEventListener("input", () => filterAndRenderBooks());

function filterAndRenderBooks() {
  const term = (searchInputEl?.value ?? "").trim().toLowerCase();
  const filtered = term
    ? allBooks.filter(
        (b) =>
          b.title?.toLowerCase().includes(term) ||
          b.author?.toLowerCase().includes(term) ||
          b.isbn?.toLowerCase().includes(term),
      )
    : allBooks;

  renderBooks(filtered);
}

// ─── Render book grid ──────────────────────────────────────────────────────────
function renderBooks(books) {
  if (!bookListEl) return;

  if (books.length === 0) {
    setStatus(bookListEl, "No books match your search.");
    return;
  }

  const hasCurrentBook = !!studentData?.currentBook;
  const wishlist = studentData?.wishlist ?? [];
  bookListEl.innerHTML = "";

  books.forEach((book) => {
    const isCurrentBook = book.id === studentData?.currentBook;
    const isAvailable = book.status === "available";
    const isWishlisted = wishlist.includes(book.id);
    const canCheckout = isAvailable && !hasCurrentBook && !isCurrentBook;

    // Status badge — "currently reading" when this is the student's active book
    const statusBadge = isCurrentBook
      ? `<span class="badge"><span class="badge-dot"></span>Currently Reading</span>`
      : isAvailable
      ? `<span class="chip">Available</span>`
      : `<span class="chip">Checked Out</span>`;

    // Checkout / return button
    let actionBtn = "";
    if (isCurrentBook) {
      actionBtn = `<button class="btn-ghost" data-action="return" data-book-id="${escHtml(
        book.id,
      )}">Return Book</button>`;
    } else if (canCheckout) {
      actionBtn = `<button class="btn-primary" data-action="checkout" data-book-id="${escHtml(
        book.id,
      )}" data-book-title="${escHtml(book.title)}">Check Out</button>`;
    } else if (isAvailable && hasCurrentBook) {
      actionBtn = `<button class="btn-primary" disabled title="Return your current book first">Check Out</button>`;
    }
    // checked_out by someone else: no action button

    // Wishlist button — not shown for the student's current book
    const wishlistBtn = !isCurrentBook
      ? `<button class="btn-ghost" data-action="${
          isWishlisted ? "unwishlist" : "wishlist"
        }" data-book-id="${escHtml(book.id)}">
           ${isWishlisted ? "♥ Wishlisted" : "♡ Wishlist"}
         </button>`
      : "";

    const coverHtml = book.coverUrl
      ? `<img src="${escHtml(
          book.coverUrl,
        )}" alt="Cover" class="book-cover-thumb" />`
      : "";

    const descHtml = book.description
      ? `<p class="text-muted book-desc">${escHtml(book.description)}</p>`
      : "";

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      ${coverHtml}
      <div class="panel-title">${escHtml(book.title)}</div>
      <div class="panel-body">
        <p class="text-muted">${escHtml(book.author)}</p>
        <div class="chip-row">
          <span class="chip">ISBN ${escHtml(book.isbn)}</span>
          ${statusBadge}
        </div>
        ${descHtml}
        <div class="chip-row">
          ${actionBtn}
          ${wishlistBtn}
        </div>
      </div>`;

    panel
      .querySelector("[data-action='checkout']")
      ?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        requestCheckout(btn.dataset.bookId, btn.dataset.bookTitle);
      });

    panel
      .querySelector("[data-action='return']")
      ?.addEventListener("click", (e) => {
        initiateReturn(e.currentTarget.dataset.bookId);
      });

    panel
      .querySelector("[data-action='wishlist']")
      ?.addEventListener("click", (e) => {
        addToWishlist(e.currentTarget.dataset.bookId);
      });

    panel
      .querySelector("[data-action='unwishlist']")
      ?.addEventListener("click", (e) => {
        removeFromWishlist(e.currentTarget.dataset.bookId);
      });

    bookListEl.appendChild(panel);
  });
}

// ─── Currently reading / checkout display ─────────────────────────────────────
async function renderCurrentBook() {
  if (!currentBookEl) return;

  const bookId = studentData.currentBook;
  if (!bookId) {
    currentBookEl.innerHTML = `
      <div class="panel-title">Currently Reading</div>
      <div class="panel-body">
        <p class="text-muted">No book checked out. Browse a library to find one.</p>
      </div>`;
    return;
  }

  // Try cache first, then fetch from class teacher's library
  let book = bookCache.get(bookId);
  if (!book && classTeacherId) {
    currentBookEl.innerHTML = `
      <div class="panel-title">Currently Reading</div>
      <div class="panel-body"><p class="text-muted">Loading…</p></div>`;
    const snap = await getDoc(
      doc(db, "teachers", classTeacherId, "books", bookId),
    );
    if (snap.exists()) {
      book = snap.data();
      bookCache.set(bookId, { ...book, teacherId: classTeacherId });
    }
  }

  // "Pending" = student requested but teacher hasn't confirmed yet
  // (book still shows as "available" in the teacher's collection)
  const isPending = book?.status === "available";

  const coverHtml = book?.coverUrl
    ? `<img src="${escHtml(
        book.coverUrl,
      )}" alt="Cover" class="book-cover-current" />`
    : "";

  currentBookEl.innerHTML = `
    <div class="panel-title">Currently Reading</div>
    <div class="panel-body">
      ${coverHtml}
      <strong>${escHtml(book?.title ?? bookId)}</strong>
      <p class="text-muted">${escHtml(book?.author ?? "")}</p>
      <div class="chip-row">
        ${
          isPending
            ? `<span class="badge"><span class="badge-dot"></span>Pending Confirmation</span>`
            : `<span class="badge"><span class="badge-dot"></span>Checked Out</span>`
        }
      </div>
      <div class="chip-row">
        <button class="btn-ghost" id="returnBtn">I've Returned This Book</button>
      </div>
    </div>`;

  document
    .getElementById("returnBtn")
    ?.addEventListener("click", () => initiateReturn(bookId));
}

// ─── Checkout request (student side) ─────────────────────────────────────────
// Security: students/{uid} allow write if auth.uid == uid ✓
// Book status stays "available" until teacher confirms in teacher.js confirmCheckout()
async function requestCheckout(bookId, bookTitle) {
  if (!currentUser) return;
  if (!selectedTeacherId) {
    alert("Please select a teacher's library to browse first.");
    return;
  }

  // Re-fetch student doc — guard against race condition
  const freshSnap = await getDoc(doc(db, "students", currentUser.uid));
  if (freshSnap.data().currentBook !== null) {
    alert(
      "You already have a book checked out. Return it before checking out another.",
    );
    return;
  }

  // Re-fetch book — guard against race condition
  const bookSnap = await getDoc(
    doc(db, "teachers", selectedTeacherId, "books", bookId),
  );
  if (!bookSnap.exists() || bookSnap.data().status !== "available") {
    alert("This book is no longer available.");
    await loadTeacherBooks(selectedTeacherId);
    return;
  }

  // Only field written: currentBook on student's own doc ✓
  await updateDoc(doc(db, "students", currentUser.uid), {
    currentBook: bookId,
  });

  studentData.currentBook = bookId;

  await renderCurrentBook();
  filterAndRenderBooks();
}

// ─── Return initiation (student side) ─────────────────────────────────────────
// Security: students/{uid} allow write if auth.uid == uid ✓
// Teacher finalizes in teacher.js validateReturn()
async function initiateReturn(bookId) {
  if (!currentUser) return;

  const confirmed = confirm(
    "This records that you've physically handed back the book. Your teacher will finalize it in their dashboard.",
  );
  if (!confirmed) return;

  await updateDoc(doc(db, "students", currentUser.uid), {
    currentBook: null,
  });

  studentData.currentBook = null;

  await renderCurrentBook();
  filterAndRenderBooks();
}

// ─── Wishlist ─────────────────────────────────────────────────────────────────
// Security: students/{uid} allow write if auth.uid == uid ✓
// Note: teachers/{teacherId}/books/{bookId}/wishlist (array<studentId>) cannot
// be updated by students — that write requires auth.uid == teacherId.
// Only students/{uid}/wishlist (array<bookId>) is updated here.
async function addToWishlist(bookId) {
  if (!currentUser) return;

  await updateDoc(doc(db, "students", currentUser.uid), {
    wishlist: arrayUnion(bookId),
  });

  if (!studentData.wishlist) studentData.wishlist = [];
  if (!studentData.wishlist.includes(bookId)) studentData.wishlist.push(bookId);

  renderWishlist();
  filterAndRenderBooks(); // refresh wishlist button states
}

async function removeFromWishlist(bookId) {
  if (!currentUser) return;

  await updateDoc(doc(db, "students", currentUser.uid), {
    wishlist: arrayRemove(bookId),
  });

  studentData.wishlist = (studentData.wishlist ?? []).filter(
    (id) => id !== bookId,
  );

  renderWishlist();
  filterAndRenderBooks();
}

function renderWishlist() {
  if (!wishlistEl) return;

  const wishlist = studentData?.wishlist ?? [];
  if (wishlist.length === 0) {
    setStatus(
      wishlistEl,
      "Your wishlist is empty. Browse a library to add books.",
    );
    return;
  }

  wishlistEl.innerHTML = "";

  wishlist.forEach((bookId) => {
    // Resolve title from cache — populated when any teacher's library is loaded
    const cached = bookCache.get(bookId);
    const title = cached?.title ?? `Book ID: ${bookId.slice(0, 8)}…`;
    const author = cached?.author ?? "";

    const item = document.createElement("div");
    item.className = "panel";
    item.innerHTML = `
      <div class="panel-title">${escHtml(title)}</div>
      <div class="panel-body">
        <p class="text-muted">${escHtml(author)}</p>
        <button class="btn-ghost" data-remove="${escHtml(bookId)}">
          Remove
        </button>
      </div>`;

    item
      .querySelector("[data-remove]")
      ?.addEventListener("click", (e) =>
        removeFromWishlist(e.currentTarget.dataset.remove),
      );

    wishlistEl.appendChild(item);
  });
}
