import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { getOrder, getProduct, listProducts, openDatabase } from '../server/db.js';
import type { Product } from '../shared/types.js';
import { fixture, sessionCookie, testAddress, xhr } from './fixtures.js';

const headers = ['slug', 'name', 'category', 'brand', 'design', 'color', 'size', 'barcode', 'sku', 'price', 'stock', 'image', 'description'];
const row = (overrides: Record<string, string> = {}): Record<string, string> => ({
  slug: 'demo-white-shirt', name: 'काशी, White Shirt', category: 'Shirts', brand: 'काशी', design: 'UK-DESIGN-01', color: 'White',
  size: 'M', barcode: '000012Ab', sku: '000Sku-M', price: '1299', stock: '7', image: '/images/demo-shirt.jpg',
  description: 'Demo shirt, not real inventory', ...overrides,
});
const csv = (rows: Record<string, string>[], columns = headers) => '\uFEFF' + [columns, ...rows.map((entry) => columns.map((column) => entry[column] ?? ''))]
  .map((values) => values.map((value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')).join('\r\n');

describe('catalogue variants and atomic CSV import', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(() => f.db.close());
  const previewPath = '/api/admin/catalogue/import/preview';
  const importPath = '/api/admin/catalogue/import';
  async function imported(rows: Record<string, string>[]) {
    return f.admin.post(importPath).set(xhr).send({ csv: csv(rows) }).expect(200);
  }
  function product(slug = 'demo-white-shirt') { return listProducts(f.db, true).find((entry) => entry.slug === slug)!; }

  it('previews read-only and imports quoted commas, Hindi, BOM and leading-zero/case-sensitive identifiers', async () => {
    const rows = [row(), row({ size: 'XXL', barcode: '000013Ab', sku: '000Sku-XXL' }), row({ slug: 'demo-navy-shirt', color: 'Navy', barcode: '000014Ab' })];
    const before = listProducts(f.db, true);
    const preview = await f.admin.post(previewPath).set(xhr).send({ csv: csv(rows) }).expect(200);
    assert.deepEqual({ valid: preview.body.valid, rows: preview.body.rows, products: preview.body.products, variants: preview.body.variants }, { valid: true, rows: 3, products: 2, variants: 3 });
    assert.match(preview.body.warnings[0], /not an increment or live POS sync/);
    assert.deepEqual(listProducts(f.db, true), before);
    assert.deepEqual((await imported(rows)).body, { created: 2, updated: 0, variants: 3 });
    const white = product(); assert.equal(white.name, 'काशी, White Shirt'); assert.equal(white.brand, 'काशी'); assert.equal(white.design, 'UK-DESIGN-01');
    assert.equal(white.variants[0]!.barcode, '000012Ab'); assert.equal(white.variants[0]!.sku, '000Sku-M');
    assert.equal(white.variants.length, 2); assert.equal(product('demo-navy-shirt').color, 'Navy');
    const stored = f.db.prepare('SELECT typeof(barcode) AS kind FROM variants WHERE barcode = ?').get('000012Ab') as { kind: string };
    assert.equal(stored.kind, 'text');
  });

  it('requires admin and XHR for both routes and rejects cross-site import', async () => {
    for (const path of [previewPath, importPath]) {
      await request(f.app).post(path).set(xhr).send({ csv: csv([row()]) }).expect(401);
      await f.customer.post(path).set(xhr).send({ csv: csv([row()]) }).expect(403);
      await f.admin.post(path).send({ csv: csv([row()]) }).expect(403);
      await f.admin.post(path).set(xhr).set('Sec-Fetch-Site', 'cross-site').send({ csv: csv([row()]) }).expect(403);
    }
    assert.equal(listProducts(f.db, true).length, 12);
  });

  it('reimport is absolute, preserves omitted sizes/products, and keeps existing blank metadata', async () => {
    await imported([row(), row({ size: 'L', barcode: '000013Ab', stock: '9' })]);
    const id = product().id; const original = f.products[0]!;
    const update = row({ stock: '3', name: '', brand: '', design: '', color: '', category: '', price: '', image: '', description: '', sku: '' });
    assert.deepEqual((await imported([update])).body, { created: 0, updated: 1, variants: 1 });
    assert.deepEqual((await imported([update])).body, { created: 0, updated: 1, variants: 1 });
    const current = product(); assert.equal(current.id, id); assert.equal(current.name, 'काशी, White Shirt'); assert.equal(current.brand, 'काशी');
    assert.equal(current.variants.find(({ size }) => size === 'M')!.stock, 3);
    assert.equal(current.variants.find(({ size }) => size === 'L')!.stock, 9);
    assert.equal(current.variants.find(({ size }) => size === 'M')!.sku, '000Sku-M');
    assert.deepEqual(getProduct(f.db, original.id), original);
  });

  it('rejects duplicate group sizes/barcodes, conflicting colour/metadata and malformed CSV without writes', async () => {
    const invalid = [
      csv([row(), row({ barcode: 'different' })]),
      csv([row(), row({ size: 'L' })]),
      csv([row(), row({ size: 'L', barcode: 'different', color: 'Navy' })]),
      csv([row(), row({ size: 'L', barcode: 'different', price: '1999' })]),
      'slug,name\n"unterminated',
      csv([row()], [...headers, 'size']),
      csv([row()], headers.filter((header) => header !== 'barcode')),
    ];
    for (const text of invalid) {
      const preview = await f.admin.post(previewPath).set(xhr).send({ csv: text }).expect(200);
      assert.equal(preview.body.valid, false); assert.ok(preview.body.errors[0].row >= 1); assert.equal(typeof preview.body.errors[0].message, 'string');
      await f.admin.post(importPath).set(xhr).send({ csv: text }).expect(400);
    }
    assert.equal(listProducts(f.db, true).length, 12);
  });

  it('rejects database barcode collisions and rolls back a batch with an otherwise valid first product', async () => {
    await imported([row()]); const before = listProducts(f.db, true);
    const rows = [row({ slug: 'new-valid-shirt', barcode: 'unique-first' }), row({ slug: 'new-invalid-shirt', barcode: '000012Ab' })];
    const preview = await f.admin.post(previewPath).set(xhr).send({ csv: csv(rows) }).expect(200);
    assert.equal(preview.body.valid, false); assert.match(preview.body.errors[0].message, /already belongs/);
    await f.admin.post(importPath).set(xhr).send({ csv: csv(rows) }).expect(400);
    assert.deepEqual(listProducts(f.db, true), before);
  });

  it('revalidates at commit if another product takes a previewed barcode', async () => {
    const text = csv([row()]);
    assert.equal((await f.admin.post(previewPath).set(xhr).send({ csv: text }).expect(200)).body.valid, true);
    await f.admin.patch(`/api/admin/products/${f.products[0]!.id}`).set(xhr)
      .send({ variants: [{ size: 'M', stock: 2, barcode: '000012Ab' }] }).expect(200);
    await f.admin.post(importPath).set(xhr).send({ csv: text }).expect(400);
    assert.equal(listProducts(f.db, true).length, 12);
  });

  it('warns for explicit barcode replacement but never silently moves another variant barcode', async () => {
    await imported([row()]);
    const changed = row({ barcode: '000099New' });
    const preview = await f.admin.post(previewPath).set(xhr).send({ csv: csv([changed]) }).expect(200);
    assert.ok(preview.body.warnings.some((message: string) => message.includes('replaces an existing barcode')));
    await imported([changed]); assert.equal(product().variants[0]!.barcode, '000099New');
    await imported([row({ slug: 'other-shirt', barcode: 'other-barcode' })]);
    await f.admin.post(importPath).set(xhr).send({ csv: csv([row({ barcode: 'other-barcode' })]) }).expect(400);
    assert.equal(product().variants[0]!.barcode, '000099New');
  });

  it('accepts arbitrary safe sizes up to 30 and rejects empty, unsafe, overlength and oversized arrays', async () => {
    const sizes = ['XS', 'XXL', '3XL', '30', '32', 'Free Size'];
    await imported(sizes.map((size, index) => row({ size, barcode: `Size-${index}` })));
    assert.deepEqual(new Set(product().variants.map(({ size }) => size)), new Set(sizes));
    for (const size of ['', '<script>', 'x'.repeat(25), 'M\u0000']) {
      await f.admin.post(importPath).set(xhr).send({ csv: csv([row({ size })]) }).expect(400);
    }
    const route = `/api/admin/products/${f.products[0]!.id}`;
    await f.admin.patch(route).set(xhr).send({ variants: Array.from({ length: 30 }, (_, index) => ({ size: `Size ${index}`, stock: 1 })) }).expect(200);
    await f.admin.patch(route).set(xhr).send({ variants: Array.from({ length: 31 }, (_, index) => ({ size: `Size ${index}`, stock: 1 })) }).expect(400);
    const body = { ...f.payload(), items: [{ productId: product().id, size: 'Free Size', quantity: 1 }] };
    await f.customer.post('/api/orders').set(xhr).send(body).expect(201);
  });

  it('rejects missing new-product metadata, bad stock/price/barcode, and more than 1000 rows', async () => {
    const invalidRows: Record<string, string>[] = [{ image: '' }, { name: '' }, { category: '' }, { description: '' }, { stock: '-1' }, { stock: '1.5' }, { price: '0' }, { barcode: '' }];
    for (const invalid of invalidRows) {
      await f.admin.post(importPath).set(xhr).send({ csv: csv([row(invalid)]) }).expect(400);
    }
    const many = csv(Array.from({ length: 1001 }, (_, index) => row({ slug: `item-${index}`, barcode: `B-${index}` })));
    const result = await f.admin.post(previewPath).set(xhr).send({ csv: many }).expect(200);
    assert.equal(result.body.valid, false); assert.match(result.body.errors[0].message, /1000/);
    assert.equal(listProducts(f.db, true).length, 12);
  });

  it('replays exact-distinct Unicode sizes in any input order without another reservation', async () => {
    await imported(['Å', 'Å'].map((size, index) => row({ size, barcode: `unicode-${index}` })));
    const item = product();
    const body = { ...f.payload(), items: item.variants.map(({ size }) => ({ productId: item.id, size, quantity: 1 })) };
    const first = await f.customer.post('/api/orders').set(xhr).send(body).expect(201);
    const after = product().variants;
    const again = await f.customer.post('/api/orders').set(xhr).send({ ...body, items: [...body.items].reverse() }).expect(201);
    assert.equal(again.body.order.id, first.body.order.id);
    assert.deepEqual(product().variants, after);
  });

  it('supports import bodies over 32 KiB but enforces 2 MiB and retains normal API limits', async () => {
    const text = csv(Array.from({ length: 10 }, (_, index) => row({ slug: `large-${index}`, barcode: `large-${index}`, description: 'x'.repeat(4000) })));
    assert.ok(Buffer.byteLength(JSON.stringify({ csv: text })) > 32768);
    assert.equal((await f.admin.post(previewPath).set(xhr).send({ csv: text }).expect(200)).body.valid, true);
    await f.admin.post(importPath).set(xhr).send({ csv: 'x'.repeat(2 * 1024 * 1024) }).expect(413);
    await f.admin.post('/api/admin/products').set(xhr).send({ name: 'x'.repeat(40000) }).expect(413);
  });

  it('enforces global barcode 409 atomically in regular admin API, while blank and case-distinct barcodes remain valid', async () => {
    const first = f.products[0]!; const second = f.products[1]!;
    await f.admin.patch(`/api/admin/products/${first.id}`).set(xhr).send({ brand: 'Keep Brand', design: 'Keep Design', variants: [{ size: 'M', stock: 3, barcode: '000Ab' }, { size: 'L', stock: 2 }] }).expect(200);
    const before = getProduct(f.db, second.id)!;
    const bad = await f.admin.patch(`/api/admin/products/${second.id}`).set(xhr).send({ name: 'Must roll back', variants: [{ size: 'M', stock: 3, barcode: '000Ab' }] }).expect(409);
    assert.match(bad.body.error, /Barcode/); assert.equal(JSON.stringify(bad.body).includes('SQLITE'), false);
    assert.deepEqual(getProduct(f.db, second.id), before);
    await f.admin.patch(`/api/admin/products/${first.id}`).set(xhr).send({ price: 1000 }).expect(200);
    assert.equal(getProduct(f.db, first.id)!.brand, 'Keep Brand'); assert.equal(getProduct(f.db, first.id)!.design, 'Keep Design');
    await f.admin.patch(`/api/admin/products/${first.id}`).set(xhr).send({ variants: [{ size: 'M', stock: 5 }] }).expect(200);
    assert.equal(getProduct(f.db, first.id)!.variants[0]!.barcode, '000Ab');
    await f.admin.patch(`/api/admin/products/${second.id}`).set(xhr).send({ variants: [{ size: 'M', stock: 1, barcode: '000ab' }, { size: 'L', stock: 1, barcode: '' }] }).expect(200);
    await f.admin.patch(`/api/admin/products/${second.id}`).set(xhr).send({ variants: [{ size: 'M', stock: 1, barcode: 'duplicate' }, { size: 'L', stock: 1, barcode: 'duplicate' }] }).expect(409);
    const { id: _id, soldOutAt: _soldOutAt, archivedAt: _archivedAt, ...fields } = getProduct(f.db, first.id)!;
    await f.admin.post('/api/admin/products').set(xhr).send({ ...fields, slug: 'colliding-created-product' }).expect(409);
    assert.equal(listProducts(f.db, true).length, 12);
  });

  it('searches brand/design/colour/barcode/SKU and snapshots identifiers immutably', async () => {
    await imported([row()]); const current = product();
    for (const q of ['काशी', 'UK-DESIGN-01', 'White', '000012Ab', '000Sku-M']) {
      const results = await request(f.app).get('/api/products').query({ q }).expect(200);
      assert.ok((results.body.products as Product[]).some(({ id }) => id === current.id));
    }
    const body = { ...f.payload(), items: [{ productId: current.id, size: 'M', quantity: 1 }] };
    const order = (await f.customer.post('/api/orders').set(xhr).send(body).expect(201)).body.order;
    assert.deepEqual(Object.fromEntries(['brand', 'design', 'color', 'barcode', 'sku'].map((key) => [key, order.items[0][key]])),
      { brand: 'काशी', design: 'UK-DESIGN-01', color: 'White', barcode: '000012Ab', sku: '000Sku-M' });
    await imported([row({ name: 'Renamed', brand: 'Changed', design: 'New', color: 'Ivory', barcode: 'new-barcode', sku: 'new-sku' })]);
    assert.deepEqual(getOrder(f.db, order.id), order);
  });

  it('cancellation restores removed variant metadata and conflicts fail without partial restock or status change', async () => {
    await imported([row()]); const current = product();
    const body = { ...f.payload(), items: [{ productId: current.id, size: 'M', quantity: 2 }, { productId: f.products[0]!.id, size: 'M', quantity: 1 }] };
    const order = (await f.customer.post('/api/orders').set(xhr).send(body).expect(201)).body.order;
    const stockAfter = f.stock();
    await f.admin.patch(`/api/admin/products/${current.id}`).set(xhr).send({ variants: [{ size: 'S', stock: 1 }] }).expect(200);
    const other = f.products[1]!;
    await f.admin.patch(`/api/admin/products/${other.id}`).set(xhr).send({ variants: [{ size: 'M', stock: 1, barcode: '000012Ab' }] }).expect(200);
    await f.admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'cancelled' }).expect(409);
    assert.equal(getOrder(f.db, order.id)!.status, 'placed'); assert.equal(f.stock(), stockAfter); assert.equal(f.stock(current.id), 0);
    await f.admin.patch(`/api/admin/products/${other.id}`).set(xhr).send({ variants: [{ size: 'M', stock: 1, barcode: '' }] }).expect(200);
    await f.admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'cancelled' }).expect(200);
    const restored = getProduct(f.db, current.id)!.variants.find(({ size }) => size === 'M')!;
    assert.deepEqual(restored, { size: 'M', stock: 2, barcode: '000012Ab', sku: '000Sku-M' });
    assert.equal(f.stock(), stockAfter + 1);
  });
});

