/**
 * <decisions-panel> Web Component.
 * Every open decision from every agent in one list, blocking first then oldest, with one-click
 * "accept recommendation", pick-an-option, or a free-text reply. Answers go back to the agent
 * as an ordinary dashboard message (server side, POST /api/decisions/:id/answer).
 *
 * Usage:
 *   panel.render();   // from state.decisions; refreshed on 'init' and 'decision_update'
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, timeAgo, showToast } from '/dashboard/assets/utils.ts';

function optionButtons(d) {
  return d.options.map((o) => {
    const rec = o.key === d.recommended;
    return `<button class="decision-option${rec ? ' recommended' : ''}" data-action="choose" data-id="${d.id}" data-key="${esc(o.key)}">
      <span class="decision-key">(${esc(o.key)})</span> ${esc(o.label)}${rec ? ' <span class="decision-rec">recommended</span>' : ''}
    </button>`;
  }).join('');
}

export function renderDecisionCard(d) {
  const accept = d.recommended
    ? `<button class="decision-accept" data-action="choose" data-id="${d.id}" data-key="${esc(d.recommended)}">Accept recommendation (${esc(d.recommended)})</button>`
    : '';
  return `<div class="decision-item${d.blocking ? ' blocking' : ''}" data-decision="${d.id}">
    <div class="decision-meta">
      <span class="decision-agent">${esc(d.agentName)}</span>
      <span class="decision-topic">${esc(d.topic)}</span>
      ${d.blocking ? '<span class="decision-blocking">blocking</span>' : ''}
      <span class="decision-age">#${d.id} · ${esc(timeAgo(d.createdAt))}</span>
    </div>
    <div class="decision-question">${esc(d.question)}</div>
    ${accept}
    <div class="decision-options">${optionButtons(d)}</div>
    <div class="decision-reply">
      <input type="text" class="decision-text" data-id="${d.id}" placeholder="Or reply in your own words (sent with a chosen option, or on its own)">
      <button data-action="reply" data-id="${d.id}">Send</button>
    </div>
  </div>`;
}

export class DecisionsPanel extends HTMLElement {
  connectedCallback() {
    this.addEventListener('click', (e) => this._onClick(e));
    this.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key === 'Enter' && t.classList && t.classList.contains('decision-text')) this._answer(t.dataset.id, null);
    });
  }

  render() {
    const open = state.decisions || [];
    const header = `<div class="decisions-header">
      <h2>Decisions waiting on you (${open.length})</h2>
      <button class="decisions-close" data-action="close" title="Close">Close</button>
    </div>`;
    const body = open.length
      ? open.map(renderDecisionCard).join('')
      : '<div class="decision-empty">Nothing is waiting on you.</div>';
    this.innerHTML = header + `<div class="decisions-list">${body}</div>`;
  }

  _onClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id, key } = btn.dataset;
    if (action === 'close') this.dispatchEvent(new CustomEvent('close-decisions', { bubbles: true }));
    else if (action === 'choose') this._answer(id, key);
    else if (action === 'reply') this._answer(id, null);
  }

  async _answer(id, key) {
    const input = this.querySelector(`.decision-text[data-id="${id}"]`);
    const text = input ? input.value.trim() : '';
    if (!key && !text) { showToast('Pick an option or write a reply'); return; }
    const card = this.querySelector(`[data-decision="${id}"]`);
    if (card) card.classList.add('sending');
    try {
      const res = await fetch(`/api/decisions/${encodeURIComponent(id)}/answer`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: key || null, text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(`Could not answer #${id}: ${err.error || res.status}`);
        if (card) card.classList.remove('sending');
        return;
      }
      // The decision_update broadcast re-renders the list; remove locally so it feels immediate.
      state.decisions = (state.decisions || []).filter((d) => String(d.id) !== String(id));
      this.render();
    } catch (err) {
      showToast(`Could not answer #${id}: ${err.message}`);
      if (card) card.classList.remove('sending');
    }
  }
}

customElements.define('decisions-panel', DecisionsPanel);
