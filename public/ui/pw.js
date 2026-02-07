// Proofwork UI helpers (no framework).
// Keep this file dependency-free; it is shared by all static portals and apps pages.

export function qs(sel, root = document) {
  return root.querySelector(sel);
}

export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v); // avoid unless you fully control content.
    else if (k.startsWith('data-')) node.setAttribute(k, String(v));
    else if (k === 'aria-current') node.setAttribute('aria-current', String(v));
    else if (k === 'aria-pressed') node.setAttribute('aria-pressed', String(v));
    else if (k === 'href') node.setAttribute('href', String(v));
    else if (k === 'type') node.setAttribute('type', String(v));
    else if (k === 'value') node.value = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children || []) {
    if (c === undefined || c === null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function storageGet(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

export const LS = {
  buyerToken: 'pw_buyer_token',
  workerToken: 'pw_worker_token',
  adminToken: 'pw_admin_token',
  csrfToken: 'pw_csrf_token',
  devMode: 'pw_dev_mode',
};

export function getDevMode() {
  return storageGet(LS.devMode, '0') === '1';
}

export function setDevMode(on) {
  storageSet(LS.devMode, on ? '1' : '0');
  document.body.classList.toggle('pw-dev-on', Boolean(on));
}

export function initDevMode() {
  setDevMode(getDevMode());
}

let toastWrap;

export function ensureToasts() {
  if (toastWrap) return toastWrap;
  toastWrap = document.createElement('div');
  toastWrap.className = 'pw-toast-wrap';
  toastWrap.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastWrap);
  return toastWrap;
}

export function toast(message, kind = '') {
  const wrap = ensureToasts();
  const t = document.createElement('div');
  t.className = `pw-toast ${kind}`.trim();
  t.textContent = String(message || '');
  wrap.appendChild(t);
  setTimeout(() => {
    t.remove();
  }, 4200);
}

export async function copyToClipboard(text) {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    toast('Copied', 'good');
    return true;
  } catch {
    // Fallback: temporary textarea + execCommand.
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.className = 'pw-offscreen';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copied', 'good');
      return true;
    } catch {
      toast('Copy failed', 'bad');
      return false;
    }
  }
}

export function formatCents(cents) {
  const n = Number(cents ?? 0);
  if (!Number.isFinite(n)) return '$0.00';
  const dollars = (n / 100).toFixed(2);
  return `$${dollars}`;
}

export function formatBps(bps) {
  const n = Number(bps ?? 0);
  if (!Number.isFinite(n)) return '0%';
  return `${(n / 100).toFixed(2)}%`;
}

export function formatAgo(tsMs) {
  const ts = Number(tsMs ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const delta = Date.now() - ts;
  const s = Math.floor(delta / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export async function fetchJson(url, { method = 'GET', headers = {}, body, credentials = 'include' } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

export function authHeader(token) {
  const t = String(token ?? '').trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function startPolling(fn, { intervalMs = 2500, immediate = true } = {}) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      await fn();
    } finally {
      if (!stopped) setTimeout(tick, intervalMs);
    }
  }
  if (immediate) tick();
  return () => {
    stopped = true;
  };
}

// Hash-based view router for static portals.
// Turns "one long page" into low-effort sections without introducing a framework.
//
// Usage:
// 1) Mark top-level sections with `data-view` and an `id`.
// 2) Ensure side-nav links use `href="#<id>"`.
// 3) Call `initHashViews({ defaultViewId: "..." })` from the page's JS.
export function initHashViews({
  navSelector = '.pw-sidenav a[href^="#"]',
  viewSelector = '[data-view]',
  defaultViewId = '',
  onChange = null,
} = {}) {
  const views = new Map();
  for (const node of qsa(viewSelector)) {
    const id = String(node.id || '').trim();
    if (id) views.set(id, node);
  }
  if (!views.size) return null;

  const links = qsa(navSelector);

  function normalizeId(v) {
    const raw = String(v || '').trim();
    const id = raw.startsWith('#') ? raw.slice(1) : raw;
    if (id && views.has(id)) return id;
    if (defaultViewId && views.has(defaultViewId)) return defaultViewId;
    return Array.from(views.keys())[0];
  }

  function setView(id, { push = false } = {}) {
    const next = normalizeId(id);
    for (const [vid, el] of views.entries()) el.hidden = vid !== next;

    for (const a of links) {
      const href = String(a.getAttribute('href') || '').trim();
      if (!href.startsWith('#')) continue;
      const hid = href.slice(1);
      if (hid === next) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }

    if (push) {
      try {
        window.location.hash = `#${next}`;
      } catch {
        // ignore
      }
    }

    if (typeof onChange === 'function') {
      try {
        onChange(next);
      } catch {
        // ignore
      }
    }

    return next;
  }

  function applyFromHash() {
    return setView(window.location.hash || '', { push: false });
  }

  for (const a of links) {
    a.addEventListener('click', (ev) => {
      const href = String(a.getAttribute('href') || '').trim();
      if (!href.startsWith('#')) return;
      ev.preventDefault();
      setView(href, { push: true });
    });
  }

  window.addEventListener('hashchange', applyFromHash);

  // Useful for actionbars and scripted flows.
  try {
    window.pwSetView = (id) => setView(String(id || ''), { push: true });
  } catch {
    // ignore
  }

  applyFromHash();
  return { setView, views };
}
