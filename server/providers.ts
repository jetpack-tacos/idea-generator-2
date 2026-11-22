import Anthropic from '@anthropic-ai/sdk';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import defaults from '../settings.example.json' with { type: 'json' };
import { runNoShell } from './alert.ts';
import type { ScoutSource } from './scouts/sources.ts';

export type ApiProviderId = 'openrouter' | 'anthropic' | 'openai' | 'deepseek' | 'zai';
export type ProviderId = ApiProviderId | 'crew';
export type CrewWorker = 'neon' | 'hydrogen';
export type CrewEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type Role = 'distill' | 'expand' | 'combine' | 'judge' | 'summary' | 'research' | 'x' | 'brief' | 'deep' | 'exists';
export const ROLES: Role[] = ['distill', 'expand', 'combine', 'judge', 'summary', 'research', 'x', 'brief', 'deep', 'exists'];

const CREW_WORKERS = new Set<string>(['neon', 'hydrogen']);
const CREW_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh']);

export type AppSettings = {
  models: Record<Role, string>;
  projectsRoot: string;
  /** Safety net across all boards, in USD per local calendar day. */
  maxUsdPerDay: number;
  activeHours: { start: string; end: string };
  scoutIntervalsHours: Record<ScoutSource, number>;
  judgeManyPath: string;
  crewPath: string;
  crewCallsPerDay: number;
  alertCommand: string[];
  sessionsPath: string;
  interests: string;
  seedThreshold: number;
  seedsPerRound: number;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  ...(defaults as AppSettings),
  judgeManyPath: '',
  crewPath: '',
  alertCommand: [],
  sessionsPath: '',
};

type ProviderDef = {
  label: string;
  type: 'openai' | 'anthropic';
  base?: string;
  env?: string;
  /** Can run OpenRouter's web-search plugin (needed for the X scout). */
  search?: boolean;
};

