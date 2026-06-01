/**
 * Smoke tests for `bin/collab` CLI argument parsing.
 *
 * The CLI is a self-contained Node script (not a TypeScript module), so
 * tests spawn the binary in a subprocess and assert on exit code + stderr.
 * Targets that would otherwise trigger network calls (e.g. `dashboard`,
 * `operator`, real agent names) are replaced with bogus names that the
 * target-validator rejects — so a passing smoke can't leak a side effect.
 *
 * Covers backlog item AA — argv parser must reject unknown long-flags
 * instead of silently consuming them as positional message body.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';


const COLLAB_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'collab',
);


/**
 * Run the CLI with the given args. Returns the spawn result with stdout
 * and stderr decoded as utf-8 strings. The orchestrator HTTP endpoint
 * is pointed at an unreachable port so any real send attempt would fail
 * fast rather than block the test runner.
 */
function runCollab(args: string[]) {
  return spawnSync(COLLAB_BIN, args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ORCHESTRATOR_URL: 'http://127.0.0.1:1',
      COLLAB_AGENT: 'test-runner',
    },
    timeout: 5_000,
  });
}


describe('collab send — unknown flag handling', () => {
  it('should reject an unknown --flag and exit with code 2', () => {
    const r = runCollab(['send', 'nonexistent-target-xyz', '--topic', 't', '--bogus-flag', 'message']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag '--bogus-flag' in 'send'/);
    assert.match(r.stderr, /Valid flags:/);
    assert.match(r.stderr, /--topic/);
  });

  it('should mention POSIX -- end-of-options escape in the hint', () => {
    const r = runCollab(['send', 'nonexistent', '--topic', 't', '--stdin', 'x']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /POSIX end-of-options/);
    assert.match(r.stderr, /-- --stdin/);
  });

  it('should pass --stdin through as message body when preceded by --', () => {
    // Target is bogus so the validator rejects, but we should get past flag parsing.
    // The validator emits a different error than the unknown-flag error.
    const r = runCollab(['send', 'nonexistent-target-xyz', '--topic', 't', '--', '--stdin', 'hello']);
    // Either status 0 (sent — unlikely with bogus target) OR target-validator failure.
    // The key assertion: stderr must NOT contain the unknown-flag error.
    assert.doesNotMatch(r.stderr, /unknown flag/);
  });

  it('should accept all four known send flags without error', () => {
    const r = runCollab([
      'send', 'nonexistent-target-xyz',
      '--topic', 't',
      '--in-reply-to', 'prev-msg',
      '--notify', 'normal',
      '--reply-reminder', '15',
      'hello world',
    ]);
    assert.doesNotMatch(r.stderr, /unknown flag/);
  });
});


describe('collab reminder add — unknown flag handling', () => {
  it('should reject an unknown --flag on reminder add and exit with code 2', () => {
    const r = runCollab(['reminder', 'add', 'brain', 'ping', '--cadence', '5m', '--bogus', 'value']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag '--bogus' in 'reminder add'/);
    assert.match(r.stderr, /--cadence/);
    assert.match(r.stderr, /--from/);
  });

  it('should accept --cadence and --from without error', () => {
    const r = runCollab(['reminder', 'add', 'brain', 'ping', '--cadence', '5m', '--from', 'me']);
    assert.doesNotMatch(r.stderr, /unknown flag/);
  });
});


describe('collab publish — unknown flag handling', () => {
  it('should reject an unknown --flag on publish and exit with code 2', () => {
    const r = runCollab(['publish', 'slug', 'dir', '--bogus-publish-flag', 'value']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag '--bogus-publish-flag' in 'publish'/);
    assert.match(r.stderr, /--template/);
    assert.match(r.stderr, /--store/);
    assert.match(r.stderr, /--title/);
  });

  it('should accept all three known publish flags without error', () => {
    const r = runCollab(['publish', 'slug', '--template', 'tpl', '--store', 'st', '--title', 'A title']);
    assert.doesNotMatch(r.stderr, /unknown flag/);
  });
});


describe('collab — bare -- token (POSIX end-of-options)', () => {
  it('should not reject a single -- in send args', () => {
    // `--` alone is not a flag; it's the end-of-options marker. Should not
    // trigger the unknown-flag rejection.
    const r = runCollab(['send', 'nonexistent', '--topic', 't', '--', 'plain', 'message']);
    assert.doesNotMatch(r.stderr, /unknown flag/);
  });

  it('should not reject a single -- in reminder add args', () => {
    const r = runCollab(['reminder', 'add', 'brain', 'ping', '--cadence', '5m', '--', 'extra', 'positional']);
    assert.doesNotMatch(r.stderr, /unknown flag/);
  });
});
