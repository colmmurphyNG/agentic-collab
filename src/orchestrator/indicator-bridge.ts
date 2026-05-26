/**
 * Bridge indicator transitions → agent Messages thread.
 *
 * Today, when an indicator like `approval` (Yes/No/Always allow prompt) or
 * `low-context` fires, the orchestrator broadcasts an `indicator_update`
 * WebSocket event and the dashboard shows a "Needs Approval" badge on the
 * agent card in the sidebar. The Messages tab itself shows nothing — if
 * the operator is reading a Messages thread, the badge is easy to miss.
 *
 * This module mirrors warning/danger indicator FIRES and CLEARS into the
 * agent's Messages thread as `[system]` messages with topic=`indicator`,
 * so the operator sees blocker state in-stream regardless of which tab
 * they're on.
 *
 * Stateful: tracks which warning/danger indicators are currently active
 * per agent. Only fires on TRANSITIONS — first appearance of an indicator
 * id since last clear posts a "blocker" message; disappearance posts a
 * "cleared" message. Avoids spam if the indicator stays active across
 * multiple poll cycles.
 *
 * In-memory state (resets on orchestrator restart) — acceptable because
 * a restart re-runs the indicator detection on the next poll and re-posts
 * any active blockers.
 */

import type { Database } from './database.ts';
import type { ActiveIndicator, DashboardMessage } from '../shared/types.ts';

/** Indicator styles that warrant a Messages-tab surface. */
const BLOCKER_STYLES = new Set(['warning', 'danger']);

/** Emoji prefix per style — keeps the system message at-a-glance scannable. */
function styleEmoji(style: string | undefined): string {
  switch (style) {
    case 'danger': return '🔴';
    case 'warning': return '⚠️';
    default: return '·';
  }
}

export type IndicatorBridgeState = {
  /** Map<agentName, Map<indicatorId, badge>> — last-seen blocker badges. */
  active: Map<string, Map<string, string>>;
};

export function createIndicatorBridgeState(): IndicatorBridgeState {
  return { active: new Map() };
}

/**
 * Compare new indicators against tracked-active state. For each indicator that
 * just APPEARED (in new, not in tracked), post a blocker system message and
 * track it. For each that just CLEARED (in tracked, not in new), post a
 * cleared system message and untrack it. Returns the list of dashboard
 * messages that were written so the caller can broadcast them.
 *
 * Non-blocker indicators (style other than warning/danger) are ignored — the
 * badge surface is enough; no need to flood the message thread with neutral
 * status indicators.
 */
export function bridgeIndicatorTransitions(
  state: IndicatorBridgeState,
  agentName: string,
  newIndicators: ActiveIndicator[],
  db: Database,
): DashboardMessage[] {
  const tracked = state.active.get(agentName) ?? new Map<string, string>();
  const newBlockers = new Map<string, string>();
  for (const ind of newIndicators) {
    if (BLOCKER_STYLES.has(ind.style ?? '')) {
      newBlockers.set(ind.id, ind.badge);
    }
  }

  const out: DashboardMessage[] = [];

  // FIRED: in newBlockers, not in tracked.
  for (const ind of newIndicators) {
    if (!BLOCKER_STYLES.has(ind.style ?? '')) continue;
    if (tracked.has(ind.id)) continue;
    const emoji = styleEmoji(ind.style);
    const msg = db.addDashboardMessage(
      agentName,
      'from_agent',
      `[system] ${emoji} ${ind.badge} — open the Watch tab to see the prompt`,
      { topic: 'indicator', sourceAgent: 'system' },
    );
    out.push(msg);
  }

  // CLEARED: in tracked, not in newBlockers.
  for (const [id, badge] of tracked) {
    if (newBlockers.has(id)) continue;
    const msg = db.addDashboardMessage(
      agentName,
      'from_agent',
      `[system] ✓ ${badge} cleared`,
      { topic: 'indicator', sourceAgent: 'system' },
    );
    out.push(msg);
  }

  state.active.set(agentName, newBlockers);
  return out;
}

/**
 * Drop bridge state for an agent — call on agent destroy so stale tracker
 * entries don't accumulate.
 */
export function clearIndicatorBridgeForAgent(state: IndicatorBridgeState, agentName: string): void {
  state.active.delete(agentName);
}