export const PROVIDERS: Record<ApiProviderId, ProviderDef> = {
  openrouter: { label: 'OpenRouter', type: 'openai', base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', search: true },
  anthropic: { label: 'Anthropic', type: 'anthropic', env: 'ANTHROPIC_API_KEY' },
  openai: { label: 'OpenAI', type: 'openai', base: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
  deepseek: { label: 'DeepSeek', type: 'openai', base: 'https://api.deepseek.com', env: 'DEEPSEEK_API_KEY' },
  zai: { label: 'Z.ai', type: 'openai', base: 'https://api.z.ai/api/paas/v4', env: 'ZAI_API_KEY' },
};

export function parseCrewModel(model: string): { worker: CrewWorker; effort: CrewEffort } {
  const parts = model.split(':');
  if (parts.length < 1 || parts.length > 2) throw new ProviderError('bad_model', `Invalid crew model "${model}"`);
  const [worker, effort = 'medium'] = parts;
  if (!CREW_WORKERS.has(worker)) throw new ProviderError('bad_model', `Unknown crew worker "${worker}" (expected neon or hydrogen)`);
  if (!CREW_EFFORTS.has(effort)) throw new ProviderError('bad_model', `Invalid crew effort "${effort}" (expected low, medium, high, or xhigh)`);
  return { worker: worker as CrewWorker, effort: effort as CrewEffort };
}

export function parseModel(ref: string): { provider: ProviderId; model: string } {
  const i = ref.indexOf(':');
  const head = i > 0 ? ref.slice(0, i) : '';
  if (head === 'crew') {
    const rest = ref.slice(i + 1);
    const { worker, effort } = parseCrewModel(rest);
    return { provider: 'crew', model: `${worker}:${effort}` };
  }
  // Bare OpenRouter model slugs can have tags such as vendor/model:free.
  if (Object.hasOwn(PROVIDERS, head) && ref.slice(i + 1)) return { provider: head as ApiProviderId, model: ref.slice(i + 1) };
  if (ref && (i < 0 || ref.slice(0, i).includes('/'))) return { provider: 'openrouter', model: ref };
  throw new ProviderError('bad_model', `Invalid model reference "${ref}"`);
}

export function isCrewModel(ref: string): boolean {
  if (!ref) return false;
  try {
    return parseModel(ref).provider === 'crew';
  } catch {
    return false;
  }
}

export function keyFor(p: ApiProviderId): string | undefined {
  const env = PROVIDERS[p].env;
  return (env && process.env[env]) || undefined;
}

type BaseUrls = Partial<Record<ApiProviderId, string>>;

function baseFor(p: ApiProviderId, baseUrls: BaseUrls) {
  return (baseUrls[p] ?? PROVIDERS[p].base ?? '').replace(/\/+$/, '');
}

export class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Anthropic first-party prices (USD per million tokens), for the budget limiter.
const ANTHROPIC_PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
};
const ANTHROPIC_PRICE_PREFIXES = Object.entries(ANTHROPIC_PRICES).sort((a, b) => b[0].length - a[0].length);

function anthropicPrice(model: string): [number, number] {
  if (ANTHROPIC_PRICES[model]) return ANTHROPIC_PRICES[model];
  const undated = model.replace(/-\d{8}$/, '');
  if (ANTHROPIC_PRICES[undated]) return ANTHROPIC_PRICES[undated];
  const prefix = ANTHROPIC_PRICE_PREFIXES.find(([k]) => model.startsWith(k));
  return prefix ? prefix[1] : [5, 25];
}

export type ChatRequest = {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: object;
  temperature: number;
  maxTokens?: number;
  timeoutMs?: number;
  onUsage?: (usage: Usage) => void;
  boardId?: number;
  role?: Role;
  /** OpenRouter plugins, e.g. [{ id: 'web', engine: 'native' }] for live search. */
  plugins?: object[];
};
/** citations: URLs the search engine itself returned (not what the model wrote). costUsd: 0 when the provider does not report it. */
export type Usage = { inputTokens: number; outputTokens: number; costUsd: number };
export type ChatResult = { value: any; costUsd: number; citations?: string[] };
export type ChatAttempt = { model: string; boardId: number | null; role: Role } & Usage;

const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const MODEL_PRICES: Record<string, [miss: number, hit: number, output: number]> = {
  'deepseek:deepseek-flash': [0.30, 0.006, 1.20],
  'deepseek:deepseek-chat': [0.30, 0.03, 1.20],
  'deepseek:deepseek-reasoner': [0.55, 0.14, 2.19],
  'zai:glm-5.3-flash': [0.15, 0.03, 0.50],
  'zai:glm-5-flash': [0.15, 0.03, 0.50],
  'openai:gpt-5.4-mini': [0.40, 0.10, 1.60],
  'openai:gpt-5.4': [2.50, 0.625, 10.00],
  'openai:gpt-4o-mini': [0.15, 0.075, 0.60],
  'openai:gpt-4o': [2.50, 1.25, 10.00],
};
const FALLBACK_PAID_PRICE: [miss: number, hit: number, output: number] = [2.00, 0.50, 10.00];

function chatUsage(provider: ApiProviderId, model: string, usage: any): Usage {
  const hits = tokens(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens);
  const inputTokens = tokens(usage?.prompt_tokens) || hits + tokens(usage?.prompt_cache_miss_tokens);
  const outputTokens = tokens(usage?.completion_tokens);
  const price = MODEL_PRICES[`${provider}:${model}`];
  const cached = Math.min(inputTokens, hits);
  const reported = Number(usage?.cost);
  const isFree = provider === 'openrouter' && /:free$/i.test(model);
  let costUsd = 0;
  if (price) {
    costUsd = ((inputTokens - cached) * price[0] + cached * price[1] + outputTokens * price[2]) / 1e6;
  } else if (Number.isFinite(reported) && reported > 0) {
    costUsd = reported;
  } else if (!isFree && (inputTokens > 0 || outputTokens > 0)) {
    costUsd = ((inputTokens - cached) * FALLBACK_PAID_PRICE[0] + cached * FALLBACK_PAID_PRICE[1] + outputTokens * FALLBACK_PAID_PRICE[2]) / 1e6;
  }
  return { inputTokens, outputTokens, costUsd };
}
export type ChatFn = (r: ChatRequest) => Promise<ChatResult>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull a JSON object out of a model answer: drop <think> blocks and code fences, take the outermost braces. */
export function extractJson(text: string) {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error(`No JSON object in answer: ${t.slice(0, 160)}`);
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pull the last fenced or bare JSON object out of a Markdown/prose reply. */
export function extractLastJson(text: string): any {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const candidates: { value: unknown; end: number }[] = [];

  for (const match of stripped.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const inner = match[1].trim();
    try {
      const parsed = JSON.parse(inner);
      if (isPlainJsonObject(parsed)) {
        candidates.push({ value: parsed, end: (match.index ?? 0) + match[0].length });
      }
    } catch {
      /* ignore non-JSON fences or fences with prose around JSON (covered by bare scan) */
    }
  }

  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < stripped.length; j++) {
      const ch = stripped[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(stripped.slice(i, j + 1));
            if (isPlainJsonObject(parsed)) {
              candidates.push({ value: parsed, end: j + 1 });
              i = j;
            }
          } catch {
            /* not valid JSON; keep scanning */
          }
          break;
        }
      }
    }
  }

  if (!candidates.length) throw new Error(`No JSON object in answer: ${stripped.trim().slice(0, 160)}`);
  candidates.sort((a, b) => a.end - b.end);
  return candidates[candidates.length - 1].value;
}

