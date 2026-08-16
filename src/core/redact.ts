/**
 * Secret redaction.
 *
 * Credentials must never reach logs, the dashboard, or an LLM prompt. This
 * module is the single chokepoint for scrubbing them out of arbitrary values.
 */

const SECRET_KEY_PATTERN =
  /(api[-_]?key|apikey|secret|token|password|passwd|bearer|authorization|credential|private[-_]?key)/i;

/** Query-string parameters that carry credentials for our providers. */
const SECRET_QUERY_PARAMS = ['apikey', 'api_key', 'token', 'access_token', 'key'];

export const REDACTED = '[REDACTED]';

/** Registered secret literals, so a leaked value is caught even out of context. */
const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) knownSecrets.add(value);
}

export function resetSecrets(): void {
  knownSecrets.clear();
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Strip credential-bearing query parameters from a URL, keeping it readable. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const [name] of [...parsed.searchParams]) {
      if (SECRET_QUERY_PARAMS.includes(name.toLowerCase()) || SECRET_KEY_PATTERN.test(name)) {
        parsed.searchParams.set(name, REDACTED);
      }
    }
    return redactString(parsed.toString());
  } catch {
    return redactString(url);
  }
}

/** Deep-redact an arbitrary value: secret-looking keys, URLs, known literals. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH_LIMIT]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? redactUrl(value) : redactString(value);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}
