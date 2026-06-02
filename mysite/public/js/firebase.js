// ─────────────────────────────────────────────────────────────────────────────
// firebase.js — BookWare Firebase initialization
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAHYS-XvdJ5O0uEU-e8-aSDwRDm6_nWOSs",
  authDomain: "bookware-site2.firebaseapp.com",
  projectId: "bookware-site2",
  storageBucket: "bookware-site2.firebasestorage.app",
  messagingSenderId: "262580903929",
  appId: "1:262580903929:web:97dd44ad3f2184b799a728",
  measurementId: "G-DFX36Z7JLY",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ─── Gray-screen safety net ──────────────────────────────────────────────────
// Every portal page hides <body> until its auth guard reveals it. If anything
// throws before that (denied Firestore read, network blip, etc.) the page would
// otherwise stay gray forever with no feedback. This turns that into a readable
// error. Covers admin/student/teacher since they all import firebase.js.
function revealWithError(reason) {
  if (getComputedStyle(document.body).visibility !== "hidden") return;
  document.body.style.visibility = "visible";
  const msg = (reason && reason.message) || String(reason || "Unknown error");
  document.body.innerHTML =
    '<div style="max-width:520px;margin:80px auto;padding:24px;text-align:center;' +
    'font-family:system-ui,sans-serif;color:#e74c3c;">' +
    '<h2 style="margin:0 0 12px">Couldn\u2019t load your portal</h2>' +
    '<p style="color:#999;word-break:break-word">' + msg + "</p>" +
    '<p><a href="/" style="color:#4a9eff">\u2190 Back to sign in</a></p></div>';
}
window.addEventListener("unhandledrejection", (e) => {
  console.error("[BookWare] Unhandled init error:", e.reason);
  revealWithError(e.reason);
});
window.addEventListener("error", (e) => {
  console.error("[BookWare] Script error:", e.error || e.message);
  revealWithError(e.error || e.message);
});
