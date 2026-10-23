/**
 * ContentLidWave — the progress wave a lidded card wears while its content
 * has not painted.
 *
 * A card whose page is being made shows its chrome over a lid in the pane's
 * surface: first as the shell's stand-in (`body-stand-in.tsx`), whose
 * display list the host draws as its face over a workspace switch
 * (`lib/face-draw.ts`), and then as the page's own frame, until the card's
 * content paints (`body/body-chrome-frame.tsx`). A plain lid lifting reads
 * as a pop; the same lid wearing the deck's wave reads as a load finishing,
 * the way the launch's splash does. So both pictures draw it, centred over
 * the pane, with the same geometry, so the hand-off from face to page
 * changes nothing on screen.
 *
 * The stand-in draws the wave's rest pose, which is what the host's face
 * carries; the page draws it running, whose loop begins at that same pose.
 * The page shows it only once its frame wears {@link LID_WAVE_ATTRIBUTE},
 * written two display frames after its chrome frame, beside the page's
 * `painted` report: by the time the host shows the page the wave is up, and
 * a card whose content paints within those frames never draws it.
 *
 * Laws: [L06] whether the wave shows is the frame's attribute and the
 * stylesheet's; [L13] its motion is the wave's own CSS loop; [L20] it
 * composes `TugProgressIndicator` and sets none of its tokens.
 *
 * @module components/chrome/content-lid-wave
 */

import "./content-lid-wave.css";

import React from "react";

import { TugProgressIndicator } from "../tugways/tug-progress-indicator";

/** On a page's chrome frame from two display frames past its first chrome frame: its lid may show the wave. */
export const LID_WAVE_ATTRIBUTE = "data-lid-wave";

/** The wave's bar height, px: the launch splash's. */
const WAVE_SIZE = 32;

export interface ContentLidWaveProps {
  /** Running in the page; at rest in the stand-in, whose picture the host draws. */
  running: boolean;
}

export function ContentLidWave({ running }: ContentLidWaveProps): React.ReactElement {
  return (
    <div className="tug-content-lid-wave" data-slot="content-lid-wave" aria-hidden="true">
      <TugProgressIndicator variant="wave" size={WAVE_SIZE} state={running ? "running" : "stopped"} />
    </div>
  );
}
