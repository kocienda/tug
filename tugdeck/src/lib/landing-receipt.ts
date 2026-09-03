/**
 * landing-receipt — the `Tug-Arc:` trailer parser the History join badge
 * reads.
 *
 * The commit landing summary is now formatted server-side and rides the shell
 * ledger ([P07]); the client-side receipt formatters that used to live here
 * are gone. Only the History badge's trailer parser remains.
 *
 * @module lib/landing-receipt
 */

/**
 * The arc short name from a `Tug-Arc:` trailer value
 * (`tugarc/<name> onto <base>`, or a bare branch ref from older commits).
 * Null when the value doesn't carry an arc ref — the badge does not render.
 */
export function arcNameFromTrailer(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const ref = value.trim().split(/\s+/, 1)[0] ?? "";
  if (!ref.startsWith("tugarc/")) return null;
  const name = ref.slice("tugarc/".length);
  return name.length > 0 ? name : null;
}
