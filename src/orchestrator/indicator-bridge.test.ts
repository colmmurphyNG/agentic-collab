import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import {
  createIndicatorBridgeState,
  bridgeIndicatorTransitions,
  clearIndicatorBridgeForAgent,
} from './indicator-bridge.ts';
import type { ActiveIndicator } from '../shared/types.ts';

describe('indicator-bridge', () => {
  let db: Database;
  let tmp: string;
  let state: ReturnType<typeof createIndicatorBridgeState>;

  before(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'indicator-bridge-')));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    db = new Database(join(tmp, `test-${Date.now()}-${Math.random()}.db`));
    db.createAgent({ name: 'tl', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    db.registerProxy('p1', 'tok', 'localhost:3100');
    state = createIndicatorBridgeState();
  });

  function readMessages(agent: string) {
    return db.rawDb
      .prepare("SELECT message, topic, source_agent FROM dashboard_messages WHERE agent = ? AND topic = 'indicator' ORDER BY id ASC")
      .all(agent) as Array<{ message: string; topic: string; source_agent: string }>;
  }

  it('should post a blocker message when a warning indicator first appears', () => {
    const ind: ActiveIndicator[] = [{ id: 'approval', badge: 'Needs Approval', style: 'warning' }];
    const out = bridgeIndicatorTransitions(state, 'tl', ind, db);
    assert.equal(out.length, 1);
    assert.match(out[0]!.message, /⚠️ Needs Approval/);
    assert.equal(out[0]!.topic, 'indicator');
    const msgs = readMessages('tl');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.source_agent, 'system');
  });

  it('should post a danger emoji for danger-style indicators', () => {
    const ind: ActiveIndicator[] = [{ id: 'logged-out', badge: 'Logged Out', style: 'danger' }];
    bridgeIndicatorTransitions(state, 'tl', ind, db);
    const msgs = readMessages('tl');
    assert.match(msgs[0]?.message ?? '', /🔴 Logged Out/);
  });

  it('should NOT re-post when the same indicator stays active across polls', () => {
    const ind: ActiveIndicator[] = [{ id: 'approval', badge: 'Needs Approval', style: 'warning' }];
    bridgeIndicatorTransitions(state, 'tl', ind, db);
    bridgeIndicatorTransitions(state, 'tl', ind, db); // 2nd poll, still active
    bridgeIndicatorTransitions(state, 'tl', ind, db); // 3rd poll
    const msgs = readMessages('tl');
    assert.equal(msgs.length, 1, 'one fire message only, no spam across polls');
  });

  it('should post a cleared message when an indicator disappears', () => {
    const ind: ActiveIndicator[] = [{ id: 'approval', badge: 'Needs Approval', style: 'warning' }];
    bridgeIndicatorTransitions(state, 'tl', ind, db);
    bridgeIndicatorTransitions(state, 'tl', [], db); // indicator gone
    const msgs = readMessages('tl');
    assert.equal(msgs.length, 2);
    assert.match(msgs[1]?.message ?? '', /✓ Needs Approval cleared/);
  });

  it('should handle multiple indicators independently — fire each on first sight', () => {
    bridgeIndicatorTransitions(state, 'tl', [
      { id: 'approval', badge: 'Needs Approval', style: 'warning' },
    ], db);
    bridgeIndicatorTransitions(state, 'tl', [
      { id: 'approval', badge: 'Needs Approval', style: 'warning' },
      { id: 'low-context', badge: 'Low Context', style: 'danger' },
    ], db);
    const msgs = readMessages('tl');
    assert.equal(msgs.length, 2, 'one fire for approval (first poll), one for low-context (second poll)');
    assert.match(msgs[1]?.message ?? '', /Low Context/);
  });

  it('should IGNORE indicators with non-blocker styles (no message posted)', () => {
    const ind: ActiveIndicator[] = [{ id: 'info', badge: 'Idle', style: 'info' }];
    const out = bridgeIndicatorTransitions(state, 'tl', ind, db);
    assert.equal(out.length, 0);
    const msgs = readMessages('tl');
    assert.equal(msgs.length, 0);
  });

  it('should isolate state per agent', () => {
    db.createAgent({ name: 'sfcc', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    bridgeIndicatorTransitions(state, 'tl', [
      { id: 'approval', badge: 'Needs Approval', style: 'warning' },
    ], db);
    // Same indicator on a different agent fires independently
    bridgeIndicatorTransitions(state, 'sfcc', [
      { id: 'approval', badge: 'Needs Approval', style: 'warning' },
    ], db);
    assert.equal(readMessages('tl').length, 1);
    assert.equal(readMessages('sfcc').length, 1);
  });

  it('should clear state when clearIndicatorBridgeForAgent is called (post-destroy)', () => {
    const ind: ActiveIndicator[] = [{ id: 'approval', badge: 'Needs Approval', style: 'warning' }];
    bridgeIndicatorTransitions(state, 'tl', ind, db);
    clearIndicatorBridgeForAgent(state, 'tl');
    // Without state, the same indicator on next call fires as if first-time
    const out = bridgeIndicatorTransitions(state, 'tl', ind, db);
    assert.equal(out.length, 1, 'after clear, indicator re-fires as new');
  });
});
