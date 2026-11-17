import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from './migrate.js';
import { putSecret } from './secrets.js';
import { setupCode } from './auth/tokens.js';

/** Web-push VAPID keys: generated once, public key in app_setting, private key encrypted in secret. */
export async function ensureVapidKeys(app: FastifyInstance): Promise<{ publicKey: string }> {
  const existing = await app.db.query<{ value: { publicKey: string } }>(
    `SELECT value FROM app_setting WHERE key = 'vapid' AND contractor_id IS NULL`,
  );
  if (existing.rows[0]?.value?.publicKey) return { publicKey: existing.rows[0].value.publicKey };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([0x04]), Buffer.from(pubJwk.x!, 'base64url'), Buffer.from(pubJwk.y!, 'base64url')]);
  const pub = raw.toString('base64url');
  const secretId = await putSecret(app.db, { contractorId: null, purpose: 'vapid.private_key', value: privJwk.d! });
  await app.db.query(
    `INSERT INTO app_setting (key, contractor_id, value, secret_id) VALUES ('vapid', NULL, $1, $2)
     ON CONFLICT (key, contractor_id) DO NOTHING`,
    [JSON.stringify({ publicKey: pub, subject: app.config.publicUrl }), secretId],
  );
  app.log.info('generated VAPID keys for web push');
  return { publicKey: pub };
}

/** When there is no user at all, prints a one-time setup code to the log. */
export async function prepareFirstRun(app: FastifyInstance): Promise<string | null> {
  const n = (await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app_user')).rows[0]!.n;
  if (n > 0) {
    app.setupState.code = null;
    return null;
  }
  const code = setupCode();
  app.setupState.code = code;
  app.log.warn(
    `\n==============================================================\n` +
      ` SONU first run: no users yet.\n` +
      ` Open ${app.config.publicUrl}/setup and enter this one-time setup code:\n\n` +
      `     ${code}\n\n` +
      ` The code is valid until the platform admin is created (a restart makes a new one).\n` +
      `==============================================================`,
  );
  return code;
}

/** Everything that must happen before the server listens. */
export async function initApp(app: FastifyInstance): Promise<void> {
  await runMigrations(app.db, app.config.migrationsDir, (m) => app.log.info(m));
  await fs.mkdir(app.config.uploadDir, { recursive: true }).catch((err) => app.log.warn({ err: (err as Error).message }, 'cannot create UPLOAD_DIR'));
  await ensureVapidKeys(app);
  await prepareFirstRun(app);
}
