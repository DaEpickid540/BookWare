# Teacher backend

The teacher portal's data layer: what it stores, what it guarantees, and where
each guarantee is enforced.

- **Code:** [`public/js/teacher-api.js`](public/js/teacher-api.js) — every read
  and write. [`public/js/teacher.js`](public/js/teacher.js) is UI only.
- **Authorization:** [`firestore.rules`](firestore.rules)
- **Query support:** [`firestore.indexes.json`](firestore.indexes.json)

All three ship together. A change to the code that needs a rule or an index and
doesn't get one fails at runtime, in a user's browser, with no build-time
warning. See [`../CLAUDE.md`](../CLAUDE.md) for the deployment path.

---

## Data model

Everything a teacher owns hangs off their own document, keyed by their Firebase
Auth uid.

```
teachers/{uid}                       the teacher record + their settings
  ├── books/{bookId}                 the classroom shelf
  ├── history/{loanId}               ONE ROW PER LOAN — the borrowing ledger
  ├── requests/{reqId}               pending checkouts ("Ask me first" mode)
  ├── classes/{classId}              a period/section
  │     └── students/{studentUid}    that class's roster (name + school email)
  ├── recommendations/{recId}        starred titles
  └── students/{studentUid}          flat membership marker (see below)

classCodes/{CODE}                    CODE → { teacherId, classId }
users/{uid}                          role + ban state (shared with all portals)
students/{uid}                       the student's own record
invites/{token}                      teacher invite links
```

### `history` is the ledger, not a log

A book document has one `checkedOutBy` field but can have several `copies`. With
3 copies and 2 borrowers it can only name one of them, so the other loan is
invisible — no borrower name, no due date, no way to return it.

So **`history` is the source of truth for who has what.** One row per loan:

| Field | Meaning |
|---|---|
| `bookId`, `bookTitle`, `author`, `coverUrl` | denormalised so the list renders without reading every book |
| `studentId`, `studentName` | the borrower; `studentName` is redacted to `[deleted]` on erasure |
| `dateOut`, `dueDate` | 14-day loan |
| `dateReturned` | **`null` means the loan is open.** This is the whole query |
| `reconstructed` | this row was synthesised to close a loan that had no record |

`listOpenLoans()` is `where('dateReturned', '==', null)` — one field, so no
composite index, ever.

The book's `copies` / `checkedOutCount` / `status` remain a **tally**. The
student portal and `firestore.rules` both read them, so they stay accurate, but
the teacher portal never treats them as a roster.

### The flat `teachers/{uid}/students/{sid}` marker

A PII-free "this student may use this library" flag, separate from the class
roster. `firestore.rules` checks *this* to serve a Class Only library, so it
must be deleted whenever a student leaves the teacher's last class — otherwise
a removed student keeps borrowing privileges forever.
`removeStudentFromClass()` and the retention sweep both handle it.

### Join codes

A student joins by reading `classCodes/{CODE}` — a document-ID lookup, so no
query and no index. If that document is missing or points elsewhere, the code is
dead however healthy the teacher's screen looks.

`ensureClassCodeMapping()` therefore always **reads the mapping back** after
writing and returns what a student would actually find. A class whose code
doesn't resolve renders a red banner with a Retry button rather than pretending.
If the code collides with another teacher's, the rules correctly forbid taking
it over, so a fresh code is minted and persisted instead of retrying forever.

---

## Invariants

These are what the module exists to hold. Break one and the symptoms are the
ones this rebuild was fixing.

1. **A loan changes four things atomically.** Book counter, student record, the
   ledger row, and (when approving) the request status commit in one
   transaction — `checkoutToStudent()`. Previously four independent writes: two
   students could be handed the same last copy, and a partial failure reported
   the whole thing as failed while half of it had landed.

2. **Availability is `checkedOutCount >= copies`, never `=== 0`.** Returning one
   of three copies must put a book back to `available`, or the student view
   shows "1/3 available" with no Check Out button.

3. **A return names a loan, not a book.** `returnLoan(loanId)` frees exactly one
   copy and closes exactly one student's row.

4. **The teacher is the sole authority on a return.** A student's "Returned It"
   clears their own `currentBook` but does not free the copy. The teacher's list
   surfaces that as *"says they handed it back"* and sorts those to the top.

5. **A student never holds two books.** Enforced inside the checkout
   transaction, so it can't be raced.

6. **A copy count never drops below the copies that are out.** `adjustCopies()`
   is a transaction and refuses.

7. **Every class carries a last day of school.** On that date the roster is
   deleted and `firestore.rules` stops serving it. Rules are the real control;
   the purge in `retention.js` is opportunistic cleanup.

8. **Every call has a deadline.** A Firestore read that never settles throws
   nothing and catches nothing — the panel waiting on it shows "Loading…"
   forever with a clean console. `DEADLINE_MS` is 12s; only genuinely transient
   codes are retried, because retrying `permission-denied` just says no again.

---

## Bulk operations and import

`deleteBooks(ids)` removes several books in batches of 400 (Firestore caps a
batch at 500). Each batch is atomic, so a bulk delete cannot leave the shelf
half-cleared.

`importBooks(entries, { onProgress })` takes entries already grouped by
`spreadsheet.js` — one per distinct book, carrying a copy count — and writes
them in the same batches. Two things it deliberately does:

