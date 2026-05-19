/**
 * Agent lifecycle operations: spawn, resume, suspend, destroy, reload.
 * Integrates with engine adapters, tmux proxy, and persistence.
 *
 * Long-running operations (spawn, suspend, resume, reload) use a three-phase
 * locking pattern to avoid holding locks across slow proxy calls and sleeps:
 *
 *   Phase 1 (lock): validate → transition to intermediate state → release
 *   Phase 2 (no lock): slow work (proxy calls, sleeps)
 *   Phase 3 (lock): re-read → validate intermediate state → finalize
 *
 * Intermediate states ('spawning', 'suspending', 'resuming') act as claims —
 * concurrent callers see the agent is in transition and back off.
 * Watchdog timers mark agents 'failed' if operations hang.
 *
 * Short operations (interrupt, compact, kill, deliver) use single-phase locks.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.ts';
import type { DashboardMessage } from '../shared/types.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse, AgentRecord, PipelineStep } from '../shared/types.ts';
import { sessionName, requireProxy, canSuspend, canResume } from '../shared/agent-entity.ts';
import { shellQuote, sleep } from '../shared/utils.ts';
import { getAdapter } from './adapters/index.ts';
import { resolvePersonaPath, loadPersona, composeSystemPrompt, getPersonasDir, toHostPath, parseFrontmatter } from './persona.ts';
import { resolveHook } from './hook-resolver.ts';
import type { HookResult, TemplateVars } from './hook-resolver.ts';
import type { AccountStore } from './accounts.ts';
import { resolveEffectiveConfig } from './engine-config-resolver.ts';
import { stripCliFailureLines } from './cli-failure-patterns.ts';

export type LifecycleContext = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  orchestratorHost: string;
  accountStore?: AccountStore;
  /**
   * Callback to signal that a lifecycle operation completed for an agent.
   * Used to coordinate cool-down periods with the message dispatcher (Race 2 fix).
   */
  onLifecycleOp?: (agentName: string) => void;
};

// Timeouts and delays — configurable via env vars for tuning in different environments
const SPAWN_TIMEOUT_MS = parseInt(process.env['SPAWN_TIMEOUT_MS'] ?? '30000', 10);
const SUSPEND_TIMEOUT_MS = parseInt(process.env['SUSPEND_TIMEOUT_MS'] ?? '60000', 10);
const RESUME_TIMEOUT_MS = parseInt(process.env['RESUME_TIMEOUT_MS'] ?? '60000', 10);
const RELOAD_TIMEOUT_MS = parseInt(process.env['RELOAD_TIMEOUT_MS'] ?? '90000', 10);
const RENAME_DELAY_MS = parseInt(process.env['RENAME_DELAY_MS'] ?? '3000', 10);
const EXIT_WAIT_MS = parseInt(process.env['EXIT_WAIT_MS'] ?? '10000', 10);
const POST_SPAWN_ACTIVE_DELAY_MS = parseInt(process.env['POST_SPAWN_ACTIVE_DELAY_MS'] ?? '2000', 10);
const POST_RENAME_TASK_DELAY_MS = parseInt(process.env['POST_RENAME_TASK_DELAY_MS'] ?? '1000', 10);
const INTERRUPT_KEY_DELAY_MS = parseInt(process.env['INTERRUPT_KEY_DELAY_MS'] ?? '300', 10);

function prependExports(cmd: string, entries: Array<[string, string]>): string {
  const assignments = entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  return `export ${assignments} && ${cmd}`;
}

/** Wrap a launch command with base exports plus persona-defined launch env. */
function withLaunchEnv(agent: AgentRecord, cmd: string, personaFile: string, accountHome?: string): string {
  const baseEntries: Array<[string, string]> = [
    ['COLLAB_AGENT', agent.name],
    ['COLLAB_PERSONA_FILE', personaFile],
  ];
  // Inject HOME override for account-based credential isolation
  if (accountHome) {
    baseEntries.push(['HOME', accountHome]);
  }
  const reservedKeys = new Set(baseEntries.map(([key]) => key));
  const launchEntries = Object.entries(agent.launchEnv ?? {})
    .filter(([key]) => !reservedKeys.has(key));
  return prependExports(cmd, [...baseEntries, ...launchEntries]);
}

/** Wrap the first shell step in a pipeline with agent env vars (same as withLaunchEnv for paste mode). */
function wrapFirstShellStep(steps: PipelineStep[], agent: AgentRecord, personaFile: string, accountHome?: string): PipelineStep[] {
  const idx = steps.findIndex(s => s.type === 'shell');
  if (idx === -1) return steps;
  const step = steps[idx] as { type: 'shell'; command: string };
  const wrapped = [...steps];
  wrapped[idx] = { type: 'shell', command: withLaunchEnv(agent, step.command, personaFile, accountHome) };
  return wrapped;
}

/** Wrap a resolved hook result with agent env vars for launch operations (spawn/resume/reload). */
function wrapLaunchResult(result: HookResult, agent: AgentRecord, personaFile: string, accountHome?: string): HookResult {
  if (result.mode === 'paste') {
    return { mode: 'paste', text: withLaunchEnv(agent, result.text, personaFile, accountHome) };
  }
  if (result.mode === 'pipeline') {
    return { ...result, steps: wrapFirstShellStep(result.steps, agent, personaFile, accountHome) };
  }
  return result;
}

/**
 * Dispatch a resolved hook result to the proxy.
 * Handles paste, keys, send sequences, pipelines, and skip modes uniformly.
 *
 * When agentName is provided and the pipeline contains capture steps,
 * captured variables are stored in the agent's captured_vars column.
 */
async function dispatchHookResult(
  ctx: LifecycleContext,
  proxyId: string,
  tmuxSession: string,
  result: HookResult,
  opts?: { pressEnter?: boolean; keyDelay?: number; agentName?: string },
): Promise<void> {
  if (result.mode === 'skip') return;

  if (result.mode === 'keys') {
    for (const key of result.keys) {
      await ctx.proxyDispatch(proxyId, {
        action: 'send_keys',
        sessionName: tmuxSession,
        keys: key,
      });
      if (opts?.keyDelay) await sleep(opts.keyDelay);
    }
    return;
  }

  if (result.mode === 'send') {
    for (const action of result.actions) {
      if ('keystroke' in action) {
        await ctx.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: tmuxSession,
          keys: action.keystroke,
        });
      } else if ('text' in action) {
        await ctx.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: tmuxSession,
          keys: action.text,
        });
      } else if ('paste' in action) {
        await ctx.proxyDispatch(proxyId, {
          action: 'paste',
          sessionName: tmuxSession,
          text: action.paste,
          pressEnter: false,
        });
      }
      const waitMs = action.post_wait_ms;
      if (waitMs && waitMs > 0) await sleep(waitMs);
    }
    return;
  }

  if (result.mode === 'pipeline') {
    for (const step of result.steps) {
      if (step.type === 'keystrokes') {
        await dispatchHookResult(ctx, proxyId, tmuxSession, { mode: 'send', actions: step.actions }, opts);
      } else if (step.type === 'keystroke') {
        await ctx.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: tmuxSession,
          keys: step.key,
        });
        // Brief delay after keystrokes to let terminal process them before
        // the next step — prevents Escape from eating the first character of
        // a subsequent paste (e.g. "/exit" → "xit")
        await sleep(100);
      } else if (step.type === 'shell') {
        // Split paste and Enter into separate dispatches so the terminal
        // ingestion delay happens orchestrator-side, not inside the HTTP
        // request to the proxy. Fixes timeout for large pastes (GH #2).
        const shouldEnter = opts?.pressEnter ?? true;
        await ctx.proxyDispatch(proxyId, {
          action: 'paste',
          sessionName: tmuxSession,
          text: step.command,
          pressEnter: false,
        });
        if (shouldEnter) {
          const delay = Math.min(Math.max(100, step.command.length), 12000);
          await sleep(delay);
          await ctx.proxyDispatch(proxyId, {
            action: 'send_keys',
            sessionName: tmuxSession,
            keys: 'Enter',
          });
        }
      } else if (step.type === 'capture') {
        const captureResult = await ctx.proxyDispatch(proxyId, {
          action: 'capture',
          sessionName: tmuxSession,
          lines: step.lines,
        });
        if (opts?.agentName && captureResult.ok && typeof captureResult.data === 'string') {
          try {
            const regexStr = step.regex === 'uuid'
              ? '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
              : step.regex;
            const re = new RegExp(regexStr);
            // Strip CLI-failure lines first so a UUID inside an error message
            // ("No conversation found with session ID: <uuid>") cannot be
            // captured and re-written to the DB as the live session id.
            // Without this filter, a stale-resume produces an infinite recovery
            // loop on the dead UUID (see scratch/brain/lifecycle-resume-bug.md).
            const sanitised = stripCliFailureLines(captureResult.data);
            const match = re.exec(sanitised);
            if (match && match[1]) {
              const captured = match[1].trim();
              ctx.db.updateAgentCapturedVar(opts.agentName, step.var, captured);
              console.log(`[lifecycle] ${opts.agentName}: captured $${step.var} = ${captured}`);
              // When capturing SESSION_ID, also update currentSessionId for legacy resume flow
              if (step.var === 'SESSION_ID') {
                const latest = ctx.db.getAgent(opts.agentName!);
                if (latest) {
                  ctx.db.updateAgentState(opts.agentName!, latest.state, latest.version, {
                    currentSessionId: captured,
                  });
                }
              }
            }
          } catch (err) {
            console.warn(`[lifecycle] ${opts.agentName}: capture regex failed for $${step.var}:`, (err as Error).message);
          }
        }
      } else if (step.type === 'wait') {
        await sleep(step.ms);
      }
    }
    return;
  }

  // mode === 'paste' — split paste and Enter so the delay happens
  // orchestrator-side, not inside the proxy HTTP request (GH #2).
  const shouldEnter = opts?.pressEnter ?? true;
  await ctx.proxyDispatch(proxyId, {
    action: 'paste',
    sessionName: tmuxSession,
    text: result.text,
    pressEnter: false,
  });
  if (shouldEnter) {
    // Short texts (messages) need minimal delay; large texts (personas/prompts)
    // need proportional delay for terminal ingestion.
    const delay = Math.min(Math.max(100, result.text.length), 12000);
    await sleep(delay);
    await ctx.proxyDispatch(proxyId, {
      action: 'send_keys',
      sessionName: tmuxSession,
      keys: 'Enter',
    });
  }
}

