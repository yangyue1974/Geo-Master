import { rm } from 'node:fs/promises';
import { startFixtureServer } from './fixtureServer.js';
import { extractEntities } from '../probe/extract.js';
import { generateQueries } from '../probe/queries.js';
import { runAudit } from '../fixpack/audit.js';
import { buildFixpack } from '../fixpack/build.js';
import { scoreRun } from '../probe/score.js';
import { buildBaselineReport } from '../report/baseline.js';
import { buildDiffReport } from '../report/diff.js';
import { writeJson, readJson, paths } from '../util/fsx.js';
import { log } from '../util/log.js';
import { callPath } from '../probe/run.js';
import { SCHEMA_VERSION } from '../types.js';
import type { EngineCall, QueriesFile, RunManifest, SiteProfile } from '../types.js';

/**
 * 端到端自测。
 *
 * 覆盖不需要外部 API 的全部环节:
 *   extract → queries → audit → fixpack → (合成探测结果) → score → report → diff
 *
 * 探测那一段用合成的引擎响应,而不是真调 API —— 这样才能断言评分逻辑的正确性:
 * 我知道每一条合成响应里有什么,所以我知道分数应该是多少。
 * 真调 API 只能验证"能跑",验证不了"算对了"。
 *
 * 跑法: npm run e2e
 */

const SITE_ID = 'e2e-fixture';

