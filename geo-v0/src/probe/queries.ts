import { log } from '../util/log.js';
import { writeJson, readJson, paths, exists } from '../util/fsx.js';
import { fingerprint, seededShuffle } from '../util/hash.js';
import { paraphraseBatch, suggestThemes } from './claude.js';
import type {
  Entity,
  EntitiesFile,
  QueriesFile,
  Query,
  SiteProfile,
  Tier,
  TemplateId,
  TimeSensitivity,
} from '../types.js';
import { SCHEMA_VERSION, TIERS } from '../types.js';

/**
 * 题库生成。
 *
 * 与 spec 的偏离(有意):spec 说"用 Claude API 对每个抽样实体生成查询",
 * 但那和 B1 的"严禁模型补全编造"是同一个风险 —— 模型很容易生成一首库里不存在的歌,
 * 那道题从出生就是废的,而且你在 Day 30 之前都不会发现。
 *
 * 所以:
 *   1. 题目由模板 + entities.json 里的确凿事实确定性填充(可复现,零幻觉)
 *   2. 模型只做两件受约束的事:
 *      a) 挑主题词(不含专有名词)
 *      b) 把机械句式改写得像普通乐迷说话
 *   3. 改写结果必须仍包含原实体名字符串,否则丢弃回退到模板原文
 *
 * 事实不足时少出题,绝不硬凑到 150。题量随数据丰富度浮动是正确行为。
 */

const DEFAULT_SAMPLING: Record<Tier, number> = {
  control: 20,
  detail: 50,
  aggregate: 50,
  fresh: 30,
};

const FALLBACK_THEMES = [
  'hope', 'grief', 'forgiveness', 'praise and worship',
  'gratitude', 'faith in hard times', 'redemption', 'family',
];

export interface QueryOpts {
  paraphrase?: boolean;
  llmThemes?: boolean;
  /** 覆盖各档题量 */
  sampling?: Partial<Record<Tier, number>>;
  force?: boolean;
}

