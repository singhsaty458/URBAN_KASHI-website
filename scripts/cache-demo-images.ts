/** Downloads demo-only Unsplash photography as local binary assets. No customer data leaves this process. */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const sources = await Promise.all(['server/db.ts', 'src/pages/Home.tsx'].map(file => readFile(resolve(root, file), 'utf8')));
const ids = [...new Set(sources.flatMap(source => [...source.matchAll(/photo-\d+-[a-f0-9]+/g)].map(match => match[0])))];
await mkdir(resolve(root, 'public/images'), { recursive: true });
let failures = 0;
for (const id of ids) {
  const target = resolve(root, 'public/images', `${id}.jpg`);
  if (await stat(target).then(result => result.size > 0, () => false)) continue;
  try {
    const response = await fetch(`https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=85&fm=jpg`, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error(`HTTP ${response.status}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    console.info(`Cached ${id}`);
  } catch (error) { failures++; console.error(`Could not download ${id}: ${error instanceof Error ? error.message : 'unknown error'}`); }
}
console.info(`${ids.length} demo asset references checked; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;