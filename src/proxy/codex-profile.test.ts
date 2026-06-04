import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  codexProfilePath,
  writeCodexProfile,
  removeCodexProfile,
  scrubLegacyProfileFromCentralConfig,
} from './codex-profile.ts';

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

  describe('scrubLegacyProfileFromCentralConfig', () => {
    it('should remove [profiles.<name>] block from central config', () => {
      const home = tmpCodexHome();
      try {
        const central = join(home, 'config.toml');
        writeFileSync(
          central,
          '[profiles.codex-drone]\ndeveloper_instructions = """\nold body\n"""\n',
          'utf-8',
        );
        scrubLegacyProfileFromCentralConfig('codex-drone', home);
        const after = readFileSync(central, 'utf-8');
        assert.ok(!after.includes('[profiles.codex-drone]'));
        assert.ok(!after.includes('old body'));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should remove top-level `profile = "<name>"` selector line', () => {
      const home = tmpCodexHome();
      try {
        const central = join(home, 'config.toml');
        writeFileSync(central, 'model = "gpt-5"\nprofile = "codex-drone"\nother = "keep"\n', 'utf-8');
        scrubLegacyProfileFromCentralConfig('codex-drone', home);
        const after = readFileSync(central, 'utf-8');
        assert.ok(!after.includes('profile = "codex-drone"'));
        assert.ok(after.includes('model = "gpt-5"'), 'unrelated top-level keys preserved');
        assert.ok(after.includes('other = "keep"'), 'unrelated top-level keys preserved');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should leave [profiles.<other>] blocks alone', () => {
      const home = tmpCodexHome();
      try {
        const central = join(home, 'config.toml');
        writeFileSync(
          central,
          '[profiles.codex-drone]\ndeveloper_instructions = """\ndrone\n"""\n\n' +
            '[profiles.codex-prev]\ndeveloper_instructions = """\nprev\n"""\n',
          'utf-8',
        );
        scrubLegacyProfileFromCentralConfig('codex-drone', home);
        const after = readFileSync(central, 'utf-8');
        assert.ok(!after.includes('[profiles.codex-drone]'), 'target block removed');
        assert.ok(after.includes('[profiles.codex-prev]'), 'sibling block preserved');
        assert.ok(after.includes('prev'), 'sibling body preserved');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should leave [mcp_servers] and other non-profile sections alone', () => {
      const home = tmpCodexHome();
      try {
        const central = join(home, 'config.toml');
        writeFileSync(
          central,
          '[profiles.codex-drone]\ndeveloper_instructions = """\ndrone\n"""\n\n' +
            '[mcp_servers]\n[mcp_servers.atlassian]\ncommand = "atlassian-mcp"\n',
          'utf-8',
        );
        scrubLegacyProfileFromCentralConfig('codex-drone', home);
        const after = readFileSync(central, 'utf-8');
        assert.ok(!after.includes('[profiles.codex-drone]'));
        assert.ok(after.includes('[mcp_servers]'));
        assert.ok(after.includes('[mcp_servers.atlassian]'));
        assert.ok(after.includes('atlassian-mcp'));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should be no-op when central config does not exist', () => {
      const home = tmpCodexHome();
      try {
        scrubLegacyProfileFromCentralConfig('codex-drone', home);
        assert.ok(!existsSync(join(home, 'config.toml')), 'no file created');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should be no-op when central config has no legacy entry for that name', () => {
      const home = tmpCodexHome();
      try {
        const central = join(home, 'config.toml');
        const original = '[mcp_servers]\ncommand = "x"\n';
        writeFileSync(central, original, 'utf-8');
        scrubLegacyProfileFromCentralConfig('codex-drone', home);
        const after = readFileSync(central, 'utf-8');
        assert.equal(after, original, 'file unchanged byte-for-byte');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should be idempotent (second scrub is no-op)', () => {
      const home = tmpCodexHome();
      try {
        const central = join(home, 'config.toml');
        writeFileSync(
          central,
          '[profiles.codex-drone]\ndeveloper_instructions = """\ndrone\n"""\n',
          'utf-8',
        );
        scrubLegacyProfileFromCentralConfig('codex-drone', home);
        const afterFirst = readFileSync(central, 'utf-8');
        scrubLegacyProfileFromCentralConfig('codex-drone', home);
        const afterSecond = readFileSync(central, 'utf-8');
        assert.equal(afterSecond, afterFirst);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('should reject invalid profile names', () => {
      assert.throws(
        () => scrubLegacyProfileFromCentralConfig('../etc/passwd'),
        /Invalid profile name/,
      );
    });
  });

  describe('writeCodexProfile integration with scrub', () => {
    it('should remove matching legacy block from central config after write', () => {
      const home = tmpCodexHome();
      try {
        const central = join(home, 'config.toml');
        writeFileSync(
          central,
          '[profiles.codex-drone]\ndeveloper_instructions = """\nOLD\n"""\n',
          'utf-8',
        );
        writeCodexProfile('codex-drone', 'NEW', home);
        const centralAfter = readFileSync(central, 'utf-8');
        assert.ok(!centralAfter.includes('[profiles.codex-drone]'), 'legacy block gone');
        assert.ok(!centralAfter.includes('OLD'), 'old body gone');
        const v2 = readFileSync(join(home, 'codex-drone.config.toml'), 'utf-8');
        assert.ok(v2.includes('NEW'), 'v2 file has new body');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe('removeCodexProfile integration with scrub', () => {
    it('should scrub legacy block even when v2 file does not exist', () => {
      const home = tmpCodexHome();
      try {
        const central = join(home, 'config.toml');
        writeFileSync(
          central,
          '[profiles.codex-drone]\ndeveloper_instructions = """\nold\n"""\n',
          'utf-8',
        );
        removeCodexProfile('codex-drone', home);
        const centralAfter = readFileSync(central, 'utf-8');
        assert.ok(!centralAfter.includes('[profiles.codex-drone]'));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
