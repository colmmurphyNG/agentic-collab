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

describe('start.sh — host-port parameterization', () => {
  it('URLs use $HOST_PORT, never a hardcoded numeric port', async () => {
    // The host port is derived at runtime from $ORCHESTRATOR_HOST_PORT (env
    // override), then `docker compose port orchestrator 3000`, then a
    // fallback default. Hardcoding any numeric port in a localhost: URL
    // would defeat the parameterization. This test guards against
    // regressing to `http://localhost:3000` (the original bug — wrong port)
    // or `http://localhost:3001` (the simple-fix port — re-hardcoded
    // instead of templated).
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(SCRIPT_PATH, 'utf-8');
    const lines = source.split('\n');
    const urlOffenders: Array<{ lineNum: number; text: string }> = [];
    // Match `localhost:NNNN/` — a URL path with a numeric port. The
    // templated form `localhost:${HOST_PORT}/` does not match this regex.
    const urlWithLiteralPort = /localhost:[0-9]+\//;
    lines.forEach((line, idx) => {
      if (urlWithLiteralPort.test(line)) {
        urlOffenders.push({ lineNum: idx + 1, text: line.trim() });
      }
    });
    assert.equal(
      urlOffenders.length,
      0,
      `start.sh URLs must use \${HOST_PORT}, not a hardcoded port:\n` +
        urlOffenders.map((o) => `  line ${o.lineNum}: ${o.text}`).join('\n'),
    );
  });

  it('still does not contain a localhost:3000 reference anywhere', async () => {
    // Container internally listens on 3000, but host-side script must never
    // address :3000 directly (compose publishes it on a different host port).
    // This is the original-bug regression guard.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(SCRIPT_PATH, 'utf-8');
    assert.doesNotMatch(source, /localhost:3000/);
  });

  it('uses HOST_PORT in the curl health check and dashboard URL', async () => {
    // Spot-check that the derivation is actually wired into the two
    // user-facing URLs. Catches the silent-revert failure mode where
    // someone reverts to a hardcoded URL but the literal-port regex above
    // still passes (e.g. they introduce another mechanism).
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(SCRIPT_PATH, 'utf-8');
    assert.match(source, /curl[^\n]*localhost:\$\{HOST_PORT\}\/api\/orchestrator\/status/);
    assert.match(source, /Dashboard:[^\n]*localhost:\$\{HOST_PORT\}\/dashboard/);
  });
});
