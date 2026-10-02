import * as cheerio from 'cheerio';
import { fetchWithRetry, mapLimit } from '../util/http.js';
import { log } from '../util/log.js';
import { writeJson, writeText, readJson, readJsonOr, paths } from '../util/fsx.js';
import { globToRegExp, pathOf } from '../util/url.js';
import { fetchSitemap } from '../probe/sitemap.js';
import type { EntitiesFile, SiteProfile } from '../types.js';

/**
 * B5 可读性体检。
 *
 * spec 把这一步排在 W1 末尾。那个顺序是错的,代价很大:
 * 如果 robots.txt 封了 PerplexityBot,或实体页只在客户端 JS 渲染后才出现内容,
 * 那么基线跑出来的 0% 是"被封的 0%"而不是"被忽略的 0%" —— 两者对应完全不同的修复方案,
 * 而你会在花完预算跑完 600 次调用之后才发现。
 *
 * 这一步是 30 分钟的工作,应该是 Day 1 的第一件事。
 */

/** ChatGPT 检索重度依赖 Bing,所以 Bingbot 与 GPTBot 都是 blocker 级。 */
const BOTS = [
  { ua: 'GPTBot', why: 'OpenAI 抓取器 —— ChatGPT 的训练与检索来源', severity: 'blocker' as const },
  { ua: 'OAI-SearchBot', why: 'ChatGPT Search 的实时抓取器', severity: 'blocker' as const },
  { ua: 'PerplexityBot', why: 'Perplexity 抓取器 —— 主引擎', severity: 'blocker' as const },
  { ua: 'Bingbot', why: 'Bing 索引 —— ChatGPT 检索的底层依赖', severity: 'blocker' as const },
  { ua: 'Googlebot', why: 'Google 索引 —— Gemini grounding 的底层依赖', severity: 'blocker' as const },
  { ua: 'ClaudeBot', why: 'Anthropic 抓取器', severity: 'warn' as const },
  { ua: 'Google-Extended', why: 'Gemini 训练用;拒绝不影响 grounding 检索', severity: 'info' as const },
  { ua: 'CCBot', why: 'Common Crawl —— 多数模型的间接语料来源', severity: 'warn' as const },
];

export type Severity = 'blocker' | 'warn' | 'info' | 'ok';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  fix?: string;
}

export interface AuditReport {
  site: string;
  siteDomain: string;
  auditedAt: string;
  findings: Finding[];
  stats: {
    robotsFound: boolean;
    sitemapUrls: number;
    entityUrlsInSitemap: number;
    pagesSampled: number;
    pagesServerRendered: number;
    pagesWithJsonLd: number;
    pagesWithEntityInTitle: number;
    pagesWithMetaDescription: number;
  };
}

