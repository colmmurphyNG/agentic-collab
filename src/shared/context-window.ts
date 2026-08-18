/**
 * Derive an agent's context-window size from what its pane declares.
 *
 * Claude Code prints the window next to the model in the status banner, e.g.
 * `~/dev/project  Opus 5 (1M context)  ctx: 81% used`. Reading it from there
 * keeps the orchestrator correct as new models ship, with no model→window
 * table to maintain.
 *
 * This exists because a hardcoded 200,000 was applied to every model. Opus 5
 * runs a 1M window, so that constant overstates usage 5x on the token-count
 * path — enough to trip the auto-recycle threshold at roughly a fifth of real
 * usage. Percentages printed by Claude Code are already computed against the
 * true window and need no conversion (verified 2026-08-18: a pane reading
 * `ctx: 81% used` corresponded to 809,657 actual tokens on 1M = 81.0%).
 */

/** Fallback when the pane declares no window. Matches pre-1M Claude models. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Returns the declared window in tokens, or DEFAULT_CONTEXT_WINDOW_TOKENS when
 * the pane does not state one. Accepts `1M context`, `(200k context)`, and
 * fractional forms like `1.5M context`.
 */
export function parseContextWindow(paneOutput: string): number {
  const match = paneOutput.match(/(\d+(?:\.\d+)?)\s*([MmKk])\s+context/);
  if (!match) return DEFAULT_CONTEXT_WINDOW_TOKENS;

  const value = parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONTEXT_WINDOW_TOKENS;

  const multiplier = match[2]!.toLowerCase() === 'm' ? 1_000_000 : 1_000;
  return Math.round(value * multiplier);
}
