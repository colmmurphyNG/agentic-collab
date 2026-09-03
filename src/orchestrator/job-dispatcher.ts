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


/**
 * How many consecutive `skipIfActive` skips to tolerate before firing anyway. At the default
 * 60-second tick that is roughly ten minutes of deferring to a busy agent, after which a missed
 * run costs more than a queued message does.
 */
export const MAX_CONSECUTIVE_SKIPS = 10;

export class JobDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive skipIfActive skips per job id. Reset when the job actually fires. */
  private consecutiveSkips = new Map<number, number>();
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
          const skips = (this.consecutiveSkips.get(job.id) ?? 0) + 1;
          this.consecutiveSkips.set(job.id, skips);
          if (skips < MAX_CONSECUTIVE_SKIPS) {
            // Log the FIRST skip and then sparsely. A silent skip is what let an hourly job miss
            // 24 consecutive runs on 2026-09-01/02 with no signal anywhere: the skip wrote no line
            // AND did not advance next_fire_at, so the job stayed permanently due and permanently
            // skipped. Silence is also the expected output of these jobs on success, so a stalled
            // schedule and a healthy quiet one looked identical.
            if (skips === 1 || skips % 5 === 0) {
              console.log(
                `[jobs] Skipping job #${job.id}: ${job.agentName} is active (${skips} consecutive; ` +
                  `firing anyway at ${MAX_CONSECUTIVE_SKIPS})`,
              );
            }
            continue;
          }
          // Deferring has stopped being politeness and become a stall. Fire regardless: delivery is
          // queued and the message dispatcher already waits for a deliverable state, so enqueueing
          // to a busy agent costs a delay rather than an interruption. An unbounded skip costs the
          // run entirely, which is strictly worse.
          console.warn(
            `[jobs] Job #${job.id} has been skipped ${skips} times because ${job.agentName} is ` +
              `active. Firing anyway — an unbounded skip silently drops every run.`,
          );
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
      this.consecutiveSkips.delete(job.id);

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
