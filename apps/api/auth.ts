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

/**
 * Does this request look like it came in from the public internet?
 *
 * `assertExposureIsSafe` asks where the socket listens. A tunnel — cloudflared,
 * Tailscale Funnel, ngrok, any reverse proxy — makes that the wrong question:
 * the process still listens on 127.0.0.1, and the dashboard is still on the
 * public internet. So each request is also asked where it thinks it arrived.
 *
 * Two tells, both from the request itself:
 *   - a forwarding header, which only something in front of us adds
 *   - a Host naming anything other than this machine
 *
 * Honest about its limit: a client that already knows the URL can send whatever
 * Host it likes, and this is not what stops them. It stops the accident — a
 * tunnel opened for convenience over a dashboard whose password was never set.
 * The password is the control. This is what tells you that you need one.
 */
export function looksPubliclyRouted(headers: IncomingMessage['headers']): boolean {
  // RFC 7239 and the de facto headers that predate it. Vendor-specific ones
  // (cf-connecting-ip and friends) are deliberately not listed: the generic
  // ones are enough, and a list of brand names goes stale.
  const forwarding = ['forwarded', 'x-forwarded-for', 'x-forwarded-host'];
  if (forwarding.some((name) => headers[name] !== undefined)) return true;

  const host = headers.host;
  // No Host at all is HTTP/1.0 or a hand-written request, not a browser that
  // followed a public URL. Nothing to conclude from it.
  if (!host) return false;
  // "127.0.0.1:3000" -> "127.0.0.1", "[::1]:3000" -> "::1". A malformed literal
  // yields '', which is not loopback, so it is treated as outside.
  const name = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : (host.split(':')[0] ?? host);
  return !isLoopback(name);
}

/**
 * Refuse a request that reached us from outside while no password is set.
 *
 * Not a 401: a challenge would prompt for a credential that cannot exist yet.
 * The answer is a configuration change, so the response says which one, in
 * plain text a browser will render as-is.
 *
 * Returns true when the request may proceed.
 */
export function refuseUnprotectedExposure(
  req: IncomingMessage,
  res: ServerResponse,
  password: string | undefined,
): boolean {
  if (password) return true;
  if (!looksPubliclyRouted(req.headers)) return true;

  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    'This dashboard is reachable from outside this machine and has no password.\n\n' +
      'It shows a live portfolio, its open positions and every signal, so it is not\n' +
      'served over a tunnel unprotected.\n\n' +
      'Set DASHBOARD_PASSWORD (at least 12 characters) in .env and restart.\n',
  );
  return false;
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
