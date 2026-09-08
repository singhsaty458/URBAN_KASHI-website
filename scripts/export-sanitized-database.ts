import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { insertProduct, listProducts, openDatabase, transaction, type StoreDatabase } from '../server/db.js';

/** Build from trusted schema and catalogue-only rows, never copy/delete from a private backup. */
export function sanitizedCatalogue(source: StoreDatabase): StoreDatabase {
  const clean = openDatabase(':memory:', { seed: false });
  try {
    source.exec('BEGIN');
    try {
      const version = source.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 3) throw new Error('Only website schema v3 is supported; the source is never migrated.');
      const products = listProducts(source, true);
      transaction(clean, () => {
        for (const product of products) {
          // Do not publish signed remote URLs, embedded credentials, or broken private upload references.
          for (const image of [product.image, ...product.images]) {
            if (!/^\/images\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp|svg)$/.test(image)) {
              throw new Error('Export requires bundled /images/ assets. Review and sanitize other product imagery separately.');
            }
          }
          insertProduct(clean, product);
          clean.prepare('UPDATE products SET sold_out_at = ?, archived_at = ? WHERE id = ?')
            .run(product.soldOutAt ?? null, product.archivedAt ?? null, product.id);
        }
        // A restored snapshot must not gain additional demo products on first startup.
        clean.prepare('INSERT INTO seed_history(name) VALUES (?)').run('demo-v1');
      });
      source.exec('COMMIT');
    } catch (error) {
      source.exec('ROLLBACK');
      throw error;
    }
    for (const table of ['users', 'sessions', 'orders', 'payment_events', 'image_uploads']) {
      if (clean.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count !== 0) {
        throw new Error('Sanitized export unexpectedly contains private records.');
      }
    }
    if (clean.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
      || clean.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('Sanitized database failed integrity checks.');
    }
    return clean;
  } catch (error) {
    clean.close();
    throw error;
  }
}

async function main(): Promise<void> {
  // Deliberately ignore dotenv/DATABASE_PATH: this command may only read this website's default DB.
  const root = realpathSync(resolve(import.meta.dirname, '..'));
  const dataRoot = resolve(root, 'data');
  const filename = resolve(dataRoot, 'store.sqlite');
  if (realpathSync(dataRoot) !== dataRoot || realpathSync(filename) !== filename) {
    throw new Error('Refusing a redirected website database path.');
  }
  const destinationRoot = resolve(root, 'seed');
  mkdirSync(destinationRoot, { recursive: true });
  if (realpathSync(destinationRoot) !== destinationRoot) throw new Error('Refusing a redirected export directory.');
  const destination = resolve(destinationRoot, 'catalogue.sqlite');
  if (existsSync(destination)) throw new Error('Export already exists. Review/remove that generated snapshot before exporting again.');
  const source = new DatabaseSync(filename, { readOnly: true });
  let clean: StoreDatabase | undefined;
  try {
    source.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    clean = sanitizedCatalogue(source);
    await backup(clean, destination);
    const products = clean.prepare('SELECT count(*) AS count FROM products').get()?.count;
    const variants = clean.prepare('SELECT count(*) AS count FROM variants').get()?.count;
    console.info(`Sanitized snapshot created: ${products} products, ${variants} variants; zero accounts, sessions, orders, payment events or upload records.`);
  } finally {
    clean?.close();
    source.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch { console.error('Sanitized export failed. Check source schema, bundled image paths, destination and permissions; private data was not logged.'); process.exitCode = 1; }
}