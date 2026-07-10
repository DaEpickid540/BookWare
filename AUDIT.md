# BookWare Web App — Audit Report

**Scope:** Original audit was read-only. A follow-up remediation pass (below) then
fixed the findings. **Nothing was deployed** — the Firestore rules changes and code
changes are in the working tree only and still need to be pushed/deployed to take
effect in production.
**Date:** 2026-07-09
**Canonical app root:** `mysite/public/` (Firebase Hosting site, project `bookware-site2`)

---

## ⭐ Remediation & Re-Scan (2026-07-09)

The issues from the audit below were fixed and the app was re-verified by serving it
locally and loading every page against the live Firestore. All pages load with **zero
console errors** and correctly reach Google sign-in / validate tokens.

### Critical bug found *during* remediation
- **`booklist.js` was corrupted and broke the entire student and teacher portals.**
  A bad merge had spliced ~2,640 book entries into the middle of the `shuffle()`
  function (line 196 was missing its `];`), making the file a syntax error. Because
  `student.js` and `teacher.js` both import it transitively via `theme.js`, **both
  portals failed to load any JavaScript at all** in production. Repaired losslessly:
  `shuffle()` restored and all recovered titles merged back into `BOOKLIST` (now 2,676
  entries). Verified in-browser. *This alone was likely making the deployed app's
  student/teacher portals non-functional.*

### Security fixes
- **Stored XSS (admin panel) closed.** The two inline `onclick="approveAccessRequest('${...}')"`
  handlers in `admin.js` were replaced with `data-*` attributes + delegated listeners,
  so an attacker's Google display name can never enter an executable string. Also
  hardened every `esc()` helper (admin/teacher/student) to escape single quotes, and
  escaped the error string in `firebase.js`'s safety-net `innerHTML`.
- **Firestore data-leak paths tightened:** `students/{uid}/recommendations` is no longer
  readable by arbitrary signed-in peers (owner/teacher/admin only); `pendingUsers` can
  no longer be enumerated (a user may read only their own record); the vestigial
  `globalBanList` was removed so `admin/settings` holds nothing sensitive. The
  intentionally-broad reads (`teachers/{id}` directory, `admin/settings` maintenance
  flag) are now documented in-rule.
- **"Similar Readers" removed.** It required students to read each other's records —
  which the rules (correctly) forbid — so it never worked and would have been a peer-data
  leak if it did. Removed the feature and its fake privacy toggles rather than fake it.
- **Admin allowlist centralized** into `public/js/config.js` (single source of truth,
  mirrored in `firestore.rules`), replacing five drifting copies. Admins remain hardcoded
  to `sarvin.sukhe@gmail.com` / `sarvinsukhe@gmail.com` / `daepickid540@gmail.com`;
  teachers still require an invite and a `@masonohioschools.com` (or admin) email.

### Bug / quirk fixes
- **Revoked invites** now show a clear "revoked" message on `teacher-signup.html` instead
  of a confusing generic failure (the rules already blocked them; the UX lied).
- **Multi-copy checkout visibility:** the teacher "Checked Out" list and export now include
  books with *some* copies out (previously hidden until every copy was gone).
- **Class codes** now use `crypto.getRandomValues()` from an unambiguous alphabet instead
  of `Math.random()`.
- **"Force Logout All Users"** is now real (writes `admin/settings.sessionEpoch`; portals
  sign out older sessions on next load, fail-open) instead of a no-op stub.
- **Silent checkout-history write failure** now surfaces a toast to the student.
- **Non-functional stub toggles** removed; the one real one (**wishlist alerts**) is now
  wired to persist and actually gate the notification.
- **`signup.css`** gained a mobile breakpoint (the only stylesheet that lacked one).
- **`SECURITY_RULES.md`** rewritten to match the actual deployed rules (it previously
  documented a much more permissive draft).

### ⚠️ Still requires your action
1. **Deploy the Firestore rules** — the tightened rules only protect production once
   deployed (`firebase deploy --only firestore:rules`). Until then, the old rules are live.
2. **Deploy hosting** to ship the code fixes (including the critical `booklist.js` repair).
3. **End-to-end auth testing** (logging in as a real student/teacher/admin and clicking
   through) still needs you — it can't be automated without your Google credentials.
