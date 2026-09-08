import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import type { Request, Response } from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { archiveSoldOutProducts, getProduct, listProducts, openDatabase, SOLD_OUT_ARCHIVE_MS, updateProduct, type StoreDatabase } from '../server/db.js';
import { IMAGE_LIMITS, ImageStore } from '../server/images.js';
import { reserveOrder } from '../server/orders.js';
import { sessionCookie, testAddress, xhr } from './fixtures.js';
import type { ImageUpload } from '../shared/types.js';

const route = '/api/admin/uploads/images';
const image = (format: 'jpeg' | 'png' | 'webp' = 'png', width = 80, height = 40) => sharp({ create: {
  width, height, channels: 3, background: { r: 50, g: 100, b: 150 },
} }).toFormat(format).toBuffer();
const checksum = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

describe('private admin image upload pipeline', () => {
  let directory: string;
  let uploadsPath: string;
  let db: StoreDatabase;
  let app: ReturnType<typeof createApp>;
  let store: ImageStore;
  let admin: ReturnType<typeof request.agent>;
  let customer: ReturnType<typeof request.agent>;
  let now: number;
  const upload = async (data: Buffer, mime = 'image/png') => (await admin.post(route).set(xhr)
    .set('Content-Type', mime).set('X-File-Name', '../../original-private-photo.png').send(data).expect(201)).body as ImageUpload;
  const registryCount = () => (db.prepare('SELECT COUNT(*) AS count FROM image_uploads').get() as { count: number }).count;

  // Exercise the real HTTP parser/app over local IPC. On this Windows host even a bare
  // node:http GET /uploads over TCP terminates natively (0xE0000027), before Express.
  // Named pipes (Unix sockets elsewhere) retain exact-path assertions without that transport.
  const localHttp = async (options: RequestOptions) => {
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\urban-kashi-image-test-${randomUUID()}` : join(directory, 'http.sock');
    const server = createServer(app);
    // Let the application reject the headers, rather than Node automatically inviting a body.
    server.on('checkContinue', (req, res) => app(req, res));
    let client: ReturnType<typeof httpRequest> | undefined;
    try {
      server.listen(socketPath);
      await once(server, 'listening');
      return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        client = httpRequest({ ...options, socketPath, agent: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.once('error', reject);
          res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        client.once('error', reject);
        client.once('continue', () => reject(new Error('Rejected upload must not request a body.')));
        client.setTimeout(5000, () => client!.destroy(new Error('Expected rejection before sending any body.')));
        if (client.hasHeader('Expect')) client.flushHeaders(); // Deliberately never send/end the declared body.
        else client.end();
      });
    } finally {
      client?.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'urban-kashi-image-test-'));
    uploadsPath = join(directory, 'managed-images');
    now = Date.parse('2026-09-01T12:00:00.000Z');
    db = openDatabase(':memory:');
    app = createApp({ db, uploadsPath, distPath: false, rateLimit: false, disableMaintenance: true, paymentGateway: null, clock: () => now });
    store = app.locals.images as ImageStore;
    for (const role of ['admin', 'customer']) db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)')
      .run(role, 'Test User', `${role}@example.test`, 'unused-test-hash', role, new Date(now).toISOString());
    admin = request.agent(app).set('Cookie', sessionCookie(db, 'admin'));
    customer = request.agent(app).set('Cookie', sessionCookie(db, 'customer'));
  });
  afterEach(() => { app.locals.closeDatabase(); db.close(); rmSync(directory, { recursive: true, force: true }); });

  it('requires admin, XHR and same-site writes before any raw parser runs', async () => {
    const body = await image();
    await request(app).post(route).set(xhr).set('Content-Type', 'image/png').send(body).expect(401);
    await customer.post(route).set(xhr).set('Content-Type', 'image/png').send(body).expect(403);
    await admin.post(route).set('Content-Type', 'image/png').send(body).expect(403);
    await admin.post(route).set(xhr).set('Sec-Fetch-Site', 'cross-site').set('Content-Type', 'image/png').send(body).expect(403);
    // A large in-flight TCP write can reset when the server correctly sends an early 401.
    // Require actual security responses to oversized headers with NO body: parsing/draining
    // first would time out, not pass as an accepted ECONNRESET or a parser-generated 413.
    for (const [headers, status, error] of [
      [xhr, 401, 'Please sign in.'],
      [{ ...xhr, Cookie: sessionCookie(db, 'customer') }, 403, 'Administrator access required.'],
      [{ Cookie: sessionCookie(db, 'admin') }, 403, 'Request security check failed.'],
      [{ ...xhr, Cookie: sessionCookie(db, 'admin'), 'Sec-Fetch-Site': 'cross-site' }, 403, 'Request security check failed.'],
    ] as const) {
      const rejected = await localHttp({ method: 'POST', path: route, headers: { ...headers,
        'Content-Type': 'image/png', 'Content-Length': IMAGE_LIMITS.inputBytes + 1, Expect: '100-continue' } });
      assert.equal(rejected.status, status);
      assert.deepEqual(JSON.parse(rejected.body.toString()), { error });
    }
    await customer.post(route).set(xhr).set('Content-Type', 'application/json').send('{invalid').expect(403);
    assert.equal(registryCount(), 0);
    assert.equal(existsSync(uploadsPath), false);
  });

  it('grants no raw-body bypass to alternate paths or methods, and leaves JSON API limits unchanged', async () => {
    const data = await image();
    for (const path of [route + '/', '/api/admin/uploads/Images', '/api/admin/uploads/%69mages', '/api//admin/uploads/images',
      '/API/admin/uploads/images', '/api/admin/uploads/images/other', '/api/admin/products']) {
      const result = await admin.post(path).set(xhr).set('Content-Type', 'image/png').send(data);
      assert.ok(result.status >= 400, `${path}: ${result.status}`);
    }
    await admin.put(route).set(xhr).set('Content-Type', 'image/png').send(data).expect(415);
    await admin.patch(route).set(xhr).set('Content-Type', 'image/png').send(data).expect(415);
    await admin.get(route).expect(404);
    await admin.post('/api/admin/products').set(xhr).send({ description: 'x'.repeat(33 * 1024) }).expect(413);
    await admin.post(route).set(xhr).set('Content-Type', 'image/png; charset=utf-8').send(data).expect(415);
    await admin.post(route).set(xhr).set('Content-Type', 'application/octet-stream').send(data).expect(415);
    await admin.post(route).set(xhr).set('Content-Type', 'image/png').set('Content-Encoding', 'gzip').send(data).expect(415);
    assert.equal(registryCount(), 0);
  });

  it('converts JPEG, PNG and WebP to a direct UUID response with no original name or metadata', async () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const result = await upload(await image(format), `image/${format}`);
      assert.deepEqual(Object.keys(result).sort(), ['bytes', 'height', 'path', 'width']);
      assert.match(result.path, /^\/uploads\/products\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/);
      assert.equal(result.width, 80); assert.equal(result.height, 40);
      const raw = readFileSync(join(uploadsPath, basename(result.path)));
      assert.equal(raw.length, result.bytes);
      const metadata = await sharp(raw).metadata();
      assert.equal(metadata.format, 'webp'); assert.equal(metadata.space, 'srgb');
      assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.equal(metadata.xmp, undefined);
    }
    assert.equal(registryCount(), 3);
    assert.equal(readdirSync(uploadsPath).length, 3);
    assert.ok(readdirSync(uploadsPath).every((filename) => filename.endsWith('.webp') && !filename.includes('original')));
  });

  it('rotates EXIF before fitting inside 1600 square, strips metadata, and never enlarges', async () => {
    const original = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: 'red' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    assert.equal((await sharp(original).metadata()).orientation, 6);
    const result = await upload(original, 'image/jpeg');
    assert.equal(result.width, 800); assert.equal(result.height, 1600);
    const optimized = await sharp(readFileSync(join(uploadsPath, basename(result.path)))).metadata();
    assert.equal(optimized.orientation, undefined); assert.equal(optimized.exif, undefined); assert.equal(optimized.icc, undefined);
    const small = await upload(await image('png', 10, 5));
    assert.equal(small.width, 10); assert.equal(small.height, 5);
  });

  it('rejects magic/MIME mismatch, SVG/GIF/HTML, appended polyglots, corrupt and truncated images', async () => {
    const png = await image(); const jpeg = await image('jpeg'); const webp = await image('webp');
    for (const mime of ['image/svg+xml', 'image/gif', 'text/html']) {
      await admin.post(route).set(xhr).set('Content-Type', mime).send(png).expect(415);
    }
    const invalid: Array<[Buffer, string]> = [
      [jpeg, 'image/png'], [png, 'image/jpeg'], [webp, 'image/png'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'],
      [Buffer.from('GIF89a'), 'image/png'], [Buffer.from('<!doctype html><html>bad</html>'), 'image/jpeg'],
      [Buffer.concat([jpeg, Buffer.from('<script>alert(1)</script>')]), 'image/jpeg'],
      [Buffer.concat([png, Buffer.from('PK\u0003\u0004zip-data')]), 'image/png'],
      [Buffer.concat([webp, Buffer.from('another-file')]), 'image/webp'],
      [png.subarray(0, png.length - 1), 'image/png'], [jpeg.subarray(0, jpeg.length - 2), 'image/jpeg'],
      [webp.subarray(0, webp.length - 4), 'image/webp'], [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'],
    ];
    const badCRC = Buffer.from(png); badCRC[badCRC.length - 1] = badCRC[badCRC.length - 1]! ^ 1;
    invalid.push([badCRC, 'image/png']);
    for (const [data, mime] of invalid) await admin.post(route).set(xhr).set('Content-Type', mime).send(data).expect(400);
    assert.equal(registryCount(), 0);
    assert.equal(existsSync(uploadsPath), false);
  });

  it('rejects input over 10 MiB and declared dimensions over 40 million pixels without allocating that image', async () => {
    await admin.post(route).set(xhr).set('Content-Type', 'image/png').send(Buffer.alloc(IMAGE_LIMITS.inputBytes + 1)).expect(413);
    const huge = Buffer.from(await image());
    huge.writeUInt32BE(10_000, 16); huge.writeUInt32BE(5000, 20);
    huge.writeUInt32BE(checksum(huge.subarray(12, 29)), 29);
    await admin.post(route).set(xhr).set('Content-Type', 'image/png').send(huge).expect(400);
    assert.equal(registryCount(), 0);
  });

  it('rejects animated PNG and WebP flags/pages rather than flattening a hidden animation', async () => {
    const png = await image();
    const animation = Buffer.alloc(20);
    animation.writeUInt32BE(8); animation.write('acTL', 4, 'ascii'); animation.writeUInt32BE(2, 8);
    animation.writeUInt32BE(checksum(animation.subarray(4, 16)), 16);
    const apng = Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]);
    await admin.post(route).set(xhr).set('Content-Type', 'image/png').send(apng).expect(400);
    const webp = await image('webp');
    const extended = Buffer.alloc(18); extended.write('VP8X', 0, 'ascii'); extended.writeUInt32LE(10, 4); extended[8] = 2;
    const animated = Buffer.concat([webp.subarray(0, 12), extended, webp.subarray(12)]);
    animated.writeUInt32LE(animated.length - 8, 4);
    await admin.post(route).set(xhr).set('Content-Type', 'image/webp').send(animated).expect(400);
    assert.equal(registryCount(), 0);
  });

  it('serves only registered optimized WebP via GET/HEAD with immutable public headers', async () => {
    const uploaded = await upload(await image());
    const fetched = await request(app).get(uploaded.path).expect(200);
    assert.match(fetched.headers['content-type'], /^image\/webp/);
    assert.equal(fetched.headers['x-content-type-options'], 'nosniff');
    assert.equal(fetched.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(Number(fetched.headers['content-length']), uploaded.bytes);
    assert.ok(Buffer.isBuffer(fetched.body));
    assert.equal((await sharp(fetched.body as Buffer).metadata()).format, 'webp');
    const head = await request(app).head(uploaded.path).expect(200);
    assert.equal(Number(head.headers['content-length']), uploaded.bytes);
    assert.equal(head.text, undefined);
    const unregistered = `${randomUUID()}.webp`;
    writeFileSync(join(uploadsPath, unregistered), 'not-public');
    for (const path of ['/uploads', '/uploads/products', '/uploads/products/', `/uploads/products/${randomUUID()}.webp`,
      `/uploads/products/${unregistered}`, '/uploads/products/original.png', '/uploads/products/store.sqlite',
      '/uploads/products/store.sqlite-wal', '/uploads/products/store.sqlite-shm', '/uploads/products/%2e%2e%2fstore.sqlite',
      '/uploads/products/%5c..%5cstore.sqlite', uploaded.path + '/extra']) {
      const missing = await localHttp({ method: 'GET', path, headers: { Accept: 'text/html' } });
      assert.equal(missing.status, 404, path);
      assert.deepEqual(JSON.parse(missing.body.toString()), { error: 'Image not found.' }, path);
    }
    await request(app).post(uploaded.path).send('no writes').expect(404);
    await request(app).delete(uploaded.path).expect(404);
  });

  it('enforces quota including unregistered crash leftovers and never reports a failed write as success', async () => {
    const limited = createApp({ db, uploadsPath, uploadsQuotaBytes: 1, distPath: false, rateLimit: false, disableMaintenance: true, paymentGateway: null });
    try {
      await request(limited).post(route).set(xhr).set('Cookie', sessionCookie(db, 'admin')).set('Content-Type', 'image/png').send(await image()).expect(507);
      assert.equal(registryCount(), 0);
      assert.deepEqual(readdirSync(uploadsPath), []);
    } finally { limited.locals.closeDatabase(); }
    const staleFile = `${randomUUID()}.webp`;
    writeFileSync(join(uploadsPath, staleFile), Buffer.alloc(1024));
    const bounded = createApp({ db, uploadsPath, uploadsQuotaBytes: 1024, distPath: false, rateLimit: false, disableMaintenance: true, paymentGateway: null });
    try {
      await request(bounded).post(route).set(xhr).set('Cookie', sessionCookie(db, 'admin')).set('Content-Type', 'image/png').send(await image()).expect(507);
      assert.equal(registryCount(), 0);
      assert.equal(existsSync(join(uploadsPath, staleFile)), true);
    } finally { bounded.locals.closeDatabase(); }
  });

  it('limits admin uploads to 30/min and rejects busy admission without queuing request buffers', async () => {
    const limited = createApp({ db, uploadsPath, distPath: false, disableMaintenance: true, paymentGateway: null });
    try {
      const cookie = sessionCookie(db, 'admin');
      for (let index = 0; index < IMAGE_LIMITS.uploadsPerMinute; index++) await request(limited).post(route).set(xhr)
        .set('Cookie', cookie).set('Content-Type', 'image/png').send(Buffer.from('bad')).expect(400);
      await request(limited).post(route).set(xhr).set('Cookie', cookie).set('Content-Type', 'image/png').send(await image()).expect(429);
    } finally { limited.locals.closeDatabase(); }
    const responses = Array.from({ length: 3 }, () => Object.assign(new EventEmitter(), { locals: {} }) as unknown as Response);
    for (let index = 0; index < 2; index++) store.admit({} as Request, responses[index]!, (error) => assert.equal(error, undefined));
    store.admit({} as Request, responses[2]!, (error: unknown) => assert.equal((error as { status: number }).status, 503));
    responses[0]!.emit('close');
    store.admit({} as Request, responses[2]!, (error) => assert.equal(error, undefined));
    responses[1]!.emit('finish'); responses[2]!.emit('finish');
  });

  it('cleans only old unreferenced registered uploads after a second observation, preserving archived/gallery/order photos', async () => {
    const data = await image();
    const primary = await upload(data); const gallery = await upload(data); const historical = await upload(data);
    const abandoned = await upload(data); const adopted = await upload(data);
    const product = listProducts(db)[0]!;
    updateProduct(db, { ...product, image: historical.path, images: [historical.path], variants: [{ size: 'M', stock: 1 }] });
    const order = reserveOrder(db, 'customer', { items: [{ productId: product.id, size: 'M', quantity: 1 }], address: testAddress, idempotencyKey: randomUUID() }, 'COD');
    updateProduct(db, { ...getProduct(db, product.id)!, image: primary.path, images: [primary.path, gallery.path] });
    const seedPhoto = join(uploadsPath, 'seed-photo.jpg'); writeFileSync(seedPhoto, 'owner-file');
    now += SOLD_OUT_ARCHIVE_MS;
    archiveSoldOutProducts(db, now);
    assert.ok(getProduct(db, product.id)!.archivedAt);
    assert.equal(store.cleanup(now), 0);
    now += IMAGE_LIMITS.recheckMs - 1;
    assert.equal(store.cleanup(now), 0);
    updateProduct(db, { ...getProduct(db, product.id)!, images: [primary.path, gallery.path, adopted.path] });
    now++;
    assert.equal(store.cleanup(now), 1);
    assert.equal(existsSync(join(uploadsPath, basename(abandoned.path))), false);
    for (const photo of [primary, gallery, historical, adopted]) {
      assert.equal(existsSync(join(uploadsPath, basename(photo.path))), true);
      await request(app).get(photo.path).expect(200);
    }
    assert.equal(existsSync(seedPhoto), true);
    assert.equal(registryCount(), 4);
    assert.equal(order.items[0]!.image, historical.path);
    assert.equal(getProduct(db, product.id)!.active, false);
    await admin.patch(`/api/admin/products/${product.id}`).set(xhr).send({ image: abandoned.path }).expect(409);
  });

  it('requires a full 24 hours before an orphan can even be marked and ignores malicious registry paths', async () => {
    const uploaded = await upload(await image());
    const start = now;
    const privatePath = join(directory, 'private-file'); writeFileSync(privatePath, 'private');
    db.prepare('INSERT INTO image_uploads(filename,bytes,created_at,unreferenced_at) VALUES (?,?,?,?)')
      .run('../private-file', 7, '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
    assert.equal(store.cleanup(start + IMAGE_LIMITS.orphanAgeMs), 0);
    assert.equal((db.prepare('SELECT unreferenced_at FROM image_uploads WHERE filename = ?').get(basename(uploaded.path)) as { unreferenced_at: string | null }).unreferenced_at, null);
    assert.equal(store.cleanup(start + IMAGE_LIMITS.orphanAgeMs + 1), 0);
    assert.equal(store.cleanup(start + IMAGE_LIMITS.orphanAgeMs + IMAGE_LIMITS.recheckMs), 0);
    assert.equal(store.cleanup(start + IMAGE_LIMITS.orphanAgeMs + IMAGE_LIMITS.recheckMs + 1), 1);
    assert.equal(readFileSync(privatePath, 'utf8'), 'private');
  });

  it('rejects DB/public upload-root collisions and isolates implicit memory-database roots', () => {
    const disk = openDatabase(join(directory, 'db', 'store.sqlite'));
    try {
      assert.throws(() => createApp({ db: disk, uploadsPath: directory, distPath: false, paymentGateway: null }), /DATABASE_PATH must be outside/);
      const dist = join(directory, 'compiled'); mkdirSync(dist);
      for (const root of [dist, join(dist, 'images'), directory]) assert.throws(() => createApp({ db, uploadsPath: root, distPath: dist, paymentGateway: null }), /must not overlap/);
      const a = createApp({ db, distPath: false, disableMaintenance: true, paymentGateway: null });
      const otherDb = openDatabase(':memory:');
      const b = createApp({ db: otherDb, distPath: false, disableMaintenance: true, paymentGateway: null });
      try {
        const first = a.locals.images as ImageStore; const second = b.locals.images as ImageStore;
        assert.notEqual(first.path, second.path);
        assert.equal(existsSync(first.path), false); assert.equal(existsSync(second.path), false);
        assert.ok(first.path.includes('urban-kashi-images-'));
      } finally { a.locals.closeDatabase(); b.locals.closeDatabase(); otherDb.close(); }
    } finally { disk.close(); }
  });
});