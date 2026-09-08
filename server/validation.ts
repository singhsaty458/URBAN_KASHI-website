import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const nameSchema = z.string().trim().min(2).max(100);
export const passwordSchema = z.string().refine(
  (value) => Buffer.byteLength(value, 'utf8') >= 10 && Buffer.byteLength(value, 'utf8') <= 72
    && /[a-z]/i.test(value) && /[0-9]/.test(value),
  'Password must be 10–72 UTF-8 bytes and contain a letter and a number.',
);
export const registerSchema = z.object({
  name: nameSchema, email: emailSchema, password: passwordSchema,
}).strict();
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 72),
}).strict();

const text = (max: number) => z.string().trim().min(1).max(max);
export const sizeSchema = text(24).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u, 'Size must be safe text, at most 24 characters.');
const identifierSchema = z.string().trim().max(160).regex(/^[^\u0000-\u001f\u007f]*$/, 'Barcode/SKU contains control characters.');
const imageSchema = z.string().max(2048).refine((value) => {
  if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/')) {
    return /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(value)
      && !value.split('/').some((part) => part === '.' || part === '..');
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}, 'Image must be an HTTPS URL or a safe same-site path.');

export const productSchema = z.object({
  slug: z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: text(160),
  category: z.enum(['Shirts', 'T-Shirts', 'Trousers', 'Kurtas', 'Layers']),
  price: z.number().int().min(1).max(1_000_000),
  originalPrice: z.number().int().min(1).max(1_000_000).nullable(),
  color: text(80),
  brand: z.string().trim().max(160).default(''),
  design: z.string().trim().max(160).default(''),
  description: text(5000),
  details: z.array(text(500)).max(20),
  image: imageSchema,
  images: z.array(imageSchema).min(1).max(12),
  badge: text(50).nullable(),
  featured: z.boolean(),
  active: z.boolean(),
  variants: z.array(z.object({
    size: sizeSchema,
    stock: z.number().int().min(0).max(1_000_000),
    barcode: identifierSchema.max(128).optional(),
    sku: identifierSchema.optional(),
  }).strict()).min(1).max(30).refine(
    (variants) => new Set(variants.map(({ size }) => size)).size === variants.length,
    'Variant sizes must be unique.',
  ),
}).strict();
export const productPatchSchema = productSchema.extend({
  brand: z.string().trim().max(160), design: z.string().trim().max(160),
}).partial().refine(
  (value) => Object.keys(value).length > 0, 'Provide at least one product field.',
);
export function validateProductPrices(product: { price: number; originalPrice: number | null }): boolean {
  return product.originalPrice === null || product.originalPrice >= product.price;
}

export const addressSchema = z.object({
  name: nameSchema,
  phone: z.string().trim().regex(/^(?:\+91)?[6-9]\d{9}$/, 'Provide a valid Indian mobile number.'),
  line1: text(250).refine((value) => value.length >= 5, 'Address is too short.'),
  city: text(100).refine((value) => value.length >= 2),
  state: text(100).refine((value) => value.length >= 2),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, 'Provide a six-digit Indian pincode.'),
}).strict();
export const checkoutSchema = z.object({
  items: z.array(z.object({
    productId: text(100), size: sizeSchema,
    quantity: z.number().int().min(1).max(10),
  }).strict()).min(1).max(20).refine(
    (items) => new Set(items.map(({ productId, size }) => JSON.stringify([productId, size]))).size === items.length,
    'Duplicate product/size lines are not allowed.',
  ),
  address: addressSchema,
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
}).strict();
export const statusSchema = z.object({
  status: z.enum(['placed', 'confirmed', 'shipped', 'delivered', 'cancelled']),
}).strict();