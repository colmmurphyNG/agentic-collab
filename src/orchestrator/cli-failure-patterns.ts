/**
 * Patterns that identify lines emitted by a CLI engine (claude / codex / opencode)
 * when it has refused to start or has fallen back to the shell.
 *
 * Used in two places:
 *
 * 1. `health-monitor.ts:detectCliExit` — scans recent pane output to decide whether
 *    the agent has exited to a shell and should be marked `failed`.
 *
 * 2. `lifecycle.ts` capture step — filters these lines OUT of the captured pane
 *    text before running the SESSION_ID regex, so a UUID inside an error message
 *    ("No conversation found with session ID: <uuid>") cannot be mistaken for a
 *    live session id and re-written to the DB. Without this filter, a resume
 *    failure produces an infinite recovery loop on the dead UUID.
 */
export const cliFailurePatterns: readonly RegExp[] = [
  /No conversation found with session ID/i, // claude --resume <stale-id>
  /Session .+ not found/i,                  // generic session lookup failure
  /command not found.*claude/i,             // claude not installed
  /command not found.*codex/i,              // codex not installed
  /command not found.*opencode/i,           // opencode not installed
];

/** Return true if `line` matches any known CLI-failure pattern. */
export function isCliFailureLine(line: string): boolean {
  return cliFailurePatterns.some((re) => re.test(line));
}

/** Strip CLI-failure lines from a captured pane text. */
export function stripCliFailureLines(captured: string): string {
  return captured
    .split('\n')
    .filter((line) => !isCliFailureLine(line))
    .join('\n');
}
