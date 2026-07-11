// ─────────────────────────────────────────────────────────────────────────────
// auth.js — BookWare login handler  (imported by index.html)
// ─────────────────────────────────────────────────────────────────────────────
import { auth, db } from "./firebase.js";
import { ADMIN_EMAILS } from "./config.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Errors where the popup can't work in this environment (blocked, COOP handshake
// failure, storage disabled, etc.) — for these we fall back to a full-page redirect.
const REDIRECT_FALLBACK_CODES = new Set([
  "auth/popup-blocked",
  "auth/cancelled-popup-request",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported",
  "auth/internal-error",
]);

const PENDING_ROLE_KEY = "bw-pending-role";

// How long to wait on a sign-in step before treating it as stuck/interrupted
// rather than leaving the spinner spinning forever. Generous enough for a
// slow network or 2FA prompt, short enough that a genuine hang isn't mistaken
// for "still working."
const AUTH_TIMEOUT_MS = 20000;
const AUTO_RELOAD_SECONDS = 8;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const overlay = document.getElementById("signinOverlay");
const spinnerEl = document.getElementById("signinSpinner");
const labelEl = document.getElementById("signinLabel");
const stuckEl = document.getElementById("signinStuck");
const reloadBtn = document.getElementById("signinReloadBtn");
const reloadCountdownEl = document.getElementById("signinReloadCountdown");
const errorToast = document.getElementById("errorToast");
let errorTimer = null;
let reloadTimer = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isAdmin = (email) => ADMIN_EMAILS.includes(email?.toLowerCase());

function showLoading(card) {
  stuckEl?.setAttribute("hidden", "");
  spinnerEl?.removeAttribute("hidden");
  labelEl?.removeAttribute("hidden");
  overlay?.classList.add("visible");
  overlay?.removeAttribute("hidden");
  card?.classList.add("loading");
}
function hideLoading(card) {
  // Don't hide the overlay out from under the stuck-state recovery UI — it
  // needs to stay up until the user reloads (manually or via the countdown).
  if (stuckEl && !stuckEl.hidden) return;
  overlay?.classList.remove("visible");
  card?.classList.remove("loading");
}
function showError(msg) {
  clearTimeout(errorTimer);
  if (!errorToast) {
    alert(msg);
    return;
  }
  errorToast.textContent = msg;
  errorToast.classList.add("visible");
  errorTimer = setTimeout(() => errorToast.classList.remove("visible"), 6000);
}

// Races `promise` against a timer — if sign-in hasn't settled within `ms`, we
// treat it as interrupted (this is a real, known failure mode: a popup that
// gets closed in an unusual way, a dropped network mid-redirect, or a broken
// COOP/storage handshake can leave the underlying Firebase promise neither
// resolving nor rejecting, which otherwise spins the loading overlay forever).
function withTimeout(promise, ms = AUTH_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("Sign-in timed out"), { code: "bw/auth-timeout" }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Replaces the spinner with a clear "this is stuck" message, a manual Reload
// button, and an auto-reload countdown — so an interrupted sign-in always has
// a visible way out instead of an indefinite spinner.
function showStuckState() {
  clearTimeout(reloadTimer);
  spinnerEl?.setAttribute("hidden", "");
  labelEl?.setAttribute("hidden", "");
  stuckEl?.removeAttribute("hidden");
  overlay?.classList.add("visible");
  overlay?.removeAttribute("hidden");

  let secondsLeft = AUTO_RELOAD_SECONDS;
  if (reloadCountdownEl) reloadCountdownEl.textContent = String(secondsLeft);
  reloadTimer = setInterval(() => {
    secondsLeft -= 1;
    if (reloadCountdownEl) reloadCountdownEl.textContent = String(Math.max(secondsLeft, 0));
    if (secondsLeft <= 0) {
      clearInterval(reloadTimer);
      window.location.reload();
    }
  }, 1000);
}

reloadBtn?.addEventListener("click", () => window.location.reload());

async function ensureUserDoc(user, role) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      name: user.displayName ?? "",
      email: user.email ?? "",
      role,
      banned: false,
      class: null,
      createdAt: serverTimestamp(),
    });
  } else if (role === "admin" && snap.data().role !== "admin") {
    await updateDoc(ref, { role: "admin" });
  } else if (role === "teacher" && snap.data().role === "student") {
    // Upgrade a stale student doc to teacher when they register as teacher
    await updateDoc(ref, { role: "teacher" });
  }
}

