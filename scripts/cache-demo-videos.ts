import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Public HD-ready renditions: individual item pages confirm the Mixkit Free License.
// See docs/HERO_VIDEOS.md. No API keys, scraping, browser cookies or TLS bypass.
const root = resolve(import.meta.dirname, '..');
const videos = resolve(root, 'public/videos');
const images = resolve(root, 'public/images');
mkdirSync(videos, { recursive: true });
mkdirSync(images, { recursive: true });
mkdirSync(resolve(root, 'data'), { recursive: true });
const temporary = mkdtempSync(resolve(root, 'data/hero-download-'));

function ffmpeg(args: string[]) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('FFmpeg failed. Install/select an approved FFmpeg binary; do not bypass security controls.');
}

try {
  for (const id of [41491, 41479, 41480]) {
    const output = join(videos, `winter-editorial-${id}.mp4`);
    const poster = join(images, `winter-editorial-${id}.jpg`);
    if (!existsSync(output)) {
      const response = await fetch(`https://assets.mixkit.co/videos/${id}/${id}-720.mp4`, { signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.headers.get('content-type')?.includes('video/mp4')) throw new Error(`Clip ${id} is not available as a public MP4 (${response.status}).`);
      const limit = 20 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit || !response.body) throw new Error('Unexpected source size.');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > limit) throw new Error('Source video exceeds download limit.');
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const original = join(temporary, `${id}.mp4`);
      writeFileSync(original, Buffer.concat(chunks));
      // Six-second, silent H.264 edits; faststart and no metadata. No stretched aspect ratios.
      ffmpeg(['-i', original, '-t', '6', '-an', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', output]);
    }
    if (!existsSync(poster)) ffmpeg(['-i', output, '-frames:v', '1', '-q:v', '3', '-update', '1', poster]);
    console.info(`Winter editorial ${id}: ${statSync(output).size} video bytes; poster available.`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }