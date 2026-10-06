/**
 * Tmux operations. Runs on the host machine.
 * All tmux commands executed via child_process.
 */

import { execSync, execFileSync, type ExecSyncOptions } from 'node:child_process';

const EXEC_OPTS: ExecSyncOptions = { encoding: 'utf-8', timeout: 10_000 };

// tmux resolves -t exact-then-prefix, so an unanchored 'agent-dev' matches
// 'agent-dev-a'. The two anchored forms are not interchangeable: a pane or
// window target needs the trailing colon, and '=name' alone fails to resolve.
export function sessionTarget(name: string): string {
  return `=${name}`;
}

export function paneTarget(name: string): string {
  return `=${name}:`;
}

function exec(cmd: string): string {
  try {
    return (execSync(cmd, EXEC_OPTS) as string).trim();
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(`tmux command failed: ${cmd}\n${msg}`);
  }
}

/**
 * Detached tmux sessions default to 80x24, which is too narrow for the Claude
 * Code status bar: it renders the displayed path, the model, and `ctx: NN% used`
 * on one line, so a long path pushes the context reading past the right edge and
 * it is never written to the pane at all.
 *
 * That silently removed agents from the ctx-threshold auto-recycle net — and
 * selectively, since a long displayed path comes from working in a deep scratch
 * or memory directory, which is also what accumulates context fastest. Measured
 * 2026-08-18 at 80 columns: four agents unreadable, one of them at 83%, plus a
 * fifth truncated mid-value at 93% (above the 92% recycle threshold).
 *
 * 200 columns fits the longest path in use with room to spare. Nothing reads the
 * pane by fixed column offsets, so widening is safe for every consumer.
 */
const SESSION_WIDTH = 200;
const SESSION_HEIGHT = 50;

export function createSession(sessionName: string, cwd: string): void {
  validateSessionName(sessionName);
  // Unset CLAUDECODE so spawned Claude Code instances don't think they're nested.
  // The proxy may itself be launched from within a Claude Code session.
  // Explicitly pass PATH so engines like Codex that spawn sub-shells don't lose
  // the collab bin directory that the proxy prepended at startup.
  const path = process.env['PATH'] ?? '';
  exec(`tmux new-session -d -s '${esc(sessionName)}' -c '${esc(cwd)}' -x ${SESSION_WIDTH} -y ${SESSION_HEIGHT} -e CLAUDECODE= -e PATH='${esc(path)}'`);
}

export function hasSession(sessionName: string): boolean {
  validateSessionName(sessionName);
  try {
    exec(`tmux has-session -t '${esc(sessionTarget(sessionName))}'`);
    return true;
  } catch {
    return false;
  }
}

export function killSession(sessionName: string): void {
  validateSessionName(sessionName);
  try {
    exec(`tmux kill-session -t '${esc(sessionTarget(sessionName))}'`);
  } catch {
    // Session may already be gone
  }
}

export function clearHistory(sessionName: string): void {
  validateSessionName(sessionName);
  try {
    exec(`tmux clear-history -t '${esc(paneTarget(sessionName))}'`);
  } catch {
    // Session may be gone — non-fatal
  }
}

