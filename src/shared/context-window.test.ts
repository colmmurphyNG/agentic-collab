import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseContextWindow } from './context-window.ts';

describe('parseContextWindow', () => {
  test('should read a 1M window from the Claude Code status banner', () => {
    const pane = '  ~/dev/SFCC-webapp/retail-react-app  Opus 5 (1M context)  ctx: 81% used';
    assert.equal(parseContextWindow(pane), 1_000_000);
  });

  test('should read a k-suffixed window', () => {
    assert.equal(parseContextWindow('Sonnet 5 (200k context)  ctx: 40% used'), 200_000);
  });

  test('should read a fractional M window', () => {
    assert.equal(parseContextWindow('Model (1.5M context)'), 1_500_000);
  });

  test('should accept a declaration without parentheses', () => {
    assert.equal(parseContextWindow('running with 1M context enabled'), 1_000_000);
  });

  test('should be case-insensitive on the unit suffix', () => {
    assert.equal(parseContextWindow('(1m context)'), 1_000_000);
    assert.equal(parseContextWindow('(128K context)'), 128_000);
  });

  test('should return null when neither a window nor a known model is present', () => {
    // Deliberately not a default. Guessing small over-reports occupancy and
    // would recycle a healthy agent; null means no reading, so no recycle.
    assert.equal(parseContextWindow('  ~/dev/conductor  SomeFutureModel  ctx: 12% used'), null);
    assert.equal(parseContextWindow(''), null);
  });

  test('should return null when the declared value is zero or unparseable', () => {
    assert.equal(parseContextWindow('(0M context)'), null);
  });

  test('should not treat a token count as a window declaration', () => {
    assert.equal(parseContextWindow('· Pontificating… (2m 14s · ↓ 4.0k tokens)'), null);
  });
});

describe('parseContextWindow — model-name source', () => {
  test('should derive 1M for an Opus 5 banner that omits the declaration', () => {
    // Measured 2026-08-18: tl and pwa both print a bare "Opus 5" yet run a 1M
    // window (943,749 tokens at 94%; 417,941 at 42%). Falling back to 200k here
    // would reintroduce the 5x error this module exists to remove.
    assert.equal(parseContextWindow('  ~/dev  Opus 5  ctx: 94% used'), 1_000_000);
    assert.equal(parseContextWindow('  ~/dev/SFCC-webapp  Opus 5  ctx: 42% used'), 1_000_000);
  });

  test('should prefer an explicit declaration over the model-name mapping', () => {
    assert.equal(parseContextWindow('Opus 5 (200k context)  ctx: 30% used'), 200_000);
  });

  test('should agree with the model mapping when both sources are present', () => {
    assert.equal(parseContextWindow('Opus 5 (1M context)  ctx: 81% used'), 1_000_000);
  });

  test('should be case-insensitive on the model name', () => {
    assert.equal(parseContextWindow('opus 5  ctx: 10% used'), 1_000_000);
    assert.equal(parseContextWindow('OPUS5  ctx: 10% used'), 1_000_000);
  });

  test('should return null for an unmeasured model rather than guessing', () => {
    // Haiku's window has not been measured here. Unmonitored is the correct
    // outcome for an unmeasured model; mis-monitored is not.
    assert.equal(parseContextWindow('  ~/dev  Haiku  ctx: 73% used'), null);
  });
});
