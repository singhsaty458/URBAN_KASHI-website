import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { listProducts, openDatabase } from '../server/db.js';
import { sanitizedCatalogue } from '../scripts/export-sanitized-database.js';

test('fresh catalogue snapshot preserves inventory but not private rows, schema or deleted bytes', async () => {
  const source = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'uk-sanitized-'));
  let clean: DatabaseSync | undefined;
  const marker = 'PRIVATE_SENTINEL_NEVER_PUBLISH';
  try {
    source.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run('private-user', marker, 'fixture@example.test', marker, 'admin', '2026-09-08');
    source.prepare('INSERT INTO sessions VALUES (?,?,?)').run(marker, 'private-user', 9999999999999);
    source.prepare(`INSERT INTO orders(id,userId,items,address,subtotal,shipping,total,paymentMethod,status,createdAt,idempotency_key,payload_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('private-order', 'private-user', '[]', marker, 100, 0, 100, 'COD', 'placed', '2026-09-08', marker, marker);
    source.prepare('INSERT INTO payment_events VALUES (?,?,?)').run('private-event', marker, '2026-09-08');
    source.prepare('INSERT INTO image_uploads VALUES (?,?,?,?)').run(marker, 100, '2026-09-08', null);
    source.exec('CREATE TABLE private_extra (secret TEXT); CREATE TABLE deleted_private (secret TEXT);');
    source.prepare('INSERT INTO private_extra VALUES (?)').run(marker);
    source.prepare('INSERT INTO deleted_private VALUES (?)').run(marker);
    source.exec('DROP TABLE deleted_private;');
    const first = listProducts(source, true)[0]!;
    source.prepare('UPDATE variants SET stock = 0 WHERE product_id = ?').run(first.id);
    source.prepare('UPDATE products SET active = 0, sold_out_at = ?, archived_at = ? WHERE id = ?')
      .run('2026-09-01T00:00:00.000Z', '2026-09-03T00:00:00.000Z', first.id);
    source.prepare('UPDATE variants SET barcode = ?, sku = ? WHERE product_id = ? AND size = ?')
      .run('000012345', 'TEST-SKU', first.id, 'M');
    const original = listProducts(source, true);
    clean = sanitizedCatalogue(source);
    assert.deepEqual(listProducts(clean, true), original);
    assert.deepEqual(listProducts(source, true), original);
    assert.equal(source.prepare('SELECT count(*) AS count FROM users').get()?.count, 1);
    for (const table of ['users', 'sessions', 'orders', 'payment_events', 'image_uploads']) {
      assert.equal(clean.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0);
    }
    assert.equal(clean.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'private_extra'").get()?.count, 0);
    const destination = join(directory, 'catalogue.sqlite');
    await backup(clean, destination);
    assert.equal(readFileSync(destination).includes(Buffer.from(marker)), false);
    const restored = openDatabase(destination);
    try {
      assert.deepEqual(listProducts(restored, true), original);
      assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { restored.close(); }
  } finally { clean?.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('rejects unknown schema and non-bundled images without changing source data', () => {
  const source = openDatabase(':memory:');
  try {
    source.exec('PRAGMA user_version = 4;');
    assert.throws(() => sanitizedCatalogue(source), /schema v3/);
    source.exec('PRAGMA user_version = 3;');
    const id = listProducts(source, true)[0]!.id;
    for (const image of ['https://example.test/photo.jpg?token=private', '/uploads/products/private.webp']) {
      source.prepare('UPDATE products SET image = ? WHERE id = ?').run(image, id);
      assert.throws(() => sanitizedCatalogue(source), /bundled/);
      assert.equal(source.prepare('SELECT image FROM products WHERE id = ?').get(id)?.image, image);
    }
  } finally { source.close(); }
});