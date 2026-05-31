/**
 * OO Phase 0/1/2 — token-usage aggregation for the /usage report endpoint.
 *
 * Walks Claude Code session JSONLs at ~/.claude/projects/<slug>/<sid>.jsonl
 * (mounted into the container via docker-compose.override.yml as
 * /host-projects/<slug>/<sid>.jsonl) and extracts per-event usage data from
 * assistant messages: `message.usage = {input_tokens, output_tokens,
 * cache_read_input_tokens}`. Aggregates by (project_slug, date, model) and
 * applies Anthropic pricing to produce dollar-cost overlays.
 *
 * Refresh model: in-memory cache rebuilt every REFRESH_MS (default 5 min).
 * On-demand refresh via `aggregate({force: true})`. Slow path is the JSONL
 * walk (~3-5s for the current 378-file corpus); cached path returns
 * immediately. Background refresh is best-effort — if the JSONL dir is
 * unreachable, the previous cache is returned with a `stale` flag.
 */

import { readFileSync } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Per-million-token pricing in USD. Public Anthropic pricing as of 2026-05. */
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  // Sonnet 4.6
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  // Opus 4.7
  'claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.5 },
  // Haiku 4.5
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  // 1M-context flavours (same pricing as base)
  'claude-opus-4-7[1m]': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-4-6[1m]': { input: 3, output: 15, cacheRead: 0.3 },
};

/** Pricing for unknown models — conservative Opus default so we don't under-report. */
const UNKNOWN_PRICING = { input: 15, output: 75, cacheRead: 1.5 };

export type DayBucket = {
  date: string;             // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;          // input * pricing.input + output * pricing.output + cacheRead * pricing.cacheRead
  sessions: number;         // distinct sessions contributing on this day
};

export type AgentBucket = {
  agent: string;            // derived from customTitle or project_slug
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  sessions: number;
  topSession?: {
    sessionId: string;
    title: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  };
};

export type SessionRow = {
  sessionId: string;
  title: string;            // customTitle or first user-message preview
  agent: string;
  projectSlug: string;
  startTs: string;
  endTs: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
};

export type UsageAggregate = {
  refreshedAt: string;
  windowDays: number;
  totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; sessions: number };
  byDay: DayBucket[];
  byAgent: AgentBucket[];
  topSessions: SessionRow[];   // outlier-cost sessions (>= $5 single session) plus top-10 overall
  outliers: SessionRow[];      // sessions >= OUTLIER_USD_THRESHOLD
  stale: boolean;              // true if last refresh failed and we're returning prior cache
  seatQuota: SeatQuotaReport | null; // null when SEAT_QUOTA_TOKENS_PER_MONTH unset
  costMultiplier: number;      // applied to displayed dollar figures; defaults to 1.0
};

/** Seat-quota tracking — operator's Anthropic Enterprise tier includes a token
 *  allowance per seat-per-month. /usage shows what % of that allowance the
 *  observed token consumption represents, plus a warning flag when consumption
 *  crosses the alert threshold. Calibrates the cost overlay against real
 *  Enterprise reality rather than list pricing. */
export type SeatQuotaReport = {
  monthlyTokenAllowance: number;
  tokensConsumedThisWindow: number;
  percentConsumed: number;     // tokensConsumedThisWindow / monthlyTokenAllowance × 100
  alertThresholdPct: number;
  isOverThreshold: boolean;
  windowDays: number;          // matches UsageAggregate.windowDays for context
};


const REFRESH_MS = 5 * 60 * 1000;     // 5 minutes
const OUTLIER_USD = 5;                // single-session cost threshold for the outliers list
const TOP_N_SESSIONS = 10;

