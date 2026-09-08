import { test as base, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { ImageUpload, Product } from '../shared/types';

type Photo = { name: string; mimeType: string; buffer: Buffer };
const test = base.extend<{ photo: Photo }>({
  photo: async ({}, use) => {
    // Actual decodable PNG bytes, not a mocked success or a base64 placeholder.
    const buffer = await sharp({ create: { width: 24, height: 32, channels: 3, background: '#ac8260' } }).png().toBuffer();
    await use({ name: 'test-product.png', mimeType: 'image/png', buffer });
  },
});
const endpoint = '/api/admin/uploads/images';
const xhr = { 'X-Requested-With': 'UrbanKashi' };
const uploadedPath = /^\/uploads\/products\/[0-9a-f-]{36}\.webp$/;

test.beforeEach(async ({ baseURL }) => {
  // Fail closed if somebody tries to point these writes at the real store.
  expect(baseURL).toBe('http://127.0.0.1:4180');
});

async function admin(page: Page) {
  const response = await page.request.post('/api/auth/login', {
    headers: xhr, data: { email: 'admin@example.test', password: 'BrowserTests2026!' },
  });
  expect(response.ok()).toBe(true);
  await page.goto('/admin');
  await expect(page.getByRole('button', { name: 'New product', exact: true })).toBeVisible();
}

async function mainUpload(page: Page, photo: Photo) {
  const responsePromise = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST');
  await page.getByLabel('Upload main photo', { exact: true }).setInputFiles(photo);
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(response.request().headers()['content-type']).toBe('image/png');
  expect(response.request().headers()['x-requested-with']).toBe('UrbanKashi');
  const upload = await response.json() as ImageUpload;
  expect(upload.path).toMatch(uploadedPath);
  expect(upload.width).toBe(24); expect(upload.height).toBe(32); expect(upload.bytes).toBeGreaterThan(0);
  // Chromium may omit a File-backed request body from CDP's postDataBuffer.
  // Verify actual server-stored bytes against the selected photo's optimized output instead.
  const stored = await page.request.get(upload.path);
  expect(stored.status()).toBe(200);
  const expected = await sharp(photo.buffer).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb').webp({ quality: 82 }).toBuffer();
  expect(await stored.body()).toEqual(expected);
  expect(upload.bytes).toBe(expected.length);
  await expect(page.getByLabel(/^Main image/)).toHaveValue(upload.path);
  const preview = page.getByRole('img', { name: 'Main photo preview', exact: true });
  await expect(preview).toHaveAttribute('src', upload.path);
  await expect.poll(() => preview.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth)).toBe(24);
  await expect(page.locator('.product-editor')).toHaveAttribute('aria-busy', 'false');
  return upload;
}

