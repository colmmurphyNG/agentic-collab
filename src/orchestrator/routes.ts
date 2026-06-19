/**
 * HTTP API routes for the orchestrator.
 * Uses URLPattern for routing. No frameworks.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, rmSync, statSync, createWriteStream, createReadStream, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { renderMarkdown, wrapInHtml, DOC_PAGES } from '../docs/render.ts';
import { hostname } from 'node:os';
import type { Database } from './database.ts';
import type { WebSocketServer } from '../shared/websocket-server.ts';
import type { AgentState, DashboardMessage, DestinationRecord, EngineType, FileRecord, PendingMessage, ProxyCommand, ProxyResponse, ProxyRegistration } from '../shared/types.ts';
import type { TelegramDispatcher } from './telegram.ts';
import { sanitizeMessage, generateMessageId } from '../shared/sanitize.ts';
import { parseCron, nextFireAt as cronNextFireAt } from '../shared/cron.ts';
import { getVersion, versionsMatch } from '../shared/version.ts';
import type { LockManager } from '../shared/lock.ts';
import { getPersonasDir, parseFrontmatter, createPersonaAndAgent, syncSinglePersona, syncPersonasWithDiff, updateFrontmatterField, resolvePersonaPath, toHostPath } from './persona.ts';
import {
  spawnAgent, resumeAgent, suspendAgent, destroyAgent,
  reloadAgent, recoverAgent, recycleAgent, unwedgeAgent, interruptAgent, compactAgent, killAgent,
  executeCustomButton, executeIndicatorAction,
  type LifecycleContext,
} from './lifecycle.ts';
import { getAdapter } from './adapters/index.ts';
import { shutdownAgents, restoreAllAgents } from './network.ts';
import { UsageAggregator, renderUsageMarkdown } from './usage-aggregator.ts';
import { DroneAuditAggregator, renderAuditMarkdown } from './drone-audit.ts';
import { sessionName } from '../shared/agent-entity.ts';
import { paneEndsWithShellPrompt } from './cli-failure-patterns.ts';
import { recordTelegramInbound, getActiveTelegramRoute, maybeAutoClearOnCommPref, isCommPrefDirective, clearTelegramRoute, listTelegramRoutes, _resetTelegramRoutes } from './telegram-routing.ts';
import type { MessageDispatcher } from './message-dispatcher.ts';
import type { UsagePoller } from './usage-poller.ts';

/** Validates agent and persona names: 1-63 chars, alphanumeric start, [a-zA-Z0-9_-]. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

/**
 * Shared context injected into all route handlers.
 *
 * - db: SQLite persistence (agents, events, messages, proxies)
 * - wss: WebSocket server for real-time dashboard updates
 * - locks: Per-agent SQLite locks for lifecycle serialization
 * - proxyDispatch: Sends commands to tmux proxies (with retry)
 * - getDashboardHtml: Lazy-loaded dashboard HTML (cached after first read)
 * - orchestratorHost: Public URL for system prompts and inter-agent messaging
 * - orchestratorSecret: Shared secret for POST/DELETE auth (null = no auth)
 *
 * Lifecycle operations use makeLifecycleCtx() to extract the subset they need.
 */
export type RouteContext = {
  db: Database;
  wss: WebSocketServer;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  getDashboardHtml: () => string;
  orchestratorHost: string;
  orchestratorSecret: string | null;
  messageDispatcher: MessageDispatcher;
  usagePoller: UsagePoller;
  voiceEnabled: boolean;
  accountStore: import('./accounts.ts').AccountStore;
  pagesDir: string;
  storesDir: string;
  filesDir: string;
  telegramDispatcher: TelegramDispatcher;
};

/**
 * Resolve the proxy ID for an agent at spawn/resume time.
 * Priority: explicit body value > agent's existing proxyId > any available proxy.
 */
function resolveProxyId(ctx: RouteContext, agent: { proxyId: string | null }, bodyProxyId?: string): string {
  // 1. Explicit override from request body
  if (bodyProxyId) return bodyProxyId;

  // 2. Already assigned (e.g. from a previous spawn)
  if (agent.proxyId) return agent.proxyId;

  // 3. Fall back to any registered proxy
  const proxies = ctx.db.listProxies();
  if (proxies.length > 0) return proxies[0]!.proxyId;

  return '';
}

/**
 * Self-heal: when a proxy (re-)registers, recover any failed agents on it
 * whose tmux sessions are still alive **and** whose pane shows a live CLI
 * (not just a bare shell prompt).
 *
 * The pane check (item HH) covers the case where the tmux session was
 * recreated externally (e.g. by a tmux/proxy restart) but the CLI engine
 * was never spawned inside it — the session "exists" yet only the host
 * shell is alive. Without the check, this routine would flip the agent
 * back to `active` and the dashboard would surface a healthy state while
 * messages get delivered into a bare zsh and discarded.
 */
export async function recoverFailedAgents(ctx: RouteContext, proxyId: string): Promise<void> {
  const agents = ctx.db.listAgents().filter(
    (a) => a.proxyId === proxyId && a.state === 'failed',
  );
  if (agents.length === 0) return;

  let recovered = 0;
  for (const agent of agents) {
    const session = sessionName(agent);
    const result = await ctx.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: session,
    });

    if (!(result.ok && result.data === true)) continue;

    // Pane exists. Now verify the CLI is actually alive inside it — not
    // just a bare zsh/bash prompt left behind by a vanished CLI.
    const cap = await ctx.proxyDispatch(proxyId, {
      action: 'capture',
      sessionName: session,
      lines: 30,
    });
    if (cap.ok && typeof cap.data === 'string' && paneEndsWithShellPrompt(cap.data)) {
      // Pane exists but CLI is gone — refuse to self-heal. The agent
      // stays `failed` so the dashboard surfaces the real state and the
      // operator can decide to Recycle.
      ctx.db.logEvent(agent.name, 'self_heal_refused', undefined, {
        reason: 'tmux session alive but CLI not running (bare shell prompt)',
      });
      continue;
    }

    const current = ctx.db.getAgent(agent.name);
    if (!current || current.state !== 'failed') continue;
    ctx.db.updateAgentState(agent.name, 'active', current.version, {
      lastActivity: new Date().toISOString(),
      failedAt: null,
      failureReason: null,
    });
    ctx.db.logEvent(agent.name, 'self_healed', undefined, {
      reason: 'Proxy re-registered, tmux session alive with CLI running',
    });
    ctx.wss.broadcast(JSON.stringify({
      type: 'agent_update',
      agent: ctx.db.getAgent(agent.name),
    }));
    recovered++;
  }

  if (recovered > 0) {
    console.log(`[proxy-register] Self-healed ${recovered} agents on ${proxyId}`);
  }
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, match: URLPatternResult, ctx: RouteContext) => Promise<void>;

type Route = {
  method: string;
  pattern: URLPattern;
  handler: RouteHandler;
};

function buildRoutes(): Route[] {
  const routes: Route[] = [];
  const route = (method: string, pathname: string, handler: RouteHandler) => {
    routes.push({ method, pattern: new URLPattern({ pathname }), handler });
  };

// ── Dashboard ──

route('GET', '/dashboard', async (_req, res, _match, ctx) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
  });
  res.end(ctx.getDashboardHtml());
});

// Serve dashboard ES module assets (*.js files under src/dashboard/)
const ASSET_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8', // browser-native type stripping
  '.css': 'text/css; charset=utf-8',
};

