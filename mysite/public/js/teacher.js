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
  addDoc,
  collection,
  query,
  where,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { lookupISBN } from "./books.js";

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const logoutBtn = document.getElementById("logoutTeacher");
const lookupBtn = document.getElementById("lookupIsbn");
const isbnInput = document.getElementById("isbnInput");
const isbnResult = document.getElementById("isbnResult");
const inviteBtn = document.getElementById("createInvite");
const inviteOutput = document.getElementById("inviteOutput");
const libraryEl = document.getElementById("libraryList");
const historyEl = document.getElementById("historyList");

// ─── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;

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
  if (!userSnap.exists() || userSnap.data().role !== "teacher") {
    await signOut(auth);
    window.location.href = "/";
    return;
  }

  currentUser = user;
  await loadLibrary();
  await loadCheckoutHistory();
});

// ─── ISBN lookup → autofill form ──────────────────────────────────────────────
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

  // Render editable autofill form — teacher can correct fields before saving
  isbnResult.innerHTML = `
    <div class="panel">
      <div class="panel-title">Book Details — Edit Before Saving</div>
      <div class="panel-body">
        ${
          data.cover
            ? `<img id="bookCoverPreview" src="${data.cover}" alt="Cover" class="book-cover-preview"/>`
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
          <span class="chip">ISBN ${isbn}</span>
        </div>
        <br/>
        <button class="btn-primary" id="addToLibraryBtn">Add to Library</button>
        <span class="text-muted" id="addBookStatus"></span>
      </div>
    </div>`;

  // Populate fields after rendering (avoids XSS via innerHTML attribute injection)
  document.getElementById("bookTitleInput").value = data.title;
  document.getElementById("bookAuthorInput").value = data.author;
  document.getElementById("bookDescInput").value = data.description;

  // "Add to Library" — reads current input values so teacher edits are respected
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

      await addBook(isbn, title, author, data.cover ?? "", description);

      // Clear the lookup form and result on success
      isbnInput.value = "";
      isbnResult.innerHTML = `<p class="text-muted">✓ "${title}" added to your library.</p>`;

      await loadLibrary();
    });
});