test('real main and sequential gallery uploads preview, save, reload and show Sold out only when all sizes are zero', async ({ page, photo }, testInfo) => {
  await admin(page);
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  const form = page.locator('.product-editor');
  const slug = `uploaded-${testInfo.project.name}-${Date.now()}`;
  const name = `Uploaded photo ${slug}`;
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Slug', { exact: true }).fill(slug);
  await form.getByLabel('Colour', { exact: true }).fill('Sand');
  await form.getByLabel(/^Price \(whole INR/).fill('1499');
  await form.getByLabel('Description', { exact: true }).fill('Isolated browser upload fixture.');
  await form.getByLabel('Badge (optional)', { exact: true }).fill('New');
  const main = await mainUpload(page, photo);
  await expect(form.getByLabel(/^Gallery \(/)).toHaveValue(main.path);

  const events: string[] = [];
  page.on('request', request => { if (request.url().endsWith(endpoint)) events.push('request'); });
  page.on('response', response => { if (response.url().endsWith(endpoint)) events.push('response'); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route(`**${endpoint}`, async route => { calls++; if (calls === 1) await gate; await route.continue(); });
  try {
    await form.getByLabel('Upload gallery photos', { exact: true }).setInputFiles([photo, { ...photo, name: 'second-view.png' }]);
    await expect(form.locator('[role="status"]')).toContainText('Uploading photo 1 of 2');
    await expect.poll(() => calls).toBe(1);
    await expect(form.getByLabel('Name', { exact: true })).toBeDisabled();
    await expect(form.getByLabel(/^Main image/)).toBeDisabled();
    await expect(form.getByLabel(/^Gallery \(/)).toBeDisabled();
    await expect(form.getByLabel('Upload main photo', { exact: true })).toBeDisabled();
    await expect(form.getByLabel('Upload gallery photos', { exact: true })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Create product', exact: true })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Close product editor', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Orders', exact: true })).toBeDisabled();
    expect(events).toEqual(['request']);
  } finally { release(); }
  await expect(form.locator('[role="status"]')).toContainText('2 of 2 photos uploaded');
  await expect(form).toHaveAttribute('aria-busy', 'false');
  expect(events).toEqual(['request', 'response', 'request', 'response']);
  await page.unroute(`**${endpoint}`);
  const gallery = (await form.getByLabel(/^Gallery \(/).inputValue()).split('\n');
  expect(gallery).toHaveLength(3); expect(new Set(gallery).size).toBe(3); expect(gallery[0]).toBe(main.path);
  for (const path of gallery) expect(path).toMatch(uploadedPath);
  await expect(form.getByRole('img', { name: /^Gallery photo preview/ })).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/admin/products') && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Create product', exact: true }).click();
  const createdResponse = await saveResponse;
  expect(createdResponse.status()).toBe(201);
  const payload = createdResponse.request().postDataJSON();
  expect(payload).not.toHaveProperty('soldOutAt'); expect(payload).not.toHaveProperty('archivedAt');
  const { product } = await createdResponse.json() as { product: Product };
  expect(product.image).toBe(main.path); expect(product.images).toEqual(gallery); expect(product.soldOutAt).toBeTruthy();
  await expect(form).toHaveCount(0);
  await page.reload();
  await page.getByLabel('Find a product').fill(name);
  await expect(page.locator('.inventory-row')).toContainText('Sold out since');
  await expect(page.locator('.inventory-row')).toContainText('48 hours');
  await page.locator('.inventory-row').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(form.getByLabel(/^Main image/)).toHaveValue(main.path);
  await expect(form.getByLabel(/^Gallery \(/)).toHaveValue(gallery.join('\n'));
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();

  const imageResponse = await page.request.get(main.path);
  expect(imageResponse.status()).toBe(200); expect(imageResponse.headers()['content-type']).toContain('image/webp');
  expect((await imageResponse.body()).toString('ascii', 8, 12)).toBe('WEBP');
  await page.goto(`/shop?q=${slug}`);
  const card = page.locator('.product-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card.locator('.product-image-wrap .sold-out-badge')).toHaveText('Sold out');
  await expect(card.locator('.sold-out-badge')).toHaveCSS('font-size', '14px');
  await page.goto(`/product/${slug}`);
  await expect(page.locator('.product-main-photo img')).toHaveAttribute('src', main.path);
  await expect(page.locator('.product-main-photo .sold-out-badge')).toHaveText('Sold out');
  await expect(page.getByRole('button', { name: 'Sold out', exact: true })).toBeDisabled();
  await page.reload();
  await expect.poll(() => page.locator('.product-main-photo img').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(24);

  // Restock only M through the editor. Other sizes stay zero, so neither photo should say Sold out.
  await page.goto('/admin');
  await page.getByLabel('Find a product').fill(name);
  await page.locator('.inventory-row').getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByRole('spinbutton', { name: 'M', exact: true }).fill('2');
  const patchResponse = page.waitForResponse(response => response.url().endsWith(`/api/admin/products/${product.id}`) && response.request().method() === 'PATCH');
  await form.getByRole('button', { name: 'Save product', exact: true }).click();
  const patched = await patchResponse;
  expect(patched.status()).toBe(200);
  expect(patched.request().postDataJSON()).not.toHaveProperty('soldOutAt');
  expect(patched.request().postDataJSON()).not.toHaveProperty('archivedAt');
  await expect(form).toHaveCount(0);
  await page.goto(`/shop?q=${slug}`);
  await expect(card.locator('.product-badge')).toHaveText('New');
  await expect(card.locator('.sold-out-badge')).toHaveCount(0);
  await page.goto(`/product/${slug}`);
  await expect(page.locator('.product-main-photo .product-badge')).toHaveText('New');
  await expect(page.locator('.product-main-photo .sold-out-badge')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Size M', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Size S, sold out', exact: true })).toBeDisabled();
});

test('photo replacement preserves other gallery paths; invalid files, gallery limit and simulated 507 recover without false success', async ({ page, photo }) => {
  await admin(page);
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  const form = page.locator('.product-editor');
  const first = await mainUpload(page, photo);
  const other = '/images/photo-1596755094514-f87e34085b2c.jpg';
  await form.getByLabel(/^Gallery \(/).fill(`${first.path}\n${other}\n${first.path}`);
  const second = await mainUpload(page, photo);
  await expect(form.getByLabel(/^Gallery \(/)).toHaveValue(`${second.path}\n${other}`);
  let requests = 0;
  page.on('request', request => { if (request.url().endsWith(endpoint)) requests++; });
  const input = form.getByLabel('Upload main photo', { exact: true });
  await input.setInputFiles({ name: 'not-a-photo.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
  await expect(form.getByRole('alert')).toContainText('choose a JPEG, PNG or WebP');
  await input.setInputFiles({ ...photo, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(form.getByRole('alert')).toContainText('no larger than 10 MiB');
  await input.setInputFiles({ ...photo, buffer: Buffer.alloc(0) });
  await expect(form.getByRole('alert')).toContainText('nonempty');
  await form.getByLabel('Upload gallery photos', { exact: true }).setInputFiles(Array.from({ length: 11 }, (_, index) => ({ ...photo, name: `photo-${index}.png` })));
  await expect(form.getByRole('alert')).toContainText('Gallery holds at most 12 photos');
  expect(requests).toBe(0);
  await expect(form.getByLabel(/^Main image/)).toHaveValue(second.path);
  const invalidResponse = page.waitForResponse(response => response.url().endsWith(endpoint));
  await input.setInputFiles({ ...photo, buffer: Buffer.from('invalid PNG bytes') });
  expect((await invalidResponse).status()).toBe(400);
  await expect(form.getByRole('alert')).toContainText('0 of 1 photos uploaded');
  await expect(form.getByLabel(/^Main image/)).toHaveValue(second.path);

  // Only the error contract is intercepted; all successful uploads here use the real isolated server.
  await page.route(`**${endpoint}`, route => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: 'Managed image storage quota is full.' }) }));
  await input.setInputFiles(photo);
  await expect(form.getByRole('alert')).toContainText('Managed image storage quota is full.');
  await expect(form.getByRole('alert')).toContainText('0 of 1 photos uploaded');
  await expect(form.locator('[role="status"]')).toBeEmpty();
  await expect(form).toHaveAttribute('aria-busy', 'false');
  await expect(form.getByLabel(/^Main image/)).toHaveValue(second.path);
  await expect(form.getByLabel(/^Gallery \(/)).toHaveValue(`${second.path}\n${other}`);
  await expect(form.getByRole('button', { name: 'Create product', exact: true })).toBeEnabled();
  await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Orders', exact: true })).toBeEnabled();
  await page.unroute(`**${endpoint}`);
  // If the gallery does not refer to the old main, replacing main must not discard other photos.
  await form.getByLabel(/^Gallery \(/).fill(other);
  await mainUpload(page, photo);
  await expect(form.getByLabel(/^Gallery \(/)).toHaveValue(other);
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('partial gallery failure retains completed uploads and locks the inventory Edit toggle', async ({ page, photo }, testInfo) => {
  await admin(page);
  const slug = `partial-upload-${testInfo.project.name}-${Date.now()}`;
  const image = '/images/photo-1596755094514-f87e34085b2c.jpg';
  const created = await page.request.post('/api/admin/products', { headers: xhr, data: {
    slug, name: slug, category: 'Shirts', price: 1000, originalPrice: null, color: 'Sand',
    description: 'Isolated gallery error fixture.', details: [], image, images: [image],
    badge: null, featured: false, active: true, variants: [{ size: 'M', stock: 1 }],
  } });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByLabel('Find a product').fill(slug);
  const toggle = page.locator('.inventory-row').getByRole('button', { name: 'Edit', exact: true });
  await toggle.click();
  const form = page.locator('.product-editor');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route(`**${endpoint}`, async route => { calls++; if (calls === 1) await gate; await route.continue(); });
  try {
    await form.getByLabel('Upload gallery photos', { exact: true }).setInputFiles([
      photo, { ...photo, name: 'broken.png', buffer: Buffer.from('invalid PNG') }, { ...photo, name: 'not-sent.png' },
    ]);
    await expect(form).toHaveAttribute('aria-busy', 'true');
    await expect(toggle).toBeDisabled();
    await expect(page.getByLabel('Find a product')).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Save product', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(form.getByRole('alert')).toContainText('1 of 3 photos uploaded');
  await expect(form.getByRole('alert')).toContainText('remaining files were not uploaded');
  await expect(form).toHaveAttribute('aria-busy', 'false');
  expect(calls).toBe(2);
  const gallery = (await form.getByLabel(/^Gallery \(/).inputValue()).split('\n');
  expect(gallery).toHaveLength(2); expect(gallery[0]).toBe(image); expect(gallery[1]).toMatch(uploadedPath);
  await expect(form.getByLabel(/^Main image/)).toHaveValue(image);
  await expect(form.getByRole('img', { name: 'Gallery photo preview 2', exact: true })).toHaveAttribute('src', gallery[1]);
  await expect(toggle).toBeEnabled();
  await expect(form.getByRole('button', { name: 'Save product', exact: true })).toBeEnabled();
  await page.unroute(`**${endpoint}`);
  await form.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(form).toHaveCount(0);
  const saved = await page.request.get(`/api/products/${slug}`);
  expect((await saved.json() as { product: Product }).product.images).toEqual(gallery);
});

test('startup fake-clock archive remains in admin and requires restock plus explicit Active to restore', async ({ page }, testInfo) => {
  const slug = `upload-archive-${testInfo.project.name}`;
  await admin(page);
  const initialResponse = await page.request.get('/api/admin/products');
  const initial = (await initialResponse.json() as { products: Product[] }).products.find(product => product.slug === slug)!;
  expect(initial.archivedAt).toBeTruthy(); expect(initial.soldOutAt).toBeTruthy();
  expect(Date.parse(initial.archivedAt!) - Date.parse(initial.soldOutAt!)).toBe(48 * 60 * 60 * 1000);
  expect((await page.request.get(`/api/products/${slug}`)).status()).toBe(404);
  await page.goto(`/shop?q=${slug}`);
  await expect(page.getByRole('heading', { name: 'No pieces in this edit.', exact: true })).toBeVisible();
  await expect(page.locator('.product-card')).toHaveCount(0);
  await page.goto('/admin');
  await page.getByLabel('Find a product').fill(initial.name);
  const row = page.locator('.inventory-row');
  await expect(row.locator('.inventory-archived')).toHaveText('Archived');
  await expect(row).toContainText('existing orders and photos are preserved');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.locator('.product-editor');
  await expect(form).toContainText('restock at least one size and select Active');
  await expect(form.getByLabel('Active', { exact: true })).not.toBeChecked();
  await form.getByLabel('Active', { exact: true }).check();
  await form.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Restock at least one size before republishing');
  await form.getByLabel('Active', { exact: true }).uncheck();
  await form.getByRole('spinbutton', { name: 'M', exact: true }).fill('3');
  await form.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(row.locator('.inventory-archived')).toHaveText('Archived');
  expect((await page.request.get(`/api/products/${slug}`)).status()).toBe(404);
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByLabel('Active', { exact: true }).check();
  const restoredResponse = page.waitForResponse(response => response.url().endsWith(`/api/admin/products/${initial.id}`) && response.request().method() === 'PATCH');
  await form.getByRole('button', { name: 'Save product', exact: true }).click();
  const response = await restoredResponse;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).not.toHaveProperty('soldOutAt');
  expect(response.request().postDataJSON()).not.toHaveProperty('archivedAt');
  const restored = (await response.json() as { product: Product }).product;
  expect(restored.active).toBe(true); expect(restored.archivedAt).toBeNull(); expect(restored.soldOutAt).toBeNull();
  expect(restored.id).toBe(initial.id); expect(restored.image).toBe(initial.image); expect(restored.images).toEqual(initial.images);
  await expect(form).toHaveCount(0);
  await expect(row.locator('.inventory-archived')).toHaveCount(0);
  await page.goto(`/product/${slug}`);
  await expect(page.getByRole('heading', { level: 1, name: initial.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Size M', exact: true })).toBeEnabled();
});

test('customer restricted view explains owner sign-in without granting admin upload access', async ({ page }, testInfo) => {
  const registration = await page.request.post('/api/auth/register', { headers: xhr, data: {
    name: 'Upload Customer', email: `upload-customer-${testInfo.project.name}-${Date.now()}@example.test`, password: 'UploadCustomer2026!',
  } });
  expect(registration.status()).toBe(201);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Restricted access.' })).toBeVisible();
  await expect(page.getByText(/You are signed in with a customer account/)).toContainText('sign out, then sign in with the owner account');
  await expect(page.getByLabel('Upload main photo', { exact: true })).toHaveCount(0);
  const denied = await page.request.post(endpoint, { headers: { ...xhr, 'Content-Type': 'image/png' }, data: Buffer.from('not decoded for a customer') });
  expect(denied.status()).toBe(403);
  await page.getByRole('link', { name: 'Back to your account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});