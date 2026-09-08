import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Order, Product, User, Variant } from '../shared/types.js';
import { HttpError } from './errors.js';

export type StoreDatabase = DatabaseSync;
export type UserRow = User & { password_hash: string };
type ProductRow = Omit<Product, 'details' | 'images' | 'variants' | 'featured' | 'active'> & {
  details: string; images: string; featured: number; active: number;
  sold_out_at: string | null; archived_at: string | null;
};
export type OrderRow = {
  id: string; userId: string; items: string; address: string; subtotal: number;
  shipping: number; total: number; paymentMethod: Order['paymentMethod']; status: Order['status'];
  createdAt: string; idempotency_key: string; payload_hash: string;
  payment_status: NonNullable<Order['paymentStatus']>; gateway_order_id: string | null;
  gateway_payment_id: string | null; paid_at: string | null;
  gateway_state: 'new' | 'creating' | 'ready' | 'pending_review'; payment_review: string | null;
};

const transactions = new WeakSet<StoreDatabase>();
const clocks = new WeakMap<StoreDatabase, () => number>();
export const SOLD_OUT_ARCHIVE_MS = 48 * 60 * 60 * 1000;
export const databaseNow = (db: StoreDatabase): number => (clocks.get(db) ?? Date.now)();
/** Trusted test clock; never sourced from request bodies. */
export function setDatabaseClock(db: StoreDatabase, clock: () => number): void { clocks.set(db, clock); }

export function transaction<T>(db: StoreDatabase, callback: () => T): T {
  if (transactions.has(db)) return callback();
  db.exec('BEGIN IMMEDIATE');
  transactions.add(db);
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    transactions.delete(db);
  }
}

/** Call after FINAL variant writes, in the same transaction as the stock mutation. */
export function synchronizeProductLifecycle(db: StoreDatabase, productId: string, now = databaseNow(db)): void {
  transaction(db, () => {
    const stocked = Boolean(db.prepare('SELECT 1 FROM variants WHERE product_id = ? AND stock > 0 LIMIT 1').get(productId));
    if (stocked) {
      // An archived product needs an explicit republish, never an implicit cancellation/restock.
      db.prepare('UPDATE products SET sold_out_at = NULL WHERE id = ? AND archived_at IS NULL AND sold_out_at IS NOT NULL').run(productId);
    } else {
      db.prepare('UPDATE products SET sold_out_at = ? WHERE id = ? AND sold_out_at IS NULL AND archived_at IS NULL')
        .run(new Date(now).toISOString(), productId);
    }
  });
}

/** Soft archive only. No variant, order, snapshot or image is removed. */
export function archiveSoldOutProducts(db: StoreDatabase, now = databaseNow(db)): number {
  return transaction(db, () => {
    // Initializes legacy zero-stock rows once; ordinary stocked reads cause no row writes.
    db.prepare(`UPDATE products SET sold_out_at = ? WHERE sold_out_at IS NULL AND archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM variants WHERE product_id = products.id AND stock > 0)`).run(new Date(now).toISOString());
    const result = db.prepare(`UPDATE products SET active = 0, archived_at = ?
      WHERE archived_at IS NULL AND sold_out_at IS NOT NULL AND julianday(sold_out_at) <= julianday(?)
      AND NOT EXISTS (SELECT 1 FROM variants WHERE product_id = products.id AND stock > 0)`)
      .run(new Date(now).toISOString(), new Date(now - SOLD_OUT_ARCHIVE_MS).toISOString());
    return Number(result.changes);
  });
}