export async function runAudit(
  site: SiteProfile,
  opts: { sample?: number } = {},
): Promise<AuditReport> {
  const findings: Finding[] = [];
  const origin = new URL(site.sitemap).origin;

  // ---------------- 1. robots.txt ----------------
  log.step('B5.1 robots.txt');
  let robotsText = '';
  let robotsFound = false;
  try {
    const res = await fetchWithRetry(`${origin}/robots.txt`, { retries: 2, noRetryStatus: [404] });
    if (res.ok) {
      robotsText = await res.text();
      robotsFound = true;
    }
  } catch (e) {
    log.warn(`robots.txt 抓取失败: ${(e as Error).message}`);
  }

  if (!robotsFound) {
    findings.push({
      id: 'robots-missing',
      severity: 'warn',
      title: '没有 robots.txt',
      detail: '缺失通常等同于全部放行,不是 blocker,但也意味着没有显式声明 sitemap 位置。',
      fix: '添加 public/robots.txt,显式 Allow 各 AI 抓取器,并加一行 Sitemap: 指向 sitemap.xml。',
    });
  } else {
    const rules = parseRobots(robotsText);
    for (const bot of BOTS) {
      const blocked = isBlocked(rules, bot.ua, '/');
      if (blocked) {
        findings.push({
          id: `robots-block-${bot.ua}`,
          severity: bot.severity,
          title: `robots.txt 封禁 ${bot.ua}`,
          detail: `${bot.why}。被封意味着这台引擎根本读不到站点内容 —— 基线的 0% 是"被封的 0%",不是"被忽略的 0%"。`,
          fix: `在 robots.txt 里为 ${bot.ua} 加 Allow: /`,
        });
      }
    }
    if (!/^\s*sitemap:/im.test(robotsText)) {
      findings.push({
        id: 'robots-no-sitemap',
        severity: 'warn',
        title: 'robots.txt 未声明 sitemap',
        detail: '抓取器发现新页面的主要途径之一。',
        fix: `在 robots.txt 末尾加: Sitemap: ${site.sitemap}`,
      });
    }
  }

  // ---------------- 2. sitemap 覆盖率 ----------------
  log.step('B5.2 sitemap 完整性');
  const entries = await fetchSitemap(site.sitemap);
  const sitemapUrls = entries.map((e) => e.loc);
  const matchers = site.entityPatterns.map((p) => ({ type: p.type, re: globToRegExp(p.pattern) }));
  const entityUrls = sitemapUrls.filter((u) => matchers.some((m) => m.re.test(pathOf(u))));

  let entFile: EntitiesFile | null = null;
  try {
    entFile = await readJson<EntitiesFile>(paths.data(site.id, 'entities.json'));
  } catch {
    /* 还没跑 extract,只报 sitemap 侧的数字 */
  }

  const entityNameByUrl = new Map<string, string>();
  for (const e of entFile?.entities ?? []) {
    if (e.name) entityNameByUrl.set(e.url.replace(/\/$/, ''), e.name);
  }

  if (entFile) {
    const inSitemap = new Set(sitemapUrls.map((u) => u.replace(/\/$/, '')));
    const missing = entFile.entities.filter((e) => !inSitemap.has(e.url.replace(/\/$/, '')));
    if (missing.length) {
      findings.push({
        id: 'sitemap-coverage',
        severity: missing.length > entFile.entities.length * 0.1 ? 'blocker' : 'warn',
        title: `${missing.length}/${entFile.entities.length} 个实体页不在 sitemap 中`,
        detail: `不在 sitemap 里的页面被发现的概率显著更低。示例: ${missing.slice(0, 3).map((m) => m.url).join(', ')}`,
        fix: '让 sitemap 由实体表动态生成,而不是手工维护。',
      });
    }
  }
  if (entityUrls.length === 0) {
    findings.push({
      id: 'sitemap-no-entities',
      severity: 'blocker',
      title: 'sitemap 中没有任何 URL 匹配 entityPattern',
      detail: `模式: ${site.entityPatterns.map((p) => p.pattern).join(', ')}。要么模式配错了,要么实体页压根不在 sitemap 里。`,
      fix: '跑 `geo extract --propose` 看该站的真实 URL 形态。',
    });
  }

  // ---------------- 3. 裸抓实体页(最高优先级信号) ----------------
  const sampleSize = opts.sample ?? 12;
  const sample = pickSpread(entityUrls, sampleSize);
  log.step(`B5.3 裸抓 ${sample.length} 个实体页(不执行 JS,模拟抓取器所见)`);

  let serverRendered = 0;
  let withJsonLd = 0;
  let withEntityInTitle = 0;
  let withMeta = 0;
  const csrPages: string[] = [];
  const thinPages: { url: string; chars: number }[] = [];
  const noJsonLdPages: string[] = [];
  const badTitlePages: string[] = [];

  const results = await mapLimit(sample, 4, async (url) => {
    try {
      // 用 PerplexityBot 的 UA 裸抓 —— 要看的是抓取器实际拿到什么,不是浏览器拿到什么
      const res = await fetchWithRetry(url, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
          accept: 'text/html',
        },
        retries: 2,
        timeoutMs: 45_000,
        noRetryStatus: [404, 410],
      });
      return { url, status: res.status, html: await res.text(), finalUrl: res.url, redirected: res.redirected };
    } catch (e) {
      return { url, status: 0, html: '', finalUrl: url, redirected: false, error: (e as Error).message };
    }
  });

  /*
   * 失效页面先剔出去,不参与渲染判定。
   * 一个 404 或跳首页的页面不是"客户端渲染的空壳" —— 混进去会被报成 CSR blocker,
   * 把人送去查一个不存在的渲染问题。它们单独报为 sitemap 死链。
   */
  const deadSample: { url: string; reason: string }[] = [];
  const siteNameLc = site.siteName.trim().toLowerCase();
  const live = results.filter((r) => {
    if (r.status === 404 || r.status === 410) {
      deadSample.push({ url: r.url, reason: `HTTP ${r.status}` });
      return false;
    }
    if (r.redirected && pathOf(r.finalUrl) !== pathOf(r.url)) {
      deadSample.push({ url: r.url, reason: `重定向到 ${pathOf(r.finalUrl) || '/'}` });
      return false;
    }
    if (!r.html) return false;
    const $$ = cheerio.load(r.html);
    const label = ($$('h1').first().text().trim() || $$('title').first().text().trim()).toLowerCase();
    const hasLd = $$('script[type="application/ld+json"]').length > 0;
    if (label === siteNameLc && !hasLd) {
      deadSample.push({ url: r.url, reason: '返回全站通用页(软 404)' });
      return false;
    }
    return true;
  });

  for (const r of live) {
    const $ = cheerio.load(r.html);
    const title = $('title').first().text().trim();
    const h1 = $('h1').first().text().trim();
    const meta = $('meta[name="description"]').attr('content')?.trim() ?? '';
    const jsonLdCount = $('script[type="application/ld+json"]').length;

    // 正文文本量:CSR 页面的裸 HTML 通常只有 shell,可见文本极少
    const body = $('body').clone();
    body.find('script,style,noscript').remove();
    const bodyText = body.text().replace(/\s+/g, ' ').trim();

    // JSON-LD 里带 name 的页面,其结构化内容按定义就在裸 HTML 里
    const hasJsonLdName = $('script[type="application/ld+json"]')
      .toArray()
      .some((el) => {
        try {
          return /"name"\s*:\s*"[^"]{1,}"/.test($(el).contents().text());
        } catch {
          return false;
        }
      });

    /*
     * CSR 判定是多信号的,不是单一字节数阈值。
     * 单纯用文本量会把"内容偏薄但确实 SSR"的页面(比如只有标题+曲目表的专辑页)
     * 误报成 blocker —— 那会把人送去查一个不存在的渲染 bug,代价比漏报还大。
     * 空壳页的特征是三个信号同时缺失:没有 h1、没有带 name 的 JSON-LD、正文近乎为空。
     */
    const hasIdentity = h1.length > 0 || hasJsonLdName;
    const isSSR = hasIdentity && bodyText.length >= 120;
    if (isSSR) {
      serverRendered++;
      // 薄内容是另一个问题,和 CSR 无关,不能混为一谈
      if (bodyText.length < 400) thinPages.push({ url: r.url, chars: bodyText.length });
    } else {
      csrPages.push(r.url);
    }

    if (jsonLdCount > 0) withJsonLd++;
    else noJsonLdPages.push(r.url);

    /*
     * 「title 是否含实体名」必须拿**抽到的实体名**比,不能拿 URL slug 比。
     * GospelHub 的 slug 是 UUID,拿它比对会 11/11 全部误报 ——
     * 而这条警告会把人送去改本来就没问题的 title 模板。
     * 没有 entities.json 时(还没跑 extract)退回 slug,但要求 slug 看起来像人类可读的名字。
     */
    const known = entityNameByUrl.get(r.url.replace(/\/$/, ''));
    const needle = known?.toLowerCase() ?? readableSlug(r.url);
    if (!needle) {
      // 既没有已知实体名,slug 又是 UUID —— 无从判断,不作结论
      withEntityInTitle++;
    } else if (looseIncludes(title.toLowerCase(), needle)) {
      withEntityInTitle++;
    } else {
      badTitlePages.push(r.url);
    }

    if (meta.length > 20) withMeta++;
  }

  const n = live.length || 1;

  // 死链:优先用 extract 的全量结果,没有就用本次抽样的结果
  const deadFile = await readJsonOr<{ total: number; dead: { url: string; reason: string }[] } | null>(
    paths.data(site.id, 'dead-urls.json'),
    null,
  );
  const deadList = deadFile?.dead.length ? deadFile.dead : deadSample;
  const deadBase = deadFile?.dead.length ? deadFile.total : results.length;
  if (deadList.length) {
    findings.push({
      id: 'sitemap-dead-urls',
      severity: 'warn',
      title: `sitemap 列出的实体 URL 里有 ${deadList.length}/${deadBase} 个已失效` +
        `(${deadFile?.dead.length ? '全量' : '抽样'})`,
      detail:
        '抓取器沿 sitemap 抓到的是 404、跳首页或通用页。死链会消耗抓取配额、拉低整站质量信号,' +
        '而且推 IndexNow 时会把它们一起推出去。' +
        `示例: ${deadList.slice(0, 3).map((d) => `${d.url}(${d.reason})`).join(', ')}`,
      fix:
        'sitemap 只列出仍然存在的实体。如果记录是被删掉的,sitemap 要同步;' +
        '更好的做法是不删已结束的演出,保留页面并标注为过去的场次 —— 历史页面本身也能回答问题。',
    });
  }

  if (csrPages.length > 0) {
    findings.push({
      id: 'csr-rendering',
      severity: 'blocker',
      title: `${csrPages.length}/${n} 个实体页的裸 HTML 里没有实体内容`,
      detail:
        '内容只在客户端 JS 执行后才出现。抓取器基本不执行 JS —— 这些页面对 AI 引擎等同于空白。' +
        '这是最高优先级修复项:在它修好之前,所有其他修复(JSON-LD、FAQ 块、聚合页)都不会被看到。' +
        `示例: ${csrPages.slice(0, 3).join(', ')}`,
      fix: 'Next.js 实体页改为 SSR / SSG(Server Component 或 generateStaticParams),不要在 useEffect 里取数据。',
    });
  } else {
    findings.push({
      id: 'csr-rendering',
      severity: 'ok',
      title: `全部 ${n} 个抽样实体页服务端渲染正常`,
      detail: '抓取器裸抓即可拿到实体内容。这是所有后续修复能生效的前提。',
    });
  }

  if (thinPages.length > 0) {
    findings.push({
      id: 'thin-content',
      severity: 'warn',
      title: `${thinPages.length}/${n} 个实体页正文内容偏薄(< 400 字符)`,
      detail:
        '这些页面确实是服务端渲染的(和 CSR 是两回事),但可引用的文字太少。' +
        '引擎倾向于引用能直接支撑一句话答案的页面 —— 只有标题和一个列表的页面很难被选中。' +
        `示例: ${thinPages.slice(0, 3).map((p) => `${p.url} (${p.chars} 字符)`).join(', ')}`,
      fix: 'B3 的问答块正是为这一项设计的:用库内事实给每个实体页补两到四句可直接引用的文字。',
    });
  }

  if (noJsonLdPages.length > 0) {
    findings.push({
      id: 'no-jsonld',
      severity: 'warn',
      title: `${noJsonLdPages.length}/${n} 个实体页没有 JSON-LD`,
      detail: '缺少结构化标记,引擎需要靠自然语言理解页面结构,准确率与被引概率都更低。',
      fix: 'B1 的产出直接解决这一项。',
    });
  }

  if (badTitlePages.length > 0) {
    findings.push({
      id: 'title-missing-entity',
      severity: 'warn',
      title: `${badTitlePages.length}/${n} 个页面的 <title> 不含实体名`,
      detail: `title 是引擎判断"这一页是关于谁的"最强的单一信号。示例: ${badTitlePages.slice(0, 3).join(', ')}`,
      fix: 'title 模板改成 `{实体名} — {类型} | {站名}`。',
    });
  }

  if (withMeta < n) {
    findings.push({
      id: 'meta-description',
      severity: 'info',
      title: `${n - withMeta}/${n} 个页面缺 meta description`,
      detail: '不是 blocker,但它常被直接用作摘要片段。',
      fix: '由库内事实生成两句话的 description,无数据则留空,不要用模板套话灌水。',
    });
  }

  // ---------------- 汇总 ----------------
  const report: AuditReport = {
    site: site.id,
    siteDomain: site.siteDomain,
    auditedAt: new Date().toISOString(),
    findings: findings.sort((a, b) => sevRank(a.severity) - sevRank(b.severity)),
    stats: {
      robotsFound,
      sitemapUrls: sitemapUrls.length,
      entityUrlsInSitemap: entityUrls.length,
      pagesSampled: n,
      pagesServerRendered: serverRendered,
      pagesWithJsonLd: withJsonLd,
      pagesWithEntityInTitle: withEntityInTitle,
      pagesWithMetaDescription: withMeta,
    },
  };

  await writeJson(paths.data(site.id, 'audit.json'), report);
  await writeText(paths.report(`audit_${site.id}.md`), renderAuditMd(site, report));
  log.ok(`体检报告写入 report/audit_${site.id}.md`);

  const blockers = findings.filter((f) => f.severity === 'blocker');
  if (blockers.length) {
    log.error(`发现 ${blockers.length} 个 blocker:`);
    for (const b of blockers) log.error(`  · ${b.title}`);
    log.error('在这些修好之前跑基线,你测的是"被封/空白"而不是"未被引用"。');
  } else {
    log.ok('无 blocker。站点对抓取器可读,基线数据可以正常解读。');
  }
  return report;
}

