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
 *   3. Nothing — returns null rather than guessing.
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

/**
 * Returns null for an unrecognised model rather than assuming a default, and
 * the direction matters because the consumer's action is destructive.
 *
 * The usual fail-safe instinct — a bad value keeps the guard ON — inverts here:
 * the guard firing IS the destructive act (destroy + respawn), so "on" is not
 * the safe default. The asymmetry comes from the action, not from the value.
 *
 * Guessing small is the actively unsafe direction: assuming 200k for a model
 * that actually holds 1M over-reports occupancy 5x and recycles an agent at a
 * fifth of real usage — the exact failure this module was written to remove —
 * and nothing surfaces it, because the reading looks plausible and the recycle
 * looks legitimate. Returning null means no reading, so no recycle: an
 * unmeasured model is left unmonitored rather than mis-monitored, which is the
 * status quo we have already lived with rather than a new harm.
 */

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
 * declaration over the model name, or **null** when neither is available.
 * Callers must treat null as "no context reading", never as a default.
 */
export function parseContextWindow(paneOutput: string): number | null {
  return parseDeclaredWindow(paneOutput) ?? parseModelWindow(paneOutput);
}
