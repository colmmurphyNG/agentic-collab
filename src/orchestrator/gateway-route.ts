/**
 * Seat / Gateway routing for claude agents.
 *
 * An agent whose `route` is 'gateway' launches through the LLM gateway instead
 * of the operator's seat. The persona's launch command stays written for the
 * seat; on spawn/resume/reload the command is rewritten:
 *
 *   - `--settings <file>` points at a per-agent file that is the seat settings
 *     file with the gateway overlay merged on top (base URL, model mapping,
 *     apiKeyHelper). Plugins and anything else in the seat file carry over.
 *   - `--model <id>` becomes the family alias (opus / sonnet / haiku), which
 *     Claude Code resolves through the overlay's ANTHROPIC_DEFAULT_*_MODEL env,
 *     so the gateway's model ids live in config rather than here.
 *
 * The overlay is `<config-dir>/gateway-settings.json`. Without it the gateway
 * cannot be selected, and an agent already set to it launches on the seat.
 * The session id is untouched, so the conversation carries across a switch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from '../shared/utils.ts';

export type AgentRoute = 'seat' | 'gateway';

export function isAgentRoute(value: unknown): value is AgentRoute {
  return value === 'seat' || value === 'gateway';
}

/** Config dir as the orchestrator sees it (the container side of the bind mount). */
function containerConfigDir(): string {
  return process.env['AGENTIC_COLLAB_CONFIG_DIR']
    ?? join(process.env['HOME'] ?? '/tmp', '.config', 'agentic-collab');
}

/** Config dir as the host shell sees it. Equal to the container dir when not in Docker. */
export function hostConfigDir(): string {
  const containerDir = containerConfigDir();
  const hostHome = process.env['HOST_HOME'];
  if (hostHome && containerDir.startsWith('/config/agentic-collab')) {
    return join(hostHome, '.config', 'agentic-collab') + containerDir.slice('/config/agentic-collab'.length);
  }
  return containerDir;
}

/** Map a host path under the config dir to the path the orchestrator can read. */
function toContainerConfigPath(hostPath: string): string | null {
  const hostDir = hostConfigDir();
  if (hostPath === hostDir || hostPath.startsWith(hostDir + '/')) {
    return containerConfigDir() + hostPath.slice(hostDir.length);
  }
  return null;
}

export function gatewayOverlayPath(): string {
  return join(containerConfigDir(), 'gateway-settings.json');
}

export function gatewayConfigured(): boolean {
  return existsSync(gatewayOverlayPath());
}

type Settings = Record<string, unknown> & { env?: Record<string, string> };

function readJsonObject(path: string): Settings | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Settings : null;
  } catch {
    return null;
  }
}

const SETTINGS_FLAG = /--settings\s+('[^']*'|"[^"]*"|\S+)/;
const MODEL_FLAG = /--model\s+('[^']*'|"[^"]*"|\S+)/;

function unquote(token: string): string {
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1);
  }
  return token;
}

/** The `--settings` value in a launch command, unquoted, or null if there is none. */
export function seatSettingsPath(cmd: string): string | null {
  const m = SETTINGS_FLAG.exec(cmd);
  return m ? unquote(m[1]!) : null;
}

/** Family alias for a model id, or null when the id names no known family. */
export function modelFamily(model: string): 'opus' | 'sonnet' | 'haiku' | null {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

/**
 * Rewrite a seat launch command for the gateway. Pure: no filesystem access.
 * Returns the command unchanged when it does not launch claude.
 */
export function rewriteForGateway(cmd: string, gatewaySettingsPath: string): string {
  if (!/(^|[\s;&|])claude(\s|$)/.test(cmd)) return cmd;
  const settingsArg = `--settings ${shellQuote(gatewaySettingsPath)}`;
  let out = SETTINGS_FLAG.test(cmd)
    ? cmd.replace(SETTINGS_FLAG, () => settingsArg)
    : cmd.replace(/(^|[\s;&|])claude(?=\s|$)/, (m) => `${m} ${settingsArg}`);
  out = out.replace(MODEL_FLAG, (whole, token: string) => {
    const family = modelFamily(unquote(token));
    return family ? `--model ${family}` : whole;
  });
  return out;
}

/**
 * Write the agent's merged gateway settings file and return its host path, or
 * null when no overlay is configured. The seat file is read only if it lives
 * under the config dir (the only host directory the orchestrator can see).
 */
export function materialiseGatewaySettings(agentName: string, cmd: string): string | null {
  const overlay = readJsonObject(gatewayOverlayPath());
  if (!overlay) return null;

  const seatHostPath = seatSettingsPath(cmd);
  const seatReadable = seatHostPath ? toContainerConfigPath(seatHostPath) : null;
  const seat = seatReadable ? readJsonObject(seatReadable) ?? {} : {};

  const merged: Settings = { ...seat, ...overlay, env: { ...(seat.env ?? {}), ...(overlay.env ?? {}) } };

  const dir = join(containerConfigDir(), 'gateway-settings');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentName}.json`), JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  return join(hostConfigDir(), 'gateway-settings', `${agentName}.json`);
}

/** Apply the agent's route to a launch command. Seat, non-claude and unconfigured are pass-through. */
export function applyRoute(agent: { name: string; engine: string; route: string | null }, cmd: string): string {
  if (agent.route !== 'gateway' || agent.engine !== 'claude') return cmd;
  const settingsPath = materialiseGatewaySettings(agent.name, cmd);
  if (!settingsPath) {
    console.warn(`[gateway-route] ${agent.name}: route is gateway but ${gatewayOverlayPath()} is missing or invalid; launching on the seat`);
    return cmd;
  }
  return rewriteForGateway(cmd, settingsPath);
}
