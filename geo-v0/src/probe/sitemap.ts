import { fetchText } from '../util/http.js';
import { log } from '../util/log.js';
import { normalizeUrl } from '../util/url.js';

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

const decodeXmlEntities = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&'); // 必须最后,否则 &amp;lt; 会被双重解码

/**
 * 递归抓取 sitemap(含 sitemap index)。
 *
 * 不引 XML 解析器 —— sitemap 格式极其规整,正则足够,且对畸形 XML 更宽容
 * (实践中不少站点的 sitemap 有未转义字符,严格解析器会整份拒绝)。
 */
export async function fetchSitemap(
  url: string,
  opts: { maxDepth?: number; maxUrls?: number } = {},
): Promise<SitemapEntry[]> {
  const { maxDepth = 4, maxUrls = 50_000 } = opts;
  const seen = new Set<string>();
  const out: SitemapEntry[] = [];

  async function walk(u: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= maxUrls) return;
    const norm = normalizeUrl(u);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);

    let xml: string;
    try {
      xml = await fetchText(norm, { timeoutMs: 60_000 });
    } catch (e) {
      log.warn(`sitemap 抓取失败 ${norm}: ${(e as Error).message}`);
      return;
    }

    // gzip 的 sitemap 由 fetch 自动解压(Content-Encoding);.xml.gz 静态文件不处理,直接跳过
    if (!xml.includes('<')) {
      log.warn(`sitemap 内容不是 XML,跳过: ${norm}`);
      return;
    }

    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const blocks = xml.match(/<(?:url|sitemap)\b[\s\S]*?<\/(?:url|sitemap)>/gi) ?? [];

    if (blocks.length === 0) {
      // 兜底:某些站点的 sitemap 只有裸 <loc>
      const locs = xml.match(/<loc>([\s\S]*?)<\/loc>/gi) ?? [];
      for (const l of locs) {
        const v = normalizeUrl(decodeXmlEntities(l.replace(/<\/?loc>/gi, '').trim()));
        if (v) (isIndex ? await walk(v, depth + 1) : out.push({ loc: v }));
      }
      return;
    }

    const children: string[] = [];
    for (const b of blocks) {
      const locM = b.match(/<loc>([\s\S]*?)<\/loc>/i);
      if (!locM || !locM[1]) continue;
      const loc = normalizeUrl(decodeXmlEntities(locM[1].trim()));
      if (!loc) continue;
      if (isIndex) {
        children.push(loc);
      } else {
        const lm = b.match(/<lastmod>([\s\S]*?)<\/lastmod>/i);
        const entry: SitemapEntry = { loc };
        if (lm && lm[1]) entry.lastmod = lm[1].trim();
        out.push(entry);
        if (out.length >= maxUrls) return;
      }
    }

    for (const c of children) {
      await walk(c, depth + 1);
      if (out.length >= maxUrls) return;
    }
  }

  await walk(url, 0);
  log.ok(`sitemap: ${out.length} 个 URL(来自 ${seen.size} 份 sitemap 文件)`);
  return out;
}

/**
 * URL 模式自动提议。
 *
 * 未来的客户只给一个 URL,不会告诉你实体页长什么样。
 * 做法:按第一段路径前缀聚类,取样本量足够大的前缀作为候选实体模式,人工确认后写进 site profile。
 * 这是"自动提议 + 配置覆盖"的中间态 —— 全自动识别不可靠,全手工配置不 scale。
 */
export function proposePatterns(
  urls: string[],
  opts: { minCount?: number; topN?: number } = {},
): { pattern: string; count: number; samples: string[] }[] {
  const { minCount = 5, topN = 20 } = opts;
  const groups = new Map<string, string[]>();

  for (const u of urls) {
    let path: string;
    try {
      path = new URL(u).pathname;
    } catch {
      continue;
    }
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    // 只提议 1-2 段深度的模式:/artist/* 和 /artist/*/*
    for (let depth = 1; depth <= Math.min(2, segs.length); depth++) {
      if (segs.length !== depth + 1 && segs.length !== depth) continue;
      const prefix = '/' + segs.slice(0, depth).join('/');
      const pattern = segs.length > depth ? prefix + '/*' : prefix;
      if (!groups.has(pattern)) groups.set(pattern, []);
      const g = groups.get(pattern)!;
      if (g.length < 3) g.push(u);
    }
  }

  const counts = new Map<string, number>();
  for (const u of urls) {
    let path: string;
    try {
      path = new URL(u).pathname;
    } catch {
      continue;
    }
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    for (let depth = 1; depth <= Math.min(2, segs.length); depth++) {
      if (segs.length !== depth + 1 && segs.length !== depth) continue;
      const prefix = '/' + segs.slice(0, depth).join('/');
      const pattern = segs.length > depth ? prefix + '/*' : prefix;
      counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([p, c]) => c >= minCount && p.endsWith('/*'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([pattern, count]) => ({ pattern, count, samples: groups.get(pattern) ?? [] }));
}
