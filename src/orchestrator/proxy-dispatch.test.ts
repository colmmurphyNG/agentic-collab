import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProxyRegistration } from '../shared/types.ts';
import { createProxyDispatch, PROXY_RETRY_COUNT } from './proxy-dispatch.ts';

const proxy: ProxyRegistration = {
  proxyId: 'p1',
  token: 'tok',
  host: 'localhost:3100',
  version: null,
  versionMatch: true,
  lastHeartbeat: '2026-10-30T00:00:00Z',
  registeredAt: '2026-10-30T00:00:00Z',
};
const capture = { action: 'capture', sessionName: 'agent-x', lines: 50 } as const;

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('createProxyDispatch', () => {
  it('marks an unregistered proxy as unreachable', async () => {
    const dispatch = createProxyDispatch(() => undefined, fetchReturning(200, { ok: true }), 0);
    const result = await dispatch('gone', capture);
    assert.equal(result.ok, false);
    assert.equal(result.unreachable, true);
    assert.match(result.error ?? '', /not registered/);
  });

  it('marks a transport failure as unreachable after retrying', async () => {
    let calls = 0;
    const failingFetch = (async () => { calls++; throw new TypeError('fetch failed'); }) as typeof fetch;
    const dispatch = createProxyDispatch(() => proxy, failingFetch, 0);
    const result = await dispatch('p1', capture);
    assert.equal(result.ok, false);
    assert.equal(result.unreachable, true);
    assert.equal(calls, PROXY_RETRY_COUNT + 1);
    assert.match(result.error ?? '', /Proxy unreachable after 3 attempts: fetch failed/);
  });

  it('passes through an error the proxy sent, without marking it unreachable', async () => {
    const dispatch = createProxyDispatch(() => proxy, fetchReturning(200, { ok: false, error: "can't find session" }), 0);
    const result = await dispatch('p1', capture);
    assert.equal(result.ok, false);
    assert.equal(result.unreachable, undefined);
    assert.equal(result.error, "can't find session");
  });

  it('treats an HTTP error status as an answer, not as unreachable', async () => {
    const dispatch = createProxyDispatch(() => proxy, fetchReturning(500, 'boom'), 0);
    const result = await dispatch('p1', capture);
    assert.equal(result.ok, false);
    assert.equal(result.unreachable, undefined);
    assert.match(result.error ?? '', /Proxy returned 500/);
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const flakyFetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: true, data: 'pane' }), { status: 200 });
    }) as typeof fetch;
    const dispatch = createProxyDispatch(() => proxy, flakyFetch, 0);
    const result = await dispatch('p1', capture);
    assert.deepEqual(result, { ok: true, data: 'pane' });
  });
});
