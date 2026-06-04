import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { codexProfilePath, writeCodexProfile, removeCodexProfile } from './codex-profile.ts';

function tmpCodexHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'codex-profile-test-')));
}

describe('proxy/codex-profile', () => {
  describe('codexProfilePath', () => {
    it('should build $CODEX_HOME/<name>.config.toml', () => {
      const home = '/fake/codex';
      assert.equal(codexProfilePath('drone', home), '/fake/codex/drone.config.toml');
    });
  });

  describe('writeCodexProfile', () => {
    it('should write developer_instructions only — no [profiles.X] header', () => {
      const home = tmpCodexHome();
      try {
        writeCodexProfile('codex-drone', 'hello world', home);
        const body = readFileSync(join(home, 'codex-drone.config.toml'), 'utf-8');
        assert.match(body, /^developer_instructions = """\nhello world\n"""\n$/);
        assert.ok(!body.includes('[profiles.'), 'file IS the profile — no header');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should preserve backticks, $, !, and embedded single/double quotes', () => {
      const home = tmpCodexHome();
      try {
        const instructions = 'code: `echo "$FOO"` and !alert and \'single\'';
        writeCodexProfile('codex-drone', instructions, home);
        const body = readFileSync(join(home, 'codex-drone.config.toml'), 'utf-8');
        assert.ok(body.includes(instructions), 'instructions survive unescaped');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should encode embedded """ as the unicode escape to keep TOML parseable', () => {
      const home = tmpCodexHome();
      try {
        const instructions = 'say """quote""" here';
        writeCodexProfile('codex-drone', instructions, home);
        const body = readFileSync(join(home, 'codex-drone.config.toml'), 'utf-8');
        const triplets = (body.match(/"""/g) ?? []).length;
        assert.equal(triplets, 2, 'only the two TOML delimiters remain after encoding');
        assert.ok(body.includes('\\u0022'), 'embedded """ encoded as \\u0022');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should overwrite an existing profile file', () => {
      const home = tmpCodexHome();
      try {
        writeCodexProfile('codex-drone', 'first', home);
        writeCodexProfile('codex-drone', 'second', home);
        const body = readFileSync(join(home, 'codex-drone.config.toml'), 'utf-8');
        assert.ok(body.includes('second'));
        assert.ok(!body.includes('first'));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should create the codex home dir if missing', () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), 'codex-profile-test-')));
      const home = join(parent, 'nested', 'codex');
      try {
        writeCodexProfile('codex-drone', 'hi', home);
        assert.ok(existsSync(join(home, 'codex-drone.config.toml')));
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it('should reject invalid profile names', () => {
      assert.throws(
        () => writeCodexProfile('../etc/passwd', 'x'),
        /Invalid profile name/,
      );
      assert.throws(
        () => writeCodexProfile('with space', 'x'),
        /Invalid profile name/,
      );
    });
  });

  describe('removeCodexProfile', () => {
    it('should delete an existing profile file', () => {
      const home = tmpCodexHome();
      try {
        writeCodexProfile('codex-drone', 'hi', home);
        assert.ok(existsSync(join(home, 'codex-drone.config.toml')));
        removeCodexProfile('codex-drone', home);
        assert.ok(!existsSync(join(home, 'codex-drone.config.toml')));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should be idempotent when the profile does not exist', () => {
      const home = tmpCodexHome();
      try {
        removeCodexProfile('nonexistent', home);
        assert.ok(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should reject invalid profile names', () => {
      assert.throws(
        () => removeCodexProfile('../etc/passwd'),
        /Invalid profile name/,
      );
    });
  });
});
