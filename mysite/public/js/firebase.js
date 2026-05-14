// ─────────────────────────────────────────────────────────────────────────────
// firebase.js — BookWare Firebase initialization
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyABnCudl3zjwH4TT-_gVtDuyM1TTigv0Aw",
  authDomain: "bookware-site-b04b7.firebaseapp.com",
  projectId: "bookware-site-b04b7",
  storageBucket: "bookware-site-b04b7.firebasestorage.app",
  messagingSenderId: "255583822979",
  appId: "1:255583822979:web:4a02fcaf0d3cf2c81327b6",
  measurementId: "G-M03C4DLPLY",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
