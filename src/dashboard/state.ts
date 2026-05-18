/**
 * Dashboard shared state and event bus.
 * Single source of truth for all dashboard components.
 * Import via: import { state, on, emit } from '/dashboard/assets/state.ts';
 */

// ── State ──

export const state = {
  agents: [],
  threads: {},
  selected: null,
  connected: false,
  unread: {},
  threadView: 'messages',
  watchTimer: null,
  personaCache: {},
  searchFilter: '',
  quickFilter: null,
  engineUsage: {},
  proxies: [],
  accounts: [],
  engineConfigs: [],
  emptyGroups: [],
  drafts: {},
  topicPerAgent: {},
  // Counterparty filter for the Messages tab per agent.
  // Values: 'all' (default), 'operator', 'team', or a specific agent name.
  // Lets the operator separate "tl ↔ me" from "tl ↔ specialists" in tl's thread.
  counterpartyPerAgent: {},
  editingPersona: false,
  indicators: {},
  pages: [],
  stores: [],
  destinations: [],
  // Internal tracking for progressive message loading
  _threadRenderedFrom: 0,
  _renderedAgent: null,
};

// ── Event Bus ──
// Lightweight pub/sub for cross-component communication.
// Events are strings; listeners receive an optional detail object.
//
// Standard events:
//   'agents-changed'      — agent list structurally changed (add/remove)
//   'agent-updated'       — single agent data changed { name }
//   'agent-selected'      — selected agent changed { name }
//   'message-added'       — new message appended { agent, message }
//   'message-withdrawn'   — message withdrawn { agent, id }
//   'thread-changed'      — thread needs re-render (tab switch)
//   'connection-changed'  — WebSocket connected/disconnected
//   'unread-changed'      — unread counts changed { agent }
//   'indicators-changed'  — agent indicators changed { agent }
//   'proxies-changed'     — proxy list changed
//   'filter-changed'      — search or quick filter changed

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, detail) {
  const fns = listeners.get(event);
  if (!fns) return;
  for (const fn of fns) {
    try { fn(detail); } catch (e) { console.error(`[state] Event "${event}" listener error:`, e); }
  }
}

// ── Token Management ──

export function getToken() {
  return localStorage.getItem('orchestrator_token') || '';
}

export function setToken(token) {
  if (token) {
    localStorage.setItem('orchestrator_token', token);
    syncTokenCookie(token);
  } else {
    localStorage.removeItem('orchestrator_token');
    clearTokenCookie();
  }
}

/**
 * Mirror the bearer token into a `conductor_token` cookie. Browser-direct
 * navigation to GET routes (e.g. `<a href="/scratch">`) can't add an
 * Authorization header — the cookie is the fallback path the orchestrator's
 * authorize() helper checks when the header is absent. SameSite=Strict
 * prevents cross-site CSRF; the cookie is scoped to / so it covers /pages,
 * /scratch, /docs, etc.
 */
function syncTokenCookie(token) {
  document.cookie = `conductor_token=${encodeURIComponent(token)}; path=/; SameSite=Strict`;
}

function clearTokenCookie() {
  document.cookie = 'conductor_token=; path=/; SameSite=Strict; max-age=0';
}

// Sync the cookie on module load — covers dashboard sessions that set the
// token before this code (cookie-sync logic) existed.
const _initialToken = getToken();
if (_initialToken) syncTokenCookie(_initialToken);

export function authHeaders() {
  const t = getToken();
  return t ? { 'authorization': `Bearer ${t}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
}
