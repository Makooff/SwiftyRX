import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load `.env` into process.env using Node's built-in loader (Node >= 20.12).
 *
 * No dotenv dependency: the runtime already does this. Values already present
 * in the real environment win, so a deployment's secrets are never overwritten
 * by a stray local file.
 */
export function loadEnvFile(path = '.env'): boolean {
  const absolute = resolve(process.cwd(), path);
  if (!existsSync(absolute)) return false;

  const loader = (process as NodeJS.Process & { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader !== 'function') {
    throw new Error(
      'process.loadEnvFile is unavailable — Node 20.12+ is required, or export the variables yourself',
    );
  }

  const before = { ...process.env };
  loader.call(process, absolute);
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
  return true;
}
