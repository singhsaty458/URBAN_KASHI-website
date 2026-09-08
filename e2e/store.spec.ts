import { test, expect, type Page } from '@playwright/test';
import type { Product } from '../shared/types';

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
async function chooseProduct(page: Page) {
  const { products } = await (await page.request.get('/api/products')).json() as { products: Product[] };
  const product = products.find(p => p.variants.some(v => v.size === 'M' && v.stock > 2))!;
  await page.goto(`/product/${product.slug}`);
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible();
  return product;
}

test('editorial home, responsive navigation, local fonts and no runtime/CSP errors', async ({ page }, testInfo) => {
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', event => { if (event.type() === 'error' && /Content Security Policy|Refused to/i.test(event.text())) problems.push(event.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Wear your own energy.');
  await expect(page.locator('.featured-section .product-card')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.locator('.fashion-hero__slide.is-active img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await noOverflow(page);
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('dialog', { name: 'Explore', exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('link', { name: /Shop all/ }).click();
    await expect(page).toHaveURL(/\/shop$/);
    await page.goto('/');
  }
  await page.screenshot({ path: testInfo.outputPath('home.png'), fullPage: true });
  expect(problems).toEqual([]);
});

test('search and category filters work with URL state', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Search collection', exact: true }).click();
  await page.getByLabel('Search the collection', { exact: true }).fill('linen');
  await page.getByRole('button', { name: 'Submit search' }).click();
  await expect(page).toHaveURL(/q=linen/);
  await expect(page.locator('.product-card').first()).toBeVisible();
  await page.goto('/shop?category=Kurtas');
  await expect(page.locator('.product-card').first()).toBeVisible();
  for (const category of await page.locator('.product-category').allTextContents()) expect(category).toContain('Kurtas');
  await noOverflow(page);
  await page.goto('/shop?q=NoSuchProductZXQ');
  await expect(page.locator('.product-card')).toHaveCount(0);
  await expect(page.locator('.empty-state')).toBeVisible();
});

test('wishlist, bag persistence, size validation and drawer dismissal', async ({ page }) => {
  const product = await chooseProduct(page);
  await page.getByRole('button', { name: 'Add to bag', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Choose an available size');
  await page.getByRole('button', { name: 'Save to wishlist', exact: true }).click();
  await page.getByRole('button', { name: 'Size M', exact: true }).click();
  await page.getByRole('button', { name: 'Add to bag', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(product.name);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Open bag, 1 items' }).click();
  await expect(page.getByRole('dialog')).toContainText(product.name);
  await page.keyboard.press('Escape');
  await page.goto('/wishlist');
  await expect(page.getByRole('heading', { level: 3, name: product.name })).toBeVisible();
  await noOverflow(page);
});

test('customer registration, address validation, COD checkout and order history', async ({ page }, testInfo) => {
  const product = await chooseProduct(page);
  await page.getByRole('button', { name: 'Size M', exact: true }).click();
  await page.getByRole('button', { name: 'Add to bag', exact: true }).click();
  await page.getByRole('link', { name: 'Continue to checkout' }).click();
  await page.getByRole('link', { name: 'Sign in or register', exact: true }).click();
  await page.waitForURL(/\/account\?next=/);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Full name', { exact: true }).fill('Browser Customer');
  await page.getByLabel('Email address', { exact: true }).fill(`browser-${testInfo.project.name}-${Date.now()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('BrowserCustomer2026!');
  await page.getByRole('button', { name: 'Create your account', exact: true }).click();
  await page.waitForURL('**/checkout');
  await page.getByRole('button', { name: 'Place COD order', exact: true }).click();
  await expect(page.getByText('Enter a valid 10-digit Indian mobile number.')).toBeVisible();
  await page.getByRole('textbox', { name: /^Mobile number/ }).fill('9876543210');
  await page.getByRole('textbox', { name: /^Street address/ }).fill('42 Demo Test Road');
  await page.getByRole('textbox', { name: /^City/ }).fill('Varanasi');
  await page.getByRole('textbox', { name: /^State \/ union territory/ }).fill('Uttar Pradesh');
  await page.getByRole('textbox', { name: /^PIN code/ }).fill('221005');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('checkout.png'), fullPage: true });
  await page.getByRole('button', { name: 'Place COD order', exact: true }).click();
  await page.waitForURL(/\/order\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Your order, recorded.' })).toBeVisible();
  await expect(page.locator('.order-details-grid')).toContainText(product.name);
  await expect(page.locator('.status')).toHaveText('placed');
  await expect(page.getByRole('button', { name: 'Open bag, 0 items' })).toBeVisible();
  const orderUrl = page.url();
  await page.reload();
  await expect(page.locator('.order-details-grid')).toContainText('42 Demo Test Road');
  await page.goto('/account');
  await expect(page.locator('.order-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.goto(orderUrl);
  await expect(page.getByRole('link', { name: 'Sign in or register', exact: true })).toBeVisible();
  await expect(page.locator('.order-details-grid')).toHaveCount(0);
});

test('admin product create/edit and order state transitions', async ({ page }, testInfo) => {
  await page.goto('/account?next=/admin');
  await page.getByLabel('Email address', { exact: true }).fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('BrowserTests2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await page.waitForURL('**/admin');
  await expect(page.locator('.stats-grid')).toBeVisible();
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  const form = page.locator('.product-editor');
  const name = `Browser ${testInfo.project.name} shirt`;
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Slug', { exact: true }).fill(`browser-${testInfo.project.name}-shirt`);
  await form.getByLabel('Colour', { exact: true }).fill('Sand');
  await form.getByLabel(/^Price \(whole INR/).fill('1499');
  await form.getByLabel('Description', { exact: true }).fill('Temporary browser-test sample product only.');
  await form.getByLabel(/^Main image/).fill('/images/photo-1596755094514-f87e34085b2c.jpg');
  await form.getByRole('spinbutton', { name: 'M', exact: true }).fill('5');
  await form.getByRole('button', { name: 'Create product', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByLabel('Find a product').fill(name);
  await page.locator('.inventory-row').getByRole('button', { name: 'Edit', exact: true }).click();
  await form.getByLabel(/^Price \(whole INR/).fill('1599');
  await form.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('.inventory-row')).toContainText('1,599');
  await page.screenshot({ path: testInfo.outputPath('admin.png'), fullPage: true });
  await noOverflow(page);
  const { products } = await (await page.request.get('/api/products')).json() as { products: Product[] };
  const fixtureOrder = await page.request.post('/api/orders', {
    headers: { 'X-Requested-With': 'UrbanKashi' },
    data: { items: [{ productId: products[0].id, size: 'M', quantity: 1 }],
      address: { name: 'Admin Test', phone: '9876543210', line1: '42 Demo Street', city: 'Varanasi', state: 'Uttar Pradesh', pincode: '221005' },
      idempotencyKey: `browser-admin-${testInfo.project.name}-${Date.now()}` },
  });
  expect(fixtureOrder.status()).toBe(201);
  const { order: createdOrder } = await fixtureOrder.json() as { order: { id: string } };
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  const order = page.locator('.admin-order').filter({ has: page.getByRole('combobox', { name: `Status for order ${createdOrder.id}`, exact: true }) });
  await expect(order).toHaveCount(1);
  await expect(order).toBeVisible();
  await order.getByRole('combobox').selectOption('confirmed');
  await order.getByRole('button', { name: 'Update status' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Order status updated to confirmed.' }).first()).toBeVisible();
  await expect(order.getByRole('combobox')).toHaveValue('confirmed');
});

test('unknown route and API outage are recoverable', async ({ page }) => {
  await page.goto('/this-page-does-not-exist');
  await expect(page.getByRole('link', { name: /Back to|Explore|collection/i }).first()).toBeVisible();
  await page.route('**/api/products', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test catalogue temporarily unavailable.' }) }));
  await page.goto('/shop');
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await page.unroute('**/api/products');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.product-card').first()).toBeVisible();
});