const promptJsonRule = (schema: object) =>
  `\n\nRespond with ONLY a JSON object that matches this JSON Schema. No prose, no code fences.\n${JSON.stringify(schema)}`;

async function openaiChat(p: ApiProviderId, model: string, r: ChatRequest, baseUrls: BaseUrls, record: (usage: Usage) => void): Promise<ChatResult> {
  const base = baseFor(p, baseUrls);
  const key = keyFor(p);
  if (!key) throw new ProviderError('no_key', `Set ${PROVIDERS[p].env} to use ${PROVIDERS[p].label}`);
  if (r.plugins && !PROVIDERS[p].search) throw new ProviderError('no_search', `${PROVIDERS[p].label} cannot search the web; use an OpenRouter model such as openrouter:x-ai/grok-4.3`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  headers.Authorization = `Bearer ${key}`;
  if (p === 'openrouter') Object.assign(headers, { 'HTTP-Referer': 'http://localhost:8300', 'X-Title': 'Idea Generator 2' });

  const flash = p === 'deepseek' || p === 'zai';
  let jsonMode: 'schema' | 'object' | 'prompt' = 'schema';
  const body: any = { model, temperature: r.temperature, max_tokens: r.maxTokens ?? 1200 };
  if (p === 'zai') {
    body.reasoning_effort = 'low';
    body.max_tokens = Math.max(body.max_tokens, 4000);
  }
  if (p === 'openrouter') {
    body.reasoning = { enabled: false };
    body.usage = { include: true };
    if (r.plugins) body.plugins = r.plugins;
  }
  let lastError = '';
  for (let attempt = 0, adjustments = 0; attempt < 3; ) {
    body.messages = [
      { role: 'system', content: r.system + (jsonMode !== 'schema' ? promptJsonRule(r.schema) : '') },
      { role: 'user', content: r.user },
    ];
    if (jsonMode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: r.schemaName, strict: true, schema: r.schema } };
    else if (jsonMode === 'object') body.response_format = { type: 'json_object' };
    else delete body.response_format;

    let res: Response;
    let text: string;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(r.plugins ? 150_000 : 120_000),
        redirect: 'error',
      });
      text = await res.text();
    } catch (error) {
      record(ZERO_USAGE);
      throw error;
    }
    let data: any;
    try { data = JSON.parse(text); } catch { /* reported below */ }
    const usage = chatUsage(p, model, data?.usage);
    record(usage);
    // Providers disagree on parameters; adapt and retry without spending an attempt.
    if (res.status === 400 && adjustments < 4) {
      adjustments++;
      if (body.reasoning && /reasoning/i.test(text)) {
        delete body.reasoning; // this model insists on reasoning; thinking counts against max_tokens
        body.max_tokens = Math.max(body.max_tokens * 4, 4000);
        continue;
      }
      if ('reasoning_effort' in body && /reasoning/i.test(text)) {
        delete body.reasoning_effort;
        continue;
      }
      if ('temperature' in body && /temperature/i.test(text)) { delete body.temperature; continue; }
      if (body.max_tokens && /max_tokens/i.test(text) && /max_completion_tokens/i.test(text)) {
        body.max_completion_tokens = body.max_tokens; delete body.max_tokens; continue;
      }
      if (jsonMode === 'schema' && (flash ? /response_format/i : /response_format|json_schema|structured/i).test(text)) {
        jsonMode = flash ? 'object' : 'prompt';
        continue;
      }
    }
    attempt++;
    if (!res.ok) {
      lastError = `${PROVIDERS[p].label} ${res.status}: ${text.slice(0, 300)}`;
      if (res.status === 401 || res.status === 403) throw new ProviderError('bad_key', lastError);
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * attempt); continue; }
      throw new ProviderError('provider_error', lastError);
    }
    if (!data) { lastError = `${PROVIDERS[p].label}: invalid JSON response`; continue; }
    const message = data.choices?.[0]?.message ?? {};
    const content: string | undefined = message.content;
    const citations: string[] = (message.annotations ?? [])
      .filter((a: any) => a?.type === 'url_citation' && a.url_citation?.url)
      .map((a: any) => a.url_citation.url);
    if (!content) { lastError = `Empty answer from ${model}`; continue; }
    try {
      return { value: extractJson(content), costUsd: usage.costUsd, citations };
    } catch (e: any) {
      lastError = e.message;
      if (!flash && jsonMode === 'schema') jsonMode = 'prompt';
    }
  }
  throw new ProviderError('provider_error', lastError || `${PROVIDERS[p].label} failed`);
}

