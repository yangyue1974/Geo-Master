#!/usr/bin/env node
import { loadEnv, loadSite, budgetLimit } from './config.js';
import { log } from './util/log.js';
import { readJson, writeJson, paths } from './util/fsx.js';
import { extractEntities } from './probe/extract.js';
import { generateQueries } from './probe/queries.js';
import { probe } from './probe/run.js';
import { scoreRun, listRuns } from './probe/score.js';
import { verifyEngines } from './probe/verify.js';
import { buildBaselineReport } from './report/baseline.js';
import { buildDiffReport } from './report/diff.js';
import { runAudit } from './fixpack/audit.js';
import { buildFixpack } from './fixpack/build.js';
import { generateKey, submitUrls } from './fixpack/indexnow.js';
import type { EntitiesFile, Tier } from './types.js';

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const str = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const num = (a: Args, k: string): number | undefined => {
  const v = str(a, k);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const list = (a: Args, k: string): string[] | undefined =>
  str(a, k)?.split(',').map((s) => s.trim()).filter(Boolean);

const HELP = `
geo-v0 — 检测 / 修复 / 复测闭环

用法: npm run geo -- <命令> [选项]

跑通顺序(不要跳步):
  1  audit     B5 可读性体检 —— 必须最先跑。站点对抓取器不可读时,基线的 0% 无法解读。
  2  verify    引擎冒烟 —— 验证 citations 透传。尺子读不出数就别跑基线。
  3  extract   sitemap → entities.json
  4  queries   entities.json → queries.json(生成后即冻结)
  5  probe     引擎探测 → data/raw/{run_id}/
  6  score     评分 → data/scores/{run_id}.json
  7  report    基线报告 → report/baseline_{run_id}.md
  8  fixpack   修复包 → fixpack/output/{site}/
  9  indexnow  IndexNow 推送
 10  diff      复测对比 → report/diff_report.md

命令与选项:

  audit     --site <id>  [--sample 12]
  verify    [--engines perplexity-sonar-pro,openai-search]  [--query "..."]
  extract   --site <id>  [--source sitemap|supabase]  [--propose]  [--shallow]
                         [--limit-per-type 300]  [--concurrency 5]
  queries   --site <id>  [--paraphrase]  [--llm-themes]  [--force]
                         [--control 20 --detail 50 --aggregate 50 --fresh 30]
  probe     --site <id>  --label <baseline|d15|d30>  [--run-id <id>]
                         [--engines a,b]  [--attempts 2]  [--concurrency 3]
                         [--limit N]  [--budget 50]
  score     --site <id>  --run <run_id>
  report    --site <id>  --run <run_id>
  diff      --site <id>  --runs <run_id,run_id,...>
  fixpack   --site <id>  [--out <dir>]  [--new-release-days 90]  [--min-aggregate-items 3]
  indexnow  --site <id>  [--generate-key]  [--submit]  [--dry-run]
  runs      列出已有 run_id

示例:
  npm run audit   -- --site gospelhub
  npm run verify
  npm run extract -- --site gospelhub --propose
  npm run probe   -- --site gospelhub --label baseline --limit 4   # 先小跑冒烟
  npm run probe   -- --site gospelhub --label baseline
`;

async function main(): Promise<void> {
  await loadEnv();
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || args.help) {
    console.log(HELP);
    return;
  }

  const needSite = ['audit', 'extract', 'queries', 'probe', 'score', 'report', 'diff', 'fixpack', 'indexnow'];
  const siteId = str(args, 'site');
  if (needSite.includes(cmd) && !siteId) {
    throw new Error(`命令 ${cmd} 需要 --site <id>。可用配置见 sites/ 目录。`);
  }
  const site = siteId ? await loadSite(siteId) : null;

  switch (cmd) {
    case 'audit': {
      const report = await runAudit(site!, { sample: num(args, 'sample') ?? 12 });
      if (report.findings.some((f) => f.severity === 'blocker')) process.exitCode = 2;
      break;
    }

    case 'verify': {
      const ok = await verifyEngines({
        engines: list(args, 'engines'),
        query: str(args, 'query'),
      });
      if (!ok) process.exitCode = 2;
      break;
    }

    case 'extract': {
      const source = (str(args, 'source') ?? 'sitemap') as 'sitemap' | 'supabase';
      await extractEntities(site!, {
        source,
        limitPerType: num(args, 'limit-per-type') ?? 300,
        concurrency: num(args, 'concurrency') ?? 5,
        shallow: args.shallow === true,
        proposeOnly: args.propose === true,
      });
      break;
    }

    case 'queries': {
      const sampling: Partial<Record<Tier, number>> = {};
      for (const t of ['control', 'detail', 'aggregate', 'fresh'] as Tier[]) {
        const v = num(args, t);
        if (v !== undefined) sampling[t] = v;
      }
      await generateQueries(site!, {
        paraphrase: args.paraphrase === true,
        llmThemes: args['llm-themes'] === true,
        force: args.force === true,
        sampling,
      });
      break;
    }

    case 'probe': {
      const label = str(args, 'label');
      if (!label) throw new Error('probe 需要 --label(baseline / d15 / d30)');
      const manifest = await probe(site!, {
        label,
        runId: str(args, 'run-id'),
        engines: list(args, 'engines'),
        attempts: num(args, 'attempts') ?? 2,
        concurrency: num(args, 'concurrency') ?? 3,
        limit: num(args, 'limit'),
        budgetUsd: num(args, 'budget') ?? budgetLimit(),
      });
      log.info(`\n下一步:  npm run score -- --site ${site!.id} --run ${manifest.runId}`);
      break;
    }

    case 'score': {
      const run = str(args, 'run');
      if (!run) throw new Error('score 需要 --run <run_id>');
      await scoreRun(site!, run);
      log.info(`\n下一步:  npm run report -- --site ${site!.id} --run ${run}`);
      break;
    }

    case 'report': {
      const run = str(args, 'run');
      if (!run) throw new Error('report 需要 --run <run_id>');
      await buildBaselineReport(site!, run);
      break;
    }

    case 'diff': {
      const runs = list(args, 'runs');
      if (!runs || runs.length < 2) throw new Error('diff 需要 --runs <run_id,run_id,...>(至少两个)');
      await buildDiffReport(site!, runs);
      break;
    }

    case 'fixpack': {
      await buildFixpack(site!, {
        outDir: str(args, 'out'),
        newReleaseDays: num(args, 'new-release-days') ?? 90,
        minAggregateItems: num(args, 'min-aggregate-items'),
      });
      break;
    }

    case 'indexnow': {
      if (args['generate-key'] === true) {
        const key = generateKey();
        console.log(`\nINDEXNOW_KEY=${key}\n`);
        log.info('把上面这行加进 .env,然后跑 fixpack 生成 key 文件。');
        break;
      }
      const payload = await readJson<{ key: string; urls: string[] }>(
        `${paths.fixpack('output', site!.id)}/data/indexnow-urls.json`,
      );
      if (args.submit !== true && args['dry-run'] !== true) {
        log.info(`待推送 ${payload.urls.length} 个 URL。加 --submit 真推,或 --dry-run 看看会推什么。`);
        break;
      }
      const results = await submitUrls(site!, payload.urls, {
        key: payload.key,
        dryRun: args['dry-run'] === true,
      });
      const failed = results.filter((r) => !(r.status === 200 || r.status === 202));
      if (failed.length) process.exitCode = 2;
      break;
    }

    case 'runs': {
      const runs = await listRuns();
      if (!runs.length) log.info('还没有任何 run。');
      for (const r of runs) console.log(`  ${r}`);
      break;
    }

    case 'stats': {
      const ent = await readJson<EntitiesFile>(paths.data(site!.id, 'entities.json'));
      const byType = new Map<string, number>();
      for (const e of ent.entities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      console.log(`entities: ${ent.count} (${[...byType].map(([t, c]) => `${t}=${c}`).join(', ')})`);
      break;
    }

    default:
      console.log(HELP);
      throw new Error(`未知命令: ${cmd}`);
  }
}

main().catch((e) => {
  log.error((e as Error).message);
  if (process.env.GEO_DEBUG) console.error(e);
  process.exit(1);
});
