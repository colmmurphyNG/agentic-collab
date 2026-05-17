/**
 * Tests for start.sh flag handling and the smart-rebuild decision tree.
 *
 * These tests exercise start.sh in --dry-run mode so no Docker or proxy
 * processes are spawned. The script's prerequisite checks (node, tmux) must
 * pass on the test host, which they do on any reasonable dev/CI environment
 * since the conductor itself requires them.
 *
 * Tests intentionally do NOT cover the auto-rebuild decision branches that
 * depend on `docker compose ps` state, because those require either a live
 * docker daemon or a non-trivial mock. The flag-override paths (--build,
 * --no-build) are deterministic and fully covered here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT_PATH = join(import.meta.dirname, '..', 'start.sh');

function runStart(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('start.sh — flag parsing', () => {
  it('--help prints usage and exits 0 without running prerequisite checks', () => {
    const result = runStart(['--help']);
    assert.equal(result.status, 0, `--help should exit 0:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /--build/);
    assert.match(result.stdout, /--no-build/);
    assert.match(result.stdout, /--dry-run/);
    // --help should NOT have triggered the prerequisite section.
    assert.doesNotMatch(result.stdout, /Checking prerequisites/);
  });

  it('-h is an alias for --help', () => {
    const result = runStart(['-h']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--build/);
  });

  it('rejects an unknown flag with exit 1 and a clear error', () => {
    const result = runStart(['--invented']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown flag.*--invented/);
  });
});

describe('start.sh — --dry-run with build-flag overrides', () => {
  it('--build --dry-run decides BUILD with reason "--build flag"', () => {
    const result = runStart(['--build', '--dry-run']);
    assert.equal(result.status, 0, `dry-run --build should exit 0:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Force build flag:\s+yes/);
    assert.match(result.stdout, /Decision:\s+BUILD/);
    assert.match(result.stdout, /--build flag/);
    // Should NOT have actually built — dry-run guards the docker compose build call.
    assert.doesNotMatch(result.stdout, /Orchestrator image built/);
    // Should announce dry-run exit before health check.
    assert.match(result.stdout, /DRY RUN complete/);
  });

  it('--no-build --dry-run decides SKIP with reason "--no-build flag"', () => {
    const result = runStart(['--no-build', '--dry-run']);
    assert.equal(result.status, 0, `dry-run --no-build should exit 0:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Force build flag:\s+no/);
    assert.match(result.stdout, /Decision:\s+SKIP/);
    assert.match(result.stdout, /--no-build flag/);
    // Should NOT have built and should NOT have started anything.
    assert.doesNotMatch(result.stdout, /Orchestrator image built/);
    assert.doesNotMatch(result.stdout, /Orchestrator starting via Docker Compose/);
  });

  it('--dry-run alone uses auto mode and exits before any side effects', () => {
    const result = runStart(['--dry-run']);
    assert.equal(result.status, 0, `dry-run alone should exit 0:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Force build flag:\s+auto/);
    // Auto mode prints a Decision: line and a reason; we don't pin the
    // specific branch since it depends on container state on the test host.
    assert.match(result.stdout, /Decision:\s+(BUILD|SKIP)/);
    assert.match(result.stdout, /DRY RUN complete/);
    // Critical: the proxy must not be started under dry-run.
    assert.doesNotMatch(result.stdout, /Starting proxy/);
  });
});

describe('start.sh — portable shell tooling', () => {
  it('does not emit "grep: invalid option" warnings from grep -P on BSD grep', () => {
    // start.sh now uses grep -oE for the docker version extraction (line ~82).
    // BSD grep on macOS rejects -P and would print "grep: invalid option" to stderr
    // on every run; this test guards against regressing to grep -P.
    const result = runStart(['--dry-run']);
    assert.doesNotMatch(result.stderr, /grep:.*invalid option/);
  });
});
