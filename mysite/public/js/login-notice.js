// login-notice.js — shows why a user was bounced back to the sign-in page.
//
// Extracted from an inline <script>: the Content-Security-Policy in
// firebase.json sets script-src 'self' with no 'unsafe-inline', so the inline
// version never executed in production. student.js and admin.js redirect banned
// users here with ?banned=… and the reason simply never appeared — a suspended
// account landed on a blank login page with no explanation at all.
//
// Load with `defer` so #loginError exists by the time this runs.
(function () {
  var p  = new URLSearchParams(window.location.search);
  var el = document.getElementById('loginError');
  if (!el) return;

  var banned = p.get('banned');
  if (banned === 'admin') {
    el.textContent =
      'Your account has been suspended for 24 hours due to repeated unauthorized access attempts.';
    el.hidden = false;
  } else if (banned === '1') {
    var reason = p.get('reason') || 'Policy violation';
    var days   = p.get('days')   || 'some time';
    el.textContent =
      'Account suspended for ' + days + ' day(s): ' + reason +
      '. Contact your teacher or administrator.';
    el.hidden = false;
  }

  // Clear the query string so a refresh doesn't re-show the message.
  if (banned) history.replaceState(null, '', '/');
})();