// ── Shared launch-sequence helpers ──
// Extracted from spawn/resume/reload to reduce duplication.

/** Sleep, then inject the engine's /rename command (if any) into the tmux session. */
async function injectRename(
  ctx: LifecycleContext,
  proxyId: string,
  tmuxSession: string,
  adapter: ReturnType<typeof getAdapter>,
  name: string,
): Promise<void> {
  await sleep(RENAME_DELAY_MS);
  const renameCmd = adapter.buildRenameCommand(name);
  if (renameCmd) {
    await ctx.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: tmuxSession,
      text: renameCmd,
      pressEnter: true,
    });
  }
}

/**
 * Create a tmux session and write a config profile for engines that use one (e.g. Codex).
 *
 * Idempotent: if a tmux session with the requested name already exists (for
 * example because a previous exit hook intentionally preserved the pane for
 * inspection — see the "session still alive after exit — preserving for
 * inspection" branch of the suspend pipeline), kill it before creating a
 * fresh one. The previous behaviour silently let tmux's `new-session` collide
 * with the preserved pane and the next spawn's paste landed in a dirty zsh
 * prompt; long persona bodies with backticks and single quotes then dropped
 * the shell into quote-continuation mode mid-paste and zombied the agent
 * (Sammons/agentic-collab#5).
 *
 * `has_session` and `kill_session` failures are tolerated — if the proxy can't
 * answer, we still attempt `create_session` and surface its real error.
 */
async function createSessionAndWriteProfile(
  ctx: LifecycleContext,
  proxyId: string,
  tmuxSession: string,
  cwd: string,
  adapter: ReturnType<typeof getAdapter>,
  name: string,
  systemPrompt: string | null,
): Promise<ProxyResponse> {
  const hasResult = await ctx
    .proxyDispatch(proxyId, { action: 'has_session', sessionName: tmuxSession })
    .catch(() => ({ ok: false, data: false }) as ProxyResponse);
  if (hasResult.ok && hasResult.data === true) {
    console.log(
      `[lifecycle] ${name}: tmux session "${tmuxSession}" exists at spawn — killing before fresh create (Sammons#5)`,
    );
    await ctx
      .proxyDispatch(proxyId, { action: 'kill_session', sessionName: tmuxSession })
      .catch((err: unknown) => {
        console.warn(
          `[lifecycle] best-effort kill_session before create failed for ${name}: ${(err as Error).message}`,
        );
        return { ok: false } as ProxyResponse;
      });
  }

  const createResult = await ctx.proxyDispatch(proxyId, {
    action: 'create_session',
    sessionName: tmuxSession,
    cwd,
  });
  if (createResult.ok && adapter.usesConfigProfile && systemPrompt) {
    await ctx.proxyDispatch(proxyId, {
      action: 'write_codex_profile',
      profileName: name,
      developerInstructions: systemPrompt,
    });
  }
  return createResult;
}

/**
 * Re-lock the agent, verify it is still in the expected intermediate state,
 * and transition to 'active'. Returns the updated record, or the current
 * record unchanged if the state was altered concurrently.
 */
async function finalizeToActive(
  ctx: LifecycleContext,
  name: string,
  intermediateState: string,
  interruptedEventName: string,
  updateExtra: Record<string, unknown>,
  eventName: string,
  eventMeta?: Record<string, unknown>,
  operationLabel?: string,
): Promise<AgentRecord> {
  const label = operationLabel ?? intermediateState;
  return await ctx.locks.withLock(name, async () => {
    const latest = ctx.db.getAgent(name);
    if (!latest) throw new Error(`Agent "${name}" disappeared during ${label}`);
    if (latest.state !== intermediateState) {
      ctx.db.logEvent(name, interruptedEventName, undefined, { finalState: latest.state });
      return latest;
    }
    const updated = ctx.db.updateAgentState(name, 'active', latest.version, updateExtra);
    ctx.db.logEvent(name, eventName, undefined, eventMeta);
    return updated;
  });
}

/**
 * Read the persona's `mcps:` allowlist from its frontmatter, if present.
 * Returns the string array (possibly empty) when defined, or undefined when
 * the persona doesn't declare the field. Caller distinguishes:
 *   undefined → fall back to default MCP resolution (no --mcp-config flag)
 *   [] / non-empty → materialise the file and pass --mcp-config + --strict-mcp-config
 */
function resolveMcpAllowlist(personaPath: string): string[] | undefined {
  const content = loadPersona(personaPath);
  if (!content) return undefined;
  const { frontmatter } = parseFrontmatter(content);
  const mcps = frontmatter['mcps'];
  if (mcps === undefined) return undefined;
  if (Array.isArray(mcps) && mcps.every((m) => typeof m === 'string')) {
    return mcps as string[];
  }
  return undefined;
}

/**
 * Ask the proxy to materialise a per-agent MCP config file on the host.
 * Returns the host path to feed into `claude --mcp-config`, or undefined
 * if the proxy call failed (allowlist couldn't be materialised — skip the
 * flag and fall back to default behaviour rather than blocking the spawn).
 */
