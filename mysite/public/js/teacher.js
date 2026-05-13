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

import { lookupISBN } from "./books.js";

// ─── Page Routing ──────────────────────────────────────────────────────────────
function setupPageRouting() {
  document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const page = e.currentTarget.dataset.page;
      showPage(page);
    });
  });
}

function showPage(pageName) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-item")
    .forEach((n) => n.classList.remove("active"));

  const pageEl = document.getElementById(pageName + "Page");
  if (pageEl) {
    pageEl.classList.add("active");
  }

  document.querySelector(`[data-page="${pageName}"]`)?.classList.add("active");
}

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const logoutBtn = document.getElementById("logoutTeacherBtn");
const logoutSettingsBtn = document.getElementById("logoutSettingsBtn");
const lookupBtn = document.getElementById("lookupIsbn");
const isbnInput = document.getElementById("isbnInput");
const isbnResult = document.getElementById("isbnResult");
const libraryEl = document.getElementById("libraryList");
const historyEl = document.getElementById("historyList");
const exportHistoryBtn = document.getElementById("exportHistoryBtn");
const createInviteBtn = document.getElementById("createInviteBtn");
const inviteOutput = document.getElementById("inviteOutput");
const settingsEl = document.getElementById("settingsPanel");
const canInviteStatus = document.getElementById("canInviteStatus");

// ─── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let teacherData = null;
let allBooks = [];

// ─── Logout ───────────────────────────────────────────────────────────────────
logoutBtn?.addEventListener("click", () => signOut(auth));
logoutSettingsBtn?.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (!user) window.location.href = "/";
});

// ─── Auth + Initialization ──────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "/";
    return;
  }

  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists() || userSnap.data().role !== "teacher") {
    await signOut(auth);
    window.location.href = "/";
    return;
  }

  currentUser = user;

  const teacherRef = doc(db, "teachers", user.uid);
  const teacherSnap = await getDoc(teacherRef);
  if (!teacherSnap.exists()) {
    settingsEl.innerHTML = `<div class="panel-body"><p class="text-muted">Teacher record not found.</p></div>`;
    return;
  }

  teacherData = teacherSnap.data();

  setupPageRouting();
  renderSettings();
  await loadLibrary();
  await loadCheckoutHistory();
});

