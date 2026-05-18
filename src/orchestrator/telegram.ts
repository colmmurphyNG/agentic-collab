/**
 * Telegram Bot API dispatcher.
 * Handles outbound message sending and inbound long polling.
 * Uses native fetch() — no npm dependencies.
 */

const TELEGRAM_API = 'https://api.telegram.org';

/** Rate limiter: max 1 message per second per chatId. */
const lastSendTimestamps = new Map<string, number>();

export type InboundTelegramMessage = {
  chatId: string;
  text: string;
};

export class TelegramDispatcher {
  private pollingAbort: AbortController | null = null;
  private pollingPromise: Promise<void> | null = null;
  private lastUpdateId = 0;

  /**
   * Send a message to a Telegram chat via Bot API.
   * Respects rate limit of 1 message/second per chatId.
   *
   * `notifyId` is an optional correlation id (typically a UUID generated at the
   * /api/notify entry point) used to thread logs across attempt / outcome so
   * silent drops are diagnosable after the fact. Format key=value, parseable
   * via `grep notify_id=<id>` (see brain backlog item H1).
   */
  async send(botToken: string, chatId: string, text: string, notifyId?: string): Promise<boolean> {
    const idTag = notifyId ? `notify_id=${notifyId} ` : '';

    // Rate limit: 1 msg/sec per chatId.
    const now = Date.now();
    const lastSent = lastSendTimestamps.get(chatId) ?? 0;
    const elapsed = now - lastSent;
    if (elapsed < 1000) {
      const waitMs = 1000 - elapsed;
      if (notifyId) console.log(`[telegram] ${idTag}rate_limit_wait ms=${waitMs} chat_id=${chatId}`);
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
    lastSendTimestamps.set(chatId, Date.now());

    if (notifyId) console.log(`[telegram] ${idTag}attempt chat_id=${chatId} bytes=${text.length}`);

    try {
      const resp = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        // Full body, no truncation — Telegram error bodies are small and the
        // detail is what tells you whether it was rate-limit / bad token / etc.
        console.error(`[telegram] ${idTag}delivery_failed http_status=${resp.status} chat_id=${chatId} body=${body}`);
        return false;
      }
      if (notifyId) console.log(`[telegram] ${idTag}delivered http_status=${resp.status} chat_id=${chatId}`);
      return true;
    } catch (err) {
      const e = err as Error;
      // Surface the error class (TimeoutError / TypeError / AbortError) — they
      // diagnose differently. TimeoutError = api.telegram.org didn't respond in
      // 10s; TypeError = DNS / TLS / connection failure.
      console.error(`[telegram] ${idTag}delivery_error error_name=${e.name} chat_id=${chatId} message=${e.message}`);
      return false;
    }
  }

  /**
   * Start long polling for inbound messages.
   * Calls onMessage for each text message received.
   * Retries on error after 5s delay.
   */
  startPolling(botToken: string, onMessage: (chatId: string, text: string) => void): void {
    if (this.pollingAbort) {
      this.stopPolling();
    }
    this.pollingAbort = new AbortController();
    this.lastUpdateId = 0;

    const poll = async (): Promise<void> => {
      const signal = this.pollingAbort!.signal;
      while (!signal.aborted) {
        try {
          const url = `${TELEGRAM_API}/bot${botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`;
          const resp = await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error(`[telegram] getUpdates failed (${resp.status}): ${body}`);
            if (!signal.aborted) await delay(5000, signal);
            continue;
          }
          const data = await resp.json() as { ok: boolean; result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> };
          if (!data.ok || !data.result) {
            if (!signal.aborted) await delay(5000, signal);
            continue;
          }
          for (const update of data.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            if (update.message?.text) {
              const chatId = String(update.message.chat.id);
              onMessage(chatId, update.message.text);
            }
          }
        } catch (err) {
          if (signal.aborted) return;
          console.error(`[telegram] Poll error: ${(err as Error).message}`);
          await delay(5000, signal).catch(() => {});
        }
      }
    };

    this.pollingPromise = poll();
    console.log('[telegram] Long polling started');
  }

  /** Stop polling gracefully. */
  stopPolling(): void {
    if (this.pollingAbort) {
      this.pollingAbort.abort();
      this.pollingAbort = null;
      this.pollingPromise = null;
      console.log('[telegram] Long polling stopped');
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
