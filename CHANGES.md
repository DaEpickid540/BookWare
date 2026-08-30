# BookWare — Change Log

---

## Release history

### v2.1 — 2026-08-29

**Joining a class**
- Class codes can now be shared as a link or a QR code as well as read aloud.
  Each class card gets **Link & QR**; following the link signs a student in and
  joins them automatically, with no code to type.
- Fixed: a student who joined with a class code was denied every book read,
  checkout and rental request in any library that was not Public. The join
  wrote only the per-class roster, while the security rules grant library
  access off the flat roster. Joins now write a PII-free membership marker
  there too, and existing students are repaired automatically on next sign-in.
- Fixed: joining a teacher's second class silently did nothing if you were
  already in their first.
- Fixed: removing a library left the old row on screen until reload.
- Removing a student, or the school year ending, now actually revokes their
  access to that library's books.

**Checking books in and out**
- The teacher's checkout setting is now two named modes — **Automatic**
  (students borrow directly, every loan logged) and **Ask me first** (requests
  route to the Students tab for approval) — instead of one switch whose off
  state explained nothing.
- Every book now shows a checkout control in some state, with the reason when
  it is unavailable, rather than a bare disabled button or nothing at all.
- Returns: when a student marks a book handed back, the teacher's Currently
  Checked Out list flags it and sorts it to the top, and the student sees it as
  awaiting confirmation instead of it vanishing. A return with no open history
  row is now logged rather than lost.

**ARIA**
- Admins can switch ARIA off for students and for teachers independently
  (System Settings → ARIA AI Availability). Saved keys and preferences are left
  untouched, so switching a role back on restores what they had.

**Onboarding**
- Added the first-run intro slideshow, which the admin portal's "Replay
  Onboarding" button had been promising since it was written but which did not
  exist. Replayable any time from Settings → Getting Started.
- Both first-run steps now run after the splash screen clears; the reading quiz
  had been opening behind it.

**Interface**
- Renamed the Library page cards that described only part of their contents
  ("Select a Library" over a card that was mostly a book list).
- Loading placeholders show a spinner instead of bare "Loading…" text.
- Fixed: collapsed sidebar icons sat flush against the left edge, and the
  collapse toggle overflowed the rail.
- Fixed: buttons in the Add a Book search results spilled outside their cards.
- The teacher's Your Books panel is taller and scrolls internally.
- Fixed: adding more copies of a book already on the shelf created a second
  entry instead of incrementing the first, because matching required an exact
  ISBN or Google volume id. Existing duplicates can be folded together with
  **Merge duplicates**.
- Sign Out and the Settings close button no longer depend on the rest of
  start-up having succeeded, and the teacher portal has Sign Out in the sidebar
  rather than only inside Settings.
- Fixed: one failing start-up step abandoned every step after it, leaving the
  Library tab's panels stuck on "Loading…" until a nav round-trip reran them.

---

_Below: the original autonomous rebuild session log, updated after each phase._

---

## Audit

**Audit completed — see AUDIT.md for full details.**

Firebase project: `bookware-site2` (hosted at `bookware-site.web.app`)  
Admin emails: `sarvin.sukhe@gmail.com`, `daepickid540@gmail.com`

**Pages found:**
- `index.html` — landing portal (Student / Teacher / Admin cards, Google OAuth)
- `student.html` — 5-page SPA: Library, Locker, Wishlist, Profile, Settings
- `teacher.html` — 6-page SPA: Library, Students, Now Reading, Recommendations, Invite Teachers, Settings
- `admin.html` — 5-page SPA: Dashboard, Users, Bans, Settings, Debug
- `teacher-signup.html` — one-time invite claim (token from URL)

**All features documented in AUDIT.md.**

---

## Deleted

Removed all source files from `mysite/public/`:
- 5 HTML files
- 9 CSS files (`variables.css`, `base.css`, `layout.css`, `components.css`, `responsive.css`, `index.css`, `student.css`, `teacher.css`, `admin.css`)
- 7 JS files (`firebase.js`, `auth.js`, `books.js`, `student.js`, `teacher.js`, `admin.js`, `teacher-signup.js`)

**Preserved:** `.firebaserc`, `firebase.json`, `firestore.rules`, `.git`

---

## Built - HTML

All 5 pages rebuilt with semantic structure and ARIA attributes:

| File | Key improvements |
|---|---|
| `index.html` | `role="list"` on card grid, `role="listitem"` on cards, `aria-label` on all buttons, `hidden` attr for error/overlay |
| `student.html` | All 5 pages in single SPA, `aria-current="page"` on nav, `role="list"` on book containers, proper `<label>` for all toggles |
| `teacher.html` | Same improvements, `hidden` attr on biweekly banner, proper `<label>` elements |
| `admin.html` | `role="dialog"` on ban modal, `aria-modal="true"`, `aria-labelledby`, proper `<label for>` in form groups |
| `teacher-signup.html` | `role="status"` on status message, `aria-live="polite"` |

