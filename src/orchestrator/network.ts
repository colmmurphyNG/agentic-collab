/**
 * Network restore: graceful shutdown + crash recovery.
 * Handles stateBeforeShutdown for clean restarts and
 * detects agents in active/idle state with missing tmux sessions.
 */

import type { AgentRecord } from '../shared/types.ts';
import { sessionName, isRunning } from '../shared/agent-entity.ts';
import { sleep } from '../shared/utils.ts';
import { resumeAgent, type LifecycleContext } from './lifecycle.ts';

const RESTORE_STAGGER_MS = 3_000;
// Observed ~50s between the HTTP server listening and the proxy registering on
// a cold start, so this has to be generous to be worth having.
const PROXY_WAIT_TIMEOUT_MS = 120_000;
const PROXY_WAIT_POLL_MS = 500;
/** Session name used only to ask a proxy whether it is alive. Never created. */
export const PROXY_PROBE_SESSION = '__agentic_liveness_probe__';

/**
 * Restore can outrun proxy startup, and a registration row is not evidence of a
 * live proxy: startup deliberately refreshes stale rows so a slow rebuild does
 * not reap them, so a row can outlive the process it describes by up to the 45s
 * reaper window. Restoring against one fails every agent with "Proxy
 * unreachable", recorded as an agent fault that nothing retries.
 *
 * So probe rather than count rows. The probe asks whether a sentinel session
 * exists: read-only, and a command any proxy able to serve a restore at all
 * already supports, so it cannot fail merely because a proxy predates it.
 */
async function waitForLiveProxy(ctx: LifecycleContext, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let waitLogged = false;

  for (;;) {
    for (const proxy of ctx.db.listProxies()) {
      const probe = await ctx.proxyDispatch(proxy.proxyId, {
        action: 'has_session',
        sessionName: PROXY_PROBE_SESSION,
      });
      if (probe.ok) {
        if (waitLogged) console.log(`[network] Proxy ${proxy.proxyId} answering - proceeding with restore`);
        return true;
      }
    }

    // Checked after probing so a single slow probe cannot skip the deadline.
    if (Date.now() >= deadline) return false;

    if (!waitLogged) {
      console.log(`[network] No proxy answering yet - waiting up to ${Math.round(timeoutMs / 1000)}s before restore`);
      waitLogged = true;
    }
    await sleep(PROXY_WAIT_POLL_MS);
  }
}

/**
 * Graceful shutdown: save current state for all running agents, then exit.
 * Marks agents as suspended with stateBeforeShutdown set.
 *
 * NOTE: This is a synchronous DB-only operation — it does NOT send exit
 * commands to agents via the proxy. Agent processes continue running in their
 * tmux sessions until the proxy shuts down or they exit on their own.
 * On restore, the orchestrator will reconnect to existing sessions or create
 * new ones via resumeAgent().
 */
export function shutdownAgents(ctx: LifecycleContext): number {
  const agents = ctx.db.listAgents().filter(isRunning);

  let count = 0;
  for (const agent of agents) {
    try {
      ctx.db.updateAgentState(agent.name, 'suspended', agent.version, {
        stateBeforeShutdown: agent.state,
        lastActivity: new Date().toISOString(),
      });
      ctx.db.logEvent(agent.name, 'shutdown_suspended', undefined, {
        previousState: agent.state,
      });
      count++;
    } catch (err) {
      console.error(`[network] Failed to suspend ${agent.name} during shutdown:`, err);
    }
  }

  console.log(`[network] Gracefully suspended ${count} agents`);
  return count;
}

/**
 * Restore all agents that were running before shutdown/crash.
 * Two recovery modes:
 * 1. Graceful: agents have stateBeforeShutdown set → resume them
 * 2. Crash: agents in active/idle state but tmux session missing → resume them
 *
 * Waits for a proxy that actually answers before doing anything, then staggers
 * restarts by 3s to avoid proxy overload. If none answers, nothing is restored
 * and nothing is marked failed.
 */