// ─── Admin pre-registration claim ──────────────────────────────────────────────
// Mirrors the doc-id transform used by admin.js submitAddUser.
const emailKeyFor = (email) => (email ?? "").toLowerCase().trim().replace(/\./g, "_");

// If an admin pre-added this email via "Add User", return { role, ref } so the
// caller can provision the account and THEN delete the record. The order
// matters: firestore.rules' hasPendingRole() must still see the pendingUsers
// doc while the users doc is being created, so deletion happens only after
// provisioning succeeds.
async function peekPendingUser(user) {
  try {
    const ref  = doc(db, "pendingUsers", emailKeyFor(user.email));
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return { ref, role: snap.data().role === "teacher" ? "teacher" : "student" };
  } catch (_) {
    return null;
  }
}

// Create the users doc + role-specific doc for a brand-new account.
async function provisionUser(user, role) {
  await setDoc(doc(db, "users", user.uid), {
    name: user.displayName ?? "",
    email: user.email ?? "",
    role,
    banned: false,
    class: null,
    createdAt: serverTimestamp(),
  });
  if (role === "teacher") {
    await setDoc(doc(db, "teachers", user.uid), {
      name: user.displayName ?? "",
      email: user.email ?? "",
      createdAt: serverTimestamp(),
      canInvite: true,
      libraryPublic: false,
    });
  } else {
    await setDoc(doc(db, "students", user.uid), {
      name: user.displayName ?? "",
      email: user.email ?? "",
      currentBook: null,
      wishlist: [],
      wishlistMeta: {},
      banned: false,
    });
  }
}

// ─── Post-auth provisioning + routing (shared by popup and redirect paths) ─────
async function completeLogin(user, role) {
  // ── Admin ─────────────────────────────────────────────────────────────────
  if (role === "admin") {
    if (!isAdmin(user.email)) {
      await signOut(auth);
      showError("Admin access is restricted to authorized accounts.");
      return;
    }
    await ensureUserDoc(user, "admin");
    window.location.href = "/admin.html";
    return;
  }

  // ── Teacher ───────────────────────────────────────────────────────────────
  // Invite-only: the "Teacher" button is for existing teachers signing back in.
  // New accounts must come through an admin or teacher invite link.
  if (role === "teacher") {
    const uRef  = doc(db, "users", user.uid);
    const uSnap = await getDoc(uRef);

    if (uSnap.exists()) {
      const r = uSnap.data().role;
      if (r === "teacher" || r === "admin") {
        // Existing teacher / admin — let through
        window.location.href = "/teacher.html";
        return;
      }
      // Has a student account — wrong portal
      await signOut(auth);
      showError("Your account is registered as a student. Please use the Student sign-in.");
      return;
    }

    // No account — was this email pre-added by an admin?
    const pending = await peekPendingUser(user);
    if (pending) {
      await provisionUser(user, pending.role);
      await deleteDoc(pending.ref).catch(() => {/* non-critical */});
      window.location.href = pending.role === "teacher" ? "/teacher.html" : "/student.html";
      return;
    }

    // Not pre-registered — send to the access page so they can enter
    // an invite code or submit an admin approval request (stay signed in)
    window.location.href = '/teacher-access.html';
    return;
  }

  // ── Student ───────────────────────────────────────────────────────────────
  const uRef = doc(db, "users", user.uid);
  const uSnap = await getDoc(uRef);

  // Already has a non-student account — redirect to correct portal
  if (uSnap.exists() && uSnap.data().role !== "student") {
    const r = uSnap.data().role;
    window.location.href = r === "teacher" ? "/teacher.html" : "/admin.html";
    return;
  }

  if (!uSnap.exists()) {
    // New account — honor an admin pre-registration if one exists
    const pending = await peekPendingUser(user);
    if (pending?.role === "teacher") {
      await provisionUser(user, "teacher");
      await deleteDoc(pending.ref).catch(() => {/* non-critical */});
      window.location.href = "/teacher.html";
      return;
    }
    await provisionUser(user, "student");
    if (pending) await deleteDoc(pending.ref).catch(() => {/* non-critical */});
    window.location.href = "/student.html";
    return;
  }

  // Existing student — make sure their students doc exists
  const sRef = doc(db, "students", user.uid);
  const sSnap = await getDoc(sRef);
  if (!sSnap.exists()) {
    await setDoc(sRef, {
      name: user.displayName ?? "",
      email: user.email ?? "",
      currentBook: null,
      wishlist: [],
      wishlistMeta: {},
      banned: false,
    });
  }

  window.location.href = "/student.html";
}

