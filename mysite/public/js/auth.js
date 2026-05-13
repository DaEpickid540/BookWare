import { auth, db } from "./firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

async function login(role) {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  const user = result.user;

  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      name: user.displayName,
      email: user.email,
      role: role,
      banned: false,
    });
  }

  const finalRole = (await getDoc(ref)).data().role;

  if (finalRole === "student") window.location.href = "/student.html";
  if (finalRole === "teacher") window.location.href = "/teacher.html";
  if (finalRole === "admin") window.location.href = "/admin.html";
}

document.getElementById("studentLogin").onclick = () => login("student");
document.getElementById("teacherLogin").onclick = () => login("teacher");
document.getElementById("adminLogin").onclick = () => login("admin");