/** Caller owns the connection and must close it after HTTP requests have drained. */
export function openDatabase(databasePath = process.env.DATABASE_PATH || './data/store.sqlite', options: { seed?: boolean } = {}): StoreDatabase {
  const filename = databasePath === ':memory:' ? databasePath : resolve(databasePath);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    transaction(db, () => {
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > 3) throw new Error('Database schema is newer than this server.');
      if (version === 0) {
        db.exec(`
          CREATE TABLE users (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin')),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE sessions (
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
          ) STRICT;
          CREATE INDEX sessions_expiry ON sessions(expires_at);
          CREATE TABLE products (
            id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('Shirts','T-Shirts','Trousers','Kurtas','Layers')),
            price INTEGER NOT NULL CHECK(price > 0), originalPrice INTEGER CHECK(originalPrice >= price),
            color TEXT NOT NULL, description TEXT NOT NULL, details TEXT NOT NULL,
            image TEXT NOT NULL, images TEXT NOT NULL, badge TEXT,
            featured INTEGER NOT NULL CHECK(featured IN (0,1)), active INTEGER NOT NULL CHECK(active IN (0,1))
          ) STRICT;
          CREATE TABLE variants (
            product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            size TEXT NOT NULL CHECK(size IN ('S','M','L','XL')),
            stock INTEGER NOT NULL CHECK(stock >= 0), PRIMARY KEY(product_id, size)
          ) STRICT;
          CREATE TABLE orders (
            id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
            items TEXT NOT NULL, address TEXT NOT NULL,
            subtotal INTEGER NOT NULL CHECK(subtotal > 0), shipping INTEGER NOT NULL CHECK(shipping >= 0),
            total INTEGER NOT NULL CHECK(total = subtotal + shipping),
            paymentMethod TEXT NOT NULL CHECK(paymentMethod = 'COD'),
            status TEXT NOT NULL CHECK(status IN ('placed','confirmed','shipped','delivered','cancelled')),
            createdAt TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
            UNIQUE(userId, idempotency_key)
          ) STRICT;
          CREATE INDEX orders_user_created ON orders(userId, createdAt DESC);
          CREATE TABLE seed_history (name TEXT PRIMARY KEY) STRICT;
          PRAGMA user_version = 1;
        `);
      }
      if (version < 2) {
        // Sequential v1 -> v2 migration. No foreign keys point to either rebuilt table.
        // Keep all old order JSON snapshots, timestamps, idempotency keys and hashes verbatim.
        db.exec(`
          ALTER TABLE products ADD COLUMN brand TEXT NOT NULL DEFAULT '';
          ALTER TABLE products ADD COLUMN design TEXT NOT NULL DEFAULT '';
          CREATE TABLE variants_v2 (
            product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            size TEXT NOT NULL CHECK(length(trim(size)) BETWEEN 1 AND 24),
            stock INTEGER NOT NULL CHECK(stock >= 0), barcode TEXT NOT NULL DEFAULT '', sku TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(product_id,size)
          ) STRICT;
          INSERT INTO variants_v2(product_id,size,stock) SELECT product_id,size,stock FROM variants;
          DROP TABLE variants;
          ALTER TABLE variants_v2 RENAME TO variants;
          CREATE UNIQUE INDEX variants_barcode_unique ON variants(barcode) WHERE barcode != '';
          CREATE TABLE orders_v2 (
            id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), items TEXT NOT NULL, address TEXT NOT NULL,
            subtotal INTEGER NOT NULL CHECK(subtotal > 0), shipping INTEGER NOT NULL CHECK(shipping >= 0),
            total INTEGER NOT NULL CHECK(total = subtotal + shipping),
            paymentMethod TEXT NOT NULL CHECK(paymentMethod IN ('COD','Razorpay')),
            status TEXT NOT NULL CHECK(status IN ('placed','confirmed','shipped','delivered','cancelled')),
            createdAt TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
            payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','pending','paid','refund_required','refunded')),
            gateway_order_id TEXT UNIQUE, gateway_payment_id TEXT UNIQUE, paid_at TEXT,
            gateway_state TEXT NOT NULL DEFAULT 'new' CHECK(gateway_state IN ('new','creating','ready','pending_review')),
            payment_review TEXT, UNIQUE(userId,idempotency_key)
          ) STRICT;
          INSERT INTO orders_v2(id,userId,items,address,subtotal,shipping,total,paymentMethod,status,createdAt,idempotency_key,payload_hash)
            SELECT id,userId,items,address,subtotal,shipping,total,paymentMethod,status,createdAt,idempotency_key,payload_hash FROM orders ORDER BY rowid;
          DROP TABLE orders;
          ALTER TABLE orders_v2 RENAME TO orders;
          CREATE INDEX orders_user_created ON orders(userId,createdAt DESC);
          CREATE TABLE payment_events (id TEXT PRIMARY KEY, digest TEXT NOT NULL, processed_at TEXT NOT NULL) STRICT;
          PRAGMA user_version = 2;
        `);
      }
      if (version < 3) {
        db.exec(`
          ALTER TABLE products ADD COLUMN sold_out_at TEXT;
          ALTER TABLE products ADD COLUMN archived_at TEXT;
          CREATE TABLE image_uploads (
            filename TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes > 0),
            created_at TEXT NOT NULL, unreferenced_at TEXT
          ) STRICT;
          CREATE INDEX products_lifecycle ON products(sold_out_at) WHERE archived_at IS NULL;
          PRAGMA user_version = 3;
        `);
      }
      if (options.seed !== false && !db.prepare('SELECT name FROM seed_history WHERE name = ?').get('demo-v1')) {
        // Record seeding separately: reopening never replenishes stock or recreates removed demo data.
        for (const product of demoProducts()) insertProduct(db, product);
        db.prepare('INSERT INTO seed_history(name) VALUES (?)').run('demo-v1');
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function publicUser(row: UserRow): User {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

function productFromRow(db: StoreDatabase, row: ProductRow): Product {
  const variants = db.prepare("SELECT size, stock, barcode, sku FROM variants WHERE product_id = ? ORDER BY CASE size WHEN 'S' THEN 1 WHEN 'M' THEN 2 WHEN 'L' THEN 3 WHEN 'XL' THEN 4 ELSE 5 END, size")
    .all(row.id) as unknown as Variant[];
  return {
    id: row.id, slug: row.slug, name: row.name, category: row.category, price: row.price,
    originalPrice: row.originalPrice, color: row.color, description: row.description,
    image: row.image, badge: row.badge, brand: row.brand, design: row.design,
    soldOutAt: row.sold_out_at, archivedAt: row.archived_at,
    details: JSON.parse(row.details), images: JSON.parse(row.images),
    featured: Boolean(row.featured), active: Boolean(row.active), variants: variants.map(({ barcode, sku, ...variant }) => ({
      ...variant, ...(barcode ? { barcode } : {}), ...(sku ? { sku } : {}),
    })),
  };
}
export function getProduct(db: StoreDatabase, id: string): Product | undefined {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as unknown as ProductRow | undefined;
  return row ? productFromRow(db, row) : undefined;
}
export function getProductBySlug(db: StoreDatabase, slug: string): Product | undefined {
  const row = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1 AND archived_at IS NULL').get(slug) as unknown as ProductRow | undefined;
  return row ? productFromRow(db, row) : undefined;
}
export function listProducts(db: StoreDatabase, all = false): Product[] {
  const rows = db.prepare(`SELECT * FROM products ${all ? '' : 'WHERE active = 1 AND archived_at IS NULL'} ORDER BY rowid`).all() as unknown as ProductRow[];
  return rows.map((row) => productFromRow(db, row));
}

function productValues(product: Product) {
  return [product.slug, product.name, product.category, product.price, product.originalPrice,
    product.color, product.description, JSON.stringify(product.details), product.image,
    JSON.stringify(product.images), product.badge, Number(product.featured), Number(product.active), product.brand ?? '', product.design ?? ''];
}
export function validateBarcodes(db: StoreDatabase, product: Product): void {
  const seen = new Set<string>();
  for (const variant of product.variants) {
    if (!variant.barcode) continue;
    const owner = db.prepare('SELECT product_id FROM variants WHERE barcode = ? AND product_id != ?').get(variant.barcode, product.id);
    if (owner || seen.has(variant.barcode)) throw new HttpError(409, 'Barcode already belongs to another variant. Use a unique barcode.');
    seen.add(variant.barcode);
  }
}
function writeVariants(db: StoreDatabase, product: Product): void {
  validateBarcodes(db, product);
  db.prepare('DELETE FROM variants WHERE product_id = ?').run(product.id);
  const statement = db.prepare('INSERT INTO variants(product_id, size, stock, barcode, sku) VALUES (?, ?, ?, ?, ?)');
  for (const variant of product.variants) statement.run(product.id, variant.size, variant.stock, variant.barcode ?? '', variant.sku ?? '');
}
function validateManagedImages(db: StoreDatabase, product: Product): void {
  for (const image of new Set([product.image, ...product.images])) {
    if (!image.startsWith('/uploads/')) continue;
    const filename = image.slice('/uploads/products/'.length);
    if (!image.startsWith('/uploads/products/') || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/.test(filename)
      || !db.prepare('SELECT 1 FROM image_uploads WHERE filename = ?').get(filename)) {
      throw new HttpError(409, 'An uploaded image is no longer available. Upload it again before saving.');
    }
  }
}
/** Use inside a transaction when modifying products and variants. */
export function insertProduct(db: StoreDatabase, product: Product): void {
  transaction(db, () => {
    validateManagedImages(db, product);
    db.prepare(`INSERT INTO products(slug,name,category,price,originalPrice,color,description,details,image,images,badge,featured,active,brand,design,id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...productValues(product), product.id);
    writeVariants(db, product);
    synchronizeProductLifecycle(db, product.id);
  });
}
export function updateProduct(db: StoreDatabase, product: Product, options: { republish?: boolean } = {}): void {
  transaction(db, () => {
    archiveSoldOutProducts(db);
    validateManagedImages(db, product);
    const existing = getProduct(db, product.id);
    if (existing?.archivedAt) {
      if (options.republish && !product.variants.some(({ stock }) => stock > 0)) {
        throw new HttpError(409, 'Restock at least one size before republishing an archived product.');
      }
      if (options.republish) db.prepare('UPDATE products SET archived_at = NULL, sold_out_at = NULL WHERE id = ?').run(product.id);
      else product = { ...product, active: false };
    }
    db.prepare(`UPDATE products SET slug=?,name=?,category=?,price=?,originalPrice=?,color=?,description=?,details=?,image=?,images=?,badge=?,featured=?,active=?,brand=?,design=? WHERE id=?`)
      .run(...productValues(product), product.id);
    writeVariants(db, product);
    synchronizeProductLifecycle(db, product.id);
  });
}

export function orderFromRow(row: OrderRow): Order & { paymentReview: string | null } {
  // Explicit allowlist: never expose the internal idempotency key or payload hash.
  return {
    id: row.id, userId: row.userId, items: JSON.parse(row.items), address: JSON.parse(row.address),
    subtotal: row.subtotal, shipping: row.shipping, total: row.total, paymentMethod: row.paymentMethod,
    status: row.status, createdAt: row.createdAt,
    paymentStatus: row.payment_status, gatewayOrderId: row.gateway_order_id, paidAt: row.paid_at,
    paymentReview: row.payment_review,
  };
}
export function getOrder(db: StoreDatabase, id: string): Order | undefined {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
  return row ? orderFromRow(row) : undefined;
}
export function listOrders(db: StoreDatabase, userId?: string): Order[] {
  const rows = userId === undefined
    ? db.prepare('SELECT * FROM orders ORDER BY createdAt DESC, rowid DESC').all()
    : db.prepare('SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC, rowid DESC').all(userId);
  return (rows as OrderRow[]).map(orderFromRow);
}

function demoProducts(): Product[] {
  const photos = [
    'photo-1598033129183-c4f50c736f10', 'photo-1602810318383-e386cc2a3ccf',
    'photo-1521572163474-6864f9cf17ab', 'photo-1503341504253-dff4815485f1',
    'photo-1473966968600-fa801b869a1a', 'photo-1624378439575-d8705ad7ae80',
    'photo-1598033129183-c4f50c736f10', 'photo-1602810318383-e386cc2a3ccf',
    'photo-1542272604-787c3835535d', 'photo-1544923246-77307dd654cb',
    'photo-1596755094514-f87e34085b2c', 'photo-1618354691229-88d47f285158',
  ];
  const entries: Array<[string, Product['category'], number, string]> = [
    ['The Ghat Linen Shirt', 'Shirts', 1899, 'Sand'],
    ['After Hours Oxford', 'Shirts', 1699, 'Ivory'],
    ['Everyday Heavyweight Tee', 'T-Shirts', 799, 'Chalk'],
    ['Midnight Oversized Tee', 'T-Shirts', 899, 'Washed Black'],
    ['Easy Pleated Trousers', 'Trousers', 2199, 'Stone'],
    ['City Straight Chinos', 'Trousers', 1999, 'Olive'],
    ['Banaras Cotton Kurta', 'Kurtas', 2299, 'Ecru'],
    ['Evening Mandarin Kurta', 'Kurtas', 2599, 'Charcoal'],
    ['Utility Denim Overshirt', 'Layers', 2999, 'Indigo'],
    ['Soft Structure Jacket', 'Layers', 3499, 'Taupe'],
    ['Sunday Resort Shirt', 'Shirts', 1499, 'Sage'],
    ['Essential Ribbed Tee', 'T-Shirts', 999, 'Ink'],
  ];
  return entries.map(([name, category, price, color], index) => {
    const image = `/images/${photos[index]}.jpg`;
    return {
      id: randomUUID(), slug: name.toLowerCase().replaceAll(' ', '-'), name, category, price,
      originalPrice: price + 400, color,
      description: `${name}: an understated ${color.toLowerCase()} essential for slow mornings and city evenings. Demo catalogue item; imagery and inventory are placeholders.`,
      details: ['Relaxed modern silhouette', 'Demo material and fit information — verify before purchase', 'Gentle cold wash; dry in shade'],
      image, images: [image], badge: index < 3 ? 'New arrival' : null,
      featured: index < 6, active: true,
      variants: ['S', 'M', 'L', 'XL'].map((size, sizeIndex) => ({ size, stock: [8, 14, 12, 6][sizeIndex]! })),
    };
  });
}