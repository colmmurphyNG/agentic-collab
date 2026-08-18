# agentic-collab

Zero-dependency orchestrator for AI coding agents via tmux. Node 24 native TypeScript — no build step, no npm install.

## Quick Start

```bash
./start.sh          # orchestrator (host :8001 → container :3000) + proxy (host :3100)
node --test 'src/**/*.test.ts'  # 1308 tests (measured 2026-08-18)
npx tsc --noEmit    # type check
```

Host port is operator preference (default `8001`, configurable via `ORCHESTRATOR_HOST_PORT`
env var or `.env` file) — avoids collisions with common dev servers on 3000/3001.
Container always listens on 3000 internally. `--port <N>` flag overrides per invocation.

**Pages and data stores** are written under `PAGES_DIR` / `STORES_DIR` (env-configurable;
fallback to legacy in-volume location next to the DB). Set these via docker-compose to
bind-mount host directories so published pages and stores survive container rebuilds
and are inspectable on the host filesystem.

## Architecture

```
Orchestrator (host :8001 → container :3000)   Proxy (host :3100)
  SQLite WAL | HTTP API                        tmux session mgmt
  WebSocket | Health Monitor               ←→  File upload streaming
  Persona loader                               Heartbeats every 15s
```

Agent state machine: `void → spawning → active ↔ idle → suspending → suspended → failed`

## Source Map

```
src/
├── orchestrator/        # Docker container
│   ├── main.ts, database.ts, routes.ts
│   ├── lifecycle.ts     # 3-phase locking, watchdog timers
│   ├── health-monitor.ts
│   ├── persona.ts       # YAML frontmatter parsing
│   └── adapters/        # claude.ts, codex.ts, opencode.ts
├── proxy/               # Host process
│   ├── main.ts, tmux.ts
├── shared/              # types.ts, lock.ts, websocket-server.ts
└── dashboard/           # Vanilla JS SPA (index.html)
```

## Key Patterns

- **3-phase locking**: lifecycle.ts uses optimistic concurrency via version column
- **Health monitor**: 30s poll cycle, idle detection via tmux parsing, context% recorded for display, auto-**recycle** at ≥92% (`AUTO_RECYCLE_THRESHOLD_PCT`) when the agent is **idle**, with a 30-minute per-agent cooldown. There is no auto-compact and no auto-reload — `compactAgent` is only reachable via `POST /api/agents/:name/compact`. Context% comes from the pane: a printed percentage is used as-is, a token count is divided by the window the pane declares (`shared/context-window.ts`), not a fixed 200k.
- **Message dispatch**: event-driven queue with cool-down coordination (300ms after lifecycle ops)
- **Personas**: `persistent-agents/*.md` with YAML frontmatter (engine, cwd, model, hooks)
- **`renderMarkdown` forward-progress invariant** (`src/docs/render.ts`): every branch in the block-dispatch `while` loop **must** advance `i` before `continue`. The heading regex (`#{1,6}\s+…`) and the paragraph continuation guard (`startsWith('#')`) are intentionally non-identical — a line like `#1602 foo` falls through to the paragraph branch, which seeds `paraLines` with the current line before incrementing `i`. Any new dispatch branch that does not advance `i` will spin the event loop forever and wedge the orchestrator (all HTTP stops, CPU 100%, log silence). The regression test in `src/docs/render.test.ts` uses a subprocess-with-hard-timeout harness (`execFileSync` + `timeout: 4000`) so a hang surfaces as a test failure rather than a suite hang — follow this pattern for any synchronous parser/renderer regression test.

## Capacity Scaling

Spin up parallel instances of an existing persona on isolated git worktrees:

```bash
# Create a new agent from an existing persona
./scripts/scale-up.sh <base-persona> <new-name> <branch> [<base-branch>]
./scripts/scale-up.sh dev dev-a feature/issue-101
./scripts/scale-up.sh reviewer reviewer-a hotfix/critical

# Tear it down when done
./scripts/scale-down.sh dev-a                  # removes worktree + branch
./scripts/scale-down.sh dev-a --keep-branch    # keep the git branch
./scripts/scale-down.sh dev-a --force          # discard uncommitted changes
```

- `scale-up.sh` creates a worktree at `<repo>-worktrees/<new-name>`, copies the base persona with `cwd` updated, and the filesystem watcher auto-registers it (`void` state); spawn via dashboard or `curl -X POST .../api/agents/<name>/spawn`
- `scale-down.sh` calls `/api/agents/<name>/destroy`, removes the worktree, and optionally deletes the local branch; refuses if uncommitted changes exist (use `--force` to override)

## Testing

```bash
node --test 'src/**/*.test.ts'           # all tests
node --test --watch 'src/**/*.test.ts'   # watch mode
node --test src/orchestrator/*.test.ts   # subset
```

## Commits

Use conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`

For story-linked work:
```
<story-slug>: description

Motivation: <why>
Changes:
 - <file>: <one-line>
```

## Known Issues / Gotchas

<!-- AUTO-MANAGED: git-insights -->
- **AppleDouble wedge (2026-06-29)** — macOS `._*` metadata files in a pages bundle directory cause a CPU-pinning event-loop wedge. `routes.ts` page handler uses `readdirSync` + `*.md` glob; `._index.md` ends in `.md`, its binary AppleDouble header triggers pathological behaviour in the markdown parser (CPU 100%, log silence, HTTP timeouts from inside and outside the container). **Both fixes have landed** (verified 2026-08-18) — this entry is kept for the diagnostic signature, not as outstanding work. `isJunkFile()` (`routes.ts`) rejects `._*` and `.DS_Store`, and is wired into the tar-extract path, the single-file store path and the file-read path; the page-directory listing separately filters all dotfiles. Diagnostic: CPU 100%, Node state `R wchan=0`, FD count stable, all background loop logs stop. Full incident: `scratch/brain/wedge-2026-06-29/index.md`.
- **~~`lastActivity` hydration corruption on restart~~ — FIXED 2026-08-18, and the diagnosis above was wrong.** The absurd `grace elapsed=~1.78e12 ms` came from `lastActivityDetected`, an **in-memory `Map`** on the health monitor that is empty after a restart by construction — read with `?? 0`, which turned the "never observed" sentinel into an epoch timestamp. It was never a DB field and nothing in the DB was corrupt. The guarded transition was already correct (no observed activity ⇒ nothing holding the agent active ⇒ idle is right); only the arithmetic and the log line were wrong. `undefined` is now kept distinct from a timestamp and the line reads `no activity observed since restart`. Lesson worth keeping: an alarming number that appears every boot and resolves to nothing each time trains readers to discount that log line, which is how a real signal on it would be missed — and it survived a week of edits to the same file for exactly that reason.
<!-- END AUTO-MANAGED -->

## Don't

- Add npm dependencies (zero-dep is a design constraint)
- Skip the type check (`npx tsc --noEmit`)
- Push directly to main (use worktree + PR)
- Use --no-verify on commits
