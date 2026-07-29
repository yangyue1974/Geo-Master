import { log } from '../util/log.js';
import { writeText, readJson, paths } from '../util/fsx.js';
import { HONEST_BOUNDS } from './bounds.js';
import { pct, esc } from './baseline.js';
import type { QueriesFile, ScoresFile, SiteProfile, Tier, EngineId } from '../types.js';
import { TIERS } from '../types.js';

/**
 * 复测对比(spec §C)。
 *
 * 拒绝跨题库指纹比较 —— 题库变了就不是同一把尺子,这时候出的 diff 是有害的,
 * 因为它看起来仍然像一份正常报告。宁可拒绝生成。
 */
export async function buildDiffReport(site: SiteProfile, runIds: string[]): Promise<string> {
  if (runIds.length < 2) throw new Error('diff 至少需要两个 run_id');

  const runs: ScoresFile[] = [];
  for (const id of runIds) runs.push(await readJson<ScoresFile>(paths.data('scores', `${id}.json`)));

  const fps = new Set(runs.map((r) => r.queriesFingerprint));
  if (fps.size > 1) {
    throw new Error(
      `题库指纹不一致: ${[...fps].join(' vs ')}。这些轮次用的不是同一份题库,不可比 —— 拒绝生成 diff。`,
    );
  }

  const qf = await readJson<QueriesFile>(paths.data(site.id, 'queries.json'));
  const qById = new Map(qf.queries.map((q) => [q.id, q]));
  const base = runs[0]!;
  const last = runs[runs.length - 1]!;

  // 引擎集合取交集 —— 中途加入的引擎(如 Gemini)没有基线,不能进主对比表
  const engineSets = runs.map((r) => new Set(r.manifest.engines.map((e) => e.id)));
  const common = [...engineSets[0]!].filter((e) => engineSets.every((s) => s.has(e))) as EngineId[];
  const lateJoiners = [...new Set(runs.flatMap((r) => r.manifest.engines.map((e) => e.id)))].filter(
    (e) => !common.includes(e as EngineId),
  );

  const L: string[] = [];
  L.push(`# ${site.siteName} — GEO 复测对比报告`);
  L.push('');
  L.push(`| 轮次 | run_id | label | 时间 | 引擎 | 状态 |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const r of runs) {
    L.push(
      `| ${runs.indexOf(r) + 1} | \`${r.runId}\` | ${r.label} | ${r.manifest.startedAt.slice(0, 10)} | ` +
        `${r.manifest.engines.length} | ${r.manifest.aborted ? '⚠️ 预算中断,数据不完整' : '完整'} |`,
    );
  }
  L.push('');
  L.push(`题库指纹 \`${base.queriesFingerprint}\` —— 所有轮次一致,可比。`);
  L.push('');
  if (lateJoiners.length) {
    L.push(
      `> 引擎 ${lateJoiners.map((e) => `\`${e}\``).join(', ')} 未在全部轮次出现(中途加入),` +
        `已排除出主对比表,单独列在第 5 节。`,
    );
    L.push('');
  }

  // ---------- 判读门槛 ----------
  const floors = runs.map((r) => r.noiseFloor.medianAgreement).filter((v): v is number => v !== null);
  const worstFloor = floors.length ? Math.min(...floors) : null;
  L.push('## 0. 判读门槛');
  L.push('');
  if (worstFloor !== null) {
    L.push(
      `各轮噪声底噪(两次运行域名 Jaccard 中位数): ${runs
        .map((r) => `${r.label}=${r.noiseFloor.medianAgreement === null ? 'n/a' : pct(r.noiseFloor.medianAgreement)}`)
        .join(', ')}。`,
    );
    L.push('');
    L.push(
      `**最差一轮为 ${pct(worstFloor)},对应的噪声波动幅度约 ${pct(1 - worstFloor)}。` +
        `本报告中小于这个幅度的引用率变化,一律记为噪声内波动,不作为结论。**`,
    );
  } else {
    L.push('无法计算噪声底噪(单次运行)。本报告的所有变化量都缺少噪声参照,谨慎解读。');
  }
  L.push('');

  // ---------- 1. 引用率矩阵前后对照 ----------
  L.push('## 1. 引用率矩阵前后对照(cited%)');
  L.push('');
  for (const engine of common) {
    L.push(`### ${engine}`);
    L.push('');
    L.push(`| tier | ${runs.map((r) => r.label).join(' | ')} | Δ(末−首) | 判读 |`);
    L.push(`|---|${runs.map(() => '---:').join('|')}|---:|---|`);
    for (const tier of TIERS) {
      const cells = runs.map((r) => r.matrix.find((c) => c.tier === tier && c.engine === engine));
      if (cells.every((c) => !c)) continue;
      const first = cells[0];
      const lastC = cells[cells.length - 1];
      const delta = (lastC?.hardCitationRate ?? 0) - (first?.hardCitationRate ?? 0);
      const n = lastC?.n ?? first?.n ?? 0;
      L.push(
        `| ${tier} | ${cells.map((c) => (c ? `${pct(c.hardCitationRate)} (${c.cited}/${c.n})` : '–')).join(' | ')} | ` +
          `${delta >= 0 ? '+' : ''}${pct(delta)} | ${verdict(tier, delta, worstFloor, n)} |`,
      );
    }
    L.push('');
  }

  // ---------- 2. 新增被引题目清单 ----------
  L.push('## 2. 新增被引题目');
  L.push('');
  const baseKey = new Set(base.perQuery.filter((p) => p.status === 'cited').map((p) => `${p.qid}|${p.engine}`));
  const gained = last.perQuery.filter(
    (p) => p.status === 'cited' && !baseKey.has(`${p.qid}|${p.engine}`),
  );
  const lost = base.perQuery.filter(
    (p) =>
      p.status === 'cited' &&
      !last.perQuery.some((q) => q.qid === p.qid && q.engine === p.engine && q.status === 'cited'),
  );

  if (gained.length === 0) {
    L.push(`从 \`${base.label}\` 到 \`${last.label}\`,没有新增被引题目。`);
  } else {
    L.push(`从 \`${base.label}\` 到 \`${last.label}\`,新增 **${gained.length}** 个(题×引擎)被引组合:`);
    L.push('');
    L.push('| qid | tier | template | engine | 题目 | 被引 URL |');
    L.push('|---|---|---|---|---|---|');
    for (const g of gained) {
      const q = qById.get(g.qid);
      L.push(
        `| ${g.qid} | ${g.tier} | ${g.template} | ${g.engine} | ${esc(q?.query ?? '')} | ` +
          `${g.citedUrls.map((u) => `\`${u}\``).join('<br>')} |`,
      );
    }
  }
  L.push('');
  if (lost.length) {
    L.push(`同期**丢失** ${lost.length} 个原本被引的组合: ${lost.map((l) => `${l.qid}/${l.engine}`).join(', ')}`);
    L.push('');
  }

  // ---------- 3. 对手榜变化 ----------
  L.push('## 3. 对手榜变化');
  L.push('');
  const allDomains = new Set([...base.competitors.map((d) => d.domain), ...last.competitors.map((d) => d.domain)]);
  const rows = [...allDomains]
    .map((d) => {
      const b = base.competitors.find((x) => x.domain === d)?.hits ?? 0;
      const l = last.competitors.find((x) => x.domain === d)?.hits ?? 0;
      return { domain: d, b, l, delta: l - b };
    })
    .sort((a, b) => Math.max(b.b, b.l) - Math.max(a.b, a.l))
    .slice(0, 25);
  L.push(`| 域名 | ${base.label} | ${last.label} | Δ |`);
  L.push('|---|---:|---:|---:|');
  for (const r of rows) {
    L.push(`| \`${r.domain}\` | ${r.b} | ${r.l} | ${r.delta >= 0 ? '+' : ''}${r.delta} |`);
  }
  L.push('');

  // ---------- 4. 尺子漂移检查 ----------
  L.push('## 4. 尺子漂移检查(control 档)');
  L.push('');
  L.push(
    'control 档没有做任何修复。它的对手结构如果发生显著变化,说明**引擎自身**变了,' +
      '此时 detail / aggregate 的变化不能全部归因于 fixpack。',
  );
  L.push('');
  const drift = controlDrift(base, last);
  L.push(`| 域名 | ${base.label} | ${last.label} | Δ |`);
  L.push('|---|---:|---:|---:|');
  for (const r of drift.rows.slice(0, 12)) {
    L.push(`| \`${r.domain}\` | ${r.b} | ${r.l} | ${r.delta >= 0 ? '+' : ''}${r.delta} |`);
  }
  L.push('');
  L.push(`control 档对手榜 Jaccard 相似度: **${pct(drift.jaccard)}**`);
  L.push('');
  if (drift.jaccard < 0.6) {
    L.push(
      `> ⚠️ **尺子漂移显著。** control 档在零修复的情况下对手结构变化了 ${pct(1 - drift.jaccard)}。` +
        `引擎的检索行为在实验期内发生了变化,本轮 detail / aggregate 的任何变化都**不能归因于 fixpack**,` +
        `只能作为观察记录。`,
    );
  } else {
    L.push(`> 尺子基本稳定。control 档对手结构未见显著变化,可比性成立。`);
  }
  L.push('');

  // ---------- 5. 排除项 ----------
  L.push('## 5. 排除在主对比之外的部分');
  L.push('');
  const windowQ = qf.queries.filter((q) => q.timeSensitivity === 'window');
  L.push(
    `### 5.1 时间窗口题(${windowQ.length} 题)\n\n` +
      `"本月新发行"这类题目在不同轮次问的**不是同一件事** —— 题面字符串冻结了,语义没有。` +
      `它们仍然跑、仍然记录,但不并入主对比表。以下是它们各轮的表现,只作观察:`,
  );
  L.push('');
  L.push(`| qid | 题目 | ${runs.map((r) => r.label).join(' | ')} |`);
  L.push(`|---|---|${runs.map(() => '---').join('|')}|`);
  for (const q of windowQ) {
    const statuses = runs.map((r) => {
      const hits = r.perQuery.filter((p) => p.qid === q.id);
      return hits.length ? hits.map((h) => `${h.engine.slice(0, 4)}:${h.status}`).join('<br>') : '–';
    });
    L.push(`| ${q.id} | ${esc(q.query)} | ${statuses.join(' | ')} |`);
  }
  L.push('');
  if (lateJoiners.length) {
    L.push(`### 5.2 中途加入的引擎\n`);
    L.push(`${lateJoiners.map((e) => `\`${e}\``).join(', ')} 没有基线数据,只能看它自己的绝对值,不能算 Δ。`);
    L.push('');
  }

  // ---------- 6. 诚实边界 ----------
  L.push('## 6. 诚实边界');
  L.push('');
  for (const b of HONEST_BOUNDS) L.push(`${b}\n`);

  const md = L.join('\n');
  const out = paths.report('diff_report.md');
  await writeText(out, md);
  log.ok(`对比报告写入 ${out}`);
  return out;
}

/**
 * 判读门槛。
 *
 * 两个约束取严的那个:
 *
 *  1. **噪声门槛** —— 由两次运行的一致率推出。引擎检索结果本身抖多大,
 *     小于这个幅度的变化就读不出来。
 *  2. **样本量门槛** —— 至少要两道题发生变化才算数。
 *     基线实测一致率高达 100%,噪声门槛会算成 1%,而 38 题的档位里一道题就是 2.6% ——
 *     单题翻转会被标成「超出噪声」。单题不是证据:它可能只是那道题的措辞恰好碰上了某个页面。
 *     没有这一条,一个极稳定的尺子反而会制造假阳性。
 */
function verdict(tier: Tier, delta: number, floor: number | null, n: number): string {
  if (tier === 'control') return '对照组,预期不动';
  const noiseThreshold = floor === null ? 0.05 : Math.max(0.02, 1 - floor) * 0.5;
  const sampleThreshold = n > 0 ? 2 / n : 0.05;
  const threshold = Math.max(noiseThreshold, sampleThreshold);
  if (delta > threshold) return `✅ 超出门槛(>${pct(threshold)}),可读为上升`;
  if (delta < -threshold) return `🔻 超出门槛(>${pct(threshold)}),下降`;
  if (delta === 0) return '无变化';
  return `门槛内波动(≤${pct(threshold)}),不构成结论`;
}

function controlDrift(a: ScoresFile, b: ScoresFile) {
  const A = new Set(a.controlCompetitors.slice(0, 15).map((d) => d.domain));
  const B = new Set(b.controlCompetitors.slice(0, 15).map((d) => d.domain));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const domains = new Set([...A, ...B]);
  const rows = [...domains]
    .map((d) => {
      const bb = a.controlCompetitors.find((x) => x.domain === d)?.hits ?? 0;
      const ll = b.controlCompetitors.find((x) => x.domain === d)?.hits ?? 0;
      return { domain: d, b: bb, l: ll, delta: ll - bb };
    })
    .sort((x, y) => Math.max(y.b, y.l) - Math.max(x.b, x.l));
  return { jaccard: union === 0 ? 1 : inter / union, rows };
}
