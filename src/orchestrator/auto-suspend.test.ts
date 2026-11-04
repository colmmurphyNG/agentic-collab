import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { AgentState, ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { HealthMonitor, findBlockingDescendant, parseAutoSuspendMinutes } from './health-monitor.ts';
import { MessageDispatcher } from './message-dispatcher.ts';
import { personaAllowsAutoSuspend } from './persona.ts';

const MIN = 60_000;
const THRESHOLD = 120 * MIN;

describe('auto-suspend', () => {
  let db: Database;
  let locks: LockManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'auto-suspend-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    locks = new LockManager(db.rawDb);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAgent(name: string, state: AgentState): void {
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(name)!;
    db.updateAgentState(name, state, a.version, { tmuxSession: `agent-${name}`, proxyId: 'p1' });
  }

  // A pane whose only descendants are a shell and claude.
  const QUIET_PS = [
    '  100     1 -zsh',
    '  101   100 /Users/x/.local/bin/claude --model opus',
    '  102   101 npx -y @acme/some-mcp-server',
    '  103   102 node /x/node_modules/.bin/some-mcp-server',
  ].join('\n');

  type Harness = {
    monitor: HealthMonitor;
    suspended: string[];
    execCalls: () => number;
    setPs: (ps: string | null) => void;
  };

  function makeHarness(opts: {
    idleMs?: number;
    cooldownMs?: number;
    allows?: boolean;
  } = {}): Harness {
    const suspended: string[] = [];
    let execCount = 0;
    let ps: string | null = QUIET_PS;
    const proxyDispatch = async (_id: string, command: ProxyCommand): Promise<ProxyResponse> => {
      if (command.action === 'display_message') return { ok: true, data: '100' };
      if (command.action === 'exec') {
        execCount++;
        return ps === null ? { ok: false, error: 'ps failed' } : { ok: true, data: ps };
      }
      return { ok: true };
    };
    const monitor = new HealthMonitor({
      db,
      locks,
      proxyDispatch,
      orchestratorHost: 'http://localhost:3000',
      autoSuspendIdleMs: opts.idleMs ?? THRESHOLD,
      autoSuspendCooldownMs: opts.cooldownMs ?? 30 * MIN,
      suspendAgentFn: async (_ctx, name) => { suspended.push(name); },
      allowsAutoSuspend: () => opts.allows ?? true,
    });
    return { monitor, suspended, execCalls: () => execCount, setPs: (p) => { ps = p; } };
  }

  async function settle(monitor: HealthMonitor): Promise<void> {
    const inFlight = (monitor as unknown as { autoSuspendInFlight: Set<string> }).autoSuspendInFlight;
    for (let i = 0; i < 50 && inFlight.size > 0; i++) await new Promise((r) => setImmediate(r));
  }

  /** Mark idle at t=0, then check again past the threshold. */
  async function idleThroughThreshold(h: Harness, name: string, at: number = THRESHOLD + MIN): Promise<void> {
    h.monitor.checkIdleSuspendTimeout(name, 0);
    h.monitor.checkIdleSuspendTimeout(name, at);
    await settle(h.monitor);
  }

  describe('configuration', () => {
    it('is disabled when the env value is unset, 0 or not a number', () => {
      assert.equal(parseAutoSuspendMinutes(undefined), 0);
      assert.equal(parseAutoSuspendMinutes('0'), 0);
      assert.equal(parseAutoSuspendMinutes('abc'), 0);
      assert.equal(parseAutoSuspendMinutes('-5'), 0);
      assert.equal(parseAutoSuspendMinutes('120'), 120);
    });

    it('does not suspend when the threshold is 0', async () => {
      makeAgent('as-off', 'idle');
      const h = makeHarness({ idleMs: 0 });
      await idleThroughThreshold(h, 'as-off', 10_000 * MIN);
      assert.deepEqual(h.suspended, []);
      assert.match(h.monitor.describeSuspendConfig(), /disabled/);
    });

    it('reports the threshold in the startup description when enabled', () => {
      const h = makeHarness();
      assert.match(h.monitor.describeSuspendConfig(), /after 120min idle, cooldown 30min/);
    });
  });

  describe('suspend trigger', () => {
    it('suspends once an agent has been idle past the threshold', async () => {
      makeAgent('as-go', 'idle');
      const h = makeHarness();
      await idleThroughThreshold(h, 'as-go');
      assert.deepEqual(h.suspended, ['as-go']);
    });

    it('does nothing before the threshold', async () => {
      makeAgent('as-early', 'idle');
      const h = makeHarness();
      await idleThroughThreshold(h, 'as-early', THRESHOLD - MIN);
      assert.deepEqual(h.suspended, []);
    });

    it('restarts the idle clock when the agent goes active in between', async () => {
      makeAgent('as-blip', 'idle');
      const h = makeHarness();
      h.monitor.checkIdleSuspendTimeout('as-blip', 0);
      const a = db.getAgent('as-blip')!;
      db.updateAgentState('as-blip', 'active', a.version);
      h.monitor.checkIdleSuspendTimeout('as-blip', 100 * MIN);
      const b = db.getAgent('as-blip')!;
      db.updateAgentState('as-blip', 'idle', b.version);
      h.monitor.checkIdleSuspendTimeout('as-blip', 130 * MIN);
      h.monitor.checkIdleSuspendTimeout('as-blip', 130 * MIN + THRESHOLD - MIN);
      await settle(h.monitor);
      assert.deepEqual(h.suspended, [], 'the clock restarted at 130 minutes');
    });

    it('never suspends an active agent', async () => {
      makeAgent('as-busy', 'active');
      const h = makeHarness();
      await idleThroughThreshold(h, 'as-busy', 10_000 * MIN);
      assert.deepEqual(h.suspended, []);
    });
  });

  describe('skip guards', () => {
    it('skips an agent with a pending message', async () => {
      makeAgent('as-pending', 'idle');
      db.enqueueMessage({ sourceAgent: null, targetAgent: 'as-pending', envelope: 'hi' });
      const h = makeHarness();
      await idleThroughThreshold(h, 'as-pending');
      assert.deepEqual(h.suspended, []);
    });

    it('skips an agent with a lifecycle operation in flight', async () => {
      makeAgent('as-locked', 'idle');
      const h = makeHarness();
      const lockId = await locks.lock('as-locked');
      try {
        await idleThroughThreshold(h, 'as-locked');
      } finally {
        locks.unlock('as-locked', lockId);
      }
      assert.deepEqual(h.suspended, []);
    });

    it('skips a persona that opts out', async () => {
      makeAgent('as-optout', 'idle');
      const h = makeHarness({ allows: false });
      await idleThroughThreshold(h, 'as-optout');
      assert.deepEqual(h.suspended, []);
    });

    it('skips when the agent started a dev server under the pane', async () => {
      makeAgent('as-dev', 'idle');
      const h = makeHarness();
      h.setPs(`${QUIET_PS}\n  200   100 /bin/zsh -c npm run dev\n  201   200 node /repo/node_modules/.bin/vite --port 3000`);
      await idleThroughThreshold(h, 'as-dev');
      assert.deepEqual(h.suspended, []);
      assert.equal(h.execCalls(), 1, 'the scan ran and found the server');
    });

    it('skips when the process list cannot be read', async () => {
      makeAgent('as-blind', 'idle');
      const h = makeHarness();
      h.setPs(null);
      await idleThroughThreshold(h, 'as-blind');
      assert.deepEqual(h.suspended, [], 'an unknown process tree must not be suspended');
    });
  });

  describe('cooldown', () => {
    it('does not rescan or retry inside the cooldown, and retries after it', async () => {
      makeAgent('as-cool', 'idle');
      const h = makeHarness();
      h.setPs(`${QUIET_PS}\n  200   100 node /repo/server.js`);
      const t = THRESHOLD + MIN;
      h.monitor.checkIdleSuspendTimeout('as-cool', 0);
      h.monitor.checkIdleSuspendTimeout('as-cool', t);
      await settle(h.monitor);
      const afterFirst = h.execCalls();
      assert.equal(afterFirst, 1);

      h.monitor.checkIdleSuspendTimeout('as-cool', t + 10 * MIN);
      await settle(h.monitor);
      assert.equal(h.execCalls(), afterFirst, 'cooldown holds the retry back');

      // The server exits; once the cooldown passes the agent is suspended.
      h.setPs(QUIET_PS);
      h.monitor.checkIdleSuspendTimeout('as-cool', t + 31 * MIN);
      await settle(h.monitor);
      assert.deepEqual(h.suspended, ['as-cool']);
    });
  });

  describe('findBlockingDescendant', () => {
    it('tolerates claude, shells and MCP subtrees', () => {
      assert.equal(findBlockingDescendant(QUIET_PS, 100), null);
    });

    it('flags a process started from a shell', () => {
      const ps = `${QUIET_PS}\n  300   100 zsh\n  301   300 npx playwright test`;
      assert.match(findBlockingDescendant(ps, 100) ?? '', /playwright/);
    });

    it('ignores processes outside the pane tree', () => {
      const ps = `${QUIET_PS}\n  900     1 node /elsewhere/server.js`;
      assert.equal(findBlockingDescendant(ps, 100), null);
    });
  });

  describe('persona opt-out', () => {
    it('is on unless the frontmatter says auto_suspend: false', () => {
      const dir = join(tmpDir, 'personas');
      mkdirSync(dir);
      writeFileSync(join(dir, 'keeper.md'), '---\nengine: claude\nauto_suspend: false\n---\nBody\n');
      writeFileSync(join(dir, 'normal.md'), '---\nengine: claude\n---\nBody\n');
      writeFileSync(join(dir, 'explicit.md'), '---\nengine: claude\nauto_suspend: true\n---\nBody\n');
      assert.equal(personaAllowsAutoSuspend('keeper', null, dir), false);
      assert.equal(personaAllowsAutoSuspend('normal', null, dir), true);
      assert.equal(personaAllowsAutoSuspend('explicit', null, dir), true);
      assert.equal(personaAllowsAutoSuspend('no-such-persona', null, dir), true);
    });
  });

  describe('wake on message', () => {
    function makeDispatcher(resumeCalls: string[], gate?: Promise<void>): MessageDispatcher {
      return new MessageDispatcher({
        db,
        locks,
        proxyDispatch: async () => ({ ok: true }),
        orchestratorHost: 'http://localhost:3000',
        resumeAgentFn: async (_ctx, name) => {
          resumeCalls.push(name);
          if (gate) await gate;
          const a = db.getAgent(name)!;
          db.updateAgentState(name, 'active', a.version);
        },
      });
    }

    it('resumes a suspended agent for a pending message, then delivers it', async () => {
      makeAgent('wk-sus', 'suspended');
      const msg = db.enqueueMessage({ sourceAgent: null, targetAgent: 'wk-sus', envelope: 'wake up' });
      const calls: string[] = [];
      const dispatcher = makeDispatcher(calls);
      try {
        const delivered = await dispatcher.tryDeliver('wk-sus');
        assert.deepEqual(calls, ['wk-sus']);
        assert.equal(delivered, true);
        assert.equal(db.getPendingMessageById(msg.id)?.status, 'delivered');
      } finally {
        dispatcher.stop();
      }
    });

    it('resumes exactly once when deliveries race while the resume is in flight', async () => {
      makeAgent('wk-race', 'suspended');
      db.enqueueMessage({ sourceAgent: null, targetAgent: 'wk-race', envelope: 'one' });
      db.enqueueMessage({ sourceAgent: null, targetAgent: 'wk-race', envelope: 'two' });
      const calls: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const dispatcher = makeDispatcher(calls, gate);
      try {
        const first = dispatcher.tryDeliver('wk-race');
        const second = dispatcher.tryDeliver('wk-race');
        await new Promise((r) => setImmediate(r));
        release();
        await Promise.all([first, second]);
        assert.deepEqual(calls, ['wk-race']);
      } finally {
        dispatcher.stop();
      }
    });

    it('does not resume a suspended agent that has nothing to deliver', async () => {
      makeAgent('wk-empty', 'suspended');
      const calls: string[] = [];
      const dispatcher = makeDispatcher(calls);
      try {
        await dispatcher.tryDeliver('wk-empty');
        assert.deepEqual(calls, []);
      } finally {
        dispatcher.stop();
      }
    });

    for (const state of ['failed', 'void'] as const) {
      it(`does not resume a ${state} agent`, async () => {
        makeAgent(`wk-${state}`, state);
        db.enqueueMessage({ sourceAgent: null, targetAgent: `wk-${state}`, envelope: 'hello' });
        const calls: string[] = [];
        const dispatcher = makeDispatcher(calls);
        try {
          const delivered = await dispatcher.tryDeliver(`wk-${state}`);
          assert.deepEqual(calls, []);
          assert.equal(delivered, false);
        } finally {
          dispatcher.stop();
        }
      });
    }

    it('does not resume an agent that is already running', async () => {
      makeAgent('wk-live', 'idle');
      db.enqueueMessage({ sourceAgent: null, targetAgent: 'wk-live', envelope: 'hello' });
      const calls: string[] = [];
      const dispatcher = makeDispatcher(calls);
      try {
        await dispatcher.tryDeliver('wk-live');
        assert.deepEqual(calls, []);
      } finally {
        dispatcher.stop();
      }
    });

    it('keeps the message pending when the resume fails', async () => {
      makeAgent('wk-fail', 'suspended');
      const msg = db.enqueueMessage({ sourceAgent: null, targetAgent: 'wk-fail', envelope: 'hello' });
      const dispatcher = new MessageDispatcher({
        db,
        locks,
        proxyDispatch: async () => ({ ok: true }),
        orchestratorHost: 'http://localhost:3000',
        resumeAgentFn: async () => { throw new Error('boom'); },
      });
      const realError = console.error;
      console.error = () => {};
      try {
        const delivered = await dispatcher.tryDeliver('wk-fail');
        assert.equal(delivered, false);
        assert.equal(db.getPendingMessageById(msg.id)?.status, 'pending');
      } finally {
        console.error = realError;
        dispatcher.stop();
      }
    });
  });
});
