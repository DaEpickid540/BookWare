// welcome.js — the first-run intro slideshow.
//
// Shown once per account, immediately after the portal finishes loading and
// BEFORE the reading-preferences quiz (quiz.js), so a brand-new user learns
// what the app is for before being asked what they like to read.
//
// "Seen" is tracked on the user's Firestore doc (`welcomeSeenAt`) rather than
// in localStorage, so it follows the account across devices and so the admin
// portal's "Replay Onboarding" button can genuinely replay it — that button's
// tooltip has always promised a welcome tour, which until now did not exist.
//
// runWelcomeTour(role) -> Promise<void>   (resolves when dismissed or finished)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const STUDENT_SLIDES = [
  {
    icon: 'bi-book-half',
    title: 'Welcome to BookWare',
    body: 'Your classroom library, in your pocket. Browse the shelves your teachers actually have, borrow what you want, and keep track of everything you read.',
  },
  {
    icon: 'bi-key-fill',
    title: 'Start with a class code',
    body: 'Your teacher hands out a short code, or a link or QR code that fills the code in for you. Add it once and their whole library appears under <strong>Library</strong>.',
  },
  {
    icon: 'bi-collection-fill',
    title: 'Borrow and return',
    body: 'Hit <strong>Check Out</strong> on any available book. It lands in your <strong>Locker</strong> with a due date. When you hand it back in class, mark it returned and your teacher confirms it.',
  },
  {
    icon: 'bi-heart-fill',
    title: 'Build a wishlist',
    body: 'Found something your library doesn\'t have yet? Add it to your <strong>Wishlist</strong>. BookWare tells you the moment a wishlisted book comes back on the shelf.',
  },
  {
    icon: 'bi-robot',
    title: 'Meet ARIA',
    body: 'ARIA is an optional AI reading buddy that suggests books based on your taste. Answer a few quick questions next and it will have something for you. You can turn it off anytime in Settings.',
  },
];

const TEACHER_SLIDES = [
  {
    icon: 'bi-book-half',
    title: 'Welcome to BookWare',
    body: 'Everything your classroom library needs in one place: your shelves, your students, who has what, and when it is due. No clipboard required.',
  },
  {
    icon: 'bi-upc-scan',
    title: 'Stock your shelves',
    body: 'On the <strong>Library</strong> tab, search by title, author, or ISBN and add the book. Covers and details fill themselves in, and you can set how many copies you own.',
  },
  {
    icon: 'bi-people-fill',
    title: 'Get students in',
    body: 'Each class on the <strong>Students</strong> tab gets its own join code, shareable link, and QR code. Put the QR up on the board: students scan it and land on your roster.',
  },
  {
    icon: 'bi-arrow-left-right',
    title: 'Track checkouts',
    body: 'Students check out from their own device. You see what is out, what is overdue, and confirm returns. Turn on <strong>Require Checkout Approval</strong> if you would rather sign off first.',
  },
  {
    icon: 'bi-shield-lock-fill',
    title: 'Student data has an expiry date',
    body: 'Every class carries a last day of school. On that date the roster, names and emails included, is deleted automatically and you lose access to it. You set the date when you create the class.',
  },
];

/**
 * Show the first-run intro slideshow as a full-screen modal.
 * @param {'student'|'teacher'} role
 * @returns {Promise<void>} resolves once the slideshow is closed
 */
export function runWelcomeTour(role = 'student') {
  const slides = role === 'teacher' ? TEACHER_SLIDES : STUDENT_SLIDES;

  return new Promise((resolve) => {
    let idx = 0;
    let settled = false;

    const overlay = document.createElement('div');
    overlay.className = 'welcome-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Welcome to BookWare');
    document.body.appendChild(overlay);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function close() {
      if (settled) return;
      settled = true;
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      overlay.classList.add('welcome-overlay--closing');
      setTimeout(() => overlay.remove(), 160);
      resolve();
    }

    function onKey(e) {
      if (e.key === 'Escape')     { close(); return; }
      if (e.key === 'ArrowRight') { next(); return; }
      if (e.key === 'ArrowLeft')  { back(); }
    }
    document.addEventListener('keydown', onKey);

    function next() { if (idx < slides.length - 1) { idx++; render(); } else close(); }
    function back() { if (idx > 0) { idx--; render(); } }

    function render() {
      const s      = slides[idx];
      const isLast = idx === slides.length - 1;
      const dots   = slides.map((_, i) =>
        `<button type="button" class="welcome-dot ${i === idx ? 'welcome-dot--active' : ''} ${i < idx ? 'welcome-dot--done' : ''}"
                 data-goto="${i}" aria-label="Go to slide ${i + 1}"></button>`
      ).join('');

      overlay.innerHTML = `
        <div class="welcome-card">
          <button type="button" class="welcome-skip">Skip</button>
          <div class="welcome-slide">
            <div class="welcome-icon" aria-hidden="true"><i class="bi ${esc(s.icon)}"></i></div>
            <h2 class="welcome-title">${esc(s.title)}</h2>
            <p class="welcome-body">${s.body}</p>
          </div>
          <div class="welcome-footer">
            <div class="welcome-dots">${dots}</div>
            <div class="welcome-nav">
              <button type="button" class="btn btn--ghost btn--sm welcome-back" ${idx === 0 ? 'disabled' : ''}>
                <i class="bi bi-arrow-left" aria-hidden="true"></i> Back
              </button>
              <button type="button" class="btn btn--primary btn--sm welcome-next">
                ${isLast ? 'Get Started' : 'Next'}
                <i class="bi ${isLast ? 'bi-check2' : 'bi-arrow-right'}" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </div>`;

      overlay.querySelector('.welcome-skip')?.addEventListener('click', close);
      overlay.querySelector('.welcome-back')?.addEventListener('click', back);
      overlay.querySelector('.welcome-next')?.addEventListener('click', next);
      overlay.querySelectorAll('[data-goto]').forEach(dot => {
        dot.addEventListener('click', () => { idx = Number(dot.dataset.goto); render(); });
      });
      overlay.querySelector('.welcome-next')?.focus();
    }

    render();
  });
}
