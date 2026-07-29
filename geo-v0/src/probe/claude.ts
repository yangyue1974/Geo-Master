import { fetchJson } from '../util/http.js';
import { requireEnv, MODELS } from '../config.js';

/**
 * Claude API —— 只用于题库的两处受约束辅助,不用于生成事实。
 * 直接打 HTTP,不引 SDK:两个函数不值得一个依赖。
 */

interface AnthropicResponse {
  content: { type: string; text?: string }[];
}

async function complete(prompt: string, maxTokens = 4096): Promise<string> {
  const key = requireEnv('ANTHROPIC_API_KEY', '题库的主题词生成与口语化改写需要');
  const res = await fetchJson<AnthropicResponse>('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELS.claude(),
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    timeoutMs: 180_000,
  });
  return res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
}

/** 主题词。明确禁止专有名词 —— 主题题目不该锚定到某个具体实体。 */
export async function suggestThemes(verticalNoun: string, n: number): Promise<string[]> {
  const text = await complete(
    `List ${n} common lyrical themes people search for in ${verticalNoun || 'popular'} music.\n\n` +
      `Rules:\n` +
      `- Each theme is 1-4 words, lowercase, no proper nouns (no artist names, no song titles, no place names).\n` +
      `- Themes an ordinary listener would actually type into a search box.\n` +
      `- Output ONLY a JSON array of strings. No prose, no markdown fence.`,
    1024,
  );
  const arr = parseJsonArray(text);
  return arr
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.length <= 40 && !/[A-Z]/.test(s))
    .slice(0, n);
}

/**
 * 口语化改写。返回数组与输入等长、同序。
 * 调用方会逐条校验专有名词是否被保留,不合格的丢弃 —— 所以这里的 prompt 只是尽力而为。
 */
export async function paraphraseBatch(queries: string[]): Promise<string[]> {
  const CHUNK = 40;
  const out: string[] = [];
  for (let i = 0; i < queries.length; i += CHUNK) {
    const chunk = queries.slice(i, i + CHUNK);
    const text = await complete(
      `Rewrite each search query below so it sounds like an ordinary music fan typing into an AI assistant.\n\n` +
        `HARD RULES:\n` +
        `- Keep every proper noun EXACTLY as written (artist names, song titles, album titles, years). Do not correct, expand, translate, or "fix" them, even if they look wrong.\n` +
        `- Keep the same question. Do not add or remove information.\n` +
        `- Keep it one sentence, English, casual but not slangy.\n` +
        `- Output ONLY a JSON array of strings, same length and same order as the input.\n\n` +
        `Input:\n${JSON.stringify(chunk, null, 2)}`,
      8192,
    );
    const arr = parseJsonArray(text);
    for (let j = 0; j < chunk.length; j++) {
      const v = arr[j];
      out.push(typeof v === 'string' ? v : chunk[j]!);
    }
  }
  return out;
}

function parseJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced && fenced[1] ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const v = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