async function materialiseMcpConfigForAgent(
  ctx: LifecycleContext,
  proxyId: string,
  agentName: string,
  cwd: string,
  allowlist: string[],
): Promise<string | undefined> {
  try {
    const response = await ctx.proxyDispatch(proxyId, {
      action: 'materialise_mcp_config',
      agentName,
      allowlist,
      cwd,
    });
    if (!response.ok) {
      console.warn(`[lifecycle] ${agentName}: materialise_mcp_config failed: ${response.error}`);
      return undefined;
    }
    const data = response.data as { path: string | null; missing?: string[] } | undefined;
    if (!data || typeof data.path !== 'string') return undefined;
    if (data.missing && data.missing.length > 0) {
      console.warn(`[lifecycle] ${agentName}: MCP allowlist entries not found in host config: ${data.missing.join(', ')}`);
    }
    return data.path;
  } catch (err) {
    console.warn(`[lifecycle] ${agentName}: materialise_mcp_config threw: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Resolve whether to use the resume hook (existing session) or start hook (fresh spawn).
 * Shared by resumeAgent and reloadAgent.
 *
 * When sessionId is non-null, uses hookResume with resumeTask.
 * Otherwise generates a new UUID (for Claude) and uses hookStart with startTask.
 *
 * Mutates templateVars.SESSION_ID in the fresh-spawn branch.
 * Returns the hook result and the (possibly new) sessionId.
 */
function resolveResumeOrStartHook(params: {
  adapter: ReturnType<typeof getAdapter>;
  hookResume: AgentRecord['hookResume'];
  hookStart: AgentRecord['hookStart'];
  agentRecord: AgentRecord;
  sessionId: string | null;
  name: string;
  cwd: string;
  resumeTask: string | undefined;
  startTask: string | undefined;
  systemPrompt: string | null;
  permissions: string | null;
  templateVars: TemplateVars;
  /** Host path to the materialised per-agent MCP config, when the persona declares `mcps:`. */
  mcpConfigPath?: string;
}): { result: HookResult; sessionId: string | null } {
  const mcpOpts = params.mcpConfigPath !== undefined ? { mcpConfigPath: params.mcpConfigPath } : {};
  if (params.sessionId) {
    const result = resolveHook('resume', params.hookResume, params.agentRecord, {
      resumeOpts: {
        name: params.name,
        sessionId: params.sessionId,
        cwd: params.cwd,
        task: params.resumeTask,
        appendSystemPrompt: params.systemPrompt,
        ...mcpOpts,
      },
      templateVars: params.templateVars,
    });
    return { result, sessionId: params.sessionId };
  }
  // No stored session — spawn fresh. Only Claude uses --session-id.
  const newSessionId = params.adapter.engine === 'claude' ? randomUUID() : null;
  params.templateVars.SESSION_ID = newSessionId ?? undefined;
  const result = resolveHook('start', params.hookStart, params.agentRecord, {
    spawnOpts: {
      name: params.name,
      cwd: params.cwd,
      task: params.startTask,
      appendSystemPrompt: params.systemPrompt,
      dangerouslySkipPermissions: params.permissions === 'skip',
      sessionId: newSessionId,
      ...mcpOpts,
    },
    templateVars: params.templateVars,
  });
  return { result, sessionId: newSessionId };
}

// ── Watchdog helper ──

/**
 * Start a watchdog timer that marks an agent 'failed' if it's still in
 * the given intermediate state after timeoutMs.
 */
export function startWatchdog(
  ctx: LifecycleContext,
  name: string,
  intermediateState: string,
  timeoutMs: number,
  proxyId?: string,
  tmuxSession?: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(async () => {
    try {
      await ctx.locks.withLock(name, async () => {
        const latest = ctx.db.getAgent(name);
        if (latest && latest.state === intermediateState) {
          ctx.db.updateAgentState(name, 'failed', latest.version, {
            failedAt: new Date().toISOString(),
            failureReason: `${intermediateState} timeout (${timeoutMs / 1000}s)`,
          });
          ctx.db.logEvent(name, `${intermediateState}_timeout`, undefined, { timeoutMs });

          // Best-effort kill tmux session
          if (proxyId && tmuxSession) {
            await ctx.proxyDispatch(proxyId, {
              action: 'kill_session',
              sessionName: tmuxSession,
            }).catch((err) => {
              console.warn(`[watchdog] Best-effort kill_session failed for ${name}:`, (err as Error).message);
            });
          }
        }
      });
    } catch (err) {
      console.warn(`[watchdog] Failed for ${name}:`, (err as Error).message);
    }
  }, timeoutMs);
}

/**
 * Spawn a new agent: create tmux session, paste spawn command.
 *
 * Phase 1: validate + transition to 'spawning'
 * Phase 2: create tmux session, paste spawn command, rename, wait
 * Phase 3: validate still 'spawning' + transition to 'active'
 */
export async function spawnAgent(
  ctx: LifecycleContext,
  opts: {
    name: string;
    engine: string;
    model?: string;
    thinking?: string;
    cwd: string;
    persona?: string;
    proxyId: string;
    task?: string;
  },
): Promise<AgentRecord> {
  if (!opts.proxyId) throw new Error(`Agent "${opts.name}" has no proxy assigned`);

  const peers = computePeers(ctx, opts.name);

  // ── Phase 1: validate + transition to 'spawning' ──
  const phase1 = await ctx.locks.withLock(opts.name, async () => {
    const agent = ctx.db.getAgent(opts.name);
    if (!agent) throw new Error(`Agent "${opts.name}" not found in registry`);
    if (agent.state !== 'void' && agent.state !== 'failed') {
      throw new Error(`Agent "${opts.name}" is in state "${agent.state}", expected void or failed`);
    }

    const tmuxSession = `agent-${opts.name}`;
    const current = ctx.db.updateAgentState(opts.name, 'spawning', agent.version, {
      tmuxSession,
      proxyId: opts.proxyId,
      lastActivity: new Date().toISOString(),
    });

    return { current, tmuxSession, engine: agent.engine, spawnCount: agent.spawnCount, permissions: agent.permissions, hookStart: agent.hookStart };
  });

  const { tmuxSession, spawnCount } = phase1;

  // Resolve engine config defaults beneath agent-level fields
  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;

  const watchdog = startWatchdog(ctx, opts.name, 'spawning', SPAWN_TIMEOUT_MS, opts.proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Compose system prompt with persona (no proxy dependency)
    const systemPrompt = buildSystemPrompt(ctx, opts.name, peers, opts.persona);

    // 2. Create tmux session + write config profile
    const createResult = await createSessionAndWriteProfile(
      ctx, opts.proxyId, tmuxSession, opts.cwd, adapter, opts.name, systemPrompt,
    );
    if (!createResult.ok) {
      // Re-acquire lock to mark failed
      await ctx.locks.withLock(opts.name, async () => {
        const latest = ctx.db.getAgent(opts.name);
        if (latest && latest.state === 'spawning') {
          ctx.db.updateAgentState(opts.name, 'failed', latest.version, {
            failedAt: new Date().toISOString(),
            failureReason: `Failed to create tmux session: ${createResult.error}`,
          });
          ctx.db.logEvent(opts.name, 'spawn_failed', undefined, { reason: createResult.error });
        }
      });
      throw new Error(`Spawn failed: ${createResult.error}`);
    }

    // 3. Generate session ID for engines that support it (Claude --session-id)
    const generatedSessionId = randomUUID();

    // 4. Build and paste spawn command via hook resolver
    const personaFile = resolvePersonaFilePath(opts.name, opts.persona);

    // 4a. If the persona declares an `mcps:` allowlist, ask the proxy to
    // materialise a per-agent MCP config file on the host filesystem. The
    // returned path is passed to claude via --mcp-config + --strict-mcp-config.
    const mcpAllowlist = resolveMcpAllowlist(personaFile);
    const mcpConfigPath = mcpAllowlist !== undefined
      ? await materialiseMcpConfigForAgent(ctx, opts.proxyId, opts.name, opts.cwd, mcpAllowlist)
      : undefined;

    const templateVars: TemplateVars = {
      AGENT_NAME: opts.name,
      AGENT_CWD: opts.cwd,
      SESSION_ID: generatedSessionId,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
      capturedVars: phase1.current.capturedVars ?? undefined,
    };
    const startResult = resolveHook('start', hookStart, effectiveCurrent, {
      spawnOpts: {
        name: opts.name,
        cwd: opts.cwd,
        model: opts.model,
        thinking: opts.thinking,
        task: opts.task,
        appendSystemPrompt: systemPrompt,
        dangerouslySkipPermissions: permissions === 'skip',
        sessionId: generatedSessionId,
        ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
      },
      templateVars,
    });

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(opts.name, phase1.current.account);
      if (home) {
        accountHome = home;
        console.log(`[lifecycle] ${opts.name}: using account "${phase1.current.account}" (HOME=${home})`);
      } else {
        console.warn(`[lifecycle] ${opts.name}: account "${phase1.current.account}" not found or missing credentials`);
      }
    }

    // Wrap launch command with agent env vars
    const wrappedStart = wrapLaunchResult(startResult, effectiveCurrent, personaFile, accountHome);

    await dispatchHookResult(ctx, opts.proxyId, tmuxSession, wrappedStart, { agentName: opts.name });

    // 5. Wait for CLI init, then inject /rename
    await injectRename(ctx, opts.proxyId, tmuxSession, adapter, opts.name);

    // Let the CLI fully initialize before finalizing state
    await sleep(POST_SPAWN_ACTIVE_DELAY_MS);

    // ── Phase 3: finalize (lock) ──
    return await finalizeToActive(ctx, opts.name, 'spawning', 'spawn_interrupted', {
      lastActivity: new Date().toISOString(),
      spawnCount: spawnCount + 1,
      lastContextPct: 0,
      currentSessionId: generatedSessionId,
    }, 'spawned', {
      engine,
      model: opts.model,
      sessionId: generatedSessionId,
    }, 'spawn');
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Resume a suspended agent.
 *
 * Phase 1: validate + transition to 'resuming'
 * Phase 2: create tmux session, paste resume command, rename, optional task
 * Phase 3: validate still 'resuming' + transition to 'active'
 */
export async function resumeAgent(
  ctx: LifecycleContext,
  name: string,
  opts?: { task?: string },
): Promise<AgentRecord> {
  const peers = computePeers(ctx, name);

  // ── Phase 1: validate + transition to 'resuming' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canResume(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", expected suspended or failed`);
    }
    const proxyId = requireProxy(agent);
    const tmuxSession = sessionName(agent);

    const current = ctx.db.updateAgentState(name, 'resuming', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return {
      current,
      proxyId,
      tmuxSession,
      engine: agent.engine,
      cwd: agent.cwd,
      persona: agent.persona,
      permissions: agent.permissions,
      currentSessionId: agent.currentSessionId,
      hookStart: agent.hookStart,
      hookResume: agent.hookResume,
    };
  });

  const { proxyId, tmuxSession, cwd, persona, currentSessionId } = phase1;

  // Resolve engine config defaults beneath agent-level fields
  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;
  const hookResume = effectiveCurrent.hookResume;

  const watchdog = startWatchdog(ctx, name, 'resuming', RESUME_TIMEOUT_MS, proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Compose system prompt (no proxy dependency)
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 2. Reuse existing tmux session if it survived suspend (preserves Watch-tab
    //    attachments and any manual operator tweaks). Only create fresh if gone.
    const hasResult = await ctx.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: tmuxSession,
    }).catch(() => ({ ok: false, data: false }));
    const sessionExists = hasResult.ok && hasResult.data === true;

    if (!sessionExists) {
      const createResult = await createSessionAndWriteProfile(ctx, proxyId, tmuxSession, cwd, adapter, name, systemPrompt);
      if (!createResult.ok) {
        await ctx.locks.withLock(name, async () => {
          const latest = ctx.db.getAgent(name);
          if (latest && latest.state === 'resuming') {
            ctx.db.updateAgentState(name, 'failed', latest.version, {
              failedAt: new Date().toISOString(),
              failureReason: `Failed to create tmux session: ${createResult.error ?? 'unknown'}`,
            });
            ctx.db.logEvent(name, 'resume_failed', undefined, { reason: createResult.error });
          }
        });
        throw new Error(`Resume failed: could not create tmux session for "${name}": ${createResult.error ?? 'unknown'}`);
      }
    } else {
      // Session alive — write updated config profile if needed
      const personaAdapter = getAdapter(engine);
      if (personaAdapter.usesConfigProfile && systemPrompt) {
        await ctx.proxyDispatch(proxyId, {
          action: 'write_codex_profile',
          profileName: name,
          developerInstructions: systemPrompt,
        }).catch(() => {});
      }
    }

    // 4. Build and paste resume command (or spawn with new session ID if none)
    //    Use hook resolver: hookResume for existing session, hookStart for fresh spawn.
    const personaFile = resolvePersonaFilePath(name, persona);

    // 4a. Per-persona MCP allowlist (CC). Same flow as spawnAgent — re-materialise
    // on resume so persona-file edits between sessions are honoured.
    const mcpAllowlist = resolveMcpAllowlist(personaFile);
    const mcpConfigPath = mcpAllowlist !== undefined
      ? await materialiseMcpConfigForAgent(ctx, proxyId, name, cwd, mcpAllowlist)
      : undefined;

    // SESSION_ID resolution: DB currentSessionId → capturedVars.SESSION_ID → null (fresh spawn)
    const resolvedSessionId = currentSessionId
      ?? phase1.current.capturedVars?.['SESSION_ID']
      ?? null;
    const resumeTemplateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: resolvedSessionId ?? undefined,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
      capturedVars: phase1.current.capturedVars ?? undefined,
    };

    if (!currentSessionId) {
      console.log(`[lifecycle] ${name}: no stored session ID, will spawn fresh via hookStart`);
    }

    const { result: resumeResult, sessionId: resumeSessionId } = resolveResumeOrStartHook({
      adapter,
      hookResume,
      hookStart,
      agentRecord: effectiveCurrent,
      sessionId: currentSessionId,
      name,
      cwd,
      resumeTask: adapter.supportsResumePrompt ? opts?.task : undefined,
      startTask: opts?.task,
      systemPrompt,
      permissions,
      templateVars: resumeTemplateVars,
      ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
    });

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(name, phase1.current.account);
      if (home) accountHome = home;
    }

    // Wrap launch command with agent env vars
    const wrappedResume = wrapLaunchResult(resumeResult, effectiveCurrent, personaFile, accountHome);

    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedResume, { agentName: name });

    // 5. /rename injection
    await injectRename(ctx, proxyId, tmuxSession, adapter, name);

    // 6. Paste task if provided (and resuming existing session).
    // Skip if the engine consumed the task inline via buildResumeCommand.
    if (opts?.task && currentSessionId && !adapter.supportsResumePrompt) {
      await sleep(POST_RENAME_TASK_DELAY_MS);
      await ctx.proxyDispatch(proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: opts.task,
        pressEnter: true,
      });
    }

    // ── Phase 3: finalize (lock) ──
    return await finalizeToActive(ctx, name, 'resuming', 'resume_interrupted', {
      tmuxSession,
      lastActivity: new Date().toISOString(),
      stateBeforeShutdown: null,
      lastContextPct: 0,
      currentSessionId: resumeSessionId,
    }, 'resumed', { sessionId: resumeSessionId }, 'resume');
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Suspend an agent: send exit command, wait, mark as suspended.
 *
 * Phase 1: validate + transition to 'suspending'
 * Phase 2: paste exit, wait, verify session gone, optional kill
 * Phase 3: validate still 'suspending' + transition to 'suspended'
 */
