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
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── Access Control ────────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = "@masonohioschools.com";
const ADMIN_EMAILS = ["sarvin.sukhe@gmail.com", "daepickid540@gmail.com"];

function isEmailAllowed(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  return lower.endsWith(ALLOWED_DOMAIN) || ADMIN_EMAILS.includes(lower);
}

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(email?.toLowerCase());
}

function showError(msg) {
  const el = document.getElementById("loginError");
  if (el) {
    el.textContent = msg;
    el.style.display = "block";
  } else {
    alert(msg);
  }
}

async function login(role) {
  // Block non-admins from even attempting admin login
  if (role === "admin") {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    let result;
    try {
      result = await signInWithPopup(auth, provider);
    } catch (e) {
      return;
    }
    const user = result.user;
    if (!isAdminEmail(user.email)) {
      await signOut(auth);
      showError("Access denied. Admin login is restricted.");
      return;
    }
    // Ensure user doc exists and has role: "admin"
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await setDoc(userRef, {
        name: user.displayName,
        email: user.email,
        role: "admin",
        banned: false,
        class: null,
        createdAt: serverTimestamp(),
      });
    } else if (userSnap.data().role !== "admin") {
      // Existing account (e.g. teacher) — elevate to admin
      try {
        await updateDoc(userRef, { role: "admin" });
      } catch (e) {
        console.error("[auth.js] Failed to elevate role to admin:", e);
        showError("Could not set admin role. Contact the system administrator.");
        await signOut(auth);
        return;
      }
    }
    window.location.href = "/admin.html";
    return;
  }

  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  const user = result.user;

  // ─── Email allowlist gate ─────────────────────────────────────────────────
  if (!isEmailAllowed(user.email)) {
    await signOut(auth);
    showError("Access denied. Only Mason Ohio Schools accounts are allowed.");
    return;
  }

  // ─── Prevent school staff from accessing admin via student/teacher buttons ─
  // (admin emails can still use student/teacher portals if they want)

  // ─── Create or verify users/{uid} ────────────────────────────────────────
  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    await setDoc(userRef, {
      name: user.displayName,
      email: user.email,
      role: role,
      banned: false,
      class: null, // students can be assigned to a teacher later
      createdAt: serverTimestamp(),
    });
  }

  // ─── Create role-specific docs ──────────────────────────────────────────
  const finalRole = (await getDoc(userRef)).data().role;

  // ─── Ban check on login ─────────────────────────────────────────────────
  const latestUserData = (await getDoc(userRef)).data();
  if (latestUserData.banned === true) {
    const expiry = latestUserData.banExpiry?.toDate?.();
    if (!expiry || expiry > new Date()) {
      await signOut(auth);
      const days = expiry ? Math.ceil((expiry - new Date()) / 86400000) : "permanently";
      const reason = latestUserData.banReason ?? "Policy violation";
      window.location.href = `/?banned=1&reason=${encodeURIComponent(reason)}&days=${days}`;
      return;
    }
  }

  if (finalRole === "student") {
    // Create students/{uid} doc if it doesn't exist — schema: { name, email, currentBook, wishlist, banned }
    const studentRef = doc(db, "students", user.uid);
    const studentSnap = await getDoc(studentRef);
    if (!studentSnap.exists()) {
      await setDoc(studentRef, {
        name: user.displayName,
        email: user.email,
        currentBook: null,
        wishlist: [],
        banned: false,
      });
    }
    window.location.href = "/student.html";
  }

  if (finalRole === "teacher") {
    // Create teachers/{uid} doc if it doesn't exist — schema: { name, email, createdAt, canInvite }
    const teacherRef = doc(db, "teachers", user.uid);
    const teacherSnap = await getDoc(teacherRef);
    if (!teacherSnap.exists()) {
      await setDoc(teacherRef, {
        name: user.displayName,
        email: user.email,
        createdAt: serverTimestamp(),
        canInvite: false, // Admin or another teacher must grant this
      });
    }
    window.location.href = "/teacher.html";
  }

  if (finalRole === "admin") {
    window.location.href = "/admin.html";
  }
}

document.getElementById("studentLogin").onclick = () => login("student");
document.getElementById("teacherLogin").onclick = () => login("teacher");
document.getElementById("adminLogin").onclick = () => login("admin");
