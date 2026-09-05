# BookWare Architecture Map

Scope: `mysite/` only. `BookWare-main/` is a stale, undeployed duplicate and is
excluded entirely (per `CLAUDE.md`). All paths below are relative to
`mysite/` unless stated otherwise. Line numbers are for the file state at the
time this document was written and will drift as the code changes — treat
them as a starting point, not a promise.

There is no server. Every file in `public/js/` runs in the browser. "Backend"
in this app means: data-access code (`public/js/*-api.js`, and — for
`student.js`/`admin.js` — the files themselves), authorization
(`firestore.rules`), and query support (`firestore.indexes.json`).

---

## 1. Module dependency graph

### Static imports (`import … from`)

| File | Imports from (local) | Imports from (CDN) |
|---|---|---|
| `firebase.js` | — | `firebase-app.js`, `firebase-auth.js`, `firebase-firestore.js` (10.12.0) |
| `config.js` | — | — |
| `retention.js` | — | `firebase-firestore.js` |
| `books.js` | — | — (uses `fetch` to Open Library / Google Books directly, no SDK) |
| `theme.js` | `booklist.js` | — (uses `fetch` directly to LLM/search APIs) |
| `booklist.js` | — | — |
| `quiz.js` | `theme.js` | — |
| `welcome.js` | — | — (no Firestore import; receives save-callbacks from callers) |
| `qr.js` | — | dynamic `import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm')` |
| `preloader.js` | — | — |
| `spreadsheet.js` | `teacher-api.js` (for `normBookKey`) | dynamic `import(SHEETJS_URL)` (jsDelivr, pinned) |
| `auth.js` | `firebase.js`, `config.js` | `firebase-auth.js`, `firebase-firestore.js` |
| `login-notice.js` | `config.js` | — |
| `sw-register.js` | — | — |
| `theme-preload.js` | — | — (plain `<script>`, not a module — see §2) |
| `install-reveal.js` | — | — |
| `teacher-api.js` | `firebase.js`, `retention.js` | `firebase-firestore.js` |
| `teacher.js` | `firebase.js`, `config.js`, `books.js`, `theme.js`, `quiz.js`, `welcome.js`, `qr.js`, `preloader.js`, `retention.js`, `teacher-api.js` (as `api`) | `firebase-auth.js`; dynamic `import('./spreadsheet.js')`, dynamic `import(jsPDF via jsdelivr)`, dynamic `import(jspdf-autotable via jsdelivr)` |
| `student.js` | `firebase.js`, `config.js`, `books.js`, `theme.js`, `quiz.js`, `welcome.js`, `preloader.js` | `firebase-auth.js`, `firebase-firestore.js` |
| `admin.js` | `firebase.js`, `config.js`, `theme.js`, `qr.js`, `preloader.js`, `retention.js` | `firebase-auth.js`, `firebase-firestore.js` |
| `teacher-access.js` | `firebase.js`, `config.js` | `firebase-auth.js`, `firebase-firestore.js` |
| `teacher-signup.js` | `firebase.js`, `config.js` | `firebase-auth.js`, `firebase-firestore.js` |

Dynamic `import()` call sites:
- `qr.js:13` — `qrcode` library from jsDelivr, loaded lazily the first time a QR is rendered.
- `spreadsheet.js:31` — SheetJS, loaded lazily on first library import.
- `teacher.js:1148` — `./spreadsheet.js`, loaded when a teacher picks an import file.
- `teacher.js:1696-1697` — `jspdf` + `jspdf-autotable` from jsDelivr, loaded lazily for PDF export.

### Mermaid dependency graph

```mermaid
graph LR
  subgraph CDN["Firebase SDK (gstatic, pinned 10.12.0)"]
    FBApp[firebase-app.js]
    FBAuth[firebase-auth.js]
    FBStore[firebase-firestore.js]
  end

  firebase.js --> FBApp
  firebase.js --> FBAuth
  firebase.js --> FBStore

  config.js
  retention.js --> FBStore
  books.js
  booklist.js
  theme.js --> booklist.js
  quiz.js --> theme.js
  welcome.js
  qr.js -. dynamic .-> qrcode[qrcode@jsdelivr]
  preloader.js
  spreadsheet.js --> teacher-api.js
  spreadsheet.js -. dynamic .-> sheetjs[SheetJS@jsdelivr]

  auth.js --> firebase.js
  auth.js --> config.js
  auth.js --> FBAuth
  auth.js --> FBStore

  login-notice.js --> config.js
  sw-register.js
  theme-preload.js
  install-reveal.js

  teacher-api.js --> firebase.js
  teacher-api.js --> retention.js
  teacher-api.js --> FBStore

  teacher.js --> firebase.js
  teacher.js --> config.js
  teacher.js --> books.js
  teacher.js --> theme.js
  teacher.js --> quiz.js
  teacher.js --> welcome.js
  teacher.js --> qr.js
  teacher.js --> preloader.js
  teacher.js --> retention.js
  teacher.js --> teacher-api.js
  teacher.js --> FBAuth
  teacher.js -. dynamic .-> spreadsheet.js
  teacher.js -. dynamic .-> jspdf[jsPDF@jsdelivr]

  student.js --> firebase.js
  student.js --> config.js
  student.js --> books.js
  student.js --> theme.js
  student.js --> quiz.js
  student.js --> welcome.js
  student.js --> preloader.js
  student.js --> FBAuth
  student.js --> FBStore

  admin.js --> firebase.js
  admin.js --> config.js
  admin.js --> theme.js
  admin.js --> qr.js
  admin.js --> preloader.js
  admin.js --> retention.js
  admin.js --> FBAuth
  admin.js --> FBStore

  teacher-access.js --> firebase.js
  teacher-access.js --> config.js
  teacher-access.js --> FBAuth
  teacher-access.js --> FBStore

  teacher-signup.js --> firebase.js
  teacher-signup.js --> config.js
  teacher-signup.js --> FBAuth
  teacher-signup.js --> FBStore
```

