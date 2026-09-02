// teacher-api.js — the entire Firestore data layer for the teacher portal.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Everything the teacher portal reads or writes goes through here. teacher.js
// is the UI; it must not import firebase-firestore directly. That split is the
// point: before it existed, data access was scattered through 2,500 lines of
// render code, so every bug looked like a UI bug and every fix was a guess.
//
// Three rules for this module:
//   1. No DOM. Not one getElementById. This file must be readable without the
//      portal open, and reusable from any other page.
//   2. Every failure is a TeacherApiError with a `code` and a plain-English
//      `hint`. A raw Firestore code ("failed-precondition") tells a teacher
//      nothing and told us nothing either — that specific one means a missing
//      composite index, and it cost hours to learn that the hard way.
//   3. Anything that changes two documents at once uses a transaction or a
//      batch. Never Promise.all over independent writes: a partial failure
//      there leaves a book checked out to a student the records don't know
//      about, and the UI reports the whole thing as failed.
//
// See ../TEACHER_BACKEND.md for the data model and the invariants it holds.

import { db } from './firebase.js';
// Retention owns the school-year date semantics for the whole app (rules,
// student portal and admin portal all agree with it). Re-export rather than
// re-implement: two copies of "when does a school year end" is how a class
// expires a day early in one place and not another.
import { endOfSchoolDay, isClassExpired, runRetentionSweep } from './retention.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, limit as qLimit, onSnapshot, runTransaction,
  writeBatch, serverTimestamp, Timestamp, arrayRemove, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

export class TeacherApiError extends Error {
  constructor(message, { code = 'bw/unknown', cause = null, hint = '' } = {}) {
    super(message);
    this.name  = 'TeacherApiError';
    this.code  = code;
    this.cause = cause;
    this.hint  = hint;
  }
  /** One line fit to put in a toast. */
  toString() { return this.hint ? `${this.message} — ${this.hint}` : this.message; }
}

// Firestore's error codes are accurate and completely unhelpful to a teacher
// staring at a blank panel. Each one below has exactly one realistic cause in
// this app; say that cause out loud instead of the code.
const HINTS = {
  'permission-denied':
    'the security rules rejected it. If this started after a code change, the rules in firestore.rules may not be deployed — run: firebase deploy --only firestore:rules',
  'failed-precondition':
    'a Firestore composite index is missing. Deploy them with: firebase deploy --only firestore:indexes',
  'unavailable':
    'could not reach Firestore. Check the network and try again.',
  'not-found':
    'that record no longer exists — it may have been deleted in another tab.',
  'unauthenticated':
    'your session expired. Sign out and back in.',
  'resource-exhausted':
    'the project hit a Firestore quota.',
  'bw/timeout':
    'the server did not respond in time.',
};

/** Wrap anything that talks to Firestore. Turns every throw into a
 *  TeacherApiError carrying a code and a hint, and logs it once with the
 *  operation name so the console says WHICH call failed. */
function wrap(label, err) {
  if (err instanceof TeacherApiError) return err;
  const code = err?.code ?? 'bw/unknown';
  const e = new TeacherApiError(`Couldn't ${label}`, {
    code,
    cause: err,
    hint: HINTS[code] ?? err?.message ?? 'unknown error',
  });
  console.error(`[teacher-api] ${label} failed:`, code, err);
  return e;
}

// ═══════════════════════════════════════════════════════════════════════════
// Deadlines and retries
// ═══════════════════════════════════════════════════════════════════════════

/** How long any single Firestore call may take before we give up on it.
 *
 *  A read that never settles is worse than one that fails: nothing throws, so
 *  nothing is caught, and the panel waiting on it shows "Loading…" forever with
 *  a clean console. Every call in this file has a deadline for that reason. */
export const DEADLINE_MS = 12000;

function withDeadline(promise, ms = DEADLINE_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('the server did not respond'), { code: 'bw/timeout' })),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Run a Firestore call with a deadline, retrying only the failures that are
 *  actually worth retrying.
 *
 *  Retrying a permission-denied is pointless — the rules will say no three
 *  times just as fast. Retrying a cold-start timeout is worth it: Firestore's
 *  FIRST read of a session is routinely slow while every read after it is
 *  instant, and that alone used to hang the whole portal. */
const RETRYABLE = new Set(['bw/timeout', 'unavailable', 'deadline-exceeded', 'internal', 'aborted']);

async function call(label, fn, { tries = 1, ms = DEADLINE_MS } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await withDeadline(fn(), ms);
    } catch (err) {
      lastErr = err;
      const code = err?.code ?? 'bw/unknown';
      if (attempt === tries || !RETRYABLE.has(code)) break;
      console.warn(`[teacher-api] ${label}: attempt ${attempt}/${tries} failed (${code}), retrying`);
    }
  }
  throw wrap(label, lastErr);
}

// ═══════════════════════════════════════════════════════════════════════════
// Session
// ═══════════════════════════════════════════════════════════════════════════

let session = null;

/** The signed-in teacher, once openTeacherSession() has resolved.
 *  `{ uid, email, role, teacher }` — `role` is 'teacher' or 'admin'. */
export function currentSession() { return session; }

function requireSession() {
  if (!session) {
    throw new TeacherApiError('Not signed in yet', {
      code: 'bw/no-session',
      hint: 'openTeacherSession() has to finish before any other call in this module',
    });
  }
  return session;
}

const T   = (...seg) => doc(db, 'teachers', requireSession().uid, ...seg);
const TC  = (...seg) => collection(db, 'teachers', requireSession().uid, ...seg);

