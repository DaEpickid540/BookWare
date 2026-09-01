# Project structure

Static site, no build step. What is in `public/` is exactly what gets served.

```
mysite/
├── firebase.json              hosting config: cache headers, CSP, rules+indexes paths
├── .firebaserc                project + hosting target (school-suite-652d8 / bookware)
├── firestore.rules            THE security boundary — server-side, on every request
├── firestore.indexes.json     composite indexes; a missing one = failed-precondition
│
├── TEACHER_BACKEND.md         teacher data model, invariants, rules contract
├── FIRESTORE_SCHEMA.md        every collection and field, with PII/retention markers
├── SECURITY_RULES.md          rules walkthrough
│
└── public/
    ├── index.html             sign-in / landing
    ├── student.html           student portal
    ├── teacher.html           teacher portal
    ├── admin.html             admin portal
    ├── teacher-signup.html    invite claim
    ├── teacher-access.html    request teacher access
    ├── privacy.html
    ├── manifest.json  sw.js   PWA shell + service worker
    │
    ├── js/
    │   ├── firebase.js        the single app / auth / db instance
    │   ├── config.js          admin allowlist, school domain, join-link helpers
    │   ├── auth.js            sign-in, role provisioning, portal routing
    │   │
    │   ├── teacher-api.js     ── teacher DATA layer (Firestore only, no DOM)
    │   ├── teacher.js         ── teacher UI layer  (DOM only, no Firestore)
    │   ├── student.js         student portal (UI + data, not yet split)
    │   ├── admin.js           admin portal   (UI + data, not yet split)
    │   │
    │   ├── retention.js       data-retention policy + purges, shared by all portals
    │   ├── books.js           Google Books / OpenLibrary lookup
    │   ├── booklist.js        student browse + shelf rendering
    │   ├── quiz.js            reading-preferences quiz
    │   ├── welcome.js         first-run intro
    │   ├── theme.js           theming, settings modal, ARIA assistant
    │   ├── theme-preload.js   applies the stored theme before first paint
    │   ├── preloader.js       splash screen
    │   ├── qr.js              QR generation (lazy)
    │   ├── login-notice.js    parks a ?join= code through sign-in
    │   ├── teacher-signup.js  invite claim flow
    │   ├── teacher-access.js  access-request flow
    │   └── sw-register.js
    │
    ├── css/
    │   ├── app.css            the portals (teacher/student/admin share it)
    │   ├── admin.css  index.css  signup.css  privacy.css  preloader.css
    │
    └── icons/  favicon.svg
```

## The one structural rule

The teacher portal is split in two and must stay that way:

- `teacher-api.js` — every Firestore read and write. No DOM.
- `teacher.js` — every DOM operation. No Firestore import.

`student.js` and `admin.js` still mix both. That is existing debt; don't copy it.

## What deploys where

| Files | Deployed by |
|---|---|
| `public/**` | Firebase Hosting |
| `firestore.rules` | `firebase deploy --only firestore:rules` |
| `firestore.indexes.json` | `firebase deploy --only firestore:indexes` |

CI does all three on a push to `main` — rules and indexes first, then hosting.
See [`../CLAUDE.md`](../CLAUDE.md).
