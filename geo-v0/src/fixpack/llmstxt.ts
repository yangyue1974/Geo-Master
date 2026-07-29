import type { Entity, SiteProfile } from '../types.js';

/**
 * B2 llms.txt。
 *
 * 一句话自述 + 覆盖范围说明 + 顶层实体索引。
 * llms.txt 是个约定俗成的格式,不是标准,所以别指望它单独带来引用 ——
 * 它的作用是当抓取器/人类确实来看的时候,能一眼看清这个库覆盖什么、结构长什么样。
 */

export function buildLlmsTxt(site: SiteProfile, entities: Entity[]): string {
  const origin = new URL(site.sitemap).origin;
  const byType = groupByType(entities);
  const L: string[] = [];

  L.push(`# ${site.siteName}`);
  L.push('');
  if (site.tagline) {
    L.push(`> ${site.tagline}`);
    L.push('');
  }
  if (site.coverage) {
    L.push(site.coverage);
    L.push('');
  }

  L.push('## Coverage');
  L.push('');
  for (const [type, list] of byType) {
    L.push(`- **${cap(type)}s**: ${list.length}`);
  }
  const years = collectYears(entities);
  if (years.length) {
    L.push(`- **Release years covered**: ${years[years.length - 1]}–${years[0]}`);
  }
  L.push('');
  L.push(`Sitemap: ${site.sitemap}`);
  L.push('');

  L.push('## Index');
  L.push('');
  for (const [type, list] of byType) {
    L.push(`### ${cap(type)}s`);
    L.push('');
    // 顶层索引只放代表性实体,完整清单在 llms-full.txt
    for (const e of list.slice(0, 50)) {
      L.push(`- [${e.name}](${e.url})${describe(e)}`);
    }
    if (list.length > 50) {
      L.push(`- …and ${list.length - 50} more — see [llms-full.txt](${origin}/llms-full.txt)`);
    }
    L.push('');
  }

  L.push('## Aggregate pages');
  L.push('');
  L.push('These pages answer cross-entity questions directly:');
  L.push('');
  for (const y of years.slice(0, 10)) {
    L.push(`- [${site.vertical.noun} releases in ${y}](${origin}/releases/${y})`);
  }
  L.push(`- [New releases](${origin}/new-releases) — updated monthly`);
  L.push('');

  L.push('## Notes');
  L.push('');
  L.push('- All facts on this site come from the database. Fields with no data are omitted rather than guessed.');
  L.push(`- Last generated: ${new Date().toISOString().slice(0, 10)}`);
  L.push('');

  return L.join('\n');
}

export function buildLlmsFullTxt(site: SiteProfile, entities: Entity[]): string {
  const L: string[] = [];
  L.push(`# ${site.siteName} — full entity index`);
  L.push('');
  if (site.tagline) L.push(`> ${site.tagline}`, '');
  L.push(`Total entities: ${entities.length}`);
  L.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  L.push('');
  for (const [type, list] of groupByType(entities)) {
    L.push(`## ${cap(type)}s (${list.length})`);
    L.push('');
    for (const e of list) L.push(`- [${e.name}](${e.url})${describe(e)}`);
    L.push('');
  }
  return L.join('\n');
}

function describe(e: Entity): string {
  const bits: string[] = [];
  if (e.facts?.artist) bits.push(`by ${e.facts.artist}`);
  const y = e.facts?.datePublished?.match(/\b(19|20)\d{2}\b/)?.[0];
  if (y) bits.push(y);
  return bits.length ? ` — ${bits.join(', ')}` : '';
}

function groupByType(entities: Entity[]): [string, Entity[]][] {
  const m = new Map<string, Entity[]>();
  for (const e of entities) {
    if (!m.has(e.type)) m.set(e.type, []);
    m.get(e.type)!.push(e);
  }
  for (const [, v] of m) v.sort((a, b) => a.name.localeCompare(b.name));
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

function collectYears(entities: Entity[]): string[] {
  const s = new Set<string>();
  for (const e of entities) {
    const y = e.facts?.datePublished?.match(/\b(19|20)\d{2}\b/)?.[0];
    if (y) s.add(y);
    for (const a of e.facts?.albums ?? []) if (a.year) s.add(a.year);
  }
  return [...s].sort().reverse();
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
