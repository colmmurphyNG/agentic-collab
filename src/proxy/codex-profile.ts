/**
 * Codex v2 profile management.
 *
 * Codex CLI v0.136+ reads `-p <name>` as `$CODEX_HOME/<name>.config.toml`,
 * layered on top of the base `~/.codex/config.toml`. Legacy `[profiles.<name>]`
 * blocks inside the central config.toml are no longer honoured by `-p`.
 *
 * This module writes per-profile files in the v2 format. The orchestrator
 * dispatches `write_codex_profile` on spawn and `remove_codex_profile` on
 * destroy via the proxy.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
}

/**
 * Remove a Codex v2 profile file. Idempotent — no error if the file
 * doesn't exist.
 */
export function removeCodexProfile(profileName: string, codexHome?: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  const path = codexProfilePath(profileName, codexHome);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