---

## Built - CSS

Consolidated 9 CSS files down to 4:

| File | Purpose |
|---|---|
| `css/app.css` | Complete design system shared by student + teacher portals |
| `css/index.css` | Landing page only |
| `css/admin.css` | Admin portal |
| `css/signup.css` | Teacher invite signup page |

**Design tokens:**
- Dark bg: `#1a1a1e` (dark gray, never pure black) — dark mode default
- Card bg: `#22222a`
- Default accent: `#e74c3c` (red)
- Light mode: `#ffffff` bg, `#f5f5f8` card
- 6 accent color overrides via `html[data-color]`
- 6 theme presets (Midnight → Snow)
- Brightness slider: 0–100 interpolating all CSS vars live
- `[hidden] { display: none !important }` added to app.css and admin.css for cross-browser safety

---

## Built - JS

| File | What was done |
|---|---|
| `firebase.js` | Unchanged logic; uses `visibility` on `documentElement` not body |
| `auth.js` | Cleaned up; same Google OAuth login flow |
| `books.js` | Unchanged (was already solid — Open Library + Google Books fallback) |
| `theme.js` | **NEW** — extracted shared brightness/color/preset/ARIA logic from student+teacher; `initARIA(toastFn?)` accepts optional toast callback |
| `student.js` | Rewrote all template literals with single-quote attrs; fixed wishlist icon escaping; uses `theme.js`; `initARIA(toast)` wired; added 400ms debounce to Google Books wishlist search |
| `teacher.js` | Fixed `renderLibraryList` syntax error; fixed double `lookupISBN` call (was calling API twice per ISBN); uses `theme.js`; `initARIA(toast)` wired |
| `admin.js` | Cleaned up; proper `hidden` attribute toggling on ban modal |
| `teacher-signup.js` | Minor cleanup only |

---

## Security

**Full security audit performed across all JS, localStorage, fetch calls, and auth flows.**

### Authentication
- **No plain-text passwords anywhere.** All authentication uses Firebase's `signInWithPopup` with Google OAuth. Firebase handles all credential storage and transmission securely. Our code never sees, stores, or transmits a password.
- No `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, or any custom auth — confirmed with grep.
- No custom session tokens rolled by our code.

### Network calls
- Only one `fetch()` in the entire codebase — in `books.js`, calling Open Library and Google Books public APIs. No credentials sent.
- All Firestore operations go through the Firebase SDK over HTTPS with proper auth tokens managed by Firebase.

### localStorage / sessionStorage
| Key | Value stored | Assessment |
|---|---|---|
| `bookware-brightness` | number 0–100 | ✅ Safe |
| `bookware-color` | color name string | ✅ Safe |
| `bookware-preset` | preset name string | ✅ Safe |
| `bw-aria-enabled` | `"true"` / `"false"` | ✅ Safe |
| `bw-aria-groq-key` | User's own Groq API key | ⚠️ See note |
| `bookware-biweekly-{uid}` | timestamp | ✅ Safe |
| `bw-admin-attempts-{uid}` | array of timestamps | ✅ Safe |
| `bw-welcomed` (session) | `"1"` | ✅ Safe |

**Groq API key note:** The ARIA AI feature stores the user's personal Groq API key in localStorage. This is a deliberate design choice documented in the UI: _"Your key is stored only in your browser. It never touches our servers."_ The key is the user's own account key, never sent to our servers, and goes directly browser→Groq. No hashing is applied because the raw key is needed to call Groq's API. The CSP headers in `firebase.json` restrict `connect-src` to an allowlist, reducing XSS risk. **The ARIA chat feature is UI-only in the current build** — the key is stored but no Groq API calls are currently made, so the key is not actually transmitted anywhere at this time.

### Firebase API key (`firebase.js`)
The `apiKey` in `firebase.js` is a Firebase **client-side identifier**, not a secret. It is designed to be public, visible in source, and is required for the Firebase SDK to connect. Access is controlled by Firebase Security Rules, authorized domains, and App Check — not by keeping the key secret. This is standard Firebase architecture.

### Verdict
**No security issues found.** No action required beyond the documentation above.

---

## Deploy

### Initial deploy
`firebase deploy --only hosting` from `mysite/`  
17 files uploaded · Release complete  
**URL:** https://bookware-site.web.app  
Git commit: `a90e739`

### Post-fix re-deploy
Fixed: double `lookupISBN` API call, `initARIA` toast feedback, `[hidden]` CSS rule, wishlist search debounce.  
17 files re-uploaded · Release complete  
Git commit: see below

---

## Polish Pass (autonomous session)

**Executed without pauses. All changes deployed.**

### Favicon + Meta
- Created `public/favicon.svg` — book + red dot logo, works on all sizes
- Added `<link rel="icon">`, `<link rel="apple-touch-icon">`, `<meta name="description">`, `<meta name="theme-color" content="#1a1a1e">` to all 5 HTML pages

### CSP improvements (firebase.json)
- Added `https://api.groq.com` to `connect-src` — enables ARIA AI calls when chat is implemented
- Added `https://books.googleusercontent.com` to `img-src` — covers some Google Books cover URLs that were being blocked

