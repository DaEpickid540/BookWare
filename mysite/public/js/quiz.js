// ─── First-time Reading Preferences Quiz ──────────────────────────────────────
// A short, friendly multi-step quiz shown to brand-new student/teacher accounts
// (and re-runnable from Settings). Answers are saved as `readingProfile` on the
// user's Firestore doc and used to (a) ground ARIA's recommendations in the
// booklist RAG, and (b) power quick-reply suggestions in the ARIA chat.
//
// The final step offers to set up ARIA itself (AI provider key + web search
// key) right here, so new users don't have to separately discover Settings to
// unlock it. It reads/writes the exact same localStorage keys as the Settings
// panel (imported from theme.js) — this step is just an alternate, friendlier
// entry point into the same configuration, never a separate copy of it.
//
// runReadingQuiz(role) -> Promise<answers | null>
//   answers is null if the user skips. Otherwise it's a plain object like:
//   { genres: ['fantasy','scifi'], length: 'medium', vibe: 'action',
//     format: 'series', favorite: 'Percy Jackson',
//     // teacher-only:
//     grades: ['9','10'], priorities: ['diverse','reluctant'], recStyle: 'mix' }

import {
  ARIA_ENABLED_KEY, ARIA_PROVIDER_KEY, ARIA_PROVIDER_KEYS, ARIA_SEARCH_PROVIDER_KEY, ARIA_SEARCH_PROVIDER_KEYS,
  PROVIDER_DISPLAY_NAME, getAriaProvider, hasSearchKeyConfigured,
} from './theme.js';

