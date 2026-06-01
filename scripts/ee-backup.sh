#!/usr/bin/env bash
#
# ee-backup.sh — daily backup of the operator-local customisation surface
# into ~/Documents/agentic-collab-backups/ (which corporate OneDrive backs
# up automatically per the operator's NETGEAR config — see backlog item EE).
#
# Tier-1 surface (operator-irreplaceable; all gitignored):
#   - persistent-agents/      — 12 persona files, including drone.md
#   - Per-domain .env files   — Algolia, Datadog, SFCC-commerce, conductor
#   - ~/.config/agentic-collab — orchestrator secret + per-agent mcp-configs/
#   - ~/.claude/skills        — operator-local Claude Code skills
#   - ~/.claude/commands      — operator-local Claude Code commands
#   - ~/.claude/agents        — operator-local custom subagents
#
# Output:  ~/Documents/agentic-collab-backups/agentic-collab-YYYY-MM-DD.tar.gz
#
# Retention:  last 10 days. Older tarballs in the backup dir are deleted.
#
# Atomic write:  tar to a .tmp file first, mv into place on success.
#                Prevents OneDrive from picking up a partial upload.
#
# Exit codes:
#   0  success — tarball created (or already existed for today, idempotent)
#   1  failure — at least one path missing OR tar/mv failed
#
# Designed to be invoked from a JJ job (collab job add drone "Run this
# script and report DONE: <path> <bytes> OR FAILED: <error>." --cron ...)
# but also runnable directly from the shell.
#
# Brain — backlog item EE, 2026-06-01

set -euo pipefail

# ── Configuration ──

readonly BACKUP_ROOT="${EE_BACKUP_ROOT:-${HOME}/Documents/agentic-collab-backups}"
readonly RETENTION_DAYS="${EE_RETENTION_DAYS:-10}"
readonly DATE_STAMP="$(date -u +%Y-%m-%d)"
readonly TARBALL_NAME="agentic-collab-${DATE_STAMP}.tar.gz"
readonly TARBALL_PATH="${BACKUP_ROOT}/${TARBALL_NAME}"
readonly TMP_PATH="${TARBALL_PATH}.tmp"

# Tier-1 paths. Order doesn't matter to tar; the array exists so non-existent
# paths can be reported separately rather than silently dropped.
readonly TIER1_PATHS=(
  "${HOME}/dev/conductor/persistent-agents"
  "${HOME}/dev/Algolia/.env"
  "${HOME}/dev/Datadog/.env"
  "${HOME}/dev/SFCC-commerce/.env"
  "${HOME}/dev/conductor/.env"
  "${HOME}/.config/agentic-collab"
  "${HOME}/.claude/skills"
  "${HOME}/.claude/commands"
  "${HOME}/.claude/agents"
)

# ── Logging ──

# Emit a single-line DONE: / FAILED: prefix at the end (drone reply contract).
# Body lines go to stderr so they don't pollute the dispatcher reply.
log() { echo "[ee-backup] $*" >&2; }
die() { echo "FAILED: $*"; exit 1; }

# ── Pre-flight ──

if [ ! -d "${HOME}/Documents" ]; then
  die "~/Documents does not exist. OneDrive sync not configured on this host? Aborting."
fi

mkdir -p "${BACKUP_ROOT}"

# Build the list of paths that actually exist. Skip absent ones with a
# warning (not all .env files exist on every machine — that's expected).
declare -a INCLUDED=()
declare -a MISSING=()
for p in "${TIER1_PATHS[@]}"; do
  if [ -e "$p" ]; then
    INCLUDED+=("$p")
  else
    MISSING+=("$p")
  fi
done

if [ "${#INCLUDED[@]}" -eq 0 ]; then
  die "No tier-1 paths exist on this host. Nothing to back up."
fi

log "Including ${#INCLUDED[@]} paths; skipping ${#MISSING[@]} absent paths."
if [ "${#MISSING[@]}" -gt 0 ]; then
  for p in "${MISSING[@]}"; do
    log "  (absent) $p"
  done
fi

# ── Build the tarball ──

# Idempotent: if today's tarball already exists, don't redo work.
# Lets the script run multiple times per day safely (e.g. retry on
# partial failure, or a JJ skipIfActive retry loop).
if [ -f "${TARBALL_PATH}" ]; then
  size=$(stat -f%z "${TARBALL_PATH}" 2>/dev/null || stat -c%s "${TARBALL_PATH}" 2>/dev/null || echo 0)
  log "Today's tarball already exists at ${TARBALL_PATH} (${size} bytes). Skipping re-creation; idempotent."
  echo "DONE: ${TARBALL_PATH} ${size} (idempotent — already existed)"
  exit 0
fi

# Tar with -C / so paths inside the archive are relative to root. This way
# `tar xzf ... -C /` restores everything in-place. Macros: BSD tar (macOS
# default) and GNU tar both honour this form.
log "Creating tarball at ${TMP_PATH}"
if ! tar -czf "${TMP_PATH}" -C / "${INCLUDED[@]/#\//}" 2>/tmp/ee-backup-tar.err; then
  err_msg="$(cat /tmp/ee-backup-tar.err 2>/dev/null | head -5 | tr '\n' ';')"
  rm -f "${TMP_PATH}"
  die "tar failed: ${err_msg}"
fi

# Atomic move into final position
if ! mv "${TMP_PATH}" "${TARBALL_PATH}"; then
  rm -f "${TMP_PATH}"
  die "mv ${TMP_PATH} -> ${TARBALL_PATH} failed"
fi

size=$(stat -f%z "${TARBALL_PATH}" 2>/dev/null || stat -c%s "${TARBALL_PATH}" 2>/dev/null)
log "Tarball created: ${TARBALL_PATH} (${size} bytes)"

# ── Prune old backups ──

# Match the canonical filename pattern only — don't accidentally rm anything
# else the operator put in this directory.
PRUNED=0
while IFS= read -r old; do
  rm -f "$old"
  PRUNED=$((PRUNED + 1))
  log "  pruned $old"
done < <(
  find "${BACKUP_ROOT}" -maxdepth 1 -name 'agentic-collab-*.tar.gz' -type f \
    -mtime "+${RETENTION_DAYS}" 2>/dev/null
)

if [ "$PRUNED" -gt 0 ]; then
  log "Pruned ${PRUNED} backup(s) older than ${RETENTION_DAYS} days."
fi

# ── Reply ──

# Single-line drone-friendly DONE: contract on stdout. All log output above
# went to stderr.
echo "DONE: ${TARBALL_PATH} ${size} (${#INCLUDED[@]} paths, ${PRUNED} pruned)"
