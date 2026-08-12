/**
 * `node:sqlite` emits an ExperimentalWarning on first use. It is noise for an
 * end-user desktop app, so we filter that one warning and leave every other
 * warning intact.
 *
 * This module must be imported *before* `node:sqlite`. ESM evaluates imports in
 * source order, so `import './suppress-warnings.js'` placed above the sqlite
 * import is enough.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  return (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
