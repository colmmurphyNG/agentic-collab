/**
 * Codex v2 profile management.
 *
 * Codex CLI v0.136+ reads `-p <name>` as `$CODEX_HOME/<name>.config.toml`,
 * layered on top of the base `~/.codex/config.toml`. Legacy `[profiles.<name>]`
 * blocks (and top-level `profile = "<name>"` selectors) inside the central
 * config.toml are not just ignored — codex hard-errors when both the v2 file
 * and a matching legacy entry exist:
 *
 *   Error: --profile `<name>` cannot be used while ~/.codex/config.toml
 *   contains legacy `profile = "<name>"` or `[profiles.<name>]` config
 *
 * This module writes per-profile files in the v2 format AND scrubs any
 * matching legacy entry from the central config on every write/remove. The
 * orchestrator dispatches `write_codex_profile` on spawn and
 * `remove_codex_profile` on destroy via the proxy.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Path to a Codex v2 per-profile file inside $CODEX_HOME (default `~/.codex`).
 */
export function codexProfilePath(profileName: string, codexHome?: string): string {
  const home = codexHome ?? join(homedir(), '.codex');
  return join(home, `${profileName}.config.toml`);
}

/**
 * Strip any legacy `[profiles.<name>]` block and matching top-level
 * `profile = "<name>"` selector line from the central `~/.codex/config.toml`.
 *
 * Idempotent and side-effect-free when:
 *   - The central config doesn't exist
 *   - No legacy entry for `profileName` is present
 *
 * Other `[profiles.X]` blocks, `[mcp_servers]`, top-level keys, and any
 * unrelated content are preserved verbatim.
 */
export function scrubLegacyProfileFromCentralConfig(
  profileName: string,
  codexHome?: string,
): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  const home = codexHome ?? join(homedir(), '.codex');
  const centralPath = join(home, 'config.toml');
  if (!existsSync(centralPath)) {
    return;
  }

  const original = readFileSync(centralPath, 'utf-8');

  // Match `[profiles.<name>]` header through to the next `[section]` header
  // or end of file. Lookahead preserves the next section header.
  const blockRegex = new RegExp(
    `\\[profiles\\.${profileName}\\][\\s\\S]*?(?=\\n\\[|$)`,
    'g',
  );
  // Match top-level `profile = "<name>"` selector line. Multiline mode so `^`
  // matches line starts; trailing newline consumed if present.
  const selectorRegex = new RegExp(
    `^profile\\s*=\\s*"${profileName}"\\s*\\n?`,
    'gm',
  );

  let scrubbed = original.replace(blockRegex, '');
  scrubbed = scrubbed.replace(selectorRegex, '');
  // Collapse triple-or-more newlines that may result from block removal.
  scrubbed = scrubbed.replace(/\n{3,}/g, '\n\n');

  if (scrubbed === original) {
    return;
  }
  writeFileSync(centralPath, scrubbed, 'utf-8');
}

/**
 * Write or replace a Codex v2 profile at `$CODEX_HOME/<name>.config.toml`.
 *
 * Uses TOML triple-quoted strings for `developer_instructions` so backticks,
 * dollar signs, exclamation marks, and embedded quotes survive unescaped.
 * The only problematic sequence — three consecutive double quotes — is
 * encoded as `"` to keep the string parseable.
 */
export function writeCodexProfile(
  profileName: string,
  developerInstructions: string,
  codexHome?: string,
): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  const path = codexProfilePath(profileName, codexHome);
  mkdirSync(dirname(path), { recursive: true });

  const safeInstructions = developerInstructions.replace(/"""/g, '""\\u0022');
  const body = `developer_instructions = """\n${safeInstructions}\n"""\n`;

  writeFileSync(path, body, 'utf-8');
  scrubLegacyProfileFromCentralConfig(profileName, codexHome);
}

/**
 * Remove a Codex v2 profile file. Idempotent — no error if the file
 * doesn't exist. Also scrubs any matching legacy entry from the central
 * config so a future spawn doesn't trip on a re-introduced conflict.
 */
export function removeCodexProfile(profileName: string, codexHome?: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  const path = codexProfilePath(profileName, codexHome);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  scrubLegacyProfileFromCentralConfig(profileName, codexHome);
}
