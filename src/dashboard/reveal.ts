/**
 * Where a progressively-rendered message list must start rendering so that
 * message `msgId` is in the DOM. Returns -1 if the message is not in `thread`,
 * or `renderedFrom` unchanged if it is already rendered. `context` older
 * messages are included above the target so it does not land flush at the top.
 */
export function revealStart(thread, renderedFrom, msgId, context = 5) {
  const idx = thread.findIndex(m => m.id === msgId);
  if (idx < 0) return -1;
  if (idx >= renderedFrom) return renderedFrom;
  return Math.max(0, idx - context);
}
