/** Tiny fake of the SONU server's three internal worker endpoints. */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';

export interface Upload {
  jobId: string;
  listKey: string;
  fileName: string;
  size: number;
  header: string[];
  captionsOk: boolean;
}

export interface FakeApp {
  url: string;
  enqueue(job: unknown): void;
  uploads: Upload[];
  results: { jobId: string; body: any }[];
  requests: { method: string; path: string; authorized: boolean }[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function headerRow(buf: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const values = ws.getRow(1).values as unknown[];
  return values.slice(1).map((v) => String(v ?? ''));
}

export async function startFakeApp(token: string, expectedCaptions: (key: string) => string[] | undefined): Promise<FakeApp> {
  const queue: unknown[] = [];
  const app: Omit<FakeApp, 'url' | 'close'> = {
    enqueue: (j) => queue.push(j),
    uploads: [],
    results: [],
    requests: [],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const authorized = req.headers.authorization === `Bearer ${token}`;
    app.requests.push({ method: req.method ?? '', path: url.pathname, authorized });
    const json = (status: number, obj?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    if (!authorized) return json(401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && url.pathname === '/internal/worker/jobs/next') {
        const job = queue.shift();
        if (!job) {
          res.writeHead(204);
          return res.end();
        }
        return json(200, job);
      }
      const m = url.pathname.match(/^\/internal\/worker\/jobs\/([^/]+)\/(file|result)$/);
      if (req.method === 'POST' && m) {
        const jobId = decodeURIComponent(m[1] as string);
        const body = await readBody(req);
        if (m[2] === 'result') {
          app.results.push({ jobId, body: JSON.parse(body.toString('utf8')) });
          return json(200, { ok: true });
        }
        const form = await new Response(new Uint8Array(body), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
        const listKey = String(form.get('listKey'));
        const file = form.get('file') as File;
        const buf = Buffer.from(await file.arrayBuffer());
        const header = await headerRow(buf).catch(() => []);
        const exp = expectedCaptions(listKey);
        const captionsOk = !!exp && exp.length === header.length && exp.every((c, i) => c === header[i]);
        app.uploads.push({ jobId, listKey, fileName: file.name, size: buf.length, header, captionsOk });
        if (!captionsOk) return json(200, { ok: false, rowsRead: 0, error: 'caption mismatch' });
        return json(200, { ok: true, rowsRead: 3 });
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      return json(500, { error: String(e) });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    ...app,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
