import { createServer, type Server } from 'node:http';

/**
 * 本地 fixture 站点 —— 端到端自测用。
 *
 * 它模拟一个真实站点的全部形态:sitemap index → 子 sitemap → 实体页(带 JSON-LD)。
 * 用途有两个:
 *   1. 在没有外网的环境里验证 extract / audit / fixpack 的完整链路
 *   2. 作为回归 fixture —— 改了抽取逻辑之后,这里的输出应当保持稳定
 *
 * 刻意埋了几个真实站点常见的毛病,用来验证 audit 能不能报出来:
 *   - /artist/csr-only 是客户端渲染的空壳
 *   - 一个实体页不在 sitemap 里
 *   - robots.txt 封了 PerplexityBot
 */

const ARTISTS = [
  { slug: 'mary-hale', name: 'Mary Hale', genre: 'Contemporary Gospel' },
  { slug: 'the-cedar-choir', name: 'The Cedar Choir', genre: 'Traditional Gospel' },
  { slug: 'jonah-reeves', name: 'Jonah Reeves', genre: 'Gospel Soul' },
];

const ALBUMS = [
  { slug: 'morning-light', name: 'Morning Light', artist: 'Mary Hale', date: '2024-03-15',
    tracks: ['Rise Again', 'Morning Light', 'Carry Me Home'] },
  { slug: 'still-waters', name: 'Still Waters', artist: 'Mary Hale', date: '2021-09-02',
    tracks: ['Still Waters', 'Deep End'] },
  { slug: 'cedar-hymns', name: 'Cedar Hymns', artist: 'The Cedar Choir', date: '2024-11-20',
    tracks: ['Old Cedar', 'Hymn for the Road'] },
  { slug: 'open-road', name: 'Open Road', artist: 'Jonah Reeves', date: '2023-06-10',
    tracks: ['Open Road', 'Long Way Down', 'Homeward'] },
];

const SONGS = [
  { slug: 'rise-again', name: 'Rise Again', artist: 'Mary Hale', album: 'Morning Light', albumSlug: 'morning-light' },
  { slug: 'old-cedar', name: 'Old Cedar', artist: 'The Cedar Choir', album: 'Cedar Hymns', albumSlug: 'cedar-hymns' },
  { slug: 'homeward', name: 'Homeward', artist: 'Jonah Reeves', album: 'Open Road', albumSlug: 'open-road' },
];

/*
 * 演出场次。刻意让同一个巡演有 3 场(同名、不同日期场馆)——
 * 用来验证去重不会把它们合并成一个。这正是 GospelHub 上真实发生过的 bug:
 * 270 个演出页压成 154 个实体,丢掉 43%。
 * 日期用相对今天的偏移,保证 fixture 永远有"未来场次"而不会随时间过期。
 */
const DAY = 86400_000;
const futureDate = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const pastDate = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

const CONCERTS = [
  { slug: 'sos-ny', tour: 'Song of the Saints Tour', performer: 'Mary Hale',
    date: futureDate(20), venue: 'Beacon Theatre', city: 'New York' },
  { slug: 'sos-chi', tour: 'Song of the Saints Tour', performer: 'Mary Hale',
    date: futureDate(24), venue: 'Chicago Theatre', city: 'Chicago' },
  { slug: 'sos-atl', tour: 'Song of the Saints Tour', performer: 'Mary Hale',
    date: futureDate(28), venue: 'Fox Theatre', city: 'Atlanta' },
  { slug: 'cedar-ny', tour: 'Cedar Nights', performer: 'The Cedar Choir',
    date: futureDate(35), venue: 'Town Hall', city: 'New York' },
  // 已结束的场次 —— 不应出现在任何 "coming up" 列表里
  { slug: 'old-show', tour: 'Retired Tour', performer: 'Jonah Reeves',
    date: pastDate(60), venue: 'Old Hall', city: 'New York' },
];

