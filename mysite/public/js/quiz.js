// ─── First-time Reading Preferences Quiz ──────────────────────────────────────
// A short, friendly multi-step quiz shown to brand-new student/teacher accounts
// (and re-runnable from Settings). Answers are saved as `readingProfile` on the
// user's Firestore doc and used to (a) ground ARIA's recommendations in the
// booklist RAG, and (b) power quick-reply suggestions in the ARIA chat.
//
// runReadingQuiz(role) -> Promise<answers | null>
//   answers is null if the user skips. Otherwise it's a plain object like:
//   { genres: ['fantasy','scifi'], length: 'medium', vibe: 'action',
//     format: 'series', favorite: 'Percy Jackson',
//     // teacher-only:
//     grades: ['9','10'], priorities: ['diverse','reluctant'], recStyle: 'mix' }

// Shown exactly once, ever, right after a reader's *first* finished quiz
// (whether they completed it or skipped) — a soft, one-time nudge to check
// out the project on GitHub. Tracked in localStorage so retakes never show it again.
const GITHUB_STAR_KEY  = 'bw-github-star-shown';
const GITHUB_REPO_URL  = 'https://github.com/DaEpickid540/BookWare';

const GENRE_OPTIONS = [
  { key: 'fantasy',     label: 'Fantasy',                  icon: 'bi-stars' },
  { key: 'scifi',       label: 'Sci-Fi & Dystopian',       icon: 'bi-rocket-takeoff' },
  { key: 'mystery',     label: 'Mystery & Thriller',       icon: 'bi-search' },
  { key: 'romance',     label: 'Romance',                  icon: 'bi-heart' },
  { key: 'contemporary',label: 'Contemporary & Realistic', icon: 'bi-people' },
  { key: 'horror',      label: 'Horror',                   icon: 'bi-moon-stars' },
  { key: 'historical',  label: 'Historical Fiction',       icon: 'bi-hourglass-split' },
  { key: 'graphic',     label: 'Graphic Novels & Manga',   icon: 'bi-image' },
  { key: 'nonfiction',  label: 'Nonfiction & Memoir',      icon: 'bi-journal-text' },
  { key: 'verse',       label: 'Verse Novels & Poetry',    icon: 'bi-feather' },
  { key: 'classics',    label: 'Classics',                 icon: 'bi-bank' },
  { key: 'adventure',   label: 'Adventure & Action',       icon: 'bi-compass' },
];

const STUDENT_STEPS = [
  {
    id: 'genres', type: 'multi', min: 1,
    title: 'What genres are you in the mood for?',
    sub: 'Pick as many as you like — ARIA will use these to find your next favorite read.',
    options: GENRE_OPTIONS,
  },
  {
    id: 'length', type: 'single',
    title: 'How long do you like your books?',
    options: [
      { key: 'quick',  label: 'Quick reads',     icon: 'bi-lightning-charge' },
      { key: 'medium', label: 'Medium length',   icon: 'bi-book' },
      { key: 'long',   label: 'Doorstoppers',    icon: 'bi-books' },
      { key: 'any',    label: "Doesn't matter — a good story is a good story", icon: 'bi-shuffle' },
    ],
  },
  {
    id: 'vibe', type: 'single',
    title: "What's your reading vibe right now?",
    options: [
      { key: 'light',      label: 'Lighthearted & fun',          icon: 'bi-emoji-smile' },
      { key: 'dark',       label: 'Dark & intense',              icon: 'bi-cloud-lightning' },
      { key: 'thoughtful', label: 'Thought-provoking',           icon: 'bi-lightbulb' },
      { key: 'action',     label: 'Action-packed & fast-paced',  icon: 'bi-lightning-charge-fill' },
      { key: 'emotional',  label: 'Emotional & character-driven',icon: 'bi-heart-pulse' },
    ],
  },
  {
    id: 'format', type: 'single',
    title: 'Series or standalone?',
    options: [
      { key: 'series',     label: 'Series I can binge',  icon: 'bi-collection-fill' },
      { key: 'standalone', label: 'Standalone stories',  icon: 'bi-bookmark-fill' },
      { key: 'either',     label: 'Either is great',     icon: 'bi-arrow-left-right' },
    ],
  },
  {
    id: 'favorite', type: 'text', optional: true,
    title: 'Name a book, author, or series you’ve loved',
    sub: 'Optional — this helps ARIA find books with a similar feel.',
    placeholder: 'e.g. Percy Jackson, Scythe, anything by Angie Thomas…',
  },
];

