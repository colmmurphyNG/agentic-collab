/**
 * Derive an agent's context-window size from its pane.
 *
 * This exists because a hardcoded 200,000 was applied to every model. Opus 5
 * runs a 1M window, so that constant overstates usage 5x on the token-count
 * path — enough to trip the auto-recycle threshold at roughly a fifth of real
 * usage. Percentages printed by Claude Code are already computed against the
 * true window and need no conversion, so they are preferred; this helper only
 * serves the token-count fallback.
 *
 * Sources, in precedence order:
 *   1. An explicit `(1M context)` declaration, when the banner carries one.
 *   2. The model name, which the banner always carries.
 *   3. DEFAULT_CONTEXT_WINDOW_TOKENS.
 *
 * The model name is the load-bearing source. The declaration is printed
 * inconsistently — measured 2026-08-18 across three `claude-opus-5` agents, all
 * three on a 1M window but only one printing `(1M context)`:
 *
 *   prev  81% of 1M   809,657 tokens   banner: "Opus 5 (1M context)"
 *   tl    94% of 1M   943,749 tokens   banner: "Opus 5"
 *   pwa   42% of 1M   417,941 tokens   banner: "Opus 5"
 *
 * Deriving from the declaration alone would therefore fall back to 200k for tl
 * and pwa and reintroduce the same 5x error it was meant to fix.
 */

/** Fallback when neither a declaration nor a known model is present. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Windows keyed on the model name as the status banner prints it. Add entries
 * only for windows that have been measured — a wrong entry here silently
 * mis-scales the token path, which is the bug this module exists to fix.
 */
const MODEL_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bopus\s*5\b/i, 1_000_000],
];

/** Reads an explicit `(1M context)` / `(200k context)` declaration, if present. */
function parseDeclaredWindow(paneOutput: string): number | null {
  const match = paneOutput.match(/(\d+(?:\.\d+)?)\s*([MmKk])\s+context/);
  if (!match) return null;

  const value = parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;

  return Math.round(value * (match[2]!.toLowerCase() === 'm' ? 1_000_000 : 1_000));
}

/** Reads the window implied by the model name in the banner, if recognised. */
function parseModelWindow(paneOutput: string): number | null {
  for (const [pattern, tokens] of MODEL_WINDOWS) {
    if (pattern.test(paneOutput)) return tokens;
  }
  return null;
}

/**
 * Returns the agent's context window in tokens, preferring an explicit
 * declaration, then the model name, then DEFAULT_CONTEXT_WINDOW_TOKENS.
 */
export function parseContextWindow(paneOutput: string): number {
  return parseDeclaredWindow(paneOutput)
    ?? parseModelWindow(paneOutput)
    ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}
