import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { createRouter, type RouteContext } from './routes.ts';
import { extractLinks, makePreview, parseManifestHours, buildManifest } from './manifest.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { AccountStore } from './accounts.ts';

describe('manifest helpers', () => {
  it('extracts urls and /pages paths without trailing punctuation or duplicates of the same url', () => {
    const links = extractLinks('Done: https://github.com/o/r/pull/7. See (https://x.io/a) and /pages/foo-bar, also [d](/pages/doc) https://x.io/pages/inner');
    assert.deepEqual(links, ['https://github.com/o/r/pull/7', 'https://x.io/a', '/pages/foo-bar', '/pages/doc', 'https://x.io/pages/inner']);
  });

  it('ignores a bare /pages and path-like text that is not a pages link', () => {
    assert.deepEqual(extractLinks('see /pages and src/pages/foo.ts and /pages/'), []);
  });

  it('collapses whitespace and truncates the preview with an ellipsis', () => {
    assert.equal(makePreview('a\n\n  b'), 'a b');
    const long = makePreview('x'.repeat(500));
    assert.equal(long.length, 200);
    assert.ok(long.endsWith('…'));
    assert.equal(makePreview('y'.repeat(200)).length, 200);
  });

  it('parses hours: default, clamp, and rejects garbage', () => {
    assert.equal(parseManifestHours(null), 36);
    assert.equal(parseManifestHours('12'), 12);
    assert.equal(parseManifestHours('0'), 1);
    assert.equal(parseManifestHours('9999'), 168);
    for (const bad of ['', 'abc', '-3', '1.5', '12h', '1e3']) assert.equal(parseManifestHours(bad), null, bad);
  });

  it('buckets null, empty and "general" topics together and skips rows with no agent', () => {
    const rows = buildManifest([
      { agent: 'a', topic: null, direction: 'to_agent', message: 'one', createdAt: '2026-01-01T00:00:01Z' },
      { agent: 'a', topic: '  ', direction: 'from_agent', message: 'two', createdAt: '2026-01-01T00:00:02Z' },
      { agent: 'a', topic: 'general', direction: 'to_agent', message: 'three', createdAt: '2026-01-01T00:00:03Z' },
      { agent: '', topic: 'x', direction: 'to_agent', message: 'no agent', createdAt: '2026-01-01T00:00:04Z' },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.topic, 'general');
    assert.equal(rows[0]!.messageCount, 3);
    assert.equal(rows[0]!.lastDirection, 'to_agent');
    assert.equal(rows[0]!.preview, 'three');
  });

  it('leaves out system lifecycle notices', () => {
    const rows = buildManifest([
      { agent: 'a', topic: 'lifecycle', direction: 'from_agent', message: '[system] Recycled', createdAt: '2026-01-01T00:00:02Z' },
      { agent: 'a', topic: 'work', direction: 'from_agent', message: 'done', createdAt: '2026-01-01T00:00:01Z' },
    ]);
    assert.deepEqual(rows.map((r) => r.topic), ['work']);
  });
});

describe('manifest (database)', () => {
  let tmpDir: string;
  let db: Database;
  const NOW = Date.parse('2026-10-07T12:00:00Z');

  /** Inserts a message and pins its created_at, which the app otherwise sets to the real now. */
  function put(agent: string, direction: 'to_agent' | 'from_agent', message: string, topic: string | undefined, at: string) {
    const m = db.addDashboardMessage(agent, direction, message, topic ? { topic } : undefined);
    db.rawDb.prepare('UPDATE dashboard_messages SET created_at = ? WHERE id = ?').run(at, m.id);
    return m;
  }

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-manifest-db-'));
    db = new Database(join(tmpDir, 'test.db'));
    put('old', 'to_agent', 'outside the window', 'stale', '2026-10-05T00:00:00Z');
    put('dev', 'to_agent', 'start work', 'feat', '2026-10-07T08:00:00Z');
    put('dev', 'from_agent', 'PR https://github.com/o/r/pull/9 and /pages/report', 'feat', '2026-10-07T09:00:00Z');
    put('dev', 'from_agent', 'again https://github.com/o/r/pull/9 plus ' + 'z'.repeat(400), 'feat', '2026-10-07T10:00:00Z');
    put('dev', 'to_agent', 'other thread', 'bug', '2026-10-07T07:00:00Z');
    put('rev', 'from_agent', 'untopiced', undefined, '2026-10-07T11:00:00Z');
    const withdrawn = put('rev', 'to_agent', 'oops', 'gone', '2026-10-07T11:30:00Z');
    db.rawDb.prepare('UPDATE dashboard_messages SET withdrawn = 1 WHERE id = ?').run(withdrawn.id);
  });
  after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns one row per agent and topic with a message in the window, newest first', () => {
    const rows = db.getManifest(36, NOW);
    assert.deepEqual(rows.map((r) => `${r.agent}/${r.topic}`), ['rev/general', 'dev/feat', 'dev/bug']);
  });

  it('excludes threads outside the window and widens with hours', () => {
    assert.ok(!db.getManifest(36, NOW).some((r) => r.agent === 'old'));
    assert.ok(db.getManifest(168, NOW).some((r) => r.agent === 'old'));
    assert.deepEqual(db.getManifest(1, NOW).map((r) => r.agent), ['rev']);
  });

  it('reports last direction, count, truncated preview and deduped links most recent first', () => {
    const feat = db.getManifest(36, NOW).find((r) => r.topic === 'feat')!;
    assert.equal(feat.messageCount, 3);
    assert.equal(feat.lastDirection, 'from_agent');
    assert.equal(feat.lastMessageAt, '2026-10-07T10:00:00Z');
    assert.equal(feat.preview.length, 200);
    assert.deepEqual(feat.links, ['https://github.com/o/r/pull/9', '/pages/report']);
  });

  it('labels a null topic general and ignores withdrawn messages', () => {
    const rev = db.getManifest(36, NOW).find((r) => r.agent === 'rev')!;
    assert.equal(rev.topic, 'general');
    assert.equal(rev.messageCount, 1);
  });

  it('uses the created_at index for the window filter', () => {
    const plan = db.rawDb.prepare("EXPLAIN QUERY PLAN SELECT agent FROM dashboard_messages WHERE created_at >= '2026-01-01T00:00:00Z'").all();
    assert.match(JSON.stringify(plan), /idx_dm_created/);
  });
});

