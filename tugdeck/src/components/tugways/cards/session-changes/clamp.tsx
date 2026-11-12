/**
 * Clamp — caps tall content to an N-line window with a reveal toggle.
 *
 * Renders arbitrary children, measures their natural height against an
 * N-line cap, and: when the content fits, renders it bare with no control;
 * when it overflows, clamps it to the cap (with a soft bottom fade) and
 * shows a "Show more / Show less" reveal that toggles the full content.
 * Presentation-only — no scroller or chrome coupling — so it drops into a
 * dialog, an inline blurb, or any surface where content can run long but is
 * cheap to render in full.
 *
 * This is the *visual-clamp* sibling of the body-kind *logical-fold*
 * system. When hidden content must UNMOUNT for performance (huge files,
 * long terminal output) or must coordinate with the transcript scroller,
 * use `BlockFoldCue` + `useBlockFoldState` instead. Clamp keeps
 * everything mounted and only caps the visible height — the right tool when
 * the content is small but tall (a wrapped command, an error message, a
 * markdown blurb).
 *
 * The clamp window and reveal are driven by a `data-expanded` attribute +
 * CSS [L06]; React state only flips the toggle's icon/label (state-derived
 * structure, the same exemption `BlockFoldCue`'s chevron uses) and gates
 * whether the toggle renders at all (a measured, structural decision). The
 * pixel cap is a measured layout constant the hook writes onto the content
 * node as `--tug-clamp-cap` — not an appearance toggle.
 *
 * Laws: [L06] appearance via CSS/DOM, [L19] component authoring guide
 * Decisions: [D105] visual-clamp vs logical-fold split
 *
 * @module components/tugways/cards/session-changes/clamp
 */

import "./clamp.css";

import React from "react";
import { ChevronsDown, ChevronsUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useClampOverflow } from "@/components/tugways/internal/use-clamp-overflow";

export interface ClampProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * Visual line cap before the content clamps. Content shorter than this
   * renders bare, with no reveal control.
   * @default 8
   */
  lines?: number;
  /**
   * Initial expanded state used when the content overflows the cap.
   * @selector [data-expanded="true"] | [data-expanded="false"]
   * @default false
   */
  defaultExpanded?: boolean;
  /** Label on the reveal control while collapsed. @default "Show more" */
  showMoreLabel?: string;
  /** Label on the reveal control while expanded. @default "Show less" */
  showLessLabel?: string;
  /** The content to clamp. */
  children: React.ReactNode;
}

/** Default line cap — a comfortable screenful of a wrapped command. */
const DEFAULT_LINES = 8;

export const Clamp = React.forwardRef<HTMLDivElement, ClampProps>(
  function Clamp(
    {
      lines = DEFAULT_LINES,
      defaultExpanded = false,
      showMoreLabel = "Show more",
      showLessLabel = "Show less",
      children,
      className,
      ...rest
    },
    ref,
  ) {
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const overflows = useClampOverflow(contentRef, lines);
    const [expanded, setExpanded] = React.useState(defaultExpanded);

    // The window only bites when the content overflows; a short content is
    // always "expanded" (bare) so the cap never clips a block that fits.
    const windowed = overflows && !expanded;

    return (
      <div
        ref={ref}
        data-slot="tug-clamp"
        data-expanded={windowed ? "false" : "true"}
        data-overflows={overflows ? "true" : undefined}
        className={cn("tug-clamp", className)}
        {...rest}
      >
        <div ref={contentRef} className="tug-clamp-content">
          {children}
        </div>
        {overflows ? (
          <TugPushButton
            data-slot="tug-clamp-toggle"
            className="tug-clamp-toggle"
            subtype="icon-text"
            emphasis="ghost"
            role="action"
            size="2xs"
            icon={expanded ? <ChevronsUp /> : <ChevronsDown />}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            // Reserve the wider of the two labels so toggling never shifts
            // the surrounding layout (same width-stability the fold cue uses).
            widthStabilize={
              showMoreLabel === showLessLabel
                ? undefined
                : { alternateLabel: expanded ? showMoreLabel : showLessLabel }
            }
          >
            {expanded ? showLessLabel : showMoreLabel}
          </TugPushButton>
        ) : null}
      </div>
    );
  },
);
