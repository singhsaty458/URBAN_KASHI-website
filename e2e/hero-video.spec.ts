import { test, expect, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:4180';
test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  await page.route(/^https?:\/\//, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
});

async function start(page: Page) {
  await page.clock.install({ time: new Date('2026-09-08T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-08T12:00:01Z'));
  await page.goto('/');
  await leaveControls(page);
}

async function leaveControls(page: Page) {
  await page.getByRole('banner').getByRole('link', { name: 'Urban Kashi home', exact: true }).focus();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.mouse.move(0, 0);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-in-view', 'true');
}

test('real local clips decode and play silently; only active video loads and background playback stops', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await start(page);
  const first = page.locator('.fashion-hero__slide[data-slide="1"] video');
  await expect(first).toHaveAttribute('data-video-state', 'ready');
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => video.currentTime > 0 && video.videoWidth > 0 && !video.paused)).toBe(true);
  expect(await first.evaluate((video: HTMLVideoElement) => ({ muted: video.muted, inline: video.playsInline, loop: video.loop })))
    .toEqual({ muted: true, inline: true, loop: true });
  await expect(page.locator('.fashion-hero__slide:not(.is-active) video[src]')).toHaveCount(0);
  const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
  expect(heading).not.toBeNull();
  await page.mouse.move(heading!.x + 5, heading!.y + 5);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-hovered', 'true');
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-motion', 'running');
  const frames = await first.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(frames);
  await page.getByRole('button', { name: 'Next slide', exact: true }).focus();
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-motion', 'stopped');
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-video-motion', 'running');
  const focusedFrames = await first.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(focusedFrames);
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-direction', 'next');
  await expect.poll(() => first.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await leaveControls(page);
  const second = page.locator('.fashion-hero__slide[data-slide="2"] video');
  await expect(second).toHaveAttribute('data-video-state', 'ready');
  await expect.poll(() => second.evaluate((video: HTMLVideoElement) => video.currentTime > 0 && !video.paused)).toBe(true);
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  const third = page.locator('.fashion-hero__slide[data-slide="3"] video');
  await expect(third).toHaveAttribute('data-video-state', 'ready');
  await expect.poll(() => third.evaluate((video: HTMLVideoElement) => video.videoWidth > 0 && video.currentTime > 0 && !video.paused)).toBe(true);
  await page.getByRole('button', { name: 'Previous slide', exact: true }).click();
  await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
  await leaveControls(page);
  await expect.poll(() => page.locator('.fashion-hero video').evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).paused))).toBe(true);
  await page.clock.fastForward(12000);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '2');
  await page.getByRole('button', { name: 'Resume motion', exact: true }).click();
  await leaveControls(page);
  await expect.poll(() => second.evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  await page.locator('.fashion-lookbook').evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-in-view', 'false');
  await expect.poll(() => second.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  expect(errors).toEqual([]);
});

test('reduced motion and data saver keep local posters without downloading video', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/videos/')) requests.push(request.url()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page);
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(page.locator('.fashion-hero__slide.is-active')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.fashion-hero video[src]')).toHaveCount(0);
  await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }));
  await page.reload();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await leaveControls(page);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-save-data', 'true');
  await page.clock.fastForward(6000);
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '2');
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '3');
  await expect(page.locator('.fashion-hero video[src]')).toHaveCount(0);
  expect(requests).toEqual([]);
});

for (const failure of ['decode', 'autoplay'] as const) {
  test(`${failure} failure leaves a poster and working slide controls`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    if (failure === 'decode') {
      await page.route('**/videos/winter-editorial-1.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: 'invalid test MP4' }));
    } else {
      await page.addInitScript(() => { HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Autoplay blocked in test', 'NotAllowedError')); });
    }
    await start(page);
    const first = page.locator('.fashion-hero__slide[data-slide="1"]');
    await expect(first.locator('video')).toHaveAttribute('data-video-state', 'fallback');
    await expect(first.locator('video')).toHaveCSS('opacity', '0');
    await expect(first.locator('img')).toBeVisible();
    await expect.poll(() => first.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth > 0)).toBe(true);
    await page.getByRole('button', { name: 'Next slide', exact: true }).click();
    await expect(page.locator('.fashion-hero')).toHaveAttribute('data-active-slide', '2');
  });
}

test('left/right swipe changes slides, vertical gesture does not, and manual controls slide horizontally', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await start(page);
  const hero = page.locator('.fashion-hero');
  async function swipe(dx: number, dy: number) {
    // Synthetic pointer sequence tests gesture discrimination on both desktop and mobile projects.
    await hero.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 250, clientY: 300 });
    await hero.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 250 + dx, clientY: 300 + dy });
  }
  await swipe(-100, 5);
  await expect(hero).toHaveAttribute('data-active-slide', '2');
  await expect(hero).toHaveAttribute('data-direction', 'next');
  await expect(page.locator('.fashion-hero__slide.is-active')).toHaveCSS('animation-name', 'fashion-slide-in');
  // Inspect an actual in-between animation frame, not just the CSS animation name.
  const transition = await page.locator('.fashion-hero__slide.is-active').evaluate(element => {
    const animation = element.getAnimations()[0];
    animation.pause();
    animation.currentTime = 425;
    const x = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
    const width = element.getBoundingClientRect().width;
    animation.finish();
    return { x, width };
  });
  expect(transition.x).toBeGreaterThan(0);
  expect(transition.x).toBeLessThan(transition.width);
  await swipe(100, 5);
  await expect(hero).toHaveAttribute('data-active-slide', '1');
  await expect(hero).toHaveAttribute('data-direction', 'previous');
  await swipe(10, 100);
  await expect(hero).toHaveAttribute('data-active-slide', '1');
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(page.locator('.fashion-hero__slide.is-active')).toHaveCSS('animation-name', 'fashion-slide-in');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});