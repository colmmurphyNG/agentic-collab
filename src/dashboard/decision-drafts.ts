/**
 * Keeps typed replies in the Decisions panel alive across re-renders. The panel rebuilds its list
 * every time any agent raises or answers a decision, which otherwise wipes whatever is being typed.
 * No DOM or dashboard imports, so the logic is unit-testable under node.
 */

/** What to remember about the focused reply box before a render. */
export function captureFocus(active, isReplyBox) {
  if (!active || !isReplyBox(active)) return null;
  return { id: active.dataset.id, start: active.selectionStart, end: active.selectionEnd };
}

/**
 * Put drafts back into freshly rendered reply boxes, drop drafts for decisions no longer open,
 * and restore focus and caret to the box that had them.
 */
export function restoreDrafts(inputs, drafts, openIds, focus) {
  for (const id of [...drafts.keys()]) if (!openIds.has(id)) drafts.delete(id);
  for (const input of inputs) {
    const draft = drafts.get(input.dataset.id);
    if (draft) input.value = draft;
    if (focus && input.dataset.id === focus.id) {
      input.focus();
      if (focus.start != null) input.setSelectionRange(focus.start, focus.end);
    }
  }
}
