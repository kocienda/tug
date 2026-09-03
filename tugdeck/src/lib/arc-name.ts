/**
 * arc-name.ts — what the deck will pass through to `tugtool arc create`.
 *
 * `/arc <name>` runs its create path through the card's shell route, which
 * means the name lands on a command line. This is the conservative check that
 * decides whether it goes unquoted or gets refused with a sentence naming the
 * constraint — a name with a space, a quote, or a `$` in it is answered here
 * rather than turned into a shell-quoting adventure.
 *
 * Deliberately narrower than the CLI's own rule and deliberately not a
 * substitute for it: `tugtool` remains the real validator, and a name that
 * passes here can still be refused there for reasons the deck has no business
 * knowing (a taken branch, a reserved word). What this guarantees is only that
 * whatever passes is safe to concatenate.
 *
 * @module lib/arc-name
 */

/** Starts with a letter or digit, then letters, digits, `.`, `-`, `_`. */
const ARC_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The sentence a refused name is answered with — the constraint, stated. */
export const ARC_NAME_CAUTION =
  "An arc name starts with a letter or digit, then letters, digits, dot, arc, or underscore";

/** True when `name` is safe to pass through to `tugtool arc create` unquoted. */
export function isShellSafeArcName(name: string): boolean {
  return ARC_NAME_SHAPE.test(name);
}
