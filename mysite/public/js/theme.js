// theme.js — Shared brightness/color/preset theme logic
// Imported by student.js and teacher.js

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

// ─── ARIA AI ──────────────────────────────────────────────────────────────────
const ARIA_ENABLED_KEY = 'bw-aria-enabled';
const ARIA_KEY_STORAGE = 'bw-aria-groq-key';
const ARIA_MODEL       = 'llama-3.1-8b-instant';

const ARIA_SYSTEM = {
  student: "You are ARIA, a warm and concise reading assistant inside BookWare, a classroom library app. Help students find books, give spoiler-free summaries, suggest similar titles by theme or reading level, and answer book questions. Keep replies short and friendly. You cannot check out books for them — point them to the library page for that.",
  teacher: "You are ARIA, a concise assistant for a teacher running a classroom library in BookWare. Help with book recommendations by reading level and theme, classroom reading activities, and library ideas. Keep replies short and practical.",
  admin:   "You are ARIA, a concise assistant for a BookWare administrator. Answer general questions about running a school library system clearly and briefly.",
};

// Registered chat re-render callbacks so toggling the setting updates live.
const ariaRefreshers = [];
export function refreshAriaChats() {
  ariaRefreshers.forEach(fn => { try { fn(); } catch (_) {} });
}

async function callGroq(key, messages) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: ARIA_MODEL, messages, temperature: 0.7, max_tokens: 600 }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch (_) {}
    if (res.status === 401) throw new Error('Invalid Groq key — check Settings → ARIA AI.');
    throw new Error(detail || `Groq request failed (${res.status}).`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '(no response)';
}

// Mount an ARIA chat widget into the element with id `mountId`.
// role: 'student' | 'teacher' | 'admin' — sets ARIA's persona.
export function initAriaChat(mountId, role = 'student') {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  const history = [{ role: 'system', content: ARIA_SYSTEM[role] ?? ARIA_SYSTEM.student }];

  function addMsg(container, who, text) {
    const el = document.createElement('div');
    el.className = `aria-msg aria-msg--${who}`;
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function render() {
    const enabled = localStorage.getItem(ARIA_ENABLED_KEY) === 'true';
    const key     = localStorage.getItem(ARIA_KEY_STORAGE) ?? '';
    if (!enabled) { mount.innerHTML = ''; mount.hidden = true; return; }
    mount.hidden = false;
    mount.innerHTML = `
      <div class="aria-chat">
        <div class="aria-chat-header">
          <span class="aria-chat-title"><i class="bi bi-robot" aria-hidden="true"></i> ARIA</span>
          <button class="aria-chat-clear" type="button" title="Clear chat" aria-label="Clear chat"><i class="bi bi-arrow-counterclockwise"></i></button>
        </div>
        <div class="aria-chat-messages" id="${mountId}-msgs" role="log" aria-live="polite"></div>
        <form class="aria-chat-input-row" id="${mountId}-form">
          <input id="${mountId}-input" class="aria-chat-input" placeholder="Ask ARIA about books…" autocomplete="off" aria-label="Message ARIA" ${key ? '' : 'disabled'} />
          <button type="submit" class="btn btn--primary btn--sm" ${key ? '' : 'disabled'} aria-label="Send message"><i class="bi bi-send-fill"></i></button>
        </form>
      </div>`;
    const msgs = document.getElementById(`${mountId}-msgs`);
    addMsg(msgs, 'bot', key
      ? "Hi! I'm ARIA. Ask me for book recommendations, summaries, or anything about reading."
      : "ARIA needs a free Groq API key. Add one in Settings → ARIA AI to start chatting.");

    mount.querySelector('.aria-chat-clear')?.addEventListener('click', () => {
      history.length = 1; // keep the system prompt
      render();
    });

    document.getElementById(`${mountId}-form`)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById(`${mountId}-input`);
      const text  = input.value.trim();
      const k     = localStorage.getItem(ARIA_KEY_STORAGE) ?? '';
      if (!text || !k) return;
      input.value = '';
      addMsg(msgs, 'user', text);
      history.push({ role: 'user', content: text });
      const thinking = addMsg(msgs, 'bot', 'Thinking…');
      thinking.classList.add('aria-msg--thinking');
      try {
        const reply = await callGroq(k, history.slice(-12));
        history.push({ role: 'assistant', content: reply });
        thinking.classList.remove('aria-msg--thinking');
        thinking.textContent = reply;
      } catch (err) {
        thinking.classList.remove('aria-msg--thinking');
        thinking.classList.add('aria-msg--error');
        thinking.textContent = err.message || String(err);
      }
      msgs.scrollTop = msgs.scrollHeight;
    });
  }

  ariaRefreshers.push(render);
  render();
}

// ARIA AI settings (shared) — toggle + Groq key
// toastFn is optional — pass the page's toast() so feedback shows in-app
export function initARIA(toastFn) {
  const toggle   = document.getElementById('ariaEnabled');
  const panel    = document.getElementById('ariaSetupPanel');
  const keyInput = document.getElementById('ariaApiKey');
  const saveBtn  = document.getElementById('ariaSaveKeyBtn');
  if (!toggle || !panel) return;

  const enabled  = localStorage.getItem(ARIA_ENABLED_KEY) === 'true';
  const savedKey = localStorage.getItem(ARIA_KEY_STORAGE) ?? '';
  toggle.checked = enabled;
  panel.hidden   = !enabled;
  if (keyInput && savedKey) keyInput.value = savedKey;

  toggle.addEventListener('change', () => {
    const on = toggle.checked;
    localStorage.setItem(ARIA_ENABLED_KEY, String(on));
    panel.hidden = !on;
    refreshAriaChats();
    toastFn?.(on ? `<i class='bi bi-robot'></i> ARIA enabled` : 'ARIA disabled', on ? 'success' : 'info');
  });

  saveBtn?.addEventListener('click', () => {
    const key = keyInput?.value.trim();
    if (!key || !key.startsWith('gsk_')) {
      toastFn?.('Key should start with gsk_ — check and try again.', 'danger');
      return;
    }
    localStorage.setItem(ARIA_KEY_STORAGE, key);
    refreshAriaChats();
    toastFn?.(`<i class='bi bi-check2'></i> Groq key saved — ARIA is ready!`, 'success');
  });
}
