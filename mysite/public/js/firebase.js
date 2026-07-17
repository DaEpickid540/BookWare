import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            'AIzaSyBXu-MgR2uIXIeUkvV8jF9AZ_a1mR8mw8s',
  authDomain:        'school-suite-652d8.firebaseapp.com',
  projectId:         'school-suite-652d8',
  storageBucket:     'school-suite-652d8.firebasestorage.app',
  messagingSenderId: '564790135010',
  appId:             '1:564790135010:web:9a57f98bd0e412644436bb',
  measurementId:     'G-WCMJMPWD3S',
};

export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// Apply auth session persistence based on user preference.
// Default ON (browserLocalPersistence) — stays logged in across browser restarts.
// If the user turns off "Stay Signed In" it switches to session-only persistence.
const _staySignedIn = localStorage.getItem('bw-stay-signed-in') !== 'false';
setPersistence(auth, _staySignedIn ? browserLocalPersistence : browserSessionPersistence)
  .catch(() => {/* ignore — non-critical */});

// Safety net: if body is hidden and something throws before auth reveals it,
// show a readable error instead of a blank gray screen.
function revealWithError(reason) {
  if (document.documentElement.style.visibility !== 'hidden') return;
  document.documentElement.style.visibility = 'visible';
  const raw = (reason && reason.message) || String(reason || 'Unknown error');
  const msg = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  document.body.innerHTML =
    '<div style="max-width:520px;margin:80px auto;padding:28px;text-align:center;' +
    'font-family:system-ui,sans-serif;color:#e74c3c;">' +
    '<h2 style="margin:0 0 12px">Couldn’t load your portal</h2>' +
    '<p style="color:#999;word-break:break-word">' + msg + '</p>' +
    '<p style="margin-top:18px"><a href="/" style="color:#4a9eff">← Back to sign in</a></p></div>';
}

window.addEventListener('unhandledrejection', (e) => {
  console.error('[BookWare] Unhandled init error:', e.reason);
  revealWithError(e.reason);
});
window.addEventListener('error', (e) => {
  console.error('[BookWare] Script error:', e.error || e.message);
  revealWithError(e.error || e.message);
});