export async function restoreAllAgents(
  ctx: LifecycleContext,
  opts: { proxyWaitMs?: number } = {},
): Promise<number> {
  const proxyWaitMs = opts.proxyWaitMs ?? PROXY_WAIT_TIMEOUT_MS;
  if (!(await waitForLiveProxy(ctx, proxyWaitMs))) {
    console.warn(
      `[network] No proxy answering after ${Math.round(proxyWaitMs / 1000)}s - skipping restore. `
      + 'Agents were left in their recorded state so a later restore can still pick them up.',
    );
    return 0;
  }

  const agents = ctx.db.listAgents();
  const toReadopt: AgentRecord[] = [];
  const toRestore: AgentRecord[] = [];

  for (const agent of agents) {
    // Mode 1: Graceful shutdown — stateBeforeShutdown is set
    if (agent.state === 'suspended' && agent.stateBeforeShutdown) {
      // Check if the tmux session survived the restart
      const hasSession = await checkTmuxSession(ctx, agent);
      if (hasSession) {
        toReadopt.push(agent);
      } else {
        toRestore.push(agent);
      }
      continue;
    }

    // Mode 2: Crash recovery — agent in active/idle/transitional state but no tmux session
    if (agent.proxyId && (agent.state === 'active' || agent.state === 'idle'
        || agent.state === 'suspending' || agent.state === 'resuming')) {
      const hasSession = await checkTmuxSession(ctx, agent);
      if (!hasSession) {
        // Mark as failed first, then queue for restore
        const now = new Date().toISOString();
        ctx.db.updateAgentState(agent.name, 'failed', agent.version, {
          failedAt: now,
          failureReason: 'Crash recovery: tmux session missing',
          lastFailedAt: now,
          lastFailureReason: 'Crash recovery: tmux session missing',
        });
        ctx.db.logEvent(agent.name, 'crash_detected', undefined, {
          previousState: agent.state,
        });
        toRestore.push({ ...agent, state: 'failed' as const });
      }
    }
  }

  const total = toReadopt.length + toRestore.length;
  if (total === 0) {
    console.log('[network] No agents to restore');
    return 0;
  }

  // Re-adopt agents whose tmux sessions survived the restart (no re-spawn needed)
  let readopted = 0;
  for (const agent of toReadopt) {
    try {
      // Restore to pre-shutdown state (idle or active), not unconditionally active.
      // Hardcoding 'active' caused agents that were idle before shutdown to get
      // stuck active if the health monitor didn't correct it in the next poll cycle.
      const current = ctx.db.getAgent(agent.name);
      if (!current) continue;
      const restoredState = (agent.stateBeforeShutdown === 'idle' || agent.stateBeforeShutdown === 'active')
        ? agent.stateBeforeShutdown
        : 'active';
      ctx.db.updateAgentState(agent.name, restoredState, current.version, {
        stateBeforeShutdown: null,
        lastActivity: new Date().toISOString(),
      });
      ctx.db.logEvent(agent.name, 'session_readopted', undefined, {
        previousState: agent.stateBeforeShutdown,
      });
      readopted++;
    } catch (err) {
      console.error(`[network] Failed to re-adopt ${agent.name}:`, err);
      // Fall through to full restore
      toRestore.push(agent);
    }
  }

  if (readopted > 0) {
    console.log(`[network] Re-adopted ${readopted} agents with existing tmux sessions`);
  }

  if (toRestore.length === 0) {
    return readopted;
  }

  console.log(`[network] Restoring ${toRestore.length} agents with ${RESTORE_STAGGER_MS}ms stagger`);

  let restored = 0;
  for (const agent of toRestore) {
    try {
      // Ensure agent has a proxy assigned
      if (!agent.proxyId) {
        // Try to assign first available proxy
        const proxies = ctx.db.listProxies();
        if (proxies.length === 0) {
          console.warn(`[network] No proxies available to restore ${agent.name}`);
          continue;
        }
        const proxy = proxies[0]!;
        const current = ctx.db.getAgent(agent.name);
        if (current) {
          ctx.db.updateAgentState(agent.name, current.state, current.version, {
            proxyId: proxy.proxyId,
          });
        }
      }

      await resumeAgent(ctx, agent.name);
      restored++;
      ctx.db.logEvent(agent.name, 'network_restored', undefined, {
        stateBeforeShutdown: agent.stateBeforeShutdown,
      });

      // Clear stateBeforeShutdown
      const updated = ctx.db.getAgent(agent.name);
      if (updated) {
        ctx.db.updateAgentState(agent.name, updated.state, updated.version, {
          stateBeforeShutdown: null,
        });
      }

      // Stagger to avoid proxy overload
      if (restored < toRestore.length) {
        await sleep(RESTORE_STAGGER_MS);
      }
    } catch (err) {
      console.error(`[network] Failed to restore ${agent.name}:`, err);
      ctx.db.logEvent(agent.name, 'restore_failed', undefined, {
        error: (err as Error).message,
      });
    }
  }

  console.log(`[network] Restored ${restored}/${toRestore.length} agents`);
  return readopted + restored;
}

/**
 * Check if a tmux session exists for an agent.
 */
async function checkTmuxSession(ctx: LifecycleContext, agent: AgentRecord): Promise<boolean> {
  if (!agent.proxyId) return false;

  const session = sessionName(agent);
  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'has_session',
    sessionName: session,
  });

  return result.ok && result.data === true;
}

