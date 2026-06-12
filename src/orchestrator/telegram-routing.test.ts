import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordTelegramInbound,
  getActiveTelegramRoute,
  clearTelegramRoute,
  listTelegramRoutes,
  _resetTelegramRoutes,
  isCommPrefDirective,
  maybeAutoClearOnCommPref,
} from './telegram-routing.ts';

describe('telegram-routing (auto-forward state map)', () => {
  beforeEach(() => {
    _resetTelegramRoutes();
  });

  it('should record a route and retrieve it within TTL', () => {
    const now = 1_000_000;
    recordTelegramInbound('tl', 'cmCollab', '1296942585', now);
    const route = getActiveTelegramRoute('tl', now + 1000);
    assert.ok(route, 'route should exist');
    assert.equal(route?.agentName, 'tl');
    assert.equal(route?.destName, 'cmCollab');
    assert.equal(route?.chatId, '1296942585');
  });

  it('should return null when no route is recorded', () => {
    assert.equal(getActiveTelegramRoute('never-seen'), null);
  });

  it('should return null when route has expired (and lazy-delete it)', () => {
    const now = 1_000_000;
    recordTelegramInbound('tl', 'cmCollab', '123', now);
    // Default TTL is 30 min; fast-forward past it.
    const beyondTTL = now + (31 * 60 * 1000);
    assert.equal(getActiveTelegramRoute('tl', beyondTTL), null);
    // Confirm the expired entry was removed from the map.
    assert.equal(listTelegramRoutes(beyondTTL).length, 0);
  });

  it('should refresh TTL when the same agent receives another inbound', () => {
    const t0 = 1_000_000;
    recordTelegramInbound('tl', 'cmCollab', '123', t0);
    const halfwayTTL = t0 + (15 * 60 * 1000);
    // New inbound at halfway — extends expiry.
    recordTelegramInbound('tl', 'cmCollab', '123', halfwayTTL);
    // 25 min after t0 = before the refreshed expiry; would have expired without refresh.
    const t25 = t0 + (25 * 60 * 1000);
    const route = getActiveTelegramRoute('tl', t25);
    assert.ok(route, 'refreshed route should still be active 25min after first inbound');
  });

  it('should track multiple agents independently', () => {
    const now = 1_000_000;
    recordTelegramInbound('tl', 'cmCollab', '111', now);
    recordTelegramInbound('sfcc', 'cmCollab', '111', now);
    recordTelegramInbound('pwa', 'otherDest', '222', now);

    assert.ok(getActiveTelegramRoute('tl', now));
    assert.ok(getActiveTelegramRoute('sfcc', now));
    const pwaRoute = getActiveTelegramRoute('pwa', now);
    assert.equal(pwaRoute?.destName, 'otherDest');
    assert.equal(pwaRoute?.chatId, '222');
    assert.equal(listTelegramRoutes(now).length, 3);
  });

  it('should let the latest inbound win for an agent (most recent chat/destination)', () => {
    const now = 1_000_000;
    recordTelegramInbound('tl', 'destA', 'chat-A', now);
    recordTelegramInbound('tl', 'destB', 'chat-B', now + 1000);
    const route = getActiveTelegramRoute('tl', now + 2000);
    assert.equal(route?.destName, 'destB');
    assert.equal(route?.chatId, 'chat-B');
  });

  it('should clear a specific agent\'s route on demand', () => {
    const now = 1_000_000;
    recordTelegramInbound('tl', 'cmCollab', '123', now);
    recordTelegramInbound('sfcc', 'cmCollab', '123', now);

    const cleared = clearTelegramRoute('tl');
    assert.equal(cleared, true);
    assert.equal(getActiveTelegramRoute('tl', now), null);
    assert.ok(getActiveTelegramRoute('sfcc', now), 'unrelated routes untouched');
  });

  it('should return false when clearing a non-existent route', () => {
    assert.equal(clearTelegramRoute('never-seen'), false);
  });

  it('should filter expired entries from listTelegramRoutes', () => {
    const t0 = 1_000_000;
    recordTelegramInbound('active', 'cmCollab', 'a', t0);
    recordTelegramInbound('stale',  'cmCollab', 'b', t0 - (60 * 60 * 1000)); // way in the past
    const live = listTelegramRoutes(t0);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.agentName, 'active');
  });

  describe('isCommPrefDirective', () => {
    it('should match notify-off directives', () => {
      assert.ok(isCommPrefDirective('turn off --notify, Im at dashboard'));
      assert.ok(isCommPrefDirective('stop --notify please'));
      assert.ok(isCommPrefDirective('no notify on this thread'));
      assert.ok(isCommPrefDirective('stop notifying me'));
      assert.ok(isCommPrefDirective('disable notify'));
    });

    it('should match "at dashboard" directives', () => {
      assert.ok(isCommPrefDirective("I'm at the dashboard now"));
      assert.ok(isCommPrefDirective('I am at dashboard'));
      assert.ok(isCommPrefDirective('Im at the dashboard'));
      assert.ok(isCommPrefDirective('back at dashboard'));
      assert.ok(isCommPrefDirective('Im back at the dashboard'));
    });

    it('should match complaint forms', () => {
      assert.ok(isCommPrefDirective('still notifying me despite repeated asks'));
      assert.ok(isCommPrefDirective('dashboard-quiet please'));
    });

    it('should NOT false-positive on benign notify mentions', () => {
      assert.ok(!isCommPrefDirective('we should notify the team'));
      assert.ok(!isCommPrefDirective('add a notify when CI fails'));
      assert.ok(!isCommPrefDirective('check the dashboard for status'));
      assert.ok(!isCommPrefDirective('hello'));
      assert.ok(!isCommPrefDirective(''));
    });
  });

  describe('maybeAutoClearOnCommPref', () => {
    // These tests use real Date.now() because maybeAutoClearOnCommPref +
    // listTelegramRoutes (inside it) read wall-clock time internally;
    // passing past timestamps to recordTelegramInbound would create
    // already-expired routes that filter out before the clear sees them.
    it('should clear all routes when text matches', () => {
      recordTelegramInbound('tl', 'cmCollab', '1');
      recordTelegramInbound('pwa', 'cmCollab', '1');
      assert.equal(listTelegramRoutes().length, 2);
      const cleared = maybeAutoClearOnCommPref('turn off --notify, Im at dashboard', 'test');
      assert.equal(cleared, 2);
      assert.equal(listTelegramRoutes().length, 0);
    });

    it('should be no-op when text does not match', () => {
      recordTelegramInbound('tl', 'cmCollab', '1');
      const cleared = maybeAutoClearOnCommPref('please review PR #1234', 'test');
      assert.equal(cleared, 0);
      assert.equal(listTelegramRoutes().length, 1);
    });

    it('should be no-op on empty input', () => {
      recordTelegramInbound('tl', 'cmCollab', '1');
      assert.equal(maybeAutoClearOnCommPref('', 'test'), 0);
      assert.equal(listTelegramRoutes().length, 1);
    });

    it('should be idempotent (second call returns 0)', () => {
      recordTelegramInbound('tl', 'cmCollab', '1');
      assert.equal(maybeAutoClearOnCommPref("I'm at the dashboard now", 'test'), 1);
      assert.equal(maybeAutoClearOnCommPref("I'm at the dashboard now", 'test'), 0);
    });
  });
});