/** Cryptographically random 6-character class code.
 *  Alphabet excludes 0/O/1/I/L so a code read aloud can't be mis-heard. */
export function generateClassCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

/** Read the school-wide operational flags every portal gates on. Never throws —
 *  a school that has never touched these settings, or a read that fails, must
 *  get the permissive default rather than a locked portal. */
export async function readAdminSettings() {
  try {
    const snap = await withDeadline(getDoc(doc(db, 'admin', 'settings')));
    return { snap, settings: snap.exists() ? snap.data() : {} };
  } catch (err) {
    console.warn('[teacher-api] admin/settings unreadable, using defaults:', err?.code ?? err);
    return { snap: null, settings: {} };
  }
}

/** Establish the teacher session for `user`.
 *
 *  Returns `{ uid, email, role, teacher, created }`, or throws:
 *    bw/not-a-teacher   — signed in, but has no teacher or admin role
 *    bw/no-teacher-doc  — has the role but no teachers/{uid} record (needs an invite)
 *
 *  An account on the admin allowlist runs this portal too, with role 'admin'.
 *  auth.js only ever writes users/{uid} for those accounts and sends them to
 *  admin.html, so they arrive here with no teachers/{uid} document at all.
 *  Bootstrapping one is the difference between the portal working and every
 *  single panel being empty with nothing in the console. */
export async function openTeacherSession(user) {
  session = null;

  const userSnap = await call('check your account', () => getDoc(doc(db, 'users', user.uid)), { tries: 3 });
  const role = userSnap.exists() ? userSnap.data().role : null;
  if (role !== 'teacher' && role !== 'admin') {
    throw new TeacherApiError('This account is not a teacher account', {
      code: 'bw/not-a-teacher',
      hint: 'ask an admin for access, or sign in with your school account',
    });
  }

  // Provisional session so the T()/TC() path helpers work for the rest of this
  // function. Replaced with the real one before returning.
  session = { uid: user.uid, email: user.email ?? '', role, teacher: null };

  let tSnap = await call('open your teacher workspace', () => getDoc(T()), { tries: 3 });
  let created = false;

  if (!tSnap.exists()) {
    if (role !== 'admin') {
      session = null;
      throw new TeacherApiError('No teacher workspace found for this account', {
        code: 'bw/no-teacher-doc',
        hint: 'ask an admin or another teacher for an invite link',
      });
    }
    await call('create your teacher workspace', () => setDoc(T(), {
      name:            user.displayName ?? user.email ?? '',
      email:           user.email ?? '',
      createdAt:       serverTimestamp(),
      canInvite:       true,
      libraryPublic:   false,
      requireApproval: false,
    }));
    tSnap = await call('open your teacher workspace', () => getDoc(T()));
    created = true;
  }

  const teacher = { id: tSnap.id, ...tSnap.data() };

  // Backfill for accounts created before `canInvite` was on the schema. The
  // invites/{token} create rule defaults a missing canInvite to false, so
  // without this a legacy teacher's "Generate link" button is silently denied.
  if (teacher.canInvite !== true) {
    try {
      await updateDoc(T(), { canInvite: true });
      teacher.canInvite = true;
    } catch (err) {
      console.warn('[teacher-api] could not backfill canInvite:', err?.code ?? err);
    }
  }

  session = { uid: user.uid, email: user.email ?? '', role, teacher };
  return { ...session, created };
}

export function closeTeacherSession() { session = null; }

/** Patch the teacher document and keep the cached copy in step, so callers
 *  never have to re-read it just to see their own write. */
async function patchTeacher(label, fields) {
  const s = requireSession();
  await call(label, () => updateDoc(T(), fields));
  Object.assign(s.teacher, fields);
}

// ═══════════════════════════════════════════════════════════════════════════
// Classes and join codes
// ═══════════════════════════════════════════════════════════════════════════
//
// A student joins by reading classCodes/{CODE} — a doc-ID lookup, no query and
// no index. If that document is missing or points elsewhere, the code is dead
// no matter how healthy the teacher's screen looks. So every function that
// hands out a code verifies the mapping by reading it back, and reports
// `codeLive: false` rather than pretending.

/** Point classCodes/{code} at this class, and report what a student would
 *  ACTUALLY find afterwards.
 *
 *  Returns `{ live, code, error }`. `code` can differ from the one passed in:
 *  when the mapping is already owned by a DIFFERENT teacher, the rules
 *  (correctly) forbid taking it over, so retrying forever is pointless — we
 *  mint a fresh code instead. The caller is expected to persist `code` back
 *  onto the class when it changed. */
export async function ensureClassCodeMapping(code, classId, { createdAt = null, allowRecode = true } = {}) {
  const s = requireSession();
  if (!code) return { live: false, code, error: 'no code' };

  try {
    const ref      = doc(db, 'classCodes', code);
    const existing = await withDeadline(getDoc(ref));

    if (existing.exists()) {
      const data = existing.data();
      if (data.teacherId === s.uid && data.classId === classId) {
        return { live: true, code, error: null };   // already correct, no write
      }
      if (data.teacherId !== s.uid) {
        // Somebody else's code. Rules forbid repointing it — and should.
        if (!allowRecode) return { live: false, code, error: 'code already in use by another class' };
        const fresh = generateClassCode();
        console.warn(`[teacher-api] class code ${code} belongs to another teacher; issuing ${fresh}`);
        return ensureClassCodeMapping(fresh, classId, { createdAt: null, allowRecode: false });
      }
      // Ours, but pointing at an old class of ours. Repoint it.
    }

    await withDeadline(setDoc(ref, {
      teacherId: s.uid,
      classId,
      createdAt: createdAt ?? serverTimestamp(),
    }));

    const check = await withDeadline(getDoc(ref));
    const live  = check.exists() && check.data().classId === classId && check.data().teacherId === s.uid;
    return { live, code, error: live ? null : 'the mapping did not stick' };
  } catch (err) {
    const e = wrap(`register class code ${code}`, err);
    return { live: false, code, error: e.hint || e.code };
  }
}

