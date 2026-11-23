import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetch as lookback, monthWindows } from '../server/scouts/lookback.ts';
import { claudeFallbackOn, isOutOfQuota, makeChat, ProviderError } from '../server/providers.ts';

const NOW = Date.parse('2026-11-23T03:00:00Z');

test('lookback asks each source once per month for six months and keeps the usual source names', async () => {
  const urls: string[] = [];
  const transport = (async (url: string) => {
    urls.push(url);
    const body = url.includes('algolia')
      ? { hits: [{ objectID: `hn${urls.length}`, title: 'Story', url: 'https://example.com', created_at: '2026-06-01' }] }
      : url.includes('github')
        ? { items: [{ id: urls.length, full_name: 'a/b', html_url: 'https://github.com/a/b', description: 'd', created_at: '2026-06-01' }] }
        : [{ paper: { id: `p${urls.length}`, title: 'Paper', summary: 's', upvotes: urls.length } }];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const finds = await lookback(transport, NOW, async () => {}, () => {});
  assert.equal(urls.filter((u) => u.includes('algolia')).length, 6);
  assert.equal(urls.filter((u) => u.includes('api.github.com')).length, 6);
  assert.ok(urls.filter((u) => u.includes('daily_papers?month=')).length >= 6);
  assert.deepEqual([...new Set(finds.map((f) => f.source))].sort(), ['github-new', 'hackernews', 'papers']);
  assert.ok(urls.some((u) => u.includes('points>200')), 'HN keeps only stories over 200 points');
  assert.equal(monthWindows(NOW).at(-1)![0], NOW - 180 * 86_400_000, 'reaches back six 30-day months');
});

test('lookback throws only when every request failed, so the scheduler retries it', async () => {
  const down = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(lookback(down, NOW, async () => {}, () => {}), /lookback found nothing/);
});

test('quota failures are told apart from other failures', () => {
  assert.ok(isOutOfQuota(new ProviderError('provider_error', 'DeepSeek 402: Insufficient Balance')));
  assert.ok(isOutOfQuota(new ProviderError('provider_error', 'Z.ai 429: rate limit')));
  assert.ok(isOutOfQuota(new ProviderError('crew_cap', 'Daily crew limit (10) reached; resumes tomorrow')));
  assert.ok(!isOutOfQuota(new ProviderError('provider_error', 'Empty answer from deepseek-flash')));
  assert.ok(!isOutOfQuota(new ProviderError('bad_key', 'DeepSeek 401: bad key')));
});

test('Claude plan fallback answers a quota failure only until the cut-off time', async () => {
  const fallback = { until: '2026-11-23T00:00:00-05:00', model: 'sonnet', headlessPath: 'C:/x/claude_headless.py' };
  const settings = () => ({ claudeFallback: fallback }) as any;
  const asked: string[] = [];
  let time = Date.parse('2026-11-22T23:30:00-05:00');
  const chat = makeChat({
    settings, now: () => time, onFallback: (m) => asked.push(m),
    openai: async () => { throw new ProviderError('provider_error', 'DeepSeek 402: Insufficient Balance'); },
    claudePlan: async () => ({ value: { ok: true }, costUsd: 0 }),
  });
  const r = { model: 'deepseek:deepseek-flash', system: 's', user: 'u', schemaName: 'x', schema: {} } as any;
  assert.deepEqual((await chat(r)).value, { ok: true });
  assert.deepEqual(asked, ['deepseek:deepseek-flash']);
  time = Date.parse('2026-11-23T00:00:01-05:00');
  await assert.rejects(chat(r), /Insufficient Balance/, 'after midnight the fallback is off');
  assert.ok(claudeFallbackOn(fallback, Date.parse('2026-11-22T23:59:00-05:00')));
  assert.ok(!claudeFallbackOn({ ...fallback, until: '' }, 0));
});

test('a non-quota failure is not sent to Claude', async () => {
  const chat = makeChat({
    settings: () => ({ claudeFallback: { until: '2999-01-01T00:00:00Z', model: 'sonnet', headlessPath: 'x' } }) as any,
    openai: async () => { throw new ProviderError('provider_error', 'Empty answer from deepseek-flash'); },
    claudePlan: async () => { throw new Error('should not be called'); },
  });
  await assert.rejects(chat({ model: 'deepseek:deepseek-flash', system: 's', user: 'u', schemaName: 'x', schema: {} } as any), /Empty answer/);
});

test('credit run sends its roles to the credit until the cut-off or ceiling, keeps the cap clear, then falls back', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const ledger = join(mkdtempSync(join(tmpdir(), 'ideagen-credit-')), 'credit.jsonl');
  const creditRun = { until: '2026-11-25T19:00:00-05:00', maxUsd: 0.05, models: { combine: 'anthropic:claude-opus-5-5' } };
  let time = Date.parse('2026-11-23T10:00:00-05:00');
  const asked: string[] = [];
  const budget: number[] = [];
  const answer = (model: string) => async (r: any) => { asked.push(r.model); return { value: { from: model }, costUsd: 0 }; };
  const chat = makeChat({
    settings: () => ({ creditRun }) as any, now: () => time, creditLedger: ledger,
    openai: async (_p: any, model: string, r: any, _b: any, record: any) => { record({ inputTokens: 1, outputTokens: 1, costUsd: 0.001 }); return answer(model)(r); },
  });
  // Stand in for the Anthropic call by routing the credit model through the openai stub.
  creditRun.models.combine = 'deepseek:opus-stand-in';
  const r = (role: string) => ({ model: 'deepseek:deepseek-flash', role, system: 's', user: 'u', schemaName: 'x', schema: {}, onUsage: (u: any) => budget.push(u.costUsd) }) as any;
  await chat(r('combine'));
  await chat(r('judge'));
  assert.deepEqual(asked, ['deepseek:opus-stand-in', 'deepseek:deepseek-flash'], 'only the listed role goes to the credit');
  assert.deepEqual(budget, [0, 0.001], 'credit dollars stay off the daily cap');
  assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 1, 'credit dollars go to the ledger');
  time = Date.parse('2026-11-25T19:00:01-05:00');
  await chat(r('combine'));
  assert.equal(asked.at(-1), 'deepseek:deepseek-flash', 'after the cut-off it is back to the usual model');
});
