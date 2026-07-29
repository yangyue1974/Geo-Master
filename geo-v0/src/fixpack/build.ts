import { log } from '../util/log.js';
import { writeJson, writeText, readJson, readJsonOr, paths } from '../util/fsx.js';
import { buildEntityJsonLd } from './jsonld.js';
import { buildLlmsTxt, buildLlmsFullTxt } from './llmstxt.js';
import {
  buildFaqBlocks,
  buildAggregatePages,
  buildNewReleasesPage,
  aggregatePathTemplates,
} from './assets.js';
import { globToRegExp } from '../util/url.js';
import { generateKey, keyFileName, manualStepsDoc } from './indexnow.js';
import { nextjsSnippets } from './nextjs.js';
import { env } from '../config.js';
import type { AuditReport } from './audit.js';
import type { EntitiesFile, QueriesFile, SiteProfile } from '../types.js';

/**
 * 组包(spec §B 输出约束)。
 *
 * fixpack 的输出必须是独立文件包 —— 一个目录,内含所有修复文件 + 部署说明。
 * 文件包就是未来产品的交付形态,所以这里刻意不假设目标是 Next.js:
 * public/ 下的东西任何站点都能直接用,代码集成部分单独放在 nextjs/ 目录里,是可选的。
 */

export interface FixpackOpts {
  outDir?: string;
  newReleaseDays?: number;
  /** 聚合页的最低条目数,默认 3。见 assets.ts 的 AggregateOpts。 */
  minAggregateItems?: number;
}

