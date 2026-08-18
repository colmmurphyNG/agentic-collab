/**
 * Per-agent MCP config materialiser (proxy-side).
 *
 * Reads the operator's global `~/.claude.json` (and optionally the agent's
 * per-cwd `.claude/settings.json`, plus the `.mcp.json` of any installed
 * Claude Code plugin), filters the `mcpServers` map down to a
 * persona-declared allowlist, and writes the resulting subset to
 * `~/.config/agentic-collab/mcp-configs/<agent>.json`. Returns the absolute
 * host path so the orchestrator can include it in the spawn command via
 * `claude --mcp-config <path> --strict-mcp-config`.
 *
 * Runs in the proxy because:
 *  - ~/.claude.json is not bind-mounted into the orchestrator container
 *  - the file path must be readable on the host (claude runs in tmux there)
 *  - the proxy already has direct host filesystem access
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import type { MaterialiseMcpConfigResult } from '../shared/types.ts';

/** Where per-agent MCP config files are written on the host. */
export function mcpConfigDir(): string {
  return process.env['MCP_CONFIGS_DIR']
    ?? join(homedir(), '.config', 'agentic-collab', 'mcp-configs');
}

/** Host path to the operator's global Claude Code config. */
export function globalClaudeConfigPath(): string {
  return process.env['CLAUDE_CONFIG_PATH'] ?? join(homedir(), '.claude.json');
}

/** Host path to Claude Code's plugin root (holds `installed_plugins.json`). */
export function pluginsDirPath(): string {
  return process.env['CLAUDE_PLUGINS_DIR'] ?? join(homedir(), '.claude', 'plugins');
}

type McpServerDef = Record<string, unknown>;
type McpServersMap = Record<string, McpServerDef>;

function safeReadJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore — caller treats missing/unreadable as no entries
  }
  return null;
}

function extractMcpServers(config: Record<string, unknown> | null): McpServersMap {
  if (!config) return {};
  const raw = (config['mcpServers'] ?? {}) as unknown;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as McpServersMap;
  }
  return {};
}

/**
 * Pluck the per-project mcpServers map from ~/.claude.json's
 * `projects[<cwd>].mcpServers` slot, if present. Claude Code stores
 * project-scoped MCP server definitions there (`claude mcp add` with the
 * default --scope=local writes to this location).
 */
function extractProjectMcpServers(globalConfig: Record<string, unknown> | null, cwd: string): McpServersMap {
  if (!globalConfig) return {};
  const projects = globalConfig['projects'];
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return {};
  const projectConf = (projects as Record<string, unknown>)[cwd];
  if (!projectConf || typeof projectConf !== 'object' || Array.isArray(projectConf)) return {};
  return extractMcpServers(projectConf as Record<string, unknown>);
}

/**
 * Collect `mcpServers` declared by installed Claude Code plugins.
 *
 * Plugins ship their own `.mcp.json` inside the plugin directory, which is NOT
 * one of the four config files Claude Code merges for a normal session — and
 * because agents spawn with `--strict-mcp-config`, a plugin server that never
 * reaches the materialised file is invisible to the agent. Skills from the same
 * plugin DO reach it, so the failure mode is an agent that has been told to use
 * a tool it cannot see. Reading the plugin manifests here closes that gap.
 *
 * Returns servers keyed by their bare name (`ned`) plus an alias map from the
 * qualified name Claude Code displays in `claude mcp list`
 * (`plugin:netgear-ned:ned`) to that bare name, so a persona may allowlist
 * either spelling. The materialised config always uses the bare name — the
 * qualified form contains colons and is a display label, not a server key.
 *
 * Scope: user-scope plugins apply to every agent; project-scope plugins apply
 * only to agents whose cwd is that project. Installation is the signal — this
 * does not consult `enabledPlugins`.
 */
export function extractPluginMcpServers(pluginsDir: string, cwd: string): {
  servers: McpServersMap;
  aliases: Record<string, string>;
} {
  const registry = safeReadJsonObject(join(pluginsDir, 'installed_plugins.json'));
  const servers: McpServersMap = {};
  const aliases: Record<string, string> = {};
  if (!registry) return { servers, aliases };

  const plugins = registry['plugins'];
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return { servers, aliases };
  }

  for (const [pluginKey, recordsRaw] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(recordsRaw)) continue;
    // `<plugin-name>@<marketplace>` — the display label uses the name half.
    const pluginName = pluginKey.split('@')[0] ?? pluginKey;

    // User scope first so a project-scope install of the same plugin wins.
    const records = (recordsRaw as Record<string, unknown>[])
      .filter((r) => r && typeof r === 'object')
      .sort((a, b) => Number(a['scope'] === 'project') - Number(b['scope'] === 'project'));

    for (const record of records) {
      if (record['scope'] === 'project' && record['projectPath'] !== cwd) continue;
      const installPath = record['installPath'];
      if (typeof installPath !== 'string' || installPath === '') continue;

      const declared = extractMcpServers(safeReadJsonObject(join(installPath, '.mcp.json')));
      for (const [name, def] of Object.entries(declared)) {
        servers[name] = def;
        aliases[`plugin:${pluginName}:${name}`] = name;
      }
    }
  }

  return { servers, aliases };
}