// ─── Invite generator — fixed to match schema exactly ─────────────────────────
// Schema: invites/{token} { createdBy, createdAt, expiresAt, used }
// No email field. expiresAt is a required Timestamp, not null.
inviteBtn?.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;

  // Respect canInvite permission from teachers/{uid}
  const teacherSnap = await getDoc(doc(db, "teachers", user.uid));
  if (!teacherSnap.exists() || !teacherSnap.data().canInvite) {
    inviteOutput.innerHTML = `<p class="text-muted">You do not have permission to create invites.</p>`;
    return;
  }

  inviteOutput.textContent = "Creating invite…";

  const token = crypto.randomUUID();
  const expiresAt = Timestamp.fromDate(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  );

  await setDoc(doc(db, "invites", token), {
    createdBy: user.uid,
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

// ─── Load teacher library ─────────────────────────────────────────────────────
async function loadLibrary() {
  if (!libraryEl) return;

  libraryEl.innerHTML = `<p class="text-muted">Loading library…</p>`;

  const booksSnap = await getDocs(
    collection(db, "teachers", currentUser.uid, "books"),
  );

  if (booksSnap.empty) {
    libraryEl.innerHTML = `<p class="text-muted">No books in your library yet.</p>`;
    return;
  }

  // Collect available book IDs to check for pending student requests
  const availableBookIds = [];
  booksSnap.forEach((d) => {
    if (d.data().status === "available") availableBookIds.push(d.id);
  });

  // Query students who have a currentBook that is one of our available books
  // (these are pending checkout requests)
  // Security: students allow read if request.auth != null ✓
  const pendingMap = {}; // bookId -> { studentId, studentName }
  if (availableBookIds.length > 0) {
    // Firestore 'in' supports up to 30 values — fine for a classroom library
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

  libraryEl.innerHTML = "";

  booksSnap.forEach((docSnap) => {
    const book = docSnap.data();
    const bookId = docSnap.id;
    const pending = pendingMap[bookId];

    const panel = document.createElement("div");
    panel.className = "panel";

    let actionHtml = "";

    if (book.status === "checked_out") {
      // Validate return — teacher side
      actionHtml = `
        <span class="badge"><span class="badge-dot"></span>Checked Out — ${
          book.checkedOutBy ?? "unknown"
        }</span>
        <br/><br/>
        <button class="btn-primary"
          data-action="return"
          data-book-id="${bookId}"
          data-book-title="${book.title}"
        >Validate Return</button>
        <p class="text-muted">After the student hands back the physical book.</p>`;
    } else if (pending) {
      // Pending checkout request from a student
      actionHtml = `
        <span class="badge"><span class="badge-dot"></span>Pending — ${pending.studentName}</span>
        <br/><br/>
        <button class="btn-primary"
          data-action="confirm"
          data-book-id="${bookId}"
          data-book-title="${book.title}"
          data-student-id="${pending.studentId}"
          data-student-name="${pending.studentName}"
        >Confirm Checkout</button>`;
    } else {
      // Available, no requests
      actionHtml = `<span class="chip">Available</span>`;
    }

    panel.innerHTML = `
      <div class="panel-title">${book.title}</div>
      <div class="panel-body">
        <p class="text-muted">${book.author}</p>
        <div class="chip-row">
          <span class="chip">ISBN ${book.isbn}</span>
        </div>
        <br/>
        ${actionHtml}
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

    libraryEl.appendChild(panel);
  });
}

// ─── Confirm checkout (teacher side) ─────────────────────────────────────────
// Updates book status and creates history entry.
// Security: teachers/{uid}/books allow write if auth.uid == teacherId ✓
//           teachers/{uid}/history allow write if auth.uid == teacherId ✓
// Note: student's currentBook was already set by the student — no write needed here.
async function confirmCheckout(bookId, bookTitle, studentId, studentName) {
  // Update book — schema fields: status, checkedOutBy, checkedOutAt
  await updateDoc(doc(db, "teachers", currentUser.uid, "books", bookId), {
    status: "checked_out",
    checkedOutBy: studentId,
    checkedOutAt: serverTimestamp(),
  });

  // Create history entry — schema fields: bookId, bookTitle, studentId, studentName, dateOut, dateReturned
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

// ─── Validate return (teacher side) ───────────────────────────────────────────
// Updates book status and closes the history entry.
// Security: teachers/{uid}/books allow write if auth.uid == teacherId ✓
//           teachers/{uid}/history allow write if auth.uid == teacherId ✓
// Note: Cannot clear students/{studentId}/currentBook — student must do that
//       themselves via the "I've Returned This Book" button in student.html.
async function validateReturn(bookId, bookTitle) {
  // Get book to find checkedOutBy before clearing it
  const bookRef = doc(db, "teachers", currentUser.uid, "books", bookId);
  const bookSnap = await getDoc(bookRef);
  if (!bookSnap.exists()) return;

  const { checkedOutBy } = bookSnap.data();

  // Update book — restore to available, clear checkout fields
  await updateDoc(bookRef, {
    status: "available",
    checkedOutBy: null,
    checkedOutAt: null,
  });

  // Find the open history entry for this book + student and close it
  // Query: teachers/{uid}/history where bookId == X and dateReturned == null
  // Requires a Firestore composite index on (bookId ASC, dateReturned ASC) — create in Firebase console
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

// ─── Checkout history display ─────────────────────────────────────────────────
async function loadCheckoutHistory() {
  if (!historyEl) return;

  const histSnap = await getDocs(
    collection(db, "teachers", currentUser.uid, "history"),
  );

  if (histSnap.empty) {
    historyEl.innerHTML = `<p class="text-muted">No checkout history yet.</p>`;
    return;
  }

  historyEl.innerHTML = "";

  // Sort by dateOut descending (most recent first)
  const entries = histSnap.docs
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
      <div class="panel-title">${entry.bookTitle}</div>
      <div class="panel-body">
        <ul class="meta-list">
          <li>Student: <strong>${entry.studentName}</strong></li>
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

// ─── Add book to teacher's library ────────────────────────────────────────────
// Writes exactly the fields defined in teachers/{teacherId}/books/{bookId} schema.
// Uses addDoc (auto-generated ID) — ISBN is stored as a field, not the doc ID,
// so a teacher can hold multiple copies of the same book.
// Security: teachers/{uid}/books allow write if auth.uid == teacherId ✓
async function addBook(isbn, title, author, coverUrl, description) {
  await addDoc(collection(db, "teachers", currentUser.uid, "books"), {
    title,
    author,
    isbn,
    coverUrl,
    description,
    status: "available",
    checkedOutBy: null,
    checkedOutAt: null,
    wishlist: [],
  });
}
