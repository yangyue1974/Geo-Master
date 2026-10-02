import { fetchWithRetry, mapLimit } from '../util/http.js';
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
  const dead: { url: string; type: string; reason: string }[] = [];
  const failed: { url: string; type: string; error: string }[] = [];
  const siteNameLc = site.siteName.trim().toLowerCase();

  const results = await mapLimit(targets, opts.concurrency ?? 5, async ({ type, url }): Promise<Entity | null> => {
    const cached = cache[url];
    if (cached) {
      bar.tick('(cached)');
      return { type, url, ...cached } as Entity;
    }
    try {
      const res = await fetchWithRetry(url, { timeoutMs: 45_000, retries: 2, noRetryStatus: [404, 410] });
      const html = await res.text();

      /*
       * 失效页面不是实体。三种形态都要认出来:
       *   - 硬 404 / 410
       *   - 被重定向到别的路径(常见于删除后跳首页)
       *   - 软 404:返回 200,但内容是全站通用页 —— 名字就是站名,没有任何实体级结构化数据
       *
       * 不拦的话,每个失效 URL 都会抽出一个叫站名的"实体",然后被去重合并成一条 ——
       * GospelHub 上 194 个已删除的演出 URL 就是这样静默消失的,日志里只显示"去重合并"。
       */
      if (res.status === 404 || res.status === 410) {
        dead.push({ url, type, reason: `HTTP ${res.status}` });
        bar.tick('(dead)');
        return null;
      }
      if (res.redirected && pathOf(res.url) !== pathOf(url)) {
        dead.push({ url, type, reason: `重定向到 ${pathOf(res.url) || '/'}` });
        bar.tick('(dead)');
        return null;
      }
      const ex = extractFromHtml(html, url);
      const hasEntityFacts = !!ex.facts._source?.some((s) => s === 'jsonld' || s === 'microdata');
      if (ex.name && ex.name.trim().toLowerCase() === siteNameLc && !hasEntityFacts) {
        dead.push({ url, type, reason: '返回全站通用页(软 404)' });
        bar.tick('(dead)');
        return null;
      }

      // slug 兜底只在 slug 本身可读时使用;UUID slug 造出来的名字比没有名字更糟
      const name = ex.name ?? readableSlugName(url);
      if (!name) {
        failed.push({ url, type, error: '页面里抽不到实体名,slug 也不可读' });
        bar.tick('(no name)');
        return null;
      }
      const rec = { name, aliases: ex.aliases, facts: ex.facts };
      cache[url] = rec;
      bar.tick();
      return { type, url, ...rec };
    } catch (e) {
      bar.tick('(failed)');
      failed.push({ url, type, error: (e as Error).message.split('\n')[0]! });
      return null;
    }
  });
  bar.done();
  await writeJson(cachePath, cache, false);

  if (dead.length) {
    const pct = ((dead.length / targets.length) * 100).toFixed(0);
    const byType = new Map<string, number>();
    for (const d of dead) byType.set(d.type, (byType.get(d.type) ?? 0) + 1);
    log.warn(
      `sitemap 里有 ${dead.length}/${targets.length} 个实体 URL 已失效(${pct}%;` +
        `${[...byType].map(([t, n]) => `${t}=${n}`).join(', ')}),已排除。` +
        `示例: ${dead[0]!.url} → ${dead[0]!.reason}`,
    );
    log.warn('  这是站点问题,不是抽取问题:抓取器沿 sitemap 抓到一批死链,会拉低整站的质量信号。明细见 dead-urls.json。');
  }
  if (failed.length) {
    log.warn(`${failed.length} 个页面抓取失败或抽不到实体名,已排除。示例: ${failed[0]!.url} — ${failed[0]!.error}`);
  }
  await writeJson(paths.data(site.id, 'dead-urls.json'), {
    checkedAt: new Date().toISOString(),
    total: targets.length,
    dead,
    failed,
  });

  const deduped = dedupe(results.filter((r): r is Entity => r !== null));
  const dropped = results.length - deduped.length;
  if (dropped > 0) log.info(`  去重合并 ${dropped} 个同一实体的重复页面`);
  return deduped;
}

/**
 * 去重。
 *
 * 「同类型同名 = 同一个实体」对歌手和专辑成立,对**事件不成立**:
 * 一个巡演有很多场,每场标题相同但日期场馆不同。GospelHub 上 270 个演出页里
 * 只有 154 个不同标题 —— 按名字去重会静默丢掉 43% 的场次,而那正是 fresh 档最值钱的数据。
 *
 * 所以 key 里加上**身份判别符**:能区分两个同名实体是否为同一事物的事实(日期、场馆)。
 * 歌手没有这些字段,行为与从前一致(取事实最丰富的那份);
 * 演出有,于是同一巡演的不同场次各自保留。
 */
function dedupe(entities: Entity[]): Entity[] {
  const byKey = new Map<string, Entity>();
  for (const r of entities) {
    if (!r.name) continue;
    const key = [r.type, r.name.toLowerCase(), identityDiscriminator(r)].join('::');
    const prev = byKey.get(key);
    if (!prev || factRichness(r) > factRichness(prev)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

function identityDiscriminator(e: Entity): string {
  const f = e.facts;
  if (!f) return '';
  // 只用身份性事实。描述、genre 这类不进 key —— 它们的差异是丰富度差异,不是身份差异。
  return [f.startDate ?? '', f.venue ?? '', f.city ?? ''].join('|').replace(/^\|+$/, '');
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
  if (f.startDate) n += 2;
  if (f.venue) n += 1;
  if (f.city) n += 1;
  if (f.performer) n += 2;
  if (f.description) n += 1;
  if (f._source?.includes('jsonld')) n += 2;
  return n;
}

/** URL slug → 人类可读名。仅在页面抽取失败时兜底。 */
/** slug 可读时才拿它当名字。UUID、纯数字、十六进制串一律返回 null。 */
function readableSlugName(url: string): string | null {
  const last = pathOf(url).split('/').filter(Boolean).pop() ?? '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)) return null;
  if (/^[0-9a-f]{16,}$/i.test(last) || /^\d+$/.test(last)) return null;
  const name = nameFromSlug(url);
  return name.length > 1 ? name : null;
}

function nameFromSlug(url: string): string {
  const segs = pathOf(url).split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  return decodeURIComponent(last)
    .replace(/[-_]+/g, ' ')
    .replace(/\.\w{2,5}$/, '')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
