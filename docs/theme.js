'use strict';

/**
 * theme.js — Theme engine for TCP Flow-Control Simulator
 *
 * Themes are applied by setting data-theme="<name>" on <html>.
 * CSS variables in style.css / auth.css respond to the attribute.
 * The chosen theme is persisted to localStorage.
 */

const THEMES = [
  {
    id:    'dark',
    label: 'Dark',
    icon:  '🌑',
    desc:  'Default dark blue-grey',
  },
  {
    id:    'light',
    label: 'Light',
    icon:  '☀️',
    desc:  'Clean white surface',
  },
  {
    id:    'ocean',
    label: 'Ocean',
    icon:  '🌊',
    desc:  'Deep teal tones',
  },
  {
    id:    'sunset',
    label: 'Sunset',
    icon:  '🌅',
    desc:  'Warm amber & rose',
  },
  {
    id:    'forest',
    label: 'Forest',
    icon:  '🌿',
    desc:  'Muted green palette',
  },
];

const STORAGE_KEY = 'tcp_theme';
const DEFAULT     = 'dark';

// ── Core helpers ──────────────────────────────────────────────────────────────

function applyTheme(id) {
  const valid = THEMES.find(t => t.id === id) ? id : DEFAULT;
  document.documentElement.setAttribute('data-theme', valid);
  localStorage.setItem(STORAGE_KEY, valid);
  // Update all picker buttons if they exist on this page
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeId === valid);
  });
}

function getSavedTheme() {
  return localStorage.getItem(STORAGE_KEY) || DEFAULT;
}

// Apply immediately on load (before paint) to avoid flash
applyTheme(getSavedTheme());

// ── Theme picker widget ───────────────────────────────────────────────────────

/**
 * Build and insert the theme picker.
 * @param {string} mountSelector  — CSS selector of the element to append into
 * @param {'row'|'dropdown'}  mode  — 'row' for topnav, 'dropdown' for auth pages
 */
function buildThemePicker(mountSelector, mode = 'row') {
  const mount = document.querySelector(mountSelector);
  if (!mount) return;

  if (mode === 'dropdown') {
    _buildDropdown(mount);
  } else {
    _buildRow(mount);
  }
}

function _buildRow(mount) {
  const wrap = document.createElement('div');
  wrap.className = 'theme-picker-row';
  wrap.setAttribute('aria-label', 'Choose theme');

  THEMES.forEach(t => {
    const btn = document.createElement('button');
    btn.className        = 'theme-btn';
    btn.dataset.themeId  = t.id;
    btn.title            = `${t.label} — ${t.desc}`;
    btn.setAttribute('aria-label', t.label);
    btn.textContent      = t.icon;
    btn.addEventListener('click', () => applyTheme(t.id));
    wrap.appendChild(btn);
  });

  mount.appendChild(wrap);
  // Mark current active
  const current = getSavedTheme();
  wrap.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.themeId === current);
  });
}

function _buildDropdown(mount) {
  const wrap = document.createElement('div');
  wrap.className = 'theme-picker-dropdown';

  const label = document.createElement('label');
  label.className   = 'theme-dropdown-label';
  label.htmlFor     = 'themeSelect';
  label.textContent = 'Theme';

  const sel = document.createElement('select');
  sel.id        = 'themeSelect';
  sel.className = 'theme-select';

  THEMES.forEach(t => {
    const opt   = document.createElement('option');
    opt.value   = t.id;
    opt.textContent = `${t.icon} ${t.label}`;
    sel.appendChild(opt);
  });

  sel.value = getSavedTheme();
  sel.addEventListener('change', () => applyTheme(sel.value));

  wrap.appendChild(label);
  wrap.appendChild(sel);
  mount.appendChild(wrap);
}

// Expose globally
window.ThemeEngine = { applyTheme, getSavedTheme, buildThemePicker, THEMES };
