import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscriptionLink } from '../public/editor.js';
import { buildSubscriptionUrl } from '../public/index.js';

test('editor decodes sources once and preserves priority, endpoint and cache option', () => {
  const sources = ['https://example.com/a?q=%26', 'https://backup.example/я', 'https://example.com/a?q=%26'];
  const original = buildSubscriptionUrl('https://old.example/secret/', sources);
  const parsed = parseSubscriptionLink(original + '&no_cache=1');
  assert.deepEqual(parsed.sources, sources);
  assert.equal(parsed.endpoint, 'https://old.example/secret/');
  assert.equal(parsed.noCache, true);
  assert.equal(buildSubscriptionUrl(parsed.endpoint, parsed.sources), original);
});

test('editor refuses ordinary links and unsupported parameters instead of silently overwriting them', () => {
  for (const url of ['https://example.com/', 'https://example.com/?subs=bad', 'https://example.com/?subs=https%3A%2F%2Fa.example&unknown=1']) {
    assert.throws(() => parseSubscriptionLink(url));
  }
});
