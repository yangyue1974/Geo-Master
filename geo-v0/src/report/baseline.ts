import { log } from '../util/log.js';
import { writeText, readJson, paths } from '../util/fsx.js';
import { boundsFor } from './bounds.js';
import type { QueriesFile, ScoresFile, SiteProfile, Tier } from '../types.js';
import { TIERS } from '../types.js';

export async function buildBaselineReport(site: SiteProfile, runId: string): Promise<string> {
  const scores = await readJson<ScoresFile>(paths.data('scores', `${runId}.json`));
  const qf = await readJson<QueriesFile>(paths.data(site.id, 'queries.json'));
  const qById = new Map(qf.queries.map((q) => [q.id, q]));

  const engines = scores.manifest.engines.map((e) => e.id);
  const L: string[] = [];

  L.push(`# ${site.siteName} — GEO 基线报告`);
  L.push('');
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| run_id | \`${scores.runId}\` (label: ${scores.label}) |`);
  L.push(`| 目标域 | \`${site.siteDomain}\` |`);
  L.push(`| 题库指纹 | \`${scores.queriesFingerprint}\` (${qf.queries.length} 题) |`);
  L.push(`| 引擎 | ${scores.manifest.engines.map((e) => `${e.id} \`${e.model}\``).join('<br>')} |`);
  L.push(`| 每题每引擎运行次数 | ${scores.manifest.attemptsPerQuery} |`);
  L.push(`| 探测时间 | ${scores.manifest.startedAt} → ${scores.manifest.finishedAt ?? '(未完成)'} |`);
  L.push(`| 调用 | 成功 ${scores.manifest.callsOk} / 失败 ${scores.manifest.callsFailed} |`);
  L.push(`| API 成本 | ≈ $${scores.manifest.costUsd.toFixed(2)} |`);
  L.push('');

  if (scores.manifest.aborted) {
    L.push(`> ⚠️ **本轮数据不完整** —— 预算护栏中断:${scores.manifest.abortReason}`);
    L.push(`> 不要拿它与完整轮次做对比。`);
    L.push('');
  }

  // ---------- 1. 引用率矩阵 ----------
  L.push('## 1. 引用率矩阵(tier × engine)');
  L.push('');
  L.push('`cited` = 目标域出现在结构化 citations 中(计 1);`mentioned` = 正文出现站名但无链接(计 0.5)。');
  L.push('**汇报以 `cited%` 为准**,加权率仅供参考。');
  L.push('');
  L.push(`| tier | ${engines.map((e) => `${e} n`).join(' | ')} | ${engines.map((e) => `${e} cited%`).join(' | ')} |`);
  L.push(`|---|${engines.map(() => '---:').join('|')}|${engines.map(() => '---:').join('|')}|`);
  for (const tier of TIERS) {
    const cells = engines.map((e) => scores.matrix.find((c) => c.tier === tier && c.engine === e));
    if (cells.every((c) => !c)) continue;
    const ns = cells.map((c) => (c ? String(c.n) : '–'));
    const rates = cells.map((c) =>
      c ? `**${pct(c.hardCitationRate)}**${c.mentioned ? ` (+${c.mentioned}m)` : ''}` : '–',
    );
    L.push(`| ${tierLabel(tier)} | ${ns.join(' | ')} | ${rates.join(' | ')} |`);
  }
  L.push('');

  // ---------- 2. 噪声底噪 ----------
  L.push('## 2. 噪声底噪(判读门槛)');
  L.push('');
  const nf = scores.noiseFloor.medianAgreement;
  L.push(
    `同一题两次运行返回的被引域名集合,Jaccard 一致率中位数 **${pct(nf ?? 0)}**(样本 ${scores.noiseFloor.sampleSize})。`,
  );
  L.push('');
  if (nf === null) {
    L.push(`> 无法计算(单次运行)。本轮缺少噪声参照。`);
  } else if (nf < 0.6) {
    L.push(
      `> ⚠️ 一致率偏低。引擎每次检索的来源集合本身抖动很大,` +
        `**幅度小于 ${pct(1 - nf)} 的前后变化不能称为结论**,只能记为噪声内波动。`,
    );
  } else if (nf >= 0.95) {
    L.push(
      `> 一致率极高。检索来源几乎完全稳定,判读门槛很紧 —— 这对实验有利。`,
    );
    L.push('>');
    L.push(
      `> **但先排除缓存。** 如果上游对相同请求返回了缓存,两次运行测的是缓存而不是方差,` +
        `这个数字就是自欺。核对办法:比较同一题两次的 \`answerText\` 是否逐字相同 —— ` +
        `逐字相同说明是缓存,该数字作废;文字不同而来源集合相同,才说明是真稳定。`,
    );
  } else {
    L.push(`> 一致率尚可。检索结果相对稳定,小幅变化仍需谨慎,但方向性变化可读。`);
  }
  L.push('');
  L.push(
    '这个数字的用途:Day 15 / Day 30 对比时,小于它对应波动幅度的变化不构成证据。' +
      '另有一条独立门槛 —— 至少两道题发生变化才算数。单题翻转可能只是那道题的措辞恰好碰上了某个页面,' +
      '尺子越稳,这条越重要(否则一个极稳定的尺子反而会制造假阳性)。',
  );
  L.push('');

  // ---------- 3. 对手榜 ----------
  L.push('## 3. 对手榜 — 现在谁在替你回答这些问题');
  L.push('');
  L.push('| # | 域名 | 被引题数 | control | detail | aggregate | fresh |');
  L.push('|---:|---|---:|---:|---:|---:|---:|');
  scores.competitors.slice(0, 30).forEach((d, i) => {
    L.push(
      `| ${i + 1} | \`${d.domain}\` | ${d.hits} | ${d.tiers.control ?? 0} | ${d.tiers.detail ?? 0} | ` +
        `${d.tiers.aggregate ?? 0} | ${d.tiers.fresh ?? 0} |`,
    );
  });
  L.push('');

  // ---------- 4. 尺子漂移基准 ----------
  L.push('## 4. 尺子漂移基准(control 档对手结构)');
  L.push('');
  L.push(
    'control 档不只是"预期输给维基百科的对照组"。它的主要作用是**检测引擎自身的变化**:' +
      'control 档的修复量为零,所以它的对手结构在 D0 / D15 / D30 之间应当基本不变。' +
      '如果它大幅变化,说明引擎自己换了检索行为,那么 detail / aggregate 的变化就不能全部归因于 fixpack。',
  );
  L.push('');
  L.push('| # | 域名 | control 档被引题数 |');
  L.push('|---:|---|---:|');
  scores.controlCompetitors.slice(0, 12).forEach((d, i) => {
    L.push(`| ${i + 1} | \`${d.domain}\` | ${d.tiers.control ?? 0} |`);
  });
  L.push('');
  L.push('> 这张表就是复测时的比对基准。记住它现在的形状。');
  L.push('');

  // ---------- 5. 已被引用的题 ----------
  const hits = scores.perQuery.filter((p) => p.status !== 'absent');
  L.push('## 5. 已被引用 / 提及的题');
  L.push('');
  if (hits.length === 0) {
    L.push(`目标域 \`${site.siteDomain}\` 在本轮 ${scores.perQuery.length} 个(题×引擎)组合中**一次都没有出现**。`);
    L.push('');
    L.push('这是预期中的基线状态。它是分子为 0 的起点,不是失败。');
  } else {
    L.push('| qid | tier | engine | 状态 | 题目 | 被引 URL |');
    L.push('|---|---|---|---|---|---|');
    for (const h of hits) {
      const q = qById.get(h.qid);
      L.push(
        `| ${h.qid} | ${h.tier} | ${h.engine} | ${h.status} | ${esc(q?.query ?? '')} | ` +
          `${h.citedUrls.map((u) => `\`${u}\``).join('<br>') || '—'} |`,
      );
    }
  }
  L.push('');

  // ---------- 6. 每题明细 ----------
  L.push('## 6. 每题明细');
  L.push('');
  L.push('<details><summary>展开全部 ' + scores.perQuery.length + ' 行</summary>');
  L.push('');
  L.push('| qid | tier | template | engine | 状态 | 一致率 | 被引域名(前 5) |');
  L.push('|---|---|---|---|---|---:|---|');
  for (const p of scores.perQuery) {
    L.push(
      `| ${p.qid} | ${p.tier} | ${p.template} | ${p.engine} | ${p.status} | ` +
        `${p.agreement === null ? '–' : pct(p.agreement)} | ` +
        `${p.domains.slice(0, 5).map((d) => `\`${d}\``).join(', ')}${p.domains.length > 5 ? ` +${p.domains.length - 5}` : ''} |`,
    );
  }
  L.push('');
  L.push('</details>');
  L.push('');

  // ---------- 7. 诚实边界 ----------
  L.push('## 7. 诚实边界');
  L.push('');
  for (const b of boundsFor(engines)) L.push(`${b}\n`);

  const md = L.join('\n');
  const out = paths.report(`baseline_${runId}.md`);
  await writeText(out, md);
  log.ok(`基线报告写入 ${out}`);
  return out;
}

function tierLabel(t: Tier): string {
  const note: Record<Tier, string> = {
    control: 'control<br><sub>对照组 / 漂移检测</sub>',
    detail: 'detail<br><sub>结构细节</sub>',
    aggregate: 'aggregate<br><sub>跨实体聚合</sub>',
    fresh: 'fresh<br><sub>时效</sub>',
  };
  return note[t];
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
