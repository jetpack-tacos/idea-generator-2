import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch as trending } from '../server/scouts/github-trending.ts';
import { fetch as githubNew } from '../server/scouts/github-new.ts';
import { fetch as hackernews } from '../server/scouts/hackernews.ts';
import { fetch as lobsters } from '../server/scouts/lobsters.ts';
import { fetch as papers } from '../server/scouts/papers.ts';
import { fetch as googleNews } from '../server/scouts/google-news.ts';

const NO_CONFIG = join(import.meta.dirname, 'no-such-sources.json');
const trendingHtml = readFileSync(join(import.meta.dirname, 'fixtures/github-trending.html'), 'utf8');

test('public scouts map live response shapes and fetch only the configured endpoints', async (t) => {
  const fetched: URL[] = [];
  const date = '2026-11-12T12:00:00.000Z';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    let payload: any;
    if (url.pathname === '/trending') return res.end(trendingHtml);
    if (url.pathname === '/search/repositories') {
      payload = { items: [{ id: 998, full_name: 'test/new', html_url: 'https://github.com/test/new', description: null, created_at: date }] };
    } else if (url.pathname === '/v0/topstories.json') {
      payload = Array.from({ length: 42 }, (_, i) => i + 1);
    } else if (url.pathname.startsWith('/v0/item/')) {
      const id = Number(url.pathname.match(/\d+(?=\.json$)/)?.[0]);
      payload = id === 1 ? { id, title: 'TEST HN', time: Date.parse(date) / 1000 } : null;
    } else if (url.pathname === '/api/v1/search_by_date') {
      payload = { hits: [
        { objectID: '1', title: 'TEST duplicate', story_text: '<p>TEST &amp; text</p>', created_at: date },
        { objectID: '100', title: 'TEST Show HN', url: 'https://example.test/show', created_at: date },
      ] };
    } else if (url.pathname === '/hottest.json') {
      payload = [{ short_id: 'lob-1', title: 'TEST lobsters', comments_url: 'https://lobste.rs/s/lob-1', description: '<p>TEST comment</p>', created_at: date }];
    } else if (url.pathname === '/api/daily_papers') {
      payload = [{ paper: { id: '2611.1', title: 'TEST  paper', ai_summary: 'TEST paper summary', publishedAt: date } }];
    } else if (url.pathname.startsWith('/rss/')) {
      if (url.pathname === '/rss/topics/made-up-hobby-topic-id') return res.writeHead(503).end();
      const items = Array.from({ length: 12 }, (_, i) => `<item><guid>test-${i}</guid><title><![CDATA[TEST News & tools]]></title><link>https://example.test/${i}?a=1&amp;b=2</link><pubDate>Thu, 12 Nov 2026 12:00:00 GMT</pubDate><source url="https://example.test">TEST news &amp; tools</source></item>`);
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`);
    } else {
      return res.writeHead(404).end();
    }
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const requestHeaders: Headers[] = [];
  const transport: typeof fetch = (input, init) => {
    assert.ok(init?.signal, 'the network request must have a timeout signal');
    const url = new URL(String(input));
    fetched.push(url);
    if (url.hostname === 'api.github.com') requestHeaders.push(new Headers(init.headers));
    return fetch(base + url.pathname + url.search, init);
  };

  assert.deepEqual((await trending(transport)).map(({ externalId, title, summary }) => [externalId, title, summary]), [
    ['test-maker/weatherdial', 'test-maker/WeatherDial', 'TEST weather & garden dial ☀.'],
    ['test-maker/solder-notes', 'test-maker/solder-notes', ''],
  ]);
  assert.deepEqual(fetched.filter((url) => url.pathname === '/trending').map((url) => url.search), ['', '?since=daily']);
  assert.equal((await githubNew(transport, Date.parse('2026-11-22T00:00:00Z'), 'test-token', NO_CONFIG))[0].externalId, '998');
  await githubNew(transport, Date.parse('2026-11-22T00:00:00Z'), '', NO_CONFIG);
  assert.equal(requestHeaders[0].get('User-Agent'), 'idea-generator');
  assert.equal(requestHeaders[0].get('Authorization'), 'Bearer test-token');
  assert.equal(requestHeaders[1].get('Authorization'), null);
  const search = fetched.find((url) => url.pathname === '/search/repositories')!;
  assert.deepEqual(Object.fromEntries(search.searchParams), {
    q: 'created:>2026-11-15', sort: 'stars', order: 'desc', per_page: '30',
  });

  const hn = await hackernews(transport);
  assert.deepEqual(hn.map(({ externalId, url, summary }) => [externalId, url, summary]), [
    ['1', 'https://news.ycombinator.com/item?id=1', 'TEST & text'],
    ['100', 'https://example.test/show', ''],
  ]);
  assert.equal(fetched.filter((url) => url.pathname.startsWith('/v0/item/')).length, 40);
  assert.equal(fetched.find((url) => url.hostname === 'hn.algolia.com')?.searchParams.get('tags'), 'show_hn');
  assert.equal((await lobsters(transport))[0].url, 'https://lobste.rs/s/lob-1');
  assert.deepEqual((await papers(transport))[0], {
    source: 'papers', externalId: '2611.1', title: 'TEST paper', url: 'https://huggingface.co/papers/2611.1',
    summary: 'TEST paper summary', publishedAt: date,
  });

  const pauses: number[] = [];
  const warnings: string[] = [];
  const news = await googleNews(transport, join(import.meta.dirname, '../sources.example.json'),
    async (ms) => { pauses.push(ms); }, (message) => warnings.push(message));
  assert.deepEqual(pauses, [2000]);
  assert.match(warnings[0], /feed 1 failed: news.google.com HTTP 503/);
  assert.equal(news.length, 10);
  assert.deepEqual(news[0], {
    source: 'google-news', externalId: 'test-0', title: 'TEST News & tools', url: 'https://example.test/0?a=1&b=2',
    summary: 'TEST news & tools', publishedAt: date,
  });
  const site = fetched.find((url) => url.pathname === '/rss/search')!;
  assert.equal(site.searchParams.get('q'), 'site:workshop.example');
  assert.equal(site.searchParams.get('ceid'), 'US:en');
});

test('hackernews tolerates single item 502 and missing story time; JSON scouts guard non-array shapes', async () => {
  const hnTransport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v0/topstories.json') return new Response(JSON.stringify([10, 11]), { status: 200 });
    if (url.pathname === '/v0/item/10.json') return new Response('bad gateway', { status: 502 });
    if (url.pathname === '/v0/item/11.json') return new Response(JSON.stringify({ id: 11, title: 'No Time Story' }), { status: 200 });
    return new Response(JSON.stringify({ hits: [{ objectID: '20', title: 'Show OK', created_at: '2026-11-12T00:00:00Z' }] }), { status: 200 });
  };
  const hn = await hackernews(hnTransport);
  assert.deepEqual(hn.map((f) => [f.externalId, f.publishedAt]), [
    ['11', undefined],
    ['20', '2026-11-12T00:00:00Z'],
  ]);

  const badShapeTransport: typeof fetch = async () => new Response(JSON.stringify({ message: 'rate limit' }), { status: 200 });
  await assert.rejects(githubNew(badShapeTransport, Date.now(), '', NO_CONFIG), /invalid repository list/i);
  await assert.rejects(lobsters(badShapeTransport), /invalid story list/i);
});

test('github-new adds keyword searches from the local sources file, and Google News takes search feeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-sources-'));
  try {
    const config = join(dir, 'sources.json');
    writeFileSync(config, JSON.stringify({
      githubSearches: ['m5stack', 'macrodroid', ''],
      googleNews: [{ name: 'MacroDroid', kind: 'search', id: 'MacroDroid NFC' }],
    }));
    const urls: URL[] = [];
    const repo = (id: number) => ({ id, full_name: `t/r${id}`, html_url: `https://github.com/t/r${id}`, description: null, created_at: '2026-11-20T00:00:00Z' });
    const transport: typeof fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.hostname === 'news.google.com') {
        return new Response('<rss><channel><item><title>T</title><link>https://example.test/n</link><guid>n1</guid></item></channel></rss>', { status: 200 });
      }
      const q = url.searchParams.get('q')!;
      if (q.startsWith('macrodroid')) return new Response('rate limited', { status: 403 });
      return new Response(JSON.stringify({ items: q.startsWith('created') ? [repo(1), repo(2)] : [repo(2), repo(3)] }), { status: 200 });
    };
    const pauses: number[] = [];
    const logs: string[] = [];
    const finds = await githubNew(transport, Date.parse('2026-11-22T00:00:00Z'), '', config, async (ms) => { pauses.push(ms); }, (m) => logs.push(m));
    assert.deepEqual(finds.map((f) => f.externalId), ['1', '2', '3'], 'keyword results added once each');
    assert.deepEqual(urls.map((u) => u.searchParams.get('q')), ['created:>2026-11-15', 'm5stack pushed:>2026-11-15', 'macrodroid pushed:>2026-11-15', 'macrodroid pushed:>2026-11-15']);
    assert.deepEqual(pauses, [10_000, 10_000, 61_000], 'a refused search waits for the next minute and tries once more');
    assert.match(logs[0], /search "macrodroid" failed/);

    urls.length = 0;
    const news = await googleNews(transport, config, async () => {}, () => {});
    assert.equal(news.length, 1);
    assert.equal(urls[0].pathname, '/rss/search');
    assert.equal(urls[0].searchParams.get('q'), 'MacroDroid NFC');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
