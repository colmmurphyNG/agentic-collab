/**
 * Health monitor: polls agents every 30s (read-only observation).
 *
 * Idle detection uses screen-diff: captures the last N lines of tmux pane
 * output each poll cycle and compares to the previous capture. If the output
 * is unchanged across consecutive polls, the agent is considered idle.
 * This is engine-agnostic — no regex prompt detection needed.
 *
 * Context % parsing prefers engine config contextPattern (from detection config)
 * over hardcoded adapter patterns. Falls back to adapters when no pattern is configured.
 * Context percentages are recorded to the DB for dashboard display but do NOT
 * trigger automatic compact or reload actions.
 *
 * Message delivery is entirely owned by MessageDispatcher (event-driven).
 * The health monitor does NOT participate in message delivery.
 */

import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord, PendingMessage, DashboardMessage, IndicatorDefinition, ActiveIndicator, PipelineStep, DetectionConfig } from '../shared/types.ts';
import { sessionName, canSuspend } from '../shared/agent-entity.ts';
import { getAdapter } from './adapters/index.ts';
import { reloadAgent, recoverAgent, recycleAgent, type LifecycleContext } from './lifecycle.ts';
import { resolveEffectiveConfig } from './engine-config-resolver.ts';
import { cliFailurePatterns, shellPromptPatterns } from './cli-failure-patterns.ts';

type CompiledDetection = {
  json: string;
  config: DetectionConfig;
  idlePatterns: Array<{ re: RegExp; lines?: number }>;
  activePatterns: Array<{ re: RegExp; lines?: number }>;
  contextPattern: RegExp | null;
};

export type HealthMonitorOptions = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  orchestratorHost: string;
  onAgentUpdate?: (agentName: string) => void;
  onQueueUpdate?: (message: PendingMessage) => void;
  onDashboardMessage?: (message: DashboardMessage) => void;
  onIndicatorUpdate?: (agentName: string, indicators: ActiveIndicator[]) => void;
  onIdleDetected?: (agentName: string) => void;
  pollIntervalMs?: number;
  idleSuspendMs?: number;        // ms of idle before suspend (default 5 minutes)
};

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_IDLE_SUSPEND_MS = 5 * 60 * 1000;

/**
 * Exponential backoff schedule for consecutive auto-recover failures of
 * the same agent. `failures` is the number of attempts already made (0
 * means no previous attempts → first attempt is immediate). Returns the
 * MIN milliseconds that must elapse since the last attempt before the
 * next is allowed.
 *
 * Curve:
 *   0 attempts: 0ms     (first failure — immediate retry, pre-backoff behaviour)
 *   1 attempt:  30s
 *   2 attempts: 2min
 *   3 attempts: 5min
 *   4+ attempts: 15min cap
 *
 * Designed to absorb genuinely-transient failures (Claude TUI crash on
 * busy load, MCP-server hiccup) with no delay, while throttling
 * persistent wedges (bad persona file, missing dependency) so they don't
 * burn through ~5 spawns/minute without operator intervention.
 *
 * Exported for unit testing — the policy itself is the entire surface.
 */
