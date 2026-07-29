import { buildFaqJsonLd, buildItemListJsonLd, type JsonLd } from './jsonld.js';
import type { Entity, Query, SiteProfile, TemplateId } from '../types.js';
import { detailQuestionsFor } from '../questionTemplates.js';

/**
 * B3 可被引用的内容资产 —— 修复包的重心。
 *
 * 铁律与 B1 相同:答案由库内事实生成,**无数据不作答**。
 * 一条答案里出现的每一个专有名词、每一个日期,都必须能在 entity.facts 里找到出处。
 * 这里没有任何自然语言生成,只有事实的句式包装 —— 这是刻意的:
 * 一旦引入模型写答案,就无法保证"无数据不作答",而一个编造的答案比没有答案伤害大得多。
 */

export interface FaqBlock {
  entityUrl: string;
  entityName: string;
  entityType: string;
  qa: { q: string; a: string; template: string }[];
  jsonLd: JsonLd | null;
}

export interface AggregatePage {
  kind: 'year' | 'theme' | 'collab' | 'city' | 'month' | 'artist-tour';
  path: string;
  h1: string;
  intro: string;
  items: { name: string; url?: string; description?: string }[];
  jsonLd: JsonLd;
}

export interface NewReleasesPage {
  path: string;
  h1: string;
  updatedAt: string;
  windowLabel: string;
  items: { name: string; url?: string; description?: string }[];
  jsonLd: JsonLd;
}

// ---------------------------------------------------------------- detail 档

/**
 * 实体页问答块。问题采用题库原题(保证问的就是我们在测的),答案两到四句。
 * 只有能从事实完整回答的题才生成 —— 答不了就不出现这个问题。
 */
export function buildFaqBlocks(entities: Entity[], queries: Query[], site: SiteProfile): FaqBlock[] {
  const byUrl = new Map(entities.map((e) => [e.url, e]));
  const blocks = new Map<string, FaqBlock>();

  const put = (e: Entity, q: { template: TemplateId; query: string; basis?: Record<string, string> }) => {
    const answer = answerDetail(
      { template: q.template, query: q.query, basis: q.basis, entity: e.name } as Query,
      e,
      entities,
    );
    if (!answer) return; // 无数据不作答
    let block = blocks.get(e.url);
    if (!block) {
      block = { entityUrl: e.url, entityName: e.name, entityType: e.type, qa: [], jsonLd: null };
      blocks.set(e.url, block);
    }
    if (block.qa.some((x) => x.q === q.query)) return;
    block.qa.push({ q: q.query, a: answer, template: q.template });
  };

  /*
   * 先铺题库里的原题 —— 保证我们正在测的那些问题,页面上一字不差地答着。
   */
  for (const q of queries) {
    if (q.tier !== 'detail' || !q.entityUrl) continue;
    const e = byUrl.get(q.entityUrl);
    if (e) put(e, q);
  }

  /*
   * 再铺**全部**实体。
   *
   * 题库是样本,修复该覆盖总体。只给抽中的那 50 个实体加问答块,等于对着考卷答题:
   * 434 个实体页里 384 个一点没改,站点整体几乎没变好,而 Day 30 的数字却会显示"有效"。
   * 模板与题库共用同一份(questionTemplates.ts),所以措辞不会漂移。
   */
  for (const e of entities) {
    for (const dq of detailQuestionsFor(e, entities)) put(e, dq);
  }

  for (const b of blocks.values()) b.jsonLd = buildFaqJsonLd(b.qa.map(({ q, a }) => ({ q, a })));
  return [...blocks.values()];
}

