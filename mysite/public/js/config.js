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