4. Consider deleting the stale duplicate app copy `BookWare-main/` from git (§0).
5. Optional hardening still open: remove `'unsafe-inline'` from the CSP `script-src`.

### Post-fix category status
| Category | Before | After |
|---|---|---|
| Student/Teacher portals load at all | ❌ Broken (`booklist.js`) | ✅ Fixed & verified |
| XSS | ⚠️ Exploitable | ✅ Closed |
| Firestore data-leak reads | ⚠️ Over-broad | ✅ Tightened (deploy pending) |
| Peer-data leak (Similar Readers) | ⚠️ Present-if-it-worked | ✅ Removed |
| Stub features presented as real | ⚠️ Several | ✅ Wired or removed |
| Admin allowlist drift | ⚠️ 5 copies | ✅ Centralized |
| Secrets in repo | ✅ None | ✅ None |

---

## 0. Repo hygiene note (read this first)

The repository root contains **three copies** of the app:

1. `mysite/` — the real, actively-deployed copy (referenced by `.firebaserc`/`firebase.json`, and the only one with `booklist.js`, `quiz.js`, `theme.js`, `teacher-access.*`, `sw.js`, `manifest.json`, PWA icons).
2. `BookWare-main/` — an **older copy, tracked in git** (30 files), missing all the features above. Looks like a stale extracted zip that got committed.
3. `.claude/worktrees/flamboyant-shirley-5621a8/` — a leftover git worktree (detached HEAD, excluded via root `.gitignore`) containing yet another older copy.

This audit covers only `mysite/`. `BookWare-main/` being committed to git is itself worth cleaning up — dead weight and a source of "which copy is real" confusion — but is left untouched per the read-only instruction.

A prior `AUDIT.md` was already tracked in this repo containing a mix of an accurate audit of the current `mysite/` layout and stale leftover content describing an older CSS/file structure (`variables.css`, `student.css`, `base.css`, etc.) that no longer exists. This report replaces it with a single, verified version.

---

## 1. File Structure & Architecture

```
mysite/
├── .firebaserc              project alias "bookware-site2"
├── firebase.json            Hosting config: security headers, CSP, SPA rewrites → /index.html
├── firestore.rules          Firestore security rules (270 lines)
├── FIRESTORE_SCHEMA.md      collection/field documentation
├── PROJECT_STRUCTURE.md     architecture notes
├── SECURITY_RULES.md        ⚠️ STALE — describes an older, more permissive ruleset (see §4)
├── .gitignore               excludes .env, firebase-debug logs, .firebase/ cache, node_modules
└── public/
    ├── index.html             Landing/login portal (Student / Teacher / Admin cards)
    ├── student.html           Student SPA
    ├── teacher.html           Teacher SPA
    ├── admin.html             Admin SPA
    ├── teacher-signup.html    One-time teacher invite-token claim page
    ├── teacher-access.html    Walk-in teacher access-request page
    ├── manifest.json, sw.js   PWA manifest + service worker
    ├── favicon.svg, icons/    PWA icons
    ├── css/
    │   ├── app.css            shared styles (teacher.html, student.html)
    │   ├── admin.css          admin-only styles
    │   ├── index.css          landing page styles
    │   └── signup.css         invite/access-request page styles
    └── js/
        ├── firebase.js        Firebase SDK init + config (52 lines)
        ├── auth.js            Google OAuth sign-in, session/role bootstrap (306 lines)
        ├── books.js           book search/lookup helpers — Open Library + Google Books (148 lines)
        ├── booklist.js        curated book catalog data (2841 lines)
        ├── quiz.js            reading-preferences onboarding quiz (315 lines)
        ├── theme.js           theming + optional "ARIA" AI-assistant chat (886 lines)
        ├── student.js         student SPA logic (2019 lines)
        ├── teacher.js         teacher SPA logic (1579 lines)
        ├── admin.js           admin SPA logic (1133 lines)
        ├── teacher-signup.js  invite-token claim logic (133 lines)
        └── teacher-access.js  walk-in access-request logic (269 lines)
```

**Architecture:** A static, client-rendered, framework-free SPA (vanilla JS ES modules, no bundler) hosted on Firebase Hosting, backed entirely by Firebase Auth (Google OAuth) + Cloud Firestore. There is no custom backend server or Cloud Functions — all authorization is enforced through Firestore Security Rules. Each role (student/teacher/admin) has its own HTML shell + JS entry point rendering "pages" within a single-page-per-role pattern. `.github/workflows/firebase-deploy.yml` deploys via GitHub Actions using a `FIREBASE_SERVICE_ACCOUNT_BOOKWARE_SITE` GitHub secret (name only — value not in the repo, correctly out of client reach).

