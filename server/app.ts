import express, { type ErrorRequestHandler, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AdminStats, Order, Product, User } from '../shared/types.js';
import {
  getOrder, getProduct, getProductBySlug, insertProduct, listOrders, listProducts,
  archiveSoldOutProducts, openDatabase, publicUser, setDatabaseClock, transaction, updateProduct,
  type StoreDatabase, type UserRow,
} from './db.js';
import { HttpError } from './errors.js';
import { reserveOrder, restoreOrderStock } from './orders.js';
import { gatewayFromEnvironment, type PaymentGateway } from './payment-gateway.js';
import { PaymentService } from './payments.js';
import { commitCatalogueImport, csvBodySchema, planCatalogueImport } from './catalogue.js';
import { clearSession, currentUser, issueSession, revokeSession } from './auth.js';
import { canonicalPath, IMAGE_LIMITS, ImageStore } from './images.js';
import {
  checkoutSchema, loginSchema, productPatchSchema, productSchema, registerSchema,
  statusSchema, validateProductPrices,
} from './validation.js';

export interface AppOptions {
  databasePath?: string;
  /** An injected connection remains owned by the caller. */
  db?: StoreDatabase;
  seed?: boolean;
  secureCookies?: boolean;
  /** Disable static serving in tests, or supply a compiled SPA directory. */
  distPath?: string | false;
  /** Only for isolated tests; enabled by default, including production. */
  rateLimit?: false;
  /** Trusted server injection; null explicitly disables payments and skips all environment access. */
  paymentGateway?: PaymentGateway | null;
  /** Private image directory; memory databases otherwise use an isolated, lazily created temp directory. */
  uploadsPath?: string;
  /** Managed-file quota, default 200 MiB. Trusted server/test configuration only. */
  uploadsQuotaBytes?: number;
  /** Disables background sweeps only; request-time lifecycle enforcement remains enabled. */
  disableMaintenance?: boolean;
  /** Trusted lifecycle/cleanup clock for isolated tests. Does not alter session expiry. */
  clock?: () => number;
}
const dummyPasswordHash = bcrypt.hashSync(randomBytes(32).toString('hex'), 12);
const transitions: Record<Order['status'], Order['status'][]> = {
  placed: ['confirmed', 'cancelled'], confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered'], delivered: [], cancelled: [],
};
const userOf = (res: Response): User => res.locals.user as User;
const parameter = (value: string | string[]): string => Array.isArray(value) ? value[0]! : value;

