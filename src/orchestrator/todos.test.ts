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

// To-dos: actions for the operator that came out of a decision. An option carrying steps opens
// one when it is chosen; marking it done notifies the raising agent on the decision's topic.

describe('todos (database)', () => {
  let tmpDir: string;
  let db: Database;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-todos-db-'));
    db = new Database(join(tmpDir, 'test.db'));
  });
  after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it('round-trips a decision-derived to-do, newest first', () => {
    const t = db.createTodo({
      agentName: 'frontend', title: 'check the order on stage BM',
      steps: 'stage BM, order 12345, compare the totals', decisionId: 42, topic: 'issue-42',
    });
    assert.deepEqual(db.getTodo(t.id)!, {
      id: t.id, agentName: 'frontend', title: 'check the order on stage BM',
      steps: 'stage BM, order 12345, compare the totals',
      decisionId: 42, topic: 'issue-42', status: 'open', createdAt: t.createdAt, doneAt: null,
    });
    const older = db.createTodo({ agentName: 'frontend', title: 'second' });
    assert.deepEqual(db.listTodos().map((x) => x.id), [older.id, t.id]);
    assert.equal(db.countOpenTodos(), 2);
  });

  it('closes once, and reopens once', () => {
    const t = db.createTodo({ agentName: 'x', title: 'one' });
    const done = db.markTodoDone(t.id);
    assert.equal(done?.status, 'done');
    assert.ok(done?.doneAt);
    assert.equal(db.markTodoDone(t.id), undefined);
    assert.equal(db.reopenTodo(t.id)?.status, 'open');
    assert.equal(db.reopenTodo(t.id), undefined);
    const openBefore = db.listTodos({ status: 'open' }).length;
    const doneBefore = db.listTodos({ status: 'done' }).length;
    db.markTodoDone(db.createTodo({ agentName: 'x', title: 'done one' }).id);
    assert.equal(db.listTodos({ status: 'open' }).length, openBefore, 'done takes it off the open list');
    assert.equal(db.listTodos({ status: 'done' }).length, doneBefore + 1);
  });
});

describe('todos (routes)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  const broadcasts: string[] = [];

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-todos-routes-'));
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

  it('a decision option may carry steps, and only up to 500 characters', async () => {
    const base = { agentName: 'frontend', topic: 'issue-42', question: 'Check the order?', options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No, but I will check' }] };
    const created = (await api('POST', '/api/decisions', { ...base, options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No, but I will check', steps: 'check the order on stage BM' }] })).data as Decision;
    assert.equal(created.options.find((o) => o.key === 'b')?.steps, 'check the order on stage BM');
    assert.equal(created.options.find((o) => o.key === 'a')?.steps ?? null, null);
    const long = await api('POST', '/api/decisions', { ...base, options: [{ key: 'a', label: 'Yes', steps: 'x'.repeat(501) }] });
    assert.equal(long.status, 400);
    assert.match(long.data.error, /at most 500/);
    const numberSteps = await api('POST', '/api/decisions', { ...base, options: [{ key: 'a', label: 'Yes', steps: 5 }] });
    assert.equal(numberSteps.status, 400);
  });

  it('choosing an option with steps opens a to-do; a plain choice or a text answer does not', async () => {
    broadcasts.length = 0;
    const created = (await api('POST', '/api/decisions', {
      agentName: 'frontend', topic: 'issue-42', question: 'Check the order?',
      options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'check the order on stage BM', steps: 'stage BM, order 12345' }],
    })).data as Decision;
    const answer = await api('POST', `/api/decisions/${created.id}/answer`, { choice: 'b', text: 'and reply here' });
    assert.equal(answer.status, 200);
    const todos = (await api('GET', '/api/todos')).data;
    assert.equal(todos.length, 1);
    assert.deepEqual(
      { ...todos[0], createdAt: undefined },
      { id: todos[0].id, agentName: 'frontend', title: 'check the order on stage BM', steps: 'stage BM, order 12345', decisionId: created.id, topic: 'issue-42', status: 'open', createdAt: undefined, doneAt: null },
    );
    // The answer tells the agent what opened, and the header count changed.
    const envelope = db.listPendingMessages('frontend').map((m) => m.envelope).find((e) => e.includes(`DECISION #${created.id}`)) ?? '';
    assert.match(envelope, new RegExp(`to-do item #${todos[0].id} opened for the operator`));
    assert.ok(broadcasts.map((b) => JSON.parse(b)).some((b) => b.type === 'todos_change' && b.openTodos === 1), 'todos_change broadcast on open');

    const plain = (await api('POST', '/api/decisions', {
      agentName: 'frontend', topic: 'issue-42', question: 'Plain?', options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }],
    })).data as Decision;
    await api('POST', `/api/decisions/${plain.id}/answer`, { choice: 'a' });
    const textOnly = (await api('POST', '/api/decisions', {
      agentName: 'frontend', topic: 'issue-42', question: 'Text only?', options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No, but I will check', steps: 'never mind' }],
    })).data as Decision;
    await api('POST', `/api/decisions/${textOnly.id}/answer`, { text: 'neither, talk to tl' });
    assert.equal((await api('GET', '/api/todos')).data.length, 1, 'only the action option opened one');
  });

  it('marking done notifies the raising agent on the decision topic; reopen works', async () => {
    broadcasts.length = 0;
    const created = (await api('POST', '/api/decisions', {
      agentName: 'frontend', topic: 'issue-42', question: 'Check the order?',
      options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'check the order on stage BM', steps: 'stage BM, order 12345' }],
    })).data as Decision;
    await api('POST', `/api/decisions/${created.id}/answer`, { choice: 'b' });
    const todo = (await api('GET', '/api/todos')).data[0];
    assert.equal((await api('POST', '/api/todos/99999/done')).status, 404);
    const done = await api('POST', `/api/todos/${todo.id}/done`);
    assert.equal(done.status, 200);
    assert.equal(done.data.status, 'done');
    assert.ok(done.data.doneAt);
    const pending = db.listPendingMessages('frontend').map((m) => m.envelope).find((e) => e.includes(`TO-DO #${todo.id} done`));
    assert.ok(pending, 'done notice enqueued');
    assert.ok(pending!.startsWith(`[from: dashboard, reply with collab send dashboard --topic issue-42]:`), pending);
    assert.match(pending!, new RegExp(`from decision #${created.id}`));
    assert.equal((await api('POST', `/api/todos/${todo.id}/done`)).status, 409);
    const openAfterDone = db.countOpenTodos();
    assert.ok(broadcasts.map((b) => JSON.parse(b)).some((b) => b.type === 'todos_change' && b.openTodos === openAfterDone), 'todos_change broadcast on done');

    const reopened = await api('POST', `/api/todos/${todo.id}/reopen`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.status, 'open');
    assert.equal((await api('POST', `/api/todos/${todo.id}/reopen`)).status, 409);
  });

  it('rejects an invalid status filter', async () => {
    assert.equal((await api('GET', '/api/todos?status=bogus')).status, 400);
    assert.equal((await api('GET', '/api/todos?status=all')).status, 200);
  });
});