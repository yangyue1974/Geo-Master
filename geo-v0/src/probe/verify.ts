import { log } from '../util/log.js';
import { writeJson, paths } from '../util/fsx.js';
import { resolveEngines } from './engines/index.js';
import { extractCitations, deepScanUrls } from './engines/extract.js';

/**
 * 引擎冒烟 —— 跑基线之前必须先过这一关。
 *
 * spec 把 "citations 经 OpenRouter 完整透传" 当作前提。它是待验证的经验断言。
 * 如果透传形态变了(字段改名、模型下架、annotations 不回传),整批基线数据会静默地全 0,
 * 而 0 会被误读成"我们没被引用",实际是"尺子没读数"。这两件事的后续动作完全相反。
 *
 * 这个命令用一道必然有引用的题打穿所有引擎,把原始 JSON 全量落盘,并列出:
 *   - extractor 提到了几条、走的哪个字段(via)
 *   - 深度扫描发现的所有 URL 字段路径(用来发现 extractor 漏掉的新字段)
 *
 * 判读规则写在输出末尾。
 */

const CANARY_QUERY =
  'What are the most cited scientific papers about CRISPR gene editing? Include source links.';

export interface VerifyOpts {
  query?: string;
  engines?: string[];
}

export async function verifyEngines(opts: VerifyOpts = {}): Promise<boolean> {
  const query = opts.query ?? CANARY_QUERY;
  const engines = resolveEngines(opts.engines);

  if (engines.length === 0) {
    log.error('没有可用引擎。检查 OPENROUTER_API_KEY / GEMINI_API_KEY。');
    return false;
  }

  log.step(`引擎冒烟,题目: ${query}`);
  let allGood = true;
  const summary: Record<string, unknown> = {};

  for (const engine of engines) {
    log.step(`${engine.id}  (model=${engine.model})`);
    const t0 = Date.now();
    try {
      const res = await engine.ask(query);
      const ms = Date.now() - t0;
      const { citations, viaCounts } = extractCitations(res.raw, res.answerText);
      const deep = deepScanUrls(res.raw);

      const dumpPath = paths.data('_verify', `${engine.id}.json`);
      await writeJson(dumpPath, {
        engine: engine.id,
        model: engine.model,
        query,
        latencyMs: ms,
        answerText: res.answerText,
        extracted: citations,
        viaCounts,
        deepScanUrlPaths: dedupePaths(deep),
        usage: res.usage,
        raw: res.raw,
      });

      const ok = citations.length > 0 && !onlyTextVia(viaCounts);
      allGood &&= ok;

      log.info(`  延迟 ${ms}ms  答案 ${res.answerText.length} 字  成本 $${(res.usage?.costUsd ?? 0).toFixed(5)}`);
      log.info(`  提取到 ${citations.length} 条引用,字段分布: ${JSON.stringify(viaCounts)}`);
      for (const c of citations.slice(0, 5)) log.info(`    ${c.domain}  ←  ${c.via}`);

      // extractor 没覆盖到的 URL 字段 —— 这是发现上游改接口的主要信号
      const covered = new Set(citations.map((c) => c.url.toLowerCase()));
      const missed = dedupePaths(deep).filter(
        (d) => !covered.has(d.url.toLowerCase()) && !/schema\.org|openrouter\.ai|googleapis\.com\/\$/.test(d.url),
      );
      if (missed.length) {
        log.warn(`  深度扫描发现 ${missed.length} 个未被 extractor 采纳的 URL 字段路径,前 8 条:`);
        for (const m of missed.slice(0, 8)) log.warn(`    ${m.path}  →  ${m.url.slice(0, 70)}`);
      }

      if (!ok) {
        log.error(
          `  ${engine.id} 未从结构化字段提取到引用 —— 尺子在这台引擎上读不出数。` +
            `看 ${dumpPath} 的 deepScanUrlPaths,把新字段加进 engines/extract.ts 再跑一次。`,
        );
      } else {
        log.ok(`  ${engine.id} 通过`);
      }

      summary[engine.id] = { ok, model: engine.model, citations: citations.length, viaCounts, latencyMs: ms };
    } catch (e) {
      allGood = false;
      log.error(`  ${engine.id} 调用失败: ${(e as Error).message}`);
      summary[engine.id] = { ok: false, model: engine.model, error: (e as Error).message };
    }
  }

  await writeJson(paths.data('_verify', 'summary.json'), {
    verifiedAt: new Date().toISOString(),
    query,
    result: summary,
  });

  console.log('\n' + '─'.repeat(72));
  if (allGood) {
    log.ok('全部引擎通过。尺子可读数,可以跑基线。');
    log.info('注意:通过只说明"字段能读出来",不说明"字段语义没变"。原始 JSON 已存 data/_verify/,建议人眼扫一遍。');
  } else {
    log.error('有引擎未通过。不要在这个状态下跑基线 —— 你会得到一批无法区分"没被引用"和"没读数"的 0。');
  }
  console.log('─'.repeat(72) + '\n');
  return allGood;
}

/** via=text 是正文兜底,语义弱一档;只有它命中,等于结构化引用一条都没拿到。 */
function onlyTextVia(viaCounts: Record<string, number>): boolean {
  const keys = Object.keys(viaCounts);
  return keys.length > 0 && keys.every((k) => k === 'text');
}

function dedupePaths(deep: { path: string; url: string }[]): { path: string; url: string }[] {
  const seen = new Set<string>();
  const out: { path: string; url: string }[] = [];
  for (const d of deep) {
    // 把数组下标抹平,同一字段的多条只报一次
    const key = d.path.replace(/\[\d+\]/g, '[]') + '|' + d.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
