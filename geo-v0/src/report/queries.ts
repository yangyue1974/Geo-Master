import { log } from '../util/log.js';
import { writeText, readJson, paths } from '../util/fsx.js';
import { esc } from './baseline.js';
import type { QueriesFile, Query, SiteProfile, TemplateId, Tier, TimeSensitivity } from '../types.js';
import { TIERS } from '../types.js';

/**
 * 把冻结的题库导出成可读文档。
 *
 * 题库是这个实验唯一不能变的东西,所以它值得一份人能读的副本:
 * 审题时要能看出哪道题是凭空造的,汇报时要能让别人复核我们到底问了什么。
 * 导出同时写 Markdown(给人读)与 CSV(进表格)。
 */

const TIER_NOTE: Record<Tier, string> = {
  control: '对照组。实体主题目(Who is X),预期输给维基百科 —— 它的真正作用是检测引擎自身的漂移:' +
    'control 档修复量为零,对手结构若在复测间大幅变化,说明引擎变了,其他档的变化就不能归因于修复。',
  detail: '结构细节题。发行日期、专辑序列、某歌手在某城市的演出场馆 —— 维基条目在这一层普遍稀疏,' +
    '结构化数据库是天然更好的来源。',
  aggregate: '跨实体聚合题。没有任何一个百科页面能回答,引擎必须引用一个现成的列表页。' +
    '这一档是修复包的主战场。',
  fresh: '时效题。未来的演出与近期发行 —— 百科天然滞后,活跃维护的数据库在这一档优势最大。',
};

const TS_NOTE: Record<TimeSensitivity, string> = {
  none: '与时间无关,前后完全可比',
  'entity-relative': '实体固定、语义随时间推进,前后仍可比',
  window: '时间窗口题 —— 不同轮次问的不是同一件事,**不并入主对比表**',
};

const TEMPLATE_NOTE: Partial<Record<TemplateId, string>> = {
  'who-is': 'Who is {artist}?',
  release: '{album} 的发行日期',
  chronology: '{artist} 的专辑按时间排序',
  'concert-venue': '{artist} 在 {city} 的演出场馆',
  'song-album': '某首歌收录在哪张专辑',
  credits: '创作 / 制作署名',
  'year-list': '某年发行了哪些专辑',
  theme: '某主题的歌曲',
  collab: '与 {artist} 合作过的歌手',
  latest: '{artist} 的最新单曲 / 专辑',
  'new-releases': '本月 / 近期新发行',
  'artist-touring': '{artist} 接下来在哪演出',
  'concerts-city': '{city} 有哪些即将到来的演出',
  'concerts-month': '{month} 有哪些演出',
};

