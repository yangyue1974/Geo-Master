/**
 * 全局类型。所有落盘 JSON 的形状都定义在这里 —— 复测可比性依赖 schema 稳定。
 * 改动任何已落盘结构时,必须同步 SCHEMA_VERSION,否则 diff 会静默地比错东西。
 */

export const SCHEMA_VERSION = 1;

export type Tier = 'control' | 'detail' | 'aggregate' | 'fresh';

export const TIERS: Tier[] = ['control', 'detail', 'aggregate', 'fresh'];

export type EngineId = 'perplexity-sonar-pro' | 'openai-search' | 'gemini-grounded';

export type TemplateId =
  | 'who-is'
  | 'song-album'
  | 'release'
  | 'chronology'
  | 'credits'
  | 'year-list'
  | 'theme'
  | 'collab'
  | 'latest'
  | 'new-releases';

/**
 * 时效性分类 —— spec 原文没有这一层,但 fresh 档必须拆。
 *  none            : 与时间无关,前后完全可比
 *  entity-relative : "{artist} 的最新单曲" —— 实体固定,语义随时间漂移但仍可比
 *  window          : "本月新发行" —— Day 0 与 Day 30 问的不是同一件事,不可严格比较
 */
export type TimeSensitivity = 'none' | 'entity-relative' | 'window';

// ---------------------------------------------------------------- A1 实体

export interface EntityFacts {
  /** 只放确实抽到的事实。缺就不写 —— 下游严禁补全。 */
  artist?: string;
  albums?: { name: string; year?: string; url?: string }[];
  tracks?: { name: string; url?: string }[];
  datePublished?: string;
  genre?: string[];
  sameAs?: string[];
  description?: string;
  /** 事实来源,用于判断可信度: jsonld > microdata > heuristic */
  _source?: ('jsonld' | 'microdata' | 'heuristic' | 'db')[];
}

export interface Entity {
  type: string; // artist | album | song | ...(由 site profile 的 entityPatterns 决定)
  name: string;
  url: string;
  aliases: string[];
  facts?: EntityFacts;
}

export interface EntitiesFile {
  schemaVersion: number;
  site: string;
  source: 'sitemap' | 'supabase';
  generatedAt: string;
  count: number;
  entities: Entity[];
}

// ---------------------------------------------------------------- A3 题库

export interface Query {
  id: string;
  tier: Tier;
  template: TemplateId;
  /** 主实体名。aggregate 的 year-list / new-releases 类题目没有主实体,为 null。 */
  entity: string | null;
  entityUrl?: string;
  query: string;
  timeSensitivity: TimeSensitivity;
  /** 生成这道题所依赖的事实,用于事后审计"这题是不是凭空造的" */
  basis?: Record<string, string>;
}

export interface QueriesFile {
  schemaVersion: number;
  site: string;
  generatedAt: string;
  /** 题库冻结指纹。基线与所有复测必须一致,否则 diff 拒绝运行。 */
  fingerprint: string;
  counts: Record<Tier, number>;
  queries: Query[];
}

// ---------------------------------------------------------------- A4 探测

export interface Citation {
  url: string;
  domain: string;
  title?: string;
  /** 提取路径,用于审计 extractor 是否走对了字段 */
  via: string;
}

export interface EngineCall {
  schemaVersion: number;
  runId: string;
  qid: string;
  engine: EngineId;
  model: string;
  attempt: number; // 1 | 2
  ok: boolean;
  error?: string;
  answerText: string;
  citations: Citation[];
  usage?: { costUsd?: number; promptTokens?: number; completionTokens?: number };
  latencyMs: number;
  ts: string;
  /** 原始响应完整落盘,便于事后审计 */
  raw: unknown;
}

