import { log } from '../util/log.js';
import { writeJson, readJson, readJsonOr, paths, listDir } from '../util/fsx.js';
import { isTargetDomain } from '../util/url.js';
import { callPath } from './run.js';
import type {
  CiteStatus,
  DomainStat,
  EngineCall,
  EngineId,
  QueriesFile,
  QueryEngineScore,
  RunManifest,
  ScoresFile,
  SiteProfile,
  Tier,
  TierEngineCell,
} from '../types.js';
import { SCHEMA_VERSION, TIERS } from '../types.js';

/**
 * 评分(spec §A5)+ 一个 spec 没有但必须有的指标。
 *
 * spec 的三档:cited=1 / mentioned=0.5 / absent=0。
 *
 * 补充的是 agreement:同一题两次运行被引域名集合的 Jaccard。
 * spec 说"跑 2 次取并集降噪",但丢掉了这两次之间最有价值的信息 ——
 * 它们的分歧程度就是噪声底噪的直接测量。
 * 如果同一题两次跑出的域名只有 0.4 重合,那么任何小于这个幅度的前后变化都不能称为结论。
 * 这把"变化量才是结论依据"从一句修辞变成了一个可计算的门槛。
 */

export async function scoreRun(site: SiteProfile, runId: string): Promise<ScoresFile> {
  const qf = await readJson<QueriesFile>(paths.data(site.id, 'queries.json'));
  const manifest = await readJson<RunManifest>(paths.data('raw', runId, 'manifest.json'));

  if (manifest.queriesFingerprint !== qf.fingerprint) {
    throw new Error(
      `题库指纹不匹配:run=${manifest.queriesFingerprint} vs 当前 queries.json=${qf.fingerprint}。` +
        `题库被改过,这一轮与基线不可比。`,
    );
  }

  const engineIds = manifest.engines.map((e) => e.id);
  const perQuery: QueryEngineScore[] = [];
  const domainAgg = new Map<string, DomainStat>();
  const controlAgg = new Map<string, DomainStat>();
  const viaCounts: Record<string, number> = {};
  const nameRe = buildNameRegex(site.nameVariants);

  for (const q of qf.queries) {
    for (const engine of engineIds) {
      const calls: EngineCall[] = [];
      for (let a = 1; a <= manifest.attemptsPerQuery; a++) {
        const c = await readJsonOr<EngineCall | null>(callPath(runId, engine, q.id, a), null);
        if (c) calls.push(c);
      }
      if (calls.length === 0) continue;

      const okCalls = calls.filter((c) => c.ok);
      const failed = calls.length - okCalls.length;

      // 被引域名并集
      const domainSets = okCalls.map((c) => new Set(c.citations.map((x) => x.domain)));
      const union = new Set<string>();
      for (const s of domainSets) for (const d of s) union.add(d);

      // 目标站被引的具体 URL
      const citedUrls = [
        ...new Set(
          okCalls.flatMap((c) =>
            c.citations.filter((x) => isTargetDomain(x.domain, site.siteDomain)).map((x) => x.url),
          ),
        ),
      ];

      for (const c of okCalls) for (const x of c.citations) viaCounts[x.via] = (viaCounts[x.via] ?? 0) + 1;

      let status: CiteStatus;
      let score: 1 | 0.5 | 0;
      if (citedUrls.length > 0) {
        status = 'cited';
        score = 1;
      } else if (okCalls.some((c) => nameRe.test(c.answerText))) {
        status = 'mentioned';
        score = 0.5;
      } else {
        status = 'absent';
        score = 0;
      }

      perQuery.push({
        qid: q.id,
        tier: q.tier,
        template: q.template,
        engine: engine as EngineId,
        status,
        score,
        citedUrls,
        domains: [...union].sort(),
        agreement: jaccardOfPair(domainSets),
        attempts: calls.length,
        failed,
      });

      // 对手榜:每题每域名只计一次,避免两次运行重复计数
      for (const d of union) {
        if (isTargetDomain(d, site.siteDomain)) continue; // 自己不进对手榜
        bump(domainAgg, d, q.tier);
        if (q.tier === 'control') bump(controlAgg, d, q.tier);
      }
    }
  }

  const matrix = buildMatrix(perQuery, engineIds as EngineId[]);
  const agreements = perQuery.map((p) => p.agreement).filter((a): a is number => a !== null);

  const scores: ScoresFile = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    label: manifest.label,
    site: site.id,
    siteDomain: site.siteDomain,
    queriesFingerprint: qf.fingerprint,
    generatedAt: new Date().toISOString(),
    manifest,
    matrix,
    competitors: sortDomains(domainAgg),
    controlCompetitors: sortDomains(controlAgg),
    noiseFloor: { medianAgreement: median(agreements), sampleSize: agreements.length },
    perQuery,
  };

  const out = paths.data('scores', `${runId}.json`);
  await writeJson(out, scores);
  log.ok(`scores 写入 ${out}`);

  const totalCited = perQuery.filter((p) => p.status === 'cited').length;
  log.info(`  被引 ${totalCited}/${perQuery.length} 个(题×引擎)组合`);
  log.info(`  噪声底噪(两次运行域名 Jaccard 中位数): ${fmtPct(scores.noiseFloor.medianAgreement)}`);
  log.info(`  citation 字段分布: ${JSON.stringify(viaCounts)}`);
  if (Object.keys(viaCounts).length === 1 && viaCounts['text']) {
    log.warn('所有引用都来自正文兜底(via=text),没有一条来自结构化字段 —— 尺子很可能坏了,先跑 verify。');
  }
  return scores;
}

