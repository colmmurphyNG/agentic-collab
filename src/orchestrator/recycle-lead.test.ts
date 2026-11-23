import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from './database.ts';
import { LockManager } from '../shared/lock.ts';
import { HealthMonitor } from './health-monitor.ts';
import { personaRecycleLead } from './persona.ts';

describe('personaRecycleLead', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'recycle-lead-persona-'));
    writeFileSync(join(dir, 'plain.md'), '---\nengine: claude\n---\nBody\n');
    writeFileSync(join(dir, 'ent-b.md'), '---\nengine: claude\nlead: tl-ent\n---\nBody\n');
    writeFileSync(join(dir, 'quiet.md'), '---\nengine: claude\nlead: none\n---\nBody\n');
    writeFileSync(join(dir, 'tl.md'), '---\nengine: claude\n---\nBody\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to tl when the persona names no lead', () => {
    assert.equal(personaRecycleLead('plain', null, dir), 'tl');
  });

  it('uses the lead the persona names', () => {
    assert.equal(personaRecycleLead('ent-b', null, dir), 'tl-ent');
  });

  it('returns null for lead: none', () => {
    assert.equal(personaRecycleLead('quiet', null, dir), null);
  });

  it('never makes an agent its own lead', () => {
    assert.equal(personaRecycleLead('tl', null, dir), null);
  });

  it('defaults to tl when there is no persona file', () => {
    assert.equal(personaRecycleLead('missing', null, dir), 'tl');
  });
});

describe('HealthMonitor.notifyLeadOfRecycle', () => {
  let tmp: string;
  let db: Database;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'recycle-lead-db-'));
    db = new Database(join(tmp, 'test.db'));
    db.createAgent({ name: 'lead-a', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
    db.createAgent({ name: 'worker-a', engine: 'claude', cwd: '/tmp', proxyId: 'p1' });
  });
  after(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function monitorWithLead(lead: string | null, queued: string[]): HealthMonitor {
    return new HealthMonitor({
      db,
      locks: new LockManager(db.rawDb),
      proxyDispatch: async () => ({ ok: true }),
      orchestratorHost: 'http://localhost:3000',
      pollIntervalMs: 100,
      recycleLead: () => lead,
      onSystemMessageQueued: (n) => { queued.push(n); },
    });
  }
  const notices = (name: string) =>
    db.getDeliverableMessages(name).filter((m) => m.envelope.includes('is back after an automatic recycle'));

  it('queues one message to the lead naming the recycled agent', () => {
    const queued: string[] = [];
    monitorWithLead('lead-a', queued).notifyLeadOfRecycle(db.getAgent('worker-a')!);
    const sent = notices('lead-a');
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.envelope, /worker-a is back/);
    assert.deepEqual(queued, ['lead-a']);
  });

  it('sends nothing when the lead is not a registered agent', () => {
    const queued: string[] = [];
    monitorWithLead('nobody', queued).notifyLeadOfRecycle(db.getAgent('worker-a')!);
    assert.equal(notices('nobody').length, 0);
    assert.deepEqual(queued, []);
  });

  it('sends nothing when there is no lead', () => {
    const queued: string[] = [];
    monitorWithLead(null, queued).notifyLeadOfRecycle(db.getAgent('worker-a')!);
    assert.deepEqual(queued, []);
  });
});
