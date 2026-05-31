/**
 * Default engine config definitions.
 * Used for initial seeding and the "Reset Defaults" action.
 */

export type DefaultEngineConfig = {
  name: string;
  engine: string;
  model?: string | null;
  thinking?: string | null;
  permissions?: string | null;
  hookStart?: string | null;
  hookResume?: string | null;
  hookCompact?: string | null;
  hookExit?: string | null;
  hookInterrupt?: string | null;
  hookReload?: string | null;
  hookSubmit?: string | null;
  indicators?: string | null;
  detection?: string | null;
  launchEnv?: Record<string, string> | null;
};

// Shared indicator definitions
const UNSAFE_INDICATOR = { id: 'unsafe', regex: '.', badge: 'Unsafe', style: 'danger' };
const LOW_CONTEXT_INDICATOR = { id: 'low-context', regex: 'Context left until', badge: 'Low Context', style: 'danger' };
const CONTEXT_LIMIT_INDICATOR = { id: 'context-limit', regex: 'Context limit reached', badge: 'Context Limit', style: 'danger' };
// Approval-style prompts come in three shapes across Claude Code 2.1.x:
//   1. Yes / No / Always allow ......... older yes/no permission prompts
//   2. Do you want to proceed? ......... newer (2.1.142+) confirmation prompts
//   3. AskUserQuestion UI .............. multi-option numbered prompts, identified
//                                        by the footer
//                                        "Enter to select · ↑/↓ to navigate · Esc to cancel"
// Without shape 3, the indicator-bridge (PR #41) doesn't fire on AskUserQuestion
// prompts and the question never surfaces to the Messages thread (empirical
// trigger: pwa-2391 PHX-2472 npm-install recovery, 2026-05-30). All three shapes
// folded into the default regex; per-persona overrides win when present.
const CLAUDE_APPROVAL_INDICATOR = {
  id: 'approval',
  regex: '(Yes)\\s*/\\s*(No)\\s*/\\s*(Always allow)|Do you want to proceed\\?|Enter to select.{1,30}to navigate.{1,30}Esc to cancel',
  badge: 'Needs Approval',
  style: 'warning',
  actions: {
    '$1': [{ type: 'keystroke', keystroke: '$1' }],
    '$2': [{ type: 'keystroke', keystroke: '$2' }],
    '$3': [{ type: 'keystroke', keystroke: '$3' }],
  },
};
const CLAUDE_FILE_PERMISSION_INDICATOR = {
  id: 'file-permission',
  regex: 'Do you want to .+\\?',
  badge: 'Needs Approval',
  style: 'warning',
  actions: {
    'Yes': [{ type: 'keystroke', keystroke: '1' }],
    'Allow All': [{ type: 'keystroke', keystroke: '2' }],
    'No': [{ type: 'keystroke', keystroke: '3' }],
  },
};
const CLAUDE_PLAN_INDICATOR = {
  id: 'plan-review',
  regex: '(approve)\\s*/\\s*(deny)\\s*/\\s*(edit)',
  badge: 'Plan Review',
  style: 'warning',
  actions: {
    '$1': [{ type: 'keystroke', keystroke: '$1' }],
    '$2': [{ type: 'keystroke', keystroke: '$2' }],
    '$3': [{ type: 'keystroke', keystroke: '$3' }],
  },
};
const CLAUDE_RESUME_PROMPT_INDICATOR = {
  id: 'resume-prompt',
  regex: 'Resume from summary',
  badge: 'Resume Prompt',
  style: 'warning',
  actions: {
    'Summary': [{ type: 'keystroke', keystroke: 'Enter' }],
    'Full': [{ type: 'keystroke', keystroke: 'Down' }, { type: 'keystroke', keystroke: 'Enter' }],
  },
};
const LOGGED_OUT_INDICATOR = { id: 'logged-out', regex: 'Not logged in', badge: 'Logged Out', style: 'danger' };
const LOCAL_AGENTS_INDICATOR = { id: 'local-agents', regex: '\\u00b7\\s*(\\d+) local agents?', badge: '$1 Local Agents', style: 'info' };
const BACKGROUND_SHELLS_INDICATOR = { id: 'bg-shells', regex: '\\u00b7\\s*(\\d+) shells?', badge: '$1 Shells', style: 'info' };
const BACKGROUND_TASKS_INDICATOR = { id: 'bg-tasks', regex: '\\u00b7\\s*(\\d+) background tasks?', badge: '$1 Background', style: 'info' };

