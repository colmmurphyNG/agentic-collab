/**
 * <files-panel> Web Component.
 * Agent profile / index page — summary, published pages, data stores, workspace info.
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, formatFileSize } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';

export class FilesPanel extends HTMLElement {
  _agent = null;
  // Local per-panel toggle: when true, the Pages section shows archived
  // pages (fetched on demand from the server) instead of active ones.
  // State is local to the panel instance — switching agents resets it.
  _showArchived = false;
  _archivedPages = null;

  async load(agentName) {
    this._agent = agentName;
    if (this._renderedAgent !== agentName) {
      // New agent — reset the archived toggle/cache.
      this._showArchived = false;
      this._archivedPages = null;
      this._renderedAgent = agentName;
    }
    const agent = state.agents.find(a => a.name === agentName);
    if (!agent) {
      this.innerHTML = '<div class="files-empty">Agent not found</div>';
      return;
    }

    // Decide which pages list to render. Active comes from the cached
    // state.pages snapshot (kept fresh by WebSocket); archived is fetched
    // lazily the first time the operator flips the toggle.
    let agentPages;
    if (this._showArchived) {
      if (this._archivedPages === null) {
        try {
          const res = await fetch('/api/pages?archived=true', { headers: authHeaders() });
          this._archivedPages = res.ok ? await res.json() : [];
        } catch { this._archivedPages = []; }
      }
      agentPages = (this._archivedPages || []).filter(p => p.agent === agentName);
    } else {
      agentPages = (state.pages || []).filter(p => p.agent === agentName && !p.archived);
    }
    const agentStores = (state.stores || []).filter(s => s.agent === agentName);
    const indicators = state.indicators[agentName] || [];
    let html = '<div class="agent-profile">';

    // ── Header ──
    html += '<div class="profile-section">';
    html += `<div class="profile-name">${agent.icon ? esc(agent.icon) + ' ' : ''}${esc(agent.name)}</div>`;
    html += `<div class="profile-meta">`;
    html += `<span class="state-badge state-${agent.state}">${agent.state}</span>`;
    html += ` <span class="profile-dim">${esc(agent.engine || '')}</span>`;
    if (agent.cwd) html += ` <span class="profile-dim">· ${esc(agent.cwd)}</span>`;
    html += '</div>';
    if (indicators.length > 0) {
      html += '<div class="profile-indicators">';
      for (const ind of indicators) {
        html += `<span class="indicator-badge ${ind.style || 'info'}">${esc(ind.badge)}</span>`;
      }
      html += '</div>';
    }
    html += '</div>';

    // ── Published Pages ──
    // The section always renders if either active or archived view has rows,
    // and always renders the toggle so the operator can switch even when
    // their current view is empty (e.g. all archived, none active).
    {
      html += '<div class="profile-section">';
      const toggleLabel = this._showArchived ? 'View active' : 'View archived';
      html += `<div class="profile-section-header">`;
      html += `<div class="profile-section-title">${this._showArchived ? 'Archived Pages' : 'Published Pages'}</div>`;
      html += `<button class="page-toggle" data-action="toggle-archived">${toggleLabel}</button>`;
      html += `</div>`;
      if (agentPages.length === 0) {
        html += `<div class="profile-dim" style="padding:8px 0">${this._showArchived ? 'No archived pages for this agent.' : 'No published pages yet.'}</div>`;
      } else {
        for (const page of agentPages) {
          const isArch = this._showArchived;
          html += `<div class="profile-card" data-page-slug="${esc(page.slug)}">`;
          html += `<a class="profile-card-link" href="/pages/${esc(page.slug)}" target="_blank">`;
          html += `<span class="profile-card-title">${icon.globe(14)} ${esc(page.slug)}</span>`;
          html += `<span class="profile-card-meta">${page.fileCount} files · ${formatFileSize(page.totalBytes)}</span>`;
          html += `</a>`;
          html += `<button class="page-archive-btn" data-action="${isArch ? 'unarchive' : 'archive'}" data-slug="${esc(page.slug)}" title="${isArch ? 'Unarchive page' : 'Archive page'}">${isArch ? 'Unarchive' : 'Archive'}</button>`;
          html += `</div>`;
        }
      }
      html += '</div>';
    }

    // ── Data Stores ──
    if (agentStores.length > 0) {
      html += '<div class="profile-section">';
      html += '<div class="profile-section-title">Data Stores</div>';
      for (const store of agentStores) {
        html += '<div class="profile-card">';
        html += `<span class="profile-card-title">${icon.file(14)} ${esc(store.name)}</span>`;
        html += `<span class="profile-card-meta">updated ${esc(store.updatedAt ? new Date(store.updatedAt).toLocaleDateString() : '')}</span>`;
        html += '</div>';
      }
      html += '</div>';
    }

    // ── Workspace ──
    if (agent.cwd) {
      html += '<div class="profile-section">';
      html += '<div class="profile-section-title">Workspace</div>';
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/files`, { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          const files = (data.files || []).slice(0, 10);
          if (files.length > 0) {
            html += '<div class="profile-card">';
            html += `<span class="profile-card-meta">${esc(data.cwd)}</span>`;
            for (const f of files) {
              const sizeStr = f.isDir ? '' : ' · ' + formatFileSize(f.size);
              html += `<div class="profile-file">${f.isDir ? '📁' : '📄'} ${esc(f.name)}${sizeStr}</div>`;
            }
            if (data.files.length > 10) html += `<div class="profile-dim">+ ${data.files.length - 10} more</div>`;
            html += '</div>';
          }
        }
      } catch { /* skip workspace listing on error */ }
      html += '</div>';
    }

    html += '</div>';
    this.innerHTML = html;

    // Wire archive/unarchive buttons and the view-toggle.
    this.querySelectorAll('[data-action="toggle-archived"]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._showArchived = !this._showArchived;
        this._archivedPages = null; // force re-fetch next render
        this.load(this._agent);
      });
    });
    this.querySelectorAll('[data-action="archive"], [data-action="unarchive"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const slug = btn.dataset.slug;
        const archived = btn.dataset.action === 'archive';
        btn.disabled = true;
        try {
          const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/archive`, {
            method: 'POST',
            headers: { ...authHeaders(), 'content-type': 'application/json' },
            body: JSON.stringify({ archived }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Invalidate caches and re-render. state.pages is kept fresh by the
          // WS pages_update broadcast the server sends.
          this._archivedPages = null;
          this.load(this._agent);
        } catch {
          btn.disabled = false;
        }
      });
    });
  }
}

customElements.define('files-panel', FilesPanel);
