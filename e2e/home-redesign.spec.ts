import { test, expect, type Page } from '@playwright/test';
import type { Product } from '../shared/types';

const origin = 'http://127.0.0.1:4180';
const motionKey = 'uk-home-motion-paused';
const externalRequests = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  const unexpected: string[] = [];
  externalRequests.set(page, unexpected);
  // Fail closed: even a regressed image/CTA cannot contact :8080 or a remote host.
  await page.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).origin !== origin) {
      unexpected.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
});

test.afterEach(async ({ page }) => {
  expect(externalRequests.get(page), 'No remote photography or unexpected network destinations').toEqual([]);
});

async function frozenClock(page: Page) {
  await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-07T12:00:01Z'));
}

async function showSlide(page: Page, number: number) {
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', String(number));
  await expect(page.locator('.fashion-hero__slide.is-active')).toHaveCount(1);
  await expect(page.getByRole('group', { name: new RegExp(`^${number} of 3:`) })).toHaveCount(1);
  for (let index = 1; index <= 3; index++) {
    const slide = page.locator(`.fashion-hero__slide[data-slide="${index}"]`);
    await expect(slide).toHaveAttribute('aria-hidden', String(index !== number));
    await expect(page.getByRole('button', { name: new RegExp(`^Show slide ${index}:`) }))
      .toHaveAttribute('aria-pressed', String(index === number));
    if (index !== number) {
      await expect(page.getByRole('group', { name: new RegExp(`^${index} of 3:`) })).toHaveCount(0);
      await expect(slide).toHaveCSS('opacity', '0');
    }
  }
}

async function expectHeroMotion(page: Page, running: boolean) {
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-motion', running ? 'running' : 'stopped');
  await expect(page.locator('.fashion-hero__slide.is-active img'))
    .toHaveCSS('animation-play-state', running ? 'running' : 'paused');
  for (const photo of await page.locator('.fashion-hero__slide:not(.is-active) img').all()) {
    await expect(photo).toHaveCSS('animation-play-state', 'paused');
  }
}

async function leaveHeroControls(page: Page) {
  // Resume itself retains focus; both temporary blockers must be cleared.
  await page.getByRole('banner').getByRole('link', { name: 'Urban Kashi home', exact: true }).focus();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.mouse.move(0, 0);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-in-view', 'true');
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-hovered', 'false');
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-focus-within', 'false');
}

async function scrollToLookbook(page: Page) {
  await page.locator('.fashion-lookbook').evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }));
  await page.mouse.move(0, 0);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-in-view', 'false');
}

test('local editorial images load without network/CSP/runtime errors; carousel controls work by pointer and keyboard', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('requestfailed', request => problems.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => console.error(`CSP: ${event.violatedDirective} ${event.blockedURI}`));
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Wear your own energy.');
  await expect(page.getByRole('region', { name: 'Fashion editorial', exact: true })).toHaveAttribute('aria-roledescription', 'carousel');
  await expect(page.locator('#fashion-hero-slides')).toHaveAttribute('aria-live', 'off');
  await expect(page.locator('.fashion-hero__slide img')).toHaveCount(3);
  for (const image of await page.locator('.fashion-hero__slide img').all()) {
    await expect(image).toHaveAttribute('src', /^\/images\/.+\.jpg$/);
    await expect(image).toHaveAttribute('alt', /^Demo editorial photograph/);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  }
  await showSlide(page, 1);
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await showSlide(page, 2);
  await page.getByRole('button', { name: 'Previous slide', exact: true }).click();
  await showSlide(page, 1);
  await page.getByRole('button', { name: 'Previous slide', exact: true }).press('Enter');
  await showSlide(page, 3);
  await page.getByRole('button', { name: 'Next slide', exact: true }).press('Space');
  await showSlide(page, 1);
  await page.getByRole('button', { name: /^Show slide 3:/ }).click();
  await showSlide(page, 3);
  await page.getByRole('button', { name: /^Show slide 1:/ }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Show slide 2:/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await showSlide(page, 2);
  // Exercise lazy-loaded local category, product and lookbook photography too.
  for (const section of ['.fashion-categories', '#fashion-edit', '.fashion-lookbook']) {
    await page.locator(section).scrollIntoViewIfNeeded();
    for (const image of await page.locator(`${section} img`).all()) {
      await image.scrollIntoViewIfNeeded();
      await expect(image).toHaveAttribute('src', /^\/images\//);
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    }
  }
  expect(problems).toEqual([]);
});

test('reduced motion removes zoom and automatic slides but leaves manual navigation available', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await frozenClock(page);
  await page.goto('/');
  await leaveHeroControls(page);
  await expect(page.locator('.fashion-home')).toHaveAttribute('data-motion', 'reduced');
  await expect(page.locator('.fashion-home')).toHaveAttribute('data-reduced-motion', 'true');
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-motion', 'stopped');
  for (const image of await page.locator('.fashion-hero__photo, .fashion-lookbook__frame img, .uk-brand__trishul').all()) {
    await expect(image).toHaveCSS('animation-name', 'none');
    await expect(image).toHaveCSS('transform', 'none');
  }
  await page.clock.fastForward(18_000);
  await showSlide(page, 1);
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await showSlide(page, 2);
  await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
  await page.getByRole('button', { name: 'Resume motion', exact: true }).click();
  await leaveHeroControls(page);
  await page.clock.fastForward(12_000);
  await showSlide(page, 2);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-motion', 'stopped');
  await scrollToLookbook(page);
  await expect(page.locator('.fashion-lookbook')).toHaveAttribute('data-motion', 'stopped');
});