export function autoRecoverBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  if (failures === 1) return 30 * 1000;
  if (failures === 2) return 2 * 60 * 1000;
  if (failures === 3) return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private readonly quickPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Consecutive health check failure count per agent. */
  private readonly consecutiveFailures = new Map<string, number>();
  private static readonly FAILURE_THRESHOLD = 3; // failures before marking agent as failed
  /** Pane snapshot captured at the moment an agent was marked failed.
   *  Used to distinguish stale pane output from a genuinely revived CLI. */
  private readonly failureSnapshot = new Map<string, string>();
  /** Last tmux window_activity timestamp per agent. When unchanged between
   *  polls, the pane has received no output — agent is definitively idle
   *  without needing to capture and diff pane content. */
  private readonly lastActivityTs = new Map<string, number>();
  /**
   * Last captured pane snapshot (ANSI-stripped, last N lines) per agent.
   * Used for screen-diff idle detection.
   */
  private readonly lastPaneSnapshot = new Map<string, string>();
  /**
   * Count of consecutive polls where pane output was unchanged.
   * When >= IDLE_THRESHOLD, the agent is considered idle.
   */
  private readonly unchangedCount = new Map<string, number>();
  /**
   * Number of consecutive unchanged polls required before marking idle.
   * With 2s fast-poll, 2 consecutive (after baseline) = 6s to detect idle.
   */
  static readonly IDLE_THRESHOLD = 2;
  /**
   * Grace period (ms) after last detected activity before allowing idle transition.
   * Resets every time new output is detected, preventing active/idle blinking
   * when agents produce intermittent output.
   */
  static readonly ACTIVE_GRACE_MS = parseInt(process.env['ACTIVE_GRACE_MS'] ?? '10000', 10);
  /** Timestamp of last detected screen change per agent. */
  private readonly lastActivityDetected = new Map<string, number>();
  /** Number of trailing pane lines to capture for screen-diff. */
  static readonly SNAPSHOT_LINES = 30;
  /**
   * Last auto-recycle timestamp per agent. Used to enforce the cool-down so
   * an agent that just recycled doesn't immediately re-trigger if its new
   * session somehow lands back above the threshold (e.g. operator pastes a
   * huge prompt right after spawn).
   */
  private readonly lastAutoRecycleAt = new Map<string, number>();
  /**
   * Context-percentage threshold that triggers an auto-recycle. Above this,
   * the agent is destroyed + respawned with a fresh SESSION_ID, with the
   * existing Q v1/v2 handoff snapshot preserving its last 30 tmux lines and
   * 10 dashboard messages for the new instance.
   *
   * Env-overridable for testing / dialing in.
   */
  static readonly AUTO_RECYCLE_THRESHOLD_PCT = parseInt(process.env['AUTO_RECYCLE_THRESHOLD_PCT'] ?? '92', 10);
  /**
   * Cool-down between auto-recycles for the same agent. Defense-in-depth so
   * a cold-start ctx spike right after spawn doesn't immediately re-trigger.
   * Default 30 min — set to 0 in tests.
   */
  static readonly AUTO_RECYCLE_COOLDOWN_MS = parseInt(process.env['AUTO_RECYCLE_COOLDOWN_MS'] ?? String(30 * 60 * 1000), 10);
  private readonly db: Database;
  private readonly locks: LockManager;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly orchestratorHost: string;
  private readonly pollIntervalMs: number;
  private readonly idleSuspendMs: number;
  static readonly FAST_POLL_MS = 2_000;
  private readonly onAgentUpdate: (agentName: string) => void;
  private readonly onQueueUpdate: (message: PendingMessage) => void;
  private readonly onDashboardMessage: (message: DashboardMessage) => void;
  private readonly onIndicatorUpdate: (agentName: string, indicators: ActiveIndicator[]) => void;
  private readonly onIdleDetected: (agentName: string) => void;
  private readonly activeIndicators = new Map<string, ActiveIndicator[]>();
  private readonly compiledIndicators = new Map<string, { json: string; entries: Array<{ def: IndicatorDefinition; re: RegExp }> }>();
  private readonly compiledDetection = new Map<string, CompiledDetection>();
  /** Timestamp when an agent was healed — used to suppress stale exit-message
   *  re-detection during the grace period after healing. */
  private readonly healedAt = new Map<string, number>();
  /** Per-agent consecutive auto-recover failure tracking — drives exponential
   *  backoff so a wedged agent (persistent bad config, missing file, etc.)
   *  doesn't burn through 8 spawn attempts in 2 minutes. Counter increments
   *  each time maybeAutoRecover fires; resets to 0 on successful recover. */
  private readonly recoverFailures = new Map<string, { count: number; lastAttemptAt: number }>();

  constructor(opts: HealthMonitorOptions) {
    this.db = opts.db;
    this.locks = opts.locks;
    this.proxyDispatch = opts.proxyDispatch;
    this.orchestratorHost = opts.orchestratorHost;
    this.onAgentUpdate = opts.onAgentUpdate ?? (() => {});
    this.onQueueUpdate = opts.onQueueUpdate ?? (() => {});
    this.onDashboardMessage = opts.onDashboardMessage ?? (() => {});
    this.onIndicatorUpdate = opts.onIndicatorUpdate ?? (() => {});
    this.onIdleDetected = opts.onIdleDetected ?? (() => {});
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.idleSuspendMs = opts.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS;
  }

  /**
   * Strip ANSI escape sequences from a string.
   * Handles CSI sequences (colors, cursor), OSC sequences (hyperlinks, titles),
   * and single-character escapes.
   */
  /** Merge engine config defaults into agent record for indicator/detection resolution. */
  private resolveAgent(agent: AgentRecord): AgentRecord {
    const engineConfig = this.db.getEngineConfig(agent.engine);
    return resolveEffectiveConfig(agent, engineConfig);
  }

  static stripAnsi(text: string): string {
    // CSI: \x1b[ ... final byte (letter)
    // OSC: \x1b] ... ST (\x1b\\ or \x07)
    // Single-char: \x1b followed by a non-[ non-] byte
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g, '');
  }

  /**
   * Take a snapshot of the last N lines of pane output for screen-diff.
   * Strips ANSI codes and trailing whitespace for stable comparison.
   */
  static takeSnapshot(paneOutput: string, lines: number = HealthMonitor.SNAPSHOT_LINES): string {
    const stripped = HealthMonitor.stripAnsi(paneOutput);
    const allLines = stripped.split('\n');
    return allLines
      .slice(-lines)
      .map(l => l.trimEnd())
      .join('\n');
  }

  /**
   * Resolve and cache compiled detection config for an agent's engine.
   * Returns null if the engine has no detection config.
   */
  private getDetection(agent: AgentRecord): CompiledDetection | null {
    const engineConfig = this.db.getEngineConfig(agent.engine);
    const detectionJson = engineConfig?.detection ?? null;
    if (!detectionJson) {
      this.compiledDetection.delete(agent.engine);
      return null;
    }

    const cached = this.compiledDetection.get(agent.engine);
    if (cached && cached.json === detectionJson) return cached;

    try {
      const config: DetectionConfig = JSON.parse(detectionJson);
      const idlePatterns: Array<{ re: RegExp; lines?: number }> = [];
      const activePatterns: Array<{ re: RegExp; lines?: number }> = [];
      for (const p of config.idlePatterns ?? []) {
        const raw = typeof p === 'string' ? p : p.pattern;
        const lines = typeof p === 'object' ? p.lines : undefined;
        try { idlePatterns.push({ re: new RegExp(raw), lines }); } catch { /* skip invalid */ }
      }
      for (const p of config.activePatterns ?? []) {
        const raw = typeof p === 'string' ? p : p.pattern;
        const lines = typeof p === 'object' ? p.lines : undefined;
        try { activePatterns.push({ re: new RegExp(raw), lines }); } catch { /* skip invalid */ }
      }
      let contextPattern: RegExp | null = null;
      if (config.contextPattern) {
        try { contextPattern = new RegExp(config.contextPattern); } catch { /* skip */ }
      }
      const compiled: CompiledDetection = { json: detectionJson, config, idlePatterns, activePatterns, contextPattern };
      this.compiledDetection.set(agent.engine, compiled);
      return compiled;
    } catch {
      return null;
    }
  }

  /**
   * Screen-diff idle detection, augmented by engine detection patterns.
   * Pattern match takes priority: idle pattern match → idle, active pattern match → active.
   * Falls back to screen-diff when no patterns match.
   * Returns true if the agent appears idle.
   */
  private checkScreenDiff(agent: AgentRecord, paneOutput: string): boolean {
    const detection = this.getDetection(agent);
    const snapshotLines = detection?.config.snapshotLines ?? HealthMonitor.SNAPSHOT_LINES;
    const idleThreshold = detection?.config.idleThreshold ?? HealthMonitor.IDLE_THRESHOLD;

    const snapshot = HealthMonitor.takeSnapshot(paneOutput, snapshotLines);
    const prev = this.lastPaneSnapshot.get(agent.name);
    this.lastPaneSnapshot.set(agent.name, snapshot);

    // Pattern-based detection takes priority over screen-diff
    if (detection && (detection.idlePatterns.length > 0 || detection.activePatterns.length > 0)) {
      const fullStripped = HealthMonitor.stripAnsi(paneOutput);
      const allLines = fullStripped.split('\n');
      // Helper: get the text to match — either last N lines or full output
      const textForPattern = (lines?: number) => {
        if (lines && lines < allLines.length) return allLines.slice(-lines).join('\n');
        return fullStripped;
      };
      // Check active patterns first — if something indicates work, it's active
      for (const { re, lines } of detection.activePatterns) {
        if (re.test(textForPattern(lines))) {
          this.unchangedCount.set(agent.name, 0);
          this.lastActivityDetected.set(agent.name, Date.now());
          return false;
        }
      }
      // Check idle patterns — if something indicates waiting, it's idle
      for (const { re, lines } of detection.idlePatterns) {
        if (re.test(textForPattern(lines))) {
          const count = (this.unchangedCount.get(agent.name) ?? 0) + 1;
          this.unchangedCount.set(agent.name, count);
          return count >= idleThreshold;
        }
      }
    }

    // Fallback: screen-diff
    if (prev === undefined) {
      this.unchangedCount.set(agent.name, 0);
      return false;
    }

    if (snapshot === prev) {
      const count = (this.unchangedCount.get(agent.name) ?? 0) + 1;
      this.unchangedCount.set(agent.name, count);
      return count >= idleThreshold;
    } else {
      this.unchangedCount.set(agent.name, 0);
      this.lastActivityDetected.set(agent.name, Date.now());
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    console.log(`[health] Starting monitor (poll every ${this.pollIntervalMs}ms, fast-poll every ${HealthMonitor.FAST_POLL_MS}ms for active agents)`);
    this.timer = setInterval(() => {
      this.pollAll().catch((err) => {
        console.error('[health] Poll error:', err);
      });
    }, this.pollIntervalMs);
    this.fastTimer = setInterval(() => {
      this.pollActiveAgents().catch((err) => {
        console.error('[health] Fast poll error:', err);
      });
    }, HealthMonitor.FAST_POLL_MS);
  }

  stop(): void {
    if (this.fastTimer) {
      clearInterval(this.fastTimer);
      this.fastTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[health] Monitor stopped');
    }
    for (const timer of this.quickPollTimers.values()) {
      clearTimeout(timer);
    }
    this.quickPollTimers.clear();
  }

  /**
   * Schedule a one-shot poll for a specific agent ~1s from now.
   * Used after message delivery to catch the idle→active transition quickly.
   * Deduplicates: only one quick poll per agent at a time.
   */
  scheduleQuickPoll(agentName: string): void {
    if (this.quickPollTimers.has(agentName)) return;
    const timer = setTimeout(() => {
      this.quickPollTimers.delete(agentName);
      const agent = this.db.getAgent(agentName);
      if (agent && agent.proxyId) {
        this.pollAgent(agent).catch((err) => {
          console.error(`[health] Quick poll error for ${agentName}:`, err);
        });
      }
    }, 1000);
    this.quickPollTimers.set(agentName, timer);
  }

  /**
   * Fast-poll only active agents (every 5s) for near real-time state detection.
   * Uses screen-diff: captures last N lines of pane, compares to previous capture.
   * Unchanged across IDLE_THRESHOLD consecutive polls → idle.
   */
  async pollActiveAgents(): Promise<void> {
    const agents = this.db.listAgents().filter(
      (a) => a.state === 'active' && a.proxyId,
    );
    for (const agent of agents) {
      try {
        // Fast path: check window_activity before expensive capture
        const activityResult = await this.proxyDispatch(agent.proxyId!, {
          action: 'pane_activity',
          sessionName: sessionName(agent),
        } as ProxyCommand);
        const resolved = this.resolveAgent(agent);
        const hasDetectionPatterns = this.getDetection(resolved) !== null;

        if (activityResult.ok) {
          const currentTs = activityResult.data as number;
          const prevTs = this.lastActivityTs.get(agent.name);
          this.lastActivityTs.set(agent.name, currentTs);
          if (prevTs !== undefined && currentTs === prevTs && !hasDetectionPatterns) {
            // Pane unchanged and no detection patterns — definitively idle, skip capture
            this.handleIdleTransitions(agent, true);
            continue;
          }
        }

        // Capture pane output for detection patterns and/or screen-diff
        const paneOutput = await this.capturePaneOutput(agent);
        if (paneOutput === null) continue;
        this.evaluateIndicators(resolved, paneOutput);
        const isIdle = this.checkScreenDiff(resolved, paneOutput);
        this.handleIdleTransitions(agent, isIdle);
      } catch (err) {
        console.error(`[health] Fast poll error for ${agent.name}:`, err);
      }
    }
  }

  /**
   * Poll all active/idle agents.
   */
  async pollAll(): Promise<void> {
    const allAgents = this.db.listAgents();

    // Poll active/idle agents for health, idle detection, indicators
    const liveAgents = allAgents.filter(a => canSuspend(a) && a.proxyId);
    for (const agent of liveAgents) {
      try {
        await this.pollAgent(agent);
      } catch (err) {
        console.error(`[health] Error polling ${agent.name}:`, err);
      }
    }

    // Poll failed agents for recovery — CLI may have been resumed via tmux injection
    const failedAgents = allAgents.filter(a => a.state === 'failed' && a.proxyId && a.tmuxSession);
    for (const agent of failedAgents) {
      try {
        await this.pollFailedAgent(agent);
      } catch (err) {
        console.error(`[health] Error polling failed ${agent.name}:`, err);
      }
    }
  }

  /**
   * Poll a single agent. Read-only observation + idle detection.
   */
  async pollAgent(agentSnapshot: AgentRecord): Promise<void> {
    const agent = this.db.getAgent(agentSnapshot.name);
    if (!agent || !agent.proxyId || !canSuspend(agent)) return;

    const resolved = this.resolveAgent(agent);
    const hasDetectionPatterns = this.getDetection(resolved) !== null;

    // Fast path: check tmux window_activity timestamp before expensive capture.
    const activityResult = await this.proxyDispatch(agent.proxyId, {
      action: 'pane_activity',
      sessionName: sessionName(agent),
    } as ProxyCommand);
    if (activityResult.ok) {
      const currentTs = activityResult.data as number;
      const prevTs = this.lastActivityTs.get(agent.name);
      this.lastActivityTs.set(agent.name, currentTs);
      if (prevTs !== undefined && currentTs === prevTs && !hasDetectionPatterns) {
        // Pane unchanged and no detection patterns — definitively idle
        this.handleIdleTransitions(agent, true);
        this.checkIdleSuspendTimeout(agent.name);
        return;
      }
    }

    const paneOutput = await this.capturePaneOutput(agent);
    if (paneOutput === null) return;

    // Check if the CLI exited back to a bare shell prompt (e.g. session not found)
    if (this.detectCliExit(agent, paneOutput)) {
      this.maybeAutoRecover(agent);
      return;
    }

    this.recordContextPercent(agent, paneOutput);
    this.evaluateIndicators(resolved, paneOutput);

    const isIdle = this.checkScreenDiff(resolved, paneOutput);
    this.handleIdleTransitions(agent, isIdle);

    this.checkIdleSuspendTimeout(agent.name);

    if (isIdle) {
      await this.handleQueuedReload(agent.name);
    }

    // Update lastActivity on every successful poll so dashboard timestamps stay fresh.
    // Done last to avoid version conflicts with other state updates above.
    const latest = this.db.getAgent(agent.name);
    if (latest) {
      this.db.updateAgentState(agent.name, latest.state, latest.version, {
        lastActivity: new Date().toISOString(),
      });
    }
  }

  /**
   * Capture pane output for an agent. Returns null if capture failed
   * (agent marked as failed as a side-effect).
   */
  private async capturePaneOutput(agent: AgentRecord): Promise<string | null> {
    const captureResult = await this.proxyDispatch(agent.proxyId!, {
      action: 'capture',
      sessionName: sessionName(agent),
      lines: 50,
    });

    if (!captureResult.ok) {
      const failures = (this.consecutiveFailures.get(agent.name) ?? 0) + 1;
      this.consecutiveFailures.set(agent.name, failures);
      console.warn(`[health] Cannot capture ${agent.name} (${failures}/${HealthMonitor.FAILURE_THRESHOLD}): ${captureResult.error}`);

      if (failures >= HealthMonitor.FAILURE_THRESHOLD) {
        // No pane output available (capture failed) — store last known snapshot
        const lastKnown = this.lastPaneSnapshot.get(agent.name) ?? '';
        this.failureSnapshot.set(agent.name, lastKnown);
        this.db.updateAgentState(agent.name, 'failed', agent.version, {
          failedAt: new Date().toISOString(),
          failureReason: `Health check failed ${failures}x: ${captureResult.error}`,
        });
        this.db.logEvent(agent.name, 'health_check_failed', undefined, {
          reason: captureResult.error,
          consecutiveFailures: failures,
        });
        this.emitSystemMessage(agent.name, `Failed — health check failed ${failures}x`);
        this.onAgentUpdate(agent.name);
        this.consecutiveFailures.delete(agent.name);
      }
      return null;
    }

    // Reset failure counter on success
    this.consecutiveFailures.delete(agent.name);
    return (captureResult.data as string) ?? '';
  }

  /**
   * Parse context % from pane output and record to DB (read-only — no actions taken).
   * Prefers engine config's contextPattern over hardcoded adapter patterns.
   */
  private recordContextPercent(agent: AgentRecord, paneOutput: string): void {
    let contextPct: number | null = null;

    // Try engine config contextPattern first
    const detection = this.getDetection(agent);
    if (detection?.contextPattern) {
      const lines = paneOutput.split('\n');
      // Search bottom-up through last 20 lines (status bar region)
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        const match = lines[i]?.match(detection.contextPattern);
        if (match?.[1]) {
          const rawValue = parseInt(match[1].replace(/,/g, ''), 10);
          // Determine if value is a percentage or token count:
          // If the matched text contains '%', treat as direct percentage.
          // Otherwise assume token count and convert (200k context window).
          if (match[0].includes('%')) {
            contextPct = Math.min(100, rawValue);
          } else {
            contextPct = Math.min(100, Math.round((rawValue / 200_000) * 100));
          }
          break;
        }
      }
    }

    // Fall back to adapter if contextPattern didn't match
    if (contextPct === null) {
      const adapter = getAdapter(agent.engine);
      const contextResult = adapter.parseContextPercent(paneOutput);
      contextPct = contextResult.contextPct;
    }

    if (contextPct === null) return;

    // Re-read the agent to avoid stale version conflicts from the poll snapshot
    const latest = this.db.getAgent(agent.name);
    if (!latest || (latest.state !== 'active' && latest.state !== 'idle')) return;
    try {
      this.db.updateAgentState(agent.name, latest.state, latest.version, {
        lastContextPct: contextPct,
        lastActivity: new Date().toISOString(),
      });
    } catch { /* version conflict — another operation changed the agent, skip this update */ }
    this.onAgentUpdate(agent.name);

    // Auto-recycle (item Z): when ctx breaches the threshold and the agent is
    // idle, destroy + respawn with a fresh SESSION_ID, leaning on the existing
    // Q v1/v2 handoff snapshot to preserve last-state for the new instance.
    // Gated on:
    //   - latest.state === 'idle' (don't interrupt active work)
    //   - cool-down since the last auto-recycle for this agent
    // Fires async (no await) so the poll loop doesn't block. The lifecycle
    // already has its own three-phase locking — concurrent invocations are
    // safe (subsequent calls just see state ≠ idle and skip).
    this.maybeTriggerAutoRecycle(latest, contextPct);
  }

  /**
   * Background trigger for ctx-threshold auto-recycle. Idempotent + safe to
   * call from the poll hot path (no awaits, no DB writes from this thread —
   * the actual recycle happens off-thread via recycleAgent).
   *
   * NOTE: kept package-private (no `_` prefix) so tests can drive the
   * threshold transitions directly without simulating a full poll cycle.
   */
  maybeTriggerAutoRecycle(agent: AgentRecord, contextPct: number): void {
    if (contextPct < HealthMonitor.AUTO_RECYCLE_THRESHOLD_PCT) return;
    if (agent.state !== 'idle') return; // active work — defer to next poll
    const lastAt = this.lastAutoRecycleAt.get(agent.name) ?? 0;
    const sinceLast = Date.now() - lastAt;
    if (sinceLast < HealthMonitor.AUTO_RECYCLE_COOLDOWN_MS) {
      // Don't spam — cool-down still active
      return;
    }
    this.lastAutoRecycleAt.set(agent.name, Date.now());
    console.log(
      `[health] ${agent.name}: auto-recycle triggered (ctx=${contextPct}% ≥ ${HealthMonitor.AUTO_RECYCLE_THRESHOLD_PCT}%, state=idle)`,
    );
    this.db.logEvent(agent.name, 'auto_recycle_triggered', undefined, { contextPct });
    // Fire-and-forget; recycleAgent handles its own locking + failure paths.
    void this.runAutoRecycle(agent.name);
  }

  private async runAutoRecycle(agentName: string): Promise<void> {
    try {
      const lifecycleCtx = this.makeLifecycleCtx();
      await recycleAgent(lifecycleCtx, agentName);
      this.onAgentUpdate(agentName);
    } catch (err) {
      console.warn(
        `[health] ${agentName}: auto-recycle failed: ${(err as Error).message}`,
      );
      // Clear the cool-down marker so we can retry on next poll if the agent
      // is still above threshold (recycleAgent might have failed for a
      // transient reason like a brief tmux race).
      this.lastAutoRecycleAt.delete(agentName);
    }
  }

  /**
   * Idle transitions — augmented by engine detection config when available.
   *
   * - active → idle: screen unchanged / idle pattern matched
   * - idle → active: screen changed / active pattern matched
   */
  private handleIdleTransitions(agent: AgentRecord, isIdle: boolean): void {
    if (agent.state === 'active' && isIdle) {
      // Enforce grace period — don't transition to idle if recent activity was detected
      const detection = this.compiledDetection.get(agent.engine);
      const graceMs = detection?.config.activeGraceMs ?? HealthMonitor.ACTIVE_GRACE_MS;
      const lastActivity = this.lastActivityDetected.get(agent.name) ?? 0;
      const elapsed = Date.now() - lastActivity;
      if (elapsed < graceMs) {
        return; // Still within grace period, stay active
      }
      const current = this.db.getAgent(agent.name);
      if (current && current.state === 'active') {
        console.log(`[health] ${agent.name}: active → idle (unchanged=${this.unchangedCount.get(agent.name) ?? 0}, grace elapsed=${elapsed}ms)`);
        this.db.updateAgentState(agent.name, 'idle', current.version, {
          lastActivity: new Date().toISOString(),
        });
        this.db.logEvent(agent.name, 'idle_detected');
        this.onAgentUpdate(agent.name);
        this.onIdleDetected(agent.name);
      }
    } else if (agent.state === 'idle' && !isIdle) {
      const current = this.db.getAgent(agent.name);
      if (current && current.state === 'idle') {
        console.log(`[health] ${agent.name}: idle → active (screen changed)`);
        this.db.updateAgentState(agent.name, 'active', current.version, {
          lastActivity: new Date().toISOString(),
        });
        this.db.logEvent(agent.name, 'activity_detected');
        this.onAgentUpdate(agent.name);
      }
    }
  }

  /**
   * Check if an idle agent has exceeded the suspend timeout.
   * Currently logs only — auto-suspend is not implemented yet.
   */
  /**
   * Detect if the CLI has exited back to a bare shell prompt.
   * This happens when `claude --resume <id>` fails (e.g. "No conversation found")
   * or the CLI crashes. The tmux session stays alive but shows a bash prompt.
   *
   * Uses two complementary signals for cross-platform reliability:
   * 1. Shell prompt patterns (bash $, zsh %, fish >, root #)
   * 2. Known CLI exit messages in the pane output
   *
   * Requires 2 consecutive detections to avoid false positives during spawn.
   * Returns true if exit was detected (agent marked as failed), false otherwise.
   */
  private detectCliExit(agent: AgentRecord, paneOutput: string): boolean {
    const key = `shell_${agent.name}`;
    const lines = paneOutput.split('\n');

    // Grace period after healing: stale error text may linger in the scrollback
    // for a few poll cycles. Suppress exit detection for 60s after a heal event.
    const healed = this.healedAt.get(agent.name);
    if (healed !== undefined && Date.now() - healed < 60_000) {
      this.consecutiveFailures.delete(key);
      return false;
    }

    // Find the last non-empty line
    let lastLine = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]!.trim();
      if (trimmed) { lastLine = trimmed; break; }
    }

    // Signal 1: Known CLI exit messages in RECENT output only (last 8 lines).
    // Only scanning recent lines prevents stale error text in tmux scrollback
    // from re-triggering false positives after an agent heals and restarts.
    // Patterns are shared with lifecycle.ts so the capture step strips the same
    // failure lines before extracting a UUID — see cli-failure-patterns.ts.
    const recentLines = lines.slice(-8).join('\n');
    const hasExitMessage = cliFailurePatterns.some(re => re.test(recentLines));

    // Signal 2: Bare shell prompt at the bottom of the pane.
    // Patterns shared with routes.recoverFailedAgents via
    // cli-failure-patterns.ts so the same "bare zsh / bash" detection
    // is used to (a) catch exits during normal polling and (b) refuse
    // to self-heal an agent whose pane was recreated externally
    // without restarting the CLI inside it.
    const isShellPrompt = shellPromptPatterns.some(re => re.test(lastLine));

    // Need at least one signal
    if (!isShellPrompt && !hasExitMessage) {
      this.consecutiveFailures.delete(key);
      return false;
    }

    const count = (this.consecutiveFailures.get(key) ?? 0) + 1;
    this.consecutiveFailures.set(key, count);

    if (count < 2) return false; // need 2 consecutive to confirm

    // Determine reason from recent pane context
    let reason = 'CLI exited to shell prompt';
    if (/No conversation found/i.test(recentLines)) {
      reason = 'CLI session not found — resume failed';
    } else if (/command not found/i.test(recentLines)) {
      reason = 'CLI binary not found';
    } else if (hasExitMessage) {
      reason = 'CLI exited unexpectedly';
    }

    console.warn(`[health] ${agent.name}: ${reason}`);
    // Snapshot pane at failure time so heal detection can distinguish stale output
    this.failureSnapshot.set(agent.name, paneOutput);

    // On confirmed resume failure, clear the dead session id so the next
    // recovery falls through to the `start` hook instead of looping on the
    // same dead UUID. resolveResumeOrStartHook picks the resume hook whenever
    // currentSessionId OR capturedVars.SESSION_ID is set, so both must be
    // cleared. See scratch/brain/lifecycle-resume-bug.md.
    const isResumeFailure = reason === 'CLI session not found — resume failed';
    this.db.updateAgentState(agent.name, 'failed', agent.version, {
      failedAt: new Date().toISOString(),
      failureReason: reason,
      ...(isResumeFailure ? { currentSessionId: null } : {}),
    });
    if (isResumeFailure) {
      this.db.updateAgentCapturedVar(agent.name, 'SESSION_ID', null);
    }
    this.db.logEvent(agent.name, 'cli_exit_detected', undefined, { reason, lastLine });
    this.emitSystemMessage(agent.name, `Failed — ${reason}`);
    this.onAgentUpdate(agent.name);
    this.cleanupAgent(agent.name);
    return true;
  }

  /**
   * Poll a failed agent to see if its CLI has been manually revived in tmux.
   * Only captures pane output and checks for healing — no idle detection or indicators.
   */
  private async pollFailedAgent(agentSnapshot: AgentRecord): Promise<void> {
    const agent = this.db.getAgent(agentSnapshot.name);
    if (!agent || agent.state !== 'failed' || !agent.proxyId) return;

    const captureResult = await this.proxyDispatch(agent.proxyId, {
      action: 'capture',
      sessionName: sessionName(agent),
      lines: 50,
    });

    if (!captureResult.ok) return; // can't reach pane — still failed

    const paneOutput = (captureResult.data as string) ?? '';
    this.detectCliHealed(agent, paneOutput);
  }

  /**
   * Detect if a failed agent's CLI has been revived (e.g. manual tmux injection).
   * Mirrors detectCliExit() structure: checks for CLI-alive signals, requires 2
   * consecutive detections to avoid false positives during pane transitions.
   *
   * CLI-alive signals (any one sufficient):
   * - Claude Code status bar text: "bypass permissions", "tokens", "current:"
   * - Active input prompt (❯) without a shell prompt at bottom
   * - Known CLI UI patterns in the pane output
   *
   * Counter-signal (blocks healing):
   * - Shell prompt patterns at the bottom of the pane (same as detectCliExit)
   */
  private detectCliHealed(agent: AgentRecord, paneOutput: string): boolean {
    const key = `heal_${agent.name}`;
    const lines = paneOutput.split('\n');

    // Find the last non-empty line
    let lastLine = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]!.trim();
      if (trimmed) { lastLine = trimmed; break; }
    }

    // Shell prompt at bottom means CLI is NOT alive — patterns shared with
    // detectCliExit + routes.recoverFailedAgents via cli-failure-patterns.ts.
    if (shellPromptPatterns.some(re => re.test(lastLine))) {
      this.consecutiveFailures.delete(key);
      return false;
    }

    // Require a failure snapshot to exist — if we didn't witness the failure
    // (e.g. after orchestrator restart), we can't distinguish stale from revived.
    const failSnap = this.failureSnapshot.get(agent.name);
    if (failSnap === undefined) {
      // First poll of this failed agent since (re)start — capture baseline snapshot
      // but don't heal. Next poll can compare against this baseline.
      this.failureSnapshot.set(agent.name, paneOutput);
      this.consecutiveFailures.delete(key);
      return false;
    }
    // Pane must differ from failure snapshot — stale output can't trigger healing
    if (paneOutput === failSnap) {
      this.consecutiveFailures.delete(key);
      return false;
    }

    // CLI-alive signals anywhere in the pane output
    const cliAlivePatterns = [
      /bypass permissions/i,           // Claude Code permission mode
      /\btokens?$/m,                   // status bar token count
      /current:\s*\d+(\.\d+)?/,       // context usage display
      /\bcontext\s+\d+%/i,            // context percentage
      /❯/,                             // Claude Code input prompt
      /^>\s+/m,                        // Claude Code continuation prompt
    ];
    const hasCliSignal = cliAlivePatterns.some(re => re.test(paneOutput));

    if (!hasCliSignal) {
      this.consecutiveFailures.delete(key);
      return false;
    }

    // Require 2 consecutive detections (same pattern as detectCliExit)
    const count = (this.consecutiveFailures.get(key) ?? 0) + 1;
    this.consecutiveFailures.set(key, count);

    if (count < 2) return false;

    this.consecutiveFailures.delete(key);
    this.failureSnapshot.delete(agent.name);
    this.healedAt.set(agent.name, Date.now());
    console.log(`[health] ${agent.name}: CLI detected alive in tmux — healing`);

    // Clear tmux scrollback so stale error messages don't re-trigger detectCliExit().
    if (agent.proxyId) {
      this.proxyDispatch(agent.proxyId, {
        action: 'clear_history',
        sessionName: sessionName(agent),
      }).catch(() => { /* best-effort — non-fatal if pane is gone */ });
    }

    this.db.updateAgentState(agent.name, 'active', agent.version, {
      failedAt: null,
      failureReason: null,
    });
    this.db.logEvent(agent.name, 'cli_healed', undefined, {
      reason: 'CLI detected alive in tmux pane',
      lastLine,
    });
    this.emitSystemMessage(agent.name, 'Healed — CLI detected alive');
    this.onAgentUpdate(agent.name);
    return true;
  }

  /**
   * Clean up all per-agent tracking maps to prevent memory leaks
   * when an agent is removed or transitions to a terminal state.
   */
  cleanupAgent(name: string): void {
    this.lastPaneSnapshot.delete(name);
    this.unchangedCount.delete(name);
    this.consecutiveFailures.delete(name);
    this.consecutiveFailures.delete(`shell_${name}`);
    this.consecutiveFailures.delete(`heal_${name}`);
    this.lastActivityTs.delete(name);
    this.healedAt.delete(name);
    this.activeIndicators.delete(name);
    this.compiledIndicators.delete(name);
    // Note: failureSnapshot intentionally NOT deleted here — it's needed
    // by detectCliHealed() after the agent transitions to failed state.
  }

  private checkIdleSuspendTimeout(agentName: string): void {
    const agent = this.db.getAgent(agentName);
    if (!agent || agent.state !== 'idle' || !agent.lastActivity) return;

    const idleDuration = Date.now() - new Date(agent.lastActivity).getTime();
    if (idleDuration > this.idleSuspendMs) {
      console.log(`[health] ${agent.name} idle for ${Math.round(idleDuration / 1000)}s (exceeds ${Math.round(this.idleSuspendMs / 1000)}s threshold)`);
      this.db.logEvent(agent.name, 'idle_timeout_exceeded', undefined, {
        idleDurationMs: idleDuration,
        thresholdMs: this.idleSuspendMs,
      });
    }
  }

  /**
   * Handle a queued reload when the agent is waiting for input.
   */
  private async handleQueuedReload(agentName: string): Promise<void> {
    const latest = this.db.getAgent(agentName);
    if (latest && latest.reloadQueued) {
      await this.handleReload(latest);
    }
  }

  private async handleReload(agent: AgentRecord): Promise<void> {
    try {
      const lifecycleCtx = this.makeLifecycleCtx();
      await reloadAgent(lifecycleCtx, agent.name, {
        immediate: true,
        task: agent.reloadTask ?? undefined,
      });
      this.onAgentUpdate(agent.name);
    } catch (err) {
      console.error(`[health] Reload failed for ${agent.name}:`, err);
      this.onAgentUpdate(agent.name);
    }
  }

  /**
   * Check if an agent that just failed should be auto-recovered.
   * Reads the engine's detection config for the autoRecover flag.
   * Fires asynchronously — does not block the poll cycle.
   *
   * Exponential backoff on consecutive failures: prevents a persistently
   * wedged agent (bad persona, missing file, broken host config) from
   * burning through retry attempts in seconds. Without throttling, a
   * single bad spawn loops with spawnCount climbing ~5 per minute until
   * the operator intervenes. Schedule below — failure 1 retries
   * immediately (matches pre-backoff behaviour); failures 2-4 escalate;
   * failure 5+ caps at 15 minutes so the agent never gets entirely
   * abandoned. Counter resets on successful recovery.
   */
  private maybeAutoRecover(agent: AgentRecord): void {
    const resolved = this.resolveAgent(agent);
    const detection = this.getDetection(resolved);
    if (!detection?.config.autoRecover) return;

    const now = Date.now();
    const tracked = this.recoverFailures.get(agent.name) ?? { count: 0, lastAttemptAt: 0 };
    const minDelayMs = autoRecoverBackoffMs(tracked.count);
    const sinceLast = now - tracked.lastAttemptAt;
    if (tracked.count > 0 && sinceLast < minDelayMs) {
      const remainingMs = minDelayMs - sinceLast;
      console.log(`[health] ${agent.name}: autoRecover throttled — ${tracked.count} consecutive failures, ${Math.ceil(remainingMs / 1000)}s remaining before next attempt`);
      this.db.logEvent(agent.name, 'auto_recover_throttled', undefined, {
        consecutiveFailures: tracked.count,
        remainingMs,
      });
      return;
    }

    console.log(`[health] ${agent.name}: autoRecover enabled — scheduling recovery (attempt ${tracked.count + 1})`);
    this.db.logEvent(agent.name, 'auto_recover_triggered', undefined, {
      consecutiveFailures: tracked.count,
    });
    this.emitSystemMessage(agent.name, 'Auto-recovering...');
    this.recoverFailures.set(agent.name, { count: tracked.count + 1, lastAttemptAt: now });

    // Fire-and-forget — recovery is a full lifecycle operation
    const lifecycleCtx = this.makeLifecycleCtx();
    recoverAgent(lifecycleCtx, agent.name).then(() => {
      console.log(`[health] ${agent.name}: auto-recovery completed`);
      // Success — clear the failure counter so the next failure (if any)
      // gets an immediate retry rather than starting backed-off.
      this.recoverFailures.delete(agent.name);
      this.onAgentUpdate(agent.name);
    }).catch((err) => {
      console.error(`[health] ${agent.name}: auto-recovery failed:`, err);
      this.onAgentUpdate(agent.name);
    });
  }

  /** Emit a lifecycle event as a system message in the agent's chat thread. */
  private emitSystemMessage(agentName: string, label: string): void {
    const msg = this.db.addDashboardMessage(agentName, 'from_agent', `[system] ${label}`, {
      topic: 'lifecycle',
      sourceAgent: 'system',
    });
    this.onDashboardMessage(msg);
  }

  /** Get currently active indicators for an agent. */
  getActiveIndicators(agentName: string): ActiveIndicator[] {
    return this.activeIndicators.get(agentName) ?? [];
  }

  /**
   * Evaluate indicator definitions against pane output.
   * Compiles regexes once and caches them, invalidating when the indicators JSON changes.
   * Only fires the onIndicatorUpdate callback when the set of matched indicators changes.
   */
  private evaluateIndicators(agent: AgentRecord, paneOutput: string): void {
    if (!agent.indicators) {
      if (this.activeIndicators.has(agent.name)) {
        this.activeIndicators.delete(agent.name);
        this.compiledIndicators.delete(agent.name);
        this.onIndicatorUpdate(agent.name, []);
      }
      return;
    }

    // Compile regexes once, invalidate if indicators JSON changed
    const cached = this.compiledIndicators.get(agent.name);
    if (!cached || cached.json !== agent.indicators) {
      try {
        const defs: IndicatorDefinition[] = JSON.parse(agent.indicators);
        const entries: Array<{ def: IndicatorDefinition; re: RegExp }> = [];
        for (const d of defs) {
          try {
            entries.push({ def: d, re: new RegExp(d.regex) });
          } catch { /* skip invalid regex */ }
        }
        this.compiledIndicators.set(agent.name, { json: agent.indicators, entries });
      } catch { return; }
    }

    const compiled = this.compiledIndicators.get(agent.name);
    if (!compiled) return;

    const stripped = HealthMonitor.stripAnsi(paneOutput);
    const active: ActiveIndicator[] = [];

    for (const { def, re } of compiled.entries) {
      const match = re.exec(stripped);
      if (match) {
        // Interpolate $N capture group references in actions and badge
        const interpolated = def.actions ? interpolateIndicatorActions(def.actions, match) : undefined;
        const badge = interpolateCaptureGroups(def.badge, match);
        active.push({ id: def.id, badge, style: def.style, ...(interpolated ? { actions: interpolated } : {}) });
      }
    }

    const prev = this.activeIndicators.get(agent.name) ?? [];
    const fingerprint = (list: ActiveIndicator[]) => list.map(i =>
      i.id + ':' + (i.actions ? Object.keys(i.actions).join('+') : '')
    ).join(',');

    this.activeIndicators.set(agent.name, active);
    if (fingerprint(prev) !== fingerprint(active)) {
      this.onIndicatorUpdate(agent.name, active);
    }
  }

  private makeLifecycleCtx(): LifecycleContext {
    return {
      db: this.db,
      locks: this.locks,
      proxyDispatch: this.proxyDispatch,
      orchestratorHost: this.orchestratorHost,
    };
  }
}

