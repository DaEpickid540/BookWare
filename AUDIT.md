# BookWare — Pre-Rebuild Audit

## Firebase Config
- **Project ID:** `bookware-site2`
- **Auth domain:** `bookware-site2.firebaseapp.com`
- **API key:** `AIzaSyAHYS-XvdJ5O0uEU-e8-aSDwRDm6_nWOSs`
- **App ID:** `1:262580903929:web:97dd44ad3f2184b799a728`
- **Firebase SDK version:** 10.12.0
- **Admin emails (hardcoded):** `sarvin.sukhe@gmail.com`, `daepickid540@gmail.com`
- **Teacher allowlist domain:** `@masonohioschools.com`

---

## File Architecture

```
mysite/
├── firebase.json           Hosting config: CSP headers, rewrites → /index.html
├── firestore.rules         Firestore security rules
├── .firebaserc             Project: bookware-site2
├── FIRESTORE_SCHEMA.md     Firestore collection/field docs
├── PROJECT_STRUCTURE.md
├── SECURITY_RULES.md
└── public/
    ├── index.html           Landing / login portal (3 cards)
    ├── student.html         Student SPA (5 pages)
    ├── teacher.html         Teacher SPA (6 pages)
    ├── admin.html           Admin SPA (5 pages)
    ├── teacher-signup.html  One-time teacher invite claim page
    ├── css/
    │   ├── index.css        Landing page (imports other CSS files)
    │   ├── student.css      Student + teacher design system (~1600 lines)
    │   ├── teacher.css      Teacher-specific overrides
    │   ├── admin.css        Admin portal styles
    │   ├── variables.css    Design tokens (colors, spacing, radius, shadows)
    │   ├── base.css         Reset + global
    │   ├── layout.css       Layout utilities
    │   ├── components.css   Reusable components
    │   └── responsive.css   Breakpoints
    └── js/
        ├── firebase.js      Firebase init + unhandled-rejection safety net
        ├── auth.js          Login handler — index.html only
        ├── books.js         Book search (Open Library primary, Google Books fallback)
        ├── student.js       Student portal (~1886 lines)
        ├── teacher.js       Teacher portal (~2121 lines)
        ├── admin.js         Admin portal (~654 lines)
        └── teacher-signup.js  Teacher invite claim (~156 lines)
```

---

## All Current Features

### Landing Page (index.html + auth.js)
- Three portal cards: **Student**, **Teacher**, **Admin** — each with Google Sign-In
- Teacher card requires existing `teachers/{uid}` doc (must sign up via invite first)
- Admin card restricted to two hardcoded emails
- Ban redirect messaging: `?banned=1&reason=...&days=...` or `?banned=admin`
- Sign-in spinner overlay and error toast

### Student Portal (student.html + student.js)

