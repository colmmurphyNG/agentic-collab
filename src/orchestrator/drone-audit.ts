/**
 * PP-0 — brain audit job. Identifies repetitive cheap-task patterns in
 * agent session data and recommends offloading to a Haiku-running drone
 * persona for cost savings.
 *
 * Data source: the LL-0 raw session FTS5 index at
 *   scratch/brain/sessions-index/index.db
 * (built by `index-claude-sessions.py`). Contains every assistant
 * tool_use / tool_result / text event across all 378+ session JSONLs.
 *
 * Pattern matchers below are regexes against the `content` column of the
 * events FTS5 table, scoped to tool_use events where most "routine
 * cheap-task" patterns live (CI polls, log scans, ticket sweeps, etc.).
 *
 * Cost savings model: pattern occurrence count × estimated $-per-occurrence
 * × (sonnet_price − haiku_price) / sonnet_price. The per-occurrence cost is
 * a rough heuristic (avg session cost / avg ops per session). Operator
 * recalibrates by tuning DRONE_AVG_COST_PER_OCCURRENCE env var.
 *
 * Refresh model: same as UsageAggregator — 5-min cache, refresh on demand.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';


/** Pattern catalogue — regex against the LL-0 events.content column.
 *  Each pattern represents a class of routine task we'd consider for drone
 *  offload. Keep these specific enough to avoid false positives but broad
 *  enough to capture variations. */
export const DRONE_PATTERNS: DronePatternDef[] = [
  {
    id: 'ci-status-checks',
    label: 'CI status polling (gh run view / gh pr checks)',
    regex: '(gh run view|gh pr checks|gh workflow run|actions/runs/\\d+)',
    contentKindFilter: ['tool_use'],
    description: 'Bash invocations polling GitHub Actions / PR check status. Read-only, structured output, perfect drone fodder.',
  },
  {
    id: 'log-scans',
    label: 'Datadog log queries',
    regex: 'mcp__datadog__(logs|search_logs|get_latest)',
    contentKindFilter: ['tool_use'],
    description: 'Datadog MCP log scans. Pattern-matching against known error signatures rarely needs Opus reasoning.',
  },
  {
    id: 'jira-ticket-sweeps',
    label: 'Jira ticket lookups',
    regex: 'mcp__atlassian__jira_(get_issue|search_issues|get_transitions|get_project_issues)',
    contentKindFilter: ['tool_use'],
    description: 'Read-only Jira queries. Structured input/output; drone-suitable.',
  },
  {
    id: 'pr-validation',
    label: 'PR title/body validation',
    regex: '(gh pr view|gh pr list).*?(--json|--body|--title)',
    contentKindFilter: ['tool_use'],
    description: 'PR metadata inspection for convention checks. Pure pattern-match work.',
  },
  {
    id: 'read-only-file-inspection',
    label: 'Read-only file inspection (no follow-up edit)',
    regex: '^Read\\s|^Glob\\s|^Grep\\s',
    contentKindFilter: ['tool_use'],
    description: 'File reads + searches. Many of these are followed by edits (legitimate work for Opus); some are pure inspection.',
  },
  {
    id: 'shell-curl-polls',
    label: 'curl polling (CI / health-checks / external URLs)',
    regex: 'curl\\s+-s\\w*\\s+https?://',
    contentKindFilter: ['tool_use'],
    description: 'curl-based polling. Almost always routine.',
  },
  {
    id: 'cron-style-monitoring',
    label: 'Repeated identical Bash calls (loop polling)',
    regex: 'until\\s+.+?;\\s*do\\s+sleep|while\\s+true|for\\s+i\\s+in\\s+\\$\\(seq',
    contentKindFilter: ['tool_use'],
    description: 'Shell loops that poll until a condition. Classic drone work.',
  },
  {
    id: 'test-output-interpretation',
    label: 'Test output parsing (jest/playwright/node:test)',
    regex: '(playwright test|jest |node --test|npm (test|run test))',
    contentKindFilter: ['tool_use'],
    description: 'Running tests + reading their output. Drone can match against known failure-mode catalog before escalating.',
  },
];

export type DronePatternDef = {
  id: string;
  label: string;
  regex: string;
  contentKindFilter: string[];
  description: string;
};

export type PatternMatch = {
  patternId: string;
  patternLabel: string;
  patternDescription: string;
  totalOccurrences: number;
  byAgent: Array<{ agent: string; occurrences: number; estSavingsUsd: number }>;
  estSavingsUsd: number;
};

