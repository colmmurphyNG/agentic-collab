import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from './database.ts';
import { JobDispatcher } from './job-dispatcher.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


/** Minimal mock that records tryDeliver calls */
function mockMessageDispatcher(): MessageDispatcher & { deliverCalls: string[] } {
  const deliverCalls: string[] = [];
  return {
    deliverCalls,
    tryDeliver: async (agentName: string) => { deliverCalls.push(agentName); return false; },
    stop: () => {},
  } as unknown as MessageDispatcher & { deliverCalls: string[] };
}


/** ISO timestamp N seconds ago, without milliseconds (matches DB format). */
function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}


describe('JobDispatcher', () => {
  let db: Database;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentic-job-dispatch-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.createAgent({ name: 'job-target', engine: 'claude', cwd: '/tmp' });
    db.createAgent({ name: 'job-target-active', engine: 'claude', cwd: '/tmp' });
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should fire a due job, advance next_fire_at, and trigger delivery', () => {
    const job = db.createJob({
      agentName: 'job-target',
      createdBy: 'ben',
      prompt: 'Run the PR audit',
      cronExpr: '0 */5 * * *',
      nextFireAt: isoSecondsAgo(60),  // due 60s ago
    });

    const queued: unknown[] = [];
    const mock = mockMessageDispatcher();
    const dispatcher = new JobDispatcher({
      db,
      messageDispatcher: mock,
      onQueueUpdate: (msg) => queued.push(msg),
    });

    dispatcher.tick();

    assert.equal(queued.length, 1);
    assert.deepEqual(mock.deliverCalls, ['job-target']);

    const pending = db.getDeliverableMessages('job-target');
    assert.ok(pending.some(m => m.envelope.includes('Run the PR audit')));
    assert.ok(pending.some(m => m.envelope.includes(`job #${job.id}`)));
    assert.ok(pending.some(m => m.envelope.includes('from ben')));

    const updated = db.getJob(job.id)!;
    assert.notEqual(updated.nextFireAt, job.nextFireAt);
    assert.equal(updated.status, 'active');  // jobs stay active after firing
    assert.ok(updated.lastFiredAt);

    db.deleteJob(job.id);
  });

  it('should skip a job whose next_fire_at is in the future', () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const job = db.createJob({
      agentName: 'job-target',
      prompt: 'Not yet',
      cronExpr: '0 */5 * * *',
      nextFireAt: futureIso,
    });

    const mock = mockMessageDispatcher();
    const dispatcher = new JobDispatcher({ db, messageDispatcher: mock });
    dispatcher.tick();

    assert.equal(mock.deliverCalls.length, 0);
    const after = db.getJob(job.id)!;
    assert.equal(after.lastFiredAt, null);

    db.deleteJob(job.id);
  });

  it('should skip a paused job even if it is due', () => {
    const job = db.createJob({
      agentName: 'job-target',
      prompt: 'Paused job',
      cronExpr: '* * * * *',
      nextFireAt: isoSecondsAgo(60),
    });
    db.updateJobStatus(job.id, 'paused');

    const mock = mockMessageDispatcher();
    const dispatcher = new JobDispatcher({ db, messageDispatcher: mock });
    dispatcher.tick();

    assert.equal(mock.deliverCalls.length, 0);
    db.deleteJob(job.id);
  });

  it('should respect skip_if_active when the target agent is active', () => {
    // Move job-target-active into 'active' state
    {
      const current = db.getAgent('job-target-active');
      if (current) db.updateAgentState('job-target-active', 'active', current.version);
    }

    const job = db.createJob({
      agentName: 'job-target-active',
      prompt: 'Active-skip',
      cronExpr: '* * * * *',
      nextFireAt: isoSecondsAgo(60),
      skipIfActive: true,
    });

    const mock = mockMessageDispatcher();
    const dispatcher = new JobDispatcher({ db, messageDispatcher: mock });
    dispatcher.tick();

    assert.equal(mock.deliverCalls.length, 0);

    // Job stays scheduled — next_fire_at NOT advanced on skip
    const after = db.getJob(job.id)!;
    assert.equal(after.lastFiredAt, null);

    db.deleteJob(job.id);
    {
      const current = db.getAgent('job-target-active');
      if (current) db.updateAgentState('job-target-active', 'idle', current.version);
    }
  });

  it('should fire when skip_if_active=false even on an active agent', () => {
    {
      const current = db.getAgent('job-target-active');
      if (current) db.updateAgentState('job-target-active', 'active', current.version);
    }

    const job = db.createJob({
      agentName: 'job-target-active',
      prompt: 'Force-fire',
      cronExpr: '* * * * *',
      nextFireAt: isoSecondsAgo(60),
      skipIfActive: false,
    });

    const mock = mockMessageDispatcher();
    const dispatcher = new JobDispatcher({ db, messageDispatcher: mock });
    dispatcher.tick();

    assert.deepEqual(mock.deliverCalls, ['job-target-active']);
    db.deleteJob(job.id);
    {
      const current = db.getAgent('job-target-active');
      if (current) db.updateAgentState('job-target-active', 'idle', current.version);
    }
  });

  it('should pause a job whose cron expression becomes invalid', () => {
    // Insert a job with a deliberately bad cron — simulates a corrupted row
    const job = db.createJob({
      agentName: 'job-target',
      prompt: 'Bad cron',
      cronExpr: 'not a cron expression',
      nextFireAt: isoSecondsAgo(60),
    });

    const mock = mockMessageDispatcher();
    const dispatcher = new JobDispatcher({ db, messageDispatcher: mock });
    dispatcher.tick();

    // It still enqueues a message (the prompt itself isn't gated on cron validity)
    // — but next-fire computation fails, so the dispatcher pauses the job rather
    // than leave it stuck firing every tick forever.
    const after = db.getJob(job.id)!;
    assert.equal(after.status, 'paused');

    db.deleteJob(job.id);
  });

  it('validateCron should not throw on a good cron and should throw on a bad one', () => {
    const dispatcher = new JobDispatcher({ db, messageDispatcher: mockMessageDispatcher() });
    assert.doesNotThrow(() => dispatcher.validateCron('0 */5 * * *'));
    assert.throws(() => dispatcher.validateCron('not a cron 1 2'), /only literals/);
    assert.throws(() => dispatcher.validateCron('* * * *'), /5 space-separated fields/);
  });

  it('computeNextFire should return a string in DB-compatible ISO format', () => {
    const dispatcher = new JobDispatcher({ db, messageDispatcher: mockMessageDispatcher() });
    const next = dispatcher.computeNextFire('0 */5 * * *', new Date(Date.UTC(2026, 5, 1, 0, 1, 0)));
    // No fractional seconds — matches the DB column format
    assert.match(next, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
