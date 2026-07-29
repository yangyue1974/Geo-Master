import { log, progress } from '../util/log.js';
import { writeJson, readJson, paths, exists } from '../util/fsx.js';
import { createLimiter } from '../util/http.js';
import { Budget, BudgetExceeded } from '../util/budget.js';
import { budgetLimit } from '../config.js';
import { resolveEngines, type Engine } from './engines/index.js';
import type { EngineCall, QueriesFile, RunManifest, SiteProfile, Query } from '../types.js';
import { SCHEMA_VERSION } from '../types.js';

export interface ProbeOpts {
  label: string; // baseline | d15 | d30
  runId?: string;
  engines?: string[];
  attempts?: number;
  concurrency?: number;
  /** 只跑前 N 题,冒烟用 */
  limit?: number;
  budgetUsd?: number;
}

export async function probe(site: SiteProfile, opts: ProbeOpts): Promise<RunManifest> {
  const qf = await readJson<QueriesFile>(paths.data(site.id, 'queries.json'));
  const engines = resolveEngines(opts.engines);
  if (!engines.length) throw new Error('没有可用引擎。检查 API keys。');

  const runId = opts.runId ?? `${opts.label}-${new Date().toISOString().slice(0, 10)}`;
  const attempts = opts.attempts ?? 2; // spec §A4:每题每引擎跑 2 次,被引域名取并集
  const concurrency = opts.concurrency ?? 3; // spec §A4:并发 ≤ 3
  const budget = new Budget(opts.budgetUsd ?? budgetLimit());

  const queries = opts.limit ? qf.queries.slice(0, opts.limit) : qf.queries;

  log.step(`探测 run=${runId} label=${opts.label}`);
  log.info(`  题库指纹 ${qf.fingerprint} (${queries.length} 题)`);
  log.info(`  引擎: ${engines.map((e) => `${e.id}[${e.model}]`).join(', ')}`);
  log.info(`  每题每引擎 ${attempts} 次,并发 ${concurrency},预算上限 $${budget.limitUsd}`);

  const manifest: RunManifest = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    label: opts.label,
    site: site.id,
    siteDomain: site.siteDomain,
    queriesFingerprint: qf.fingerprint,
    engines: engines.map((e) => ({ id: e.id, model: e.model })),
    attemptsPerQuery: attempts,
    startedAt: new Date().toISOString(),
    costUsd: 0,
    callsOk: 0,
    callsFailed: 0,
  };
  const manifestPath = paths.data('raw', runId, 'manifest.json');
  await writeJson(manifestPath, manifest);

  // 任务展开:题 × 引擎 × 次数
  type Job = { q: Query; engine: Engine; attempt: number };
  const jobs: Job[] = [];
  for (const q of queries) {
    for (const engine of engines) {
      for (let a = 1; a <= attempts; a++) jobs.push({ q, engine, attempt: a });
    }
  }

  // 断点续跑:已落盘的调用直接跳过
  const todo: Job[] = [];
  for (const j of jobs) {
    if (await exists(callPath(runId, j.engine.id, j.q.id, j.attempt))) {
      manifest.callsOk++;
    } else {
      todo.push(j);
    }
  }
  if (todo.length < jobs.length) {
    log.info(`  断点续跑: ${jobs.length - todo.length}/${jobs.length} 已有结果,跳过`);
  }

  const limit = createLimiter(concurrency);
  const bar = progress('calls', todo.length);
  let aborted = false;

  await Promise.all(
    todo.map((job) =>
      limit(async () => {
        if (aborted) return;
        try {
          budget.assert();
        } catch (e) {
          if (e instanceof BudgetExceeded && !aborted) {
            aborted = true;
            manifest.aborted = true;
            manifest.abortReason = e.message;
            log.error(`\n预算护栏触发: ${e.message} —— 中断,已完成部分照常落盘`);
          }
          return;
        }

        const t0 = Date.now();
        let call: EngineCall;
        try {
          const res = await job.engine.ask(job.q.query);
          call = {
            schemaVersion: SCHEMA_VERSION,
            runId,
            qid: job.q.id,
            engine: job.engine.id,
            model: res.model,
            attempt: job.attempt,
            ok: true,
            answerText: res.answerText,
            citations: res.citations,
            usage: res.usage,
            latencyMs: Date.now() - t0,
            ts: new Date().toISOString(),
            raw: res.raw,
          };
          budget.add(res.usage?.costUsd);
          budget.checkWarn();
          manifest.callsOk++;
        } catch (e) {
          call = {
            schemaVersion: SCHEMA_VERSION,
            runId,
            qid: job.q.id,
            engine: job.engine.id,
            model: job.engine.model,
            attempt: job.attempt,
            ok: false,
            error: (e as Error).message.slice(0, 1000),
            answerText: '',
            citations: [],
            latencyMs: Date.now() - t0,
            ts: new Date().toISOString(),
            raw: null,
          };
          manifest.callsFailed++;
          // 失败也落盘 —— 否则断点续跑会无限重试一道注定失败的题
          budget.add(0);
        }

        await writeJson(callPath(runId, job.engine.id, job.q.id, job.attempt), call, false);
        manifest.costUsd = budget.total;
        bar.tick(`$${budget.total.toFixed(2)}`);
      }),
    ),
  );
  bar.done();

  manifest.finishedAt = new Date().toISOString();
  manifest.costUsd = budget.total;
  await writeJson(manifestPath, manifest);

  log.ok(
    `探测完成 run=${runId}: ok=${manifest.callsOk} failed=${manifest.callsFailed} 成本≈$${budget.total.toFixed(2)}` +
      (budget.unpricedCalls ? ` (其中 ${budget.unpricedCalls} 次未回传 cost,按估值计入)` : ''),
  );
  if (manifest.aborted) {
    log.warn('本轮为预算中断的不完整数据。评分与报告会显著标注,不要拿它跟完整轮次做对比。');
  }
  return manifest;
}

export function callPath(runId: string, engine: string, qid: string, attempt: number): string {
  // spec §A4 要求 data/raw/{run_id}/{engine}/{qid}.json;多次运行加 attempt 后缀
  return paths.data('raw', runId, engine, `${qid}.a${attempt}.json`);
}
