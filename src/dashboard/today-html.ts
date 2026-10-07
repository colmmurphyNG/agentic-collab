/**
 * Rendering for the Today panel: one row per (agent, topic) thread. No DOM or dashboard imports,
 * so the escaping and the link labels are unit-testable under node.
 */

import { escAttr, isSafeLink } from './update-html.ts';

/** "2h ago" style age; takes `now` so it is testable. */
export function agoLabel(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const mins = Math.floor(Math.max(0, now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

/** Short chip text: "PR #12 repo" for a GitHub pull request, otherwise host and path or the page path. */
export function linkLabel(link) {
  const pr = /^https?:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/i.exec(link);
  if (pr) return `PR #${pr[2]} ${pr[1]}`;
  if (link.startsWith('/pages/')) return link;
  const text = link.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

export function renderTodayRow(row, now = Date.now()) {
  const chips = (row.links || []).filter(isSafeLink).map((l) =>
    `<a class="today-chip" href="${escAttr(l)}" target="_blank" rel="noopener noreferrer" title="${escAttr(l)}">${escAttr(linkLabel(l))}</a>`).join('');
  const who = row.lastDirection === 'to_agent' ? 'you' : escAttr(row.agent);
  return `<div class="today-item" data-agent="${escAttr(row.agent)}" data-topic="${escAttr(row.topic)}">
    <div class="today-meta">
      <span class="today-agent">${escAttr(row.agent)}</span>
      <span class="today-topic">${escAttr(row.topic)}</span>
      <span class="today-age">${escAttr(agoLabel(row.lastMessageAt, now))} · ${Number(row.messageCount) || 0} msg · last: ${who}</span>
    </div>
    <div class="today-main">
      <div class="today-preview">${escAttr(row.preview)}</div>
      <button class="today-pickup" data-action="pickup" title="Open this thread with the composer set to this topic">Pick up</button>
    </div>
    ${chips ? `<div class="today-links">${chips}</div>` : ''}
  </div>`;
}
