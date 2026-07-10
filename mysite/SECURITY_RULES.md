# BookWare — Firestore Security Model

> **`firestore.rules` in this folder is the single source of truth.** This file
> is a human-readable summary. If the two ever disagree, the deployed
> `firestore.rules` wins — update this doc to match, never the other way around.
> (An earlier version of this file described a much more permissive draft ruleset
> that was never the real one; it has been replaced.)

## Identity & roles

- **Auth:** Google OAuth only (Firebase Auth). No passwords are ever handled by
  app code.
- **Role** lives in `users/{uid}.role` (`student` | `teacher` | `admin`) and is
  the value the rules trust. The `isAdmin()`/`isTeacher()`/`isStudent()` helpers
  read it from Firestore, not from a client claim.
- **Admins** are hardcoded. A user may only set their own `role` to `"admin"` if
  their verified email is in the allowlist baked into `firestore.rules`
  (`sarvin.sukhe@gmail.com`, `sarvinsukhe@gmail.com`, `daepickid540@gmail.com`).
  The same list lives in `public/js/config.js` for client-side routing — the two
  **must** be kept in sync.
- **Teachers** are invite-only: an admin or an existing teacher issues an invite
  (`invites/{token}`), or an admin pre-registers an email (`pendingUsers`), or a
  `@masonohioschools.com` user requests approval (`accessRequests`). No one
  becomes a teacher without a teacher/admin approving them.

## Collection-by-collection

| Path | Read | Write |
|------|------|-------|
| `users/{uid}` | self or admin | self-create only; self-update can't touch `role`/ban fields (except the hardcoded admins promoting themselves); admin can do anything |
| `students/{uid}` | self, any teacher, or admin | self (not ban fields), teacher, or admin |
| `students/{uid}/recommendations` | **self, teacher, or admin** (not arbitrary peers) | owner only, if not banned |
| `teachers/{uid}` | any signed-in user (public library directory — no secrets stored here) | teacher-self or admin |
| `teachers/{uid}/books` | teacher-self, admin, or a student who is enrolled or whose library is public | teacher/admin; students may only flip checkout-status fields, gated on enrollment |
| `teachers/{uid}/history` | teacher-self, admin, or the student it's about | student-create; teacher/admin update |
| `teachers/{uid}/requests` | teacher-self, admin, or the requesting student | student-create (own, `pending`); teacher/admin approve-deny |
| `teachers/{uid}/classes` (+ roster) | signed-in (join codes); roster scoped to teacher/self/admin | teacher/admin |
| `invites/{token}` | single-doc `get` is public (pre-login claim page); `list` is teacher/admin only | teacher-with-`canInvite`/admin create; creator can revoke; claim flow marks used |
| `accessRequests/{uid}` | requester or admin | requester-create (own, `pending`, can't self-approve); admin approve/deny |
| `pendingUsers/{emailKey}` | **only the owning email** (can't enumerate) | admin only |
| `admin/{doc}` | any signed-in user (holds only `maintenanceMode` / `sessionEpoch` — no PII) | admin only |
| everything else | denied | denied (`allow read, write: if false`) |

## Known, intentional trade-offs

- `teachers/{uid}` is world-readable to signed-in users because the "All
  Libraries" discovery screen lists every teacher. Only directory-appropriate
  fields (name, email, library visibility, currently-reading) live there — do
  **not** add secrets to a teacher document.
- `admin/{doc}` is world-readable because the student/teacher portals check
  `maintenanceMode` at load. Keep it limited to non-sensitive operational flags.
- Instant token revocation isn't possible without a Cloud Function. The admin
  "Force Re-login" writes `admin/settings.sessionEpoch`; each portal signs out
  any session older than that stamp on its next load (`shouldForceLogout` in
  `config.js`).
