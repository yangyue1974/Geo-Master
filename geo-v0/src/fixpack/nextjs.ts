import type { SiteProfile } from '../types.js';
import type { AggregatePage, FaqBlock, NewReleasesPage } from './assets.js';

/**
 * GospelHub 专用的 Next.js 集成片段(App Router)。
 *
 * 注意这些是**片段**,不是自动 patch。生成能干净合入任意仓库的 patch 需要知道那个仓库的
 * 目录结构、命名约定、数据层形状 —— 那些这边都不知道。承诺自动 patch 只会产出合不进去的 diff。
 * 所以这里给的是可直接拷贝的完整文件 + 明确的接入位置说明。
 *
 * 关键设计:JSON-LD 由页面数据在渲染时生成,不读静态文件。
 * 这样 JSON-LD 与页面内容永远一致 —— 静态文件会漂移,漂移的结构化数据比没有更糟。
 */

export function nextjsSnippets(
  site: SiteProfile,
  data: { aggregates: AggregatePage[]; newReleases: NewReleasesPage | null; faqBlocks: FaqBlock[] },
): Record<string, string> {
  const noun = site.vertical.noun;
  const out: Record<string, string> = {};

  out['README.md'] = `# Next.js 集成片段

拷贝到 GospelHub 仓库对应位置,按下面的说明接线。

| 文件 | 目标位置 | 作用 |
|---|---|---|
| \`lib/jsonld.ts\` | \`lib/jsonld.ts\` | 由页面数据生成 schema.org 标记(B1) |
| \`components/JsonLd.tsx\` | \`components/JsonLd.tsx\` | 注入 \`<script type="application/ld+json">\` |
| \`components/FaqBlock.tsx\` | \`components/FaqBlock.tsx\` | 实体页可见问答块(B3 detail 档) |
| \`app/releases/[year]/page.tsx\` | 同名 | 按年份聚合列表页(B3 aggregate 档) |
| \`app/new-releases/page.tsx\` | 同名 | 新发行页(B3 fresh 档) |

## 接线

1. 在 artist / album 页组件里,用页面已有的数据调 \`buildArtistJsonLd\` / \`buildAlbumJsonLd\`,
   把结果传给 \`<JsonLd>\`。**不要从静态文件读** —— 那会与页面内容漂移。
2. 在同样的页面里放 \`<FaqBlock items={...} />\`,数据同样来自页面已有的 props。
3. 新建的两类页面记得加进 sitemap 生成逻辑。**不加进 sitemap 等于没上线。**

## 两条硬约束

- **无数据即跳过。** 所有 builder 遇到空值都会省略该字段,不填 "Unknown"、不填空字符串。
  维持这个行为 —— 一个编造的字段比缺失字段伤害大得多。
- **问答块必须可见。** 不要用 \`display:none\` / \`sr-only\` 藏起来。隐藏文本会被判作 cloaking。
`;

  out['components/JsonLd.tsx'] = `interface Props {
  data: Record<string, unknown> | null | undefined;
}

/** 无数据时什么都不渲染 —— 空的 JSON-LD 比没有 JSON-LD 更糟。 */
export function JsonLd({ data }: Props) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
`;

  out['lib/jsonld.ts'] = `/**
 * schema.org 标记生成器。
 *
 * 铁律:所有字段来自传入的数据,任何字段无数据即跳过。不填占位符,不猜。
 * 这些函数在服务端渲染时调用,保证 JSON-LD 与页面上显示的内容是同一份数据。
 */

type Json = Record<string, unknown>;

export interface AlbumRef {
  name: string;
  url?: string;
  year?: string;
}

export interface TrackRef {
  name: string;
  url?: string;
}

export interface ArtistData {
  name: string;
  url: string;
  aliases?: string[];
  genre?: string[];
  description?: string;
  sameAs?: string[];
  albums?: AlbumRef[];
}

export function buildArtistJsonLd(a: ArtistData): Json | null {
  if (!a.name) return null;
  const ld: Json = {
    '@context': 'https://schema.org',
    '@type': 'MusicGroup',
    name: a.name,
    url: a.url,
  };
  if (a.aliases?.length) ld.alternateName = a.aliases;
  if (a.genre?.length) ld.genre = a.genre;
  if (a.description) ld.description = a.description;
  if (a.sameAs?.length) ld.sameAs = a.sameAs;
  if (a.albums?.length) {
    ld.album = a.albums.map((al) => {
      const item: Json = { '@type': 'MusicAlbum', name: al.name };
      if (al.url) item.url = al.url;
      if (al.year) item.datePublished = al.year;
      return item;
    });
  }
  return ld;
}

export interface AlbumData {
  name: string;
  url: string;
  artist?: string;
  datePublished?: string;
  genre?: string[];
  description?: string;
  tracks?: TrackRef[];
}

export function buildAlbumJsonLd(a: AlbumData): Json | null {
  if (!a.name) return null;
  const ld: Json = {
    '@context': 'https://schema.org',
    '@type': 'MusicAlbum',
    name: a.name,
    url: a.url,
  };
  if (a.artist) ld.byArtist = { '@type': 'MusicGroup', name: a.artist };
  if (a.datePublished) ld.datePublished = a.datePublished;
  if (a.genre?.length) ld.genre = a.genre;
  if (a.description) ld.description = a.description;
  if (a.tracks?.length) {
    ld.numTracks = a.tracks.length;
    ld.track = a.tracks.map((t, i) => {
      const item: Json = { '@type': 'MusicRecording', name: t.name, position: i + 1 };
      if (t.url) item.url = t.url;
      return item;
    });
  }
  return ld;
}

export function buildFaqJsonLd(qa: { q: string; a: string }[]): Json | null {
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

export function buildItemListJsonLd(
  name: string,
  url: string,
  items: { name: string; url?: string; description?: string }[],
): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    url,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => {
      const item: Json = { '@type': 'Thing', name: it.name };
      if (it.url) item.url = it.url;
      if (it.description) item.description = it.description;
      return { '@type': 'ListItem', position: i + 1, item };
    }),
  };
}
`;

  out['components/FaqBlock.tsx'] = `import { JsonLd } from './JsonLd';
import { buildFaqJsonLd } from '@/lib/jsonld';

export interface FaqItem {
  q: string;
  a: string;
}

/**
 * 实体页问答块。
 *
 * 必须是页面上**可见**的内容,不能藏。隐藏文本会被判作 cloaking,
 * 而且引擎对可见内容的信任度本来就更高。
 *
 * 传进来的 items 应当已经过滤掉"库里答不了"的问题 —— 这个组件不负责编答案。
 */
export function FaqBlock({ items }: { items: FaqItem[] }) {
  if (!items?.length) return null;
  return (
    <section aria-labelledby="faq-heading" className="mt-10">
      <h2 id="faq-heading" className="text-xl font-semibold mb-4">
        Frequently asked
      </h2>
      <dl className="space-y-4">
        {items.map((item) => (
          <div key={item.q}>
            <dt className="font-medium">{item.q}</dt>
            <dd className="mt-1 text-muted-foreground">{item.a}</dd>
          </div>
        ))}
      </dl>
      <JsonLd data={buildFaqJsonLd(items)} />
    </section>
  );
}
`;

  out['app/releases/[year]/page.tsx'] = `import { notFound } from 'next/navigation';
import Link from 'next/link';
import { JsonLd } from '@/components/JsonLd';
import { buildItemListJsonLd } from '@/lib/jsonld';

/**
 * 按年份的发行列表页(B3 aggregate 档)。
 *
 * 这类页面是为被引用而生的:没有任何一个维基页面能回答
 * "${year_example(noun)}",引擎必须找一个现成的列表页来引用。
 *
 * 三个要点:
 *   1. h1 直接就是问题的答案形态 —— 引擎匹配的就是这一行
 *   2. ItemList JSON-LD —— 让列表结构可机读
 *   3. 服务端渲染 —— 客户端渲染的列表等于不存在
 */

export const revalidate = 3600;

// TODO: 换成 GospelHub 自己的数据层调用
async function getAlbumsByYear(year: string) {
  // return db.albums.findMany({ where: { releaseYear: year }, orderBy: { name: 'asc' } })
  return [] as { id: string; name: string; slug: string; artistName?: string }[];
}

export async function generateStaticParams() {
  // TODO: 返回库里所有有专辑发行的年份
  return [] as { year: string }[];
}

export async function generateMetadata({ params }: { params: Promise<{ year: string }> }) {
  const { year } = await params;
  const title = \`${cap(noun)} albums released in \${year}\`;
  return {
    title,
    description: \`A complete list of ${noun} albums released in \${year}, from the ${site.siteName} database.\`,
  };
}

export default async function Page({ params }: { params: Promise<{ year: string }> }) {
  const { year } = await params;
  if (!/^(19|20)\\d{2}$/.test(year)) notFound();

  const albums = await getAlbumsByYear(year);
  if (albums.length === 0) notFound(); // 空列表页不如不存在

  const h1 = \`${cap(noun)} albums released in \${year}\`;
  const items = albums.map((a) => ({
    name: a.name,
    url: \`${originOf(site)}/album/\${a.slug}\`,
    ...(a.artistName ? { description: \`by \${a.artistName}\` } : {}),
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold">{h1}</h1>
      <p className="mt-3 text-muted-foreground">
        {albums.length} ${noun} album{albums.length > 1 ? 's' : ''} released in {year},
        listed from the ${site.siteName} database. Each entry links to its full release page.
      </p>

      <ol className="mt-8 space-y-3">
        {albums.map((a) => (
          <li key={a.id}>
            <Link href={\`/album/\${a.slug}\`} className="font-medium hover:underline">
              {a.name}
            </Link>
            {a.artistName ? <span className="text-muted-foreground"> — by {a.artistName}</span> : null}
          </li>
        ))}
      </ol>

      <JsonLd data={buildItemListJsonLd(h1, \`${originOf(site)}/releases/\${year}\`, items)} />
    </main>
  );
}
`;

  out['app/new-releases/page.tsx'] = `import Link from 'next/link';
import { JsonLd } from '@/components/JsonLd';
import { buildItemListJsonLd } from '@/lib/jsonld';

/**
 * 新发行页(B3 fresh 档)。
 *
 * 这是长期最能体现"活数据库 vs 静态百科"差异的资产 —— 维基百科天然滞后,
 * Perplexity 类引擎明显偏好新鲜来源。
 *
 * 页面上必须有**明确的更新日期**。没有日期的"最新"页面,引擎无法判断新鲜度,
 * 也就无法把它当作时效题的答案来源。
 */

export const revalidate = 3600;

// TODO: 换成 GospelHub 自己的数据层调用
async function getRecentReleases(days = 90) {
  // const since = new Date(Date.now() - days * 86400000)
  // return db.albums.findMany({ where: { releaseDate: { gte: since } }, orderBy: { releaseDate: 'desc' } })
  return [] as { id: string; name: string; slug: string; artistName?: string; releaseDate: string }[];
}

export async function generateMetadata() {
  return {
    title: 'New ${noun} releases',
    description: 'The latest ${noun} albums and singles, updated continuously from the ${site.siteName} database.',
  };
}

export default async function Page() {
  const releases = await getRecentReleases(90);
  const updated = new Date().toISOString().slice(0, 10);
  const h1 = 'New ${noun} releases';

  const items = releases.map((r) => ({
    name: r.name,
    url: \`${originOf(site)}/album/\${r.slug}\`,
    description: [r.artistName ? \`by \${r.artistName}\` : '', \`released \${r.releaseDate.slice(0, 10)}\`]
      .filter(Boolean)
      .join(' · '),
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold">{h1}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last updated <time dateTime={updated}>{updated}</time> · showing the last 90 days
      </p>

      {releases.length === 0 ? (
        <p className="mt-8 text-muted-foreground">No releases recorded in the last 90 days.</p>
      ) : (
        <ol className="mt-8 space-y-3">
          {releases.map((r) => (
            <li key={r.id}>
              <Link href={\`/album/\${r.slug}\`} className="font-medium hover:underline">
                {r.name}
              </Link>
              {r.artistName ? <span className="text-muted-foreground"> — by {r.artistName}</span> : null}
              <span className="text-muted-foreground"> · {r.releaseDate.slice(0, 10)}</span>
            </li>
          ))}
        </ol>
      )}

      <JsonLd data={buildItemListJsonLd(h1, '${originOf(site)}/new-releases', items)} />
    </main>
  );
}
`;

  // 把生成的聚合页数据一并附上,方便对照实现是否覆盖了全部页面
  out['GENERATED-PAGES.md'] = generatedPagesDoc(site, data);

  return out;
}

