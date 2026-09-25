/**
 * `BlockNoticeBand` — the thin, collapse-independent annotation band a
 * tool block wears BETWEEN its header and its body.
 *
 * The header carries identity + a one-glyph result summary; the body carries
 * the full output (and is withheld while collapsed). Neither is the right
 * home for a short human explanation that must be readable WITHOUT expanding —
 * a failed Bash command's first error line, an Edit's "string not found", a
 * truncation note. That is this band: one to three lines with a leading
 * tone icon, rendered by `BlockChrome` in BOTH the collapsed and expanded
 * states (it sits OUTSIDE the chrome's collapse guard, unlike the body).
 *
 * It is general, not error-specific: `tone` selects the icon + its color
 * (`error`/`warning`/`info`/`success`), so any tool can surface a warning or
 * an info note through the same facility. The text stays neutral and the band
 * rides the same quiet strip surface as the header/footer — only the icon
 * carries the tone color, matching the chrome's "the lifecycle dot carries
 * status, no heavy color band" philosophy. The text clamps at `maxLines`
 * (default 3) with a trailing ellipsis; the full detail lives in the body,
 * one expand away.
 *
 * Laws:
 *  - [L06] appearance flows through `data-tone` + the clamp CSS var, never
 *    React state.
 *  - [L19] file pair (`.tsx` + `.css`), module docstring, exported props
 *    interface, `data-slot="tool-block-notice"` on the root.
 *  - [L20] owns the `--tugx-toolnotice-*` token family; reuses the shared
 *    `--tugx-block-*` strip surface/text tones and the `--tug7-*` tone
 *    colors for the icon.
 *
 * @module components/tugways/blocks/block-notice
 */

import "./block-notice.css";

import React from "react";
import { AlertCircle, AlertTriangle, CircleCheck, Info } from "lucide-react";

import { cn } from "@/lib/utils";

/** Tone of a notice band — selects the leading icon and its color. */
export type BlockNoticeTone = "error" | "warning" | "info" | "success";

/**
 * The data a tool block hands to the chrome's `notice` slot. `text` is the
 * short explanation (clamped to `maxLines`); `icon` overrides the per-tone
 * default when a tool wants something more specific.
 */
export interface BlockNotice {
  tone: BlockNoticeTone;
  /** The explanation. Typically a string; rendered mono with whitespace kept. */
  text: React.ReactNode;
  /** Override the default per-tone icon. */
  icon?: React.ReactNode;
  /** Lines shown before the text clips with an ellipsis. @default 3 */
  maxLines?: number;
}

/** Default leading icon per tone — all already in the tugways lucide set. */
const DEFAULT_ICON: Readonly<Record<BlockNoticeTone, React.ReactNode>> = {
  error: <AlertCircle aria-hidden="true" />,
  warning: <AlertTriangle aria-hidden="true" />,
  info: <Info aria-hidden="true" />,
  success: <CircleCheck aria-hidden="true" />,
};

const DEFAULT_MAX_LINES = 3;

/**
 * Render a {@link BlockNotice}. The chrome mounts this between the header
 * and the body in both collapse states.
 */
export const BlockNoticeBand: React.FC<
  BlockNotice & { className?: string }
> = ({ tone, text, icon, maxLines = DEFAULT_MAX_LINES, className }) => {
  return (
    <div
      data-slot="tool-block-notice"
      data-tone={tone}
      className={cn("tool-block-notice", className)}
    >
      <span className="tool-block-notice-icon tug-line-box" aria-hidden="true">
        {icon ?? DEFAULT_ICON[tone]}
      </span>
      <span
        className="tool-block-notice-text"
        style={
          {
            "--tugx-toolnotice-clamp-lines": String(maxLines),
          } as React.CSSProperties
        }
      >
        {text}
      </span>
    </div>
  );
};