route('GET', '/dashboard/assets/:path+', async (req, res, match) => {
  const filePath = match.pathname.groups['path'] ?? '';
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const contentType = ASSET_TYPES[ext];
  if (filePath.includes('..') || !contentType) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  try {
    const fullPath = join(import.meta.dirname!, '..', 'dashboard', filePath);
    const content = readFileSync(fullPath, 'utf-8');
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

// ── Docs ──

const DOCS_DIR = join(import.meta.dirname!, '..', 'docs');

route('GET', '/docs', async (_req, res) => {
  // Index page — redirect to quickstart
  res.writeHead(302, { location: '/docs/quickstart' });
  res.end();
});

route('GET', '/docs/:page', async (_req, res, match) => {
  const page = match.pathname.groups['page'] ?? '';
  if (page.includes('..') || !/^[a-z0-9-]+$/.test(page)) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  const mdPath = join(DOCS_DIR, `${page}.md`);
  if (!existsSync(mdPath)) {
    res.writeHead(404); res.end('Page not found'); return;
  }
  const md = readFileSync(mdPath, 'utf-8');
  const bodyHtml = renderMarkdown(md);
  const docPage = DOC_PAGES.find(p => p.slug === page);
  const title = docPage?.title ?? page;
  const html = wrapInHtml(title, bodyHtml, page);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
  });
  res.end(html);
});

// ── Usage report (OO Phase 0/1/2) ──
//
// Token-usage aggregation surfaced at /usage (HTML) + /api/usage (JSON).
// Reads Claude Code session JSONLs from the bind-mounted directory, computes
// per-agent / per-day token totals + dollar cost via per-model pricing, and
// renders a markdown report wrapped in the same HTML chrome as /docs/* pages.
// Cached in-memory with a 5-minute refresh window.

const usageAggregator = new UsageAggregator();

route('GET', '/api/usage', async (_req, res, _m, ctx) => {
  if (!authorize(ctx.orchestratorSecret, _req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const agg = await usageAggregator.aggregate();
    return json(res, 200, agg);
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
});

route('GET', '/usage', async (_req, res, _m, ctx) => {
  if (!authorize(ctx.orchestratorSecret, _req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const agg = await usageAggregator.aggregate();
    const md = renderUsageMarkdown(agg);
    const bodyHtml = renderMarkdown(md);
    const html = wrapInHtml('Usage', bodyHtml, 'usage');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Usage report failed: ${(e as Error).message}`);
  }
});

// LiteLLM spend telemetry (Phase 1 of /pages/brain-litellm-pilot). Two routes:
//   - /api/llm-spend (JSON) — per-agent spend totals + cost-table staleness
//   - /llm-spend (HTML)     — sortable table view rendered for the dashboard
// Both query the litellm-proxy /spend/keys endpoint using LITELLM_MASTER_KEY.
// 60-second in-process cache prevents thrashing the proxy DB.

type LlmSpendKeyRow = {
  api_key: string;
  key_alias: string | null;
  spend: number;
  metadata?: { agent?: string; provisioned_by?: string } | null;
  created_at?: string;
  last_used_at?: string | null;
};

type LlmSpendSnapshot = {
  generatedAt: string;
  proxyImage: string;
  costTableSnapshotDate: string | null;
  costTableAgeDays: number | null;
  totalSpend: number;
  byAgent: Array<{ agent: string; keyAlias: string; spend: number; lastUsedAt: string | null }>;
};

let _llmSpendCache: { at: number; data: LlmSpendSnapshot } | null = null;
const LLM_SPEND_CACHE_MS = 60_000;

async function fetchLlmSpend(): Promise<LlmSpendSnapshot> {
  const cached = _llmSpendCache;
  if (cached && Date.now() - cached.at < LLM_SPEND_CACHE_MS) return cached.data;

  const proxyUrl = process.env['LITELLM_PROXY_URL'] ?? 'http://litellm-proxy:8080';
  const masterKey = process.env['LITELLM_MASTER_KEY'] ?? '';
  if (!masterKey) {
    throw new Error('LITELLM_MASTER_KEY not set; cannot query litellm-proxy /spend/keys');
  }

  // Use Node fetch (Node 24 has it native).
  const resp = await fetch(`${proxyUrl}/spend/keys`, {
    headers: { Authorization: `Bearer ${masterKey}` },
  });
  if (!resp.ok) {
    throw new Error(`litellm /spend/keys returned ${resp.status} ${resp.statusText}`);
  }
  const rows = (await resp.json()) as LlmSpendKeyRow[];

  const byAgent: LlmSpendSnapshot['byAgent'] = rows
    .map((r) => ({
      agent: r.metadata?.agent ?? r.key_alias ?? r.api_key.slice(0, 16),
      keyAlias: r.key_alias ?? r.api_key.slice(0, 16),
      spend: typeof r.spend === 'number' ? r.spend : 0,
      lastUsedAt: r.last_used_at ?? null,
    }))
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = byAgent.reduce((sum, a) => sum + a.spend, 0);

  // Cost-table-staleness signal (R3 mitigation). Image SHA / version is hard-
  // pinned in docker-compose.yml — we surface that string here. The snapshot
  // date is best-effort: parsed from the LITELLM_IMAGE_SNAPSHOT_DATE env if the
  // operator has set it (recommended on each image bump); otherwise null.
  const proxyImage = process.env['LITELLM_IMAGE_TAG'] ?? 'ghcr.io/berriai/litellm:v1.89.1-stable';
  const snapshotDate = process.env['LITELLM_IMAGE_SNAPSHOT_DATE'] ?? null;
  const ageDays = snapshotDate
    ? Math.floor((Date.now() - new Date(snapshotDate).getTime()) / 86_400_000)
    : null;

  const data: LlmSpendSnapshot = {
    generatedAt: new Date().toISOString(),
    proxyImage,
    costTableSnapshotDate: snapshotDate,
    costTableAgeDays: ageDays,
    totalSpend,
    byAgent,
  };
  _llmSpendCache = { at: Date.now(), data };
  return data;
}

function renderLlmSpendMarkdown(s: LlmSpendSnapshot): string {
  const lines: string[] = [];
  lines.push('# LiteLLM spend — per-agent attribution');
  lines.push('');
  lines.push(`_Generated ${s.generatedAt}._`);
  lines.push('');
  lines.push('## Proxy + cost-table');
  lines.push('');
  lines.push(`- **Image**: \`${s.proxyImage}\``);
  if (s.costTableSnapshotDate) {
    const badge = (s.costTableAgeDays ?? 0) > 60 ? ' ⚠️ STALE — bump image' : '';
    lines.push(`- **Cost-table snapshot**: ${s.costTableSnapshotDate} (${s.costTableAgeDays} days old)${badge}`);
  } else {
    lines.push(`- **Cost-table snapshot**: unknown — set \`LITELLM_IMAGE_SNAPSHOT_DATE\` in env on next image bump`);
  }
  lines.push('');
  lines.push(`## Total spend: $${s.totalSpend.toFixed(4)}`);
  lines.push('');
  lines.push('## By agent');
  lines.push('');
  if (s.byAgent.length === 0) {
    lines.push('_No spend recorded yet — proxy is up but no calls have routed through it._');
  } else {
    lines.push('| Agent | Spend | Last used | Virtual key |');
    lines.push('|---|--:|---|---|');
    for (const a of s.byAgent) {
      const lastUsed = a.lastUsedAt ?? '_never_';
      lines.push(`| **${a.agent}** | $${a.spend.toFixed(4)} | ${lastUsed} | \`${a.keyAlias}\` |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

route('GET', '/api/llm-spend', async (req, res, _m, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const data = await fetchLlmSpend();
    return json(res, 200, data);
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
});

route('GET', '/llm-spend', async (req, res, _m, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const data = await fetchLlmSpend();
    const md = renderLlmSpendMarkdown(data);
    const bodyHtml = renderMarkdown(md);
    const html = wrapInHtml('LiteLLM Spend', bodyHtml, 'llm-spend');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`LiteLLM spend report failed: ${(e as Error).message}`);
  }
});

// PP-0 drone-offload audit surfaced at /audit (HTML) + /api/drone-audit (JSON).
// Scans the LL-0 session FTS5 index for repetitive cheap-task patterns and
// estimates the dollar savings of routing them to a Haiku-running drone
// persona. Cached in-memory with a 5-minute refresh window.

const droneAuditAggregator = new DroneAuditAggregator();

route('GET', '/api/drone-audit', async (_req, res, _m, ctx) => {
  if (!authorize(ctx.orchestratorSecret, _req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const report = await droneAuditAggregator.audit();
    return json(res, 200, report);
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
});

route('GET', '/audit', async (_req, res, _m, ctx) => {
  if (!authorize(ctx.orchestratorSecret, _req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    const report = await droneAuditAggregator.audit();
    const md = renderAuditMarkdown(report);
    const bodyHtml = renderMarkdown(md);
    const html = wrapInHtml('Drone audit', bodyHtml, 'audit');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Drone audit failed: ${(e as Error).message}`);
  }
});

// ── Agent CRUD ──

route('GET', '/api/agents', async (_req, res, _match, ctx) => {
  const agents = ctx.db.listAgents();
  json(res, 200, agents);
});

route('GET', '/api/agents/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) return json(res, 404, { error: 'Agent not found' });
  json(res, 200, agent);
});

route('POST', '/api/agents', async (req, res, _match, ctx) => {
  const body = await readJson<{
    name?: string;
    cwd?: string;
    engine?: string;
    model?: string;
    thinking?: string;
    permissions?: string;
    proxyId?: string;
    group?: string;
  }>(req);
  if (!body.name || !body.cwd) {
    return json(res, 400, { error: 'name, cwd required' });
  }

  const nameError = validateAgentName(body.name);
  if (nameError) return json(res, 400, { error: nameError });

  const resolvedEngine = body.engine;
  if (!resolvedEngine) {
    return json(res, 400, { error: 'engine is required' });
  }

  const VALID_ENGINES = new Set(['claude', 'codex', 'opencode']);
  if (!VALID_ENGINES.has(resolvedEngine)) {
    return json(res, 400, { error: 'engine must be claude, codex, or opencode' });
  }

  const existing = ctx.db.getAgent(body.name);
  if (existing) return json(res, 409, { error: 'Agent already exists' });

  const agent = ctx.db.createAgent({
    name: body.name,
    engine: resolvedEngine as EngineType,
    model: body.model,
    thinking: body.thinking,
    cwd: body.cwd,
    persona: body.name,
    permissions: body.permissions,
    proxyId: body.proxyId,
    agentGroup: body.group,
  });

  // Write persona file so agent config persists across restarts
  try {
    const fmLines: string[] = [];
    if (body.engine) fmLines.push(`engine: ${body.engine}`);
    if (body.model) fmLines.push(`model: ${body.model}`);
    if (body.thinking) fmLines.push(`thinking: ${body.thinking}`);
    fmLines.push(`cwd: ${body.cwd}`);
    if (body.permissions) fmLines.push(`permissions: ${body.permissions}`);
    if (body.group) fmLines.push(`group: ${body.group}`);
    const content = `---\n${fmLines.join('\n')}\n---\n`;
    const dir = getPersonasDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${body.name}.md`), content, 'utf-8');
  } catch (err) {
    // Non-fatal — agent is created in DB even if persona file write fails
    console.warn(`[routes] Failed to write persona file for ${body.name}: ${(err as Error).message}`);
  }

  ctx.db.logEvent(agent.name, 'created');
  broadcastAgentUpdate(ctx, agent.name);
  json(res, 201, agent);
});

route('DELETE', '/api/agents/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) return json(res, 404, { error: 'Agent not found' });

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
  try { unlinkSync(personaPath); } catch { /* file may not exist */ }

  ctx.db.deleteAgent(name);
  ctx.db.logEvent(name, 'destroyed');
  ctx.wss.broadcast(JSON.stringify({ type: 'agent_destroyed', name }));
  json(res, 200, { ok: true });
});

// ── Agent Messaging ──

route('POST', '/api/agents/send', async (req, res, _match, ctx) => {
  const body = await readJson<{
    from?: string;
    to?: string;
    message?: string;
    topic?: string;
    replyReminder?: number | boolean;
  }>(req);
  if (!body.from || !body.to || !body.message || !body.topic) {
    return json(res, 400, { error: 'from, to, message, topic required' });
  }

  const target = ctx.db.getAgent(body.to);
  if (!target) return json(res, 404, { error: `Target agent "${body.to}" not found` });
  if (target.state === 'void') {
    return json(res, 400, { error: `Target agent "${body.to}" is in void state (not spawned). Spawn it first with: collab spawn ${body.to}` });
  }

  const messageId = generateMessageId();
  const sanitized = sanitizeMessage(body.message);
  const topicStr = body.topic;

  // Format envelope with topic
  const envelope = buildReplyEnvelope(body.from, topicStr, sanitized);

  // Enqueue for async delivery
  const pending = ctx.db.enqueueMessage({
    sourceAgent: body.from,
    targetAgent: body.to,
    envelope,
  });

  // Store in dashboard_messages for sender thread (from_agent direction — agent sent it)
  const senderMsg = ctx.db.addDashboardMessage(body.from, 'from_agent', sanitized, {
    topic: topicStr,
    sourceAgent: body.from,
    targetAgent: body.to,
  });
  ctx.db.linkDashboardMessageToQueue(senderMsg.id, pending.id);

  // Store in dashboard_messages for receiver thread (to_agent direction — message going to agent)
  const receiverMsg = ctx.db.addDashboardMessage(body.to, 'to_agent', sanitized, {
    topic: topicStr,
    sourceAgent: body.from,
    targetAgent: body.to,
  });
  ctx.db.linkDashboardMessageToQueue(receiverMsg.id, pending.id);

  // Log routing events
  ctx.db.logEvent(body.from, 'message_queued', messageId, { to: body.to, queueId: pending.id });
  ctx.db.logEvent(body.to, 'message_queued', messageId, { from: body.from, queueId: pending.id });

  // Broadcast both messages + queue update to dashboard
  const linkedSenderMsg = { ...senderMsg, queueId: pending.id, deliveryStatus: 'pending' };
  const linkedReceiverMsg = { ...receiverMsg, queueId: pending.id, deliveryStatus: 'pending' };
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg: linkedSenderMsg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg: linkedReceiverMsg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  // Auto-create reply reminder if requested
  if (body.replyReminder) {
    const cadence = typeof body.replyReminder === 'number' ? body.replyReminder : 30;
    const prompt = `[reply-reminder] topic: ${topicStr} | from: ${body.from} | "${sanitized}" — Please respond if you haven't already.`;
    ctx.db.createReminder({ agentName: body.to, createdBy: body.from, prompt, cadenceMinutes: Math.max(cadence, 5) });
  }

  // Event-driven delivery — attempt immediately, don't block response
  ctx.messageDispatcher.tryDeliver(body.to).catch((err) => {
    console.error(`[routes] Immediate delivery failed for ${body.to}:`, (err as Error).message);
  });

  json(res, 202, { ok: true, messageId, queueId: pending.id, status: 'pending' });
});

// ── Dashboard Messages ──

route('POST', '/api/dashboard/send', async (req, res, _match, ctx) => {
  const body = await readJson<{
    agent?: string;
    message?: string;
    topic?: string;
    replyReminder?: number | boolean;
  }>(req);
  if (!body.agent || !body.message || !body.topic) {
    return json(res, 400, { error: 'agent, message, topic required' });
  }

  const agent = ctx.db.getAgent(body.agent);
  if (!agent) return json(res, 404, { error: `Agent "${body.agent}" not found` });

  const sanitized = sanitizeMessage(body.message);
  const topicStr = body.topic;
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((id: unknown) => typeof id === 'string') : undefined;

  // Auto-clear Telegram routes if the operator is signalling they're at
  // the dashboard now (or otherwise telling agents to stop notifying).
  // Pairs with _default.md §12 — silent compliance gets replaced by
  // immediate state cleanup.
  maybeAutoClearOnCommPref(sanitized, 'dashboard send');

  const envelope = buildReplyEnvelope('dashboard', topicStr, sanitized);
  const { msg, pending } = enqueueAndDeliver(ctx, {
    agentName: body.agent,
    displayMessage: sanitized,
    envelope,
    topic: topicStr,
    sourceAgent: 'dashboard',
    targetAgent: body.agent,
    queueSourceAgent: null,
    fileIds,
  });

  // Auto-create reply reminder if requested
  if (body.replyReminder) {
    const cadence = typeof body.replyReminder === 'number' ? body.replyReminder : 30;
    const prompt = `[reply-reminder] topic: ${topicStr} | from: dashboard | "${sanitized}" — Please respond if you haven't already.`;
    ctx.db.createReminder({ agentName: body.agent, createdBy: 'dashboard', prompt, cadenceMinutes: Math.max(cadence, 5) });
  }

  json(res, 202, { ok: true, msg, queueId: pending.id, status: 'pending' });
});

route('POST', '/api/dashboard/upload', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agentName = url.searchParams.get('agent');
  const filename = url.searchParams.get('filename');
  const userMessage = url.searchParams.get('message');

  if (!agentName || !filename) {
    return json(res, 400, { error: 'agent and filename query params required' });
  }

  // Defense-in-depth filename validation (proxy also validates)
  if (!filename || filename.includes('/') || filename.includes('\\') ||
      filename === '.' || filename === '..' ||
      filename.includes('\0') || filename.length > 255 ||
      /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..+)?$/i.test(filename)) {
    return json(res, 400, { error: 'Invalid filename' });
  }

  const agent = ctx.db.getAgent(agentName);
  if (!agent) return json(res, 404, { error: 'Agent not found' });
  if (!agent.proxyId) return json(res, 400, { error: 'Agent has no proxy' });

  const proxy = ctx.db.getProxy(agent.proxyId);
  if (!proxy) return json(res, 500, { error: 'Proxy not found' });

  // Stream file to proxy's /upload endpoint — no buffering
  const proxyUrl = new URL('/upload', `http://${proxy.host}`);
  proxyUrl.searchParams.set('cwd', agent.cwd);
  proxyUrl.searchParams.set('filename', filename);

  type UploadProxyResult = { ok: boolean; data?: { path?: string; size?: number }; error?: string };
  const proxyResult = await new Promise<UploadProxyResult>((resolve) => {
    let settled = false;
    const settle = (result: UploadProxyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const proxyReq = httpRequest(proxyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-proxy-token': proxy.token,
        ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}),
      },
    }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', (chunk: Buffer) => { body += chunk; });
      proxyRes.on('error', (err: Error) => settle({ ok: false, error: err.message }));
      proxyRes.on('end', () => {
        try { settle(JSON.parse(body)); }
        catch { settle({ ok: false, error: 'Invalid proxy response' }); }
      });
    });

    proxyReq.on('error', (err: Error) => {
      if (!settled) req.destroy();
      settle({ ok: false, error: err.message });
    });

    // Stream with backpressure via pipeline — handles flow control and cleanup
    pipeline(req, proxyReq).catch((err) => {
      settle({ ok: false, error: (err as Error).message });
    });
  });

  if (!proxyResult.ok) {
    return json(res, 500, { error: proxyResult.error ?? 'File write failed' });
  }

  const writtenPath = proxyResult.data?.path ?? `${agent.cwd}/${filename}`;
  const fileSize = proxyResult.data?.size ?? 0;

  // Enqueue agent notification through existing pipeline
  const uploadNotice = `I uploaded ${writtenPath}`;
  const agentMessage = userMessage ? `${userMessage}\n\n${uploadNotice}` : uploadNotice;
  const envelope = buildReplyEnvelope('dashboard', 'file-upload', sanitizeMessage(agentMessage));
  const displayMessage = userMessage
    ? `${userMessage}\n\nUploaded ${filename} (${formatBytes(fileSize)})`
    : `Uploaded ${filename} (${formatBytes(fileSize)})`;

  const { msg, pending } = enqueueAndDeliver(ctx, {
    agentName,
    displayMessage,
    envelope,
    topic: 'file-upload',
    sourceAgent: 'dashboard',
    targetAgent: agentName,
    queueSourceAgent: null,
    broadcastLinked: false,
  });

  json(res, 202, { ok: true, msg, queueId: pending.id, path: writtenPath, size: fileSize });
});

route('POST', '/api/dashboard/reply', async (req, res, _match, ctx) => {
  const body = await readJson<{
    agent?: string;
    message?: string;
    topic?: string;
  }>(req);
  if (!body.agent || !body.message || !body.topic) {
    return json(res, 400, { error: 'agent, message, topic required' });
  }

  const sanitized = sanitizeMessage(body.message);
  const msg = ctx.db.addDashboardMessage(body.agent, 'from_agent', sanitized, { topic: body.topic, sourceAgent: body.agent });

  // Broadcast to dashboard WebSocket
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg }));

  // Auto-forward to Telegram when the operator is on remote (i.e. an inbound
  // Telegram message has been delivered to this agent within the TTL window).
  // Without this, the agent's reply lands on the dashboard only, and an
  // operator on Telegram sees nothing back. Fire-and-forget — failures are
  // logged but don't fail the reply. See telegram-routing.ts for design.
  const route = getActiveTelegramRoute(body.agent);
  if (route) {
    const dest = ctx.db.getDestination(route.destName);
    if (dest && dest.enabled && dest.type === 'telegram') {
      const botToken = dest.config['botToken'] as string;
      const text = `[${body.agent}] ${sanitized}`;
      ctx.telegramDispatcher.send(botToken, route.chatId, text).then((ok) => {
        if (ok) {
          console.log(`[telegram-routing] Auto-forwarded ${body.agent} reply to chat ${route.chatId} (dest=${route.destName})`);
        }
      }).catch((err) => {
        console.error(`[telegram-routing] Auto-forward failed for ${body.agent}:`, (err as Error).message);
      });
    }
  }

  json(res, 200, { ok: true, msg });
});

route('GET', '/api/dashboard/threads', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agent = url.searchParams.get('agent') ?? undefined;
  const threads = ctx.db.getDashboardThreads(agent);
  json(res, 200, threads);
});

route('GET', '/api/dashboard/messages/search', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json(res, 400, { error: 'q (search query) required' });
  const agent = url.searchParams.get('agent') || undefined;
  const results = ctx.db.searchMessages(q, agent);
  json(res, 200, results);
});

route('PUT', '/api/dashboard/read-cursor', async (req, res, _match, ctx) => {
  const body = await readJson<{ agent?: string }>(req);
  if (!body.agent || typeof body.agent !== 'string') {
    return json(res, 400, { error: 'agent (string) required' });
  }
  ctx.db.updateReadCursor(body.agent);
  json(res, 200, { ok: true });
});

