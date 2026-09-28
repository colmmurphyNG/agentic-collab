import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { createRouter, type RouteContext } from './routes.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { AccountStore } from './accounts.ts';
import type { Decision, ProxyCommand, ProxyResponse } from '../shared/types.ts';

describe('decisions (database)', () => {
  let tmpDir: string;
  let db: Database;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-decisions-db-'));
    db = new Database(join(tmpDir, 'test.db'));
  });
  after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it('lists open decisions blocking first, then oldest first', () => {
    const a = db.createDecision({ agentName: 'x', topic: 't', question: 'first', options: [] });
    const b = db.createDecision({ agentName: 'y', topic: 't', question: 'second, blocking', options: [], blocking: true });
    const c = db.createDecision({ agentName: 'x', topic: 't', question: 'third', options: [] });
    assert.deepEqual(db.listDecisions().map((d) => d.id), [b.id, a.id, c.id]);
    assert.deepEqual(db.countOpenDecisionsByAgent(), { x: 2, y: 1 });
  });

  it('round-trips options and the recommendation, and refuses a recommendation that is not an option', () => {
    const d = db.createDecision({ agentName: 'x', topic: 't', question: 'q', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], recommended: 'b' });
    const got = db.getDecision(d.id)!;
    assert.deepEqual(got.options, [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]);
    assert.equal(got.recommended, 'b');
    assert.throws(() => db.createDecision({ agentName: 'x', topic: 't', question: 'q', options: [{ key: 'a', label: 'A' }], recommended: 'z' }), /not one of the option keys/);
  });

  it('closes a decision once only', () => {
    const d = db.createDecision({ agentName: 'z', topic: 't', question: 'q', options: [] });
    const first = db.closeDecision(d.id, 'answered', 'yes');
    assert.equal(first?.status, 'answered');
    assert.equal(first?.answer, 'yes');
    assert.ok(first?.answeredAt);
    assert.equal(db.closeDecision(d.id, 'answered', 'no'), undefined);
    assert.equal(db.getDecision(d.id)?.answer, 'yes');
    assert.equal(db.countOpenDecisionsByAgent()['z'], undefined);
  });
});

describe('decisions (routes)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  const broadcasts: string[] = [];

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-decisions-routes-'));
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
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: resp.status, data: await resp.json() };
  }

  const good = {
    agentName: 'frontend',
    topic: 'issue-42',
    question: 'Ship behind a flag?',
    options: [{ key: 'a', label: 'Yes, default off' }, { key: 'b', label: 'No' }],
    recommended: 'a',
    blocking: true,
  };

  it('creates a decision, posts it to the thread, and broadcasts the open list', async () => {
    broadcasts.length = 0;
    const { status, data } = await api('POST', '/api/decisions', good);
    assert.equal(status, 201);
    assert.equal(data.status, 'open');
    assert.equal(data.blocking, true);
    const thread = db.getDashboardThreads()['frontend'] ?? [];
    assert.ok(JSON.stringify(thread).includes(`[decision #${data.id}, blocking] Ship behind a flag?`), 'thread entry');
    const update = broadcasts.map((b) => JSON.parse(b)).find((b) => b.type === 'decision_update');
    assert.ok(update, 'decision_update broadcast');
    assert.equal(update.openDecisionsByAgent.frontend, 1);
  });

  it('rejects malformed input', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...good, agentName: undefined }, /agentName/],
      [{ ...good, topic: '' }, /topic/],
      [{ ...good, question: 'x'.repeat(2001) }, /question/],
      [{ ...good, options: [{ key: 'bad key', label: 'x' }] }, /key/],
      [{ ...good, options: [{ key: 'a', label: '' }] }, /label/],
      [{ ...good, options: [{ key: 'a', label: 'x' }, { key: 'a', label: 'y' }] }, /duplicate/],
      [{ ...good, recommended: 'z' }, /recommended/],
      [{ ...good, options: Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: 'x' })), recommended: null }, /at most 8/],
    ];
    for (const [body, re] of cases) {
      const { status, data } = await api('POST', '/api/decisions', body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.match(data.error, re);
    }
    assert.equal((await api('POST', '/api/decisions', { ...good, agentName: 'nobody' })).status, 404);
  });

  it('answering delivers a normal dashboard message to the agent and closes the decision once', async () => {
    const created = (await api('POST', '/api/decisions', { ...good, agentName: 'backend', topic: 'issue-9' })).data as Decision;
    const { status, data } = await api('POST', `/api/decisions/${created.id}/answer`, { choice: 'a', text: 'and add a test' });
    assert.equal(status, 200);
    assert.equal(data.status, 'answered');
    assert.equal(data.answer, '(a) Yes, default off — and add a test');
    const queued = db.listPendingMessages('backend');
    const envelope = queued.map((m) => m.envelope).find((e) => e.includes(`DECISION #${created.id}`));
    assert.ok(envelope, 'answer enqueued for the agent');
    assert.ok(envelope!.startsWith('[from: dashboard, reply with collab send dashboard --topic issue-9]:'), envelope);
    const again = await api('POST', `/api/decisions/${created.id}/answer`, { choice: 'b' });
    assert.equal(again.status, 409);
  });

  it('answer needs a valid choice or some text', async () => {
    const created = (await api('POST', '/api/decisions', good)).data as Decision;
    assert.equal((await api('POST', `/api/decisions/${created.id}/answer`, {})).status, 400);
    assert.equal((await api('POST', `/api/decisions/${created.id}/answer`, { choice: 'zz' })).status, 400);
    assert.equal((await api('POST', '/api/decisions/99999/answer', { text: 'x' })).status, 404);
    const textOnly = await api('POST', `/api/decisions/${created.id}/answer`, { text: 'neither, talk to tl' });
    assert.equal(textOnly.status, 200);
    assert.equal(textOnly.data.answer, 'neither, talk to tl');
  });

  it('only the raising agent can withdraw', async () => {
    const created = (await api('POST', '/api/decisions', good)).data as Decision;
    assert.equal((await api('POST', `/api/decisions/${created.id}/withdraw`, { agentName: 'backend' })).status, 403);
    const ok = await api('POST', `/api/decisions/${created.id}/withdraw`, { agentName: 'frontend' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.status, 'withdrawn');
    assert.equal((await api('POST', `/api/decisions/${created.id}/answer`, { choice: 'a' })).status, 409);
  });

  it('lists by status and agent', async () => {
    const open = (await api('GET', '/api/decisions')).data as Decision[];
    assert.ok(open.every((d) => d.status === 'open'));
    const all = (await api('GET', '/api/decisions?status=all&agent=backend')).data as Decision[];
    assert.ok(all.length >= 1 && all.every((d) => d.agentName === 'backend'));
    assert.equal((await api('GET', '/api/decisions?status=bogus')).status, 400);
  });
});
