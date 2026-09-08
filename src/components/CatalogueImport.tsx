import { useRef, useState } from 'react';
import type { ImportPreview } from '../../shared/types';
import { api, message } from '../lib/api';
import { ErrorState } from './UI';

const MAX_BYTES = 2 * 1024 * 1024;

export function CatalogueImport({ onImported }: { onImported: () => void | Promise<void> }) {
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<{ csv: string; result: ImportPreview } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const revision = useRef(0);
  const locked = useRef(false);
  const valid = Boolean(csv.trim()) && new TextEncoder().encode(csv).length <= MAX_BYTES;

  function invalidate() { revision.current++; setPreview(null); setConfirmed(false); setError(''); setResult(''); }
  async function read(file?: File) {
    if (locked.current) return;
    invalidate(); setCsv(''); setFilename(file?.name ?? '');
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { setError('Choose a .csv file only / केवल CSV फ़ाइल चुनें.'); return; }
    if (file.size > MAX_BYTES) { setError('CSV limit is 2 MiB. Split larger exports before uploading.'); return; }
    const version = revision.current;
    locked.current = true; setBusy('Reading CSV…');
    try {
      const text = await file.text();
      if (version !== revision.current) return;
      if (text.includes('\uFFFD')) throw new Error('Unreadable encoding. Export again as CSV UTF-8.');
      if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('CSV limit is 2 MiB.');
      setCsv(text);
    } catch (error) { setError(message(error)); }
    finally { locked.current = false; setBusy(''); }
  }
  async function validate() {
    if (locked.current || !valid) return;
    locked.current = true; setBusy('Checking rows…'); setError(''); setResult(''); setPreview(null); setConfirmed(false);
    const current = csv, version = revision.current;
    try {
      const data = await api<ImportPreview>('/admin/catalogue/import/preview', { method: 'POST', body: JSON.stringify({ csv: current }), signal: AbortSignal.timeout(30000) });
      if (revision.current === version) setPreview({ csv: current, result: data });
    } catch (error) { setError(message(error)); }
    finally { locked.current = false; setBusy(''); }
  }
  async function commit() {
    if (locked.current || !valid || !confirmed || !preview?.result.valid || preview.csv !== csv) return;
    locked.current = true; setBusy('Importing catalogue…'); setError(''); setPreview(null); setConfirmed(false);
    try {
      const data = await api<{ created: number; updated: number; variants: number }>('/admin/catalogue/import', { method: 'POST', body: JSON.stringify({ csv }), signal: AbortSignal.timeout(60000) });
      setResult(`Imported / आयात पूरा: ${data.created} created, ${data.updated} updated, ${data.variants} variants saved.`);
      await onImported();
    } catch (error) { setError(`${message(error)} If the connection was interrupted, refresh and check inventory before importing again. A new preview is required.`); }
    finally { locked.current = false; setBusy(''); }
  }
  return <section className="catalogue-import paper-panel" aria-labelledby="catalogue-import-title" aria-busy={Boolean(busy)}>
    <h3 id="catalogue-import-title">CSV catalogue import / कैटलॉग आयात</h3>
    <p className="small">Excel / POS export → Save as <strong>CSV UTF-8</strong>. Set the barcode column to <strong>Text / टेक्स्ट</strong> before entering or exporting codes to preserve leading zeros. Lost zeros cannot be restored by import.</p>
    <details><summary>Import guide / कैसे भरें</summary><ul className="small">
      <li>One row per design + colour + size. Use the same slug to group sizes into one product. Different colours need their own slugs.</li>
      <li>Use brand + design consistently to link colour siblings. Blank designs are not linked.</li>
      <li>Keep each barcode unique and preserve the exact POS code; barcode and SKU are text, not numbers.</li>
      <li>Allocate website stock separately / वेब स्टॉक अलग रखें. There is no automatic POS synchronisation.</li>
      <li>Preview checks server rules; import is applied only after your explicit confirmation.</li>
    </ul></details>
    <a className="text-link" href="/catalogue-template.csv" download>Download CSV template / नमूना डाउनलोड</a>
    <label className="catalogue-file">CSV file (maximum 2 MiB)<input type="file" accept=".csv" disabled={Boolean(busy)} onChange={e => { void read(e.target.files?.[0]); e.target.value = ''; }} /></label>
    {filename && <p className="small">Selected: {filename}</p>}
    {csv && <details><summary>Review / edit CSV text</summary><label className="catalogue-file" htmlFor="catalogue-csv-text">Current CSV</label><textarea id="catalogue-csv-text" rows={7} spellCheck={false} disabled={Boolean(busy)} value={csv} onChange={e => { invalidate(); setCsv(e.target.value); }} /></details>}
    {csv && !valid && <p role="alert" className="field-error">CSV must be nonempty and at most 2 MiB.</p>}
    <button type="button" className="button outline-button" disabled={Boolean(busy) || !valid} onClick={validate}>Preview / जाँचें</button>
    {preview && <div className="import-preview" aria-live="polite"><p><strong>{preview.result.valid ? 'Ready for review' : 'Please fix the CSV'}</strong> · {preview.result.rows} rows · {preview.result.products} products · {preview.result.variants} variants</p>
      {preview.result.errors.length > 0 && <><h4>Errors / त्रुटियाँ</h4><ul>{preview.result.errors.map((item, i) => <li key={i}>Row {item.row}: {item.message}</li>)}</ul></>}
      {preview.result.warnings.length > 0 && <><h4>Warnings / ध्यान दें</h4><ul>{preview.result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></>}
      {preview.result.valid && <label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={e => setConfirmed(e.target.checked)} />I reviewed these exact rows and approve inventory changes / आयात की पुष्टि</label>}
    </div>}
    <button type="button" className="button" disabled={Boolean(busy) || !valid || !confirmed || !preview?.result.valid || preview.csv !== csv} onClick={commit}>Confirm import / आयात करें</button>
    {(busy || result) && <p role="status">{busy || result}</p>}{error && <ErrorState error={error} />}
  </section>;
}