// ─── Utilities ──────────────────────────────────────────────────────────────────
function setStatus(container, msg, type = "info") {
  if (!container) return;
  container.innerHTML = `<p class="text-muted">${escHtml(msg)}</p>`;
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Settings ───────────────────────────────────────────────────────────────────
function renderSettings() {
  if (!settingsEl || !teacherData) return;

  settingsEl.innerHTML = `
    <div class="panel-title">Account Information</div>
    <div class="panel-body">
      <strong>${escHtml(teacherData.name)}</strong>
      <p class="text-muted">${escHtml(currentUser?.email ?? "")}</p>
    </div>`;

  if (canInviteStatus) {
    canInviteStatus.textContent = teacherData.canInvite ? "✓ Yes" : "✗ No";
  }
}

// ─── ISBN Lookup + Add Book ─────────────────────────────────────────────────────
lookupBtn?.addEventListener("click", async () => {
  const isbn = isbnInput.value.trim();
  if (!isbn) return;

  isbnResult.innerHTML = `<p class="text-muted">Looking up…</p>`;
  lookupBtn.disabled = true;

  const data = await lookupISBN(isbn);
  lookupBtn.disabled = false;

  if (!data) {
    isbnResult.innerHTML = `<p class="text-muted">No book found for that ISBN.</p>`;
    return;
  }

  isbnResult.innerHTML = `
    <div class="panel">
      <div class="panel-title">Book Details — Edit Before Saving</div>
      <div class="panel-body">
        ${
          data.cover
            ? `<img src="${escHtml(
                data.cover,
              )}" alt="Cover" class="book-cover-thumb"/>`
            : `<p class="text-muted">No cover image found.</p>`
        }
        <div class="input-row">
          <label for="bookTitleInput">Title</label>
          <input id="bookTitleInput" type="text" />
        </div>
        <div class="input-row">
          <label for="bookAuthorInput">Author</label>
          <input id="bookAuthorInput" type="text" />
        </div>
        <div class="input-row">
          <label for="bookDescInput">Description</label>
          <input id="bookDescInput" type="text" />
        </div>
        <div class="chip-row">
          <span class="chip">ISBN ${escHtml(isbn)}</span>
        </div>
        <br/>
        <button class="btn-primary" id="addToLibraryBtn">Add to Library</button>
        <span class="text-muted" id="addBookStatus"></span>
      </div>
    </div>`;

  document.getElementById("bookTitleInput").value = data.title;
  document.getElementById("bookAuthorInput").value = data.author;
  document.getElementById("bookDescInput").value = data.description;

  document
    .getElementById("addToLibraryBtn")
    .addEventListener("click", async () => {
      const title = document.getElementById("bookTitleInput").value.trim();
      const author = document.getElementById("bookAuthorInput").value.trim();
      const description = document.getElementById("bookDescInput").value.trim();
      const statusEl = document.getElementById("addBookStatus");

      if (!title) {
        statusEl.textContent = "Title is required.";
        return;
      }

      document.getElementById("addToLibraryBtn").disabled = true;
      statusEl.textContent = "Saving…";

      await addDoc(collection(db, "teachers", currentUser.uid, "books"), {
        title,
        author,
        isbn,
        coverUrl: data.cover ?? "",
        description,
        status: "available",
        checkedOutBy: null,
        checkedOutAt: null,
        wishlist: [],
      });

      isbnInput.value = "";
      isbnResult.innerHTML = `<p class="text-muted">✓ "${title}" added to your library.</p>`;

      await loadLibrary();
    });
});

// ─── Load library ───────────────────────────────────────────────────────────────
async function loadLibrary() {
  if (!libraryEl) return;

  libraryEl.innerHTML = `<p class="text-muted">Loading library…</p>`;

  const snap = await getDocs(
    collection(db, "teachers", currentUser.uid, "books"),
  );

  if (snap.empty) {
    libraryEl.innerHTML = `<p class="text-muted">No books yet. Add one above!</p>`;
    allBooks = [];
    return;
  }

  allBooks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  libraryEl.innerHTML = "";

  // Get pending student checkouts
  const availableBookIds = allBooks
    .filter((b) => b.status === "available")
    .map((b) => b.id);
  const pendingMap = {};

  if (availableBookIds.length > 0) {
    const chunk = availableBookIds.slice(0, 30);
    const studentsSnap = await getDocs(
      query(collection(db, "students"), where("currentBook", "in", chunk)),
    );
    studentsSnap.forEach((d) => {
      pendingMap[d.data().currentBook] = {
        studentId: d.id,
        studentName: d.data().name,
      };
    });
  }

  allBooks.forEach((book) => {
    const pending = pendingMap[book.id];

    let actionHtml = "";
    if (book.status === "checked_out") {
      actionHtml = `
        <span class="badge"><span class="badge-dot"></span>Checked Out by Student</span>
        <div class="action-buttons">
          <button class="btn-primary" data-action="return" data-book-id="${escHtml(
            book.id,
          )}" data-book-title="${escHtml(book.title)}">Mark Returned</button>
        </div>`;
    } else if (pending) {
      actionHtml = `
        <span class="badge"><span class="badge-dot"></span>Pending — ${escHtml(
          pending.studentName,
        )}</span>
        <div class="action-buttons">
          <button class="btn-primary" data-action="confirm" data-book-id="${escHtml(
            book.id,
          )}" data-book-title="${escHtml(
        book.title,
      )}" data-student-id="${escHtml(
        pending.studentId,
      )}" data-student-name="${escHtml(
        pending.studentName,
      )}">Confirm Checkout</button>
        </div>`;
    } else {
      actionHtml = `<span class="chip">Available</span>`;
    }

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="panel-title">${escHtml(book.title)}</div>
      <div class="panel-body">
        <p class="text-muted">${escHtml(book.author)}</p>
        <div class="chip-row">
          <span class="chip">ISBN ${escHtml(book.isbn)}</span>
          ${actionHtml}
        </div>
        <div class="action-buttons">
          <button class="btn-ghost" data-action="delete" data-book-id="${escHtml(
            book.id,
          )}" data-book-title="${escHtml(book.title)}">Delete Book</button>
        </div>
      </div>`;

    panel
      .querySelector("[data-action='confirm']")
      ?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        confirmCheckout(
          btn.dataset.bookId,
          btn.dataset.bookTitle,
          btn.dataset.studentId,
          btn.dataset.studentName,
        );
      });

    panel
      .querySelector("[data-action='return']")
      ?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        validateReturn(btn.dataset.bookId, btn.dataset.bookTitle);
      });

    panel
      .querySelector("[data-action='delete']")
      ?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        deleteBook(btn.dataset.bookId, btn.dataset.bookTitle);
      });

    libraryEl.appendChild(panel);
  });
}

// ─── Confirm checkout ───────────────────────────────────────────────────────────
async function confirmCheckout(bookId, bookTitle, studentId, studentName) {
  await updateDoc(doc(db, "teachers", currentUser.uid, "books", bookId), {
    status: "checked_out",
    checkedOutBy: studentId,
    checkedOutAt: serverTimestamp(),
  });

  await addDoc(collection(db, "teachers", currentUser.uid, "history"), {
    bookId,
    bookTitle,
    studentId,
    studentName,
    dateOut: serverTimestamp(),
    dateReturned: null,
  });

  await loadLibrary();
  await loadCheckoutHistory();
}

