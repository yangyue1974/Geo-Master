import type { Entity, TemplateId } from './types.js';

/**
 * 题面模板 —— 出题(A3)与答题(B3)共用同一份。
 *
 * 分成两处写会漂移:题库问的和页面答的一旦措辞不同,
 * 页面就答不上我们正在测的那个问题,而这件事不会报任何错。
 * e2e 里有断言锁住这一点。
 */

export interface DetailQuestion {
  template: TemplateId;
  query: string;
  basis: Record<string, string>;
}

/**
 * 一个实体能出的全部 detail 题。事实不足的模板直接不出现 —— 无数据不提问。
 * `all` 用于跨实体反查(比如从 album 反查某歌手的专辑序列)。
 */
export function detailQuestionsFor(e: Entity, all: Entity[]): DetailQuestion[] {
  const out: DetailQuestion[] = [];
  const f = e.facts;
  if (!f) return out;

  if (e.type === 'song' || e.type === 'track') {
    const artist = f.artist;
    const album = f.albums?.[0]?.name;
    if (artist && album) {
      out.push({
        template: 'song-album',
        query: `Which album is "${e.name}" by ${artist} on?`,
        basis: { song: e.name, artist, expectedAlbum: album },
      });
    }
    if (artist) {
      out.push({
        template: 'credits',
        query: `Who wrote and produced "${e.name}" by ${artist}?`,
        basis: { song: e.name, artist },
      });
    }
  }

  if (e.type === 'album') {
    const artist = f.artist;
    if (artist && f.datePublished) {
      out.push({
        template: 'release',
        query: `When was the album ${e.name} by ${artist} released?`,
        basis: { album: e.name, artist, expectedDate: f.datePublished },
      });
    }
    const first = f.tracks?.[0];
    if (artist && first) {
      out.push({
        template: 'song-album',
        query: `Which album is "${first.name}" by ${artist} on?`,
        basis: { song: first.name, artist, expectedAlbum: e.name },
      });
    }
  }

  if (e.type === 'artist') {
    const own = f.albums?.length
      ? f.albums
      : all
          .filter((x) => x.type === 'album' && x.facts?.artist === e.name)
          .map((x) => ({ name: x.name, year: x.facts?.datePublished?.match(/\b(19|20)\d{2}\b/)?.[0] }));
    if (own.length >= 2) {
      out.push({
        template: 'chronology',
        query: `List ${e.name}'s albums in chronological order.`,
        basis: { artist: e.name, knownAlbums: String(own.length) },
      });
    }
  }

  if (e.type === 'concert' && f.performer && f.city && f.venue && f.startDate) {
    out.push({
      template: 'concert-venue',
      query: `Which venue is ${f.performer} playing at in ${f.city}?`,
      basis: { artist: f.performer, city: f.city, expectedVenue: f.venue, date: f.startDate },
    });
  }

  return out;
}
