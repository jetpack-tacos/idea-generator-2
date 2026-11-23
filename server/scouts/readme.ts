import { request } from './http.ts';

/**
 * Plain text from a README: no badges, images, HTML, code blocks or link targets.
 * The idea writer gets what the project does, not its markup.
 */
export function cleanReadme(markdown: string, maxLen = 1200): string {
  const text = markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ') // linked badges
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links keep their words
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ') // tables
    .replace(/[*_`]{1,3}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (stop > maxLen * 0.6 ? cut.slice(0, stop + 1) : cut).trim();
}

/** "owner/repo" from a GitHub repository URL, or null for anything else. */
export function repoFromUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The repo's README as plain text, or '' when it has none or GitHub refuses. Never throws. */
export async function fetchReadme(repoUrl: string, transport = globalThis.fetch, token = process.env.GITHUB_TOKEN): Promise<string> {
  const repo = repoFromUrl(repoUrl);
  if (!repo) return '';
  const headers: Record<string, string> = { 'User-Agent': 'idea-generator', Accept: 'application/vnd.github.raw+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await request(`https://api.github.com/repos/${repo}/readme`, transport, headers);
    return cleanReadme(await res.text());
  } catch {
    return '';
  }
}

/** A seed's pitch: the find's own summary plus what its README says. */
export function seedPitch(summary: string, readme: string): string {
  const parts = [summary.trim(), readme ? `From its README: ${readme}` : ''].filter(Boolean);
  return parts.join('\n\n').slice(0, 1600);
}
