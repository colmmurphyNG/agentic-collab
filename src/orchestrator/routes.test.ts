import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { createRouter, routeTelegramMessage, type RouteContext } from './routes.ts';
import type { TelegramDispatcher } from './telegram.ts';
import { WebSocketServer } from '../shared/websocket-server.ts';

/**
 * Stub TelegramDispatcher — no-ops everything so tests don't hit api.telegram.org
 * or spawn the long-polling loop (which would prevent the process from exiting).
 */
function makeStubTelegramDispatcher(): TelegramDispatcher {
  return {
    startPolling: () => {},
    stopPolling: () => {},
    send: async () => true,
  } as unknown as TelegramDispatcher;
}
import { LockManager } from '../shared/lock.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { AccountStore } from './accounts.ts';
import type { DestinationRecord, ProxyCommand, ProxyResponse } from '../shared/types.ts';

/** Helper to build a MessageDispatcher for tests */
function makeTestDispatcher(db: Database, locks: LockManager, proxyDispatch: (id: string, cmd: ProxyCommand) => Promise<ProxyResponse>): MessageDispatcher {
  return new MessageDispatcher({ db, locks, proxyDispatch, orchestratorHost: 'http://localhost:3000' });
}

describe('API Routes', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let proxyCommands: ProxyCommand[];

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-routes-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    proxyCommands = [];

    const mockProxyDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      proxyCommands.push(command);
      if (command.action === 'capture') {
        return { ok: true, data: '> prompt\n' };
      }
      if (command.action === 'display_message') {
        return { ok: true, data: '#{session_name}:0.0' };
      }
      if (command.action === 'has_session') {
        return { ok: true, data: true };
      }
      return { ok: true };
    };

    const locks = new LockManager(db.rawDb);
    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html><body>Dashboard</body></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null, // no auth for base tests
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  // ── Dashboard ──

  it('GET /dashboard serves HTML', async () => {
    const resp = await fetch(`http://localhost:${port}/dashboard`);
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes('Dashboard'));
  });

  // ── Agent CRUD ──

  it('POST /api/agents creates an agent', async () => {
    const { status, data } = await api('POST', '/api/agents', {
      name: 'api-agent-1',
      engine: 'claude',
      model: 'opus',
      thinking: 'high',
      cwd: '/tmp/test',
      proxyId: 'proxy-test',
    });
    assert.equal(status, 201);
    assert.equal((data as Record<string, unknown>).name, 'api-agent-1');
    assert.equal((data as Record<string, unknown>).state, 'void');
  });

  it('POST /api/agents accepts optional group field', async () => {
    const { status, data } = await api('POST', '/api/agents', {
      name: 'api-agent-grouped',
      engine: 'claude',
      cwd: '/tmp/test',
      group: 'infra',
    });
    assert.equal(status, 201);
    assert.equal((data as Record<string, unknown>).agentGroup, 'infra');
  });

  it('PATCH /api/agents/:name/group updates and returns the agent', async () => {
    // Ensure agent exists (created in earlier test)
    const { status, data } = await api('PATCH', '/api/agents/api-agent-grouped/group', { group: 'platform' });
    assert.equal(status, 200);
    // Verify the group actually persisted
    const { data: agent } = await api('GET', '/api/agents/api-agent-grouped');
    assert.equal((agent as Record<string, unknown>).agentGroup, 'platform');
  });

  it('PATCH /api/agents/:name/group returns 404 for unknown agent', async () => {
    const { status } = await api('PATCH', '/api/agents/nonexistent-agent/group', { group: 'x' });
    assert.equal(status, 404);
  });

  it('POST /api/agents rejects duplicate', async () => {
    const { status } = await api('POST', '/api/agents', {
      name: 'api-agent-1',
      engine: 'claude',
      cwd: '/tmp',
    });
    assert.equal(status, 409);
  });

  it('POST /api/agents validates required fields', async () => {
    const { status } = await api('POST', '/api/agents', { name: 'no-engine' });
    assert.equal(status, 400);
  });

  it('GET /api/agents lists agents', async () => {
    const { status, data } = await api('GET', '/api/agents');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    assert.ok((data as Array<Record<string, unknown>>).some(a => a.name === 'api-agent-1'));
  });

  it('GET /api/agents/:name retrieves single agent', async () => {
    const { status, data } = await api('GET', '/api/agents/api-agent-1');
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).name, 'api-agent-1');
  });

  it('GET /api/agents/:name returns 404 for missing', async () => {
    const { status } = await api('GET', '/api/agents/nope');
    assert.equal(status, 404);
  });

  it('agent state can be updated via DB for test setup', () => {
    const agent = db.getAgent('api-agent-1')!;
    const updated = db.updateAgentState('api-agent-1', 'active', agent.version, {
      tmuxSession: 'agent-api-agent-1',
    });
    assert.equal(updated.state, 'active');
    assert.equal(updated.tmuxSession, 'agent-api-agent-1');
  });

  it('DELETE /api/agents/:name deletes agent', async () => {
    await api('POST', '/api/agents', { name: 'del-agent', engine: 'claude', cwd: '/tmp' });
    const { status } = await api('DELETE', '/api/agents/del-agent');
    assert.equal(status, 200);

    const { status: s2 } = await api('GET', '/api/agents/del-agent');
    assert.equal(s2, 404);
  });

  // ── Dashboard Messages ──

  it('POST /api/dashboard/send enqueues message', async () => {
    // Register a proxy first
    db.registerProxy('proxy-test', 'tok', 'localhost:3100');

    const { status, data } = await api('POST', '/api/dashboard/send', {
      agent: 'api-agent-1',
      message: 'Hello from dashboard',
      topic: 'testing',
    });
    assert.equal(status, 202);
    assert.ok((data as Record<string, unknown>).ok);
    assert.ok((data as Record<string, unknown>).queueId);
    assert.equal((data as Record<string, unknown>).status, 'pending');
  });

  it('POST /api/dashboard/reply stores reply', async () => {
    const { status, data } = await api('POST', '/api/dashboard/reply', {
      agent: 'api-agent-1',
      message: 'Reply from agent',
      topic: 'testing',
    });
    assert.equal(status, 200);
    const msg = (data as Record<string, unknown>).msg as Record<string, unknown>;
    assert.equal(msg.direction, 'from_agent');
  });

  it('GET /api/dashboard/threads returns threads', async () => {
    const { status, data } = await api('GET', '/api/dashboard/threads');
    assert.equal(status, 200);
    const threads = data as Record<string, Array<Record<string, unknown>>>;
    assert.ok(threads['api-agent-1']);
    assert.ok(threads['api-agent-1']!.length >= 2);
  });

  it('GET /api/dashboard/threads?agent= filters by agent', async () => {
    const { status, data } = await api('GET', '/api/dashboard/threads?agent=api-agent-1');
    assert.equal(status, 200);
    const threads = data as Record<string, Array<Record<string, unknown>>>;
    assert.ok(threads['api-agent-1']);
  });

  // ── Read Cursor ──

  it('PUT /api/dashboard/read-cursor updates cursor', async () => {
    const { status, data } = await api('PUT', '/api/dashboard/read-cursor', { agent: 'api-agent-1' });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).ok, true);
  });

  it('PUT /api/dashboard/read-cursor rejects missing agent', async () => {
    const { status } = await api('PUT', '/api/dashboard/read-cursor', {});
    assert.equal(status, 400);
  });

  // ── Agent Actions ──

  it('POST /api/agents/:name/interrupt sends escape keys', async () => {
    proxyCommands = [];
    const { status } = await api('POST', '/api/agents/api-agent-1/interrupt');
    assert.equal(status, 200);
    assert.ok(proxyCommands.some(c => c.action === 'send_keys'));
  });

  it('POST /api/agents/:name/compact sends compact command', async () => {
    proxyCommands = [];
    const { status } = await api('POST', '/api/agents/api-agent-1/compact');
    assert.equal(status, 200);
    assert.ok(proxyCommands.some(c => c.action === 'paste'));
  });

  it('POST /api/agents/:name/kill kills session', async () => {
    proxyCommands = [];
    const { status } = await api('POST', '/api/agents/api-agent-1/kill');
    assert.equal(status, 200);
    assert.ok(proxyCommands.some(c => c.action === 'kill_session'));

    // Agent should be suspended after kill
    const agent = db.getAgent('api-agent-1');
    assert.equal(agent?.state, 'suspended');
  });

  // ── Proxy Registration ──

  it('POST /api/proxy/register registers proxy', async () => {
    const { status, data } = await api('POST', '/api/proxy/register', {
      proxyId: 'new-proxy',
      token: 'new-token',
      host: 'localhost:3200',
    });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).proxyId, 'new-proxy');
  });

  it('POST /api/proxy/register includes version match info', async () => {
    const { status, data } = await api('POST', '/api/proxy/register', {
      proxyId: 'versioned-proxy',
      token: 'v-token',
      host: 'localhost:3300',
      version: 'test-sha-abc',
    });
    assert.equal(status, 200);
    const result = data as Record<string, unknown>;
    assert.equal(result['proxyId'], 'versioned-proxy');
    assert.equal(result['version'], 'test-sha-abc');
    // orchestratorVersion should be present in response
    assert.ok('orchestratorVersion' in result);
    // versionMatch should be false since test-sha-abc won't match
    assert.equal(result['versionMatch'], false);
  });

  it('POST /api/proxy/register without version sets versionMatch false', async () => {
    const { status, data } = await api('POST', '/api/proxy/register', {
      proxyId: 'no-version-proxy',
      token: 'nv-token',
      host: 'localhost:3400',
    });
    assert.equal(status, 200);
    const result = data as Record<string, unknown>;
    assert.equal(result['version'], null);
    assert.equal(result['versionMatch'], false);
  });

  it('POST /api/proxy/heartbeat updates heartbeat', async () => {
    const { status } = await api('POST', '/api/proxy/heartbeat', { proxyId: 'new-proxy' });
    assert.equal(status, 200);
  });

  it('POST /api/proxy/heartbeat rejects unknown proxy', async () => {
    const { status } = await api('POST', '/api/proxy/heartbeat', { proxyId: 'unknown' });
    assert.equal(status, 404);
  });

  it('GET /api/proxies lists proxies', async () => {
    const { status, data } = await api('GET', '/api/proxies');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('DELETE /api/proxy/:proxyId removes proxy', async () => {
    const { status } = await api('DELETE', '/api/proxy/new-proxy');
    assert.equal(status, 200);
    const proxy = db.getProxy('new-proxy');
    assert.equal(proxy, undefined);
  });

  // ── Events ──

  it('GET /api/events/:agentName returns events', async () => {
    const { status, data } = await api('GET', '/api/events/api-agent-1');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  // ── 404 ──

  it('returns 404 for unknown routes', async () => {
    const { status } = await api('GET', '/api/nonexistent');
    assert.equal(status, 404);
  });

  // ── Inter-agent messaging ──

  it('POST /api/agents/send enqueues message', async () => {
    // Need agent with proxy and tmux session
    db.updateAgentState('api-agent-1', 'active', db.getAgent('api-agent-1')!.version, {
      proxyId: 'proxy-test',
      tmuxSession: 'agent-api-agent-1',
    });

    const { status, data } = await api('POST', '/api/agents/send', {
      from: 'dashboard',
      to: 'api-agent-1',
      message: 'Test inter-agent message',
      topic: 'test-topic',
    });

    assert.equal(status, 202);
    assert.ok((data as Record<string, unknown>).messageId);
    assert.ok((data as Record<string, unknown>).queueId);
    assert.equal((data as Record<string, unknown>).status, 'pending');
    const queued = db.listPendingMessages('api-agent-1');
    assert.ok(queued.some(m => m.envelope.includes('collab send dashboard --topic test-topic')));
  });

  it('POST /api/agents/send rejects unknown target', async () => {
    const { status } = await api('POST', '/api/agents/send', {
      from: 'a',
      to: 'nonexistent',
      message: 'hello',
      topic: 'test-topic',
    });
    assert.equal(status, 404);
  });

  it('GET /api/queue returns queued messages', async () => {
    const { status, data } = await api('GET', '/api/queue?agent=api-agent-1');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    assert.ok((data as Array<Record<string, unknown>>).length > 0);
  });

  it('POST /api/agents/:name/tmux maps send-keys through the proxy', async () => {
    proxyCommands = [];
    const { status, data } = await api('POST', '/api/agents/api-agent-1/tmux', {
      args: ['send-keys', '/exit', 'Enter'],
    });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).ok, true);
    assert.deepEqual(proxyCommands.at(-1), {
      action: 'send_keys_raw',
      sessionName: 'agent-api-agent-1',
      keys: ['/exit', 'Enter'],
    });
  });

  it('POST /api/agents/:name/tmux maps display-message through the proxy', async () => {
    proxyCommands = [];
    const { status, data } = await api('POST', '/api/agents/api-agent-1/tmux', {
      args: ['display-message', '-p', '#{session_name}:#{window_index}.#{pane_index}'],
    });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).data, '#{session_name}:0.0');
    assert.deepEqual(proxyCommands.at(-1), {
      action: 'display_message',
      sessionName: 'agent-api-agent-1',
      format: '#{session_name}:#{window_index}.#{pane_index}',
    });
  });

  it('POST /api/agents/:name/tmux rejects unsupported commands', async () => {
    const { status } = await api('POST', '/api/agents/api-agent-1/tmux', {
      args: ['list-sessions'],
    });
    assert.equal(status, 400);
  });

  // ── Lifecycle Routes ──

  it('POST /api/agents/:name/exit exits (suspends) active agent', async () => {
    // Ensure agent is active
    const a = db.getAgent('api-agent-1');
    if (a && a.state !== 'active') {
      db.updateAgentState('api-agent-1', 'active', a.version, {
        proxyId: 'proxy-test',
        tmuxSession: 'agent-api-agent-1',
      });
    }

    const { status, data } = await api('POST', '/api/agents/api-agent-1/exit');
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).state, 'suspended');
  });

  it('POST /api/agents/:name/resume resumes suspended agent', async () => {
    const { status, data } = await api('POST', '/api/agents/api-agent-1/resume');
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).state, 'active');
  });

  it('POST /api/agents/:name/reload queues reload (non-immediate)', async () => {
    const { status, data } = await api('POST', '/api/agents/api-agent-1/reload', {
      task: 'check this',
    });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).reloadQueued, 1);
  });

  it('POST /api/agents/:name/destroy removes agent', async () => {
    // Create a disposable agent
    await api('POST', '/api/agents', { name: 'to-destroy', engine: 'claude', cwd: '/tmp' });

    const { status } = await api('POST', '/api/agents/to-destroy/destroy');
    assert.equal(status, 200);

    const { status: s2 } = await api('GET', '/api/agents/to-destroy');
    assert.equal(s2, 404);
  });

  // ── Orchestrator Control ──

  it('GET /api/orchestrator/status returns stats', async () => {
    const { status, data } = await api('GET', '/api/orchestrator/status');
    assert.equal(status, 200);
    assert.ok(typeof (data as Record<string, unknown>).totalAgents === 'number');
  });

  it('POST /api/orchestrator/shutdown suspends running agents', async () => {
    const { status, data } = await api('POST', '/api/orchestrator/shutdown');
    assert.equal(status, 200);
    assert.ok(typeof (data as Record<string, unknown>).suspended === 'number');
  });

  it('POST /api/orchestrator/restore restores agents', async () => {
    const { status, data } = await api('POST', '/api/orchestrator/restore');
    assert.equal(status, 200);
    assert.ok(typeof (data as Record<string, unknown>).restored === 'number');
  });
});

