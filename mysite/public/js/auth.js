// auth.js — Login handler for index.html
import { auth, db } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ADMIN_EMAILS = ['sarvin.sukhe@gmail.com', 'daepickid540@gmail.com'];

const overlay    = document.getElementById('signinOverlay');
const errorToast = document.getElementById('errorToast');
let   errorTimer = null;

const isAdmin = email => ADMIN_EMAILS.includes(email?.toLowerCase());

function showLoading(card) {
  overlay?.classList.add('visible');
  overlay?.removeAttribute('hidden');
  card?.classList.add('loading');
}
function hideLoading(card) {
  overlay?.classList.remove('visible');
  card?.classList.remove('loading');
}

function showError(msg) {
  clearTimeout(errorTimer);
  if (!errorToast) { alert(msg); return; }
  errorToast.textContent = msg;
  errorToast.classList.add('visible');
  errorTimer = setTimeout(() => errorToast.classList.remove('visible'), 6500);
}

async function ensureUserDoc(user, role) {
  const ref  = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      name:      user.displayName ?? '',
      email:     user.email       ?? '',
      role,
      banned:    false,
      class:     null,
      createdAt: serverTimestamp(),
    });
  } else if (role === 'admin' && snap.data().role !== 'admin') {
    await updateDoc(ref, { role: 'admin' });
  }
}

async function login(role, cardEl) {
  showLoading(cardEl);
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const { user } = await signInWithPopup(auth, provider);

    if (role === 'admin') {
      if (!isAdmin(user.email)) {
        await signOut(auth);
        showError('Admin access is restricted to authorized accounts.');
        return;
      }
      await ensureUserDoc(user, 'admin');
      window.location.href = '/admin.html';
      return;
    }

    if (role === 'teacher') {
      const tSnap = await getDoc(doc(db, 'teachers', user.uid));
      if (!tSnap.exists()) {
        await signOut(auth);
        showError('No teacher account found. Register via your invite link first, then sign in here.');
        return;
      }
      await ensureUserDoc(user, 'teacher');
      window.location.href = '/teacher.html';
      return;
    }

    // Student
    const uRef  = doc(db, 'users', user.uid);
    const uSnap = await getDoc(uRef);

    if (uSnap.exists() && uSnap.data().role !== 'student') {
      const r = uSnap.data().role;
      window.location.href = r === 'teacher' ? '/teacher.html' : '/admin.html';
      return;
    }

    if (!uSnap.exists()) {
      await setDoc(uRef, {
        name:      user.displayName ?? '',
        email:     user.email       ?? '',
        role:      'student',
        banned:    false,
        class:     null,
        createdAt: serverTimestamp(),
      });
    }

    const sRef  = doc(db, 'students', user.uid);
    const sSnap = await getDoc(sRef);
    if (!sSnap.exists()) {
      await setDoc(sRef, {
        name:         user.displayName ?? '',
        email:        user.email       ?? '',
        currentBook:  null,
        wishlist:     [],
        wishlistMeta: {},
        banned:       false,
      });
    }

    window.location.href = '/student.html';

  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') return;
    if (err.code === 'auth/popup-blocked') {
      showError('Pop-ups are blocked — allow pop-ups for this site and try again.');
      return;
    }
    if (err.code === 'auth/network-request-failed') {
      showError('Network error. Check your connection and try again.');
      return;
    }
    showError(`Sign-in failed (${err.code ?? err.message ?? 'unknown'}). Check the console for details.`);
    console.error('[auth] login failed:', err);
  } finally {
    hideLoading(cardEl);
  }
}

document.getElementById('studentLogin')?.addEventListener('click', function () { login('student', this); });
document.getElementById('teacherLogin')?.addEventListener('click', function () { login('teacher', this); });
document.getElementById('adminLogin')?.addEventListener('click',   function () { login('admin',   this); });
