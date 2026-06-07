// teacher-access.js — Teacher access request / invite claim page
import { auth, db } from './firebase.js';
import {
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot,
  runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = '@masonohioschools.com';
const ADMIN_EMAILS   = ['sarvin.sukhe@gmail.com', 'sarvinsukhe@gmail.com', 'daepickid540@gmail.com'];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const subheadingEl    = document.getElementById('pageSubheading');
const userBadgeEl     = document.getElementById('userBadge');
const userAvatarEl    = document.getElementById('userAvatar');
const userNameEl      = document.getElementById('userName');
const userEmailEl     = document.getElementById('userEmail');
const statusEl        = document.getElementById('statusMessage');
const inviteSectionEl = document.getElementById('inviteSection');
const orDividerEl     = document.getElementById('orDivider');
const requestSectionEl= document.getElementById('requestSection');
const inviteCodeInput = document.getElementById('inviteCodeInput');
const joinWithCodeBtn = document.getElementById('joinWithCodeBtn');
const joinBtnLabel    = document.getElementById('joinBtnLabel');
const requestAccessBtn= document.getElementById('requestAccessBtn');
const requestBtnLabel = document.getElementById('requestBtnLabel');
const signOutBtn      = document.getElementById('signOutBtn');

// ─── State ────────────────────────────────────────────────────────────────────
let currentUser      = null;
let requestUnsub     = null;   // onSnapshot unsubscribe

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className   = `status-message status-message--${type}`;
}
function clearStatus() {
  statusEl.textContent = '';
  statusEl.className   = 'status-message';
}

function showUI() {
  inviteSectionEl.hidden  = false;
  orDividerEl.hidden      = false;
  requestSectionEl.hidden = false;
  signOutBtn.hidden       = false;
  subheadingEl.textContent =
    'Your account doesn\'t have teacher access yet. Enter an invite code from another teacher, or request approval from your school admin.';
}

function setJoinLoading(on) {
  joinWithCodeBtn.disabled = on;
  joinBtnLabel.innerHTML   = on
    ? '<span class="btn-spinner" style="width:14px;height:14px;border-width:2px"></span>'
    : 'Join';
}

function setRequestLoading(on) {
  requestAccessBtn.disabled = on;
  requestBtnLabel.innerHTML = on
    ? '<span class="btn-spinner"></span> Sending…'
    : 'Request Admin Approval';
}

function showPendingState() {
  requestAccessBtn.disabled = true;
  requestBtnLabel.innerHTML = '<span class="btn-spinner"></span> Waiting for Approval…';
  setStatus(
    'Your request is pending. You\'ll be redirected automatically once an admin approves you.',
    'info'
  );
}

function showDeniedState() {
  requestAccessBtn.disabled = false;
  requestBtnLabel.textContent = 'Request Access Again';
  setStatus('Your access request was denied. You can submit a new request or contact your admin directly.', 'error');
}

// ─── Subscribe to request doc for live status updates ─────────────────────────
function subscribeToRequest(uid) {
  if (requestUnsub) requestUnsub();
  requestUnsub = onSnapshot(doc(db, 'accessRequests', uid), (snap) => {
    if (!snap.exists()) return;
    const { status } = snap.data();
    if (status === 'approved') {
      setStatus('Approved! Redirecting to your dashboard…', 'success');
      setTimeout(() => { window.location.href = '/teacher.html'; }, 900);
    } else if (status === 'denied') {
      if (requestUnsub) { requestUnsub(); requestUnsub = null; }
      showDeniedState();
    }
  });
}

// ─── Auth gate ────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = '/';
    return;
  }
  currentUser = user;

  // Populate user badge
  if (user.photoURL) {
    userAvatarEl.src = user.photoURL;
    userAvatarEl.hidden = false;
  } else {
    userAvatarEl.hidden = true;
  }
  userNameEl.textContent  = user.displayName ?? '';
  userEmailEl.textContent = user.email ?? '';
  userBadgeEl.hidden = false;

  // Check if they already have a teacher/admin role (edge case: they were approved
  // while signed in somewhere else, or coming here directly after prior approval)
  try {
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    if (userSnap.exists()) {
      const role = userSnap.data().role;
      if (role === 'teacher' || role === 'admin') {
        window.location.href = '/teacher.html';
        return;
      }
    }
  } catch (err) {
    console.warn('[teacher-access] user doc check failed:', err);
  }

  // Check for an existing access request
  try {
    const reqSnap = await getDoc(doc(db, 'accessRequests', user.uid));
    if (reqSnap.exists()) {
      const { status } = reqSnap.data();
      if (status === 'approved') {
        // Shouldn't normally happen — user doc might not be set yet, retry
        setStatus('Approved! Redirecting…', 'success');
        setTimeout(() => { window.location.href = '/teacher.html'; }, 1000);
        return;
      }
      showUI();
      if (status === 'pending') {
        showPendingState();
        subscribeToRequest(user.uid);
        return;
      }
      if (status === 'denied') {
        showDeniedState();
      }
    } else {
      showUI();
    }
  } catch (err) {
    console.warn('[teacher-access] request check failed:', err);
    showUI();
  }
});

