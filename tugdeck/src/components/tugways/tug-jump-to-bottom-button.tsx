/**
 * tug-jump-to-bottom-button.tsx — round "scroll to latest" affordance for a
 * transcript that follows its own live edge.
 *
 * Floats over the scrollport, pinned bottom-center, and is shown only while
 * the reader has scrolled away from the live edge. Modeled on the down-arrow
 * button chat clients surface when the conversation is scrolled up.
 *
 * Card-agnostic: the Session card's transcript and the Overview's column both
 * mount it, and neither owns it. What a host supplies is the positioned
 * ancestor it floats in, the click that jumps, and the attribute that shows
 * it — nothing about the button knows which transcript it is over.
 *
 * **Visibility is appearance state.** The host toggles a `data-visible`
 * attribute on the button — written from whatever its own follow-bottom
 * observer is — and CSS fades it in / out ([L06]). The component itself holds
 * no state and never re-renders for the show / hide.
 *
 * **Mount discipline.** A host renders this unconditionally, never mounting it
 * behind a condition, so the show / hide is a pure CSS transition with no
 * React reconciliation ([L26]).
 *
 * @module components/tugways/tug-jump-to-bottom-button
 */

import "./tug-jump-to-bottom-button.css";

import React from "react";
import { ArrowDown } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";

export interface TugJumpToBottomButtonProps {
  /**
   * Fired when the user clicks the button — the host jumps its transcript to
   * the latest content and re-engages follow-bottom.
   */
  onClick: () => void;
}

/**
 * Round jump-to-latest button. The host owns visibility via the
 * `data-visible` attribute (see module docstring); this component is
 * a thin, stateless affordance. The ref forwards to the underlying
 * `<button>` so the host can toggle that attribute imperatively.
 */
export const TugJumpToBottomButton = React.forwardRef<
  HTMLButtonElement,
  TugJumpToBottomButtonProps
>(function TugJumpToBottomButton({ onClick }, ref) {
  return (
    <TugPushButton
      ref={ref}
      data-slot="tug-jump-to-bottom-button"
      className="tug-jump-to-bottom-button"
      subtype="icon"
      emphasis="filled"
      role="action"
      size="sm"
      rounded="full"
      icon={<ArrowDown />}
      // The filled look is weight, not a CTA claim: Return never means "scroll
      // to latest", and the button is mounted the whole time the transcript is
      // up (visibility is CSS), so registering it would make it the card's
      // standing Return's-home and swallow every editor submit chord.
      neverDefaultButton
      aria-label="Scroll to latest"
      onClick={onClick}
    />
  );
});