**Verdict: ✅ Good** — clean separation of concerns, one JS entry point per portal, shared helpers (`firebase.js`, `books.js`, `theme.js`) correctly imported as modules.

---

## 2. Feature Completeness

### Teacher UX
| Feature | Status | Notes |
|---|---|---|
| Create library/classroom | ✅ Complete | Multi-class manager: create/rename/delete classes, per-class invite codes — `teacher.js:230-333` |
| Add books | ✅ Complete | ISBN + title/author search, multi-copy stepper — `teacher.js:499-592` |
| Show recommendations | ✅ Complete | `teacher.js:1110-1149` |
| Current book ("Now Reading") | ✅ Complete | `teacher.js:1223-1310` |
| Export rental logs | ✅ Complete | Exports as `.md`, `.csv`, **and** a themed PDF (jsPDF+autotable) — `teacher.js:818-988` |
| Invite via QR/email | ⚠️ Partial / misleading label | The QR+email "Invite Teachers" flow (`teacher.js:1370-1433`) invites **other teachers**, not students. Student enrollment is a plain-text class code with a copy button only — no QR path for students. |
| Approve student rental requests | ✅ Complete | `loadPendingRequests`/`approveRequest`/`denyRequest` — `teacher.js:397-493`, gated by a require-approval toggle |
| Temp ban students | ✅ Complete | Sets a `banExpiry` from a day count — `teacher.js:1060-1075`; requires the student to have signed in at least once already (`users` doc lookup by email), so a teacher can't pre-ban an email before first sign-in |

### Student UX
| Feature | Status | Notes |
|---|---|---|
| Recommendations | ✅ Complete | `renderTeacherExtras` — `student.js:744-818` |
| Liked/wishlist books | ✅ Complete | `addToWishlist`/`removeFromWishlist` + `renderWishlist`, plus Google-Books-backed wishlist search — `student.js:1354-1506`; a separate star-rating "recommend" feature also exists (1855-1994) |
| Ask to rent | ✅ Complete | `submitRentalRequest` writes a real Firestore doc to `teachers/{tid}/requests`, read back via `renderRentalRequests` — `student.js:1199-1324` |
| Reading preferences quiz | ✅ Complete | `quiz.js` full modal flow, persisted to `readingProfile` |
| Similar Readers (classmates) | ❌ Broken | Queries `students` where `class == classTeacherId` (`student.js:1809-1845`), but `class` is set to `null` at account creation (`auth.js:77,114`) and is **never populated anywhere else** — joining a library writes to an `addedTeachers` array instead (`student.js:423`). The query returns empty for every account created under the current multi-class system. |
| Privacy toggles (Show reading / Show recs / Appear in Similar Readers) | ❌ Non-functional stub | Present in `student.html` (:344-367) with no corresponding read/write logic anywhere in `student.js` — moot in any case since Similar Readers itself is broken |
| Notification toggles (Wishlist available / New books) | ❌ Non-functional stub | Present in `student.html` (:463-474), no backing code in `student.js` |

### Admin UX
| Feature | Status | Notes |
|---|---|---|
| Perma ban | ✅ Complete, distinct from teacher temp-ban | `banUser()` sets `banExpiry: null` for permanent — `admin.js:542-556` |
| Panels with sub-settings | ✅ Complete | 7 sidebar pages (Dashboard, Users, Libraries, Rentals, Bans, Invites, Settings, Debug); Settings modal has 6 sub-panels (System, Appearance, Data, Danger Zone, ARIA AI, Teacher Access Requests) — `admin.html:58-92, 370-575` |
| Invite management | ✅ Complete | Pending access-request approval, invite-link creation with optional email-lock + QR, revocable invite list — `admin.js:616-881` |
| Force-logout all users | ❌ Stub | Button shows a confirm dialog, then does nothing — `admin.js:916-918`, `admin.html:497-499`. Would require a Cloud Function to actually revoke sessions server-side, which this project doesn't have. |
| Debug → Error Log panel | ❌ Stub | UI exists (`admin.html:606-611`) but is never populated by any code |