const TEACHER_EXTRA_STEPS = [
  {
    id: 'grades', type: 'multi', min: 1,
    title: 'What grade levels do you teach?',
    options: [
      { key: '9',     label: '9th grade' },
      { key: '10',    label: '10th grade' },
      { key: '11',    label: '11th grade' },
      { key: '12',    label: '12th grade' },
      { key: 'mixed', label: 'Mixed / other' },
    ],
  },
  {
    id: 'priorities', type: 'multi', min: 1,
    title: 'What matters most when stocking your classroom library?',
    sub: 'Pick a few — ARIA will weigh these when it suggests titles for your shelves.',
    options: [
      { key: 'diverse',    label: 'Diverse voices & representation', icon: 'bi-globe-americas' },
      { key: 'curriculum', label: 'Curriculum tie-ins & classics',   icon: 'bi-mortarboard-fill' },
      { key: 'reluctant',  label: 'Hooking reluctant readers',       icon: 'bi-magnet-fill' },
      { key: 'sel',        label: 'Social-emotional learning topics',icon: 'bi-heart-fill' },
      { key: 'justgood',   label: 'Great stories kids will finish',  icon: 'bi-emoji-laughing-fill' },
    ],
  },
  {
    id: 'recStyle', type: 'single',
    title: 'How should ARIA tailor its suggestions for you?',
    options: [
      { key: 'wholeclass', label: 'Whole-class picks',              icon: 'bi-people-fill' },
      { key: 'individual', label: 'Matching individual students',   icon: 'bi-person-check-fill' },
      { key: 'mix',        label: 'A mix of both',                  icon: 'bi-shuffle' },
    ],
  },
];

