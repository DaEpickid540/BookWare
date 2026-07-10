// theme.js — Shared brightness/color/preset theme logic
// Imported by student.js and teacher.js

import { pickBooksForProfile, formatBooksForPrompt } from './booklist.js';

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

export const BRIGHTNESS_KEY = 'bookware-brightness';
export const COLOR_KEY      = 'bookware-color';
export const PRESET_KEY     = 'bookware-preset';
export const BTNSIZE_KEY    = 'bookware-btnsize';

// ── Button size (small / medium / large) ──────────────────────────────────────
export function applyButtonSize(size) {
  const html = document.documentElement;
  if (!size || size === 'medium') html.removeAttribute('data-btnsize');
  else                            html.setAttribute('data-btnsize', size);
  document.querySelectorAll('.btnsize-opt').forEach(b => {
    const active = b.dataset.size === (size || 'medium');
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

export const THEME_PRESETS = {
  midnight:  { brightness: 5,  color: 'crimson' },
  night:     { brightness: 18, color: 'crimson' },
  dusk:      { brightness: 32, color: 'sunset'  },
  ash:       { brightness: 52, color: 'slate'   },
  parchment: { brightness: 72, color: 'sunset'  },
  snow:      { brightness: 95, color: 'ocean'   },
};

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v)       { return Math.max(0, Math.min(255, Math.round(v))); }
function toHex(v)       { v = clamp(v); return '#' + v.toString(16).padStart(2, '0').repeat(3); }

function brightnessToVars(val) {
  const t      = val / 100;
  const base   = lerp(0, 255, t);
  const offAlt = lerp(16, -8, t);
  let textV;
  if      (val <= 45) textV = lerp(240, 200, val / 45);
  else if (val >= 55) textV = lerp(200, 26,  (val - 55) / 45);
  else                textV = 200;
  return {
    '--bg':       toHex(base),
    '--bg-card':  toHex(base + lerp(-8, 8, t)),
    '--bg-inset': toHex(base + lerp(-14, 12, t)),
    '--border':   toHex(base + offAlt * 0.6),
    '--text':     toHex(textV),
  };
}

export function brightnessLabel(val) {
  if (val <= 8)  return 'Pitch Black';
  if (val <= 22) return 'Dark';
  if (val <= 38) return 'Dim';
  if (val <= 48) return 'Mid Dark';
  if (val <= 52) return 'Mid';
  if (val <= 62) return 'Mid Light';
  if (val <= 78) return 'Light';
  if (val <= 92) return 'Bright';
  return 'Pure White';
}

export function applyBrightness(val) {
  const vars = brightnessToVars(val);
  const html  = document.documentElement;
  for (const [k, v] of Object.entries(vars)) html.style.setProperty(k, v);
  if (val >= 50) {
    html.setAttribute('data-theme', 'light');
    html.style.setProperty('color-scheme', 'light');
  } else {
    html.removeAttribute('data-theme');
    html.style.setProperty('color-scheme', 'dark');
  }
  const label = document.getElementById('brightnessLabel');
  if (label) label.textContent = brightnessLabel(val);
}

export function applyColor(color) {
  const html = document.documentElement;
  if (!color || color === 'crimson') html.removeAttribute('data-color');
  else                               html.setAttribute('data-color', color);
  document.querySelectorAll('.color-swatch').forEach(s => {
    const active = s.dataset.color === (color || 'crimson');
    s.classList.toggle('active', active);
    s.setAttribute('aria-pressed', String(active));
  });
}

export function applyPreset(name) {
  const preset = THEME_PRESETS[name];
  if (!preset) return;
  applyBrightness(preset.brightness);
  applyColor(preset.color);
  localStorage.setItem(BRIGHTNESS_KEY, String(preset.brightness));
  localStorage.setItem(COLOR_KEY,      preset.color);
  localStorage.setItem(PRESET_KEY,     name);
  const slider = document.getElementById('brightnessSlider');
  if (slider) slider.value = preset.brightness;
  document.querySelectorAll('.theme-preset').forEach(p => {
    const active = p.dataset.preset === name;
    p.classList.toggle('active', active);
    p.setAttribute('aria-pressed', String(active));
  });
}

export function initTheme() {
  const savedBrightness = parseInt(localStorage.getItem(BRIGHTNESS_KEY) ?? '18', 10);
  const savedColor      = localStorage.getItem(COLOR_KEY) || 'crimson';
  const savedPreset     = localStorage.getItem(PRESET_KEY) || 'night';
  const savedBtnSize    = localStorage.getItem(BTNSIZE_KEY) || 'medium';

  applyBrightness(savedBrightness);
  applyColor(savedColor);
  applyButtonSize(savedBtnSize);

  document.querySelectorAll('.btnsize-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.dataset.size || 'medium';
      applyButtonSize(size);
      localStorage.setItem(BTNSIZE_KEY, size);
    });
  });

  document.querySelectorAll('.theme-preset').forEach(p => {
    const active = p.dataset.preset === savedPreset;
    p.classList.toggle('active', active);
    p.setAttribute('aria-pressed', String(active));
  });

  const slider = document.getElementById('brightnessSlider');
  if (slider) {
    slider.value = savedBrightness;
    slider.addEventListener('input', () => {
      const val = parseInt(slider.value, 10);
      applyBrightness(val);
      localStorage.setItem(BRIGHTNESS_KEY, String(val));
      localStorage.removeItem(PRESET_KEY);
      document.querySelectorAll('.theme-preset').forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-pressed', 'false');
      });
    });
  }

  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      applyColor(swatch.dataset.color);
      localStorage.setItem(COLOR_KEY, swatch.dataset.color);
      localStorage.removeItem(PRESET_KEY);
      document.querySelectorAll('.theme-preset').forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-pressed', 'false');
      });
    });
  });

  document.querySelectorAll('.theme-preset').forEach(p => {
    p.addEventListener('click', () => applyPreset(p.dataset.preset));
  });

  // Reveal page after theme is applied
  document.documentElement.style.visibility = 'visible';

  // Global book-cover fallback: swap broken <img> to placeholder div
  // Catches both real 404s and OpenLibrary silent placeholders (via ?default=false on the URL)
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG') return;
    const isSearch = img.classList.contains('book-search-cover');
    const isCover  = img.classList.contains('book-cover');
    if (!isCover && !isSearch) return;
    const ph = document.createElement('div');
    ph.className = isSearch ? 'book-search-cover-ph' : 'book-cover-ph';
    ph.setAttribute('aria-hidden', 'true');
    ph.innerHTML = '<i class="bi bi-book-fill"></i>';
    if (img.style.cssText) ph.style.cssText = img.style.cssText;
    img.replaceWith(ph);
  }, true /* capture so it fires before the img's own handlers */);
}