// ─── Surfaced error handling ───────────────────────────────────────────────────
function reportAuthError(err) {
  if (err.code === "bw/auth-timeout") {
    console.error("[auth] sign-in stuck/timed out:", err);
    showStuckState();
    return;
  }
  if (err.code === "auth/popup-closed-by-user") return;
  if (err.code === "auth/network-request-failed") {
    showError("Network error. Check your connection and try again.");
    return;
  }
  if (err.code === "auth/unauthorized-domain") {
    showError(
      `This domain (${window.location.hostname}) isn't authorized in Firebase. ` +
        `Add it under Authentication → Settings → Authorized domains.`,
    );
    return;
  }
  showError(
    `Sign-in failed (${err.code ?? err.message ?? "unknown"}). Check the console for details.`,
  );
  console.error("[auth] login failed:", err);
}

// ─── Core login (popup with redirect fallback) ─────────────────────────────────
async function login(role, cardEl) {
  showLoading(cardEl);
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });

    let user;
    try {
      ({ user } = await withTimeout(signInWithPopup(auth, provider)));
    } catch (popupErr) {
      if (REDIRECT_FALLBACK_CODES.has(popupErr.code)) {
        // Remember which portal the user wanted, then redirect-sign-in.
        // getRedirectResult() (below) finishes the flow when we come back.
        sessionStorage.setItem(PENDING_ROLE_KEY, role);
        await withTimeout(signInWithRedirect(auth, provider));
        return; // navigating away
      }
      throw popupErr;
    }

    await completeLogin(user, role);
  } catch (err) {
    reportAuthError(err);
  } finally {
    hideLoading(cardEl);
  }
}

// ─── Complete a redirect-based sign-in when we land back on the page ───────────
(async () => {
  // PENDING_ROLE_KEY is only set right before we call signInWithRedirect, so
  // its presence means this page load is genuinely "returning from Google" —
  // show the spinner (and, if this hangs, the stuck-state recovery UI) only
  // in that case. An ordinary page visit shouldn't show either.
  const returningFromRedirect = !!sessionStorage.getItem(PENDING_ROLE_KEY);
  if (returningFromRedirect) showLoading(null);

  let result;
  try {
    result = await withTimeout(getRedirectResult(auth));
  } catch (err) {
    if (returningFromRedirect) reportAuthError(err);
    else console.warn("[auth] getRedirectResult check failed:", err);
    hideLoading(null);
    return;
  }
  if (!result?.user) { hideLoading(null); return; }

  const role = sessionStorage.getItem(PENDING_ROLE_KEY) || "student";
  sessionStorage.removeItem(PENDING_ROLE_KEY);
  try {
    await completeLogin(result.user, role);
  } catch (err) {
    reportAuthError(err);
  } finally {
    hideLoading(null);
  }
})();

// ─── Button bindings ──────────────────────────────────────────────────────────
document.getElementById("studentLogin")?.addEventListener("click", function () {
  login("student", this);
});
document.getElementById("teacherLogin")?.addEventListener("click", function () {
  login("teacher", this);
});
document.getElementById("adminLogin")?.addEventListener("click", function () {
  login("admin", this);
});