- **A title already on the shelf gains copies** rather than being added again,
  using the same `findExistingBook` identity rule as the Add flow. Importing
  the same file twice tops up counts instead of doubling the library.
- **Checkout state is not imported.** A row marked "Checked out" in another app
  names a student who does not exist here, and a copy marked out with no
  borrower could never be returned through the UI. Those copies arrive
  available, and the count is reported back so the teacher is told.

### Reading the spreadsheet

`public/js/spreadsheet.js` is parsing only — no DOM, no Firestore. It lazy-loads
SheetJS from jsDelivr (already in the CSP `script-src`; a different CDN would be
blocked silently). Two properties of these exports drive its design:

- **One row per physical copy.** Four copies of a title are four identical rows,
  so rows are grouped and the group size becomes `copies`. Importing them
  ungrouped is what would create the duplicate entries the Merge button cleans up.
- **ISBNs written as numbers.** They arrive in scientific notation
  (`9.780439023528E12`), and any ISBN-10 beginning with 0 has lost its leading
  zeros — `0061097314` comes back as `61097314`. Those are padded back out;
  verified against the ISBN-10 check digit on a real 436-row export, where it
  recovered 8 ISBNs and produced zero checksum failures.

## Errors

Every failure surfaces as a `TeacherApiError` with a `code` and a plain-English
`hint`, so a toast can say what to do instead of printing a Firestore enum.

| Code | Means |
|---|---|
| `permission-denied` | rules said no — often because the deployed ruleset is older than `firestore.rules` |
| `failed-precondition` | a composite index is missing |
| `bw/timeout` | the call passed `DEADLINE_MS` |
| `bw/no-session` | an API call ran before `openTeacherSession()` finished |
| `bw/not-a-teacher` | signed in, but no teacher/admin role |
| `bw/no-teacher-doc` | has the role, has no `teachers/{uid}` — needs an invite |
| `bw/already-has-book`, `bw/no-copies` | ordinary checkout outcomes, not faults |
| `bw/last-copy`, `bw/copies-out` | copy-count guards |
| `bw/code-not-live` | a join code could not be registered; the old one still works |

---

## Rules contract

What the teacher portal needs from `firestore.rules`, and why.

| Path | Requirement |
|---|---|
| `teachers/{uid}` | owner creates with `getAfter()` — the invite claim writes `users/{uid}` in the *same* transaction, so a plain `get()` sees no role and rejects every claim |
| `teachers/{uid}/history` | **the owning teacher may create rows**, not just students. Approvals and reconstructed returns are teacher-side writes |
| `teachers/{uid}/books` | students may update only the five checkout fields |
| `teachers/{uid}/classes/{cid}/students` | teacher reads are cut off by `classNotEnded()`; the student and admins keep access so withdrawal and erasure still work |
| `classCodes/{code}` | `get` yes, `list` no — a code is resolvable by whoever holds it, but the collection can't be harvested |
| `students/{uid}` | a teacher may write only `currentBook`, `currentBookTeacherId`, `addedTeachers` |
| `users/{uid}` | teachers may set ban fields on **students** only, and only with a non-null `banExpiry` — permanent bans stay admin-only |

**Admins run this portal too.** An account in `ADMIN_EMAILS` has role `"admin"`,
for which `isTeacher()` is false. Every rule above carries an `|| isAdmin()` arm.
`openTeacherSession()` also bootstraps a missing `teachers/{uid}` for them —
`auth.js` never creates one, so without it every panel was silently empty.

---

## Indexes

Declared in [`firestore.indexes.json`](firestore.indexes.json). All four are
required by queries that exist today; the file used to be empty.

| Collection | Fields | Used by |
|---|---|---|
| `users` | `bannedBy`, `banned` | teacher — active bans |
| `users` | `banned`, `bannedAt desc` | admin — recent activity |
| `accessRequests` | `status`, `requestedAt` | admin — access queue |
| `requests` | `studentId`, `bookId`, `status` | student — duplicate-request guard |

Adding a query with two or more filters means adding an entry here in the same
change. Builds are asynchronous — a new index takes minutes before its query
starts working.

---

## Retention

Student names and school emails are education records, so they have a defined
lifetime. Two halves, because there is no server:

- **Access** ends on the last day of school, enforced server-side by
  `classNotEnded()` in the rules, for everyone except admins.
- **Deletion** happens opportunistically, the next time a portal is opened.
  Teachers purge their own expired history; admins carry out roster erasure,
  because past the cutoff a teacher can no longer read the roster in order to
  delete it.

Checkout history is kept 2 years (`HISTORY_RETENTION_DAYS`), and only *closed*
loans are purged — a book still out is an active record. Erasure **redacts**
history rather than deleting it: the loan is the library's inventory record, the
name is the personal part.

Guaranteed on-time deletion would require a scheduled Cloud Function.

---

## Known gaps

- `student.js` and `admin.js` still mix UI and data access, and still write the
  book counters directly. They are correct, but not isolated the way this side
  now is.
- Class create/rename/date editing still uses `window.prompt()`. It works, but
  it's the last piece of the teacher UI with no real dialog.
- Checkout history is read in full by the live listener and by every export. It
  is bounded by the 2-year purge, but a very large library will feel it.
