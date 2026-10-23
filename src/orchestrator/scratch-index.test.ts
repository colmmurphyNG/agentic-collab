import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { listMarkdownRecursiveAsync, createSwrCache, logIfSlow, SCRATCH_SKIP_MARKER } from './scratch-index.ts';
import { scratchIndexerState, createRouter, type RouteContext } from './routes.ts';
import { Database } from './database.ts';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'scratch-index-test-')));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('listMarkdownRecursiveAsync', () => {
  let root: string;
  before(() => {
    root = tmp();
    mkdirSync(join(root, 'keep', 'deep'), { recursive: true });
    mkdirSync(join(root, 'index', 'nested', 'more'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'a.md'), '# a');
    writeFileSync(join(root, 'keep', 'b.md'), '# b');
    writeFileSync(join(root, 'keep', 'deep', 'c.MD'), '# c');
    writeFileSync(join(root, 'keep', 'ignore.txt'), 'x');
    writeFileSync(join(root, 'index', SCRATCH_SKIP_MARKER), '');
    writeFileSync(join(root, 'index', 'skipped.md'), '# s');
    writeFileSync(join(root, 'index', 'nested', 'more', 'skipped-too.md'), '# s');
    writeFileSync(join(root, 'node_modules', 'pkg', 'n.md'), '# n');
    writeFileSync(join(root, '.git', 'g.md'), '# g');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('keeps normal markdown and skips marker folders, node_modules and .git', async () => {
    const files = (await listMarkdownRecursiveAsync(root)).map((f) => f.relPath).sort();
    assert.deepEqual(files, ['a.md', 'keep/b.md', 'keep/deep/c.MD']);
  });

  it('skips the root itself when it holds the marker', async () => {
    const r = tmp();
    writeFileSync(join(r, SCRATCH_SKIP_MARKER), '');
    writeFileSync(join(r, 'x.md'), '# x');
    assert.deepEqual(await listMarkdownRecursiveAsync(r), []);
    rmSync(r, { recursive: true, force: true });
  });
});

describe('createSwrCache', () => {
  it('builds once for two requests within the TTL', async () => {
    let builds = 0; let t = 0;
    const cache = createSwrCache(async () => ++builds, 60_000, () => t);
    assert.equal(await cache.get(), 1);
    t = 59_000;
    assert.equal(await cache.get(), 1);
    assert.equal(builds, 1);
  });

  it('shares one build between concurrent first requests', async () => {
    let builds = 0;
    const d = deferred<string>();
    const cache = createSwrCache(() => { builds++; return d.promise; }, 60_000);
    const a = cache.get(); const b = cache.get();
    d.resolve('html');
    assert.deepEqual(await Promise.all([a, b]), ['html', 'html']);
    assert.equal(builds, 1);
  });

  it('serves the stale copy while one background rebuild runs', async () => {
    let builds = 0; let t = 0;
    const gates = [deferred<string>(), deferred<string>()];
    const cache = createSwrCache(() => gates[builds++]!.promise, 1000, () => t);
    gates[0]!.resolve('old');
    assert.equal(await cache.get(), 'old');
    t = 5000;
    assert.equal(await cache.get(), 'old'); // starts rebuild, returns stale
    assert.equal(await cache.get(), 'old'); // rebuild still running: no second build
    assert.equal(builds, 2);
    gates[1]!.resolve('new');
    await new Promise((r) => setImmediate(r));
    assert.equal(await cache.get(), 'new');
    assert.equal(builds, 2);
  });

  it('keeps the stale copy when a refresh fails and retries after a failed first build', async () => {
    let calls = 0; let t = 0;
    const cache = createSwrCache(async () => {
      calls++;
      if (calls === 1) throw new Error('first');
      if (calls === 3) throw new Error('refresh');
      return `v${calls}`;
    }, 1000, () => t);
    await assert.rejects(cache.get(), /first/);
    assert.equal(await cache.get(), 'v2');
    t = 5000;
    assert.equal(await cache.get(), 'v2');
    await new Promise((r) => setImmediate(r));
    assert.equal(await cache.get(), 'v2');
  });
});

async function indexOnce(db: Database, personas: () => Set<string>) {
  createRouter({ orchestratorSecret: null } as RouteContext); // registers the factory
  return scratchIndexerState.create!(db, { personas, log: () => {} }).runOnce();
}

describe('scratch index build', () => {
  let db: Database;
  let root: string;
  let personas: string;
  let prevRoots: string | undefined;
  let prevPersonasDir: string | undefined;
  before(() => {
    root = tmp(); personas = tmp();
    prevRoots = process.env['PROJECT_RENDER_ROOTS'];
    prevPersonasDir = process.env['PERSONAS_DIR'];
    const proj = join(root, 'proj');
    mkdirSync(join(proj, 'scratch', 'alpha'), { recursive: true });
    mkdirSync(join(proj, 'scratch', 'bulk'), { recursive: true });
    // A few thousand files, so the walk takes real async time.
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(proj, 'scratch', 'bulk', `d${d}`), { recursive: true });
      for (let i = 0; i < 150; i++) writeFileSync(join(proj, 'scratch', 'bulk', `d${d}`, `f${i}.md`), `# ${d}-${i}`);
    }
    for (let i = 0; i < 5; i++) writeFileSync(join(proj, 'scratch', 'alpha', `n${i}.md`), '# n');
    writeFileSync(join(personas, 'alpha.md'), '---\nengine: claude\n---\n');
    process.env['PROJECT_RENDER_ROOTS'] = proj;
    process.env['PERSONAS_DIR'] = personas;
    db = new Database(join(root, 'idx.db'));
  });
  after(() => {
    db.close();
    if (prevRoots === undefined) delete process.env['PROJECT_RENDER_ROOTS']; else process.env['PROJECT_RENDER_ROOTS'] = prevRoots;
    if (prevPersonasDir === undefined) delete process.env['PERSONAS_DIR']; else process.env['PERSONAS_DIR'] = prevPersonasDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(personas, { recursive: true, force: true });
  });

  it('reads the known persona set once per run, not once per file', async () => {
    let reads = 0;
    const summary = await indexOnce(db, () => { reads++; return new Set(['alpha']); });
    assert.equal(reads, 1);
    assert.equal(summary.seen, 3005);
    const alpha = db.rawDb.prepare("SELECT COUNT(*) AS n FROM scratch_docs WHERE persona = 'alpha'").get() as { n: number };
    assert.equal(alpha.n, 5); // attribution still uses the set
  });

  it('lets other work run while an index run over thousands of files is in progress', async () => {
    const fresh = new Database(join(root, 'idx2.db'));
    let ticks = 0;
    let maxGap = 0;
    let last = Date.now();
    const timer = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 5);
    const summary = await indexOnce(fresh, () => new Set());
    clearInterval(timer);
    fresh.close();
    assert.equal(summary.changed, 3005);
    assert.ok(ticks > 0, 'timer must fire during the run');
    assert.ok(maxGap < 1000, `event loop stalled for ${maxGap}ms`);
  });
});

