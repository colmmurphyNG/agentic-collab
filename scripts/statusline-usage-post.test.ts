import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'statusline-usage-post.sh');

type Post = { auth: string | undefined; body: unknown };

describe('statusline-usage-post.sh', () => {
  let dir: string;
  let server: Server;
  let url: string;
  let posts: Post[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'statusline-usage-'));
    writeFileSync(join(dir, 'secret'), 'test-secret');
    posts = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        posts.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  function run(statusLine: unknown): void {
    const result = spawnSync('sh', [SCRIPT], {
      input: JSON.stringify(statusLine),
      env: {
        ...process.env,
        CONDUCTOR_URL: url,
        CONDUCTOR_SECRET_FILE: join(dir, 'secret'),
        CONDUCTOR_USAGE_CACHE_DIR: join(dir, 'cache'),
      },
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'must never print into the status line');
  }

  async function settle(expected: number): Promise<void> {
    for (let i = 0; i < 40 && posts.length < expected; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 150));
  }

  const limits = (week: number) => ({
    model: { display_name: 'Opus' },
    rate_limits: {
      five_hour: { used_percentage: 3, resets_at: 1793664000 },
      seven_day: { used_percentage: week, resets_at: 1793682000 },
    },
  });

  it('posts the rate limits with the bearer secret', async () => {
    run(limits(40));
    await settle(1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.auth, 'Bearer test-secret');
    assert.deepEqual(posts[0]!.body, { rate_limits: limits(40).rate_limits });
  });

  it('skips an unchanged reading, and posts again when it changes', async () => {
    run(limits(40));
    await settle(1);
    run(limits(40));
    await settle(2);
    assert.equal(posts.length, 1, 'identical reading within 15 minutes is not resent');
    run(limits(41));
    await settle(2);
    assert.equal(posts.length, 2);
  });

  it('resends an unchanged reading once the last send is over 15 minutes old', async () => {
    run(limits(40));
    await settle(1);
    const old = new Date(Date.now() - 16 * 60_000);
    utimesSync(join(dir, 'cache', 'statusline-rate-limits.json'), old, old);
    run(limits(40));
    await settle(2);
    assert.equal(posts.length, 2);
  });

  it('does nothing when the status line carries no rate limits', async () => {
    run({ model: { display_name: 'Opus' } });
    await settle(1);
    assert.equal(posts.length, 0);
  });
});