export async function buildFixpack(site: SiteProfile, opts: FixpackOpts = {}): Promise<string> {
  // 配置错误在任何 IO 之前就抛 —— 撞车是配置问题,不该等读完文件才发现
  assertNoPathCollision(site);

  const outDir = opts.outDir ?? paths.fixpack('output', site.id);
  const entFile = await readJson<EntitiesFile>(paths.data(site.id, 'entities.json'));
  const entities = entFile.entities;
  const qf = await readJsonOr<QueriesFile | null>(paths.data(site.id, 'queries.json'), null);
  const audit = await readJsonOr<AuditReport | null>(paths.data(site.id, 'audit.json'), null);
  const origin = new URL(site.sitemap).origin;

  log.step(`生成修复包 → ${outDir}`);

  // ---------------- B1 JSON-LD ----------------
  const jsonLdByUrl: Record<string, unknown> = {};
  let skipped = 0;
  for (const e of entities) {
    const ld = buildEntityJsonLd(e, site);
    if (ld) jsonLdByUrl[e.url] = ld;
    else skipped++;
  }
  await writeJson(`${outDir}/data/jsonld-by-url.json`, jsonLdByUrl);
  log.ok(`B1 JSON-LD: ${Object.keys(jsonLdByUrl).length} 个实体(${skipped} 个因无名称跳过)`);

  // ---------------- B2 llms.txt ----------------
  await writeText(`${outDir}/public/llms.txt`, buildLlmsTxt(site, entities));
  const full = buildLlmsFullTxt(site, entities);
  const fullKb = Buffer.byteLength(full, 'utf8') / 1024;
  if (fullKb <= 2048) {
    await writeText(`${outDir}/public/llms-full.txt`, full);
    log.ok(`B2 llms.txt + llms-full.txt (${fullKb.toFixed(0)} KB)`);
  } else {
    log.warn(`B2 llms-full.txt 体积 ${fullKb.toFixed(0)} KB,超过 2MB,跳过(spec §B2:体积允许才生成)`);
  }

  // ---------------- B3 内容资产 ----------------
  const faqBlocks = qf ? buildFaqBlocks(entities, qf.queries, site) : [];
  await writeJson(`${outDir}/data/faq-blocks.json`, faqBlocks);

  const themes = site.vertical.themes ?? [];
  const agg = buildAggregatePages(entities, site, themes, { minItems: opts.minAggregateItems });
  const aggregates = agg.pages;
  await writeJson(`${outDir}/data/aggregate-pages.json`, aggregates);

  const newReleases = buildNewReleasesPage(entities, site, { days: opts.newReleaseDays ?? 90 });
  if (newReleases) await writeJson(`${outDir}/data/new-releases.json`, newReleases);

  const totalQa = faqBlocks.reduce((n, b) => n + b.qa.length, 0);
  log.ok(
    `B3 内容资产: ${faqBlocks.length} 个实体页问答块(共 ${totalQa} 条问答)、` +
      `${aggregates.length} 个聚合页、${newReleases ? `${newReleases.items.length} 条新发行` : '新发行页无数据,跳过'}`,
  );
  if (totalQa === 0) {
    log.warn(
      'B3 一条问答都没生成 —— 库内缺少支撑 detail 档答案的事实。' +
        '这不是 bug:无数据不作答。要出问答块,得先把库内数据补上。',
    );
  }
  if (aggregates.filter((a) => a.kind === 'theme').length === 0) {
    log.warn('没有主题聚合页 —— 库里的歌没有主题标签。这是 aggregate 档最容易赢的一类页面,值得优先补数据。');
  }

  // 条目数分布直接打出来,不用另跑脚本才能看见
  const sizes = aggregates.map((a) => a.items.length).sort((a, b) => b - a);
  if (sizes.length) {
    const median = sizes[Math.floor(sizes.length / 2)]!;
    log.info(`  聚合页条目数: 最大 ${sizes[0]}, 中位 ${median}, 最小 ${sizes[sizes.length - 1]}`);
  }
  if (agg.dropped.length) {
    const byKind = new Map<string, number>();
    for (const d of agg.dropped) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    log.warn(
      `  ${agg.dropped.length} 个聚合页因条目不足被挡掉` +
        `(${[...byKind].map(([k, v]) => `${k}=${v}`).join(', ')})。` +
        `薄页面赢不了引用,还会拉低站点整体质量信号。要放行就调 --min-aggregate-items。`,
    );
  }

  // ---------------- B4 IndexNow ----------------
  const key = env('INDEXNOW_KEY') ?? generateKey();
  await writeText(`${outDir}/public/${keyFileName(key)}`, key);
  const pushUrls = [
    ...entities.map((e) => e.url),
    ...aggregates.map((a) => origin + a.path),
    ...(newReleases ? [origin + newReleases.path] : []),
  ];
  await writeJson(`${outDir}/data/indexnow-urls.json`, { key, host: new URL(site.sitemap).hostname, urls: pushUrls });
  await writeText(`${outDir}/INDEXNOW-MANUAL-STEPS.md`, manualStepsDoc(site, key));
  log.ok(`B4 IndexNow: key ${key},待推送 ${pushUrls.length} 个 URL`);
  if (!env('INDEXNOW_KEY')) {
    log.warn(`INDEXNOW_KEY 未设置,已生成新 key。把这一行加进 .env:\n    INDEXNOW_KEY=${key}`);
  }

  // ---------------- robots.txt 建议 ----------------
  await writeText(`${outDir}/public/robots.txt`, robotsTxt(site));

  // ---------------- Next.js 集成产物(GospelHub 专用,可选) ----------------
  const snippets = nextjsSnippets(site, { aggregates, newReleases, faqBlocks });
  for (const [rel, content] of Object.entries(snippets)) {
    await writeText(`${outDir}/nextjs/${rel}`, content);
  }
  log.ok(`Next.js 集成片段: ${Object.keys(snippets).length} 个文件`);

  // ---------------- 部署说明 ----------------
  await writeText(
    `${outDir}/DEPLOY.md`,
    deployDoc(site, {
      entities: entities.length,
      jsonLd: Object.keys(jsonLdByUrl).length,
      faqBlocks: faqBlocks.length,
      qa: totalQa,
      aggregates: aggregates.length,
      newReleases: newReleases?.items.length ?? 0,
      indexNowUrls: pushUrls.length,
      key,
      audit,
    }),
  );

  log.ok(`修复包完成 → ${outDir}`);
  log.info('  先读 DEPLOY.md。若 B5 还有 blocker,先修 blocker —— 在页面对抓取器可读之前,这一包里的东西都不会被看到。');
  return outDir;
}

/**
 * 聚合页路径与已有实体页命名空间的撞车检查。
 *
 * 默认的 `/releases/{year}` 在 GospelHub 上会撞 `/releases/{uuid}`(专辑详情页)。
 * 撞车不会报错,只会静默地做错两件事:新页面被现有路由吃掉,
 * 以及下一轮实体抽取把聚合页当成实体收进 entities.json。
 * 两个都不会抛异常,只会让数据慢慢变脏 —— 所以在生成之前就拦住。
 */