describe('skipped folders over HTTP', () => {
  let root: string; let server: Server; let port: number; let prev: string | undefined; let db: Database;
  before(async () => {
    root = tmp();
    prev = process.env['PROJECT_RENDER_ROOTS'];
    const proj = join(root, 'skipproj');
    mkdirSync(join(proj, 'scratch', 'idx'), { recursive: true });
    writeFileSync(join(proj, 'scratch', 'listed.md'), '# listed');
    writeFileSync(join(proj, 'scratch', 'idx', SCRATCH_SKIP_MARKER), '');
    writeFileSync(join(proj, 'scratch', 'idx', 'hidden.md'), '# hidden but servable');
    process.env['PROJECT_RENDER_ROOTS'] = proj;
    db = new Database(join(root, 'skip.db'));
    const router = createRouter({ orchestratorSecret: null, db } as RouteContext);
    await scratchIndexerState.create!(db, { log: () => {} }).runOnce();
    server = createServer((req, res) => { void router(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  after(() => {
    server.close();
    db.close();
    if (prev === undefined) delete process.env['PROJECT_RENDER_ROOTS']; else process.env['PROJECT_RENDER_ROOTS'] = prev;
    rmSync(root, { recursive: true, force: true });
  });

  it('omits the folder from the index but still serves its files', async () => {
    const index = await (await fetch(`http://127.0.0.1:${port}/api/scratch/list`)).text();
    assert.match(index, /skipproj\/listed\.md/);
    assert.ok(!index.includes('hidden.md'));
    const direct = await fetch(`http://127.0.0.1:${port}/scratch/skipproj/idx/hidden.md`);
    assert.equal(direct.status, 200);
    assert.match(await direct.text(), /hidden but servable/);
  });
});

describe('slow-request log', () => {
  it('logs exactly one line, without the query string, for a slow request', () => {
    const lines: string[] = [];
    logIfSlow('GET', '/scratch?token=secret', 0, 1500, 1000, (l) => lines.push(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /GET \/scratch 1500ms/);
    assert.ok(!lines[0]!.includes('secret'));
  });

  it('logs nothing for a fast request, or one exactly at the threshold', () => {
    const lines: string[] = [];
    logIfSlow('GET', '/x', 0, 999, 1000, (l) => lines.push(l));
    logIfSlow('GET', '/x', 0, 1000, 1000, (l) => lines.push(l));
    assert.deepEqual(lines, []);
  });

  describe('through the router', () => {
    let server: Server; let port: number;
    let clock = 0;
    const lines: string[] = [];
    before(async () => {
      const router = createRouter({ orchestratorSecret: null } as RouteContext, {
        slowRequestMs: 1000,
        now: () => clock,
        log: (l) => lines.push(l),
      });
      server = createServer((req, res) => {
        // Each request advances the fake clock between start and close.
        const bump = req.url?.includes('slow') ? 2500 : 5;
        void router(req, res);
        clock += bump;
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      port = (server.address() as { port: number }).port;
    });
    after(() => server.close());

    it('logs a slow request once and stays silent for a fast one', async () => {
      await (await fetch(`http://127.0.0.1:${port}/nope-fast`)).text();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(lines.length, 0);
      await (await fetch(`http://127.0.0.1:${port}/nope-slow?x=1`)).text();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /GET \/nope-slow 2500ms/);
    });
  });
});
