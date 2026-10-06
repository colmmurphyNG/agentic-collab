/**
 * A message pasted into a Claude agent with nothing typed around it is treated as text the
 * user copied in from elsewhere, and the agent holds it for the operator instead of acting.
 * These tests pin which pastes carry the typed prefix that prevents that.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import { deliverToAgent, DELIVERY_TYPED_PREFIX, type LifecycleContext } from './lifecycle.ts';
import type { EngineType, ProxyCommand } from '../shared/types.ts';

describe('message delivery typed prefix', () => {
  let db: Database;
  let tmpDir: string;
  let sent: ProxyCommand[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'delivery-prefix-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    sent = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function ctx(): LifecycleContext {
    return {
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId, command) => {
        sent.push(command);
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
    };
  }

  function makeIdle(name: string, engine: EngineType): void {
    db.createAgent({ name, engine, cwd: '/tmp', proxyId: 'p1' });
    const agent = db.getAgent(name)!;
    db.updateAgentState(name, 'idle', agent.version, { proxyId: 'p1', tmuxSession: `agent-${name}` });
  }

  function pastes(): Extract<ProxyCommand, { action: 'paste' }>[] {
    return sent.filter((c): c is Extract<ProxyCommand, { action: 'paste' }> => c.action === 'paste');
  }

  it('types the prefix ahead of a message pasted into a Claude agent', async () => {
    makeIdle('claude-agent', 'claude');
    const error = await deliverToAgent(ctx(), db.getAgent('claude-agent')!, '[from: tl]: long brief');

    assert.equal(error, null);
    assert.equal(pastes().length, 1);
    assert.equal(pastes()[0]!.text, '[from: tl]: long brief', 'the message itself must be pasted unchanged');
    assert.equal(pastes()[0]!.typedPrefix, DELIVERY_TYPED_PREFIX);
  });

  it('leaves other engines without a prefix', async () => {
    makeIdle('codex-agent', 'codex');
    const error = await deliverToAgent(ctx(), db.getAgent('codex-agent')!, '[from: tl]: brief');

    assert.equal(error, null);
    assert.ok(pastes().length >= 1, 'the message must still be delivered');
    assert.ok(pastes().every((c) => c.typedPrefix === undefined));
  });

  it('keeps the prefix on one line so typing it cannot submit early', () => {
    assert.doesNotMatch(DELIVERY_TYPED_PREFIX, /[\r\n]/);
  });
});
