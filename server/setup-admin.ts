import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { hiddenPassword } from './create-admin.js';
import { openDatabase, publicUser, transaction, type StoreDatabase, type UserRow } from './db.js';
import { emailSchema, nameSchema, registerSchema } from './validation.js';

/** Private operator capability only. Never expose this function through an HTTP route. */
export async function provisionAdministrator(db: StoreDatabase, details: unknown, confirmation: string) {
  const input = registerSchema.parse(details);
  if (confirmation !== `ADMIN ${input.email}`) throw new Error('Confirmation did not match. No account was changed.');
  const passwordHash = await bcrypt.hash(input.password, 12);
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email) as UserRow | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      // Preserve identity, linked orders and history. Explicit setup replaces the password.
      db.prepare("UPDATE users SET name = ?, password_hash = ?, role = 'admin' WHERE id = ?")
        .run(input.name, passwordHash, id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    } else {
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, input.name, input.email, passwordHash, 'admin', new Date().toISOString());
    }
    const saved = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!saved) throw new Error('Administrator setup could not be verified. Account changes were rolled back.');
    return { user: publicUser(saved), created: !existing };
  });
}

/** Interactive only, fail closed outside this website's private data directory. */
export async function setupAdmin(): Promise<void> {
  process.umask(0o077);
  let db: StoreDatabase | undefined;
  let password: string | undefined;
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Admin setup requires a private interactive terminal on an approved machine.');
    const root = resolve(import.meta.dirname, '..');
    if (realpathSync(process.cwd()) !== realpathSync(root)) throw new Error('Run admin setup from the website root, never another project.');
    const configured = process.env.DATABASE_PATH;
    const filename = configured ? resolve(root, configured) : resolve(root, 'data/store.sqlite');
    if (!existsSync(filename) || !existsSync(resolve(root, 'data'))) {
      throw new Error('An existing website database under its data directory is required. No database was created.');
    }
    const dataRoot = realpathSync(resolve(root, 'data'));
    const websiteRoot = realpathSync(root);
    if (dataRoot !== resolve(websiteRoot, 'data')) throw new Error('The website data directory must not redirect outside this website.');
    const databasePath = realpathSync(filename);
    const child = relative(dataRoot, databasePath);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error('Admin setup only supports an existing database inside this website data directory. No other project may be modified.');
    }
    console.info(`Website database: ${databasePath}`);
    console.info('Owner-only setup: creates an admin, or promotes an existing email and REPLACES its password. Existing sessions are revoked; orders are preserved.');
    console.info('Proceed only with owner authorization and any required IT approval. This does not configure the POS.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let email: string; let name: string; let confirmation: string;
    try {
      email = emailSchema.parse(await prompt.question('Owner admin email: '));
      name = nameSchema.parse(await prompt.question('Owner display name: '));
      confirmation = await prompt.question(`To authorize this account/password change, type ADMIN ${email}: `);
    } finally { prompt.close(); }
    if (confirmation !== `ADMIN ${email}`) throw new Error('Confirmation did not match. No account was changed.');
    password = await hiddenPassword('New admin password (hidden): ');
    const repeated = await hiddenPassword('Confirm new password (hidden): ');
    if (password !== repeated) throw new Error('Passwords do not match. No account was changed.');
    const input = registerSchema.parse({ email, name, password });
    db = openDatabase(databasePath, { seed: false });
    const result = await provisionAdministrator(db, input, confirmation);
    console.info(result.created ? 'Website administrator created.' : 'Website administrator updated; previous sessions revoked.');
    console.info('Sign in at /admin/login using the email and new password you just entered.');
  } catch (error) {
    if (error instanceof z.ZodError) console.error(error.issues[0]?.message ?? 'Invalid administrator details.');
    else if (error instanceof Error && !('code' in error)) console.error(error.message);
    else console.error('Administrator setup failed. Check the website database configuration and permissions.');
    process.exitCode = 1;
  } finally { password = undefined; db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await setupAdmin();