/**
 * macos-support — the minimum-macOS support policy and the pure derivation
 * that drives the runtime version gate ([P05], [P07], Spec S02).
 *
 * Policy lives here, beside the gate UI and its copy, not in the backend:
 * tugcast reports only the raw host version (`hostInfoStore`, from the
 * handshake), and this module decides whether that version is supported. The
 * table is kept in sync with `scripts/lab/matrix.json` `min_version`s by a
 * drift test.
 *
 * The comparison is fail-open ([R02]): an unknown or unparseable host version
 * never blocks. The gate fires only when the host is *known* to be below its
 * line's floor (or on a line older than anything we support).
 *
 * @module lib/macos-support
 */

import { useHostInfo, type HostInfo } from "./host-info-store";

/** A parsed macOS version. Missing components parse as 0 (e.g. "26" → 26.0.0). */
export interface MacosVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Minimum supported `{minor, patch}` per macOS major line ([P07], Spec S02).
 * Seeded from [Q01] and kept in sync with `scripts/lab/matrix.json`
 * `min_version`s (drift test). Keys are major versions:
 *   15 → Sequoia, 26 → Tahoe, 27 → Golden Gate.
 *
 * A host whose major line is listed is below the floor iff its `{minor,patch}`
 * is below the entry. A host on a major *not* listed is below the floor only
 * when it is older than the lowest listed line — a line newer than any we've
 * certified is allowed through (fail-open: we don't block an OS we simply
 * haven't gotten to yet).
 */
export const SUPPORTED_MACOS: Readonly<
  Record<number, { minor: number; patch: number }>
> = {
  15: { minor: 6, patch: 0 },
  26: { minor: 0, patch: 0 },
  27: { minor: 0, patch: 0 },
};

/**
 * Dev affordance (dev builds only): force the gate `"open"` or `"closed"` to
 * iterate the panel under HMR without spoofing the host version. Leave
 * `false`; the `import.meta.env.DEV` guard folds it out of production.
 */
export const SESSION_FORCE_VERSION_GATE: "open" | "closed" | false = false;

/** Parse a dotted macOS version string; `null` if it isn't `N`, `N.N`, or `N.N.N`. */
export function parseMacosVersion(version: string): MacosVersion | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(version.trim());
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? "0"),
    patch: Number(m[3] ?? "0"),
  };
}

/** Order two versions: negative if `a < b`, 0 if equal, positive if `a > b`. */
export function compareMacosVersion(a: MacosVersion, b: MacosVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** The lowest major line we support (the absolute floor's major). */
function lowestSupportedMajor(): number {
  return Math.min(...Object.keys(SUPPORTED_MACOS).map(Number));
}

/**
 * Is this host *known* to be below its line's minimum (or on a line older than
 * anything we support)? Pure, unit-tested. A `null` host (pre-handshake) or an
 * unparseable version returns `false` — unknown is fail-open, never blocked
 * ([R02], Spec S03).
 */
export function isHostBelowFloor(host: HostInfo | null): boolean {
  if (host === null) return false;
  const v = parseMacosVersion(host.version);
  if (v === null) return false;
  const line = SUPPORTED_MACOS[v.major];
  if (line !== undefined) {
    return (
      compareMacosVersion(v, {
        major: v.major,
        minor: line.minor,
        patch: line.patch,
      }) < 0
    );
  }
  // Not a listed line: block only if older than the lowest line we support.
  return v.major < lowestSupportedMajor();
}

/**
 * The minimum version string the host's line requires, for the gate's copy
 * (e.g. `"15.6"`). Falls back to the lowest supported line when the host line
 * is unknown or older than anything we support.
 */
export function requiredMinimumLabel(host: HostInfo | null): string {
  const v = host !== null ? parseMacosVersion(host.version) : null;
  const major =
    v !== null && SUPPORTED_MACOS[v.major] !== undefined
      ? v.major
      : lowestSupportedMajor();
  const line = SUPPORTED_MACOS[major];
  return line.patch > 0
    ? `${major}.${line.minor}.${line.patch}`
    : `${major}.${line.minor}`;
}

/**
 * ConfigureTug's open state with the version gate's precedence applied: setup is
 * suppressed while the gate is open, so the two app-modal siblings never stack
 * (Spec S02). Pure — lives here (not in the component) so it's unit-testable
 * without pulling in React/CSS, and so the precedence rule sits beside the gate
 * derivation it depends on.
 */
export function deriveConfigureTugOpen(
  gateOpen: boolean,
  wouldOpen: boolean,
): boolean {
  return !gateOpen && wouldOpen;
}

/**
 * Whether the version gate should be open (blocking). The single derivation
 * both `VersionGate` and `ConfigureTug` read, so the gate's precedence over
 * setup (Spec S02) stays consistent. A dev override wins in dev builds.
 *
 * Reads the host via `useHostInfo` — external state enters React only through
 * `useSyncExternalStore` ([L02]).
 */
export function useVersionGateOpen(): boolean {
  const host = useHostInfo();
  if (import.meta.env.DEV && SESSION_FORCE_VERSION_GATE !== false) {
    return SESSION_FORCE_VERSION_GATE === "open";
  }
  return isHostBelowFloor(host);
}
