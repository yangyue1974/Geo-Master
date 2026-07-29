import { fetchText } from '../util/http.js';
import { mapLimit } from '../util/http.js';
import { log, progress } from '../util/log.js';
import { writeJson, paths, readJsonOr } from '../util/fsx.js';
import { globToRegExp, pathOf } from '../util/url.js';
import { fetchSitemap, proposePatterns } from './sitemap.js';
import { extractFromHtml } from './entityFacts.js';
import { extractFromSupabase } from './supabase.js';
import type { Entity, EntitiesFile, SiteProfile } from '../types.js';
import { SCHEMA_VERSION } from '../types.js';

export interface ExtractOpts {
  source: 'sitemap' | 'supabase';
  /** 每类实体最多抓多少页(抓 HTML 是最慢的一步,默认给个上限) */
  limitPerType?: number;
  concurrency?: number;
  /** 不抓 HTML,只从 sitemap URL 推名字。快速冒烟用。 */
  shallow?: boolean;
  /** 只打印模式提议然后退出 —— 接一个新站点时的第一步 */
  proposeOnly?: boolean;
}

export async function extractEntities(site: SiteProfile, opts: ExtractOpts): Promise<EntitiesFile> {
  const entities =
    opts.source === 'supabase'
      ? await extractFromSupabase(site)
      : await extractFromSitemap(site, opts);

  const file: EntitiesFile = {
    schemaVersion: SCHEMA_VERSION,
    site: site.id,
    source: opts.source,
    generatedAt: new Date().toISOString(),
    count: entities.length,
    entities,
  };

  const out = paths.data(site.id, 'entities.json');
  await writeJson(out, file);
  log.ok(`entities.json 写入 ${out} (${entities.length} 个实体)`);

  const withFacts = entities.filter((e) => e.facts && Object.keys(e.facts).length > 1).length;
  const byType = new Map<string, number>();
  for (const e of entities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  log.info(`  类型分布: ${[...byType].map(([t, c]) => `${t}=${c}`).join(', ')}`);
  log.info(`  含结构化事实: ${withFacts}/${entities.length}`);
  if (withFacts < entities.length * 0.3 && opts.source === 'sitemap' && !opts.shallow) {
    log.warn(
      '大部分实体页抽不到结构化事实 —— detail 档题量会很少。这本身就是 B5 体检的一个发现(站点缺 JSON-LD)。',
    );
  }
  return file;
}

async function extractFromSitemap(site: SiteProfile, opts: ExtractOpts): Promise<Entity[]> {
  log.step(`抓取 sitemap: ${site.sitemap}`);
  const entries = await fetchSitemap(site.sitemap);
  const urls = entries.map((e) => e.loc);

  if (opts.proposeOnly || site.entityPatterns.length === 0) {
    const proposals = proposePatterns(urls);
    log.step('URL 模式提议(把选中的写进 site profile 的 entityPatterns):');
    for (const p of proposals) {
      console.log(`  ${String(p.count).padStart(6)}  ${p.pattern}`);
      for (const s of p.samples) console.log(`          e.g. ${s}`);
    }
    if (opts.proposeOnly) return [];
    if (site.entityPatterns.length === 0) {
      throw new Error('site profile 没有 entityPatterns,且未指定 --propose。请先确认模式再跑。');
    }
  }

  // 按模式分类
  const matchers = site.entityPatterns.map((p) => ({ type: p.type, re: globToRegExp(p.pattern) }));
  const buckets = new Map<string, string[]>();
  for (const u of urls) {
    const path = pathOf(u);
    for (const m of matchers) {
      if (m.re.test(path)) {
        if (!buckets.has(m.type)) buckets.set(m.type, []);
        buckets.get(m.type)!.push(u);
        break; // 第一个匹配的模式赢,模式顺序即优先级
      }
    }
  }

  const limit = opts.limitPerType ?? 300;
  const targets: { type: string; url: string }[] = [];
  for (const [type, list] of buckets) {
    log.info(`  ${type}: sitemap 中 ${list.length} 个,抓取上限 ${limit}`);
    for (const u of list.slice(0, limit)) targets.push({ type, url: u });
  }
  if (targets.length === 0) {
    throw new Error('没有 URL 匹配任何 entityPattern。用 --propose 看看该站的真实 URL 形态。');
  }

  if (opts.shallow) {
    return targets.map(({ type, url }) => ({
      type,
      name: nameFromSlug(url),
      url,
      aliases: [],
    }));
  }

  // 断点续跑:已抓过的页不重抓
  const cachePath = paths.data(site.id, 'cache', 'pages.json');
  const cache = await readJsonOr<Record<string, { name: string | null; aliases: string[]; facts: unknown }>>(
    cachePath,
    {},
  );

  log.step(`抓取 ${targets.length} 个实体页 HTML(并发 ${opts.concurrency ?? 5})`);
  const bar = progress('pages', targets.length);
  const results = await mapLimit(targets, opts.concurrency ?? 5, async ({ type, url }) => {
    const cached = cache[url];
    if (cached) {
      bar.tick('(cached)');
      return { type, url, ...cached } as Entity & { facts: never };
    }
    try {
      const html = await fetchText(url, { timeoutMs: 45_000, retries: 2, noRetryStatus: [404, 410] });
      const ex = extractFromHtml(html, url);
      const rec = { name: ex.name ?? nameFromSlug(url), aliases: ex.aliases, facts: ex.facts };
      cache[url] = rec;
      bar.tick();
      return { type, url, ...rec };
    } catch (e) {
      bar.tick('(failed)');
      log.warn(`抓取失败 ${url}: ${(e as Error).message}`);
      return { type, url, name: nameFromSlug(url), aliases: [], facts: {} };
    }
  });
  bar.done();
  await writeJson(cachePath, cache, false);

  // 去重(同名同类型只留事实最丰富的那个)
  const byKey = new Map<string, Entity>();
  for (const r of results as Entity[]) {
    if (!r.name) continue;
    const key = `${r.type}::${r.name.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || factRichness(r) > factRichness(prev)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

function factRichness(e: Entity): number {
  const f = e.facts;
  if (!f) return 0;
  let n = 0;
  if (f.artist) n += 2;
  if (f.datePublished) n += 2;
  n += (f.albums?.length ?? 0) > 0 ? 3 : 0;
  n += (f.tracks?.length ?? 0) > 0 ? 3 : 0;
  n += (f.genre?.length ?? 0) > 0 ? 1 : 0;
  n += (f.sameAs?.length ?? 0) > 0 ? 1 : 0;
  if (f.description) n += 1;
  if (f._source?.includes('jsonld')) n += 2;
  return n;
}

/** URL slug → 人类可读名。仅在页面抽取失败时兜底。 */
function nameFromSlug(url: string): string {
  const segs = pathOf(url).split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  return decodeURIComponent(last)
    .replace(/[-_]+/g, ' ')
    .replace(/\.\w{2,5}$/, '')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
