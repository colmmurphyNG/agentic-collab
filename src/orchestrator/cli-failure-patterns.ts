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

/**
 * Shell-prompt patterns at the bottom of a pane that indicate the CLI engine
 * has exited and only the host shell is alive. Shared between
 * `health-monitor.detectCliExit` and `routes.recoverFailedAgents` so the
 * same "bare zsh / bash" detection is used to (a) catch exits during
 * normal polling and (b) refuse to self-heal an agent whose tmux pane
 * was recreated externally without restarting the CLI inside it.
 *
 * Covers bash, zsh, fish, root, minimal sh/bash prompts, and zsh
 * continuation prompts (`quote>`, `dquote>`, etc.) that the persona
 * onboarding heredoc can drop the shell into.
 */
// User-and-host character class includes word chars + `.` + `-` so common
// shapes like `test-user@test-host` match. Plain `\w+` (no dot/dash)
// silently misses real-world macOS/Linux usernames + hostnames — the bug
// that let tl's bare-zsh pane go undetected during today's incident.
const USER_HOST = String.raw`[\w.-]+@[\w.-]+`;
export const shellPromptPatterns: readonly RegExp[] = [
  new RegExp(`${USER_HOST}[:\\s].*[$%#>]\\s*$`),                     // user@host:path$ / user@host path% / root@host:~#
  new RegExp(`^\\[?${USER_HOST}\\s.*\\]?[$%#]\\s*$`),                // [user@host path]$
  /^(?:ba)?sh[\d.-]*[$#]\s*$/,                                       // bash-5.2$ or sh$
  /^(?:cmdand\s+quote|quote|dquote|heredoc|cmdsubst|cmdor)>\s*$/i,  // zsh continuation prompts
];

/**
 * Returns `true` when the last non-empty line of `paneOutput` matches a
 * known shell-prompt pattern — i.e. the CLI engine inside the pane is
 * gone and only the host shell is responding. Use this to distinguish
 * "tmux session alive AND CLI alive" from "tmux session alive but CLI
 * died, leaving bare shell".
 */
export function paneEndsWithShellPrompt(paneOutput: string): boolean {
  const lines = paneOutput.split('\n');
  let lastLine = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed) { lastLine = trimmed; break; }
  }
  if (!lastLine) return false;
  return shellPromptPatterns.some(re => re.test(lastLine));
}
