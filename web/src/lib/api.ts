import { PUBLIC_PATHS } from './endpoints';

/** Server error shape: { error: { code, message, details? } } */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'sonu';

type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler = () => {
  const path = window.location.pathname;
  if (PUBLIC_PATHS.some((p) => path.startsWith(p))) return;
  const next = encodeURIComponent(path + window.location.search);
  window.location.assign(`/login?next=${next}`);
};

/** Replace the 401 behaviour (tests, or to use the router instead of a full reload). */
export function setUnauthorizedHandler(fn: UnauthorizedHandler) {
  onUnauthorized = fn;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body (ignored when `form` is given). */
  body?: unknown;
  /** Multipart body. Do not set Content-Type: the browser adds the boundary. */
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Set false for calls where 401 is an expected answer (e.g. GET /auth/me, login). */
  redirectOn401?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']) {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = res.statusText || `Request failed (${res.status})`;
  let details: unknown;
  try {
    const data = (await res.json()) as Partial<ApiErrorBody>;
    if (data?.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
      details = data.error.details;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, message, details);
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { [CSRF_HEADER]: CSRF_VALUE, Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method, headers, body, credentials: 'include', signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection and try again.');
  }

  if (!res.ok) {
    const err = await parseError(res);
    if (res.status === 401 && opts.redirectOn401 !== false) onUnauthorized();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

export const apiGet = <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body' | 'form'>) => api<T>(path, { ...opts, method: 'GET' });
export const apiPost = <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body' | 'form'>) => api<T>(path, { ...opts, method: 'POST', body });
export const apiPut = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const apiPatch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });
/** Multipart upload helper: fields are appended as strings, files as File/Blob. */
export function apiUpload<T>(path: string, fields: Record<string, string | Blob | File>, method: 'POST' | 'PUT' = 'POST') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return api<T>(path, { method, form });
}
