import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsage, parseCodexStatus } from './usage-poller.ts';

describe('parseClaudeUsage', () => {
  it('parses typical /usage output with two buckets', () => {
    const output = [
      '  Current session',
      '  ████▌                                              9% used',
      '  Resets 12pm (America/Chicago)',
      '',
      '  Current week (all models)',
      '  ███████████                                        22% used',
      '  Resets Mar 13, 12am (America/Chicago)',
    ].join('\n');

    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 2);

    assert.equal(buckets[0]!.label, 'Current session');
    assert.equal(buckets[0]!.pctUsed, 9);
    assert.equal(buckets[0]!.resetsAt, '12pm (America/Chicago)');

    assert.equal(buckets[1]!.label, 'Current week (all models)');
    assert.equal(buckets[1]!.pctUsed, 22);
    assert.equal(buckets[1]!.resetsAt, 'Mar 13, 12am (America/Chicago)');
  });

  it('parses the v2.1.289 Usage tab, ignoring the contributors breakdown', () => {
    // Captured from a live pane 2026-10-06. The "% of your usage" lines below the
    // buckets are a breakdown, not limits, and must not become buckets.
    const output = [
      '   Plugin skill-listing footprint',
      '   stripe                      2 skills · ~59 tok/turn',
      '   Current session',
      '   ███████                                            14% used',
      '   Resets 11:20am (Europe/Dublin)',
      '   Current week (all models)',
      '   █▌                                                 3% used',
      '   Resets Oct 13 at 6am (Europe/Dublin)',
      '   Current week (Fable)',
      '                                                      0% used',
      '   Resets Oct 13 at 6am (Europe/Dublin)',
      "   What's contributing to your limits usage?",
      '   95% of your usage was at >150k context',
      '   56% of your usage was while 4+ sessions ran in parallel',
      '   Usage credits',
      '   ███████████████████████████████████████████        86% used',
      '   $559.92 / $650.00 spent · Resets Nov 1 (Europe/Dublin)',
    ].join('\n');

    const buckets = parseClaudeUsage(output);
    const week = buckets.find(b => b.label === 'Current week (all models)');
    assert.ok(week, JSON.stringify(buckets));
    assert.equal(week.pctUsed, 3);
    assert.equal(week.resetsAt, 'Oct 13 at 6am (Europe/Dublin)');
    assert.equal(buckets.find(b => b.label === 'Current session')?.pctUsed, 14);
    assert.ok(!buckets.some(b => b.pctUsed === 95 || b.pctUsed === 56), JSON.stringify(buckets));
  });

  it('parses three buckets including Sonnet-only', () => {
    const output = [
      '  Current session',
      '  ██                                                 4% used',
      '  Resets 6pm (America/Chicago)',
      '',
      '  Current week (all models)',
      '  ████████████████                                   32% used',
      '  Resets Mar 15, 12am (America/Chicago)',
      '',
      '  Current week (Sonnet only)',
      '  ███████                                            14% used',
      '  Resets Mar 15, 12am (America/Chicago)',
    ].join('\n');

    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 3);
    assert.equal(buckets[2]!.label, 'Current week (Sonnet only)');
    assert.equal(buckets[2]!.pctUsed, 14);
  });

  it('returns empty array for no usage data', () => {
    const buckets = parseClaudeUsage('some random output\nno usage here');
    assert.equal(buckets.length, 0);
  });

  it('handles missing reset info', () => {
    const output = '  Session\n  ████████████████████  50% used\n';
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.pctUsed, 50);
    assert.equal(buckets[0]!.resetsAt, '');
  });

  it('skips progress bar lines when finding label', () => {
    const output = [
      '  My label',
      '  ████████████████████████████████████████████',
      '  75% used',
      '  Resets tomorrow',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets[0]!.label, 'My label');
    assert.equal(buckets[0]!.pctUsed, 75);
  });

  it('ignores "NN% used" without adjacent progress bar (false positive)', () => {
    const output = [
      '  Claude adapter: parseContextPercent reports %',
      '  used directly: 19% used',
      '  some other text',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 0);
  });

  it('ignores stray "NN% used" in conversation text', () => {
    const output = [
      '  The API shows 45% used this month',
      '  We need to reduce usage',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 0);
  });

  it('filters out paths and bare timezones as labels', () => {
    const output = [
      '  /tmp',
      '  ████▌                                              5% used',
      '  Resets 12pm',
      '  (America/Chicago)',
      '',
      '  Current week (all models)',
      '  ██████████████████████████                         102% used',
      '  Resets May 1 (America/Chicago)',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    // Should only capture "Current week (all models)", not "/tmp" or "(America/Chicago)"
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.label, 'Current week (all models)');
    assert.equal(buckets[0]!.pctUsed, 102);
  });

  it('parses v2.1.118+ inline format (no labels, just reset times)', () => {
    const output = [
      '  Resets 2pm (America/Chicago)████████████████████   96% used',
      '',
      '  Resets 5pm (America/Chicago)                       0% used',
      '',
      '  $203.22 / $200.00 spent · Resets May 1 (America/Chicago)',
    ].join('\n');
    const buckets = parseClaudeUsage(output);
    assert.equal(buckets.length, 3);

    assert.equal(buckets[0]!.label, 'Resets 2pm');
    assert.equal(buckets[0]!.pctUsed, 96);
    assert.equal(buckets[0]!.resetsAt, '2pm (America/Chicago)');

    assert.equal(buckets[1]!.label, 'Resets 5pm');
    assert.equal(buckets[1]!.pctUsed, 0);

    assert.equal(buckets[2]!.label, 'Extra usage');
    assert.equal(buckets[2]!.pctUsed, 102); // 203.22/200 = 101.6%
    assert.equal(buckets[2]!.resetsAt, 'May 1 (America/Chicago)');
  });
});