// Activity-context indicator — surfaces the spinner line text ("Watching X for
// 10m") so the operator can distinguish "agent is genuinely busy on a long
// task" from "agent is dead/stuck/ignoring" without opening the Watch pane.
// Line-anchored + requires both the spinner glyph and a parenthesised time so
// it won't false-positive on prose mentions of the verbs. style=info means it
// doesn't trigger the indicator-bridge (no Messages spam) — agent-card only.
// Verbs claude emits include Watching, Brewed, Baked, Cogitated, Crunched,
// Churned, Nucleating, Warping, Improvising — captured generically as \\S+.
const CLAUDE_ACTIVITY_INDICATOR = {
  id: 'activity',
  // Matches BOTH spinner shapes claude emits:
  //   "✻ Brewed for 13s · 2 shells"     (past-tense, bare time after "for")
  //   "✶ Watching X… (10m 20s · ↓ ...)" (ongoing, parenthesised time)
  // Group 1 captures the verb (Watching / Brewed / Cogitated / etc.); group 2
  // captures the time component (e.g. "13s", "10m 20s", "1m 33s"). The glyph
  // anchor + line-start prevents prose false-positives.
  //
  // lines: 10 constrains evaluation to the last 10 lines of the pane snapshot.
  // Stale spinner-line text persists in scrollback for hours after an agent
  // goes idle; without this constraint, the activity badge stays falsely
  // active on idle agent cards. The live spinner renders in the footer area
  // (last ~5–8 lines), so 10 gives a safe margin without admitting scrollback.
  regex: '(?:^|\\n)\\s*[\\u2736\\u2733\\u273b\\u2722]\\s+(\\w+)[^\\n]{0,120}?(\\d+[ms](?:\\s+\\d+[ms])?)',
  badge: '$1 $2',
  style: 'info',
  lines: 10,
};

// Queued-input indicator — fires when claude has stacked operator inbounds in
// the textarea behind a long-running tool call. Distinguishes "no response
// because dead" from "no response because busy + queue backed up". warning
// style → bridges to Messages thread (PR #41) so operator gets a heads-up.
//
// lines: 10 same rationale — only fire when the "Press up to edit queued"
// footer is currently visible at the bottom of the pane, not when it appears
// in scrollback after the inbounds got processed.
const CLAUDE_QUEUED_INPUT_INDICATOR = {
  id: 'queued-input',
  regex: '(?:^|\\n)\\s*\\u276f Press up to edit queued messages',
  badge: 'Queued input',
  style: 'warning',
  lines: 10,
};

// Detection configs per engine — regex patterns for idle/active state detection
const CLAUDE_DETECTION = {
  idlePatterns: [
    { pattern: '^[\\u276f>]\\s*$', lines: 5 },            // prompt waiting for input (❯ or >)
  ],
  activePatterns: [
    '^\\s*(Read|Write|Edit|Bash|Glob|Grep|Agent|WebFetch|WebSearch)\\s',  // tool execution
    '^[\\u280b\\u2819\\u2839\\u2838\\u283c\\u2834\\u2826\\u2827\\u2807\\u280f]',  // braille spinner
    { pattern: '\\u00b7\\s*\\d+ local agents?', lines: 3 },  // sub-agents (status bar only)
    // Background shells and background tasks are deliberately NOT active signals.
    // Long-lived bg shells (forgotten polls, stuck playwright runs) routinely
    // outlive the agent's interest in them and were causing permanent
    // false-active state. The braille spinner above covers the legitimate
    // "actively-thinking-and-spawning-tools" case; bg-shell counts remain
    // visible as info indicators (see BACKGROUND_SHELLS_INDICATOR /
    // BACKGROUND_TASKS_INDICATOR above).
  ],
  contextPattern: '(\\d+)\\s*tokens',
  idleThreshold: 2,
  activeGraceMs: 10000,
  snapshotLines: 30,
  autoRecover: true,
};

const CODEX_DETECTION = {
  idlePatterns: [
    { pattern: '^[\\u203a\\u276f>]\\s', lines: 5 },       // prompt chars (›, ❯, >)
    { pattern: '^[\\u203a\\u276f>]\\s*$', lines: 5 },     // prompt at end of line
  ],
  activePatterns: [
    '^[\\u25e6\\u2022]\\s*Working', // working indicator (◦/• Working)
  ],
  contextPattern: '(\\d+)%\\s+(?:context\\s+)?left',
  idleThreshold: 2,
  activeGraceMs: 10000,
  snapshotLines: 30,
};