export async function suspendAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<AgentRecord> {
  // ── Phase 1: validate + transition to 'suspending' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canSuspend(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", expected active or idle`);
    }
    const proxyId = requireProxy(agent);

    const current = ctx.db.updateAgentState(name, 'suspending', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return { current, proxyId, engine: agent.engine, hookExit: agent.hookExit, tmuxSession: sessionName(agent) };
  });

  const { proxyId, tmuxSession } = phase1;

  // Resolve engine config defaults beneath agent-level fields
  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const hookExit = effectiveCurrent.hookExit;

  const watchdog = startWatchdog(ctx, name, 'suspending', SUSPEND_TIMEOUT_MS, proxyId, tmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──

    // Send exit command via hook resolver
    const exitResult = resolveHook('exit', hookExit, effectiveCurrent);
    await dispatchHookResult(ctx, proxyId, tmuxSession, exitResult, { agentName: name });

    // Wait for process to exit, then verify
    await sleep(EXIT_WAIT_MS);

    // Session ID capture is now handled by capture steps in the exit pipeline.
    // If the exit hook included a capture step with var=SESSION_ID, it's already
    // stored in captured_vars and currentSessionId by dispatchHookResult.

    // Check if session is still alive — but don't kill it.
    // Preserve the tmux session so the user can inspect final state via Watch tab.
    // The session will be cleaned up on next spawn or destroy.
    const sessionGone = await ctx.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: tmuxSession,
    });
    const exited = !sessionGone.ok || sessionGone.data !== true;
    if (!exited) {
      console.log(`[lifecycle] ${name}: session still alive after exit — preserving for inspection`);
    }

    // ── Phase 3: finalize (lock) ──
    return await ctx.locks.withLock(name, async () => {
      const latest = ctx.db.getAgent(name);
      if (!latest) throw new Error(`Agent "${name}" disappeared during suspend`);

      if (latest.state !== 'suspending') {
        ctx.db.logEvent(name, 'suspend_interrupted', undefined, { finalState: latest.state });
        return latest;
      }

      const updated = ctx.db.updateAgentState(name, 'suspended', latest.version, {
        lastActivity: new Date().toISOString(),
      });
      ctx.db.logEvent(name, 'suspended');
      return updated;
    });
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Resolve the "master" persona name for a possibly-scaled-up agent.
 *
 * Resolution order:
 *   1. Explicit `derived_from: <master>` field in the agent's persona
 *      frontmatter (preferred — `scripts/scale-up.sh` writes this when
 *      cloning a base persona).
 *   2. Name-pattern stripping: `pwa-a` → `pwa` if `pwa.md` exists. Used
 *      as a fallback for older scaled personas that pre-date the
 *      `derived_from` field.
 *   3. Self-master: singletons (`tl`, `brain`, hyphenated-but-unique
 *      names like `Tridion-expert`) where nothing else matches.
 *
 * In every case, the returned name must correspond to an existing persona
 * file under `getPersonasDir()` — a `derived_from` pointing at a missing
 * persona is ignored so we don't write to a dangling memory dir.
 */
function resolveMasterPersona(name: string): string {
  const personasDir = getPersonasDir();

  // 1. Frontmatter `derived_from` (preferred path).
  const ownPath = join(personasDir, `${name}.md`);
  if (existsSync(ownPath)) {
    try {
      const raw = readFileSync(ownPath, 'utf-8');
      const { frontmatter } = parseFrontmatter(raw);
      const derived = frontmatter['derived_from'];
      if (typeof derived === 'string' && derived.length > 0 && derived !== name) {
        const derivedPath = join(personasDir, `${derived}.md`);
        if (existsSync(derivedPath)) return derived;
        console.warn(`[handoff] ${name}: derived_from='${derived}' but ${derivedPath} not found — falling back`);
      }
    } catch {
      // Frontmatter read failures are non-fatal here — fall through to step 2.
    }
  }

  // 2. Name-pattern stripping (legacy fallback for personas without derived_from).
  const dashIdx = name.lastIndexOf('-');
  if (dashIdx > 0) {
    const candidate = name.slice(0, dashIdx);
    const candidatePath = join(personasDir, `${candidate}.md`);
    if (existsSync(candidatePath)) return candidate;
  }

  // 3. Self-master.
  return name;
}

/**
 * Map a host-side project directory (e.g. `/Users/test-user/dev/project-a`)
 * to the Claude Code projects slug convention used by `~/.claude/projects/`:
 * a leading `-` followed by the absolute path with each `/` AND each `.`
 * replaced by `-`. The `.` mapping is what turns `test-user` (the host
 * username with a dot) into `test-user` in the slug.
 *
 * `/Users/test-user/dev/conductor` → `-Users-test-user-dev-conductor`
 *
 * Returns null if the input is not an absolute path.
 */
