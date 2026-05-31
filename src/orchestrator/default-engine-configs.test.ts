import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ENGINE_CONFIGS } from './default-engine-configs.ts';

describe('DEFAULT_ENGINE_CONFIGS.claude detection patterns', () => {
  const claude = DEFAULT_ENGINE_CONFIGS.find(c => c.name === 'claude');

  it('has a claude config', () => {
    assert.ok(claude, 'claude default config should be present');
  });

  it('keeps `local agents?` as an active signal — sub-agents in flight = active', () => {
    const detection = JSON.parse(claude!.detection);
    const patterns: Array<string | { pattern: string; lines?: number }> = detection.activePatterns;
    const found = patterns.some(p => {
      const raw = typeof p === 'string' ? p : p.pattern;
      return raw.includes('local agents?');
    });
    assert.equal(found, true, '`local agents?` must remain in activePatterns');
  });

  it('drops `shells?` from active signals — bg shells outlive agent interest', () => {
    const detection = JSON.parse(claude!.detection);
    const patterns: Array<string | { pattern: string; lines?: number }> = detection.activePatterns;
    const found = patterns.some(p => {
      const raw = typeof p === 'string' ? p : p.pattern;
      return raw.includes('shells?');
    });
    assert.equal(found, false, '`shells?` activePattern caused permanent false-active when bg shells outlive agent polling — must not be an active signal');
  });

  it('drops `background tasks?` from active signals — same rationale as shells', () => {
    const detection = JSON.parse(claude!.detection);
    const patterns: Array<string | { pattern: string; lines?: number }> = detection.activePatterns;
    const found = patterns.some(p => {
      const raw = typeof p === 'string' ? p : p.pattern;
      return raw.includes('background tasks?');
    });
    assert.equal(found, false, '`background tasks?` activePattern caused permanent false-active when bg tasks outlive agent polling — must not be an active signal');
  });

  it('keeps the braille spinner active signal — actively-thinking case', () => {
    const detection = JSON.parse(claude!.detection);
    const patterns: Array<string | { pattern: string; lines?: number }> = detection.activePatterns;
    const found = patterns.some(p => {
      const raw = typeof p === 'string' ? p : p.pattern;
      return raw.includes('\\u280b') || raw.includes('⠋');
    });
    assert.equal(found, true, 'braille spinner pattern is the legitimate actively-thinking signal');
  });

  it('keeps tool-execution active signal — Read/Write/Edit/Bash/etc.', () => {
    const detection = JSON.parse(claude!.detection);
    const patterns: Array<string | { pattern: string; lines?: number }> = detection.activePatterns;
    const found = patterns.some(p => {
      const raw = typeof p === 'string' ? p : p.pattern;
      return raw.includes('Read|Write|Edit|Bash');
    });
    assert.equal(found, true, 'tool-execution pattern must remain an active signal');
  });

  it('still exposes shell + background-task counts as info-only indicators', () => {
    const indicators = JSON.parse(claude!.indicators);
    const ids = indicators.map((i: { id: string }) => i.id);
    assert.ok(ids.includes('bg-shells'), 'bg-shells indicator must remain for operator visibility');
    assert.ok(ids.includes('bg-tasks'), 'bg-tasks indicator must remain for operator visibility');
    assert.ok(ids.includes('local-agents'), 'local-agents indicator must remain for operator visibility');
  });
});

