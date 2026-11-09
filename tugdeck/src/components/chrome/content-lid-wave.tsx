/**
 * ContentLidWave — the deck's progress wave, centred on a lidded content
 * box, so a card whose content has not painted reads as one loading.
 *
 * It stands on every lid: the shell's stand-in for a card whose page has not
 * painted (`body-stand-in.tsx`), and the body page's own lid until its
 * content paints (`body/body-chrome-frame.tsx`, hidden by `body-page.css`
 * once `data-content-painted` lands). It draws after about two display
 * frames, so a lid that stands a frame or two never flickers a glyph, and a
 * slow one shows it steadily. The delay is counted in painted frames: the
 * wave mounts clear and arms itself two painted frames on, a DOM attribute
 * the stylesheet reads. Counting frames rather than milliseconds is the
 * point — a switch's first frame with the lid in it can come long after the
 * lid is made, and a delay in milliseconds runs out before anyone sees it.
 * Nothing animates on the frames: they only gate the attribute.
 *
 * The host's face for an arriving card is read off the stand-in
 * (`lib/face-draw.ts`), at the cut, inside the delay: the wrapper carries
 * {@link FACE_REST_ATTRIBUTE}, so the face draws the wave as it will stand
 * rather than as the delay hides it, and the face and the stand-in beneath it
 * show the same picture.
 *
 * Laws: [L06] whether it shows is the stylesheet's, keyed on an attribute
 * written to the DOM, never React state; [L13] the pulse is the wave's own
 * CSS animation, and the two frames move nothing; [L20] the wave keeps its own
 * tokens, and this only places it; [L09] the pane composes it into its own
 * content box.
 *
 * @module components/chrome/content-lid-wave
 */

import "./content-lid-wave.css";

import React, { useLayoutEffect, useRef } from "react";

import { FACE_REST_ATTRIBUTE } from "@/lib/face-draw";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";

/** The wave's bar height on a lid, px. */
export const LID_WAVE_SIZE = 20;

/** On the wrapper once its delay has passed: the wave draws. */
export const LID_WAVE_ARMED_ATTRIBUTE = "data-lid-wave-armed";

/** The animation-frame callbacks the wave waits before it arms: two painted frames clear. */
const LID_WAVE_DELAY_CALLBACKS = 3;

/** The wave over a lidded content box. */
export function ContentLidWave(): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  // Two painted frames, then armed: the first frame that shows the lid, and
  // the next, go without the glyph. Three callbacks, because a mount committed
  // in a task ahead of a frame's paint has its first callback run before that
  // very paint — the one that first shows the lid.
  useLayoutEffect(() => {
    let left = LID_WAVE_DELAY_CALLBACKS;
    const step = (): void => {
      left -= 1;
      if (left > 0) frame = requestAnimationFrame(step);
      else ref.current?.setAttribute(LID_WAVE_ARMED_ATTRIBUTE, "");
    };
    let frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={ref} className="tug-content-lid-wave" {...{ [FACE_REST_ATTRIBUTE]: "" }} aria-hidden="true">
      <TugProgressIndicator variant="wave" size={LID_WAVE_SIZE} aria-hidden />
    </div>
  );
}