export type DroneAuditReport = {
  refreshedAt: string;
  windowDays: number;
  jsonlIndexPath: string;
  totalEvents: number;
  patternMatches: PatternMatch[];
  totalEstSavingsUsd: number;
  costAssumptions: {
    sonnetInputPerM: number;
    sonnetOutputPerM: number;
    haikuInputPerM: number;
    haikuOutputPerM: number;
    avgCostPerOccurrence: number;
    savingsRatio: number;
  };
  stale: boolean;
};


const REFRESH_MS = 5 * 60 * 1000;

const DEFAULT_INDEX_PATH = process.env['DRONE_AUDIT_INDEX_DB']
  || '/host-dev/conductor/scratch/brain/sessions-index/index.db';
const DEFAULT_WINDOW_DAYS = parseInt(process.env['USAGE_WINDOW_DAYS'] || '7', 10);
// Average cost per pattern occurrence — operator-tunable. Default $0.10 per
// occurrence (typical tool_use round-trip on Sonnet 4.6 with cache reads).
// Bump up/down based on observed reality from /usage data.
const AVG_COST_PER_OCCURRENCE = parseFloat(process.env['DRONE_AVG_COST_PER_OCCURRENCE'] || '0.10');
// Haiku vs Sonnet savings ratio. Sonnet input $3/M / Haiku input $1/M = 3×.
// Sonnet output $15/M / Haiku output $5/M = 3×. Conservative blended estimate:
// ~67% saving (Haiku costs ~33% of Sonnet at typical input/output ratio).
const SAVINGS_RATIO = 0.67;

// Cost-model constants (for the report's costAssumptions block)
const SONNET_INPUT = 3;
const SONNET_OUTPUT = 15;
const HAIKU_INPUT = 1;
const HAIKU_OUTPUT = 5;


export class DroneAuditAggregator {
  private cached: DroneAuditReport | null = null;
  private refreshing: Promise<DroneAuditReport> | null = null;
  private readonly indexPath: string;
  private readonly windowDays: number;

  constructor(opts: { indexPath?: string; windowDays?: number } = {}) {
    this.indexPath = opts.indexPath ?? DEFAULT_INDEX_PATH;
    this.windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  }

