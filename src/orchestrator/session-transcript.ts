/**
 * Disk-presence check for CLI session transcripts.
 *
 * Claude Code writes one `<session-id>.jsonl` per session under
 * `<projects-dir>/<project-slug>/`. The orchestrator sees that tree when
 * CLAUDE_PROJECTS_DIR is bind-mounted; when it is not, presence is unknowable
 * and callers must not act on the answer.
 *
 * Used to tell two failure modes apart that otherwise look identical:
 * a recorded session id that never existed (orchestrator bug) versus one whose
 * transcript is on disk but failed to resume (CLI-side problem).
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 'unknown' means the check could not run — never treat it as 'absent'. */
export type TranscriptPresence = 'present' | 'absent' | 'unknown';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does a transcript exist for this session id?
 *
 * @param sessionId   Session id to look for. Non-UUID values return 'unknown'
 *                    rather than 'absent' — they are outside what this check
 *                    can speak to, and they must not reach a path join.
 * @param projectsDir Root of the per-project transcript tree. Defaults to
 *                    CLAUDE_PROJECTS_DIR.
 */
export function findSessionTranscript(
  sessionId: string | null | undefined,
  projectsDir: string | undefined = process.env['CLAUDE_PROJECTS_DIR'],
): TranscriptPresence {
  if (!projectsDir) return 'unknown';
  if (!sessionId || !UUID_RE.test(sessionId)) return 'unknown';

  const filename = `${sessionId}.jsonl`;
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    // Dir missing or unreadable — cannot distinguish absent from broken check.
    return 'unknown';
  }

  for (const dir of projectDirs) {
    try {
      if (readdirSync(join(projectsDir, dir)).includes(filename)) return 'present';
    } catch {
      // Skip unreadable project dirs; another may still hold the transcript.
    }
  }
  return 'absent';
}
