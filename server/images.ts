import { randomUUID } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestHandler } from 'express';
import sharp, { type OutputInfo } from 'sharp';
import type { ImageUpload } from '../shared/types.js';
import { databaseNow, transaction, type StoreDatabase } from './db.js';
import { HttpError } from './errors.js';

export const IMAGE_LIMITS = Object.freeze({ inputBytes: 10 * 1024 * 1024, pixels: 40_000_000,
  dimension: 1600, quality: 82, concurrency: 2, uploadsPerMinute: 30,
  quotaBytes: 200 * 1024 * 1024, orphanAgeMs: 24 * 60 * 60 * 1000, recheckMs: 60_000 });
const filenamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;
const prefix = '/uploads/products/';
const mimeFormats: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
type RegistryRow = { filename: string; bytes: number; created_at: string; unreferenced_at: string | null };
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) crc = crcTable[(crc ^ data[index]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** Resolve existing ancestors too, so a symlink/junction cannot disguise overlapping roots. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalPath(parent), relative(parent, absolute));
}

/** Exact container framing prevents appended files/HTML and truncated envelopes being silently decoded. */
function validateEnvelope(data: Buffer, format: string): void {
  const invalid = () => { throw new HttpError(400, 'Invalid, truncated or unsupported image.'); };
  if (/<(?:!doctype\s+html|html\b|script\b|svg\b)|<\?php/i.test(data.toString('latin1'))) invalid();
  if (format === 'png') {
    if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
    let offset = 8; let ended = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (length > data.length - offset - 12 || (offset === 8 && (type !== 'IHDR' || length !== 13))) invalid();
      if (!/^[A-Za-z]{4}$/.test(type) || crc32(data, offset + 4, offset + 8 + length) !== data.readUInt32BE(offset + 8 + length)) invalid();
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) invalid();
      offset += length + 12;
      if (type === 'IEND') { if (length !== 0 || offset !== data.length) invalid(); ended = true; break; }
    }
    if (!ended) invalid();
  } else if (format === 'webp') {
    if (data.length < 20 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP'
      || data.readUInt32LE(4) + 8 !== data.length) invalid();
    let offset = 12;
    while (offset + 8 <= data.length) {
      const type = data.toString('ascii', offset, offset + 4);
      const length = data.readUInt32LE(offset + 4);
      if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type)
        || length > data.length - offset - 8) invalid();
      if (type === 'VP8X' && (length !== 10 || (data[offset + 8]! & 2))) invalid();
      offset += 8 + length + (length % 2);
    }
    if (offset !== data.length) invalid();
  } else if (format === 'jpeg') {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) invalid();
    let offset = 2; let ended = false;
    while (offset < data.length) {
      if (data[offset++] !== 0xff) invalid();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9) { ended = offset === data.length; break; }
      if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
      if (offset + 2 > data.length) invalid();
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) invalid();
      offset += length;
      if (marker === 0xda) {
        while (offset < data.length) {
          if (data[offset] !== 0xff) { offset++; continue; }
          const next = data[offset + 1];
          if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
          if (next === 0xff) { offset++; continue; }
          break;
        }
      }
    }
    if (!ended) invalid();
  } else invalid();
}

export class ImageStore {
  readonly path: string;
  readonly quotaBytes: number;
  private readonly temporary: boolean;
  private processing = 0;
  private closed = false;