  async audit(opts: { force?: boolean } = {}): Promise<DroneAuditReport> {
    if (!opts.force && this.cached) {
      const age = Date.now() - new Date(this.cached.refreshedAt).getTime();
      if (age < REFRESH_MS) return this.cached;
    }
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doAudit().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doAudit(): Promise<DroneAuditReport> {
    try {
      const result = this.runQueries();
      this.cached = result;
      return result;
    } catch (e) {
      if (this.cached) return { ...this.cached, stale: true };
      throw e;
    }
  }

  private runQueries(): DroneAuditReport {
    if (!existsSync(this.indexPath)) {
      throw new Error(`LL-0 index not found at ${this.indexPath}. Run scratch/brain/sessions-index/index-claude-sessions.py first.`);
    }
    const db = new DatabaseSync(this.indexPath, { readOnly: true });
    try {
      const cutoffMs = Date.now() - this.windowDays * 24 * 60 * 60 * 1000;
      const cutoffIso = new Date(cutoffMs).toISOString();

      // Total events for context
      const totalRow = db.prepare(
        'SELECT COUNT(*) AS n FROM events WHERE timestamp >= ?'
      ).get(cutoffIso) as { n: number };
      const totalEvents = totalRow.n;

      const matches: PatternMatch[] = [];
      let totalSavings = 0;

      for (const pat of DRONE_PATTERNS) {
        // FTS5 doesn't expose regex natively. Use LIKE pattern for cheap pre-filter
        // then regex-filter in JS for precision. This avoids loading the full
        // events table into memory.
        //
        // The LIKE pattern derives from the regex by taking a stable token from
        // the pattern (the first plain-text segment). For patterns where this
        // is hard, we fall back to scanning all tool_use rows in the window.
        const likeKeyword = this.deriveLikeKeyword(pat.regex);
        const sql = likeKeyword
          ? `SELECT content_kind, content, project_slug
             FROM events
             WHERE timestamp >= ? AND content LIKE ?`
          : `SELECT content_kind, content, project_slug
             FROM events
             WHERE timestamp >= ? AND content_kind IN ('tool_use', 'text')`;
        const params = likeKeyword ? [cutoffIso, `%${likeKeyword}%`] : [cutoffIso];
        const rows = db.prepare(sql).all(...params) as Array<{
          content_kind: string;
          content: string;
          project_slug: string;
        }>;

        const re = new RegExp(pat.regex);
        const perAgent = new Map<string, number>();
        let total = 0;
        for (const row of rows) {
          if (!pat.contentKindFilter.includes(row.content_kind)) continue;
          if (!re.test(row.content)) continue;
          total++;
          const agent = this.slugToAgent(row.project_slug);
          perAgent.set(agent, (perAgent.get(agent) ?? 0) + 1);
        }

        const estSavings = total * AVG_COST_PER_OCCURRENCE * SAVINGS_RATIO;
        const byAgent = [...perAgent.entries()]
          .map(([agent, occurrences]) => ({
            agent,
            occurrences,
            estSavingsUsd: occurrences * AVG_COST_PER_OCCURRENCE * SAVINGS_RATIO,
          }))
          .sort((a, b) => b.occurrences - a.occurrences);

        matches.push({
          patternId: pat.id,
          patternLabel: pat.label,
          patternDescription: pat.description,
          totalOccurrences: total,
          byAgent,
          estSavingsUsd: estSavings,
        });
        totalSavings += estSavings;
      }

      matches.sort((a, b) => b.totalOccurrences - a.totalOccurrences);

      return {
        refreshedAt: new Date().toISOString(),
        windowDays: this.windowDays,
        jsonlIndexPath: this.indexPath,
        totalEvents,
        patternMatches: matches,
        totalEstSavingsUsd: totalSavings,
        costAssumptions: {
          sonnetInputPerM: SONNET_INPUT,
          sonnetOutputPerM: SONNET_OUTPUT,
          haikuInputPerM: HAIKU_INPUT,
          haikuOutputPerM: HAIKU_OUTPUT,
          avgCostPerOccurrence: AVG_COST_PER_OCCURRENCE,
          savingsRatio: SAVINGS_RATIO,
        },
        stale: false,
      };
    } finally {
      db.close();
    }
  }

  /** Pull a stable plain-text token from a regex for LIKE pre-filtering.
   *  Returns null when the regex contains alternation — a single LIKE keyword
   *  would incorrectly filter out rows that match the other branches. */
  private deriveLikeKeyword(regex: string): string | null {
    if (regex.includes('|')) return null;
    const stripped = regex.replace(/[\\^$.|?*+()[\]{}]/g, ' ');
    const match = stripped.match(/[A-Za-z_][A-Za-z_0-9]{2,}/);
    return match ? match[0] : null;
  }

  /** Slug → agent name heuristic. The LL-0 events table doesn't carry agent
   *  name directly; project_slug encodes the cwd which often maps to an agent.
   *
   *  Mapping rules are operator-configured via env (per-fork persona/project
   *  layout differs). Format:
   *    SLUG_AGENT_MAPPINGS=SUBSTRING:label,SUBSTRING:label,...
   *  e.g. `project-a:agent-a,project-b:agent-b`. First substring match wins.
   *
   *  Falls back to the slug's last segment stripped of the leading user-path
   *  noise so unmapped slugs still produce something semi-readable. */
  private slugToAgent(slug: string): string {
    if (slug.endsWith('-conductor')) return 'conductor-agents';
    for (const [needle, label] of slugMappings()) {
      if (slug.includes(needle)) return label;
    }
    // Generic fallback: strip leading `-Users-<user>-` if present, then dashes → slashes.
    return slug.replace(/^-Users-[^-]+(?:-[^-]+)?-/, '').replace(/-/g, '/');
  }
}

/** Parse SLUG_AGENT_MAPPINGS into an ordered array of [substring, label] pairs.
 *  Empty/unset → empty array (no operator-specific mappings; falls back to the
 *  generic slug-cleanup transform). */
function slugMappings(): Array<[string, string]> {
  const raw = process.env['SLUG_AGENT_MAPPINGS'];
  if (!raw) return [];
  const out: Array<[string, string]> = [];
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [needle, label] = pair.split(':').map((s) => s.trim());
    if (needle && label) out.push([needle, label]);
  }
  return out;
}