// ─── Settings modal ───────────────────────────────────────────────────────────
export function openSettingsModal() {
  const overlay = document.getElementById('settingsPage');
  if (overlay) {
    overlay.hidden = false;
    overlay.querySelector('.settings-modal-box')?.scrollTo?.(0, 0);
  }
}

export function initSettingsModal() {
  const overlay = document.getElementById('settingsPage');
  if (!overlay) return;
  const close = () => { overlay.hidden = true; };
  // Click on the backdrop (outside the box) closes it
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.settings-modal-close')?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
}

// ─── Stay Signed In ───────────────────────────────────────────────────────────
export const STAY_SIGNED_IN_KEY = 'bw-stay-signed-in';

/**
 * Wire the #staySignedInToggle checkbox.
 * onChangeFn(stay: boolean) is called when the toggle changes — use it to call
 * Firebase setPersistence from the portal's JS (which already imports Firebase).
 */
export function initStaySignedIn(onChangeFn) {
  const toggle = document.getElementById('staySignedInToggle');
  if (!toggle) return;
  toggle.checked = localStorage.getItem(STAY_SIGNED_IN_KEY) !== 'false'; // default ON
  toggle.addEventListener('change', () => {
    const stay = toggle.checked;
    localStorage.setItem(STAY_SIGNED_IN_KEY, String(stay));
    onChangeFn?.(stay);
  });
}

// ─── ARIA AI ──────────────────────────────────────────────────────────────────
const ARIA_ENABLED_KEY  = 'bw-aria-enabled';
// Web search is multi-provider too — pick whichever backend you have a key for.
const ARIA_SEARCH_PROVIDER_KEY  = 'bw-aria-search-provider';
const ARIA_SEARCH_PROVIDER_KEYS = {
  contextwire: 'bw-aria-search-key-contextwire',
  brave:       'bw-aria-search-key-brave',
  serpapi:     'bw-aria-search-key-serpapi',
};
const SEARCH_PROVIDER_META = {
  contextwire: {
    label:       'ContextWire API Key',
    hint:        '⭐ Recommended — 1,000 free searches/mo, no card required · contextwire.dev',
    placeholder: 'contextwire api key…',
  },
  brave: {
    label:       'Brave Search API Key',
    hint:        'Reliable, but lost its free tier in 2026 (metered billing) · brave.com/search/api',
    placeholder: 'brave subscription token…',
  },
  serpapi: {
    label:       'SerpAPI Key',
    hint:        'Limited free tier (~100 searches/mo) · serpapi.com',
    placeholder: 'serpapi key…',
  },
};

// Per-provider localStorage keys (keep old groq key for backward compat)
const ARIA_PROVIDER_KEYS = {
  anthropic:  'bw-aria-key-anthropic',
  openai:     'bw-aria-key-openai',
  gemini:     'bw-aria-key-gemini',
  cloudflare: 'bw-aria-key-cloudflare',
  openrouter: 'bw-aria-key-openrouter',
  groq:       'bw-aria-groq-key',  // legacy key preserved
};

const PROVIDER_META = {
  anthropic:  { label: 'Claude (Anthropic) API Key',           hint: 'console.anthropic.com — best quality',     placeholder: 'sk-ant-api03-…' },
  openai:     { label: 'OpenAI API Key',                       hint: 'platform.openai.com/api-keys',             placeholder: 'sk-…'           },
  gemini:     { label: 'Gemini API Key',                       hint: 'aistudio.google.com/apikey — free tier',   placeholder: 'AIza…'          },
  cloudflare: { label: 'Cloudflare Key (AccountID::APIToken)', hint: 'dash.cloudflare.com → AI → API Tokens',   placeholder: 'abc123::token'  },
  openrouter: { label: 'OpenRouter API Key',                   hint: 'openrouter.ai/keys — free models available', placeholder: 'sk-or-…'      },
  groq:       { label: 'Groq API Key',                         hint: 'console.groq.com — fast & free',           placeholder: 'gsk_…'          },
};