function projectMemorySlug(cwd: string): string | null {
  if (!cwd.startsWith('/')) return null;
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Best-effort mirror of the destroy handoff snapshot into the master's
 * project memory directory, where it can be picked up by future Claude
 * Code sessions of the master persona via that project's `MEMORY.md` index.
 *
 * Writes:
 *   - `<CLAUDE_PROJECTS_DIR>/<projectSlug>/memory/handoff_<name>_<ts>.md`
 *   - one-line pointer appended to `<CLAUDE_PROJECTS_DIR>/<projectSlug>/memory/MEMORY.md`
 *
 * Silently no-ops when:
 *   - `CLAUDE_PROJECTS_DIR` env is unset (test mode / operators who haven't
 *     opted in to the bind-mount)
 *   - the master persona has no resolvable cwd
 *   - the cwd is not an absolute host path
 */
function mirrorHandoffToProjectMemory(
  master: string,
  destroyedName: string,
  timestamp: string,
  body: string,
): void {
  const projectsDir = process.env['CLAUDE_PROJECTS_DIR'];
  if (!projectsDir) return;

  try {
    const masterPath = join(getPersonasDir(), `${master}.md`);
    if (!existsSync(masterPath)) return;
    const { frontmatter } = parseFrontmatter(readFileSync(masterPath, 'utf-8'));
    const cwd = frontmatter['cwd'];
    if (typeof cwd !== 'string' || cwd.length === 0) return;

    const slug = projectMemorySlug(cwd);
    if (!slug) return;

    const memoryDir = join(projectsDir, slug, 'memory');
    mkdirSync(memoryDir, { recursive: true });

    const filename = `handoff_${destroyedName}_${timestamp}.md`;
    const filePath = join(memoryDir, filename);
    const frontmatterHeader =
      `---\n` +
      `name: Handoff from ${destroyedName}\n` +
      `description: Destroy-time snapshot of ${destroyedName} (scaled from ${master}) — last tmux pane + recent dashboard messages\n` +
      `type: project\n` +
      `---\n\n`;
    writeFileSync(filePath, frontmatterHeader + body, 'utf-8');

    // Append pointer to MEMORY.md (create if missing).
    const indexPath = join(memoryDir, 'MEMORY.md');
    const isoDate = timestamp.slice(0, 4) + '-' + timestamp.slice(4, 6) + '-' + timestamp.slice(6, 8);
    const pointer = `- [Handoff: ${destroyedName}](${filename}) — ${isoDate} destroy-time snapshot for master \`${master}\`\n`;
    if (existsSync(indexPath)) {
      appendFileSync(indexPath, pointer);
    } else {
      writeFileSync(indexPath, pointer);
    }
    console.log(`[handoff] ${destroyedName}: mirrored to ${filePath}`);
  } catch (err) {
    console.warn(`[handoff] ${destroyedName}: project-memory mirror failed: ${(err as Error).message}`);
  }
}

/**
 * Build the markdown body for a destroy handoff page. Captures the agent's
 * identity, the last tmux pane snapshot, and the last 10 dashboard messages
 * so the operator (and any master persona reading the page) can see what the
 * agent was doing at the moment of teardown.
 */
function composeHandoffBody(
  agent: AgentRecord,
  master: string,
  tmuxCapture: string,
  recentMessages: DashboardMessage[],
  destroyedAt: Date,
): string {
  const lines: string[] = [];
  lines.push(`# Handoff: ${agent.name} → ${master}`);
  lines.push('');
  lines.push(`**Destroyed at:** ${destroyedAt.toISOString()}`);
  lines.push(`**Agent name:** \`${agent.name}\``);
  if (master === agent.name) {
    lines.push(`**Master:** \`${master}\` (self — singleton agent, no scale-up parent detected)`);
  } else {
    lines.push(`**Master:** \`${master}\` (derived by stripping the trailing suffix from the agent name)`);
  }
  lines.push(`**State at destroy:** ${agent.state}`);
  lines.push(`**Engine:** ${agent.engine}`);
  if (agent.cwd) lines.push(`**cwd:** \`${agent.cwd}\``);
  lines.push('');
  lines.push('## Last tmux pane capture');
  lines.push('');
  if (tmuxCapture.trim().length > 0) {
    lines.push('```');
    lines.push(tmuxCapture.trimEnd());
    lines.push('```');
  } else {
    lines.push('_(no tmux capture available — agent had no live session at destroy time)_');
  }
  lines.push('');
  lines.push('## Recent dashboard messages');
  lines.push('');
  if (recentMessages.length === 0) {
    lines.push('_(no recent dashboard messages on this agent\'s queue)_');
  } else {
    for (const msg of recentMessages) {
      const arrow = msg.direction === 'to_agent' ? '→ (incoming)' : '← (outgoing)';
      const topicLabel = msg.topic ? ` _topic: ${msg.topic}_` : '';
      lines.push(`### ${msg.createdAt} ${arrow}${topicLabel}`);
      lines.push('');
      const quoted = msg.message.split('\n').map((l) => `> ${l}`).join('\n');
      lines.push(quoted);
      lines.push('');
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '_This page was generated automatically by the orchestrator at agent-destroy time. ' +
      'It captures the last visible state of the agent so the master persona (and operator) can ' +
      'pick up where the destroyed instance left off. When `CLAUDE_PROJECTS_DIR` is configured, ' +
      'an identical snapshot is also mirrored to the master\'s project memory directory so ' +
      'future Claude Code sessions of the master pick it up via that project\'s `MEMORY.md` index._',
  );
  return lines.join('\n');
}

/**
 * Best-effort handoff snapshot at destroy time. Writes a Page at
 * `<PAGES_DIR>/handoff-<name>-<timestamp>/index.md` capturing the agent's
 * identity, last tmux pane, and recent messages. Failures here are logged
 * but never block the actual destroy — operator confirmation of teardown is
 * the contract; the handoff is a courtesy.
 *
 * If `PAGES_DIR` is unset, the handoff is skipped silently (test mode).
 */
async function captureDestroyHandoff(
  ctx: LifecycleContext,
  agent: AgentRecord,
): Promise<void> {
  const pagesDir = process.env['PAGES_DIR'];
  if (!pagesDir) return;

  try {
    const now = new Date();
    const ts =
      now.getUTCFullYear().toString() +
      String(now.getUTCMonth() + 1).padStart(2, '0') +
      String(now.getUTCDate()).padStart(2, '0') +
      '-' +
      String(now.getUTCHours()).padStart(2, '0') +
      String(now.getUTCMinutes()).padStart(2, '0') +
      String(now.getUTCSeconds()).padStart(2, '0');
    // Slug must satisfy SLUG_RE in routes.ts: ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$
    const slug = `handoff-${agent.name.toLowerCase()}-${ts}`;
    const master = resolveMasterPersona(agent.name);

    let tmuxCapture = '';
    if (agent.proxyId && agent.tmuxSession) {
      try {
        const result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'capture',
          sessionName: agent.tmuxSession,
          lines: 30,
        });
        if (result.ok && typeof result.data === 'string') {
          tmuxCapture = result.data;
        }
      } catch (err) {
        console.warn(`[handoff] ${agent.name}: tmux capture failed: ${(err as Error).message}`);
      }
    }

    let recentMessages: DashboardMessage[] = [];
    try {
      const threads = ctx.db.getDashboardThreads(agent.name);
      const all = threads[agent.name] ?? [];
      recentMessages = all.slice(-10);
    } catch (err) {
      console.warn(`[handoff] ${agent.name}: dashboard-message fetch failed: ${(err as Error).message}`);
    }

    const body = composeHandoffBody(agent, master, tmuxCapture, recentMessages, now);

    const slugDir = join(pagesDir, slug);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 'index.md'), body, 'utf-8');
    const totalBytes = Buffer.byteLength(body, 'utf-8');
    ctx.db.createPage({
      slug,
      title: `Handoff: ${agent.name} → ${master}`,
      agent: master,
      fileCount: 1,
      totalBytes,
    });
    console.log(`[handoff] Captured for ${agent.name} → /pages/${slug} (master: ${master})`);

    // Best-effort mirror to the master's project memory dir (no-op when
    // CLAUDE_PROJECTS_DIR is unset, e.g. tests or operators who haven't
    // opted in to the bind-mount).
    mirrorHandoffToProjectMemory(master, agent.name, ts, body);
  } catch (err) {
    console.warn(`[handoff] ${agent.name}: capture failed (continuing with destroy): ${(err as Error).message}`);
  }
}

/**
 * Destroy an agent: kill tmux session, remove from registry.
 * Single-phase lock — fast operation.
 *
 * Before the destructive steps, captures a handoff snapshot to
 * `/pages/handoff-<name>-<ts>/` so the operator and the agent's master
 * persona can see what the destroyed instance was doing at teardown.
 * Snapshot capture is best-effort and never blocks the destroy.
 */
export async function destroyAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);

    // Snapshot BEFORE we kill anything — once the tmux session is gone, the
    // capture would return empty.
    await captureDestroyHandoff(ctx, agent);

    if (agent.proxyId && agent.tmuxSession) {
      await ctx.proxyDispatch(agent.proxyId, {
        action: 'kill_session',
        sessionName: agent.tmuxSession,
      });
    }

    // Clean up config profile for engines that use it (e.g. Codex)
    if (agent.proxyId) {
      const adapter = getAdapter(agent.engine);
      if (adapter.usesConfigProfile) {
        await ctx.proxyDispatch(agent.proxyId, {
          action: 'remove_codex_profile',
          profileName: name,
        }).catch((err) => { console.warn('[cleanup] Config profile removal failed:', (err as Error).message); });
      }
    }

    // Delete persona file so persona sync doesn't resurrect the agent
    const personaFilename = agent.persona ?? name;
    const personaPath = join(getPersonasDir(), `${personaFilename}.md`);
    if (existsSync(personaPath)) {
      unlinkSync(personaPath);
    }

    ctx.db.deleteAgent(name);
    ctx.db.logEvent(name, 'destroyed');
  });
}

