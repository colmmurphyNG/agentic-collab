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
 * Clear every active route. Returns how many were live at the time, so the
 * caller can tell the operator whether anything was actually being forwarded.
 */
export function clearAllTelegramRoutes(): number {
  const live = listTelegramRoutes().length;
  routes.clear();
  return live;
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
 *   - "silence the notify" / "mute notifications" / "quiet the pings"
 *   - "I'm at the dashboard" / "back at dashboard" / "I'm at my desk"
 *   - "still notifying me" / "still pinging me" / "still getting pings"
 *   - "dashboard-quiet" / "dashboard quiet"
 *   - a message that is nothing but "silence" / "quiet" / "mute" / "shh"
 *
 * Used by /api/dashboard/send + routeTelegramMessage to AUTO-CLEAR the
 * Telegram routes when one of these is detected, pairing _default.md §12
 * (explicit ack on comm-preference directives) with enforcement-side
 * action. Avoids the 2026-06-12 incident where every Telegram complaint
 * refreshed the TTL and extended the noise window.
 *
 * That incident recurred on 2026-09-15 because this list is a vocabulary and
 * the operator's words were outside it: "silence on the notify, Im at desk",
 * then "Silence". Neither matched, so nothing cleared, and because a
 * non-matching inbound still arms a route, each complaint bought another
 * 30 minutes of the noise it was complaining about. Hence `isQuietCommand`
 * below — a phrase list is always one phrasing behind, so there has to be one
 * spelling that is guaranteed to work.
 *
 * False-positive guard: bare "notify" without a "stop/turn off/no/still"
 * prefix does NOT match — e.g. "we should notify the team" stays inactive.
 * The single-word forms match only when they are the WHOLE message, so
 * "the log silence was the diagnostic" stays inactive too.
 */
const COMM_PREF_DIRECTIVE_PATTERNS: RegExp[] = [
  /\b(turn[- ]off|stop|no|disable|silence|mute|kill)\s+(?:the\s+)?(--?notify|notify|notifying|notification|notifications|ping|pings|pinging)/i,
  /\b(silence|mute|quiet)\s+on\s+(?:the\s+)?(--?notify|notify|notification|notifications|ping|pings)/i,
  /\bstop\s+(notifying|pinging)\b/i,
  /\b(i'?m|i\s+am)\s+(at|back\s+at|back\s+on)\s+(?:the\s+)?(dashboard|desk|my\s+desk)\b/i,
  /\bback\s+(at|on)\s+(?:the\s+)?(dashboard|desk|my\s+desk)\b/i,
  /\bat\s+(my\s+)?desk\b/i,
  /\bstill\s+(notifying|pinging)\b/i,
  /\bstill\s+getting\s+(the\s+)?(notification|notifications|ping|pings|notifcations)\b/i,
  /\bdashboard[- ]quiet\b/i,
  // Whole-message single words only, so ordinary prose using "silence" or
  // "quiet" does not trip the guard.
  /^\s*(silence|quiet|mute|hush|shh+)\s*[.!]*\s*$/i,
];

/**
 * The explicit off switch: a Telegram message that is exactly `/quiet` (or
 * `/silence`, `/mute`), optionally with the `@botname` suffix Telegram adds in
 * groups.
 *
 * This exists because `isCommPrefDirective` is a guess at phrasing and will
 * keep being one phrasing behind. One spelling has to work every time, and be
 * documentable, so the operator is never reduced to rewording a complaint.
 */
const QUIET_COMMAND = /^\s*\/(quiet|silence|mute)(@[A-Za-z0-9_]+)?\s*$/i;

export function isQuietCommand(text: string): boolean {
  if (!text) return false;
  return QUIET_COMMAND.test(text);
}

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
  const cleared = clearAllTelegramRoutes();
  console.log(`[telegram-routing] auto-cleared ${cleared} routes (comm-pref directive detected in ${source})`);
  return cleared;
}
