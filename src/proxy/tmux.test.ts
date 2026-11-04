import { describe, it, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  sendKeys,
  sessionTarget,
  paneTarget,
  createSession,
  hasSession,
  killSession,
  capturePaneLines,
  listSessions,
  pasteText,
  sendKeysRaw,
  PASTE_FLAGS,
  buildCreateSessionCommand,
  cpuPriorityPrefix,
  defaultCpuPriority,
  describeCpuPriority,
  parseCpuPriority,
  _resetCpuPriorityLogForTesting,
} from './tmux.ts';

describe('tmux sendKeys validation', () => {
  it('rejects keys with shell metacharacters', () => {
    assert.throws(() => sendKeys('test-session', '$(whoami)'), /Invalid keys/);
  });

  it('rejects keys with backticks', () => {
    assert.throws(() => sendKeys('test-session', '`id`'), /Invalid keys/);
  });

  it('rejects keys with semicolons', () => {
    assert.throws(() => sendKeys('test-session', 'Enter; rm -rf /'), /Invalid keys/);
  });

  it('rejects keys with pipes', () => {
    assert.throws(() => sendKeys('test-session', 'Enter | cat /etc/passwd'), /Invalid keys/);
  });

  it('rejects keys with newlines', () => {
    assert.throws(() => sendKeys('test-session', 'Enter\nrm -rf /'), /Invalid keys/);
  });

  it('rejects invalid session names', () => {
    assert.throws(() => sendKeys("bad'name", 'Escape'), /Invalid session name/);
  });

  it('rejects session names with shell injection', () => {
    assert.throws(() => sendKeys('$(whoami)', 'Escape'), /Invalid session name/);
  });

  // Valid keys would succeed validation but fail on tmux exec (no tmux in test).
  // We verify they pass validation by checking the error is from tmux, not from our validation.
  it('accepts valid key names (Escape, Enter, C-c pattern)', () => {
    // These pass validation but fail on tmux execution — that's expected
    try {
      sendKeys('test-session', 'Escape Escape Escape');
    } catch (err) {
      // Should fail with "tmux command failed" not "Invalid keys"
      assert.ok((err as Error).message.includes('tmux command failed'),
        `Expected tmux error, got: ${(err as Error).message}`);
    }
  });

  it('accepts C-c style keys', () => {
    try {
      sendKeys('test-session', 'C-c');
    } catch (err) {
      assert.ok((err as Error).message.includes('tmux command failed'),
        `Expected tmux error, got: ${(err as Error).message}`);
    }
  });
});

describe('tmux target anchoring', () => {
  it('should anchor a session target with a bare equals prefix', () => {
    assert.equal(sessionTarget('agent-dev'), '=agent-dev');
  });

  // The colon is load-bearing: tmux rejects '=name' on a pane target with
  // "can't find pane", so dropping it breaks capture and send for every agent.
  it('should anchor a pane target with a trailing colon', () => {
    assert.equal(paneTarget('agent-dev'), '=agent-dev:');
  });

  it('should not let a master name resolve to a scaled child', () => {
    assert.notEqual(sessionTarget('agent-dev'), sessionTarget('agent-dev-a'));
    assert.notEqual(paneTarget('agent-dev'), paneTarget('agent-dev-a'));
  });
});

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Exercises real tmux because the defect was in tmux's own target resolution,
// not in our string building. A child session is mandatory: with only the parent
// present these assertions pass whether or not the anchoring is there.
describe('tmux prefix-collision safety (real tmux)', { skip: !tmuxAvailable() }, () => {
  const parent = `collabtest-tmuxtarget-${process.pid}`;
  const child = `${parent}-a`;

  // Each test builds its own sessions. Sequential coupling made the capture case
  // pass against unanchored code, because an earlier test had already destroyed
  // the child it was supposed to prove was not being read.
  function reset(): void {
    for (const name of [parent, child]) {
      try {
        execFileSync('tmux', ['kill-session', '-t', `=${name}`], { timeout: 5000, stdio: 'ignore' });
      } catch {
        // Already gone.
      }
    }
  }

  beforeEach(reset);
  after(reset);

  it('should not report the parent as present when only the child exists', () => {
    createSession(child, process.cwd());
    assert.equal(hasSession(child), true, 'child should exist');
    assert.equal(hasSession(parent), false, 'parent must not resolve to the child by prefix');
  });

  it('should create the session wide enough for the full status bar', () => {
    // Detached tmux defaults to 80 columns, which truncates the Claude Code
    // status bar mid-line and silently drops the "ctx: NN% used" reading that
    // the auto-recycle threshold depends on. Measured live: four agents
    // unreadable at 80 columns, one of them at 83%.
    createSession(child, process.cwd());
    const width = execFileSync('tmux', ['display-message', '-p', '-t', `=${child}:`, '#{window_width}'], { encoding: 'utf8' }).trim();
    assert.ok(Number(width) >= 120, `window width ${width} must fit the status bar (>=120)`);
  });

  it('should leave the child alive when killing an absent parent', () => {
    createSession(child, process.cwd());
    killSession(parent);
    assert.equal(hasSession(child), true, 'killing the absent parent must not kill the child');
  });

  it('should not read the child pane when capturing an absent parent', () => {
    createSession(child, process.cwd());
    assert.throws(() => capturePaneLines(parent, 20), /tmux command failed/);
  });

  it('should kill only the exact session it targets', () => {
    createSession(parent, process.cwd());
    createSession(child, process.cwd());
    killSession(parent);
    assert.equal(hasSession(parent), false, 'parent should be gone');
    assert.equal(hasSession(child), true, 'child should be untouched');
  });

  it('should leave no test sessions behind', () => {
    createSession(parent, process.cwd());
    createSession(child, process.cwd());
    killSession(parent);
    killSession(child);
    assert.equal(
      listSessions().some((s) => s === parent || s === child),
      false,
    );
  });
});

