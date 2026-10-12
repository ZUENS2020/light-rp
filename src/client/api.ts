export const API = '/api/v3';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API}${path}`, { ...init, headers });
  let body: any;
  if (response.headers.get('Content-Type')?.includes('json')) body = await response.json();
  else body = await response.text();
  if (!response.ok) {
    const message =
      body?.error?.message || body?.error || body?.message || `请求失败（${response.status}）`;
    throw new ApiError(
      typeof message === 'string' ? message : JSON.stringify(message),
      response.status,
      body,
    );
  }
  return body as T;
}
export function post<T = any>(path: string, body?: unknown) {
  return api<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
export async function download(path: string, filename: string) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) {
    let detail: any;
    try {
      detail = await response.json();
    } catch {}
    throw new Error(detail?.error?.message || detail?.error || `导出失败（${response.status}）`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition');
  const match = disposition?.match(/filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i);
  const actual = match ? decodeURIComponent(match[1] || match[2]) : filename;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = actual;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function asList<T = any>(value: any, key?: string): T[] {
  if (Array.isArray(value)) return value;
  if (key && Array.isArray(value?.[key])) return value[key];
  return value?.items || [];
}
export function readable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}
export function errorText(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
