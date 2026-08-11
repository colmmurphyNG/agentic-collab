import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSessionTranscript } from './session-transcript.ts';

describe('findSessionTranscript', () => {
  let projectsDir: string;
  const liveId = '11111111-2222-3333-4444-555555555555';
  const deadId = '99999999-8888-7777-6666-555555555555';

  before(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
    mkdirSync(join(projectsDir, '-Users-someone-dev-projA'));
    mkdirSync(join(projectsDir, '-Users-someone-dev-projB'));
    writeFileSync(join(projectsDir, '-Users-someone-dev-projB', `${liveId}.jsonl`), '{}\n');
    writeFileSync(join(projectsDir, 'loose-file.jsonl'), '{}\n');
  });

  after(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('should find a transcript in any project subdirectory', () => {
    assert.equal(findSessionTranscript(liveId, projectsDir), 'present');
  });

  it('should report absent when no project directory holds the transcript', () => {
    assert.equal(findSessionTranscript(deadId, projectsDir), 'absent');
  });

  it('should report unknown when no projects dir is configured', () => {
    // The distinction that matters: callers treat 'unknown' as "do not act",
    // so an unmounted deployment must never look like a missing transcript.
    assert.equal(findSessionTranscript(liveId, undefined), 'unknown');
  });

  it('should report unknown when the projects dir does not exist', () => {
    assert.equal(findSessionTranscript(liveId, join(projectsDir, 'no-such-dir')), 'unknown');
  });

  it('should report unknown for a non-UUID session id rather than absent', () => {
    for (const bad of ['', 'not-a-uuid', '../../etc/passwd', 'null']) {
      assert.equal(findSessionTranscript(bad, projectsDir), 'unknown', `input "${bad}"`);
    }
  });

  it('should report unknown for a null or undefined session id', () => {
    assert.equal(findSessionTranscript(null, projectsDir), 'unknown');
    assert.equal(findSessionTranscript(undefined, projectsDir), 'unknown');
  });
});
