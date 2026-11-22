import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeEntities, request, type Find } from './http.ts';

type Feed = { name: string; kind: 'topics' | 'site'; id: string };
const LOCAL = join(import.meta.dirname, '../../sources.local.json');

function field(item: string, name: string) {
  const value = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(item)?.[1]?.trim() ?? '';
  return /^<!\[CDATA\[[\s\S]*\]\]>$/.test(value) ? value.slice(9, -3).trim() : decodeEntities(value);
}

export function parseFeed(xml: string, name: string): Find[] {
  if (!/<rss\b/i.test(xml)) throw new Error('Google News returned invalid RSS');
  const finds: Find[] = [];
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = field(item, 'title');
    const url = field(item, 'link');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const date = Date.parse(field(item, 'pubDate'));
    finds.push({
      source: 'google-news', externalId: field(item, 'guid') || url, title, url,
      summary: field(item, 'source') || name,
      publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : undefined,
    });
    if (finds.length === 10) break;
  }
  return finds;
}

export async function fetch(
  transport = globalThis.fetch, configPath = LOCAL, wait = delay,
  log: (message: string) => void = console.warn,
): Promise<Find[]> {
  let config;
  try {
    config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error: any) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const feeds: Feed[] = Array.isArray(config) ? config : config?.googleNews;
  if (!Array.isArray(feeds)) throw new Error('sources.local.json must contain a googleNews array');
  const finds = new Map<string, Find>();
  let succeeded = 0;
  for (const [index, feed] of feeds.entries()) {
    if (!feed?.id || typeof feed.id !== 'string' || typeof feed.name !== 'string' || (feed.kind !== 'topics' && feed.kind !== 'site')) {
      log(`[scouts] google-news invalid feed at position ${index + 1}`);
      continue;
    }
    if (index) await wait(2000);
    const id = encodeURIComponent(feed.id);
    const target = feed.kind === 'topics' ? `topics/${id}?` : `search?q=site:${id}&`;
    try {
      const response = await request(`https://news.google.com/rss/${target}hl=en-US&gl=US&ceid=US:en`, transport);
      for (const find of parseFeed(await response.text(), feed.name)) finds.set(find.externalId, find);
      succeeded++;
    } catch (error: any) {
      log(`[scouts] google-news feed ${index + 1} failed: ${error.message}`);
    }
  }
  if (feeds.length && !succeeded) throw new Error('All Google News feeds failed');
  return [...finds.values()];
}
