import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCliFailureLine, stripCliFailureLines, cliFailurePatterns } from './cli-failure-patterns.ts';

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
});
