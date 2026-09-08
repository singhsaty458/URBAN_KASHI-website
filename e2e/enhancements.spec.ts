import { randomInt, randomUUID } from 'node:crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import type { Order, Product } from '../shared/types';

// All HTTP helpers use Playwright's isolated :4180 server and its temporary DB.
// These are synthetic POS-export values, never a connection to a POS or gateway.
const headers = { 'X-Requested-With': 'UrbanKashi' };
const csvHeader = 'slug,name,category,brand,design,color,size,barcode,sku,price,stock,image,description';
const logoName = 'अर्बन काशी — URBAN KASHI';

test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:4180');
  // Fail closed even if a regression tries to load the real checkout script.
  await page.route(/^https?:\/\/(?:[^/]+\.)?razorpay\.com(?:\/|$)/, route => route.abort());
});

function catalogueFixture() {
  const suffix = randomUUID();
  const code = `00${Date.now()}${randomInt(100000, 999999)}`;
  const whiteSlug = `browser-csv-white-${suffix}`;
  const navySlug = `browser-csv-navy-${suffix}`;
  const brand = `Browser Textiles ${suffix.slice(0, 8)}`;
  const design = `Kashi Check ${suffix.slice(0, 8)}`;
  const description = 'Synthetic CSV sample, website stock only; not connected to a POS.';
  const image = '/images/photo-1598033129183-c4f50c736f10.jpg';
  const variants = [
    { size: '38/40', stock: 5, barcode: `${code}1`, sku: '0007-WHITE-38/40' },
    { size: 'Free Size', stock: 7, barcode: `${code}2`, sku: '0008-WHITE-FREE' },
    { size: '38/40', stock: 4, barcode: `${code}3`, sku: '0009-NAVY-38/40' },
  ];
  const rows = variants.map((variant, index) => [
    index === 2 ? navySlug : whiteSlug, index === 2 ? 'Browser CSV Navy Shirt' : 'Browser CSV White Shirt',
    'Shirts', brand, design, index === 2 ? 'Navy' : 'White', variant.size, variant.barcode, variant.sku,
    '1299', String(variant.stock), image, description,
  ]);
  const csv = [csvHeader, ...rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(','))].join('\r\n');
  return { csv, whiteSlug, navySlug, brand, design, description, variants };
}

