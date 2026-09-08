import { test, expect } from '@playwright/test';

test.beforeEach(async ({ baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:4180');
});

test('dedicated administrator sign-in opens product management without customer registration', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Administrator sign-in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole('heading', { name: 'Administrator sign-in.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create your account' })).toHaveCount(0);
  await page.getByLabel('Admin email', { exact: true }).fill('admin@example.test');
  await page.getByLabel('Admin password', { exact: true }).fill('BrowserTests2026!');
  await page.getByRole('button', { name: 'Sign in to admin', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('button', { name: 'New product', exact: true })).toBeVisible();
  await page.goto('/admin/login');
  await expect(page).toHaveURL(/\/admin$/);
});

test('customer cannot use admin login and retains their session after denial', async ({ page }, testInfo) => {
  const email = `admin-denied-${testInfo.project.name}-${Date.now()}@example.test`;
  const password = 'CustomerTest2026!';
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'X-Requested-With': 'UrbanKashi' }, data: { email, password, name: 'Customer Test' },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Administrator sign-in', exact: true }).click();
  await page.getByLabel('Admin email', { exact: true }).fill(email);
  await page.getByLabel('Admin password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to admin', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid administrator credentials');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole('button', { name: 'New product', exact: true })).toHaveCount(0);
  const current = await page.request.get('/api/auth/me');
  expect((await current.json()).user.email).toBe(email);
  await page.getByRole('link', { name: 'Customer account portal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});