// Priority order ARIA auto-selects from when multiple keys are saved — Claude
// first because Anthropic models give the highest-quality recommendations and
// chat replies of any provider we support. Falls through to whichever else the
// user has configured.
const PROVIDER_PRIORITY = ['anthropic', 'openai', 'gemini', 'groq', 'openrouter', 'cloudflare'];
const PROVIDER_DISPLAY_NAME = {
  anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini',
  groq: 'Groq', openrouter: 'OpenRouter', cloudflare: 'Cloudflare',
};

const ARIA_SYSTEM = {
  student: "You are ARIA, a warm and concise reading assistant inside BookWare, a classroom library app. Help students find books, give spoiler-free summaries, suggest similar titles by theme or reading level, and answer book questions. Keep replies short and friendly. You cannot check out books for them — point them to the library page for that.",
  teacher: "You are ARIA, a concise assistant for a teacher running a classroom library in BookWare. Help with book recommendations by reading level and theme, classroom reading activities, and library ideas. Keep replies short and practical.",
  admin:   "You are ARIA, a concise assistant for a BookWare administrator. Answer general questions about running a school library system clearly and briefly.",
};

// ── Reading-quiz profile helpers (shared by ARIA chat + Recommends) ───────────
// Friendly labels for the quiz's machine-readable keys, used when describing a
// reader's profile to the AI and when building quick-reply chips.
const PROFILE_LABELS = {
  genres: {
    fantasy: 'fantasy', scifi: 'sci-fi & dystopian', mystery: 'mystery & thriller',
    romance: 'romance', contemporary: 'contemporary & realistic fiction', horror: 'horror',
    historical: 'historical fiction', graphic: 'graphic novels & manga',
    nonfiction: 'nonfiction & memoir', verse: 'verse novels & poetry',
    classics: 'classics', adventure: 'adventure & action',
  },
  length:  { quick: 'quick reads', medium: 'medium-length books', long: 'long doorstoppers', any: 'any length' },
  vibe:    { light: 'lighthearted & fun', dark: 'dark & intense', thoughtful: 'thought-provoking',
             action: 'action-packed & fast-paced', emotional: 'emotional & character-driven' },
  format:  { series: 'series they can binge', standalone: 'standalone stories', either: 'series or standalone, either works' },
  grades:  { '9': '9th grade', '10': '10th grade', '11': '11th grade', '12': '12th grade', mixed: 'mixed grade levels' },
  priorities: { diverse: 'diverse voices & representation', curriculum: 'curriculum tie-ins & classics',
                reluctant: 'hooking reluctant readers', sel: 'social-emotional learning topics',
                justgood: 'great stories kids will finish' },
  recStyle: { wholeclass: 'whole-class picks', individual: 'matching individual students', mix: 'a mix of whole-class and individual picks' },
};
const lbl = (cat, key) => PROFILE_LABELS[cat]?.[key] ?? String(key);

/** Turn a saved quiz profile into a short natural-language description for the
 *  AI prompt. Returns null if there's no usable profile (skipped/empty). */
function describeProfile(profile, role = 'student') {
  if (!profile || profile.skipped) return null;
  const bits = [];
  if (profile.genres?.length) bits.push(`enjoys ${profile.genres.map(g => lbl('genres', g)).join(', ')}`);
  if (profile.vibe)   bits.push(`is in the mood for something ${lbl('vibe', profile.vibe)}`);
  if (profile.length) bits.push(`prefers ${lbl('length', profile.length)}`);
  if (profile.format) bits.push(`likes ${lbl('format', profile.format)}`);
  if (profile.favorite) bits.push(`loved reading "${profile.favorite}"`);
  if (role === 'teacher') {
    if (profile.grades?.length) bits.push(`teaches ${profile.grades.map(g => lbl('grades', g)).join(', ')}`);
    if (profile.priorities?.length) bits.push(`cares most about ${profile.priorities.map(p => lbl('priorities', p)).join(', ')} when stocking the classroom shelf`);
    if (profile.recStyle) bits.push(`wants ${lbl('recStyle', profile.recStyle)}`);
  }
  if (!bits.length) return null;
  const who = role === 'teacher' ? 'This teacher' : 'This reader';
  return `${who} ${bits.join('; ')}.`;
}

/** Like describeProfile, but phrased in second person ("you enjoy…", "you
 *  teach…") for ARIA to address the reader directly in its hello message —
 *  kept separate so verb conjugation stays correct (third person "enjoys"
 *  vs. second person "enjoy" can't just be string-spliced together). */
function describeProfileToReader(profile, role = 'student') {
  if (!profile || profile.skipped) return null;
  // Collect candidate phrases in priority order, then keep just the top 3 —
  // a chat bubble reads far better as one tight sentence than a checklist of
  // every quiz answer crammed into a single run-on.
  const bits = [];
  if (profile.genres?.length) bits.push(`like ${profile.genres.slice(0, 2).map(g => lbl('genres', g)).join(' and ')}`);
  if (profile.favorite)       bits.push(`loved reading "${profile.favorite}"`);
  if (profile.vibe)           bits.push(`are in the mood for something ${lbl('vibe', profile.vibe)}`);
  if (role === 'teacher') {
    if (profile.priorities?.length) bits.push(`care most about ${lbl('priorities', profile.priorities[0])} for your shelves`);
    else if (profile.grades?.length) bits.push(`teach ${profile.grades.map(g => lbl('grades', g)).join(', ')}`);
  }
  if (profile.length) bits.push(`tend to go for ${lbl('length', profile.length)}`);
  if (profile.format) bits.push(`like ${lbl('format', profile.format)}`);
  if (!bits.length) return null;

  const top = bits.slice(0, 3);
  if (top.length === 1) return `you ${top[0]}`;
  if (top.length === 2) return `you ${top[0]} and ${top[1]}`;
  return `you ${top[0]}, ${top[1]}, and ${top[2]}`;
}