### Entry points vs. shared libraries

**Entry points** (loaded directly by an HTML `<script type="module">` — see §2):
`auth.js` (index.html), `student.js`, `teacher.js`, `admin.js`,
`teacher-access.js`, `teacher-signup.js`, `login-notice.js`.

**Shared libraries** (never loaded directly by an HTML page; only reached via
`import`): `firebase.js`, `config.js`, `retention.js`, `books.js`, `theme.js`,
`booklist.js`, `quiz.js`, `welcome.js`, `qr.js`, `preloader.js`,
`spreadsheet.js`, `teacher-api.js`.

**Plain scripts, not modules** (loaded via `<script src=…>`, no `import`/`export`
at all — see §2 for why): `theme-preload.js`, `sw-register.js`,
`install-reveal.js`. `sw.js` is a Service Worker script registered by
`sw-register.js`; it runs in its own worker global scope, not the page.

**No-Firestore modules** (confirmed by grep — pure UI/logic, safe to reuse
anywhere, no `firebase-firestore` import and no `collection(db,…)`/`doc(db,…)`
calls): `books.js`, `theme.js`, `booklist.js`, `quiz.js`, `welcome.js`,
`preloader.js`, `qr.js`, `theme-preload.js`, `install-reveal.js`,
`sw-register.js`, `login-notice.js`.

---

## 2. Page → script → stylesheet map

All pages preconnect to Google Fonts and load Bootstrap Icons + the font CSS
from `fonts.googleapis.com` (blocking `<link rel="stylesheet">`, no
`defer`/`async` equivalent for CSS).

| Page | Stylesheets (in order) | Scripts (in order) |
|---|---|---|
| `index.html` | `index.css` | `login-notice.js` (module) → `auth.js` (module) → `sw-register.js` (`defer`) |
| `student.html` | `app.css`, `preloader.css` | `theme-preload.js` (blocking, plain `<script>`, head) → `student.js` (module, body end) → `sw-register.js` (`defer`) |
| `teacher.html` | `app.css`, `preloader.css` | `theme-preload.js` (blocking, plain, head) → `teacher.js` (module, body end) → `sw-register.js` (`defer`) |
| `admin.html` | `admin.css`, `preloader.css` | `theme-preload.js` (blocking, plain, head) → `admin.js` (module, body end) → `sw-register.js` (`defer`) |
| `teacher-access.html` | `signup.css` | `teacher-access.js` (module) → `sw-register.js` (`defer`) |
| `teacher-signup.html` | `signup.css` | `teacher-signup.js` (module) → `sw-register.js` (`defer`) |
| `privacy.html` | `privacy.css` | none |
| `ios.html` | `install.css` | `install-reveal.js` (`defer`) |
| `android.html` | `install.css` | `install-reveal.js` (`defer`) |

Notes:
- `type="module"` scripts are deferred by the HTML spec by default and execute
  in document order relative to each other, after the DOM is parsed but before
  `DOMContentLoaded`. `login-notice.js` therefore always finishes (or at least
  starts) running before `auth.js`.
- `theme-preload.js` is deliberately **not** a module and has neither
  `defer` nor `async` — it must block and run before first paint so the saved
  brightness/color theme applies before anything is visible (see its own header
  comment and `theme-preload.js:1-16`). It sets
  `document.documentElement.style.visibility = 'hidden'` until the portal's own
  JS clears it once auth resolves.
  - `index.html`, `privacy.html`, `teacher-access.html`, and
    `teacher-signup.html` do **not** load `theme-preload.js` at all — those
    pages ship a fixed dark palette, per the comment in
    `theme-preload.js:173-175`.
- `sw-register.js` is `defer`, not a module, and waits for the `load` event
  before calling `navigator.serviceWorker.register('/sw.js')`.
- CSP (see §6) forbids inline `<script>` (`script-src 'self' …`, no
  `'unsafe-inline'`) — this is explicitly why `login-notice.js`,
  `sw-register.js`, `install-reveal.js`, and `theme-preload.js` exist as
  separate files instead of inline blocks (each file's own header comment says
  so).

---

## 3. Data flow to Firestore

Every collection referenced anywhere under `public/js/`, found by grepping for
`collection(db, …)` / `doc(db, …)` across every JS file (not by reading
`firestore.rules` and assuming symmetry).

### `users/{uid}`
- **Read:** `auth.js` (`ensureUserDoc`, `completeLogin` role branches), `student.js` (role/ban check on load), `teacher-api.js` (`openTeacherSession`, `findStudentByEmail`, `listActiveBans`), `admin.js` (`loadAllUsers`, `loadSystemStats`, `loadRecentActivity`, `loadFirestoreStats`, `loadAuthStats`, ban-modal email lookup), `teacher-access.js`, `teacher-signup.js`.
- **Write:** `auth.js` (create on first sign-in, self-provision, admin role upgrade), `student.js` (create on first sign-in; clears own expired ban fields), `teacher-api.js` (`banStudent`/`liftBan` — ban fields only), `admin.js` (`banUser`/`unbanUser`, `deleteUserRecord`, `approveAccessRequest` sets role=teacher, auto-ban on repeated bad admin-login attempts), `teacher-access.js` (invite-claim transaction sets role=teacher), `teacher-signup.js` (same, via token claim transaction).
- **Rule:** `firestore.rules:85-127`, `match /users/{userId}`. Present and exercised on every field the client touches (role, banned/banExpiry/banReason/bannedBy/bannedAt). **Match: OK.**