const OPENCODE_DETECTION = {
  idlePatterns: [
    { pattern: 'ctrl\\+t\\s+variants', lines: 3 },        // idle TUI hint
    { pattern: 'ask anything', lines: 3 },                 // input placeholder
  ],
  activePatterns: [
    { pattern: 'esc\\s+interrupt', lines: 3 },             // processing indicator
  ],
  contextPattern: '(\\d+)%\\s+used',
  idleThreshold: 2,
  activeGraceMs: 10000,
  snapshotLines: 30,
};

export const DEFAULT_ENGINE_CONFIGS: DefaultEngineConfig[] = [
  {
    name: 'claude',
    engine: 'claude',
    hookStart: JSON.stringify([
      { type: 'shell', command: 'claude --dangerously-skip-permissions --model opus --effort max --append-system-prompt $PERSONA_PROMPT' },
      { type: 'wait', ms: 5000 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 500 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 1000 },
      { type: 'shell', command: '/status' },
      { type: 'capture', lines: 30, regex: 'uuid', var: 'SESSION_ID' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    hookResume: JSON.stringify([
      { type: 'shell', command: 'claude --resume $SESSION_ID --append-system-prompt $PERSONA_PROMPT' },
      { type: 'wait', ms: 5000 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 500 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 1000 },
      { type: 'shell', command: '/status' },
      { type: 'capture', lines: 30, regex: 'uuid', var: 'SESSION_ID' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    hookCompact: JSON.stringify([
      { type: 'shell', command: '/compact' },
    ]),
    hookExit: JSON.stringify([
      { type: 'shell', command: '/exit' },
    ]),
    hookInterrupt: JSON.stringify([
      { type: 'keystroke', key: 'Escape' },
      { type: 'keystroke', key: 'Escape' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    hookReload: JSON.stringify([
      { type: 'shell', command: '/exit' },
      { type: 'wait', ms: 10000 },
      { type: 'shell', command: 'claude --dangerously-skip-permissions --model opus --effort max --append-system-prompt $PERSONA_PROMPT' },
      { type: 'wait', ms: 5000 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 500 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 1000 },
      { type: 'shell', command: '/status' },
      { type: 'capture', lines: 30, regex: 'uuid', var: 'SESSION_ID' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    indicators: JSON.stringify([
      UNSAFE_INDICATOR,
      CLAUDE_APPROVAL_INDICATOR,
      CLAUDE_FILE_PERMISSION_INDICATOR,
      CLAUDE_PLAN_INDICATOR,
      CLAUDE_RESUME_PROMPT_INDICATOR,
      LOW_CONTEXT_INDICATOR,
      CONTEXT_LIMIT_INDICATOR,
      LOGGED_OUT_INDICATOR,
      LOCAL_AGENTS_INDICATOR,
      BACKGROUND_SHELLS_INDICATOR,
      BACKGROUND_TASKS_INDICATOR,
      CLAUDE_ACTIVITY_INDICATOR,
      CLAUDE_QUEUED_INPUT_INDICATOR,
    ]),
    detection: JSON.stringify(CLAUDE_DETECTION),
  },
  {
    name: 'codex',
    engine: 'codex',
    hookStart: JSON.stringify([
      { type: 'shell', command: 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -p $AGENT_NAME' },
    ]),
    hookResume: JSON.stringify([
      { type: 'shell', command: 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -p $AGENT_NAME resume $SESSION_ID' },
    ]),
    indicators: JSON.stringify([
      UNSAFE_INDICATOR,
    ]),
    detection: JSON.stringify(CODEX_DETECTION),
  },
  {
    name: 'opencode',
    engine: 'opencode',
    hookStart: JSON.stringify([
      { type: 'shell', command: 'opencode' },
    ]),
    hookResume: JSON.stringify([
      { type: 'shell', command: 'opencode -s $SESSION_ID' },
    ]),
    indicators: JSON.stringify([
      LOW_CONTEXT_INDICATOR,
      CONTEXT_LIMIT_INDICATOR,
    ]),
    detection: JSON.stringify(OPENCODE_DETECTION),
  },
];
