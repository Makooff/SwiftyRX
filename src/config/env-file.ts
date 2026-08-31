/**
 * Reading and editing a `.env` file as text.
 *
 * Separate from `load-env.ts`, which hands the file to Node's loader and never
 * looks at it. Here the file is the artefact: someone wrote comments in it,
 * ordered it to suit themselves, and will open it again after this runs. So an
 * edit replaces the line it means to change and leaves everything else exactly
 * as it was — rather than parsing to an object and serialising a new file,
 * which is tidier and throws away the part that belongs to the reader.
 */

/** The assignments in a .env file, last one winning, comments discarded. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = stripQuotes(line.slice(eq + 1).trim());
  }
  return out;
}

function stripQuotes(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}

/**
 * The same assignments, each with the comment block written directly above it.
 *
 * `.env.recommande` explains every value it proposes, in French, in the lines
 * above that value. Reading those back means the explanation lives in exactly
 * one place — the file a person edits — instead of being duplicated into a
 * script that will drift away from it.
 *
 * A blank line ends a block: a comment separated from the assignment is a
 * section heading, not an explanation of that key.
 */
export function parseEnvFileWithComments(
  text: string,
): Record<string, { value: string; comment: string }> {
  const out: Record<string, { value: string; comment: string }> = {};
  let block: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') {
      block = [];
      continue;
    }
    if (line.startsWith('#')) {
      block.push(line.replace(/^#+\s?/, '').trimEnd());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        out[key] = {
          value: stripQuotes(line.slice(eq + 1).trim()),
          comment: block.join(' ').replace(/\s+/g, ' ').trim(),
        };
      }
    }
    block = [];
  }
  return out;
}

/**
 * Rewrite the assignments named in `changes`, preserving everything else.
 *
 * A key that already has a line is replaced where it stands, so the comment
 * above it — which explains that setting — still sits above it afterwards. A
 * key with no line is appended under `appendHeading`, grouped rather than
 * scattered, so it is obvious later which lines a tool wrote.
 *
 * A commented-out `# KEY=value` is not treated as an assignment: it is left
 * alone and the key is appended. Uncommenting someone's deliberately disabled
 * line is a decision, not a formatting detail.
 */
export function applyToEnvFile(
  text: string,
  changes: Record<string, string>,
  appendHeading?: string,
): string {
  const remaining = new Map(Object.entries(changes));
  const lines = text.split(/\r?\n/);

  const rewritten = lines.map((line) => {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=/.exec(line);
    if (!match) return line;
    const key = match[2]!;
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${match[1]}${key}=${value}`;
  });

  if (remaining.size === 0) return rewritten.join('\n');

  while (rewritten.length > 0 && rewritten[rewritten.length - 1]!.trim() === '') rewritten.pop();
  rewritten.push('');
  if (appendHeading) rewritten.push(appendHeading);
  for (const [key, value] of remaining) rewritten.push(`${key}=${value}`);
  rewritten.push('');
  return rewritten.join('\n');
}
