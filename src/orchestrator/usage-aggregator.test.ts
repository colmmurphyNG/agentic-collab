import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageAggregator, renderUsageMarkdown, MODEL_PRICING } from './usage-aggregator.ts';


function makeFixtureJsonl(events: object[]): string {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

function nowIso(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString();
}


describe('UsageAggregator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'usage-agg-')));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aggregates input/output/cache-read tokens across assistant messages', async () => {
    const slugDir = join(tmpDir, '-Users-colm-test');
    mkdirSync(slugDir);
    const ts = nowIso(0);
    writeFileSync(join(slugDir, 'session-a.jsonl'), makeFixtureJsonl([
      { type: 'custom-title', customTitle: 'test-agent', sessionId: 'session-a' },
      {
        type: 'assistant',
        timestamp: ts,
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 } },
      },
      {
        type: 'assistant',
        timestamp: ts,
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 0 } },
      },
    ]));

    const agg = await new UsageAggregator({ jsonlDir: tmpDir, windowDays: 7 }).aggregate();
    assert.equal(agg.totals.inputTokens, 3000);
    assert.equal(agg.totals.outputTokens, 1500);
    assert.equal(agg.totals.cacheReadTokens, 200);
    // Cost: (3000 * 3 + 1500 * 15 + 200 * 0.3) / 1M = (9000 + 22500 + 60) / 1M = $0.03156
    assert.ok(agg.totals.costUsd > 0.03, 'cost should be > $0.03');
    assert.ok(agg.totals.costUsd < 0.04, 'cost should be < $0.04');
  });

  it('groups by agent via agent-name event when present, falls back to customTitle then slug', async () => {
    const slugDir = join(tmpDir, '-Users-test-slug');
    mkdirSync(slugDir);
    const ts = nowIso(0);

    // Session A: has agent-name 'brain'
    writeFileSync(join(slugDir, 'a.jsonl'), makeFixtureJsonl([
      { type: 'agent-name', agentName: 'brain', sessionId: 'a' },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]));
    // Session B: customTitle 'tl' only
    writeFileSync(join(slugDir, 'b.jsonl'), makeFixtureJsonl([
      { type: 'custom-title', customTitle: 'tl', sessionId: 'b' },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 100 } } },
    ]));
    // Session C: no metadata → derived from slug
    writeFileSync(join(slugDir, 'c.jsonl'), makeFixtureJsonl([
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 300, output_tokens: 150 } } },
    ]));

    const agg = await new UsageAggregator({ jsonlDir: tmpDir, windowDays: 7 }).aggregate();
    const agents = agg.byAgent.map(a => a.agent);
    assert.ok(agents.includes('brain'), 'should include brain agent');
    assert.ok(agents.includes('tl'), 'should include tl agent');
    assert.equal(agg.byAgent.length, 3, 'three distinct agents');
  });

  it('filters out events outside the window', async () => {
    const slugDir = join(tmpDir, '-Users-old-and-new');
    mkdirSync(slugDir);
    writeFileSync(join(slugDir, 'mixed.jsonl'), makeFixtureJsonl([
      { type: 'custom-title', customTitle: 'agent-x', sessionId: 'mixed' },
      // 30 days ago → outside the 7-day window
      { type: 'assistant', timestamp: nowIso(-30), message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 9999, output_tokens: 9999 } } },
      // Today → inside window
      { type: 'assistant', timestamp: nowIso(0), message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]));

    const agg = await new UsageAggregator({ jsonlDir: tmpDir, windowDays: 7 }).aggregate();
    assert.equal(agg.totals.inputTokens, 100, 'should only include events inside window');
    assert.equal(agg.totals.outputTokens, 50);
  });

  it('flags sessions ≥ $5 as outliers', async () => {
    const slugDir = join(tmpDir, '-Users-cost-test');
    mkdirSync(slugDir);
    // Burn $14 of Sonnet: input 4M @ $3/M = $12, output 0.2M @ $15/M = $3 → ~$15
    writeFileSync(join(slugDir, 'expensive.jsonl'), makeFixtureJsonl([
      { type: 'agent-name', agentName: 'cost-test', sessionId: 'expensive' },
      { type: 'assistant', timestamp: nowIso(0), message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 4_000_000, output_tokens: 200_000 } } },
    ]));
    writeFileSync(join(slugDir, 'cheap.jsonl'), makeFixtureJsonl([
      { type: 'agent-name', agentName: 'cheap-test', sessionId: 'cheap' },
      { type: 'assistant', timestamp: nowIso(0), message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 500 } } },
    ]));

    const agg = await new UsageAggregator({ jsonlDir: tmpDir, windowDays: 7 }).aggregate();
    assert.equal(agg.outliers.length, 1, 'one outlier (the expensive session)');
    assert.equal(agg.outliers[0]!.sessionId, 'expensive');
    assert.ok(agg.outliers[0]!.costUsd > 14, 'expensive session should cost > $14');
  });

  it('returns stale cache when refresh fails (graceful degradation)', async () => {
    const agg = new UsageAggregator({ jsonlDir: tmpDir, windowDays: 7 });
    // First successful aggregate
    const slugDir = join(tmpDir, '-Users-stale-test');
    mkdirSync(slugDir);
    writeFileSync(join(slugDir, 'a.jsonl'), makeFixtureJsonl([
      { type: 'assistant', timestamp: nowIso(0), message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]));
    const fresh = await agg.aggregate();
    assert.equal(fresh.stale, false);
    assert.equal(fresh.totals.inputTokens, 100);

    // Now delete the dir + force refresh → should return stale prior cache
    rmSync(tmpDir, { recursive: true, force: true });
    const stale = await agg.aggregate({ force: true });
    assert.equal(stale.stale, true, 'second refresh after dir vanished should return stale flag');
    assert.equal(stale.totals.inputTokens, 100, 'stale data should match prior cache');
  });

  it('uses model pricing correctly for Sonnet/Opus/Haiku', () => {
    // Sanity-check the public pricing constants haven't drifted
    assert.equal(MODEL_PRICING['claude-sonnet-4-6']!.input, 3);
    assert.equal(MODEL_PRICING['claude-sonnet-4-6']!.output, 15);
    assert.equal(MODEL_PRICING['claude-haiku-4-5']!.input, 1);
    assert.equal(MODEL_PRICING['claude-haiku-4-5']!.output, 5);
    assert.equal(MODEL_PRICING['claude-opus-4-7']!.input, 15);
    assert.equal(MODEL_PRICING['claude-opus-4-7']!.output, 75);
  });
});

