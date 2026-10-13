/**
 * <todo-panel> Web Component.
 * Actions for the operator that came out of a decision: an option carrying steps opened one when
 * it was chosen. Newest first, each with its steps; Done tells the raising agent it happened,
 * "Show done" brings done ones back with a Reopen button. Nothing here is answered.
 *
 * Usage:
 *   panel.render();       // open items from state.todos; refreshed on 'init' and 'todos_change'
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, timeAgo, showToast } from '/dashboard/assets/utils.ts';

export function renderTodoItem(t) {
  const done = t.status === 'done';
  const when = done ? `done ${timeAgo(t.doneAt)}` : timeAgo(t.createdAt);
  return `<div class="todo-item${done ? ' done' : ''}" data-todo="${t.id}">
    <div class="todo-meta">
      <span class="todo-agent">${esc(t.agentName)}</span>
      ${t.decisionId ? `<span title="the decision whose answer opened this">from decision #${t.decisionId}</span>` : ''}
      ${t.topic ? `<span>${esc(t.topic)}</span>` : ''}
      <span class="todo-age">#${t.id} · ${esc(when)}</span>
    </div>
    <div class="todo-main">
      <span class="todo-title">${esc(t.title)}</span>
      <button class="todo-action" data-action="${done ? 'reopen' : 'done'}" data-id="${t.id}">${done ? 'Reopen' : 'Done'}</button>
    </div>
    ${t.steps ? `<div class="todo-steps">${esc(t.steps)}</div>` : ''}
  </div>`;
}

export class TodoPanel extends HTMLElement {
  _showDone = false;
  _done = [];
  _loadingDone = false;

  connectedCallback() {
    this.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'close') {
        this.dispatchEvent(new CustomEvent('close-todos', { bubbles: true }));
      } else {
        this._transition(el.dataset.id, el.dataset.action);
      }
    });
    this.addEventListener('change', (e) => {
      if (e.target.classList && e.target.classList.contains('todos-show-done')) {
        this._showDone = e.target.checked;
        this.render();
      }
    });
  }

  render() {
    this._renderList();
    if (this._showDone) this._loadDone();
  }

  _renderList() {
    const open = state.todos || [];
    const header = `<div class="todos-header">
      <h2>To-do (${open.length} open)</h2>
      <label class="todos-toggle"><input type="checkbox" class="todos-show-done"${this._showDone ? ' checked' : ''}> Show done</label>
      <button class="todos-close" data-action="close" title="Close">Close</button>
    </div>`;
    let body = open.length
      ? open.map(renderTodoItem).join('')
      : '<div class="todo-empty">Nothing waiting on you.</div>';
    if (this._showDone) {
      body += '<h3 class="todos-done-heading">Done</h3>';
      body += this._done.length
        ? this._done.map(renderTodoItem).join('')
        : `<div class="todo-empty">${this._loadingDone ? 'Loading...' : 'Nothing marked done yet.'}</div>`;
    }
    this.innerHTML = header + `<div class="todos-list">${body}</div>`;
  }

  async _loadDone() {
    if (this._loadingDone) return;
    this._loadingDone = true;
    try {
      const res = await fetch('/api/todos?status=done', { headers: authHeaders() });
      if (res.ok) this._done = await res.json();
      else showToast(`Could not load done to-dos: ${res.status}`);
    } catch (err) {
      showToast(`Could not load done to-dos: ${err.message}`);
    } finally {
      this._loadingDone = false;
    }
    if (this._showDone) this._renderList();
  }

  async _transition(id, action) {
    const item = this.querySelector(`[data-todo="${id}"]`);
    if (item) item.classList.add('sending');
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: authHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(`Could not ${action === 'done' ? 'mark' : 'reopen'} to-do #${id}: ${err.error || res.status}`);
        if (item) item.classList.remove('sending');
        return;
      }
      // The todos_change broadcast re-renders; move it locally so it feels immediate.
      if (action === 'done') {
        const updated = await res.json();
        state.todos = (state.todos || []).filter((t) => String(t.id) !== String(id));
        this._done = [updated, ...this._done.filter((t) => String(t.id) !== String(id))];
      } else {
        const updated = await res.json();
        this._done = this._done.filter((t) => String(t.id) !== String(id));
        state.todos = [updated, ...(state.todos || []).filter((t) => String(t.id) !== String(id))];
      }
      this._renderList();
    } catch (err) {
      showToast(`Could not ${action === 'done' ? 'mark' : 'reopen'} to-do #${id}: ${err.message}`);
      if (item) item.classList.remove('sending');
    }
  }
}

customElements.define('todo-panel', TodoPanel);