test('6000ms autoplay suspends on hover, focus and offscreen, then resumes with a fresh timer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await frozenClock(page);
  await page.goto('/');
  await leaveHeroControls(page);
  await expectHeroMotion(page, true);
  await page.clock.fastForward(5999);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '1');
  await page.clock.fastForward(1);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '2');
  await expectHeroMotion(page, true);

  // mouse.move explicitly exercises pointer hover even in the touch project.
  const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
  expect(heading).not.toBeNull();
  await page.mouse.move(heading!.x + 5, heading!.y + 5);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-hovered', 'true');
  await expectHeroMotion(page, false);
  await page.clock.fastForward(12_000);
  await showSlide(page, 2);
  await page.mouse.move(0, 0);
  await expectHeroMotion(page, true);
  await page.getByRole('button', { name: 'Next slide', exact: true }).focus();
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-focus-within', 'true');
  await expectHeroMotion(page, false);
  await page.clock.fastForward(12_000);
  await showSlide(page, 2);
  await leaveHeroControls(page);
  await expectHeroMotion(page, true);
  await scrollToLookbook(page);
  await expectHeroMotion(page, false);
  await expect(page.locator('.fashion-lookbook')).toHaveAttribute('data-motion', 'running');
  for (const image of await page.locator('.fashion-lookbook__frame img').all()) {
    await expect(image).toHaveCSS('animation-play-state', 'running');
  }
  await page.clock.fastForward(12_000);
  await showSlide(page, 2);
  await leaveHeroControls(page);
  await expectHeroMotion(page, true);
  await expect(page.locator('.fashion-lookbook')).toHaveAttribute('data-motion', 'stopped');
  await page.clock.fastForward(5999);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '2');
  await page.clock.fastForward(1);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '3');
});

test('user pause survives reload, stops hero/lookbook/brand motion and resumes only after leaving controls', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await frozenClock(page);
  await page.goto('/');
  await leaveHeroControls(page);
  await expectHeroMotion(page, true);
  await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume motion', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.fashion-home')).toHaveAttribute('data-motion', 'paused');
  await expect(page.locator('.fashion-home')).toHaveAttribute('data-user-paused', 'true');
  expect(await page.evaluate(key => localStorage.getItem(key), motionKey)).toBe('true');
  await leaveHeroControls(page);
  await expectHeroMotion(page, false);
  await page.clock.fastForward(12_000);
  await showSlide(page, 1);
  await page.reload();
  await expect(page.locator('.fashion-home')).toHaveAttribute('data-motion', 'paused');
  await expect(page.locator('.fashion-home')).toHaveAttribute('data-user-paused', 'true');
  await leaveHeroControls(page);
  await expectHeroMotion(page, false);
  await scrollToLookbook(page);
  await expect(page.locator('.fashion-lookbook')).toBeInViewport();
  await expect(page.locator('.fashion-lookbook')).toHaveAttribute('data-motion', 'stopped');
  for (const image of await page.locator('.fashion-lookbook__frame img, .uk-brand__trishul').all()) {
    await expect(image).toHaveCSS('animation-play-state', 'paused');
  }
  await leaveHeroControls(page);
  await page.getByRole('button', { name: 'Resume motion', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause motion', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.fashion-home')).toHaveAttribute('data-motion', 'running');
  expect(await page.evaluate(key => localStorage.getItem(key), motionKey)).toBe('false');
  await expectHeroMotion(page, false);
  await page.clock.fastForward(12_000);
  await showSlide(page, 1);
  await leaveHeroControls(page);
  await expectHeroMotion(page, true);
  for (const glyph of await page.locator('.uk-brand__trishul').all()) await expect(glyph).toHaveCSS('animation-play-state', 'running');
  await page.clock.fastForward(6000);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '2');
});