// No timeout(1) on macOS, so every wait here is a bounded iteration count that
// re-tests the condition itself rather than trusting a fixed sleep.
async function settle(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * A session whose COMMAND is the reader, so the pty is in raw mode before any
 * paste can arrive. An earlier version of this test started a shell and typed
 * `stty raw` at it; the paste raced the stty, the tty's icrnl quietly turned CR
 * into LF, and the test passed against the broken code. Setting the command up
 * front removes the race and is what makes the assertion mean anything.
 */
function rawReader(name: string, bytes: number, outFile: string): void {
  execFileSync('tmux', [
    'new-session', '-d', '-s', name, '-c', process.cwd(),
    `stty raw -echo; head -c ${bytes} > ${outFile}`,
  ]);
}

async function readWhenSized(file: string, bytes: number): Promise<string> {
  for (let i = 0; i < 60; i++) {
    if (existsSync(file) && readFileSync(file).length >= bytes) {
      return readFileSync(file, 'utf-8');
    }
    await settle(100);
  }
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
}

describe('pasteText delivers a message intact', () => {
  // Real tmux, and each test reads what actually landed in the pane or the buffer
  // stack. Both assertions below were checked against the pre-fix command form and
  // both fail there — a test that passes either way would have shipped the bug.
  const made: string[] = [];
  const files: string[] = [];

  after(() => {
    for (const s of made) { try { killSession(s); } catch { /* already gone */ } }
    for (const f of files) { try { rmSync(f, { force: true }); } catch { /* fine */ } }
  });

  it('preserves line breaks instead of delivering each one as Enter', async () => {
    const out = `${tmpdir()}/paste-lf-${process.pid}.bin`;
    const name = `paste-lf-${process.pid}`;
    const text = 'AAA\n\nBBB\nCCC';
    files.push(out);
    made.push(name);
    rawReader(name, text.length, out);
    await settle(400);

    await pasteText(name, text, false);
    const got = await readWhenSized(out, text.length);

    // paste-buffer replaces LF with CR unless -r is given, and CR is Enter to a TUI.
    // A 39-line message therefore arrived as 39 submits, keeping only the last segment
    // and joining the text on either side of every break.
    assert.ok(!got.includes('\r'), `no CR should reach the pane, got ${JSON.stringify(got)}`);
    assert.equal(got, text, 'the pane must receive the text byte-for-byte');
  });

  it('does not leave the delivered message sitting in a shared tmux buffer', async () => {
    const out = `${tmpdir()}/paste-clean-${process.pid}.bin`;
    const name = `paste-clean-${process.pid}`;
    const marker = `buffer-residue-marker-${process.pid}`;
    files.push(out);
    made.push(name);
    rawReader(name, marker.length, out);
    await settle(400);

    await pasteText(name, marker, false);
    await readWhenSized(out, marker.length);

    // Pre-fix this used tmux's unnamed buffer and never deleted it, so every message
    // ever delivered stayed readable in a clipboard shared by every agent — measured at
    // 50 retained buffers holding 95 KB of inter-agent traffic. -b names it per paste
    // and -d drops it.
    const names = execFileSync('tmux', ['list-buffers', '-F', '#{buffer_name}'], { encoding: 'utf-8' })
      .split('\n').filter(Boolean);
    const residue = names.filter((b) => {
      try {
        return execFileSync('tmux', ['show-buffer', '-b', b], { encoding: 'utf-8' }).includes(marker);
      } catch {
        return false; // raced with another delete; it is not residue if it is gone
      }
    });
    assert.deepEqual(residue, [], 'the delivered text must not remain in any tmux buffer');
  });

  it('types the prefix ahead of the pasted text, with no line break to submit it early', async () => {
    const out = `${tmpdir()}/paste-prefix-${process.pid}.bin`;
    const name = `paste-prefix-${process.pid}`;
    const prefix = 'Delivered.\nSender in header. ';
    const text = 'line one\nline two';
    const expected = 'Delivered. Sender in header. ' + text;
    files.push(out);
    made.push(name);
    rawReader(name, expected.length, out);
    await settle(400);

    await pasteText(name, text, false, prefix);
    const got = await readWhenSized(out, expected.length);

    assert.equal(got, expected, 'prefix first, line breaks in it flattened, message byte-for-byte after');
  });

  // A third test asserting that two concurrent deliveries each get their own text was
  // written and then deleted: it cannot fail. `exec` here wraps execSync and nothing
  // yields between the load and the paste, so two pasteText calls in this single-threaded
  // proxy can never interleave. Keeping it would have implied a guarantee that the test
  // was not checking. The cross-talk risk is real but comes from OTHER tmux clients
  // pasting without -b, which is a property of those callers, not of this function.
});

describe('paste flags are load-bearing', () => {
  // The truncation fault lives in the receiving application, so it cannot be reproduced here —
  // any harness reading raw bytes gets every byte, which is how it was localised. That leaves -p
  // with no behavioural test, and the line-break test passes without it. These assertions exist so
  // that removing a flag fails the suite rather than silently reinstating a fault.

  it('keeps bracketed paste, which is what stops messages being truncated', () => {
    assert.match(PASTE_FLAGS, /(^|\s)-p(\s|$)/, 'removing -p reinstates the 1022-byte truncation');
  });

  it('keeps LF unreplaced, so line breaks are not delivered as Enter', () => {
    assert.match(PASTE_FLAGS, /(^|\s)-r(\s|$)/, 'removing -r turns every line break into a submit');
  });

  it('keeps the buffer deletion, so delivered messages do not accumulate in a shared clipboard', () => {
    assert.match(PASTE_FLAGS, /(^|\s)-d(\s|$)/, 'removing -d leaves every message readable server-wide');
  });
});

const MAC = { platform: 'darwin', taskpolicyAvailable: true };
const LINUX = { platform: 'linux', taskpolicyAvailable: false };
const NO_TASKPOLICY = { platform: 'darwin', taskpolicyAvailable: false };

// The pre-change command line, spelled out so `normal` is checked byte-for-byte
// against what the proxy used to send rather than against the code under test.
const LEGACY_CMD = "tmux new-session -d -s 'agent-x' -c '/tmp/work' -x 200 -y 50 -e CLAUDECODE= -e PATH='/usr/bin:/bin'";

describe('agent CPU priority: session command', () => {
  beforeEach(() => _resetCpuPriorityLogForTesting());

  it('wraps the session shell with taskpolicy -c utility by default', () => {
    const cmd = buildCreateSessionCommand('agent-x', '/tmp/work', '/usr/bin:/bin', defaultCpuPriority(undefined), MAC, '/bin/zsh');
    assert.equal(cmd, `${LEGACY_CMD} '/usr/sbin/taskpolicy -c utility /bin/zsh -l'`);
  });

  it('never uses the background clamp, which throttles disk I/O', () => {
    const cmd = buildCreateSessionCommand('agent-x', '/tmp/work', '/usr/bin:/bin', 'utility', MAC, '/bin/zsh');
    assert.doesNotMatch(cmd, /taskpolicy[^']*\s-b(\s|')/);
    assert.doesNotMatch(cmd, /-c background/);
  });

  it('leaves the command byte-for-byte unchanged for normal', () => {
    assert.equal(buildCreateSessionCommand('agent-x', '/tmp/work', '/usr/bin:/bin', 'normal', MAC, '/bin/zsh'), LEGACY_CMD);
  });

  it('AGENT_CPU_PRIORITY=normal selects the unwrapped command', () => {
    const cmd = buildCreateSessionCommand('agent-x', '/tmp/work', '/usr/bin:/bin', defaultCpuPriority('normal'), MAC, '/bin/zsh');
    assert.equal(cmd, LEGACY_CMD);
  });

  it('a per-session override beats the env default in both directions', () => {
    const envNormal = defaultCpuPriority('normal');
    assert.match(buildCreateSessionCommand('agent-x', '/tmp/work', '/p', parseCpuPriority('utility') ?? envNormal, MAC, '/bin/zsh'), /taskpolicy -c utility/);
    const envUtility = defaultCpuPriority('utility');
    assert.equal(buildCreateSessionCommand('agent-x', '/tmp/work', '/usr/bin:/bin', parseCpuPriority('normal') ?? envUtility, MAC, '/bin/zsh'), LEGACY_CMD);
  });

  it('parses case-insensitively and rejects unknown values', () => {
    assert.equal(parseCpuPriority('UTILITY'), 'utility');
    assert.equal(parseCpuPriority(' normal '), 'normal');
    assert.equal(parseCpuPriority('background'), undefined);
    assert.equal(parseCpuPriority(undefined), undefined);
    assert.equal(defaultCpuPriority('bogus'), 'utility');
    assert.equal(defaultCpuPriority(''), 'utility');
  });

  it('falls back to no wrapper on a non-darwin host', () => {
    mock.method(console, 'warn', () => {});
    assert.equal(buildCreateSessionCommand('agent-x', '/tmp/work', '/usr/bin:/bin', 'utility', LINUX, '/bin/zsh'), LEGACY_CMD);
    mock.restoreAll();
  });

  it('falls back to no wrapper when taskpolicy is missing', () => {
    mock.method(console, 'warn', () => {});
    assert.equal(buildCreateSessionCommand('agent-x', '/tmp/work', '/usr/bin:/bin', 'utility', NO_TASKPOLICY, '/bin/zsh'), LEGACY_CMD);
    mock.restoreAll();
  });

  it('logs the fallback once, not per session', () => {
    const warn = mock.method(console, 'warn', () => {});
    cpuPriorityPrefix('utility', LINUX);
    cpuPriorityPrefix('utility', LINUX);
    cpuPriorityPrefix('utility', NO_TASKPOLICY);
    assert.equal(warn.mock.callCount(), 1);
    mock.restoreAll();
  });

  it('does not log for normal, which asks for nothing', () => {
    const warn = mock.method(console, 'warn', () => {});
    cpuPriorityPrefix('normal', LINUX);
    assert.equal(warn.mock.callCount(), 0);
    mock.restoreAll();
  });

  it('skips the clamp rather than quote around an unusual $SHELL', () => {
    assert.equal(buildCreateSessionCommand('agent-x', '/tmp/work', '/usr/bin:/bin', 'utility', MAC, "/bin/z sh'; rm -rf /"), LEGACY_CMD);
  });

  it('startup line reports the priority in force and flags a mistyped value', () => {
    assert.match(describeCpuPriority(undefined, MAC), /priority: utility, wrapper: taskpolicy -c utility/);
    assert.match(describeCpuPriority('normal', MAC), /priority: normal, wrapper: none/);
    assert.match(describeCpuPriority('utlity', MAC), /unrecognised AGENT_CPU_PRIORITY="utlity"/);
    assert.match(describeCpuPriority(undefined, LINUX), /wrapper: none/);
  });
});

// Real tmux on macOS: the clamp must reach the shell and its children, and the
// pane pid (#{pane_pid}) must still be the shell, i.e. taskpolicy exec'd.
describe('agent CPU priority: real tmux', { skip: !tmuxAvailable() || process.platform !== 'darwin' }, () => {
  const name = `collabtest-cpuprio-${process.pid}`;
  const sync = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim();
  const kill = (): void => {
    try { execFileSync('tmux', ['kill-session', '-t', `=${name}`], { timeout: 5000, stdio: 'ignore' }); } catch { /* gone */ }
  };
  beforeEach(kill);
  after(kill);

  function paneShell(): { pid: string; comm: string } {
    const pid = sync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']);
    return { pid, comm: sync('ps', ['-o', 'command=', '-p', pid]) };
  }

  it('keeps the pane pid on the shell and clamps it to utility, unlike normal', () => {
    createSession(name, process.cwd(), 'utility');
    const clamped = paneShell();
    assert.match(clamped.comm, /zsh|bash|sh/, `pane pid must be the shell itself, got: ${clamped.comm}`);
    assert.doesNotMatch(clamped.comm, /taskpolicy/);
    const clampedPri = sync('ps', ['-o', 'pri=', '-p', clamped.pid]);
    kill();
    createSession(name, process.cwd(), 'normal');
    const plain = paneShell();
    const plainPri = sync('ps', ['-o', 'pri=', '-p', plain.pid]);
    assert.notEqual(clampedPri, plainPri, 'utility clamp must change the scheduling priority');
    assert.ok(Number(clampedPri) < Number(plainPri), `utility ${clampedPri} should be below normal ${plainPri}`);
  });
});
