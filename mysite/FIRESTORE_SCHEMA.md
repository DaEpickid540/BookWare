# BookWare Firestore Schema

Every collection BookWare writes, with the fields it actually stores.

**Legend**
- 🔴 **PII** — personally identifies a student or staff member.
- ⏳ **Retention** — deleted automatically; see `public/js/retention.js`.

Anything not marked has no personal data in it.

For how the teacher portal *uses* these collections — the invariants, the rules
contract, and which queries need which index — see
[TEACHER_BACKEND.md](TEACHER_BACKEND.md).

---

## `users/{uid}` 🔴
The role record. Created on first sign-in.

```
name          string            🔴 from the Google account
email         string            🔴 from the Google account
role          "student" | "teacher" | "admin"
banned        boolean
banExpiry     timestamp | null  null on a permanent ban
banReason     string            (only when banned)
bannedBy      uid | "system"
bannedAt      timestamp
class         string | null     legacy, unused by the multi-class system
createdAt     timestamp
```

## `students/{studentId}` 🔴
```
name                  string                🔴
email                 string                🔴
currentBook           bookId | null
currentBookTeacherId  teacherId | null
addedTeachers         array<teacherId>      libraries this student joined
wishlist              array<bookId>
currentlyReading      array<{bookId,...}>
readingProfile        map                   quiz answers (genres/length/vibe/format)
welcomeSeenAt         timestamp | null      first-run intro slideshow shown. Cleared
                                            (with readingProfile) by the admin
                                            portal's "Replay Onboarding".
notifWishlist         boolean
```

### `students/{studentId}/recommendations/{recId}`
Star ratings a student left. Readable only by that student, teachers, admins.

## `teachers/{teacherId}` 🔴
Readable by any signed-in user — this is the in-app library directory. Store
nothing private here.

```
name             string      🔴
email            string      🔴
photoURL         string      🔴
createdAt        timestamp
canInvite        boolean     gates invite creation in firestore.rules
libraryPublic    boolean     discoverable by non-enrolled students
requireApproval  boolean     checkouts need teacher approval
inviteCode       string      legacy single-class code
readingProfile   map
welcomeSeenAt    timestamp | null   first-run intro slideshow shown
currentlyReading {title, author, coverUrl}
```

### `teachers/{teacherId}/classes/{classId}` ⏳
```
name            string
inviteCode      string      6 chars, crypto.getRandomValues. Mirrored into
                            classCodes/{inviteCode} — see below — which is
                            what a student's code entry actually looks up.
endDate         timestamp   ⏳ LAST DAY OF SCHOOL — 23:59:59 local on that day.
                            Required. firestore.rules refuses to serve this
                            class's roster to the teacher once request.time
                            passes it.
rosterPurgedAt  timestamp   set when the roster was actually erased
archived        boolean
createdAt       timestamp
```

### `teachers/{teacherId}/classes/{classId}/students/{studentId}` 🔴 ⏳
The class roster. **The most sensitive collection in the app.**

```
studentId  uid       🔴
name       string    🔴
email      string    🔴
joinedAt   timestamp
joinedVia  "code"
```
⏳ **Deleted on the parent class's `endDate`.** Teacher access is cut off by
`firestore.rules` on that date; erasure runs on the next admin portal load
(only admins can still read an expired roster in order to delete it).

## `classCodes/{code}`
The join-code → class lookup a student's app actually reads. Doc ID is the
code itself.
```
teacherId  uid
classId    string    id within teachers/{teacherId}/classes
createdAt  timestamp
```
Readable by any signed-in user via `get` (never `list` — the collection can't
be enumerated), so a student can resolve a code without knowing which teacher
issued it, without exposing every class code in the app to every user.

**Writes must permit `role: "admin"` as well as `role: "teacher"`** — the
teacher portal admits both, so an owner on the admin allowlist runs it with
role `admin`. Requiring `isTeacher()` alone silently blocked those owners from
registering their codes, which made every code they issued unresolvable.

Kept in sync by `ensureClassCodeMapping()` in `teacher.js`, called from
`createClass()`, `refreshClassCode()`, `deleteClass()`, and every
`loadClasses()`. That helper always **writes then reads back**, and reports
whether the mapping is actually live rather than assuming the write landed; a
class whose code isn't resolvable renders a red warning with the failing error
code and a Retry button, so this can never fail invisibly again.

### `teachers/{teacherId}/books/{bookId}`
```
title, author, isbn, coverUrl, description   string
copies           number
checkedOutCount  number    authoritative count of copies out
status           "available" | "checked_out"
                 Derived: 'checked_out' only when checkedOutCount >= copies.
                 Set consistently on BOTH checkout and return paths.
checkedOutBy     studentId | null
checkedOutAt     timestamp | null
dueDate          timestamp | null
```

### `teachers/{teacherId}/history/{entryId}` 🔴 ⏳
The borrowing ledger — **one row per loan**, and a student education record.

