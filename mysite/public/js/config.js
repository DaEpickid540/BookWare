// config.js — single source of truth for privileged accounts.
//
// IMPORTANT: These values are mirrored in firestore.rules (which cannot import
// JS). If you change the admin list or the teacher domain here, update
// firestore.rules to match — the server-side rules are the real security
// boundary; the checks in client code are only for UX/routing.

// Hardcoded administrators. Gmail ignores dots, so sarvin.sukhe@ and
// sarvinsukhe@ are the same mailbox — both listed for safety.
export const ADMIN_EMAILS = [
  'sarvin.sukhe@gmail.com',
  'sarvinsukhe@gmail.com',
  'daepickid540@gmail.com',
];

// Only accounts on this domain (plus the admins above) may become teachers.
export const ALLOWED_DOMAIN = '@masonohioschools.com';

export const isAdminEmail = (email) =>
  ADMIN_EMAILS.includes((email ?? '').toLowerCase());

export const isTeacherEmail = (email) => {
  const e = (email ?? '').toLowerCase();
  return e.endsWith(ALLOWED_DOMAIN) || ADMIN_EMAILS.includes(e);
};

// ─── Class-join links (QR codes + shareable URLs) ─────────────────────────────
// A teacher can hand out a class code three ways: read it aloud, share a link,
// or show a QR code. All three resolve to the SAME code — the link just carries
// it in `?join=` so the student never has to type it.
//
// The link points at the site root rather than /student.html because a student
// following it is usually signed out, and student.html bounces signed-out
// visitors back to "/" — which would drop the code on the floor. index.html
// stashes it (see login-notice.js) and student.js claims it after sign-in.
export const JOIN_PARAM = 'join';

// Where index.html parks a code while the student signs in. localStorage, not
// sessionStorage: the Google sign-in redirect flow can land in a fresh tab.
export const PENDING_JOIN_KEY = 'bw-pending-join';

/** Absolute join URL for a class code, e.g. https://…/?join=MJ7K2P */
export function buildJoinUrl(code, origin = window.location.origin) {
  return `${origin}/?${JOIN_PARAM}=${encodeURIComponent(String(code ?? '').trim().toUpperCase())}`;
}

/** Pull a class code out of a URL's query string. Returns '' when absent.
 *  Codes are always uppercase and alphanumeric (see genCode in teacher.js), so
 *  anything else is treated as absent rather than passed along to a lookup. */
export function readJoinCode(search = window.location.search) {
  const raw = new URLSearchParams(search).get(JOIN_PARAM) ?? '';
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9-]{4,24}$/.test(code) ? code : '';
}

// Admin "Force Re-login": returns true when the user signed in before the admin
// stamped admin/settings.sessionEpoch. Fail-open — any missing/invalid value
// means "don't log out", so a bad read can never lock people out by accident.
export function shouldForceLogout(settingsSnap, user) {
  try {
    if (!settingsSnap?.exists?.()) return false;
    const epoch = settingsSnap.data().sessionEpoch?.toDate?.();
    if (!epoch || isNaN(epoch.getTime())) return false;
    const lastRaw = user?.metadata?.lastSignInTime;
    if (!lastRaw) return false;
    const last = new Date(lastRaw);
    if (isNaN(last.getTime())) return false;
    return last.getTime() < epoch.getTime();
  } catch (_) {
    return false;
  }
}
