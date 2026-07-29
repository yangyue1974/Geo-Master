import { log } from './log.js';

/** 普通抓取用的 UA。B5 体检里另有 bot UA,见 fixpack/audit.ts。 */
export const DEFAULT_UA =
  'Mozilla/5.0 (compatible; geo-v0-probe/0.1; +https://github.com/yangyue1974/Geo-Master)';

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  /** 这些状态码不重试,直接返回(比如 404) */
  noRetryStatus?: number[];
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 带指数退避重试的 fetch。
 * 退避序列: 1s, 2s, 4s, 8s (+ 0-500ms jitter)。429 尊重 Retry-After。
 */
export async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { retries = 4, timeoutMs = 120_000, noRetryStatus = [], ...rest } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: rest.method ?? 'GET',
        headers: { 'user-agent': DEFAULT_UA, ...(rest.headers ?? {}) },
        body: rest.body,
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);

      if (res.ok || noRetryStatus.includes(res.status)) return res;

      // 4xx(除 408/429)是请求本身的问题,重试无意义
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        const body = await res.text().catch(() => '');
        /*
         * 响应体进 message。上游对"型号不存在""参数不认""key 没权限"往往一律回 4xx,
         * 只报状态码等于把唯一有用的信息丢掉,然后靠人一轮轮猜。
         */
        throw new HttpError(
          `HTTP ${res.status} ${url}\n    ${body.replace(/\s+/g, ' ').slice(0, 600)}`,
          res.status,
          body.slice(0, 2000),
        );
      }

      const body = await res.text().catch(() => '');
      lastErr = new HttpError(`HTTP ${res.status} ${url}`, res.status, body.slice(0, 2000));

      if (attempt === retries) break;
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt + Math.random() * 500;
      log.warn(`${res.status} on ${short(url)}, retry ${attempt + 1}/${retries} in ${Math.round(wait)}ms`);
      await sleep(wait);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (attempt === retries) break;
      const wait = 1000 * 2 ** attempt + Math.random() * 500;
      log.warn(`${(e as Error).message} on ${short(url)}, retry ${attempt + 1}/${retries} in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${short(url)}: ${text.slice(0, 400)}`);
  }
}

function short(url: string): string {
  return url.length > 80 ? url.slice(0, 77) + '...' : url;
}

/** 并发闸门。active 计数在获得许可时才 ++,保证不超发。 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** 有序 map + 并发上限。结果顺序与输入一致。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}
