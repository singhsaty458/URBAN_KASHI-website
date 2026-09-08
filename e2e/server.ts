// Dedicated test process: temporary database, never the actual store or POS.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { archiveSoldOutProducts, insertProduct, listProducts, openDatabase, setDatabaseClock, SOLD_OUT_ARCHIVE_MS } from '../server/db.js';
import { createApp } from '../server/app.js';
const directory = mkdtempSync(join(tmpdir(), 'uk-browser-test-'));
const db = openDatabase(join(directory, 'test.sqlite'));
// Startup-only fake lifecycle clock on THIS temporary connection. No HTTP clock controls,
// production database access, or global Date changes; each browser project gets its own row.
const archiveTime = Date.now();
setDatabaseClock(db, () => archiveTime - SOLD_OUT_ARCHIVE_MS);
try {
  const sample = listProducts(db)[0]!;
  for (const project of ['desktop', 'mobile']) insertProduct(db, {
    ...sample, id: `upload-archive-${project}`, slug: `upload-archive-${project}`,
    name: `Upload archive fixture ${project}`, featured: false, active: true,
    brand: '', design: '', badge: 'New', variants: [{ size: 'M', stock: 0 }],
  });
  archiveSoldOutProducts(db, archiveTime);
} finally { setDatabaseClock(db, Date.now); }
db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
  .run('browser-test-admin', 'Browser Admin', 'admin@example.test', bcrypt.hashSync('BrowserTests2026!', 4), 'admin', new Date().toISOString());
const app = createApp({ db, rateLimit: false, secureCookies: false, paymentGateway: null });
const server = app.listen(4180, '127.0.0.1');
let stopping = false;
function close() {
  if (stopping) return;
  stopping = true;
  server.close(() => { db.close(); rmSync(directory, { force: true, recursive: true }); process.exit(0); });
  server.closeAllConnections();
}
process.on('SIGTERM', close);
process.on('SIGINT', close);