This is the authoritative answer to "who has a copy of this book". The book
document has a single `checkedOutBy` field but can have several copies, so it
can only ever name one borrower; the teacher portal reads loans from here
instead. An open loan is a row with `dateReturned == null`.

```
bookId, bookTitle, author   string
coverUrl      string            denormalised so the list renders without
                                reading every book document
studentId     uid | null     🔴 null once redacted
studentName   string         🔴 "[deleted]" once redacted
dateOut       timestamp
dueDate       timestamp | null  14 days after dateOut
dateReturned  timestamp | null  null = still checked out
returnedBy    uid | null        the teacher who confirmed the return
reconstructed true              synthesised to close a loan that had no row
redactedAt    timestamp         set when the student was erased
```
Written by the student on self-serve checkout, and by the teacher on approval
and on return — `firestore.rules` allows both.
⏳ **Deleted `HISTORY_RETENTION_DAYS` (730 = 2 years) after `dateOut`, and only
once `dateReturned` is set.** An open loan is a live record and is never purged.

### `teachers/{teacherId}/requests/{reqId}` 🔴
Rental approval queue: `studentId`, `studentName` 🔴, `bookId`, `bookTitle`,
`status` ("pending"|"approved"|"denied"), `requestedAt`, `respondedAt`.

### `teachers/{teacherId}/recommendations/{recId}`
Teacher's starred picks. No student data.

### `teachers/{teacherId}/students/{studentId}` 🔴
Two different things share this path.

**1. Membership marker** (the normal case, `membershipOnly: true`)
```
studentId       uid
classId         string    the class whose code they joined with
joinedAt        timestamp
joinedVia       "code" | "backfill"
membershipOnly  true
```
No name, no email — deliberately. It exists purely because
`firestore.rules` decides whether to serve a Class Only library by testing
`exists(teachers/{tid}/students/{uid})`, and nothing else. Writing only the
per-class roster (which is what the join used to do) left every code-joining
student denied every book read, checkout, and rental request.

Written by `addTeacherByCode()` in `student.js`, backfilled for pre-existing
students by `ensureLibraryAccessMarkers()` on portal load, and deleted by
`removeStudent()` (teacher.js) and `purgeEndedClassRosters()` (retention.js) —
so revoking a student, or the school year ending, actually revokes access.
`loadClasses()` skips these when migrating a legacy roster into a class.

**2. Legacy flat roster** 🔴 (no `membershipOnly` flag)
Superseded by per-class rosters; same shape as a class roster entry, carrying
name and email. Still written only when a code resolves to a teacher rather
than a class.

> ⚠️ **Not covered by the `endDate` cut-off** — it has no parent class to carry
> a date. Migrate any remaining entries into a class roster. The membership
> markers above are exempt from this concern: they hold no personal data.

## `invites/{token}` 🔴
```
recipientEmail  string     🔴 "" for an open invite
used, revoked   boolean
expiresAt       timestamp  7 days
createdBy       uid
createdByName   string     🔴
createdByRole   "teacher" | "admin"
claimedBy       uid | null
claimedAt, revokedAt, revokedBy
```
Single-doc `get` is public (the claim page validates before sign-in), so anyone
holding a token can read that invite's recipient email.

## `accessRequests/{uid}` 🔴
Walk-in teacher access requests: `name` 🔴, `email` 🔴, `photoURL` 🔴,
`requestedAt`, `status` ("pending"|"approved"|"denied").

## `pendingUsers/{emailKey}` 🔴
Admin pre-registrations. Doc ID is the lowercased email with dots → `_`.
Readable only by the matching email. Deleted when claimed.

## `admin/settings`
```
maintenanceMode       boolean
sessionEpoch          timestamp   forces re-login for sessions older than this
ariaStudentsEnabled   boolean     school-wide ARIA kill switch for students
ariaTeachersEnabled   boolean     …and, independently, for teachers.
                                  UNSET MEANS ENABLED for both — a failed or
                                  missing read must never silently remove ARIA.
                                  Applied by setAriaAvailability() in theme.js.
```
Readable by any signed-in user (portals check `maintenanceMode` at load), so it
must never hold PII. The old `globalBanList` field was removed for this reason.

---

## Not stored in Firestore

Kept in the browser's own storage, never uploaded:

| Key | Purpose |
|---|---|
| `bookware-preset` / `-color` / `-brightness` / `-btnsize` | Theme |
| `bw-stay-signed-in` | Session persistence choice |
| `bw-aria-enabled` / `-provider` / `-search-provider` | ARIA settings |
| `bw-aria-key-*`, `bw-aria-search-key-*` | The user's **own** AI API keys |
| `bookware-biweekly-{uid}` | Last overdue-reminder timestamp |
| `bw-admin-attempts-{uid}` | Failed admin-access attempts |
| `bw-github-star-shown` | One-time prompt flag |
| `bw-welcomed`, `bw-pending-role` *(sessionStorage)* | Per-session UI state |
| `bw-pending-join` | Class code from a `?join=` QR/share link, held across sign-in |

See `public/privacy.html` for the user-facing version of all of this.
