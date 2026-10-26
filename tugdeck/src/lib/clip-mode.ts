/**
 * clip-mode.ts — the page under a site clip recording.
 *
 * A site clip is one scene recorded twice, once per theme mode, and the two
 * cuts are trimmed to the same frames. So the two runs have to move alike:
 * every animation at its declared duration, and nothing that keeps its own
 * phase — a blinking caret — in the frame. The harness switches the mode on
 * per launch (`TUGAPP_CLIP_MODE=1`, which `TestHarnessUserScript` turns into
 * `window.__tugClipMode` the way the persist and restore flags are), and
 * this module reads the flag once at boot, in the shell and in every body.
 *
 * What it pins: `--tug-timing` at 1 on the root, so a scene records at the
 * product's own pace whatever a developer's deck last set the multiplier
 * to; and `data-tug-clip` on `<html>`, the hook a stylesheet stills a
 * self-phased loop under — the composer's caret blink, in
 * `tug-text-editor/caret-layer.ts`. The stub's pacing needs no pin: a
 * transcript's `paceMs` is a constant the stub reads, so it is already the
 * same in both cuts.
 *
 * Appearance only, through CSS and DOM ([L06]); no React state reads it.
 *
 * @module lib/clip-mode
 */

declare global {
  interface Window {
    /**
     * DEBUG-only: the page is recording a site clip. Set by a `WKUserScript`
     * injected at `atDocumentStart` when the Swift host starts with
     * `TUGAPP_CLIP_MODE=1`; release builds never reach this path
     * (`#if DEBUG`-gated). Read once at boot by {@link installClipMode}.
     */
    __tugClipMode?: boolean;
  }
}

/** The attribute `<html>` carries under clip mode; stylesheets key on it. */
export const CLIP_MODE_ATTR = "data-tug-clip";

/** Whether this page booted under clip mode. */
export function isClipMode(): boolean {
  return window.__tugClipMode === true;
}

/**
 * Pin the page for a recording when the launch asked for one; a no-op
 * otherwise. Call once at boot, after the motion observer.
 */
export function installClipMode(): void {
  if (!isClipMode()) return;
  const root = document.documentElement;
  root.setAttribute(CLIP_MODE_ATTR, "");
  root.style.setProperty("--tug-timing", "1");
}
