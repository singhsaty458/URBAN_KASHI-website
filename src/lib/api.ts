import { useCallback, useEffect, useState } from 'react';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-Requested-With': 'UrbanKashi' } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}). Please try again.`);
  if (data === null) throw new Error('The server returned an unreadable response. Please try again.');
  return data as T;
}

export const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export const money = (value: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
export const categories = ['Shirts', 'T-Shirts', 'Trousers', 'Kurtas', 'Layers'] as const;
export const sizes = ['S', 'M', 'L', 'XL'] as const;
export const statuses = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;

export function useResource<T>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string }>({ data: null, loading: Boolean(path), error: '' });
  const [version, setVersion] = useState(0);
  const retry = useCallback(() => setVersion(n => n + 1), []);
  useEffect(() => {
    if (!path) { setState({ data: null, loading: false, error: '' }); return; }
    const controller = new AbortController();
    setState({ data: null, loading: true, error: '' });
    api<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ data, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ data: null, loading: false, error: message(error) });
    });
    return () => controller.abort();
  }, [path, version]);
  return { ...state, retry };
}

export function useTitle(title: string) {
  useEffect(() => { document.title = `${title} — URBAN KASHI`; }, [title]);
}