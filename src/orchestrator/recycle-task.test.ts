import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecycleTask } from './lifecycle.ts';

describe('buildRecycleTask', () => {
  it('points at the real handoff folder for the agent cwd', () => {
    const task = buildRecycleTask('pwa', '/Users/x/dev/SFCC-webapp');
    assert.match(task, /~\/\.claude\/projects\/-Users-x-dev-SFCC-webapp\/memory/);
    assert.match(task, /handoff_pwa_\*\.md/);
  });

  it('no longer tells the agent to look for MEMORY.md pointers', () => {
    assert.doesNotMatch(buildRecycleTask('pwa', '/Users/x/dev'), /MEMORY\.md/);
  });

  it('tells the agent to read the ticket state file', () => {
    assert.match(buildRecycleTask('tl', '/Users/x/dev'), /scratch\/tickets\/phx-XXXX\.md/);
  });

  it('falls back to a generic folder when cwd is not absolute', () => {
    const task = buildRecycleTask('tl', 'relative/dir');
    assert.match(task, /your project's memory folder/);
    assert.doesNotMatch(task, /undefined|null/);
  });
});