async function loginAdmin(page: Page) {
  await page.goto('/account?next=/admin');
  await page.getByLabel('Email address', { exact: true }).fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('BrowserTests2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await page.waitForURL('**/admin');
  await expect(page.getByRole('heading', { name: 'The inventory', exact: true })).toBeVisible();
}

async function inventory(page: Page) {
  const response = await page.request.get('/api/admin/products');
  expect(response.status()).toBe(200);
  const { products } = await response.json() as { products: Product[] };
  return products.sort((a, b) => a.id.localeCompare(b.id));
}

async function seedCatalogue(page: Page) {
  await loginAdmin(page);
  const fixture = catalogueFixture();
  // Setup only; the CSV workflow test below exercises the actual browser import.
  const response = await page.request.post('/api/admin/catalogue/import', { headers, data: { csv: fixture.csv } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ created: 2, updated: 0, variants: 3 });
  return fixture;
}

async function labelValue(container: Locator, label: string, value: string) {
  const field = container.locator('.catalogue-labels > div').filter({
    has: container.page().locator('dt').filter({ hasText: new RegExp(`^${label}$`) }),
  });
  await expect(field.locator('dd')).toHaveText(value);
}

async function noOverflow(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    outside: [...document.querySelectorAll('main *, header *, footer *')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
    }).slice(0, 12).map(element => `${element.tagName}.${element.className}`),
  }));
  expect(metrics.width, `Horizontal overflow at ${page.url()}: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(metrics.viewport + 1);
}

test('admin CSV template, read-only preview, exact-row approval, import and custom-size editor round trip', async ({ page }) => {
  test.setTimeout(90_000);
  await loginAdmin(page);
  const panel = page.getByRole('region', { name: 'CSV catalogue import / कैटलॉग आयात', exact: true });
  const upload = panel.getByLabel('CSV file (maximum 2 MiB)', { exact: true });
  const preview = panel.getByRole('button', { name: 'Preview / जाँचें', exact: true });
  const confirm = panel.getByRole('button', { name: 'Confirm import / आयात करें', exact: true });
  const approval = panel.getByRole('checkbox', { name: /I reviewed these exact rows/ });
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/catalogue/import') writes.push(request.postData() ?? '');
  });
  const before = await inventory(page);
  await expect(preview).toBeDisabled();
  await expect(confirm).toBeDisabled();
  await panel.getByText('Import guide / कैसे भरें', { exact: true }).click();
  await expect(panel.getByText(/There is no automatic POS synchronisation/)).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await panel.getByRole('link', { name: 'Download CSV template / नमूना डाउनलोड', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('catalogue-template.csv');
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  if (!stream) throw new Error('CSV template download did not supply a readable stream.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const template = Buffer.concat(chunks);
  expect(template.toString('utf8').split(/\r?\n/)[0]).toBe(csvHeader);
  await upload.setInputFiles({ name: 'catalogue-template.csv', mimeType: 'text/csv', buffer: template });
  await expect(preview).toBeEnabled();
  await preview.click();
  await expect(panel.locator('.import-preview')).toContainText('Ready for review · 3 rows · 2 products · 3 variants');
  await expect(panel.locator('.import-preview')).toContainText('Stock is absolute website-allocated stock');
  await expect(confirm).toBeDisabled();
  expect(await inventory(page)).toEqual(before);
  expect(writes).toEqual([]);

  const fixture = catalogueFixture();
  const duplicateBarcodeCsv = fixture.csv.replace(fixture.variants[1]!.barcode, fixture.variants[0]!.barcode);
  await upload.setInputFiles({ name: 'duplicate-barcode.csv', mimeType: 'text/csv', buffer: Buffer.from(duplicateBarcodeCsv) });
  await expect(preview).toBeEnabled();
  await preview.click();
  await expect(panel.locator('.import-preview')).toContainText('Please fix the CSV');
  await expect(panel.locator('.import-preview')).toContainText('Duplicate barcode in this CSV.');
  await expect(approval).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  expect(await inventory(page)).toEqual(before);
  expect(writes).toEqual([]);
  await upload.setInputFiles({ name: 'synthetic-pos-export.csv', mimeType: 'text/csv', buffer: Buffer.from(fixture.csv) });
  await expect(panel.locator('.import-preview')).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  await expect(preview).toBeEnabled();
  await preview.click();
  await expect(approval).toBeVisible();
  await expect(approval).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  expect(await inventory(page)).toEqual(before);
  await approval.check();
  await expect(confirm).toBeEnabled();
  await panel.getByText('Review / edit CSV text', { exact: true }).click();
  // HTML textarea.value normalizes Windows CRLF to LF during manual editing.
  const editedCsv = fixture.csv.replaceAll('\r\n', '\n').replaceAll(fixture.description, `${fixture.description} Reviewed.`);
  await panel.getByLabel('Current CSV', { exact: true }).fill(editedCsv);
  await expect(panel.locator('.import-preview')).toHaveCount(0);
  await expect(approval).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  expect(writes).toEqual([]);
  expect(await inventory(page)).toEqual(before);
  await preview.click();
  await expect(approval).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  await approval.check();
  await confirm.click();
  await expect(panel.getByRole('status')).toHaveText('Imported / आयात पूरा: 2 created, 0 updated, 3 variants saved.');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]!)).toEqual({ csv: editedCsv });
  await expect(confirm).toBeDisabled();
  const after = await inventory(page);
  expect(after).toHaveLength(before.length + 2);
  expect(after.filter(product => before.some(previous => previous.id === product.id))).toEqual(before);
  const white = after.find(product => product.slug === fixture.whiteSlug)!;
  expect(white).toMatchObject({ brand: fixture.brand, design: fixture.design, color: 'White', description: `${fixture.description} Reviewed.`, variants: fixture.variants.slice(0, 2) });
  expect(after.find(product => product.slug === fixture.navySlug)).toMatchObject({ color: 'Navy', variants: [fixture.variants[2]] });

  // Previewing an update must not reset stock or other stored metadata either.
  const updatedCsv = editedCsv.replaceAll('"5"', '"9"');
  await panel.getByLabel('Current CSV', { exact: true }).fill(updatedCsv);
  await preview.click();
  await expect(approval).toBeVisible();
  expect(await inventory(page)).toEqual(after);
  await approval.check();
  await confirm.click();
  await expect(panel.getByRole('status')).toHaveText('Imported / आयात पूरा: 0 created, 2 updated, 3 variants saved.');
  expect(writes).toHaveLength(2);
  expect((await inventory(page)).find(product => product.id === white.id)?.variants[0]).toEqual({ ...fixture.variants[0], stock: 9 });

  await page.getByLabel('Find a product', { exact: true }).fill(fixture.variants[0]!.barcode);
  await expect(page.locator('.inventory-product')).toHaveCount(1);
  await page.locator('.inventory-row').getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.locator('.product-editor');
  await expect(form.getByLabel('Brand / ब्रांड (optional)', { exact: true })).toHaveValue(fixture.brand);
  await expect(form.getByLabel('Design / डिज़ाइन (optional)', { exact: true })).toHaveValue(fixture.design);
  for (const [index, variant] of fixture.variants.slice(0, 2).entries()) {
    await expect(form.getByRole('textbox', { name: `Size ${index + 1}`, exact: true })).toHaveValue(variant.size);
    await expect(form.getByLabel(`Barcode ${index + 1}`, { exact: true })).toHaveValue(variant.barcode);
    await expect(form.getByLabel(`SKU ${index + 1}`, { exact: true })).toHaveValue(variant.sku);
  }
  await expect(form.getByRole('spinbutton', { name: '38/40', exact: true })).toHaveValue('9');
  await form.getByRole('button', { name: 'Add size / साइज़ जोड़ें', exact: true }).click();
  await form.getByRole('textbox', { name: 'Size 3', exact: true }).fill('42 Tall');
  await form.getByRole('spinbutton', { name: '42 Tall', exact: true }).fill('3');
  const addedBarcode = `${fixture.variants[0]!.barcode}0`;
  await form.getByLabel('Barcode 3', { exact: true }).fill(addedBarcode);
  await form.getByLabel('SKU 3', { exact: true }).fill('0010-WHITE-TALL');
  await form.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.reload();
  await page.getByLabel('Find a product', { exact: true }).fill(addedBarcode);
  await expect(page.locator('.inventory-product')).toHaveCount(1);
  await page.locator('.inventory-row').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(form.getByLabel('Barcode 1', { exact: true })).toHaveValue(fixture.variants[0]!.barcode);
  // Server sorting may move the new custom size; locate it by its stock label.
  const addedRow = form.locator('.catalogue-variant').filter({ has: page.getByRole('spinbutton', { name: '42 Tall', exact: true }) });
  await expect(addedRow.getByRole('textbox', { name: /^Size \d+$/ })).toHaveValue('42 Tall');
  await expect(addedRow.getByRole('spinbutton', { name: '42 Tall', exact: true })).toHaveValue('3');
  await expect(addedRow.getByRole('textbox', { name: /^Barcode \d+$/ })).toHaveValue(addedBarcode);
  await expect(addedRow.getByRole('textbox', { name: /^SKU \d+$/ })).toHaveValue('0010-WHITE-TALL');
  await noOverflow(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await noOverflow(page);
});

test('barcode search reveals exact size identifiers and navigable colour siblings', async ({ page }) => {
  const fixture = await seedCatalogue(page);
  await page.goto('/shop');
  await page.getByRole('textbox', { name: 'Search products', exact: true }).fill(fixture.variants[0]!.barcode);
  await expect(page).toHaveURL(new RegExp(`q=${fixture.variants[0]!.barcode}$`));
  await expect(page.locator('.product-card')).toHaveCount(1);
  await page.getByRole('heading', { level: 3, name: 'Browser CSV White Shirt', exact: true }).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/product/${fixture.whiteSlug}$`));
  const copy = page.locator('.product-detail-copy');
  await labelValue(copy, 'Brand', fixture.brand);
  await labelValue(copy, 'Design', fixture.design);
  await expect(copy.getByText(fixture.description, { exact: true })).toBeVisible();
  for (const variant of fixture.variants.slice(0, 2)) {
    await copy.getByRole('button', { name: `Size ${variant.size}`, exact: true }).click();
    await expect(copy.getByRole('button', { name: `Size ${variant.size}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await labelValue(copy, 'Barcode', variant.barcode);
    await labelValue(copy, 'SKU', variant.sku);
    await expect(copy.locator('.stock-note')).toHaveText(`${variant.stock} available in size ${variant.size}`);
  }
  const siblings = page.getByRole('navigation', { name: 'Other colours of this brand and design', exact: true });
  await expect(siblings.getByRole('link')).toHaveCount(1);
  await expect(siblings.getByRole('link', { name: 'Navy', exact: true })).toHaveAttribute('href', `/product/${fixture.navySlug}`);
  await siblings.getByRole('link', { name: 'Navy', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Browser CSV Navy Shirt', exact: true })).toBeVisible();
  await expect(copy.locator('.color-label')).toHaveText('Colour Navy');
  await expect(copy.getByRole('button', { name: 'Size 38/40', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(copy.locator('.stock-note')).toHaveText('Select a size to check availability.');
  await copy.getByRole('button', { name: 'Size 38/40', exact: true }).click();
  await labelValue(copy, 'Barcode', fixture.variants[2]!.barcode);
  await labelValue(copy, 'SKU', fixture.variants[2]!.sku);
  await expect(siblings.getByRole('link', { name: 'White', exact: true })).toHaveAttribute('href', `/product/${fixture.whiteSlug}`);
  await siblings.getByRole('link', { name: 'White', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Browser CSV White Shirt', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await noOverflow(page);
});

test('disabled gateway keeps COD default and saves custom-size metadata without gateway traffic', async ({ page }) => {
  const gatewayRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/(^|\.)razorpay\.com$/.test(url.hostname) || /^\/api\/payments\/(create|verify|reconcile)(\/|$)/.test(url.pathname)) gatewayRequests.push(request.url());
  });
  const fixture = await seedCatalogue(page);
  await page.goto(`/product/${fixture.whiteSlug}`);
  await page.getByRole('button', { name: 'Size 38/40', exact: true }).click();
  await page.getByRole('button', { name: 'Add to bag', exact: true }).click();
  await labelValue(page.getByRole('dialog'), 'Barcode', fixture.variants[0]!.barcode);
  await page.getByRole('link', { name: 'Continue to checkout', exact: true }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  const cod = page.getByRole('radio', { name: /^Cash on delivery/ });
  const online = page.getByRole('radio', { name: /^Online · Razorpay/ });
  await expect(cod).toBeChecked();
  await expect(cod).toBeEnabled();
  await expect(online).toBeVisible();
  await expect(online).toBeDisabled();
  await expect(online).not.toBeChecked();
  await expect(page.locator('#online-payment-info')).toContainText('Online unavailable:');
  const config = await page.request.get('/api/payments/config');
  expect(config.status()).toBe(200);
  expect(await config.json()).toMatchObject({ online: false, mode: 'disabled' });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/payments/config' && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh payment options', exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Refresh payment options', exact: true })).toBeEnabled();
  await expect(cod).toBeChecked();
  await expect(online).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Place COD order', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Continue to (TEST|online) payment/ })).toHaveCount(0);
  const summary = page.locator('.checkout-summary');
  for (const [label, value] of [['Brand', fixture.brand], ['Design', fixture.design], ['Colour', 'White'], ['Barcode', fixture.variants[0]!.barcode], ['SKU', fixture.variants[0]!.sku]] as const) {
    await labelValue(summary, label, value);
  }
  await expect(summary.getByText('Size 38/40 · Qty 1', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Full name', exact: true }).fill('Synthetic Checkout Customer');
  await page.getByRole('textbox', { name: 'Mobile number', exact: true }).fill('9876543210');
  await page.getByRole('textbox', { name: 'Street address', exact: true }).fill('42 Synthetic Test Road');
  await page.getByRole('textbox', { name: 'City', exact: true }).fill('Varanasi');
  await page.getByRole('textbox', { name: 'State / union territory', exact: true }).fill('Uttar Pradesh');
  await page.getByRole('textbox', { name: 'PIN code', exact: true }).fill('221005');
  await noOverflow(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await noOverflow(page);
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/orders' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Place COD order', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { order } = await response.json() as { order: Order };
  expect(order).toMatchObject({ paymentMethod: 'COD', paymentStatus: 'unpaid', status: 'placed', subtotal: 1299, shipping: 99, total: 1398 });
  expect(order.items).toHaveLength(1);
  expect(order.items[0]).toMatchObject({ brand: fixture.brand, design: fixture.design, color: 'White', size: '38/40', barcode: fixture.variants[0]!.barcode, sku: fixture.variants[0]!.sku, quantity: 1, price: 1299 });
  await expect(page).toHaveURL(new RegExp(`/order/${order.id}$`));
  await expect(page.getByRole('heading', { name: 'Your order, recorded.', exact: true })).toBeVisible();
  await expect(page.locator('.order-confirmation .payment-notice')).toContainText('COD · unpaid');
  await expect(page.locator('.order-confirmation .payment-notice')).toContainText('does not confirm payment collection');
  await expect(page.getByRole('button', { name: 'Open bag, 0 items', exact: true })).toBeVisible();
  await page.reload();
  await labelValue(page.locator('.order-details-grid'), 'Barcode', fixture.variants[0]!.barcode);
  await labelValue(page.locator('.order-details-grid'), 'SKU', fixture.variants[0]!.sku);
  await expect(page.locator('.order-details-grid')).toContainText('Size 38/40 · Qty 1');
  expect(gatewayRequests).toEqual([]);
  await expect(page.locator('script[src*="razorpay.com"]')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 900 });
  await noOverflow(page);
});

test('bilingual header and footer logos are accessible and layouts fit down to 320px', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('img', { name: logoName, exact: true })).toHaveCount(2);
  const home = page.getByRole('banner').getByRole('link', { name: 'Urban Kashi home', exact: true });
  const footerHome = page.getByRole('contentinfo').getByRole('link', { name: logoName, exact: true });
  await expect(home).toHaveAttribute('href', '/');
  await expect(footerHome).toHaveAttribute('href', '/');
  for (const logo of await page.getByRole('img', { name: logoName, exact: true }).all()) {
    await expect(logo).toBeVisible();
    await expect(logo.locator('[lang="hi"]')).toHaveText('अर्बन काशी');
    await expect(logo.locator('[lang="en"]')).toHaveText('URBAN KASHI');
    await expect(logo.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(logo.locator('svg')).toHaveAttribute('focusable', 'false');
  }
  await noOverflow(page);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Wear your own energy.');
    await noOverflow(page);
    for (const control of [home, page.getByRole('button', { name: 'Open navigation', exact: true }), page.getByRole('button', { name: 'Search collection', exact: true }), page.getByRole('button', { name: 'Open bag, 0 items', exact: true })]) {
      await expect(control).toBeInViewport();
    }
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('dialog', { name: 'Explore', exact: true }).getByRole('link', { name: /Shop all/ }).click();
    await expect(page).toHaveURL(/\/shop$/);
    await expect(page.locator('.product-card').first()).toBeVisible();
    await noOverflow(page);
    await home.focus();
    await expect(home).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('http://127.0.0.1:4180/');
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
    await noOverflow(page);
  }
});

test('only the logo glyph rotates around Y normally and reduced motion removes animation', async ({ page }) => {
  // Override the suite's reducedMotion: reduce default to exercise the real CSS.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const glyphs = page.locator('.uk-brand__trishul');
  await expect(glyphs).toHaveCount(2);
  for (const glyph of await glyphs.all()) {
    await expect(glyph).toHaveCSS('animation-name', 'uk-brand-upright-turn');
    await expect(glyph).toHaveCSS('animation-iteration-count', 'infinite');
    await expect.poll(() => glyph.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(1);
    const samples = await glyph.evaluate(async element => {
      const animation = element.getAnimations()[0]!;
      const effect = animation.effect as KeyframeEffect;
      const duration = Number(effect.getTiming().duration);
      const keyframes = effect.getKeyframes().map(frame => frame.transform);
      // Seek the actual CSS animation rather than sleep or inject replacement styles.
      animation.pause();
      await animation.ready;
      animation.currentTime = duration / 4;
      const quarter = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      animation.currentTime = duration / 2;
      const half = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { duration, keyframes, quarter: { x: quarter.m11, y: quarter.m22, z: quarter.m33, xz: quarter.m13, zx: quarter.m31 }, half: { x: half.m11, y: half.m22, z: half.m33 } };
    });
    expect(samples.duration).toBeGreaterThan(0);
    expect(samples.keyframes).toEqual(['rotateY(0deg)', 'rotateY(360deg)']);
    expect(samples.quarter.x).toBeCloseTo(0, 4);
    expect(samples.quarter.y).toBeCloseTo(1, 4);
    expect(samples.quarter.z).toBeCloseTo(0, 4);
    expect(Math.abs(samples.quarter.xz)).toBeCloseTo(1, 4);
    expect(Math.abs(samples.quarter.zx)).toBeCloseTo(1, 4);
    expect(samples.half.x).toBeCloseTo(-1, 4);
    expect(samples.half.y).toBeCloseTo(1, 4);
    expect(samples.half.z).toBeCloseTo(-1, 4);
  }
  for (const text of await page.locator('.uk-brand__hindi, .uk-brand__english').all()) {
    await expect(text).toHaveCSS('animation-name', 'none');
    await expect(text).toHaveCSS('transform', 'none');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const glyph of await glyphs.all()) {
    await expect(glyph).toHaveCSS('animation-name', 'none');
    await expect(glyph).toHaveCSS('transform', 'none');
    await expect.poll(() => glyph.evaluate(element => element.getAnimations().length)).toBe(0);
  }
  // Also check initial reduced-motion load, not just a live preference change.
  await page.reload();
  await expect(glyphs).toHaveCount(2);
  for (const glyph of await glyphs.all()) {
    await expect(glyph).toHaveCSS('animation-name', 'none');
    await expect(glyph).toHaveCSS('transform', 'none');
  }
});