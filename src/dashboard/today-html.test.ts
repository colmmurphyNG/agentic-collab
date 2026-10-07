import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agoLabel, linkLabel, renderTodayRow } from './today-html.ts';

const NOW = Date.parse('2026-10-07T12:00:00Z');

describe('today-html', () => {
  it('labels ages', () => {
    assert.equal(agoLabel('2026-10-07T11:59:50Z', NOW), 'just now');
    assert.equal(agoLabel('2026-10-07T11:15:00Z', NOW), '45m ago');
    assert.equal(agoLabel('2026-10-07T10:00:00Z', NOW), '2h ago');
    assert.equal(agoLabel('2026-10-04T12:00:00Z', NOW), '3d ago');
    assert.equal(agoLabel('garbage', NOW), '');
  });

  it('shortens github pull request links', () => {
    assert.equal(linkLabel('https://github.com/o/repo/pull/42/files'), 'PR #42 repo');
    assert.equal(linkLabel('/pages/abc'), '/pages/abc');
  });

  it('escapes agent, topic, preview and link text and drops unsafe links', () => {
    const html = renderTodayRow({
      agent: '<b>a</b>', topic: '"t"', preview: '<script>x</script>', lastDirection: 'to_agent',
      lastMessageAt: '2026-10-07T10:00:00Z', messageCount: 2,
      links: ['javascript:alert(1)', 'https://x.io/?a="b"'],
    }, NOW);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>a'));
    assert.ok(!html.includes('javascript:'));
    assert.match(html, /data-topic="&quot;t&quot;"/);
    assert.match(html, /href="https:\/\/x\.io\/\?a=&quot;b&quot;"/);
    assert.match(html, /last: you/);
  });
});
