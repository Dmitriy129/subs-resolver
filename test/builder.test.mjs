import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSubscriptionUrl } from '../public/index.js';

const endpoint = 'https://resolver.example/11111111-2222-4333-8444-555555555555/';

test('builds a link on the current endpoint with ordered full URLs and one layer of query encoding', () => {
  const primary = 'https://primary.example/sub/user%2Fname?tag=a%26b&tag=a+b&tag=a%2Bb&empty=';
  const backup = 'http://backup.example:8080/другой/用户?имя=Иван&format=base64';
  const sources = [primary, backup, primary];
  const link = new URL(buildSubscriptionUrl(endpoint, sources));

  assert.equal(link.origin + link.pathname, endpoint);
  assert.deepEqual(link.searchParams.getAll('subs'), sources);
  assert.deepEqual([...link.searchParams.keys()], ['subs', 'subs', 'subs']);
  assert.equal(new URL(link.searchParams.get('subs')).search, new URL(primary).search);
});

test('trims pasted URL edges and skips blank backup rows without changing priority', () => {
  const link = new URL(buildSubscriptionUrl(endpoint, [
    '  https://primary.example/sub/first\n', '', '  ', '\thttps://backup.example/sub/second  ',
  ]));
  assert.deepEqual(link.searchParams.getAll('subs'), [
    'https://primary.example/sub/first', 'https://backup.example/sub/second',
  ]);
});

test('clears stale endpoint query and fragment and normalizes the trailing slash', () => {
  const link = new URL(buildSubscriptionUrl(`${endpoint.slice(0, -1)}?subs=old&unused=1#old`, [
    'https://primary.example/sub/client',
  ]));
  assert.equal(link.origin + link.pathname, endpoint);
  assert.equal(link.hash, '');
  assert.deepEqual([...link.searchParams], [['subs', 'https://primary.example/sub/client']]);
});

test('requires a primary URL and identifies malformed backup rows instead of generating a partial link', () => {
  for (const sources of [[], [''], ['  ', 'https://backup.example/sub/client']]) {
    assert.throws(() => buildSubscriptionUrl(endpoint, sources), (error) => error.rowIndex === 0);
  }
  for (const invalid of [
    'primary.example/sub/client', '/relative', 'ftp://example.com/sub', 'http://',
    'https://user:password@example.com/sub', 'https://example.com/sub#fragment',
    'https://example.com/sub#', 'https://example.com/sub with space', 'https://exa\nmple.com/sub',
  ]) {
    assert.throws(
      () => buildSubscriptionUrl(endpoint, ['https://primary.example/sub/client', invalid]),
      (error) => error.rowIndex === 1,
    );
  }
});
