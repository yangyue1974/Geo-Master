import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { paths, exists, readJson } from './util/fsx.js';
import type { SiteProfile } from './types.js';

/**
 * 极简 .env 加载。不引 dotenv —— 一个 20 行的函数不值得一个依赖。
 * 已存在的 process.env 优先(CI / shell 覆盖)。
 */
export async function loadEnv(): Promise<void> {
  const p = resolve(paths.data('..'), '.env');
  if (!(await exists(p))) return;
  const text = await readFile(p, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

export function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

export function requireEnv(key: string, why: string): string {
  const v = env(key);
  if (!v) throw new Error(`缺少环境变量 ${key} —— ${why}。参考 .env.example。`);
  return v;
}

export const MODELS = {
  perplexity: () => env('GEO_MODEL_PERPLEXITY') ?? 'perplexity/sonar-pro',
  openaiSearch: () => env('GEO_MODEL_OPENAI_SEARCH') ?? 'openai/gpt-4o-search-preview',
  gemini: () => env('GEO_MODEL_GEMINI') ?? 'gemini-2.5-flash',
  claude: () => env('GEO_MODEL_CLAUDE') ?? 'claude-sonnet-4-5',
};

export function budgetLimit(): number {
  const v = Number(env('GEO_BUDGET_USD'));
  return Number.isFinite(v) && v > 0 ? v : 50;
}

export async function loadSite(idOrPath: string): Promise<SiteProfile> {
  const candidates = [
    idOrPath,
    paths.sites(idOrPath),
    paths.sites(`${idOrPath}.json`),
  ];
  for (const c of candidates) {
    if (await exists(c)) {
      const profile = await readJson<SiteProfile>(c);
      return validateSite(profile);
    }
  }
  throw new Error(`找不到站点配置: ${idOrPath}(试过 ${candidates.join(', ')})`);
}

function validateSite(p: SiteProfile): SiteProfile {
  const missing = (['id', 'siteName', 'siteDomain', 'sitemap'] as const).filter((k) => !p[k]);
  if (missing.length) throw new Error(`站点配置缺字段: ${missing.join(', ')}`);
  if (!p.nameVariants?.length) {
    // mentioned=0.5 的判定完全依赖这个列表,缺了就静默漏判 —— 自动补最基本的变体
    p.nameVariants = [p.siteName, p.siteDomain];
  }
  if (!p.entityPatterns?.length) p.entityPatterns = [];
  if (!p.vertical) p.vertical = { noun: '' };
  if (!p.sampling) p.sampling = {};
  return p;
}
