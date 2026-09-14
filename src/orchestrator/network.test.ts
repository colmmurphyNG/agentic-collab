import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { shutdownAgents, restoreAllAgents, PROXY_PROBE_SESSION } from './network.ts';
import type { LifecycleContext } from './lifecycle.ts';

describe('Network', () => {
  let db: Database;
  let tmpDir: string;
  let proxyCommands: ProxyCommand[];
  let ctx: LifecycleContext;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'network-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    proxyCommands = [];

    ctx = {
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        proxyCommands.push(command);
        if (command.action === 'has_session') {
          return { ok: true, data: false }; // simulate missing sessions for crash recovery
        }
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
    };
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('shutdownAgents', () => {
    it('suspends active agents with stateBeforeShutdown', () => {
      db.createAgent({ name: 'net-active', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('net-active')!;
      db.updateAgentState('net-active', 'active', a.version, {
        tmuxSession: 'agent-net-active',
        proxyId: 'p1',
      });

      db.createAgent({ name: 'net-idle', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const b = db.getAgent('net-idle')!;
      db.updateAgentState('net-idle', 'idle', b.version, {
        tmuxSession: 'agent-net-idle',
        proxyId: 'p1',
      });

      const count = shutdownAgents(ctx);
      assert.equal(count, 2);

      const active = db.getAgent('net-active')!;
      assert.equal(active.state, 'suspended');
      assert.equal(active.stateBeforeShutdown, 'active');

      const idle = db.getAgent('net-idle')!;
      assert.equal(idle.state, 'suspended');
      assert.equal(idle.stateBeforeShutdown, 'idle');
    });

    it('ignores void/suspended agents', () => {
      db.createAgent({ name: 'net-void', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      // void agent should not be touched
      const count = shutdownAgents(ctx);
      assert.equal(count, 0); // net-active and net-idle already suspended
    });
  });

  describe('restoreAllAgents', () => {
    it('restores agents with stateBeforeShutdown', async () => {
      proxyCommands = [];
      const count = await restoreAllAgents(ctx);
      assert.ok(count >= 1); // at least net-active and net-idle should be restored
      assert.ok(proxyCommands.some(c => c.action === 'create_session'));
      assert.ok(proxyCommands.some(c => c.action === 'paste'));
    });

    it('returns 0 when nothing to restore', async () => {
      // All agents should now be active/idle after restore
      // Create a fresh context with sessions found
      const freshCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'has_session') {
            return { ok: true, data: true }; // sessions exist
          }
          return { ok: true };
        },
      };
      // Suspend all first, then clear stateBeforeShutdown
      const agents = db.listAgents().filter(a => a.state === 'active' || a.state === 'idle');
      for (const a of agents) {
        db.updateAgentState(a.name, 'suspended', a.version, {
          stateBeforeShutdown: null,
        });
      }

      proxyCommands = [];
      const count = await restoreAllAgents(freshCtx);
      assert.equal(count, 0);
    });

    it('recovers agents stuck in suspending state (crash recovery)', async () => {
      db.createAgent({ name: 'net-suspending', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('net-suspending')!;
      db.updateAgentState('net-suspending', 'suspending', a.version, {
        tmuxSession: 'agent-net-suspending',
        proxyId: 'p1',
      });

      proxyCommands = [];
      const count = await restoreAllAgents(ctx);
      assert.ok(count >= 1);

      // Agent should have been marked failed then resumed
      const agent = db.getAgent('net-suspending');
      assert.ok(agent);
      assert.equal(agent!.state, 'active');
    });

    it('recovers agents stuck in resuming state (crash recovery)', async () => {
      db.createAgent({ name: 'net-resuming', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('net-resuming')!;
      db.updateAgentState('net-resuming', 'resuming', a.version, {
        tmuxSession: 'agent-net-resuming',
        proxyId: 'p1',
      });

      proxyCommands = [];
      const count = await restoreAllAgents(ctx);
      assert.ok(count >= 1);

      const agent = db.getAgent('net-resuming');
      assert.ok(agent);
      assert.equal(agent!.state, 'active');
    });

    it('skips restore entirely when no proxy is registered', async () => {
      // Move all other agents to non-restorable states so only our test agent is eligible
      for (const a of db.listAgents()) {
        if (a.stateBeforeShutdown || a.state === 'active' || a.state === 'idle'
            || a.state === 'suspending' || a.state === 'resuming') {
          db.updateAgentState(a.name, 'suspended', a.version, { stateBeforeShutdown: null });
        }
      }

      db.createAgent({ name: 'net-no-proxy', engine: 'claude', cwd: '/tmp' });
      const a = db.getAgent('net-no-proxy')!;
      // Set stateBeforeShutdown without a proxy
      db.updateAgentState('net-no-proxy', 'suspended', a.version, {
        stateBeforeShutdown: 'active',
      });

      proxyCommands = [];
      // Remove all proxies temporarily to simulate no available proxies
      const savedProxy = db.getProxy('p1');
      db.removeProxy('p1');

      // proxyWaitMs: 0 so the readiness gate gives up immediately instead of
      // spending its 30s default waiting for a proxy this test just removed.
      const count = await restoreAllAgents(ctx, { proxyWaitMs: 0 });
      // Should not crash — the readiness gate declines to restore anything.
      assert.equal(count, 0);

      // Re-register proxy for subsequent tests
      if (savedProxy) {
        db.registerProxy(savedProxy.proxyId, savedProxy.token, savedProxy.host);
      }
    });

    it('re-adopts agents whose tmux sessions survived restart', async () => {
      // Clean up all agents to isolate this test
      for (const a of db.listAgents()) {
        if (a.stateBeforeShutdown || a.state === 'active' || a.state === 'idle'
            || a.state === 'suspending' || a.state === 'resuming') {
          db.updateAgentState(a.name, 'suspended', a.version, { stateBeforeShutdown: null });
        }
      }

      db.createAgent({ name: 'net-readopt', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('net-readopt')!;
      db.updateAgentState('net-readopt', 'active', a.version, {
        tmuxSession: 'agent-net-readopt',
        proxyId: 'p1',
      });
      // Simulate graceful shutdown
      const active = db.getAgent('net-readopt')!;
      db.updateAgentState('net-readopt', 'suspended', active.version, {
        stateBeforeShutdown: 'active',
      });

      // Context where has_session returns true — tmux survived
      const readoptCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'has_session') {
            return { ok: true, data: true };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const count = await restoreAllAgents(readoptCtx);
      assert.equal(count, 1);

      const agent = db.getAgent('net-readopt')!;
      assert.equal(agent.state, 'active');
      assert.equal(agent.stateBeforeShutdown, null);

      // Should NOT have created a new tmux session or pasted any commands
      assert.ok(!proxyCommands.some(c => c.action === 'create_session'));
      assert.ok(!proxyCommands.some(c => c.action === 'paste'));
    });

    it('re-adopts idle agents as idle (not active)', async () => {
      // Clean up all agents to isolate this test
      for (const a of db.listAgents()) {
        if (a.stateBeforeShutdown || a.state === 'active' || a.state === 'idle'
            || a.state === 'suspending' || a.state === 'resuming') {
          db.updateAgentState(a.name, 'suspended', a.version, { stateBeforeShutdown: null });
        }
      }

      db.createAgent({ name: 'net-readopt-idle', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('net-readopt-idle')!;
      db.updateAgentState('net-readopt-idle', 'idle', a.version, {
        tmuxSession: 'agent-net-readopt-idle',
        proxyId: 'p1',
      });
      // Simulate graceful shutdown while idle
      const idle = db.getAgent('net-readopt-idle')!;
      db.updateAgentState('net-readopt-idle', 'suspended', idle.version, {
        stateBeforeShutdown: 'idle',
      });

      // Context where has_session returns true — tmux survived
      const readoptCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          proxyCommands.push(command);
          if (command.action === 'has_session') {
            return { ok: true, data: true };
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const count = await restoreAllAgents(readoptCtx);
      assert.equal(count, 1);

      const agent = db.getAgent('net-readopt-idle')!;
      assert.equal(agent.state, 'idle', 'idle agent should be readopted as idle, not active');
      assert.equal(agent.stateBeforeShutdown, null);
    });

    it('skips active agents with existing tmux session (no crash)', async () => {
      db.createAgent({ name: 'net-healthy', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      const a = db.getAgent('net-healthy')!;
      db.updateAgentState('net-healthy', 'active', a.version, {
        tmuxSession: 'agent-net-healthy',
        proxyId: 'p1',
      });

      // Context where has_session returns true — agent is healthy
      const healthyCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          if (command.action === 'has_session') {
            return { ok: true, data: true }; // session exists, no crash
          }
          return { ok: true };
        },
      };

      proxyCommands = [];
      const count = await restoreAllAgents(healthyCtx);
      // Healthy active agent should NOT be restored
      const agent = db.getAgent('net-healthy')!;
      assert.equal(agent.state, 'active');
    });
  });

  describe('proxy readiness gate', () => {
    // A registration row is not evidence of a live proxy: startup refreshes
    // stale heartbeats, so a row can outlive its process by up to the reaper
    // window. Restoring against one fails every agent for no fault of its own.
    function makeIsolatedCtx(dbPath: string, opts: { answering: () => boolean }) {
      const isoDb = new Database(dbPath);
      const commands: ProxyCommand[] = [];
      let proxyAnsweringAtFirstNonProbe: boolean | null = null;

      const isoCtx: LifecycleContext = {
        db: isoDb,
        locks: new LockManager(isoDb.rawDb),
        proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
          if (!opts.answering()) {
            return { ok: false, error: 'Proxy unreachable after 3 attempts: fetch failed' };
          }
          const isProbe = command.action === 'has_session'
            && command.sessionName === PROXY_PROBE_SESSION;
          if (!isProbe && proxyAnsweringAtFirstNonProbe === null) {
            proxyAnsweringAtFirstNonProbe = true;
          }
          if (!isProbe) commands.push(command);
          if (command.action === 'has_session') return { ok: true, data: false };
          return { ok: true };
        },
        orchestratorHost: 'http://localhost:3000',
      };

      return {
        db: isoDb,
        ctx: isoCtx,
        commands,
        restoreWorkStarted: () => proxyAnsweringAtFirstNonProbe === true,
      };
    }

    it('does not mark agents failed when a registered proxy is not answering', async () => {
      // This is the shape of the real incident: the row was there, the process
      // was not, and every agent was recorded as failed.
      const { db: isoDb, ctx: isoCtx, restoreWorkStarted } =
        makeIsolatedCtx(join(tmpDir, 'dead-proxy.db'), { answering: () => false });
      try {
        isoDb.registerProxy('p-dead', 'tok', 'localhost:3100');
        isoDb.createAgent({ name: 'stranded', engine: 'claude', cwd: '/tmp', proxyId: 'p-dead' });
        const a = isoDb.getAgent('stranded')!;
        isoDb.updateAgentState('stranded', 'active', a.version, {
          tmuxSession: 'agent-stranded',
          proxyId: 'p-dead',
        });

        const count = await restoreAllAgents(isoCtx, { proxyWaitMs: 50 });

        assert.equal(count, 0, 'restore should report nothing restored');
        const after = isoDb.getAgent('stranded')!;
        assert.equal(after.state, 'active', 'a dead proxy is not the agent\'s fault');
        assert.equal(after.failureReason, null, 'no failure should be recorded');
        assert.equal(restoreWorkStarted(), false, 'restore must not begin against a dead proxy');
      } finally {
        isoDb.close();
      }
    });

    it('does not mark agents failed when no proxy has registered', async () => {
      const { db: isoDb, ctx: isoCtx, commands } =
        makeIsolatedCtx(join(tmpDir, 'no-proxy.db'), { answering: () => false });
      try {
        isoDb.createAgent({ name: 'gated', engine: 'claude', cwd: '/tmp', proxyId: 'p-ghost' });
        const a = isoDb.getAgent('gated')!;
        isoDb.updateAgentState('gated', 'active', a.version, {
          tmuxSession: 'agent-gated',
          proxyId: 'p-ghost',
        });

        const count = await restoreAllAgents(isoCtx, { proxyWaitMs: 50 });

        assert.equal(count, 0);
        const after = isoDb.getAgent('gated')!;
        assert.equal(after.state, 'active', 'agent must not be marked failed');
        assert.equal(after.failureReason, null);
        assert.equal(commands.length, 0, 'nothing should be dispatched before a proxy exists');
      } finally {
        isoDb.close();
      }
    });

    it('proceeds once a proxy starts answering during the wait', async () => {
      let answering = false;
      const { db: isoDb, ctx: isoCtx, commands, restoreWorkStarted } =
        makeIsolatedCtx(join(tmpDir, 'late-proxy.db'), { answering: () => answering });
      try {
        isoDb.registerProxy('p-late', 'tok', 'localhost:3100');
        isoDb.createAgent({ name: 'late', engine: 'claude', cwd: '/tmp', proxyId: 'p-late' });
        const a = isoDb.getAgent('late')!;
        isoDb.updateAgentState('late', 'suspended', a.version, {
          stateBeforeShutdown: 'idle',
          tmuxSession: 'agent-late',
          proxyId: 'p-late',
        });

        // The proxy comes up after the gate has already started waiting.
        const timer = setTimeout(() => { answering = true; }, 150);
        const count = await restoreAllAgents(isoCtx, { proxyWaitMs: 5_000 });
        clearTimeout(timer);

        assert.equal(count, 1, 'the late-answering proxy should still get its agent restored');
        assert.ok(commands.some(c => c.action === 'has_session'), 'restore should have run');
        assert.equal(restoreWorkStarted(), true);
      } finally {
        isoDb.close();
      }
    });
  });
});
