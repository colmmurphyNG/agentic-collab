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
