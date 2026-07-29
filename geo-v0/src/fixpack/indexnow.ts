import { randomBytes } from 'node:crypto';
import { fetchWithRetry } from '../util/http.js';
import { log } from '../util/log.js';
import { writeText, writeJson, paths } from '../util/fsx.js';
import { env } from '../config.js';
import type { SiteProfile } from '../types.js';

/**
 * B4 索引推送。
 *
 * ChatGPT 的检索重度依赖 Bing,所以这一步的优先级高于所有内容改动 ——
 * 页面写得再好,没进索引就等于不存在。
 *
 * IndexNow 是唯一能主动推送的通道(Bing 及联盟引擎)。Google 不吃 IndexNow,
 * 那边只能走 Search Console,列在手动步骤清单里。
 */

const ENDPOINTS = [
  'https://api.indexnow.org/indexnow',
  'https://www.bing.com/indexnow',
];

export function generateKey(): string {
  return randomBytes(16).toString('hex'); // IndexNow key: 8-128 位十六进制
}

/** key 文件必须放在站点根目录,内容就是 key 本身 —— 这是所有权验证方式。 */
export function keyFileName(key: string): string {
  return `${key}.txt`;
}

export interface SubmitResult {
  endpoint: string;
  status: number;
  ok: boolean;
  body: string;
  urlCount: number;
}

export async function submitUrls(
  site: SiteProfile,
  urls: string[],
  opts: { key?: string; dryRun?: boolean } = {},
): Promise<SubmitResult[]> {
  const key = opts.key ?? env('INDEXNOW_KEY');
  if (!key) throw new Error('缺少 INDEXNOW_KEY。先跑 `geo indexnow --generate-key`。');

  const host = new URL(site.sitemap).hostname;
  const keyLocation = `https://${host}/${keyFileName(key)}`;

  // 单次提交上限 10000,分批
  const batches: string[][] = [];
  for (let i = 0; i < urls.length; i += 10_000) batches.push(urls.slice(i, i + 10_000));

  if (opts.dryRun) {
    log.info(`[dry-run] 将向 ${ENDPOINTS.length} 个端点提交 ${urls.length} 个 URL,分 ${batches.length} 批`);
    log.info(`[dry-run] host=${host} keyLocation=${keyLocation}`);
    log.info(`[dry-run] 样例: ${urls.slice(0, 3).join(', ')}`);
    return [];
  }

  // key 文件必须先在线上可访问,否则提交必被拒
  try {
    const check = await fetchWithRetry(keyLocation, { retries: 1, noRetryStatus: [404, 403] });
    const body = (await check.text()).trim();
    if (!check.ok || body !== key) {
      throw new Error(
        `key 文件校验失败: ${keyLocation} 返回 ${check.status},内容 "${body.slice(0, 40)}"。` +
          `必须先把 public/${keyFileName(key)} 部署上线(内容就是 key 本身),再提交。`,
      );
    }
    log.ok(`key 文件校验通过: ${keyLocation}`);
  } catch (e) {
    throw new Error(`key 文件不可访问: ${(e as Error).message}`);
  }

  const results: SubmitResult[] = [];
  for (const endpoint of ENDPOINTS) {
    for (const batch of batches) {
      try {
        const res = await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ host, key, keyLocation, urlList: batch }),
          retries: 3,
          timeoutMs: 60_000,
        });
        const body = (await res.text()).slice(0, 500);
        results.push({ endpoint, status: res.status, ok: res.ok, body, urlCount: batch.length });
        // IndexNow: 200 接受,202 已接收待验证,其余为拒绝
        if (res.status === 200 || res.status === 202) {
          log.ok(`${endpoint}: ${res.status} — 提交 ${batch.length} 个 URL`);
        } else {
          log.warn(`${endpoint}: ${res.status} — ${body}`);
        }
      } catch (e) {
        results.push({ endpoint, status: 0, ok: false, body: (e as Error).message, urlCount: batch.length });
        log.error(`${endpoint} 提交失败: ${(e as Error).message}`);
      }
    }
  }

  await writeJson(paths.data(site.id, 'indexnow-submissions.json'), {
    submittedAt: new Date().toISOString(),
    host,
    keyLocation,
    urlCount: urls.length,
    results,
  });
  return results;
}

/** IndexNow 覆盖不到的部分,老老实实列成手动清单。 */
export function manualStepsDoc(site: SiteProfile, key: string): string {
  const host = new URL(site.sitemap).hostname;
  return `# 索引推送 — 手动步骤

IndexNow 只覆盖 Bing 及其联盟引擎。以下步骤没有 API,必须人工操作一次。
做完之后整个索引通道才算打通。

## 1. Bing Webmaster Tools（必做,优先级最高）

ChatGPT 的检索重度依赖 Bing 索引。这一步没做完,ChatGPT 那一列基本不会动。

1. https://www.bing.com/webmasters — 用任意微软账号登录
2. 添加站点 \`https://${host}\`
3. 验证所有权（三选一,推荐 DNS TXT，其次上传 HTML 文件到 public/）
4. Sitemaps → 提交 \`${site.sitemap}\`
5. IndexNow 页面确认 key \`${key}\` 已被识别
6. URL Inspection 抽查 2-3 个实体页,确认 Bing 看到的 HTML 里**有实体内容**
   —— 如果这里显示空白或只有骨架,说明 SSR 没生效,回到 B5 的 blocker 修完再来

## 2. Google Search Console（必做）

Google 不吃 IndexNow,只能走 GSC。Gemini 的 grounding 依赖 Google 索引。

1. https://search.google.com/search-console
2. 添加资源 \`https://${host}\`（推荐 Domain 属性,需 DNS 验证）
3. Sitemaps → 提交 \`${site.sitemap}\`
4. URL 检查工具抽查 2-3 个实体页 → 「测试实际网址」→ 看「已渲染的 HTML」
5. 对新建的聚合页和 /new-releases 手动「请求编入索引」（每天有配额,先推最重要的几个）

## 3. 验证渲染（做完 1、2 之后）

在本地对着线上跑一次裸抓,确认抓取器看到的和浏览器看到的一致：

\`\`\`bash
npm run audit -- --site ${site.id}
\`\`\`

blocker 归零才算 Day 0 就绪。

## 4. 记 Day 0

上面全部完成、Vercel 部署上线的那一天记为 **Day 0**。
Day 15 / Day 30 从这一天起算,不是从代码合并那天起算。
`;
}