/** Express app factory. Close app.locals.closeDatabase() after draining requests. */
export function createApp(optionsOrPath: AppOptions | string = {}) {
  const options = typeof optionsOrPath === 'string' ? { databasePath: optionsOrPath } : optionsOrPath;
  const db = options.db ?? openDatabase(options.databasePath, { seed: options.seed });
  if (options.clock) setDatabaseClock(db, options.clock);
  const gateway = options.paymentGateway === undefined ? gatewayFromEnvironment() : options.paymentGateway;
  const payments = new PaymentService(db, gateway);
  const secureCookies = options.secureCookies ?? process.env.COOKIE_SECURE === 'true';
  const distPath = options.distPath === false ? false : resolve(options.distPath ?? resolve(import.meta.dirname, '../dist'));
  // A misconfigured database must never become a downloadable static asset.
  if (distPath) {
    const databases = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
    const insideDist = databases.some(({ file }) => {
      if (!file) return false;
      const path = relative(canonicalPath(distPath), canonicalPath(file));
      return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    });
    if (insideDist) {
      if (!options.db) db.close();
      throw new Error('DATABASE_PATH must be outside the compiled public directory.');
    }
  }

  let images: ImageStore;
  try {
    images = new ImageStore(db, { uploadsPath: options.uploadsPath,
      distPath: distPath || resolve(import.meta.dirname, '../dist'), quotaBytes: options.uploadsQuotaBytes });
    archiveSoldOutProducts(db);
    if (!options.disableMaintenance) images.cleanup();
  } catch (error) {
    if (!options.db) db.close();
    throw error;
  }

  const app = express();
  app.disable('x-powered-by');
  app.enable('case sensitive routing'); // /API must not alias the exact webhook exception.
  app.set('trust proxy', false); // Do not trust client-supplied forwarding headers.
  app.locals.db = db;
  app.locals.images = images;
  const maintenance = options.disableMaintenance ? undefined : setInterval(() => {
    try { archiveSoldOutProducts(db); images.cleanup(); }
    catch { console.error('Store maintenance could not complete.'); }
  }, 60_000);
  maintenance?.unref();
  let closed = false;
  app.locals.closeDatabase = () => {
    if (closed) return;
    closed = true;
    if (maintenance) clearInterval(maintenance);
    images.close();
    if (!options.db) db.close();
  };
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", ...(gateway ? ['https://checkout.razorpay.com'] : [])], scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://images.unsplash.com', 'https:'],
      connectSrc: ["'self'", ...(gateway ? ['https://api.razorpay.com', 'https://checkout.razorpay.com'] : [])],
      frameSrc: ["'self'", ...(gateway ? ['https://api.razorpay.com', 'https://checkout.razorpay.com'] : [])],
      fontSrc: ["'self'"], objectSrc: ["'none'"],
      baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      upgradeInsecureRequests: secureCookies ? [] : null,
    } },
    strictTransportSecurity: secureCookies ? undefined : false,
  }));

  const api = express.Router({ caseSensitive: true, strict: true });
  app.use('/api', api);
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (options.rateLimit !== false) {
    api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false,
      message: { error: 'Too many requests. Please try again shortly.' } }));
  }
  // Only this exact POST route bypasses XHR. Raw bytes must precede every JSON parser.
  api.post('/payments/webhook', express.raw({ type: 'application/json', limit: '2mb', inflate: false }), payments.webhook);
  api.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-Requested-With') !== 'UrbanKashi' || req.get('Sec-Fetch-Site')?.toLowerCase() === 'cross-site') {
        throw new HttpError(403, 'Request security check failed.');
      }
      const canonicalUpload = req.method === 'POST' && req.originalUrl.split('?')[0] === '/api/admin/uploads/images';
      if (!canonicalUpload && !req.is('application/json') && (Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding'))) {
        throw new HttpError(415, 'Use application/json for request bodies.');
      }
    }
    next();
  });
  api.use((req, res, next) => { res.locals.user = currentUser(db, req); next(); });
  const requireUser: RequestHandler = (_req, res, next) => {
    if (!res.locals.user) throw new HttpError(401, 'Please sign in.');
    next();
  };
  const requireAdmin: RequestHandler = (_req, res, next) => {
    if (!res.locals.user) throw new HttpError(401, 'Please sign in.');
    if (userOf(res).role !== 'admin') throw new HttpError(403, 'Administrator access required.');
    next();
  };
  // Only the exact canonical POST has a raw parser. Authentication and admission precede all buffering.
  api.post('/admin/uploads/images', requireAdmin,
    ...(options.rateLimit === false ? [] : [rateLimit({ windowMs: 60_000, limit: IMAGE_LIMITS.uploadsPerMinute,
      keyGenerator: (_req, res) => userOf(res).id, standardHeaders: 'draft-8', legacyHeaders: false,
      message: { error: 'Too many image uploads. Please retry in a minute.' } })]),
    (req, _res, next) => {
      if (req.originalUrl.split('?')[0] !== '/api/admin/uploads/images') throw new HttpError(404, 'API endpoint not found.');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(req.get('Content-Type') ?? '')) {
        throw new HttpError(415, 'Use image/jpeg, image/png or image/webp.');
      }
      next();
    }, images.admit, express.raw({ type: () => true, limit: IMAGE_LIMITS.inputBytes, inflate: false }), images.upload);
  api.post(['/admin/catalogue/import', '/admin/catalogue/import/preview'], express.json({ limit: '2mb', strict: true }));
  api.use(express.json({ limit: '32kb', strict: true }));
  // Includes reads and writes so clock-expired rows are hidden even between sweeps / after downtime.
  api.use((_req, _res, next) => { archiveSoldOutProducts(db); next(); });
  if (options.rateLimit !== false) {
    api.use(['/auth/login', '/auth/admin/login', '/auth/register'], rateLimit({
      windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
      message: { error: 'Too many sign-in attempts. Please try again later.' },
    }));
  }

  api.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  api.use('/payments', payments.router(requireUser));
  api.get('/products', (req, res) => {
    let products = listProducts(db);
    if (typeof req.query.category === 'string') products = products.filter((product) => product.category === req.query.category);
    if (typeof req.query.q === 'string') {
      const query = req.query.q.slice(0, 200).toLowerCase();
      products = products.filter((product) => `${product.name} ${product.description} ${product.brand ?? ''} ${product.design ?? ''} ${product.color} ${product.variants.map((variant) => `${variant.barcode ?? ''} ${variant.sku ?? ''}`).join(' ')}`.toLowerCase().includes(query));
    }
    if (req.query.sort === 'price-asc') products.sort((a, b) => a.price - b.price);
    if (req.query.sort === 'price-desc') products.sort((a, b) => b.price - a.price);
    res.json({ products });
  });
  api.get('/products/:slug', (req, res) => {
    const product = getProductBySlug(db, parameter(req.params.slug));
    if (!product) throw new HttpError(404, 'Product not found.');
    res.json({ product });
  });
  api.get('/auth/me', (_req, res) => { res.json({ user: res.locals.user }); });
  api.post('/auth/register', async (req, res) => {
    const input = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user: User = { id: randomUUID(), name: input.name, email: input.email, role: 'customer' };
    transaction(db, () => {
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(user.email)) {
        throw new HttpError(409, 'Unable to register with this email.');
      }
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
        .run(user.id, user.name, user.email, passwordHash, user.role, new Date().toISOString());
      issueSession(db, req, res, user.id, secureCookies);
    });
    res.status(201).json({ user });
  });
  const login = (adminOnly: boolean): RequestHandler => async (req, res) => {
    const input = loginSchema.parse(req.body);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email) as UserRow | undefined;
    const valid = await bcrypt.compare(input.password, row?.password_hash ?? dummyPasswordHash);
    const denied = () => new HttpError(401, adminOnly ? 'Invalid administrator credentials or administrator access is not configured.' : 'Invalid email or password.');
    if (!row || !valid || (adminOnly && row.role !== 'admin')) throw denied();
    const user = transaction(db, () => {
      // A private setup/password change may occur while bcrypt is awaiting.
      const current = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as UserRow | undefined;
      if (!current || current.password_hash !== row.password_hash || (adminOnly && current.role !== 'admin')) throw denied();
      issueSession(db, req, res, current.id, secureCookies);
      return publicUser(current);
    });
    res.json({ user });
  };
  api.post('/auth/login', login(false));
  api.post('/auth/admin/login', login(true));
  api.post('/auth/logout', (req, res) => {
    revokeSession(db, req);
    clearSession(res, secureCookies);
    res.json({ ok: true });
  });

  api.get('/orders', requireUser, (_req, res) => { res.json({ orders: listOrders(db, userOf(res).id) }); });
  api.post('/orders', requireUser, (req, res) => {
    const input = checkoutSchema.parse(req.body);
    const order = reserveOrder(db, userOf(res).id, input, 'COD');
    res.status(201).json({ order });
  });
  api.get('/orders/:id', requireUser, (req, res) => {
    const order = getOrder(db, parameter(req.params.id));
    if (!order || (order.userId !== userOf(res).id && userOf(res).role !== 'admin')) {
      throw new HttpError(404, 'Order not found.');
    }
    res.json({ order });
  });

  api.use('/admin', requireAdmin);
  api.get('/admin/stats', (_req, res) => {
    const count = (table: 'products' | 'orders') => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    const stats: AdminStats = {
      products: count('products'), orders: count('orders'),
      customers: (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'customer'").get() as { count: number }).count,
      revenue: (db.prepare("SELECT COALESCE(SUM(total), 0) AS revenue FROM orders WHERE status != 'cancelled' AND (paymentMethod = 'COD' OR (payment_status = 'paid' AND payment_review IS NULL))").get() as { revenue: number }).revenue,
    };
    res.json({ stats });
  });
  api.get('/admin/products', (_req, res) => { res.json({ products: listProducts(db, true) }); });
  api.post('/admin/catalogue/import/preview', (req, res) => {
    const { csv } = csvBodySchema.parse(req.body);
    res.json(planCatalogueImport(db, csv).preview);
  });
  api.post('/admin/catalogue/import', (req, res) => {
    const { csv } = csvBodySchema.parse(req.body);
    const imported = commitCatalogueImport(db, csv);
    if (!imported.result) { res.status(400).json({ error: 'CSV validation failed. Nothing was imported.', errors: imported.preview.errors }); return; }
    res.json(imported.result);
  });
  api.post('/admin/products', (req, res) => {
    const input = productSchema.parse(req.body);
    if (!validateProductPrices(input)) throw new HttpError(400, 'Original price cannot be below the selling price.');
    const product: Product = { id: randomUUID(), ...input };
    transaction(db, () => {
      if (db.prepare('SELECT id FROM products WHERE slug = ?').get(product.slug)) throw new HttpError(409, 'Product slug already exists.');
      insertProduct(db, product);
    });
    res.status(201).json({ product: getProduct(db, product.id)! });
  });
  api.patch('/admin/products/:id', (req, res) => {
    const input = productPatchSchema.parse(req.body);
    const product = transaction(db, () => {
      const existing = getProduct(db, parameter(req.params.id));
      if (!existing) throw new HttpError(404, 'Product not found.');
      const product = { ...existing, ...input };
      if (input.variants) product.variants = input.variants.map((variant) => {
        const previous = existing.variants.find(({ size }) => size === variant.size);
        return { ...previous, ...variant }; // Omitted optional identifiers survive stock-only edits; explicit '' clears.
      });
      if (!validateProductPrices(product)) throw new HttpError(400, 'Original price cannot be below the selling price.');
      if (db.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').get(product.slug, product.id)) {
        throw new HttpError(409, 'Product slug already exists.');
      }
      updateProduct(db, product, { republish: input.active === true });
      return getProduct(db, product.id)!;
    });
    res.json({ product });
  });
  api.get('/admin/orders', (_req, res) => { res.json({ orders: listOrders(db) }); });
  api.patch('/admin/orders/:id', (req, res) => {
    const { status } = statusSchema.parse(req.body);
    const order = transaction(db, () => {
      const order = getOrder(db, parameter(req.params.id));
      if (!order) throw new HttpError(404, 'Order not found.');
      if (!transitions[order.status].includes(status)) throw new HttpError(409, 'Invalid order status transition.');
      if (order.paymentMethod === 'Razorpay' && ['confirmed', 'shipped'].includes(status)
        && (order.paymentStatus !== 'paid' || order.paymentReview != null)) {
        throw new HttpError(409, 'Online orders need a verified captured payment with no payment review before confirmation or shipment.');
      }
      if (status === 'cancelled') {
        restoreOrderStock(db, order);
        if (order.paymentMethod === 'Razorpay' && order.paymentStatus === 'paid') {
          db.prepare("UPDATE orders SET payment_status = 'refund_required' WHERE id = ?").run(order.id);
        }
      }
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
      return getOrder(db, order.id)!;
    });
    res.json({ order });
  });
  api.use((_req, _res, next) => { next(new HttpError(404, 'API endpoint not found.')); });

  app.use((req, res, next) => {
    if (req.path === '/uploads' || req.path.startsWith('/uploads/')) return images.serve(req, res, next);
    next();
  });

  if (distPath) {
    app.use(express.static(distPath, { index: false, dotfiles: 'deny', redirect: false, maxAge: 0 }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || extname(req.path) || !req.get('Accept')?.includes('text/html') || !req.accepts('html')) return next();
      const index = resolve(distPath, 'index.html');
      if (!existsSync(index)) return next(new HttpError(503, 'Storefront build is not available.'));
      res.set('Cache-Control', 'no-cache');
      res.sendFile(index);
    });
  }
  app.use((_req, _res, next) => { next(new HttpError(404, 'Not found.')); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid request.' }); return;
    }
    const failure = error as { type?: string; code?: string; status?: number } | null;
    if (failure?.type === 'entity.too.large') { res.status(413).json({ error: 'Request body is too large.' }); return; }
    if (failure?.type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid JSON body.' }); return; }
    if (failure?.status && failure.status >= 400 && failure.status < 500) {
      res.status(failure.status).json({ error: 'Invalid request.' }); return;
    }
    // No SQL, credentials, stack traces, or arbitrary exception text in client responses or logs.
    console.error('An unexpected server request error occurred.');
    res.status(500).json({ error: 'An unexpected server error occurred.' });
  };
  app.use(errors);
  return app;
}