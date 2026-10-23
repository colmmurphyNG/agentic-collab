/**
 * Persistent index behind the `/scratch` page: file metadata for listing and
 * paging, plus a contentless FTS5 table (trigram tokenizer, so identifiers and
 * partial words match) for searching inside files.
 *
 * The indexer is incremental and async: it re-reads only files whose size or
 * mtime changed, in small batches that yield to the event loop, so a first run
 * over thousands of files never stalls other requests.
 */

import { rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { listMarkdownRecursiveAsync } from './scratch-index.ts';

// Metadata for listing/paging, plus a contentless FTS5 table keyed by
// scratch_docs.id so file bodies are not stored twice. id is AUTOINCREMENT so a
// rowid is never reused for a different file.
const SCRATCH_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS scratch_docs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    path     TEXT NOT NULL UNIQUE,
    project  TEXT NOT NULL,
    persona  TEXT NOT NULL,
    abs_path TEXT NOT NULL,
    size     INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_scratch_docs_mtime ON scratch_docs(mtime_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_scratch_docs_persona ON scratch_docs(persona, mtime_ms DESC);
`;

/** The index sits next to the main database, never inside it. */
export function scratchIndexPathFor(dbPath: string): string {
  return dbPath === ':memory:' ? ':memory:' : `${dbPath.replace(/\.db$/, '')}.scratch-index.db`;
}

function openWithSchema(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec(SCRATCH_SCHEMA);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Everything in the index can be rebuilt from the files on disk, so a file that
 * will not open is deleted and recreated rather than repaired. Without FTS5 the
 * page and filename search keep working; only content search is switched off.
 */
export function openScratchIndexDb(path: string): { db: DatabaseSync; fts: boolean } {
  let db: DatabaseSync;
  try {
    db = openWithSchema(path);
  } catch (err) {
    console.warn(`[scratch-index] recreating ${path}: ${(err as Error).message}`);
    for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
    db = openWithSchema(path);
  }
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS scratch_fts USING fts5(body, content='', contentless_delete=1, tokenize='trigram')`);
    db.prepare(`SELECT rowid FROM scratch_fts WHERE scratch_fts MATCH 'abc' LIMIT 1`).all();
    return { db, fts: true };
  } catch {
    return { db, fts: false };
  }
}

/** Indexed body per file; the rest of a larger file is not searchable. */
export const SCRATCH_BODY_CAP_BYTES = 512 * 1024;
const BATCH_MAX_FILES = 25;
const BATCH_MAX_BYTES = 1024 * 1024;
const MAX_QUERY_CHARS = 200;
/** Trigram tokenizer: shorter phrases cannot match anything. */
export const MIN_CONTENT_QUERY_CHARS = 3;

export type ScratchRootSpec = { project: string; absRoot: string; urlPrefix: string };
export type ScratchRunSummary = { seen: number; changed: number; removed: number; ms: number };

export type ScratchIndexerOptions = {
  db: DatabaseSync;
  /** Whether the FTS table is usable; false keeps metadata only. */
  fts: boolean;
  roots: () => ScratchRootSpec[];
  attribute: (project: string, relPath: string) => string;
  intervalMs?: number;
  log?: (line: string) => void;
  /** Test seam: read at most `cap` bytes of a file as text. */
  readBody?: (absPath: string, cap: number) => Promise<string>;
};

export type ScratchDocRow = { path: string; project: string; persona: string; size: number; mtimeMs: number };

