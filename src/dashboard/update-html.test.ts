import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escAttr, isSafeLink, updateTitleHtml } from './update-html.ts';

describe('update-html', () => {
  it('links a safe link in a new tab without an opener', () => {
    const html = updateTitleHtml({ id: 3, title: 'Review', link: '/pages/review' });
    assert.match(html, /^<a class="update-title" href="\/pages\/review" target="_blank" rel="noopener noreferrer"/);
  });

  it('escapes the title and the link, so neither can add markup or break out of the href', () => {
    const html = updateTitleHtml({ id: 3, title: '<img src=x onerror=alert(1)>', link: 'https://example.com/"onmouseover="alert(1)' });
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /href="[^"]*"onmouseover/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&quot;onmouseover=&quot;/);
  });

  it('renders anything that is not http(s) or /pages/ as text, never as a link', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,x', 'review.html', '//evil.example.com', undefined]) {
      assert.equal(isSafeLink(link), false, String(link));
      assert.doesNotMatch(updateTitleHtml({ id: 1, title: 't', link }), /<a /, String(link));
    }
  });

  it('escAttr covers all five characters', () => {
    assert.equal(escAttr(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });
});
