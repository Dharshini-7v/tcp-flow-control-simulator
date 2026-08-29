'use strict';

/**
 * auth.js — Shared auth utilities for all frontend pages
 *
 * Provides:
 *   AuthAPI   — fetch wrappers for /api/auth/* endpoints
 *   AuthGuard — call on protected pages to redirect unauthenticated users
 *   AuthUser  — helpers to read/clear stored session data
 */

const API_BASE = 'http://localhost:3000/api/auth';

// ── API wrapper ───────────────────────────────────────────────────────────────
const AuthAPI = {
  register(name, email, password) {
    return fetch(`${API_BASE}/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, password }),
    });
  },

  login(email, password) {
    return fetch(`${API_BASE}/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
  },

  logout() {
    const token = localStorage.getItem('tcp_token');
    return fetch(`${API_BASE}/logout`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });
  },

  me() {
    const token = localStorage.getItem('tcp_token');
    return fetch(`${API_BASE}/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
  },
};

// ── Session helpers ───────────────────────────────────────────────────────────
const AuthUser = {
  getToken() {
    return localStorage.getItem('tcp_token');
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem('tcp_user'));
    } catch {
      return null;
    }
  },

  clear() {
    localStorage.removeItem('tcp_token');
    localStorage.removeItem('tcp_user');
  },

  isLoggedIn() {
    const token = this.getToken();
    if (!token) return false;
    // Decode payload (no signature verify — server does that)
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      // Check expiry
      return payload.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  },
};

// ── Auth Guard ────────────────────────────────────────────────────────────────
/**
 * Call this at the top of any protected page.
 * If the user is not authenticated, redirects to login.html immediately.
 * Returns the user object if authenticated.
 */
function AuthGuard() {
  if (!AuthUser.isLoggedIn()) {
    AuthUser.clear();
    window.location.replace('login.html');
    return null;
  }
  return AuthUser.getUser();
}

// ── Logout helper ─────────────────────────────────────────────────────────────
async function doLogout() {
  try { await AuthAPI.logout(); } catch { /* ignore network errors on logout */ }
  AuthUser.clear();
  window.location.replace('login.html');
}
