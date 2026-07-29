import * as cheerio from 'cheerio';
import type { EntityFacts } from '../types.js';
import { normalizeUrl } from '../util/url.js';

/**
 * 从实体页 HTML 抽取名称与事实。
 *
 * 这一层是 spec 的补丁。原 spec 的 entities.json 只有 name/type/aliases,
 * 但 detail 档要问"哪首歌在哪张专辑上" —— 那个关系数据没有来源。
 *
 * 三级降级: JSON-LD > microdata > 启发式(title/h1/列表)。
 * 每条事实标注来源,题库生成器据此决定信任度。
 * 抽不到就是抽不到 —— 绝不推断,绝不补全。缺事实的后果是少出几道题,不是出假题。
 */

export interface ExtractedEntity {
  name: string | null;
  aliases: string[];
  facts: EntityFacts;
  /** 裸 HTML 里是否直接含实体内容 —— B5 体检复用这个信号 */
  hasServerRenderedName: boolean;
}

export function extractFromHtml(html: string, url: string): ExtractedEntity {
  const $ = cheerio.load(html);
  const facts: EntityFacts = {};
  const sources = new Set<'jsonld' | 'microdata' | 'heuristic'>();
  let name: string | null = null;
  const aliases: string[] = [];

  // ---- 1. JSON-LD(最可信) ----
  const blobs = collectJsonLd($);
  const node = pickEntityNode(blobs);
  if (node) {
    sources.add('jsonld');
    if (typeof node.name === 'string') name = node.name.trim();
    pushAliases(aliases, node.alternateName);
    const genre = asStringArray(node.genre);
    if (genre.length) facts.genre = genre;
    const sameAs = asStringArray(node.sameAs)
      .map((s) => normalizeUrl(s))
      .filter((s): s is string => !!s);
    if (sameAs.length) facts.sameAs = sameAs;
    if (typeof node.datePublished === 'string') facts.datePublished = node.datePublished.trim();
    if (typeof node.description === 'string') facts.description = node.description.trim().slice(0, 600);

    const byArtist = node.byArtist as Record<string, unknown> | undefined;
    if (byArtist && typeof byArtist.name === 'string') facts.artist = byArtist.name.trim();

    // ---- 事件类字段 ----
    if (typeof node.startDate === 'string') facts.startDate = node.startDate.trim();
    if (typeof node.endDate === 'string') facts.endDate = node.endDate.trim();

    // performer 可能是单个对象或数组;只取第一个,多演出者的场次在 v0 不展开
    const performer = firstObject(node.performer);
    if (performer) {
      if (typeof performer.name === 'string') facts.performer = performer.name.trim();
      const pu = typeof performer.url === 'string' ? normalizeUrl(performer.url) : null;
      if (pu) facts.performerUrl = pu;
    }

    const place = firstObject(node.location);
    if (place) {
      if (typeof place.name === 'string') facts.venue = place.name.trim();
      const addr = firstObject(place.address);
      if (addr) {
        if (typeof addr.addressLocality === 'string') facts.city = addr.addressLocality.trim();
        if (typeof addr.addressRegion === 'string') facts.region = addr.addressRegion.trim();
        if (typeof addr.addressCountry === 'string') facts.country = addr.addressCountry.trim();
      } else if (typeof place.address === 'string') {
        // 地址是一整个字符串时不拆 —— 拆是猜,猜就会把城市填错
        facts.city = undefined;
      }
    }

    const albums = asItemArray(node.album ?? node.albums);
    if (albums.length) facts.albums = albums;

    const tracks = asItemArray(
      (node.track as unknown) ??
        ((node.tracks as Record<string, unknown> | undefined)?.itemListElement as unknown) ??
        ((node.track as Record<string, unknown> | undefined)?.itemListElement as unknown),
    );
    if (tracks.length) facts.tracks = tracks.map((t) => ({ name: t.name, ...(t.url ? { url: t.url } : {}) }));
  }

  // ---- 2. microdata(次可信) ----
  if (!name) {
    const md = $('[itemscope] [itemprop="name"]').first().text().trim();
    if (md) {
      name = md;
      sources.add('microdata');
    }
  }

  // ---- 3. 启发式(最后手段) ----
  const h1 = $('h1').first().text().trim();
  const title = $('title').first().text().trim();
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
  if (!name) {
    const guess = h1 || ogTitle || stripSiteSuffix(title);
    if (guess) {
      name = guess;
      sources.add('heuristic');
    }
  }

  if (!facts.description) {
    const desc =
      $('meta[name="description"]').attr('content')?.trim() ??
      $('meta[property="og:description"]').attr('content')?.trim();
    if (desc) {
      facts.description = desc.slice(0, 600);
      sources.add('heuristic');
    }
  }

  if (sources.size) facts._source = [...sources];

  const hasServerRenderedName = !!name && (h1.length > 0 || blobs.length > 0);

  return { name: name ? clean(name) : null, aliases, facts, hasServerRenderedName };
}