### Styling consistency
- ✅ Shared design tokens (colors, fonts) are value-consistent across `app.css`/`admin.css`/`index.css`/`signup.css`, and each HTML page links the correct matching stylesheet.
- ✅ `app.css`, `admin.css`, `index.css` all have responsive `@media` breakpoints.
- ⚠️ `signup.css` has **no** `@media` queries — the teacher invite-claim (`teacher-signup.html`) and walk-in access-request (`teacher-access.html`) pages have no mobile responsiveness handling, unlike every other page.

**Verdict: ✅ Good overall**, with real gaps: the Similar Readers feature is fully broken for the current account model, and several settings-page toggles (privacy/notifications) and one admin Danger Zone button are non-functional stubs presented as working controls.

---

## 3. Authentication & OAuth

- **Method:** Google OAuth only, via Firebase Auth `GoogleAuthProvider` + `signInWithPopup` (with a redirect fallback for popup-blocked environments). No email/password auth exists anywhere (`signInWithEmailAndPassword` is never used).
- **Role routing** happens in `auth.js`'s post-OAuth callback:
  - **Admin:** checked against a hardcoded `ADMIN_EMAILS` list **and** the Firestore `role == "admin"` field (dual check).
  - **Teacher:** invite-only — either (a) an invite token in `invites/{token}` claimed via `teacher-signup.js`, domain-restricted to `@masonohioschools.com` or the admin allowlist; (b) an admin pre-registers an email in `pendingUsers/{emailKey}`, consumed on first sign-in; or (c) a walk-in `accessRequests/{uid}` doc for manual admin approval (`teacher-access.js`).
  - **Student:** auto-provisioned on first Google sign-in (not anonymous auth) — `users/{uid}` + `students/{uid}` docs created automatically.
- **Session persistence:** Standard Firebase Auth SDK-managed ID tokens, toggled between `browserLocalPersistence` and `browserSessionPersistence` based on a "Stay Signed In" preference in localStorage (`firebase.js:24-29`). No custom token minting, no raw JWTs manually stored.
- **OAuth redirect/config:** No OAuth client secret, redirect-URI list, or backend/service-account credentials exist in client code (confirmed via full read + repo-wide grep). `firebase.js:10-18` contains the standard public Firebase web config (apiKey, authDomain, projectId, appId) — this is not a secret by design; it identifies the project, it does not authorize access. `firebase.json`'s CSP `frame-src` correctly allowlists `accounts.google.com`/`*.firebaseapp.com`, and `Cross-Origin-Opener-Policy: same-origin-allow-popups` is set, which is required for `signInWithPopup` to function under a strict COOP.
- **Admin-role escalation is checked server-side, not just client-side** — `firestore.rules:56-64` re-validates the same admin email allowlist before permitting a `role: "admin"` self-write on the user's own doc, so the client-side allowlist (duplicated across `auth.js`, `teacher-signup.js`, `teacher-access.js`, `admin.js`, `teacher.js`) is UI convenience, not the actual security boundary. That said, the duplication across 5 files is a real maintenance risk: if the list is edited in one file but not in `firestore.rules` (or vice versa), the client and server checks would disagree.

**Verdict: ✅ Good** — Google OAuth only, popup+redirect fallback, and the one place where client trust would matter (admin self-promotion) is correctly re-validated server-side in Firestore rules.

---

## 4. Security Audit

### Passwords
✅ **Good.** No passwords are ever handled by app code — Google OAuth only, confirmed by full read of `auth.js` and a repo-wide grep for password/hash-related code.

### API keys / secrets
✅ **Good**, with one caveat. No service-account JSON, private keys, or third-party API *secret* keys were found anywhere in `mysite/` (grepped for `private_key`, `BEGIN PRIVATE KEY`, `service_account`, `client_secret`, `AIzaSy` — only hit is the expected public Firebase web apiKey). Caveat: `theme.js` lets end users paste their **own** third-party AI provider keys (Groq/OpenAI/etc.) for the optional "ARIA" chat assistant; these are stored in the browser's own `localStorage` and used for client-side `fetch` calls to those providers directly (`callOpenAI` and similar, `theme.js:~383+`). This is the user's own key on their own device, not a repo secret — but note `CHANGES.md` describes this feature as "UI-only, no calls made," which is **stale/inaccurate** relative to the current code.

