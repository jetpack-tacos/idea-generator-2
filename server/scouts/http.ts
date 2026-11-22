export type Find = {
  source: string;
  externalId: string;
  title: string;
  url: string;
  summary: string;
  publishedAt?: string;
};

export type Scout = () => Promise<Find[]>;

export async function request(url: string, transport: typeof fetch, headers: Record<string, string> = {}) {
  const res = await transport(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${new URL(url).hostname} HTTP ${res.status}`);
  }
  return res;
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (!name.startsWith('#')) return entities[name] ?? match;
    const hex = name[1].toLowerCase() === 'x';
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

export function plainText(markup = '') {
  return decodeEntities(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