export function listSessions(): string[] {
  try {
    const output = exec("tmux list-sessions -F '#{session_name}'");
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Paste text into a tmux pane via load-buffer + paste-buffer.
 * Optionally press Enter after pasting.
 */
// Delay between paste and Enter: 1ms per character (terminal ingestion rate),
// with a 500ms floor so short messages still get a comfortable flush window.
function pasteEnterDelay(textLength: number): number {
  return Math.max(500, textLength);
}

/**
 * Flags on the paste. **Each one fixes a DIFFERENT observed fault, and none is decorative.**
 * Spelled out because the one that looks most droppable is the one holding up the worst failure.
 *
 * `-p`  Bracketed paste, so the application ingests the block as a paste rather than as typed
 *       input. **This is what stops messages being truncated.** Measured across four independently
 *       reported truncations: the receiving input line consumed text in 1,022-byte chunks and kept
 *       only the final partial chunk, so a message of N bytes arrived as its last `N mod 1022`.
 *       All four fitted that exactly — 2,592→548, 2,130→86, 2,068→24 and 1,766→744 bytes received.
 *       1022 is 1024 − 2, i.e. a receiver-side buffer, which nothing else here can influence.
 * `-r`  Keep LF as LF. Without it tmux replaces every LF with CR, and CR is Enter to a terminal
 *       application, so line breaks became submissions and the text either side of each one was
 *       joined. Real corruption, but never the truncation.
 * `-b`  Per-paste buffer name, set on the load as well. Without it a paste takes whatever is top of
 *       the shared stack, which delivered one agent another agent's message.
 * `-d`  Drop the buffer once pasted. Without it every message ever delivered stayed readable in a
 *       server-wide clipboard; 50 buffers holding 95 KB when first measured.
 *
 * The truncation cannot be reproduced in a test here: any harness that reads raw bytes receives all
 * of them, which is how the fault was localised to the receiving application in the first place. So
 * `-p` has no behavioural test protecting it, and a test that only checks line breaks survive will
 * pass without it. That is what the assertion on this constant is for.
 */
export const PASTE_FLAGS = '-d -p -r';

/**
 * A buffer name unique to one paste, so a delivery can never paste another
 * delivery's text. The name must go on BOTH load-buffer and paste-buffer:
 * naming only the load is the intuitive fix and it changes nothing, because a
 * paste-buffer without -b takes whatever is top of the buffer stack.
 *
 * Only [A-Za-z0-9-] reaches the shell here — sessionName is already validated,
 * and it is sanitised again because this value is interpolated into a command.
 */
let pasteSeq = 0;
function pasteBufferName(sessionName: string): string {
  pasteSeq = (pasteSeq + 1) % 1_000_000;
  const safe = sessionName.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40);
  return `collab-${safe}-${process.pid}-${Date.now().toString(36)}-${pasteSeq}`;
}

/**
 * `typedPrefix` is typed as keystrokes, not pasted, so the receiving application sees it as the
 * user's own words. Claude Code treats a bracketed paste as text copied in from elsewhere and
 * will not act on instructions inside one unless typed words around it ask it to, so a long
 * message pasted on its own was being held for the operator instead of handled.
 * Line breaks are removed from the prefix: typed, each one would be an Enter.
 */
export async function pasteText(
  sessionName: string,
  text: string,
  pressEnter: boolean,
  typedPrefix?: string,
): Promise<void> {
  validateSessionName(sessionName);
  // Verify tmux is responsive before pasting — catches locked/overloaded sessions
  try {
    execSync(`tmux capture-pane -t '${esc(paneTarget(sessionName))}' -p -S -1`, { ...EXEC_OPTS, timeout: 5000 });
  } catch {
    throw new Error(`tmux session "${sessionName}" is not responsive (capture-pane timed out)`);
  }
  const prefix = typedPrefix?.replace(/[\r\n]+/g, ' ');
  if (prefix) {
    execFileSync('tmux', ['send-keys', '-l', '-t', paneTarget(sessionName), prefix], EXEC_OPTS);
  }
  // Pass text via stdin (input option) to avoid all shell escaping issues
  const buffer = pasteBufferName(sessionName);
  execSync(`tmux load-buffer -b ${buffer} -`, { ...EXEC_OPTS, input: text });
  try {
    exec(`tmux paste-buffer ${PASTE_FLAGS} -b ${buffer} -t '${esc(paneTarget(sessionName))}'`);
  } catch (err) {
    // -d never ran, so remove it here; a failed paste must not leak a buffer.
    try {
      exec(`tmux delete-buffer -b ${buffer}`);
    } catch {
      // best-effort cleanup — surface the paste failure, not this one
    }
    throw err;
  }

  if (pressEnter) {
    await new Promise<void>((r) => setTimeout(r, pasteEnterDelay(text.length)));
    exec(`tmux send-keys -t '${esc(paneTarget(sessionName))}' Enter`);
  }
}

/**
 * Capture the last N lines from the tmux pane.
 */
export function capturePaneLines(sessionName: string, lines: number): string {
  validateSessionName(sessionName);
  const safeLines = Math.max(1, Math.min(Math.floor(lines) || 50, 10000));
  return exec(`tmux capture-pane -t '${esc(paneTarget(sessionName))}' -p -S -${safeLines}`);
}

/**
 * Get the last activity timestamp for a tmux session pane.
 * Returns Unix timestamp (seconds) from tmux's #{window_activity}.
 */
export function paneActivity(sessionName: string): number {
  validateSessionName(sessionName);
  const output = exec(`tmux display-message -t '${esc(paneTarget(sessionName))}' -p '#{window_activity}'`);
  const ts = parseInt(output, 10);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Send raw keys to a tmux session.
 * Keys are validated to prevent shell injection — only known tmux key names
 * and safe patterns (e.g. "Escape Escape Escape", "C-c", "Enter") are allowed.
 */
const SAFE_KEYS_RE = /^[a-zA-Z0-9 -]+$/;

export function sendKeys(sessionName: string, keys: string): void {
  validateSessionName(sessionName);
  if (!SAFE_KEYS_RE.test(keys)) {
    throw new Error(`Invalid keys: "${keys}" — only alphanumeric, spaces, and hyphens allowed`);
  }
  exec(`tmux send-keys -t '${esc(paneTarget(sessionName))}' ${keys}`);
}

/**
 * Send raw tmux send-keys tokens without shell interpolation.
 * Used only by the constrained `collab tmux ... -- send-keys ...` escape hatch.
 */
export function sendKeysRaw(sessionName: string, keys: string[]): void {
  validateSessionName(sessionName);
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('keys required');
  }
  execFileSync('tmux', ['send-keys', '-t', paneTarget(sessionName), ...keys], EXEC_OPTS);
}

/**
 * Run `tmux display-message -p` for a session and return stdout.
 */
export function displayMessage(sessionName: string, format: string): string {
  validateSessionName(sessionName);
  if (!format) {
    throw new Error('format required');
  }
  return (execFileSync('tmux', ['display-message', '-t', paneTarget(sessionName), '-p', format], EXEC_OPTS) as string).trim();
}

/**
 * Resize the tmux window for a session to the given width and height.
 */
export function resizePane(sessionName: string, width: number, height: number): void {
  validateSessionName(sessionName);
  const w = Math.max(1, Math.min(Math.floor(width), 500));
  const h = Math.max(1, Math.min(Math.floor(height), 200));
  exec(`tmux resize-window -t '${esc(paneTarget(sessionName))}' -x ${w} -y ${h}`);
}

/**
 * Validate tmux session name — only allow safe characters.
 */
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: "${name}" — only [a-zA-Z0-9_-] allowed`);
  }
}

/**
 * Escape single quotes for shell.
 */
function esc(s: string): string {
  return s.replace(/'/g, "'\\''");
}