function answerDetail(q: Query, e: Entity, all: Entity[]): string | null {
  const f = e.facts ?? {};
  switch (q.template) {
    case 'song-album': {
      const album = q.basis?.expectedAlbum ?? f.albums?.[0]?.name;
      const artist = q.basis?.artist ?? f.artist;
      if (!album || !artist) return null;
      const albumEntity = all.find((x) => x.type === 'album' && x.name === album);
      const year = albumEntity?.facts?.datePublished?.match(/\b(19|20)\d{2}\b/)?.[0];
      let s = `"${q.entity}" by ${artist} appears on the album ${album}.`;
      if (year) s += ` ${album} was released in ${year}.`;
      return s;
    }
    case 'release': {
      const date = q.basis?.expectedDate ?? f.datePublished;
      const artist = q.basis?.artist ?? f.artist;
      if (!date || !artist) return null;
      const pretty = prettyDate(date);
      let s = `${e.name} by ${artist} was released on ${pretty}.`;
      if (f.tracks?.length) s += ` The album contains ${f.tracks.length} tracks.`;
      if (f.genre?.length) s += ` It is categorised as ${f.genre.join(', ')}.`;
      return s;
    }
    case 'chronology': {
      const albums = (f.albums ?? all.filter((x) => x.type === 'album' && x.facts?.artist === e.name).map((x) => ({
        name: x.name,
        year: x.facts?.datePublished?.match(/\b(19|20)\d{2}\b/)?.[0],
      })))
        .filter((a) => a.name)
        .sort((a, b) => (a.year ?? '9999').localeCompare(b.year ?? '9999'));
      if (albums.length < 2) return null;
      const listed = albums.map((a) => (a.year ? `${a.name} (${a.year})` : a.name)).join(', ');
      return `${e.name}'s albums in chronological order: ${listed}.`;
    }
    case 'concert-venue': {
      const venue = q.basis?.expectedVenue ?? f.venue;
      const city = q.basis?.city ?? f.city;
      const artist = q.basis?.artist ?? f.performer;
      const date = q.basis?.date ?? f.startDate;
      if (!venue || !city || !artist || !date) return null;
      return `${artist} is playing at ${venue} in ${city} on ${date}, as part of ${e.name}.`;
    }
    case 'credits': {
      // 库里没有 credits 字段就直接不作答 —— 这一条大概率会被跳过,那是正确行为
      const credits = (f as Record<string, unknown>).credits;
      if (!credits || typeof credits !== 'string') return null;
      return `${credits}`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- aggregate 档

export const DEFAULT_AGGREGATE_PATHS = {
  year: '/releases/{year}',
  theme: '/themes/{theme}',
  collab: '/collaborations/{artist}',
  newReleases: '/new-releases',
  city: '/concerts-in/{city}',
  month: '/concerts/{month}',
  artistTour: '/tour/{artist}',
} as const;

export function aggregatePathTemplates(site: SiteProfile) {
  return { ...DEFAULT_AGGREGATE_PATHS, ...(site.aggregatePaths ?? {}) };
}

/**
 * 聚合列表页 —— 优先级最高的新建页面类型。
 * 没有任何一个维基页面能回答"某年发行了哪些 gospel 专辑",
 * 引擎回答这类问题时必须引用一个现成的列表页。这类页面就是为被引用而生的形态。
 */
export interface AggregateOpts {
  /**
   * 一个聚合页至少要有多少条目才生成。
   *
   * 默认 3。实测 GospelHub 上 79 个聚合页里有 51 个只有 2-3 条 ——
   * 一个列 2 场演出的页面既赢不了引用(对手是 Eventbrite 这个量级),
   * 又会把站点整体的质量信号往下拉:大规模薄页面是搜索引擎明确会降权的模式。
   *
   * 但门槛是个判断,不是定理 —— 对长尾查询,一个只有 2 场演出的页面可能确实是唯一的答案。
   * 所以它可配,而且被门槛挡掉的页面会明确报出来,不静默丢弃。
   */
  minItems?: number;
}

export interface AggregateResult {
  pages: AggregatePage[];
  /** 因条目太少被挡掉的页面,按类型汇总 —— 静默截断会让人误以为"全覆盖了" */
  dropped: { kind: string; path: string; items: number }[];
}

export function buildAggregatePages(
  entities: Entity[],
  site: SiteProfile,
  themes: string[],
  opts: AggregateOpts = {},
): AggregateResult {
  const origin = new URL(site.sitemap).origin;
  const noun = site.vertical.noun;
  const tpl = aggregatePathTemplates(site);
  const minItems = opts.minItems ?? 3;
  const pages: AggregatePage[] = [];

  // --- 按年份 ---
  const byYear = new Map<string, Entity[]>();
  for (const e of entities) {
    if (e.type !== 'album') continue;
    const y = e.facts?.datePublished?.match(/\b(19|20)\d{2}\b/)?.[0];
    if (!y) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(e);
  }
  for (const [year, albums] of [...byYear].sort((a, b) => b[0].localeCompare(a[0]))) {
    if (albums.length < 2) continue; // 一张专辑不构成列表页
    const path = tpl.year.replace('{year}', year);
    const items = albums
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({
        name: a.name,
        url: a.url,
        ...(a.facts?.artist ? { description: `by ${a.facts.artist}` } : {}),
      }));
    // h1 直接就是问句的答案形态 —— 引擎匹配的是这一行
    const h1 = `${cap(noun)} albums released in ${year}`;
    pages.push({
      kind: 'year',
      path,
      h1,
      intro:
        `${albums.length} ${noun} album${albums.length > 1 ? 's' : ''} released in ${year}, ` +
        `listed from the ${site.siteName} database. Each entry links to its full release page.`,
      items,
      jsonLd: buildItemListJsonLd(h1, origin + path, items),
    });
  }

  // --- 按合作关系 ---
  // 只在库里有确凿的 collaborator 数据时生成。没有就不生成 —— 不猜。
  const collabs = new Map<string, Set<string>>();
  for (const e of entities) {
    const raw = (e.facts as Record<string, unknown> | undefined)?.collaborators;
    if (!Array.isArray(raw)) continue;
    const names = raw.filter((x): x is string => typeof x === 'string');
    if (!names.length) continue;
    collabs.set(e.name, new Set(names));
  }
  for (const [artist, partners] of collabs) {
    if (partners.size < 2) continue;
    const slug = slugify(artist);
    const path = tpl.collab.replace('{artist}', slug);
    const h1 = `${cap(noun)} artists who have collaborated with ${artist}`;
    const items = [...partners].sort().map((p) => {
      const ent = entities.find((x) => x.name === p);
      return { name: p, ...(ent ? { url: ent.url } : {}) };
    });
    pages.push({
      kind: 'collab',
      path,
      h1,
      intro: `${partners.size} artists have recorded with ${artist}, according to the ${site.siteName} database.`,
      items,
      jsonLd: buildItemListJsonLd(h1, origin + path, items),
    });
  }

  // --- 按主题 ---
  // 同理:只有库里给歌打了主题标签才生成。没有标签数据就一页都不生成。
  const byTheme = new Map<string, Entity[]>();
  for (const e of entities) {
    const raw = (e.facts as Record<string, unknown> | undefined)?.themes;
    const tags = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    for (const t of tags) {
      const key = t.toLowerCase();
      if (!themes.length || themes.includes(key)) {
        if (!byTheme.has(key)) byTheme.set(key, []);
        byTheme.get(key)!.push(e);
      }
    }
  }
  for (const [theme, songs] of byTheme) {
    if (songs.length < 3) continue;
    const path = tpl.theme.replace('{theme}', slugify(theme));
    const h1 = `${cap(noun)} songs about ${theme}`;
    const items = songs.map((s) => ({
      name: s.name,
      url: s.url,
      ...(s.facts?.artist ? { description: `by ${s.facts.artist}` } : {}),
    }));
    pages.push({
      kind: 'theme',
      path,
      h1,
      intro: `${songs.length} ${noun} songs about ${theme} from the ${site.siteName} database.`,
      items,
      jsonLd: buildItemListJsonLd(h1, origin + path, items),
    });
  }

  pages.push(...buildConcertPages(entities, site, tpl, origin, noun));

  const kept = pages.filter((p) => p.items.length >= minItems);
  const dropped = pages
    .filter((p) => p.items.length < minItems)
    .map((p) => ({ kind: p.kind, path: p.path, items: p.items.length }));
  return { pages: kept, dropped };
}

/**
 * 演出聚合页。
 *
 * spec 没有预见到这类页面 —— 它假设的是 artist/album/song 音乐库。
 * 但演出同时占满三个可赢维度:地域(某城市)、时间窗口(某月)、实体关系(某歌手的巡演),
 * 而且没有任何百科页面覆盖「下个月纽约有哪些 gospel 演出」这种问题。
 *
 * 只收未来的场次。已经结束的演出不该出现在"coming up"的列表里,
 * 而列一堆过期演出会直接损害页面的可引用性。
 */
function buildConcertPages(
  entities: Entity[],
  site: SiteProfile,
  tpl: ReturnType<typeof aggregatePathTemplates>,
  origin: string,
  noun: string,
): AggregatePage[] {
  const pages: AggregatePage[] = [];
  const upcoming = entities
    .filter((e) => e.type === 'concert' && isUpcomingDate(e.facts?.startDate))
    .sort((a, b) => (a.facts!.startDate! < b.facts!.startDate! ? -1 : 1));
  if (upcoming.length === 0) return pages;

  const describe = (e: Entity) => {
    const f = e.facts!;
    return [f.performer, f.startDate, [f.venue, f.city].filter(Boolean).join(', ')]
      .filter(Boolean)
      .join(' · ');
  };

  // --- 按城市 ---
  for (const [city, list] of groupBy(upcoming, (e) => e.facts?.city)) {
    if (list.length < 2) continue;
    const path = tpl.city.replace('{city}', slugify(city));
    const h1 = `${cap(noun)} concerts in ${city}`;
    const items = list.map((e) => ({ name: e.name, url: e.url, description: describe(e) }));
    pages.push({
      kind: 'city',
      path,
      h1,
      intro:
        `${list.length} upcoming ${noun} concert${list.length > 1 ? 's' : ''} in ${city}, ` +
        `from the ${site.siteName} database. Dates, venues and performers below.`,
      items,
      jsonLd: buildItemListJsonLd(h1, origin + path, items),
    });
  }

  // --- 按月份 ---
  for (const [ym, list] of groupBy(upcoming, (e) => e.facts?.startDate?.slice(0, 7))) {
    if (list.length < 2) continue;
    const path = tpl.month.replace('{month}', ym);
    const h1 = `${cap(noun)} concerts in ${monthLabel(ym)}`;
    const items = list.map((e) => ({ name: e.name, url: e.url, description: describe(e) }));
    pages.push({
      kind: 'month',
      path,
      h1,
      intro:
        `${list.length} ${noun} concert${list.length > 1 ? 's' : ''} scheduled for ${monthLabel(ym)}, ` +
        `from the ${site.siteName} database.`,
      items,
      jsonLd: buildItemListJsonLd(h1, origin + path, items),
    });
  }

  // --- 按歌手(巡演页) ---
  for (const [artist, list] of groupBy(upcoming, (e) => e.facts?.performer)) {
    if (list.length < 2) continue;
    const path = tpl.artistTour.replace('{artist}', slugify(artist));
    const h1 = `${artist} tour dates`;
    const items = list.map((e) => ({ name: e.name, url: e.url, description: describe(e) }));
    pages.push({
      kind: 'artist-tour',
      path,
      h1,
      intro:
        `${artist} has ${list.length} upcoming ${noun} concert dates listed on ${site.siteName}, ` +
        `running from ${list[0]!.facts!.startDate} to ${list[list.length - 1]!.facts!.startDate}.`,
      items,
      jsonLd: buildItemListJsonLd(h1, origin + path, items),
    });
  }

  return pages;
}

// ---------------------------------------------------------------- fresh 档

/**
 * 新发行页。滚动更新,页面带明确更新日期。
 * 这是长期最能体现"活数据库 vs 静态百科"差异的资产 —— 维基百科天然滞后。
 */
export function buildNewReleasesPage(
  entities: Entity[],
  site: SiteProfile,
  opts: { days?: number; now?: Date } = {},
): NewReleasesPage | null {
  const days = opts.days ?? 90;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 86400_000);
  const origin = new URL(site.sitemap).origin;
  const noun = site.vertical.noun;

  const recent = entities
    .filter((e) => e.type === 'album' || e.type === 'song')
    .map((e) => ({ e, d: parseDate(e.facts?.datePublished) }))
    .filter((x): x is { e: Entity; d: Date } => x.d !== null && x.d >= cutoff && x.d <= now)
    .sort((a, b) => b.d.getTime() - a.d.getTime());

  if (recent.length === 0) return null; // 无数据不作答,页面也一样

  const items = recent.map(({ e, d }) => ({
    name: e.name,
    url: e.url,
    description: [e.facts?.artist ? `by ${e.facts.artist}` : '', `released ${d.toISOString().slice(0, 10)}`]
      .filter(Boolean)
      .join(' · '),
  }));

  const h1 = `New ${noun} releases`;
  const path = aggregatePathTemplates(site).newReleases;
  return {
    path,
    h1,
    updatedAt: now.toISOString().slice(0, 10),
    windowLabel: `last ${days} days`,
    items,
    jsonLd: buildItemListJsonLd(h1, origin + path, items),
  };
}

// ---------------------------------------------------------------- helpers

function prettyDate(d: string): string {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return d;
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s.length === 4 ? `${s}-01-01` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function groupBy(items: Entity[], keyOf: (e: Entity) => string | undefined): [string, Entity[]][] {
  const m = new Map<string, Entity[]>();
  for (const it of items) {
    const k = keyOf(it)?.trim();
    if (!k) continue; // 分组值缺失就丢弃,不归入"其他" —— "其他"页面没有可引用价值
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

function isUpcomingDate(date: string | undefined, now = new Date()): boolean {
  if (!date) return false;
  const d = new Date(date.length === 7 ? `${date}-01` : date);
  return !Number.isNaN(d.getTime()) && d >= new Date(now.toISOString().slice(0, 10));
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const idx = Number(m) - 1;
  return MONTH_NAMES[idx] ? `${MONTH_NAMES[idx]} ${y}` : ym;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