/**
 * Execute a reload: exit current session, resume with fresh context.
 *
 * Queue mode: single-phase lock, sets reloadQueued flag.
 * Immediate mode:
 *   Phase 1: validate + transition to 'suspending'
 *   Phase 2: exit, wait, kill, create fresh session, paste resume, rename, optional task
 *   Phase 3: validate still 'suspending' + transition to 'active'
 */
export async function reloadAgent(
  ctx: LifecycleContext,
  name: string,
  opts?: { immediate?: boolean; task?: string },
): Promise<AgentRecord> {
  // Queue mode: set flag and return
  if (!opts?.immediate) {
    return ctx.locks.withLock(name, async () => {
      const agent = ctx.db.getAgent(name);
      if (!agent) throw new Error(`Agent "${name}" not found`);
      if (!canSuspend(agent)) {
        throw new Error(`Agent "${name}" is in state "${agent.state}", cannot queue reload`);
      }
      const updated = ctx.db.updateAgentState(name, agent.state, agent.version, {
        reloadQueued: 1,
        reloadTask: opts?.task ?? null,
      });
      ctx.db.logEvent(name, 'reload_queued');
      return updated;
    });
  }

  // Immediate mode: three-phase
  const peers = computePeers(ctx, name);

  // ── Phase 1: validate + transition to 'suspending' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!canSuspend(agent)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", cannot reload`);
    }
    const proxyId = requireProxy(agent);

    const current = ctx.db.updateAgentState(name, 'suspending', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return {
      current,
      proxyId,
      engine: agent.engine,
      cwd: agent.cwd,
      persona: agent.persona,
      permissions: agent.permissions,
      previousContextPct: agent.lastContextPct,
      currentSessionId: agent.currentSessionId,
      spawnCount: agent.spawnCount,
      reloadTask: agent.reloadTask,
      oldTmuxSession: sessionName(agent),
      hookStart: agent.hookStart,
      hookResume: agent.hookResume,
      hookExit: agent.hookExit,
    };
  });

  const {
    proxyId, cwd, persona, previousContextPct,
    currentSessionId, spawnCount, reloadTask, oldTmuxSession,
  } = phase1;

  // Resolve engine config defaults beneath agent-level fields
  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;
  const hookResume = effectiveCurrent.hookResume;
  const hookExit = effectiveCurrent.hookExit;

  const watchdog = startWatchdog(ctx, name, 'suspending', RELOAD_TIMEOUT_MS, proxyId, oldTmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Send exit command via hook resolver
    const exitResult = resolveHook('exit', hookExit, effectiveCurrent);
    await dispatchHookResult(ctx, proxyId, oldTmuxSession, exitResult, { agentName: name });

    // 2. Wait for exit
    await sleep(EXIT_WAIT_MS);

    // Session ID capture is now handled by capture steps in the exit pipeline.

    // 3. Kill tmux session
    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: oldTmuxSession,
    });

    // 4. Compose system prompt (no proxy dependency)
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 5. Create fresh tmux session + write config profile
    const tmuxSession = `agent-${name}`;
    await createSessionAndWriteProfile(ctx, proxyId, tmuxSession, cwd, adapter, name, systemPrompt);

    const taskText = opts?.task ?? reloadTask;
    // For engines that support inline resume prompts (e.g. Codex), pass the task
    // as a positional CLI argument instead of pasting it separately into tmux.
    // This avoids Codex's unreliable multiline paste handling.
    const inlineTask = adapter.supportsResumePrompt && taskText
      ? `[orchestrator → ${name}] ${taskText}`
      : undefined;

    const personaFile = resolvePersonaFilePath(name, persona);

    // Per-persona MCP allowlist (CC). Reload is the natural place to pick up
    // mcps: edits — operator dashboards trigger reload after persona edits.
    const mcpAllowlist = resolveMcpAllowlist(personaFile);
    const mcpConfigPath = mcpAllowlist !== undefined
      ? await materialiseMcpConfigForAgent(ctx, proxyId, name, cwd, mcpAllowlist)
      : undefined;

    // Read-after-write outside lock: the exit pipeline's capture step wrote
    // capturedVars atomically via updateAgentCapturedVar (SQL UPDATE) during
    // Phase 2's dispatchHookResult. This read is intentionally outside the
    // Phase 3 lock — the captured var is already persisted, and no concurrent
    // operation clears capturedVars between exit dispatch and this point.
    const postExitAgent = ctx.db.getAgent(name);
    const existingSessionId = postExitAgent?.capturedVars?.['SESSION_ID'] ?? currentSessionId;

    const reloadTemplateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: existingSessionId ?? name,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
      capturedVars: postExitAgent?.capturedVars ?? phase1.current.capturedVars ?? undefined,
    };

    const { result: reloadResult, sessionId: reloadSessionId } = resolveResumeOrStartHook({
      adapter,
      hookResume,
      hookStart,
      agentRecord: effectiveCurrent,
      sessionId: existingSessionId,
      name,
      cwd,
      resumeTask: inlineTask,
      startTask: inlineTask,
      systemPrompt,
      permissions,
      templateVars: reloadTemplateVars,
      ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
    });

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(name, phase1.current.account);
      if (home) accountHome = home;
    }

    // Wrap launch command with agent env vars
    const wrappedReload = wrapLaunchResult(reloadResult, effectiveCurrent, personaFile, accountHome);

    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedReload, { agentName: name });

    // 6. /rename injection
    await injectRename(ctx, proxyId, tmuxSession, adapter, name);

    // 7. Paste reload task if provided (skip if already passed as inline CLI prompt)
    if (taskText && !inlineTask) {
      await sleep(POST_RENAME_TASK_DELAY_MS);
      await ctx.proxyDispatch(proxyId, {
        action: 'paste',
        sessionName: tmuxSession,
        text: `[orchestrator → ${name}] ${taskText}`,
        pressEnter: true,
      });
    }

    // ── Phase 3: finalize (lock) ──
    return await finalizeToActive(ctx, name, 'suspending', 'reload_interrupted', {
      tmuxSession: `agent-${name}`,
      reloadQueued: 0,
      reloadTask: null,
      spawnCount: spawnCount + 1,
      lastContextPct: 0,
      lastActivity: new Date().toISOString(),
      currentSessionId: reloadSessionId,
    }, 'reloaded', {
      previousContextPct,
      sessionId: reloadSessionId,
    }, 'reload');
  } finally {
    clearTimeout(watchdog);
  }
}

const RECOVER_TIMEOUT_MS = parseInt(process.env['RECOVER_TIMEOUT_MS'] ?? '60000', 10);

/**
 * Recover a failed agent by killing its old session and starting fresh.
 * Sends a reconstruction prompt that tells the agent to read its own durable
 * state (collab queue, persona, git log) rather than trying to restore the
 * ephemeral session transcript.
 *
 * Accepts agents in 'failed' state only. Three-phase locking.
 */
export async function recoverAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<AgentRecord> {
  const peers = computePeers(ctx, name);

  // ── Phase 1: validate + transition to 'spawning' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (agent.state !== 'failed') {
      throw new Error(`Agent "${name}" is in state "${agent.state}", recovery requires 'failed'`);
    }
    const proxyId = requireProxy(agent);

    const current = ctx.db.updateAgentState(name, 'spawning', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return {
      current,
      proxyId,
      cwd: agent.cwd,
      persona: agent.persona,
      spawnCount: agent.spawnCount,
      oldTmuxSession: sessionName(agent),
    };
  });

  const { proxyId, cwd, persona, spawnCount, oldTmuxSession } = phase1;

  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;

  const watchdog = startWatchdog(ctx, name, 'spawning', RECOVER_TIMEOUT_MS, proxyId, oldTmuxSession);

  try {
    // ── Phase 2: slow proxy work (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Kill old tmux session (best-effort — it may already be gone)
    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: oldTmuxSession,
    }).catch(() => {});

    // 2. Compose system prompt
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 3. Create fresh tmux session
    const tmuxSession = `agent-${name}`;
    await createSessionAndWriteProfile(ctx, proxyId, tmuxSession, cwd, adapter, name, systemPrompt);

    // 4. Build spawn command with new session ID
    const generatedSessionId = randomUUID();
    const personaFile = resolvePersonaFilePath(name, persona);
    const templateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: generatedSessionId,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
    };

    const recoveryTask = [
      'Your previous session was lost. Reconstruct your context from durable state:',
      '1. Your persona and role are already loaded via system prompt',
      `2. Check recent git activity: \`git log --oneline -20\``,
      '3. Check peer status: \`collab agents\`',
      '4. Review your recent messages: \`collab queue --limit 20\`',
      '5. Notify the operator you have recovered: \`collab send operator --topic recovery "Session recovered, reconstructing context"\`',
      'Resume your work from where you left off.',
    ].join('\n');

    // Per-persona MCP allowlist (CC) — recover path also honours mcps:.
    const mcpAllowlist = resolveMcpAllowlist(personaFile);
    const mcpConfigPath = mcpAllowlist !== undefined
      ? await materialiseMcpConfigForAgent(ctx, proxyId, name, cwd, mcpAllowlist)
      : undefined;

    const startResult = resolveHook('start', hookStart, effectiveCurrent, {
      spawnOpts: {
        name,
        cwd,
        task: recoveryTask,
        appendSystemPrompt: systemPrompt,
        dangerouslySkipPermissions: permissions === 'skip',
        sessionId: generatedSessionId,
        ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
      },
      templateVars,
    });

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(name, phase1.current.account);
      if (home) accountHome = home;
    }

    const wrappedStart = wrapLaunchResult(startResult, effectiveCurrent, personaFile, accountHome);
    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedStart, { agentName: name });

    // 5. Inject rename
    await injectRename(ctx, proxyId, tmuxSession, adapter, name);
    await sleep(POST_SPAWN_ACTIVE_DELAY_MS);

    // ── Phase 3: finalize ──
    return await finalizeToActive(ctx, name, 'spawning', 'recover_interrupted', {
      tmuxSession,
      spawnCount: spawnCount + 1,
      lastContextPct: 0,
      lastActivity: new Date().toISOString(),
      currentSessionId: generatedSessionId,
    }, 'recovered', {
      engine,
      sessionId: generatedSessionId,
      reason: 'auto-recovery from failed state',
    }, 'recover');
  } finally {
    clearTimeout(watchdog);
  }
}

