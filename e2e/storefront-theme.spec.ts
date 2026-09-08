import { test, expect, type Page } from '@playwright/test';
import type { CartItem, Product } from '../shared/types';

const origin = 'http://127.0.0.1:4180';
const customSize = '44 / XXL Regular Fit';
const sample: Product = {
  id: 'card-fixture', slug: 'card-fixture', name: 'Everyday Winter Jacket', category: 'Layers', price: 4999,
  originalPrice: 5999, color: 'Black', description: 'Isolated browser fixture, not actual inventory.',
  details: [], image: '/images/photo-1544923246-77307dd654cb.jpg', images: [], badge: null,
  featured: true, active: true, variants: [{ size: 'M', stock: 1 }, { size: customSize, stock: 12 }, { size: 'L', stock: 0 }],
};

test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  await page.route(/^https?:\/\//, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
});
async function catalogue(page: Page, products: Product[]) {
  await page.route('**/api/products', route => route.fulfill({ json: { products } }));
}
async function bag(page: Page): Promise<CartItem[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('uk-bag-v1') || '[]'));
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function palette(page: Page) {
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.site-header')).toHaveCSS('background-color', /^rgba?\(17, 20, 18/);
  await expect(page.locator('.site-header')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.locator('.site-footer')).toHaveCSS('background-color', 'rgb(17, 20, 18)');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--gold').trim())).toBe('#e6c59a');
  await noOverflow(page);
}

test('one palette across storefront, customer, checkout, admin and light drawers', async ({ page }) => {
  for (const path of ['/', '/shop', '/wishlist', '/account', '/admin/login', '/about', '/shipping', '/privacy', '/missing-theme-route']) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await palette(page);
  }
  await page.getByRole('button', { name: 'Search collection', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.drawer-header')).toHaveCSS('background-color', 'rgb(17, 20, 18)');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Search collection', exact: true })).toBeFocused();
  // This credential exists only in e2e/server.ts's disposable database.
  const login = await page.request.post('/api/auth/admin/login', {
    headers: { 'X-Requested-With': 'UrbanKashi' }, data: { email: 'admin@example.test', password: 'BrowserTests2026!' },
  });
  expect(login.status()).toBe(200);
  await page.goto('/admin');
  await expect(page.locator('.stats-grid')).toBeVisible();
  await palette(page);
  await expect(page.locator('.stats-grid > div').first()).toHaveCSS('background-color', 'rgb(245, 245, 244)');
  await page.getByRole('button', { name: 'New product', exact: true }).click();
  await expect(page.locator('.product-editor')).toHaveCSS('background-color', 'rgb(245, 245, 244)');
  await noOverflow(page);
  const { products } = await (await page.request.get('/api/products')).json() as { products: Product[] };
  const product = products.find(p => p.variants.some(v => v.stock > 0))!;
  const size = product.variants.find(v => v.stock > 0)!.size;
  await page.evaluate(item => localStorage.setItem('uk-bag-v1', JSON.stringify([item])), { productId: product.id, size, quantity: 1 });
  await page.goto('/checkout');
  await expect(page.locator('.checkout-summary')).toBeVisible();
  await expect(page.locator('.checkout-summary')).toHaveCSS('background-color', 'rgb(245, 245, 244)');
  await palette(page);
  await page.goto('/account');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await palette(page);
});

