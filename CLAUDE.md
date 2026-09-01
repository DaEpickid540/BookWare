# BookWare — working notes for Claude

BookWare is a classroom-library manager for Mason High School: teachers catalogue
the books on their classroom shelf, students borrow them, and everyone signs in
with a Google account.

## Read this first

**There is no server.** No Node backend, no Cloud Functions, no build step. The
whole app is static files in `mysite/public/` talking directly to Firestore from
the browser. So when someone says "the backend", they mean three things
together, and a change to one without the others is what breaks:

| "The backend" | Lives in | Deployed by |
|---|---|---|
| Data-access code | `mysite/public/js/*-api.js` | Hosting |
| Authorization | `mysite/firestore.rules` | `firebase deploy --only firestore:rules` |
| Query support | `mysite/firestore.indexes.json` | `firebase deploy --only firestore:indexes` |

Anything that can't run in a browser tab (a scheduled job, a secret, a webhook,
sending an actual email) **cannot be added without introducing Cloud Functions
first.** Retention purges are opportunistic for exactly this reason — see the
header comment in `retention.js`. Invite and share buttons open the user's own
mail client via `mailto:`; the app does not send mail.

## Directory layout

```
mysite/public/         ← the entire app. This is what ships.
  js/teacher-api.js    ← teacher data layer  (Firestore)
  js/teacher.js        ← teacher UI          (DOM only)
  js/student.js        ← student portal      (UI + data, not yet split)
  js/admin.js          ← admin portal        (UI + data, not yet split)
  js/retention.js      ← data-retention policy, shared by all three
  js/config.js         ← admin allowlist + school domain
  js/firebase.js       ← the one Firebase app/auth/db instance
mysite/firestore.rules       ← the real security boundary
mysite/firestore.indexes.json
mysite/TEACHER_BACKEND.md    ← data model + invariants for the teacher side
BookWare-main/               ← STALE COPY. Do not edit. See below.
```

### `BookWare-main/` is a stale duplicate

It is an older snapshot of the same app: same filenames, older contents, missing
half the modules. It is tracked in git but nothing deploys from it. Grepping the
repo without excluding it returns two versions of every function and sends you
editing the dead one. **Only `mysite/` ships.** Scope searches to `mysite/`.

## Layering rule for the teacher portal

`teacher.js` renders. `teacher-api.js` talks to Firestore. The split is load
bearing:

- **Never** `import ... from 'firebase-firestore.js'` inside `teacher.js`.
- **Never** touch the DOM inside `teacher-api.js`.
- New teacher-side reads or writes go in `teacher-api.js` as an exported
  function that throws `TeacherApiError`.

`student.js` and `admin.js` predate this and still mix the two. That is a known
debt, not a pattern to copy.

## Rules for changing Firestore access

1. **A new multi-field query needs an index.** Two or more filters, or a filter
   plus an `orderBy` on another field, means a composite index in
   `firestore.indexes.json`. Without one the query throws
   `failed-precondition` at runtime and the panel using it is permanently
   empty — nothing catches it at review time.
2. **Check the rule before writing the code.** Most "it silently doesn't work"
   reports in this repo were a client write the rules never allowed. Read the
   matching `match` block in `firestore.rules` first.
3. **Two documents changing together means a transaction.** Never `Promise.all`
   over independent writes: a partial failure leaves the data inconsistent AND
   reports the whole action as failed, so nobody realises half of it landed.
4. **An admin runs the teacher portal too.** Accounts in `ADMIN_EMAILS` have
   role `"admin"`, for which `isTeacher()` is **false**. Every rule the teacher
   portal depends on needs an `|| isAdmin()` arm. This has bitten repeatedly.
5. `config.js` and `firestore.rules` both hardcode the admin allowlist and the
   school domain. Rules can't import JS. Change one, change the other.

## Deploying

CI (`.github/workflows/firebase-hosting-merge.yml`) deploys rules and indexes
first, then hosting, on every push to `main`. Rules and indexes were previously
**not deployed by anything** — production ran whatever was last pushed by hand.
If the `firestore` job fails on permissions, the service account in
`FIREBASE_SERVICE_ACCOUNT_SCHOOL_SUITE_652D8` needs the *Firebase Rules Admin*
and *Cloud Datastore Index Admin* roles.

By hand, from `mysite/`:

```bash
firebase deploy --only firestore:rules,firestore:indexes --project school-suite-652d8
```

Index builds are asynchronous. A freshly deployed index can take minutes to
finish, and the query keeps failing until it does.

## Running it locally

From the repo root, the preview configs in `.claude/launch.json`:

- `bookware` — `firebase serve` on :5050 (honours `firebase.json` headers/CSP)
- `bookware-static` — plain static server on :5055

Both hit the **real** Firestore project. There is no seeded local dataset.

Compiling the rules locally needs **JDK 21+** — `firebase-tools` refuses older
runtimes:

```bash
firebase emulators:exec --only firestore --project school-suite-652d8 "echo ok"
```

## Decoding a failure

| Symptom | Almost always |
|---|---|
| `permission-denied` | The deployed ruleset doesn't match `firestore.rules`, or the account has role `admin` and the rule only allows `isTeacher()` |
| `failed-precondition` | Missing composite index |
| Panel stuck on "Loading…" forever | An unhandled rejection, or a read that never settles. Every API call has a deadline for this reason; don't add one without |
| Action "fails" but the data changed | Non-atomic multi-document write. Use a transaction |
| Class code says "not found" for students | `classCodes/{CODE}` is missing or points at another class — the class card shows a red warning with a Retry when this happens |

## Conventions

- ES modules, no bundler, no TypeScript, no package.json in `mysite/`.
- Firebase SDK is imported by full `https://www.gstatic.com/firebasejs/10.12.0/`
  URL. Keep the version identical across files.
- New external origins must be added to the CSP `connect-src`/`script-src` in
  `mysite/firebase.json` or the browser blocks them with no visible error.
- Escape every interpolated value with `esc()` before it reaches `innerHTML`.
- Comments explain *why*, especially where the code looks odd because of a bug
  it is deliberately avoiding. Don't strip those.