/** Build a handful of quiz-grounded quick-reply prompts for the ARIA chat —
 *  short labels paired with the full message they send when tapped. */
function buildQuickReplies(profile, role = 'student') {
  if (!profile || profile.skipped) return [];
  const out = [];
  const genres = profile.genres ?? [];
  if (genres[0]) out.push({ label: `More ${lbl('genres', genres[0])}`, msg: `Recommend a great ${lbl('genres', genres[0])} book for me — that's one of my favorite genres.` });
  if (genres[1]) out.push({ label: `Something ${lbl('genres', genres[1])}`, msg: `I'm also into ${lbl('genres', genres[1])} — what's a good one to pick up next?` });
  if (profile.favorite) out.push({ label: `Like "${profile.favorite}"`, msg: `Can you recommend something with a similar feel to "${profile.favorite}"?` });
  if (profile.vibe) out.push({ label: `Match my mood`, msg: `I'm in the mood for something ${lbl('vibe', profile.vibe)} right now — any ideas?` });
  if (role === 'teacher') {
    if (profile.priorities?.[0]) out.push({ label: `Picks for my shelf`, msg: `Suggest a few books that would be great for ${lbl('priorities', profile.priorities[0])} in my classroom library.` });
    if (profile.grades?.[0]) out.push({ label: `For grade ${profile.grades[0]}`, msg: `What books would you recommend for ${lbl('grades', profile.grades[0])} students?` });
  }
  out.push({ label: 'Surprise me', msg: 'Surprise me with a book recommendation — anything you think I would love!' });
  // Keep it tidy — at most 4 chips so the row never wraps awkwardly.
  return out.slice(0, 4);
}

// Auto-picks the best-available provider: the highest-priority one (Claude
// first) that actually has a saved key. Returns null if none are configured.
function getAriaProvider() {
  for (const provider of PROVIDER_PRIORITY) {
    if (localStorage.getItem(ARIA_PROVIDER_KEYS[provider])) return provider;
  }
  return null;
}
function getAriaKey() {
  const provider = getAriaProvider();
  return provider ? (localStorage.getItem(ARIA_PROVIDER_KEYS[provider]) ?? '') : '';
}

// Registered chat re-render callbacks so toggling the setting updates live.
const ariaRefreshers = [];
export function refreshAriaChats() {
  ariaRefreshers.forEach(fn => { try { fn(); } catch (_) {} });
}

// ── Provider-specific API callers ─────────────────────────────────────────────

async function callOpenAI(endpoint, key, messages, model, extraHeaders = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 600 }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch (_) {}
    if (res.status === 401) throw new Error('Invalid API key — check Settings → ARIA AI.');
    throw new Error(detail || `AI request failed (${res.status}).`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}

async function callAnthropic(key, messages) {
  const system   = messages.find(m => m.role === 'system')?.content ?? '';
  const chatMsgs = messages.filter(m => m.role !== 'system');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      ...(system ? { system } : {}),
      messages: chatMsgs,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch (_) {}
    if (res.status === 401) throw new Error('Invalid Anthropic key — check Settings → ARIA AI.');
    throw new Error(detail || `Anthropic request failed (${res.status}).`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() ?? '(no response)';
}

async function callGemini(key, messages) {
  const system   = messages.find(m => m.role === 'system')?.content ?? '';
  const chatMsgs = messages.filter(m => m.role !== 'system');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: chatMsgs.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
      }),
    }
  );
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch (_) {}
    throw new Error(detail || `Gemini request failed (${res.status}).`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '(no response)';
}

async function callCloudflare(combinedKey, messages) {
  const sep = combinedKey.indexOf('::');
  if (sep < 0) throw new Error('Cloudflare key must be "AccountID::APIToken" — check Settings.');
  const accountId = combinedKey.slice(0, sep);
  const apiToken  = combinedKey.slice(sep + 2);
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiToken}` },
      body: JSON.stringify({ messages }),
    }
  );
  if (!res.ok) throw new Error(`Cloudflare AI request failed (${res.status}).`);
  const data = await res.json();
  return data.result?.response?.trim() ?? '(no response)';
}

// ─── Web search providers (ARIA can use any one of these) ─────────────────────
// ContextWire — generous free-tier search+answer API. Recommended: 1,000 free
// searches/mo, no card required. Docs: https://contextwire.dev
//   GET /api/ask?q=... with `Authorization: Bearer <key>`, returns a
//   pre-extracted `answer` plus a `sources` array (title/url).
async function searchContextWire(key, query) {
  try {
    const url = `https://contextwire.dev/api/ask?q=${encodeURIComponent(query + ' book')}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${key}` } });
    if (!res.ok) return '';
    const data = await res.json();
    const lines = [];
    if (data.answer) lines.push(data.answer.trim());
    (data.sources ?? []).slice(0, 3).forEach(s => {
      if (s?.title) lines.push(`• ${s.title}${s.url ? ` — ${s.url}` : ''}`);
    });
    return lines.join('\n');
  } catch {
    return '';
  }
}

