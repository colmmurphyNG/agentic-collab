import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  sendKeys,
  sessionTarget,
  paneTarget,
  createSession,
  hasSession,
  killSession,
  capturePaneLines,
  listSessions,
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
