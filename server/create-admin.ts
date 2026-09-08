import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { openDatabase, transaction, type StoreDatabase } from './db.js';
import { registerSchema } from './validation.js';
import { z } from 'zod';

/** No password characters are echoed, including on Windows terminals. */
export async function hiddenPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('A terminal or ADMIN_PASSWORD is required.');
  process.stdout.write(label);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolvePassword, reject) => {
    let value = '';
    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
    }
    function onEnd() { cleanup(); reject(new Error('Password entry cancelled.')); }
    function onError() { cleanup(); reject(new Error('Unable to read password.')); }
    function onData(chunk: Buffer | string) {
      for (const character of chunk.toString()) {
        if (character === '\u0003' || character === '\u0004') { onEnd(); return; }
        if (character === '\r' || character === '\n') { cleanup(); resolvePassword(value); return; }
        if (character === '\u007f' || character === '\b') { value = Array.from(value).slice(0, -1).join(''); }
        else if (character >= ' ' && character !== '\u001b') {
          value += character;
          if (Buffer.byteLength(value, 'utf8') > 1024) { cleanup(); reject(new Error('Password is too long.')); return; }
        }
      }
    }
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
  });
}

export async function createAdmin(): Promise<void> {
  process.umask(0o077);
  let db: StoreDatabase | undefined;
  let email = process.env.ADMIN_EMAIL;
  let name = process.env.ADMIN_NAME;
  let password = process.env.ADMIN_PASSWORD;
  // Avoid retaining a credential in this process's environment longer than needed.
  delete process.env.ADMIN_PASSWORD;
  try {
    if (!email || !name) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Set ADMIN_EMAIL, ADMIN_NAME, and ADMIN_PASSWORD for noninteractive use.');
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        email ||= await prompt.question('Admin email: ');
        name ||= await prompt.question('Admin name: ');
      } finally { prompt.close(); }
    }
    if (!password) {
      password = await hiddenPassword('Admin password (hidden): ');
      const confirmation = await hiddenPassword('Confirm password (hidden): ');
      if (password !== confirmation) throw new Error('Passwords do not match.');
    }
    const input = registerSchema.parse({ name, email, password });
    const hash = await bcrypt.hash(input.password, 12);
    password = undefined;
    db = openDatabase();
    const connection = db;
    transaction(connection, () => {
      if (connection.prepare('SELECT id FROM users WHERE email = ?').get(input.email)) {
        throw new Error('Email already exists; no account was changed or promoted.');
      }
      connection.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), input.name, input.email, hash, 'admin', new Date().toISOString());
    });
    console.info('Administrator created. Sign in using the regular storefront login.');
  } catch (error) {
    if (error instanceof z.ZodError) console.error(error.issues[0]?.message ?? 'Invalid admin details.');
    else if (error instanceof Error && !('code' in error)) console.error(error.message);
    else console.error('Administrator creation failed. Check database configuration and permissions.');
    process.exitCode = 1;
  } finally { password = undefined; db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await createAdmin();
}