// Brave Search — reliable, Google-grade results, but lost its free tier in
// 2026 (now metered/billed). Docs: https://api-dashboard.search.brave.com
//   GET /res/v1/web/search?q=... with `X-Subscription-Token: <key>`.
async function searchBrave(key, query) {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query + ' book')}&count=3`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
    });
    if (!res.ok) return '';
    const data = await res.json();
    return (data.web?.results ?? []).slice(0, 3)
      .map(r => `• ${r.title}: ${r.description ?? ''}`)
      .join('\n');
  } catch {
    return '';
  }
}

// SerpAPI — Google search results via SerpAPI. Small free tier (~100/mo).
// Docs: https://serpapi.com
async function searchSerpApi(key, query) {
  try {
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query + ' book')}&api_key=${key}&num=3`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const data = await res.json();
    return (data.organic_results ?? []).slice(0, 3)
      .map(r => `• ${r.title}: ${r.snippet ?? ''}`)
      .join('\n');
  } catch {
    return '';
  }
}

/** Dispatch a web search to whichever provider the user configured */
async function webSearch(provider, key, query) {
  switch (provider) {
    case 'brave':       return searchBrave(key, query);
    case 'serpapi':     return searchSerpApi(key, query);
    case 'contextwire':
    default:            return searchContextWire(key, query);
  }
}

/** Unified AI call — routes to the right provider */
async function callAriaProvider(provider, key, messages) {
  // Optionally inject web-search results (from the user's chosen search
  // provider) into the last user message for grounded, up-to-date answers.
  const searchProvider = localStorage.getItem(ARIA_SEARCH_PROVIDER_KEY) ?? 'contextwire';
  const searchKey = localStorage.getItem(ARIA_SEARCH_PROVIDER_KEYS[searchProvider] ?? '') ?? '';
  if (searchKey) {
    const lastUserIdx = [...messages].reverse().findIndex(m => m.role === 'user');
    if (lastUserIdx >= 0) {
      const realIdx = messages.length - 1 - lastUserIdx;
      const ctx = await webSearch(searchProvider, searchKey, messages[realIdx].content);
      if (ctx) {
        messages = messages.map((m, i) => i === realIdx
          ? { ...m, content: `${m.content}\n\n[Web context:\n${ctx}]` }
          : m);
      }
    }
  }

  switch (provider) {
    case 'anthropic':
      return callAnthropic(key, messages);
    case 'openai':
      return callOpenAI('https://api.openai.com/v1/chat/completions', key, messages, 'gpt-4o-mini');
    case 'gemini':
      return callGemini(key, messages);
    case 'cloudflare':
      return callCloudflare(key, messages);
    case 'openrouter':
      return callOpenAI(
        'https://openrouter.ai/api/v1/chat/completions', key, messages,
        'meta-llama/llama-3.2-3b-instruct:free',
        { 'HTTP-Referer': 'https://bookware-site2.web.app', 'X-Title': 'BookWare ARIA' }
      );
    case 'groq':
    default:
      return callOpenAI('https://api.groq.com/openai/v1/chat/completions', key, messages, 'llama-3.1-8b-instant');
  }
}

// ── Chat widget ───────────────────────────────────────────────────────────────

/** Mount an ARIA chat widget into the element with id `mountId`.
 *  role: 'student' | 'teacher' | 'admin'
 *  getProfile: optional () => readingProfile getter — when present, ARIA shows
 *  quiz-grounded quick-reply chips and tailors its hello to what the user
 *  said they like. Passed as a getter (not a value) because the quiz may
 *  finish loading well after the chat first mounts. */
