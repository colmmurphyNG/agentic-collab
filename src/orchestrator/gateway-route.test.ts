import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyRoute, gatewayConfigured, hostConfigDir, isAgentRoute, materialiseGatewaySettings, modelFamily,
  rewriteForGateway, seatSettingsPath,
} from './gateway-route.ts';

// The shape of a real persona resume line, with the seat settings file and a pinned model.
const SEAT_CMD = 'claude --resume $SESSION_ID --dangerously-skip-permissions --model claude-haiku-4-5 $ADD_DIR_FLAGS --settings /cfg/agent-plugin-settings.json --append-system-prompt-file $PERSONA_PROMPT_FILEPATH';

describe('modelFamily', () => {
  it('maps model ids to their family alias', () => {
    assert.equal(modelFamily('claude-opus-5-5[1m]'), 'opus');
    assert.equal(modelFamily('claude-sonnet-5'), 'sonnet');
    assert.equal(modelFamily('claude-haiku-4-5'), 'haiku');
    assert.equal(modelFamily('opus'), 'opus');
  });

  it('returns null for an id with no known family', () => {
    assert.equal(modelFamily('gpt-5.4'), null);
  });
});

describe('isAgentRoute', () => {
  it('accepts only seat and gateway', () => {
    assert.equal(isAgentRoute('seat'), true);
    assert.equal(isAgentRoute('gateway'), true);
    assert.equal(isAgentRoute('openrouter'), false);
    assert.equal(isAgentRoute(undefined), false);
  });
});

describe('seatSettingsPath', () => {
  it('reads bare and quoted values', () => {
    assert.equal(seatSettingsPath(SEAT_CMD), '/cfg/agent-plugin-settings.json');
    assert.equal(seatSettingsPath("claude --settings '/a b/s.json' -p x"), '/a b/s.json');
  });

  it('returns null when there is no --settings flag', () => {
    assert.equal(seatSettingsPath('claude --model opus'), null);
  });
});

describe('rewriteForGateway', () => {
  it('swaps the settings file and the model, and keeps everything else', () => {
    const out = rewriteForGateway(SEAT_CMD, '/cfg/gateway-settings/drone.json');
    assert.equal(
      out,
      "claude --resume $SESSION_ID --dangerously-skip-permissions --model haiku $ADD_DIR_FLAGS --settings '/cfg/gateway-settings/drone.json' --append-system-prompt-file $PERSONA_PROMPT_FILEPATH",
    );
  });

  it('adds --settings right after claude when the command has none', () => {
    assert.equal(
      rewriteForGateway('claude --model opus --effort max', '/g.json'),
      "claude --settings '/g.json' --model opus --effort max",
    );
  });

  it('leaves a model with no known family alone', () => {
    const out = rewriteForGateway('claude --model custom-model --settings /s.json', '/g.json');
    assert.match(out, /--model custom-model/);
  });

  it('leaves a command that does not launch claude unchanged', () => {
    const cmd = 'codex --model gpt-5.4 --settings /s.json';
    assert.equal(rewriteForGateway(cmd, '/g.json'), cmd);
  });

  it('does not treat a word containing "claude" as the claude command', () => {
    const cmd = 'claude-code-helper --settings /s.json';
    assert.equal(rewriteForGateway(cmd, '/g.json'), cmd);
  });
});

describe('gateway settings on disk', () => {
  let dir: string;
  let savedConfigDir: string | undefined;
  let savedHostHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-route-'));
    savedConfigDir = process.env['AGENTIC_COLLAB_CONFIG_DIR'];
    savedHostHome = process.env['HOST_HOME'];
    process.env['AGENTIC_COLLAB_CONFIG_DIR'] = dir;
    delete process.env['HOST_HOME'];
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env['AGENTIC_COLLAB_CONFIG_DIR'];
    else process.env['AGENTIC_COLLAB_CONFIG_DIR'] = savedConfigDir;
    if (savedHostHome === undefined) delete process.env['HOST_HOME'];
    else process.env['HOST_HOME'] = savedHostHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const overlay = {
    apiKeyHelper: 'python3 /x/gateway-token.py',
    env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5' },
  };

  it('is not configured, and writes nothing, without an overlay', () => {
    assert.equal(gatewayConfigured(), false);
    assert.equal(materialiseGatewaySettings('drone', SEAT_CMD), null);
    assert.equal(existsSync(join(dir, 'gateway-settings')), false);
  });

  it('is not configured when the overlay is not a JSON object', () => {
    writeFileSync(join(dir, 'gateway-settings.json'), '[1, 2]');
    assert.equal(materialiseGatewaySettings('drone', SEAT_CMD), null);
  });

  it('merges the overlay onto the seat settings file, keeping plugins and seat env', () => {
    writeFileSync(join(dir, 'gateway-settings.json'), JSON.stringify(overlay));
    const seatPath = join(dir, 'agent-plugin-settings.json');
    writeFileSync(seatPath, JSON.stringify({ enabledPlugins: { 'a@b': true }, env: { KEEP_ME: '1', ANTHROPIC_BASE_URL: 'seat' } }));

    const out = materialiseGatewaySettings('drone', `claude --settings ${seatPath}`);
    assert.equal(out, join(dir, 'gateway-settings', 'drone.json'));
    const merged = JSON.parse(readFileSync(out!, 'utf-8'));
    assert.deepEqual(merged.enabledPlugins, { 'a@b': true });
    assert.equal(merged.apiKeyHelper, overlay.apiKeyHelper);
    assert.deepEqual(merged.env, { KEEP_ME: '1', ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5' });
    assert.equal(statSync(out!).mode & 0o777, 0o600);
  });

  it('uses the overlay alone when the seat file is outside the config dir', () => {
    writeFileSync(join(dir, 'gateway-settings.json'), JSON.stringify(overlay));
    const out = materialiseGatewaySettings('drone', 'claude --settings /elsewhere/s.json');
    const merged = JSON.parse(readFileSync(out!, 'utf-8'));
    assert.deepEqual(merged, overlay);
  });

  it('maps the container config dir to the host one when running in Docker', () => {
    process.env['AGENTIC_COLLAB_CONFIG_DIR'] = '/config/agentic-collab';
    process.env['HOST_HOME'] = '/Users/someone';
    assert.equal(hostConfigDir(), '/Users/someone/.config/agentic-collab');
  });

  describe('applyRoute', () => {
    const agent = (route: string | null, engine = 'claude') => ({ name: 'drone', engine, route });

    it('passes seat agents through untouched', () => {
      writeFileSync(join(dir, 'gateway-settings.json'), JSON.stringify(overlay));
      assert.equal(applyRoute(agent(null), SEAT_CMD), SEAT_CMD);
    });

    it('rewrites a gateway agent once the gateway is set up', () => {
      writeFileSync(join(dir, 'gateway-settings.json'), JSON.stringify(overlay));
      const out = applyRoute(agent('gateway'), SEAT_CMD);
      assert.match(out, new RegExp(`--settings '${join(dir, 'gateway-settings', 'drone.json')}'`));
      assert.match(out, /--model haiku /);
    });

    it('launches a gateway agent on the seat when the gateway is not set up', () => {
      assert.equal(applyRoute(agent('gateway'), SEAT_CMD), SEAT_CMD);
    });

    it('ignores the route for non-claude engines', () => {
      writeFileSync(join(dir, 'gateway-settings.json'), JSON.stringify(overlay));
      assert.equal(applyRoute(agent('gateway', 'codex'), SEAT_CMD), SEAT_CMD);
    });
  });
});
