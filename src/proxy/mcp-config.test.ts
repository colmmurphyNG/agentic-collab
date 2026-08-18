import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { buildAgentMcpConfig, extractPluginMcpServers, materialiseMcpConfig } from './mcp-config.ts';

function tmpDir(): string {
  // macOS `/var/folders/...` is a symlink to `/private/var/folders/...`. Resolve
  // so prefix-checks elsewhere in the code don't trip.
  return realpathSync(mkdtempSync(join(tmpdir(), 'mcp-config-test-')));
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf-8');
}

/**
 * Lay out a plugin root the way Claude Code does: an `installed_plugins.json`
 * registry pointing at per-plugin install dirs that each carry a `.mcp.json`.
 */
function writePluginRoot(
  root: string,
  plugins: { key: string; scope?: string; projectPath?: string; servers: Record<string, unknown> }[],
): string {
  const registry: Record<string, unknown[]> = {};
  for (const [i, plugin] of plugins.entries()) {
    const installPath = join(root, 'cache', `install-${i}`);
    writeJson(join(installPath, '.mcp.json'), { mcpServers: plugin.servers });
    const record: Record<string, unknown> = { scope: plugin.scope ?? 'user', installPath };
    if (plugin.projectPath !== undefined) record['projectPath'] = plugin.projectPath;
    (registry[plugin.key] ??= []).push(record);
  }
  writeJson(join(root, 'installed_plugins.json'), { version: 2, plugins: registry });
  return root;
}