function generatedPagesDoc(
  site: SiteProfile,
  data: { aggregates: AggregatePage[]; newReleases: NewReleasesPage | null; faqBlocks: FaqBlock[] },
): string {
  const L: string[] = [];
  L.push('# 本次生成的页面清单');
  L.push('');
  L.push('这些是从当前 entities.json 推出来的页面。上线后**必须加进 sitemap**。');
  L.push('');
  L.push(`## 聚合页 (${data.aggregates.length})`);
  L.push('');
  if (data.aggregates.length === 0) {
    L.push('无 —— 库内缺少年份/主题/合作数据。这是 aggregate 档最容易赢的一类页面,值得优先补数据。');
  } else {
    L.push('| 路径 | 类型 | h1 | 条目数 |');
    L.push('|---|---|---|---:|');
    for (const a of data.aggregates) L.push(`| \`${a.path}\` | ${a.kind} | ${a.h1} | ${a.items.length} |`);
  }
  L.push('');
  L.push('## 新发行页');
  L.push('');
  L.push(
    data.newReleases
      ? `\`${data.newReleases.path}\` — ${data.newReleases.items.length} 条(${data.newReleases.windowLabel})`
      : '无 —— 库内近期没有带发行日期的记录。fresh 档没有这个页面基本赢不了。',
  );
  L.push('');
  L.push(`## 实体页问答块 (${data.faqBlocks.length} 个实体)`);
  L.push('');
  const total = data.faqBlocks.reduce((n, b) => n + b.qa.length, 0);
  L.push(`共 ${total} 条问答。完整内容见 \`../data/faq-blocks.json\`。`);
  L.push('');
  if (total === 0) {
    L.push('一条都没生成 —— 库内缺少支撑 detail 档答案的事实(专辑归属、发行日期、署名)。');
    L.push('这不是 bug:无数据不作答。');
  }
  return L.join('\n');
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function originOf(site: SiteProfile): string {
  return new URL(site.sitemap).origin;
}

function year_example(noun: string): string {
  return `What ${noun} albums came out in 2024?`;
}
