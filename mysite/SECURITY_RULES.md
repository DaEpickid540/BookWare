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
| `teachers/{uid}/history` | teacher-self, admin, or the student it's about | student-create; teacher/admin update; **teacher/admin delete** (needed by the 2-year retention purge) |
| `teachers/{uid}/requests` | teacher-self, admin, or the requesting student | student-create (own, `pending`); teacher/admin approve-deny |
| `teachers/{uid}/classes` | signed-in (join codes) | teacher/admin |
| `teachers/{uid}/classes/{cid}/students` (roster) | the student themselves, admins, **and the teacher only until the class's `endDate`** | teacher/admin create (roster create additionally requires `classNotEnded()`, admin exempt); teacher, self, or admin delete |
| `classCodes/{code}` | single-doc `get` only, any signed-in user; **`list` is denied outright** (no enumeration) | teacher-create for their own `teacherId` only; owning teacher or admin delete; never updated |
| `invites/{token}` | single-doc `get` is public (pre-login claim page); `list` is teacher/admin only | teacher-with-`canInvite`/admin create; creator can revoke; claim flow marks used |
| `accessRequests/{uid}` | requester or admin | requester-create (own, `pending`, can't self-approve); admin approve/deny |
| `pendingUsers/{emailKey}` | **only the owning email** (can't enumerate) | admin only |
| `admin/{doc}` | any signed-in user (holds only `maintenanceMode` / `sessionEpoch` — no PII) | admin only |
| everything else | denied | denied (`allow read, write: if false`) |

## Class-code lookup: why `classCodes/{code}` exists

A student resolves a class-join code without knowing which teacher issued it
(`addTeacherByCode` in `student.js`). The first version of this did that with
`collectionGroup('classes').where('inviteCode', '==', code)` — which turned
out to need **two** separate things just to be reachable at all: a rule keyed
purely by collection name via a `{path=**}` wildcard (a rule nested under
`teachers/{teacherId}/classes/{classId}` does not cover a collection-group
query, only requests scoped to one known teacher), *and* a collection-group
scope override on the `inviteCode` field, since Firestore's automatic
single-field indexing doesn't cover collection-group queries by default. Two
independent ways for the lookup to silently break — and the index-build state
in particular isn't something the client, or a rules-emulator test, can see:
the emulator doesn't enforce indexes at all, so a test suite passing there
proves nothing about whether a real collection-group index has finished
building in production.

That whole design is gone. `classCodes/{code}` is a flat top-level collection
where the code **is** the document ID, holding `{ teacherId, classId }`. A
lookup is a plain `get` — no index of any kind, ever, at any collection depth.
It's also tighter: `allow get` (not `list`) means a code resolves for whoever
already holds it, but the collection can't be enumerated to harvest every
class code and teacher ID in the app the way the old collectionGroup rule
allowed.

Every place a code is created or destroyed keeps this in sync: `createClass()`,
`refreshClassCode()` (old code deleted, new one written), `deleteClass()`, and
the legacy-flat-roster migration in `loadClasses()`. Classes created before
this fix existed are backfilled once, lazily, on the owning teacher's next
load — see the `codeMapped` flag in `loadClasses()`.

Verified against the real ruleset with `@firebase/rules-unit-testing`
(ownership enforcement, enumeration blocking, expired-class handling, legacy
fallback) before this was deployed; see git history for the test script if
this needs re-checking.

## Data-retention rules

Two rules exist to limit how long student personal data is reachable:

1. **Class rosters expire on the last day of school.** Each class carries an
   `endDate` timestamp. The roster read rule calls `classNotEnded()`, which
   compares `request.time` against it, so the owning teacher's access ends on
   that date — server-side, on every request, whether or not any client code
   runs. Students and admins keep access: the student so they can still withdraw
   their own record, the admin so somebody can still perform the deletion.
2. **Teachers may delete their own history.** Required so the 2-year checkout
   purge in `retention.js` can actually delete. Previously delete was
   admin-only, which meant expired records could never be removed.

⚠️ **Access ≠ erasure.** These rules end *access* precisely on time. Actual
deletion is done by client-side sweeps in `public/js/retention.js`, which run
when a portal is opened — so records can be unreachable-but-present for a
while. The admin Debug page lists anything in that state. Guaranteed-timely
erasure would need a scheduled Cloud Function.

## Known, intentional trade-offs

- `teachers/{uid}` is world-readable to signed-in users because the "All
  Libraries" discovery screen lists every teacher. Only directory-appropriate
  fields (name, email, library visibility, currently-reading) live there — do
  **not** add secrets to a teacher document.
- The legacy flat roster `teachers/{uid}/students` has **no** `endDate` cut-off,
  because it has no parent class to carry one. The join flow now routes students
  into a real class instead, but any pre-existing entries there are still
  unexpiring — worth migrating.
- `admin/{doc}` is world-readable because the student/teacher portals check
  `maintenanceMode` at load. Keep it limited to non-sensitive operational flags.
- Instant token revocation isn't possible without a Cloud Function. The admin
  "Force Re-login" writes `admin/settings.sessionEpoch`; each portal signs out
  any session older than that stamp on its next load (`shouldForceLogout` in
  `config.js`).
