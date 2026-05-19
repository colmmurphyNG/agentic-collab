/**
 * Per-agent MCP config materialiser (proxy-side).
 *
 * Reads the operator's global `~/.claude.json` (and optionally the agent's
 * per-cwd `.claude/settings.json`), filters the `mcpServers` map down to a
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
 * Build the merged-then-filtered mcpServers map for an agent.
 * Merge order: global ~/.claude.json first, then cwd's .claude/settings.json
 * (cwd entries override global where names collide). Filter to allowlist.
 */
export function buildAgentMcpConfig(opts: {
  allowlist: string[];
  cwd: string;
  globalConfigPath?: string;
}): { servers: McpServersMap; missing: string[] } {
  const globalPath = opts.globalConfigPath ?? globalClaudeConfigPath();
  const cwdSettingsPath = join(opts.cwd, '.claude', 'settings.json');

  const globalServers = extractMcpServers(safeReadJsonObject(globalPath));
  const cwdServers = extractMcpServers(safeReadJsonObject(cwdSettingsPath));

  // cwd overrides global where names collide
  const merged: McpServersMap = { ...globalServers, ...cwdServers };

  const servers: McpServersMap = {};
  const missing: string[] = [];
  for (const name of opts.allowlist) {
    const entry = merged[name];
    if (entry !== undefined) {
      servers[name] = entry;
    } else {
      missing.push(name);
    }
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
  });

  writeFileSync(outPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8');

  return { path: outPath, missing };
}