  constructor(private readonly db: StoreDatabase, options: { uploadsPath?: string; distPath: string | false; quotaBytes?: number }) {
    const files = (db.prepare('PRAGMA database_list').all() as { file: string }[]).map(({ file }) => file).filter(Boolean);
    this.temporary = !options.uploadsPath && files.length === 0;
    this.path = canonicalPath(options.uploadsPath ?? (files[0] ? join(dirname(files[0]), 'product-images') : join(tmpdir(), `urban-kashi-images-${randomUUID()}`)));
    this.quotaBytes = options.quotaBytes ?? IMAGE_LIMITS.quotaBytes;
    if (!Number.isSafeInteger(this.quotaBytes) || this.quotaBytes < 1) throw new Error('Image quota must be a positive integer.');
    if (files.some((file) => inside(this.path, canonicalPath(file)))) throw new Error('DATABASE_PATH must be outside the upload directory.');
    if (options.distPath) {
      const dist = canonicalPath(options.distPath);
      if (inside(dist, this.path) || inside(this.path, dist)) throw new Error('Upload and compiled public directories must not overlap.');
    }
    if (existsSync(this.path) && !lstatSync(this.path).isDirectory()) throw new Error('Upload path must be a directory.');
  }

  /** Acquired before buffering input. Busy requests are rejected, never queued in memory. */
  readonly admit: RequestHandler = (_req, res, next) => {
    if (this.closed || this.processing >= IMAGE_LIMITS.concurrency) return next(new HttpError(503, 'Image processing is busy. Please retry shortly.'));
    this.processing++;
    let released = false;
    const release = () => { if (!released) { released = true; this.processing--; } };
    res.locals.imageProcessing = false;
    res.locals.releaseImage = release;
    const finished = () => { if (!res.locals.imageProcessing) release(); };
    res.once('finish', finished); res.once('close', finished);
    next();
  };

  readonly upload: RequestHandler = async (req, res, next) => {
    res.locals.imageProcessing = true;
    let data: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;
    req.body = undefined; // Never retain the original on the request or in a temporary file.
    try {
      if (!data?.length) throw new HttpError(400, 'An image file is required.');
      if (data.length > IMAGE_LIMITS.inputBytes) throw new HttpError(413, 'Image exceeds 10 MiB.');
      const format = mimeFormats[req.get('Content-Type') ?? ''];
      if (!format) throw new HttpError(415, 'Use image/jpeg, image/png or image/webp.');
      validateEnvelope(data, format);
      let output: { data: Buffer; info: OutputInfo };
      try {
        const decoder = sharp(data, { failOn: 'warning', limitInputPixels: IMAGE_LIMITS.pixels, animated: false });
        const metadata = await decoder.metadata();
        if (metadata.format !== format || !metadata.width || !metadata.height
          || metadata.width * metadata.height > IMAGE_LIMITS.pixels || (metadata.pages ?? 1) !== 1) {
          throw new Error('Unsupported image');
        }
        output = await decoder.rotate().resize(IMAGE_LIMITS.dimension, IMAGE_LIMITS.dimension, { fit: 'inside', withoutEnlargement: true })
          .toColourspace('srgb').webp({ quality: IMAGE_LIMITS.quality }).toBuffer({ resolveWithObject: true });
      } catch { throw new HttpError(400, 'Image could not be safely decoded. Use a non-animated JPEG, PNG or WebP under 40 million pixels.'); }
      data = undefined;
      if (this.closed || req.aborted || res.destroyed) return;
      if (output.data.length > IMAGE_LIMITS.inputBytes) throw new HttpError(413, 'Optimized image is too large.');
      const filename = `${randomUUID()}.webp`;
      const path = join(this.path, filename);
      let written = false;
      try {
        transaction(this.db, () => {
          this.ensureRoot();
          // Count actual managed files, including crash leftovers, rather than promising imaginary free disk.
          const bytes = readdirSync(this.path).filter((name) => filenamePattern.test(name)).reduce((sum, name) => sum + lstatSync(join(this.path, name)).size, 0);
          if (bytes + output.data.length > this.quotaBytes) throw new HttpError(507, 'Managed image storage quota is full.');
          writeFileSync(path, output.data, { flag: 'wx', mode: 0o600 }); written = true;
          this.db.prepare('INSERT INTO image_uploads(filename,bytes,created_at) VALUES (?,?,?)')
            .run(filename, output.data.length, new Date(databaseNow(this.db)).toISOString());
        });
      } catch (error) {
        if (written) { try { unlinkSync(path); } catch { /* Counted against quota; never reported as successful. */ } }
        if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new HttpError(507, 'Image storage is full.');
        throw error;
      }
      const result: ImageUpload = { path: `${prefix}${filename}`, bytes: output.data.length, width: output.info.width, height: output.info.height };
      res.status(201).json(result);
    } catch (error) { next(error); }
    finally { data = undefined; res.locals.imageProcessing = false; (res.locals.releaseImage as () => void)(); }
  };