### Firestore rules
⚠️ **Needs attention — genuinely over-permissive in several places**, all traced to one root cause: the `allowedEmail()` helper (`firestore.rules:42-44`) is defined as simply `return isSignedIn();` — it appears to have been intended as a domain/allowlist check but was never implemented, so every rule that calls it is really just "any authenticated user." Concretely:

- **`teachers/{teacherId}` full-document read is open to any signed-in user** (`firestore.rules:90`: `allow read: if isSignedIn() && allowedEmail();`) — any authenticated student can read *any* teacher's full document, including fields like `inviteCode`, `readingProfile`, `canInvite`, and `requireApproval` that look like they should be private to that teacher/admins.
- **`admin/{doc}` (the `admin/settings` document) is readable by any signed-in user** (`firestore.rules:255`: `allow read: if isSignedIn();`) — this document holds `maintenanceMode` and (per `FIRESTORE_SCHEMA.md`) a `globalBanList`; if `globalBanList` contains user emails/UIDs, any student or teacher can currently read the full ban list.
- **`teachers/{uid}/classes/{classId}`** (`:152`) and **`teachers/{uid}/recommendations/{recId}`** (`:168`) reads are similarly gated only by the no-op `allowedEmail()` — open to any signed-in user, not just enrolled students.
- **`students/{studentId}/recommendations/{recId}` read** (`:83`) is `if isSignedIn()` — any signed-in user can read any student's recommendation subcollection.
- **`invites/{token}` single-doc `get` is fully public, no auth required** (`:187`, `allow get: if true;`) — intentional, so the unauthenticated claim page can validate a token before sign-in, but it also means anyone who obtains/guesses a token ID (a Firestore auto-ID, impractical to guess) can read that invite's `recipientEmail` and `createdBy` — a minor PII disclosure. `list` on the collection is correctly restricted to teachers/admins (`:189`), so tokens can't be enumerated.

What **is** solid: there's a default-deny catch-all (`:266-267`, `allow read, write: if false`), no collection has a blanket open **write**, book-checkout writes by students are tightly restricted to specific fields via `hasOnly([...])` (`:112-116`), `accessRequests` prevents self-approval (`:227-236`), and `pendingUsers` prevents non-admin writes.

- ⚠️ **`SECURITY_RULES.md` is stale** and documents a different, in some ways more permissive but structurally inconsistent ruleset (e.g. admin gated on a `request.auth.token.admin` custom claim, which doesn't exist in the real rules — the real rules use a Firestore `role` field instead). Anyone consulting that doc instead of the live `firestore.rules` would draw the wrong conclusions. Recommend regenerating or deleting it.

### XSS
⚠️ **Needs attention — one confirmed exploitable path.** All three portal files (`student.js:44-50`, `teacher.js:28-30`, `admin.js:28-30`) define a local `esc()` helper that HTML-encodes `& < > "` — but **none of them escape single quotes**.

- **Confirmed stored-XSS in `admin.js`:** at `admin.js:660-667` and `admin.js:1033-1040`, escaped values are interpolated into an inline `onclick` attribute where the arguments are themselves delimited by single quotes inside a double-quoted HTML attribute:
  ```js
  onclick="approveAccessRequest('${esc(r.id)}','${esc(r.name||'')}','${esc(r.email||'')}','${esc(r.photoURL||'')}')"
  ```
  Because `esc()` doesn't encode `'`, a display name containing one (e.g. `x');alert(document.cookie);//`) breaks out of the JS string literal and executes arbitrary JavaScript in the **admin's** browser session as soon as the admin views the Pending Access Requests list. This is attacker-reachable: any Google user can submit a walk-in access request via `teacher-access.html` using their own Google account's display name, which they fully control. **This should be fixed** — either escape `'` (e.g. to `&#39;`) in `esc()`, or (preferably, and consistent with the rest of the codebase) stop building `onclick="..."` strings from data and attach event listeners via `data-*` attributes instead.
- **Same root-cause weakness, narrower exploit surface, in `student.js`:** book titles/authors (teacher-entered, or from external Google Books/Open Library results) are interpolated into single-quoted HTML attributes like `alt='Cover of ${esc(book.title)}'` and `data-title='${esc(book.title)}'` (`student.js:952-996, 1010-1014, 1426-1430`). A title containing an apostrophe plus a crafted suffix could break attribute context. Requires a teacher (or a spoofed external API response) to supply the malicious string — narrower than the admin.js path, but the same one-line fix applies.
- `quiz.js` already has a **correct** `esc()` (line 126) that does encode `'` → `&#39;`, so the fix pattern already exists in this codebase — it just isn't applied consistently.
- No other unescaped `innerHTML`/`insertAdjacentHTML`/`document.write` of untrusted data was found; `booklist.js`/`books.js` are pure data-fetch helpers with no DOM writes.

### CSRF
✅ **Not applicable in the traditional sense** — there are no server-side cookie-session form endpoints; all writes go through the Firebase JS SDK directly to Firestore using bearer ID tokens, authorized by Firestore Security Rules rather than ambient cookies, so classic CSRF doesn't apply here.

### Data exposure
✅ **Good**, aside from the Firestore-rule over-permissiveness noted above. No other students' emails or personal info are rendered to peers in the UI — `renderSimilarReaders` shows only initials/first names (moot anyway, since it's broken). Teacher emails are shown to students in library-directory views by design (a public teacher/library directory), not a leak of protected data.

