import type { ProxyCommand, ProxyRegistration, ProxyResponse } from '../shared/types.ts';

export const PROXY_RETRY_COUNT = 2;
const PROXY_RETRY_BASE_MS = 500;
const PROXY_REQUEST_TIMEOUT_MS = 15_000;

export type ProxyDispatch = (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;

/**
 * Send a command to a proxy, retrying transport failures.
 *
 * A response the proxy sent is returned as-is, even an error: that is the
 * proxy's account of the agent. Only when no response arrived (not registered,
 * refused, timed out) is the result marked `unreachable`, because then nothing
 * is known about the agent and callers must not treat it as an agent fault.
 */
export function createProxyDispatch(
  getProxy: (proxyId: string) => ProxyRegistration | null | undefined,
  fetchImpl: typeof fetch = fetch,
  retryBaseMs = PROXY_RETRY_BASE_MS,
): ProxyDispatch {
  return async (proxyId, command) => {
    const proxy = getProxy(proxyId);
    if (!proxy) {
      return { ok: false, unreachable: true, error: `Proxy "${proxyId}" not registered` };
    }

    let lastError = '';
    for (let attempt = 0; attempt <= PROXY_RETRY_COUNT; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 500ms, 1000ms
        const delay = retryBaseMs * Math.pow(2, attempt - 1);
        await new Promise<void>((r) => setTimeout(r, delay));
      }

      try {
        const resp = await fetchImpl(`http://${proxy.host}/command`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-proxy-token': proxy.token,
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(PROXY_REQUEST_TIMEOUT_MS),
        });

        if (!resp.ok) {
          const text = await resp.text();
          return { ok: false, error: `Proxy returned ${resp.status}: ${text}` };
        }

        return await resp.json() as ProxyResponse;
      } catch (err) {
        lastError = (err as Error).message;
        if (attempt < PROXY_RETRY_COUNT) {
          console.warn(`[proxy-dispatch] Attempt ${attempt + 1} failed for ${proxyId}: ${lastError}, retrying...`);
        }
      }
    }

    return {
      ok: false,
      unreachable: true,
      error: `Proxy unreachable after ${PROXY_RETRY_COUNT + 1} attempts: ${lastError}`,
    };
  };
}
