import type { Citation } from '../../types.js';
import { normalizeUrl, domainOf, domainFromTitle, extractUrlsFromText, isRedirectWrapper } from '../../util/url.js';

/**
 * Citation 提取器 —— 整个实验的尺子。
 *
 * spec 假设 "citations 经 OpenRouter 完整透传"。那是待验证的经验断言,不是事实:
 * OpenRouter 把 Perplexity 的引用放在非标准字段,不同时期在
 *   body.citations / choices[].message.annotations / body.search_results
 * 之间飘。所以这里不赌任何单一字段 —— 按已知路径依次扫,每条引用记录它的 via(来自哪个字段),
 * 报告里会汇总 via 分布。如果某一轮 via 分布突变,说明上游改了接口形态,尺子需要复核。
 *
 * 兜底扫正文 markdown 链接是最后手段,且单独标 via=text,因为它的语义弱一档
 * (模型在正文里提到一个 URL ≠ 检索系统真的引用了它)。
 */

export interface ExtractResult {
  citations: Citation[];
  /** 各字段命中数,用于 verify 与报告里的尺子健康检查 */
  viaCounts: Record<string, number>;
}

export function extractCitations(raw: unknown, answerText: string): ExtractResult {
  const found: Citation[] = [];
  const seen = new Set<string>();

  const add = (url: unknown, via: string, title?: unknown) => {
    if (typeof url !== 'string') return;
    const norm = normalizeUrl(url);
    if (!norm) return;
    const key = norm.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const t = typeof title === 'string' ? title : undefined;
    // 跳转包装(Gemini grounding 的 vertexaisearch)域名不在 URL 里,从 title 兜底
    const domain = domainOf(norm) ?? domainFromTitle(t) ?? (isRedirectWrapper(norm) ? '__redirect__' : null);
    if (!domain) return;
    found.push({ url: norm, domain, ...(t ? { title: t } : {}), via });
  };

  const r = raw as Record<string, any> | null | undefined;
  if (r && typeof r === 'object') {
    // --- Perplexity via OpenRouter: 顶层 citations(字符串数组) ---
    for (const c of asArray(r.citations)) {
      if (typeof c === 'string') add(c, 'body.citations');
      else if (c && typeof c === 'object') add(c.url, 'body.citations', c.title);
    }

    // --- Perplexity: 顶层 search_results ---
    for (const s of asArray(r.search_results)) {
      if (s && typeof s === 'object') add(s.url, 'body.search_results', s.title ?? s.name);
    }

    for (const choice of asArray(r.choices)) {
      const msg = choice?.message ?? choice?.delta;
      if (!msg || typeof msg !== 'object') continue;

      // --- OpenAI 搜索版: message.annotations[].url_citation ---
      for (const a of asArray(msg.annotations)) {
        if (!a || typeof a !== 'object') continue;
        if (a.type === 'url_citation' && a.url_citation) {
          add(a.url_citation.url, 'annotations.url_citation', a.url_citation.title);
        } else if (a.url) {
          add(a.url, 'annotations.url', a.title);
        }
      }
      // 某些透传把 citations 挂在 message 上
      for (const c of asArray(msg.citations)) {
        if (typeof c === 'string') add(c, 'message.citations');
        else if (c && typeof c === 'object') add(c.url, 'message.citations', c.title);
      }
      // choice 级别的 sources
      for (const s of asArray(choice.sources ?? msg.sources)) {
        if (s && typeof s === 'object') add(s.url, 'sources', s.title);
      }
    }

    // --- Gemini grounding: candidates[].groundingMetadata ---
    for (const cand of asArray(r.candidates)) {
      const gm = cand?.groundingMetadata;
      if (!gm) continue;
      for (const chunk of asArray(gm.groundingChunks)) {
        const web = chunk?.web;
        if (web) add(web.uri, 'groundingChunks.web', web.domain ?? web.title);
      }
      for (const q of asArray(gm.groundingSupports)) {
        for (const seg of asArray(q?.segment?.citations)) add(seg?.uri, 'groundingSupports', seg?.title);
      }
      // searchEntryPoint 里有时含真实结果链接
      for (const u of extractUrlsFromText(String(gm.searchEntryPoint?.renderedContent ?? ''))) {
        add(u, 'searchEntryPoint');
      }
    }
  }

  // --- 兜底:正文里的 URL。语义弱一档,单独标记。 ---
  if (found.length === 0) {
    for (const u of extractUrlsFromText(answerText)) add(u, 'text');
  }

  const viaCounts: Record<string, number> = {};
  for (const c of found) viaCounts[c.via] = (viaCounts[c.via] ?? 0) + 1;

  return { citations: found, viaCounts };
}

function asArray(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return [v];
  return [];
}

/**
 * 深度扫描 —— 只在 verify 里用。
 * 把响应里所有看起来像 URL 的字段路径都列出来,人工确认 extractor 是否漏了新字段。
 */
export function deepScanUrls(raw: unknown, maxDepth = 8): { path: string; url: string }[] {
  const out: { path: string; url: string }[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > maxDepth || out.length > 500) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v.trim())) out.push({ path, url: v.trim() });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(raw, '', 0);
  return out;
}