describe('renderUsageMarkdown', () => {
  it('renders all required sections for the /usage HTML endpoint', () => {
    const agg = {
      refreshedAt: '2026-05-31T17:00:00.000Z',
      windowDays: 7,
      totals: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 100_000, costUsd: 10.5, sessions: 5 },
      byDay: [
        { date: '2026-05-30', inputTokens: 500_000, outputTokens: 250_000, cacheReadTokens: 50_000, costUsd: 5, sessions: 3 },
        { date: '2026-05-31', inputTokens: 500_000, outputTokens: 250_000, cacheReadTokens: 50_000, costUsd: 5.5, sessions: 4 },
      ],
      byAgent: [
        { agent: 'brain', inputTokens: 600_000, outputTokens: 300_000, cacheReadTokens: 60_000, costUsd: 6, sessions: 2 },
        { agent: 'tl', inputTokens: 400_000, outputTokens: 200_000, cacheReadTokens: 40_000, costUsd: 4.5, sessions: 3 },
      ],
      topSessions: [],
      outliers: [],
      stale: false,
    };
    const md = renderUsageMarkdown(agg);
    assert.match(md, /# Token Usage/);
    assert.match(md, /## Totals/);
    assert.match(md, /## Per agent/);
    assert.match(md, /## By day/);
    assert.match(md, /brain/);
    assert.match(md, /tl/);
    assert.match(md, /\$10\.50/);
  });

  it('shows the stale warning when stale=true', () => {
    const stale = {
      refreshedAt: '2026-05-30T00:00:00.000Z',
      windowDays: 7,
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 0 },
      byDay: [],
      byAgent: [],
      topSessions: [],
      outliers: [],
      stale: true,
    };
    const md = renderUsageMarkdown(stale);
    assert.match(md, /Stale/i);
  });
});