export interface RunManifest {
  schemaVersion: number;
  runId: string;
  label: string; // baseline | d15 | d30 | ...
  site: string;
  siteDomain: string;
  queriesFingerprint: string;
  engines: { id: EngineId; model: string }[];
  attemptsPerQuery: number;
  startedAt: string;
  finishedAt?: string;
  /** 预算护栏触发时为 true,报告必须显著标注结果不完整 */
  aborted?: boolean;
  abortReason?: string;
  costUsd: number;
  callsOk: number;
  callsFailed: number;
}

// ---------------------------------------------------------------- A5 评分

export type CiteStatus = 'cited' | 'mentioned' | 'absent';

export interface QueryEngineScore {
  qid: string;
  tier: Tier;
  template: TemplateId;
  engine: EngineId;
  status: CiteStatus;
  score: 1 | 0.5 | 0;
  /** 目标站被引的具体 URL(并集) */
  citedUrls: string[];
  /** 本题所有被引域名(两次并集) */
  domains: string[];
  /**
   * 两次运行被引域名集合的 Jaccard 一致率。
   * 这是噪声底噪的直接测量 —— 小于它的前后变化不能称为结论。
   * 只跑了一次或全部失败时为 null。
   */
  agreement: number | null;
  attempts: number;
  failed: number;
}

export interface TierEngineCell {
  tier: Tier;
  engine: EngineId;
  n: number;
  cited: number;
  mentioned: number;
  absent: number;
  /** (cited*1 + mentioned*0.5) / n */
  citationRate: number;
  /** cited / n —— 硬指标,汇报时以这个为准 */
  hardCitationRate: number;
}

export interface DomainStat {
  domain: string;
  hits: number;
  queries: number;
  tiers: Partial<Record<Tier, number>>;
}

export interface ScoresFile {
  schemaVersion: number;
  runId: string;
  label: string;
  site: string;
  siteDomain: string;
  queriesFingerprint: string;
  generatedAt: string;
  manifest: RunManifest;
  matrix: TierEngineCell[];
  /** 对手榜:被引域名按频次排序 */
  competitors: DomainStat[];
  /** control 档单独的对手榜 —— 尺子漂移检测器 */
  controlCompetitors: DomainStat[];
  /** 全局噪声底噪:所有题 agreement 的中位数 */
  noiseFloor: { medianAgreement: number | null; sampleSize: number };
  perQuery: QueryEngineScore[];
}

// ---------------------------------------------------------------- 站点 profile

export interface EntityPattern {
  type: string;
  /** glob 风格: /artist/* 。* 匹配单个路径段,** 匹配多段。 */
  pattern: string;
}

export interface SiteProfile {
  id: string;
  siteName: string;
  siteDomain: string;
  /** 正文提及判定用的站名变体(mentioned=0.5 的判据)。大小写不敏感。 */
  nameVariants: string[];
  sitemap: string;
  entityPatterns: EntityPattern[];
  /** 垂直领域描述,用于题库措辞。noun 会填进 "What {noun} albums came out in {year}?" */
  vertical: {
    noun: string;
    themes?: string[];
  };
  sampling: Partial<Record<Tier, number>>;
  /**
   * 聚合页的路径模板。
   *
   * 必须可配置:默认值 `/releases/{year}` 在某些站点上会与已有的实体页命名空间撞车
   * (GospelHub 的专辑详情页就是 `/releases/{uuid}`)。撞车的后果是新页面被现有路由吃掉,
   * 而且实体抽取会把聚合页当成实体 —— 两个都不会报错,只会静默地测错东西。
   * buildFixpack 会主动检查冲突并拒绝生成。
   */
  aggregatePaths?: {
    /** 含 {year} */
    year?: string;
    /** 含 {theme} */
    theme?: string;
    /** 含 {artist} */
    collab?: string;
    /** fresh 档的新发行页 */
    newReleases?: string;
  };
  /** 可选:db 捷径模式的表映射 */
  supabase?: {
    tables: { type: string; table: string; nameColumn: string; urlTemplate: string }[];
  };
  /** llms.txt 用的一句话自述 */
  tagline?: string;
  coverage?: string;
}
