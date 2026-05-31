import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DRONE_PATTERNS,
  DroneAuditAggregator,
  renderAuditMarkdown,
  type DroneAuditReport,
} from './drone-audit.ts';


function buildFixtureIndex(dbPath: string, rows: Array<{
  timestamp: string;
  role: string;
  content_kind: string;
  content: string;
  project_slug?: string;
}>) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE VIRTUAL TABLE events USING fts5(
      event_id UNINDEXED,
      session_id UNINDEXED,
      project_slug UNINDEXED,
      timestamp UNINDEXED,
      role UNINDEXED,
      content_kind UNINDEXED,
      cwd UNINDEXED,
      git_branch UNINDEXED,
      content
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO events (event_id, session_id, project_slug, timestamp, role, content_kind, cwd, git_branch, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let i = 0;
  for (const r of rows) {
    stmt.run(
      `evt-${i++}`,
      'session-fixture',
      r.project_slug ?? '-Users-colm-murphy-dev-conductor',
      r.timestamp,
      r.role,
      r.content_kind,
      '/Users/colm.murphy/dev/conductor',
      'main',
      r.content,
    );
  }
  db.close();
}


describe('DRONE_PATTERNS catalogue', () => {
  it('every pattern has a unique id, compilable regex, and non-empty label', () => {
    const ids = new Set<string>();
    for (const p of DRONE_PATTERNS) {
      assert.ok(!ids.has(p.id), `Duplicate pattern id: ${p.id}`);
      ids.add(p.id);
      assert.ok(p.label.length > 0, `Pattern ${p.id} missing label`);
      assert.ok(p.description.length > 0, `Pattern ${p.id} missing description`);
      assert.ok(p.contentKindFilter.length > 0, `Pattern ${p.id} missing contentKindFilter`);
      assert.doesNotThrow(() => new RegExp(p.regex), `Pattern ${p.id} regex does not compile`);
    }
  });

  it('ci-status-checks pattern matches gh run view and rejects unrelated text', () => {
    const re = new RegExp(DRONE_PATTERNS.find(p => p.id === 'ci-status-checks')!.regex);
    assert.ok(re.test('gh run view 12345'));
    assert.ok(re.test('gh pr checks --watch'));
    assert.ok(re.test('https://github.com/foo/bar/actions/runs/987'));
    assert.ok(!re.test('git status'));
  });

  it('log-scans pattern matches Datadog MCP tools and rejects unrelated text', () => {
    const re = new RegExp(DRONE_PATTERNS.find(p => p.id === 'log-scans')!.regex);
    assert.ok(re.test('mcp__datadog__logs'));
    assert.ok(re.test('mcp__datadog__search_logs'));
    assert.ok(re.test('mcp__datadog__get_latest_error'));
    assert.ok(!re.test('mcp__atlassian__jira_get_issue'));
  });

  it('jira-ticket-sweeps pattern matches Jira MCP read tools and rejects writes', () => {
    const re = new RegExp(DRONE_PATTERNS.find(p => p.id === 'jira-ticket-sweeps')!.regex);
    assert.ok(re.test('mcp__atlassian__jira_get_issue'));
    assert.ok(re.test('mcp__atlassian__jira_search_issues'));
    assert.ok(!re.test('mcp__atlassian__jira_create_issue'));
    assert.ok(!re.test('mcp__atlassian__jira_add_comment'));
  });

  it('cron-style-monitoring pattern matches shell polling loops', () => {
    const re = new RegExp(DRONE_PATTERNS.find(p => p.id === 'cron-style-monitoring')!.regex);
    assert.ok(re.test('until curl localhost:8001; do sleep 5; done'));
    assert.ok(re.test('while true; do gh run view; done'));
    assert.ok(re.test('for i in $(seq 1 10); do echo $i; done'));
    assert.ok(!re.test('echo hello'));
  });
});


describe('DroneAuditAggregator', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drone-audit-'));
    dbPath = join(tmpDir, 'index.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('counts pattern occurrences and attributes to the right agent slug', async () => {
    const now = new Date().toISOString();
    buildFixtureIndex(dbPath, [
      { timestamp: now, role: 'assistant', content_kind: 'tool_use', content: '[tool_use Bash] gh run view 999' },
      { timestamp: now, role: 'assistant', content_kind: 'tool_use', content: '[tool_use Bash] gh pr checks 1234' },
      { timestamp: now, role: 'assistant', content_kind: 'tool_use', content: 'mcp__datadog__logs query', project_slug: '-Users-colm-murphy-dev-Datadog' },
      { timestamp: now, role: 'user', content_kind: 'text', content: 'gh run view' },  // wrong role/kind — should NOT match ci-status-checks (contentKindFilter excludes text)
    ]);

    const agg = new DroneAuditAggregator({ indexPath: dbPath, windowDays: 7 });
    const report = await agg.audit();

    const ci = report.patternMatches.find(p => p.patternId === 'ci-status-checks')!;
    assert.equal(ci.totalOccurrences, 2);
    assert.ok(ci.estSavingsUsd > 0);

    const dd = report.patternMatches.find(p => p.patternId === 'log-scans')!;
    assert.equal(dd.totalOccurrences, 1);
    assert.deepEqual(dd.byAgent.map(a => a.agent), ['dd']);
  });

  it('respects the windowDays cutoff', async () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    buildFixtureIndex(dbPath, [
      { timestamp: recent, role: 'assistant', content_kind: 'tool_use', content: 'gh run view 1' },
      { timestamp: old,    role: 'assistant', content_kind: 'tool_use', content: 'gh run view 2' },
    ]);

    const agg = new DroneAuditAggregator({ indexPath: dbPath, windowDays: 7 });
    const report = await agg.audit();
    const ci = report.patternMatches.find(p => p.patternId === 'ci-status-checks')!;
    assert.equal(ci.totalOccurrences, 1);
  });

  it('returns empty matches and totalEstSavingsUsd=0 on empty corpus', async () => {
    buildFixtureIndex(dbPath, []);
    const agg = new DroneAuditAggregator({ indexPath: dbPath, windowDays: 7 });
    const report = await agg.audit();
    assert.equal(report.totalEvents, 0);
    assert.equal(report.totalEstSavingsUsd, 0);
    for (const m of report.patternMatches) {
      assert.equal(m.totalOccurrences, 0);
    }
  });

  it('caches results within REFRESH_MS and returns same object on second call', async () => {
    const now = new Date().toISOString();
    buildFixtureIndex(dbPath, [
      { timestamp: now, role: 'assistant', content_kind: 'tool_use', content: 'gh run view 1' },
    ]);
    const agg = new DroneAuditAggregator({ indexPath: dbPath, windowDays: 7 });
    const first = await agg.audit();
    const second = await agg.audit();
    assert.equal(first.refreshedAt, second.refreshedAt);
  });

  it('force=true bypasses the cache and re-queries the DB', async () => {
    const now = new Date().toISOString();
    buildFixtureIndex(dbPath, [
      { timestamp: now, role: 'assistant', content_kind: 'tool_use', content: 'gh run view 1' },
    ]);
    const agg = new DroneAuditAggregator({ indexPath: dbPath, windowDays: 7 });
    const first = await agg.audit();
    // Wait 1 ms so refreshedAt differs
    await new Promise(r => setTimeout(r, 2));
    const second = await agg.audit({ force: true });
    assert.notEqual(first.refreshedAt, second.refreshedAt);
  });

  it('throws when the LL-0 index file does not exist', async () => {
    const missing = join(tmpDir, 'does-not-exist.db');
    const agg = new DroneAuditAggregator({ indexPath: missing, windowDays: 7 });
    await assert.rejects(() => agg.audit(), /LL-0 index not found/);
  });

  it('cost-savings math: savings = occurrences × avgCost × savingsRatio', async () => {
    const now = new Date().toISOString();
    // Build 10 ci-status-check events
    const rows = Array.from({ length: 10 }, (_, i) => ({
      timestamp: now,
      role: 'assistant',
      content_kind: 'tool_use',
      content: `gh run view ${i}`,
    }));
    buildFixtureIndex(dbPath, rows);
    const agg = new DroneAuditAggregator({ indexPath: dbPath, windowDays: 7 });
    const report = await agg.audit();
    const ci = report.patternMatches.find(p => p.patternId === 'ci-status-checks')!;
    const expected = 10 * report.costAssumptions.avgCostPerOccurrence * report.costAssumptions.savingsRatio;
    assert.ok(Math.abs(ci.estSavingsUsd - expected) < 1e-9, `expected ${expected}, got ${ci.estSavingsUsd}`);
  });

  it('sorts matches by total occurrences descending', async () => {
    const now = new Date().toISOString();
    const rows: Array<{ timestamp: string; role: string; content_kind: string; content: string }> = [];
    // 5 ci-status-checks
    for (let i = 0; i < 5; i++) rows.push({ timestamp: now, role: 'assistant', content_kind: 'tool_use', content: `gh run view ${i}` });
    // 2 log-scans
    for (let i = 0; i < 2; i++) rows.push({ timestamp: now, role: 'assistant', content_kind: 'tool_use', content: `mcp__datadog__logs ${i}` });
    buildFixtureIndex(dbPath, rows);
    const agg = new DroneAuditAggregator({ indexPath: dbPath, windowDays: 7 });
    const report = await agg.audit();
    const nonZero = report.patternMatches.filter(m => m.totalOccurrences > 0);
    for (let i = 0; i < nonZero.length - 1; i++) {
      assert.ok(nonZero[i]!.totalOccurrences >= nonZero[i + 1]!.totalOccurrences);
    }
  });
});