export function startFixtureServer(port = 0): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(req.url ?? '/', origin);
    const send = (body: string, type = 'text/html; charset=utf-8', status = 200) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    // ---- robots.txt:刻意封了 PerplexityBot,验证 audit 能报出来 ----
    if (url.pathname === '/robots.txt') {
      return send(
        `User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n`,
        'text/plain',
      );
    }

    if (url.pathname === '/sitemap.xml') {
      return send(
        `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/sitemap-artists.xml</loc></sitemap>
  <sitemap><loc>${origin}/sitemap-albums.xml</loc></sitemap>
  <sitemap><loc>${origin}/sitemap-songs.xml</loc></sitemap>
  <sitemap><loc>${origin}/sitemap-concerts.xml</loc></sitemap>
</sitemapindex>`,
        'application/xml',
      );
    }

    if (url.pathname === '/sitemap-artists.xml') {
      // 注意:csr-only 这个歌手页刻意不放进 sitemap,验证覆盖率检查
      return send(urlset(ARTISTS.map((a) => `${origin}/artist/${a.slug}`)), 'application/xml');
    }
    if (url.pathname === '/sitemap-albums.xml') {
      return send(urlset(ALBUMS.map((a) => `${origin}/album/${a.slug}`)), 'application/xml');
    }
    if (url.pathname === '/sitemap-songs.xml') {
      return send(urlset(SONGS.map((s) => `${origin}/song/${s.slug}`)), 'application/xml');
    }
    if (url.pathname === '/sitemap-concerts.xml') {
      // 末尾三条是已失效的演出 —— 记录删了,sitemap 没同步。GospelHub 上实测有 194 条这样的 URL。
      return send(
        urlset([
          ...CONCERTS.map((c) => `${origin}/concert/${c.slug}`),
          `${origin}/concert/gone-404`,
          `${origin}/concert/gone-redirect`,
          `${origin}/concert/gone-soft`,
        ]),
        'application/xml',
      );
    }

    // 三种失效形态:硬 404 / 跳首页 / 返回 200 的全站通用页
    if (url.pathname === '/concert/gone-404') {
      return send('<!doctype html><html><head><title>Event not found</title></head><body><h1>Not found</h1></body></html>', 'text/html; charset=utf-8', 404);
    }
    if (url.pathname === '/concert/gone-redirect') {
      res.writeHead(302, { location: '/' });
      return res.end();
    }
    if (url.pathname === '/' || url.pathname === '/concert/gone-soft') {
      return send(homePage());
    }

    // 单独一份含空壳页的 sitemap —— 专门用来验证 audit 的 CSR 检测器,
    // 不混进主 sitemap,免得污染实体抽取的断言
    if (url.pathname === '/sitemap-broken.xml') {
      return send(
        urlset([`${origin}/artist/csr-only`, `${origin}/artist/${ARTISTS[0]!.slug}`]),
        'application/xml',
      );
    }

    // ---- 客户端渲染的空壳页,验证 audit 的 CSR 检测 ----
    if (url.pathname === '/artist/csr-only') {
      return send(
        `<!doctype html><html><head><title>Loading…</title></head>
<body><div id="root"></div><script>/* 内容全靠 JS 渲染 */</script></body></html>`,
      );
    }

    const artist = ARTISTS.find((a) => url.pathname === `/artist/${a.slug}`);
    if (artist) return send(artistPage(artist, origin));

    const album = ALBUMS.find((a) => url.pathname === `/album/${a.slug}`);
    if (album) return send(albumPage(album, origin));

    const song = SONGS.find((s) => url.pathname === `/song/${s.slug}`);
    if (song) return send(songPage(song, origin));

    const concert = CONCERTS.find((c) => url.pathname === `/concert/${c.slug}`);
    if (concert) return send(concertPage(concert, origin));

    send('<!doctype html><html><body><h1>Not found</h1></body></html>', 'text/html; charset=utf-8', 404);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as { port: number }).port;
      resolve({ server, origin: `http://127.0.0.1:${p}` });
    });
  });
}

function urlset(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>2025-01-01</lastmod></url>`).join('\n')}
</urlset>`;
}

function page(title: string, h1: string, body: string, jsonLd: unknown, desc: string): string {
  return `<!doctype html><html lang="en"><head>
<title>${title}</title>
<meta name="description" content="${desc}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head><body>
<h1>${h1}</h1>
${body}
<p>This page is part of a fixture site used to test the geo-v0 probe end to end. It contains enough prose to pass the server-side-rendering check, which requires a meaningful amount of visible text in the raw HTML.</p>
</body></html>`;
}