describe('v1 database migration', () => {
  it('preserves legacy orders, snapshots, idempotency, indexes, seed history and stock through sequential upgrade', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'urban-kashi-migration-'));
    const path = join(directory, 'legacy.sqlite');
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('customer','admin')),created_at TEXT NOT NULL) STRICT;
        CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL) STRICT;
        CREATE INDEX sessions_expiry ON sessions(expires_at);
        CREATE TABLE products(id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('Shirts','T-Shirts','Trousers','Kurtas','Layers')),price INTEGER NOT NULL CHECK(price > 0),originalPrice INTEGER CHECK(originalPrice >= price),color TEXT NOT NULL,description TEXT NOT NULL,details TEXT NOT NULL,image TEXT NOT NULL,images TEXT NOT NULL,badge TEXT,featured INTEGER NOT NULL CHECK(featured IN (0,1)),active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;
        CREATE TABLE variants(product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,size TEXT NOT NULL CHECK(size IN ('S','M','L','XL')),stock INTEGER NOT NULL CHECK(stock >= 0),PRIMARY KEY(product_id,size)) STRICT;
        CREATE TABLE orders(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),items TEXT NOT NULL,address TEXT NOT NULL,subtotal INTEGER NOT NULL CHECK(subtotal > 0),shipping INTEGER NOT NULL CHECK(shipping >= 0),total INTEGER NOT NULL CHECK(total = subtotal + shipping),paymentMethod TEXT NOT NULL CHECK(paymentMethod = 'COD'),status TEXT NOT NULL CHECK(status IN ('placed','confirmed','shipped','delivered','cancelled')),createdAt TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_hash TEXT NOT NULL,UNIQUE(userId,idempotency_key)) STRICT;
        CREATE INDEX orders_user_created ON orders(userId,createdAt DESC);
        CREATE TABLE seed_history(name TEXT PRIMARY KEY) STRICT;
        INSERT INTO seed_history VALUES ('demo-v1');
        PRAGMA user_version = 1;`);
      const userId = 'legacy-customer'; const productId = 'legacy-product'; const orderId = randomUUID(); const key = 'legacy-idempotency';
      const createdAt = '2025-01-01T00:00:00.000Z';
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(userId, 'Legacy User', 'legacy@example.test', 'unused-fixture-hash', 'customer', createdAt);
      db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(productId, 'legacy-shirt', 'Legacy Shirt', 'Shirts', 1000, null, 'White', 'Original description', '[]', '/images/old.jpg', '["/images/old.jpg"]', null, 0, 1);
      db.prepare('INSERT INTO variants VALUES (?,?,?)').run(productId, 'M', 4);
      const items = [{ productId, size: 'M', quantity: 1 }];
      const snapshots = JSON.stringify([{ productId, name: 'Old immutable name', image: '/images/snapshot.jpg', size: 'M', quantity: 1, price: 1000 }]);
      const hash = createHash('sha256').update(JSON.stringify({ items, address: testAddress })).digest('hex');
      db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(orderId, userId, snapshots, JSON.stringify(testAddress), 1000, 99, 1099, 'COD', 'placed', createdAt, key, hash);
      const cookie = sessionCookie(db, userId);
      db.close(); db = openDatabase(path);
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
      assert.equal(listProducts(db, true).length, 1); assert.equal(getProduct(db, productId)!.brand, '');
      assert.deepEqual(getProduct(db, productId)!.variants, [{ size: 'M', stock: 4 }]);
      const raw = db.prepare('SELECT items,payload_hash,idempotency_key FROM orders WHERE id = ?').get(orderId) as { items: string; payload_hash: string; idempotency_key: string };
      assert.deepEqual({ ...raw }, { items: snapshots, payload_hash: hash, idempotency_key: key });
      const app = createApp({ db, distPath: false, rateLimit: false, paymentGateway: null, disableMaintenance: true });
      const replay = await request(app).post('/api/orders').set(xhr).set('Cookie', cookie).send({ items, address: testAddress, idempotencyKey: key }).expect(201);
      assert.equal(replay.body.order.id, orderId); assert.equal(replay.body.order.createdAt, createdAt); assert.deepEqual(replay.body.order.items, JSON.parse(snapshots));
      assert.equal(replay.body.order.paymentStatus, 'unpaid'); assert.equal(getProduct(db, productId)!.variants[0]!.stock, 4);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[];
      for (const name of ['orders_user_created', 'sessions_expiry', 'variants_barcode_unique']) assert.ok(indexes.some((index) => index.name === name));
      db.prepare('INSERT INTO variants(product_id,size,stock,barcode,sku) VALUES (?,?,?,?,?)').run(productId, 'Free Size', 3, '000001', 'Sku');
      db.close(); db = openDatabase(path);
      assert.equal(listProducts(db, true).length, 1); assert.equal(getProduct(db, productId)!.variants.length, 2);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count, 1);
    } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});