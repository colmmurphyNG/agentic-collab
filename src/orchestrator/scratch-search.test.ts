import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import {
  createScratchIndexer, readCapped, searchScratchContent, searchScratchNames, listScratchDocs, ftsPhrase, scratchSnippet,
  SCRATCH_BODY_CAP_BYTES,
} from './scratch-search.ts';
import { Database } from './database.ts';
import { createRouter, scratchIndexerState, type RouteContext } from './routes.ts';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'scratch-search-test-')));
}

function touch(path: string, body: string, mtimeSec: number): void {
  writeFileSync(path, body);
  utimesSync(path, mtimeSec, mtimeSec);
}

describe('scratch indexer', () => {
  let root: string; let db: Database;
  let reads: string[];
  let persona = 'alpha';
  function indexer(fts = db.scratchFts) {
    return createScratchIndexer({
      db: db.rawDb, fts, log: () => {},
      roots: () => [{ project: 'proj', absRoot: join(root, 'scratch'), urlPrefix: '' }],
      attribute: () => persona,
      readBody: async (p, cap) => { reads.push(p); return readCapped(p, cap); },
    });
  }

  before(() => {
    root = tmp();
    mkdirSync(join(root, 'scratch', 'sub'), { recursive: true });
    db = new Database(join(root, 'idx.db'));
  });
  after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it('has FTS5 on the Node used to run the suite', () => {
    assert.equal(db.scratchFts, true, 'run the suite with Node 24 (host node 23 has no FTS5)');
  });

  it('indexes new files, then re-reads only the one that changed', async () => {
    touch(join(root, 'scratch', 'one.md'), 'the quick brown fox', 1_700_000_000);
    touch(join(root, 'scratch', 'sub', 'two.md'), 'stripeEnabled is fail-open', 1_700_000_000);
    reads = [];
    let s = await indexer().runOnce();
    assert.deepEqual({ seen: s.seen, changed: s.changed, removed: s.removed }, { seen: 2, changed: 2, removed: 0 });
    assert.equal(reads.length, 2);

    reads = [];
    s = await indexer().runOnce();
    assert.deepEqual({ changed: s.changed, removed: s.removed }, { changed: 0, removed: 0 });
    assert.equal(reads.length, 0, 'unchanged files must not be re-read');

    touch(join(root, 'scratch', 'one.md'), 'a slow purple otter', 1_700_000_100);
    reads = [];
    s = await indexer().runOnce();
    assert.equal(s.changed, 1);
    assert.deepEqual(reads, [join(root, 'scratch', 'one.md')]);
    assert.equal((searchScratchContent(db.rawDb, true, 'brown fox', 10) as any).items.length, 0, 'old body is gone');
    assert.equal((searchScratchContent(db.rawDb, true, 'purple otter', 10) as any).items.length, 1);
    assert.equal(listScratchDocs(db.rawDb, { offset: 0, limit: 10 }).total, 2, 'update replaces the row, no duplicate');
  });

  it('finds content by substring and file names by terms', () => {
    const c = searchScratchContent(db.rawDb, true, 'ripeEnab', 10);
    assert.equal(c.status, 'ok');
    assert.deepEqual((c as any).items.map((i: any) => i.path), ['proj/sub/two.md']);
    assert.deepEqual(searchScratchNames(db.rawDb, 'SUB two', 10).map((d) => d.path), ['proj/sub/two.md']);
    assert.deepEqual(searchScratchNames(db.rawDb, '%', 10), [], 'LIKE wildcards are literal');
  });

  it('re-attributes personas for unchanged files without re-reading them', async () => {
    persona = 'beta'; reads = [];
    const s = await indexer().runOnce();
    assert.equal(s.changed, 0);
    assert.equal(reads.length, 0);
    assert.equal(listScratchDocs(db.rawDb, { persona: 'beta', offset: 0, limit: 10 }).total, 2);
  });

  it('removes rows and index entries for vanished files', async () => {
    unlinkSync(join(root, 'scratch', 'sub', 'two.md'));
    const s = await indexer().runOnce();
    assert.equal(s.removed, 1);
    assert.equal(listScratchDocs(db.rawDb, { offset: 0, limit: 10 }).total, 1);
    assert.equal((searchScratchContent(db.rawDb, true, 'fail-open', 10) as any).items.length, 0);
  });

  it('keeps the index when every root walks empty (unreadable mount)', async () => {
    const empty = createScratchIndexer({ db: db.rawDb, fts: true, log: () => {}, roots: () => [], attribute: () => 'x' });
    const s = await empty.runOnce();
    assert.equal(s.removed, 0);
    assert.equal(listScratchDocs(db.rawDb, { offset: 0, limit: 10 }).total, 1);
  });

  it('never overlaps runs: a call during a run joins it', async () => {
    const ix = indexer();
    const a = ix.runOnce(); const b = ix.runOnce();
    assert.equal(a, b);
    await a;
  });

  it('caps the indexed body per file', async () => {
    touch(join(root, 'scratch', 'big.md'), `${'x'.repeat(SCRATCH_BODY_CAP_BYTES)}\nTAILMARKER`, 1_700_000_200);
    await indexer().runOnce();
    assert.equal((searchScratchContent(db.rawDb, true, 'TAILMARKER', 10) as any).items.length, 0);
  });

  it('survives hostile query text without throwing', () => {
    for (const q of ['"', '""', 'a" OR "b', 'foo*', 'x AND y', '(abc)', 'NEAR(a b)', 'body:abc', "'; DROP TABLE scratch_docs; --", '\u0000abc']) {
      const r = searchScratchContent(db.rawDb, true, q, 10);
      assert.notEqual(r.status, 'error', `query ${JSON.stringify(q)} errored`);
      searchScratchNames(db.rawDb, q, 10);
    }
    assert.equal(searchScratchContent(db.rawDb, true, '', 10).status, 'too_short');
    assert.equal(searchScratchContent(db.rawDb, true, 'ab', 10).status, 'too_short');
    assert.equal(ftsPhrase('a"b'), '"a""b"');
  });

  it('builds a snippet around the match', async () => {
    touch(join(root, 'scratch', 'snip.md'), `${'filler '.repeat(40)}NEEDLE here\nnext line`, 1_700_000_300);
    const sn = await scratchSnippet(join(root, 'scratch', 'snip.md'), 'needle');
    assert.match(sn, /^….*NEEDLE here next line$/);
  });

  it('without FTS keeps the metadata and reports content search as unavailable', async () => {
    const plain = new Database(join(root, 'nofts.db'));
    const ix = createScratchIndexer({
      db: plain.rawDb, fts: false, log: () => {},
      roots: () => [{ project: 'proj', absRoot: join(root, 'scratch'), urlPrefix: '' }],
      attribute: () => 'alpha',
      readBody: async () => { throw new Error('bodies must not be read without FTS'); },
    });
    const s = await ix.runOnce();
    assert.ok(s.changed >= 1);
    assert.equal(searchScratchContent(plain.rawDb, false, 'quick', 10).status, 'unavailable');
    assert.ok(searchScratchNames(plain.rawDb, 'one', 10).length >= 1);
    plain.close();
  });
});