async function main() {
  const { server, origin } = await startFixtureServer();
  const failures: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (cond) log.ok(`  ✓ ${msg}`);
    else {
      log.error(`  ✗ ${msg}`);
      failures.push(msg);
    }
  };

  try {
    log.step(`fixture 站点启动于 ${origin}`);

    // 清掉上一轮
    await rm(paths.data(SITE_ID), { recursive: true, force: true });
    await rm(paths.data('raw', 'e2e-baseline'), { recursive: true, force: true });
    await rm(paths.data('raw', 'e2e-d30'), { recursive: true, force: true });

    const site: SiteProfile = {
      id: SITE_ID,
      siteName: 'Fixture Gospel',
      siteDomain: new URL(origin).host,
      nameVariants: ['Fixture Gospel', new URL(origin).host],
      sitemap: `${origin}/sitemap.xml`,
      entityPatterns: [
        { type: 'artist', pattern: '/artist/*' },
        { type: 'album', pattern: '/album/*' },
        { type: 'song', pattern: '/song/*' },
        { type: 'concert', pattern: '/concert/*' },
      ],
      vertical: { noun: 'gospel', themes: ['hope', 'grief', 'family'] },
      sampling: { control: 3, detail: 12, aggregate: 12, fresh: 5 },
      tagline: 'A fixture database.',
    };
    await writeJson(paths.sites(`${SITE_ID}.json`), site);

    // ---------------- A1 ----------------
    log.step('A1 实体抽取');
    const ents = await extractEntities(site, { source: 'sitemap', concurrency: 4 });
    check(ents.entities.length === 15, `抽到 15 个实体(实际 ${ents.entities.length})`);

    // 关键断言:同一巡演的 3 场同名演出必须全部保留。
    // 按名字去重会把它们压成 1 个 —— 这是 GospelHub 上真实丢掉 43% 场次的那个 bug。
    const sos = ents.entities.filter((e) => e.type === 'concert' && e.name === 'Song of the Saints Tour');
    check(sos.length === 3, `同名巡演的 3 场各自保留(实际 ${sos.length})`);
    check(
      new Set(sos.map((e) => e.facts?.startDate)).size === 3,
      '3 场的日期各不相同(身份判别符生效)',
    );

    // 关键断言:MusicEvent 的字段必须抽全,否则演出实体就是只有名字的空壳
    const ny = sos.find((e) => e.facts?.city === 'New York');
    check(!!ny?.facts?.startDate, 'concert 抽到 startDate');
    check(ny?.facts?.venue === 'Beacon Theatre', `concert 抽到 venue(实际 ${ny?.facts?.venue})`);
    check(ny?.facts?.country === 'USA', 'concert 抽到 country');
    check(
      ny?.facts?.performer === 'Mary Hale',
      `concert 抽到 performer 而不是被嵌套的 MusicGroup 顶掉(实际 ${ny?.facts?.performer})`,
    );
    check(!!ny?.facts?.performerUrl, 'concert 抽到 performerUrl —— 演出与歌手之间那条边');
    const mary = ents.entities.find((e) => e.name === 'Mary Hale');
    check(!!mary, 'Mary Hale 被抽到');
    check(mary?.facts?.albums?.length === 2, `Mary Hale 有 2 张专辑(实际 ${mary?.facts?.albums?.length})`);
    check(mary?.facts?._source?.includes('jsonld') === true, '事实来源标记为 jsonld');
    const morning = ents.entities.find((e) => e.name === 'Morning Light');
    check(morning?.facts?.artist === 'Mary Hale', 'Morning Light 的 byArtist 抽对');
    check(morning?.facts?.tracks?.length === 3, `Morning Light 有 3 首歌(实际 ${morning?.facts?.tracks?.length})`);
    check(morning?.facts?.datePublished === '2024-03-15', 'Morning Light 发行日期抽对');

    // ---------------- A3 ----------------
    log.step('A3 题库生成');
    const qf = await generateQueries(site, { force: true });
    check(qf.queries.length > 0, `生成了 ${qf.queries.length} 题`);
    check(qf.counts.control === 3, `control ${qf.counts.control} 题`);
    check(qf.counts.detail > 0, `detail ${qf.counts.detail} 题`);
    check(qf.counts.aggregate > 0, `aggregate ${qf.counts.aggregate} 题`);

    // 关键断言:题目里的专有名词必须来自 entities,不能凭空出现
    const names = new Set(ents.entities.map((e) => e.name));
    const badEntity = qf.queries.filter((q) => q.entity && !names.has(q.entity) && !isTrackName(q.entity, ents.entities));
    check(badEntity.length === 0, `所有题目的实体名都来自 entities.json(违规 ${badEntity.length} 条)`);

    /*
     * 关键断言:不出结构性必输的题。
     * fixture 里既没有 collaborators 也没有主题标签,所以这两类题一道都不该出 ——
     * 出了就既答不了、也生成不出对应页面,而且会稀释整档的分母。
     */
    check(
      qf.queries.filter((q) => q.template === 'collab').length === 0,
      '库里没有 collaborators,不出合作题(无数据不提问)',
    );
    check(
      qf.queries.filter((q) => q.template === 'theme').length === 0,
      '库里没有主题标签,不出主题题(无数据不提问)',
    );
    check(
      qf.queries.some((q) => q.template === 'concert-venue'),
      'detail 档含 concert-venue,不再是单一模板独吞整档',
    );

    // 关键断言:fresh 档必须拆成两类,否则 Day 30 的对比无效
    const freshQ = qf.queries.filter((q) => q.tier === 'fresh');
    check(
      freshQ.some((q) => q.timeSensitivity === 'entity-relative') &&
        freshQ.some((q) => q.timeSensitivity === 'window'),
      'fresh 档同时含 entity-relative 与 window 两类',
    );

    // 关键断言:题库冻结
    const again = await generateQueries(site, {});
    check(again.fingerprint === qf.fingerprint, '重复调用不重新生成,指纹不变(题库冻结生效)');

    // 关键断言:确定性 —— 同样输入必须得到同样题库
    const regen = await generateQueries(site, { force: true });
    check(regen.fingerprint === qf.fingerprint, '强制重建得到相同指纹(生成是确定性的)');

    // ---------------- B5 ----------------
    log.step('B5 可读性体检');
    const audit = await runAudit(site, { sample: 10 });
    const ids = new Set(audit.findings.map((f) => f.id));
    check(ids.has('robots-block-PerplexityBot'), 'audit 报出 robots.txt 封禁 PerplexityBot');
    check(
      audit.findings.find((f) => f.id === 'robots-block-PerplexityBot')?.severity === 'blocker',
      '该项被判为 blocker',
    );
    check(ids.has('robots-no-sitemap'), 'audit 报出 robots.txt 未声明 sitemap');
    check(
      audit.findings.find((f) => f.id === 'csr-rendering')?.severity === 'ok',
      '正常 SSR 页面不被误报为 CSR(避免把人送去查不存在的渲染 bug)',
    );
    check(
      audit.findings.find((f) => f.id === 'thin-content')?.severity === 'warn',
      '内容偏薄单独报为 warn,不与 CSR 混为一谈',
    );

    // 用含空壳页的 sitemap 单独验证 CSR 检测器确实能报出来
    const brokenSite: SiteProfile = { ...site, id: `${SITE_ID}-broken`, sitemap: `${origin}/sitemap-broken.xml` };
    const brokenAudit = await runAudit(brokenSite, { sample: 10 });
    const csr = brokenAudit.findings.find((f) => f.id === 'csr-rendering');
    check(csr?.severity === 'blocker', 'CSR 空壳页被判为 blocker');
    check(
      brokenAudit.stats.pagesServerRendered === 1 && brokenAudit.stats.pagesSampled === 2,
      `2 个页面中恰好 1 个 SSR 正常(实际 ${brokenAudit.stats.pagesServerRendered}/${brokenAudit.stats.pagesSampled})`,
    );

    // ---------------- B1-B4 ----------------
    log.step('B1–B4 修复包');

    // 撞车检查:默认的 /releases/{year} 与"专辑详情页在 /releases/*"的站点冲突
    // (GospelHub 就是这种情况)。必须在生成前抛,而不是静默产出会被路由吃掉的页面。
    // 保持 id 不变,这样它读的是同一份 entities.json —— 变量只有 entityPatterns
    const collidingSite: SiteProfile = {
      ...site,
      entityPatterns: [...site.entityPatterns, { type: 'album', pattern: '/releases/*' }],
    };
    let collided = false;
    try {
      await buildFixpack(collidingSite);
    } catch (e) {
      collided = /撞车/.test((e as Error).message);
    }
    check(collided, '聚合页路径撞上实体页命名空间时,fixpack 拒绝生成');

    // 配了 aggregatePaths 之后应当放行
    const fixedSite: SiteProfile = {
      ...collidingSite,
      aggregatePaths: { year: '/gospel-albums/{year}' },
    };
    let passedAfterFix = true;
    try {
      await buildFixpack(fixedSite, { outDir: paths.fixpack('output', `${SITE_ID}-fixed`) });
    } catch {
      passedAfterFix = false;
    }
    check(passedAfterFix, '改掉 aggregatePaths 之后放行');
    const outDir = await buildFixpack(site, { newReleaseDays: 100000 }); // fixture 数据是历史日期,放宽窗口
    const jsonld = await readJson<Record<string, any>>(`${outDir}/data/jsonld-by-url.json`);
    check(Object.keys(jsonld).length === 15, `15 个实体都有 JSON-LD(实际 ${Object.keys(jsonld).length})`);

    const concertLd = jsonld[`${origin}/concert/sos-ny`];
    check(concertLd?.['@type'] === 'MusicEvent', 'concert → MusicEvent(不是降级成 Thing)');
    check(concertLd?.performer?.name === 'Mary Hale', 'concert JSON-LD 含 performer');
    check(
      concertLd?.location?.address?.addressLocality === 'New York',
      'concert JSON-LD 含 location.address.addressLocality',
    );

    const maryLd = jsonld[`${origin}/artist/mary-hale`];
    check(maryLd?.['@type'] === 'MusicGroup', 'artist → MusicGroup');
    check(Array.isArray(maryLd?.album) && maryLd.album.length === 2, 'artist JSON-LD 含 2 张专辑');
    const albumLd = jsonld[`${origin}/album/morning-light`];
    check(albumLd?.['@type'] === 'MusicAlbum', 'album → MusicAlbum');
    check(albumLd?.byArtist?.name === 'Mary Hale', 'album JSON-LD 含 byArtist');
    check(albumLd?.numTracks === 3, 'album JSON-LD 含 numTracks=3');

    // 关键断言:无数据即跳过,绝不出现占位符
    const allValues = JSON.stringify(jsonld);
    check(
      !/"(Unknown|N\/A|TBD|null|undefined|)"/.test(allValues.replace(/"@?\w+":/g, '')),
      'JSON-LD 里没有占位符/空值(无数据即跳过)',
    );

    const aggs = await readJson<any[]>(`${outDir}/data/aggregate-pages.json`);
    check(aggs.length > 0, `生成了 ${aggs.length} 个聚合页`);
    const y2024 = aggs.find((a) => a.path === '/releases/2024');
    check(!!y2024, '有 /releases/2024 页面(2024 年有 2 张专辑)');
    check(y2024?.items?.length === 2, `2024 页含 2 张专辑(实际 ${y2024?.items?.length})`);
    check(y2024?.jsonLd?.['@type'] === 'ItemList', '聚合页带 ItemList JSON-LD');
    check(
      !aggs.some((a) => a.path === '/releases/2021'),
      '2021 年只有 1 张专辑,不生成聚合页(一张不构成列表)',
    );

    // 演出聚合页 —— 三个可赢维度各一类
    const nyPage = aggs.find((a) => a.kind === 'city' && /new-york/.test(a.path));
    check(!!nyPage, '生成了按城市的演出聚合页');
    check(nyPage?.items?.length === 2, `纽约页含 2 场未来演出(实际 ${nyPage?.items?.length})`);
    check(
      !JSON.stringify(nyPage ?? {}).includes('Retired Tour'),
      '已结束的演出不出现在 coming up 列表里',
    );
    check(aggs.some((a) => a.kind === 'month'), '生成了按月份的演出聚合页');
    const tour = aggs.find((a) => a.kind === 'artist-tour');
    check(!!tour, '生成了歌手巡演页');
    check(tour?.items?.length === 3, `Mary Hale 巡演页含 3 场(实际 ${tour?.items?.length})`);

    // 演出题库
    const cq = qf.queries.filter((q) => q.template === 'concerts-city');
    const tq = qf.queries.filter((q) => q.template === 'artist-touring');
    check(cq.length > 0, `生成了 ${cq.length} 道城市演出题`);
    check(tq.length > 0, `生成了 ${tq.length} 道巡演题`);
    check(
      qf.queries.filter((q) => q.template === 'concerts-month').every((q) => /\b(19|20)\d{2}\b/.test(q.query)),
      '月份演出题的题面写死了年月(复测时仍问同一件事)',
    );
    check(
      !tq.some((q) => q.entity === 'Jonah Reeves'),
      'Jonah Reeves 只有已结束的演出,不给他出巡演题(无数据不提问)',
    );

    const faqs = await readJson<any[]>(`${outDir}/data/faq-blocks.json`);
    const totalQa = faqs.reduce((n, b) => n + b.qa.length, 0);
    check(totalQa > 0, `生成了 ${totalQa} 条问答`);
    // 关键断言:credits 模板在库里没有 credits 字段时必须一条都不出
    check(
      !faqs.some((b) => b.qa.some((x: any) => x.template === 'credits')),
      '库里没有 credits 数据,credits 问答一条都不生成(无数据不作答)',
    );

    // ---------------- A4 合成 / A5 评分 ----------------
    log.step('A4/A5 评分(用合成响应,以便断言分数正确)');
    await synthesizeRun(site, qf, 'e2e-baseline', 'baseline', 0);
    const baseScores = await scoreRun(site, 'e2e-baseline');
    check(
      baseScores.matrix.every((c) => c.hardCitationRate === 0),
      '基线全 0(合成数据里目标域一次没出现)',
    );
    check(
      baseScores.competitors.some((d) => d.domain === 'en.wikipedia.org'),
      '对手榜含 wikipedia',
    );
    check(
      !baseScores.competitors.some((d) => d.domain === site.siteDomain),
      '对手榜不含自己',
    );
    check(baseScores.noiseFloor.medianAgreement !== null, '算出了噪声底噪');

    await synthesizeRun(site, qf, 'e2e-d30', 'd30', 0.5);
    const d30 = await scoreRun(site, 'e2e-d30');
    const aggCell = d30.matrix.find((c) => c.tier === 'aggregate');
    check((aggCell?.hardCitationRate ?? 0) > 0, `d30 的 aggregate 档引用率 > 0(${aggCell?.hardCitationRate})`);
    const ctrlCell = d30.matrix.find((c) => c.tier === 'control');
    check(ctrlCell?.hardCitationRate === 0, 'control 档仍为 0(合成时刻意不给它引用)');

    // ---------------- C 报告 ----------------
    log.step('C 报告');
    const basePath = await buildBaselineReport(site, 'e2e-baseline');
    check(!!basePath, `基线报告生成: ${basePath}`);
    const diffPath = await buildDiffReport(site, ['e2e-baseline', 'e2e-d30']);
    check(!!diffPath, `对比报告生成: ${diffPath}`);

    // 关键断言:题库指纹不一致时必须拒绝生成 diff
    const tampered = await readJson<QueriesFile>(paths.data(SITE_ID, 'queries.json'));
    const manifestPath = paths.data('raw', 'e2e-d30', 'manifest.json');
    const m = await readJson<RunManifest>(manifestPath);
    await writeJson(manifestPath, { ...m, queriesFingerprint: 'TAMPERED' });
    let rejected = false;
    try {
      await scoreRun(site, 'e2e-d30');
    } catch {
      rejected = true;
    }
    check(rejected, '题库指纹被改后,评分拒绝运行(不可比就不出数)');
    await writeJson(manifestPath, m); // 还原
    void tampered;
  } finally {
    server.close();
    // 自测产物不留在工作区 —— diff_report.md 与真实报告同路径,留着会混淆
    await Promise.all(
      [
        paths.data(SITE_ID),
        paths.data(`${SITE_ID}-broken`),
        paths.data('raw', 'e2e-baseline'),
        paths.data('raw', 'e2e-d30'),
        paths.data('scores', 'e2e-baseline.json'),
        paths.data('scores', 'e2e-d30.json'),
        paths.sites(`${SITE_ID}.json`),
        paths.report('baseline_e2e-baseline.md'),
        paths.report(`audit_${SITE_ID}.md`),
        paths.report(`audit_${SITE_ID}-broken.md`),
        paths.report('diff_report.md'),
        paths.fixpack('output', SITE_ID),
        paths.fixpack('output', `${SITE_ID}-fixed`),
        paths.data(`${SITE_ID}-collide`),
        paths.data(`${SITE_ID}-fixed`),
        paths.report(`audit_${SITE_ID}-collide.md`),
      ].map((p) => rm(p, { recursive: true, force: true })),
    );
  }

  console.log('\n' + '─'.repeat(60));
  if (failures.length) {
    log.error(`${failures.length} 项断言失败:`);
    for (const f of failures) log.error(`  · ${f}`);
    process.exit(1);
  }
  log.ok('端到端全部通过。');
  console.log('─'.repeat(60) + '\n');
}