export function initAriaChat(mountId, role = 'student', getProfile = null) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const history = [{ role: 'system', content: ARIA_SYSTEM[role] ?? ARIA_SYSTEM.student }];
  let chipsShown = false; // only show quick replies until the user starts chatting

  function addMsg(container, who, text) {
    const el = document.createElement('div');
    el.className = `aria-msg aria-msg--${who}`;
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function render() {
    const enabled  = localStorage.getItem(ARIA_ENABLED_KEY) === 'true';
    const key      = getAriaKey();
    const provider = getAriaProvider();
    const hasSearchKey = hasSearchKeyConfigured();
    if (!enabled) { mount.innerHTML = ''; mount.hidden = true; return; }
    mount.hidden = false;
    const providerName = PROVIDER_META[provider]?.label?.split(' ')[0] ?? 'AI';
    const profile = getProfile?.() ?? null;
    chipsShown = false;
    mount.innerHTML = `
      <div class="aria-chat">
        <div class="aria-chat-header">
          <span class="aria-chat-title"><i class="bi bi-robot" aria-hidden="true"></i> ARIA
            ${hasSearchKey ? '<i class="bi bi-search" title="Web search enabled" style="font-size:0.7rem;opacity:0.6;margin-left:4px" aria-hidden="true"></i>' : ''}
          </span>
          <button class="aria-chat-clear" type="button" title="Clear chat" aria-label="Clear chat"><i class="bi bi-arrow-counterclockwise"></i></button>
        </div>
        <div class="aria-chat-messages" id="${mountId}-msgs" role="log" aria-live="polite"></div>
        <div class="aria-chat-chips" id="${mountId}-chips"></div>
        <form class="aria-chat-input-row" id="${mountId}-form">
          <input id="${mountId}-input" class="aria-chat-input" placeholder="Ask ARIA about books…" autocomplete="off" aria-label="Message ARIA" ${key ? '' : 'disabled'} />
          <button type="submit" class="btn btn--primary btn--sm" ${key ? '' : 'disabled'} aria-label="Send message"><i class="bi bi-send-fill"></i></button>
        </form>
      </div>`;
    const msgs  = document.getElementById(`${mountId}-msgs`);
    const chips = document.getElementById(`${mountId}-chips`);
    const greetingBits = describeProfileToReader(profile, role);
    addMsg(msgs, 'bot', key
      ? (greetingBits
          ? `Hi! I'm ARIA. From your reading quiz, I can tell ${greetingBits} — want a recommendation, or ask me anything about books!`
          : `Hi! I'm ARIA${hasSearchKey ? ' (web search on)' : ''}. Ask me for book recommendations, summaries, or anything about reading.`)
      : 'ARIA needs an API key. Add one in Settings → ARIA AI to start chatting.');

    function renderChips() {
      if (!chips) return;
      if (chipsShown || !key) { chips.innerHTML = ''; return; }
      const replies = buildQuickReplies(profile, role);
      if (!replies.length) { chips.innerHTML = ''; return; }
      chips.innerHTML = replies.map((r, i) =>
        `<button type="button" class="aria-chip" data-idx="${i}"><i class="bi bi-stars" aria-hidden="true"></i> ${escHtml(r.label)}</button>`
      ).join('');
      chips.querySelectorAll('.aria-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const r = replies[Number(btn.dataset.idx)];
          if (r) sendMessage(r.msg);
        });
      });
    }
    renderChips();

    async function sendMessage(text) {
      const k    = getAriaKey();
      const prov = getAriaProvider();
      if (!text || !k) return;
      chipsShown = true;
      if (chips) chips.innerHTML = '';
      addMsg(msgs, 'user', text);
      history.push({ role: 'user', content: text });
      const thinking = addMsg(msgs, 'bot', 'Thinking…');
      thinking.classList.add('aria-msg--thinking');
      try {
        const reply = await callAriaProvider(prov, k, history.slice(-12));
        history.push({ role: 'assistant', content: reply });
        thinking.classList.remove('aria-msg--thinking');
        thinking.textContent = reply;
      } catch (err) {
        thinking.classList.remove('aria-msg--thinking');
        thinking.classList.add('aria-msg--error');
        thinking.textContent = err.message || String(err);
      }
      msgs.scrollTop = msgs.scrollHeight;
    }

    mount.querySelector('.aria-chat-clear')?.addEventListener('click', () => {
      history.length = 1; // keep the system prompt
      render();
    });

    document.getElementById(`${mountId}-form`)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById(`${mountId}-input`);
      const text  = input.value.trim();
      if (!text) return;
      input.value = '';
      await sendMessage(text);
    });
  }

  ariaRefreshers.push(render);
  render();
}

// ── ARIA Recommends panel ─────────────────────────────────────────────────────
const AR_LOCAL_COUNT    = 2; // picks drawn from BookWare's curated on-file list
const AR_INTERNET_COUNT = 2; // picks ARIA sources beyond the on-file list

function hasSearchKeyConfigured() {
  const sp = localStorage.getItem(ARIA_SEARCH_PROVIDER_KEY) ?? 'contextwire';
  return !!localStorage.getItem(ARIA_SEARCH_PROVIDER_KEYS[sp] ?? '');
}

