/**
 * JobDispatcher — fires cron-scheduled prompts at agents as inbound messages.
 *
 * Mirrors ReminderDispatcher's shape but for the JJ "recurring jobs" model:
 *   - Jobs are fire-and-continue (no manual completion)
 *   - Cadence is a cron expression, not a fixed-minute interval
 *   - Status is `active` | `paused`; never `completed`
 *   - On each fire, compute the next next_fire_at via parseCron + nextFireAt
 *
 * Each tick scans for jobs whose next_fire_at <= now AND status='active'.
 * Honours `skip_if_active` — when set (default), jobs targeting an `active`
 * agent are skipped without re-stamping next_fire_at; the next tick will
 * try again. Jobs targeting `paused` agents (the persona state, not the job
 * state) still fire — paused agents are reachable for inbound messages.
 */

import type { Database } from './database.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { PendingMessage, DashboardMessage } from '../shared/types.ts';
import { parseCron, nextFireAt } from '../shared/cron.ts';


export type JobDispatcherOptions = {
  db: Database;
  messageDispatcher: MessageDispatcher;
  onQueueUpdate?: (message: PendingMessage) => void;
  onDashboardMessage?: (message: DashboardMessage) => void;
  intervalMs?: number;
};


export class JobDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Database;
  private readonly messageDispatcher: MessageDispatcher;
  private readonly onQueueUpdate: ((message: PendingMessage) => void) | undefined;
  private readonly onDashboardMessage: ((message: DashboardMessage) => void) | undefined;
  private readonly intervalMs: number;

  constructor(opts: JobDispatcherOptions) {
    this.db = opts.db;
    this.messageDispatcher = opts.messageDispatcher;
    this.onQueueUpdate = opts.onQueueUpdate;
    this.onDashboardMessage = opts.onDashboardMessage;
    this.intervalMs = opts.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    console.log(`[jobs] Starting dispatcher (every ${this.intervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick(): void {
    const due = this.db.listDueJobs();
    for (const job of due) {
      // Skip delivery if the agent is currently active and skipIfActive is set.
      // Note: we do NOT advance next_fire_at on skip — the job will retry next tick.
      if (job.skipIfActive) {
        const agent = this.db.getAgent(job.agentName);
        if (agent && agent.state === 'active') {
          continue;
        }
      }

      const creator = job.createdBy || 'system';
      const envelope = `[job #${job.id} from ${creator}]: ${job.prompt}`;
      const displayMessage = `Job #${job.id}: ${job.prompt}`;

      const dashMsg = this.db.addDashboardMessage(job.agentName, 'to_agent', displayMessage, {
        topic: 'job',
        sourceAgent: creator,
        targetAgent: job.agentName,
      });

      const msg = this.db.enqueueMessage({
        sourceAgent: null,
        targetAgent: job.agentName,
        envelope,
      });
      this.db.linkDashboardMessageToQueue(dashMsg.id, msg.id);

      // Compute next fire BEFORE delivery so a delivery failure doesn't strand
      // the job at a stale next_fire_at (which would make every tick re-fire).
      let nextIso: string;
      try {
        const next = nextFireAt(job.cronExpr, new Date());
        nextIso = next.toISOString().replace(/\.\d{3}Z$/, 'Z');
      } catch (e) {
        console.error(`[jobs] Failed to compute next fire for job #${job.id} (cron '${job.cronExpr}'): ${(e as Error).message}. Pausing job.`);
        this.db.updateJobStatus(job.id, 'paused');
        continue;
      }
      this.db.updateJobFire(job.id, nextIso);

      if (this.onDashboardMessage) {
        this.onDashboardMessage(dashMsg);
      }
      if (this.onQueueUpdate) {
        this.onQueueUpdate(msg);
      }

      console.log(`[jobs] Dispatching job #${job.id} to ${job.agentName} (next fire: ${nextIso})`);
      this.messageDispatcher.tryDeliver(job.agentName).catch((err) => {
        console.error(`[jobs] Delivery trigger failed for ${job.agentName}:`, (err as Error).message);
      });
    }
  }

  /**
   * Validate a cron expression without side effects. Throws if invalid.
   * Useful for routes that need to reject bad input before insert.
   */
  validateCron(expr: string): void {
    parseCron(expr);
  }

  /**
   * Compute the next fire time for a cron expression. Used by route handlers
   * on create / pause-resume to stamp next_fire_at.
   */
  computeNextFire(expr: string, from: Date = new Date()): string {
    const next = nextFireAt(expr, from);
    return next.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}
