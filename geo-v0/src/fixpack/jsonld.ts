import type { Entity, SiteProfile } from '../types.js';

/**
 * B1 结构化标记。
 *
 * 铁律(spec §B1):数据只允许来自库内事实,任何字段无数据即跳过,严禁模型补全编造。
 * 这里的实现方式是:所有字段都从 entity.facts 读,读不到就整个字段不出现。
 * 没有默认值,没有占位符,没有 "Unknown"。
 *
 * 生成的是**数据**,不是静态文件 —— GospelHub 那边由页面数据在渲染时生成同样的结构,
 * 保证 JSON-LD 与页面内容永远一致(见 output 里的 TSX helper)。
 */

export type JsonLd = Record<string, unknown>;

export function buildEntityJsonLd(e: Entity, site: SiteProfile): JsonLd | null {
  switch (e.type) {
    case 'artist':
      return artistJsonLd(e, site);
    case 'album':
      return albumJsonLd(e, site);
    case 'song':
    case 'track':
      return songJsonLd(e, site);
    default:
      return genericJsonLd(e, site);
  }
}

function artistJsonLd(e: Entity, site: SiteProfile): JsonLd | null {
  if (!e.name) return null;
  const f = e.facts ?? {};
  const ld: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MusicGroup',
    name: e.name,
    url: e.url,
  };
  if (e.aliases.length) ld.alternateName = e.aliases;
  if (f.genre?.length) ld.genre = f.genre;
  if (f.description) ld.description = f.description;
  if (f.sameAs?.length) ld.sameAs = f.sameAs;
  if (f.albums?.length) {
    ld.album = f.albums.map((a) => {
      const item: JsonLd = { '@type': 'MusicAlbum', name: a.name };
      if (a.url) item.url = a.url;
      if (a.year) item.datePublished = a.year;
      return item;
    });
  }
  return ld;
}

function albumJsonLd(e: Entity, site: SiteProfile): JsonLd | null {
  if (!e.name) return null;
  const f = e.facts ?? {};
  const ld: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MusicAlbum',
    name: e.name,
    url: e.url,
  };
  if (f.artist) ld.byArtist = { '@type': 'MusicGroup', name: f.artist };
  if (f.datePublished) ld.datePublished = f.datePublished;
  if (f.genre?.length) ld.genre = f.genre;
  if (f.description) ld.description = f.description;
  if (f.sameAs?.length) ld.sameAs = f.sameAs;
  if (f.tracks?.length) {
    ld.numTracks = f.tracks.length;
    ld.track = f.tracks.map((t, i) => {
      const item: JsonLd = { '@type': 'MusicRecording', name: t.name, position: i + 1 };
      if (t.url) item.url = t.url;
      return item;
    });
  }
  return ld;
}

function songJsonLd(e: Entity, site: SiteProfile): JsonLd | null {
  if (!e.name) return null;
  const f = e.facts ?? {};
  const ld: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MusicRecording',
    name: e.name,
    url: e.url,
  };
  if (f.artist) ld.byArtist = { '@type': 'MusicGroup', name: f.artist };
  if (f.albums?.[0]) {
    const a = f.albums[0];
    const alb: JsonLd = { '@type': 'MusicAlbum', name: a.name };
    if (a.url) alb.url = a.url;
    ld.inAlbum = alb;
  }
  if (f.datePublished) ld.datePublished = f.datePublished;
  if (f.description) ld.description = f.description;
  return ld;
}

function genericJsonLd(e: Entity, site: SiteProfile): JsonLd | null {
  if (!e.name) return null;
  const ld: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Thing',
    name: e.name,
    url: e.url,
  };
  if (e.facts?.description) ld.description = e.facts.description;
  return ld;
}

/** FAQPage 标记。问题来自题库原题,答案由库内事实生成;无数据不作答。 */
export function buildFaqJsonLd(qa: { q: string; a: string }[]): JsonLd | null {
  if (!qa.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qa.map((x) => ({
      '@type': 'Question',
      name: x.q,
      acceptedAnswer: { '@type': 'Answer', text: x.a },
    })),
  };
}

/** ItemList 标记 —— 聚合页的核心。引擎回答聚合题时需要引用一个现成列表。 */
export function buildItemListJsonLd(
  name: string,
  url: string,
  items: { name: string; url?: string; description?: string }[],
): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    url,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => {
      const item: JsonLd = { '@type': 'Thing', name: it.name };
      if (it.url) item.url = it.url;
      if (it.description) item.description = it.description;
      return { '@type': 'ListItem', position: i + 1, item };
    }),
  };
}