### `students/{uid}` (+ `students/{uid}/recommendations/{recId}`)
- **Read:** `auth.js`, `student.js` (own doc, heavily), `teacher-api.js` (`listOpenLoans` reads `currentBook` per borrower), `admin.js` (`resetUserOnboarding`).
- **Write:** `auth.js` (`ensureUserDoc`/`provisionUser`), `student.js` (self-provision, wishlist, `currentlyReading`, `notifWishlist`, `readingProfile`, `welcomeSeenAt`, ban-expiry clear, `myRecIds`/`recommendations` subcollection), `teacher-api.js` (`checkoutToStudent`/`returnLoan` write `currentBook`/`currentBookTeacherId`; `removeStudentFromClass` writes `addedTeachers` via `arrayRemove`), `admin.js` (`resetUserOnboarding`, `deleteUserRecord` deletes the doc), `retention.js` (`eraseStudentFromTeacher`/`eraseStudentEverywhere` deletes/redacts related records — see `teachers/*` below, not this doc directly).
- **Rule:** `firestore.rules:130-158`, `match /students/{studentId}` plus nested `recommendations` match. The teacher-write path is deliberately narrowed to exactly `["currentBook", "currentBookTeacherId", "addedTeachers"]` (rules:144-146), matching the three fields `teacher-api.js` actually writes. **Match: OK**, and unusually well cross-referenced (the rule comment cites the exact functions).

### `teachers/{uid}`
- **Read:** almost every file — `student.js` (library browsing, teacher lookup, notifications), `teacher-api.js` (`openTeacherSession`, session bootstrap/backfill), `admin.js` (`loadAllLibraries`, `loadAllRentals`, retention sweeps), `retention.js`.
- **Write:** `auth.js`/`teacher-access.js`/`teacher-signup.js` (provision on invite claim or first sign-in), `teacher-api.js` (`patchTeacher` — `libraryPublic`, `requireApproval`, `currentlyReading`, `readingProfile`, `welcomeSeenAt`, `displayName`, `canInvite` backfill), `admin.js` (`approveAccessRequest` creates teacher doc), `admin.js` `deleteUserRecord` (deletes `teachers/{uid}`).
- **Rule:** `firestore.rules:161-174`. **Match: OK.**