### Admin theme support
- Added full theme preset grid + brightness slider to admin Settings page (`admin.html`)
- `admin.js` now imports and calls `initTheme()` from `theme.js` — admin portal now respects brightness/preset/accent stored in localStorage
- `admin.css` gains `theme-preset-grid`, `theme-preset`, `brightness-slider`, `brightness-slider-row` styles

### Loading skeletons
- Added `@keyframes shimmer` + `.skeleton`, `.skeleton-book-row`, `.skeleton-book-cover`, `.skeleton-book-info`, `.skeleton-line-*` classes to `app.css`
- `student.js` `loadTeacherBooks()` now shows 6 skeleton rows while fetching — no more blank flash
- `teacher.js` `loadLibrary()` now shows 6 skeleton rows while fetching

### Animation + polish
- Landing page portal cards now stagger in with `cardFadeUp` animation (delays: 0.05s, 0.12s, 0.19s)
- Heading and subheading fade up on load
- `.page-title` gets `transition: opacity 0.12s ease` for smooth page-switch feel

### Deploy
18 files (was 17 — favicon.svg added). Release complete.
URL: https://bookware-site.web.app

---

## Feature Implementation Pass (Task 2)

**Full feature spec implemented. See UPGRADES.md for complete audit.**

### Rental Request / Approval Workflow ✅
- New `teachers/{uid}/requests/{reqId}` Firestore collection with rules
- Teacher: **"Require Checkout Approval"** toggle in Library Settings — when ON, students see "Request Checkout" instead of "Check Out"
- Teacher: **Pending Requests** panel on Students page — approve triggers checkout transaction, deny marks request denied
- Student: `submitRentalRequest()` creates pending request doc
- Student: **Rental Requests** section in Locker page shows pending/approved/denied status with color-coded cards
- Firestore rules: students can create requests for enrolled/public libraries; teachers can approve/deny; students read their own

### CSV Export ✅
- Teacher Students page: **Export .CSV** button alongside .MD
- Format: Book Title, Author, Student, Date Out, Due Date, Date Returned, Status
- Admin Rentals page: global CSV export across all teachers

### QR Code for Invites ✅
- After generating an invite link, a QR code appears using Google Charts API (`chart.googleapis.com`)
- CSP img-src updated to allow `chart.googleapis.com`
- QR shows immediately; resolves to invite URL when scanned

### Email Share for Invites ✅
- **Share via Email** button appears after invite is generated
- Opens `mailto:` with pre-filled subject and body including the invite link, locked email, and teacher name

### Admin — All Libraries Page ✅
- New **Libraries** nav item in admin sidebar
- Table: teacher name, email, book count, visibility (Public/Class Only), approval mode
- Click "View Books" to drill into a teacher's library with copy/status breakdown

### Admin — All Rentals Page ✅
- New **Rentals** nav item in admin sidebar
- Stats row: Total Rentals, Active Now, Overdue (red), Returned
- Filterable table: all checkout history across all teachers
- CSV export of all rentals

### Admin — Organized Settings Panels ✅
- Settings page redesigned into 4 labeled card panels: System, Appearance, Data, Danger Zone
- Each panel has clear icon, label, and subsettings rows
- Signed-in email moved into System panel
- Danger zone has warning-colored border

### Admin — Confirm Modal ✅
- `appConfirm()` replaces `window.confirm()` for delete/ban/revoke actions
- Styled modal with Cancel/Confirm buttons — no browser-native dialogs

### Firestore Rules Updated ✅
- Added `requests` subcollection under `teachers/{uid}/requests/{reqId}`
- Student create permissions gated on enrollment + notBanned
- Teacher update permissions for approve/deny
- Deployed to `bookware-site2` project (explicit `--project` flag)

### Deploy
- Hosting: `firebase deploy --only hosting --project bookware-site2`
- Firestore rules: `firebase deploy --only firestore:rules --project bookware-site2`
- `.firebaserc` updated to always use `bookware-site2`
- Live: https://bookware-site2.web.app

---

## TODO / In Progress

**All spec features implemented. App is live.**

Remaining future work (not blocking):
- ARIA AI chat integration — Groq key stored, CSP allows api.groq.com, no chat UI yet
- Push notifications — rules exist, FCM not wired
- Mobile slide-in sidebar drawer with backdrop
- Custom prompt/rename modal (currently uses `window.prompt()` for class rename)
- Reading progress tracking
