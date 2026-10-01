import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { createRouter, type RouteContext } from './routes.ts';
import { updateLinkError } from './update-link.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { AccountStore } from './accounts.ts';
import type { Update, ProxyCommand, ProxyResponse } from '../shared/types.ts';

describe('updates (database)', () => {
  let tmpDir: string;
  let db: Database;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-updates-db-'));
    db = new Database(join(tmpDir, 'test.db'));
  });
  after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it('lists open updates newest first and counts the unseen ones', () => {
    const a = db.createUpdate({ agentName: 'x', title: 'first', link: '/pages/a' });
    const b = db.createUpdate({ agentName: 'y', title: 'second', link: 'https://example.com/b', summary: 's', topic: 't' });
    assert.deepEqual(db.listUpdates().map((u) => u.id), [b.id, a.id]);
    assert.equal(db.countUnseenOpenUpdates(), 2);
    assert.equal(db.getUpdate(b.id)?.summary, 's');
    assert.equal(db.getUpdate(a.id)?.topic, null);
  });

  it('marks seen once, done once, and reopen keeps it seen', () => {
    const u = db.createUpdate({ agentName: 'z', title: 'q', link: '/pages/q' });
    assert.equal(db.markUpdateSeen(u.id), true);
    assert.equal(db.markUpdateSeen(u.id), false);
    const done = db.markUpdateDone(u.id);
    assert.equal(done?.status, 'done');
    assert.ok(done?.doneAt);
    assert.equal(db.markUpdateDone(u.id), undefined);
    const reopened = db.reopenUpdate(u.id);
    assert.equal(reopened?.status, 'open');
    assert.equal(reopened?.doneAt, null);
    assert.ok(reopened?.seenAt);
    assert.equal(db.reopenUpdate(u.id), undefined);
  });

  it('done implies seen', () => {
    const u = db.createUpdate({ agentName: 'z', title: 'never opened', link: '/pages/n' });
    assert.ok(db.markUpdateDone(u.id)?.seenAt);
  });

  it('creates the table idempotently when the database is opened again', () => {
    const path = join(tmpDir, 'reopen.db');
    const first = new Database(path);
    first.createUpdate({ agentName: 'x', title: 'kept', link: '/pages/k' });
    first.close();
    const second = new Database(path);
    assert.deepEqual(second.listUpdates().map((u) => u.title), ['kept']);
    second.close();
  });
});

describe('updateLinkError', () => {
  it('accepts http, https and /pages/ links', () => {
    for (const ok of ['http://example.com', 'https://example.com/pr/1?x=1#y', 'HTTPS://EXAMPLE.COM', '/pages/review/index']) {
      assert.equal(updateLinkError(ok), null, ok);
    }
  });

  it('rejects every other form', () => {
    const bad = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '/etc/passwd',
      'pages/review',
      './pages/review',
      '../pages/review',
      '//evil.example.com/pages/x',
      '/pagesx/review',
      'ftp://example.com/x',
      'https://',
      'https://example.com/"onmouseover="alert(1)',
      "https://example.com/'x",
      'https://example.com/<b>',
      'https://example.com/a b',
      '/pages/a\\b',
      '',
      '   ',
      'https://example.com/' + 'x'.repeat(2000),
    ];
    for (const link of bad) assert.ok(updateLinkError(link), `should reject ${JSON.stringify(link)}`);
    assert.ok(updateLinkError(undefined));
    assert.ok(updateLinkError(42));
  });
});

