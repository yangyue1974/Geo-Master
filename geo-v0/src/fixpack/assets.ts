import { buildFaqJsonLd, buildItemListJsonLd, type JsonLd } from './jsonld.js';
import type { Entity, Query, SiteProfile } from '../types.js';

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
  kind: 'year' | 'theme' | 'collab';
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

  for (const q of queries) {
    if (q.tier !== 'detail' || !q.entityUrl) continue;
    const e = byUrl.get(q.entityUrl);
    if (!e) continue;
    const answer = answerDetail(q, e, entities);
    if (!answer) continue; // 无数据不作答

    let block = blocks.get(e.url);
    if (!block) {
      block = { entityUrl: e.url, entityName: e.name, entityType: e.type, qa: [], jsonLd: null };
      blocks.set(e.url, block);
    }
    if (block.qa.some((x) => x.q === q.query)) continue;
    block.qa.push({ q: q.query, a: answer, template: q.template });
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

/**
 * 聚合列表页 —— 优先级最高的新建页面类型。
 * 没有任何一个维基页面能回答"某年发行了哪些 gospel 专辑",
 * 引擎回答这类问题时必须引用一个现成的列表页。这类页面就是为被引用而生的形态。
 */
export function buildAggregatePages(
  entities: Entity[],
  site: SiteProfile,
  themes: string[],
): AggregatePage[] {
  const origin = new URL(site.sitemap).origin;
  const noun = site.vertical.noun;
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
    const path = `/releases/${year}`;
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
    const path = `/collaborations/${slug}`;
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
    const path = `/themes/${slugify(theme)}`;
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
  const path = '/new-releases';
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