#### `teachers/{uid}/books/{bookId}`
- **Read:** `student.js` (library book list, wishlist checks), `teacher-api.js` (`listBooks`), `admin.js` (`loadAllLibraries`/`showLibraryDetail`).
- **Write:** `teacher-api.js` (`addBook`, `adjustCopies`, `deleteBook(s)`, `importBooks`, `mergeDuplicateBooks`, checkout/return transactions), `student.js` (`requestCheckout` transaction updates `checkedOutCount`/`status`/`checkedOutBy`/`checkedOutAt`/`dueDate` directly — this is the one place a **student writes a teacher's book doc**, and the rule (rules:187-194) narrowly allows exactly those five fields).
- **Rule:** `firestore.rules:177-195`. **Match: OK** — the student-write carve-out lines up field-for-field with what `student.js:1790-1796` actually sets.

#### `teachers/{uid}/history/{histId}`
- **Read:** `teacher-api.js` (`listOpenLoans`, `watchHistory`, `listHistory`), `student.js` (`renderReadingStats` — own rows only), `admin.js` (`loadAllRentals`), `retention.js` (purge/redact sweeps).
- **Write:** `teacher-api.js` (`checkoutToStudent`, `returnLoan`, `reconstructReturn` — all as the teacher/admin), `student.js` (`requestCheckout` — `addDoc` as the student, `student.js:1817-1825`), `retention.js` (delete expired rows, redact on erasure).
- **Rule:** `firestore.rules:198-221`. Explicitly allows create by both the student and the owning teacher/admin, with a comment (`rules:202-209`) calling out the exact bug this fixed (approvals silently failing). **Match: OK.**

#### `teachers/{uid}/requests/{reqId}` ("Ask me first" checkout requests)
- **Read:** `teacher-api.js` (`listPendingRequests`), `student.js` (`submitRentalRequest` dedupe check, `renderRentalRequests`).
- **Write:** `student.js` (`submitRentalRequest` creates), `teacher-api.js` (`approveRequest` → `checkoutToStudent` updates status via transaction; `denyRequest` updates status).
- **Rule:** `firestore.rules:225-242`. **Match: OK.**
- **Index:** composite index required and present (`firestore.indexes.json:32-41`, `studentId`+`bookId`+`status`, matching `student.js:1868-1871`).

#### `teachers/{uid}/classes/{classId}` (+ `classes/{classId}/students/{sid}`)
- **Read:** `teacher-api.js` (`listClasses`, `countRoster`, `listRoster`), `student.js` (join flow, legacy invite-code fallback, `ensureLibraryAccessMarkers`), `retention.js` (roster purge, overdue scan).
- **Write:** `teacher-api.js` (`createClass`, `renameClass`, `setClassEndDate`, `deleteClass`, `removeStudentFromClass`), `student.js` (`joinLibraryByCode` creates the per-class roster row; `renderAddedTeachersList` deletes it on withdrawal), `retention.js` (purge, `rosterPurgedAt`/`archived` stamp, redaction).
- **Rule:** `firestore.rules:245-282`, including the `classNotEnded()` retention gate. **Match: OK.**

#### `teachers/{uid}/recommendations/{recId}` (teacher-curated recs)
- **Read:** `student.js` (`renderTeacherExtras`, notifications), `teacher-api.js` (`listRecommendations`).
- **Write:** `teacher-api.js` (`addRecommendation`/`removeRecommendation`).
- **Rule:** `firestore.rules:285-289`. **Match: OK.**

#### `teachers/{uid}/students/{sid}` (legacy flat roster / access marker)
- **Read/write:** `student.js` (`ensureLibraryAccessMarkers`, join/leave flows — this is the doc that actually gates Class-Only library reads per the rule on `books`), `teacher-api.js` (`removeStudentFromClass`), `retention.js` (purge/erasure).
- **Rule:** `firestore.rules:291-300`. **Match: OK.**

### `classCodes/{code}`
- **Read:** `student.js` (`joinLibraryByCode` — doc-ID `get`, no query).
- **Write:** `teacher-api.js` (`ensureClassCodeMapping`, `rotateClassCode`, `deleteClass`).
- **Rule:** `firestore.rules:317-341`. `allow list: if false` deliberately (comment explains this closes an enumeration hole a prior `collectionGroup` design had). **Match: OK.**

### `invites/{token}`
- **Read:** `teacher-signup.js` (`validateToken`), `teacher-access.js` (transaction get), `teacher-api.js` (`listInvites`), `admin.js` (`loadAdminInvites`).
- **Write:** `teacher-api.js` (`createInvite`, `revokeInvite`), `admin.js` (`createAdminInvite`, `revokeAdminInvite`), `teacher-access.js`/`teacher-signup.js` (claim transaction marks `used`).
- **Rule:** `firestore.rules:344-377`. **Match: OK** — the three-path update rule (admin / creator revoke / claimer marks used) matches the three call sites exactly.

### `accessRequests/{uid}`
- **Read:** `teacher-access.js` (own doc + live `onSnapshot`), `admin.js` (`loadAccessRequests`, `loadSettingsRequests`, `watchPendingRequests` live badge).
- **Write:** `teacher-access.js` (`requestAccessBtn` creates), `admin.js` (`approveAccessRequest`/`denyAccessRequest` update status).
- **Rule:** `firestore.rules:381-399`. **Match: OK.**
- **Index:** composite index present (`firestore.indexes.json:23-31`, `status`+`requestedAt`, matching `admin.js:786-790` and `:1203-1207`).

### `pendingUsers/{emailKey}`
- **Read:** `auth.js` (`peekPendingUser`).
- **Write:** `admin.js` (`submitAddUser` creates), `auth.js` (deletes after successful claim).
- **Rule:** `firestore.rules:404-414`. **Match: OK.**

### `admin/settings` (singleton doc under `admin/{doc}`)
- **Read:** `teacher-api.js` (`readAdminSettings`), `teacher.js`, `student.js` (maintenance/force-logout/ARIA-availability gate), `admin.js` (`loadSystemSettings`).
- **Write:** `admin.js` (`setMaintenanceMode`, `setAriaRoleEnabled`, `forceLogoutAll` stamps `sessionEpoch`).
- **Rule:** `firestore.rules:420-423`, `match /admin/{doc}` — read open to any signed-in user, write admin-only. **Match: OK.**

### `notifications/{userId}/…` — **rule with no client code (mismatch, flagged)**
- **Rule:** `firestore.rules:426-429` exists and is fully specified (own-user read, teacher/admin write), labeled "future FCM" in the rules comment.
- **Client code:** grepped across all of `public/js/` — the only hits for the string `notifications` are the *UI* concept (`renderNotifications()`, `notifBannerInner`, `#notifWishlist` toggle) in `student.js`, none of which touch a Firestore `notifications` collection. **No file reads or writes this collection.** This is dead/future-reserved surface: safe (default-deny elsewhere would have been worse), but worth knowing it does nothing yet.

### Non-BookWare collections in the same rules file (different apps, same project)
`routes/{id}` (mason-navigator) and `os_users`, `os_invites`, `os_teacherRequests`,
`os_settings`, `os_hostingStatus`, `sessionTemplates`, `occurrences` (+
`occurrences/{id}/signups`) (opensched) are declared in `firestore.rules:437-593`
but are **not referenced anywhere in `mysite/public/js/`** — confirmed by grep.
The rules file's own header comment (`firestore.rules:431-435`) explains this is
intentional: it is "the authoritative ruleset for the shared default database"
across multiple apps in the same Firebase project, namespaced apart from
BookWare's own collections. Not a BookWare bug, just worth knowing this rules
file is not BookWare-exclusive.

### Summary table

| Collection | Client read | Client write | Rule present | Index needed | Status |
|---|---|---|---|---|---|
| `users` | yes | yes | yes | yes (2, present) | OK |
| `students` (+`recommendations`) | yes | yes | yes | no | OK |
| `teachers` | yes | yes | yes | no | OK |
| `teachers/*/books` | yes | yes (incl. by students) | yes | no | OK |
| `teachers/*/history` | yes | yes (incl. by students) | yes | no | OK |
| `teachers/*/requests` | yes | yes | yes | yes (present) | OK |
| `teachers/*/classes(+/students)` | yes | yes | yes | no | OK |
| `teachers/*/recommendations` | yes | yes | yes | no | OK |
| `teachers/*/students` (legacy) | yes | yes | yes | no | OK |
| `classCodes` | yes | yes | yes | no (doc-ID get) | OK |
| `invites` | yes | yes | yes | no | OK |
| `accessRequests` | yes | yes | yes | yes (present) | OK |
| `pendingUsers` | yes | yes | yes | no | OK |
| `admin/settings` | yes | yes | yes | no | OK |
| `notifications` | **no** | **no** | yes | — | **Rule with no client code — unused/reserved** |
| `routes`, `os_*`, `sessionTemplates`, `occurrences` | **no** (different app) | **no** (different app) | yes | — | Not BookWare; shared-project rules file |

No collection was found that the client reads/writes **without** a matching
rule block — every read/write in the JS traced back to a `match` block that
permits it. The one asymmetry runs the other way: a rule exists
(`notifications`) with nothing in the client using it yet.

---

## 4. Auth / role model

### Sign-in path
1. `index.html` loads `auth.js` as a module. Three buttons (`studentLogin`,
   `teacherLogin`, `adminLogin`) each call `login(role, cardEl)`
   (`auth.js:443-472`) with a *client-asserted* desired role string
   (`"student" | "teacher" | "admin"`) — this string is only ever used to pick
   which redirect/branch to run in `completeLogin()`; it never grants a role by
   itself.
2. `login()` does `signInWithPopup(auth, GoogleAuthProvider)`, falling back to
   `signInWithRedirect` for popup-hostile environments
   (`auth.js:24-30`, `443-464`). `getRedirectResult()` is also polled on every
   load (`auth.js:475-508`) to finish a redirect-based sign-in.
3. `completeLogin(user, role)` (`auth.js:298-415`) is the actual role
   resolution:
   - **Admin button:** checks `isAdmin(user.email)` against
     `ADMIN_EMAILS` from `config.js` (**client-side check** —
     `auth.js:69, 301`). If the email isn't on the list, the user is signed
     out and shown a dialog; no `users` doc is touched. If it *is* on the
     list, `ensureUserDoc(user, "admin")` writes `role: "admin"`.
   - **Teacher button:** reads `users/{uid}`. Existing teacher/admin → let
     through. Existing student → reject with a dialog. No doc → check
     `pendingUsers/{emailKey}` (admin pre-registration) and provision as
     teacher if found, otherwise route to `teacher-access.html` (invite code
     or "request access" flow — never silently grants teacher).
   - **Student button:** default path; provisions a `students` doc.
4. All role-changing writes ultimately hit `firestore.rules`'s `users/{userId}`
   `create`/`update` rules (`firestore.rules:99-124`), which are the actual
   security boundary: self-serve `student` is unconditionally allowed;
   self-serve `admin` requires `isAdminEmail()` (server-side, checks
   `request.auth.token.email` against the **rules' own copy** of the admin
   list, `firestore.rules:53-63`); self-serve `teacher` requires
   `isSchoolOrAdminEmail()` (email ends in `@masonohioschools.com`, or is an
   admin) **or** `hasPendingRole("teacher")` (an admin pre-registered this
   exact email). An admin (`isAdmin()`, i.e. already has `role: "admin"` in
   `users/{uid}`) may create/update any user doc arbitrarily.

### Where role is persisted
- `users/{uid}.role` is the single source of truth for "what kind of account is
  this" (`"student" | "teacher" | "admin"`). Every portal's `onAuthStateChanged`
  handler re-reads this doc on every load (`student.js:240-263`,
  `teacher-api.js openTeacherSession:189-244`, `admin.js:141-162`) and redirects
  away if the role doesn't match the current portal.
- `teachers/{uid}` and `students/{uid}` are role-specific *profile* documents,
  created alongside `users/{uid}` but never consulted to decide role — only
  `users/{uid}.role` is.
- `ADMIN_EMAILS` is duplicated in two places that must be kept in sync by hand:
  `public/js/config.js:10-14` (client) and `firestore.rules:53-55`
  `adminEmailList()` (server). `CLAUDE.md` flags this explicitly. Both lists
  currently match (`sarvin.sukhe@gmail.com`, `sarvinsukhe@gmail.com`,
  `daepickid540@gmail.com`) — **no drift found** at the time of writing.
- `ALLOWED_DOMAIN = '@masonohioschools.com'` (`config.js:17`) is likewise
  mirrored as a regex in `firestore.rules:71`
  (`emailLower().matches('.*@masonohioschools[.]com')`) — also matching.

### What each role can reach (as implemented, not just as intended)
- **Student:** own `users`/`students` docs; any `teachers/{id}` profile doc
  (public directory — rules:162); a teacher's `books` only if that teacher's
  library is public or the student has a roster-membership marker
  (`teachers/{tid}/students/{uid}`); can write exactly 5 fields on someone
  else's `books/{bookId}` doc during self-checkout; can create `history` and
  `requests` rows as themselves; cannot read another student's `students` doc,
  another student's `recommendations`, or enumerate `classCodes`.
- **Teacher:** everything under their own `teachers/{uid}` subtree; any other
  teacher's profile doc (read-only, directory); the loan-tracking fields
  (`currentBook`, `currentBookTeacherId`, `addedTeachers`) on any student's
  `students/{uid}` doc; temp-ban/unban on `users/{uid}` **only if
  `role == "student"`** and only ban fields (rules:113-120) — a teacher cannot
  ban another teacher or issue a permanent ban (`banExpiry` must be non-null).
- **Admin:** unrestricted read/write on every BookWare collection
  (`isAdmin()` is an `||` arm on nearly every rule). Also runs the *teacher*
  portal UI (see below) with `role: "admin"`.
- **Admin-runs-teacher-portal quirk:** `teacher-api.js:184-199` explicitly
  bootstraps a `teachers/{uid}` doc for an admin account that signs into
  `teacher.html`, because `auth.js` never creates one for admins (admins are
  routed straight to `admin.html`). This is the specific case `CLAUDE.md`
  calls out: "`isTeacher()` is **false** for admins," and every rule the
  teacher portal depends on needs an explicit `|| isAdmin()` arm. Verified
  present on all of: `teachers/{id}` create/update, `books` create/update/
  delete, `history` create/update/delete, `requests` update/delete, `classes`
  write, `classes/*/students` create/delete, `recommendations` write,
  `classCodes` create/delete/update, legacy `students` create/delete.

### Client-side-only decisions (flagged explicitly, per the task)
These are UX/routing conveniences, not security boundaries — the matching
server-side rule is cited for each so it's clear the real gate is elsewhere:
1. **`auth.js:69` `isAdmin(email)`** — decides which dialog/redirect to show
   during sign-in. Real gate: `isAdminEmail()` in `firestore.rules:61-63`
   (used inside the `users` create/update rules).
2. **`teacher.js:195` `isAllowlistedAdmin`** and **`config.js:19-20`
   `isAdminEmail()`** — used client-side to decide whether to apply the
   maintenance-mode/force-logout gate to the current session. Real gate:
   nothing stops a non-exempt account from being maintenance-gated server-side
   either (the exemption is a UX nicety, not a privilege escalation risk,
   since `admin/settings` write is still admin-only per rules).
3. **`config.js:22-25` `isTeacherEmail()`** — used by `teacher.js:187` and
   `teacher-access.js:175`/`teacher-signup.js:79` to short-circuit obviously
   wrong sign-ins before hitting Firestore. Real gate:
   `isSchoolOrAdminEmail()` / `hasPendingRole()` in the `users` create rule.
4. **`admin.js:143-162` auto-ban after 3 failed admin-portal attempts** — the
   *attempt counter* lives in `localStorage` (`bw-admin-attempts-{uid}`,
   client-only, trivially clearable), but the resulting ban write
   (`users/{uid}.banned = true`) is a normal write validated by the standard
   `users` update rule, so the actual ban still requires the write to be
   permitted server-side (in this case it succeeds because... **note:** the
   client is signed in as the *user being banned*, and the standard "own doc"
   update rule (`firestore.rules:121-124`) explicitly excludes the `banned`
   key from what a non-admin can touch on their own doc — so this specific
   self-ban write should be **rejected by the rules** for a non-admin caller.
   This looks like a latent bug: the auto-ban best-effort write
   (`admin.js:156`, wrapped in `try {} catch (_) {}`) likely fails silently
   against `firestore.rules` every time, meaning repeated bad admin-login
   attempts are probably never actually persisted as a ban. Worth verifying
   against the Firestore emulator/logs; not fixed here per the "documentation
   only" scope of this task.
5. **`teacher-api.js:1189-1199` `setDisplayName` length check (60 chars)** —
   client-side validation only; `firestore.rules` places no length limit on
   `teachers/{uid}.displayName`, so a direct SDK call could set a longer one.
   Low risk (display-only field, escaped with `esc()` everywhere it's
   rendered) but technically a client-only constraint.
6. **ARIA AI provider/API keys** (`theme.js`) — which LLM/search provider is
   "active," and the API keys themselves, live in `localStorage` per browser
   (`ARIA_PROVIDER_KEY`, `ARIA_PROVIDER_KEYS`, `theme.js:443-450`). This is a
   user preference, not a role/permission decision, but it means every ARIA
   call goes **directly from the student/teacher/admin's browser** to a
   third-party API with a key the user typed in themselves — there is no
   server-side proxy, quota control, or content moderation in front of it.

---

## 5. Firestore rules — match block by match block

(`mysite/firestore.rules`, in file order)

| Match block | Read | Write | Key gating |
|---|---|---|---|
| `users/{userId}` (85-127) | Self, any teacher, any admin | Create: self as student always; self as admin if `isAdminEmail()`; self as teacher if school/admin email or `hasPendingRole`; admin can create for anyone. Update: admin anything; self-promote-to-admin if `isAdminEmail()` (role only); teacher can toggle ban fields on a *student* only; everyone else can touch their own doc except role/ban fields. Delete: admin only. | `isAdmin()`, `isAdminEmail()`, `isSchoolOrAdminEmail()`, `hasPendingRole()` |
| `students/{studentId}` (130-149) | Self, any teacher, any admin | Create: self only. Update: self (non-ban fields, must not be banned) OR teacher (only `currentBook`/`currentBookTeacherId`/`addedTeachers`) OR admin. Delete: admin only. | `isTeacher()`, `notBanned()`, field-diff `hasOnly` |
| `students/{studentId}/recommendations/{recId}` (151-157) | Self, teacher, admin | Self only (must not be banned) | `notBanned()` |
| `teachers/{teacherId}` (161-174) | Any signed-in user (public directory) | Create: self (if `users` role will be teacher/admin, via `getAfter`) or admin. Update: self-if-teacher, or admin. Delete: admin only. | `getAfter()` (same-transaction read), `isTeacher()`, `isAdmin()` |
| `teachers/*/books/{bookId}` (177-195) | Admin; owning teacher; any signed-in user if library is public or they're on the roster marker | Create/delete: owning teacher or admin. Update: owning teacher/admin, **or** a non-banned student touching only `status`/`checkedOutBy`/`checkedOutAt`/`dueDate`/`checkedOutCount`, gated by public-or-enrolled | `isStudent()`, `notBanned()`, field-diff `hasOnly`, `libraryPublic` / roster-marker `exists()` |
| `teachers/*/history/{histId}` (198-221) | Owning teacher, admin, or the student who owns that row | Create: student (non-banned) OR owning teacher/admin. Update/delete: owning teacher or admin only. | `isStudent()`, `notBanned()`, `isTeacher()` |
| `teachers/*/requests/{reqId}` (225-242) | Owning teacher, admin, or the requesting student | Create: student only, must self-assert `status: "pending"` and own `studentId`, gated by public-or-enrolled. Update/delete: owning teacher or admin. | `isStudent()`, `notBanned()`, `libraryPublic` / roster marker |
| `teachers/*/classes/{classId}` (245-283) | Any signed-in user | Write: owning teacher or admin | — |
| `…/classes/{classId}/students/{sid}` (267-282) | Student themself, admin, or owning teacher **if `classNotEnded()`** | Create: student or teacher, gated by `classNotEnded()` (admin exempt). Delete: teacher, student, or admin. Update: admin only. | `classNotEnded()` — the actual server-side enforcement of the retention/last-day-of-school policy |
| `teachers/*/recommendations/{recId}` (285-289) | Any signed-in user | Owning teacher or admin | — |
| `teachers/*/students/{sid}` legacy flat roster (291-300) | Owning teacher, the student themself, or admin | Create: student or teacher. Delete: teacher, student, or admin. Update: admin only. | — |
| `classCodes/{code}` (317-341) | `get` only (no `list`) by any signed-in user | Create: teacher/admin, must self-assert `teacherId`. Delete: admin, or owning teacher. Update: owning teacher/admin repointing their own code to their own class only. | `isTeacher()`, `isAdmin()`, doc-ID-as-code design avoids needing an index |
| `invites/{token}` (344-377) | `get` open to everyone (even signed out — claim page validates before sign-in); `list` teacher/admin only | Create: admin, or teacher with `canInvite == true`. Update: admin (anything); creator (revoke fields only); claimer (marks `used`, must match `recipientEmail` if set, one-shot). Delete: admin only. | `canInvite` flag on `teachers/{uid}` |
| `accessRequests/{reqId}` (381-399) | Requester or admin | Create: requester only, must be `status: "pending"`. Update: admin, or requester resubmitting to pending. Delete: admin or requester (withdraw). | — |
| `pendingUsers/{emailKey}` (404-414) | `get`: only the matching email's own signed-in user. `list`: admin only. | Create/update: admin only. Delete: admin, or the matching user (self-claim cleanup). | Email-match via `request.auth.token.email.lower()` |
| `admin/{doc}` (420-423) | Any signed-in user | Admin only | — |
| `notifications/{userId}/**` (426-429) | Owner only | Admin or teacher | Declared, unused (see §3) |
| `routes/{id}` (438-441) | Public, append-only | Create only (no update/delete) | Different app (mason-navigator) |
| `os_*`, `sessionTemplates`, `occurrences` (445-593) | Various | Various | Different app (opensched); own `osUserRole()`/`isOsAdmin()`/`isOsTeacher()` helper functions, fully separate from BookWare's `userRole()`/`isAdmin()`/`isTeacher()` |
| `{document=**}` catch-all (596-598) | Deny | Deny | Default-deny backstop |

**Helper functions** (`firestore.rules:6-82`): `isSignedIn()`, `uid()`,
`userRole()` (reads `users/{uid}.role`), `isAdmin()`/`isTeacher()`/`isStudent()`
(role equality checks), `isBanned()`/`notBanned()` (checks `banned` + `banExpiry`
vs. `request.time`), `allowedEmail()` (currently just `isSignedIn()` — the
comment at rules:42-49 explains students can be any Google account so a
domain check would lock them out; this is intentionally permissive, and the
comment warns not to rely on it to protect secrets), `adminEmailList()`/
`isAdminEmail()`/`isSchoolOrAdminEmail()` (email-based checks mirroring
`config.js`), `hasPendingRole(role)` (checks `pendingUsers`).

---

## 6. Cross-cutting concerns

### Service worker (`public/sw.js`, registered by `sw-register.js`)
- Cache name `bookware-v8` (`sw.js:17`); precaches an explicit shell list
  (`sw.js:18-62`) covering every HTML page, every CSS file, and every JS file
  that is a page entry point or an unconditionally-needed shared module — but
  **not** the lazily-`import()`ed ones (`spreadsheet.js`, `qr.js` is included
  at `sw.js:54` even though it's a shared module reached only via import from
  `teacher.js`/`admin.js`; the CDN-hosted `qrcode`/`jspdf`/`jspdf-autotable`/
  SheetJS bundles are never precached and always go straight to network).
- Strategy is **network-first** for everything same-origin, both HTML
  (`sw.js:115-128`) and static assets (`sw.js:129-152`), with cache fallback
  only on failure/offline. The header comment (`sw.js:10-16`, `130-138`)
  explains this replaced an earlier cache-first strategy that shipped stale
  JS indefinitely after every deploy.
- Cross-origin requests (Firebase, Google, jsDelivr, the LLM APIs) are passed
  through untouched — the fetch handler bails out immediately if
  `url.origin !== self.location.origin` (`sw.js:111`).
- `firebase.json:10-23` sets `Cache-Control: no-cache, no-store, must-revalidate`
  specifically on `/sw.js` so the browser always re-checks for a new worker.

### Theme system (`theme-preload.js` + `theme.js`)
- `theme-preload.js` is the **single source of truth** for the brightness→color
  math (`computeThemeVars()`, exported as `window.BookWareTheme`) — its header
  comment explicitly states this used to be duplicated in `theme.js` and the
  two drifted, causing a light theme with unreadable text. `theme.js` now
  calls the same function via `window.BookWareTheme` rather than
  reimplementing it (confirmed no duplicate math in `theme.js`).
  - `theme.js` also imports from `booklist.js` (`pickBooksForProfile`,
    `formatBooksForPrompt`) to ground ARIA's book recommendations in a curated
    reading list rather than pure LLM invention (`booklist.js:1-12`).
- Persistence: `localStorage['bookware-brightness']` (0-100 slider),
  `localStorage['bookware-color']` (accent hue). Read before paint by
  `theme-preload.js:187-199` to avoid a flash of the wrong theme.
- `theme-preload.js` also updates `<meta name="theme-color">` to match the
  live background so an installed PWA's OS chrome (status bar / task switcher)
  matches the in-app theme (`theme-preload.js:158-179`).

### Retention (`retention.js`)
- Single definition of two policy constants: `HISTORY_RETENTION_DAYS = 730`
  (2 years) and `ROSTER_GRACE_DAYS = 0` (access ends exactly on the last day
  of school, no grace).
- Explicitly **opportunistic**, not scheduled — the module's own header
  comment states BookWare has no server/Cloud Functions, so purges only run
  when a teacher or admin portal loads. The *access* cutoff, however, is
  enforced unconditionally and immediately by `firestore.rules`'s
  `classNotEnded()` (server-side, evaluated on every request) — deletion is
  "only half the control," per the file's own framing.
- `runRetentionSweep()` (teacher-triggered, `teacher-api.js:1218-1226`) purges
  only that teacher's own expired history + attempts roster purges (which only
  succeed for classes that teacher can still read — i.e., not yet past the
  cutoff, since the rule denies the teacher read access exactly at the cutoff).
- `runAdminRetentionSweep()` (admin-triggered, `admin.js:183-189`) is what
  actually deletes rosters **after** they've expired, because only an admin
  retains read access past the cutoff (rules:271-273, `uid() == teacherId &&
  classNotEnded()` — the teacher's own access is gated by the same function
  that stops the purge from being self-served).
- `eraseStudentEverywhere()` walks every `teachers/{id}` doc to scrub one
  student's name from every roster and redact (not delete) their history rows
  — used by `admin.js deleteUserRecord()` so "permanently delete" is actually
  complete, not just deleting `users`/`students`/`teachers` docs and leaving
  the person's name in every class they ever joined.

### Content-Security-Policy (`firebase.json:33-61`)
Applies to `**` (every response). No `'unsafe-inline'` for scripts — this is
why several files exist purely to move inline logic into `<script src>` (see
§2). Allowed external origins, by directive:

- **`script-src`**: `https://www.gstatic.com`, `https://apis.google.com`,
  `https://cdn.jsdelivr.net`
- **`style-src`**: `'unsafe-inline'` (styles only), `https://cdn.jsdelivr.net`,
  `https://fonts.googleapis.com`
- **`font-src`**: `https://cdn.jsdelivr.net`, `https://fonts.gstatic.com`
- **`img-src`**: `data:`, `https://covers.openlibrary.org`,
  `https://archive.org`, `https://*.archive.org`, `https://books.google.com`,
  `https://lh3.googleusercontent.com`, `https://books.googleusercontent.com`
- **`connect-src`**: `https://*.googleapis.com`, `wss://*.googleapis.com`,
  `https://*.gstatic.com`, `https://*.firebaseio.com`,
  `wss://*.firebaseio.com`, `https://openlibrary.org`,
  `https://www.googleapis.com`, `https://api.groq.com`,
  `https://api.anthropic.com`, `https://api.openai.com`,
  `https://api.cloudflare.com`, `https://openrouter.ai`,
  `https://contextwire.dev`, `https://api.search.brave.com`,
  `https://serpapi.com`
- **`frame-src`**: `https://accounts.google.com`, `https://*.firebaseapp.com`
- **`worker-src`**: `'self'` (the service worker)
- `object-src 'none'`, `base-uri 'self'`, `default-src 'self'`

Every one of the LLM/search origins in `connect-src` is used by `theme.js`
(ARIA), confirmed by grep — none are vestigial. `archive.org`/`books.google.com`/
`lh3.googleusercontent.com`/`books.googleusercontent.com` are book-cover image
hosts surfaced by `books.js`'s Open Library / Google Books search results.

---

## 7. External dependencies

| Origin | Used by | Purpose |
|---|---|---|
| `www.gstatic.com` | `firebase.js` and every file that imports Firebase SDK modules | Firebase App/Auth/Firestore SDK (pinned `10.12.0`) |
| `apis.google.com` | Google Sign-In popup/redirect flow (via Firebase Auth) | OAuth |
| `accounts.google.com` | Google Sign-In (frame) | OAuth |
| `*.firebaseapp.com` | Auth redirect flow (frame) | OAuth handoff |
| `*.googleapis.com`, `*.firebaseio.com` (+ `wss://`) | Firestore SDK realtime channel | Firestore reads/writes/`onSnapshot` |
| `cdn.jsdelivr.net` | `qr.js` (qrcode lib), `spreadsheet.js` (SheetJS), `teacher.js` (jsPDF + jspdf-autotable), plus Bootstrap Icons CSS loaded directly from every HTML page's `<head>` | Lazy-loaded libraries; icon font |
| `fonts.googleapis.com` / `fonts.gstatic.com` | Every HTML page's `<head>` | Web fonts (DM Serif Display, DM Sans) |
| `openlibrary.org` / `covers.openlibrary.org` | `books.js` | Primary book search + cover images (no API key) |
| `www.googleapis.com/books/v1` | `books.js` | Fallback book search (Google Books) |
| `archive.org`, `books.google.com`, `lh3.googleusercontent.com`, `books.googleusercontent.com` | `books.js` results rendered as `<img>` | Book cover image hosts |
| `api.groq.com`, `api.openai.com`, `api.anthropic.com`, `openrouter.ai`, `generativelanguage.googleapis.com` (Gemini — covered by the `*.googleapis.com` wildcard), `api.cloudflare.com` | `theme.js` (`callOpenAI`, `callAnthropic`, `callGemini`, `callCloudflare`) | ARIA chat/recommendation LLM backends — user-supplied API key, called directly from the browser, no server proxy |
| `contextwire.dev`, `api.search.brave.com`, `serpapi.com` | `theme.js` (`searchContextWire`, `searchBrave`, `searchSerpApi`) | Optional web-search grounding for ARIA — also user-supplied API key, direct from browser |

No origin appears in the client code that is missing from the CSP, and no CSP
entry (aside from the general `*.googleapis.com`/`*.gstatic.com`/
`*.firebaseio.com` wildcards, which cover more than BookWare strictly needs)
looks unused.

---

## Known-debt notes carried from `CLAUDE.md` and confirmed in code

- `student.js` and `admin.js` mix Firestore access directly into UI code
  (confirmed: both import `firebase-firestore.js` directly and call
  `collection(db, …)`/`doc(db, …)` throughout their own bodies). `teacher.js`
  does not — it only imports `teacher-api.js` and never touches
  `firebase-firestore.js` directly (confirmed by grep — no such import in
  `teacher.js`). This is the one place the codebase's own stated layering rule
  is fully honored.
- `teacher-signup.js` and `teacher-access.js` are two independent, mostly
  duplicated invite-claim implementations (compare `teacher-signup.js:93-120`
  to `teacher-access.js:182-214` — nearly identical transactions). Different
  entry points (`?token=` query param vs. a page reached after a failed
  sign-in), but the invite-claim logic itself is copy-pasted, not shared.
