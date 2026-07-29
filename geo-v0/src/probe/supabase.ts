import { fetchJson } from '../util/http.js';
import { log } from '../util/log.js';
import { env } from '../config.js';
import { normalizeUrl } from '../util/url.js';
import type { Entity, SiteProfile, EntityFacts } from '../types.js';

/**
 * db 捷径模式 —— 仅 GospelHub 自用。
 *
 * 刻意用 PostgREST 裸 HTTP 而非 @supabase/supabase-js:
 * 这条路径是捷径,不该为它给主路径增加一个依赖。
 *
 * 注意:sitemap 模式才是主路径。这里拿到的事实更全,会让 detail 档题目更多,
 * 但那不代表 sitemap 模式坏了 —— 它代表站点的公开页缺结构化数据,那正是 B5 要报告的问题。
 */
export async function extractFromSupabase(site: SiteProfile): Promise<Entity[]> {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('db 捷径模式需要 SUPABASE_URL 与 SUPABASE_SERVICE_KEY');
  if (!site.supabase?.tables?.length) {
    throw new Error(`site profile ${site.id} 没有 supabase.tables 映射`);
  }

  const out: Entity[] = [];
  for (const t of site.supabase.tables) {
    const endpoint = `${url.replace(/\/$/, '')}/rest/v1/${t.table}?select=*`;
    log.info(`  supabase: ${t.table} → type=${t.type}`);
    const rows = await fetchJson<Record<string, unknown>[]>(endpoint, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      timeoutMs: 60_000,
    });
    for (const row of rows) {
      const name = String(row[t.nameColumn] ?? '').trim();
      if (!name) continue;
      const entityUrl = normalizeUrl(renderTemplate(t.urlTemplate, row));
      if (!entityUrl) continue;
      out.push({
        type: t.type,
        name,
        url: entityUrl,
        aliases: [],
        facts: factsFromRow(row),
      });
    }
    log.ok(`  supabase: ${t.table} → ${rows.length} 行`);
  }
  return out;
}

function renderTemplate(tpl: string, row: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(row[k] ?? '')));
}

/**
 * 从 db 行提取事实。只搬运确实存在的列,不推断。
 * 列名按常见命名试探 —— 认不出的列直接丢弃,不猜。
 */
function factsFromRow(row: Record<string, unknown>): EntityFacts {
  const f: EntityFacts = { _source: ['db'] };
  const str = (k: string) => {
    const v = row[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };

  const artist = str('artist') ?? str('artist_name') ?? str('performer');
  if (artist) f.artist = artist;

  const date = str('release_date') ?? str('released_at') ?? str('date_published') ?? str('year');
  if (date) f.datePublished = date;

  const genre = row['genre'] ?? row['genres'];
  if (typeof genre === 'string' && genre.trim()) f.genre = [genre.trim()];
  else if (Array.isArray(genre)) f.genre = genre.filter((g): g is string => typeof g === 'string');

  const desc = str('description') ?? str('bio') ?? str('summary');
  if (desc) f.description = desc.slice(0, 600);

  return f;
}
