import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCliFailureLine, stripCliFailureLines, cliFailurePatterns, shellPromptPatterns, paneEndsWithShellPrompt } from './cli-failure-patterns.ts';

describe('cli-failure-patterns', () => {
  describe('isCliFailureLine', () => {
    it('matches claude resume-not-found message', () => {
      assert.equal(isCliFailureLine('No conversation found with session ID: abc-123'), true);
    });

    it('matches generic session-not-found message (case-insensitive)', () => {
      assert.equal(isCliFailureLine('Session abc-123 not found'), true);
      assert.equal(isCliFailureLine('session abc-123 NOT FOUND'), true);
    });

    it('matches "command not found" for each supported engine', () => {
      assert.equal(isCliFailureLine('zsh: command not found: claude'), true);
      assert.equal(isCliFailureLine('bash: command not found: codex'), true);
      assert.equal(isCliFailureLine('zsh: command not found: opencode'), true);
    });

    it('does not match a normal Claude TUI line', () => {
      assert.equal(isCliFailureLine('  Opus 4.7  ctx: 12%'), false);
      assert.equal(isCliFailureLine('❯ '), false);
      assert.equal(isCliFailureLine('user@host:~$ '), false);
    });

    it('does not match a successful /status line that happens to contain a UUID', () => {
      assert.equal(isCliFailureLine('Session: 67749c98-1c7b-4bdb-8f0e-5a1c5ed7e9be'), false);
    });
  });

  describe('stripCliFailureLines', () => {
    it('removes only failure lines from a multi-line capture', () => {
      const input = [
        'No conversation found with session ID: 11111111-2222-3333-4444-555555555555',
        'Session: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        '$',
      ].join('\n');
      const out = stripCliFailureLines(input);
      assert.ok(!out.includes('No conversation found'));
      assert.ok(out.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
      assert.ok(out.endsWith('$'));
    });

    it('returns input unchanged when no failure lines are present', () => {
      const input = 'Opus 4.7\n❯ \n';
      assert.equal(stripCliFailureLines(input), input);
    });

    it('returns empty string when input is only failure lines', () => {
      const input = 'No conversation found with session ID: abc\nSession xyz not found\n';
      // join('\n') after filtering an empty array yields ''; filtered list keeps
      // the trailing empty string from the trailing newline, so result is ''.
      assert.equal(stripCliFailureLines(input).trim(), '');
    });
  });

  it('exports a non-empty patterns array', () => {
    assert.ok(cliFailurePatterns.length > 0);
    cliFailurePatterns.forEach((re) => assert.ok(re instanceof RegExp));
  });

  describe('shellPromptPatterns + paneEndsWithShellPrompt (HH)', () => {
    it('should match the operator-incident zsh prompt at end of pane', () => {
      const pane = [
        'zsh: bad pattern: [from:',
        "test-user@test-host dev % [from: dashboard, reply with collab send dashboard --topic foo]: 'hi'",
        'zsh: bad pattern: [from:',
        'test-user@test-host dev %',
      ].join('\n');
      assert.equal(paneEndsWithShellPrompt(pane), true,
        'tl-incident shape: pane ending in `user@host path %` must be detected as shell prompt');
    });

    it('should match bash prompt at end of pane', () => {
      assert.equal(paneEndsWithShellPrompt('output\nuser@host:~/path$ '), true);
    });

    it('should match root prompt at end of pane', () => {
      assert.equal(paneEndsWithShellPrompt('output\nroot@host:~# '), true);
    });

    it('should match zsh continuation prompt (heredoc trap)', () => {
      assert.equal(paneEndsWithShellPrompt('output\nquote>'), true);
      assert.equal(paneEndsWithShellPrompt('output\ndquote>'), true);
      assert.equal(paneEndsWithShellPrompt('output\ncmdand quote>'), true);
    });

    it('should not match a live Claude TUI footer', () => {
      const claudeAlivePane = [
        '────────────────────────────────────────────────────────────────────────── tl ──',
        '❯ ',
        '────────────────────────────────────────────────────────────────────────────────',
        '  ~/dev  Opus 4.7  ctx: --                                     ◈ max · /effort',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n');
      assert.equal(paneEndsWithShellPrompt(claudeAlivePane), false,
        'live Claude TUI footer must NOT be detected as shell prompt');
    });

    it('should return false on empty pane output', () => {
      assert.equal(paneEndsWithShellPrompt(''), false);
      assert.equal(paneEndsWithShellPrompt('\n\n\n'), false);
    });

    it('should ignore trailing blank lines and check last non-empty line', () => {
      assert.equal(paneEndsWithShellPrompt('user@host ~ %\n\n\n'), true);
    });

    it('exports shellPromptPatterns as a non-empty regex array', () => {
      assert.ok(shellPromptPatterns.length > 0);
      shellPromptPatterns.forEach((re) => assert.ok(re instanceof RegExp));
    });
  });
});
