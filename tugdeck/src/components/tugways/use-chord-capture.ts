/**
 * use-chord-capture.ts — the reader that owns the keyboard while a chord is
 * being read rather than obeyed.
 *
 * Reading a keydown is the easy half. The hard half is making three layers
 * yield so the chord arrives as an answer instead of firing its command, and
 * that is what this hook is: the key pipeline's stage-1 listener stands down
 * (`chordCaptureState.arm`), the host parks every menu key equivalent for the
 * span — AppKit's key-equivalent scan runs before the web view sees a keydown,
 * so without it ⌘W closes the card instead of being recorded ([P15]) — and a
 * focus trap holds the keyboard story with Escape as the cancel.
 *
 * Two surfaces in the Keyboard pane need exactly that and nothing else in
 * common. The row's capture strip holds each chord pending until the user
 * commits it; the chord probe answers one press and disarms. They are two
 * renderings of one reader, and a second implementation of the arming would
 * be a second, worse one — the failure mode is silent (a chord that fires on
 * its way to being read) and only ever appears in the shipped app.
 *
 * Neither surface writes anything from here. The hook reads; committing is
 * the caller's, and the probe has no commit at all.
 *
 * Laws: [L03] the arm is pushed in a layout effect, so it is in force before
 * any keyboard handler that could beat it to the key; [L27] the arm's release
 * is the effect's teardown.
 *
 * @module components/tugways/use-chord-capture
 */

import { useLayoutEffect, useRef } from "react";

import { chordCaptureState } from "./chord-capture-state";
import { chordFromEvent } from "./chord-format";
import type { Chord } from "./command-registry";
import { useFocusTrap } from "./use-focus-trap";

/** Modifier keys pressed alone, which are a chord in progress, not a chord. */
const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
]);

export interface UseChordCaptureOptions {
  /** A chord was read. Called once per non-modifier key, Escape excepted. */
  readonly onChord: (chord: Chord) => void;
  /** Escape, or the focus trap's own dismiss. */
  readonly onCancel: () => void;
}

/**
 * Arm a chord reader for as long as the calling component is mounted.
 *
 * Mounting is the arming: a caller arms by rendering the component that calls
 * this, and disarms by not rendering it. There is no `active` flag, because a
 * hook that could be armed or not would put the two surfaces' disarm logic
 * back inside the shared piece, and they disarm on different events.
 *
 * The callbacks are held in refs, so a caller that rebuilds them every render
 * does not re-run the arm ([L07]).
 */
export function useChordCapture({
  onChord,
  onCancel,
}: UseChordCaptureOptions): void {
  const onChordRef = useRef(onChord);
  onChordRef.current = onChord;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useFocusTrap({
    active: true,
    onEscapeDismiss: () => onCancelRef.current(),
  });

  useLayoutEffect(() => {
    const release = chordCaptureState.arm();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (MODIFIER_CODES.has(event.code)) return;
      // Nothing else may act on this key: the surface is here to read the
      // chord, and a chord that fires its old command on the way to being
      // read is the failure this whole capture exists to avoid.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.code === "Escape") {
        onCancelRef.current();
        return;
      }
      onChordRef.current(chordFromEvent(event));
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      release();
    };
  }, []);
}