/**
 * Build the merged-then-filtered mcpServers map for an agent.
 *
 * Merge order (later sources override earlier on name collision):
 *   0. installed plugins' `<installPath>/.mcp.json` → mcpServers
 *      (lowest precedence — operator config always overrides a plugin default)
 *   1. global    `~/.claude.json` → mcpServers
 *   2. per-project `~/.claude.json` → projects[<cwd>] → mcpServers
 *      (Claude Code's `claude mcp add --scope=local` lands here)
 *   3. per-cwd `<cwd>/.claude/settings.json` → mcpServers
 *   4. per-cwd `<cwd>/.mcp.json` → mcpServers
 *      (Claude Code's project-root MCP config — `claude mcp add --scope=project`)
 *
 * Then filter to allowlist. An allowlist entry may name a plugin server either
 * bare (`ned`) or by the qualified label `claude mcp list` prints
 * (`plugin:netgear-ned:ned`); both materialise under the bare name. The bare
 * spelling resolves against the merged map, so an operator override wins; the
 * qualified spelling resolves against the plugin's own declaration, so it keeps
 * meaning "the server this plugin ships" even when a same-named entry exists.
 */
export function buildAgentMcpConfig(opts: {
  allowlist: string[];
  cwd: string;
  globalConfigPath?: string;
  pluginsDir?: string;
}): { servers: McpServersMap; missing: string[] } {
  const globalPath = opts.globalConfigPath ?? globalClaudeConfigPath();
  const globalConfig = safeReadJsonObject(globalPath);

  const plugin = extractPluginMcpServers(opts.pluginsDir ?? pluginsDirPath(), opts.cwd);
  const globalServers = extractMcpServers(globalConfig);
  const projectScopedServers = extractProjectMcpServers(globalConfig, opts.cwd);
  const cwdSettingsServers = extractMcpServers(safeReadJsonObject(join(opts.cwd, '.claude', 'settings.json')));
  const cwdMcpJsonServers = extractMcpServers(safeReadJsonObject(join(opts.cwd, '.mcp.json')));

  // Later sources override earlier on name collision.
  const merged: McpServersMap = {
    ...plugin.servers,
    ...globalServers,
    ...projectScopedServers,
    ...cwdSettingsServers,
    ...cwdMcpJsonServers,
  };

  const servers: McpServersMap = {};
  const missing: string[] = [];
  for (const name of opts.allowlist) {
    const entry = merged[name];
    if (entry !== undefined) {
      servers[name] = entry;
      continue;
    }

    // Qualified plugin label — materialise under the bare server name, since
    // the qualified form contains colons and is not a usable server key.
    const bare = plugin.aliases[name];
    const pluginEntry = bare !== undefined ? plugin.servers[bare] : undefined;
    if (bare !== undefined && pluginEntry !== undefined) {
      servers[bare] = pluginEntry;
      continue;
    }

    missing.push(name);
  }

  return { servers, missing };
}

/**
 * Materialise an agent's MCP config to disk. Returns the host path the
 * orchestrator should pass to `claude --mcp-config`.
 *
 * Behaviour:
 *  - Empty allowlist → writes `{"mcpServers": {}}` and returns the path.
 *    Combined with --strict-mcp-config this gives the agent zero MCPs.
 *  - Some allowlist names missing from the merged sources → still writes
 *    a config containing the names that DID resolve, returns them in
 *    `missing` so the caller can log/warn.
 */
export function materialiseMcpConfig(opts: {
  agentName: string;
  allowlist: string[];
  cwd: string;
  outputDir?: string;
  globalConfigPath?: string;
  pluginsDir?: string;
}): MaterialiseMcpConfigResult {
  const dir = opts.outputDir ?? mcpConfigDir();
  const outPath = join(dir, `${opts.agentName}.json`);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  } else if (!existsSync(dirname(outPath))) {
    mkdirSync(dirname(outPath), { recursive: true });
  }

  const { servers, missing } = buildAgentMcpConfig({
    allowlist: opts.allowlist,
    cwd: opts.cwd,
    ...(opts.globalConfigPath !== undefined ? { globalConfigPath: opts.globalConfigPath } : {}),
    ...(opts.pluginsDir !== undefined ? { pluginsDir: opts.pluginsDir } : {}),
  });

  writeFileSync(outPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8');

  return { path: outPath, missing };
}