test('readable names/prices and aligned card actions fit 320–1440px without clipping', async ({ page }, info) => {
  const products = [
    { ...sample, name: 'Short Jacket' },
    { ...sample, id: 'long', slug: 'long', name: 'Urban Kashi Heavyweight Winter Jacket With Extra Long Editorial Product Name', price: 999999, originalPrice: 1299999 },
    { ...sample, id: 'plain', slug: 'plain', name: 'Lightweight Black Bomber', originalPrice: null },
    { ...sample, id: 'sold', slug: 'sold', name: 'Sold-out Winter Layer', variants: [{ size: 'M', stock: 0 }] },
  ];
  await catalogue(page, products);
  await page.goto('/shop');
  await expect(page.locator('.product-card')).toHaveCount(4);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => document.fonts.ready);
    await noOverflow(page);
    const boxes = await page.locator('.product-card').evaluateAll(cards => cards.map(card => {
      const name = card.querySelector('h3')!;
      const price = card.querySelector('.product-price')!;
      const image = card.querySelector('.product-image-wrap')!;
      const actions = card.querySelector('.product-card-actions__buttons')!;
      const rect = card.getBoundingClientRect();
      return {
        top: rect.top, nameFont: parseFloat(getComputedStyle(name).fontSize), priceFont: parseFloat(getComputedStyle(price).fontSize),
        imageBottom: image.getBoundingClientRect().bottom, nameTop: name.getBoundingClientRect().top,
        nameBottom: name.getBoundingClientRect().bottom, priceTop: price.getBoundingClientRect().top,
        actionTop: actions.getBoundingClientRect().top,
        fits: [name, price, actions, card.querySelector('select')!].every(el => el.getBoundingClientRect().right <= rect.right + 1 && el.scrollWidth <= el.clientWidth + 1),
        targets: Array.from(actions.querySelectorAll('button')).every(el => el.getBoundingClientRect().height >= 44),
      };
    }));
    for (const box of boxes) {
      expect(box.nameFont).toBeGreaterThanOrEqual(16);
      expect(box.priceFont).toBeGreaterThanOrEqual(18);
      expect(box.imageBottom).toBeLessThanOrEqual(box.nameTop);
      expect(box.nameBottom).toBeLessThanOrEqual(box.priceTop + 1);
      expect(box.fits).toBe(true);
      expect(box.targets).toBe(true);
      for (const peer of boxes.filter(other => Math.abs(other.top - box.top) < 1)) {
        expect(Math.abs(peer.actionTop - box.actionTop)).toBeLessThanOrEqual(1);
        expect(Math.abs(peer.priceTop - box.priceTop)).toBeLessThanOrEqual(1);
      }
    }
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`shop-theme-${width}.png`), fullPage: true });
  }
});

test('card Add to bag requires size, supports keyboard/custom sizes and restores focus', async ({ page }) => {
  await catalogue(page, [sample]);
  await page.goto('/shop');
  const card = page.locator('.product-card');
  const add = card.getByRole('button', { name: /^Add to bag:/ });
  const size = card.getByRole('combobox');
  await add.click();
  await expect(card.getByRole('alert')).toContainText('Choose an available size');
  await expect(size).toBeFocused();
  expect(await bag(page)).toEqual([]);
  // Check the native option state; this Playwright version retargets disabled
  // assertions on <option> to its (intentionally enabled) parent <select>.
  await expect(size.locator('option[value="L"]')).toHaveJSProperty('disabled', true);
  await size.selectOption(customSize);
  await size.focus();
  await page.keyboard.press('Tab');
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText(customSize);
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => bag(page)).toEqual([{ productId: sample.id, size: customSize, quantity: 1 }]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open bag, 1 items' })).toBeVisible();
});

