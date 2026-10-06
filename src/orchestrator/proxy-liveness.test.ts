import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import {
  markProxyAlive,
  wasProxyAlive,
  resetProxyLiveness,
  reapStaleProxies,
} from './proxy-liveness.ts';

describe('proxy liveness', () => {
  beforeEach(() => {
    resetProxyLiveness();
  });

  it('should report a proxy never heard from as not alive', () => {
    assert.equal(wasProxyAlive('p-unknown'), false);
  });

  it('should report a proxy as alive once a signal is recorded', () => {
    markProxyAlive('p1');
    assert.equal(wasProxyAlive('p1'), true);
  });

  it('should keep proxies independent', () => {
    markProxyAlive('p1');
    assert.equal(wasProxyAlive('p1'), true);
    assert.equal(wasProxyAlive('p2'), false, 'one proxy being alive says nothing about another');
  });

  it('should start empty, so a restart means nothing is confirmed yet', () => {
    markProxyAlive('p1');
    resetProxyLiveness();
    assert.equal(
      wasProxyAlive('p1'),
      false,
      'absence must read as never-heard-from, which is the safe direction',
    );
  });

  describe('reapStaleProxies', () => {
    // The incident: a stored heartbeat is refreshed at startup, so a record can
    // look fresh with nothing behind it. Failing agents on that evidence killed
    // a healthy fleet seconds before the proxy finished starting.
    function withDb(fn: (db: Database) => void): void {
      const dir = mkdtempSync(join(tmpdir(), 'reaper-test-'));
      const db = new Database(join(dir, 'test.db'));
      try {
        fn(db);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    function addRunningAgent(db: Database, name: string, proxyId: string): void {
      db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId });
      const a = db.getAgent(name)!;
      db.updateAgentState(name, 'active', a.version, { proxyId, tmuxSession: `agent-${name}` });
    }

    it('should spare agents of a proxy never heard from since startup', () => {
      withDb((db) => {
        db.registerProxy('p-slow', 'tok', 'localhost:3100');
        addRunningAgent(db, 'waiting', 'p-slow');

        // threshold 0 => the record counts as stale immediately, which is what
        // the startup heartbeat refresh produces in the real incident.
        const result = reapStaleProxies(db, 0);

        assert.deepEqual(result.removed, ['p-slow']);
        assert.deepEqual(result.failed, [], 'no agent may be failed for a proxy we never heard from');
        assert.deepEqual(result.spared, ['p-slow']);
        assert.equal(db.getAgent('waiting')!.state, 'active');
        assert.equal(db.getAgent('waiting')!.failureReason, null);
      });
    });

    it('should fail agents of a proxy that was alive and then went away', () => {
      withDb((db) => {
        db.registerProxy('p-gone', 'tok', 'localhost:3100');
        addRunningAgent(db, 'orphaned', 'p-gone');
        markProxyAlive('p-gone');

        const result = reapStaleProxies(db, 0);

        assert.deepEqual(result.removed, ['p-gone']);
        assert.deepEqual(result.failed, ['orphaned'], 'a confirmed-then-absent proxy does orphan its agents');
        assert.deepEqual(result.spared, []);
        const agent = db.getAgent('orphaned')!;
        assert.equal(agent.state, 'failed');
        assert.equal(agent.failureReason, 'Proxy disconnected');
      });
    });

    it('should leave a fresh proxy and its agents untouched', () => {
      withDb((db) => {
        db.registerProxy('p-fresh', 'tok', 'localhost:3100');
        addRunningAgent(db, 'healthy', 'p-fresh');
        markProxyAlive('p-fresh');

        const result = reapStaleProxies(db, 45);

        assert.deepEqual(result.removed, [], 'a proxy inside the threshold is not stale');
        assert.deepEqual(result.failed, []);
        assert.equal(db.getAgent('healthy')!.state, 'active');
      });
    });

    it('should not fail a non-running agent even when its proxy really died', () => {
      withDb((db) => {
        db.registerProxy('p-dead', 'tok', 'localhost:3100');
        db.createAgent({ name: 'parked', engine: 'claude', cwd: '/tmp', proxyId: 'p-dead' });
        markProxyAlive('p-dead');

        const result = reapStaleProxies(db, 0);

        assert.deepEqual(result.failed, [], 'a suspended or void agent has nothing to lose');
        assert.notEqual(db.getAgent('parked')!.state, 'failed');
      });
    });
  });
});