// ---------------------------------------------------------------- helpers

function sevRank(s: Severity): number {
  return { blocker: 0, warn: 1, info: 2, ok: 3 }[s];
}

interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (cur && (key === 'allow' || key === 'disallow')) {
      (key === 'allow' ? cur.allow : cur.disallow).push(val);
      lastWasAgent = false;
    }
  }
  return groups;
}

/** 最长匹配规则胜出(robots.txt 标准行为);具名 UA 组优先于 *。 */
function isBlocked(groups: RobotsGroup[], ua: string, path: string): boolean {
  const lower = ua.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && lower.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const applicable = specific.length ? specific : wildcard;
  if (!applicable.length) return false;

  let best: { len: number; allow: boolean } | null = null;
  for (const g of applicable) {
    for (const p of g.disallow) {
      if (p === '') continue; // Disallow: 空值 = 全部允许
      if (matchRule(p, path) && (!best || p.length > best.len)) best = { len: p.length, allow: false };
    }
    for (const p of g.allow) {
      if (matchRule(p, path) && (!best || p.length >= best.len)) best = { len: p.length, allow: true };
    }
  }
  return best ? !best.allow : false;
}

function matchRule(rule: string, path: string): boolean {
  const re = new RegExp(
    '^' + rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'),
  );
  return re.test(path);
}

