import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// A value that absorbs any property read, call or construction, so the page script runs without a real DOM.
function absorb(): unknown {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'then') return undefined;
      return absorb();
    },
    set: () => true,
    apply: () => absorb(),
    construct: () => absorb() as object,
  });
}

function pageScript(): string {
  const html = readFileSync(join(import.meta.dirname, '..', '..', 'dashboard', 'index.html'), 'utf-8');
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html has an inline module script');
  return match[1]!
    .replace(/^import\s*\{([^}]*)\}\s*from\s*'[^']*';$/gm, (_m, names: string) =>
      `const {${names.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')}} = __stub;`)
    .replace(/^import\s*'[^']*';$/gm, '');
}

describe('dashboard index.html script', () => {
  it('should run to the end without a ReferenceError', () => {
    const done = { ran: false };
    const context = vm.createContext(new Proxy({ __stub: absorb(), __done: done } as Record<string | symbol, unknown>, {
      get: (target, prop) => (prop in target ? target[prop] : absorb()),
      has: () => true,
    }));
    vm.runInContext(`${pageScript()}\n__done.ran = true;`, context);
    assert.equal(done.ran, true);
  });
});