  /** No express.static: only registered, UUID WebP regular files are readable. */
  readonly serve: RequestHandler = (req, res, next) => {
    const filename = req.path.startsWith(prefix) ? req.path.slice(prefix.length) : '';
    if (!['GET', 'HEAD'].includes(req.method) || !filenamePattern.test(filename)) return next(new HttpError(404, 'Image not found.'));
    let fd: number | undefined;
    try {
      if (!this.db.prepare('SELECT 1 FROM image_uploads WHERE filename = ?').get(filename)) throw new Error();
      this.checkRoot();
      const path = join(this.path, filename);
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error();
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > IMAGE_LIMITS.inputBytes) throw new Error();
      const body = req.method === 'HEAD' ? undefined : readFileSync(fd);
      res.set({ 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': String(stat.size) });
      if (body) res.send(body); else res.end();
    } catch { next(new HttpError(404, 'Image not found.')); }
    finally { if (fd !== undefined) closeSync(fd); }
  };

  private checkRoot(): void {
    if (!lstatSync(this.path).isDirectory() || realpathSync(this.path) !== this.path) throw new Error('Upload directory changed.');
  }
  private ensureRoot(): void { mkdirSync(this.path, { recursive: true, mode: 0o700 }); this.checkRoot(); }

  /** Two observations >=60s apart, both after 24h; recheck all references under the same SQLite write lock as deletion. */
  cleanup(now = databaseNow(this.db)): number {
    if (this.closed) return 0;
    return transaction(this.db, () => {
      const rows = this.db.prepare('SELECT * FROM image_uploads WHERE created_at < ?').all(new Date(now - IMAGE_LIMITS.orphanAgeMs).toISOString()) as RegistryRow[];
      if (!rows.length) return 0;
      const references = new Set<string>();
      for (const row of this.db.prepare('SELECT image,images FROM products').all() as { image: string; images: string }[]) {
        references.add(row.image);
        for (const image of JSON.parse(row.images) as string[]) references.add(image);
      }
      for (const row of this.db.prepare('SELECT items FROM orders').all() as { items: string }[]) {
        for (const item of JSON.parse(row.items) as { image?: string }[]) if (item.image) references.add(item.image);
      }
      let deleted = 0;
      for (const row of rows) {
        if (!filenamePattern.test(row.filename)) continue; // Never follow arbitrary registry paths.
        if (references.has(`${prefix}${row.filename}`)) {
          if (row.unreferenced_at) this.db.prepare('UPDATE image_uploads SET unreferenced_at = NULL WHERE filename = ?').run(row.filename);
          continue;
        }
        if (!row.unreferenced_at) {
          this.db.prepare('UPDATE image_uploads SET unreferenced_at = ? WHERE filename = ?').run(new Date(now).toISOString(), row.filename);
          continue;
        }
        if (now - Date.parse(row.unreferenced_at) < IMAGE_LIMITS.recheckMs) continue;
        try {
          this.checkRoot();
          const path = join(this.path, row.filename);
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
          // No awaits/network between reference check and unlink: catalogue writes use BEGIN IMMEDIATE too.
          unlinkSync(path);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
        this.db.prepare('DELETE FROM image_uploads WHERE filename = ?').run(row.filename);
        deleted++;
      }
      return deleted;
    });
  }

  close(): void {
    this.closed = true;
    if (this.temporary) rmSync(this.path, { recursive: true, force: true });
  }
}