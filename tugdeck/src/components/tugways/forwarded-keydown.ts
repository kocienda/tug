/**
 * forwarded-keydown.ts — the keydown the engine hands a key view on the
 * user's behalf, built so it matches chords exactly as the original did.
 *
 * A chord is matched by an event's effective code (`effectiveCode` in
 * `chord-format.ts`), and a letter's effective code comes from the legacy
 * `keyCode`. A copy that carried `key` and `code` alone would match by
 * position again, so on AZERTY a forwarded ⌘A would read as ⌘Q to whatever
 * it was forwarded to. The copy therefore carries `keyCode`.
 *
 * `keyCode` is a legacy field, and an engine is free to ignore it in the
 * `KeyboardEvent` init dictionary and report 0. So the copy is read back,
 * and when the constructor did not keep the value it is defined on the event
 * itself.
 */

/** The fields a forwarded keydown copies from the keydown it stands in for. */
export type ForwardableKeydown = Pick<
  KeyboardEvent,
  "key" | "code" | "keyCode" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

/** Builds a keydown from an init dictionary; the default is the DOM's own. */
export type KeydownFactory<E extends { readonly keyCode: number }> = (
  init: KeyboardEventInit,
) => E;

/**
 * A bubbling, cancelable keydown carrying the original's key, code, keyCode
 * and modifier flags.
 *
 * It must bubble: React attaches its handlers at the root container, so a
 * non-bubbling dispatch would never reach the component.
 */
export function forwardedKeydown(event: ForwardableKeydown): KeyboardEvent;
export function forwardedKeydown<E extends { readonly keyCode: number }>(
  event: ForwardableKeydown,
  make: KeydownFactory<E>,
): E;
export function forwardedKeydown(
  event: ForwardableKeydown,
  make: KeydownFactory<{ readonly keyCode: number }> = (init) =>
    new KeyboardEvent("keydown", init),
): { readonly keyCode: number } {
  const forwarded = make({
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });
  if (forwarded.keyCode !== event.keyCode) {
    Object.defineProperty(forwarded, "keyCode", {
      value: event.keyCode,
      configurable: true,
      enumerable: true,
    });
  }
  return forwarded;
}