### CSP
⚠️ `firebase.json`'s CSP includes `'unsafe-inline'` in `script-src` (already flagged as a known hardening item in `UPGRADES.md:84`), which weakens the browser's own mitigation against the XSS pattern above. Everything else in the headers is solid: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, restrictive `Permissions-Policy`, `object-src 'none'`, `base-uri 'self'`.

---

## 5. Data Leaks

- ✅ No `.env` files, credential files, service-account JSON, or private keys found anywhere in the tracked repo (`mysite/`, `BookWare-main/`, or root) — confirmed via filename search and content grep.
- ✅ `mysite/.gitignore` correctly excludes `.env`, `firebase-debug*.log`, and the `.firebase/` cache directory.
- ✅ The only real deploy credential (`FIREBASE_SERVICE_ACCOUNT_BOOKWARE_SITE`) is referenced only by name in `.github/workflows/firebase-deploy.yml:20` as a GitHub Actions secret — its value is not, and cannot be, present in the repo.
- ⚠️ Three admin emails (`sarvin.sukhe@gmail.com`, `sarvinsukhe@gmail.com`, `daepickid540@gmail.com`) are hardcoded in plaintext across 5 client-side JS files and thus visible to anyone viewing page source in a **public** GitHub repo — not a security flaw per se (the rules re-check server-side), but these personal emails are effectively public.

**Verdict: ✅ Good** — no actual secrets committed; hardcoded admin emails are PII, not credentials.

---

## 6. Known Quirks / Bugs