export async function exportQueries(site: SiteProfile): Promise<{ md: string; csv: string }> {
  const qf = await readJson<QueriesFile>(paths.data(site.id, 'queries.json'));
  const L: string[] = [];

  L.push(`# ${site.siteName} — GEO 题库`);
  L.push('');
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| 目标域 | \`${site.siteDomain}\` |`);
  L.push(`| 题量 | ${qf.queries.length} |`);
  L.push(`| 指纹 | \`${qf.fingerprint}\` |`);
  L.push(`| 生成于 | ${qf.generatedAt.slice(0, 10)} |`);
  L.push('');
  L.push(
    '> **这份题库已冻结。** 基线与所有复测必须用同一份文件 —— 评分与 diff 在指纹不匹配时会拒绝运行。' +
      '改题库等于作废已有基线。',
  );
  L.push('');
  L.push(
    '> 所有题目由模板 + 库内确凿事实确定性填充,没有一个专有名词是模型生成的。' +
      '事实不足的模板不出题 —— 所以某些档位的题量低于配额,那是正确行为:少出题好过出假题。',
  );
  L.push('');

  // ---------- 构成 ----------
  L.push('## 构成');
  L.push('');
  L.push('| 档 | 题数 | 模板分布 |');
  L.push('|---|---:|---|');
  for (const tier of TIERS) {
    const rows = qf.queries.filter((q) => q.tier === tier);
    if (!rows.length) continue;
    const byTpl = new Map<string, number>();
    for (const q of rows) byTpl.set(q.template, (byTpl.get(q.template) ?? 0) + 1);
    const dist = [...byTpl].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · ');
    L.push(`| **${tier}** | ${rows.length} | ${dist} |`);
  }
  L.push('');

  const windowCount = qf.queries.filter((q) => q.timeSensitivity === 'window').length;
  if (windowCount) {
    L.push(
      `其中 **${windowCount} 道时间窗口题**("本月新发行"这类)在不同轮次问的不是同一件事 —— ` +
        '题面字符串冻结了,语义没有。它们照跑照记录,但不并入主对比表。',
    );
    L.push('');
  }

  // ---------- 逐档明细 ----------
  for (const tier of TIERS) {
    const rows = qf.queries.filter((q) => q.tier === tier);
    if (!rows.length) continue;

    L.push(`## ${tier} 档(${rows.length} 题)`);
    L.push('');
    L.push(`${TIER_NOTE[tier]}`);
    L.push('');

    const byTpl = new Map<TemplateId, Query[]>();
    for (const q of rows) {
      const bucket = byTpl.get(q.template);
      if (bucket) bucket.push(q);
      else byTpl.set(q.template, [q]);
    }

    for (const [tpl, list] of [...byTpl].sort((a, b) => b[1].length - a[1].length)) {
      L.push(`### ${tpl} — ${list.length} 题`);
      const note = TEMPLATE_NOTE[tpl];
      if (note) L.push(`<sub>${note}</sub>`);
      L.push('');
      L.push('| qid | 题目 | 时效性 | 依据(库内事实) |');
      L.push('|---|---|---|---|');
      for (const q of list) {
        const basis = q.basis
          ? Object.entries(q.basis).map(([k, v]) => `${k}=${esc(v)}`).join('; ')
          : '—';
        L.push(`| \`${q.id}\` | ${esc(q.query)} | ${q.timeSensitivity} | ${basis} |`);
      }
      L.push('');
    }
  }

  // ---------- 字段说明 ----------
  L.push('## 字段说明');
  L.push('');
  L.push('**时效性** —— spec 原文没有这一层,但 fresh 档必须拆,否则复测对比无效:');
  L.push('');
  for (const [k, v] of Object.entries(TS_NOTE)) L.push(`- \`${k}\` — ${v}`);
  L.push('');
  L.push(
    '**依据** —— 生成这道题所用的库内事实。用途是事后审计:' +
      '每个专有名词都能在 `entities.json` 里找到出处,所以不存在"问了一首不存在的歌"这种废题。',
  );
  L.push('');

  const md = L.join('\n');
  const mdPath = paths.report(`queries_${site.id}.md`);
  await writeText(mdPath, md);

  // CSV:给表格用。字段顺序固定,便于 diff 与外部工具消费。
  const csvRows = ['qid,tier,template,timeSensitivity,entity,query,basis'];
  for (const q of qf.queries) {
    const basis = q.basis ? Object.entries(q.basis).map(([k, v]) => `${k}=${v}`).join('; ') : '';
    csvRows.push(
      [q.id, q.tier, q.template, q.timeSensitivity, q.entity ?? '', q.query, basis]
        .map(csvCell)
        .join(','),
    );
  }
  const csvPath = paths.report(`queries_${site.id}.csv`);
  await writeText(csvPath, csvRows.join('\n') + '\n');

  log.ok(`题库导出:\n    ${mdPath}\n    ${csvPath}`);
  log.info(`  ${qf.queries.length} 题,指纹 ${qf.fingerprint}`);
  return { md: mdPath, csv: csvPath };
}

/** CSV 转义:含逗号、引号或换行时加引号,内部引号翻倍。 */
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
