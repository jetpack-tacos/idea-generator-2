import { plainText, request, type Find } from './http.ts';

const URL_ROOT = 'https://github.com';

export function parseTrending(html: string): Find[] {
  const finds: Find[] = [];
  for (const [, attrs, body] of html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const classes = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2];
    if (!classes?.split(/\s+/).includes('Box-row')) continue;
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(body)?.[1] ?? '';
    const href = /<a\b[^>]*\shref\s*=\s*(["'])(.*?)\1/i.exec(heading)?.[2];
    if (!href || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(href)) continue;
    const title = href.replace(/^\/|\/$/g, '');
    const summary = plainText(/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1]);
    finds.push({ source: 'github-trending', externalId: title.toLowerCase(), title, url: `${URL_ROOT}/${title}`, summary });
  }
  return finds;
}

export async function fetch(transport = globalThis.fetch): Promise<Find[]> {
  const pages = await Promise.all(['/trending', '/trending?since=daily'].map(async (path) => {
    const html = await (await request(URL_ROOT + path, transport)).text();
    const finds = parseTrending(html);
    if (!finds.length) throw new Error('GitHub Trending returned no repository entries');
    return finds;
  }));
  return [...new Map(pages.flat().map((find) => [find.externalId, find])).values()];
}