function buildSteps(role) {
  // Teachers get a longer, more classroom-relevant quiz: their own taste
  // questions PLUS the extra grade/priority/style questions, inserted right
  // after the genre picker so the flow still feels personal-first.
  if (role === 'teacher') {
    const [genres, ...rest] = STUDENT_STEPS;
    return [genres, ...TEACHER_EXTRA_STEPS, ...rest];
  }
  return STUDENT_STEPS;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/**
 * Show the reading-preferences quiz as a full-screen modal.
 * Resolves with the answers object, or `null` if the user skips/dismisses.
 */
export function runReadingQuiz(role = 'student') {
  return new Promise((resolve) => {
    const steps = buildSteps(role);
    const answers = {};
    let idx = 0;
    let settled = false;

    const overlay = document.createElement('div');
    overlay.className = 'quiz-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Reading preferences quiz');
    document.body.appendChild(overlay);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function closeOverlay(result) {
      document.body.style.overflow = prevOverflow;
      overlay.classList.add('quiz-overlay--closing');
      setTimeout(() => overlay.remove(), 160);
      resolve(result);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      clearAutoAdvance();
      // One-time GitHub star nudge — shown right at the end of a reader's
      // very first quiz (completed or skipped), then never again.
      if (!localStorage.getItem(GITHUB_STAR_KEY)) {
        localStorage.setItem(GITHUB_STAR_KEY, '1');
        renderStarPrompt(() => closeOverlay(result));
      } else {
        closeOverlay(result);
      }
    }

    function renderStarPrompt(onDone) {
      overlay.innerHTML = `
        <div class="quiz-card quiz-card--star">
          <div class="quiz-step">
            <div class="quiz-star-icon" aria-hidden="true"><i class="bi bi-github"></i></div>
            <h2 class="quiz-title">Enjoying BookWare?</h2>
            <p class="quiz-sub">
              BookWare is an independent passion project. If it's helped you find your next
              great read, a ⭐ on the GitHub repo goes a long way — it costs nothing and means a lot.
            </p>
            <div class="quiz-star-actions">
              <a class="btn btn--primary btn--sm quiz-star-link" href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer">
                <i class="bi bi-github" aria-hidden="true"></i> Visit &amp; star on GitHub
              </a>
              <button type="button" class="btn btn--ghost btn--sm quiz-star-dismiss">Maybe later</button>
            </div>
          </div>
        </div>`;
      let done = false;
      const finishPrompt = () => { if (!done) { done = true; onDone(); } };
      overlay.querySelector('.quiz-star-dismiss')?.addEventListener('click', finishPrompt);
      overlay.querySelector('.quiz-star-link')?.addEventListener('click', () => setTimeout(finishPrompt, 200));
    }

    function skip() { finish(null); }

    function complete() {
      const out = {};
      for (const step of steps) {
        const v = answers[step.id];
        if (step.type === 'multi') out[step.id] = [...(v ?? [])];
        else if (typeof v === 'string' && v.trim()) out[step.id] = v.trim();
      }
      finish(out);
    }

    // Tracks the pending single-select auto-advance timer so a manual
    // "Next" click (or another selection) can cancel it — otherwise both
    // fire and the quiz silently skips a question.
    let autoAdvanceTimer = null;
    function clearAutoAdvance() {
      if (autoAdvanceTimer) { clearTimeout(autoAdvanceTimer); autoAdvanceTimer = null; }
    }

    function goNext() {
      clearAutoAdvance();
      if (idx < steps.length - 1) { idx++; render(); }
      else complete();
    }
    function goBack() {
      clearAutoAdvance();
      if (idx > 0) { idx--; render(); }
    }

    function canAdvance(step) {
      if (step.type === 'multi')  return (answers[step.id]?.size ?? 0) >= (step.min ?? 0);
      if (step.type === 'single') return !!answers[step.id];
      return true; // text steps are always skippable/advanceable
    }

    function render() {
      const step = steps[idx];
      const isLast = idx === steps.length - 1;
      const dots = steps.map((_, i) =>
        `<span class="quiz-dot ${i === idx ? 'quiz-dot--active' : ''} ${i < idx ? 'quiz-dot--done' : ''}"></span>`
      ).join('');

      let bodyHtml = '';
      if (step.type === 'multi' || step.type === 'single') {
        const selected = step.type === 'multi' ? (answers[step.id] ?? new Set()) : null;
        bodyHtml = `<div class="quiz-options quiz-options--${step.type}">` +
          step.options.map(opt => {
            const isSel = step.type === 'multi'
              ? selected.has(opt.key)
              : answers[step.id] === opt.key;
            return `<button type="button" class="quiz-chip ${isSel ? 'quiz-chip--selected' : ''}" data-key="${esc(opt.key)}">
              ${opt.icon ? `<i class="bi ${esc(opt.icon)}" aria-hidden="true"></i>` : ''}
              <span>${esc(opt.label)}</span>
              ${step.type === 'multi' ? `<i class="bi bi-check-circle-fill quiz-chip-check" aria-hidden="true"></i>` : ''}
            </button>`;
          }).join('') +
          `</div>`;
      } else if (step.type === 'text') {
        bodyHtml = `<input type="text" class="text-input quiz-text-input" id="quizTextInput"
          placeholder="${esc(step.placeholder ?? '')}" autocomplete="off"
          value="${esc(answers[step.id] ?? '')}" aria-label="${esc(step.title)}" />`;
      }

      overlay.innerHTML = `
        <div class="quiz-card">
          <button type="button" class="quiz-skip" aria-label="Skip quiz">Skip for now</button>
          <div class="quiz-dots" aria-hidden="true">${dots}</div>
          <div class="quiz-step">
            <h2 class="quiz-title">${esc(step.title)}</h2>
            ${step.sub ? `<p class="quiz-sub">${esc(step.sub)}</p>` : ''}
            ${bodyHtml}
          </div>
          <div class="quiz-nav">
            <button type="button" class="btn btn--ghost btn--sm quiz-back" ${idx === 0 ? 'disabled' : ''}>
              <i class="bi bi-arrow-left" aria-hidden="true"></i> Back
            </button>
            <button type="button" class="btn btn--primary btn--sm quiz-next" ${canAdvance(step) ? '' : 'disabled'}>
              ${isLast ? 'Finish' : 'Next'} <i class="bi ${isLast ? 'bi-check2' : 'bi-arrow-right'}" aria-hidden="true"></i>
            </button>
          </div>
        </div>`;

      // Wire chip interactions
      overlay.querySelectorAll('.quiz-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.key;
          if (step.type === 'multi') {
            const set = answers[step.id] ?? (answers[step.id] = new Set());
            set.has(key) ? set.delete(key) : set.add(key);
            render();
          } else {
            clearAutoAdvance(); // re-picking before the timer fires shouldn't double-advance
            answers[step.id] = key;
            render();
            // Single-select auto-advances for a snappier feel — but a manual
            // Next click (or a fresh pick on the next render) cancels this.
            autoAdvanceTimer = setTimeout(() => {
              autoAdvanceTimer = null;
              if (!settled) goNext();
            }, 220);
          }
        });
      });

      // Wire text input
      const textInput = overlay.querySelector('#quizTextInput');
      if (textInput) {
        textInput.addEventListener('input', () => { answers[step.id] = textInput.value; });
        textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } });
        setTimeout(() => textInput.focus(), 50);
      }

      overlay.querySelector('.quiz-skip')?.addEventListener('click', skip);
      overlay.querySelector('.quiz-back')?.addEventListener('click', goBack);
      overlay.querySelector('.quiz-next')?.addEventListener('click', goNext);
    }

    render();
  });
}

export { GENRE_OPTIONS };
