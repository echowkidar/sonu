/** Reading one list: open view -> Show -> XLS -> save the download (size-capped, never opened). */
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ListDef, ListKey } from './allowlist.js';
import { clickAllowed, hasAllowedButton } from './guard.js';
import type { PortalSession } from './session.js';
import type { Pace } from './pace.js';

export interface DownloadedFile {
  path: string;
  fileName: string;
  bytes: number;
}

export interface ReadOptions {
  tmpDir: string;
  maxBytes: number;
  timeoutMs: number;
}

const ALLOWED_EXT = /\.(xls|xlsx)$/i;

export async function readList(session: PortalSession, key: ListKey, def: ListDef, pace: Pace, opts: ReadOptions): Promise<DownloadedFile> {
  const page = session.page;
  await session.openList(def);
  if (def.hasShow) {
    await pace.step();
    await clickAllowed(page, 'Show', { timeoutMs: opts.timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: opts.timeoutMs }).catch(() => undefined);
  }
  await pace.step();
  const downloadP = page.waitForEvent('download', { timeout: opts.timeoutMs });
  downloadP.catch(() => undefined); // avoid an unhandled rejection if the click below throws
  await clickAllowed(page, 'XLS', { nth: def.xlsIndex, timeoutMs: opts.timeoutMs });
  const download = await downloadP;
  const suggested = download.suggestedFilename();
  const ext = (suggested.match(ALLOWED_EXT)?.[0] ?? '').toLowerCase();
  if (!ext) {
    await download.delete().catch(() => undefined);
    throw new Error('export is not an .xls/.xlsx file');
  }
  const failure = await download.failure();
  if (failure) throw new Error(`download failed: ${failure}`);
  // Our own file name: never trust the portal's name as a path.
  const fileName = `${key}-${Date.now()}${ext}`;
  const path = join(opts.tmpDir, fileName);
  await download.saveAs(path);
  await download.delete().catch(() => undefined);
  const { size } = await stat(path);
  if (size === 0 || size > opts.maxBytes) {
    await rm(path, { force: true });
    throw new Error(size === 0 ? 'export file is empty' : `export file larger than ${opts.maxBytes} bytes`);
  }
  return { path, fileName, bytes: size };
}

/** "Test connection": open the list and confirm the Show button exists — nothing is pressed. */
export async function probeList(session: PortalSession, def: ListDef, timeoutMs: number): Promise<boolean> {
  await session.openList(def);
  return hasAllowedButton(session.page, 'Show', timeoutMs);
}
