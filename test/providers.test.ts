// Provider adapters against local fake servers: the request shapes we send
// and the fallbacks we take. (Real providers are exercised by `npm run calibrate`.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  extractJson, listModels, makeChat, parseModel, ProviderError,
} from '../server/providers.ts';

type Seen = { path: string; headers: Record<string, any>; body: any };
const seen: Seen[] = [];
let script: ((s: Seen) => { status: number; body: unknown }) | null = null;
let server: Server;
let base = '';

before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const s: Seen = { path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    seen.push(s);
    const out = script ? script(s) : { status: 404, body: { error: 'no script' } };
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.DEEPSEEK_API_KEY = 'ds-test';
  process.env.ZAI_API_KEY = 'zai-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.OPENROUTER_API_KEY = 'or-test';
  // The Anthropic SDK reads its base URL from the environment.
  process.env.ANTHROPIC_BASE_URL = base;
});
after(() => server.close());

const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
const req = (model: string) => ({ model, system: 'sys', user: 'usr', schemaName: 'idea', schema, temperature: 0.9 });
const oaiAnswer = (content: string, extra: object = {}) => ({ choices: [{ message: { content, ...extra } }], usage: { cost: 0.002 } });

test('model references: provider prefix and bare OpenRouter slugs', () => {
  assert.deepEqual(parseModel('openrouter:anthropic/claude-sonnet-5.5'), { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' });
  assert.throws(() => parseModel('missing:example'), ProviderError);
  assert.deepEqual(parseModel('anthropic/claude-sonnet-5.5'), { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' });
  assert.deepEqual(parseModel('anthropic:claude-opus-5-5'), { provider: 'anthropic', model: 'claude-opus-5-5' });
});

test('JSON is dug out of thinking tags, code fences and prose', () => {
  assert.deepEqual(extractJson('<think>hmm {no}</think>\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":2}} hope that helps'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'));
});

test('OpenAI-compatible: strict json_schema, Bearer key, cost from usage', async () => {
  script = () => ({ status: 200, body: oaiAnswer('{"title":"Ok"}') });
  const chat = makeChat({ baseUrls: { openrouter: base } });
  const out = await chat(req('openrouter:my-model'));
  assert.deepEqual(out.value, { title: 'Ok' });
  assert.equal(out.costUsd, 0.002);
  const s = seen.at(-1)!;
  assert.equal(s.path, '/chat/completions');
  assert.equal(s.headers.authorization, 'Bearer or-test');
  assert.equal(s.body.model, 'my-model');
  assert.equal(s.body.response_format.type, 'json_schema');
  assert.equal(s.body.response_format.json_schema.strict, true);
});

for (const [provider, model, key, cache, cost] of [
  ['deepseek', 'deepseek-flash', 'ds-test', { prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 }, 0.0004224],
  ['zai', 'glm-5.3-flash', 'zai-test', { prompt_tokens_details: { cached_tokens: 400 } }, 0.000202],
] as const) {
  test(`${provider}: strict schema, one JSON-object fallback, and cached token pricing`, async () => {
    seen.length = 0;
    const usage = { prompt_tokens: 1000, completion_tokens: 200, ...cache };
    const answer = { ...oaiAnswer('{"title":"OK"}'), usage };
    const attempts: any[] = [];
    const chat = makeChat({ baseUrls: { [provider]: base }, log: (row) => attempts.push(row) });
    const call = () => chat({ ...req(`${provider}:${model}`), role: 'judge', boardId: 7 });
    script = () => ({ status: 200, body: answer });
    const strict = await call();
    assert.deepEqual(strict.value, { title: 'OK' });
    assert.ok(Math.abs(strict.costUsd - cost) < 1e-12);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/chat/completions');
    assert.equal(seen[0].headers.authorization, `Bearer ${key}`);
    assert.deepEqual(seen[0].body.response_format, { type: 'json_schema', json_schema: { schema, name: 'idea', strict: true } });
    assert.equal(seen[0].body.reasoning_effort, provider === 'zai' ? 'low' : 'none');
    assert.ok(!('thinking' in seen[0].body));

    seen.length = attempts.length = 0;
    script = (s) => s.body.response_format.type === 'json_schema'
      ? { status: 400, body: { error: 'Unsupported response_format' } }
      : { status: 200, body: answer };
    const fallback = await call();
    assert.deepEqual(fallback.value, { title: 'OK' });
    assert.ok(Math.abs(fallback.costUsd - cost) < 1e-12);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1].body.response_format, { type: 'json_object' });
    assert.ok(seen[1].body.messages[0].content.includes(JSON.stringify(schema)));
    assert.deepEqual(attempts.map(({ costUsd }) => Number(costUsd.toFixed(10))), [0, cost]);
    assert.deepEqual(attempts.map(({ costUsd, ...attempt }) => attempt), [
      { model: `${provider}:${model}`, boardId: 7, role: 'judge', inputTokens: 0, outputTokens: 0 },
      { model: `${provider}:${model}`, boardId: 7, role: 'judge', inputTokens: 1000, outputTokens: 200 },
    ]);
    seen.length = 0;
    script = () => ({ status: 400, body: { error: 'Unsupported response_format' } });
    await assert.rejects(call(), (e: any) => e.code === 'provider_error');
    assert.equal(seen.length, 2);
  });
}

test('missing key and missing search are explained, not sent', async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const chat = makeChat();
  await assert.rejects(chat(req('openai:gpt-5.4-mini')), (e: any) => e.code === 'no_key');
  await assert.rejects(chat({ ...req('deepseek:deepseek-flash'), plugins: [{ id: 'web' }] }), (e: any) => e.code === 'no_search');
  if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
});

test('Anthropic (SDK): output_config with JSON schema and low effort, no temperature, cost from usage', async () => {
  seen.length = 0;
  script = () => ({
    status: 200,
    body: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: '{"title":"Från Claude"}' }], usage: { input_tokens: 1000, output_tokens: 100 },
    },
  });
  const chat = makeChat();
  const out = await chat(req('anthropic:claude-sonnet-5-5'));
  assert.deepEqual(out.value, { title: 'Från Claude' });
  assert.equal(out.costUsd, (1000 * 2 + 100 * 10) / 1e6);
  const s = seen.at(-1)!;
  assert.equal(s.path, '/v1/messages');
  // The SDK decides how the key travels (API version 2026-10-21 sends it as a Bearer token).
  assert.ok(s.headers.authorization === 'Bearer sk-ant-test' || s.headers['x-api-key'] === 'sk-ant-test');
  assert.deepEqual(s.body.output_config, { format: { type: 'json_schema', schema }, effort: 'low' });
  assert.ok(!('temperature' in s.body));
  assert.equal(s.body.system, 'sys');
});

test('model lists double as a connection test', async () => {
  script = () => ({ status: 200, body: { data: [{ id: 'b' }, { id: 'a' }] } });
  assert.deepEqual(await listModels('deepseek', { deepseek: base }), ['a', 'b']);
  assert.equal(seen.at(-1)!.path, '/models');
  await assert.rejects(listModels('deepseek', { deepseek: 'http://127.0.0.1:1' }), (e: any) => e.code === 'unreachable');
});