// AI providers offered in the onboarding step, in the order shown. Kept in
// sync by hand with the Settings → ARIA AI markup in student.html/teacher.html
// (same labels, links, and free-tier notes) since that panel is static HTML.
const ARIA_PROVIDERS = [
  { key: 'anthropic', name: 'Claude', badge: '⭐ Highest Quality', badgeClass: 'aria-badge--best',
    hint: 'No free tier, but very cheap for this use', linkLabel: 'console.anthropic.com/settings/keys',
    linkUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-api03-…' },
  { key: 'openai', name: 'ChatGPT (OpenAI)', badge: '', badgeClass: '',
    hint: 'No permanent free tier', linkLabel: 'platform.openai.com/api-keys',
    linkUrl: 'https://platform.openai.com/api-keys', placeholder: 'sk-…' },
  { key: 'gemini', name: 'Gemini', badge: 'Free tier', badgeClass: 'aria-badge--free',
    hint: 'Free key, no card required', linkLabel: 'aistudio.google.com/apikey',
    linkUrl: 'https://aistudio.google.com/apikey', placeholder: 'AIza…' },
  { key: 'groq', name: 'Groq', badge: 'Free & fast', badgeClass: 'aria-badge--free',
    hint: 'Free key, generous limits', linkLabel: 'console.groq.com/keys',
    linkUrl: 'https://console.groq.com/keys', placeholder: 'gsk_…' },
];

const SEARCH_PROVIDERS = [
  { key: 'contextwire', name: 'ContextWire', badge: '⭐ Recommended (free)', badgeClass: 'aria-badge--best',
    hint: '1,000 free searches/mo, no card required', linkLabel: 'contextwire.dev',
    linkUrl: 'https://contextwire.dev', placeholder: 'contextwire api key…' },
  { key: 'brave', name: 'Brave Search', badge: '', badgeClass: '',
    hint: 'Reliable, but lost its free tier in 2026 (metered billing)', linkLabel: 'brave.com/search/api',
    linkUrl: 'https://brave.com/search/api', placeholder: 'brave subscription token…' },
  { key: 'serpapi', name: 'SerpAPI', badge: '', badgeClass: '',
    hint: 'Limited free tier (~100 searches/mo)', linkLabel: 'serpapi.com',
    linkUrl: 'https://serpapi.com', placeholder: 'serpapi key…' },
];

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
  {
    id: 'ariaSetup', type: 'aria-setup', optional: true,
    title: 'Set up ARIA, your AI reading assistant',
    sub: 'Optional — paste any keys you have to unlock AI chat and personalized picks. Skip this and set it up anytime later in Settings.',
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
      return true; // text + aria-setup steps are always skippable/advanceable
    }

    // ── ARIA setup step ─────────────────────────────────────────────────────
    // Reads/writes the exact same localStorage keys as Settings → ARIA AI (see
    // the theme.js imports above) — this is an alternate entry point into that
    // same configuration, not a separate copy of it. If the user pastes both a
    // working AI key and a Web Search key here, ARIA is switched on immediately
    // so they see the benefit without a separate trip to Settings.
    function buildAriaSetupHtml() {
      const providerOptions = ARIA_PROVIDERS.map(p =>
        `<option value="${esc(p.key)}">${p.badge ? esc(p.badge) + ' — ' : ''}${esc(p.name)}</option>`
      ).join('');

      // Only the chosen provider's key box renders visibly — picking Groq
      // shouldn't clutter the screen with Claude/ChatGPT/Gemini boxes too.
      const providerRows = ARIA_PROVIDERS.map(p => `
        <div class="aria-key-row" data-provider="${esc(p.key)}" hidden>
          <div class="aria-key-row-head">
            <span class="aria-key-row-label">${esc(p.name)}${p.badge ? ` <span class="aria-badge ${esc(p.badgeClass)}">${esc(p.badge)}</span>` : ''}</span>
            <span class="aria-key-row-status" data-quiz-status="${esc(p.key)}"></span>
          </div>
          <div class="settings-hint">${esc(p.hint)} — <a href="${esc(p.linkUrl)}" target="_blank" rel="noopener">${esc(p.linkLabel)}</a></div>
          <div class="aria-key-row-input">
            <input type="password" class="text-input text-input--mono" id="quizAriaKey-${esc(p.key)}"
              placeholder="${esc(p.placeholder)}" autocomplete="off" aria-label="${esc(p.name)} API key" />
            <button type="button" class="btn btn--sm" data-quiz-save="${esc(p.key)}">Save</button>
          </div>
        </div>`).join('');

      const searchOptions = SEARCH_PROVIDERS.map(p =>
        `<option value="${esc(p.key)}">${p.badge ? esc(p.badge) + ' — ' : ''}${esc(p.name)}</option>`
      ).join('');

      return `
        <div class="quiz-aria-setup">
          <div class="quiz-aria-status" id="quizAriaStatus"></div>

          <div class="quiz-aria-group-label">AI Provider — pick the one you want to use</div>
          <select id="quizAriaProviderSelect" class="select-input" aria-label="AI provider" style="margin-bottom:10px">${providerOptions}</select>
          ${providerRows}

          <div class="quiz-aria-group-label" style="margin-top:14px">
            Web Search <span class="aria-badge">optional but recommended</span>
          </div>
          <div class="settings-hint" style="margin-bottom:8px">Lets ARIA search the web for fresh, internet-grounded book picks — pick a provider</div>
          <select id="quizAriaSearchProvider" class="select-input" aria-label="Web search provider">${searchOptions}</select>
          <div class="aria-key-row" style="border-top:none;padding-top:10px">
            <div class="settings-hint" id="quizSearchHint"></div>
            <div class="aria-key-row-input">
              <input type="password" class="text-input text-input--mono" id="quizAriaSearchKey" autocomplete="off" aria-label="Web search API key" />
              <button type="button" class="btn btn--sm" id="quizAriaSaveSearchBtn">Save</button>
            </div>
          </div>

          <p class="settings-hint" style="margin-top:10px">Keys are stored only in your browser — never sent to our servers. Change these anytime in Settings → ARIA AI.</p>
        </div>`;
    }

    function wireAriaSetupStep() {
      const providerSelect = overlay.querySelector('#quizAriaProviderSelect');
      const searchSelect   = overlay.querySelector('#quizAriaSearchProvider');
      const searchHint     = overlay.querySelector('#quizSearchHint');
      const searchInput    = overlay.querySelector('#quizAriaSearchKey');
      const statusLine     = overlay.querySelector('#quizAriaStatus');
      if (!providerSelect) return; // not the aria-setup step

      function updateProviderRowVisibility(chosen) {
        ARIA_PROVIDERS.forEach(p => {
          const row = overlay.querySelector(`.aria-key-row[data-provider="${p.key}"]`);
          if (row) row.hidden = p.key !== chosen;
        });
      }

      function refreshStatus() {
        const active = getAriaProvider();
        const searchReady = hasSearchKeyConfigured();
        ARIA_PROVIDERS.forEach(p => {
          const badge = overlay.querySelector(`[data-quiz-status="${p.key}"]`);
          if (!badge) return;
          const hasKey = !!localStorage.getItem(ARIA_PROVIDER_KEYS[p.key]);
          badge.textContent = hasKey ? (p.key === active ? '✓ Active' : '✓ Saved') : '';
        });
        // ARIA requires BOTH an AI key and a Web Search key to switch on (same
        // gate Settings enforces) — the message reflects exactly which of the
        // two is still missing rather than declaring victory on just one.
        if (statusLine) {
          if (active && searchReady) {
            statusLine.innerHTML = `<i class="bi bi-check-circle-fill" style="color:var(--success)" aria-hidden="true"></i> ARIA is ready on <strong>${esc(PROVIDER_DISPLAY_NAME[active] ?? active)}</strong> — turned on for you.`;
          } else if (active && !searchReady) {
            statusLine.innerHTML = `<i class="bi bi-hourglass-split" aria-hidden="true"></i> Almost there — add a Web Search key below too to fully unlock ARIA.`;
          } else if (!active && searchReady) {
            statusLine.innerHTML = `<i class="bi bi-hourglass-split" aria-hidden="true"></i> Almost there — add a key for ${esc(PROVIDER_DISPLAY_NAME[providerSelect.value] ?? providerSelect.value)} above too to fully unlock ARIA.`;
          } else {
            statusLine.innerHTML = `<i class="bi bi-info-circle-fill" aria-hidden="true"></i> No keys saved yet — add one above, or skip and set this up later in Settings.`;
          }
        }
        // Once both prerequisites are met, switch ARIA on right away — the
        // whole point of doing this during onboarding is to skip the extra
        // trip to Settings to flip the toggle themselves.
        if (active && searchReady) {
          localStorage.setItem(ARIA_ENABLED_KEY, 'true');
        }
      }

      function updateSearchHint() {
        const p = SEARCH_PROVIDERS.find(s => s.key === searchSelect.value) ?? SEARCH_PROVIDERS[0];
        if (searchHint) searchHint.innerHTML = `${esc(p.hint)} — <a href="${esc(p.linkUrl)}" target="_blank" rel="noopener">${esc(p.linkLabel)}</a>`;
        if (searchInput) {
          searchInput.placeholder = p.placeholder;
          searchInput.value = localStorage.getItem(ARIA_SEARCH_PROVIDER_KEYS[p.key]) ?? '';
        }
      }

      // Restore any values already saved (e.g. user went Back and returned)
      ARIA_PROVIDERS.forEach(p => {
        const input = overlay.querySelector(`#quizAriaKey-${p.key}`);
        if (input) input.value = localStorage.getItem(ARIA_PROVIDER_KEYS[p.key]) ?? '';
      });
      const savedChoice = localStorage.getItem(ARIA_PROVIDER_KEY) ?? 'groq';
      providerSelect.value = savedChoice;
      updateProviderRowVisibility(savedChoice);
      searchSelect.value = localStorage.getItem(ARIA_SEARCH_PROVIDER_KEY) ?? 'contextwire';
      updateSearchHint();
      refreshStatus();

      providerSelect.addEventListener('change', () => {
        localStorage.setItem(ARIA_PROVIDER_KEY, providerSelect.value);
        updateProviderRowVisibility(providerSelect.value);
        refreshStatus();
      });

      overlay.querySelectorAll('[data-quiz-save]').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.quizSave;
          const input = overlay.querySelector(`#quizAriaKey-${key}`);
          const val = input?.value.trim() ?? '';
          if (val) localStorage.setItem(ARIA_PROVIDER_KEYS[key], val);
          else localStorage.removeItem(ARIA_PROVIDER_KEYS[key]);
          refreshStatus();
        });
      });

      searchSelect.addEventListener('change', () => {
        localStorage.setItem(ARIA_SEARCH_PROVIDER_KEY, searchSelect.value);
        updateSearchHint();
      });

      overlay.querySelector('#quizAriaSaveSearchBtn')?.addEventListener('click', () => {
        const provider = searchSelect.value;
        const val = searchInput?.value.trim() ?? '';
        const storageKey = ARIA_SEARCH_PROVIDER_KEYS[provider];
        if (val) localStorage.setItem(storageKey, val);
        else localStorage.removeItem(storageKey);
        refreshStatus();
      });
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
      } else if (step.type === 'aria-setup') {
        bodyHtml = buildAriaSetupHtml();
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

      if (step.type === 'aria-setup') wireAriaSetupStep();

      overlay.querySelector('.quiz-skip')?.addEventListener('click', skip);
      overlay.querySelector('.quiz-back')?.addEventListener('click', goBack);
      overlay.querySelector('.quiz-next')?.addEventListener('click', goNext);
    }

    render();
  });
}

export { GENRE_OPTIONS };
