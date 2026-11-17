import { randomBytes } from 'node:crypto';
import { startMockPortal, type MockOptions, type MockPortal } from '../../mock-portal/server.js';
import { listCaptions } from '../../mock-portal/views.js';
import { workerToken, type WorkerConfig } from '../../src/config.js';
import { Logger } from '../../src/logger.js';
import { AppClient, pollOnce } from '../../src/run.js';
import { startFakeApp, type FakeApp } from './fake-app.js';

export const ENCRYPTION_KEY = randomBytes(32).toString('base64');
export const TOKEN = workerToken(ENCRYPTION_KEY);

/** Fictional credentials, fresh per scenario so the log-grep test is meaningful. */
export function fictionalCredentials() {
  return {
    project: 'MARAFIQ',
    username: 'test.contractor',
    password: `Mock-${randomBytes(9).toString('base64url')}!`,
  };
}

export function testConfig(appUrl: string, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    appUrl,
    token: TOKEN,
    pollSeconds: 1,
    headless: true,
    allowInsecurePortal: true,
    pace: { minMs: 0, maxMs: 15, maxBackoffMs: 50 },
    maxDownloadBytes: 5 * 1024 * 1024,
    navTimeoutMs: 15_000,
    stepTimeoutMs: 10_000,
    ...over,
  };
}

export interface ScenarioInput {
  mock?: Omit<MockOptions, 'credentials'>;
  kind?: 'test' | 'sync';
  lists?: string[];
  /** Password sent in the job; defaults to the correct one. */
  jobPassword?: string;
  baseUrl?: (mock: MockPortal) => string;
  config?: Partial<WorkerConfig>;
}

export interface ScenarioOutput {
  mock: MockPortal;
  app: FakeApp;
  result: any;
  logs: string[];
  password: string;
  jobPassword: string;
  /** Run one more poll (no job queued) and return. */
  pollAgain(): Promise<boolean>;
  close(): Promise<void>;
}

export async function runScenario(input: ScenarioInput): Promise<ScenarioOutput> {
  const creds = fictionalCredentials();
  const mock = await startMockPortal({ credentials: creds, ...(input.mock ?? {}) });
  const app = await startFakeApp(TOKEN, listCaptions);
  const logs: string[] = [];
  const logger = new Logger((l) => logs.push(l), { test: true });
  const cfg = testConfig(app.url, input.config);
  const client = new AppClient(cfg.appUrl, cfg.token);
  const jobPassword = input.jobPassword ?? creds.password;
  app.enqueue({
    jobId: `job-${randomBytes(3).toString('hex')}`,
    kind: input.kind ?? 'sync',
    connection: {
      id: 'conn-1',
      baseUrl: input.baseUrl ? input.baseUrl(mock) : mock.baseUrl,
      project: creds.project,
      username: creds.username,
      password: jobPassword,
    },
    lists: input.lists ?? [],
  });
  await pollOnce(cfg, client, logger);
  const result = app.results[0]?.body;
  return {
    mock,
    app,
    result,
    logs,
    password: creds.password,
    jobPassword,
    pollAgain: () => pollOnce(cfg, client, logger),
    close: async () => {
      await mock.close();
      await app.close();
    },
  };
}
