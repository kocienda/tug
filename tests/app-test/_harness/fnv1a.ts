/**
 * fnv1a.ts — the short instance token, computed the same way in TS as
 * everywhere else in the suite.
 *
 * Three implementations of this must agree or resources get addressed
 * by the wrong name: `tugcore::ports::fnv1a_32` (Rust),
 * `InstanceConfig.shortToken` (Swift), and this one. All three are
 * FNV-1a 32-bit rendered as eight lower-hex digits.
 *
 * The harness needs it because an instance's private tmux server is
 * `tug-<token>` — addressing that server by name is the only way to
 * reclaim it when the `tugtool` spawn is unavailable.
 */

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a 32-bit hash of `input`'s UTF-8 bytes. */
export function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    // `Math.imul` keeps the multiply in 32-bit space; a plain `*`
    // loses precision past 2^53 and silently diverges from Rust.
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** The `%08x` short token for an instance id. */
export function shortToken(instanceId: string): string {
  return fnv1a32(instanceId).toString(16).padStart(8, "0");
}

/** The private tmux server label for an instance id: `tug-<token>`. */
export function tmuxSocketLabel(instanceId: string): string {
  return `tug-${shortToken(instanceId)}`;
}