function assertNoPathCollision(site: SiteProfile): void {
  const tpl = aggregatePathTemplates(site);
  const matchers = site.entityPatterns.map((p) => ({ ...p, re: globToRegExp(p.pattern) }));
  const samples: { kind: string; path: string }[] = [
    { kind: 'year', path: tpl.year.replace('{year}', '2024') },
    { kind: 'theme', path: tpl.theme.replace('{theme}', 'hope') },
    { kind: 'collab', path: tpl.collab.replace('{artist}', 'example-artist') },
    { kind: 'newReleases', path: tpl.newReleases },
    { kind: 'city', path: tpl.city.replace('{city}', 'new-york') },
    { kind: 'month', path: tpl.month.replace('{month}', '2026-08') },
    { kind: 'artistTour', path: tpl.artistTour.replace('{artist}', 'example-artist') },
  ];

  const hits = samples.flatMap((s) => {
    const m = matchers.find((x) => x.re.test(s.path));
    return m ? [{ ...s, pattern: m.pattern, type: m.type }] : [];
  });

  if (hits.length) {
    throw new Error(
      `聚合页路径与已有实体页命名空间撞车:\n` +
        hits
          .map((h) => `  ${h.kind}: ${h.path}  撞上  ${h.pattern} (${h.type} 详情页)`)
          .join('\n') +
        `\n在 sites/${site.id}.json 里加 aggregatePaths 改掉冲突的模板。` +
        `\n不改的话新页面会被现有路由吃掉,而且下一轮抽取会把聚合页当成实体 —— 两者都不报错。`,
    );
  }
}

function robotsTxt(site: SiteProfile): string {
  return `# ${site.siteName} — robots.txt
# 显式放行 AI 检索抓取器。缺省行为各家不一致,显式声明最稳。

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Bingbot
Allow: /

User-agent: CCBot
Allow: /

User-agent: *
Allow: /

Sitemap: ${site.sitemap}
`;
}