route('POST', '/api/dashboard/messages/:id/withdraw', async (_req, res, match, ctx) => {
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid message ID' });

  const msg = ctx.db.getDashboardMessageById(id);
  if (!msg) return json(res, 404, { error: 'Message not found' });
  if (msg.direction !== 'to_agent') return json(res, 400, { error: 'Can only withdraw outgoing messages' });
  if (msg.withdrawn) return json(res, 400, { error: 'Message already withdrawn' });

  // Cancel pending delivery if not yet delivered
  if (msg.queueId) {
    ctx.db.cancelPendingMessage(msg.queueId);
  }

  // Mark the original message as withdrawn
  ctx.db.withdrawMessage(id);

  // Broadcast withdrawal of the original message before sending the notice
  const updatedOriginal = ctx.db.getDashboardMessageById(id)!;
  ctx.wss.broadcast(JSON.stringify({ type: 'message_withdrawn', msg: updatedOriginal }));

  // Send a follow-up withdrawal notice to the agent
  const withdrawalText = `[system] the user withdrew this message: "${msg.message}"`;
  const envelope = buildReplyEnvelope('dashboard', msg.topic ?? 'system', sanitizeMessage(withdrawalText));
  const { linkedMsg: linkedWithdrawMsg } = enqueueAndDeliver(ctx, {
    agentName: msg.agent,
    displayMessage: withdrawalText,
    envelope,
    topic: msg.topic ?? 'system',
    sourceAgent: 'dashboard',
    targetAgent: msg.agent,
    queueSourceAgent: null,
  });

  json(res, 200, { ok: true, withdrawnMsg: updatedOriginal, noticeMsg: linkedWithdrawMsg });
});

// ── Proxy Registration ──

route('POST', '/api/proxy/register', async (req, res, _match, ctx) => {
  const body = await readJson<{
    proxyId?: string;
    token?: string;
    host?: string;
    version?: string;
  }>(req);
  if (!body.proxyId || !body.token || !body.host) {
    return json(res, 400, { error: 'proxyId, token, host required' });
  }

  const proxyVersion = typeof body.version === 'string' ? body.version : undefined;
  const proxy = ctx.db.registerProxy(body.proxyId, body.token, body.host, proxyVersion);

  // Compute version match and enrich the response
  const orchestratorVersion = getVersion();
  const versionMatch = !!proxyVersion && versionsMatch(proxyVersion, orchestratorVersion);
  const enriched: ProxyRegistration = { ...proxy, versionMatch };

  if (proxyVersion && !versionMatch) {
    console.warn(`[proxy-register] Version mismatch: proxy "${body.proxyId}" is ${proxyVersion}, orchestrator is ${orchestratorVersion}`);
  }

  broadcastProxyUpdate(ctx);
  json(res, 200, { ...enriched, orchestratorVersion });

  // Self-heal: recover failed agents on this proxy whose tmux sessions survived
  recoverFailedAgents(ctx, body.proxyId).catch((err) => {
    console.error(`[proxy-register] Recovery failed for ${body.proxyId}:`, err);
  });
});

route('POST', '/api/proxy/heartbeat', async (req, res, _match, ctx) => {
  const body = await readJson<{ proxyId?: string }>(req);
  if (!body.proxyId) return json(res, 400, { error: 'proxyId required' });

  const updated = ctx.db.updateProxyHeartbeat(body.proxyId);
  if (!updated) return json(res, 404, { error: 'Proxy not registered' });

  json(res, 200, { ok: true });
});

route('DELETE', '/api/proxy/:proxyId', async (_req, res, match, ctx) => {
  const proxyId = match.pathname.groups['proxyId']!;
  const removed = ctx.db.removeProxy(proxyId);
  if (!removed) return json(res, 404, { error: 'Proxy not found' });
  broadcastProxyUpdate(ctx);
  json(res, 200, { ok: true });
});

route('GET', '/api/proxies', async (_req, res, _match, ctx) => {
  const proxies = enrichProxiesWithVersionMatch(ctx.db.listProxies());
  json(res, 200, proxies);
});

// ── Events ──

route('GET', '/api/events/:agentName', async (req, res, match, ctx) => {
  const agentName = match.pathname.groups['agentName']!;
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 10000) : 50;
  const events = ctx.db.getEvents(agentName, limit);
  json(res, 200, events);
});

// ── Message Queue ──

route('GET', '/api/queue', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agent = url.searchParams.get('agent') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const limit = parseInt(url.searchParams.get('limit') ?? '', 10) || undefined;
  const messages = ctx.db.listPendingMessages(agent, status, limit);
  json(res, 200, messages);
});

// ── Agent Files ──

route('GET', '/api/agents/:name/files', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) return json(res, 404, { error: 'Agent not found' });
  if (!agent.cwd) return json(res, 400, { error: 'Agent has no working directory' });
  if (!agent.proxyId) return json(res, 400, { error: 'Agent has no proxy' });

  try {
    const result = await ctx.proxyDispatch(agent.proxyId, {
      action: 'exec',
      command: `find . -maxdepth 1 -not -name '.' -printf '%T@\\t%s\\t%y\\t%f\\n' 2>/dev/null | sort -rn | head -100`,
      cwd: agent.cwd,
      timeoutMs: 5000,
    } as any);
    if (!result.ok) return json(res, 500, { error: 'Failed to list files' });

    const files = (result.data as string).split('\n').filter(Boolean).map(line => {
      const [mtime, size, type, ...nameParts] = line.split('\t');
      return {
        name: nameParts.join('\t'),
        size: parseInt(size ?? '0', 10),
        isDir: type === 'd',
        modified: new Date(parseFloat(mtime ?? '0') * 1000).toISOString(),
      };
    });
    json(res, 200, { cwd: agent.cwd, files });
  } catch {
    json(res, 500, { error: 'Failed to list files' });
  }
});

// ── Engine Configs ──

route('GET', '/api/engine-configs', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listEngineConfigs());
});

route('GET', '/api/engine-configs/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const config = ctx.db.getEngineConfig(name);
  if (!config) return json(res, 404, { error: 'Engine config not found' });
  json(res, 200, config);
});

route('POST', '/api/engine-configs', async (req, res, _match, ctx) => {
  const body = await readJson<{ name?: string; engine?: string }>(req);
  if (!body.name || !body.engine) return json(res, 400, { error: 'name and engine required' });
  try {
    ctx.db.createEngineConfig(body as Parameters<typeof ctx.db.createEngineConfig>[0]);
    const config = ctx.db.getEngineConfig(body.name);
    ctx.wss.broadcast(JSON.stringify({ type: 'engine_config_update', config }));
    json(res, 201, config);
  } catch (err) {
    json(res, 409, { error: 'Engine config already exists' });
  }
});

route('PUT', '/api/engine-configs/:name', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson(req);
  const updated = ctx.db.updateEngineConfig(name, body as Parameters<typeof ctx.db.updateEngineConfig>[1]);
  if (!updated) return json(res, 404, { error: 'Engine config not found' });
  const config = ctx.db.getEngineConfig(name);
  ctx.wss.broadcast(JSON.stringify({ type: 'engine_config_update', config }));
  json(res, 200, config);
});

route('DELETE', '/api/engine-configs/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  // Check if any agents use this engine (engine field is the config lookup key)
  const agents = ctx.db.listAgents();
  const refs = agents.filter(a => a.engine === name);
  if (refs.length > 0) {
    return json(res, 409, { error: `Cannot delete: ${refs.length} agent(s) use engine "${name}"` });
  }
  const deleted = ctx.db.deleteEngineConfig(name);
  if (!deleted) return json(res, 404, { error: 'Engine config not found' });
  ctx.wss.broadcast(JSON.stringify({ type: 'engine_config_deleted', name }));
  json(res, 200, { ok: true });
});

route('POST', '/api/engine-configs/reset-defaults', async (_req, res, _match, ctx) => {
  const { DEFAULT_ENGINE_CONFIGS } = await import('./default-engine-configs.ts');
  const results: string[] = [];
  for (const config of DEFAULT_ENGINE_CONFIGS) {
    const existing = ctx.db.getEngineConfig(config.name);
    if (existing) {
      // Delete and recreate to clear stale fields not in the new defaults
      ctx.db.deleteEngineConfig(config.name);
    }
    ctx.db.createEngineConfig(config);
    results.push(existing ? `reset: ${config.name}` : `created: ${config.name}`);
  }
  const configs = ctx.db.listEngineConfigs();
  ctx.wss.broadcast(JSON.stringify({ type: 'init', engineConfigs: configs }));
  json(res, 200, { ok: true, results });
});

// ── Preferences (dashboard prefs, item MM — server-side so they survive
//    localStorage origin partitioning across port/host changes) ──

route('GET', '/api/preferences', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listPreferences());
});

route('PUT', '/api/preferences', async (req, res, _match, ctx) => {
  const body = await readJson<Record<string, unknown>>(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(res, 400, { error: 'body must be a JSON object of key→value pairs' });
  }
  ctx.db.setPreferences(body);
  json(res, 200, ctx.db.listPreferences());
});

route('DELETE', '/api/preferences/:key', async (_req, res, match, ctx) => {
  const key = match.pathname.groups['key']!;
  const deleted = ctx.db.deletePreference(key);
  if (!deleted) return json(res, 404, { error: 'Preference not found' });
  json(res, 200, { ok: true });
});

// ── Pages (static hosting) ──

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const MAX_PAGE_BYTES = 50 * 1024 * 1024; // 50 MB

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.xml': 'application/xml',
  '.md': 'text/markdown',
};

function pageMime(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** Wrap rendered markdown in a minimal, readable HTML page (no docs nav). */
function wrapMarkdownPage(title: string, bodyHtml: string, baseHref?: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // <base href> makes relative links in markdown (e.g. `[X](X.md)` references
  // to sibling files inside a bundle) resolve against the bundle's URL
  // rather than the browser's current URL. Without this, opening
  // `/pages/<slug>` and clicking `[X](X.md)` resolves to `/pages/X.md` — a 404
  // — because the browser drops the last URL segment when resolving the
  // relative href. Only injected when the caller supplies a baseHref;
  // generated index pages (which have no relative links) skip it.
  const baseTag = baseHref ? `\n  <base href="${esc(baseHref)}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">${baseTag}
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { max-width: 820px; margin: 2rem auto; padding: 0 1.25rem;
           font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
           color: #1f2328; background: #fff; }
    @media (prefers-color-scheme: dark) {
      body { color: #e6edf3; background: #0d1117; }
      a { color: #58a6ff; }
      code, pre { background: #161b22 !important; }
      table th, table td { border-color: #30363d !important; }
      hr { border-color: #30363d !important; }
    }
    h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 0.5em; line-height: 1.25; }
    h1 { font-size: 2em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
    p, ul, ol, table, pre { margin: 0.8em 0; }
    a { color: #0969da; }
    code { background: #f6f8fa; padding: 0.2em 0.4em; border-radius: 3px; font-size: 85%;
           font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
    pre { background: #f6f8fa; padding: 1em; border-radius: 6px; overflow-x: auto; }
    pre code { background: transparent; padding: 0; font-size: 100%; }
    table { border-collapse: collapse; }
    table th, table td { border: 1px solid #d0d7de; padding: 6px 12px; }
    table th { background: #f6f8fa; font-weight: 600; }
    blockquote { border-left: 4px solid #d0d7de; margin: 1em 0; padding: 0 1em; color: #656d76; }
    hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
    img { max-width: 100%; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/** Render a .md file as a full HTML page using the existing renderMarkdown utility. */
function serveMarkdownAsHtml(res: ServerResponse, filePath: string, title: string, baseHref?: string): void {
  const md = readFileSync(filePath, 'utf-8');
  const bodyHtml = renderMarkdown(md);
  const html = wrapMarkdownPage(title, bodyHtml, baseHref);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

/** Recursively count files and total bytes in a directory. */
function dirStats(dir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0, totalBytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirStats(p);
      fileCount += sub.fileCount;
      totalBytes += sub.totalBytes;
    } else {
      fileCount++;
      totalBytes += statSync(p).size;
    }
  }
  return { fileCount, totalBytes };
}

// Publish a page: POST /api/pages?slug=<slug>&agent=<agent>&title=<title>
// Body: tar stream (extracted to pages/<slug>/) OR single file with &filename=<name>
route('POST', '/api/pages', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const slug = url.searchParams.get('slug');
  const agent = url.searchParams.get('agent') ?? null;
  const title = url.searchParams.get('title') ?? null;

  if (!slug || !SLUG_RE.test(slug)) return json(res, 400, { error: 'Invalid slug (kebab-case, 2-64 chars)' });

  const pageDir = join(ctx.pagesDir, slug);
  const filename = url.searchParams.get('filename');

  // Collect body
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > MAX_PAGE_BYTES) return json(res, 413, { error: `Page exceeds ${MAX_PAGE_BYTES / 1024 / 1024}MB limit` });
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  if (filename) {
    // Single file upload
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, filename), body);
  } else {
    // Tar stream — extract using node:child_process
    mkdirSync(pageDir, { recursive: true });
    const { execSync } = await import('node:child_process');
    try {
      execSync('tar xf -', { input: body, cwd: pageDir, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return json(res, 400, { error: 'Failed to extract tar: ' + (err as Error).message });
    }
  }

  const stats = dirStats(pageDir);
  const page = ctx.db.createPage({ slug, title, agent: agent ?? undefined, fileCount: stats.fileCount, totalBytes: stats.totalBytes });
  ctx.wss.broadcast(JSON.stringify({ type: 'pages_update', pages: ctx.db.listPages() }));
  json(res, 201, page);
});

route('GET', '/api/pages', async (req, res, _match, ctx) => {
  // Optional ?archived=true to list archived pages instead of active ones.
  // Default (no param or archived=false) returns active pages — preserves the
  // existing contract for callers that don't know about the archived flag.
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const archived = url.searchParams.get('archived') === 'true';
  json(res, 200, ctx.db.listPages({ archived }));
});

/**
 * Archive or unarchive a published page.
 *
 * The page's files stay on disk under pagesDir/<slug>/ — only the DB flag
 * changes. Archived pages are hidden from the default GET /api/pages listing
 * but remain reachable via GET /pages/<slug> (callers with the direct URL
 * can still view).
 *
 * Body: { archived?: boolean }   — defaults to true (archive) if omitted.
 *
 * Returns: { ok: true, slug, archived } on success, 404 if the slug is unknown.
 */
route('POST', '/api/pages/:slug/archive', async (req, res, match, ctx) => {
  const slug = match.pathname.groups['slug']!;
  const body = await readJson<{ archived?: boolean }>(req);
  const archived = body.archived === undefined ? true : !!body.archived;

  const existing = ctx.db.getPage(slug);
  if (!existing) return json(res, 404, { error: 'Page not found' });

  const updated = ctx.db.setPageArchived(slug, archived);
  if (!updated) return json(res, 404, { error: 'Page not found' });

  // Broadcast the active pages list so dashboards refresh.
  ctx.wss.broadcast(JSON.stringify({ type: 'pages_update', pages: ctx.db.listPages() }));
  json(res, 200, { ok: true, slug, archived });
});

route('DELETE', '/api/pages/:slug', async (_req, res, match, ctx) => {
  const slug = match.pathname.groups['slug']!;
  const pageDir = join(ctx.pagesDir, slug);
  if (existsSync(pageDir)) rmSync(pageDir, { recursive: true });
  const deleted = ctx.db.deletePage(slug);
  if (!deleted) return json(res, 404, { error: 'Page not found' });
  ctx.wss.broadcast(JSON.stringify({ type: 'pages_update', pages: ctx.db.listPages() }));
  json(res, 200, { ok: true });
});

// Public page serving (no auth)
route('GET', '/pages/:slug', async (_req, res, match, ctx) => {
  const slug = match.pathname.groups['slug']!;
  const pageDir = join(ctx.pagesDir, slug);
  const indexHtmlPath = join(pageDir, 'index.html');
  const indexMdPath = join(pageDir, 'index.md');

  // Prefer index.html (backward-compatible with existing pages).
  if (existsSync(indexHtmlPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync(indexHtmlPath));
    return;
  }
  // Fall back to index.md, rendered as HTML.
  // baseHref is the trailing-slash form of the bundle URL so relative
  // links in markdown (e.g. `[X](X.md)` references to sibling files in
  // the same bundle) resolve correctly when the user is browsing
  // `/pages/<slug>` without a trailing slash.
  if (existsSync(indexMdPath)) {
    serveMarkdownAsHtml(res, indexMdPath, slug, `/pages/${slug}/`);
    return;
  }
  // No index — list files (or single-file fallback).
  if (!existsSync(pageDir)) return json(res, 404, { error: 'Page not found' });
  const files = readdirSync(pageDir);
  if (files.length === 1) {
    const filePath = join(pageDir, files[0]!);
    if (filePath.toLowerCase().endsWith('.md')) {
      serveMarkdownAsHtml(res, filePath, `${slug}/${files[0]}`, `/pages/${slug}/`);
      return;
    }
    res.writeHead(200, { 'Content-Type': pageMime(filePath) });
    res.end(readFileSync(filePath));
    return;
  }
  // Hide macOS resource-fork sidecar files (._*) and hidden dotfiles from the listing.
  const visibleFiles = files.filter(f => !f.startsWith('.') && !f.startsWith('._'));
  const links = visibleFiles.map(f => `<li><a href="/pages/${slug}/${f}">${f}</a></li>`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html><html><head><title>${slug}</title></head><body><h1>${slug}</h1><ul>${links}</ul></body></html>`);
});

