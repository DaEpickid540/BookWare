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

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const statusEl = document.getElementById("statusMessage");
const signInBtn = document.getElementById("signInBtn");
const btnLabel = document.getElementById("btnLabel");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setStatus(msg, type = "info") {
  statusEl.textContent = msg;
  statusEl.className = type; // "info" | "error" | "success"
}

function setLoading(isLoading) {
  signInBtn.disabled = isLoading;
  btnLabel.innerHTML = isLoading
    ? '<span class="spinner"></span> Working…'
    : "Sign in with Google";
}

// ─── Step 1: Read and validate token (no auth required — rules allow public read)
const params = new URLSearchParams(window.location.search);
const token = params.get("token");

if (!token) {
  setStatus("Invalid invite link: no token provided.", "error");
  // Leave button disabled permanently — nothing to do.
} else {
  validateToken(token);
}

async function validateToken(token) {
  let inviteData;

  try {
    const inviteRef = doc(db, "invites", token);
    const inviteSnap = await getDoc(inviteRef);

    if (!inviteSnap.exists()) {
      setStatus("This invite link is invalid.", "error");
      return;
    }

    inviteData = inviteSnap.data();
  } catch (err) {
    console.error("Token read failed:", err);
    setStatus("Failed to validate invite. Please try again.", "error");
    return;
  }

  // Check already used
  if (inviteData.used === true) {
    setStatus("This invite link has already been used.", "error");
    return;
  }

  // Check expiry — inviteData.expiresAt is a Firestore Timestamp
  const now = new Date();
  if (inviteData.expiresAt && inviteData.expiresAt.toDate() < now) {
    setStatus("This invite link has expired.", "error");
    return;
  }

  // Token is valid — enable the sign-in button
  setStatus(
    "Invite verified! Sign in with your Google account to continue.",
    "info",
  );
  signInBtn.disabled = false;

  // ─── Step 2: Handle sign-in click ─────────────────────────────────────────
  signInBtn.addEventListener("click", () => handleSignup(token, inviteData), {
    once: true,
  });
}

// ─── Step 3: Sign in, write Firestore docs, mark invite used, redirect ────────
async function handleSignup(token, inviteData) {
  setLoading(true);

  let user;

  // Sign in with Google
  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    user = result.user;
  } catch (err) {
    console.error("Sign-in failed:", err);
    setStatus("Sign-in was cancelled or failed. Please try again.", "error");
    setLoading(false);
    signInBtn.addEventListener("click", () => handleSignup(token, inviteData), {
      once: true,
    });
    return;
  }

  try {
    // Check if this account already has a role (prevent overwriting)
    const existingUserRef = doc(db, "users", user.uid);
    const existingUserSnap = await getDoc(existingUserRef);
    if (existingUserSnap.exists()) {
      setStatus(
        "This Google account is already registered in BookWare.",
        "error",
      );
      setLoading(false);
      return;
    }

    // Write users/{uid} — exactly the fields in the schema
    // Security rule: allow write if request.auth.uid == uid ✓
    await setDoc(doc(db, "users", user.uid), {
      name: user.displayName,
      email: user.email,
      role: "teacher",
      banned: false,
      class: null,
      createdAt: serverTimestamp(),
    });

    // Write teachers/{uid} — exactly the fields in the schema
    // Security rule: allow write if request.auth.uid == teacherId ✓
    await setDoc(doc(db, "teachers", user.uid), {
      name: user.displayName,
      email: user.email,
      createdAt: serverTimestamp(),
      canInvite: false, // Admin or existing teacher can grant this later
    });

    // Mark invite as used
    // Security rule: allow write if request.auth != null ✓
    await updateDoc(doc(db, "invites", token), {
      used: true,
    });
  } catch (err) {
    console.error("Account setup failed:", err);
    setStatus(
      "Account setup failed. Please contact an administrator.",
      "error",
    );
    setLoading(false);
    return;
  }

  setStatus("Account created! Redirecting…", "success");
  window.location.href = "/teacher.html";
}
