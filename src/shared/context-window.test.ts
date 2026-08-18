import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseContextWindow, DEFAULT_CONTEXT_WINDOW_TOKENS } from './context-window.ts';

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

  test('should fall back to the default when no window is declared', () => {
    const pane = '  ~/dev/conductor  Opus 5  ctx: 12% used';
    assert.equal(parseContextWindow(pane), DEFAULT_CONTEXT_WINDOW_TOKENS);
    assert.equal(parseContextWindow(''), DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  test('should fall back when the declared value is zero or unparseable', () => {
    assert.equal(parseContextWindow('(0M context)'), DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  test('should not treat a token count as a window declaration', () => {
    assert.equal(parseContextWindow('· Pontificating… (2m 14s · ↓ 4.0k tokens)'), DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});