// ── Scratch render (item R) ──
//
// Read-only renderer for ad-hoc markdown files under each whitelisted
// project's `scratch/` directory. Lets the operator + agents view draft
// docs (PR bodies, RCA drafts, ticket investigations) without going
// through `collab publish` and polluting the pages index.
//
// Auth-gated by default — scratch frequently contains unfinished WIP
// material. Returns 401 when ORCHESTRATOR_SECRET is set and the
// request lacks a valid Bearer token. When the secret is unset (dev
// mode) the routes are public, matching the rest of the orchestrator.
//
// Whitelist via PROJECT_RENDER_ROOTS env var (comma-separated absolute
// paths). The basename of each entry becomes the URL segment, e.g.
//   PROJECT_RENDER_ROOTS=/host-projects/project-a,/host-projects/project-b
//   → /scratch/project-a/<rel-path>, /scratch/project-b/<rel-path>
//
// Security:
//   - Path-traversal `..` rejected before resolving.
//   - realpathSync + prefix check rejects symlink escape.
//   - Only `.md` files are rendered.

/** Parse PROJECT_RENDER_ROOTS into a map: project-name → absolute path. */
function getProjectRenderRoots(): Map<string, string> {
  const raw = process.env['PROJECT_RENDER_ROOTS'];
  if (!raw) return new Map();
  const map = new Map<string, string>();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!entry.startsWith('/')) continue; // must be absolute
    const name = entry.split('/').pop();
    if (!name) continue;
    // If two roots share a basename, the second wins — operator-visible at
    // boot via the index page (the duplicate would replace the first entry).
    map.set(name, entry);
  }
  return map;
}

type ScratchRoot = { absRoot: string; urlPrefix: string };

/** Discover all scratch roots for a project — the top-level `<project>/scratch/`
 *  plus any one-level-deep monorepo subdirectory that has its own scratch dir
 *  (e.g. `project-a/retail-react-app/scratch/`). Returns roots ordered by
 *  urlPrefix length descending so prefix matching in resolveScratchFile picks
 *  the most specific. The top-level root's urlPrefix is empty. */
function discoverScratchRoots(projectRoot: string): ScratchRoot[] {
  const roots: ScratchRoot[] = [];
  const topScratch = join(projectRoot, 'scratch');
  if (existsSync(topScratch)) {
    roots.push({ absRoot: topScratch, urlPrefix: '' });
  }
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try { entries = readdirSync(projectRoot, { withFileTypes: true }); } catch { return roots; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'scratch') continue;
    const nested = join(projectRoot, entry.name, 'scratch');
    if (existsSync(nested)) {
      roots.push({ absRoot: nested, urlPrefix: `${entry.name}/` });
    }
  }
  roots.sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);
  return roots;
}

/** Resolve a (project, relPath) tuple to an absolute on-disk `.md` path.
 *  Returns null + a reason string if any check fails.
 *
 *  Supports nested scratch dirs via discoverScratchRoots — a relPath that
 *  starts with `<subdir>/` resolves under `<project>/<subdir>/scratch/`
 *  instead of `<project>/scratch/`. */
function resolveScratchFile(project: string, relPath: string): { path: string } | { error: string; status: number } {
  if (relPath.includes('..')) return { error: 'Invalid path', status: 400 };
  if (!relPath.toLowerCase().endsWith('.md')) return { error: 'Only .md files are renderable', status: 400 };

  const roots = getProjectRenderRoots();
  const projectRoot = roots.get(project);
  if (!projectRoot) return { error: 'Unknown project', status: 404 };

  const scratchRoots = discoverScratchRoots(projectRoot);
  if (scratchRoots.length === 0) return { error: 'Project has no scratch directory', status: 404 };

  // Pick the most-specific matching root for this relPath (roots are pre-sorted
  // longest-prefix-first so the first match wins).
  const matched = scratchRoots.find((r) => r.urlPrefix === '' || relPath.startsWith(r.urlPrefix));
  if (!matched) return { error: 'File not found', status: 404 };

  let scratchRootReal: string;
  try { scratchRootReal = realpathSync(matched.absRoot); } catch { return { error: 'Project has no scratch directory', status: 404 }; }

  const innerRel = matched.urlPrefix ? relPath.slice(matched.urlPrefix.length) : relPath;
  const candidate = join(matched.absRoot, innerRel);
  if (!existsSync(candidate)) return { error: 'File not found', status: 404 };

  let candidateReal: string;
  try { candidateReal = realpathSync(candidate); } catch { return { error: 'File not found', status: 404 }; }

  // Symlink-escape guard: realpath must stay under the matched scratch realroot.
  if (!candidateReal.startsWith(scratchRootReal + '/') && candidateReal !== scratchRootReal) {
    return { error: 'Path escapes project scratch dir', status: 400 };
  }
  return { path: candidateReal };
}

/** Recursively collect all `.md` files under a directory. Returns paths
 *  relative to `root`. Skips hidden dirs (dot-prefixed) and node_modules. */
function listMarkdownRecursive(root: string): Array<{ relPath: string; size: number; mtimeMs: number }> {
  const results: Array<{ relPath: string; size: number; mtimeMs: number }> = [];
  function walk(dir: string, prefix: string): void {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try {
          const st = statSync(full);
          results.push({ relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* file vanished between readdir and stat — skip */ }
      }
    }
  }
  walk(root, '');
  return results;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatRelativeAge(mtimeMs: number, nowMs: number = Date.now()): string {
  const ageMs = nowMs - mtimeMs;
  const m = Math.floor(ageMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.floor(d / 30);
  return `${mo} mo ago`;
}

// Persona attribution heuristic for /scratch view:
//   1. Filename starts with `handoff_<persona>_<date>` → that persona
//   2. First path segment under scratch/ is a known persona → that persona
//   3. Worktree-name pattern `<persona>-NNNN` → base persona (numeric suffix stripped)
//   4. Dir matching `pr-NNNN-{review,refresh,nits-check,...}` → `prev` (only when
//      `prev` is a known persona on this operator's setup; off otherwise)
//   5. Project-primary fallback (operator-configured via PROJECT_PRIMARY_PERSONAS env)
//   6. Otherwise `unattributed`
//
// Persona list is operator-local — derived at request time from the on-disk
// persistent-agents/ directory. NOT hardcoded in this file; persona handles
// stay in each operator's environment, never in the public codebase.
//
// Project-primary fallback is operator-configured via env:
//   PROJECT_PRIMARY_PERSONAS=project-a:agent-a,project-b:agent-b
// (comma-separated colon-pairs). Empty/unset → no fallback, `unattributed`.

function getKnownPersonas(): Set<string> {
  // Runtime discovery — the persona list IS the persistent-agents/ directory.
  // Excludes the inherited-defaults file (_default.md) which isn't a persona.
  try {
    const entries = readdirSync(getPersonasDir(), { withFileTypes: true });
    return new Set(
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
        .map((e) => e.name.slice(0, -3).toLowerCase()),
    );
  } catch {
    return new Set();
  }
}

function getProjectPrimaryPersona(): Record<string, string> {
  const raw = process.env['PROJECT_PRIMARY_PERSONAS'];
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [project, persona] = pair.split(':').map((s) => s.trim());
    if (project && persona) out[project] = persona;
  }
  return out;
}

function attributePersona(relPath: string, project: string): string {
  const known = getKnownPersonas();
  // Handoff filename: handoff_<persona>_<timestamp>.md
  const handoffMatch = /^handoff[-_]([a-zA-Z0-9-]+?)[-_]\d{8}/.exec(basename(relPath));
  if (handoffMatch) {
    const candidate = handoffMatch[1]!.toLowerCase();
    // Strip worktree suffix (agent-NNNN → agent) if base name is a known persona
    const base = candidate.replace(/-\d+$/, '');
    if (known.has(candidate)) return candidate;
    if (known.has(base)) return base;
  }
  // First path segment matches a known persona
  const firstSeg = relPath.split('/')[0]?.toLowerCase() ?? '';
  if (known.has(firstSeg)) return firstSeg;
  const firstSegBase = firstSeg.replace(/-\d+$/, '');
  if (known.has(firstSegBase)) return firstSegBase;
  // PR-review directory pattern — match anywhere in the path so nested scratch
  // dirs (e.g. `subapp/pr-NNNN-review/...`) attribute to `prev`. Only honoured
  // when `prev` is a known persona on this operator's setup.
  if (known.has('prev') && /(?:^|\/)pr-\d+(?:-[a-z]+)*(?:\/|$)/.test(relPath.toLowerCase())) {
    return 'prev';
  }
  // Project-primary fallback (operator-local env config)
  return getProjectPrimaryPersona()[project] ?? 'unattributed';
}

route('GET', '/scratch', async (req, res, _match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });

  const roots = getProjectRenderRoots();
  if (roots.size === 0) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(wrapMarkdownPage('Scratch', renderMarkdown('# Scratch files\n\n_No projects are configured for scratch rendering. Set `PROJECT_RENDER_ROOTS` to a comma-separated list of absolute paths._')));
    return;
  }

  // Gather all files across all projects with persona attribution.
  type Entry = { project: string; relPath: string; size: number; mtimeMs: number; persona: string };
  const all: Entry[] = [];
  for (const [project, projectRoot] of roots.entries()) {
    for (const root of discoverScratchRoots(projectRoot)) {
      for (const f of listMarkdownRecursive(root.absRoot)) {
        const relPath = `${root.urlPrefix}${f.relPath}`;
        all.push({ project, relPath, size: f.size, mtimeMs: f.mtimeMs, persona: attributePersona(relPath, project) });
      }
    }
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const lines: string[] = ['# Scratch files', ''];
  lines.push(`_Total: ${all.length} files across ${roots.size} projects. Updated ${all[0] ? formatRelativeAge(all[0].mtimeMs) : 'never'}._`);
  lines.push('');

  // ── Latest 10 ──
  lines.push('## Latest 10');
  lines.push('');
  if (all.length === 0) {
    lines.push('_No markdown files yet._');
  } else {
    for (const f of all.slice(0, 10)) {
      lines.push(`- [${f.project}/${f.relPath}](/scratch/${f.project}/${f.relPath}) — **${f.persona}**, ${formatBytes(f.size)}, ${formatRelativeAge(f.mtimeMs)}`);
    }
  }
  lines.push('');

  // ── Grouped by persona ──
  lines.push('## By persona');
  lines.push('');
  const byPersona = new Map<string, Entry[]>();
  for (const f of all) {
    if (!byPersona.has(f.persona)) byPersona.set(f.persona, []);
    byPersona.get(f.persona)!.push(f);
  }
  // Sort personas by total file count desc, with 'unattributed' last
  const personaOrder = [...byPersona.entries()].sort((a, b) => {
    if (a[0] === 'unattributed') return 1;
    if (b[0] === 'unattributed') return -1;
    return b[1].length - a[1].length;
  });
  for (const [persona, files] of personaOrder) {
    lines.push(`### ${persona} (${files.length} file${files.length === 1 ? '' : 's'})`);
    lines.push('');
    for (const f of files) {
      lines.push(`- [${f.project}/${f.relPath}](/scratch/${f.project}/${f.relPath}) — ${formatBytes(f.size)}, ${formatRelativeAge(f.mtimeMs)}`);
    }
    lines.push('');
  }

  const html = wrapMarkdownPage('Scratch', renderMarkdown(lines.join('\n')));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

route('GET', '/scratch/:project/:path+', async (req, res, match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });

  const project = match.pathname.groups['project']!;
  const relPath = match.pathname.groups['path']!;
  const resolved = resolveScratchFile(project, relPath);
  if ('error' in resolved) return json(res, resolved.status, { error: resolved.error });
  // baseHref = directory of this file so relative links between scratch
  // markdown files (e.g. `[A](./other.md)`) resolve correctly.
  const lastSlash = relPath.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? relPath.slice(0, lastSlash + 1) : '';
  serveMarkdownAsHtml(res, resolved.path, `${project}/${relPath}`, `/scratch/${project}/${dirPart}`);
});

