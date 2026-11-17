/**
 * Portal session: sign-in with Project / Username / Password, re-use of the session between lists,
 * and THE sign-in budget: at most MAX_SIGNIN_ATTEMPTS (2) sign-in attempts per job, in total,
 * including re-sign-ins after an expired session. There is no third attempt, ever.
 */
import type { Page } from 'playwright';
import { APP_ROOT, LOGIN_FIELD_LABELS, LOGIN_PATH, type ListDef } from './allowlist.js';
import type { PortalGuard } from './guard.js';
import type { Logger } from './logger.js';
import type { Pace } from './pace.js';

/** Hard limit. design/14 4.3: "At most 2 sign-in attempts, then stop and alert". */
export const MAX_SIGNIN_ATTEMPTS = 2;

/** The one and only sign-in counter. One instance per job. */
export class SignInBudget {
  private used = 0;
  readonly max: number;

  constructor(max: number = MAX_SIGNIN_ATTEMPTS) {
    if (!Number.isInteger(max) || max < 1 || max > MAX_SIGNIN_ATTEMPTS) {
      throw new RangeError(`sign-in budget must be 1..${MAX_SIGNIN_ATTEMPTS}`);
    }
    this.max = max;
  }

  get attempts(): number {
    return this.used;
  }

  get remaining(): number {
    return this.max - this.used;
  }

  /** Reserve one attempt. Returns false — and never reserves — once the budget is used up. */
  tryTake(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
}

export class SignInFailedError extends Error {
  override name = 'SignInFailedError';
  constructor(message: string, readonly attempts: number) {
    super(message);
  }
}

/** The session ended and the budget does not allow another sign-in (last sign-in had succeeded). */
export class SessionLostError extends Error {
  override name = 'SessionLostError';
}

export interface PortalCredentials {
  project: string;
  username: string;
  password: string;
}

export interface SessionOptions {
  origin: string;
  navTimeoutMs: number;
}

export class PortalSession {
  private signedIn = false;
  private lastAttemptFailed = false;
  private lastMessage = '';

  constructor(
    readonly page: Page,
    private readonly guard: PortalGuard,
    private readonly creds: PortalCredentials,
    readonly budget: SignInBudget,
    private readonly logger: Logger,
    private readonly pace: Pace,
    private readonly opts: SessionOptions,
  ) {}

  get isSignedIn(): boolean {
    return this.signedIn;
  }

  /** Sign in, using the job's budget. Throws SignInFailedError / SessionLostError when the budget is used up. */
  async signIn(): Promise<void> {
    for (;;) {
      if (!this.budget.tryTake()) {
        if (this.lastAttemptFailed) {
          throw new SignInFailedError(this.lastMessage || 'sign-in failed', this.budget.attempts);
        }
        throw new SessionLostError('session ended and the sign-in budget for this job is used up');
      }
      const n = this.budget.attempts;
      this.logger.info('sign-in attempt', { attempt: n, of: this.budget.max });
      const r = await this.attempt();
      if (r.ok) {
        this.signedIn = true;
        this.lastAttemptFailed = false;
        this.pace.ok();
        this.logger.info('signed in', { attempt: n });
        return;
      }
      this.signedIn = false;
      this.lastAttemptFailed = true;
      this.lastMessage = r.message;
      this.logger.warn('sign-in attempt failed', { attempt: n, message: r.message });
      if (this.budget.remaining > 0) await this.pace.backoff();
    }
  }

  private async attempt(): Promise<{ ok: true } | { ok: false; message: string }> {
    const page = this.page;
    this.guard.beginSignIn();
    try {
      await page.goto(this.opts.origin + LOGIN_PATH, { waitUntil: 'load', timeout: this.opts.navTimeoutMs });
      await this.pace.step();
      const project = page.getByLabel(LOGIN_FIELD_LABELS.project, { exact: true });
      const username = page.getByLabel(LOGIN_FIELD_LABELS.username, { exact: true });
      const password = page.getByLabel(LOGIN_FIELD_LABELS.password, { exact: true });
      const isSelect = (await project.locator('xpath=self::select').count()) > 0;
      if (isSelect) await project.selectOption({ label: this.creds.project }, { timeout: this.opts.navTimeoutMs });
      else await project.fill(this.creds.project, { timeout: this.opts.navTimeoutMs });
      await username.fill(this.creds.username, { timeout: this.opts.navTimeoutMs });
      await password.fill(this.creds.password, { timeout: this.opts.navTimeoutMs });
      const navigated = page.waitForEvent('framenavigated', {
        predicate: (f) => f === page.mainFrame(),
        timeout: this.opts.navTimeoutMs,
      }).catch(() => undefined);
      // Submitting with Enter in the password field: the worker never clicks a login button.
      await password.press('Enter');
      await navigated;
      await page.waitForLoadState('load', { timeout: this.opts.navTimeoutMs }).catch(() => undefined);
      if (await this.onLoginPage()) {
        const alert = page.getByRole('alert').first();
        const text = (await alert.textContent({ timeout: 2000 }).catch(() => null))?.trim();
        return { ok: false, message: (text || 'sign-in rejected').slice(0, 200) };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : 'sign-in error' };
    } finally {
      this.guard.idle();
    }
  }

  private async onLoginPage(): Promise<boolean> {
    let path = '';
    try {
      path = new URL(this.page.url()).pathname;
    } catch {
      /* about:blank or error page */
    }
    if (path === LOGIN_PATH) return true;
    return this.page.getByLabel(LOGIN_FIELD_LABELS.password, { exact: true }).isVisible().catch(() => false);
  }

  /**
   * Open an allow-listed list view. Signs in first if needed; if the portal sends us back to the
   * login page (session expired) it signs in again — within the same budget — and retries once.
   */
  async openList(def: ListDef): Promise<void> {
    for (let round = 0; round < 2; round++) {
      if (!this.signedIn) await this.signIn();
      this.guard.beginList(def);
      await this.pace.step();
      const resp = await this.page.goto(this.opts.origin + APP_ROOT + def.viewPath, {
        waitUntil: 'load',
        timeout: this.opts.navTimeoutMs,
      });
      if (await this.onLoginPage()) {
        this.signedIn = false;
        this.guard.idle();
        this.logger.info('session expired; signing in again if the budget allows', { remaining: this.budget.remaining });
        continue;
      }
      if (!resp || !resp.ok()) throw new Error(`view returned HTTP ${resp?.status() ?? 'no response'}`);
      return;
    }
    throw new SessionLostError('portal kept returning to the login page');
  }
}