export async function generateQueries(site: SiteProfile, opts: QueryOpts = {}): Promise<QueriesFile> {
  const outPath = paths.data(site.id, 'queries.json');

  // 题库一经生成即冻结 —— 基线和所有复测必须用同一份文件。
  if ((await exists(outPath)) && !opts.force) {
    const existing = await readJson<QueriesFile>(outPath);
    log.warn(
      `queries.json 已存在(fingerprint ${existing.fingerprint}, ${existing.queries.length} 题)。` +
        `题库冻结中,不重新生成。确需重建请加 --force —— 但那会作废已有基线,diff 将拒绝跨指纹比较。`,
    );
    return existing;
  }

  const entFile = await readJson<EntitiesFile>(paths.data(site.id, 'entities.json'));
  const entities = entFile.entities;
  if (!entities.length) throw new Error('entities.json 为空,先跑 extract');

  const sampling = { ...DEFAULT_SAMPLING, ...site.sampling, ...opts.sampling };
  const noun = site.vertical.noun || '';

  let themes = site.vertical.themes?.length ? site.vertical.themes : FALLBACK_THEMES;
  if (opts.llmThemes) {
    const suggested = await suggestThemes(noun, 10).catch((e) => {
      log.warn(`主题词生成失败,回退到内置列表: ${(e as Error).message}`);
      return [];
    });
    if (suggested.length) themes = suggested;
  }

  const queries: Query[] = [];
  const seed = `${site.id}:queries:v1`;

  const artists = entities.filter((e) => e.type === 'artist');
  const albums = entities.filter((e) => e.type === 'album');
  const songs = entities.filter((e) => e.type === 'song' || e.type === 'track');

  // ---- control: who-is ----
  for (const e of pick(artists.length ? artists : entities, sampling.control, seed + ':control')) {
    push(queries, {
      tier: 'control',
      template: 'who-is',
      entity: e.name,
      entityUrl: e.url,
      query: `Who is ${e.name}?`,
      timeSensitivity: 'none',
    });
  }

  // ---- detail: 四个模板,每个都要求确凿事实 ----
  const detailCandidates: Omit<Query, 'id'>[] = [];

  // song-album: 需要"这首歌属于哪张专辑"的关系。来源:song 实体的 facts.artist + 所属专辑
  for (const s of songs) {
    const artist = s.facts?.artist;
    const album = s.facts?.albums?.[0]?.name;
    if (!artist || !album) continue; // 无数据不出题
    detailCandidates.push({
      tier: 'detail',
      template: 'song-album',
      entity: s.name,
      entityUrl: s.url,
      query: `Which album is "${s.name}" by ${artist} on?`,
      timeSensitivity: 'none',
      basis: { song: s.name, artist, expectedAlbum: album },
    });
  }
  // 兜底:album 实体带 tracks 时也能出 song-album 题
  for (const a of albums) {
    const artist = a.facts?.artist;
    const tracks = a.facts?.tracks ?? [];
    if (!artist || tracks.length === 0) continue;
    const t = tracks[0]!;
    detailCandidates.push({
      tier: 'detail',
      template: 'song-album',
      entity: t.name,
      entityUrl: a.url,
      query: `Which album is "${t.name}" by ${artist} on?`,
      timeSensitivity: 'none',
      basis: { song: t.name, artist, expectedAlbum: a.name },
    });
  }

  // release: 需要 album + artist + 已知发行日期
  for (const a of albums) {
    const artist = a.facts?.artist;
    if (!artist || !a.facts?.datePublished) continue;
    detailCandidates.push({
      tier: 'detail',
      template: 'release',
      entity: a.name,
      entityUrl: a.url,
      query: `When was the album ${a.name} by ${artist} released?`,
      timeSensitivity: 'none',
      basis: { album: a.name, artist, expectedDate: a.facts.datePublished },
    });
  }

  // chronology: 需要该歌手名下 ≥2 张专辑
  for (const ar of artists) {
    const own = ar.facts?.albums ?? albums.filter((a) => a.facts?.artist === ar.name);
    if (own.length < 2) continue;
    detailCandidates.push({
      tier: 'detail',
      template: 'chronology',
      entity: ar.name,
      entityUrl: ar.url,
      query: `List ${ar.name}'s albums in chronological order.`,
      timeSensitivity: 'none',
      basis: { artist: ar.name, knownAlbums: String(own.length) },
    });
  }

  // credits: 需要具体歌名 + 歌手
  for (const s of songs) {
    const artist = s.facts?.artist;
    if (!artist) continue;
    detailCandidates.push({
      tier: 'detail',
      template: 'credits',
      entity: s.name,
      entityUrl: s.url,
      query: `Who wrote and produced "${s.name}" by ${artist}?`,
      timeSensitivity: 'none',
      basis: { song: s.name, artist },
    });
  }

  pushAll(queries, balancedPick(detailCandidates, sampling.detail, seed + ':detail'));

  // ---- aggregate: 跨实体,没有单一维基页能回答 ----
  const aggCandidates: Omit<Query, 'id'>[] = [];

  const years = collectYears(albums);
  for (const y of years) {
    aggCandidates.push({
      tier: 'aggregate',
      template: 'year-list',
      entity: null,
      query: `What ${noun} albums came out in ${y}?`.replace(/\s+/g, ' '),
      timeSensitivity: 'none',
      basis: { year: y },
    });
  }

  for (const th of themes) {
    aggCandidates.push({
      tier: 'aggregate',
      template: 'theme',
      entity: null,
      query: `${cap(noun)} songs about ${th}?`.replace(/\s+/g, ' '),
      timeSensitivity: 'none',
      basis: { theme: th },
    });
  }

  for (const ar of artists) {
    aggCandidates.push({
      tier: 'aggregate',
      template: 'collab',
      entity: ar.name,
      entityUrl: ar.url,
      query: `Which ${noun} artists have collaborated with ${ar.name}?`.replace(/\s+/g, ' '),
      timeSensitivity: 'none',
      basis: { artist: ar.name },
    });
  }

  pushAll(queries, balancedPick(aggCandidates, sampling.aggregate, seed + ':aggregate'));

  // ---- fresh: 必须拆成两类,否则 Day 30 的对比是无效的 ----
  const freshCandidates: Omit<Query, 'id'>[] = [];

  // entity-relative:实体固定,语义随时间漂移但前后仍可比
  for (const ar of artists) {
    freshCandidates.push({
      tier: 'fresh',
      template: 'latest',
      entity: ar.name,
      entityUrl: ar.url,
      query: `What is ${ar.name}'s latest single or album?`,
      timeSensitivity: 'entity-relative',
      basis: { artist: ar.name },
    });
  }

  // window:"本月新发行" —— Day 0 与 Day 30 问的不是同一件事。
  // 保留(它是 fresh 档的主战场),但打上 window 标记,报告里单独列、不并入主对比。
  const windowVariants = [
    `What are the new ${noun} releases this month?`,
    `What ${noun} albums came out recently?`,
    `Any new ${noun} music released in the last few weeks?`,
  ];
  for (const q of windowVariants) {
    freshCandidates.push({
      tier: 'fresh',
      template: 'new-releases',
      entity: null,
      query: q.replace(/\s+/g, ' '),
      timeSensitivity: 'window',
    });
  }

  pushAll(queries, balancedPick(freshCandidates, sampling.fresh, seed + ':fresh'));

  // ---- 可选:模型口语化改写(受约束) ----
  if (opts.paraphrase) {
    await applyParaphrase(queries);
  }

  // ---- 编号与冻结 ----
  queries.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  queries.forEach((q, i) => {
    q.id = `q${String(i + 1).padStart(3, '0')}`;
  });

  const counts = Object.fromEntries(
    TIERS.map((t) => [t, queries.filter((q) => q.tier === t).length]),
  ) as Record<Tier, number>;

  const file: QueriesFile = {
    schemaVersion: SCHEMA_VERSION,
    site: site.id,
    generatedAt: new Date().toISOString(),
    fingerprint: fingerprint(queries.map((q) => [q.id, q.tier, q.template, q.query])),
    counts,
    queries,
  };

  await writeJson(outPath, file);
  log.ok(`queries.json 写入 ${outPath}`);
  log.info(`  题量: ${TIERS.map((t) => `${t}=${counts[t]}`).join(', ')} (共 ${queries.length})`);
  log.info(`  指纹: ${file.fingerprint} —— 所有复测必须匹配这个值`);

  for (const t of TIERS) {
    const want = sampling[t];
    if (counts[t] < want) {
      log.warn(
        `${t} 档只出到 ${counts[t]}/${want} 题 —— 站点结构化事实不足。` +
          `这不是 bug:少出题好过出假题。想补题就先把站点数据补上(那本来就是 B1 要做的事)。`,
      );
    }
  }
  return file;
}