test('real catalogue tabs support roving keyboard selection, four-piece limits and working collection/category CTAs', async ({ page }) => {
  const response = await page.request.get('/api/products');
  expect(response.status()).toBe(200);
  const { products } = await response.json() as { products: Product[] };
  const auth = await page.request.get('/api/auth/me');
  expect(await auth.json()).toMatchObject({ user: null });
  await page.goto('/');
  const panel = page.getByRole('tabpanel');
  const names = ['The edit', 'Shirts', 'T-Shirts', 'Layers'];
  async function checkEdit(name: string) {
    const matching = products.filter(product => product.active && (name === 'The edit' || product.category === name));
    const expected = [...matching.filter(product => product.featured), ...matching.filter(product => !product.featured)].slice(0, 4);
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await expect(panel).toHaveAttribute('data-filter', name);
    await expect(panel).toHaveAccessibleName(name);
    await expect(panel.locator('.product-card')).toHaveCount(expected.length);
    await expect(panel.locator('.product-card h3')).toHaveText(expected.map(product => product.name));
    for (const [index, product] of expected.entries()) {
      await expect(panel.locator('.product-card h3 a').nth(index)).toHaveAttribute('href', `/product/${product.slug}`);
      await expect(panel.locator('.product-category').nth(index)).toHaveText(`${product.category} · ${product.color}`);
    }
    for (const tabName of names) {
      const tab = page.getByRole('tab', { name: tabName, exact: true });
      await expect(tab).toHaveAttribute('aria-selected', String(tabName === name));
      await expect(tab).toHaveAttribute('tabindex', tabName === name ? '0' : '-1');
      await expect(tab).toHaveAttribute('aria-controls', 'fashion-edit-panel');
    }
  }
  await checkEdit('The edit');
  await page.getByRole('tab', { name: 'The edit', exact: true }).focus();
  for (const [key, name] of [['ArrowRight', 'Shirts'], ['ArrowRight', 'T-Shirts'], ['End', 'Layers'], ['ArrowRight', 'The edit'], ['ArrowLeft', 'Layers'], ['Home', 'The edit']] as const) {
    await page.keyboard.press(key);
    await expect(page.getByRole('tab', { name, exact: true })).toBeFocused();
    await checkEdit(name);
  }
  await page.keyboard.press('Tab');
  await expect(panel).toBeFocused();
  await page.getByRole('tab', { name: 'Shirts', exact: true }).click();
  await checkEdit('Shirts');
  await page.getByRole('link', { name: 'Explore the edit', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/#fashion-edit`);
  await expect(page.getByRole('heading', { name: 'Your next rotation.', exact: true })).toBeInViewport();

  for (const [name, path] of [['Shop the collection', '/shop'], ['All clothing', '/shop'], ['See the collection', '/shop?sort=newest'], ['Explore layers', '/shop?category=Layers'], ['Our story', '/about']] as const) {
    await page.goto('/');
    const link = page.getByRole('main').getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('href', path);
    await link.click();
    await expect(page).toHaveURL(`${origin}${path}`);
  }
  for (const category of ['Shirts', 'T-Shirts', 'Trousers', 'Layers']) {
    const expected = products.filter(product => product.active && product.category === category);
    for (const strip of [false, true]) {
      await page.goto('/');
      const link = strip
        ? page.getByRole('navigation', { name: 'Explore clothing categories' }).getByRole('link', { name: category, exact: true })
        : page.getByRole('link', { name: `Shop ${category}`, exact: true });
      await expect(link).toHaveAttribute('href', `/shop?category=${category}`);
      await link.click();
      await expect(page).toHaveURL(`${origin}/shop?category=${category}`);
      await expect(page.locator('.product-card')).toHaveCount(expected.length);
      for (const text of await page.locator('.product-category').allTextContents()) expect(text.split('·')[0].trim()).toBe(category);
    }
  }
});

test('failed photography has an accessible fallback and catalogue failure retries into empty and recovered edits', async ({ page }) => {
  let catalogueState: 'error' | 'empty' | 'real' = 'error';
  await page.route('**/images/winter-editorial-41491.jpg', route => route.fulfill({ status: 200, contentType: 'image/jpeg', body: 'deliberately invalid test image' }));
  await page.route('**/api/products', route => catalogueState === 'real' ? route.fallback() : route.fulfill({
    status: catalogueState === 'error' ? 503 : 200,
    json: catalogueState === 'error' ? { error: 'Test edit temporarily unavailable.' } : { products: [] },
  }));
  await page.goto('/');
  const fallback = page.locator('.fashion-hero__slide.is-active .image-fallback');
  await expect(fallback).toHaveAccessibleName('Demo editorial photograph of a male model putting on a winter coat');
  await expect(fallback).toBeVisible();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('alert')).toContainText('Test edit temporarily unavailable.');
  catalogueState = 'empty';
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(panel.getByRole('heading', { name: 'The edit is taking shape.', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Shirts', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'No shirts in the edit yet.', exact: true })).toBeVisible();
  await expect(panel.locator('.product-card')).toHaveCount(0);
  await panel.getByRole('link', { name: 'Browse all clothing', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/shop`);
  catalogueState = 'error';
  await page.goto('/');
  await expect(panel.getByRole('alert')).toBeVisible();
  catalogueState = 'real';
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('.product-card').first()).toBeVisible();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await showSlide(page, 2);
  await expect.poll(() => page.locator('.fashion-hero__slide.is-active img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
});