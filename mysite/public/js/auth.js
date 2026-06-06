// ─────────────────────────────────────────────────────────────────────────────
// auth.js — BookWare login handler  (imported by index.html)
// ─────────────────────────────────────────────────────────────────────────────
import { auth, db } from "./firebase.js";
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
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const ADMIN_EMAILS = [
  "sarvin.sukhe@gmail.com",
  "sarvinsukhe@gmail.com",
  "daepickid540@gmail.com",
];

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

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const overlay = document.getElementById("signinOverlay");
const errorToast = document.getElementById("errorToast");
let errorTimer = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isAdmin = (email) => ADMIN_EMAILS.includes(email?.toLowerCase());

function showLoading(card) {
  overlay?.classList.add("visible");
  overlay?.removeAttribute("hidden");
  card?.classList.add("loading");
}
function hideLoading(card) {
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

    // No account at all — must be invited first
    await signOut(auth);
    showError(
      "Teacher accounts require an invite link. " +
      "Ask your school admin or an existing teacher for one."
    );
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
    await setDoc(uRef, {
      name: user.displayName ?? "",
      email: user.email ?? "",
      role: "student",
      banned: false,
      class: null,
      createdAt: serverTimestamp(),
    });
  }

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
      ({ user } = await signInWithPopup(auth, provider));
    } catch (popupErr) {
      if (REDIRECT_FALLBACK_CODES.has(popupErr.code)) {
        // Remember which portal the user wanted, then redirect-sign-in.
        // getRedirectResult() (below) finishes the flow when we come back.
        sessionStorage.setItem(PENDING_ROLE_KEY, role);
        await signInWithRedirect(auth, provider);
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
  let result;
  try {
    result = await getRedirectResult(auth);
  } catch (err) {
    reportAuthError(err);
    return;
  }
  if (!result?.user) return;
  const role = sessionStorage.getItem(PENDING_ROLE_KEY) || "student";
  sessionStorage.removeItem(PENDING_ROLE_KEY);
  showLoading(null);
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
