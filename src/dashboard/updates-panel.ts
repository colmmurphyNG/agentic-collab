/**
 * <updates-panel> Web Component.
 * Finished work agents have handed over (a page, a PR, a report), newest first, each a link that
 * opens in a new tab. Opening the panel or an item marks it seen; Done takes it off the list and
 * "Show done" brings done ones back with a Reopen button. Nothing here is answered.
 *
 * Usage:
 *   panel.render();       // open items from state.updates; refreshed on 'init' and 'updates_change'
 *   panel.markAllSeen();  // called when the panel is opened
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, timeAgo, showToast } from '/dashboard/assets/utils.ts';
import { updateTitleHtml } from '/dashboard/assets/update-html.ts';

export function renderUpdateItem(u) {
  const done = u.status === 'done';
  const when = done ? `done ${timeAgo(u.doneAt)}` : timeAgo(u.createdAt);
  const unseen = !done && !u.seenAt;
  return `<div class="update-item${unseen ? ' unseen' : ''}${done ? ' done' : ''}" data-update="${u.id}">
    <div class="update-meta">
      ${unseen ? '<span class="update-new">new</span>' : ''}
      <span class="update-agent">${esc(u.agentName)}</span>
      ${u.topic ? `<span class="update-topic">${esc(u.topic)}</span>` : ''}
      <span class="update-age">#${u.id} · ${esc(when)}</span>
    </div>
    <div class="update-main">
      ${updateTitleHtml(u)}
      <button class="update-action" data-action="${done ? 'reopen' : 'done'}" data-id="${u.id}">${done ? 'Reopen' : 'Done'}</button>
    </div>
    ${u.summary ? `<div class="update-summary">${esc(u.summary)}</div>` : ''}
  </div>`;
}

export class UpdatesPanel extends HTMLElement {
  _showDone = false;
  _done = [];
  _loadingDone = false;

  connectedCallback() {
    this.addEventListener('click', (e) => this._onClick(e));
    // A middle-click opens the link too, without a click event.
    this.addEventListener('auxclick', (e) => {
      const a = e.target.closest('a[data-action="open"]');
      if (a) this._markSeen([a.dataset.id]);
    });
    this.addEventListener('change', (e) => {
      if (e.target.classList && e.target.classList.contains('updates-show-done')) {
        this._showDone = e.target.checked;
        this.render();
      }
    });
  }

  render() {
    this._renderList();
    if (this._showDone) this._loadDone();
  }

  /** Marks every open, unseen item seen. The server broadcasts the new count. */
  markAllSeen() {
    const ids = (state.updates || []).filter((u) => !u.seenAt).map((u) => String(u.id));
    if (ids.length) this._markSeen(ids);
  }

  _renderList() {
    const open = state.updates || [];
    const header = `<div class="updates-header">
      <h2>Updates (${open.length} open)</h2>
      <label class="updates-toggle"><input type="checkbox" class="updates-show-done"${this._showDone ? ' checked' : ''}> Show done</label>
      <button class="updates-close" data-action="close" title="Close">Close</button>
    </div>`;
    let body = open.length
      ? open.map(renderUpdateItem).join('')
      : '<div class="update-empty">No open updates.</div>';
    if (this._showDone) {
      body += '<h3 class="updates-done-heading">Done</h3>';
      body += this._done.length
        ? this._done.map(renderUpdateItem).join('')
        : `<div class="update-empty">${this._loadingDone ? 'Loading...' : 'Nothing marked done yet.'}</div>`;
    }
    this.innerHTML = header + `<div class="updates-list">${body}</div>`;
  }

  async _loadDone() {
    if (this._loadingDone) return;
    this._loadingDone = true;
    try {
      const res = await fetch('/api/updates?status=done', { headers: authHeaders() });
      if (res.ok) this._done = await res.json();
      else showToast(`Could not load done updates: ${res.status}`);
    } catch (err) {
      showToast(`Could not load done updates: ${err.message}`);
    } finally {
      this._loadingDone = false;
    }
    if (this._showDone) this._renderList();
  }

  _onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    // The link opens itself in a new tab; all that is left to do is record that it was seen.
    if (action === 'open') this._markSeen([id]);
    else if (action === 'close') this.dispatchEvent(new CustomEvent('close-updates', { bubbles: true }));
    else if (action === 'done' || action === 'reopen') this._transition(id, action);
  }

  async _markSeen(ids) {
    const unseen = ids.filter((id) => (state.updates || []).some((u) => String(u.id) === String(id) && !u.seenAt));
    if (!unseen.length) return;
    // Show it as seen straight away; the updates_change broadcast confirms the count.
    const now = new Date().toISOString();
    for (const u of state.updates || []) if (unseen.includes(String(u.id))) u.seenAt = now;
    state.unseenUpdates = Math.max(0, (state.unseenUpdates || 0) - unseen.length);
    this._renderList();
    const count = document.getElementById('updatesCount');
    if (count) { count.textContent = state.unseenUpdates ? String(state.unseenUpdates) : ''; count.style.display = state.unseenUpdates ? '' : 'none'; }
    await Promise.all(unseen.map((id) => fetch(`/api/updates/${encodeURIComponent(id)}/seen`, {
      method: 'POST', headers: authHeaders(),
    }).catch(() => {})));
  }

  async _transition(id, action) {
    const item = this.querySelector(`[data-update="${id}"]`);
    if (item) item.classList.add('sending');
    try {
      const res = await fetch(`/api/updates/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: authHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(`Could not ${action === 'done' ? 'mark' : 'reopen'} #${id}: ${err.error || res.status}`);
        if (item) item.classList.remove('sending');
        return;
      }
      const updated = await res.json();
      // The updates_change broadcast re-renders too; move it locally so it feels immediate.
      if (action === 'done') {
        state.updates = (state.updates || []).filter((u) => String(u.id) !== String(id));
        this._done = [updated, ...this._done.filter((u) => String(u.id) !== String(id))];
      } else {
        this._done = this._done.filter((u) => String(u.id) !== String(id));
        state.updates = [updated, ...(state.updates || []).filter((u) => String(u.id) !== String(id))].sort((a, b) => b.id - a.id);
      }
      this._renderList();
    } catch (err) {
      showToast(`Could not ${action === 'done' ? 'mark' : 'reopen'} #${id}: ${err.message}`);
      if (item) item.classList.remove('sending');
    }
  }
}

customElements.define('updates-panel', UpdatesPanel);
