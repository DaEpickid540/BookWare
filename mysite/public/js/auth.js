import { auth, db } from "./firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

async function login(role) {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  const user = result.user;

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
