// teacher-signup.js — Teacher invite claim page
import { auth, db } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, setDoc, updateDoc, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const statusEl  = document.getElementById('statusMessage');
const signInBtn = document.getElementById('signInBtn');
const btnLabel  = document.getElementById('btnLabel');

const ALLOWED_DOMAIN = '@masonohioschools.com';
const ADMIN_EMAILS   = ['sarvin.sukhe@gmail.com', 'sarvinsukhe@gmail.com', 'daepickid540@gmail.com'];

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className   = `status-message status-message--${type}`;
}

function setLoading(on) {
  signInBtn.disabled = on;
  if (on) {
    btnLabel.innerHTML = '<span class="btn-spinner"></span> Working…';
  } else {
    btnLabel.textContent = 'Sign in with Google';
  }
}

// Step 1: validate token from URL
const token = new URLSearchParams(window.location.search).get('token');

if (!token) {
  setStatus('Invalid invite link — no token found.', 'error');
} else {
  validateToken(token);
}

async function validateToken(token) {
  try {
    const snap = await getDoc(doc(db, 'invites', token));
    if (!snap.exists()) {
      setStatus('This invite link is invalid.', 'error');
      return;
    }
    if (snap.data().used === true) {
      setStatus('This invite link has already been used.', 'error');
      return;
    }
    if (snap.data().expiresAt?.toDate() < new Date()) {
      setStatus('This invite link has expired.', 'error');
      return;
    }
    setStatus('Invite verified! Sign in with Google to create your teacher account.', 'info');
    signInBtn.disabled = false;
    signInBtn.addEventListener('click', () => handleSignup(token), { once: true });
  } catch (err) {
    console.error(err);
    setStatus('Failed to validate invite. Please try again.', 'error');
  }
}

// Step 2: Google sign-in + account creation
async function handleSignup(token) {
  setLoading(true);
  let user;

  try {
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    user = result.user;
  } catch (err) {
    console.error(err);
    setStatus('Sign-in was cancelled or failed. Please try again.', 'error');
    setLoading(false);
    signInBtn.addEventListener('click', () => handleSignup(token), { once: true });
    return;
  }

  const email = user.email?.toLowerCase() ?? '';
  if (!email.endsWith(ALLOWED_DOMAIN) && !ADMIN_EMAILS.includes(email)) {
    setStatus('Only Mason Ohio Schools accounts may register.', 'error');
    setLoading(false);
    return;
  }

  try {
    const existingSnap = await getDoc(doc(db, 'users', user.uid));
    if (existingSnap.exists()) {
      setStatus('This Google account is already registered in BookWare.', 'error');
      setLoading(false);
      return;
    }

    await runTransaction(db, async (tx) => {
      const inviteRef  = doc(db, 'invites', token);
      const inviteSnap = await tx.get(inviteRef);

      if (!inviteSnap.exists())            throw new Error('invalid');
      if (inviteSnap.data().used === true)  throw new Error('used');
      if (inviteSnap.data().expiresAt?.toDate() < new Date()) throw new Error('expired');

      const recipientEmail = inviteSnap.data().recipientEmail;
      if (recipientEmail && user.email?.toLowerCase() !== recipientEmail.toLowerCase()) {
        throw new Error('wrong-account');
      }

      tx.update(inviteRef, { used: true, claimedBy: user.uid, claimedAt: serverTimestamp() });

      tx.set(doc(db, 'users', user.uid), {
        name: user.displayName, email: user.email,
        role: 'teacher', banned: false, class: null,
        createdAt: serverTimestamp(),
      });
      tx.set(doc(db, 'teachers', user.uid), {
        name: user.displayName, email: user.email,
        createdAt: serverTimestamp(),
        canInvite: true,
        libraryPublic: false,
      });
    });
  } catch (err) {
    console.error(err);
    const msg =
      err.message === 'used'          ? 'This invite link has already been used.' :
      err.message === 'expired'       ? 'This invite link has expired.' :
      err.message === 'invalid'       ? 'This invite link is invalid.' :
      err.message === 'wrong-account' ? 'This invite was sent to a different email address. Sign in with the correct account and try again.' :
                                        'Account setup failed. Please contact an administrator.';
    setStatus(msg, 'error');
    setLoading(false);
    return;
  }

  setStatus('Account created! Redirecting…', 'success');
  setTimeout(() => { window.location.href = '/teacher.html'; }, 900);
}