**Library page (default)**
- Teacher library selector chips (linked teachers shown as pill buttons)
- No-library CTA (prompt to add code when no libraries linked)
- Book list with search (title/author/ISBN)
- Per-book: checkout, return, wishlist toggle, recommend toggle, set-as-reading toggle
- Multi-copy support (shows N/M copies available)
- Notifications banner (wishlisted books available, teacher currently reading, teacher recommendations)
- Recommendations card (teacher's picks for selected library)
- Now Reading card (what the teacher is currently reading)
- All Libraries discovery section: enrolled libraries + public libraries
  - Browse button (sets selected teacher)
  - Request Access button (opens mailto for class-only libraries)
- Access gate: class-only libraries show locked message; enrolled or public can load books

**Locker page**
- Active loan card with cover, due date, overdue detection
- "Returned It" button (initiates return flow with confirm dialog)
- Reading log (returned books, sorted newest first)
- Download reading log as `.MD` button

**Wishlist page**
- My wishlist (teacher library books + Google Books search entries)
- Search Google Books to add to wishlist (debounced)
- Remove from wishlist

**Profile page**
- Currently reading list (up to 6 books; includes checked-out book)
- My Recommendations list (with remove)
- Reading stats grid: Books Read, Wishlisted, Active Loan, Overdue
- Similar Readers grid (classmates in same class)

**Settings page**
- Account info (email display)
- My Information (name, email, class, account status)
- Teacher Libraries: add library by class code, remove added libraries
- Privacy toggles: Show currently reading, Show my recommendations, Appear in Similar Readers
- Appearance: 6 named theme presets (Midnight/Night/Dusk/Ash/Parchment/Snow), brightness slider (0–100), 6 accent color swatches (Crimson/Ocean/Forest/Amethyst/Sunset/Slate)
- Notifications toggles: Wishlist available alerts, New book announcements
- ARIA AI: enable toggle + Groq API key input (stored in localStorage only)
- About section
- Sign Out bar

### Teacher Portal (teacher.html + teacher.js)

**Library page**
- Book search/add (title, author, or ISBN) with copy quantity stepper
- Add Copies button for existing books
- Multi-class manager: create/rename/delete classes, per-class invite codes (copy/regenerate)
- Library visibility toggle: Class Only vs Public (with live stats when public)
- Library book list with search
- Per-book: recommend/unrecommend, mark returned, add copy, delete
- Bi-weekly check-in banner: shows every 14 days, lists all checked-out books, email/download .MD buttons

**Students page**
- Currently checked out list (book + student name + checkout date + due date + overdue flag)
- Checkout history (real-time listener, shows date out + date returned or "still out")
- Export checkout report as `.MD`
- Class roster (grouped by class, student name + email + remove button)
- Temporary ban form (email + days + reason) and active bans list with lift button

**Now Reading page**
- Search Google Books or own library to set currently reading
- Student preview panel
- Clear currently reading button

**Recommendations page**
- Currently Reading quick-set banner (search + clear)
- Your Picks list (remove button)
- Search to add recommendations (own library + Google Books fallback)

**Invite Teachers page**
- Generate invite link (email-locked, 7-day expiry, copy to clipboard)
- All teachers can invite
- Past invites list

**Settings page**
- Account info (name, email, member since)
- Permissions badge (canInvite)
- Appearance (same as student: presets + brightness slider + accent swatches)
- ARIA AI (same as student)
- About
- Sign Out bar

### Admin Portal (admin.html + admin.js)

**Dashboard**
- Stats: Total Users, Active Today, Global Bans, Maintenance Mode
- Quick actions: Toggle Maintenance Mode, Refresh Stats
- Recent activity feed (recent bans)

**Users page**
- Full user table: email, name, role, status (active/banned)
- Search by email/name, filter by role
- Per-user: View details, Ban (opens modal), Unban, Delete

**Bans page**
- Create ban button (modal: email, reason dropdown, duration)
- Active bans list with Revoke button

**Settings page**
- Maintenance mode toggle (disables all non-admin access)
- Global ban list viewer
- Danger Zone: Export All Data (JSON), Force Logout All Users
- Account section with sign-out

**Debug page**
- Firestore stats table (total users, students, teachers, admins)
- Auth stats table (banned count)
- Error log

### Teacher Signup (teacher-signup.html + teacher-signup.js)
- Validates invite token from URL `?token=...`
- Checks: token exists, not used, not expired, email matches recipient
- Google sign-in locked to invite recipient email
- Atomic Firestore transaction: claim token + create users/{uid} + create teachers/{uid}
- Error messages for all failure cases

---

## Theme System

**6 presets:**
| Preset | Brightness | Accent |
|---|---|---|
| Midnight | 5 | Crimson |
| Night | 18 | Crimson (default) |
| Dusk | 32 | Sunset |
| Ash | 52 | Slate |
| Parchment | 72 | Sunset |
| Snow | 95 | Ocean |

**6 accent colors:**
- Crimson `#e74c3c`, Ocean `#2980b9`, Forest `#27ae60`, Amethyst `#8e44ad`, Sunset `#e67e22`, Slate `#607d8b`

**Brightness system:** Interpolates CSS vars (`--bg`, `--bg-alt`, `--bg-light`, `--card`, `--border`, `--text`) from brightness 0 (black) to 100 (white). Applied inline before first paint to avoid flash.

---

## Firestore Schema Summary

| Collection | Purpose |
|---|---|
| `users/{uid}` | All users (role, banned, banExpiry) |
| `students/{uid}` | Student profiles (currentBook, wishlist, currentlyReading) |
| `teachers/{uid}` | Teacher profiles (name, inviteCode, libraryPublic, currentlyReading) |
| `teachers/{uid}/books/{id}` | Library books (status, copies, checkedOutCount) |
| `teachers/{uid}/history/{id}` | Checkout history |
| `teachers/{uid}/classes/{id}` | Multi-class system (name, inviteCode) |
| `teachers/{uid}/classes/{id}/students/{uid}` | Per-class roster |
| `teachers/{uid}/recommendations/{id}` | Teacher book recommendations |
| `teachers/{uid}/students/{uid}` | Legacy flat roster |
| `students/{uid}/recommendations/{id}` | Student book recommendations |
| `invites/{token}` | Teacher invite tokens |
| `admin/settings` | maintenanceMode, globalBanList |

---

## Known Issues in Current Code
1. Unescaped `"` in some HTML template strings inside toast calls
2. Duplicate theme/brightness JS code in both student.js and teacher.js
3. student.html/teacher.html use inline style blocks for body visibility
4. admin.html and student.html both define `#notificationContainer .toast-container`
5. teacher.js renderLibraryList has syntax error (extra `</div>`)
6. student.js notification banner tries to pass HTML string through escHtml (strips tags)