describe('updates (routes)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  const broadcasts: string[] = [];

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-updates-routes-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    const origBroadcast = wss.broadcast.bind(wss);
    wss.broadcast = (data: string) => { broadcasts.push(data); origBroadcast(data); };
    const proxyDispatch = async (_id: string, _cmd: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);
    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: new MessageDispatcher({ db, locks, proxyDispatch, orchestratorHost: 'http://localhost:3000' }),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'homes'), skipAutoRegister: true }),
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
      filesDir: join(tmpDir, 'files'),
      telegramDispatcher: { send: async () => true } as any,
    };
    db.createAgent({ name: 'frontend', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    db.createAgent({ name: 'backend', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    }));
  });

  after(() => { wss.close(); server.close(); db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, data: await resp.json() };
  }

  function lastChange(): { updates: Update[]; unseenUpdates: number } | undefined {
    return broadcasts.map((b) => JSON.parse(b)).filter((b) => b.type === 'updates_change').pop();
  }

  const good = {
    agent: 'frontend',
    title: '  Review page for the cache fix  ',
    summary: 'Two findings, both minor',
    link: '/pages/cache-fix-review',
    topic: 'issue-42',
  };

  it('creates an update, posts it to the thread, and broadcasts the open list', async () => {
    broadcasts.length = 0;
    const { status, data } = await api('POST', '/api/updates', good);
    assert.equal(status, 201);
    assert.equal(data.status, 'open');
    assert.equal(data.title, 'Review page for the cache fix');
    assert.equal(data.agentName, 'frontend');
    assert.equal(data.seenAt, null);
    const thread = db.getDashboardThreads()['frontend'] ?? [];
    assert.ok(JSON.stringify(thread).includes(`[update #${data.id}] Review page for the cache fix`), 'thread entry');
    const change = lastChange();
    assert.ok(change, 'updates_change broadcast');
    assert.equal(change!.updates[0]!.id, data.id);
    assert.equal(change!.unseenUpdates, 1);
  });

  it('summary and topic are optional', async () => {
    const { status, data } = await api('POST', '/api/updates', { agent: 'backend', title: 'PR ready', link: 'https://example.com/pr/7' });
    assert.equal(status, 201);
    assert.equal(data.summary, null);
    assert.equal(data.topic, null);
  });

  it('rejects malformed input', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...good, agent: undefined }, /agent/],
      [{ ...good, title: undefined }, /title/],
      [{ ...good, title: '   ' }, /title/],
      [{ ...good, title: 'x'.repeat(201) }, /title/],
      [{ ...good, summary: 'x'.repeat(501) }, /summary/],
      [{ ...good, summary: 'two\nlines' }, /summary/],
      [{ ...good, topic: 'x'.repeat(81) }, /topic/],
      [{ ...good, link: undefined }, /link required/],
      [{ ...good, link: 'javascript:alert(1)' }, /http:\/\/ or https:\/\//],
      [{ ...good, link: 'data:text/html,hi' }, /http:\/\/ or https:\/\//],
      [{ ...good, link: 'review/index.html' }, /http:\/\/ or https:\/\//],
      [{ ...good, link: '/Users/someone/report.md' }, /http:\/\/ or https:\/\//],
      [{ ...good, link: 'https://example.com/"><script>' }, /quotes/],
    ];
    for (const [body, re] of cases) {
      const { status, data } = await api('POST', '/api/updates', body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.match(data.error, re);
    }
    assert.equal((await api('POST', '/api/updates', { ...good, agent: 'nobody' })).status, 404);
  });

  it('lists by status, newest first, and filters by agent', async () => {
    const a = (await api('POST', '/api/updates', { ...good, title: 'older' })).data as Update;
    const b = (await api('POST', '/api/updates', { ...good, title: 'newer' })).data as Update;
    await api('POST', `/api/updates/${a.id}/done`);
    const open = (await api('GET', '/api/updates')).data as Update[];
    assert.ok(open.every((u) => u.status === 'open'));
    assert.ok(!open.some((u) => u.id === a.id));
    const ids = open.map((u) => u.id);
    assert.deepEqual(ids, [...ids].sort((x, y) => y - x), 'newest first');
    assert.equal(ids[0], b.id);
    const done = (await api('GET', '/api/updates?status=done')).data as Update[];
    assert.ok(done.some((u) => u.id === a.id) && done.every((u) => u.status === 'done'));
    const all = (await api('GET', '/api/updates?status=all&agent=backend')).data as Update[];
    assert.ok(all.length >= 1 && all.every((u) => u.agentName === 'backend'));
    assert.equal((await api('GET', '/api/updates?status=bogus')).status, 400);
  });

  it('seen, done and reopen each move the update and broadcast', async () => {
    const created = (await api('POST', '/api/updates', good)).data as Update;
    const before = lastChange()!.unseenUpdates;

    broadcasts.length = 0;
    const seen = await api('POST', `/api/updates/${created.id}/seen`);
    assert.equal(seen.status, 200);
    assert.ok(seen.data.seenAt);
    assert.equal(lastChange()?.unseenUpdates, before - 1);

    broadcasts.length = 0;
    const seenAgain = await api('POST', `/api/updates/${created.id}/seen`);
    assert.equal(seenAgain.status, 200);
    assert.equal(lastChange(), undefined, 'a second seen changes nothing, so nothing is broadcast');

    broadcasts.length = 0;
    const done = await api('POST', `/api/updates/${created.id}/done`);
    assert.equal(done.status, 200);
    assert.equal(done.data.status, 'done');
    assert.ok(!lastChange()!.updates.some((u) => u.id === created.id), 'gone from the open list');
    assert.equal((await api('POST', `/api/updates/${created.id}/done`)).status, 409);

    broadcasts.length = 0;
    const reopened = await api('POST', `/api/updates/${created.id}/reopen`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.status, 'open');
    assert.equal(reopened.data.doneAt, null);
    assert.ok(lastChange()!.updates.some((u) => u.id === created.id), 'back in the open list');
    assert.equal((await api('POST', `/api/updates/${created.id}/reopen`)).status, 409);
  });

  it('unknown and malformed ids', async () => {
    for (const action of ['seen', 'done', 'reopen']) {
      assert.equal((await api('POST', `/api/updates/99999/${action}`)).status, 404, action);
      assert.equal((await api('POST', `/api/updates/abc/${action}`)).status, 400, action);
    }
  });
});
