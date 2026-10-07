/**
 * Building blocks for the `/scratch` index: an async markdown walker, a
 * stale-while-revalidate cache, and the slow-request logger.
 *
 * Everything here is async so a multi-thousand-file walk over a Docker bind
 * mount never blocks the event loop; the orchestrator must keep answering
 * other requests (and `collab` discovery) while an index build runs.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type MarkdownFile = { relPath: string; size: number; mtimeMs: number };

/** A directory containing this file is omitted from the index listing (and so is
 *  everything beneath it). Files under it are still served by direct URL. */
export const SCRATCH_SKIP_MARKER = '.scratch-skip';

/** Recursively collect `.md` files under `root`, relative to it. Skips
 *  dot-prefixed entries, `node_modules`, `.git`, and any directory holding a
 *  `.scratch-skip` marker. Directories are read sequentially; the stats within
 *  one directory run concurrently. */
export async function listMarkdownRecursiveAsync(root: string): Promise<MarkdownFile[]> {
  const results: MarkdownFile[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === SCRATCH_SKIP_MARKER)) return;
    const mdFiles: Array<{ full: string; rel: string }> = [];
    const subdirs: Array<{ full: string; rel: string }> = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) subdirs.push({ full, rel });
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) mdFiles.push({ full, rel });
    }
    const stats = await Promise.all(mdFiles.map(async (f) => {
      try {
        const st = await stat(f.full);
        return { relPath: f.rel, size: st.size, mtimeMs: st.mtimeMs };
      } catch { return null; } // file vanished between readdir and stat
    }));
    for (const s of stats) if (s) results.push(s);
    for (const d of subdirs) await walk(d.full, d.rel);
  }
  await walk(root, '');
  return results;
}

export type SwrCache<T> = {
  get(): Promise<T>;
  /** Drop the cached value (an in-flight build still completes but is discarded). */
  clear(): void;
};

/** Stale-while-revalidate cache over an async builder. The first call awaits the
 *  build; later calls within `ttlMs` return the cached value; after that the stale
 *  value is returned immediately while one background rebuild runs. At most one
 *  build is in flight. A failed refresh keeps the stale value; a failed first
 *  build rejects and is retried by the next call. */
export function createSwrCache<T>(build: () => Promise<T>, ttlMs: number, now: () => number = Date.now): SwrCache<T> {
  let value: { v: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  let generation = 0;

  function start(): Promise<T> {
    const gen = generation;
    const p: Promise<T> = build().then(
      (v) => {
        if (gen === generation) value = { v, at: now() };
        if (inflight === p) inflight = null;
        return v;
      },
      (err) => {
        if (inflight === p) inflight = null;
        throw err;
      },
    );
    inflight = p;
    return p;
  }

  return {
    get() {
      if (!value) return inflight ?? start();
      if (now() - value.at >= ttlMs && !inflight) start().catch(() => { /* keep serving the stale copy */ });
      return Promise.resolve(value.v);
    },
    clear() {
      value = null;
      inflight = null;
      generation++;
    },
  };
}

/** Log one line when a request took longer than `thresholdMs`: method, path (no
 *  query string), duration. Silent otherwise. */
export function logIfSlow(
  method: string | undefined,
  rawUrl: string | undefined,
  startedAtMs: number,
  endedAtMs: number,
  thresholdMs: number,
  log: (line: string) => void = (l) => console.warn(l),
): void {
  const duration = endedAtMs - startedAtMs;
  if (duration <= thresholdMs) return;
  const path = (rawUrl ?? '').split('?')[0] || '/';
  log(`[slow-request] ${method ?? '?'} ${path} ${Math.round(duration)}ms`);
}