const RECYCLE_TIMEOUT_MS = parseInt(process.env['RECYCLE_TIMEOUT_MS'] ?? '60000', 10);

/**
 * Recycle an agent: write a Q v1/v2 handoff snapshot, kill the existing
 * tmux session, then spawn fresh with a new SESSION_ID. The DB row and
 * persona file are preserved (in contrast to destroy).
 *
 * Sits between Reload (no context refresh — same session id via --resume)
 * and Destroy (terminal — removes the agent entirely):
 *
 *   Reload  → same SESSION_ID, persona prompt reapplied. Context preserved.
 *   Recycle → handoff snapshot + fresh SESSION_ID. Context wiped; new
 *             instance reads the snapshot via its master's MEMORY.md.
 *   Destroy → handoff snapshot + remove DB row + unlink persona file.
 *
 * Accepts agents in 'active', 'idle', or 'failed' state. Three-phase
 * locking. Reuses captureDestroyHandoff + spawn machinery.
 *
 * Foundation for Z (auto-recycle at 92% ctx) — same primitive, different
 * trigger source.
 */
export async function recycleAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<AgentRecord> {
  const peers = computePeers(ctx, name);

  // ── Phase 1: validate + transition to 'spawning' ──
  const phase1 = await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    const acceptable = new Set(['active', 'idle', 'failed']);
    if (!acceptable.has(agent.state)) {
      throw new Error(`Agent "${name}" is in state "${agent.state}", recycle requires one of: active, idle, failed`);
    }
    const proxyId = requireProxy(agent);

    const current = ctx.db.updateAgentState(name, 'spawning', agent.version, {
      lastActivity: new Date().toISOString(),
    });

    return {
      current,
      proxyId,
      cwd: agent.cwd,
      persona: agent.persona,
      spawnCount: agent.spawnCount,
      oldTmuxSession: sessionName(agent),
      agentSnapshot: agent,
    };
  });

  const { proxyId, cwd, persona, spawnCount, oldTmuxSession, agentSnapshot } = phase1;

  const engineConfig = ctx.db.getEngineConfig(phase1.current.engine);
  const effectiveCurrent = resolveEffectiveConfig(phase1.current, engineConfig);
  const engine = effectiveCurrent.engine;
  const permissions = effectiveCurrent.permissions;
  const hookStart = effectiveCurrent.hookStart;

  const watchdog = startWatchdog(ctx, name, 'spawning', RECYCLE_TIMEOUT_MS, proxyId, oldTmuxSession);

  try {
    // ── Phase 2: handoff + kill + fresh spawn (no lock) ──
    const adapter = getAdapter(engine);

    // 1. Write handoff snapshot BEFORE killing — the tmux capture would
    //    return empty once the session is gone.
    await captureDestroyHandoff(ctx, agentSnapshot);

    // 2. Kill the existing tmux session (best-effort — may already be gone
    //    if the agent was in 'failed' state).
    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: oldTmuxSession,
    }).catch(() => {});

    // 3. Compose system prompt
    const systemPrompt = buildSystemPrompt(ctx, name, peers, persona);

    // 4. Create fresh tmux session
    const tmuxSession = `agent-${name}`;
    await createSessionAndWriteProfile(ctx, proxyId, tmuxSession, cwd, adapter, name, systemPrompt);

    // 5. Build start command with new SESSION_ID
    const generatedSessionId = randomUUID();
    const personaFile = resolvePersonaFilePath(name, persona);

    // Per-persona MCP allowlist (CC). Materialise BEFORE templateVars so the
    // MCP_CONFIG_FLAGS substitution can see it (when paired with PR #21).
    const mcpAllowlist = resolveMcpAllowlist(personaFile);
    const mcpConfigPath = mcpAllowlist !== undefined
      ? await materialiseMcpConfigForAgent(ctx, proxyId, name, cwd, mcpAllowlist)
      : undefined;

    const templateVars: TemplateVars = {
      AGENT_NAME: name,
      AGENT_CWD: cwd,
      SESSION_ID: generatedSessionId,
      PERSONA_PROMPT: systemPrompt,
      PERSONA_PROMPT_FILEPATH: personaFile ?? undefined,
    };

    const recycleTask = [
      'Your previous instance was recycled to reset context. Reconstruct from durable state:',
      '1. Your persona is reloaded (system prompt + body) — re-read it.',
      `2. Recent activity: \`git log --oneline -20\``,
      '3. Peer status: \`collab agents\`',
      '4. Your last messages: \`collab queue --limit 20\`',
      `5. Handoff snapshot from the previous instance is available via the master persona's project MEMORY.md (look for \`handoff_${name}_<timestamp>.md\` pointers). Read it to recover context.`,
      'Resume your work; notify the operator if anything needs attention.',
    ].join('\n');

    const startResult = resolveHook('start', hookStart, effectiveCurrent, {
      spawnOpts: {
        name,
        cwd,
        task: recycleTask,
        appendSystemPrompt: systemPrompt,
        dangerouslySkipPermissions: permissions === 'skip',
        sessionId: generatedSessionId,
        ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
      },
      templateVars,
    });

    // Scaffold isolated HOME if agent has an account configured
    let accountHome: string | undefined;
    if (phase1.current.account && ctx.accountStore) {
      const home = ctx.accountStore.scaffoldAgentHome(name, phase1.current.account);
      if (home) accountHome = home;
    }

    const wrappedStart = wrapLaunchResult(startResult, effectiveCurrent, personaFile, accountHome);
    await dispatchHookResult(ctx, proxyId, tmuxSession, wrappedStart, { agentName: name });

    // 6. Inject /rename + brief settle
    await injectRename(ctx, proxyId, tmuxSession, adapter, name);
    await sleep(POST_SPAWN_ACTIVE_DELAY_MS);

    // ── Phase 3: finalize ──
    return await finalizeToActive(ctx, name, 'spawning', 'recycle_interrupted', {
      tmuxSession,
      spawnCount: spawnCount + 1,
      lastContextPct: 0,
      lastActivity: new Date().toISOString(),
      currentSessionId: generatedSessionId,
    }, 'recycled', {
      engine,
      sessionId: generatedSessionId,
      previousSessionId: agentSnapshot.currentSessionId ?? undefined,
    }, 'recycle');
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Interrupt an active agent: send escape keys to cancel current operation.
 * Single-phase lock — fast operation.
 */
export async function interruptAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    const proxyId = requireProxy(agent);

    // Resolve engine config defaults for hook fields
    const engineConfig = ctx.db.getEngineConfig(agent.engine);
    const effectiveAgent = resolveEffectiveConfig(agent, engineConfig);

    // Send interrupt via hook resolver
    const interruptResult = resolveHook('interrupt', effectiveAgent.hookInterrupt, effectiveAgent);
    await dispatchHookResult(ctx, proxyId, sessionName(agent), interruptResult, { keyDelay: INTERRUPT_KEY_DELAY_MS, agentName: name });

    ctx.db.logEvent(name, 'interrupted');
  });

  // Signal lifecycle op completion for cool-down coordination (Race 2 fix)
  ctx.onLifecycleOp?.(name);
}

/**
 * Send compact command to an agent.
 * Single-phase lock — fast operation.
 */
export async function compactAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    const proxyId = requireProxy(agent);

    // Resolve engine config defaults for hook fields
    const engineConfig = ctx.db.getEngineConfig(agent.engine);
    const effectiveAgent = resolveEffectiveConfig(agent, engineConfig);

    // Send compact command via hook resolver
    const compactResult = resolveHook('compact', effectiveAgent.hookCompact, effectiveAgent);
    if (compactResult.mode === 'skip') {
      console.log(`[lifecycle] ${name}: engine "${effectiveAgent.engine}" does not support compaction — skipping`);
      ctx.db.logEvent(name, 'compact_skipped', undefined, { reason: 'unsupported_engine' });
      return;
    }

    // Compact is not a launch hook — no env wrapping needed.
    // COLLAB_AGENT is already set in the tmux session env from spawn.
    await dispatchHookResult(ctx, proxyId, sessionName(agent), compactResult, { agentName: name });

    // Transition to active so the agent doesn't appear idle during compaction.
    // The health monitor will detect idle again once compaction finishes.
    if (agent.state === 'idle') {
      ctx.db.updateAgentState(name, 'active', agent.version, {
        lastActivity: new Date().toISOString(),
      });
    }

    ctx.db.logEvent(name, 'compact_requested');
  });

  // Signal lifecycle op completion for cool-down coordination (Race 2 fix)
  ctx.onLifecycleOp?.(name);
}

