import { fetchWithRetry } from '../../util/http.js';
import { env, requireEnv, MODELS } from '../../config.js';
import { extractCitations } from './extract.js';
import type { Citation, EngineId } from '../../types.js';

export interface EngineResponse {
  answerText: string;
  citations: Citation[];
  usage?: { costUsd?: number; promptTokens?: number; completionTokens?: number };
  raw: unknown;
  model: string;
}

export interface Engine {
  id: EngineId;
  model: string;
  available(): boolean;
  ask(query: string): Promise<EngineResponse>;
}

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

const REFERER_HEADERS = {
  'HTTP-Referer': 'https://github.com/yangyue1974/Geo-Master',
  'X-Title': 'geo-v0-probe',
};

/**
 * 禁令(spec §A4):不得使用 OpenRouter 的 `:online` 网页插件。
 * 它把第三方搜索索引外挂到任意模型上,测出的是那家索引的收录情况而非目标引擎自身的检索。
 * 这个断言在构造时检查 —— 让"尺子即错"这件事在跑之前就炸,而不是跑完 600 次调用之后。
 */
function assertNativeRetrieval(model: string): void {
  if (model.includes(':online') || model.endsWith('/online')) {
    throw new Error(
      `拒绝使用 ${model}:':online' 插件测的是第三方索引的收录情况,不是目标引擎自身的检索。尺子即错。`,
    );
  }
}

async function callOpenRouter(model: string, query: string, extra: Record<string, unknown> = {}) {
  assertNativeRetrieval(model);
  const key = requireEnv('OPENROUTER_API_KEY', '引擎探测需要');
  const res = await fetchWithRetry(OPENROUTER, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...REFERER_HEADERS,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: query }],
      // 必须显式打开,否则拿不到真实 cost,预算护栏就是瞎的
      usage: { include: true },
      ...extra,
    }),
    timeoutMs: 180_000,
    retries: 4,
  });
  const text = await res.text();
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`OpenRouter 返回非 JSON: ${text.slice(0, 500)}`);
  }
  if (raw.error) {
    throw new Error(`OpenRouter error: ${JSON.stringify(raw.error).slice(0, 500)}`);
  }
  return raw;
}

function answerOf(raw: any): string {
  const c = raw?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
  }
  return '';
}

function usageOf(raw: any) {
  const u = raw?.usage ?? {};
  return {
    costUsd: typeof u.cost === 'number' ? u.cost : undefined,
    promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
  };
}

// ---------------------------------------------------------------- 1. Perplexity

export function perplexityEngine(): Engine {
  const model = MODELS.perplexity();
  return {
    id: 'perplexity-sonar-pro',
    model,
    available: () => !!env('OPENROUTER_API_KEY'),
    async ask(query) {
      const raw = await callOpenRouter(model, query);
      const answerText = answerOf(raw);
      return { answerText, citations: extractCitations(raw, answerText).citations, usage: usageOf(raw), raw, model };
    },
  };
}

// ---------------------------------------------------------------- 2. OpenAI 搜索版

export function openaiSearchEngine(): Engine {
  const model = MODELS.openaiSearch();
  return {
    id: 'openai-search',
    model,
    available: () => !!env('OPENROUTER_API_KEY'),
    async ask(query) {
      // 搜索版模型不接受 temperature/top_p 等采样参数,请求体必须保持最小
      const raw = await callOpenRouter(model, query);
      const answerText = answerOf(raw);
      return { answerText, citations: extractCitations(raw, answerText).citations, usage: usageOf(raw), raw, model };
    },
  };
}

// ---------------------------------------------------------------- 3. Gemini grounding(直连)

export function geminiEngine(): Engine {
  const model = MODELS.gemini();
  return {
    id: 'gemini-grounded',
    model,
    available: () => !!env('GEMINI_API_KEY'),
    async ask(query) {
      const key = requireEnv('GEMINI_API_KEY', 'Gemini grounding 直连 Google,不走 OpenRouter');
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          tools: [{ google_search: {} }],
        }),
        timeoutMs: 180_000,
        retries: 4,
      });
      const raw: any = JSON.parse(await res.text());
      if (raw.error) throw new Error(`Gemini error: ${JSON.stringify(raw.error).slice(0, 500)}`);
      const answerText = (raw?.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p?.text ?? '')
        .join('');
      return {
        answerText,
        citations: extractCitations(raw, answerText).citations,
        // Gemini 免费额度覆盖本实验题量,不计入预算
        usage: { costUsd: 0 },
        raw,
        model,
      };
    },
  };
}

export const ALL_ENGINES: Record<EngineId, () => Engine> = {
  'perplexity-sonar-pro': perplexityEngine,
  'openai-search': openaiSearchEngine,
  'gemini-grounded': geminiEngine,
};

/** 默认引擎集:v0 只跑前两个,Gemini 有 key 才加入(spec §A4 第 3 条)。 */
export function resolveEngines(ids?: string[]): Engine[] {
  if (ids?.length) {
    return ids.map((id) => {
      const f = ALL_ENGINES[id as EngineId];
      if (!f) throw new Error(`未知引擎: ${id}(可选: ${Object.keys(ALL_ENGINES).join(', ')})`);
      return f();
    });
  }
  return [perplexityEngine(), openaiSearchEngine(), geminiEngine()].filter((e) => e.available());
}