// ─── Join with invite code ─────────────────────────────────────────────────────
joinWithCodeBtn.addEventListener('click', async () => {
  const token = inviteCodeInput.value.trim();
  if (!token) {
    setStatus('Please paste or type your invite code.', 'error');
    inviteCodeInput.focus();
    return;
  }
  clearStatus();
  setJoinLoading(true);

  const user  = currentUser;
  const email = user.email?.toLowerCase() ?? '';

  if (!email.endsWith(ALLOWED_DOMAIN) && !ADMIN_EMAILS.includes(email)) {
    setStatus('Only Mason Ohio Schools accounts (@masonohioschools.com) may register as teachers.', 'error');
    setJoinLoading(false);
    return;
  }

  try {
    await runTransaction(db, async (tx) => {
      const inviteRef  = doc(db, 'invites', token);
      const inviteSnap = await tx.get(inviteRef);

      if (!inviteSnap.exists())                              throw new Error('invalid');
      const inv = inviteSnap.data();
      if (inv.used === true)                                 throw new Error('used');
      if (inv.revoked === true)                              throw new Error('revoked');
      if (inv.expiresAt?.toDate?.() < new Date())            throw new Error('expired');
      const recipientEmail = inv.recipientEmail ?? '';
      if (recipientEmail && email !== recipientEmail.toLowerCase()) {
        throw new Error('wrong-account');
      }

      tx.update(inviteRef, { used: true, claimedBy: user.uid, claimedAt: serverTimestamp() });

      tx.set(doc(db, 'users', user.uid), {
        name: user.displayName ?? '',
        email: user.email ?? '',
        role: 'teacher',
        banned: false,
        class: null,
        createdAt: serverTimestamp(),
      });
      tx.set(doc(db, 'teachers', user.uid), {
        name: user.displayName ?? '',
        email: user.email ?? '',
        ...(user.photoURL ? { photoURL: user.photoURL } : {}),
        createdAt: serverTimestamp(),
        canInvite: true,
        libraryPublic: false,
      });
    });

    setStatus('Access granted! Redirecting to your dashboard…', 'success');
    setTimeout(() => { window.location.href = '/teacher.html'; }, 900);
  } catch (err) {
    console.error('[teacher-access] invite claim failed:', err);
    const msg =
      err.message === 'used'          ? 'This invite code has already been used.' :
      err.message === 'revoked'       ? 'This invite has been revoked by the person who created it.' :
      err.message === 'expired'       ? 'This invite code has expired. Ask for a fresh one.' :
      err.message === 'invalid'       ? 'Invite code not found. Check for typos and try again.' :
      err.message === 'wrong-account' ? 'This invite was sent to a different email address. Sign in with the correct account.' :
                                        'Failed to claim invite. Please try again or contact your admin.';
    setStatus(msg, 'error');
    setJoinLoading(false);
  }
});

// Allow Enter key to submit invite code
inviteCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinWithCodeBtn.click();
});

// ─── Request admin approval ────────────────────────────────────────────────────
requestAccessBtn.addEventListener('click', async () => {
  if (!currentUser) return;
  clearStatus();
  setRequestLoading(true);

  try {
    await setDoc(doc(db, 'accessRequests', currentUser.uid), {
      name:        currentUser.displayName ?? '',
      email:       currentUser.email ?? '',
      photoURL:    currentUser.photoURL ?? '',
      requestedAt: serverTimestamp(),
      status:      'pending',
    });

    showPendingState();
    subscribeToRequest(currentUser.uid);
  } catch (err) {
    console.error('[teacher-access] request failed:', err);
    setStatus('Failed to send your request. Please try again.', 'error');
    setRequestLoading(false);
  }
});

// ─── Sign out ─────────────────────────────────────────────────────────────────
signOutBtn.addEventListener('click', async () => {
  if (requestUnsub) { requestUnsub(); requestUnsub = null; }
  await signOut(auth);
  window.location.href = '/';
});
