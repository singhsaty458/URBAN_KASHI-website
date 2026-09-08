import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { StoreDatabase, UserRow } from './db.js';
import { publicUser } from './db.js';
import type { User } from '../shared/types.js';

export const SESSION_COOKIE = 'urban_kashi_session';
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function sessionToken(req: Request): string | undefined {
  const matches = (req.headers.cookie || '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const token = matches[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
function cookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };
}

export function currentUser(db: StoreDatabase, req: Request): User | null {
  const token = sessionToken(req);
  if (!token) return null;
  const row = db.prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), Date.now()) as UserRow | undefined;
  return row ? publicUser(row) : null;
}
export function revokeSession(db: StoreDatabase, req: Request): void {
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}
export function issueSession(db: StoreDatabase, req: Request, res: Response, userId: string, secure: boolean): void {
  const token = randomBytes(32).toString('hex');
  revokeSession(db, req);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, Date.now() + SESSION_DURATION);
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(secure), maxAge: SESSION_DURATION });
}
export function clearSession(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(secure));
}