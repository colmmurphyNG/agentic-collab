/**
 * <today-panel> Web Component.
 * A rolling manifest of the last day and a half of conversations, one row per agent and topic,
 * newest first. "Pick up" does not send anything: it dispatches 'today-pickup' so the page can
 * open that agent's thread on that topic in the existing composer.
 *
 * Usage:
 *   panel.render();   // fetches /api/manifest; also refreshed every minute and on new messages while open
 */

import { authHeaders } from '/dashboard/assets/state.ts';
import { showToast } from '/dashboard/assets/utils.ts';
import { renderTodayRow } from '/dashboard/assets/today-html.ts';

const REFRESH_MS = 60_000;

export class TodayPanel extends HTMLElement {
  _rows = [];
  _loaded = false;
  _timer = null;
  _fetching = false;
  _refetch = false;

  connectedCallback() {
    this.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'close') this.dispatchEvent(new CustomEvent('close-today', { bubbles: true }));
      else if (el.dataset.action === 'pickup') {
        const item = el.closest('.today-item');
        this.dispatchEvent(new CustomEvent('today-pickup', { bubbles: true, detail: { agent: item.dataset.agent, topic: item.dataset.topic } }));
      }
    });
  }

  disconnectedCallback() { this._stop(); }

  /** Draws what is loaded and fetches a fresh list; keeps refreshing while the panel is visible. */
  render() {
    this._draw();
    this._load();
    if (!this._timer) this._timer = setInterval(() => {
      if (this.style.display === 'none') this._stop(); else this._load();
    }, REFRESH_MS);
  }

  _stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _draw() {
    const header = `<div class="today-header">
      <h2>Today (${this._rows.length} threads, last 36h)</h2>
      <button class="today-close" data-action="close" title="Close">Close</button>
    </div>`;
    const body = this._rows.length
      ? this._rows.map((r) => renderTodayRow(r)).join('')
      : `<div class="today-empty">${this._loaded ? 'No conversations in the last 36 hours.' : 'Loading...'}</div>`;
    const list = this.querySelector('.today-list');
    // Keep the scroll position across a background refresh.
    const top = list ? list.scrollTop : 0;
    this.innerHTML = header + `<div class="today-list">${body}</div>`;
    const fresh = this.querySelector('.today-list');
    if (fresh) fresh.scrollTop = top;
  }

  async _load() {
    // A message arriving mid-fetch asks for one more pass instead of a parallel request.
    if (this._fetching) { this._refetch = true; return; }
    this._fetching = true;
    try {
      const res = await fetch('/api/manifest?hours=36', { headers: authHeaders() });
      if (res.ok) { this._rows = await res.json(); this._loaded = true; this._draw(); }
      else showToast(`Could not load Today: ${res.status}`);
    } catch (err) {
      showToast(`Could not load Today: ${err.message}`);
    } finally {
      this._fetching = false;
    }
    if (this._refetch) { this._refetch = false; this._load(); }
  }
}

customElements.define('today-panel', TodayPanel);
