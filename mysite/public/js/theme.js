// theme.js — Shared brightness/color/preset theme logic
// Imported by student.js and teacher.js

export const BRIGHTNESS_KEY = 'bookware-brightness';
export const COLOR_KEY      = 'bookware-color';
export const PRESET_KEY     = 'bookware-preset';

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
  if (val >= 50) html.setAttribute('data-theme', 'light');
  else           html.removeAttribute('data-theme');
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

  applyBrightness(savedBrightness);
  applyColor(savedColor);

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
}

// ARIA AI setup (shared)
export function initARIA() {
  const ARIA_ENABLED_KEY = 'bw-aria-enabled';
  const ARIA_KEY_STORAGE = 'bw-aria-groq-key';

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
    // toast is called from the page JS, not here
  });

  saveBtn?.addEventListener('click', () => {
    const key = keyInput?.value.trim();
    if (!key || !key.startsWith('gsk_')) return false;
    localStorage.setItem(ARIA_KEY_STORAGE, key);
    return true;
  });
}