const anthropicClients = new Map<string, Anthropic>();
function anthropicClient(key: string | undefined) {
  const id = key ?? '(default)';
  if (!anthropicClients.has(id)) anthropicClients.set(id, key ? new Anthropic({ apiKey: key, maxRetries: 0, timeout: 120_000 }) : new Anthropic({ maxRetries: 0, timeout: 120_000 }));
  return anthropicClients.get(id)!;
}

async function anthropicChat(model: string, r: ChatRequest, record: (usage: Usage) => void): Promise<ChatResult> {
  if (r.plugins) throw new ProviderError('no_search', 'The X scout needs OpenRouter (Grok with X search)');
  const key = keyFor('anthropic');
  if (!key) throw new ProviderError('no_key', 'Set ANTHROPIC_API_KEY to use Anthropic');
  const client = anthropicClient(key);
  // Structured output via output_config.format. No temperature: current models reject
  // non-default sampling. Low effort: these are short, single-shot answers.
  const output_config: any = { format: { type: 'json_schema', schema: r.schema }, effort: 'low' };
  for (let attempt = 0; attempt < 2; attempt++) {
    let received = false;
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: Math.max(r.maxTokens ?? 1200, 4000),
        system: r.system,
        messages: [{ role: 'user', content: r.user }],
        output_config,
      } as any);
      received = true;
      const inputTokens = msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0);
      const outputTokens = msg.usage.output_tokens;
      const [pin, pout] = anthropicPrice(model);
      const costUsd = (inputTokens * pin + outputTokens * pout) / 1e6;
      record({ inputTokens, outputTokens, costUsd });
      if (msg.stop_reason === 'refusal') throw new ProviderError('refused', `${model} declined to answer`);
      const text = msg.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
      return { value: extractJson(text), costUsd };
    } catch (e) {
      if (!received) record(ZERO_USAGE);
      // Older models (e.g. Haiku 4.5) do not take effort: drop it once and retry.
      if (e instanceof Anthropic.BadRequestError && 'effort' in output_config && /effort/i.test(e.message)) {
        delete output_config.effort;
        continue;
      }
      if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('bad_key', `Anthropic: ${e.message}`);
      if (e instanceof Anthropic.APIError) throw new ProviderError('provider_error', `Anthropic ${e.status}: ${e.message}`);
      throw e;
    }
  }
  throw new ProviderError('provider_error', `Anthropic ${model} failed`);
}

let crewQueue: Promise<void> = Promise.resolve();
function enqueueCrew<T>(fn: () => Promise<T>): Promise<T> {
  const next = crewQueue.then(fn, fn);
  crewQueue = next.then(() => {}, () => {});
  return next;
}

const DEFAULT_CREW_TIMEOUT_MS = 15 * 60_000;