describe('proxy/mcp-config', () => {
  describe('buildAgentMcpConfig', () => {
    it('filters global mcpServers to the allowlist', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, {
          mcpServers: {
            atlassian: { command: 'atlassian-mcp' },
            datadog: { command: 'datadog-mcp' },
            playwright: { command: 'playwright-mcp' },
          },
        });

        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });

        const { servers, missing } = buildAgentMcpConfig({
          allowlist: ['atlassian', 'datadog'],
          cwd,
          globalConfigPath: globalPath,
        });

        assert.deepEqual(Object.keys(servers).sort(), ['atlassian', 'datadog']);
        assert.deepEqual(missing, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reports missing allowlist entries without throwing', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: { atlassian: { command: 'a' } } });

        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });

        const { servers, missing } = buildAgentMcpConfig({
          allowlist: ['atlassian', 'datadog'],
          cwd,
          globalConfigPath: globalPath,
        });

        assert.deepEqual(Object.keys(servers), ['atlassian']);
        assert.deepEqual(missing, ['datadog']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('merges per-cwd .claude/settings.json mcpServers (cwd wins on collision)', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, {
          mcpServers: { atlassian: { command: 'global-atlassian' } },
        });
        const cwd = join(dir, 'project');
        writeJson(join(cwd, '.claude', 'settings.json'), {
          mcpServers: {
            atlassian: { command: 'cwd-atlassian-override' },
            'sfcc-dev': { command: 'cwd-sfcc' },
          },
        });

        const { servers } = buildAgentMcpConfig({
          allowlist: ['atlassian', 'sfcc-dev'],
          cwd,
          globalConfigPath: globalPath,
        });

        assert.equal((servers['atlassian'] as { command: string }).command, 'cwd-atlassian-override');
        assert.equal((servers['sfcc-dev'] as { command: string }).command, 'cwd-sfcc');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('treats missing global config as no entries (does not throw)', () => {
      const dir = tmpDir();
      try {
        const { servers, missing } = buildAgentMcpConfig({
          allowlist: ['atlassian'],
          cwd: dir,
          globalConfigPath: join(dir, 'does-not-exist.json'),
        });
        assert.deepEqual(servers, {});
        assert.deepEqual(missing, ['atlassian']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads per-project mcpServers from ~/.claude.json projects[<cwd>] map', () => {
      const dir = tmpDir();
      try {
        const cwd = join(dir, 'my-project');
        mkdirSync(cwd, { recursive: true });
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, {
          mcpServers: { atlassian: { command: 'global-atlassian' } },
          projects: {
            [cwd]: {
              mcpServers: {
                'sfcc-dev': { command: 'sfcc-mcp' },
                github: { command: 'github-mcp' },
              },
            },
          },
        });

        const { servers, missing } = buildAgentMcpConfig({
          allowlist: ['atlassian', 'sfcc-dev', 'github'],
          cwd,
          globalConfigPath: globalPath,
        });

        assert.deepEqual(Object.keys(servers).sort(), ['atlassian', 'github', 'sfcc-dev']);
        assert.deepEqual(missing, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads cwd/.mcp.json mcpServers (Claude Code project-root standard)', () => {
      const dir = tmpDir();
      try {
        const cwd = join(dir, 'my-project');
        mkdirSync(cwd, { recursive: true });
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: { foo: { command: 'foo-mcp' } },
        });
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: {} });

        const { servers } = buildAgentMcpConfig({
          allowlist: ['foo'],
          cwd,
          globalConfigPath: globalPath,
        });

        assert.equal((servers['foo'] as { command: string }).command, 'foo-mcp');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('cwd/.mcp.json overrides per-project map which overrides global on name collision', () => {
      const dir = tmpDir();
      try {
        const cwd = join(dir, 'my-project');
        mkdirSync(cwd, { recursive: true });
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, {
          mcpServers: { atlassian: { command: 'GLOBAL' } },
          projects: {
            [cwd]: { mcpServers: { atlassian: { command: 'PROJECT-SCOPED' } } },
          },
        });
        writeJson(join(cwd, '.claude', 'settings.json'), {
          mcpServers: { atlassian: { command: 'CWD-SETTINGS' } },
        });
        writeJson(join(cwd, '.mcp.json'), {
          mcpServers: { atlassian: { command: 'CWD-MCP-JSON' } },
        });

        const { servers } = buildAgentMcpConfig({
          allowlist: ['atlassian'],
          cwd,
          globalConfigPath: globalPath,
        });

        // Most-specific source wins.
        assert.equal((servers['atlassian'] as { command: string }).command, 'CWD-MCP-JSON');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('materialiseMcpConfig', () => {
    it('writes a strict-subset JSON file and returns its path', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, {
          mcpServers: {
            atlassian: { command: 'atlassian-mcp', args: ['--port', '7777'] },
            datadog: { command: 'datadog-mcp' },
            chrome: { command: 'chrome-mcp' },
          },
        });
        const outputDir = join(dir, 'mcp-configs');
        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });

        const { path, missing } = materialiseMcpConfig({
          agentName: 'pwa-test',
          allowlist: ['chrome', 'atlassian'],
          cwd,
          outputDir,
          globalConfigPath: globalPath,
        });

        assert.ok(path);
        assert.equal(path, join(outputDir, 'pwa-test.json'));
        assert.deepEqual(missing, []);
        assert.ok(existsSync(path!));

        const written = JSON.parse(readFileSync(path!, 'utf-8'));
        assert.ok(written.mcpServers);
        assert.deepEqual(Object.keys(written.mcpServers).sort(), ['atlassian', 'chrome']);
        assert.equal(written.mcpServers.atlassian.command, 'atlassian-mcp');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writes an empty mcpServers object when allowlist is empty (CC3 explicit-zero)', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: { atlassian: { command: 'a' } } });

        const { path, missing } = materialiseMcpConfig({
          agentName: 'silent-agent',
          allowlist: [],
          cwd: dir,
          outputDir: join(dir, 'out'),
          globalConfigPath: globalPath,
        });

        assert.ok(path);
        assert.deepEqual(missing, []);
        const written = JSON.parse(readFileSync(path!, 'utf-8'));
        assert.deepEqual(written, { mcpServers: {} });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('creates the output directory if it does not exist', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: { atlassian: { command: 'a' } } });
        const outputDir = join(dir, 'nested', 'mcp-configs');

        assert.equal(existsSync(outputDir), false);

        const { path } = materialiseMcpConfig({
          agentName: 'fresh-tree',
          allowlist: ['atlassian'],
          cwd: dir,
          outputDir,
          globalConfigPath: globalPath,
        });

        assert.ok(path);
        assert.equal(existsSync(outputDir), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  describe('plugin-declared mcpServers', () => {
    it('should resolve a plugin server named bare in the allowlist', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: { atlassian: { command: 'a' } } });
        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });
        const pluginsDir = writePluginRoot(join(dir, 'plugins'), [
          { key: 'netgear-ned@netgear', servers: { ned: { type: 'http', url: 'https://ned.example/mcp' } } },
        ]);

        const { servers, missing } = buildAgentMcpConfig({
          allowlist: ['atlassian', 'ned'],
          cwd,
          globalConfigPath: globalPath,
          pluginsDir,
        });

        assert.deepEqual(Object.keys(servers).sort(), ['atlassian', 'ned']);
        assert.deepEqual(servers['ned'], { type: 'http', url: 'https://ned.example/mcp' });
        assert.deepEqual(missing, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should resolve the qualified plugin label and materialise it under the bare name', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: {} });
        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });
        const pluginsDir = writePluginRoot(join(dir, 'plugins'), [
          { key: 'netgear-ned@netgear', servers: { ned: { type: 'http', url: 'https://ned.example/mcp' } } },
        ]);

        const { servers, missing } = buildAgentMcpConfig({
          allowlist: ['plugin:netgear-ned:ned'],
          cwd,
          globalConfigPath: globalPath,
          pluginsDir,
        });

        // Keyed bare — a colon-bearing label is a display string, not a server key.
        assert.deepEqual(Object.keys(servers), ['ned']);
        assert.deepEqual(missing, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should let an operator config entry override a plugin server of the same name', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: { ned: { type: 'http', url: 'https://override.example/mcp' } } });
        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });
        const pluginsDir = writePluginRoot(join(dir, 'plugins'), [
          { key: 'netgear-ned@netgear', servers: { ned: { type: 'http', url: 'https://plugin.example/mcp' } } },
        ]);

        const bare = buildAgentMcpConfig({
          allowlist: ['ned'], cwd, globalConfigPath: globalPath, pluginsDir,
        });
        assert.deepEqual(bare.servers['ned'], { type: 'http', url: 'https://override.example/mcp' });

        // The qualified spelling still means "the server this plugin ships".
        const qualified = buildAgentMcpConfig({
          allowlist: ['plugin:netgear-ned:ned'], cwd, globalConfigPath: globalPath, pluginsDir,
        });
        assert.deepEqual(qualified.servers['ned'], { type: 'http', url: 'https://plugin.example/mcp' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should apply a project-scope plugin only to an agent in that project', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: {} });
        const mine = join(dir, 'mine');
        const theirs = join(dir, 'theirs');
        mkdirSync(mine, { recursive: true });
        mkdirSync(theirs, { recursive: true });
        const pluginsDir = writePluginRoot(join(dir, 'plugins'), [
          { key: 'scoped@mkt', scope: 'project', projectPath: mine, servers: { scoped: { command: 's' } } },
        ]);

        const inProject = buildAgentMcpConfig({
          allowlist: ['scoped'], cwd: mine, globalConfigPath: globalPath, pluginsDir,
        });
        assert.deepEqual(Object.keys(inProject.servers), ['scoped']);

        const elsewhere = buildAgentMcpConfig({
          allowlist: ['scoped'], cwd: theirs, globalConfigPath: globalPath, pluginsDir,
        });
        assert.deepEqual(Object.keys(elsewhere.servers), []);
        assert.deepEqual(elsewhere.missing, ['scoped']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should still report an unknown plugin label as missing rather than throwing', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: {} });
        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });
        const pluginsDir = writePluginRoot(join(dir, 'plugins'), [
          { key: 'netgear-ned@netgear', servers: { ned: { command: 'n' } } },
        ]);

        const { servers, missing } = buildAgentMcpConfig({
          allowlist: ['plugin:does-not-exist:nope'],
          cwd,
          globalConfigPath: globalPath,
          pluginsDir,
        });

        assert.deepEqual(Object.keys(servers), []);
        assert.deepEqual(missing, ['plugin:does-not-exist:nope']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should treat an absent or malformed plugin root as simply no plugin servers', () => {
      const dir = tmpDir();
      try {
        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });

        assert.deepEqual(extractPluginMcpServers(join(dir, 'nope'), cwd), { servers: {}, aliases: {} });

        const broken = join(dir, 'broken');
        mkdirSync(broken, { recursive: true });
        writeFileSync(join(broken, 'installed_plugins.json'), '{ not json', 'utf-8');
        assert.deepEqual(extractPluginMcpServers(broken, cwd), { servers: {}, aliases: {} });

        const noPlugins = join(dir, 'empty');
        mkdirSync(noPlugins, { recursive: true });
        writeJson(join(noPlugins, 'installed_plugins.json'), { version: 2 });
        assert.deepEqual(extractPluginMcpServers(noPlugins, cwd), { servers: {}, aliases: {} });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should carry plugin servers through materialiseMcpConfig to the written file', () => {
      const dir = tmpDir();
      try {
        const globalPath = join(dir, '.claude.json');
        writeJson(globalPath, { mcpServers: {} });
        const cwd = join(dir, 'project');
        mkdirSync(cwd, { recursive: true });
        const pluginsDir = writePluginRoot(join(dir, 'plugins'), [
          { key: 'netgear-ned@netgear', servers: { ned: { type: 'http', url: 'https://ned.example/mcp' } } },
        ]);

        const result = materialiseMcpConfig({
          agentName: 'brain',
          allowlist: ['plugin:netgear-ned:ned'],
          cwd,
          outputDir: join(dir, 'out'),
          globalConfigPath: globalPath,
          pluginsDir,
        });

        assert.ok(existsSync(result.path));
        const written = JSON.parse(readFileSync(result.path, 'utf-8')) as { mcpServers: Record<string, unknown> };
        assert.deepEqual(Object.keys(written.mcpServers), ['ned']);
        assert.deepEqual(result.missing, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