function isTrackName(name: string, entities: { facts?: { tracks?: { name: string }[] } }[]): boolean {
  return entities.some((e) => e.facts?.tracks?.some((t) => t.name === name));
}

/**
 * 合成引擎响应。
 * citedRatio 控制 detail/aggregate/fresh 三档里有多大比例的题引用目标域。
 * control 档恒不引用 —— 它是对照组,合成数据也要遵守这个设定。
 */
async function synthesizeRun(
  site: SiteProfile,
  qf: QueriesFile,
  runId: string,
  label: string,
  citedRatio: number,
): Promise<void> {
  const engines = [{ id: 'perplexity-sonar-pro' as const, model: 'synthetic' }];
  const manifest: RunManifest = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    label,
    site: site.id,
    siteDomain: site.siteDomain,
    queriesFingerprint: qf.fingerprint,
    engines,
    attemptsPerQuery: 2,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    costUsd: 0,
    callsOk: 0,
    callsFailed: 0,
  };

  const COMPETITORS = ['en.wikipedia.org', 'allmusic.com', 'genius.com', 'discogs.com'];

  for (let qi = 0; qi < qf.queries.length; qi++) {
    const q = qf.queries[qi]!;
    const shouldCite = q.tier !== 'control' && qi % 100 < citedRatio * 100;
    for (const e of engines) {
      for (let a = 1; a <= 2; a++) {
        const cites = COMPETITORS.slice(0, 2 + ((qi + a) % 3)).map((d) => ({
          url: `https://${d}/page/${q.id}`,
          domain: d,
          via: 'body.citations',
        }));
        if (shouldCite) {
          cites.unshift({
            url: `https://${site.siteDomain}/artist/mary-hale`,
            domain: site.siteDomain,
            via: 'body.citations',
          });
        }
        const call: EngineCall = {
          schemaVersion: SCHEMA_VERSION,
          runId,
          qid: q.id,
          engine: e.id,
          model: e.model,
          attempt: a,
          ok: true,
          answerText: `Synthetic answer for ${q.query}`,
          citations: cites,
          usage: { costUsd: 0 },
          latencyMs: 100,
          ts: new Date().toISOString(),
          raw: { synthetic: true },
        };
        await writeJson(callPath(runId, e.id, q.id, a), call, false);
        manifest.callsOk++;
      }
    }
  }
  await writeJson(paths.data('raw', runId, 'manifest.json'), manifest);
}

main().catch((e) => {
  log.error((e as Error).message);
  console.error(e);
  process.exit(1);
});