test('Buy now validates size, preserves existing bag and opens authentication-gated checkout without a bag dialog', async ({ page }) => {
  const other = { ...sample, id: 'other-jacket', slug: 'other-jacket', name: 'Another Jacket' };
  await catalogue(page, [sample, other]);
  await page.addInitScript(item => localStorage.setItem('uk-bag-v1', JSON.stringify([item])), { productId: other.id, size: 'M', quantity: 1 });
  await page.goto('/shop');
  const card = page.locator('.product-card').first();
  const buy = card.getByRole('button', { name: /^Buy now:/ });
  await buy.click();
  await expect(card.getByRole('alert')).toContainText('Choose an available size');
  await expect(page).toHaveURL(`${origin}/shop`);
  await card.getByRole('combobox').selectOption(customSize);
  await buy.click();
  await expect(page).toHaveURL(`${origin}/checkout`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in or register', exact: true })).toBeVisible();
  await expect.poll(() => bag(page)).toEqual([
    { productId: other.id, size: 'M', quantity: 1 }, { productId: sample.id, size: customSize, quantity: 1 },
  ]);
});

test('sold-out, stock, ten-unit and twenty-line limits block card purchases without changing the bag', async ({ page }) => {
  let products: Product[] = [sample, { ...sample, id: 'sold', slug: 'sold', name: 'Sold out piece', variants: [{ size: 'M', stock: 0 }] }];
  await page.route('**/api/products', route => route.fulfill({ json: { products } }));
  await page.goto('/shop');
  const seed = [{ productId: sample.id, size: 'M', quantity: 1 }, { productId: sample.id, size: customSize, quantity: 10 }];
  await page.evaluate(items => localStorage.setItem('uk-bag-v1', JSON.stringify(items)), seed);
  await page.reload();
  const first = page.locator('.product-card').first();
  const sold = page.locator('.product-card').nth(1);
  await expect(sold.getByRole('combobox')).toBeDisabled();
  await expect(sold.getByRole('button', { name: /^Sold out:/ })).toBeDisabled();
  await expect(sold.getByRole('button', { name: /^Buy now:/ })).toBeDisabled();
  await first.getByRole('combobox').selectOption('M');
  await expect(first.getByRole('alert')).toContainText('All available units');
  await expect(first.getByRole('button', { name: /^Add to bag:/ })).toBeDisabled();
  await expect(first.getByRole('button', { name: /^Buy now:/ })).toBeDisabled();
  await first.getByRole('combobox').selectOption(customSize);
  await expect(first.getByRole('alert')).toContainText('10 units');
  await expect(first.getByRole('button', { name: /^Buy now:/ })).toBeDisabled();
  expect(await bag(page)).toEqual(seed);

  products = Array.from({ length: 21 }, (_, i) => ({ ...sample, id: `limit-${i}`, slug: `limit-${i}`, name: `Limit jacket ${i}` }));
  const lines = products.slice(0, 20).map(p => ({ productId: p.id, size: customSize, quantity: 1 }));
  await page.evaluate(items => localStorage.setItem('uk-bag-v1', JSON.stringify(items)), lines);
  await page.reload();
  const last = page.locator('.product-card').last();
  await last.getByRole('combobox').selectOption(customSize);
  await expect(last.getByRole('alert')).toContainText('20 product/size lines');
  await expect(last.getByRole('button', { name: /^Buy now:/ })).toBeDisabled();
  expect(await bag(page)).toEqual(lines);
  // An existing line can still increase at the line cap, within its stock/quantity cap.
  await first.getByRole('combobox').selectOption(customSize);
  await first.getByRole('button', { name: /^Add to bag:/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(async () => (await bag(page))[0].quantity).toBe(2);
  expect((await bag(page)).length).toBe(20);
});

test('detail Buy now uses selected quantity and does not skip size validation', async ({ page }) => {
  const { products } = await (await page.request.get('/api/products')).json() as { products: Product[] };
  const product = products.find(p => p.variants.some(v => v.stock >= 2))!;
  const size = product.variants.find(v => v.stock >= 2)!.size;
  await page.goto(`/product/${product.slug}`);
  const detail = page.locator('.product-detail-copy');
  await detail.getByRole('button', { name: 'Buy now', exact: true }).click();
  await expect(detail.getByRole('alert')).toContainText('Choose an available size');
  await detail.getByRole('button', { name: `Size ${size}`, exact: true }).click();
  await detail.getByRole('button', { name: 'Increase Quantity', exact: true }).click();
  await detail.getByRole('button', { name: 'Buy now', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/checkout`);
  await expect.poll(() => bag(page)).toEqual([{ productId: product.id, size, quantity: 2 }]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('homepage and wishlist reuse the same visible card purchase controls', async ({ page }) => {
  await catalogue(page, [sample]);
  await page.goto('/');
  const featured = page.locator('.featured-section .product-card');
  await expect(featured.getByRole('button', { name: /^Add to bag:/ })).toBeVisible();
  await expect(featured.getByRole('button', { name: /^Buy now:/ })).toBeVisible();
  await featured.getByRole('button', { name: /^Save .* to wishlist$/ }).click();
  await page.goto('/wishlist');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await page.locator('.product-card').getByRole('combobox').selectOption('M');
  await page.locator('.product-card').getByRole('button', { name: /^Add to bag:/ }).click();
  await expect(page.getByRole('dialog')).toContainText(sample.name);
});