describe('API Routes — Auth', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  const SECRET = 'test-secret-xyz';

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-auth-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const authLocks = new LockManager(db.rawDb);
    const authDispatch = async () => ({ ok: true as const });
    const ctx: RouteContext = {
      db,
      wss,
      locks: authLocks,
      proxyDispatch: authDispatch,
      getDashboardHtml: () => '<html>Dashboard</html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: SECRET,
      messageDispatcher: makeTestDispatcher(db, authLocks, authDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function apiAuth(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (token) headers['authorization'] = `Bearer ${token}`;

    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it('GET requests bypass auth', async () => {
    const { status } = await apiAuth('GET', '/api/agents');
    assert.equal(status, 200);
  });

  it('POST without token returns 401', async () => {
    const { status } = await apiAuth('POST', '/api/agents', {
      name: 'auth-test', engine: 'claude', cwd: '/tmp',
    });
    assert.equal(status, 401);
  });

  it('POST with wrong token returns 401', async () => {
    const { status } = await apiAuth('POST', '/api/agents', {
      name: 'auth-test', engine: 'claude', cwd: '/tmp',
    }, 'wrong-secret');
    assert.equal(status, 401);
  });

  it('POST with correct token succeeds', async () => {
    const { status } = await apiAuth('POST', '/api/agents', {
      name: 'auth-test', engine: 'claude', cwd: '/tmp',
    }, SECRET);
    assert.equal(status, 201);
  });

  it('DELETE with correct token succeeds', async () => {
    const { status } = await apiAuth('DELETE', '/api/agents/auth-test', undefined, SECRET);
    assert.equal(status, 200);
  });

  it('DELETE without token returns 401', async () => {
    const { status } = await apiAuth('DELETE', '/api/agents/auth-test');
    assert.equal(status, 401);
  });
});

describe('API Routes — Rate Limiting', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  const SECRET = 'rate-limit-secret';

  before(async () => {
    // Override rate limit env for testing: very low limits
    process.env['RATE_LIMIT_MAX'] = '5';
    process.env['RATE_LIMIT_UPLOAD_MAX'] = '3';
    process.env['RATE_LIMIT_WINDOW_MS'] = '60000';

    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-rate-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const rateLocks = new LockManager(db.rawDb);
    const rateDispatch = async () => ({ ok: true as const });
    const ctx: RouteContext = {
      db,
      wss,
      locks: rateLocks,
      proxyDispatch: rateDispatch,
      getDashboardHtml: () => '<html>Dashboard</html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: SECRET,
      messageDispatcher: makeTestDispatcher(db, rateLocks, rateDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['RATE_LIMIT_MAX'];
    delete process.env['RATE_LIMIT_UPLOAD_MAX'];
    delete process.env['RATE_LIMIT_WINDOW_MS'];
  });

  it('GET requests are not rate limited', async () => {
    // GET should work unlimited times
    for (let i = 0; i < 10; i++) {
      const resp = await fetch(`http://localhost:${port}/api/agents`);
      assert.equal(resp.status, 200);
    }
  });

  it('unauthenticated POST requests are rejected with 401 before rate limit applies', async () => {
    // Should get 401, not 429
    const resp = await fetch(`http://localhost:${port}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', engine: 'claude', cwd: '/tmp' }),
    });
    assert.equal(resp.status, 401);
  });
});

describe('API Routes — Personas', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let personasDir: string;
  let prevPersonasHostDir: string | undefined;

  before(async () => {
    // realpathSync resolves macOS `/var/folders` → `/private/var/folders` so the
    // path the route handler returns matches the path the test built. Without
    // this, the basename check would compare the symlinked vs canonical halves.
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-persona-route-test-')));
    personasDir = join(tmpDir, 'personas');
    process.env['PERSONAS_DIR'] = personasDir;
    // Save + clear PERSONAS_HOST_DIR so `toHostPath()` returns the container
    // path verbatim during the test. In a real running container this env var
    // remaps `/app/persistent-personas` to the host's mount; in the test we
    // want the path to stay anchored to the tmpDir we just created.
    prevPersonasHostDir = process.env['PERSONAS_HOST_DIR'];
    delete process.env['PERSONAS_HOST_DIR'];
    mkdtempSync; // force eval
    const { mkdirSync } = await import('node:fs');
    mkdirSync(personasDir, { recursive: true });

    writeFileSync(join(personasDir, 'researcher.md'), '# Researcher\nYou are a research agent.');
    writeFileSync(join(personasDir, 'builder.md'), '# Builder\nYou build things.');

    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const personaLocks = new LockManager(db.rawDb);
    const personaDispatch = async () => ({ ok: true as const });
    const ctx: RouteContext = {
      db,
      wss,
      locks: personaLocks,
      proxyDispatch: personaDispatch,
      getDashboardHtml: () => '<html>Dashboard</html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: makeTestDispatcher(db, personaLocks, personaDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => {
      await router(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    delete process.env['PERSONAS_DIR'];
    if (prevPersonasHostDir !== undefined) {
      process.env['PERSONAS_HOST_DIR'] = prevPersonasHostDir;
    }
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it('GET /api/personas lists persona files', async () => {
    const { status, data } = await api('GET', '/api/personas');
    assert.equal(status, 200);
    const personas = data as Array<{ name: string; filename: string }>;
    assert.equal(personas.length, 2);
    assert.equal(personas[0]!.name, 'builder');
    assert.equal(personas[1]!.name, 'researcher');
  });

  it('GET /api/personas/:name returns persona content', async () => {
    const { status, data } = await api('GET', '/api/personas/researcher');
    assert.equal(status, 200);
    const persona = data as { name: string; content: string };
    assert.equal(persona.name, 'researcher');
    assert.ok(persona.content.includes('research agent'));
  });

  it('GET /api/personas/:name includes filePath and hostname', async () => {
    const { status, data } = await api('GET', '/api/personas/researcher');
    assert.equal(status, 200);
    const persona = data as { filePath: string; hostname: string };
    assert.ok(persona.filePath.endsWith('/researcher.md'), `expected filePath ending with /researcher.md, got: ${persona.filePath}`);
    // personasDir may differ from the resolved filePath due to symlinks (e.g., /tmp → /private/tmp on macOS)
    const personasDirBasename = personasDir.split('/').pop()!;
    assert.ok(persona.filePath.includes(personasDirBasename), 'filePath should include personas dir basename');
    assert.equal(typeof persona.hostname, 'string');
    assert.ok(persona.hostname.length > 0, 'hostname should not be empty');
  });

  it('GET /api/personas/:name returns 404 for missing persona', async () => {
    const { status } = await api('GET', '/api/personas/nonexistent');
    assert.equal(status, 404);
  });

  it('GET /api/personas/:name rejects invalid names', async () => {
    const { status } = await api('GET', '/api/personas/..etc');
    assert.equal(status, 400);
  });

  it('PUT /api/personas/:name creates a new persona', async () => {
    const { status, data } = await api('PUT', '/api/personas/tester', {
      content: '# Tester\nYou test things.',
    });
    assert.equal(status, 200);
    const persona = data as { name: string; content: string };
    assert.equal(persona.name, 'tester');
    assert.ok(persona.content.includes('test things'));

    // Verify it shows up in list
    const { data: list } = await api('GET', '/api/personas');
    const personas = list as Array<{ name: string }>;
    assert.ok(personas.some(p => p.name === 'tester'));
  });

  it('PUT /api/personas/:name updates an existing persona', async () => {
    const { status, data } = await api('PUT', '/api/personas/builder', {
      content: '# Builder v2\nYou build better things.',
    });
    assert.equal(status, 200);
    const persona = data as { name: string; content: string };
    assert.ok(persona.content.includes('better things'));
  });

  it('PUT /api/personas/:name rejects missing content', async () => {
    const { status } = await api('PUT', '/api/personas/bad', {});
    assert.equal(status, 400);
  });

  it('PUT /api/personas/:name rejects invalid names', async () => {
    const { status } = await api('PUT', '/api/personas/..etc', {
      content: 'evil',
    });
    assert.equal(status, 400);
  });

  it('POST /api/personas creates persona file and agent atomically', async () => {
    const content = '---\nengine: claude\nmodel: opus\ncwd: /my-project\n---\n# Atomic Agent\nDoes atomic things.';
    const { status, data } = await api('POST', '/api/personas', { name: 'atomic-agent', content });
    assert.equal(status, 201);

    const result = data as { persona: { name: string; frontmatter: Record<string, string> }; agent: { name: string; engine: string; cwd: string; state: string } };
    assert.equal(result.persona.name, 'atomic-agent');
    assert.equal(result.persona.frontmatter.engine, 'claude');
    assert.equal(result.agent.name, 'atomic-agent');
    assert.equal(result.agent.engine, 'claude');
    assert.equal(result.agent.cwd, '/my-project');
    assert.equal(result.agent.state, 'void');

    // Verify file exists via GET
    const { status: getStatus, data: getData } = await api('GET', '/api/personas/atomic-agent');
    assert.equal(getStatus, 200);
    assert.ok((getData as { content: string }).content.includes('Atomic Agent'));

    // Verify agent is in agent list
    const { data: agents } = await api('GET', '/api/agents');
    const agentList = agents as Array<{ name: string }>;
    assert.ok(agentList.some(a => a.name === 'atomic-agent'));
  });

  it('POST /api/personas updates existing agent on re-create', async () => {
    const content = '---\nengine: claude\nmodel: sonnet\ncwd: /my-project-v2\n---\n# Atomic Agent v2';
    const { status, data } = await api('POST', '/api/personas', { name: 'atomic-agent', content });
    assert.equal(status, 201);

    const result = data as { agent: { model: string; cwd: string } };
    assert.equal(result.agent.model, 'sonnet');
    assert.equal(result.agent.cwd, '/my-project-v2');
  });

  it('POST /api/personas rejects missing name', async () => {
    const { status } = await api('POST', '/api/personas', { content: '---\nengine: claude\ncwd: /tmp\n---\nBody' });
    assert.equal(status, 400);
  });

  it('POST /api/personas rejects missing content', async () => {
    const { status } = await api('POST', '/api/personas', { name: 'test' });
    assert.equal(status, 400);
  });

  it('POST /api/personas rejects invalid name', async () => {
    const { status } = await api('POST', '/api/personas', { name: '../escape', content: '---\nengine: claude\ncwd: /tmp\n---\n' });
    assert.equal(status, 400);
  });

  it('POST /api/personas rejects content missing required frontmatter', async () => {
    const { status, data } = await api('POST', '/api/personas', { name: 'bad-fm', content: '# No frontmatter' });
    assert.equal(status, 400);
    assert.ok((data as { error: string }).error.includes('engine and cwd are required'));
  });

  it('POST /api/agents/:name/reload syncs persona from disk before reloading', async () => {
    // Create agent via persona with engine: claude
    const initial = '---\nengine: claude\ncwd: /tmp/sync-test\n---\n# Sync Agent\nOriginal.';
    await api('POST', '/api/personas', { name: 'sync-test-agent', content: initial });

    // Verify agent was created with engine=claude
    const { data: before } = await api('GET', '/api/agents/sync-test-agent');
    assert.equal((before as Record<string, unknown>).engine, 'claude');

    // Update persona file on disk to engine: codex
    writeFileSync(
      join(personasDir, 'sync-test-agent.md'),
      '---\nengine: codex\ncwd: /tmp/sync-test\n---\n# Sync Agent\nUpdated to codex.',
    );

    // Reload — this should sync persona from disk first, updating engine in DB
    // Agent is in void state so reload will fail, but syncSinglePersona runs before the lifecycle call
    await api('POST', '/api/agents/sync-test-agent/reload', {});

    // Verify engine was updated in DB regardless of reload outcome
    const { data: after } = await api('GET', '/api/agents/sync-test-agent');
    assert.equal((after as Record<string, unknown>).engine, 'codex');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Destinations + Telegram routing
// ─────────────────────────────────────────────────────────────────────────────

describe('API Routes — Destinations', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-dest-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const mockProxyDispatch = async (_proxyId: string, _command: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);

    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      telegramDispatcher: makeStubTelegramDispatcher(),
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it('POST /api/destinations accepts a telegram destination with defaultAgent in config', async () => {
    const { status, data } = await api('POST', '/api/destinations', {
      name: 'tg-with-default',
      type: 'telegram',
      config: { botToken: 'fake:token', chatId: '12345', defaultAgent: 'team-lead' },
    });
    assert.equal(status, 201);
    const config = (data as { config: Record<string, unknown> }).config;
    assert.equal(config['defaultAgent'], 'team-lead');
    assert.equal(config['botToken'], 'fake:token');
  });

  it('PATCH /api/destinations/:name updates the config in place', async () => {
    await api('POST', '/api/destinations', {
      name: 'tg-patch-test',
      type: 'telegram',
      config: { botToken: 'fake:token', chatId: '12345' },
    });

    const { status, data } = await api('PATCH', '/api/destinations/tg-patch-test', {
      config: { botToken: 'fake:token', chatId: '12345', defaultAgent: 'team-lead' },
    });
    assert.equal(status, 200);
    assert.equal((data as { config: Record<string, unknown> }).config['defaultAgent'], 'team-lead');
  });

  it('PATCH /api/destinations/:name updates the enabled flag in place', async () => {
    await api('POST', '/api/destinations', {
      name: 'tg-enable-test',
      type: 'telegram',
      config: { botToken: 'fake:token', chatId: '12345' },
    });

    const { status, data } = await api('PATCH', '/api/destinations/tg-enable-test', {
      enabled: false,
    });
    assert.equal(status, 200);
    assert.equal((data as { enabled: boolean }).enabled, false);
  });

  it('PATCH /api/destinations/:name rejects empty body', async () => {
    await api('POST', '/api/destinations', {
      name: 'tg-empty-patch',
      type: 'telegram',
      config: { botToken: 'fake:token', chatId: '12345' },
    });

    const { status, data } = await api('PATCH', '/api/destinations/tg-empty-patch', {});
    assert.equal(status, 400);
    assert.match((data as { error: string }).error, /At least one of/);
  });

  it('PATCH /api/destinations/:name returns 404 for missing destination', async () => {
    const { status } = await api('PATCH', '/api/destinations/no-such-destination', {
      config: { botToken: 'x', chatId: '1' },
    });
    assert.equal(status, 404);
  });

  it('PATCH /api/destinations/:name enforces telegram-required fields when updating config', async () => {
    await api('POST', '/api/destinations', {
      name: 'tg-invalid-patch',
      type: 'telegram',
      config: { botToken: 'fake:token', chatId: '12345' },
    });

    const { status, data } = await api('PATCH', '/api/destinations/tg-invalid-patch', {
      config: { botToken: 'fake:token' /* chatId missing */ },
    });
    assert.equal(status, 400);
    assert.match((data as { error: string }).error, /botToken and chatId/);
  });
});

describe('routeTelegramMessage — inbound routing', () => {
  let db: Database;
  let wss: WebSocketServer;
  let tmpDir: string;
  let ctx: RouteContext;

  function makeDest(overrides: Partial<{ defaultAgent: string }> = {}): DestinationRecord {
    return {
      name: 'tg',
      type: 'telegram',
      config: { botToken: 'fake:token', chatId: '12345', ...overrides },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-route-tg-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    const mockProxyDispatch = async (): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);
    ctx = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      telegramDispatcher: makeStubTelegramDispatcher(),
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
    };
  });

  it('routes an @-prefixed message to the named agent', () => {
    db.createAgent({ name: 'dev', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    db.registerProxy('p1', 'tok', 'localhost:3100');

    routeTelegramMessage(ctx, makeDest(), '12345', '@dev hello');

    const pending = db.listPendingMessages('dev');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.envelope, 'hello');
  });

  it('routes an unprefixed message to defaultAgent when configured and agent exists', () => {
    db.createAgent({ name: 'team-lead', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    db.registerProxy('p1', 'tok', 'localhost:3100');

    routeTelegramMessage(ctx, makeDest({ defaultAgent: 'team-lead' }), '12345', 'unprefixed message');

    const pending = db.listPendingMessages('team-lead');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.envelope, 'unprefixed message');
  });

  it('falls back to dashboard thread when defaultAgent is not configured', () => {
    routeTelegramMessage(ctx, makeDest(), '12345', 'unprefixed message');

    // No agent received it — the fallback creates a dashboard message keyed by agent='telegram'
    const dashThread = db.getDashboardThreads('telegram')['telegram'] ?? [];
    assert.equal(dashThread.length, 1);
    assert.equal(dashThread[0]!.message, 'unprefixed message');
  });

  it('falls back to dashboard thread when defaultAgent is configured but agent does not exist', () => {
    routeTelegramMessage(ctx, makeDest({ defaultAgent: 'ghost-agent' }), '12345', 'unprefixed message');

    const dashThread = db.getDashboardThreads('telegram')['telegram'] ?? [];
    assert.equal(dashThread.length, 1);
    assert.equal(dashThread[0]!.message, 'unprefixed message');
  });

  it('explicit @-prefix overrides the configured defaultAgent', () => {
    db.createAgent({ name: 'team-lead', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    db.createAgent({ name: 'dev', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    db.registerProxy('p1', 'tok', 'localhost:3100');

    routeTelegramMessage(ctx, makeDest({ defaultAgent: 'team-lead' }), '12345', '@dev explicit override');

    const devPending = db.listPendingMessages('dev');
    const leadPending = db.listPendingMessages('team-lead');
    assert.equal(devPending.length, 1, 'explicitly-tagged agent should receive the message');
    assert.equal(leadPending.length, 0, 'defaultAgent should NOT receive the message when override is present');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pages archive feature
// ─────────────────────────────────────────────────────────────────────────────

describe('API Routes — Pages archive', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-pages-archive-routes-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const mockProxyDispatch = async (_proxyId: string, _command: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);

    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      telegramDispatcher: makeStubTelegramDispatcher(),
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const resp = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    return { status: resp.status, data };
  }

  /** Helper: seed a page directly via the DB (bypasses POST /api/pages tar/file-stream complexity). */
  function seed(slug: string, agent = 'tl'): void {
    db.createPage({ slug, agent, fileCount: 1, totalBytes: 100 });
  }

  it('GET /api/pages defaults to active pages only (archived hidden)', async () => {
    seed('default-active');
    seed('default-archived');
    db.setPageArchived('default-archived', true);

    const { status, data } = await api('GET', '/api/pages');
    assert.equal(status, 200);
    const slugs = (data as Array<{ slug: string }>).map((p) => p.slug);
    assert.ok(slugs.includes('default-active'));
    assert.ok(!slugs.includes('default-archived'), 'archived page must not appear in default listing');
  });

  it('GET /api/pages?archived=true returns only archived pages', async () => {
    seed('q-active');
    seed('q-archived');
    db.setPageArchived('q-archived', true);

    const { status, data } = await api('GET', '/api/pages?archived=true');
    assert.equal(status, 200);
    const pages = data as Array<{ slug: string; archived: boolean }>;
    const slugs = pages.map((p) => p.slug);
    assert.ok(slugs.includes('q-archived'));
    assert.ok(!slugs.includes('q-active'));
    assert.ok(pages.every((p) => p.archived === true), 'all returned pages must have archived=true');
  });

  it('POST /api/pages/:slug/archive with {archived:true} flips the flag', async () => {
    seed('to-flip');
    const { status, data } = await api('POST', '/api/pages/to-flip/archive', { archived: true });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).ok, true);
    assert.equal((data as Record<string, unknown>).slug, 'to-flip');
    assert.equal((data as Record<string, unknown>).archived, true);
    assert.equal(db.getPage('to-flip')!.archived, true);
  });

  it('POST /api/pages/:slug/archive with no body defaults to archive=true', async () => {
    seed('default-true');
    const { status, data } = await api('POST', '/api/pages/default-true/archive', {});
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).archived, true);
    assert.equal(db.getPage('default-true')!.archived, true);
  });

  it('POST /api/pages/:slug/archive with {archived:false} unarchives', async () => {
    seed('to-unarchive');
    db.setPageArchived('to-unarchive', true);
    assert.equal(db.getPage('to-unarchive')!.archived, true);

    const { status, data } = await api('POST', '/api/pages/to-unarchive/archive', { archived: false });
    assert.equal(status, 200);
    assert.equal((data as Record<string, unknown>).archived, false);
    assert.equal(db.getPage('to-unarchive')!.archived, false);
  });

  it('POST /api/pages/:slug/archive returns 404 for an unknown slug', async () => {
    const { status, data } = await api('POST', '/api/pages/no-such-slug/archive', { archived: true });
    assert.equal(status, 404);
    assert.match((data as { error: string }).error, /not found/i);
  });

  it('archive then list: archived page disappears from default GET /api/pages', async () => {
    seed('hide-after-archive');
    const { data: before } = await api('GET', '/api/pages');
    const slugsBefore = (before as Array<{ slug: string }>).map((p) => p.slug);
    assert.ok(slugsBefore.includes('hide-after-archive'));

    await api('POST', '/api/pages/hide-after-archive/archive', { archived: true });

    const { data: after } = await api('GET', '/api/pages');
    const slugsAfter = (after as Array<{ slug: string }>).map((p) => p.slug);
    assert.ok(!slugsAfter.includes('hide-after-archive'), 'archived page should be hidden from active listing');
  });

  it('unarchive: archived page re-appears in default GET /api/pages', async () => {
    seed('show-after-unarchive');
    await api('POST', '/api/pages/show-after-unarchive/archive', { archived: true });
    const { data: hidden } = await api('GET', '/api/pages');
    assert.ok(!(hidden as Array<{ slug: string }>).map((p) => p.slug).includes('show-after-unarchive'));

    await api('POST', '/api/pages/show-after-unarchive/archive', { archived: false });
    const { data: shown } = await api('GET', '/api/pages');
    assert.ok((shown as Array<{ slug: string }>).map((p) => p.slug).includes('show-after-unarchive'));
  });

  it('archive does NOT touch the page files on disk (reversible)', async () => {
    const pagesDir = join(tmpDir, 'pages');
    const slug = 'files-preserved';
    seed(slug);
    const slugDir = join(pagesDir, slug);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 'index.md'), '# preserved\n');

    await api('POST', `/api/pages/${slug}/archive`, { archived: true });

    assert.ok(existsSync(join(slugDir, 'index.md')), 'page files must not be removed on archive');
    await api('POST', `/api/pages/${slug}/archive`, { archived: false });
    assert.ok(existsSync(join(slugDir, 'index.md')), 'page files must not be removed on unarchive either');
  });
});

describe('API Routes — /api/notify (H1: delivery receipts)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  /** Captures (token, chatId, text, notifyId) for every TelegramDispatcher.send call. */
  let sendCalls: Array<{ token: string; chatId: string; text: string; notifyId: string | undefined }>;
  /** Controls what every TelegramDispatcher.send call returns. */
  let sendReturnsOk: boolean;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-notify-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();
    sendCalls = [];
    sendReturnsOk = true;

    const mockProxyDispatch = async (_proxyId: string, _command: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);

    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      telegramDispatcher: {
        startPolling: () => {},
        stopPolling: () => {},
        send: async (token: string, chatId: string, text: string, notifyId?: string) => {
          sendCalls.push({ token, chatId, text, notifyId });
          return sendReturnsOk;
        },
      } as unknown as TelegramDispatcher,
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sendCalls = [];
    sendReturnsOk = true;
    // Each test starts from a clean destination list so attempted/sent counts
    // assert on a known state rather than the running total across the suite.
    for (const d of db.listDestinations()) {
      db.deleteDestination(d.name);
    }
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(`http://localhost:${port}${path}`, init);
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it('returns 400 when message is missing', async () => {
    const { status, data } = await api('POST', '/api/notify', { agent: 'brain' });
    assert.equal(status, 400);
    assert.match(String(data.error), /message required/);
  });

  it('returns notifyId, attempted, and sent in the response body', async () => {
    // Seed a single enabled telegram destination.
    db.createDestination({ name: 'notify-tg-1', type: 'telegram', config: { botToken: 't', chatId: '42' } });

    const { status, data } = await api('POST', '/api/notify', { message: 'hello', agent: 'brain' });

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.attempted, 1);
    assert.equal(data.sent, 1);
    assert.ok(typeof data.notifyId === 'string' && data.notifyId.length > 0, 'notifyId must be a non-empty string');
    // UUID v4 shape (8-4-4-4-12 hex). The exact version isn't load-bearing; we
    // just want a stable, unique-enough correlator that downstream logs can grep.
    assert.match(data.notifyId, /^[0-9a-f-]{36}$/);
  });

  it('passes notifyId through to TelegramDispatcher.send', async () => {
    db.createDestination({ name: 'notify-tg-2', type: 'telegram', config: { botToken: 't2', chatId: '43' } });

    const { data } = await api('POST', '/api/notify', { message: 'thread me', agent: 'brain' });

    const sendCall = sendCalls.find(c => c.chatId === '43');
    assert.ok(sendCall, 'TelegramDispatcher.send should have been invoked for the seeded destination');
    assert.equal(sendCall.notifyId, data.notifyId, 'notifyId in send() call must match the one in the response');
    assert.equal(sendCall.text, '[brain] thread me', 'text must include the agent prefix');
  });

  it('counts dropped destinations when send returns false (visibility, not retry)', async () => {
    db.createDestination({ name: 'notify-tg-3', type: 'telegram', config: { botToken: 't3', chatId: '44' } });
    sendReturnsOk = false;

    const { status, data } = await api('POST', '/api/notify', { message: 'will fail' });

    assert.equal(status, 200, 'endpoint always returns 200 — visibility is via the body, not status');
    assert.equal(data.attempted, 1);
    assert.equal(data.sent, 0, 'failed send must not be counted as delivered');
    assert.ok(data.notifyId, 'notifyId must be returned even on full-drop');
  });

  it('issues a fresh notifyId per request', async () => {
    db.createDestination({ name: 'notify-tg-4', type: 'telegram', config: { botToken: 't4', chatId: '45' } });

    const a = await api('POST', '/api/notify', { message: 'first' });
    const b = await api('POST', '/api/notify', { message: 'second' });

    assert.notEqual(a.data.notifyId, b.data.notifyId, 'two distinct calls must get two distinct notifyIds');
  });
});

describe('API Routes — /scratch (R: render-only endpoint)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let projectA: string;
  let projectB: string;
  let prevProjectRenderRoots: string | undefined;
  /** Set to non-null to enable auth-required mode in the test server. */
  let testSecret: string | null;

  before(async () => {
    // realpathSync the tmpdir for the same macOS symlink reason as the V2 cleanup.
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-scratch-test-')));
    projectA = join(tmpDir, 'project-a');
    projectB = join(tmpDir, 'project-b');
    mkdirSync(join(projectA, 'scratch', 'sub'), { recursive: true });
    mkdirSync(join(projectB, 'scratch'), { recursive: true });

    // Seed: project-a has two markdown files (one nested), project-b has one.
    writeFileSync(join(projectA, 'scratch', 'top.md'), '# Top\nProject A top-level note.');
    writeFileSync(join(projectA, 'scratch', 'sub', 'deep.md'), '# Deep\nProject A nested note.');
    writeFileSync(join(projectB, 'scratch', 'b.md'), '# B\nProject B note.');
    // Non-markdown file should be invisible to the index and rejected by render.
    writeFileSync(join(projectA, 'scratch', 'secret.txt'), 'should not appear');

    prevProjectRenderRoots = process.env['PROJECT_RENDER_ROOTS'];
    process.env['PROJECT_RENDER_ROOTS'] = `${projectA},${projectB}`;
    testSecret = null; // dev mode by default; per-test can flip via setSecret()

    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const mockProxyDispatch = async (_proxyId: string, _command: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);

    // The router reads orchestratorSecret from the ctx at construction time,
    // but the authorize() helper called inside our handler re-reads it from
    // ctx each request — so we mutate ctx.orchestratorSecret via a getter.
    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      get orchestratorSecret() { return testSecret; },
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      telegramDispatcher: makeStubTelegramDispatcher(),
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
    } as RouteContext;

    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    if (prevProjectRenderRoots !== undefined) {
      process.env['PROJECT_RENDER_ROOTS'] = prevProjectRenderRoots;
    } else {
      delete process.env['PROJECT_RENDER_ROOTS'];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    testSecret = null;
  });

  async function getHtml(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const resp = await fetch(`http://localhost:${port}${path}`, { method: 'GET', headers });
    return { status: resp.status, body: await resp.text() };
  }

  async function getJson(path: string, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> {
    const resp = await fetch(`http://localhost:${port}${path}`, { method: 'GET', headers });
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  }

  it('GET /scratch renders an index grouped by project with markdown links', async () => {
    const { status, body } = await getHtml('/scratch');
    assert.equal(status, 200);
    assert.match(body, /project-a/);
    assert.match(body, /project-b/);
    // Both files in project-a should appear, with hrefs to /scratch/<project>/<relpath>.
    assert.match(body, /\/scratch\/project-a\/top\.md/);
    assert.match(body, /\/scratch\/project-a\/sub\/deep\.md/);
    assert.match(body, /\/scratch\/project-b\/b\.md/);
    // Non-markdown sibling must not appear in the index.
    assert.ok(!body.includes('secret.txt'), 'non-.md files must not be listed');
  });

  it('GET /scratch/:project/:path+ renders a .md file as HTML', async () => {
    const { status, body } = await getHtml('/scratch/project-a/top.md');
    assert.equal(status, 200);
    assert.match(body, /Project A top-level note/);
    // Should be wrapped in the markdown-page HTML shell.
    assert.match(body, /<!DOCTYPE html>/);
  });

  it('GET /scratch/:project/:path+ resolves nested paths', async () => {
    const { status, body } = await getHtml('/scratch/project-a/sub/deep.md');
    assert.equal(status, 200);
    assert.match(body, /Project A nested note/);
  });

  it('returns 404 for an unknown project', async () => {
    const { status, data } = await getJson('/scratch/no-such-project/whatever.md');
    assert.equal(status, 404);
    assert.match(String(data.error), /Unknown project/);
  });

  it('returns 404 when the file does not exist', async () => {
    const { status, data } = await getJson('/scratch/project-a/does-not-exist.md');
    assert.equal(status, 404);
    assert.match(String(data.error), /File not found/);
  });

  it('returns 400 for non-.md files', async () => {
    const { status, data } = await getJson('/scratch/project-a/secret.txt');
    assert.equal(status, 400);
    assert.match(String(data.error), /Only \.md files/);
  });

  it('rejects path traversal at the URL level (..) — normalizes off-route', async () => {
    // Both `..` and URL-encoded `%2e%2e` get folded by Node's URL parser before
    // reaching the route, so the request lands on a path that either doesn't
    // match `/scratch/:project/:path+` (→ 404) or matches with a different
    // project segment whose path component fails the `.md` check (→ 400).
    // Either way the server never serves `/etc/passwd` via this route. The
    // explicit `relPath.includes('..')` guard in resolveScratchFile is
    // defense-in-depth for unusual clients that don't normalize at the URL layer.
    const { status } = await getJson('/scratch/project-a/../../../etc/passwd');
    assert.ok(status === 400 || status === 404, `expected traversal to be rejected (400 or 404), got ${status}`);
  });

  it('rejects symlink escape (file is a symlink to outside the project scratch dir)', async () => {
    // Create a symlink inside scratch that points at a file outside the project.
    const outside = join(tmpDir, 'outside.md');
    writeFileSync(outside, '# OUTSIDE\nSensitive content that should not be reachable.');
    const linkPath = join(projectA, 'scratch', 'escape.md');
    // symlinkSync may fail in restricted filesystems — guard with try/catch.
    try {
      const { symlinkSync } = await import('node:fs');
      symlinkSync(outside, linkPath);
    } catch {
      // Skip the assertion path if symlinks can't be created in this env.
      return;
    }

    const { status, data } = await getJson('/scratch/project-a/escape.md');
    assert.equal(status, 400);
    assert.match(String(data.error), /escapes project scratch dir/);
  });

  it('returns 401 when secret is set and no auth header is provided', async () => {
    testSecret = 'shh';
    const { status } = await getJson('/scratch');
    assert.equal(status, 401);
  });

  it('returns 401 when secret is set and the wrong bearer is provided', async () => {
    testSecret = 'shh';
    const { status } = await getJson('/scratch', { authorization: 'Bearer wrong' });
    assert.equal(status, 401);
  });

  it('returns 200 when the correct bearer is provided', async () => {
    testSecret = 'correct-token';
    const { status } = await getHtml('/scratch', { authorization: 'Bearer correct-token' });
    assert.equal(status, 200);
  });

  it('returns 200 when the correct token is provided via conductor_token cookie', async () => {
    // The dashboard mirrors its bearer token into a cookie so browser-direct
    // navigation (e.g. clicking the Scratch header link) works without an
    // Authorization header. authorize() falls back to the cookie when the
    // header is absent.
    testSecret = 'cookie-token';
    const { status } = await getHtml('/scratch', { cookie: 'other=foo; conductor_token=cookie-token; bar=baz' });
    assert.equal(status, 200);
  });

  it('returns 401 when the conductor_token cookie holds the wrong value', async () => {
    testSecret = 'cookie-token';
    const { status } = await getJson('/scratch', { cookie: 'conductor_token=wrong-value' });
    assert.equal(status, 401);
  });

  it('returns 401 on the per-file route when secret is set and no auth header is provided', async () => {
    testSecret = 'shh';
    const { status } = await getJson('/scratch/project-a/top.md');
    assert.equal(status, 401);
  });

  it('renders a friendly empty-state when PROJECT_RENDER_ROOTS is empty', async () => {
    delete process.env['PROJECT_RENDER_ROOTS'];
    try {
      const { status, body } = await getHtml('/scratch');
      assert.equal(status, 200);
      assert.match(body, /No projects are configured/);
    } finally {
      process.env['PROJECT_RENDER_ROOTS'] = `${projectA},${projectB}`;
    }
  });
});

describe('API Routes — /api/preferences (MM: server-side dashboard prefs)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-prefs-routes-')));
    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const mockProxyDispatch = async (_proxyId: string, _command: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);

    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      telegramDispatcher: makeStubTelegramDispatcher(),
      pagesDir: join(tmpDir, 'pages'),
      storesDir: join(tmpDir, 'stores'),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.rawDb.exec('DELETE FROM preferences');
  });

  it('should return empty object when no preferences are stored', async () => {
    const res = await fetch(`http://localhost:${port}/api/preferences`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {});
  });

  it('should round-trip an object body through PUT then GET', async () => {
    const putRes = await fetch(`http://localhost:${port}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submitMode: 'enter', closeKeyboardOnSend: true }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.deepEqual(putBody, { submitMode: 'enter', closeKeyboardOnSend: true });

    const getRes = await fetch(`http://localhost:${port}/api/preferences`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.deepEqual(getBody, { submitMode: 'enter', closeKeyboardOnSend: true });
  });

  it('should merge — PUT preserves keys not in the payload', async () => {
    await fetch(`http://localhost:${port}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submitMode: 'enter', closeKeyboardOnSend: true }),
    });
    // PUT with only one key — the other should survive.
    await fetch(`http://localhost:${port}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submitMode: 'cmd-enter' }),
    });
    const getRes = await fetch(`http://localhost:${port}/api/preferences`);
    const body = await getRes.json();
    assert.deepEqual(body, { submitMode: 'cmd-enter', closeKeyboardOnSend: true });
  });

  it('should reject non-object PUT bodies', async () => {
    for (const bad of ['null', '[]', '"string"', '42']) {
      const res = await fetch(`http://localhost:${port}/api/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: bad,
      });
      assert.equal(res.status, 400, `bad payload ${bad} should 400`);
    }
  });

  it('should handle nested object values without flattening', async () => {
    await fetch(`http://localhost:${port}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: { theme: 'dark', density: 'compact' }, voice: { wake: 'hey-conductor' } }),
    });
    const getRes = await fetch(`http://localhost:${port}/api/preferences`);
    const body = await getRes.json();
    assert.deepEqual(body, { ui: { theme: 'dark', density: 'compact' }, voice: { wake: 'hey-conductor' } });
  });

  it('should delete a specific key via DELETE /api/preferences/:key', async () => {
    await fetch(`http://localhost:${port}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submitMode: 'enter', closeKeyboardOnSend: true }),
    });
    const delRes = await fetch(`http://localhost:${port}/api/preferences/submitMode`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);

    const getRes = await fetch(`http://localhost:${port}/api/preferences`);
    const body = await getRes.json();
    assert.deepEqual(body, { closeKeyboardOnSend: true });
  });

  it('should return 404 when deleting a non-existent key', async () => {
    const res = await fetch(`http://localhost:${port}/api/preferences/nonexistent`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

describe('API Routes — /pages/<slug> base href injection (relative-link fix)', () => {
  let server: Server;
  let db: Database;
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;
  let pagesDir: string;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-pages-basehref-')));
    pagesDir = join(tmpDir, 'pages');
    // Seed a bundle with an index.md that links to a sibling file, mirroring
    // the operator's INSTALLER-DESIGN.md case.
    mkdirSync(join(pagesDir, 'sandbox-automation', 'runbooks'), { recursive: true });
    writeFileSync(join(pagesDir, 'sandbox-automation', 'index.md'),
      '# Sandbox automation\n\nSee [INSTALLER-DESIGN.md](INSTALLER-DESIGN.md) and [runbook](runbooks/foo.md).');
    writeFileSync(join(pagesDir, 'sandbox-automation', 'INSTALLER-DESIGN.md'),
      '# Installer design\n\nDesign content.');
    writeFileSync(join(pagesDir, 'sandbox-automation', 'runbooks', 'foo.md'),
      '# Runbook\n\nWith a relative link to [sibling](bar.md).');

    db = new Database(join(tmpDir, 'test.db'));
    wss = new WebSocketServer();

    const mockProxyDispatch = async (_proxyId: string, _command: ProxyCommand): Promise<ProxyResponse> => ({ ok: true });
    const locks = new LockManager(db.rawDb);

    const ctx: RouteContext = {
      db,
      wss,
      locks,
      proxyDispatch: mockProxyDispatch,
      getDashboardHtml: () => '<html></html>',
      orchestratorHost: 'http://localhost:3000',
      orchestratorSecret: null,
      messageDispatcher: makeTestDispatcher(db, locks, mockProxyDispatch),
      usagePoller: { getUsageData: () => ({}), pollNow: async () => {} } as any,
      voiceEnabled: false,
      accountStore: new AccountStore({ accountsDir: join(tmpDir, 'accounts'), agentHomesDir: join(tmpDir, 'agent-homes'), skipAutoRegister: true }),
      telegramDispatcher: makeStubTelegramDispatcher(),
      pagesDir,
      storesDir: join(tmpDir, 'stores'),
    };

    const router = createRouter(ctx);
    server = createServer(async (req, res) => { await router(req, res); });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    server.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should inject <base href="/pages/<slug>/"> when serving a bundle index.md', async () => {
    const res = await fetch(`http://localhost:${port}/pages/sandbox-automation`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<base href="\/pages\/sandbox-automation\/"/, 'index.md render must include base href with bundle URL + trailing slash');
  });

  it('should inject <base href> matching subdir when serving a nested .md file', async () => {
    const res = await fetch(`http://localhost:${port}/pages/sandbox-automation/runbooks/foo.md`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<base href="\/pages\/sandbox-automation\/runbooks\/"/, 'nested render must base href against the file dir');
  });

  it('should still serve sibling files correctly via the per-file route (regression check)', async () => {
    const res = await fetch(`http://localhost:${port}/pages/sandbox-automation/INSTALLER-DESIGN.md`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Installer design/);
  });
});

describe('recoverFailedAgents (HH — refuse to heal when CLI gone but pane alive)', () => {
  let db: Database;
  let wss: WebSocketServer;
  let tmpDir: string;
  let proxyCalls: ProxyCommand[];
  /** Set by each test to control proxy responses. */
  let captureResponse: string;
  let hasSessionResponse: boolean;

  // Import recoverFailedAgents from the module under test
  let recoverFailedAgents: (ctx: any, proxyId: string) => Promise<void>;

  before(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-hh-')));
    const mod = await import('./routes.ts');
    recoverFailedAgents = (mod as any).recoverFailedAgents;
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db = new Database(join(tmpDir, `test-${Date.now()}-${Math.random()}.db`));
    wss = new WebSocketServer();
    proxyCalls = [];
    captureResponse = '';
    hasSessionResponse = true;
  });

  function makeCtx(): any {
    const proxyDispatch = async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
      proxyCalls.push(command);
      if (command.action === 'has_session') return { ok: true, data: hasSessionResponse };
      if (command.action === 'capture') return { ok: true, data: captureResponse };
      return { ok: true };
    };
    return { db, wss, proxyDispatch, orchestratorHost: 'http://localhost:3000' };
  }

  function seedFailedAgent(name: string, proxyId: string): void {
    db.registerProxy(proxyId, 'tok', 'localhost:3100');
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId });
    const a = db.getAgent(name)!;
    db.updateAgentState(name, 'failed', a.version, {
      failedAt: new Date().toISOString(),
      failureReason: 'tmux pane was killed externally',
    });
  }

  it('should heal a failed agent when pane shows live Claude TUI', async () => {
    seedFailedAgent('healthy-tl', 'proxy-x');
    captureResponse = [
      '────────────────────────────── tl ──',
      '❯ ',
      '──────────────────────────────────────',
      '  ~/dev  Opus 4.7  ctx: 12%',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');

    await recoverFailedAgents(makeCtx(), 'proxy-x');

    const after = db.getAgent('healthy-tl');
    assert.equal(after?.state, 'active', 'agent should be healed (state=active)');
    assert.equal(after?.failureReason, null, 'failureReason should clear on heal');
  });

  it('should REFUSE to heal when pane shows bare zsh prompt (HH bug — today\'s tl incident)', async () => {
    seedFailedAgent('dead-tl', 'proxy-x');
    captureResponse = [
      'zsh: bad pattern: [from:',
      "colm.murphy@IE-colm dev % [from: dashboard]: 'hi'",
      'zsh: bad pattern: [from:',
      'colm.murphy@IE-colm dev %',
    ].join('\n');

    await recoverFailedAgents(makeCtx(), 'proxy-x');

    const after = db.getAgent('dead-tl');
    assert.equal(after?.state, 'failed', 'agent must STAY failed when pane has bare shell prompt');
    assert.match(after?.failureReason ?? '', /tmux pane was killed externally/,
      'original failure reason should be preserved (we did not heal-then-refail)');
  });

  it('should skip agents whose tmux session is no longer alive', async () => {
    seedFailedAgent('vanished', 'proxy-x');
    hasSessionResponse = false;

    await recoverFailedAgents(makeCtx(), 'proxy-x');

    const after = db.getAgent('vanished');
    assert.equal(after?.state, 'failed', 'agent stays failed when no session');
    // capture should NOT have been called since has_session was false
    assert.ok(!proxyCalls.some(c => c.action === 'capture'),
      'capture must not be called when has_session returned false');
  });

  it('should not call proxy at all when no failed agents exist', async () => {
    db.registerProxy('proxy-x', 'tok', 'localhost:3100');
    db.createAgent({ name: 'happy', engine: 'claude', cwd: '/tmp', proxyId: 'proxy-x' });
    // No state change — defaults to void/idle, not failed

    await recoverFailedAgents(makeCtx(), 'proxy-x');

    assert.equal(proxyCalls.length, 0,
      'no proxy calls when there are no failed agents on this proxy');
  });

  it('should only process failed agents on the given proxy', async () => {
    seedFailedAgent('on-x', 'proxy-x');
    seedFailedAgent('on-y', 'proxy-y');
    captureResponse = '  ~/dev  Opus 4.7  ctx: 12%\n  ⏵⏵ bypass permissions on';

    await recoverFailedAgents(makeCtx(), 'proxy-x');

    assert.equal(db.getAgent('on-x')?.state, 'active', 'failed agent on proxy-x healed');
    assert.equal(db.getAgent('on-y')?.state, 'failed', 'failed agent on proxy-y untouched');
  });
});