const DEFAULT_JSONL_DIR = process.env['USAGE_JSONL_DIR'] || '/host-projects';
const DEFAULT_WINDOW_DAYS = parseInt(process.env['USAGE_WINDOW_DAYS'] || '7', 10);
// COST_MULTIPLIER — operator-configurable scale for displayed dollar figures.
// PR #50's list-price overlay is ~100-300× the actual Enterprise contract cost
// per the 2026-05-31 Netgear chargeback calibration. Default 1.0 (list-price);
// operator sets ~0.01 (1%) for Enterprise reality, or 0.0 to suppress dollars.
const COST_MULTIPLIER = parseFloat(process.env['COST_MULTIPLIER'] || '1.0');
// SEAT_QUOTA_TOKENS_PER_MONTH — operator's Anthropic seat token allowance.
// Unset → no seat-quota section in /usage report. Set this to your tier's
// included token allowance (visible in claude.ai usage page after some math
// from the % displayed there). Used to compute %-of-quota consumed.
const SEAT_QUOTA_TOKENS_PER_MONTH = process.env['SEAT_QUOTA_TOKENS_PER_MONTH']
  ? parseInt(process.env['SEAT_QUOTA_TOKENS_PER_MONTH'], 10)
  : null;
// SEAT_QUOTA_ALERT_THRESHOLD_PCT — when %-of-quota crosses this, render
// the seat-quota section in warning style. Default 80%.
const SEAT_QUOTA_ALERT_THRESHOLD_PCT = parseFloat(process.env['SEAT_QUOTA_ALERT_THRESHOLD_PCT'] || '80');


/** Cost = sum across token-types × per-million pricing. */
function calcCost(input: number, output: number, cacheRead: number, model: string | null): number {
  const p = (model && MODEL_PRICING[model]) || UNKNOWN_PRICING;
  return (input * p.input + output * p.output + cacheRead * p.cacheRead) / 1_000_000;
}

/** Aggregator with refresh-on-demand cache. */
export class UsageAggregator {
  private cached: UsageAggregate | null = null;
  private refreshing: Promise<UsageAggregate> | null = null;
  private readonly jsonlDir: string;
  private readonly windowDays: number;

  constructor(opts: { jsonlDir?: string; windowDays?: number } = {}) {
    this.jsonlDir = opts.jsonlDir ?? DEFAULT_JSONL_DIR;
    this.windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  }

  /** Returns cached aggregate if fresh; otherwise refreshes from disk. */
  async aggregate(opts: { force?: boolean } = {}): Promise<UsageAggregate> {
    const now = Date.now();
    if (!opts.force && this.cached) {
      const age = now - new Date(this.cached.refreshedAt).getTime();
      if (age < REFRESH_MS) return this.cached;
    }
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<UsageAggregate> {
    try {
      const result = this.walkJsonls();
      this.cached = result;
      return result;
    } catch (e) {
      if (this.cached) {
        return { ...this.cached, stale: true };
      }
      throw e;
    }
  }

  /** Synchronous JSONL walk. Cheap enough to run in-process — ~3-5s on 378 files. */
  private walkJsonls(): UsageAggregate {
    if (!existsSync(this.jsonlDir)) {
      throw new Error(`JSONL dir not found: ${this.jsonlDir}`);
    }

    const cutoffMs = Date.now() - this.windowDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    // Per-(date) buckets
    const dayMap = new Map<string, DayBucket>();
    // Per-(agent) buckets
    const agentMap = new Map<string, AgentBucket>();
    // Per-session rows
    const sessionMap = new Map<string, SessionRow>();

    let slugs: string[];
    try {
      slugs = readdirSync(this.jsonlDir);
    } catch {
      throw new Error(`Cannot read JSONL dir: ${this.jsonlDir}`);
    }

    for (const slug of slugs) {
      const slugDir = join(this.jsonlDir, slug);
      let files: string[];
      try {
        files = readdirSync(slugDir).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const fn of files) {
        const fp = join(slugDir, fn);
        let content: string;
        try {
          content = readFileSync(fp, 'utf-8');
        } catch { continue; }

        const sessionId = fn.replace(/\.jsonl$/, '');
        let agentName: string | null = null;
        let sessionTitle: string | null = null;
        let sessionStart: string | null = null;
        let sessionEnd: string | null = null;
        let sessionInput = 0;
        let sessionOutput = 0;
        let sessionCacheRead = 0;
        let sessionCost = 0;
        let sessionHasEventsInWindow = false;

        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line); } catch { continue; }

          const evType = ev['type'] as string | undefined;

          // Capture per-session metadata
          if (evType === 'custom-title') {
            sessionTitle = (ev['customTitle'] as string) ?? null;
            continue;
          }
          if (evType === 'agent-name') {
            agentName = (ev['agentName'] as string) ?? null;
            continue;
          }

          // Process assistant messages with usage data
          if (evType !== 'assistant') continue;
          const ts = ev['timestamp'] as string | undefined;
          if (!ts || ts < cutoffIso) continue;
          if (!sessionStart || ts < sessionStart) sessionStart = ts;
          if (!sessionEnd || ts > sessionEnd) sessionEnd = ts;
          sessionHasEventsInWindow = true;

          const msg = ev['message'] as Record<string, unknown> | undefined;
          const usage = msg?.['usage'] as Record<string, unknown> | undefined;
          const model = (msg?.['model'] as string) ?? null;
          if (!usage) continue;

          const input = (usage['input_tokens'] as number) || 0;
          const output = (usage['output_tokens'] as number) || 0;
          const cacheRead = (usage['cache_read_input_tokens'] as number) || 0;
          const cost = calcCost(input, output, cacheRead, model);

          sessionInput += input;
          sessionOutput += output;
          sessionCacheRead += cacheRead;
          sessionCost += cost;

          // Day bucket
          const date = ts.slice(0, 10);
          let dayBucket = dayMap.get(date);
          if (!dayBucket) {
            dayBucket = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0 };
            dayMap.set(date, dayBucket);
          }
          dayBucket.inputTokens += input;
          dayBucket.outputTokens += output;
          dayBucket.cacheReadTokens += cacheRead;
          dayBucket.costUsd += cost;
        }