/** Every class this teacher owns, with a live student count and a verified
 *  join code. Classes past their last day of school report `expired: true` and
 *  a count of 0 — their roster is no longer readable by design. */
export async function listClasses({ verifyCodes = true } = {}) {
  const s    = requireSession();
  const snap = await call('load your classes', () => getDocs(TC('classes')), { tries: 2 });

  const classes = await Promise.all(snap.docs.map(async d => {
    const data    = d.data();
    const expired = isClassExpired(data.endDate);

    const [codeRes, count] = await Promise.all([
      verifyCodes
        ? ensureClassCodeMapping(data.inviteCode, d.id, { createdAt: data.createdAt })
        : Promise.resolve({ live: true, code: data.inviteCode, error: null }),
      expired ? Promise.resolve(0) : countRoster(d.id),
    ]);

    // ensureClassCodeMapping may have had to mint a new code (collision with
    // another teacher). Persist it, or the class card and the live mapping
    // disagree — which is exactly how a teacher ends up reading out a code
    // that resolves to nothing.
    if (codeRes.code !== data.inviteCode) {
      try { await updateDoc(doc(db, 'teachers', s.uid, 'classes', d.id), { inviteCode: codeRes.code }); }
      catch (err) { console.warn('[teacher-api] could not persist new class code:', err?.code ?? err); }
    }

    return {
      id: d.id,
      ...data,
      inviteCode:   codeRes.code,
      studentCount: count,
      expired,
      codeLive:     codeRes.live,
      codeError:    codeRes.error,
    };
  }));

  classes.sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
  return classes;
}

/** Roster size without reading the roster. A count aggregation bills one read
 *  regardless of class size; getDocs().size bills one per student, and this
 *  runs for every class on every portal load. */
async function countRoster(classId) {
  try {
    const snap = await withDeadline(getCountFromServer(TC('classes', classId, 'students')));
    return snap.data().count;
  } catch (_) {
    return 0;   // denied (expired) or unavailable — not worth failing the page
  }
}

export async function createClass({ name, endDate }) {
  const stamp = toEndOfDayTimestamp(endDate);
  if (!stamp) {
    throw new TeacherApiError('A class needs a valid last day of school', {
      code: 'bw/bad-end-date', hint: 'use the format 2027-06-04',
    });
  }
  const code = generateClassCode();
  const ref  = await call('create the class', () => addDoc(TC('classes'), {
    name, inviteCode: code, endDate: stamp, createdAt: serverTimestamp(),
  }));

  const res = await ensureClassCodeMapping(code, ref.id);
  if (res.code !== code) {
    try { await updateDoc(doc(db, 'teachers', requireSession().uid, 'classes', ref.id), { inviteCode: res.code }); }
    catch (_) {}
  }

  return {
    id: ref.id, name, inviteCode: res.code, endDate: stamp,
    studentCount: 0, expired: false,
    createdAt: { seconds: Math.floor(Date.now() / 1000) },
    codeLive: res.live, codeError: res.error,
  };
}

export async function renameClass(classId, name) {
  await call('rename the class', () => updateDoc(T('classes', classId), { name }));
}

export async function setClassEndDate(classId, endDate) {
  const stamp = toEndOfDayTimestamp(endDate);
  if (!stamp) {
    throw new TeacherApiError('That date could not be read', {
      code: 'bw/bad-end-date', hint: 'use the format 2027-06-04',
    });
  }
  await call('save the last day of school', () => updateDoc(T('classes', classId), { endDate: stamp }));
  return stamp;
}

/** Issue a new join code for a class.
 *
 *  Registers the new mapping and confirms it resolves BEFORE writing it onto
 *  the class. Handing a teacher a code that was never registered is the exact
 *  failure this path exists to prevent, so on failure the old code is left
 *  working and nothing changes. */
export async function rotateClassCode(classId, oldCode) {
  const res = await ensureClassCodeMapping(generateClassCode(), classId);
  if (!res.live) {
    throw new TeacherApiError('Could not issue a new code', {
      code: 'bw/code-not-live',
      hint: `${res.error ?? 'unknown error'}. The existing code still works.`,
    });
  }
  await call('save the new code', () => updateDoc(T('classes', classId), { inviteCode: res.code }));
  if (oldCode && oldCode !== res.code) {
    try { await deleteDoc(doc(db, 'classCodes', oldCode)); } catch (_) {}
  }
  return res.code;
}

/** Delete a class, its roster, and its join code.
 *
 *  Batched, so a partial delete can't leave a class whose roster is half gone,
 *  and so a 30-student class is one round trip instead of 31. */
