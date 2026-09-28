import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureFocus, restoreDrafts } from './decision-drafts.ts';

function box(id) {
  return {
    dataset: { id },
    value: '',
    focused: false,
    selection: null,
    focus() { this.focused = true; },
    setSelectionRange(a, b) { this.selection = [a, b]; },
  };
}

describe('decision drafts', () => {
  it('captures the focused reply box and its caret, and ignores anything else', () => {
    const b = { ...box('3'), selectionStart: 4, selectionEnd: 9 };
    assert.deepEqual(captureFocus(b, () => true), { id: '3', start: 4, end: 9 });
    assert.equal(captureFocus(b, () => false), null);
    assert.equal(captureFocus(null, () => true), null);
  });

  it('puts drafts back after a re-render and restores focus and caret', () => {
    const drafts = new Map([['3', 'half-typed reply']]);
    const three = box('3'), four = box('4');
    restoreDrafts([four, three], drafts, new Set(['3', '4']), { id: '3', start: 4, end: 4 });
    assert.equal(three.value, 'half-typed reply');
    assert.equal(four.value, '');
    assert.ok(three.focused && !four.focused);
    assert.deepEqual(three.selection, [4, 4]);
  });

  it('drops drafts for decisions that are no longer open', () => {
    const drafts = new Map([['3', 'old'], ['4', 'keep']]);
    restoreDrafts([box('4')], drafts, new Set(['4']), null);
    assert.deepEqual([...drafts.keys()], ['4']);
  });
});
