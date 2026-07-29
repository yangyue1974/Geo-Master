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
  // 加载前就存在的变量来自 shell / CI,优先级高于文件
  const fromShell = new Set(Object.keys(process.env));
  const seenInFile = new Map<string, number>();

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
    if (!k) continue;
    /*
     * 文件内后出现的值胜出;但 shell / CI 里已设好的环境变量仍然压过文件。
     *
     * 这个文件的实际编辑方式是 `printf 'KEY=新值' >> .env` —— 换 key、换型号都这么干。
     * 先出现者胜出的话,追加的新值永远不生效:程序用着旧 key 报错,文件里却明明白白写着新的,
     * 而且不会有任何提示。占位行(`KEY=`)与真值并存时同理。
     */
    if (!fromShell.has(k)) {
      seenInFile.set(k, (seenInFile.get(k) ?? 0) + 1);
      if (v.trim() !== '' || !process.env[k]) process.env[k] = v;
    }
  }

  // 重复的 key 静默生效一个、忽略另一个,是排查时最浪费时间的一类问题
  const dupes = [...seenInFile].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupes.length) {
    console.warn(
      `[env] .env 里有重复定义,以最后一行为准: ${dupes.join(', ')} —— 建议删掉旧的那几行。`,
    );
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
  openaiSearch: () => env('GEO_MODEL_OPENAI_SEARCH') ?? 'gpt-4.1',
  gemini: () => env('GEO_MODEL_GEMINI') ?? 'gemini-3.6-flash',
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