export async function deleteClass(classId, inviteCode) {
  const s      = requireSession();
  const roster = await call('read the class roster', () => getDocs(TC('classes', classId, 'students')));

  await call('delete the class', async () => {
    for (const chunk of chunked(roster.docs, 400)) {
      const batch = writeBatch(db);
      chunk.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    const batch = writeBatch(db);
    if (inviteCode) batch.delete(doc(db, 'classCodes', inviteCode));
    batch.delete(doc(db, 'teachers', s.uid, 'classes', classId));
    await batch.commit();
  });

  return roster.size;
}

// ═══════════════════════════════════════════════════════════════════════════
// Roster
// ═══════════════════════════════════════════════════════════════════════════

/** One class's roster. Returns `{ students, readable }` — `readable: false`
 *  means the rules refused, which past the last day of school is the retention
 *  policy working correctly, not an error to shout about. */
export async function listRoster(classId) {
  try {
    const snap = await withDeadline(getDocs(TC('classes', classId, 'students')));
    const students = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    return { students, readable: true };
  } catch (err) {
    console.warn('[teacher-api] roster unreadable for class', classId, err?.code ?? err);
    return { students: [], readable: false };
  }
}

/** Remove one student from one class.
 *
 *  If that was their last class with this teacher, their library access goes
 *  too: the flat `teachers/{uid}/students/{sid}` marker is what firestore.rules
 *  actually checks to serve a Class Only library, so leaving it behind means a
 *  removed student keeps reading and borrowing the books indefinitely. */
export async function removeStudentFromClass(classId, studentId, allClassIds = []) {
  const s = requireSession();
  await call('remove the student', () => deleteDoc(T('classes', classId, 'students', studentId)));

  const others = allClassIds.filter(id => id !== classId);
  let stillEnrolled = false;
  for (const cid of others) {
    try {
      const snap = await withDeadline(getDoc(T('classes', cid, 'students', studentId)));
      if (snap.exists()) { stillEnrolled = true; break; }
    } catch (_) { /* unreadable class — assume not enrolled */ }
  }

  if (!stillEnrolled) {
    try { await updateDoc(doc(db, 'students', studentId), { addedTeachers: arrayRemove(s.uid) }); } catch (_) {}
    try { await deleteDoc(T('students', studentId)); } catch (_) {}
  }
  return { stillEnrolled };
}

// ═══════════════════════════════════════════════════════════════════════════
// Books
// ═══════════════════════════════════════════════════════════════════════════

export async function listBooks() {
  const snap = await call('load your books', () => getDocs(TC('books')), { tries: 2 });
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Normalize a title or author for duplicate detection. Case, punctuation and
 *  a leading article all vary between editions of the same book, so
 *  "The Hobbit!" and "hobbit, the" both reduce to "hobbit". */
export function normBookKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) +/, '')
    .replace(/ +(the|a|an)$/, '')
    .trim();
}

/** The book in `books` that is the same book as `book`, or null.
 *
 *  ISBN and Google's volume id win when present because they are exact, but
 *  neither can be the only test: every printing carries its own ISBN and a
 *  repeat search can return a different volume id for the same title. Matching
 *  on those alone is what silently created a second row every time a teacher
 *  added more copies of a book they already owned. */
export function findExistingBook(book, books) {
  if (!book) return null;
  const byIsbn = book.isbn && books.find(b => b.isbn && b.isbn === book.isbn);
  if (byIsbn) return byIsbn;
  const bySource = book.sourceId && books.find(b => b.sourceId && b.sourceId === book.sourceId);
  if (bySource) return bySource;
  const t = normBookKey(book.title);
  if (!t) return null;
  const a = normBookKey(book.author);
  return books.find(b => normBookKey(b.title) === t && normBookKey(b.author) === a) ?? null;
}

