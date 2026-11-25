import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import {
  spawnAgent, resumeAgent, reloadAgent, recoverAgent, recycleAgent,
  type LifecycleContext,
} from './lifecycle.ts';

describe('baseline_tokens column', () => {
  it('is added to an existing agents table that lacks it, and defaults to null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baseline-migration-'));
    try {
      const path = join(dir, 'test.db');
      const first = new Database(path);
      first.rawDb.exec('ALTER TABLE agents DROP COLUMN baseline_tokens');
      first.close();

      const second = new Database(path);
      second.createAgent({ name: 'migrated', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      assert.equal(second.getAgent('migrated')!.baselineTokens, null);
      const rec = second.getAgent('migrated')!;
      second.updateAgentState('migrated', 'idle', rec.version, { baselineTokens: 64000 });
      assert.equal(second.getAgent('migrated')!.baselineTokens, 64000);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('baselineTokens is cleared when a session starts', () => {
  let db: Database;
  let tmpDir: string;
  let ctx: LifecycleContext;
  let origPersonasDir: string | undefined;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'baseline-lifecycle-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    origPersonasDir = process.env['PERSONAS_DIR'];
    process.env['PERSONAS_DIR'] = join(tmpDir, 'personas');
  });

  after(() => {
    if (origPersonasDir === undefined) delete process.env['PERSONAS_DIR'];
    else process.env['PERSONAS_DIR'] = origPersonasDir;
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    ctx = {
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        if (command.action === 'has_session') return { ok: true, data: false };
        if (command.action === 'capture') return { ok: true, data: '> \n' };
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
    };
  });

  function seed(name: string, state: 'void' | 'active' | 'suspended' | 'failed'): void {
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(name)!;
    db.updateAgentState(name, state, a.version, {
      tmuxSession: `agent-${name}`,
      proxyId: 'p1',
      baselineTokens: 70000,
      ...(state === 'suspended' ? { currentSessionId: 'sess-1' } : {}),
    });
    assert.equal(db.getAgent(name)!.baselineTokens, 70000, 'precondition: baseline is set');
  }

  const paths: Array<{ label: string; state: 'void' | 'active' | 'suspended' | 'failed'; run: (name: string) => Promise<unknown> }> = [
    { label: 'spawn', state: 'void', run: (n) => spawnAgent(ctx, { name: n, engine: 'claude', cwd: '/tmp', proxyId: 'p1' }) },
    { label: 'resume', state: 'suspended', run: (n) => resumeAgent(ctx, n) },
    { label: 'reload', state: 'active', run: (n) => reloadAgent(ctx, n, { immediate: true }) },
    { label: 'recover', state: 'failed', run: (n) => recoverAgent(ctx, n) },
    { label: 'recycle', state: 'active', run: (n) => recycleAgent(ctx, n) },
  ];

  for (const p of paths) {
    it(`${p.label} sets baselineTokens back to null`, async () => {
      const name = `baseline-${p.label}`;
      seed(name, p.state);
      await p.run(name);
      assert.equal(db.getAgent(name)!.baselineTokens, null);
    });
  }
});
