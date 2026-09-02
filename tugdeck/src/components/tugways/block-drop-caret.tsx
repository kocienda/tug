/**
 * block-drop-caret.tsx — the drop-target indicator for a section reorder
 * drag ([P08]).
 *
 * A thin accent hairline the drag handler positions in the gap at the target
 * index while a reorder drag is live. It is a single persistently-mounted
 * element whose position + visibility the {@link useBlockReorder} handler
 * drives IMPERATIVELY (inline `top` + a `data-visible` attribute) so nothing
 * about the drag re-renders React mid-gesture ([L06]/[L08]) — the caret is
 * appearance, committed only as a DOM write.
 *
 * It is absolutely positioned within `.cards-sections` (its offset parent), so
 * its `top` is a content-relative offset the handler computes from the
 * sections' measured rects.
 *
 * Laws: [L06] appearance via inline style + `data-visible`, never React
 * state; [L19] file pair, docstring, `data-slot`.
 *
 * @module components/tugways/block-drop-caret
 */

import React from "react";
import "./block-drop-caret.css";

/**
 * The drop caret. Hidden until the handler sets `data-visible="true"` and an
 * inline `top`. `ref` hands the handler the element to drive.
 */
export const BlockDropCaret = React.forwardRef<HTMLDivElement>(
  function BlockDropCaret(_props, ref) {
    return (
      <div
        ref={ref}
        className="block-drop-caret"
        data-slot="block-drop-caret"
        aria-hidden="true"
      />
    );
  },
);
