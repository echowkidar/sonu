/** Run the mock portal by hand: `npm run mock` (fictional credentials printed below; local only). */
import { startMockPortal } from './server.js';

const port = Number(process.env.MOCK_PORT ?? 8099);
const credentials = { project: 'MARAFIQ', username: 'mock.contractor', password: 'mock-only-password' };
const mock = await startMockPortal({
  credentials,
  port,
  host: process.env.MOCK_HOST ?? '127.0.0.1',
  internalErrorFirstN: Number(process.env.MOCK_INTERNAL_ERRORS ?? 0),
  ...(process.env.MOCK_FIXTURES ? { fixturesDir: process.env.MOCK_FIXTURES } : {}),
});
console.log(`mock portal on ${mock.baseUrl} — fictional sign-in: ${credentials.project} / ${credentials.username} / ${credentials.password}`);
console.log(`trap log: ${mock.origin}/__trap-log   stats: ${mock.origin}/__stats`);
