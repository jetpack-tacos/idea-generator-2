import { fetch as trending } from './github-trending.ts';
import { fetch as githubNew } from './github-new.ts';
import { fetch as hackernews } from './hackernews.ts';
import { fetch as lobsters } from './lobsters.ts';
import { fetch as papers } from './papers.ts';
import { fetch as googleNews } from './google-news.ts';
import type { Scout } from './http.ts';

export const scouts = {
  'github-trending': trending,
  'github-new': githubNew,
  hackernews,
  lobsters,
  papers,
  'google-news': googleNews,
} satisfies Record<string, Scout>;

export type PublicScoutSource = keyof typeof scouts;
export type ScoutSource = PublicScoutSource | 'sessions';