/** Books listed more than once under the same title+author. */
export function findDuplicateGroups(books) {
  const groups = new Map();
  for (const b of books) {
    const t = normBookKey(b.title);
    if (!t) continue;
    const key = `${t}|${normBookKey(b.author)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

export async function addBook(book, copies = 1) {
  const ref = await call('add the book', () => addDoc(TC('books'), {
    title:       book.title ?? '',
    author:      book.author ?? '',
    isbn:        book.isbn ?? '',
    coverUrl:    book.cover ?? book.coverUrl ?? '',
    description: book.description ?? '',
    sourceId:    book.sourceId ?? '',
    status:      'available',
    copies,
    checkedOutCount: 0,
    checkedOutBy:    null,
    checkedOutAt:    null,
    wishlist:        [],
    addedAt:         serverTimestamp(),
  }));
  return ref.id;
}

/** Change a book's copy count by `delta`, atomically.
 *
 *  Read-modify-write, so two tabs (or a teacher and an approval) can't both
 *  read "3 copies" and both write "4". Refuses to drop the count below the
 *  number of copies currently out — that would make availability negative and
 *  strand a loan. */
export async function adjustCopies(bookId, delta) {
  return call('change the copy count', () => runTransaction(db, async tx => {
    const ref  = T('books', bookId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new TeacherApiError('That book no longer exists', { code: 'not-found' });
    const data = snap.data();
    const out  = outCount(data);
    const next = (data.copies ?? 1) + delta;
    if (next < 1) {
      throw new TeacherApiError('That is the last copy', {
        code: 'bw/last-copy', hint: 'use Delete to remove the book entirely',
      });
    }
    if (next < out) {
      throw new TeacherApiError(`${out} cop${out === 1 ? 'y is' : 'ies are'} still checked out`, {
        code: 'bw/copies-out', hint: 'have them returned first',
      });
    }
    tx.update(ref, { copies: next, status: out >= next ? 'checked_out' : 'available' });
    return next;
  }));
}

export async function deleteBook(bookId) {
  await call('delete the book', () => deleteDoc(T('books', bookId)));
}

/** Delete several books at once.
 *
 *  Batched: a 40-book cleanup is a couple of round trips rather than 40, and
 *  each batch is atomic, so the list can't end up half-deleted. Firestore caps
 *  a batch at 500 writes; 400 leaves headroom. */
export async function deleteBooks(bookIds) {
  const ids = [...new Set(bookIds)].filter(Boolean);
  if (!ids.length) return 0;
  await call('delete the selected books', async () => {
    for (const chunk of chunked(ids, 400)) {
      const batch = writeBatch(db);
      chunk.forEach(id => batch.delete(T('books', id)));
      await batch.commit();
    }
  });
  return ids.length;
}

/** Import books from a parsed spreadsheet.
 *
 *  `entries` are already grouped by the caller: one entry per distinct book,
 *  carrying the number of copies. Exports from other classroom-library apps
 *  list one ROW PER COPY, so grouping is what turns four "The Martian" rows
 *  into a single book with copies: 4 rather than four duplicate shelf entries.
 *
 *  A title already on the shelf gains copies instead of being duplicated —
 *  same identity rule the Add flow uses (findExistingBook), so importing the
 *  same file twice tops up copy counts rather than doubling the library.
 *
 *  Checkout state is deliberately NOT imported. A row marked "Checked out" in
 *  another app refers to a student who does not exist in BookWare, and a copy
 *  marked out with no borrower can never be returned through the UI. Those
 *  copies come in as available and are reported back to the caller so the
 *  teacher can be told.
 *
 *  Returns { created, updated, copiesAdded, checkedOutIgnored, skipped }. */
export async function importBooks(entries, { onProgress } = {}) {
  requireSession();
  const existing = await listBooks();
  const byId = new Map(existing.map(b => [b.id, { ...b }]));

  const plan = { created: 0, updated: 0, copiesAdded: 0, checkedOutIgnored: 0, skipped: 0 };
  const writes = [];

  for (const e of entries) {
    const title = (e.title ?? '').trim();
    if (!title) { plan.skipped++; continue; }
    const copies = Math.max(1, e.copies ?? 1);
    plan.copiesAdded += copies;
    plan.checkedOutIgnored += e.checkedOut ?? 0;

    // Match against the running set, not the original snapshot: two spreadsheet
    // entries that normalise to the same book must merge into one shelf entry.
    const match = findExistingBook({ ...e, title }, [...byId.values()]);
    if (match) {
      const next = (match.copies ?? 1) + copies;
      match.copies = next;
      writes.push({ type: 'update', ref: T('books', match.id), data: { copies: next } });
      plan.updated++;
    } else {
      const ref = doc(TC('books'));
      const data = {
        title,
        author:      (e.author ?? '').trim(),
        isbn:        (e.isbn ?? '').trim(),
        coverUrl:    (e.coverUrl ?? '').trim(),
        description: (e.description ?? '').trim(),
        sourceId:    '',
        status:      'available',
        copies,
        checkedOutCount: 0,
        checkedOutBy:    null,
        checkedOutAt:    null,
        wishlist:        [],
        addedAt:         serverTimestamp(),
        importedAt:      serverTimestamp(),
      };
      byId.set(ref.id, { id: ref.id, ...data });
      writes.push({ type: 'set', ref, data });
      plan.created++;
    }
  }

  let done = 0;
  await call('import the books', async () => {
    for (const chunk of chunked(writes, 400)) {
      const batch = writeBatch(db);
      for (const w of chunk) {
        if (w.type === 'set') batch.set(w.ref, w.data);
        else batch.update(w.ref, w.data);
      }
      await batch.commit();
      done += chunk.length;
      onProgress?.(done, writes.length);
    }
  }, { ms: 60000 });

  return plan;
}

/** Fold duplicate entries into one, summing their copy counts.
 *
 *  A group with open loans on two different entries is skipped, not merged:
 *  history rows reference a book by document id, so collapsing both would
 *  orphan one student's loan record. Returns `{ merged, skipped }`. */
export async function mergeDuplicateBooks(books) {
  const groups = findDuplicateGroups(books);
  let merged = 0, skipped = 0;

  for (const group of groups) {
    const withLoans = group.filter(b => outCount(b) > 0);
    if (withLoans.length > 1) { skipped++; continue; }

    const keeper = withLoans[0] ?? [...group].sort((a, b) => (b.copies ?? 1) - (a.copies ?? 1))[0];
    const others = group.filter(b => b.id !== keeper.id);
    const copies = group.reduce((n, b) => n + (b.copies ?? 1), 0);
    const out    = outCount(keeper);

    try {
      const batch = writeBatch(db);
      batch.update(T('books', keeper.id), {
        copies,
        status:   out >= copies ? 'checked_out' : 'available',
        coverUrl: keeper.coverUrl || others.find(b => b.coverUrl)?.coverUrl || '',
        isbn:     keeper.isbn     || others.find(b => b.isbn)?.isbn         || '',
      });
      others.forEach(o => batch.delete(T('books', o.id)));
      await batch.commit();
      merged += others.length;
    } catch (err) {
      console.error('[teacher-api] merge failed for', keeper.title, err?.code ?? err);
      skipped++;
    }
  }
  return { merged, skipped };
}

/** How many copies of a book are out. `checkedOutCount` is authoritative;
 *  the `status` fallback is only for rows written before that field existed. */
export function outCount(book) {
  return book?.checkedOutCount ?? (book?.status === 'checked_out' ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Loans
// ═══════════════════════════════════════════════════════════════════════════
//
// ─── WHY LOANS COME FROM `history`, NOT FROM THE BOOK ────────────────────────
// A book document has ONE `checkedOutBy` field but can have several copies. So
// with 3 copies and 2 borrowers, `checkedOutBy` names whichever student
// borrowed most recently and the other one is invisible — the teacher's list
// showed a single row, a single name, and no way to reach the second loan.
//
// `teachers/{uid}/history` has one row per loan, so it is the only place that
// can answer "who has a copy of this". An open loan is a row with
// `dateReturned == null`. That is a single-field query: no composite index.
//
// The book's own counters (`copies`, `checkedOutCount`, `status`) stay as they
// are — the student portal and firestore.rules both depend on them — but the
// teacher portal treats them as a tally, not as a roster.

const LOAN_DAYS = 14;

/** Every loan of this teacher's books that hasn't been returned.
 *
 *  With `withBorrowerStatus`, each loan also carries `saysReturned`: the
 *  student cleared this book from their own record but the teacher hasn't
 *  confirmed it yet. A student's "Returned It" deliberately does NOT free the
 *  copy — the teacher is the single authority on a return (see returnLoan) —
 *  so without surfacing that difference a handed-back book looks identical to
 *  one still in a backpack, and the loan stays open indefinitely.
 *
 *  One read per distinct BORROWER, not per loan: a student can only hold one
 *  book at a time, so their record answers for all of their rows at once. */
export async function listOpenLoans({ withBorrowerStatus = false } = {}) {
  const snap = await call('load checked-out books',
    () => getDocs(query(TC('history'), where('dateReturned', '==', null))), { tries: 2 });

  const loans = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));

  if (!withBorrowerStatus || !loans.length) return loans;

  const borrowerIds = [...new Set(loans.map(l => l.studentId).filter(Boolean))];
  const holding = new Map();
  await Promise.all(borrowerIds.map(async id => {
    try {
      const s = await withDeadline(getDoc(doc(db, 'students', id)));
      holding.set(id, s.exists() ? s.data().currentBook ?? null : null);
    } catch (_) { holding.set(id, undefined); }   // unknown — don't claim either way
  }));

  return loans.map(l => ({
    ...l,
    saysReturned: l.studentId && holding.get(l.studentId) !== undefined
      ? holding.get(l.studentId) !== l.bookId
      : false,
  }));
}

/** Check a book out to a student, as one atomic unit.
 *
 *  Book counter, student record, the loan row, and (when approving a request)
 *  the request status all move together or not at all. They used to be four
 *  separate writes behind a Promise.all, which had two consequences: two
 *  students could be handed the same last copy, and — because the rules only
 *  let a STUDENT create a history row — the loan row was always denied. The
 *  book got checked out, the student's record was updated, and the teacher was
 *  told "Approval failed". That combination is why approvals looked broken
 *  while books quietly went missing from the shelf.
 *
 *  (The rules fix that lets a teacher write history rows ships alongside this —
 *  see firestore.rules, match /history.)
 *
 *  Returns `{ loanId, dueDate }`. */
export async function checkoutToStudent({ bookId, studentId, requestId = null }) {
  const s   = requireSession();
  const due = new Date();
  due.setDate(due.getDate() + LOAN_DAYS);
  const dueTs = Timestamp.fromDate(due);

  const loanRef = doc(TC('history'));

  await call('check the book out', () => runTransaction(db, async tx => {
    const bookRef    = T('books', bookId);
    const studentRef = doc(db, 'students', studentId);

    // Every read must happen before every write in a Firestore transaction.
    const [bSnap, sSnap] = await Promise.all([tx.get(bookRef), tx.get(studentRef)]);

    if (!bSnap.exists()) throw new TeacherApiError('That book no longer exists', { code: 'not-found' });
    if (!sSnap.exists()) throw new TeacherApiError('That student account no longer exists', { code: 'not-found' });

    const bData = bSnap.data();
    const sData = sSnap.data();

    if (sData.currentBook) {
      throw new TeacherApiError('That student already has a book out', {
        code: 'bw/already-has-book', hint: 'they can borrow another once this one is returned',
      });
    }

    const copies = bData.copies ?? 1;
    const out    = outCount(bData);
    if (out >= copies) {
      throw new TeacherApiError('Every copy is already checked out', {
        code: 'bw/no-copies', hint: 'add a copy or wait for a return',
      });
    }

    const next = out + 1;
    tx.update(bookRef, {
      checkedOutCount: next,
      status:          next >= copies ? 'checked_out' : 'available',
      checkedOutBy:    studentId,
      checkedOutAt:    serverTimestamp(),
      dueDate:         dueTs,
    });
    tx.update(studentRef, { currentBook: bookId, currentBookTeacherId: s.uid });
    tx.set(loanRef, {
      bookId,
      bookTitle:    bData.title ?? '',
      author:       bData.author ?? '',
      coverUrl:     bData.coverUrl ?? '',
      studentId,
      studentName:  sData.name ?? '',
      dateOut:      serverTimestamp(),
      dueDate:      dueTs,
      dateReturned: null,
    });
    if (requestId) {
      tx.update(T('requests', requestId), { status: 'approved', respondedAt: serverTimestamp() });
    }
  }));

  return { loanId: loanRef.id, dueDate: due };
}

/** Mark one loan returned, as one atomic unit.
 *
 *  Takes a LOAN id, not a book id. That is what makes multi-copy books work:
 *  returning one of three copies closes that student's row and frees exactly
 *  one copy, instead of guessing which of several borrowers is handing it back.
 *
 *  Status mirrors the checkout side (`next >= copies`), not `next === 0`. With
 *  copies free, a multi-copy book must go back to 'available' — otherwise the
 *  student view shows "1/3 available" and no Check Out button. */
export async function returnLoan(loanId) {
  const s = requireSession();

  return call('record the return', () => runTransaction(db, async tx => {
    const loanRef  = T('history', loanId);
    const loanSnap = await tx.get(loanRef);
    if (!loanSnap.exists()) throw new TeacherApiError('That loan record is gone', { code: 'not-found' });

    const loan = loanSnap.data();
    if (loan.dateReturned) {
      throw new TeacherApiError('That book is already marked returned', { code: 'bw/already-returned' });
    }

    const bookRef  = T('books', loan.bookId);
    const bookSnap = await tx.get(bookRef);

    // The borrower's record is only cleared if it still points at THIS book —
    // otherwise a return processed late would wipe a newer loan the same
    // student has already started.
    const studentRef  = loan.studentId ? doc(db, 'students', loan.studentId) : null;
    const studentSnap = studentRef ? await tx.get(studentRef) : null;

    if (bookSnap.exists()) {
      const bData  = bookSnap.data();
      const copies = bData.copies ?? 1;
      const next   = Math.max(0, outCount(bData) - 1);
      tx.update(bookRef, {
        checkedOutCount: next,
        status:       next >= copies ? 'checked_out' : 'available',
        checkedOutBy: next === 0 ? null : bData.checkedOutBy,
        checkedOutAt: next === 0 ? null : bData.checkedOutAt,
        dueDate:      next === 0 ? null : bData.dueDate,
      });
    }

    tx.update(loanRef, { dateReturned: serverTimestamp(), returnedBy: s.uid });

    if (studentSnap?.exists() && studentSnap.data().currentBook === loan.bookId) {
      tx.update(studentRef, { currentBook: null, currentBookTeacherId: null });
    }

    return { bookTitle: loan.bookTitle ?? '', studentName: loan.studentName ?? '' };
  }));
}

/** Close out a loan the history has no row for.
 *
 *  Loans made before the history log existed — or ones whose row the student's
 *  own (separate, deniable) write failed to create — leave a book showing as
 *  out with nothing to return. This decrements the book and writes a closed
 *  row marked `reconstructed` so the loan doesn't just vanish. */
export async function reconstructReturn(bookId) {
  const s       = requireSession();
  const loanRef = doc(TC('history'));

  await call('record the return', () => runTransaction(db, async tx => {
    const bookRef  = T('books', bookId);
    const bookSnap = await tx.get(bookRef);
    if (!bookSnap.exists()) throw new TeacherApiError('That book no longer exists', { code: 'not-found' });

    const bData  = bookSnap.data();
    const copies = bData.copies ?? 1;
    const next   = Math.max(0, outCount(bData) - 1);

    tx.update(bookRef, {
      checkedOutCount: next,
      status:       next >= copies ? 'checked_out' : 'available',
      checkedOutBy: next === 0 ? null : bData.checkedOutBy,
      checkedOutAt: next === 0 ? null : bData.checkedOutAt,
      dueDate:      next === 0 ? null : bData.dueDate,
    });
    tx.set(loanRef, {
      bookId,
      bookTitle:     bData.title ?? '',
      author:        bData.author ?? '',
      studentId:     bData.checkedOutBy ?? null,
      studentName:   '',
      dateOut:       bData.checkedOutAt ?? null,
      dateReturned:  serverTimestamp(),
      returnedBy:    s.uid,
      reconstructed: true,
    });
  }));
}

/** Subscribe to the full checkout history, newest first.
 *
 *  `onSnapshot` has two failure modes: it errors, or it never fires at all —
 *  no data, no error, no timeout of its own. The second one is what leaves a
 *  panel on "Loading…" forever, so this adds a deadline and reports it as a
 *  failure. Returns an unsubscribe function; call it before re-subscribing. */
export function watchHistory({ onData, onError, deadlineMs = DEADLINE_MS }) {
  let settled = false;
  const watchdog = setTimeout(() => {
    if (settled) return;
    settled = true;
    onError?.(new TeacherApiError("Couldn't load checkout history", {
      code: 'bw/timeout', hint: HINTS['bw/timeout'],
    }));
  }, deadlineMs);

  const unsub = onSnapshot(TC('history'),
    snap => {
      settled = true;
      clearTimeout(watchdog);
      onData(snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0)));
    },
    err => {
      settled = true;
      clearTimeout(watchdog);
      onError?.(wrap('load checkout history', err));
    },
  );

  return () => { clearTimeout(watchdog); unsub(); };
}

/** The whole history as a plain array — for exports, which must not depend on
 *  whatever the live listener happens to be holding. */
export async function listHistory() {
  const snap = await call('load checkout history', () => getDocs(TC('history')), { tries: 2 });
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.dateOut?.seconds ?? 0) - (a.dateOut?.seconds ?? 0));
}

// ═══════════════════════════════════════════════════════════════════════════
// Checkout requests ("Ask me first" mode)
// ═══════════════════════════════════════════════════════════════════════════

export async function listPendingRequests() {
  const snap = await call('load checkout requests',
    () => getDocs(query(TC('requests'), where('status', '==', 'pending'))), { tries: 2 });
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Approve a request: the checkout and the status change commit together, so a
 *  request can never read "approved" for a checkout that didn't happen. */
export async function approveRequest({ requestId, bookId, studentId }) {
  return checkoutToStudent({ bookId, studentId, requestId });
}

export async function denyRequest(requestId) {
  await call('deny the request', () => updateDoc(T('requests', requestId), {
    status: 'denied', respondedAt: serverTimestamp(),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Recommendations
// ═══════════════════════════════════════════════════════════════════════════

export async function listRecommendations() {
  const snap = await call('load your recommendations', () => getDocs(TC('recommendations')), { tries: 2 });
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addRecommendation({ bookId, bookTitle, author = '', coverUrl = '', source = 'library' }) {
  const ref = await call('save the recommendation', () => addDoc(TC('recommendations'), {
    bookId, bookTitle, author, coverUrl, source, createdAt: serverTimestamp(),
  }));
  return { id: ref.id, bookId, bookTitle, author, coverUrl, source };
}

export async function removeRecommendation(recId) {
  await call('remove the recommendation', () => deleteDoc(T('recommendations', recId)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Bans
// ═══════════════════════════════════════════════════════════════════════════
//
// Teachers may only issue TEMPORARY bans, and only against students —
// firestore.rules enforces both. Both queries below are two-field equality
// queries and therefore need composite indexes; they are declared in
// firestore.indexes.json. Without them Firestore answers `failed-precondition`
// and this panel is permanently empty.

export async function findStudentByEmail(email) {
  const snap = await call('look that student up',
    () => getDocs(query(collection(db, 'users'), where('email', '==', email.trim().toLowerCase()), qLimit(5))));
  const match = snap.docs.find(d => d.data().role === 'student');
  if (!match) {
    throw new TeacherApiError('No student account with that email', {
      code: 'bw/no-such-student',
      hint: 'they need to sign in to BookWare at least once first',
    });
  }
  return { id: match.id, ...match.data() };
}

export async function banStudent({ studentUid, days, reason }) {
  const s = requireSession();
  if (!(days > 0)) {
    throw new TeacherApiError('A ban needs a length in days', {
      code: 'bw/bad-ban', hint: 'permanent bans are admin-only',
    });
  }
  const banExpiry = Timestamp.fromDate(new Date(Date.now() + days * 86400000));
  await call('issue the ban', () => updateDoc(doc(db, 'users', studentUid), {
    banned: true, banExpiry, banReason: reason,
    bannedBy: s.uid, bannedAt: serverTimestamp(),
  }));
  return banExpiry;
}

export async function listActiveBans() {
  const s = requireSession();
  const snap = await call('load active bans', () => getDocs(query(
    collection(db, 'users'),
    where('bannedBy', '==', s.uid),
    where('banned', '==', true),
  )), { tries: 2 });
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function liftBan(studentUid) {
  await call('lift the ban', () => updateDoc(doc(db, 'users', studentUid), {
    banned: false, banExpiry: null, banReason: null, bannedBy: null,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Teacher invites
// ═══════════════════════════════════════════════════════════════════════════

const INVITE_DAYS = 7;

export async function createInvite(recipientEmail) {
  const s     = requireSession();
  const email = recipientEmail.trim().toLowerCase();
  if (!email.includes('@')) {
    throw new TeacherApiError('That is not an email address', { code: 'bw/bad-email' });
  }
  const ref = await call('create the invite', () => addDoc(collection(db, 'invites'), {
    recipientEmail: email,
    used:           false,
    revoked:        false,
    expiresAt:      Timestamp.fromDate(new Date(Date.now() + INVITE_DAYS * 86400000)),
    createdBy:      s.uid,
    createdByName:  s.teacher?.name ?? s.email,
    createdByRole:  s.role,
    createdAt:      serverTimestamp(),
  }));
  return { id: ref.id, email, days: INVITE_DAYS };
}

export async function listInvites() {
  const s = requireSession();
  const snap = await call('load your invites',
    () => getDocs(query(collection(db, 'invites'), where('createdBy', '==', s.uid))), { tries: 2 });
  const now = Date.now();
  return snap.docs
    .map(d => {
      const data    = d.data();
      const expires = data.expiresAt?.toDate?.() ?? null;
      const expired = !!expires && expires.getTime() < now;
      return { id: d.id, ...data, expired, active: !data.used && !data.revoked && !expired };
    })
    .sort((a, b) => (Number(b.active) - Number(a.active)) ||
                    ((b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)));
}

export async function revokeInvite(inviteId) {
  const s = requireSession();
  await call('revoke the invite', () => updateDoc(doc(db, 'invites', inviteId), {
    revoked: true, revokedAt: serverTimestamp(), revokedBy: s.uid,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Teacher preferences
// ═══════════════════════════════════════════════════════════════════════════

export const setLibraryPublic    = (on)      => patchTeacher('change library visibility', { libraryPublic: !!on });
export const setRequireApproval  = (on)      => patchTeacher('change the checkout mode',  { requireApproval: !!on });
export const setCurrentlyReading = (reading) => patchTeacher('save your current read',    { currentlyReading: reading });
export const setReadingProfile   = (profile) => patchTeacher('save your reading profile', { readingProfile: profile });
export const markWelcomeSeen     = ()        => patchTeacher('save your progress',        { welcomeSeenAt: serverTimestamp() });

// ═══════════════════════════════════════════════════════════════════════════
// Small shared helpers
// ═══════════════════════════════════════════════════════════════════════════

/** 'YYYY-MM-DD' | Date | Timestamp → a Timestamp at 23:59:59.999 local on the
 *  last day of school, so that whole day counts and firestore.rules can compare
 *  it directly against request.time. */
export function toEndOfDayTimestamp(value) {
  const d = endOfSchoolDay(value);
  return d ? Timestamp.fromDate(d) : null;
}

export { endOfSchoolDay as endOfDay, isClassExpired as isExpired };

/** Opportunistic data-retention sweep for this teacher. See retention.js for
 *  why it runs on portal load rather than on a schedule. Never throws — it is
 *  housekeeping, and it must not be able to fail the portal. */
export async function runRetention() {
  const s = requireSession();
  try {
    return await runRetentionSweep(db, s.uid);
  } catch (err) {
    console.warn('[teacher-api] retention sweep failed:', err?.code ?? err);
    return null;
  }
}

function* chunked(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
