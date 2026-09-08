import type { Product } from '../../shared/types';

export const safeCatalogueText = (value: string, max: number, required = false) =>
  value.length <= max && (!required || value.trim().length > 0) && !/[<>\u0000-\u001f\u007f]/.test(value);

export function matchesProduct(product: Product, query: string) {
  return [product.name, product.slug, product.category, product.color, product.description,
    product.brand, product.design, ...product.variants.flatMap(v => [v.barcode, v.sku])]
    .filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase());
}