// ── Indicator capture group interpolation ──

/** Replace $1, $2, etc. in a string with regex match capture groups. */
function interpolateCaptureGroups(text: string | undefined, match: RegExpExecArray): string {
  if (!text) return '';
  return text.replace(/\$(\d+)/g, (_m, idx) => {
    const i = parseInt(idx, 10);
    return match[i] ?? '';
  });
}

/** Interpolate $N references in pipeline steps. */
function interpolateStepGroups(steps: PipelineStep[], match: RegExpExecArray): PipelineStep[] {
  return steps.map(step => {
    if (step.type === 'keystroke') {
      return { ...step, key: interpolateCaptureGroups(step.key, match) };
    }
    if (step.type === 'shell') {
      return { ...step, command: interpolateCaptureGroups(step.command, match) };
    }
    return step;
  });
}

/** Interpolate $N in both action keys and pipeline step values. */
function interpolateIndicatorActions(
  actions: Record<string, PipelineStep[]>,
  match: RegExpExecArray,
): Record<string, PipelineStep[]> {
  const result: Record<string, PipelineStep[]> = {};
  for (const [key, steps] of Object.entries(actions)) {
    const interpolatedKey = interpolateCaptureGroups(key, match);
    result[interpolatedKey] = interpolateStepGroups(steps, match);
  }
  return result;
}
