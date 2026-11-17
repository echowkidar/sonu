import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, apiPost, apiUpload, setUnauthorizedHandler } from '@/lib/api';

function mockFetch(res: { ok?: boolean; status?: number; jsonBody?: unknown }) {
  const f = vi.fn().mockResolvedValue({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    statusText: '',
    headers: new Headers(res.jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
    json: async () => res.jsonBody,
    text: async () => '',
  });
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe('api wrapper', () => {
  it('sends the CSRF header, cookies and JSON on every request', async () => {
    const f = mockFetch({ jsonBody: { ok: true } });
    await apiPost('/api/x', { a: 1 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init.credentials).toBe('include');
    expect(init.headers['X-Requested-With']).toBe('sonu');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('sends the CSRF header on GET too and builds the query string', async () => {
    const f = mockFetch({ jsonBody: [] });
    await api('/api/list', { query: { q: 'a b', n: 2, skip: undefined } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/list?q=a+b&n=2');
    expect(init.headers['X-Requested-With']).toBe('sonu');
  });

  it('uploads multipart without a JSON content type', async () => {
    const f = mockFetch({ jsonBody: {} });
    await apiUpload('/api/up', { listKey: 'wr', file: new File(['x'], 'a.xlsx') });
    const [, init] = f.mock.calls[0]!;
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers['X-Requested-With']).toBe('sonu');
  });

  it('maps the server error shape to ApiError', async () => {
    mockFetch({ ok: false, status: 422, jsonBody: { error: { code: 'invalid', message: 'Bad caption', details: { caption: 'WR No' } } } });
    const err = await api('/api/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'invalid', message: 'Bad caption', details: { caption: 'WR No' } });
  });

  it('falls back to a generic ApiError for non-JSON failures and network errors', async () => {
    mockFetch({ ok: false, status: 502 });
    expect(await api('/api/x').catch((e) => e)).toMatchObject({ status: 502, code: 'http_error' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fail')));
    expect(await api('/api/x').catch((e) => e)).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('calls the unauthorized handler on 401 unless disabled', async () => {
    const h = vi.fn();
    setUnauthorizedHandler(h);
    mockFetch({ ok: false, status: 401, jsonBody: { error: { code: 'unauthorized', message: 'no' } } });
    await api('/api/x').catch(() => undefined);
    expect(h).toHaveBeenCalledTimes(1);
    await api('/api/x', { redirectOn401: false }).catch(() => undefined);
    expect(h).toHaveBeenCalledTimes(1);
  });
});
