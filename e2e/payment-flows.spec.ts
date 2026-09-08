import { randomUUID } from 'node:crypto';
import { test as base, expect, type Page } from '@playwright/test';
import type { Address, CartItem, OnlineCheckout, Order, PaymentConfig, Product, User } from '../shared/types';
import type { CheckoutAttempt, RazorpayResponse } from '../src/lib/payments';

// FRONTEND CONTRACT TESTING with intercepted backend responses and a test-only
// window.Razorpay constructor. NOT real gateway end-to-end testing, provider
// verification, or live transactions. Auth/catalogue alone use the isolated
// :4180 server (paymentGateway: null); no production fake or external SDK is used.
// No project filter: the existing desktop AND mobile projects run all four tests.
const origin = 'http://127.0.0.1:4180';
const headers = { 'X-Requested-With': 'UrbanKashi' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const address: Address = {
  name: 'Synthetic Payment Customer', phone: '9876543210',
  line1: '42 Synthetic Contract Road', city: 'Varanasi', state: 'Uttar Pradesh', pincode: '221005',
};
type GatewayOptions = ConstructorParameters<NonNullable<Window['Razorpay']>>[0];
interface BrowserGateway {
  opens: number;
  closes: number;
  options?: GatewayOptions;
  failure?: () => void;
}
declare global { interface Window { __paymentContract: BrowserGateway } }
type ContractWindow = Window;

// Automatic teardown assertions also run if a scenario fails. All external HTTP
// traffic is aborted, not merely observed; even a changed provider hostname fails.
const test = base.extend<{ networkGuard: void }>({
  networkGuard: [async ({ page, baseURL }, use) => {
    expect(baseURL).toBe(origin);
    const external: string[] = [];
    const runtimeErrors: string[] = [];
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url());
    });
    page.on('pageerror', error => runtimeErrors.push(error.message));
    await page.route(/^https?:\/\//, async route => {
      if (new URL(route.request().url()).origin !== origin) await route.abort();
      else await route.fallback();
    });
    await page.addInitScript(() => {
      const state: BrowserGateway = { opens: 0, closes: 0 };
      (window as ContractWindow).__paymentContract = state;
      window.Razorpay = class {
        constructor(options: GatewayOptions) { state.options = options; }
        on(event: 'payment.failed', callback: () => void) {
          if (event === 'payment.failed') state.failure = callback;
        }
        open() { state.opens += 1; }
        close() { state.closes += 1; }
      };
    });
    try { await use(); }
    finally {
      expect(external, 'No provider script, API, iframe, or other external request may be attempted').toEqual([]);
      expect(runtimeErrors).toEqual([]);
      if (!page.isClosed()) await expect(page.locator('script[src*="razorpay"]')).toHaveCount(0);
    }
  }, { auto: true }],
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function bag(page: Page, expected: CartItem[]) {
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('uk-bag-v1') || '[]'))).toEqual(expected);
  const count = expected.reduce((sum, item) => sum + item.quantity, 0);
  await expect(page.getByRole('button', { name: `Open bag, ${count} items`, exact: true })).toBeVisible();
}

async function attempts(page: Page, userId: string): Promise<CheckoutAttempt[]> {
  return page.evaluate(id => JSON.parse(sessionStorage.getItem(`uk-checkout-attempt:${id}`) || '[]'), userId);
}

async function fillCheckout(page: Page) {
  for (const [label, value] of [
    ['Full name', address.name], ['Mobile number', address.phone], ['Street address', address.line1],
    ['City', address.city], ['State / union territory', address.state], ['PIN code', address.pincode],
  ]) await page.getByRole('textbox', { name: label, exact: true }).fill(value);
  await page.getByRole('radio', { name: /^Online · Razorpay/ }).check();
}

async function noPaidClaim(page: Page) {
  await expect(page.getByRole('heading', { name: 'Your order, recorded.', exact: true })).toHaveCount(0);
  await expect(page.getByText('Payment verified by the server.', { exact: true })).toHaveCount(0);
  await expect(page.locator('.toast-region')).not.toContainText('Payment verified');
  await expect(page.locator('.payment-notice strong').filter({ hasText: /^Razorpay · paid$/ })).toHaveCount(0);
}

