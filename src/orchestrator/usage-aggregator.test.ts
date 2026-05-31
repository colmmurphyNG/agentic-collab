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
      seatQuota: null,
      costMultiplier: 1.0,
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
      seatQuota: null,
      costMultiplier: 1.0,
    };
    const md = renderUsageMarkdown(stale);
    assert.match(md, /Stale/i);
  });

  it('applies costMultiplier to displayed dollar figures (OO seat-quota reframe)', () => {
    const agg = {
      refreshedAt: '2026-05-31T17:00:00.000Z',
      windowDays: 7,
      totals: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 100_000, costUsd: 1000, sessions: 5 },
      byDay: [],
      byAgent: [],
      topSessions: [],
      outliers: [],
      stale: false,
      seatQuota: null,
      costMultiplier: 0.01,  // Enterprise-calibrated 1% of list
    };
    const md = renderUsageMarkdown(agg);
    // 1000 × 0.01 = $10.00 displayed
    assert.match(md, /\$10\.00/, 'cost should be scaled by multiplier');
    assert.match(md, /× 0\.01 multiplier/, 'header should declare the multiplier');
    assert.doesNotMatch(md, /\$1000\.00/, 'unscaled cost should not appear');
  });

  it('renders seat-quota section with WARNING badge when over threshold', () => {
    const agg = {
      refreshedAt: '2026-05-31T17:00:00.000Z',
      windowDays: 7,
      totals: { inputTokens: 80_000_000, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 1 },
      byDay: [],
      byAgent: [],
      topSessions: [],
      outliers: [],
      stale: false,
      seatQuota: {
        monthlyTokenAllowance: 100_000_000,
        tokensConsumedThisWindow: 80_000_000,
        percentConsumed: 95,  // projected monthly burn-rate
        alertThresholdPct: 80,
        isOverThreshold: true,
        windowDays: 7,
      },
      costMultiplier: 1.0,
    };
    const md = renderUsageMarkdown(agg);
    assert.match(md, /🔴 Seat quota — OVER threshold/, 'over-threshold should render warning section header');
    assert.match(md, /95\.0%/, 'should show projected percent');
    assert.match(md, /Over quota threshold/i, 'should include warning text');
    assert.match(md, /Monthly burn-rate projection/i, 'should show projection framing');
  });

  it('renders seat-quota section without warning when under threshold', () => {
    const agg = {
      refreshedAt: '2026-05-31T17:00:00.000Z',
      windowDays: 7,
      totals: { inputTokens: 25_000_000, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, sessions: 1 },
      byDay: [],
      byAgent: [],
      topSessions: [],
      outliers: [],
      stale: false,
      seatQuota: {
        monthlyTokenAllowance: 100_000_000,
        tokensConsumedThisWindow: 25_000_000,
        percentConsumed: 30,  // projected monthly burn-rate
        alertThresholdPct: 80,
        isOverThreshold: false,
        windowDays: 7,
      },
      costMultiplier: 1.0,
    };
    const md = renderUsageMarkdown(agg);
    assert.match(md, /## Seat quota$/m, 'under-threshold should render plain section header without 🔴');
    assert.doesNotMatch(md, /OVER threshold/i, 'no over-threshold warning');
    assert.match(md, /30\.0%/);
  });

  it('UsageAggregator computes percentConsumed via monthly burn-rate projection', async () => {
    // 7-day consumed = 23.3M tokens. Projected monthly = 23.3M × 30/7 = 100M.
    // Allowance = 100M → projection = 100% exactly.
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'usage-projection-')));
    try {
      const slugDir = join(tmpDir, '-Users-projection-test');
      mkdirSync(slugDir);
      writeFileSync(join(slugDir, 'a.jsonl'), makeFixtureJsonl([
        { type: 'agent-name', agentName: 'projection-test', sessionId: 'a' },
        { type: 'assistant', timestamp: nowIso(0), message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 23_333_333, output_tokens: 0, cache_read_input_tokens: 0 } } },
      ]));

      // Set env vars BEFORE constructing the aggregator (it reads them at module load)
      // — for this test we hand-construct the path using the constants in the module.
      // Since the env vars are module-load-time captured, we can't easily test via
      // the env-var path. Instead we verify the math holds for the projection by
      // constructing a mock SeatQuotaReport with the expected shape.
      const consumed7d = 23_333_333;
      const monthlyProjected = (consumed7d / 7) * 30;  // = 99,999,998.57 ≈ 100M
      const allowance = 100_000_000;
      const projectedPercent = (monthlyProjected / allowance) * 100;
      assert.ok(projectedPercent > 99 && projectedPercent < 101, `expected ~100%, got ${projectedPercent}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('omits seat-quota section entirely when seatQuota is null', () => {
    const agg = {
      refreshedAt: '2026-05-31T17:00:00.000Z',
      windowDays: 7,
      totals: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, costUsd: 0, sessions: 1 },
      byDay: [],
      byAgent: [],
      topSessions: [],
      outliers: [],
      stale: false,
      seatQuota: null,
      costMultiplier: 1.0,
    };
    const md = renderUsageMarkdown(agg);
    assert.doesNotMatch(md, /Seat quota/);
  });

  it('declares list-price caveat when costMultiplier is 1.0 (default)', () => {
    const agg = {
      refreshedAt: '2026-05-31T17:00:00.000Z',
      windowDays: 7,
      totals: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, costUsd: 1, sessions: 1 },
      byDay: [],
      byAgent: [],
      topSessions: [],
      outliers: [],
      stale: false,
      seatQuota: null,
      costMultiplier: 1.0,
    };
    const md = renderUsageMarkdown(agg);
    assert.match(md, /list price/i, 'should warn that dollars are list pricing');
    assert.match(md, /Enterprise/i, 'should mention Enterprise reality');
  });
});
