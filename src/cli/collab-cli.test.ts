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

describe('collab decide', () => {
  it('rejects bad input before touching the network', () => {
    assert.equal(runCollab(['decide', '--topic', 't', 'q', '--bogus']).status, 2);
    assert.match(runCollab(['decide', '--topic', 't', 'q', '--option', 'bad key=x']).stderr, /--option must look like/);
    assert.equal(runCollab(['decide', '--topic', 't', 'q', '--option', 'a=x', '--recommend', 'b']).status, 2);
    assert.match(runCollab(['decide', 'q', '--option', 'a=x']).stderr, /usage: collab decide/);
    assert.match(runCollab(['decide', 'withdraw']).stderr, /usage: collab decide withdraw/);
  });

  it('sends the parsed decision to the orchestrator', async () => {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    let received: { method?: string; url?: string; body?: any } = {};
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        received = { method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 7, blocking: true, topic: 'issue-1' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const child = spawn(COLLAB_BIN, ['decide', '--topic', 'issue-1', 'Ship it?', '--option', 'a=Yes, behind a flag', '--option', 'b:No', '--recommend', 'a', '--blocking'], {
      env: { ...process.env, ORCHESTRATOR_URL: `http://127.0.0.1:${port}`, COLLAB_AGENT: 'frontend' },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const code = await new Promise((r) => child.on('close', r));
    server.close();
    assert.equal(code, 0, out);
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/decisions');
    assert.deepEqual(received.body, {
      agentName: 'frontend', topic: 'issue-1', question: 'Ship it?',
      options: [{ key: 'a', label: 'Yes, behind a flag' }, { key: 'b', label: 'No' }],
      recommended: 'a', blocking: true,
    });
    assert.match(out, /raised decision #7 \(blocking\)/);
  });
});

describe('collab reminder queue warnings', () => {
  // A fake orchestrator holding one agent's reminders, so the real CLI can be run against it.
  async function withServer(reminders: Array<Record<string, unknown>>, created: Record<string, unknown>, fn: (url: string) => Promise<void>) {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/reminders') { req.resume(); res.end(JSON.stringify(created)); return; }
      if (req.method === 'GET' && req.url?.startsWith('/api/reminders')) { res.end(JSON.stringify(reminders)); return; }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as { port: number };
    try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
  }

  async function collabAt(url: string, args: string[]) {
    const { spawn } = await import('node:child_process');
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
      const p = spawn(COLLAB_BIN, args, { env: { ...process.env, ORCHESTRATOR_URL: url, COLLAB_AGENT: 'test-runner' } });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (status) => resolveRun({ status, stdout, stderr }));
    });
  }

  const row = (id: number, sortOrder: number, extra: Record<string, unknown> = {}) => ({
    id, sortOrder, agentName: 'x', prompt: `task ${id}`, cadenceMinutes: 30, status: 'pending', lastDeliveredAt: null, ...extra,
  });

  it('should warn when a new reminder is queued behind others, naming them and suggesting a job', async () => {
    const top = row(10, 1, { lastDeliveredAt: '2026-10-01T09:00:00Z', cadenceMinutes: 1440 });
    const added = row(50, 5);
    await withServer([top, row(11, 2), added], added, async (url) => {
      const r = await collabAt(url, ['reminder', 'add', 'x', 'sweep', '--cadence', '30m']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /created reminder #50/);
      assert.match(r.stderr, /#50 is queued behind 2 pending reminder\(s\) for x \(#10, #11\)/);
      assert.match(r.stderr, /collab job add x "<prompt>" --cron "\*\/30 \* \* \* \*"/);
    });
  });

  it('should not warn when the new reminder is the only one, so it fires', async () => {
    const added = row(50, 1);
    await withServer([added], added, async (url) => {
      const r = await collabAt(url, ['reminder', 'add', 'x', 'sweep', '--cadence', '30m']);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /queued behind/);
    });
  });

  it('should mark the firing reminder, the waiting ones, and those never fired', async () => {
    const reminders = [row(10, 1, { lastDeliveredAt: '2026-10-01T09:00:00Z' }), row(11, 2), row(20, 1, { agentName: 'y' })];
    await withServer(reminders, {}, async (url) => {
      const r = await collabAt(url, ['reminder', 'list']);
      assert.equal(r.status, 0, r.stderr);
      const line = (id: number) => r.stdout.split('\n').find((l) => l.startsWith(`${id} `)) ?? '';
      assert.match(line(10), /firing$/);
      assert.match(line(11), /waiting, never fired$/);
      assert.match(line(20), /firing, never fired$/);
      assert.match(r.stdout, /Only the top pending reminder per agent fires/);
    });
  });
});
