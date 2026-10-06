import type { AgentRecord, AgentState } from '../shared/types.ts';
import { isRunning } from '../shared/agent-entity.ts';

/**
 * Which proxies have been heard from since THIS process started.
 *
 * Startup refreshes every stored proxy's heartbeat so a slow rebuild does not
 * reap records before the proxy reconnects. That makes a stored heartbeat
 * useless as evidence of life: a record can look fresh while nothing is behind
 * it. This set only grows on a real inbound signal — a registration or a
 * heartbeat — so absence means "never heard from", never "gone".
 *
 * Deliberately in memory: empty after a restart is the correct starting state,
 * because nothing has been heard from yet.
 */
const aliveSinceStartup = new Set<string>();

/** Record a real inbound signal from a proxy. */
export function markProxyAlive(proxyId: string): void {
  aliveSinceStartup.add(proxyId);
}

/**
 * Whether this proxy has been heard from since startup. False means no
 * evidence either way — treat it as unknown, not as confirmation it is gone.
 */
export function wasProxyAlive(proxyId: string): boolean {
  return aliveSinceStartup.has(proxyId);
}

/** Test-only: drop all recorded liveness. */
export function resetProxyLiveness(): void {
  aliveSinceStartup.clear();
}

/** Seconds without a heartbeat before a proxy record is considered stale. */
export const STALE_PROXY_SECONDS = 45;

interface ReaperDb {
  listStaleProxies(thresholdSeconds: number): { proxyId: string; lastHeartbeat: string }[];
  removeProxy(proxyId: string): boolean;
  listAgents(): AgentRecord[];
  updateAgentState(name: string, state: AgentState, version: number, fields: Record<string, unknown>): unknown;
  logEvent(agent: string, type: string, message?: string, meta?: Record<string, unknown>): unknown;
}

/**
 * Drop stale proxy records, and fail their agents only when we have actually
 * heard from that proxy since startup.
 *
 * Returns the proxies removed and the agents failed, so a caller can log or
 * assert on what happened.
 */
export function reapStaleProxies(db: ReaperDb, thresholdSeconds = STALE_PROXY_SECONDS): {
  removed: string[];
  failed: string[];
  spared: string[];
} {
  const removed: string[] = [];
  const failed: string[] = [];
  const spared: string[] = [];

  for (const proxy of db.listStaleProxies(thresholdSeconds)) {
    console.log(`[proxy] Removing stale proxy: ${proxy.proxyId} (last heartbeat: ${proxy.lastHeartbeat})`);
    db.removeProxy(proxy.proxyId);
    removed.push(proxy.proxyId);

    // A proxy we have never heard from says nothing about its agents. Startup
    // refreshes stored heartbeats, so "stale" here can simply mean the proxy is
    // still starting - observed at ~50s, past this threshold. Failing agents on
    // that evidence marks a healthy fleet dead moments before the proxy lands,
    // and nothing retries it.
    if (!wasProxyAlive(proxy.proxyId)) {
      console.log(`[proxy] ${proxy.proxyId} never heard from since startup - dropping the record only, leaving its agents alone`);
      spared.push(proxy.proxyId);
      continue;
    }

    for (const agent of db.listAgents().filter((a) => a.proxyId === proxy.proxyId)) {
      if (!isRunning(agent)) continue;
      const now = new Date().toISOString();
      db.updateAgentState(agent.name, 'failed', agent.version, {
        failedAt: now,
        failureReason: 'Proxy disconnected',
        lastFailedAt: now,
        lastFailureReason: 'Proxy disconnected',
      });
      db.logEvent(agent.name, 'proxy_disconnected', undefined, { proxyId: proxy.proxyId });
      failed.push(agent.name);
    }
  }

  return { removed, failed, spared };
}