// ─── Validate return ────────────────────────────────────────────────────────────
async function validateReturn(bookId, bookTitle) {
  const bookRef = doc(db, "teachers", currentUser.uid, "books", bookId);
  const bookSnap = await getDoc(bookRef);
  if (!bookSnap.exists()) return;

  const { checkedOutBy } = bookSnap.data();

  await updateDoc(bookRef, {
    status: "available",
    checkedOutBy: null,
    checkedOutAt: null,
  });

  const historyRef = collection(db, "teachers", currentUser.uid, "history");
  const q = query(
    historyRef,
    where("bookId", "==", bookId),
    where("dateReturned", "==", null),
  );
  const histSnap = await getDocs(q);

  if (!histSnap.empty) {
    await updateDoc(histSnap.docs[0].ref, {
      dateReturned: serverTimestamp(),
    });
  }

  await loadLibrary();
  await loadCheckoutHistory();
}

// ─── Delete book ────────────────────────────────────────────────────────────────
async function deleteBook(bookId, bookTitle) {
  const confirmed = confirm(
    `Delete "${bookTitle}" from your library? This cannot be undone.`,
  );
  if (!confirmed) return;

  await deleteDoc(doc(db, "teachers", currentUser.uid, "books", bookId));

  await loadLibrary();
}

// ─── Load checkout history ──────────────────────────────────────────────────────
async function loadCheckoutHistory() {
  if (!historyEl) return;

  const snap = await getDocs(
    collection(db, "teachers", currentUser.uid, "history"),
  );

  if (snap.empty) {
    historyEl.innerHTML = `<p class="text-muted">No checkout history yet.</p>`;
    return;
  }

  historyEl.innerHTML = "";

  const entries = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));

  entries.forEach((entry) => {
    const dateOut = entry.dateOut
      ? new Date(entry.dateOut.seconds * 1000).toLocaleDateString()
      : "—";
    const dateReturned = entry.dateReturned
      ? new Date(entry.dateReturned.seconds * 1000).toLocaleDateString()
      : null;

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="panel-title">${escHtml(entry.bookTitle)}</div>
      <div class="panel-body">
        <ul class="meta-list">
          <li>Student: <strong>${escHtml(entry.studentName)}</strong></li>
          <li>Checked out: <strong>${dateOut}</strong></li>
          <li>Returned: <strong>${
            dateReturned ?? "Not yet returned"
          }</strong></li>
        </ul>
        ${
          !dateReturned
            ? `<span class="badge"><span class="badge-dot"></span>Active</span>`
            : ""
        }
      </div>`;

    historyEl.appendChild(panel);
  });
}

// ─── Export history as markdown ──────────────────────────────────────────────────
exportHistoryBtn?.addEventListener("click", async () => {
  const snap = await getDocs(
    collection(db, "teachers", currentUser.uid, "history"),
  );

  if (snap.empty) {
    alert("No history to export.");
    return;
  }

  const entries = snap.docs
    .map((d) => ({ ...d.data() }))
    .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));

  const date = new Date().toLocaleDateString();
  let md = `# Checkout History\n\n`;
  md += `**Teacher:** ${escHtml(teacherData.name)}\n\n`;
  md += `**Exported:** ${date}\n\n`;
  md += `| Book | Author | Student | Date Out | Date Returned |\n`;
  md += `|------|--------|---------|----------|---------------|\n`;

  entries.forEach((entry) => {
    const dateOut = entry.dateOut
      ? new Date(entry.dateOut.seconds * 1000).toLocaleDateString()
      : "—";
    const dateReturned = entry.dateReturned
      ? new Date(entry.dateReturned.seconds * 1000).toLocaleDateString()
      : "(Not returned)";

    md += `| ${escHtml(entry.bookTitle)} | ${escHtml(
      entry.bookTitle || entry.bookTitle,
    )} | ${escHtml(entry.studentName)} | ${dateOut} | ${dateReturned} |\n`;
  });

  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${teacherData.name.replace(
    /\\s+/g,
    "_",
  )}_history_${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Invite teachers ────────────────────────────────────────────────────────────
createInviteBtn?.addEventListener("click", async () => {
  if (!teacherData.canInvite) {
    inviteOutput.innerHTML = `<div class="panel"><div class="panel-body"><p class="text-muted">You do not have permission to create invites.</p></div></div>`;
    return;
  }

  inviteOutput.textContent = "Creating invite…";

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

  inviteOutput.innerHTML = `
    <div class="panel">
      <div class="panel-title">Invite Link</div>
      <div class="panel-body">
        <input value="${url}" readonly/>
        <p class="text-muted">Expires in 7 days. Send to the new teacher.</p>
      </div>
    </div>`;
});