/** Normalize a title for duplicate-detection ("The Hobbit!" == "the hobbit"). */
function normTitle(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Mount an "ARIA Recommends" card into `mountId`. Blends two sources so picks
 *  aren't limited to BookWare's on-file list: a couple of curated titles from
 *  `booklist.js` (guaranteed real, vetted books) plus a couple ARIA sources
 *  itself — grounded in live web-search results when a Web Search key is
 *  configured (Settings → ARIA AI), or its own general knowledge otherwise.
 *  Every pick across both sources is deduplicated by normalized title so the
 *  same book is never shown twice in one refresh. Renders nothing unless ARIA
 *  is enabled AND has a working API key — i.e. "only works if the AI is
 *  wired", per spec.
 *  role: 'student' | 'teacher'
 *  getProfile: optional () => readingProfile getter (see initAriaChat). */
export function initAriaRecommends(mountId, role = 'student', getProfile = null) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  let lastSig = null;   // skip useless re-fetches when nothing relevant changed
  let inFlight = false;

  async function render() {
    const enabled  = localStorage.getItem(ARIA_ENABLED_KEY) === 'true';
    const key      = getAriaKey();
    const provider = getAriaProvider();
    if (!enabled || !key) { mount.innerHTML = ''; mount.hidden = true; lastSig = null; return; }

    const profile = getProfile?.() ?? null;
    const sig = `${provider}::${key.slice(0, 6)}::${JSON.stringify(profile ?? {})}`;
    if (sig === lastSig || inFlight) return;
    lastSig = sig;
    inFlight = true;
    mount.hidden = false;

    mount.innerHTML = `
      <div class="section-label"><i class="bi bi-stars" aria-hidden="true"></i> ARIA Recommends</div>
      <div class="aria-recs aria-recs--loading">
        <p class="empty-state"><i class="bi bi-hourglass-split" aria-hidden="true"></i> ARIA is picking books for you…</p>
      </div>`;

    const webGrounded = hasSearchKeyConfigured();
    const localPicks = pickBooksForProfile(profile, AR_LOCAL_COUNT);
    let localReasons = localPicks.map(b => b.blurb);
    const internetPicks = []; // { title, author, genres:[], reason }

    try {
      const who = role === 'teacher' ? 'a teacher looking for classroom library picks' : 'a highschool student';
      const profileLine = describeProfile(profile, role);
      const excludeTitles = localPicks.map(b => `"${b.title}"`).join(', ');
      const prompt =
        `The reader is ${who}.${profileLine ? ` ${profileLine}` : ' They have not taken the reading quiz yet, so just go on general highschool-appropriate appeal.'}\n\n` +
        `PART 1 — Here are ${localPicks.length} books already chosen for them from our on-file library list:\n${formatBooksForPrompt(localPicks)}\n\n` +
        `For each one, in the SAME order, write one short, warm sentence (max 28 words) telling this specific reader why they'd enjoy it. Prefix each line with "REASON: ".\n\n` +
        `PART 2 — Now suggest ${AR_INTERNET_COUNT} MORE real, well-known, highschool-appropriate books that match this reader, drawing on your own knowledge${webGrounded ? ' and any web search context provided below' : ''} — books that are NOT in our on-file list. ` +
        `Do not repeat any of these titles: ${excludeTitles}. Every suggestion must be a real, existing, published book — never invent a title or author.\n` +
        `Reply with one line per suggestion in EXACTLY this format:\n` +
        `NEW: Title | Author | genre1,genre2 | one warm sentence (max 28 words) on why this reader would enjoy it\n\n` +
        `Reply with EXACTLY ${localPicks.length} "REASON:" lines followed by EXACTLY ${AR_INTERNET_COUNT} "NEW:" lines, nothing else — no numbering, no preamble, no closing remarks.`;
      const reply = await callAriaProvider(provider, key, [
        { role: 'system', content: 'You are ARIA, a warm, concise reading-recommendation assistant inside the BookWare app. Follow the requested output format exactly — no preamble, no extra lines, no markdown.' },
        { role: 'user', content: prompt },
      ]);

      const lines = reply.split('\n').map(l => l.trim()).filter(Boolean);
      const reasonLines = lines.filter(l => /^REASON:/i.test(l)).map(l => l.replace(/^REASON:\s*/i, '').trim());
      const newLines    = lines.filter(l => /^NEW:/i.test(l)).map(l => l.replace(/^NEW:\s*/i, '').trim());

      if (reasonLines.length >= localPicks.length) localReasons = reasonLines.slice(0, localPicks.length);

      // Dedupe internet picks against the local picks AND against each other,
      // so the same book can never appear twice in one refresh.
      const seenTitles = new Set(localPicks.map(b => normTitle(b.title)));
      for (const line of newLines) {
        if (internetPicks.length >= AR_INTERNET_COUNT) break;
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 4) continue;
        const [title, author, genreStr, reason] = parts;
        if (!title || !author || !reason) continue;
        const tKey = normTitle(title);
        if (seenTitles.has(tKey)) continue;
        seenTitles.add(tKey);
        internetPicks.push({
          title, author, reason,
          genres: genreStr.split(',').map(g => g.trim()).filter(Boolean).slice(0, 3),
        });
      }
    } catch (_) {
      // AI personalization / internet lookup failed (rate limit, bad key,
      // offline, etc.) — fall back to the curated on-file blurbs so the box
      // still shows real picks instead of an error. This is exactly the
      // degraded mode the setup warning above the API key fields describes.
    }
    inFlight = false;

    const localCards = localPicks.map((b, i) => `
      <div class="aria-rec-card">
        <div class="aria-rec-head">
          <div class="aria-rec-title">${escHtml(b.title)}</div>
          <div class="aria-rec-author">by ${escHtml(b.author)}</div>
        </div>
        <p class="aria-rec-reason">${escHtml(localReasons[i] ?? b.blurb)}</p>
        <div class="aria-rec-genres">${b.genres.slice(0, 3).map(g => `<span class="aria-rec-chip">${escHtml(lbl('genres', g))}</span>`).join('')}</div>
      </div>`).join('');

    const internetCards = internetPicks.map(b => `
      <div class="aria-rec-card aria-rec-card--web">
        <div class="aria-rec-head">
          <div class="aria-rec-title">${escHtml(b.title)}
            <span class="aria-badge aria-badge--free">${webGrounded ? '🌐 Web pick' : '✨ AI pick'}</span>
          </div>
          <div class="aria-rec-author">by ${escHtml(b.author)}</div>
        </div>
        <p class="aria-rec-reason">${escHtml(b.reason)}</p>
        <div class="aria-rec-genres">${b.genres.map(g => `<span class="aria-rec-chip">${escHtml(g)}</span>`).join('')}</div>
      </div>`).join('');

    mount.innerHTML = `
      <div class="section-label"><i class="bi bi-stars" aria-hidden="true"></i> ARIA Recommends
        <span class="aria-recs-tag">picked just for you</span>
      </div>
      <div class="aria-recs">
        ${localCards}
        ${internetCards}
      </div>
      ${!internetPicks.length ? `<p class="settings-hint" style="margin-top:6px">Add a Web Search key in Settings → ARIA AI for fresh, internet-grounded picks too.</p>` : ''}
      <button type="button" class="btn btn--ghost btn--sm aria-recs-refresh">
        <i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Show different picks
      </button>`;

    mount.querySelector('.aria-recs-refresh')?.addEventListener('click', () => {
      lastSig = null; // force a fresh draw even though provider/profile match
      render();
    });
  }

  ariaRefreshers.push(render);
  render();
}

