import { auth, db } from "./firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const statusEl = document.getElementById("statusMessage");
const signInBtn = document.getElementById("signInBtn");
const btnLabel = document.getElementById("btnLabel");

function setStatus(msg, type = "info") {
  statusEl.textContent = msg;
  statusEl.className = type;
}

function setLoading(on) {
  signInBtn.disabled = on;
  btnLabel.innerHTML = on
    ? '<span class="spinner"></span> Working…'
    : "Sign in with Google";
}

// ── Step 1: Validate token from URL ─────────────────────────────────────────
const token = new URLSearchParams(window.location.search).get("token");

if (!token) {
  setStatus("Invalid invite link — no token found.", "error");
} else {
  validateToken(token);
}

async function validateToken(token) {
  try {
    const snap = await getDoc(doc(db, "invites", token));
    if (!snap.exists()) {
      setStatus("This invite link is invalid.", "error");
      return;
    }
    if (snap.data().used === true) {
      setStatus("This invite link has already been used.", "error");
      return;
    }
    if (snap.data().expiresAt?.toDate() < new Date()) {
      setStatus("This invite link has expired.", "error");
      return;
    }

    setStatus(
      "Invite verified! Sign in with Google to create your teacher account.",
      "info",
    );
    signInBtn.disabled = false;
    signInBtn.addEventListener("click", () => handleSignup(token), {
      once: true,
    });
  } catch (err) {
    console.error(err);
    setStatus("Failed to validate invite. Please try again.", "error");
  }
}

// ── Step 2: Google sign-in + account creation ────────────────────────────────
async function handleSignup(token) {
  setLoading(true);
  let user;

  try {
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    user = result.user;
  } catch (err) {
    console.error(err);
    setStatus("Sign-in was cancelled or failed. Please try again.", "error");
    setLoading(false);
    signInBtn.addEventListener("click", () => handleSignup(token), {
      once: true,
    });
    return;
  }

  try {
    // Check for existing account
    const existingSnap = await getDoc(doc(db, "users", user.uid));
    if (existingSnap.exists()) {
      setStatus(
        "This Google account is already registered in BookWare.",
        "error",
      );
      setLoading(false);
      return;
    }

    // Create users/{uid}
    await setDoc(doc(db, "users", user.uid), {
      name: user.displayName,
      email: user.email,
      role: "teacher",
      banned: false,
      class: null,
      createdAt: serverTimestamp(),
    });

    // Create teachers/{uid} — all teachers get canInvite: true, no admin needed
    await setDoc(doc(db, "teachers", user.uid), {
      name: user.displayName,
      email: user.email,
      createdAt: serverTimestamp(),
      canInvite: true, // every teacher can invite others
      libraryPublic: false,
    });

    // Mark invite used
    await updateDoc(doc(db, "invites", token), { used: true });
  } catch (err) {
    console.error(err);
    setStatus(
      "Account setup failed. Please contact an administrator.",
      "error",
    );
    setLoading(false);
    return;
  }

  setStatus("Account created! Redirecting…", "success");
  setTimeout(() => {
    window.location.href = "/teacher.html";
  }, 800);
}
