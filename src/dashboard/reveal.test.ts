import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { revealStart } from './reveal.ts';

const thread = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i }));

describe('revealStart', () => {
  it('should extend rendering back to an older message, with context above it', () => {
    assert.equal(revealStart(thread, 70, 1010), 5);
  });

  it('should clamp at the start of the thread', () => {
    assert.equal(revealStart(thread, 70, 1002), 0);
  });

  it('should leave the window alone when the message is already rendered', () => {
    assert.equal(revealStart(thread, 70, 1085), 70);
    assert.equal(revealStart(thread, 70, 1070), 70);
  });

  it('should report a message that is not in the thread', () => {
    assert.equal(revealStart(thread, 70, 42), -1);
    assert.equal(revealStart([], 0, 1000), -1);
  });
});