        if (!sessionHasEventsInWindow) continue;

        const agent = agentName ?? sessionTitle ?? slug.replace(/^-Users-colm-murphy-/, '').replace(/-/g, '/');
        const title = sessionTitle ?? `${agent} — ${sessionId.slice(0, 8)}`;

        // Session row
        sessionMap.set(sessionId, {
          sessionId,
          title,
          agent,
          projectSlug: slug,
          startTs: sessionStart!,
          endTs: sessionEnd!,
          inputTokens: sessionInput,
          outputTokens: sessionOutput,
          cacheReadTokens: sessionCacheRead,
          costUsd: sessionCost,
        });

        // Agent bucket
        let agentBucket = agentMap.get(agent);
        if (!agentBucket) {
          agentBucket = { agent, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0 };
          agentMap.set(agent, agentBucket);
        }
        agentBucket.inputTokens += sessionInput;
        agentBucket.outputTokens += sessionOutput;
        agentBucket.cacheReadTokens += sessionCacheRead;
        agentBucket.costUsd += sessionCost;
        agentBucket.sessions += 1;

        // Day-session counter is approximate — count per day where the session contributed
        const days = new Set<string>();
        for (const date of dayMap.keys()) {
          if (sessionStart && date >= sessionStart.slice(0, 10) && sessionEnd && date <= sessionEnd.slice(0, 10)) {
            days.add(date);
          }
        }
        for (const d of days) {
          const db = dayMap.get(d);
          if (db) db.sessions += 1;
        }
      }
    }

    // Compute top session per agent
    const sessionsByAgent = new Map<string, SessionRow[]>();
    for (const s of sessionMap.values()) {
      const list = sessionsByAgent.get(s.agent) ?? [];
      list.push(s);
      sessionsByAgent.set(s.agent, list);
    }
    for (const [agent, sessions] of sessionsByAgent) {
      sessions.sort((a, b) => b.costUsd - a.costUsd);
      const top = sessions[0];
      if (top) {
        const ab = agentMap.get(agent);
        if (ab) ab.topSession = {
          sessionId: top.sessionId,
          title: top.title,
          costUsd: top.costUsd,
          inputTokens: top.inputTokens,
          outputTokens: top.outputTokens,
        };
      }
    }

    // Top-N overall + outliers
    const allSessions = [...sessionMap.values()].sort((a, b) => b.costUsd - a.costUsd);
    const topSessions = allSessions.slice(0, TOP_N_SESSIONS);
    const outliers = allSessions.filter(s => s.costUsd >= OUTLIER_USD);

    // Totals
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: sessionMap.size };
    for (const ab of agentMap.values()) {
      totals.inputTokens += ab.inputTokens;
      totals.outputTokens += ab.outputTokens;
      totals.cacheReadTokens += ab.cacheReadTokens;
      totals.costUsd += ab.costUsd;
    }

    // Seat-quota tracking — computed only when SEAT_QUOTA_TOKENS_PER_MONTH is set
    let seatQuota: SeatQuotaReport | null = null;
    if (SEAT_QUOTA_TOKENS_PER_MONTH && SEAT_QUOTA_TOKENS_PER_MONTH > 0) {
      // Include input + output + cache-read against the seat allowance — the
      // seat-quota model bundles all token-types into the included allowance.
      // (Anthropic's actual seat-quota accounting may weight cache-reads less;
      // operator can recalibrate by adjusting SEAT_QUOTA_TOKENS_PER_MONTH.)
      const consumed = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens;
      const percent = (consumed / SEAT_QUOTA_TOKENS_PER_MONTH) * 100;
      seatQuota = {
        monthlyTokenAllowance: SEAT_QUOTA_TOKENS_PER_MONTH,
        tokensConsumedThisWindow: consumed,
        percentConsumed: percent,
        alertThresholdPct: SEAT_QUOTA_ALERT_THRESHOLD_PCT,
        isOverThreshold: percent >= SEAT_QUOTA_ALERT_THRESHOLD_PCT,
        windowDays: this.windowDays,
      };
    }

    return {
      refreshedAt: new Date().toISOString(),
      windowDays: this.windowDays,
      totals,
      byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byAgent: [...agentMap.values()].sort((a, b) => b.costUsd - a.costUsd),
      topSessions,
      outliers,
      stale: false,
      seatQuota,
      costMultiplier: COST_MULTIPLIER,
    };
  }
}