/**
 * Kill an agent: force-stop tmux session, mark as suspended.
 * Single-phase lock — fast operation. Works on any state (including transitional).
 */
export async function killAgent(
  ctx: LifecycleContext,
  name: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    const proxyId = requireProxy(agent);

    await ctx.proxyDispatch(proxyId, {
      action: 'kill_session',
      sessionName: sessionName(agent),
    });

    ctx.db.updateAgentState(name, 'suspended', agent.version, {
      tmuxSession: null,
      currentSessionId: null,
      lastActivity: new Date().toISOString(),
    });

    ctx.db.logEvent(name, 'killed');
  });
}

/**
 * Execute a custom button pipeline for an agent.
 * Looks up the named button in the agent's custom_buttons JSON,
 * resolves the pipeline steps, and dispatches them.
 */
export async function executeCustomButton(
  ctx: LifecycleContext,
  name: string,
  buttonName: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);

    const proxyId = requireProxy(agent);

    // Merge custom buttons: engine config defaults + agent-level overrides
    const buttons: Record<string, unknown> = {};
    const engineConfig = ctx.db.getEngineConfig(agent.engine);
    if (engineConfig?.customButtons) {
      try { Object.assign(buttons, JSON.parse(engineConfig.customButtons)); } catch {}
    }
    if (agent.customButtons) {
      try { Object.assign(buttons, JSON.parse(agent.customButtons)); } catch {}
    }

    const steps = buttons[buttonName];
    if (!steps || !Array.isArray(steps)) {
      throw new Error(`Custom button "${buttonName}" not found for agent "${name}"`);
    }

    const templateVars = {
      AGENT_NAME: name,
      AGENT_CWD: agent.cwd,
      SESSION_ID: agent.currentSessionId ?? undefined,
      capturedVars: agent.capturedVars ?? undefined,
    };
    const result = resolveHook('exit', steps as PipelineStep[], agent, { templateVars });
    await dispatchHookResult(ctx, proxyId, sessionName(agent), result, { agentName: name });

    ctx.db.logEvent(name, 'custom_button', undefined, { button: buttonName });
  });
}

/**
 * Execute an indicator action by parsing the agent's indicators JSON,
 * finding the named indicator and action, and dispatching the pipeline steps.
 */
export async function executeIndicatorAction(
  ctx: LifecycleContext,
  name: string,
  indicatorId: string,
  actionName: string,
): Promise<void> {
  await ctx.locks.withLock(name, async () => {
    const agent = ctx.db.getAgent(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    if (!agent.indicators) throw new Error(`Agent "${name}" has no indicators`);

    const proxyId = requireProxy(agent);
    let defs: Array<{ id: string; regex?: string; actions?: Record<string, unknown> }>;
    try {
      defs = JSON.parse(agent.indicators) as Array<{ id: string; regex?: string; actions?: Record<string, unknown> }>;
    } catch {
      throw new Error(`Agent "${name}" has invalid indicators JSON`);
    }

    const indicator = defs.find(d => d.id === indicatorId);
    if (!indicator) throw new Error(`Indicator "${indicatorId}" not found for agent "${name}"`);
    if (!indicator.actions) throw new Error(`Indicator "${indicatorId}" has no actions`);

    // Capture pane output and run the indicator regex to get capture groups for $N interpolation
    let match: RegExpExecArray | null = null;
    if (indicator.regex) {
      try {
        const captureResult = await ctx.proxyDispatch(proxyId, {
          action: 'capture',
          sessionName: sessionName(agent),
          lines: 50,
        });
        if (captureResult.ok && typeof captureResult.data === 'string') {
          match = new RegExp(indicator.regex).exec(captureResult.data);
        }
      } catch { /* best effort */ }
    }

    // Find the action — try exact match first, then try interpolated match
    let steps = indicator.actions[actionName] as PipelineStep[] | undefined;
    if ((!steps || !Array.isArray(steps)) && match) {
      // The action key in the DB may be $1, $2, etc. — find the matching definition key
      for (const [key, val] of Object.entries(indicator.actions)) {
        const interpolatedKey = key.replace(/\$(\d+)/g, (_m, idx) => match![parseInt(idx, 10)] ?? '');
        if (interpolatedKey === actionName && Array.isArray(val)) {
          // Interpolate $N in the pipeline steps too
          steps = (val as PipelineStep[]).map(step => {
            if (step.type === 'keystroke') return { ...step, key: step.key.replace(/\$(\d+)/g, (_m, idx) => match![parseInt(idx, 10)] ?? '') };
            if (step.type === 'shell') return { ...step, command: step.command.replace(/\$(\d+)/g, (_m, idx) => match![parseInt(idx, 10)] ?? '') };
            return step;
          });
          break;
        }
      }
    }

    if (!steps || !Array.isArray(steps)) {
      throw new Error(`Action "${actionName}" not found on indicator "${indicatorId}" for agent "${name}"`);
    }

    const templateVars = {
      AGENT_NAME: name,
      AGENT_CWD: agent.cwd,
      SESSION_ID: agent.currentSessionId ?? undefined,
      capturedVars: agent.capturedVars ?? undefined,
    };
    const result = resolveHook('exit', steps, agent, { templateVars });
    await dispatchHookResult(ctx, proxyId, sessionName(agent), result, { agentName: name });

    ctx.db.logEvent(name, 'indicator_action', undefined, { indicator: indicatorId, action: actionName });
  });
}

/**
 * Deliver a message to an agent via proxy paste, under lock.
 * Returns null on success, or an error string on failure.
 * Single-phase lock — fast operation.
 *
 * IMPORTANT: Re-reads the agent inside the lock to prevent stale record
 * delivery (Race 3). The passed `agent` parameter is only used for the
 * agent name — all other fields are read fresh inside the lock.
 */
export async function deliverToAgent(
  ctx: LifecycleContext,
  agent: AgentRecord,
  text: string,
): Promise<string | null> {
  let error: string | null = null;

  await ctx.locks.withLock(agent.name, async () => {
    try {
      // Re-read agent inside lock to prevent stale record issues (Race 3)
      // The passed agent record may have a stale proxyId or tmuxSession
      const currentAgent = ctx.db.getAgent(agent.name);
      if (!currentAgent) {
        error = `Agent "${agent.name}" no longer exists`;
        return;
      }

      const proxyId = requireProxy(currentAgent);

      // Resolve engine config defaults for hook fields
      const engineConfig = ctx.db.getEngineConfig(currentAgent.engine);
      const effectiveAgent = resolveEffectiveConfig(currentAgent, engineConfig);

      const hookResult = resolveHook('submit', effectiveAgent.hookSubmit, effectiveAgent, { task: text });
      // Wrap proxyDispatch to throw on failure so dispatchHookResult propagates errors
      const throwingCtx: LifecycleContext = {
        ...ctx,
        proxyDispatch: async (pid, cmd) => {
          const result = await ctx.proxyDispatch(pid, cmd);
          if (!result.ok) throw new Error(result.error ?? 'Proxy dispatch failed');
          return result;
        },
      };
      await dispatchHookResult(throwingCtx, proxyId, sessionName(currentAgent), hookResult, { agentName: currentAgent.name });
    } catch (err) {
      error = (err as Error).message ?? 'Unknown delivery error';
    }
  });

  return error;
}

// ── Helpers ──

/**
 * Compute peers list. Call BEFORE acquiring a lock to avoid holding
 * the lock while querying all agents.
 */
function computePeers(ctx: LifecycleContext, agentName: string): string[] {
  return ctx.db.listAgents()
    .filter((a) => a.name !== agentName && a.state !== 'void' && a.state !== 'failed')
    .map((a) => a.name);
}

/**
 * Resolve the host-side persona file path for an agent.
 * Used for launch-time COLLAB_PERSONA_FILE exports and custom hook wrappers.
 */
function resolvePersonaFilePath(name: string, persona?: string | null): string {
  const dir = getPersonasDir();
  const filename = persona ?? name;
  return toHostPath(join(dir, `${filename}.md`));
}

function buildSystemPrompt(
  ctx: LifecycleContext,
  agentName: string,
  peers: string[],
  persona?: string | null,
): string {
  // persona from DB is typically just a name (e.g. "almanac-lead"), not a path.
  // Only pass as explicit path if it looks like one; otherwise let convention resolve.
  const explicitPath = persona && (persona.includes('/') || persona.endsWith('.md')) ? persona : null;
  const personaPath = resolvePersonaPath(agentName, explicitPath);
  const personaContent = personaPath ? loadPersona(personaPath) : null;

  return composeSystemPrompt({
    agentName,
    personaContent,
    orchestratorHost: ctx.orchestratorHost,
    peers,
  });
}
