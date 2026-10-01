/**
 * The parts of an Updates panel item that carry agent-supplied text into HTML: the title and the
 * link it points to. No DOM or dashboard imports, so the escaping is unit-testable under node.
 */

/** Escapes for text and for a quoted attribute alike; esc() in utils leaves quotes alone. */
export function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The server only stores these forms; checked again here so a bad row renders as text, never as a link. */
export function isSafeLink(link) {
  return typeof link === 'string' && (/^https?:\/\//i.test(link) || link.startsWith('/pages/'));
}

export function updateTitleHtml(u) {
  return isSafeLink(u.link)
    ? `<a class="update-title" href="${escAttr(u.link)}" target="_blank" rel="noopener noreferrer" data-action="open" data-id="${escAttr(u.id)}">${escAttr(u.title)}</a>`
    : `<span class="update-title">${escAttr(u.title)}</span>`;
}