route('GET', '/pages/:slug/:path+', async (_req, res, match, ctx) => {
  const slug = match.pathname.groups['slug']!;
  const filePath = match.pathname.groups['path']!;
  if (filePath.includes('..')) return json(res, 400, { error: 'Invalid path' });
  const fullPath = join(ctx.pagesDir, slug, filePath);
  if (!existsSync(fullPath)) return json(res, 404, { error: 'File not found' });

  // Render .md files as HTML so they display in the browser (instead of downloading).
  // baseHref is the directory of this file so relative links to siblings
  // (e.g. another .md in the same dir, or `../other-dir/file.md`) resolve
  // correctly. Use the dirname of filePath inside the bundle — e.g.
  // `runbooks/foo.md` → baseHref `/pages/<slug>/runbooks/`.
  if (filePath.toLowerCase().endsWith('.md')) {
    const lastSlash = filePath.lastIndexOf('/');
    const dirPart = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
    serveMarkdownAsHtml(res, fullPath, `${slug}/${filePath}`, `/pages/${slug}/${dirPart}`);
    return;
  }
  res.writeHead(200, { 'Content-Type': pageMime(fullPath) });
  res.end(readFileSync(fullPath));
});

// ── Data Stores ──

const MAX_STORE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_STORE_ROWS = 1000;

/** SQL statements allowed in store queries. */
const ALLOWED_SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;

/** Dangerous statements that must be rejected outright. */
const DENIED_SQL_RE = /\b(ATTACH|DETACH)\b/i;

/** PRAGMA whitelist — only table_info is allowed. */
const PRAGMA_TABLE_INFO_RE = /^\s*PRAGMA\s+table_info\s*\(/i;

function validateStoreSql(sql: string): string | null {
  const trimmed = sql.trim();
  if (!trimmed) return 'Empty SQL statement';

  // Check for multiple statements (semicolons followed by more content)
  const stmtParts = trimmed.split(';').filter(s => s.trim().length > 0);
  if (stmtParts.length > 1) return 'Multiple statements not allowed';

  // Check for denied keywords
  if (DENIED_SQL_RE.test(trimmed)) return 'ATTACH/DETACH not allowed';

  // Allow PRAGMA table_info specifically
  if (/^\s*PRAGMA\b/i.test(trimmed)) {
    if (!PRAGMA_TABLE_INFO_RE.test(trimmed)) return 'Only PRAGMA table_info is allowed';
    return null;
  }

  // Check against allowed statement types
  if (!ALLOWED_SQL_RE.test(trimmed)) return 'Only SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE, DROP TABLE are allowed';

  return null;
}

function openStoreDb(storesDir: string, name: string): DatabaseSync {
  const dbPath = join(storesDir, `${name}.db`);
  const storeDb = new DatabaseSync(dbPath);
  storeDb.exec('PRAGMA journal_mode = WAL');
  storeDb.exec('PRAGMA busy_timeout = 5000');
  return storeDb;
}

function checkStoreSize(storesDir: string, name: string): boolean {
  const dbPath = join(storesDir, `${name}.db`);
  if (!existsSync(dbPath)) return true;
  const stat = statSync(dbPath);
  return stat.size <= MAX_STORE_BYTES;
}

route('POST', '/api/stores', async (req, res, _match, ctx) => {
  const body = await readJson<{ name?: string; agent?: string }>(req);
  const name = body.name;
  const agent = body.agent ?? null;

  if (!name || !SLUG_RE.test(name)) return json(res, 400, { error: 'Invalid store name (kebab-case, 2-64 chars)' });

  // Create the SQLite file to make it real
  const storeDb = openStoreDb(ctx.storesDir, name);
  storeDb.close();

  const record = ctx.db.createStore({ name, agent: agent ?? undefined });
  ctx.wss.broadcast(JSON.stringify({ type: 'stores_update', stores: ctx.db.listStores() }));
  json(res, 201, record);
});

route('GET', '/api/stores', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listStores());
});

route('GET', '/api/stores/:name/schema', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  if (!SLUG_RE.test(name)) return json(res, 400, { error: 'Invalid store name' });

  const record = ctx.db.getStore(name);
  if (!record) return json(res, 404, { error: 'Store not found' });

  const dbPath = join(ctx.storesDir, `${name}.db`);
  if (!existsSync(dbPath)) return json(res, 404, { error: 'Store file not found' });

  const storeDb = openStoreDb(ctx.storesDir, name);
  try {
    const tables = storeDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<Record<string, unknown>>;
    const schema: Record<string, Array<{ name: string; type: string; notnull: boolean; pk: boolean }>> = {};
    for (const t of tables) {
      const tableName = t['name'] as string;
      const cols = storeDb.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`).all() as Array<Record<string, unknown>>;
      schema[tableName] = cols.map(c => ({
        name: c['name'] as string,
        type: c['type'] as string,
        notnull: (c['notnull'] as number) === 1,
        pk: (c['pk'] as number) > 0,
      }));
    }
    json(res, 200, schema);
  } finally {
    storeDb.close();
  }
});

route('POST', '/api/stores/:name/query', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  if (!SLUG_RE.test(name)) return json(res, 400, { error: 'Invalid store name' });

  const record = ctx.db.getStore(name);
  if (!record) return json(res, 404, { error: 'Store not found' });

  const body = await readJson<{ sql?: string; params?: unknown[] }>(req);
  const sql = body.sql;
  const params = body.params ?? [];

  if (!sql) return json(res, 400, { error: 'sql is required' });
  const sqlErr = validateStoreSql(sql);
  if (sqlErr) return json(res, 400, { error: sqlErr });

  // Size check for mutating operations
  const isRead = /^\s*SELECT\b/i.test(sql.trim());
  if (!isRead && !checkStoreSize(ctx.storesDir, name)) {
    return json(res, 413, { error: `Store exceeds ${MAX_STORE_BYTES / 1024 / 1024}MB limit` });
  }

  const dbPath = join(ctx.storesDir, `${name}.db`);
  if (!existsSync(dbPath)) return json(res, 404, { error: 'Store file not found' });

  const storeDb = openStoreDb(ctx.storesDir, name);
  try {
    const trimmed = sql.trim();
    if (/^\s*SELECT\b/i.test(trimmed) || PRAGMA_TABLE_INFO_RE.test(trimmed)) {
      const stmt = storeDb.prepare(trimmed);
      const rows = stmt.all(...params) as unknown[];
      const limited = rows.slice(0, MAX_STORE_ROWS);
      json(res, 200, { rows: limited, truncated: rows.length > MAX_STORE_ROWS });
    } else {
      const stmt = storeDb.prepare(trimmed);
      const result = stmt.run(...params);
      ctx.db.touchStore(name);
      json(res, 200, { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) });
    }
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  } finally {
    storeDb.close();
  }
});

route('DELETE', '/api/stores/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  if (!SLUG_RE.test(name)) return json(res, 400, { error: 'Invalid store name' });

  // Remove the SQLite file
  const dbPath = join(ctx.storesDir, `${name}.db`);
  if (existsSync(dbPath)) unlinkSync(dbPath);
  // Also remove WAL/SHM if present
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) unlinkSync(walPath);
  if (existsSync(shmPath)) unlinkSync(shmPath);

  const deleted = ctx.db.deleteStore(name);
  if (!deleted) return json(res, 404, { error: 'Store not found' });
  ctx.wss.broadcast(JSON.stringify({ type: 'stores_update', stores: ctx.db.listStores() }));
  json(res, 200, { ok: true });
});

// ── Files (orchestrator-native file registry) ──

const FILE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Derive MIME type from filename extension. Returns application/octet-stream
 * for unknown extensions.
 */
function fileMime(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  const MIME_MAP: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
  };
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

/**
 * Upload a file. Accepts multipart/form-data or raw octet-stream.
 * Files are stored in `$DATA_DIR/files/<uuid>.<ext>`.
 * Returns the FileRecord with metadata.
 */
route('POST', '/api/files', async (req, res, _match, ctx) => {
  // Ensure files directory exists
  mkdirSync(ctx.filesDir, { recursive: true });

  const contentType = req.headers['content-type'] ?? '';
  let filename: string | null = null;
  let fileBuffer: Buffer | null = null;

  if (contentType.startsWith('multipart/form-data')) {
    // Parse multipart — extract first file field
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
      return json(res, 400, { error: 'Missing multipart boundary' });
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += (chunk as Buffer).length;
      if (totalSize > FILE_MAX_BYTES) {
        return json(res, 413, { error: `File exceeds ${FILE_MAX_BYTES / 1024 / 1024}MB limit` });
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // Simple multipart parser — find the first file field
    const boundaryBytes = Buffer.from(`--${boundary}`);
    const parts = splitBuffer(body, boundaryBytes);
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd).toString('utf-8');
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      if (filenameMatch) {
        filename = filenameMatch[1]!;
        // Content starts after \r\n\r\n, ends before trailing \r\n
        const content = part.slice(headerEnd + 4);
        // Trim trailing \r\n if present
        if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
          fileBuffer = content.slice(0, content.length - 2);
        } else {
          fileBuffer = content;
        }
        break;
      }
    }

    if (!filename || !fileBuffer) {
      return json(res, 400, { error: 'No file found in multipart body' });
    }
  } else {
    // Raw octet-stream upload — filename from query param or header
    const url = new URL(req.url!, `http://${req.headers.host}`);
    filename = url.searchParams.get('filename') ?? (req.headers['x-filename'] as string | undefined) ?? null;

    if (!filename) {
      return json(res, 400, { error: 'filename required (query param or X-Filename header)' });
    }

    // Stream to a temp buffer (with size check)
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += (chunk as Buffer).length;
      if (totalSize > FILE_MAX_BYTES) {
        return json(res, 413, { error: `File exceeds ${FILE_MAX_BYTES / 1024 / 1024}MB limit` });
      }
      chunks.push(chunk as Buffer);
    }
    fileBuffer = Buffer.concat(chunks);
  }

  // Validate filename
  if (filename.includes('/') || filename.includes('\\') ||
      filename === '.' || filename === '..' ||
      filename.includes('\0') || filename.length > 255) {
    return json(res, 400, { error: 'Invalid filename' });
  }

  // Generate UUID and preserve extension
  const id = randomUUID();
  const ext = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')) : '';
  const storedFilename = `${id}${ext}`;
  const storedPath = join(ctx.filesDir, storedFilename);
  const mime = fileMime(filename);

  // Write file to disk
  writeFileSync(storedPath, fileBuffer);

  // Record in database
  const fileRecord = ctx.db.addFile({
    id,
    name: filename,
    size: fileBuffer.length,
    mime,
    path: storedPath,
  });

  json(res, 201, fileRecord);
});

/** Split a buffer by a delimiter buffer. */
function splitBuffer(buf: Buffer, delim: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let idx: number;
  while ((idx = buf.indexOf(delim, start)) !== -1) {
    if (idx > start) {
      parts.push(buf.slice(start, idx));
    }
    start = idx + delim.length;
  }
  if (start < buf.length) {
    parts.push(buf.slice(start));
  }
  return parts;
}

/**
 * Get file content by ID. Returns the raw file with proper content-type.
 */
route('GET', '/api/files/:id', async (_req, res, match, ctx) => {
  const id = match.pathname.groups['id']!;
  const fileRecord = ctx.db.getFile(id);
  if (!fileRecord) {
    return json(res, 404, { error: 'File not found' });
  }

  if (!existsSync(fileRecord.path)) {
    return json(res, 404, { error: 'File content not found on disk' });
  }

  res.writeHead(200, {
    'Content-Type': fileRecord.mime,
    'Content-Length': String(fileRecord.size),
    'Content-Disposition': `inline; filename="${encodeURIComponent(fileRecord.name)}"`,
  });

  // Stream the file
  const stream = createReadStream(fileRecord.path);
  stream.pipe(res);
  stream.on('error', () => {
    res.end();
  });
});

/**
 * Get file metadata by ID. Returns the FileRecord JSON.
 */
route('GET', '/api/files/:id/meta', async (_req, res, match, ctx) => {
  const id = match.pathname.groups['id']!;
  const fileRecord = ctx.db.getFile(id);
  if (!fileRecord) {
    return json(res, 404, { error: 'File not found' });
  }
  json(res, 200, fileRecord);
});

/**
 * List all files.
 */
route('GET', '/api/files', async (_req, res, _match, ctx) => {
  const files = ctx.db.listFiles();
  json(res, 200, files);
});

/**
 * Delete a file by ID. Removes both the database record and the file on disk.
 */
route('DELETE', '/api/files/:id', async (_req, res, match, ctx) => {
  const id = match.pathname.groups['id']!;
  const fileRecord = ctx.db.getFile(id);
  if (!fileRecord) {
    return json(res, 404, { error: 'File not found' });
  }

  // Delete from disk
  if (existsSync(fileRecord.path)) {
    unlinkSync(fileRecord.path);
  }

  // Delete from database
  ctx.db.deleteFile(id);
  json(res, 200, { ok: true });
});

// ── Destinations (Telegram, etc.) ──

route('POST', '/api/destinations', async (req, res, _match, ctx) => {
  const body = await readJson<{
    name?: string;
    type?: string;
    config?: { botToken?: string; chatId?: string } & Record<string, unknown>;
  }>(req);
  const name = body.name;
  const type = body.type;
  const config = body.config;

  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 64) {
    return json(res, 400, { error: 'name required (1-64 chars)' });
  }
  if (!type || typeof type !== 'string') {
    return json(res, 400, { error: 'type required (e.g. "telegram")' });
  }
  if (!config || typeof config !== 'object') {
    return json(res, 400, { error: 'config required (object)' });
  }
  if (type === 'telegram') {
    if (!config.botToken || !config.chatId) {
      return json(res, 400, { error: 'telegram config requires botToken and chatId' });
    }
  }

  if (ctx.db.getDestination(name)) {
    return json(res, 409, { error: `Destination "${name}" already exists` });
  }

  const record = ctx.db.createDestination({ name, type, config });
  ctx.wss.broadcast(JSON.stringify({ type: 'destinations_update', destinations: ctx.db.listDestinations() }));

  // Start polling for newly created telegram destinations
  if (type === 'telegram' && record.enabled) {
    startTelegramPolling(ctx, record);
  }

  json(res, 201, record);
});

route('GET', '/api/destinations', async (_req, res, _match, ctx) => {
  json(res, 200, ctx.db.listDestinations());
});

route('PATCH', '/api/destinations/:name', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const existing = ctx.db.getDestination(name);
  if (!existing) return json(res, 404, { error: 'Destination not found' });

  const body = await readJson<{ config?: Record<string, unknown>; enabled?: boolean }>(req);
  const config = body.config;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;

  if (config === undefined && enabled === undefined) {
    return json(res, 400, { error: 'At least one of "config" or "enabled" must be provided' });
  }
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    return json(res, 400, { error: 'config must be an object' });
  }
  // Re-run telegram-specific config validation if updating config on a telegram dest.
  if (config !== undefined && existing.type === 'telegram') {
    if (!config['botToken'] || !config['chatId']) {
      return json(res, 400, { error: 'telegram config requires botToken and chatId' });
    }
  }

  const updates: { config?: Record<string, unknown>; enabled?: boolean } = {};
  if (config !== undefined) updates.config = config;
  if (enabled !== undefined) updates.enabled = enabled;

  const updated = ctx.db.updateDestination(name, updates);
  if (!updated) return json(res, 404, { error: 'Destination not found' });

  // If telegram polling state may have changed (config affects bot token / default agent;
  // enabled flag flips polling on/off), restart polling cleanly.
  if (updated.type === 'telegram') {
    ctx.telegramDispatcher.stopPolling();
    if (updated.enabled) {
      startTelegramPolling(ctx, updated);
    }
  }

  ctx.wss.broadcast(JSON.stringify({ type: 'destinations_update', destinations: ctx.db.listDestinations() }));
  json(res, 200, updated);
});

