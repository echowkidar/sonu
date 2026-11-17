/**
 * Adapter for Baileys (WhatsApp Web multi-device, MIT; npm "baileys").
 *
 * Loaded ONLY through a dynamic import() when an admin starts a linked session — never in click-to-chat mode.
 * The package is deliberately NOT a dependency of the server yet (see docs/API-comm.md, "Linked session"):
 * its signal library dependency is GPL-3.0. Until the lead decides and runs `npm install baileys`, the
 * loader fails and the status endpoints report `available: false` with the reason.
 */
import type { WaLibrary, WaLibraryLoader } from './types.js';

/** A variable, so TypeScript does not try to resolve the optional module at build time. */
const MODULE_NAME: string = 'baileys';

function silentLogger(): any {
  const noop = () => undefined;
  const l: any = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  l.child = () => l;
  return l;
}

export const loadBaileys: WaLibraryLoader = async (): Promise<WaLibrary> => {
  let m: any;
  try {
    m = await import(MODULE_NAME);
  } catch {
    throw new Error(`The WhatsApp library "${MODULE_NAME}" is not installed on this server (linked session unavailable).`);
  }
  const make = m.makeWASocket ?? m.default;
  if (typeof make !== 'function' || typeof m.initAuthCreds !== 'function' || !m.BufferJSON) {
    throw new Error(`The installed "${MODULE_NAME}" package does not have the expected API.`);
  }
  return {
    name: MODULE_NAME,
    initAuthCreds: () => m.initAuthCreds(),
    serialize: (v) => JSON.stringify(v, m.BufferJSON.replacer),
    deserialize: (s) => JSON.parse(s, m.BufferJSON.reviver),
    reviveKey: (type, v) => (type === 'app-state-sync-key' && v && m.proto?.Message?.AppStateSyncKeyData ? m.proto.Message.AppStateSyncKeyData.fromObject(v) : v),
    createSocket: (auth) =>
      make({
        auth,
        printQRInTerminal: false,
        logger: silentLogger(),
        browser: ['SONU', 'Chrome', '1.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
      }),
    loggedOutCodes: [m.DisconnectReason?.loggedOut ?? 401, m.DisconnectReason?.forbidden ?? 403],
    restartCodes: [m.DisconnectReason?.restartRequired ?? 515],
  };
};
