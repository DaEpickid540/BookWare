// login-notice.js — messages shown on the sign-in page before anyone signs in.
//
// Two jobs:
//   1. Explain why a user was bounced back here (?banned=…).
//   2. Catch a class join code arriving from a teacher's QR code or share link
//      (?join=CODE), park it, and tell the student what's about to happen.
//
// Originally an inline <script>: the Content-Security-Policy in firebase.json
// sets script-src 'self' with no 'unsafe-inline', so the inline version never
// executed in production and a suspended account landed on a blank login page
// with no explanation at all. It is now an ES module (deferred by default) so
// it can share the join-link constants with the rest of the app instead of
// re-declaring its own copies.
import { PENDING_JOIN_KEY, JOIN_PARAM, readJoinCode } from './config.js';

const params = new URLSearchParams(window.location.search);

// ── Why you were signed out ───────────────────────────────────────────────────
const errEl  = document.getElementById('loginError');
const banned = params.get('banned');
if (errEl && banned === 'admin') {
  errEl.textContent =
    'Your account has been suspended for 24 hours due to repeated unauthorized access attempts.';
  errEl.hidden = false;
} else if (errEl && banned === '1') {
  const reason = params.get('reason') || 'Policy violation';
  const days   = params.get('days')   || 'some time';
  errEl.textContent =
    `Account suspended for ${days} day(s): ${reason}. Contact your teacher or administrator.`;
  errEl.hidden = false;
}

// ── Class join link ───────────────────────────────────────────────────────────
// student.html bounces signed-out visitors straight back to "/", so the code
// can't simply ride along on the URL — it's parked here and claimed by
// student.js (consumePendingJoinCode) once the student is actually signed in.
const joinCode = readJoinCode();
if (joinCode) {
  try { localStorage.setItem(PENDING_JOIN_KEY, joinCode); } catch (_) {}

  const banner = document.getElementById('joinNotice');
  const codeEl = document.getElementById('joinNoticeCode');
  if (banner && codeEl) {
    codeEl.textContent = joinCode;
    banner.hidden = false;
  }
  // Nudge them at the right button — a join link is always a student join, and
  // the three portal cards otherwise give no clue which one to press.
  document.getElementById('studentLogin')?.classList.add('portal-card--suggested');
}

// Clear the query string so a refresh doesn't re-show the message or re-arm the
// join. The parked code in localStorage is what survives the sign-in round trip.
if (banned || params.has(JOIN_PARAM)) history.replaceState(null, '', '/');