/** 均匀抽样而不是取前 N —— sitemap 常按类型分块,取前 N 会只覆盖一种页面。 */
function pickSpread<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]!);
}

/**
 * URL 末段作为实体名的兜底。
 * UUID / 纯数字 / 过短的 slug 返回 null —— 它们不是人类可读的名字,拿来比对只会产生误报。
 */
function readableSlug(url: string): string | null {
  const seg = decodeURIComponent(pathOf(url).split('/').filter(Boolean).pop() ?? '');
  if (!seg) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return null;
  if (/^[0-9a-f]{16,}$/i.test(seg) || /^\d+$/.test(seg)) return null;
  const words = seg.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words.length > 2 ? words : null;
}

function looseIncludes(haystack: string, needle: string): boolean {
  const words = needle.split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return haystack.includes(needle);
  return words.filter((w) => haystack.includes(w)).length >= Math.ceil(words.length * 0.6);
}

function renderAuditMd(site: SiteProfile, r: AuditReport): string {
  const L: string[] = [];
  L.push(`# ${site.siteName} — B5 可读性体检`);
  L.push('');
  L.push(`目标域 \`${r.siteDomain}\` · ${r.auditedAt}`);
  L.push('');
  L.push('> 这份体检必须在跑基线**之前**完成。');
  L.push('> 如果站点对抓取器不可读,基线的 0% 是"被封/空白的 0%",不是"未被引用的 0%" —— ');
  L.push('> 两者对应完全不同的修复方案。');
  L.push('');
  L.push('## 数字');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---:|');
  L.push(`| robots.txt | ${r.stats.robotsFound ? '存在' : '缺失'} |`);
  L.push(`| sitemap URL 总数 | ${r.stats.sitemapUrls} |`);
  L.push(`| 其中匹配实体模式 | ${r.stats.entityUrlsInSitemap} |`);
  L.push(`| 抽样页数 | ${r.stats.pagesSampled} |`);
  L.push(`| 服务端渲染正常 | ${r.stats.pagesServerRendered}/${r.stats.pagesSampled} |`);
  L.push(`| 含 JSON-LD | ${r.stats.pagesWithJsonLd}/${r.stats.pagesSampled} |`);
  L.push(`| title 含实体名 | ${r.stats.pagesWithEntityInTitle}/${r.stats.pagesSampled} |`);
  L.push(`| 含 meta description | ${r.stats.pagesWithMetaDescription}/${r.stats.pagesSampled} |`);
  L.push('');

  const icon: Record<Severity, string> = { blocker: '🔴', warn: '🟡', info: '🔵', ok: '🟢' };
  for (const sev of ['blocker', 'warn', 'info', 'ok'] as Severity[]) {
    const items = r.findings.filter((f) => f.severity === sev);
    if (!items.length) continue;
    L.push(`## ${icon[sev]} ${sev.toUpperCase()} (${items.length})`);
    L.push('');
    for (const f of items) {
      L.push(`### ${f.title}`);
      L.push('');
      L.push(f.detail);
      if (f.fix) {
        L.push('');
        L.push(`**修复:** ${f.fix}`);
      }
      L.push('');
    }
  }
  return L.join('\n');
}
