import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import type { ImportPreview, Product } from '../shared/types.js';
import { archiveSoldOutProducts, insertProduct, listProducts, transaction, updateProduct, type StoreDatabase } from './db.js';
import { productSchema, validateProductPrices } from './validation.js';

export const csvBodySchema = z.object({ csv: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 2 * 1024 * 1024, 'CSV exceeds 2 MiB.') }).strict();
const requiredHeaders = ['slug', 'name', 'category', 'brand', 'design', 'color', 'size', 'barcode', 'sku', 'price', 'stock', 'image', 'description'];
const metadata = ['name', 'category', 'brand', 'design', 'color', 'price', 'image', 'description', 'originalPrice', 'images', 'details', 'badge', 'active', 'featured'];
const permittedHeaders = new Set([...requiredHeaders, ...metadata]);
const warning = 'Stock is absolute website-allocated stock, not an increment or live POS sync. Re-importing resets supplied sizes to the CSV stock; account for reservations before importing.';
type Planned = { product: Product; existing: boolean; republish: boolean };
type Plan = { preview: ImportPreview; changes: Planned[] };

/** Read-only planner, also rerun under BEGIN IMMEDIATE immediately before a commit. */
export function planCatalogueImport(db: StoreDatabase, csv: string): Plan {
  const preview: ImportPreview = { valid: false, rows: 0, products: 0, variants: 0, errors: [], warnings: [warning] };
  const changes: Planned[] = [];
  const error = (row: number, message: string) => preview.errors.push({ row, message });
  let records: string[][];
  try {
    if (Buffer.byteLength(csv, 'utf8') > 2 * 1024 * 1024) throw new Error();
    records = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 2 * 1024 * 1024, cast: false }) as string[][];
  } catch { error(1, 'Malformed CSV, inconsistent column count, unclosed quote, or file exceeds 2 MiB.'); return { preview, changes }; }
  const headers = records.shift()?.map((value) => value.trim()) ?? [];
  preview.rows = records.length;
  if (records.length === 0 || records.length > 1000) error(1, 'CSV must contain between 1 and 1000 data rows.');
  if (new Set(headers).size !== headers.length) error(1, 'Duplicate CSV headers are not allowed.');
  for (const key of requiredHeaders) if (!headers.includes(key)) error(1, `Missing required header: ${key}.`);
  for (const key of headers) if (!permittedHeaders.has(key)) error(1, `Unknown header: ${key}.`);
  if (preview.errors.length) return { preview, changes };
  const existingProducts = listProducts(db, true);
  const bySlug = new Map(existingProducts.map((product) => [product.slug, product]));
  const barcodeOwners = new Map<string, { slug: string; size: string }>();
  for (const product of existingProducts) for (const variant of product.variants) {
    if (variant.barcode) barcodeOwners.set(variant.barcode, { slug: product.slug, size: variant.size });
  }
  const groups = new Map<string, { row: number; fields: Record<string, string> }[]>();
  const seenBarcodes = new Set<string>();
  for (const [index, values] of records.entries()) {
    const row = index + 2; // Logical CSV record number; quoted multiline fields count as one record.
    const fields = Object.fromEntries(headers.map((key, i) => [key, values[i]?.trim() ?? '']));
    const slug = fields.slug!;
    const barcode = fields.barcode!;
    if (!barcode) error(row, 'Barcode is required for every imported size; keep it as text.');
    else {
      if (seenBarcodes.has(barcode)) error(row, 'Duplicate barcode in this CSV.');
      seenBarcodes.add(barcode);
      const owner = barcodeOwners.get(barcode);
      if (owner && (owner.slug !== slug || owner.size !== fields.size)) error(row, 'Barcode already belongs to another product/size in the website catalogue.');
    }
    const group = groups.get(slug) ?? [];
    if (group.some(({ fields: other }) => other.size === fields.size)) error(row, 'Duplicate size for this slug.');
    if (group[0] && metadata.some((key) => group[0]!.fields[key] !== fields[key])) error(row, 'Conflicting product metadata within one slug. Use a different slug for each design/colour.');
    group.push({ row, fields }); groups.set(slug, group);
  }
  preview.products = groups.size;
  preview.variants = records.length;
  for (const [slug, rows] of groups) {
    const first = rows[0]!;
    const fields = first.fields;
    const existing = bySlug.get(slug);
    const value: Record<string, unknown> = existing ? { ...existing } : {
      id: randomUUID(), slug, originalPrice: null, details: [], images: [], badge: null,
      featured: false, active: true, brand: '', design: '',
    };
    value.slug = slug;
    for (const key of metadata) {
      const raw = fields[key];
      // Blank metadata cells preserve existing data. New products still must pass the schema.
      if (raw === undefined || raw === '') continue;
      if (['price', 'originalPrice'].includes(key)) value[key] = raw === 'null' && key === 'originalPrice' ? null : /^\d+$/.test(raw) ? Number(raw) : NaN;
      else if (key === 'active' || key === 'featured') value[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
      else if (key === 'images' || key === 'details') {
        try { value[key] = JSON.parse(raw); } catch { error(first.row, `${key} must be a JSON array in a quoted CSV cell.`); }
      } else value[key] = raw;
    }
    if (!existing && !fields.images && value.image) value.images = [value.image];
    const variants = new Map((existing?.variants ?? []).map((variant) => [variant.size, variant]));
    for (const { row, fields: entry } of rows) {
      const old = variants.get(entry.size!);
      if (old?.barcode && old.barcode !== entry.barcode) preview.warnings.push(`Row ${row}: explicitly replaces an existing barcode. Historical orders keep the old barcode; cancellation may need conflict resolution.`);
      const variant = { size: entry.size!, stock: /^\d+$/.test(entry.stock!) ? Number(entry.stock) : NaN,
        barcode: entry.barcode!, sku: entry.sku || old?.sku || '' };
      const parsed = productSchema.shape.variants.element.safeParse(variant);
      if (!parsed.success) for (const issue of parsed.error.issues) error(row, `${issue.path.join('.')}: ${issue.message}`);
      variants.set(variant.size, variant);
    }
    value.variants = [...variants.values()];
    // Read-only lifecycle fields must never become writable schema fields through a CSV merge.
    const { id: productId, soldOutAt: _soldOutAt, archivedAt: _archivedAt, ...input } = value;
    const result = productSchema.safeParse(input);
    if (!result.success) {
      for (const issue of result.error.issues) error(first.row, `${issue.path.join('.')}: ${issue.message}`);
    } else if (!validateProductPrices(result.data)) error(first.row, 'Original price cannot be below selling price.');
    else if (existing?.archivedAt && fields.active === 'true' && !result.data.variants.some(({ stock }) => stock > 0)) {
      error(first.row, 'Restock at least one size before republishing an archived product.');
    } else changes.push({ product: { id: String(productId), ...result.data }, existing: Boolean(existing), republish: fields.active === 'true' });
  }
  preview.valid = preview.errors.length === 0;
  return { preview, changes };
}

export function commitCatalogueImport(db: StoreDatabase, csv: string): { preview: ImportPreview; result: { created: number; updated: number; variants: number } | null } {
  return transaction(db, () => {
    archiveSoldOutProducts(db);
    const plan = planCatalogueImport(db, csv);
    if (!plan.preview.valid) return { preview: plan.preview, result: null };
    for (const { product, existing, republish } of plan.changes) {
      if (existing) updateProduct(db, product, { republish }); else insertProduct(db, product);
    }
    return { preview: plan.preview, result: { created: plan.changes.filter(({ existing }) => !existing).length,
      updated: plan.changes.filter(({ existing }) => existing).length, variants: plan.preview.variants } };
  });
}