describe('CLAUDE_ACTIVITY_INDICATOR catches the spinner-line activity context (NN)', () => {
  const claude = DEFAULT_ENGINE_CONFIGS.find(c => c.name === 'claude');
  const indicators = JSON.parse(claude!.indicators);
  const activity = indicators.find((i: { id: string }) => i.id === 'activity');
  const re = new RegExp(activity.regex);

  it('matches the Watching X for N… (Ys) spinner shape', () => {
    const sample = '✶ Watching PHX-2472 PR #1395 Sonar fix + CI… (10m 20s · ↓ 9.0k tokens)';
    const m = sample.match(re);
    assert.ok(m, 'should match the Watching spinner line');
    assert.equal(m![1], 'Watching');
    assert.match(m![2], /10m\s+20s/);
  });

  it('matches the past-tense Brewed/Baked/Cogitated/Crunched shapes', () => {
    assert.match('✻ Brewed for 13s · 2 shells, 1 monitor still running', re);
    assert.match('✻ Baked for 3s · 2 shells still running', re);
    assert.match('✻ Cogitated for 3s · 1 shell still running', re);
    assert.match('✻ Crunched for 1m 33s · 2 shells still running', re);
  });

  it('matches the ongoing Nucleating/Warping/Improvising shapes', () => {
    assert.match('✢ Warping… (13s · ↓ 555 tokens)', re);
    assert.match('✶ Improvising… (1m 33s · ↓ 3.3k tokens · thought for 4s)', re);
  });

  it('does not falsely match prose mentions of the spinner verbs', () => {
    assert.doesNotMatch('We are watching PHX-2472 closely.', re);
    assert.doesNotMatch('I brewed coffee for 13 seconds before commit.', re);
    assert.doesNotMatch('The cogitated decision was made on 2026-05-30.', re);
  });

  it('is style=info so it does not trigger the indicator-bridge Messages spam', () => {
    assert.equal(activity.style, 'info');
  });

  it('has lines:10 constraint so stale scrollback spinner text does not falsely persist', () => {
    // Without the lines constraint, the indicator regex evaluates against the
    // full pane snapshot. Stale spinner-line text stays in scrollback for hours
    // after an agent goes idle, producing false-persistent badges on idle cards
    // (observed 2026-05-31). lines: 10 confines evaluation to the footer area
    // where the live spinner renders.
    assert.equal(activity.lines, 10);
  });
});

describe('CLAUDE_QUEUED_INPUT_INDICATOR catches stacked-inbound state (NN)', () => {
  const claude = DEFAULT_ENGINE_CONFIGS.find(c => c.name === 'claude');
  const indicators = JSON.parse(claude!.indicators);
  const qi = indicators.find((i: { id: string }) => i.id === 'queued-input');
  const re = new RegExp(qi.regex);

  it('matches the queued-messages footer that appears when inbounds stack behind a busy task', () => {
    assert.match('❯ Press up to edit queued messages', re);
    assert.match('  ❯ Press up to edit queued messages', re);
    assert.match('text above\n❯ Press up to edit queued messages\nmore below', re);
  });

  it('does not falsely match prose mentions', () => {
    assert.doesNotMatch('Operator may need to edit queued messages later.', re);
    assert.doesNotMatch('"❯ Press up to edit queued messages" — explaining the footer', re);
  });

  it('is style=warning so it bridges to the Messages thread for operator visibility', () => {
    assert.equal(qi.style, 'warning');
  });

  it('has lines:10 constraint so historical queued-input footers do not falsely persist', () => {
    assert.equal(qi.lines, 10);
  });
});

describe('CLAUDE_APPROVAL_INDICATOR regex covers all three prompt shapes', () => {
  const claude = DEFAULT_ENGINE_CONFIGS.find(c => c.name === 'claude');
  const indicators = JSON.parse(claude!.indicators);
  const approval = indicators.find((i: { id: string }) => i.id === 'approval');
  const re = new RegExp(approval.regex);

  it('matches the older Yes / No / Always allow yes-no prompt', () => {
    assert.match('Yes / No / Always allow', re);
    assert.match('Yes/No/Always allow', re);
  });

  it("matches the newer 2.1.142+ 'Do you want to proceed?' confirmation prompt", () => {
    assert.match('Do you want to proceed?', re);
    assert.match('  Do you want to proceed?  ', re);
  });

  it('matches the AskUserQuestion footer (the gap that caused pwa-2391 PHX-2472 to go silent)', () => {
    assert.match('Enter to select · ↑/↓ to navigate · Esc to cancel', re);
    assert.match('Enter to select - up/down to navigate - Esc to cancel', re);
  });

  it('does not falsely match unrelated pane content', () => {
    assert.doesNotMatch('Hello world', re);
    assert.doesNotMatch('Reading file /tmp/foo.txt', re);
    assert.doesNotMatch('Bash command completed', re);
  });
});
