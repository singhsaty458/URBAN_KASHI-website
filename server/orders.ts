import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Order, OrderItem } from '../shared/types.js';
import { archiveSoldOutProducts, getOrder, getProduct, orderFromRow, synchronizeProductLifecycle, transaction, type OrderRow, type StoreDatabase } from './db.js';
import { HttpError } from './errors.js';
import { checkoutSchema } from './validation.js';

/** Synchronous transaction only: never hold a SQLite transaction across a network await. */
export function reserveOrder(db: StoreDatabase, userId: string, input: z.infer<typeof checkoutSchema>, method: Order['paymentMethod']): Order {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const items = [...input.items].sort((a, b) => compare(a.productId, b.productId) || compare(a.size, b.size));
  // Exact variant identity needs a total, locale-independent sort. Accept the old
  // hash on replay so existing v1 COD orders are not invalidated by this change.
  const hash = createHash('sha256').update(JSON.stringify({ items, address: input.address })).digest('hex');
  return transaction(db, () => {
    archiveSoldOutProducts(db);
    const existing = db.prepare('SELECT * FROM orders WHERE userId = ? AND idempotency_key = ?').get(userId, input.idempotencyKey) as OrderRow | undefined;
    if (existing) {
      const legacyItems = [...input.items].sort((a, b) => a.productId.localeCompare(b.productId) || a.size.localeCompare(b.size));
      const legacyHash = createHash('sha256').update(JSON.stringify({ items: legacyItems, address: input.address })).digest('hex');
      if ((existing.payload_hash !== hash && existing.payload_hash !== legacyHash) || existing.paymentMethod !== method) throw new HttpError(409, 'Idempotency key already used for a different order.');
      return orderFromRow(existing);
    }
    const snapshot: OrderItem[] = [];
    for (const item of items) {
      const product = getProduct(db, item.productId);
      if (!product || !product.active || product.archivedAt) throw new HttpError(409, 'A product is no longer available.');
      const variant = product.variants.find(({ size }) => size === item.size);
      const result = db.prepare('UPDATE variants SET stock = stock - ? WHERE product_id = ? AND size = ? AND stock >= ?')
        .run(item.quantity, item.productId, item.size, item.quantity);
      if (!variant || Number(result.changes) !== 1) throw new HttpError(409, `Insufficient stock for ${product.name} (${item.size}).`);
      snapshot.push({ productId: product.id, name: product.name, image: product.image, size: item.size,
        quantity: item.quantity, price: product.price, color: product.color, brand: product.brand ?? '', design: product.design ?? '',
        barcode: variant.barcode ?? '', sku: variant.sku ?? '' });
    }
    for (const productId of new Set(items.map(({ productId }) => productId))) synchronizeProductLifecycle(db, productId);
    const subtotal = snapshot.reduce((sum, item) => sum + item.quantity * item.price, 0);
    const shipping = subtotal >= 2499 ? 0 : 99;
    const id = randomUUID();
    db.prepare(`INSERT INTO orders(id,userId,items,address,subtotal,shipping,total,paymentMethod,status,createdAt,idempotency_key,payload_hash,payment_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, JSON.stringify(snapshot), JSON.stringify(input.address), subtotal, shipping,
      subtotal + shipping, method, 'placed', new Date().toISOString(), input.idempotencyKey, hash, method === 'COD' ? 'unpaid' : 'pending');
    return getOrder(db, id)!;
  });
}

/** Inside cancellation transaction. Never silently attribute returned stock to a changed barcode/SKU. */
export function restoreOrderStock(db: StoreDatabase, order: Order): void {
  const current = getOrder(db, order.id);
  if (!current || !['placed', 'confirmed'].includes(current.status)) throw new HttpError(409, 'Order stock cannot be restored in this state.');
  archiveSoldOutProducts(db);
  for (const item of order.items) {
    const variant = db.prepare('SELECT barcode,sku FROM variants WHERE product_id = ? AND size = ?').get(item.productId, item.size) as { barcode: string; sku: string } | undefined;
    if (!variant && (db.prepare('SELECT COUNT(*) AS count FROM variants WHERE product_id = ?').get(item.productId) as { count: number }).count >= 30) {
      throw new HttpError(409, 'Cannot restore a removed size above the 30-size limit. Resolve the catalogue before cancellation.');
    }
    if (variant && ((item.barcode && variant.barcode && item.barcode !== variant.barcode) || (item.sku && variant.sku && item.sku !== variant.sku))) {
      throw new HttpError(409, 'Variant identity changed since checkout. Resolve its barcode/SKU before cancellation. No stock was restored.');
    }
    const barcode = variant?.barcode || item.barcode || '';
    const sku = variant?.sku || item.sku || '';
    if (barcode && db.prepare('SELECT product_id FROM variants WHERE barcode = ? AND NOT (product_id = ? AND size = ?)').get(barcode, item.productId, item.size)) {
      throw new HttpError(409, 'Cannot restore the removed variant: its barcode is now assigned elsewhere. Resolve the conflict first.');
    }
    db.prepare(`INSERT INTO variants(product_id,size,stock,barcode,sku) VALUES (?,?,?,?,?)
      ON CONFLICT(product_id,size) DO UPDATE SET stock = stock + excluded.stock, barcode = excluded.barcode, sku = excluded.sku`)
      .run(item.productId, item.size, item.quantity, barcode, sku);
  }
  for (const productId of new Set(order.items.map(({ productId }) => productId))) synchronizeProductLifecycle(db, productId);
}