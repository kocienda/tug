/**
 * Dev-vs-production environment gate.
 *
 * Returns `true` when the bundle is not running in production. Used to gate
 * dev-only assertions, invariant checks, and diagnostic warnings so
 * production builds pay no cost for them.
 *
 * Permissive by design: returns `true` in any environment where
 * `NODE_ENV` is not explicitly `"production"` (browsers with no
 * globals, workers, test runners, etc.). This is the correct bias —
 * a failing assertion in a non-production build surfaces the problem;
 * silently skipping one in an unrecognized environment would hide it.
 */
export function isDevEnv(): boolean {
  try {
    return (globalThis as any).process?.env?.NODE_ENV !== "production";
  } catch {
    return true;
  }
}
