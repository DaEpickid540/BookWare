import { auth, db } from "./firebase.js";
import {
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// DOM elements
const logoutBtn = document.getElementById("logoutAdmin");

// Logout
logoutBtn?.addEventListener("click", () => signOut(auth));

// Auth state
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "/";
    return;
  }

  // Verify role is admin
  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists() || userSnap.data().role !== "admin") {
    await signOut(auth);
    window.location.href = "/";
    return;
  }

  // Check admin token claim (requires custom claims from Firebase Admin SDK)
  const idTokenResult = await user.getIdTokenResult(true);
  if (!idTokenResult.claims.admin) {
    console.warn("User claims do not grant admin access");
    // Consider logging out or showing an error
  }

  console.log("Admin authenticated:", user.email);
  // TODO: load admin settings, user management dashboard
});

// Placeholder functions
async function loadAdminSettings() {
  // TODO: fetch admin/settings
  console.log("Loading admin settings...");
}

async function toggleMaintenanceMode(enabled) {
  // TODO: update admin/settings/maintenanceMode
  console.log("Toggling maintenance mode...", enabled);
}

async function loadGlobalBanList() {
  // TODO: fetch admin/settings/globalBanList
  console.log("Loading global ban list...");
}

async function addGlobalBan(uid) {
  // TODO: add uid to admin/settings/globalBanList
  // TODO: set users/{uid}/banned = true
  console.log("Adding global ban...");
}

async function removeGlobalBan(uid) {
  // TODO: remove uid from admin/settings/globalBanList
  // TODO: set users/{uid}/banned = false
  console.log("Removing global ban...");
}

async function loadAllUsers() {
  // TODO: fetch all users (requires additional collection read or Admin SDK)
  console.log("Loading all users...");
}

async function resetUserPassword(uid) {
  // TODO: trigger password reset email (Firebase Auth API)
  console.log("Resetting user password...");
}
