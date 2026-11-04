import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import {
  spawnAgent, resumeAgent, reloadAgent, recoverAgent, recycleAgent,
  resolveCpuPriorityOverride,
  type LifecycleContext,
} from './lifecycle.ts';

type CreateSession = Extract<ProxyCommand, { action: 'create_session' }>;

describe('cpu_priority persona override reaches create_session on every launch path', () => {
  let db: Database;
  let tmpDir: string;
  let personasDir: string;
  let origPersonasDir: string | undefined;
  let commands: ProxyCommand[];
  let ctx: LifecycleContext;
  let sessionExists: boolean;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cpu-priority-launch-'));
    personasDir = join(tmpDir, 'personas');
    db = new Database(join(tmpDir, 'test.db'));
    db.registerProxy('p1', 'tok', 'localhost:3100');
    origPersonasDir = process.env['PERSONAS_DIR'];
    process.env['PERSONAS_DIR'] = personasDir;
  });

  after(() => {
    if (origPersonasDir === undefined) delete process.env['PERSONAS_DIR'];
    else process.env['PERSONAS_DIR'] = origPersonasDir;
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    commands = [];
    sessionExists = false;
    ctx = {
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async (_proxyId: string, command: ProxyCommand): Promise<ProxyResponse> => {
        commands.push(command);
        if (command.action === 'has_session') return { ok: true, data: sessionExists };
        if (command.action === 'capture') return { ok: true, data: '> \n' };
        return { ok: true };
      },
      orchestratorHost: 'http://localhost:3000',
    };
  });

  function writePersona(name: string, frontmatterLines: string[]): void {
    rmSync(personasDir, { recursive: true, force: true });
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(join(personasDir, `${name}.md`), `---\nengine: claude\ncwd: /tmp\n${frontmatterLines.join('\n')}\n---\nbody\n`);
  }

  function created(): CreateSession[] {
    return commands.filter((c): c is CreateSession => c.action === 'create_session');
  }

  function seed(name: string, state: 'active' | 'suspended' | 'failed'): void {
    db.createAgent({ name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    const a = db.getAgent(name)!;
    if (state === 'suspended') {
      db.updateAgentState(name, state, a.version, { tmuxSession: `agent-${name}`, proxyId: 'p1', currentSessionId: 'sess-1' });
    } else {
      db.updateAgentState(name, state, a.version, { tmuxSession: `agent-${name}`, proxyId: 'p1' });
    }
  }

  const paths: Array<{ label: string; name: string; run: (name: string) => Promise<unknown>; state: 'active' | 'suspended' | 'failed' }> = [
    { label: 'spawn', name: 'cpu-spawn', state: 'active', run: async () => undefined },
    { label: 'resume', name: 'cpu-resume', state: 'suspended', run: (n) => resumeAgent(ctx, n) },
    { label: 'reload', name: 'cpu-reload', state: 'active', run: (n) => reloadAgent(ctx, n, { immediate: true }) },
    { label: 'recover', name: 'cpu-recover', state: 'failed', run: (n) => recoverAgent(ctx, n) },
    { label: 'recycle', name: 'cpu-recycle', state: 'active', run: (n) => recycleAgent(ctx, n) },
  ];

  async function launch(p: typeof paths[number]): Promise<void> {
    if (p.label === 'spawn') {
      // spawn starts from a void agent, so it does not go through seed().
      db.createAgent({ name: p.name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      await spawnAgent(ctx, { name: p.name, engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
      return;
    }
    seed(p.name, p.state);
    await p.run(p.name);
  }

  for (const p of paths) {
    it(`${p.label}: persona cpu_priority: normal is passed on create_session`, async () => {
      writePersona(p.name, ['cpu_priority: normal']);
      await launch(p);
      const sessions = created();
      assert.equal(sessions.length, 1, `${p.label} must create exactly one session`);
      assert.equal(sessions[0]!.cpuPriority, 'normal');
    });

    it(`${p.label}: persona cpu_priority: utility is passed on create_session`, async () => {
      writePersona(`${p.name}-u`, ['cpu_priority: utility']);
      const named = { ...p, name: `${p.name}-u` };
      await launch(named);
      const sessions = created();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.cpuPriority, 'utility');
    });

    it(`${p.label}: no persona field leaves cpuPriority unset so the proxy default applies`, async () => {
      writePersona(`${p.name}-d`, []);
      const named = { ...p, name: `${p.name}-d` };
      await launch(named);
      const sessions = created();
      assert.equal(sessions.length, 1);
      assert.equal('cpuPriority' in sessions[0]!, false);
    });
  }

  describe('resolveCpuPriorityOverride', () => {
    it('is case-insensitive and ignores unrecognised values', () => {
      writePersona('cpu-parse', ['cpu_priority: NORMAL']);
      assert.equal(resolveCpuPriorityOverride('cpu-parse'), 'normal');
      writePersona('cpu-parse', ['cpu_priority: background']);
      assert.equal(resolveCpuPriorityOverride('cpu-parse'), undefined);
    });

    it('returns undefined when the persona file does not exist', () => {
      assert.equal(resolveCpuPriorityOverride('no-such-persona-file'), undefined);
    });
  });
});