// ---------------------------------------------------------------- helpers

let counter = 0;
function push(into: Query[], q: Omit<Query, 'id'>): void {
  into.push({ id: `tmp${++counter}`, ...q });
}
function pushAll(into: Query[], qs: Omit<Query, 'id'>[]): void {
  for (const q of qs) push(into, q);
}

function pick<T>(arr: readonly T[], n: number, seed: string): T[] {
  return seededShuffle(arr, seed).slice(0, n);
}

/**
 * 按模板均衡抽样 —— 直接 slice 会让某个模板(比如 collab,每个歌手一题)吃掉整档配额。
 * 轮转各模板池,保证每种题型都有代表。
 */
function balancedPick(candidates: Omit<Query, 'id'>[], n: number, seed: string): Omit<Query, 'id'>[] {
  if (candidates.length <= n) return candidates;
  const pools = new Map<TemplateId, Omit<Query, 'id'>[]>();
  for (const c of candidates) {
    if (!pools.has(c.template)) pools.set(c.template, []);
    pools.get(c.template)!.push(c);
  }
  for (const [k, v] of pools) pools.set(k, seededShuffle(v, seed + ':' + k));

  const out: Omit<Query, 'id'>[] = [];
  const keys = [...pools.keys()].sort();
  let idx = 0;
  while (out.length < n) {
    let progressed = false;
    for (const k of keys) {
      const pool = pools.get(k)!;
      if (idx < pool.length) {
        out.push(pool[idx]!);
        progressed = true;
        if (out.length >= n) break;
      }
    }
    if (!progressed) break;
    idx++;
  }
  return out;
}

function collectYears(albums: Entity[]): string[] {
  const years = new Set<string>();
  for (const a of albums) {
    const d = a.facts?.datePublished;
    const m = d?.match(/\b(19|20)\d{2}\b/);
    if (m) years.add(m[0]);
    for (const al of a.facts?.albums ?? []) if (al.year) years.add(al.year);
  }
  return [...years].sort().reverse().slice(0, 12);
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * 受约束改写:改写后必须仍含原实体名(以及题里的引号内容),否则丢弃。
 * 这是防止模型悄悄换掉专有名词的唯一有效护栏。
 */
async function applyParaphrase(queries: Query[]): Promise<void> {
  log.step(`模型口语化改写 ${queries.length} 题(受约束,失败即回退模板原文)`);
  const originals = queries.map((q) => q.query);
  let rewritten: string[];
  try {
    rewritten = await paraphraseBatch(originals);
  } catch (e) {
    log.warn(`改写失败,全部保留模板原文: ${(e as Error).message}`);
    return;
  }

  let kept = 0;
  let rejected = 0;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    const cand = rewritten[i];
    if (!cand || !cand.trim()) continue;
    if (!preservesProperNouns(q, cand)) {
      rejected++;
      continue;
    }
    q.query = cand.trim();
    kept++;
  }
  log.info(`  改写采纳 ${kept},因专有名词不一致丢弃 ${rejected}`);
}

function preservesProperNouns(q: Query, candidate: string): boolean {
  const c = candidate.toLowerCase();
  if (q.entity && !c.includes(q.entity.toLowerCase())) return false;
  // 原题里引号内的内容(歌名)必须原样保留
  const quoted = q.query.match(/"([^"]+)"/g) ?? [];
  for (const qq of quoted) {
    if (!c.includes(qq.replace(/"/g, '').toLowerCase())) return false;
  }
  for (const [, v] of Object.entries(q.basis ?? {})) {
    if (/^\d{4}$/.test(v) && !c.includes(v)) return false; // 年份不能被改
  }
  return true;
}
