import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** geo-v0/ 根目录。所有相对路径都从这里解析,保证在任何 cwd 下行为一致。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const paths = {
  data: (...p: string[]) => resolve(ROOT, 'data', ...p),
  report: (...p: string[]) => resolve(ROOT, 'report', ...p),
  fixpack: (...p: string[]) => resolve(ROOT, 'fixpack', ...p),
  sites: (...p: string[]) => resolve(ROOT, 'sites', ...p),
};

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

export async function readJsonOr<T>(p: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(p);
  } catch {
    return fallback;
  }
}

export async function writeJson(p: string, data: unknown, pretty = true): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, pretty ? 2 : 0) + '\n', 'utf8');
}

export async function writeText(p: string, s: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, s, 'utf8');
}

export async function listDir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

export { mkdir, readFile, writeFile };
