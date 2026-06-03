# BookWare — Change Log

_Autonomous rebuild session. Updated after each phase._

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

## TODO / In Progress

**All known bugs fixed. Security audit complete. Polish pass complete. App is live.**

Potential future work (not blocking):
- ARIA AI chat integration — Groq key stored, CSP allows api.groq.com, but no chat UI or API calls exist yet
- Push notifications — `notifications/{userId}` collection exists in Firestore rules but is not used
- Reading progress tracking (percentage through a book)
- Mobile slide-in sidebar drawer with backdrop (currently icon-only on mobile, which works)