async function crewChat(
  model: string,
  r: ChatRequest,
  opts: { crewPath?: () => string; crewTimeoutMs?: number; beforeCrew?: () => void },
  record: (usage: Usage) => void,
): Promise<ChatResult> {
  if (r.plugins) throw new ProviderError('no_search', 'Crew cannot perform X web search');
  const { worker, effort } = parseCrewModel(model);
  return enqueueCrew(async () => {
    const crewPath = opts.crewPath?.()?.trim() ?? '';
    if (!crewPath) throw new ProviderError('no_crew_path', 'Set crewPath in settings.local.json to use crew models');
    opts.beforeCrew?.();

    const dir = await mkdtemp(join(tmpdir(), 'ideagen-crew-'));
    const workDir = join(dir, 'work');
    const taskFile = join(dir, 'task.md');
    const outFile = join(dir, 'out.md');
    try {
      await mkdir(workDir, { recursive: true });
      const taskBody = [
        '# System',
        '',
        r.system,
        '',
        '# Task',
        '',
        r.user,
        '',
        '# Output Format',
        '',
        `Reply with ONLY one JSON object matching this JSON schema (${r.schemaName}).`,
        '',
        '```json',
        JSON.stringify(r.schema, null, 2),
        '```',
        '',
      ].join('\n');
      await writeFile(taskFile, taskBody, 'utf8');

      const timeoutMs = r.timeoutMs ?? opts.crewTimeoutMs ?? DEFAULT_CREW_TIMEOUT_MS;
      const timeoutMinutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
      const graceMs = timeoutMs >= 60_000 ? 15_000 : Math.min(15_000, Math.floor(timeoutMs * 0.1));
      const res = await runNoShell(
        'python',
        [
          '-I', crewPath, worker,
          '--task', taskFile,
          '--dir', workDir,
          '--out', outFile,
          '--effort', effort,
          '--timeout', String(timeoutMinutes),
        ],
        timeoutMs + graceMs,
      );
      record(ZERO_USAGE);

      const detail = (res.stderr || res.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (res.killed || res.code === 4) {
        throw new ProviderError('crew_timeout', detail || `Crew ${worker} timed out`);
      }
      if (res.error) {
        throw new ProviderError('provider_error', `Crew ${worker} failed to start: ${res.error.message}`);
      }
      if (res.code === 3) {
        throw new ProviderError('crew_signin', detail || `Crew ${worker} sign-in expired`);
      }
      if (res.code !== 0) {
        throw new ProviderError('provider_error', detail || `Crew ${worker} failed (exit ${res.code})`);
      }

      let outText: string;
      try {
        outText = await readFile(outFile, 'utf8');
      } catch {
        throw new ProviderError('provider_error', `Crew ${worker} did not write out.md`);
      }
      try {
        return { value: extractLastJson(outText), costUsd: 0 };
      } catch (e: any) {
        throw new ProviderError('provider_error', e?.message ?? String(e));
      }
    } finally {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* temp cleanup errors must not mask provider errors */
      }
    }
  });
}

/** A chat function that routes every request by its "provider:model" string. */
export function makeChat({
  baseUrls = {},
  log,
  settings,
  crewPath,
  crewTimeoutMs,
  beforeCrew,
}: {
  baseUrls?: BaseUrls;
  log?: (attempt: ChatAttempt) => void;
  settings?: () => AppSettings;
  crewPath?: () => string;
  crewTimeoutMs?: number;
  beforeCrew?: () => void;
} = {}): ChatFn {
  const resolveCrewPath = crewPath ?? (() => settings?.().crewPath ?? '');
  return async (r) => {
    const { provider, model } = parseModel(r.model);
    let costUsd = 0;
    const record = (usage: Usage) => {
      costUsd += usage.costUsd;
      r.onUsage?.(usage);
      if (r.role) log?.({ model: `${provider}:${model}`, boardId: r.boardId ?? null, role: r.role, ...usage });
    };
    const out = provider === 'crew'
      ? await crewChat(model, r, { crewPath: resolveCrewPath, crewTimeoutMs, beforeCrew }, record)
      : provider === 'anthropic'
        ? await anthropicChat(model, r, record)
        : await openaiChat(provider, model, r, baseUrls, record);
    return { ...out, costUsd };
  };
}

/** List a provider's models, also used as a connection test. */
export async function listModels(p: ApiProviderId, baseUrls: BaseUrls = {}): Promise<string[]> {
  const base = baseFor(p, baseUrls);
  const key = keyFor(p);
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(res.status === 401 || res.status === 403 ? 'bad_key' : 'provider_error', `${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError('provider_error', `Not JSON: ${text.slice(0, 120)}`);
    }
  };
  try {
    if (!key) throw new ProviderError('no_key', `Set ${PROVIDERS[p].env}`);
    if (p === 'anthropic') {
      const out: string[] = [];
      for await (const m of anthropicClient(key).models.list()) out.push(m.id);
      return out;
    }
    const headers = { Authorization: `Bearer ${key}` };
    return ((await get(`${base}/models`, headers)).data ?? []).map((m: any) => m.id).sort();
  } catch (e: any) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('unreachable', `${PROVIDERS[p].label}: ${e?.cause?.code ?? e.message}`);
  }
}