async function setup(page: Page, verifyFailure?: 'rejection' | 'timeout') {
  // APIRequestContext is deliberately NOT routed: prove the actual server still
  // has online payments disabled, and obtain a real, unique authenticated user.
  const configResponse = await page.request.get('/api/payments/config');
  expect(configResponse.status()).toBe(200);
  expect(await configResponse.json()).toMatchObject({ online: false, mode: 'disabled' });
  const registered = await page.request.post('/api/auth/register', {
    headers, data: { name: address.name, email: `payment-${randomUUID()}@example.test`, password: 'SyntheticContract2026!' },
  });
  expect(registered.status()).toBe(201);
  const { user } = await registered.json() as { user: User };
  const catalogue = await page.request.get('/api/products');
  expect(catalogue.status()).toBe(200);
  const { products } = await catalogue.json() as { products: Product[] };
  const product = products.find(p => p.active && p.variants.some(v => v.stock >= 3));
  if (!product) throw new Error('Isolated catalogue needs one active product with at least three units.');
  const variant = product.variants.find(v => v.stock >= 3)!;
  const items: CartItem[] = [{ productId: product.id, size: variant.size, quantity: 1 }];
  // Immutable order fields and paise checkout amount derive from the real
  // catalogue's trusted price/size, never from client-submitted price fields.
  const id = randomUUID();
  const gatewayOrderId = `order_contract_${id.replaceAll('-', '')}`;
  const subtotal = product.price;
  const shipping = subtotal >= 2499 ? 0 : 99;
  const pending: Order = {
    id, userId: user.id, address, items: [{
      ...items[0]!, name: product.name, image: product.image, price: product.price,
      color: product.color, brand: product.brand, design: product.design, barcode: variant.barcode, sku: variant.sku,
    }], subtotal, shipping, total: subtotal + shipping, paymentMethod: 'Razorpay',
    paymentStatus: 'pending', status: 'placed', createdAt: new Date().toISOString(), gatewayOrderId, paidAt: null,
  };
  const paid: Order = { ...pending, paymentStatus: 'paid', paidAt: new Date().toISOString() };
  const config: PaymentConfig = {
    online: true, mode: 'test', keyId: 'rzp_test_contract_only',
    reason: 'Intercepted frontend contract fixture; no provider connection.', methods: ['upi', 'card'],
  };
  const checkout: NonNullable<OnlineCheckout['checkout']> = {
    key: config.keyId!, order_id: gatewayOrderId, amount: pending.total * 100, currency: 'INR', name: 'URBAN KASHI',
  };
  const callback: RazorpayResponse = {
    razorpay_order_id: gatewayOrderId, razorpay_payment_id: `pay_contract_${id.replaceAll('-', '')}`,
    razorpay_signature: 'synthetic_callback_not_a_real_signature',
  };
  const createGate = gate();
  const verifyGate = gate();
  const reconcileGate = gate();
  const state = {
    order: pending, verifyOrder: paid, reconcileOrder: paid,
    creates: [] as { items: CartItem[]; address: Address; idempotencyKey: string }[],
    verifies: [] as unknown[], reconciles: [] as string[], reads: [] as string[], unexpected: [] as string[],
  };
  // Replaced between sequential subcases; interception stays local to this page.
  await page.unroute('**/api/payments/**');
  await page.unroute('**/api/orders/**');
  await page.unroute('**/api/orders');
  await page.route('**/api/payments/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/payments/config' && request.method() === 'GET') {
      await route.fulfill({ json: config }); return;
    }
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-requested-with']).toBe('UrbanKashi');
    if (path === '/api/payments/create') {
      const body = request.postDataJSON();
      state.creates.push(body);
      expect(body).toEqual({ items, address, idempotencyKey: expect.stringMatching(uuid) });
      await createGate.promise;
      await route.fulfill({ status: 201, json: { order: pending, checkout } satisfies OnlineCheckout });
    } else if (path === '/api/payments/verify') {
      state.verifies.push(request.postDataJSON());
      expect(request.postDataJSON()).toEqual({ orderId: id, ...callback });
      await verifyGate.promise;
      if (verifyFailure === 'rejection') {
        await route.fulfill({ status: 422, json: { error: 'Synthetic verification rejection: signature not accepted.' } });
      } else if (verifyFailure === 'timeout') {
        // Simulate a transport timeout/rejected fetch, NOT the real 30s
        // AbortSignal deadline or a provider timeout. No arbitrary sleeps.
        await route.abort('timedout');
      } else {
        state.order = state.verifyOrder;
        await route.fulfill({ json: { order: state.order } });
      }
    } else if (path === `/api/payments/reconcile/${id}`) {
      state.reconciles.push(id);
      expect(request.postData()).toBeNull();
      await reconcileGate.promise;
      state.order = state.reconcileOrder;
      await route.fulfill({ json: { order: state.order } });
    } else {
      state.unexpected.push(`${request.method()} ${path}`);
      await route.abort();
    }
  });
  await page.route('**/api/orders/**', async route => {
    const path = new URL(route.request().url()).pathname;
    state.reads.push(path);
    expect(route.request().method()).toBe('GET');
    expect(path).toBe(`/api/orders/${id}`);
    await route.fulfill({ json: { order: state.order } });
  });
  await page.route('**/api/orders', async route => {
    state.unexpected.push(`${route.request().method()} /api/orders`);
    await route.abort(); // A regression must never create a real COD order.
  });
  await page.goto(`/product/${product.slug}`);
  await bag(page, []);
  await page.getByRole('button', { name: `Size ${variant.size}`, exact: true }).click();
  await page.getByRole('button', { name: 'Add to bag', exact: true }).click();
  await page.getByRole('link', { name: 'Continue to checkout', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/checkout`);
  await expect(page.getByRole('radio', { name: /^Cash on delivery/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Online · Razorpay/ })).toBeEnabled();
  await expect(page.locator('#online-payment-info')).toContainText('TEST MODE');
  await fillCheckout(page);
  await bag(page, items);

  async function start() {
    const submit = page.getByRole('button', { name: 'Continue to TEST payment', exact: true });
    // Two native clicks in one turn; a Playwright second click would wait for
    // disabled to clear and accidentally test a later, separate attempt.
    await submit.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect.poll(() => state.creates.length).toBe(1);
    await expect(page.locator('form.checkout-grid')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Please wait…', exact: true })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Full name', exact: true })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /^Cash on delivery/ })).toBeDisabled();
    expect(await attempts(page, user.id)).toMatchObject([{ key: state.creates[0]!.idempotencyKey }]);
    await bag(page, items);
    await noPaidClaim(page);
    createGate.release();
    await expect.poll(() => page.evaluate(() => (window as ContractWindow).__paymentContract.opens)).toBe(1);
    const options = await page.evaluate(() => {
      const { handler: _handler, modal: _modal, ...values } = (window as ContractWindow).__paymentContract.options!;
      return values;
    });
    expect(options).toEqual({ ...checkout, prefill: { name: address.name, email: user.email, contact: address.phone }, retry: { enabled: false } });
    await expect.poll(() => attempts(page, user.id)).toMatchObject([{ key: state.creates[0]!.idempotencyKey, orderId: id }]);
  }
  async function submitCallback() {
    await page.evaluate(response => (window as ContractWindow).__paymentContract.options!.handler(response), callback);
    await expect.poll(() => state.verifies.length).toBe(1);
    await expect(page).toHaveURL(`${origin}/checkout`);
    await expect(page.getByRole('status').filter({ hasText: 'Verifying payment with the store server…' })).toBeVisible();
    const busyButton = page.getByRole('button', { name: 'Please wait…', exact: true });
    await expect(busyButton).toBeDisabled();
    await busyButton.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await noPaidClaim(page);
    await bag(page, items);
    expect(state.creates).toHaveLength(1);
    expect(state.verifies).toHaveLength(1);
  }
  async function pendingPage() {
    await expect(page).toHaveURL(`${origin}/order/${id}`);
    await expect(page.getByRole('heading', { name: 'Payment pending.', exact: true })).toBeVisible();
    await expect(page.locator('.order-reference')).toContainText(id);
    await expect(page.locator('.payment-notice strong')).toHaveText('Razorpay · pending');
    await expect(page.locator('.order-details-grid')).toContainText(`Size ${variant.size} · Qty 1`);
    await noPaidClaim(page);
    await bag(page, items);
    expect(await attempts(page, user.id)).toMatchObject([{ key: state.creates[0]!.idempotencyKey, orderId: id }]);
  }
  function counts(verifyCount: number, reconcileCount = 0) {
    expect(state.creates).toHaveLength(1);
    expect(state.verifies).toHaveLength(verifyCount);
    expect(state.reconciles).toHaveLength(reconcileCount);
    expect(state.reads.length).toBeGreaterThan(0);
    expect(state.unexpected).toEqual([]);
  }
  return { user, product, variant, items, id, state, start, submitCallback, pendingPage, counts, verifyGate, reconcileGate };
}

test('callback alone cannot claim paid; server verification clears the original bag', async ({ page }) => {
  const flow = await setup(page);
  await flow.start();
  await flow.submitCallback(); // Verification response remains held; bag is intact.
  flow.verifyGate.release();
  await expect(page).toHaveURL(`${origin}/order/${flow.id}`);
  await expect(page.getByRole('heading', { name: 'Your order, recorded.', exact: true })).toBeVisible();
  await expect(page.locator('.payment-notice strong')).toHaveText('Razorpay · paid');
  await expect(page.locator('.payment-notice')).toContainText('Payment verified by the server.');
  await bag(page, []);
  expect(await attempts(page, flow.user.id)).toEqual([]);
  await page.reload();
  await expect(page.locator('.payment-notice strong')).toHaveText('Razorpay · paid');
  await bag(page, []);
  flow.counts(1);
});

test('authorized but uncaptured callback remains server-pending and retains the bag', async ({ page }) => {
  const flow = await setup(page);
  // Authorized is a provider state, not an Order.paymentStatus. The backend
  // contract maps uncaptured authorization to pending, never invents "paid".
  flow.state.verifyOrder = flow.state.order;
  await flow.start();
  await flow.submitCallback();
  flow.verifyGate.release();
  await flow.pendingPage();
  await expect(page.getByRole('status').filter({ hasText: 'Payment has not been confirmed as paid by the server.' })).toBeVisible();
  await page.reload();
  await flow.pendingPage();
  // A later paid record with a refund/review hold is not a clean success.
  flow.state.reconcileOrder = { ...flow.state.reconcileOrder, paymentReview: 'Synthetic refund review: fulfilment is on hold.' };
  await page.getByRole('button', { name: 'Check payment status', exact: true }).click();
  flow.reconcileGate.release();
  await expect(page.locator('.payment-notice strong')).toHaveText('Razorpay · review required');
  await expect(page.locator('.payment-notice')).toContainText('Synthetic refund review');
  await noPaidClaim(page);
  await bag(page, flow.items);
  expect(await attempts(page, flow.user.id)).toMatchObject([{ orderId: flow.id }]);
  flow.counts(1, 1);
});

test('dismiss/fail recovers the same order without another create; reconciliation clears only its unchanged bag', async ({ page }) => {
  test.setTimeout(90_000);
  for (const outcome of ['dismiss', 'fail'] as const) await test.step(outcome, async () => {
    // Each subcase has a new real account, UUID order, attempt key and route
    // state. The first clears its bag before the second is initialized.
    const flow = await setup(page);
    await flow.start();
    await page.evaluate(kind => {
      const state = (window as ContractWindow).__paymentContract;
      if (kind === 'dismiss') state.options!.modal.ondismiss();
      else { state.failure!(); state.options!.modal.ondismiss(); } // Providers may fire both; settle once.
    }, outcome);
    await flow.pendingPage();
    await expect(page.getByRole('status').filter({ hasText: outcome === 'dismiss' ? 'Payment checkout was closed.' : 'The payment attempt failed.' })).toBeVisible();
    expect(await page.evaluate(() => (window as ContractWindow).__paymentContract.closes)).toBe(outcome === 'fail' ? 1 : 0);
    const originalAttempt = (await attempts(page, flow.user.id))[0]!;
    expect(JSON.parse(originalAttempt.signature)).toEqual({ userId: flow.user.id, method: 'Razorpay', items: flow.items, address });
    await page.reload();
    await flow.pendingPage();
    await page.goto('/checkout');
    await expect(page.getByRole('link', { name: `Check existing order ${flow.id.slice(0, 8)}`, exact: true })).toHaveAttribute('href', `/order/${flow.id}`);
    await fillCheckout(page);
    const submit = page.getByRole('button', { name: 'Continue to TEST payment', exact: true });
    await expect(submit).toBeDisabled();
    // Current UI requires explicit acknowledgement even for an unchanged
    // attempt. Acknowledging must STILL reopen the saved order, not create one.
    await page.getByRole('checkbox', { name: /^I checked the existing orders and intentionally want a separate order/ }).check();
    await submit.click();
    await flow.pendingPage();
    expect(await attempts(page, flow.user.id)).toEqual([originalAttempt]);
    flow.counts(0);
    expect(await page.evaluate(() => (window as ContractWindow).__paymentContract.opens)).toBe(0);

    const retained = outcome === 'fail' ? [{ ...flow.items[0]!, quantity: 2 }] : [];
    if (outcome === 'fail') {
      // A newer bag is changed through real UI, never patched Store state.
      await page.goto(`/product/${flow.product.slug}`);
      await page.getByRole('button', { name: `Size ${flow.variant.size}`, exact: true }).click();
      await page.getByRole('button', { name: 'Add to bag', exact: true }).click();
      await page.keyboard.press('Escape');
      await bag(page, retained);
      await page.goto(`/order/${flow.id}`);
      await expect(page.getByRole('heading', { name: 'Payment pending.', exact: true })).toBeVisible();
    }
    const check = page.getByRole('button', { name: 'Check payment status', exact: true });
    await check.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect.poll(() => flow.state.reconciles.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Checking payment…', exact: true })).toBeDisabled();
    await noPaidClaim(page);
    await bag(page, outcome === 'fail' ? retained : flow.items);
    flow.reconcileGate.release();
    await expect(page.locator('.payment-notice strong')).toHaveText('Razorpay · paid');
    await expect(page.getByRole('heading', { name: 'Your order, recorded.', exact: true })).toBeVisible();
    await bag(page, retained);
    expect(await attempts(page, flow.user.id)).toEqual([]);
    await page.reload();
    await expect(page.locator('.payment-notice strong')).toHaveText('Razorpay · paid');
    await bag(page, retained);
    flow.counts(0, 1);
  });
});

test('verification rejection or transport timeout never shows success or loses the pending reference', async ({ page }) => {
  test.setTimeout(90_000);
  for (const failure of ['rejection', 'timeout'] as const) await test.step(failure, async () => {
    const flow = await setup(page, failure);
    await flow.start();
    await flow.submitCallback();
    flow.verifyGate.release();
    await flow.pendingPage();
    await expect(page.getByRole('status').filter({ hasText: 'Payment is not confirmed here. Check this existing order before paying again.' })).toBeVisible();
    if (failure === 'rejection') await expect(page.getByRole('status').filter({ hasText: 'Synthetic verification rejection: signature not accepted.' })).toBeVisible();
    await page.reload();
    await flow.pendingPage();
    flow.counts(1);
    // User-driven cleanup between subcases only AFTER proving persistence.
    // This is not payment completion: the pending attempt must survive removal.
    await page.getByRole('button', { name: 'Open bag, 1 items', exact: true }).click();
    await page.getByRole('button', { name: `Remove ${flow.product.name}, size ${flow.variant.size}`, exact: true }).click();
    await page.keyboard.press('Escape');
    await bag(page, []);
    expect(await attempts(page, flow.user.id)).toMatchObject([{ orderId: flow.id }]);
  });
});