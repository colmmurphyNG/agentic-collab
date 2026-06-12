/**
 * Telegram conversation routing (item NN/Telegram-auto-forward).
 *
 * In-memory map tracking which agents have an active "operator on Telegram"
 * conversation. When the operator sends a message to an agent via Telegram
 * inbound (routeTelegramMessage in routes.ts), we record the chat id and
 * destination so that subsequent agent → dashboard replies can be auto-
 * forwarded back to the same Telegram chat.
 *
 * Without this, an operator on Telegram remote sends "@tl status" and gets
 * routed correctly inbound, but tl's reply lands on the dashboard only
 * (`collab send operator "<reply>"` without --notify hits /api/dashboard/reply,
 * which broadcasts to WebSocket clients but doesn't touch the Telegram
 * dispatcher). Operator on Telegram sees nothing back.
 *
 * Design choices:
 *
 * - **In-memory, not DB.** Routes are ephemeral by definition (operator's
 *   "remote mode" is a conversation, not a persistent setting). Restart
 *   clears all routes — operator re-sends one Telegram message to re-arm.
 *   No schema change, no migration.
 *
 * - **TTL-bounded.** Each route expires after `TELEGRAM_ROUTE_TTL_MS`
 *   (default 30 min). Without expiry, an agent recorded once would forever
 *   forward replies to Telegram even after the operator has moved back to
 *   the dashboard.
 *
 * - **Per-agent keying.** Each agent can have at most one active route at
 *   a time (the most recent inbound wins). If operator messages multiple
 *   agents on Telegram, each one is independently routed.
 *
 * - **Singleton state.** Module-level Map. The orchestrator is single-
 *   process; multiple instances on the same DB are not supported anyway.
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const TTL_MS = parseInt(process.env['TELEGRAM_ROUTE_TTL_MS'] ?? String(DEFAULT_TTL_MS), 10);

export type TelegramRouteEntry = {
  agentName: string;
  destName: string;
  chatId: string;
  /** Absolute timestamp (ms since epoch) when this route expires. */
  expiresAt: number;
};

const routes = new Map<string, TelegramRouteEntry>();

/**
 * Record (or refresh) a Telegram → agent route. Called from
 * routeTelegramMessage after an inbound Telegram message is delivered to
 * the agent. Each call refreshes the TTL window.
 */
export function recordTelegramInbound(
  agentName: string,
  destName: string,
  chatId: string,
  now: number = Date.now(),
): void {
  routes.set(agentName, {
    agentName,
    destName,
    chatId,
    expiresAt: now + TTL_MS,
  });
}

/**
 * Return the active Telegram route for an agent, or null if there is no
 * active route or it has expired. Expired entries are removed lazily on
 * read so the map stays bounded.
 */
export function getActiveTelegramRoute(
  agentName: string,
  now: number = Date.now(),
): TelegramRouteEntry | null {
  const entry = routes.get(agentName);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    routes.delete(agentName);
    return null;
  }
  return entry;
}

/**
 * Clear an agent's Telegram route. Returns true if one was cleared.
 * Used by operator commands like "/remote off" (future) or as part of
 * agent destroy/recycle cleanup.
 */
export function clearTelegramRoute(agentName: string): boolean {
  return routes.delete(agentName);
}

/**
 * Snapshot of all active routes for diagnostics. The returned array is
 * not live — mutating it does not affect the internal map. Expired
 * entries are filtered out and removed.
 */
export function listTelegramRoutes(now: number = Date.now()): TelegramRouteEntry[] {
  const live: TelegramRouteEntry[] = [];
  for (const [key, entry] of routes) {
    if (entry.expiresAt <= now) {
      routes.delete(key);
      continue;
    }
    live.push(entry);
  }
  return live;
}

/**
 * Test-only: clear the entire map. Production code should use
 * `clearTelegramRoute(name)` for targeted clears.
 *
 * @internal
 */
export function _resetTelegramRoutes(): void {
  routes.clear();
}

/**
 * Pattern-match the operator's message for a comms-preference directive that
 * indicates the operator wants to STOP receiving Telegram auto-forwards.
 *
 * Matched signals (case-insensitive):
 *   - "turn off --notify" / "stop notify" / "no notify" / "stop notifying"
 *   - "I'm at the dashboard" / "I am at the dashboard" / "back at dashboard"
 *   - "still notifying me" (complaint form)
 *   - "dashboard-quiet" / "dashboard quiet"
 *
 * Used by /api/dashboard/send + routeTelegramMessage to AUTO-CLEAR the
 * Telegram routes when one of these is detected, pairing _default.md §12
 * (explicit ack on comm-preference directives) with enforcement-side
 * action. Avoids the 2026-06-12 incident where every Telegram complaint
 * refreshed the TTL and extended the noise window.
 *
 * False-positive guard: bare "notify" without "stop/turn off/no/still"
 * prefix does NOT match — e.g. "we should notify the team" stays inactive.
 */
const COMM_PREF_DIRECTIVE_PATTERNS: RegExp[] = [
  /\b(turn[- ]off|stop|no|disable)\s+(?:the\s+)?(--?notify|notify|notifying|notification)/i,
  /\bstop\s+notifying\b/i,
  /\b(i'?m|i\s+am)\s+(at|back\s+at|back\s+on)\s+(?:the\s+)?dashboard\b/i,
  /\bback\s+(at|on)\s+(?:the\s+)?dashboard\b/i,
  /\bstill\s+notifying\s+me\b/i,
  /\bdashboard[- ]quiet\b/i,
];

export function isCommPrefDirective(text: string): boolean {
  if (!text) return false;
  return COMM_PREF_DIRECTIVE_PATTERNS.some((re) => re.test(text));
}

/**
 * Auto-clear handler: detect a comm-preference directive in the operator's
 * message and clear all routes if matched. Returns the number of routes
 * cleared (0 if no match). Logs to console on match.
 */
export function maybeAutoClearOnCommPref(text: string, source: string): number {
  if (!isCommPrefDirective(text)) return 0;
  const before = listTelegramRoutes().length;
  routes.clear();
  console.log(`[telegram-routing] auto-cleared ${before} routes (comm-pref directive detected in ${source})`);
  return before;
}