describe('GET /api/manifest', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  const SECRET = 'manifest-secret';

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-manifest-route-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    const locks = new LockManager(db.rawDb);
    const dispatch = async () => ({ ok: true as const });
    const ctx = {
      db, wss, locks,
      proxyDispatch: dispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: SECRET,
      messageDispatcher: new MessageDispatcher({ db, locks, proxyDispatch: dispatch, orchestratorHost: 'http://localhost:3000' }),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
    } as unknown as RouteContext;
    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    }));
    db.addDashboardMessage('route-agent', 'to_agent', 'see /pages/x', { topic: 't' });
  });
  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const get = async (path: string, token?: string) => {
    const resp = await fetch(`http://localhost:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: resp.status, data: await resp.json() as any };
  };

  it('requires the bearer token', async () => {
    assert.equal((await get('/api/manifest')).status, 401);
    assert.equal((await get('/api/manifest', 'wrong')).status, 401);
  });

  it('returns thread rows with the documented shape', async () => {
    const { status, data } = await get('/api/manifest', SECRET);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(data[0]).sort(), ['agent', 'lastDirection', 'lastMessageAt', 'links', 'messageCount', 'preview', 'topic']);
    assert.equal(data[0].agent, 'route-agent');
    assert.deepEqual(data[0].links, ['/pages/x']);
  });

  it('rejects a non-numeric hours value and clamps an out-of-range one', async () => {
    assert.equal((await get('/api/manifest?hours=abc', SECRET)).status, 400);
    assert.equal((await get('/api/manifest?hours=-1', SECRET)).status, 400);
    assert.equal((await get('/api/manifest?hours=100000', SECRET)).status, 200);
  });
});