// ── ARIA settings panel (shared across all portals) ───────────────────────────
/** Wire the ARIA AI settings section.
 *  toastFn is optional — pass the page's toast() for in-app feedback. */
export function initARIA(toastFn) {
  const toggle      = document.getElementById('ariaEnabled');
  const panel       = document.getElementById('ariaSetupPanel');
  const activeLine  = document.getElementById('ariaActiveProviderText');
  // Web search — provider-aware (ContextWire / Brave / SerpAPI)
  const searchProvSelect = document.getElementById('ariaSearchProvider');
  const searchInput      = document.getElementById('ariaSearchKey');
  const searchKeyLabel   = document.getElementById('ariaSearchKeyLabel');
  const searchKeyHint    = document.getElementById('ariaSearchKeyHint');
  const searchSaveBtn    = document.getElementById('ariaSaveSearchBtn');
  if (!toggle || !panel) return;

  // Restore state
  toggle.checked = localStorage.getItem(ARIA_ENABLED_KEY) === 'true';
  panel.hidden   = !toggle.checked;

  const savedSearchProvider = localStorage.getItem(ARIA_SEARCH_PROVIDER_KEY) ?? 'contextwire';
  if (searchProvSelect) searchProvSelect.value = savedSearchProvider;
  updateSearchKeyUI(savedSearchProvider);

  // Restore each provider's saved key into its own row + refresh status badges
  ['anthropic', 'openai', 'gemini', 'groq'].forEach(provider => {
    const input = document.getElementById(`ariaKey-${provider}`);
    if (input) input.value = localStorage.getItem(ARIA_PROVIDER_KEYS[provider]) ?? '';
  });
  refreshProviderStatus();

  function refreshProviderStatus() {
    const active = getAriaProvider();
    ['anthropic', 'openai', 'gemini', 'groq'].forEach(provider => {
      const badge = document.querySelector(`.aria-key-row-status[data-status="${provider}"]`);
      if (!badge) return;
      const hasKey = !!localStorage.getItem(ARIA_PROVIDER_KEYS[provider]);
      badge.textContent = hasKey ? (provider === active ? '✓ Active' : '✓ Saved') : '';
    });
    if (activeLine) {
      activeLine.innerHTML = active
        ? `ARIA is running on <strong>${PROVIDER_DISPLAY_NAME[active] ?? active}</strong>${active === 'anthropic' ? ' <span class="aria-badge aria-badge--best">⭐ Highest Quality</span>' : ''}.`
        : 'No AI key saved yet — add one below to turn ARIA on.';
    }
  }

  function updateSearchKeyUI(provider) {
    const meta = SEARCH_PROVIDER_META[provider];
    if (!meta) return;
    if (searchKeyLabel) searchKeyLabel.textContent = meta.label;
    if (searchKeyHint)  searchKeyHint.innerHTML    = meta.hint;
    if (searchInput) {
      searchInput.placeholder = meta.placeholder;
      searchInput.value = localStorage.getItem(ARIA_SEARCH_PROVIDER_KEYS[provider] ?? '') ?? '';
    }
  }

  // Enable/disable toggle
  toggle.addEventListener('change', () => {
    const on = toggle.checked;
    localStorage.setItem(ARIA_ENABLED_KEY, String(on));
    panel.hidden = !on;
    refreshAriaChats();
    toastFn?.(on ? `<i class='bi bi-robot'></i> ARIA enabled` : 'ARIA disabled', on ? 'success' : 'info');
  });

  // Save each provider's key from its own row
  document.querySelectorAll('.aria-key-row [data-save]').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.save;
      const input = document.getElementById(`ariaKey-${provider}`);
      const key = input?.value.trim() ?? '';
      const name = PROVIDER_DISPLAY_NAME[provider] ?? provider;
      if (!key) {
        localStorage.removeItem(ARIA_PROVIDER_KEYS[provider]);
        refreshProviderStatus();
        refreshAriaChats();
        toastFn?.(`${name} key removed.`, 'info');
        return;
      }
      localStorage.setItem(ARIA_PROVIDER_KEYS[provider], key);
      refreshProviderStatus();
      refreshAriaChats();
      toastFn?.(`<i class='bi bi-check2'></i> ${name} key saved!`, 'success');
    });
  });

  // Web search provider selector
  searchProvSelect?.addEventListener('change', () => {
    const p = searchProvSelect.value;
    localStorage.setItem(ARIA_SEARCH_PROVIDER_KEY, p);
    updateSearchKeyUI(p);
    refreshAriaChats();
  });

  // Save / clear web-search key (for whichever provider is currently selected)
  searchSaveBtn?.addEventListener('click', () => {
    const provider = searchProvSelect?.value ?? 'contextwire';
    const storageKey = ARIA_SEARCH_PROVIDER_KEYS[provider] ?? ARIA_SEARCH_PROVIDER_KEYS.contextwire;
    const key = searchInput?.value.trim() ?? '';
    const name = SEARCH_PROVIDER_META[provider]?.label?.replace(/ API Key$/, '') ?? 'Search';
    if (key) {
      localStorage.setItem(storageKey, key);
      refreshAriaChats();
      toastFn?.(`<i class="bi bi-search"></i> ${name} key saved — ARIA can now search the web!`, 'success');
    } else {
      localStorage.removeItem(storageKey);
      refreshAriaChats();
      toastFn?.(`${name} key removed.`, 'info');
    }
  });
}