/** Format the aggregate as a markdown report for the /usage HTML endpoint. */
export function renderUsageMarkdown(agg: UsageAggregate): string {
  const fmtTokens = (n: number) => {
    if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return `${n}`;
  };
  // Cost multiplier scales the list-price overlay against Enterprise reality.
  // Default 1.0 (list-price), operator can set COST_MULTIPLIER=0.01 (or whatever
  // their actual/list ratio is) to make the displayed dollars directionally
  // useful instead of wildly inflated. Calibration source: 2026-05-31 Netgear
  // chargeback showed ~0.3-1% of list price for Enterprise plan.
  const mult = agg.costMultiplier;
  const fmtUsd = (n: number) => `$${(n * mult).toFixed(2)}`;

  const lines: string[] = [];
  lines.push(`# Token Usage — last ${agg.windowDays} days`);
  lines.push('');
  if (agg.stale) {
    lines.push(`> ⚠️ Stale: last refresh attempt failed; showing previous cache from ${agg.refreshedAt}.`);
    lines.push('');
  } else {
    lines.push(`_Refreshed: ${agg.refreshedAt}_`);
    lines.push('');
  }

  // Seat-quota section — only renders when SEAT_QUOTA_TOKENS_PER_MONTH is set
  if (agg.seatQuota) {
    const sq = agg.seatQuota;
    const label = sq.isOverThreshold ? '## 🔴 Seat quota — OVER threshold' : '## Seat quota';
    lines.push(label);
    lines.push('');
    lines.push(`- **Allowance:** ${fmtTokens(sq.monthlyTokenAllowance)} tokens/month (from \`SEAT_QUOTA_TOKENS_PER_MONTH\`)`);
    lines.push(`- **Consumed in last ${sq.windowDays}d:** ${fmtTokens(sq.tokensConsumedThisWindow)} tokens (${sq.percentConsumed.toFixed(1)}%)`);
    lines.push(`- **Alert threshold:** ${sq.alertThresholdPct.toFixed(0)}%`);
    if (sq.isOverThreshold) {
      lines.push('');
      lines.push(`> ⚠️ **Over quota threshold.** Token consumption in the last ${sq.windowDays} days is at ${sq.percentConsumed.toFixed(1)}% of the monthly allowance. Investigate the per-agent breakdown below for outlier sessions.`);
    }
    lines.push('');
  }

  // Headline totals
  lines.push('## Totals');
  lines.push('');
  lines.push(`- **Input:** ${fmtTokens(agg.totals.inputTokens)} tokens`);
  lines.push(`- **Output:** ${fmtTokens(agg.totals.outputTokens)} tokens`);
  lines.push(`- **Cache read:** ${fmtTokens(agg.totals.cacheReadTokens)} tokens`);
  if (mult === 1.0) {
    lines.push(`- **Estimated cost (list price):** **${fmtUsd(agg.totals.costUsd)}** — note: this is Anthropic public list pricing; Enterprise contracts typically pay ~1% of this`);
  } else {
    lines.push(`- **Estimated cost (× ${mult.toFixed(2)} multiplier):** **${fmtUsd(agg.totals.costUsd)}**`);
  }
  lines.push(`- **Sessions:** ${agg.totals.sessions}`);
  lines.push('');

  // Burn-rate trend (linear extrapolation)
  if (agg.byDay.length >= 2) {
    const recent = agg.byDay.slice(-Math.min(7, agg.byDay.length));
    const recentCost = recent.reduce((s, d) => s + d.costUsd, 0);
    const daysCovered = recent.length;
    const dailyAvg = recentCost / daysCovered;
    lines.push(`**Burn rate (last ${daysCovered}d avg):** ${fmtUsd(dailyAvg)}/day · ${fmtTokens(recent.reduce((s, d) => s + d.inputTokens + d.outputTokens, 0) / daysCovered)} tokens/day`);
    lines.push('');
  }

  // Per-agent breakdown
  lines.push('## Per agent');
  lines.push('');
  lines.push('| Agent | Sessions | Input | Output | Cache read | Cost | Top session |');
  lines.push('|-------|---------:|------:|-------:|-----------:|-----:|-------------|');
  for (const ab of agg.byAgent) {
    const top = ab.topSession ? `${ab.topSession.title.slice(0, 50)} (${fmtUsd(ab.topSession.costUsd)})` : '—';
    lines.push(`| ${ab.agent} | ${ab.sessions} | ${fmtTokens(ab.inputTokens)} | ${fmtTokens(ab.outputTokens)} | ${fmtTokens(ab.cacheReadTokens)} | ${fmtUsd(ab.costUsd)} | ${top} |`);
  }
  lines.push('');

  // Daily breakdown
  lines.push('## By day');
  lines.push('');
  lines.push('| Date | Sessions | Input | Output | Cache read | Cost |');
  lines.push('|------|---------:|------:|-------:|-----------:|-----:|');
  for (const d of agg.byDay) {
    lines.push(`| ${d.date} | ${d.sessions} | ${fmtTokens(d.inputTokens)} | ${fmtTokens(d.outputTokens)} | ${fmtTokens(d.cacheReadTokens)} | ${fmtUsd(d.costUsd)} |`);
  }
  lines.push('');

  // Outlier sessions (>= $5)
  if (agg.outliers.length > 0) {
    lines.push(`## Cost outliers (≥ $${OUTLIER_USD} single session)`);
    lines.push('');
    lines.push('| Date | Agent | Session | Cost | Input | Output |');
    lines.push('|------|-------|---------|-----:|------:|-------:|');
    for (const s of agg.outliers) {
      lines.push(`| ${s.startTs.slice(0, 10)} | ${s.agent} | ${s.title.slice(0, 60)} | ${fmtUsd(s.costUsd)} | ${fmtTokens(s.inputTokens)} | ${fmtTokens(s.outputTokens)} |`);
    }
    lines.push('');
  }

  // Top sessions
  lines.push(`## Top ${TOP_N_SESSIONS} sessions by cost`);
  lines.push('');
  lines.push('| Rank | Date | Agent | Session | Cost |');
  lines.push('|-----:|------|-------|---------|-----:|');
  for (let i = 0; i < agg.topSessions.length; i++) {
    const s = agg.topSessions[i]!;
    lines.push(`| ${i + 1} | ${s.startTs.slice(0, 10)} | ${s.agent} | ${s.title.slice(0, 60)} | ${fmtUsd(s.costUsd)} |`);
  }

  return lines.join('\n');
}
