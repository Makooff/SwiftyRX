import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Dashboard authentication.
 *
 * The dashboard is read-only, so the worst a stranger can do is *read* — but
 * what they would read is a live portfolio, its positions, and every signal the
 * system is acting on. That is worth a password.
 *
 * HTTP Basic over the browser's native prompt, deliberately: it needs no login
 * page, no session store, no cookie, and no new attack surface. The token lives
 * in the environment like every other secret.
 *
 * The rule that matters is in `assertExposureIsSafe`: binding anywhere other
 * than loopback without a token is refused at startup. Publishing a portfolio
 * by forgetting a variable is exactly the mistake this prevents.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export class UnsafeExposureError extends Error {
  constructor(host: string) {
    super(
      `Refusing to bind the dashboard to ${host} without a password.\n` +
        '  This surface exposes portfolio state, open positions and signals.\n' +
        '  Set DASHBOARD_PASSWORD (and DASHBOARD_USER if you want something other than "admin"),\n' +
        '  or bind to 127.0.0.1 and reach it through an SSH tunnel:\n' +
        '    ssh -N -L 3000:127.0.0.1:3000 you@your-server',
    );
    this.name = 'UnsafeExposureError';
  }
}

/**
 * Startup gate. A non-loopback bind requires a password, with no way to opt out
 * — an override flag would become the thing everyone sets.
 */
export function assertExposureIsSafe(host: string, password: string | undefined): void {
  if (!isLoopback(host) && !password) throw new UnsafeExposureError(host);
}

/** Constant-time compare that does not leak length through early return. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still do a comparison so the timing of a wrong-length guess matches a
    // wrong-value one.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface AuthOptions {
  user: string;
  password: string | undefined;
}

/**
 * Check one request.
 *
 * Returns true when the request may proceed. When it returns false it has
 * already written the 401 challenge, so the caller stops.
 */
export function authorise(
  req: IncomingMessage,
  res: ServerResponse,
  options: AuthOptions,
): boolean {
  // No password configured means loopback-only, already enforced at startup.
  if (!options.password) return true;

  const header = req.headers.authorization ?? '';
  const [scheme, encoded] = header.split(' ');

  if (scheme?.toLowerCase() === 'basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator !== -1) {
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      // Both compared, and both constant-time: a valid username must not be
      // distinguishable from an invalid one by response timing.
      const userOk = safeEqual(user, options.user);
      const passwordOk = safeEqual(password, options.password);
      if (userOk && passwordOk) return true;
    }
  }

  res.writeHead(401, {
    'www-authenticate': 'Basic realm="AI Market Agent", charset="UTF-8"',
    'content-type': 'application/json; charset=utf-8',
    // The dashboard should never be cached by a shared proxy.
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ error: 'authentication required' }));
  return false;
}
