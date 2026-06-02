// ─────────────────────────────────────────────────────────────────────────────
// auth.js — BookWare login handler  (imported by index.html)
// ─────────────────────────────────────────────────────────────────────────────
import { auth, db } from "./firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
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
const ALLOWED_DOMAIN = "@masonohioschools.com";
const ADMIN_EMAILS   = ["sarvin.sukhe@gmail.com", "daepickid540@gmail.com"];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const overlay    = document.getElementById("signinOverlay");
const errorToast = document.getElementById("errorToast");
let   errorTimer = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isAllowed = (email) => {
  if (!email) return false;
  const e = email.toLowerCase();
  return e.endsWith(ALLOWED_DOMAIN) || ADMIN_EMAILS.includes(e);
};
const isAdmin = (email) => ADMIN_EMAILS.includes(email?.toLowerCase());

function showLoading(card) {
  overlay?.classList.add("visible");
  card?.classList.add("loading");
}
function hideLoading(card) {
  overlay?.classList.remove("visible");
  card?.classList.remove("loading");
}
function showError(msg) {
  clearTimeout(errorTimer);
  if (!errorToast) { alert(msg); return; }
  errorToast.textContent = msg;
  errorToast.classList.add("visible");
  errorTimer = setTimeout(() => errorToast.classList.remove("visible"), 6000);
}

async function ensureUserDoc(user, role) {
  const ref  = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      name:      user.displayName ?? "",
      email:     user.email       ?? "",
      role,
      banned:    false,
      class:     null,
      createdAt: serverTimestamp(),
    });
  } else if (role === "admin" && snap.data().role !== "admin") {
    // Previous broken attempt stored wrong role — fix it.
    // Firestore rules allow admin-email accounts to self-update their own role to admin.
    await updateDoc(ref, { role: "admin" });
  }
}

// ─── Core login ───────────────────────────────────────────────────────────────
async function login(role, cardEl) {
  showLoading(cardEl);
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const { user } = await signInWithPopup(auth, provider);

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

    // ── Email gate (teacher + student) ───────────────────────────────────────
    if (!isAllowed(user.email)) {
      await signOut(auth);
      showError("Only Mason Ohio Schools accounts are allowed.");
      return;
    }

    // ── Teacher ───────────────────────────────────────────────────────────────
    if (role === "teacher") {
      const tSnap = await getDoc(doc(db, "teachers", user.uid));
      if (!tSnap.exists()) {
        await signOut(auth);
        showError(
          "No teacher account found. Register via your invite link first, then sign in here."
        );
        return;
      }
      await ensureUserDoc(user, "teacher");
      window.location.href = "/teacher.html";
      return;
    }

    // ── Student ───────────────────────────────────────────────────────────────
    const uRef  = doc(db, "users", user.uid);
    const uSnap = await getDoc(uRef);

    // Already has a non-student account — redirect to correct portal
    if (uSnap.exists() && uSnap.data().role !== "student") {
      const r = uSnap.data().role;
      window.location.href = r === "teacher" ? "/teacher.html" : "/admin.html";
      return;
    }

    if (!uSnap.exists()) {
      await setDoc(uRef, {
        name:      user.displayName ?? "",
        email:     user.email       ?? "",
        role:      "student",
        banned:    false,
        class:     null,
        createdAt: serverTimestamp(),
      });
    }

    // Ensure students/{uid} profile exists
    const sRef  = doc(db, "students", user.uid);
    const sSnap = await getDoc(sRef);
    if (!sSnap.exists()) {
      await setDoc(sRef, {
        name:         user.displayName ?? "",
        email:        user.email       ?? "",
        currentBook:  null,
        wishlist:     [],
        wishlistMeta: {},
        banned:       false,
      });
    }

    window.location.href = "/student.html";

  } catch (err) {
    if (err.code === "auth/popup-closed-by-user") return;
    if (err.code === "auth/popup-blocked") {
      showError("Pop-ups are blocked — allow pop-ups for this site and try again.");
      return;
    }
    if (err.code === "auth/network-request-failed") {
      showError("Network error. Check your connection and try again.");
      return;
    }
    // Show the real error code so it's not a mystery anymore
    showError(`Sign-in failed (${err.code ?? err.message ?? "unknown"}). Check the console for details.`);
    console.error("[auth] login failed:", err);
  } finally {
    hideLoading(cardEl);
  }
}

// ─── Button bindings ──────────────────────────────────────────────────────────
document
  .getElementById("studentLogin")
  .addEventListener("click", function () { login("student", this); });
document
  .getElementById("teacherLogin")
  .addEventListener("click", function () { login("teacher", this); });
document
  .getElementById("adminLogin")
  .addEventListener("click", function () { login("admin", this); });
