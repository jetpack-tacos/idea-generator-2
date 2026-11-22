import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request, type Find } from './http.ts';

type Repository = { id: number; full_name: string; html_url: string; description: string | null; created_at: string };

const LOCAL = join(import.meta.dirname, '../../sources.local.json');
// Anonymous GitHub search allows 10 requests a minute; a few keyword searches with a pause stay well under.
export const MAX_KEYWORD_SEARCHES = 6;

/** Keyword searches from sources.local.json ("githubSearches": ["m5stack", ...]); none when the file or key is missing. */
async function keywordSearches(configPath: string): Promise<string[]> {
  let config;
  try {
    config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^﻿/, ''));
  } catch (error: any) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const list = config?.githubSearches;
  if (!Array.isArray(list)) return [];
  return list.filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
    .map((term) => term.trim()).slice(0, MAX_KEYWORD_SEARCHES);
}

function toFinds(data: { items?: Repository[] }): Find[] {
  if (!Array.isArray(data?.items)) throw new Error('GitHub returned invalid repository list');
  return data.items.map((repo) => ({
    source: 'github-new', externalId: String(repo.id), title: repo.full_name,
    url: repo.html_url, summary: repo.description ?? '', publishedAt: repo.created_at,
  }));
}

export async function fetch(
  transport = globalThis.fetch, now = Date.now(), token = process.env.GITHUB_TOKEN,
  configPath = LOCAL, wait = delay, log: (message: string) => void = console.warn,
): Promise<Find[]> {
  const since = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
  const headers: Record<string, string> = { 'User-Agent': 'idea-generator', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // The search allowance without a sign-in is shared by everything on the home network
  // (seen 2026-11-22: 0 left in a minute this app barely used), so a refusal waits for the next minute and tries once more.
  const search = async (q: string, perPage: number) => {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
    try {
      return toFinds(await (await request(url, transport, headers)).json());
    } catch (error: any) {
      if (!/HTTP (403|429)/.test(error?.message ?? '')) throw error;
      await wait(61_000);
      return toFinds(await (await request(url, transport, headers)).json());
    }
  };

  const finds = new Map<string, Find>();
  for (const find of await search(`created:>${since}`, 30)) finds.set(find.externalId, find);
  // Popular repos on Jer's chosen subjects that changed in the last week; the seen list drops repeats.
  for (const term of await keywordSearches(configPath)) {
    await wait(10_000);
    try {
      for (const find of await search(`${term} pushed:>${since}`, 10)) {
        if (!finds.has(find.externalId)) finds.set(find.externalId, find);
      }
    } catch (error: any) {
      log(`[scouts] github-new search "${term}" failed: ${error.message ?? error}`);
    }
  }
  return [...finds.values()];
}