function artistPage(a: (typeof ARTISTS)[number], origin: string): string {
  const albums = ALBUMS.filter((x) => x.artist === a.name);
  return page(
    `${a.name} — Artist | Fixture Gospel`,
    a.name,
    `<p>${a.name} is a ${a.genre} artist with ${albums.length} albums in the database.</p>
<ul>${albums.map((x) => `<li><a href="${origin}/album/${x.slug}">${x.name}</a> (${x.date.slice(0, 4)})</li>`).join('')}</ul>`,
    {
      '@context': 'https://schema.org',
      '@type': 'MusicGroup',
      name: a.name,
      url: `${origin}/artist/${a.slug}`,
      genre: [a.genre],
      album: albums.map((x) => ({
        '@type': 'MusicAlbum',
        name: x.name,
        url: `${origin}/album/${x.slug}`,
        datePublished: x.date,
      })),
    },
    `${a.name} — ${a.genre} artist. ${albums.length} albums.`,
  );
}

function albumPage(a: (typeof ALBUMS)[number], origin: string): string {
  return page(
    `${a.name} by ${a.artist} — Album | Fixture Gospel`,
    a.name,
    `<p>${a.name} is an album by ${a.artist}, released ${a.date}.</p>
<ol>${a.tracks.map((t) => `<li>${t}</li>`).join('')}</ol>`,
    {
      '@context': 'https://schema.org',
      '@type': 'MusicAlbum',
      name: a.name,
      url: `${origin}/album/${a.slug}`,
      byArtist: { '@type': 'MusicGroup', name: a.artist },
      datePublished: a.date,
      track: a.tracks.map((t, i) => ({ '@type': 'MusicRecording', name: t, position: i + 1 })),
    },
    `${a.name} by ${a.artist}, released ${a.date}.`,
  );
}

function songPage(s: (typeof SONGS)[number], origin: string): string {
  return page(
    `${s.name} by ${s.artist} — Song | Fixture Gospel`,
    s.name,
    `<p>"${s.name}" is a song by ${s.artist} from the album ${s.album}.</p>`,
    {
      '@context': 'https://schema.org',
      '@type': 'MusicRecording',
      name: s.name,
      url: `${origin}/song/${s.slug}`,
      byArtist: { '@type': 'MusicGroup', name: s.artist },
      inAlbum: { '@type': 'MusicAlbum', name: s.album, url: `${origin}/album/${s.albumSlug}` },
    },
    `"${s.name}" by ${s.artist} from ${s.album}.`,
  );
}

function concertPage(c: (typeof CONCERTS)[number], origin: string): string {
  const artist = ARTISTS.find((a) => a.name === c.performer);
  return page(
    `${c.tour} — ${c.city} | Fixture Gospel`,
    c.tour,
    `<p>${c.performer} performs ${c.tour} at ${c.venue}, ${c.city} on ${c.date}.</p>`,
    {
      '@context': 'https://schema.org',
      '@type': 'MusicEvent',
      name: c.tour,
      url: `${origin}/concert/${c.slug}`,
      eventStatus: 'https://schema.org/EventScheduled',
      performer: {
        '@type': 'MusicGroup',
        name: c.performer,
        ...(artist ? { url: `${origin}/artist/${artist.slug}` } : {}),
      },
      startDate: c.date,
      location: {
        '@type': 'Place',
        name: c.venue,
        address: { '@type': 'PostalAddress', addressLocality: c.city, addressCountry: 'USA' },
      },
    },
    `${c.tour} on ${c.date} at ${c.venue}, ${c.city}.`,
  );
}

/** 全站通用页。软 404 返回的就是这种东西:200 状态,站名当标题,没有任何实体级结构化数据。 */
function homePage(): string {
  return `<!doctype html><html lang="en"><head>
<title>Fixture Gospel</title>
<meta name="description" content="A fixture database of gospel artists, releases and concerts.">
</head><body>
<h1>Fixture Gospel</h1>
<p>A fixture database of gospel artists, releases and concerts. Browse artists, new releases and upcoming concerts. This homepage carries enough visible text to look like a normal server-rendered page, which is exactly why a soft 404 that returns it is easy to mistake for a real entity page.</p>
</body></html>`;
}
