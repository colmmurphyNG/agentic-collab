/**
 * <jobs-panel> Web Component (JJ-2).
 * CRUD for recurring cron-scheduled jobs that fire prompts at agents.
 *
 * Distinct from <reminder-panel>:
 *   - Jobs have a cron expression, not a fixed-minute cadence
 *   - Jobs are paused/resumed/deleted, never "completed"
 *   - No queue ordering (one cron per job — no front-of-queue logic)
 *
 * Usage:
 *   const panel = document.querySelector('jobs-panel');
 *   panel.load(agentName);  // fetch and render jobs for that agent
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';


function formatNextFire(iso) {
  if (!iso) return 'unscheduled';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffH = Math.round(diffMs / 3600000);
  const stamp = d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  if (diffMs < 0) return `${stamp} (overdue)`;
  if (diffH < 1) return `${stamp} (<1h)`;
  if (diffH < 24) return `${stamp} (in ${diffH}h)`;
  const diffD = Math.round(diffH / 24);
  return `${stamp} (in ${diffD}d)`;
}


function formatLastFired(iso) {
  if (!iso) return 'never fired';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `last: ${d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}


function renderJobCard(j) {
  const classes = ['reminder-item'];  // reuse reminder-panel.css classes
  if (j.status === 'paused') classes.push('completed');

  const cronChip = `<span style="font-family:var(--mono,monospace);font-size:11px;color:var(--text-dim);background:var(--bg-elev,#161b22);padding:1px 6px;border-radius:3px">${esc(j.cronExpr)}</span>`;
  const createdByHtml = j.createdBy
    ? `<span>by ${esc(j.createdBy)}</span>`
    : '';

  let actionBtns = '';
  if (j.status === 'active') {
    actionBtns += `<button data-action="pause" data-id="${j.id}" title="Pause">${icon.x ? icon.x(14) : '⏸'}</button>`;
  } else {
    actionBtns += `<button class="complete" data-action="resume" data-id="${j.id}" title="Resume">${icon.play ? icon.play(14) : '▶'}</button>`;
  }
  actionBtns += `<button data-action="edit" data-id="${j.id}" data-prompt="${esc(j.prompt)}" data-cron="${esc(j.cronExpr)}" title="Edit">${icon.edit ? icon.edit(14) : '✎'}</button>`;
  actionBtns += `<button class="danger" data-action="delete" data-id="${j.id}" title="Delete">${icon.trash ? icon.trash(14) : (icon.x ? icon.x(14) : '×')}</button>`;

  return `<div class="${classes.join(' ')}">
    <div class="reminder-content">
      <div class="reminder-prompt">${esc(j.prompt)}</div>
      <div class="reminder-meta">
        ${cronChip}
        ${j.skipIfActive ? '<span style="font-size:11px;color:var(--yellow,#d29922);font-weight:600">skip if active</span>' : '<span style="font-size:11px;color:var(--orange,#fb8500);font-weight:600">fire even if active</span>'}
        <span class="reminder-badge ${j.status === 'active' ? 'active' : 'completed'}">${j.status}</span>
        <span>next: ${esc(formatNextFire(j.nextFireAt))}</span>
        <span>${esc(formatLastFired(j.lastFiredAt))}</span>
        ${createdByHtml}
      </div>
    </div>
    <div class="reminder-actions">${actionBtns}</div>
  </div>`;
}


export class JobsPanel extends HTMLElement {
  _agent = null;

  /** Fetch and render jobs for the given agent. */
  async load(agentName) {
    this._agent = agentName;
    if (!agentName) return;
    this.innerHTML = '<div class="reminder-empty">Loading...</div>';
    try {
      const res = await fetch(`/api/jobs?agent=${encodeURIComponent(agentName)}`, {
        headers: authHeaders(),
      });
      if (this._agent !== agentName) return;
      if (!res.ok) {
        this.innerHTML = '<div class="reminder-empty">Failed to load jobs</div>';
        return;
      }
      const jobs = await res.json();
      const active = jobs.filter(j => j.status === 'active');
      const paused = jobs.filter(j => j.status === 'paused');

      let html = `<div class="reminder-add-form">
        <textarea id="jobPrompt" placeholder="Job prompt..." rows="2"></textarea>
        <div class="reminder-form-row">
          <input type="text" id="jobCron" placeholder="cron, e.g. 0 */5 * * *" value="0 */5 * * *" style="flex:1;font-family:var(--mono,monospace);font-size:12px" />
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-dim);cursor:pointer;margin-left:4px"><input type="checkbox" id="jobSkipIfActive" checked /> Skip if active</label>
          <button id="jobAddBtn">Add</button>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.4">
          Cron: <code>minute hour day-of-month month day-of-week</code> — supports literals, <code>*</code>, <code>*/N</code>. Common patterns:
          <code>0 */5 * * *</code> = every 5h on the hour;
          <code>0 9 * * *</code> = daily 9am UTC;
          <code>0 17 * * 5</code> = Fridays 5pm UTC.
        </div>
      </div>`;

      if (active.length === 0 && paused.length === 0) {
        html += '<div class="reminder-empty">No jobs for this agent. Add one above to schedule recurring prompts.</div>';
      } else {
        if (active.length > 0) {
          for (const j of active) {
            html += renderJobCard(j);
          }
        }
        if (paused.length > 0) {
          html += '<div class="reminder-section-label">Paused</div>';
          for (const j of paused) {
            html += renderJobCard(j);
          }
        }
      }

      this.innerHTML = html;
      this._bindAddHandler(agentName);
      this._bindActionHandlers(agentName);
    } catch (err) {
      console.error('Jobs load failed:', err);
      this.innerHTML = '<div class="reminder-empty">Failed to load jobs</div>';
    }
  }

  _bindAddHandler(agentName) {
    const addBtn = this.querySelector('#jobAddBtn');
    if (!addBtn) return;
    addBtn.onclick = async () => {
      const prompt = this.querySelector('#jobPrompt').value.trim();
      const cronExpr = this.querySelector('#jobCron').value.trim();
      const skipIfActive = this.querySelector('#jobSkipIfActive').checked;
      if (!prompt || !cronExpr) return;
      try {
        const res = await fetch('/api/jobs', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            agentName,
            prompt,
            cronExpr,
            skipIfActive,
            createdBy: 'dashboard',
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          alert(`Failed to create job: ${err.error}`);
          return;
        }
        this.load(agentName);
      } catch (err) {
        console.error('Add job failed:', err);
      }
    };
  }

  _bindActionHandlers(agentName) {
    this.querySelectorAll('.reminder-actions button[data-action]').forEach(btn => {
      btn.onclick = async () => {
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        try {
          if (action === 'pause') {
            await fetch(`/api/jobs/${id}`, {
              method: 'PATCH', headers: authHeaders(),
              body: JSON.stringify({ status: 'paused' }),
            });
          } else if (action === 'resume') {
            await fetch(`/api/jobs/${id}`, {
              method: 'PATCH', headers: authHeaders(),
              body: JSON.stringify({ status: 'active' }),
            });
          } else if (action === 'delete') {
            if (!confirm('Delete this job?')) return;
            await fetch(`/api/jobs/${id}`, {
              method: 'DELETE', headers: authHeaders(),
            });
          } else if (action === 'edit') {
            this._openEditModal(id, btn, agentName);
            return;
          }
          this.load(agentName);
        } catch (err) {
          console.error('Job action failed:', err);
        }
      };
    });
  }

  _openEditModal(id, btn, agentName) {
    const oldPrompt = btn.dataset.prompt;
    const oldCron = btn.dataset.cron;

    const overlay = document.createElement('div');
    overlay.className = 'reminder-edit-overlay';
    overlay.innerHTML = `
      <div class="reminder-edit-modal">
        <textarea id="editJobPrompt">${esc(oldPrompt)}</textarea>
        <div class="edit-row">
          <input type="text" id="editJobCron" value="${esc(oldCron)}" style="font-family:var(--mono,monospace);width:100%" />
        </div>
        <div class="edit-row" style="font-size:11px;color:var(--text-dim)">
          5-field cron — literals, <code>*</code>, <code>*/N</code>. e.g. <code>0 */5 * * *</code>.
        </div>
        <div class="actions">
          <button class="cancel" id="editJobCancel">Cancel</button>
          <button class="save" id="editJobSave">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#editJobCancel').onclick = () => overlay.remove();
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#editJobSave').onclick = async () => {
      const newPrompt = overlay.querySelector('#editJobPrompt').value.trim();
      const newCron = overlay.querySelector('#editJobCron').value.trim();
      if (!newPrompt || !newCron) return;
      const patch = {};
      if (newPrompt !== oldPrompt) patch.prompt = newPrompt;
      if (newCron !== oldCron) patch.cronExpr = newCron;
      if (Object.keys(patch).length === 0) {
        overlay.remove();
        return;
      }
      const res = await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        alert(`Failed to update: ${err.error}`);
        return;
      }
      overlay.remove();
      this.load(agentName);
    };

    setTimeout(() => overlay.querySelector('#editJobPrompt').focus(), 50);
  }
}

customElements.define('jobs-panel', JobsPanel);