/** Format the audit report as markdown for the /audit HTML endpoint. */
export function renderAuditMarkdown(report: DroneAuditReport): string {
  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
  const lines: string[] = [];
  lines.push(`# Drone Offload Audit — last ${report.windowDays} days`);
  lines.push('');
  if (report.stale) {
    lines.push(`> ⚠️ Stale: last refresh failed; showing previous cache from ${report.refreshedAt}.`);
    lines.push('');
  } else {
    lines.push(`_Refreshed: ${report.refreshedAt}_`);
    lines.push('');
  }

  lines.push(`Brain scanned **${report.totalEvents.toLocaleString()}** events across the LL-0 raw session index for routine cheap-task patterns that could be offloaded to a Haiku-running drone persona for cost savings.`);
  lines.push('');

  lines.push('## Headline');
  lines.push('');
  if (report.totalEstSavingsUsd > 0) {
    lines.push(`- **Estimated savings if all matched patterns ran on Haiku instead of Sonnet/Opus:** **${fmtUsd(report.totalEstSavingsUsd)}** over the last ${report.windowDays} days.`);
    lines.push(`- Annualised: ~${fmtUsd(report.totalEstSavingsUsd * 365 / report.windowDays)}.`);
  } else {
    lines.push('- No matched patterns in the window. Either drone-suitable work is rare in this corpus, or the pattern catalogue needs expansion.');
  }
  lines.push('');

  lines.push('## Cost assumptions');
  lines.push('');
  const ca = report.costAssumptions;
  lines.push(`- **Sonnet 4.6:** $${ca.sonnetInputPerM}/M input + $${ca.sonnetOutputPerM}/M output (list price)`);
  lines.push(`- **Haiku 4.5:** $${ca.haikuInputPerM}/M input + $${ca.haikuOutputPerM}/M output (list price)`);
  lines.push(`- **Average cost per pattern occurrence:** ${fmtUsd(ca.avgCostPerOccurrence)} _(tunable via \`DRONE_AVG_COST_PER_OCCURRENCE\`)_`);
  lines.push(`- **Savings ratio:** ${(ca.savingsRatio * 100).toFixed(0)}% _(Haiku is ~33% of Sonnet on blended in/out)_`);
  lines.push(`- Estimates are at list price — multiply by your \`COST_MULTIPLIER\` to get Enterprise-calibrated saving.`);
  lines.push('');

  lines.push('## Patterns by frequency');
  lines.push('');
  for (const m of report.patternMatches) {
    if (m.totalOccurrences === 0) continue;
    lines.push(`### ${m.patternLabel}`);
    lines.push('');
    lines.push(`_${m.patternDescription}_`);
    lines.push('');
    lines.push(`- **Occurrences:** ${m.totalOccurrences.toLocaleString()} in last ${report.windowDays} days`);
    lines.push(`- **Est. savings if drone-offloaded:** ${fmtUsd(m.estSavingsUsd)}`);
    if (m.byAgent.length > 0) {
      lines.push('');
      lines.push('| Agent | Occurrences | Est. saving |');
      lines.push('|-------|------------:|------------:|');
      for (const a of m.byAgent.slice(0, 8)) {
        lines.push(`| ${a.agent} | ${a.occurrences} | ${fmtUsd(a.estSavingsUsd)} |`);
      }
    }
    lines.push('');
  }

  if (report.patternMatches.every(m => m.totalOccurrences === 0)) {
    lines.push('_No matches across any catalogued pattern. Likely either:_');
    lines.push('- _LL-0 index is empty or outdated — re-run `index-claude-sessions.py`_');
    lines.push('- _Pattern catalogue too narrow — propose new patterns to add to `DRONE_PATTERNS`_');
    lines.push('- _The team genuinely runs little routine work in this window_');
    lines.push('');
  }

  lines.push('## Next steps');
  lines.push('');
  if (report.totalEstSavingsUsd >= 50) {
    lines.push('- **Annualised savings ≥ $50/wk → drone-persona infrastructure pays back.** Consider shipping PP-1 (drone.md persona on Haiku) + PP-2 (dispatch convention).');
  } else if (report.totalEstSavingsUsd > 0) {
    lines.push(`- Estimated weekly savings (${fmtUsd(report.totalEstSavingsUsd)}) below $50/wk threshold. Drone-persona overhead may not pay back at current volume — consider waiting for the pattern frequency to grow, or expand the pattern catalogue to capture more candidates.`);
  } else {
    lines.push('- No savings detected. Refresh the LL-0 index and re-audit, or expand the pattern catalogue.');
  }
  lines.push('');
  lines.push('## Calibration knobs');
  lines.push('');
  lines.push('- `DRONE_AVG_COST_PER_OCCURRENCE` (default $0.10) — adjust to match your observed per-tool-call cost from `/usage` data');
  lines.push('- `DRONE_AUDIT_INDEX_DB` (default `/host-dev/conductor/scratch/brain/sessions-index/index.db`) — path to LL-0 index');
  lines.push('- `USAGE_WINDOW_DAYS` (default 7) — analysis window');

  return lines.join('\n');
}