describe('renderAuditMarkdown', () => {
  function makeReport(overrides: Partial<DroneAuditReport> = {}): DroneAuditReport {
    return {
      refreshedAt: '2026-05-31T20:00:00.000Z',
      windowDays: 7,
      jsonlIndexPath: '/tmp/test.db',
      totalEvents: 0,
      patternMatches: [],
      totalEstSavingsUsd: 0,
      costAssumptions: {
        sonnetInputPerM: 3,
        sonnetOutputPerM: 15,
        haikuInputPerM: 1,
        haikuOutputPerM: 5,
        avgCostPerOccurrence: 0.1,
        savingsRatio: 0.67,
      },
      stale: false,
      ...overrides,
    };
  }

  it('renders an empty report with the "no matches" hint', () => {
    const md = renderAuditMarkdown(makeReport());
    assert.match(md, /No matched patterns in the window/);
    assert.match(md, /No matches across any catalogued pattern/);
  });

  it('renders headline savings when there are matches', () => {
    const md = renderAuditMarkdown(makeReport({
      totalEvents: 100,
      totalEstSavingsUsd: 12.34,
      patternMatches: [{
        patternId: 'ci-status-checks',
        patternLabel: 'CI status polling',
        patternDescription: 'desc',
        totalOccurrences: 50,
        byAgent: [{ agent: 'tl', occurrences: 50, estSavingsUsd: 12.34 }],
        estSavingsUsd: 12.34,
      }],
    }));
    assert.match(md, /\$12\.34/);
    assert.match(md, /CI status polling/);
    assert.match(md, /\| tl \| 50 \| \$12\.34 \|/);
  });

  it('renders the stale banner when stale=true', () => {
    const md = renderAuditMarkdown(makeReport({ stale: true }));
    assert.match(md, /Stale/);
  });

  it('recommends shipping PP-1+ when savings >= \\$50', () => {
    const md = renderAuditMarkdown(makeReport({ totalEstSavingsUsd: 75 }));
    assert.match(md, /drone-persona infrastructure pays back/);
  });

  it('recommends waiting when 0 < savings < \\$50', () => {
    const md = renderAuditMarkdown(makeReport({ totalEstSavingsUsd: 12 }));
    assert.match(md, /below \$50\/wk threshold/);
  });
});