function deployDoc(
  site: SiteProfile,
  s: {
    entities: number;
    jsonLd: number;
    faqBlocks: number;
    qa: number;
    aggregates: number;
    newReleases: number;
    indexNowUrls: number;
    key: string;
    audit: AuditReport | null;
  },
): string {
  const blockers = s.audit?.findings.filter((f) => f.severity === 'blocker') ?? [];
  const L: string[] = [];

  L.push(`# ${site.siteName} — GEO 修复包 · 部署说明`);
  L.push('');
  L.push(`生成于 ${new Date().toISOString().slice(0, 10)} · 目标域 \`${site.siteDomain}\``);
  L.push('');

  if (blockers.length) {
    L.push('## ⛔ 先修这些,再谈部署');
    L.push('');
    L.push('B5 体检发现了 blocker。**在它们修好之前,这一包里的所有内容都不会被抓取器看到** ——');
    L.push('页面写得再好,读不到就等于不存在。');
    L.push('');
    for (const b of blockers) {
      L.push(`- **${b.title}** — ${b.detail}`);
      if (b.fix) L.push(`  - 修复: ${b.fix}`);
    }
    L.push('');
  } else if (s.audit) {
    L.push('## ✅ B5 体检无 blocker');
    L.push('');
    L.push('站点对抓取器可读,可以直接部署本包。');
    L.push('');
  } else {
    L.push('## ⚠️ 尚未跑 B5 体检');
    L.push('');
    L.push('先跑 `npm run audit -- --site ' + site.id + '`。不要跳过这一步。');
    L.push('');
  }

  L.push('## 包内容');
  L.push('');
  L.push('```');
  L.push('public/                      直接拷进站点 public/ 目录,任何站点通用');
  L.push('  llms.txt                   站点自述 + 覆盖范围 + 顶层实体索引');
  L.push('  llms-full.txt              完整实体清单');
  L.push(`  ${s.key}.txt   IndexNow 所有权验证文件(内容即 key)`);
  L.push('  robots.txt                 显式放行各 AI 抓取器(与现有文件合并,别直接覆盖)');
  L.push('data/                        结构化数据,供代码集成使用');
  L.push(`  jsonld-by-url.json         ${s.jsonLd} 个实体的 schema.org 标记`);
  L.push(`  faq-blocks.json            ${s.faqBlocks} 个实体页问答块(共 ${s.qa} 条)`);
  L.push(`  aggregate-pages.json       ${s.aggregates} 个聚合列表页`);
  L.push(`  new-releases.json          ${s.newReleases} 条新发行`);
  L.push(`  indexnow-urls.json         ${s.indexNowUrls} 个待推送 URL`);
  L.push('nextjs/                      Next.js 集成片段(App Router),仅 GospelHub 用');
  L.push('INDEXNOW-MANUAL-STEPS.md     Bing / GSC 的人工步骤');
  L.push('```');
  L.push('');

  L.push('## 部署顺序');
  L.push('');
  L.push('顺序不能换。索引推送必须在内容上线**之后**,否则推的是旧页面。');
  L.push('');
  L.push('### 1. 落文件(B2 / B4)');
  L.push('');
  L.push('```bash');
  L.push('cp fixpack/output/' + site.id + '/public/llms.txt        <站点仓库>/public/');
  L.push('cp fixpack/output/' + site.id + '/public/llms-full.txt   <站点仓库>/public/');
  L.push(`cp fixpack/output/${site.id}/public/${s.key}.txt <站点仓库>/public/`);
  L.push('# robots.txt 与现有内容合并,不要直接覆盖');
  L.push('```');
  L.push('');

  L.push('### 2. 合代码(B1 / B3)');
  L.push('');
  L.push('见 `nextjs/` 目录。三处改动:');
  L.push('');
  L.push('1. **实体页注入 JSON-LD** — `nextjs/lib/jsonld.ts` + 页面组件里加一行 `<JsonLd data={...} />`。');
  L.push('   JSON-LD 由页面数据在**渲染时**生成,不是读静态文件 —— 这样它与页面内容永远一致。');
  L.push('2. **实体页加问答块** — `nextjs/components/FaqBlock.tsx`。');
  L.push('   必须渲染为页面**可见**组件,不是隐藏文本。隐藏文本会被判作 cloaking,得不偿失。');
  L.push('3. **新建聚合页与新发行页** — `nextjs/app/releases/[year]/page.tsx`、`nextjs/app/new-releases/page.tsx`。');
  L.push('   这两类页面是 aggregate / fresh 两档的主要武器,优先级高于问答块。');
  L.push('');
  L.push('新页面上线后,**记得把它们加进 sitemap** —— 否则等于没上线。');
  L.push('');

  L.push('### 3. 部署并验证');
  L.push('');
  L.push('```bash');
  L.push('# 部署 Vercel 之后,裸抓验证抓取器看到的内容');
  L.push(`curl -sA "PerplexityBot" https://${site.siteDomain}/new-releases | grep -c "ItemList"`);
  L.push(`npm run audit -- --site ${site.id}   # blocker 应归零`);
  L.push('```');
  L.push('');

  L.push('### 4. 推索引(B4)');
  L.push('');
  L.push('key 文件必须先上线可访问,否则提交必被拒。');
  L.push('');
  L.push('```bash');
  L.push(`curl https://${site.siteDomain}/${s.key}.txt    # 应返回 key 本身`);
  L.push(`npm run indexnow -- --site ${site.id} --submit`);
  L.push('```');
  L.push('');
  L.push('然后按 `INDEXNOW-MANUAL-STEPS.md` 做 Bing Webmaster Tools 与 Google Search Console。');
  L.push('这两步没有 API,必须人工做一次,而且是 ChatGPT / Gemini 那两列能不能动的前提。');
  L.push('');

  L.push('### 5. 记 Day 0');
  L.push('');
  L.push('以上全部完成、线上验证通过的那一天记为 **Day 0**。');
  L.push('Day 15 / Day 30 从这一天起算,不是从代码合并那天起算。');
  L.push('');
  L.push('```bash');
  L.push(`npm run probe  -- --site ${site.id} --label d15    # Day 0 + 15`);
  L.push(`npm run score  -- --site ${site.id} --run d15-<日期>`);
  L.push(`npm run diff   -- --site ${site.id} --runs baseline-<日期>,d15-<日期>`);
  L.push('```');
  L.push('');

  L.push('## 数据边界');
  L.push('');
  L.push('本包内所有事实均来自 `data/' + site.id + '/entities.json`,即站点自身的数据。');
  L.push('**没有任何字段由模型补全。** 无数据的字段直接不出现 —— 这就是为什么:');
  L.push('');
  L.push(`- ${s.jsonLd}/${s.entities} 个实体有 JSON-LD(其余缺名称)`);
  L.push(`- 只有 ${s.qa} 条问答(其余问题在库里找不到确凿答案)`);
  L.push(`- 只有 ${s.aggregates} 个聚合页(年份/主题/合作数据不足的都没生成)`);
  L.push('');
  L.push('这些缺口不是 bug,是站点数据的真实状态。');
  L.push('要补,得去补库内数据,不能靠生成器编 —— 一个编造的答案比没有答案伤害大得多。');
  L.push('');
  return L.join('\n');
}