// ---------------------------------------------------------------- helpers

function collectJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(txt);
    } catch {
      return; // 畸形 JSON-LD 在野外很常见,静默跳过
    }
    flatten(parsed, out);
  });
  return out;
}

function flatten(v: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(v)) {
    for (const x of v) flatten(x, out);
    return;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    out.push(o);
    if (Array.isArray(o['@graph'])) flatten(o['@graph'], out);
  }
}

/*
 * 顺序即优先级。事件类必须排在 MusicGroup 之前:
 * 演出页的 JSON-LD 是 MusicEvent,里面嵌了一个 MusicGroup 的 performer。
 * 如果 MusicGroup 排前面,拿到的会是演出者而不是演出本身。
 */
const ENTITY_TYPES = [
  'MusicEvent',
  'Event',
  'MusicGroup',
  'MusicAlbum',
  'MusicRecording',
  'Person',
  'Organization',
  'Book',
  'Product',
  'Movie',
  'Recipe',
  'Course',
  'Event',
];

function pickEntityNode(blobs: Record<string, unknown>[]): Record<string, unknown> | null {
  for (const t of ENTITY_TYPES) {
    const hit = blobs.find((b) => typeIncludes(b['@type'], t));
    if (hit) return hit;
  }
  // 没有已知实体类型时,退而求其次:任何带 name 的节点(排掉 WebSite/BreadcrumbList 这类容器)
  const generic = blobs.find(
    (b) =>
      typeof b.name === 'string' &&
      !typeIncludes(b['@type'], 'WebSite') &&
      !typeIncludes(b['@type'], 'BreadcrumbList') &&
      !typeIncludes(b['@type'], 'WebPage'),
  );
  return generic ?? null;
}

function typeIncludes(t: unknown, want: string): boolean {
  if (typeof t === 'string') return t === want || t.endsWith('/' + want);
  if (Array.isArray(t)) return t.some((x) => typeIncludes(x, want));
  return false;
}

/** JSON-LD 里同一个字段可能是对象或对象数组。只取第一个,不合并。 */
function firstObject(v: unknown): Record<string, unknown> | null {
  const x = Array.isArray(v) ? v[0] : v;
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  if (typeof v === 'string') return [v.trim()].filter(Boolean);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
  return [];
}

function asItemArray(v: unknown): { name: string; year?: string; url?: string }[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const out: { name: string; year?: string; url?: string }[] = [];
  for (const raw of arr) {
    if (typeof raw === 'string') {
      const n = raw.trim();
      if (n) out.push({ name: n });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    let o = raw as Record<string, unknown>;
    // ItemList 的 itemListElement 常包一层 ListItem
    if (o.item && typeof o.item === 'object') o = o.item as Record<string, unknown>;
    const n = typeof o.name === 'string' ? o.name.trim() : '';
    if (!n) continue;
    const item: { name: string; year?: string; url?: string } = { name: n };
    const dp = o.datePublished ?? o.dateCreated;
    if (typeof dp === 'string') {
      const y = dp.match(/\b(19|20)\d{2}\b/);
      if (y) item.year = y[0];
    }
    if (typeof o.url === 'string') {
      const u = normalizeUrl(o.url);
      if (u) item.url = u;
    }
    out.push(item);
  }
  return out;
}

function pushAliases(into: string[], v: unknown): void {
  for (const a of asStringArray(v)) if (!into.includes(a)) into.push(a);
}

function stripSiteSuffix(title: string): string {
  // "Kirk Franklin | GospelHub" → "Kirk Franklin"
  return title.split(/\s+[|·—–-]\s+/)[0]?.trim() ?? title.trim();
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}