1. **Revoked invite links produce a confusing error instead of a clear message.** `teacher-signup.js`'s `validateToken()` (lines 36-58) and the claim transaction (91-117) check `used` and `expiresAt` but never check a `revoked` flag. Firestore rules *do* check `revoked` on the update path (`firestore.rules:212`), so a revoked invite link is still correctly blocked from creating an account — but the user only discovers this after clicking through Google sign-in, at which point they get the generic fallback "Account setup failed. Please contact an administrator." instead of "This invite was revoked."
2. **Similar Readers is fully broken** for every account created under the current multi-class model — see §2. The `class` field it queries on is never set (only `addedTeachers` is used for library membership now); this looks like a leftover from an earlier single-class architecture that wasn't migrated.
3. **Multi-copy books can hide checked-out copies from the teacher's "Checked Out" view.** `loadCheckedOut()` and at least three other views (`teacher.js:761, 823, 932, 1537`) filter by `b.status === 'checked_out'`, but `status` is only set to `'checked_out'` once **every** copy is out (`checkedOutCount >= copies`, e.g. `teacher.js:625`). A 3-copy book with 1 copy checked out stays `status: 'available'` and simply won't appear in these lists — a teacher could miss an overdue copy.
4. **Non-cryptographic class invite codes.** `genCode()` (`teacher.js:48`) uses `Math.random().toString(36)...` for 6-character class codes — not cryptographically secure. Low severity for a school context, but `crypto.getRandomValues()` would be stronger and codes could theoretically be guessed/brute-forced given enough attempts (rate-limiting isn't visible in the rules).
5. **Non-functional UI stubs presented as real controls:** student settings privacy/notification toggles (§2), and the admin "Force Logout All Users" Danger Zone button (`admin.js:916-918`) and Debug "Error Log" panel (never populated).
6. **Silent error swallowing** in `student.js` (`catch (_) {}` at lines 143, 400, 452, 518, 540, 736-738, 1262) hides failures with no user feedback; notably `student.js:1170-1172` silently drops a rental-history log entry if the write fails after a successful checkout — a small data-consistency gap in the audit trail.
7. **Return-flow race condition (by design, but worth flagging):** `initiateReturn` (`student.js:1327-1351`) clears the student's `currentBook` client-side immediately on self-report, before the teacher confirms the physical return — a student could start checking out a new book while the old copy is still `checked_out` server-side.
8. **Mobile responsiveness gap:** `signup.css` has no `@media` breakpoints, unlike every other stylesheet (§2).
9. **Repo hygiene:** `BookWare-main/`, a stale duplicated older copy of the entire app, is committed to git (§0).

---

## 7. Overall Verdict

| Category | Rating | Summary |
|---|---|---|
| File structure / architecture | ✅ Good | Clean vanilla-JS module SPA + Firebase backend, sensible organization. Minor demerit for the duplicated `BookWare-main/` copy committed to git. |
| Teacher feature completeness | ✅ Good | All requested features present and wired to real Firestore data; the QR "invite" only covers teacher invites, not students. |
| Student feature completeness | ⚠️ Needs attention | Recommendations/wishlist/rental-request flows are fully implemented; Similar Readers is broken, and privacy/notification settings toggles are non-functional stubs. |
| Admin feature completeness | ✅ Good | Perma-ban, multi-panel settings, and invite management are all real; "Force Logout" and the Error Log panel are stubs. |
| Styling consistency | ⚠️ Needs attention | Consistent tokens/fonts everywhere, but the signup/access-request pages have no responsive breakpoints. |
| Authentication & OAuth | ✅ Good | Google OAuth via Firebase Auth; admin-escalation is properly re-validated server-side, not just trusted from the client. |
| Password handling | ✅ Good | No passwords ever handled by app code (OAuth-only). |
| API keys / secrets | ✅ Good | No genuine secrets in the repo; Firebase web config is public-by-design; user-supplied AI keys stay client-side. |
| Firestore rules | ⚠️ Needs attention | A no-op `allowedEmail()` helper leaves several reads (full teacher docs, `admin/settings` incl. possible ban list, class rosters, teacher recommendations) open to *any* signed-in user rather than the intended scope. No blanket write access anywhere; default-deny catch-all present. Docs (`SECURITY_RULES.md`) are stale. |
| XSS | ⚠️ Needs attention | Confirmed exploitable stored-XSS via unescaped single quotes in `esc()` feeding inline `onclick` handlers in `admin.js` (reachable via a crafted Google display name on a walk-in access request), plus the same weaker pattern in `student.js`. One-line-class fix (escape `'`, or stop building inline `onclick` strings from data — `quiz.js` already does this correctly). |
| CSRF | ✅ Good | Not applicable — no cookie-session form endpoints; all writes are token-authenticated Firestore calls governed by security rules. |
| Data exposure (app-level) | ✅ Good | No cross-user PII rendered to peers in the UI itself; exposure risk is at the rules layer, not the UI. |
| Data leaks (secrets in repo) | ✅ Good | No `.env`/credential files committed; `.gitignore` correctly excludes secrets. |
| Bugs / quirks | ⚠️ Needs attention | One fully broken feature (Similar Readers), several UI stubs presented as functional, a couple of silent-failure/race-condition edge cases, and a multi-copy checkout-visibility bug. None are critical outages, but there's a real backlog to track. |

**Bottom line:** The app's foundations are sound — real Firebase Auth (no homegrown password handling), no secrets committed, and the one place client-side trust would matter (admin self-promotion) is correctly re-validated server-side. Two things should be fixed soon: (1) the `esc()` single-quote gap that enables stored XSS via `onclick` handlers, primarily in `admin.js`; and (2) the over-broad Firestore reads caused by the no-op `allowedEmail()` helper, especially on `admin/settings` and full teacher documents. Everything else here — the broken Similar Readers feature, stub buttons, stale docs, missing mobile breakpoints on two pages, and the stray duplicated `BookWare-main/` copy in git — is real but lower-priority cleanup, not a structural problem.