export const scratchIndexStatus: { running: boolean; lastFinishedAt: number | null; lastSummary: ScratchRunSummary | null } =
  { running: false, lastFinishedAt: null, lastSummary: null };

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export async function readCapped(absPath: string, cap: number): Promise<string> {
  const fh = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

type Pending = { path: string; project: string; persona: string; abs: string; size: number; mtimeMs: number; oldId: number | null };
type ExistingRow = { id: number; size: number; mtime_ms: number; persona: string; indexed: number };

export function createScratchIndexer(opts: ScratchIndexerOptions) {
  const { db, fts } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const readBody = opts.readBody ?? readCapped;
  let inflight: Promise<ScratchRunSummary> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function run(): Promise<ScratchRunSummary> {
    const started = Date.now();
    const existing = new Map<string, ExistingRow>();
    for (const r of db.prepare('SELECT id, path, size, mtime_ms, persona, indexed FROM scratch_docs').all() as Array<ExistingRow & { path: string }>) {
      existing.set(r.path, r);
    }

    const seen = new Set<string>();
    const todo: Pending[] = [];
    const personaUpdates: Array<{ id: number; persona: string }> = [];
    for (const root of opts.roots()) {
      for (const f of await listMarkdownRecursiveAsync(root.absRoot)) {
        const relPath = `${root.urlPrefix}${f.relPath}`;
        const path = `${root.project}/${relPath}`;
        if (seen.has(path)) continue; // overlapping roots: first one wins
        seen.add(path);
        const persona = opts.attribute(root.project, relPath);
        const old = existing.get(path);
        const mtimeMs = Math.floor(f.mtimeMs);
        const abs = `${root.absRoot}/${f.relPath}`;
        const unchanged = old && old.size === f.size && old.mtime_ms === mtimeMs && (old.indexed === 1 || !fts);
        if (unchanged) {
          if (old.persona !== persona) personaUpdates.push({ id: old.id, persona });
        } else {
          todo.push({ path, project: root.project, persona, abs, size: f.size, mtimeMs, oldId: old?.id ?? null });
        }
      }
    }

    if (personaUpdates.length > 0) {
      const upd = db.prepare('UPDATE scratch_docs SET persona = ? WHERE id = ?');
      db.exec('BEGIN');
      try { for (const u of personaUpdates) upd.run(u.persona, u.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    }

    // An empty walk with a populated index means the roots were unreadable, not
    // that every file was deleted: keep the rows rather than re-reading them all.
    let removed = 0;
    if (seen.size > 0) {
      const gone = [...existing].filter(([p]) => !seen.has(p)).map(([, r]) => r.id);
      if (gone.length > 0) {
        db.exec('BEGIN');
        try { for (const id of gone) deleteDoc(id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
        removed = gone.length;
      }
    }

    const insertDoc = db.prepare('INSERT INTO scratch_docs (path, project, persona, abs_path, size, mtime_ms, indexed) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertFts = fts ? db.prepare('INSERT INTO scratch_fts (rowid, body) VALUES (?, ?)') : null;
    let changed = 0;
    for (let i = 0; i < todo.length;) {
      const batch: Pending[] = [];
      let bytes = 0;
      while (i < todo.length && batch.length < BATCH_MAX_FILES && (batch.length === 0 || bytes < BATCH_MAX_BYTES)) {
        const p = todo[i++]!;
        batch.push(p);
        bytes += Math.min(p.size, SCRATCH_BODY_CAP_BYTES);
      }
      const bodies = await Promise.all(batch.map(async (p) => {
        if (!fts) return '';
        try { return await readBody(p.abs, SCRATCH_BODY_CAP_BYTES); } catch { return null; } // vanished mid-run
      }));
      db.exec('BEGIN');
      try {
        batch.forEach((p, k) => {
          const body = bodies[k]!;
          if (body === null) return; // next run removes the row if the file is really gone
          if (p.oldId !== null) deleteDoc(p.oldId);
          // A fresh id per change keeps id order close to modification order.
          const id = Number(insertDoc.run(p.path, p.project, p.persona, p.abs, p.size, p.mtimeMs, fts ? 1 : 0).lastInsertRowid);
          insertFts?.run(id, body);
          changed++;
        });
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      await yieldToLoop();
    }

    return { seen: seen.size, changed, removed, ms: Date.now() - started };
  }

  function deleteDoc(id: number): void {
    if (fts) db.prepare('DELETE FROM scratch_fts WHERE rowid = ?').run(id);
    db.prepare('DELETE FROM scratch_docs WHERE id = ?').run(id);
  }

  /** One run at a time: a call during a run joins it. */
  function runOnce(): Promise<ScratchRunSummary> {
    if (inflight) return inflight;
    scratchIndexStatus.running = true;
    const p = run().then((s) => {
      scratchIndexStatus.lastSummary = s;
      scratchIndexStatus.lastFinishedAt = Date.now();
      log(`[scratch-index] seen=${s.seen} changed=${s.changed} removed=${s.removed} ms=${s.ms}`);
      return s;
    }).finally(() => { inflight = null; scratchIndexStatus.running = false; });
    inflight = p;
    return p;
  }

  function start(): void {
    if (timer) return;
    const tick = () => { runOnce().catch((err) => log(`[scratch-index] run failed: ${err instanceof Error ? err.message : String(err)}`)); };
    setImmediate(tick);
    timer = setInterval(tick, opts.intervalMs ?? 3 * 60_000);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}

// ── Queries ──

type DocSqlRow = { path: string; project: string; persona: string; size: number; mtime_ms: number };
const toDoc = (r: DocSqlRow): ScratchDocRow => ({ path: r.path, project: r.project, persona: r.persona, size: r.size, mtimeMs: r.mtime_ms });

export function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function scratchTotals(db: DatabaseSync): { files: number; projects: number; newestMs: number | null } {
  const r = db.prepare('SELECT COUNT(*) AS files, COUNT(DISTINCT project) AS projects, MAX(mtime_ms) AS newest FROM scratch_docs').get() as { files: number; projects: number; newest: number | null };
  return { files: r.files, projects: r.projects, newestMs: r.newest };
}

export function scratchPersonaCounts(db: DatabaseSync): Array<{ persona: string; count: number }> {
  return db.prepare('SELECT persona, COUNT(*) AS count FROM scratch_docs GROUP BY persona').all() as Array<{ persona: string; count: number }>;
}

export function listScratchDocs(db: DatabaseSync, o: { persona?: string; offset: number; limit: number }): { total: number; items: ScratchDocRow[] } {
  const where = o.persona ? 'WHERE persona = ?' : '';
  const args = o.persona ? [o.persona] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM scratch_docs ${where}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT path, project, persona, size, mtime_ms FROM scratch_docs ${where} ORDER BY mtime_ms DESC, id DESC LIMIT ? OFFSET ?`).all(...args, o.limit, o.offset) as DocSqlRow[];
  return { total, items: rows.map(toDoc) };
}

/** Every whitespace-separated term must appear in the path (case-insensitive,
 *  literal, no LIKE wildcards). */
export function searchScratchNames(db: DatabaseSync, q: string, limit: number): ScratchDocRow[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (terms.length === 0) return [];
  const cond = terms.map(() => 'instr(lower(path), ?) > 0').join(' AND ');
  const rows = db.prepare(`SELECT path, project, persona, size, mtime_ms FROM scratch_docs WHERE ${cond} ORDER BY mtime_ms DESC LIMIT ?`).all(...terms, limit) as DocSqlRow[];
  return rows.map(toDoc);
}

/** The whole input as one FTS5 phrase; embedded quotes are doubled so no input
 *  can reach FTS5 query syntax (AND, NEAR, *, column filters, parentheses). */
export function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

export type ContentSearch =
  | { status: 'ok'; items: Array<ScratchDocRow & { absPath: string }> }
  | { status: 'unavailable' | 'too_short' | 'error' };

/** Newest-indexed first: ordering by rowid lets FTS5 stop after `limit` hits
 *  instead of scoring every match, which bounds the time spent on the loop. */
export function searchScratchContent(db: DatabaseSync, fts: boolean, q: string, limit: number): ContentSearch {
  q = normalizeQuery(q);
  if (!fts) return { status: 'unavailable' };
  if ([...q].length < MIN_CONTENT_QUERY_CHARS) return { status: 'too_short' };
  try {
    const rows = db.prepare(
      `SELECT d.path, d.project, d.persona, d.size, d.mtime_ms, d.abs_path
         FROM (SELECT rowid AS id FROM scratch_fts WHERE scratch_fts MATCH ? ORDER BY rowid DESC LIMIT ?) m
         JOIN scratch_docs d ON d.id = m.id`,
    ).all(ftsPhrase(q), limit) as Array<DocSqlRow & { abs_path: string }>;
    return { status: 'ok', items: rows.map((r) => ({ ...toDoc(r), absPath: r.abs_path })) };
  } catch {
    return { status: 'error' };
  }
}

export function normalizeQuery(raw: string | null): string {
  return (raw ?? '').replace(/\0/g, '').trim().slice(0, MAX_QUERY_CHARS);
}

/** ~160 characters around the first case-insensitive occurrence of `q`, with
 *  whitespace collapsed. Plain text: the caller must not insert it as HTML. */
export async function scratchSnippet(absPath: string, q: string, readBody: typeof readCapped = readCapped): Promise<string> {
  let text: string;
  try { text = await readBody(absPath, SCRATCH_BODY_CAP_BYTES); } catch { return ''; }
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  const from = Math.max(0, (at < 0 ? 0 : at) - 60);
  const slice = text.slice(from, from + 160).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${slice}`;
}
