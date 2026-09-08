import { useEffect, useId, useRef, useState } from 'react';
import type { ImageUpload } from '../../shared/types';
import { message } from '../lib/api';
import { ErrorState, Image } from './UI';
import '../product-images.css';

const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
const maxBytes = 10 * 1024 * 1024;

// Deliberately separate from the JSON API helper: this endpoint accepts raw bytes, not multipart.
async function uploadImage(file: File, signal: AbortSignal): Promise<ImageUpload> {
  const response = await fetch('/api/admin/uploads/images', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': file.type, 'X-Requested-With': 'UrbanKashi' }, body: file,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : `Image upload failed (${response.status}). Please retry.`);
  if (response.status !== 201 || !result || typeof result.path !== 'string'
    || !/^\/uploads\/products\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/.test(result.path)
    || ![result.bytes, result.width, result.height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('The server returned an invalid image upload response. No photo was replaced.');
  }
  return result as ImageUpload;
}

export function ProductImageUpload({ image, images, disabled, onMain, onGallery, onBusyChange }: {
  image: string; images: string[]; disabled: boolean;
  onMain: (path: string) => void; onGallery: (path: string) => void; onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  async function upload(files: File[], main: boolean) {
    if (disabled || controller.current || !files.length) return;
    setError(''); setStatus('');
    const gallery = [...new Set(images)];
    if (!main && gallery.length + files.length > 12) {
      setError(`Gallery holds at most 12 photos. ${Math.max(0, 12 - gallery.length)} spaces remain; remove paths before adding more.`); return;
    }
    // Validate the entire selection before sending anything. The server verifies decoding and the 40 MP limit.
    for (const file of files) {
      if (!allowedTypes.includes(file.type)) { setError(`${file.name}: choose a JPEG, PNG or WebP photo.`); return; }
      if (!file.size || file.size > maxBytes) { setError(`${file.name}: choose a nonempty photo no larger than 10 MiB.`); return; }
    }
    const request = new AbortController();
    controller.current = request; onBusyChange(true);
    let completed = 0;
    try {
      for (const file of files) {
        setStatus(`Uploading photo ${completed + 1} of ${files.length}: ${file.name}. ${completed} completed.`);
        const result = await uploadImage(file, request.signal);
        if (!mounted.current) return;
        if (main) onMain(result.path); else onGallery(result.path);
        completed++;
        setStatus(`${completed} of ${files.length} photos uploaded. Last photo: ${result.width} × ${result.height}, ${(result.bytes / 1024).toFixed(1)} KiB stored. Save the product to keep these paths.`);
      }
    } catch (error) {
      if (mounted.current) {
        setStatus('');
        setError(`${message(error)} ${completed} of ${files.length} photos uploaded. Previous photos and any completed uploads are retained; remaining files were not uploaded.`);
      }
    } finally {
      controller.current = null;
      if (mounted.current) onBusyChange(false);
    }
  }

  return <section className="product-image-upload span-two" aria-label="Product photo uploads">
    <h4>Upload product photos</h4>
    <p id={`${id}-help`} className="small muted">JPEG, PNG or WebP · up to 10 MiB per file and 40 million pixels · non-animated only. Photos upload one at a time and preview immediately after server confirmation.</p>
    <div className="product-image-upload__controls">
      <label>Upload main photo<input type="file" accept={allowedTypes.join(',')} disabled={disabled} aria-describedby={`${id}-help`} onChange={event => { const files = Array.from(event.currentTarget.files ?? []).slice(0, 1); event.currentTarget.value = ''; void upload(files, true); }} /></label>
      <label>Upload gallery photos<input type="file" multiple accept={allowedTypes.join(',')} disabled={disabled} aria-describedby={`${id}-help`} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void upload(files, false); }} /></label>
    </div>
    <p className="small">Gallery: {new Set(images).size}/12 photos. The path fields below are filled automatically and can still be edited manually.</p>
    {image && <figure className="product-image-upload__main"><Image src={image} alt="Main photo preview" /><figcaption>Main photo preview</figcaption></figure>}
    {!!images.length && <div className="product-image-upload__gallery" aria-label="Gallery photo previews">{[...new Set(images)].map((path, index) => <Image key={path} src={path} alt={`Gallery photo preview ${index + 1}`} />)}</div>}
    <p className="small muted">Compressed WebP files are stored on the server (maximum 1600 px, quality 82); the database stores paths only, not base64. Files still use real disk storage and count toward its quota. Unused uploads become eligible for cleanup after 24 hours, with a further reference check before deletion. Save to attach uploads to this product; cancelling does not save the product.</p>
    <div role="status" aria-live="polite" aria-atomic="true">{status}</div>
    {error && <ErrorState error={error} />}
  </section>;
}