route('DELETE', '/api/destinations/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const existing = ctx.db.getDestination(name);
  if (!existing) return json(res, 404, { error: 'Destination not found' });

  // Stop polling if telegram
  if (existing.type === 'telegram') {
    ctx.telegramDispatcher.stopPolling();
  }

  const deleted = ctx.db.deleteDestination(name);
  if (!deleted) return json(res, 404, { error: 'Destination not found' });
  ctx.wss.broadcast(JSON.stringify({ type: 'destinations_update', destinations: ctx.db.listDestinations() }));
  json(res, 200, { ok: true });
});

route('POST', '/api/destinations/:name/send', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const dest = ctx.db.getDestination(name);
  if (!dest) return json(res, 404, { error: 'Destination not found' });
  if (!dest.enabled) return json(res, 400, { error: 'Destination is disabled' });

  const body = await readJson<{ message?: string; fromAgent?: string }>(req);
  const message = body.message;
  if (!message) return json(res, 400, { error: 'message required' });

  const fromAgent = body.fromAgent;
  const text = fromAgent ? `[${fromAgent}] ${message}` : message;

  if (dest.type === 'telegram') {
    const botToken = dest.config['botToken'] as string;
    const chatId = dest.config['chatId'] as string;
    const ok = await ctx.telegramDispatcher.send(botToken, chatId, text);
    if (!ok) return json(res, 502, { error: 'Telegram send failed' });
    json(res, 200, { ok: true });
  } else {
    json(res, 400, { error: `Unsupported destination type: ${dest.type}` });
  }
});

route('POST', '/api/destinations/:name/test', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const dest = ctx.db.getDestination(name);
  if (!dest) return json(res, 404, { error: 'Destination not found' });

  if (dest.type === 'telegram') {
    const botToken = dest.config['botToken'] as string;
    const chatId = dest.config['chatId'] as string;
    const ok = await ctx.telegramDispatcher.send(botToken, chatId, `[agentic-collab] Test message from destination "${name}"`);
    if (!ok) return json(res, 502, { error: 'Telegram test send failed' });
    json(res, 200, { ok: true });
  } else {
    json(res, 400, { error: `Unsupported destination type: ${dest.type}` });
  }
});

// ── Personas ──


route('GET', '/api/personas', async (_req, res) => {
  try {
    const dir = getPersonasDir();
    const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    const personas = files.map(f => ({ name: f.replace(/\.md$/, ''), filename: f }));
    json(res, 200, personas);
  } catch {
    json(res, 200, []);
  }
});

route('GET', '/api/personas/:name', async (_req, res, match) => {
  const name = match.pathname.groups['name']!;
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });
  try {
    const filePath = join(getPersonasDir(), `${name}.md`);
    const raw = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    json(res, 200, { name, content: raw, frontmatter, body, filePath: toHostPath(filePath), hostname: hostname() });
  } catch {
    json(res, 404, { error: 'Persona not found' });
  }
});

route('PUT', '/api/personas/:name', async (req, res, match) => {
  const name = match.pathname.groups['name']!;
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });
  const body = await readJson<{ content?: string }>(req);
  if (typeof body.content !== 'string') return json(res, 400, { error: 'content (string) required' });
  try {
    const dir = getPersonasDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body.content, 'utf-8');
    json(res, 200, { name, content: body.content });
  } catch (err) {
    json(res, 500, { error: `Failed to write persona: ${(err as Error).message}` });
  }
});

route('POST', '/api/personas', async (req, res, _match, ctx) => {
  const body = await readJson<{ name?: string; content?: string }>(req);
  if (!body.name || typeof body.name !== 'string') {
    return json(res, 400, { error: 'name (string) required' });
  }
  if (!body.content || typeof body.content !== 'string') {
    return json(res, 400, { error: 'content (string) required' });
  }

  const name = body.name;
  if (!NAME_RE.test(name)) return json(res, 400, { error: 'Invalid persona name' });

  try {
    const persona = createPersonaAndAgent(ctx.db, name, body.content);
    const agent = ctx.db.getAgent(name);
    ctx.db.logEvent(name, 'persona_created');
    broadcastAgentUpdate(ctx, name);
    json(res, 201, { persona: { name: persona.name, frontmatter: persona.frontmatter }, agent });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/sync-personas', async (_req, res, _match, ctx) => {
  const result = syncPersonasWithDiff(ctx.db);
  // Broadcast agent updates for any created or updated agents
  for (const name of [...result.created, ...result.updated]) {
    broadcastAgentUpdate(ctx, name);
  }
  if (result.created.length > 0 || result.updated.length > 0) {
    console.log(`[sync-personas] created: ${result.created.length}, updated: ${result.updated.length}, unchanged: ${result.unchanged.length}, skipped: ${result.skipped.length}`);
  }
  json(res, 200, result);
});

// ── Agent Lifecycle Operations ──

route('POST', '/api/agents/:name/spawn', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson<{
    model?: string;
    thinking?: string;
    cwd?: string;
    persona?: string;
    proxyId?: string;
    task?: string;
  }>(req);

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    // Re-sync persona from disk to pick up config changes (engine, model, etc.)
    syncSinglePersona(ctx.db, name);
    const agent = ctx.db.getAgent(name);
    if (!agent) return json(res, 404, { error: 'Agent not found' });

    const result = await spawnAgent(lifecycleCtx, {
      name,
      engine: agent.engine,
      model: body.model ?? agent.model ?? undefined,
      thinking: body.thinking ?? agent.thinking ?? undefined,
      cwd: body.cwd ?? agent.cwd,
      persona: body.persona ?? agent.persona ?? undefined,
      proxyId: resolveProxyId(ctx, agent, body.proxyId),
      task: body.task,
    });

    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Spawned');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/resume', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson<{ proxyId?: string; task?: string }>(req);

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    // Re-sync persona from disk to pick up config changes (engine, model, etc.)
    syncSinglePersona(ctx.db, name);
    const agent = ctx.db.getAgent(name);
    if (!agent) return json(res, 404, { error: 'Agent not found' });

    // Pre-assign proxy if the agent doesn't have one (e.g. first resume after persona sync)
    const proxyId = resolveProxyId(ctx, agent, body.proxyId);
    if (proxyId && !agent.proxyId) {
      ctx.db.updateAgentState(name, agent.state, agent.version, { proxyId });
    }

    const result = await resumeAgent(lifecycleCtx, name, {
      task: body.task,
    });
    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Resumed');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// Primary "exit" endpoint + backward-compat "suspend" alias
const handleExit: RouteHandler = async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    const result = await suspendAgent(lifecycleCtx, name);
    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Exited');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
};
route('POST', '/api/agents/:name/exit', handleExit);
route('POST', '/api/agents/:name/suspend', handleExit);

route('POST', '/api/agents/:name/reload', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson<{ immediate?: boolean; task?: string }>(req);

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    // Re-sync persona from disk to pick up config changes (engine, model, etc.)
    syncSinglePersona(ctx.db, name);
    const result = await reloadAgent(lifecycleCtx, name, {
      immediate: body.immediate,
      task: body.task,
    });
    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Reloaded');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/recover', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    syncSinglePersona(ctx.db, name);
    const result = await recoverAgent(lifecycleCtx, name);
    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Recovered');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/recycle', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    syncSinglePersona(ctx.db, name);
    const result = await recycleAgent(lifecycleCtx, name);
    broadcastAgentUpdate(ctx, name);
    broadcastLifecycleEvent(ctx, name, 'Recycled');
    json(res, 200, result);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/unwedge', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await unwedgeAgent(lifecycleCtx, name);
    broadcastLifecycleEvent(ctx, name, 'Unwedged');
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('POST', '/api/agents/:name/interrupt', lifecycleRoute(interruptAgent, { eventLabel: 'Interrupted' }));

route('POST', '/api/agents/:name/compact', lifecycleRoute(compactAgent, { eventLabel: 'Compacted' }));

route('POST', '/api/agents/:name/kill', lifecycleRoute(killAgent, { broadcast: true, eventLabel: 'Killed' }));

route('GET', '/api/agents/:name/peek', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  // Support ?lines=N query param (default 50, max 1000)
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const linesParam = url.searchParams.get('lines');
  const lines = linesParam ? Math.max(1, Math.min(parseInt(linesParam, 10) || 50, 1000)) : 50;

  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'capture',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    lines,
  });

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { output: result.data });
});

route('POST', '/api/agents/:name/keys', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson<{ keys?: string }>(req);
  const keys = body?.keys;
  if (typeof keys !== 'string' || !keys) { json(res, 400, { error: 'keys required' }); return; }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'send_keys',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    keys,
  });

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { ok: true });
});

function parseTmuxCaptureLines(args: string[]): number {
  let sawPrint = false;
  let lines = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p') {
      sawPrint = true;
      continue;
    }
    if (args[i] === '-S') {
      const start = args[++i];
      const match = typeof start === 'string' ? /^-(\d+)$/.exec(start) : null;
      if (!match) {
        throw new Error('capture-pane only supports -S -<lines>');
      }
      lines = Math.max(1, Math.min(parseInt(match[1]!, 10), 10000));
      continue;
    }
    throw new Error('capture-pane only supports -p and optional -S -<lines>');
  }

  if (!sawPrint) {
    throw new Error('capture-pane currently requires -p');
  }
  return lines;
}

function parseTmuxResize(args: string[]): { width: number; height: number } {
  if (args.length !== 4) {
    throw new Error('resize-window requires -x <width> and -y <height>');
  }
  const xIdx = args.indexOf('-x');
  const yIdx = args.indexOf('-y');
  const width = xIdx !== -1 ? parseInt(args[xIdx + 1] ?? '', 10) : NaN;
  const height = yIdx !== -1 ? parseInt(args[yIdx + 1] ?? '', 10) : NaN;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('resize-window requires -x <width> and -y <height>');
  }
  return { width: Math.floor(width), height: Math.floor(height) };
}

route('POST', '/api/agents/:name/tmux', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson<{ args?: string[] }>(req);
  const args = body?.args;
  if (!Array.isArray(args) || args.length === 0 || !args.every((arg: unknown) => typeof arg === 'string')) {
    json(res, 400, { error: 'args (string[]) required' }); return;
  }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const sessionName = agent.tmuxSession ?? `agent-${name}`;
  const [subcommand, ...rest] = args as string[];
  let result: ProxyResponse;

  try {
    switch (subcommand) {
      case 'send-keys':
        if (rest.length === 0) throw new Error('send-keys requires at least one key/token');
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'send_keys_raw',
          sessionName,
          keys: rest,
        });
        break;

      case 'capture-pane':
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'capture',
          sessionName,
          lines: parseTmuxCaptureLines(rest),
        });
        break;

      case 'display-message':
        if (rest.length !== 2 || rest[0] !== '-p' || !rest[1]) {
          throw new Error('display-message currently requires -p <format>');
        }
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'display_message',
          sessionName,
          format: rest[1],
        });
        break;

      case 'resize-window': {
        const { width, height } = parseTmuxResize(rest);
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'resize_pane',
          sessionName,
          width,
          height,
        });
        break;
      }

      case 'has-session':
        if (rest.length > 0) throw new Error('has-session does not take extra arguments');
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'has_session',
          sessionName,
        });
        break;

      case 'pane-activity':
        if (rest.length > 0) throw new Error('pane-activity does not take extra arguments');
        result = await ctx.proxyDispatch(agent.proxyId, {
          action: 'pane_activity',
          sessionName,
        });
        break;

      default:
        throw new Error('supported tmux commands: send-keys, capture-pane, display-message, resize-window, has-session, pane-activity');
    }
  } catch (err) {
    json(res, 400, { error: (err as Error).message }); return;
  }

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { ok: true, data: result.data ?? null });
});

route('POST', '/api/agents/:name/type', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson<{ text?: string; pressEnter?: boolean }>(req);
  const text = body?.text;
  if (typeof text !== 'string' || !text) { json(res, 400, { error: 'text required' }); return; }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const pressEnter = body?.pressEnter === true;
  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'paste',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    text,
    pressEnter,
  });

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { ok: true });
});

route('POST', '/api/agents/:name/resize', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson<{ width?: number; height?: number }>(req);
  const width = body?.width;
  const height = body?.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1) {
    json(res, 400, { error: 'width and height required (positive integers)' }); return;
  }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }
  if (!agent.proxyId) { json(res, 400, { error: `Agent "${name}" has no proxy` }); return; }

  const result = await ctx.proxyDispatch(agent.proxyId, {
    action: 'resize_pane',
    sessionName: agent.tmuxSession ?? `agent-${name}`,
    width: Math.floor(width),
    height: Math.floor(height),
  });

  if (!result.ok) { json(res, 500, { error: result.error }); return; }
  json(res, 200, { ok: true });
});

route('POST', '/api/agents/:name/destroy', lifecycleRoute(destroyAgent, { broadcast: 'destroyed' }));

// ── Custom Buttons ──

route('POST', '/api/agents/:name/custom/:button', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const button = match.pathname.groups['button']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await executeCustomButton(lifecycleCtx, name, button);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// ── Indicator Actions ──

route('POST', '/api/agents/:name/indicator/:indicator/:action', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const indicator = match.pathname.groups['indicator']!;
  const action = match.pathname.groups['action']!;

  try {
    const lifecycleCtx = makeLifecycleCtx(ctx);
    await executeIndicatorAction(lifecycleCtx, name, indicator, action);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// ── Agent Reorder ──

route('POST', '/api/agents/reorder', async (req, res, _match, ctx) => {
  const body = await readJson<{ orders?: Array<{ name: string; sortOrder: number }> }>(req);
  const orders = body?.orders;
  if (!Array.isArray(orders) || !orders.every((o: unknown) =>
    typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>)['name'] === 'string' && typeof (o as Record<string, unknown>)['sortOrder'] === 'number'
  )) {
    json(res, 400, { error: 'orders must be an array of {name, sortOrder}' });
    return;
  }
  ctx.db.batchUpdateSortOrder(orders);
  json(res, 200, { ok: true });
});

route('PATCH', '/api/agents/:name/group', async (req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const body = await readJson<{ group?: string }>(req);
  const group = body?.group;
  if (typeof group !== 'string') { json(res, 400, { error: 'group (string) required' }); return; }

  const agent = ctx.db.getAgent(name);
  if (!agent) { json(res, 404, { error: `Agent "${name}" not found` }); return; }

  // Update persona frontmatter on disk
  const personaPath = resolvePersonaPath(name);
  if (personaPath) {
    updateFrontmatterField(personaPath, 'group', group || null);
  }

  // Update DB (reuse the agent fetched above)
  ctx.db.updateAgentState(name, agent.state, agent.version, {
    agentGroup: group || null,
  });

  ctx.wss.broadcast(JSON.stringify({
    type: 'agent_update',
    agent: ctx.db.getAgent(name),
  }));

  json(res, 200, { ok: true });
});

// ── Orchestrator Control ──

route('POST', '/api/orchestrator/shutdown', async (_req, res, _match, ctx) => {
  const networkCtx = makeLifecycleCtx(ctx);
  const count = shutdownAgents(networkCtx);
  json(res, 200, { ok: true, suspended: count });
});

route('POST', '/api/orchestrator/restore', async (_req, res, _match, ctx) => {
  try {
    const networkCtx = makeLifecycleCtx(ctx);
    const count = await restoreAllAgents(networkCtx);
    json(res, 200, { ok: true, restored: count });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

route('GET', '/api/engines/status', async (_req, res, _match, ctx) => {
  const agents = ctx.db.listAgents();
  const engines: Record<string, { configured: number; active: number; idle: number; failed: number; agents: string[] }> = {};
  for (const engine of ['claude', 'codex', 'opencode']) {
    const engineAgents = agents.filter(a => a.engine === engine);
    engines[engine] = {
      configured: engineAgents.length,
      active: engineAgents.filter(a => a.state === 'active').length,
      idle: engineAgents.filter(a => a.state === 'idle').length,
      failed: engineAgents.filter(a => a.state === 'failed').length,
      agents: engineAgents.map(a => a.name),
    };
  }
  const usage = ctx.usagePoller.getUsageData();
  json(res, 200, { engines, usage });
});

route('GET', '/api/voice/status', async (_req, res, _match, ctx) => {
  json(res, 200, { enabled: ctx.voiceEnabled });
});

route('POST', '/api/engines/poll', async (_req, res, _match, ctx) => {
  try {
    await ctx.usagePoller.pollNow();
    const usage = ctx.usagePoller.getUsageData();
    json(res, 200, { ok: true, usage });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

route('GET', '/api/orchestrator/status', async (_req, res, _match, ctx) => {
  const agents = ctx.db.listAgents();
  const proxies = ctx.db.listProxies();
  const stats = {
    totalAgents: agents.length,
    byState: {} as Record<string, number>,
    totalProxies: proxies.length,
  };
  for (const a of agents) {
    stats.byState[a.state] = (stats.byState[a.state] ?? 0) + 1;
  }
  json(res, 200, stats);
});

// ── Reminders ──

route('POST', '/api/reminders', async (req, res, _match, ctx) => {
  const body = await readJson<{
    agentName?: string;
    prompt?: string;
    cadenceMinutes?: number;
    createdBy?: string;
    skipIfActive?: boolean;
  }>(req);
  if (!body.agentName || typeof body.agentName !== 'string') {
    return json(res, 400, { error: 'agentName required' });
  }
  if (!body.prompt || typeof body.prompt !== 'string') {
    return json(res, 400, { error: 'prompt required' });
  }
  if (typeof body.cadenceMinutes !== 'number' || body.cadenceMinutes < 5) {
    return json(res, 400, { error: 'cadenceMinutes must be >= 5' });
  }

  const agent = ctx.db.getAgent(body.agentName);
  if (!agent) return json(res, 404, { error: `Agent "${body.agentName}" not found` });

  const reminder = ctx.db.createReminder({
    agentName: body.agentName,
    createdBy: body.createdBy,
    prompt: body.prompt,
    cadenceMinutes: body.cadenceMinutes,
    skipIfActive: typeof body.skipIfActive === 'boolean' ? body.skipIfActive : undefined,
  });

  broadcastReminderUpdate(ctx);
  json(res, 201, reminder);
});

route('GET', '/api/reminders', async (req, res, _match, ctx) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const agent = url.searchParams.get('agent') ?? undefined;
  const reminders = ctx.db.listReminders(agent);
  json(res, 200, reminders);
});

route('POST', '/api/reminders/:id/complete', async (_req, res, match, ctx) => {
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid reminder ID' });

  const reminder = ctx.db.getReminder(id);
  if (!reminder) return json(res, 404, { error: 'Reminder not found' });

  // Delete the completed reminder — no need to keep it around
  ctx.db.deleteReminder(id);

  // Promote the next pending reminder (now that the completed one is gone)
  const next = ctx.db.getTopReminder(reminder.agentName);
  if (next) {
    // Respect skipIfActive on promoted reminders (same check as ReminderDispatcher.tick)
    const agent = ctx.db.getAgent(next.agentName);
    const skipBecauseActive = next.skipIfActive && agent && agent.state === 'active';
    if (!skipBecauseActive) {
      const creator = next.createdBy || 'system';
      const envelope = `[reminder #${next.id} from ${creator}]: ${next.prompt}\nMark done when complete: collab reminder done ${next.id}`;
      const msg = ctx.db.enqueueMessage({
        sourceAgent: null,
        targetAgent: next.agentName,
        envelope,
      });
      ctx.db.updateReminderDelivery(next.id);
      ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: msg }));
      ctx.messageDispatcher.tryDeliver(next.agentName).catch((err) => {
        console.error(`[routes] Reminder promotion delivery failed for ${next.agentName}:`, (err as Error).message);
      });
    }
  }

  broadcastReminderUpdate(ctx);
  json(res, 200, { ok: true, deleted: id });
});

route('PATCH', '/api/reminders/:id', async (req, res, match, ctx) => {
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid reminder ID' });

  const body = await readJson<{ prompt?: string; cadenceMinutes?: number; skipIfActive?: boolean }>(req);
  const opts: { prompt?: string; cadenceMinutes?: number; skipIfActive?: boolean } = {};
  if (typeof body.prompt === 'string') opts.prompt = body.prompt;
  if (typeof body.cadenceMinutes === 'number') opts.cadenceMinutes = body.cadenceMinutes;
  if (typeof body.skipIfActive === 'boolean') opts.skipIfActive = body.skipIfActive;

  try {
    const updated = ctx.db.updateReminder(id, opts);
    if (!updated) return json(res, 404, { error: 'Reminder not found' });
    broadcastReminderUpdate(ctx);
    json(res, 200, updated);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route('DELETE', '/api/reminders/:id', async (_req, res, match, ctx) => {
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid reminder ID' });

  ctx.db.deleteReminder(id);
  broadcastReminderUpdate(ctx);
  json(res, 200, { ok: true });
});

route('POST', '/api/reminders/swap', async (req, res, _match, ctx) => {
  const body = await readJson<{ a?: number; b?: number; id1?: number; id2?: number }>(req);
  // Accept both { a, b } (dashboard) and { id1, id2 } (API) field names
  const id1 = typeof body.a === 'number' ? body.a : body.id1;
  const id2 = typeof body.b === 'number' ? body.b : body.id2;
  if (typeof id1 !== 'number' || typeof id2 !== 'number') {
    return json(res, 400, { error: 'id1/id2 (or a/b) required' });
  }

  const ok = ctx.db.swapReminderOrder(id1, id2);
  if (!ok) return json(res, 400, { error: 'Swap failed — reminders must exist and belong to same agent' });

  broadcastReminderUpdate(ctx);
  json(res, 200, { ok: true });
});

// ── Jobs (JJ — recurring cron-scheduled prompts) ──

function broadcastJobUpdate(ctx: RouteContext): void {
  const jobs = ctx.db.listJobs();
  ctx.wss.broadcast(JSON.stringify({ type: 'job_update', jobs }));
}

route('POST', '/api/jobs', async (req, res, _match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  const body = await readJson<{
    agentName?: string;
    createdBy?: string;
    prompt?: string;
    cronExpr?: string;
    skipIfActive?: boolean;
  }>(req);

  if (!body.agentName || typeof body.agentName !== 'string') {
    return json(res, 400, { error: 'agentName required' });
  }
  if (!body.prompt || typeof body.prompt !== 'string') {
    return json(res, 400, { error: 'prompt required' });
  }
  if (!body.cronExpr || typeof body.cronExpr !== 'string') {
    return json(res, 400, { error: 'cronExpr required' });
  }

  // Validate cron + compute next fire BEFORE insert so we never persist a bad cron.
  let nextIso: string;
  try {
    parseCron(body.cronExpr);
    nextIso = cronNextFireAt(body.cronExpr, new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch (e) {
    return json(res, 400, { error: `Invalid cronExpr: ${(e as Error).message}` });
  }

  // Verify the target agent exists
  if (!ctx.db.getAgent(body.agentName)) {
    return json(res, 400, { error: `Agent '${body.agentName}' does not exist` });
  }

  const job = ctx.db.createJob({
    agentName: body.agentName,
    createdBy: body.createdBy ?? undefined,
    prompt: body.prompt,
    cronExpr: body.cronExpr,
    nextFireAt: nextIso,
    skipIfActive: body.skipIfActive !== false,
  });

  broadcastJobUpdate(ctx);
  json(res, 201, job);
});

route('GET', '/api/jobs', async (req, res, _match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  const url = new URL(req.url ?? '', 'http://localhost');
  const agent = url.searchParams.get('agent') ?? undefined;
  const jobs = ctx.db.listJobs(agent);
  json(res, 200, jobs);
});

route('PATCH', '/api/jobs/:id', async (req, res, match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid job ID' });

  const existing = ctx.db.getJob(id);
  if (!existing) return json(res, 404, { error: 'Job not found' });

  const body = await readJson<{
    status?: 'active' | 'paused';
    cronExpr?: string;
    prompt?: string;
  }>(req);

  // status change (pause/resume) — recompute next_fire_at on resume
  if (body.status && body.status !== existing.status) {
    if (body.status !== 'active' && body.status !== 'paused') {
      return json(res, 400, { error: 'status must be active or paused' });
    }
    ctx.db.updateJobStatus(id, body.status);
    if (body.status === 'active') {
      try {
        const nextIso = cronNextFireAt(existing.cronExpr, new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
        ctx.db.updateJobSchedule(id, { nextFireAt: nextIso });
      } catch (e) {
        return json(res, 400, { error: `Cannot resume — invalid cron: ${(e as Error).message}` });
      }
    }
  }

  // cron / prompt change — validate then update
  const updates: { cronExpr?: string; prompt?: string; nextFireAt?: string } = {};
  if (body.cronExpr !== undefined && body.cronExpr !== existing.cronExpr) {
    try {
      const nextIso = cronNextFireAt(body.cronExpr, new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
      updates.cronExpr = body.cronExpr;
      updates.nextFireAt = nextIso;
    } catch (e) {
      return json(res, 400, { error: `Invalid cronExpr: ${(e as Error).message}` });
    }
  }
  if (body.prompt !== undefined) {
    updates.prompt = body.prompt;
  }
  if (Object.keys(updates).length > 0) {
    ctx.db.updateJobSchedule(id, updates);
  }

  broadcastJobUpdate(ctx);
  json(res, 200, ctx.db.getJob(id));
});

route('DELETE', '/api/jobs/:id', async (req, res, match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  const id = parseInt(match.pathname.groups['id']!, 10);
  if (isNaN(id)) return json(res, 400, { error: 'Invalid job ID' });

  const ok = ctx.db.deleteJob(id);
  if (!ok) return json(res, 404, { error: 'Job not found' });

  broadcastJobUpdate(ctx);
  json(res, 200, { ok: true });
});

// ── Accounts ──

route('GET', '/api/accounts', async (_req, res, _match, ctx) => {
  const accounts = ctx.accountStore.list();
  json(res, 200, accounts);
});

route('POST', '/api/accounts', async (req, res, _match, ctx) => {
  const body = await readBody(req);
  const name = body?.name;
  if (typeof name !== 'string' || name.length === 0) {
    return json(res, 400, { error: 'name is required' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return json(res, 400, { error: 'name must be alphanumeric with dashes/underscores' });
  }
  try {
    const account = ctx.accountStore.registerFromCurrent(name);
    json(res, 201, account);
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

route('DELETE', '/api/accounts/:name', async (_req, res, match, ctx) => {
  const name = match.pathname.groups['name']!;
  const removed = ctx.accountStore.remove(name);
  if (!removed) return json(res, 404, { error: 'Account not found' });
  json(res, 200, { ok: true, deleted: name });
});

// ── Telegram routes admin ──
//
// Telegram auto-forward (PR #37) records ephemeral routes in an in-memory map
// when the operator sends a Telegram inbound. Each route auto-expires after
// TELEGRAM_ROUTE_TTL_MS (default 30 min). These admin endpoints let the
// operator inspect active routes and clear them manually — useful when
// they've moved from Telegram back to the dashboard but the 30-min TTL is
// still firing auto-forwards on agent replies. Cause-of-existence:
// 2026-06-12 incident where every Telegram complaint refreshed the TTL,
// extending the noise loop indefinitely.
//
//   GET    /api/telegram/routes          — list active routes
//   DELETE /api/telegram/routes          — clear all routes (operator at dashboard)
//   DELETE /api/telegram/routes/:agent   — clear one agent's route

route('GET', '/api/telegram/routes', async (req, res, _match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  json(res, 200, { routes: listTelegramRoutes() });
});

route('DELETE', '/api/telegram/routes', async (req, res, _match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  const before = listTelegramRoutes().length;
  _resetTelegramRoutes();
  json(res, 200, { cleared: before });
});

route('DELETE', '/api/telegram/routes/:agent', async (req, res, match, ctx) => {
  if (!authorize(ctx.orchestratorSecret, req)) return json(res, 401, { error: 'Unauthorized' });
  const agent = match.pathname.groups['agent']!;
  const cleared = clearTelegramRoute(agent);
  json(res, 200, { cleared, agent });
});

// ── Notify ──

route('POST', '/api/notify', async (req, res, _match, ctx) => {
  const body = await readJson<{ agent?: string; message?: string; priority?: string }>(req);
  const agent = body.agent;
  const message = body.message;
  const priority = body.priority ?? 'normal';
  if (!message) return json(res, 400, { error: 'message required' });

  // Generate a correlation id so log lines for this notification's destinations
  // can be threaded together. Returned in the response so callers can correlate
  // an upstream user action to a downstream Telegram drop. See brain backlog H1.
  const notifyId = randomUUID();

  const destinations = ctx.db.listDestinations().filter(d => d.enabled);
  const telegramDestCount = destinations.filter(d => d.type === 'telegram').length;
  console.log(`[notify] notify_id=${notifyId} agent=${agent ?? '<none>'} priority=${priority} destinations=${destinations.length} telegram_destinations=${telegramDestCount} bytes=${message.length}`);

  let sent = 0;
  let attempted = 0;

  for (const dest of destinations) {
    const text = agent ? `[${agent}] ${message}` : message;
    try {
      if (dest.type === 'telegram') {
        const botToken = dest.config['botToken'] as string;
        const chatId = dest.config['chatId'] as string;
        attempted++;
        const ok = await ctx.telegramDispatcher.send(botToken, chatId, text, notifyId);
        if (ok) sent++;
      }
    } catch (err) {
      // best-effort per destination; surface the failure for diagnosis instead
      // of swallowing silently the way the pre-H1 path did.
      console.error(`[notify] notify_id=${notifyId} destination_error dest=${dest.name} error=${(err as Error).message}`);
    }
  }

  console.log(`[notify] notify_id=${notifyId} summary attempted=${attempted} delivered=${sent} dropped=${attempted - sent}`);

  // Broadcast to dashboard for browser notifications.
  ctx.wss.broadcast(JSON.stringify({
    type: 'notification',
    agent: agent ?? null,
    message,
    priority,
    notifyId,
  }));

  json(res, 200, { ok: true, sent, attempted, notifyId });
});

  return routes;
}

// ── Rate Limiter ──

const RATE_LIMIT_WINDOW_MS = parseInt(process.env['RATE_LIMIT_WINDOW_MS'] ?? '60000', 10);   // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env['RATE_LIMIT_MAX'] ?? '120', 10);                  // 120 requests/min for POST
const RATE_LIMIT_UPLOAD_MAX = parseInt(process.env['RATE_LIMIT_UPLOAD_MAX'] ?? '30', 10);     // 30 uploads/min

type RateBucket = { timestamps: number[]; };
const rateBuckets = new Map<string, RateBucket>();

// Clean up stale buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, bucket] of rateBuckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    if (bucket.timestamps.length === 0) rateBuckets.delete(key);
  }
}, 5 * 60_000).unref();

function checkRateLimit(ip: string, limit: number): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(ip, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
  if (bucket.timestamps.length >= limit) return false;
  bucket.timestamps.push(now);
  return true;
}

// ── Route Matcher ──

export function createRouter(ctx: RouteContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = buildRoutes();

  return async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Auth: state-mutating methods require Bearer token (GET and OPTIONS are exempt)
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      if (!authorize(ctx.orchestratorSecret, req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }

      // Rate limiting for POST/DELETE — applied after auth to avoid wasting
      // rate limit tokens on unauthenticated requests
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      const isUpload = url.pathname === '/api/dashboard/upload';
      const limit = isUpload ? RATE_LIMIT_UPLOAD_MAX : RATE_LIMIT_MAX;
      const bucketKey = isUpload ? `upload:${clientIp}` : `post:${clientIp}`;
      if (!checkRateLimit(bucketKey, limit)) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
        });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }
    }

    for (const route of routes) {
      if (req.method !== route.method) continue;
      const match = route.pattern.exec(url);
      if (match) {
        try {
          await route.handler(req, res, match, ctx);
        } catch (err) {
          const message = (err as Error).message;
          if (!res.headersSent) {
            // Return 400 for client errors (invalid JSON, oversized body)
            if (message === 'Invalid JSON body' || message === 'Request body too large') {
              json(res, 400, { error: message });
            } else {
              console.error(`[route error] ${req.method} ${req.url}:`, err);
              json(res, 500, { error: 'Internal server error' });
            }
          }
        }
        return;
      }
    }

    json(res, 404, { error: 'Not found' });
  };
}

function authorize(secret: string | null, req: IncomingMessage): boolean {
  if (!secret) return true; // dev mode — no auth

  // Bearer header path — used by curl, agents, and dashboard fetch() calls.
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const spaceIdx = header.indexOf(' ');
    if (spaceIdx !== -1) {
      const scheme = header.slice(0, spaceIdx);
      const token = header.slice(spaceIdx + 1);
      if (scheme === 'Bearer' && token.length === secret.length &&
          timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
        return true;
      }
    }
  }

  // Cookie fallback — used by browser-direct navigation (e.g. clicking a link
  // to /scratch or /pages from the dashboard, where the browser can't add a
  // bearer header). The dashboard sets `conductor_token` from its localStorage
  // copy of the secret; same value, same timing-safe comparison.
  const cookieHeader = req.headers['cookie'];
  if (typeof cookieHeader === 'string') {
    const cookieToken = parseCookieToken(cookieHeader);
    if (cookieToken && cookieToken.length === secret.length &&
        timingSafeEqual(Buffer.from(cookieToken), Buffer.from(secret))) {
      return true;
    }
  }

  return false;
}

/** Extract the `conductor_token` value from a Cookie header. Returns null if
 *  absent or malformed. Tolerates standard `k=v; k2=v2; ...` formatting. */
function parseCookieToken(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === 'conductor_token') return part.slice(eq + 1).trim();
  }
  return null;
}

// ── Helpers ──

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += (chunk as Buffer).length;
    if (totalLength > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text) return {};
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function broadcastAgentUpdate(ctx: RouteContext, agentName: string): void {
  const agent = ctx.db.getAgent(agentName);
  if (agent) {
    ctx.wss.broadcast(JSON.stringify({ type: 'agent_update', agent }));
  }
}

/** Insert a lifecycle event as a system message in the agent's chat thread and broadcast it. */
function broadcastLifecycleEvent(ctx: RouteContext, agentName: string, label: string): void {
  const msg = ctx.db.addDashboardMessage(agentName, 'from_agent', `[system] ${label}`, {
    topic: 'lifecycle',
    sourceAgent: 'system',
  });
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg }));
}

function validateAgentName(name: string): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (!NAME_RE.test(name)) return 'name must be 1-63 chars, start with alphanumeric, contain only [a-zA-Z0-9_-]';
  return null;
}

function replyHint(from: string, topic: string): string {
  return `reply with collab send ${from} --topic ${topic}`;
}

function buildReplyEnvelope(from: string, topic: string, message: string): string {
  return `[from: ${from}, ${replyHint(from, topic)}]: '${message}'`;
}

/**
 * Shared enqueue→link→broadcast→tryDeliver pipeline.
 *
 * Creates a dashboard message, enqueues a pending message, links them,
 * broadcasts both to the WebSocket, and fires async delivery.
 *
 * Returns the created dashboard message (with linked queueId/deliveryStatus)
 * and the pending queue entry so callers can reference their IDs.
 */
function enqueueAndDeliver(
  ctx: RouteContext,
  opts: {
    agentName: string;
    displayMessage: string;
    envelope: string;
    topic?: string;
    /** sourceAgent stored on the dashboard message (for display). */
    sourceAgent?: string | null;
    targetAgent?: string;
    /** sourceAgent stored on the queue entry. Defaults to opts.sourceAgent. */
    queueSourceAgent?: string | null;
    direction?: 'to_agent' | 'from_agent';
    /** Whether to broadcast the linked msg (with queueId/deliveryStatus) or the raw msg. Defaults to true. */
    broadcastLinked?: boolean;
    /** File IDs attached to this message. */
    fileIds?: string[];
  },
): { msg: DashboardMessage; pending: PendingMessage; linkedMsg: DashboardMessage & { queueId: number; deliveryStatus: string } } {
  const direction = opts.direction ?? 'to_agent';
  const deliverTo = opts.targetAgent ?? opts.agentName;

  const msg = ctx.db.addDashboardMessage(opts.agentName, direction, opts.displayMessage, {
    topic: opts.topic ?? undefined,
    sourceAgent: opts.sourceAgent ?? undefined,
    targetAgent: opts.targetAgent ?? undefined,
    fileIds: opts.fileIds,
  });

  const queueSource = opts.queueSourceAgent !== undefined ? opts.queueSourceAgent : (opts.sourceAgent ?? null);
  const pending = ctx.db.enqueueMessage({
    sourceAgent: queueSource,
    targetAgent: deliverTo,
    envelope: opts.envelope,
  });

  ctx.db.linkDashboardMessageToQueue(msg.id, pending.id);

  const linkedMsg = { ...msg, queueId: pending.id, deliveryStatus: 'pending' as const };
  const broadcastLinked = opts.broadcastLinked ?? true;
  ctx.wss.broadcast(JSON.stringify({ type: 'message', msg: broadcastLinked ? linkedMsg : msg }));
  ctx.wss.broadcast(JSON.stringify({ type: 'queue_update', message: pending }));

  ctx.messageDispatcher.tryDeliver(deliverTo).catch((err) => {
    console.error(`[routes] Delivery failed for ${deliverTo}:`, (err as Error).message);
  });

  return { msg, pending, linkedMsg };
}

function broadcastReminderUpdate(ctx: RouteContext): void {
  const reminders = ctx.db.listReminders();
  ctx.wss.broadcast(JSON.stringify({ type: 'reminder_update', reminders }));
}

function broadcastProxyUpdate(ctx: RouteContext): void {
  const proxies = enrichProxiesWithVersionMatch(ctx.db.listProxies());
  ctx.wss.broadcast(JSON.stringify({ type: 'proxy_update', proxies }));
}

function enrichProxiesWithVersionMatch(proxies: ProxyRegistration[]): ProxyRegistration[] {
  const orchestratorVersion = getVersion();
  return proxies.map(p => ({
    ...p,
    versionMatch: !!p.version && versionsMatch(p.version, orchestratorVersion),
  }));
}

/**
 * Factory for simple lifecycle route handlers that follow the pattern:
 * extract name → makeLifecycleCtx → call lifecycle fn → optionally broadcast → json 200/400.
 *
 * Keeps the handler inline noise to a single line per route.
 */
function lifecycleRoute(
  lifecycleFn: (ctx: LifecycleContext, name: string) => Promise<unknown>,
  opts?: { broadcast?: boolean | 'destroyed'; eventLabel?: string },
): RouteHandler {
  return async (_req, res, match, ctx) => {
    const name = match.pathname.groups['name']!;
    try {
      const lifecycleCtx = makeLifecycleCtx(ctx);
      await lifecycleFn(lifecycleCtx, name);
      if (opts?.broadcast === 'destroyed') {
        ctx.wss.broadcast(JSON.stringify({ type: 'agent_destroyed', name }));
      } else if (opts?.broadcast) {
        broadcastAgentUpdate(ctx, name);
      }
      if (opts?.eventLabel) {
        broadcastLifecycleEvent(ctx, name, opts.eventLabel);
      }
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  };
}

function makeLifecycleCtx(ctx: RouteContext): LifecycleContext {
  return {
    db: ctx.db,
    locks: ctx.locks,
    proxyDispatch: ctx.proxyDispatch,
    orchestratorHost: ctx.orchestratorHost,
    accountStore: ctx.accountStore,
  };
}

/**
 * Start Telegram long polling for a destination.
 * Routes inbound messages to agents via @agent-name prefix or to dashboard.
 * Exported for use in main.ts on startup.
 */
export function startTelegramPolling(ctx: RouteContext, dest: DestinationRecord): void {
  const botToken = dest.config['botToken'] as string;

  ctx.telegramDispatcher.startPolling(botToken, (incomingChatId: string, text: string) => {
    routeTelegramMessage(ctx, dest, incomingChatId, text);
  });
}

/**
 * Route a single inbound Telegram message to the appropriate destination:
 * - One or more `@agent` prefixes → fan out to those agents
 * - No prefix, `defaultAgent` configured + valid → route to default agent
 * - No prefix, no default agent → virtual "telegram" dashboard thread (existing fallback)
 *
 * Exported separately from startTelegramPolling so unit tests can exercise the
 * routing logic without spinning up the long-polling loop.
 */
export function routeTelegramMessage(
  ctx: RouteContext,
  dest: DestinationRecord,
  incomingChatId: string,
  text: string,
): void {
  const botToken = dest.config['botToken'] as string;
  console.log(`[telegram] Inbound from chat ${incomingChatId}: ${text.slice(0, 100)}`);

  // Comm-preference auto-clear: if this Telegram inbound is the operator
  // signalling "I'm at the dashboard now / stop notify", clear any active
  // routes AND skip creating a new route from THIS message. Without the
  // skip, the operator's "stop notify" Telegram would itself re-arm the
  // 30-min TTL. See telegram-routing.ts isCommPrefDirective.
  const commPrefMatched = isCommPrefDirective(text);
  if (commPrefMatched) {
    maybeAutoClearOnCommPref(text, `Telegram inbound from ${dest.name}`);
  }

  // Parse @agent-name prefixes — supports multiple: @agent1 @agent2 message
  const tagPattern = /^((?:@[a-zA-Z0-9_-]+\s+)+)([\s\S]+)$/;
  const tagMatch = text.match(tagPattern);
  const targetAgents: string[] = [];
  let messageText = text;

  if (tagMatch) {
    const tags = tagMatch[1]!.trim().split(/\s+/);
    for (const tag of tags) {
      if (tag.startsWith('@')) targetAgents.push(tag.slice(1));
    }
    messageText = tagMatch[2]!.trim();
  }

  if (targetAgents.length > 0) {
    const notFound: string[] = [];
    const delivered: string[] = [];

    for (const name of targetAgents) {
      const agent = ctx.db.getAgent(name);
      if (!agent) {
        notFound.push(name);
        continue;
      }

      enqueueAndDeliver(ctx, {
        agentName: name,
        displayMessage: messageText,
        envelope: messageText,
        topic: 'telegram',
        sourceAgent: `telegram:${dest.name}`,
      });
      // Record the route so agent → dashboard replies auto-forward back
      // to this Telegram chat for the TTL window. SKIPPED when the
      // operator's inbound is a comm-preference directive — otherwise
      // a "stop notify" Telegram itself would re-arm the TTL.
      if (!commPrefMatched) {
        recordTelegramInbound(name, dest.name, incomingChatId);
      }
      delivered.push(name);
    }

    if (delivered.length > 0) {
      console.log(`[telegram] Routed message to: ${delivered.join(', ')}`);
    }
    if (notFound.length > 0) {
      ctx.telegramDispatcher.send(botToken, incomingChatId, `Agent(s) not found: ${notFound.join(', ')}`).catch(() => {});
    }
  } else {
    // No agent prefix — fall back to the destination's `defaultAgent` config field
    // if present (e.g. a team-lead agent that is the implicit recipient for this
    // chat). Otherwise create a dashboard message visible under a virtual
    // "telegram" thread.
    const defaultAgent = typeof dest.config['defaultAgent'] === 'string'
      ? (dest.config['defaultAgent'] as string)
      : null;

    if (defaultAgent && ctx.db.getAgent(defaultAgent)) {
      enqueueAndDeliver(ctx, {
        agentName: defaultAgent,
        displayMessage: messageText,
        envelope: messageText,
        topic: 'telegram',
        sourceAgent: `telegram:${dest.name}`,
      });
      if (!commPrefMatched) {
        recordTelegramInbound(defaultAgent, dest.name, incomingChatId);
      }
      console.log(`[telegram] Routed unprefixed message to default agent: ${defaultAgent}`);
    } else {
      if (defaultAgent) {
        console.warn(`[telegram] defaultAgent "${defaultAgent}" not found — falling back to dashboard thread`);
      }
      const msg = ctx.db.addDashboardMessage('telegram', 'from_agent', messageText, {
        sourceAgent: `telegram:${dest.name}`,
      });
      ctx.wss.broadcast(JSON.stringify({ type: 'message', msg }));
      console.log('[telegram] Routed message to dashboard');
    }
  }
}