describe('scratch HTTP endpoints', () => {
  let root: string; let server: Server; let port: number; let db: Database;
  let prevRoots: string | undefined; let secret: string | null = null;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;

  before(async () => {
    root = tmp();
    prevRoots = process.env['PROJECT_RENDER_ROOTS'];
    const proj = join(root, 'proj');
    mkdirSync(join(proj, 'scratch', 'many'), { recursive: true });
    for (let i = 0; i < 30; i++) touch(join(proj, 'scratch', 'many', `f${String(i).padStart(2, '0')}.md`), `note ${i} common-phrase`, 1_700_000_000 + i);
    touch(join(proj, 'scratch', '<script>alert(1)<b>.md'), 'body with <img src=x onerror=alert(1)> inside', 1_800_000_000);
    process.env['PROJECT_RENDER_ROOTS'] = proj;
    db = new Database(join(root, 'http.db'));
    const router = createRouter({ db, get orchestratorSecret() { return secret; } } as RouteContext);
    await scratchIndexerState.create!(db, { log: () => {} }).runOnce();
    server = createServer((req, res) => { void router(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  after(() => {
    server.close(); db.close();
    if (prevRoots === undefined) delete process.env['PROJECT_RENDER_ROOTS']; else process.env['PROJECT_RENDER_ROOTS'] = prevRoots;
    rmSync(root, { recursive: true, force: true });
  });

  it('serves a light shell: totals, latest 10, collapsed persona section, no full list', async () => {
    const html = await (await fetch(url('/scratch'))).text();
    assert.match(html, /Total: 31 files across 1 projects/);
    assert.match(html, /<details data-persona="unattributed">/);
    assert.ok(!html.includes('many/f00.md'), 'the full list must not be inlined');
    assert.ok(html.length < 20_000);
  });

  it('escapes a path containing <script> in the shell and links it percent-encoded', async () => {
    const html = await (await fetch(url('/scratch'))).text();
    assert.ok(!html.includes('<script>alert(1)'), 'raw path must not reach the HTML');
    assert.match(html, /proj\/&lt;script&gt;alert\(1\)&lt;b&gt;\.md/);
    assert.match(html, /href="\/scratch\/proj\/%3Cscript%3Ealert\(1\)%3Cb%3E\.md"/);
  });

  it('pages the list and clamps limit and offset', async () => {
    const get = async (q: string) => (await (await fetch(url(`/api/scratch/list${q}`))).json()) as any;
    const p1 = await get('?limit=10&offset=0');
    assert.equal(p1.total, 31); assert.equal(p1.items.length, 10);
    const p4 = await get('?limit=10&offset=30');
    assert.equal(p4.items.length, 1);
    assert.equal((await get('?limit=100000')).limit, 200);
    assert.equal((await get('?limit=0')).limit, 1);
    const bad = await get('?limit=abc&offset=-5');
    assert.equal(bad.limit, 50); assert.equal(bad.offset, 0);
    assert.equal((await get('?persona=nobody')).total, 0);
  });

  it('search returns file-name and content hits with snippets, and tolerates odd input', async () => {
    const r = await (await fetch(url('/api/scratch/search?q=f07'))).json() as any;
    assert.deepEqual(r.files.map((f: any) => f.path), ['proj/many/f07.md']);
    const c = await (await fetch(url('/api/scratch/search?q=common-phrase&limit=5'))).json() as any;
    assert.equal(c.content.status, 'ok');
    assert.equal(c.content.items.length, 5);
    assert.match(c.content.items[0].snippet, /common-phrase/);
    for (const q of ['"', 'a OR b', 'x*', '(', '']) {
      const res = await fetch(url(`/api/scratch/search?q=${encodeURIComponent(q)}`));
      assert.equal(res.status, 200, `q=${q}`);
    }
    const short = await (await fetch(url('/api/scratch/search?q=ab'))).json() as any;
    assert.equal(short.content.status, 'too_short');
  });

  it('reports content search unavailable when FTS5 is missing, filename search still works', async () => {
    db.scratchFts = false;
    try {
      const r = await (await fetch(url('/api/scratch/search?q=f07'))).json() as any;
      assert.equal(r.content.status, 'unavailable');
      assert.equal(r.files.length, 1);
      assert.equal((await fetch(url('/scratch'))).status, 200);
    } finally { db.scratchFts = true; }
  });

  it('applies the same auth as /scratch', async () => {
    secret = 's3cret';
    try {
      for (const p of ['/scratch', '/api/scratch/list', '/api/scratch/search?q=abc']) {
        assert.equal((await fetch(url(p))).status, 401, p);
        assert.equal((await fetch(url(p), { headers: { authorization: 'Bearer s3cret' } })).status, 200, p);
      }
    } finally { secret = null; }
  });
});
