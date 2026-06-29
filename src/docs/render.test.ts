import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renderMarkdown } from './render.ts';

// renderMarkdown is synchronous, so an infinite-loop regression would hang the
// whole test suite rather than fail one test. Run the render in a short-lived
// subprocess with a hard timeout: a hang surfaces as a thrown ETIMEDOUT (test
// failure), keeping the suite responsive.
function renderInSubprocess(input: string, ms = 4000): string {
  const url = new URL('./render.ts', import.meta.url).href;
  const script = `import(${JSON.stringify(url)}).then(m=>{process.stdout.write(m.renderMarkdown(${JSON.stringify(input)}))})`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: ms, encoding: 'utf-8' });
}

describe('renderMarkdown', () => {
  // ── Inline formatting ──

  describe('links', () => {
    it('renders markdown links', () => {
      const html = renderMarkdown('Check the [Persona Reference](persona-reference) for details.');
      assert.ok(html.includes('<a href="persona-reference">Persona Reference</a>'), `Got: ${html}`);
    });

    it('renders links with full URLs', () => {
      const html = renderMarkdown('Visit [our docs](https://example.com/docs) today.');
      assert.ok(html.includes('<a href="https://example.com/docs">our docs</a>'), `Got: ${html}`);
    });

    it('renders multiple links in one line', () => {
      const html = renderMarkdown('See [A](a) and [B](b) for more.');
      assert.ok(html.includes('<a href="a">A</a>'), `Got: ${html}`);
      assert.ok(html.includes('<a href="b">B</a>'), `Got: ${html}`);
    });

    it('renders links inside list items', () => {
      const html = renderMarkdown('- [CLI Reference](cli-reference) -- all commands');
      assert.ok(html.includes('<a href="cli-reference">CLI Reference</a>'), `Got: ${html}`);
    });

    it('renders links inside table cells', () => {
      const html = renderMarkdown('| Name | Link |\n|------|------|\n| Docs | [here](docs) |');
      assert.ok(html.includes('<a href="docs">here</a>'), `Got: ${html}`);
    });
  });

  describe('images', () => {
    it('renders images', () => {
      const html = renderMarkdown('![screenshot](https://example.com/img.png)');
      assert.ok(html.includes('<img src="https://example.com/img.png" alt="screenshot"'), `Got: ${html}`);
    });

    it('renders images with relative paths', () => {
      const html = renderMarkdown('![diagram](/assets/arch.svg)');
      assert.ok(html.includes('<img src="/assets/arch.svg" alt="diagram"'), `Got: ${html}`);
    });
  });

  describe('bold and italic', () => {
    it('renders bold text', () => {
      const html = renderMarkdown('This is **bold** text.');
      assert.ok(html.includes('<strong>bold</strong>'), `Got: ${html}`);
    });

    it('renders italic text', () => {
      const html = renderMarkdown('This is *italic* text.');
      assert.ok(html.includes('<em>italic</em>'), `Got: ${html}`);
    });

    it('renders bold inside a paragraph with links', () => {
      const html = renderMarkdown('Click **Create & Spawn** then see [docs](ref).');
      assert.ok(html.includes('<strong>Create &amp; Spawn</strong>'), `Got: ${html}`);
      assert.ok(html.includes('<a href="ref">docs</a>'), `Got: ${html}`);
    });
  });

  describe('inline code', () => {
    it('renders inline code', () => {
      const html = renderMarkdown('Use `collab send` to message.');
      assert.ok(html.includes('<code>collab send</code>'), `Got: ${html}`);
    });

    it('does not format inside code spans', () => {
      const html = renderMarkdown('Run `**not bold**` literally.');
      assert.ok(html.includes('<code>**not bold**</code>'), `Got: ${html}`);
      assert.ok(!html.includes('<strong>'), `Got: ${html}`);
    });

    it('handles code with special chars', () => {
      const html = renderMarkdown('The `<div>` element.');
      assert.ok(html.includes('<code>&lt;div&gt;</code>'), `Got: ${html}`);
    });
  });

  // ── Block elements ──

  describe('headings', () => {
    it('renders h1 through h3', () => {
      const html = renderMarkdown('# Title\n\n## Section\n\n### Subsection');
      assert.ok(html.includes('<h1'), `Got: ${html}`);
      assert.ok(html.includes('<h2'), `Got: ${html}`);
      assert.ok(html.includes('<h3'), `Got: ${html}`);
    });

    it('generates id attributes for headings', () => {
      const html = renderMarkdown('## Agent States');
      assert.ok(html.includes('id="agent-states"'), `Got: ${html}`);
    });

    it('renders inline formatting in headings', () => {
      const html = renderMarkdown('## Using `collab send`');
      assert.ok(html.includes('<code>collab send</code>'), `Got: ${html}`);
    });
  });

  describe('code blocks', () => {
    it('renders fenced code blocks', () => {
      const html = renderMarkdown('```\ncollab agents\n```');
      assert.ok(html.includes('<pre><code>collab agents</code></pre>'), `Got: ${html}`);
    });

    it('renders code blocks with language', () => {
      const html = renderMarkdown('```yaml\nengine: claude\n```');
      assert.ok(html.includes('class="lang-yaml"'), `Got: ${html}`);
    });

    it('escapes HTML in code blocks', () => {
      const html = renderMarkdown('```\n<div class="test">\n```');
      assert.ok(html.includes('&lt;div class=&quot;test&quot;&gt;'), `Got: ${html}`);
    });

    it('preserves markdown syntax in code blocks', () => {
      const html = renderMarkdown('```\n**not bold** [not a link](url)\n```');
      assert.ok(!html.includes('<strong>'), `Got: ${html}`);
      assert.ok(!html.includes('<a '), `Got: ${html}`);
    });
  });

  describe('lists', () => {
    it('renders unordered lists', () => {
      const html = renderMarkdown('- item one\n- item two');
      assert.ok(html.includes('<ul>'), `Got: ${html}`);
      assert.ok(html.includes('<li>item one</li>'), `Got: ${html}`);
    });

    it('renders ordered lists', () => {
      const html = renderMarkdown('1. first\n2. second');
      assert.ok(html.includes('<ol>'), `Got: ${html}`);
      assert.ok(html.includes('<li>first</li>'), `Got: ${html}`);
    });

    it('renders inline formatting in list items', () => {
      const html = renderMarkdown('- **bold item** with [link](url)');
      assert.ok(html.includes('<strong>bold item</strong>'), `Got: ${html}`);
      assert.ok(html.includes('<a href="url">link</a>'), `Got: ${html}`);
    });
  });

  describe('tables', () => {
    it('renders tables with headers', () => {
      const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
      assert.ok(html.includes('<table>'), `Got: ${html}`);
      assert.ok(html.includes('<th>A</th>'), `Got: ${html}`);
      assert.ok(html.includes('<td>1</td>'), `Got: ${html}`);
    });

    it('renders inline formatting in cells', () => {
      const html = renderMarkdown('| Field | Desc |\n|-------|------|\n| `cwd` | **required** |');
      assert.ok(html.includes('<code>cwd</code>'), `Got: ${html}`);
      assert.ok(html.includes('<strong>required</strong>'), `Got: ${html}`);
    });
  });

  describe('paragraphs', () => {
    it('wraps text in paragraphs', () => {
      const html = renderMarkdown('Hello world.');
      assert.ok(html.includes('<p>Hello world.</p>'), `Got: ${html}`);
    });

    it('joins multi-line paragraphs', () => {
      const html = renderMarkdown('Line one\nline two.');
      assert.ok(html.includes('<p>Line one line two.</p>'), `Got: ${html}`);
    });

    it('separates paragraphs on blank lines', () => {
      const html = renderMarkdown('Para one.\n\nPara two.');
      assert.ok(html.includes('<p>Para one.</p>'), `Got: ${html}`);
      assert.ok(html.includes('<p>Para two.</p>'), `Got: ${html}`);
    });
  });

  describe('horizontal rules', () => {
    it('renders hr from ---', () => {
      const html = renderMarkdown('Above\n\n---\n\nBelow');
      assert.ok(html.includes('<hr>'), `Got: ${html}`);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('handles empty input', () => {
      const html = renderMarkdown('');
      assert.equal(html, '');
    });

    it('handles double dashes in text (not as em-dash)', () => {
      const html = renderMarkdown('Use -- for separator.');
      assert.ok(html.includes('--'), `Got: ${html}`);
    });

    it('escapes HTML in regular text', () => {
      const html = renderMarkdown('Use <script> carefully.');
      assert.ok(html.includes('&lt;script&gt;'), `Got: ${html}`);
      assert.ok(!html.includes('<script>'), `Got: ${html}`);
    });

    it('handles links with special chars in text', () => {
      const html = renderMarkdown('[Hooks & Indicators](hooks-and-indicators)');
      assert.ok(html.includes('<a href="hooks-and-indicators">Hooks &amp; Indicators</a>'), `Got: ${html}`);
    });
  });

  // Regression: a line that reaches the paragraph branch but is rejected by the
  // continuation guard (e.g. starts with '#' yet is not a heading) must still
  // advance the cursor. Before the fix the block loop stalled and spun forever,
  // hanging the renderer and the orchestrator event loop with it (a single
  // published page like /pages/team-pr-sweep-2026-06-29 wedged the whole app).
  describe('forward-progress / no-hang', () => {
    it('should not hang on a line starting with # that is not a heading', () => {
      const html = renderInSubprocess('#1602, #1578 (coordinate w/ #1605), #1586.');
      assert.ok(html.includes('<p>'), `Got: ${html}`);
      assert.ok(html.includes('#1602'), `Got: ${html}`);
    });

    it('should not hang on a bare ordered-list marker with no content', () => {
      const html = renderInSubprocess('1. ');
      assert.equal(typeof html, 'string');
    });

    it('should render a #-prefixed non-heading as a paragraph, not a heading', () => {
      const html = renderInSubprocess('#1602 not a heading');
      assert.ok(!/<h[1-6]/.test(html), `Should not be a heading. Got: ${html}`);
      assert.ok(html.includes('<p>'), `Got: ${html}`);
    });

    it('should still render a proper "# heading" as a heading', () => {
      const html = renderInSubprocess('# Real Heading');
      assert.ok(/<h1[^>]*>.*Real Heading/.test(html), `Got: ${html}`);
    });

    it('should not hang on a multi-line page mixing headings and #-prefixed text', () => {
      const md = '## Mergeable now\n#1602, #1578, #1586, #1530.\n\n## Next\nplain text line.';
      const html = renderInSubprocess(md);
      assert.ok(html.includes('#1602'), `Got: ${html}`);
      assert.ok(html.includes('Mergeable now'), `Got: ${html}`);
    });
  });
});