// ---------------------------------------------------------------- helpers

function bump(map: Map<string, DomainStat>, domain: string, tier: Tier): void {
  let s = map.get(domain);
  if (!s) {
    s = { domain, hits: 0, queries: 0, tiers: {} };
    map.set(domain, s);
  }
  s.hits++;
  s.queries++;
  s.tiers[tier] = (s.tiers[tier] ?? 0) + 1;
}

function sortDomains(map: Map<string, DomainStat>): DomainStat[] {
  return [...map.values()].sort((a, b) => b.hits - a.hits || a.domain.localeCompare(b.domain));
}

function buildMatrix(perQuery: QueryEngineScore[], engines: EngineId[]): TierEngineCell[] {
  const cells: TierEngineCell[] = [];
  for (const tier of TIERS) {
    for (const engine of engines) {
      const rows = perQuery.filter((p) => p.tier === tier && p.engine === engine);
      if (rows.length === 0) continue;
      const cited = rows.filter((r) => r.status === 'cited').length;
      const mentioned = rows.filter((r) => r.status === 'mentioned').length;
      cells.push({
        tier,
        engine,
        n: rows.length,
        cited,
        mentioned,
        absent: rows.length - cited - mentioned,
        citationRate: (cited + mentioned * 0.5) / rows.length,
        hardCitationRate: cited / rows.length,
      });
    }
  }
  return cells;
}

/**
 * 两次运行之间的 Jaccard。
 * 只在恰好有 2 次成功运行时计算 —— 3 次以上取两两平均会掩盖极端分歧,
 * 而我们要测的正是最坏情况下的抖动。
 */
function jaccardOfPair(sets: Set<string>[]): number | null {
  if (sets.length !== 2) return null;
  const [a, b] = sets as [Set<string>, Set<string>];
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function fmtPct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

/** 站名变体 → 大小写不敏感的正则。"GospelHub" 也要匹配 "Gospel Hub"。 */
function buildNameRegex(variants: string[]): RegExp {
  const parts = variants
    .filter(Boolean)
    .map((v) => v.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
  // 站名中间可能被空格拆开:GospelHub → Gospel\s*Hub
  const extra = variants
    .filter((v) => /^[A-Za-z]+[A-Z][a-z]/.test(v))
    .map((v) => v.replace(/([a-z])([A-Z])/g, '$1\\s*$2'));
  const all = [...new Set([...parts, ...extra])];
  return new RegExp(`\\b(${all.join('|')})`, 'i');
}

export async function listRuns(): Promise<string[]> {
  const dirs = await listDir(paths.data('raw'));
  return dirs.filter((d) => !d.startsWith('.')).sort();
}