describe('parseCodexStatus', () => {
  it('parses real codex /status output', () => {
    const output = [
      '╭─────────────────────────────────────────────────────────────────────────────────╮',
      '│  >_ OpenAI Codex (v0.111.0)                                                     │',
      '│                                                                                 │',
      '│  Model:                gpt-5.4 (reasoning xhigh, summaries auto)                │',
      '│  Account:              user@example.com (Plus)                                    │',
      '│                                                                                 │',
      '│  5h limit:             [████████████████░░░░] 80% left (resets 12:19)           │',
      '│  Weekly limit:         [█████░░░░░░░░░░░░░░░] 26% left (resets 01:44 on 13 Mar) │',
      '╰─────────────────────────────────────────────────────────────────────────────────╯',
    ].join('\n');
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0]!.label, '5h limit');
    assert.equal(buckets[0]!.pctUsed, 20); // 100 - 80
    assert.equal(buckets[0]!.resetsAt, '12:19');
    assert.equal(buckets[1]!.label, 'Weekly limit');
    assert.equal(buckets[1]!.pctUsed, 74); // 100 - 26
    assert.equal(buckets[1]!.resetsAt, '01:44 on 13 Mar');
  });

  it('parses "NN% used" format', () => {
    const output = '│  Daily limit:  [████] 45% used (resets tomorrow) │';
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.label, 'Daily limit');
    assert.equal(buckets[0]!.pctUsed, 45);
    assert.equal(buckets[0]!.resetsAt, 'tomorrow');
  });

  it('ignores non-limit lines (model, account, prompts)', () => {
    const output = [
      '│  Model:                gpt-5.4 (reasoning xhigh)                │',
      '│  Account:              test@test.io (Plus)                      │',
      '› Implement {feature}',
      '  83% context left',
    ].join('\n');
    const buckets = parseCodexStatus(output);
    assert.equal(buckets.length, 0);
  });

  it('returns empty for no usage data', () => {
    const buckets = parseCodexStatus('no status info here');
    assert.equal(buckets.length, 0);
  });
});
