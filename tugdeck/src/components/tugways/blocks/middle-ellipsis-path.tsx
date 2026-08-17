/**
 * `MiddleEllipsisPath` — shared header path renderer for tool blocks.
 *
 * A file path rendered with a *middle* ellipsis: the head segment
 * shrinks and ellipsizes from its trailing edge while a fixed-length
 * tail (the filename plus a little of its directory) stays pinned, so
 * a long path collapses as `/Users/koci…RTY_NOTICES.md` rather than
 * end-truncating away the filename or growing a scrollbar.
 *
 * The truncation itself is `TugPath`'s — the same mechanism the document
 * masthead's path line wears, authored once, splitting at the last separator
 * so the whole filename is pinned. What this adds is the tool block's own:
 * the `<code>` slot and mono face, transcript Find, and the tooltip.
 *
 * A hover tooltip surfaces the full path. By default (`tip="path"`) it opens
 * only when the path is actually clipped: `TugTooltip`'s `suppressOpen` gate
 * runs `pathTooltipSuppressed` on each hover, which compares the head's
 * `scrollWidth` against its `clientWidth`. A row that NAMES a file rather
 * than heading one passes `tip="file"` and gets the house file hover instead
 * — the same `fileTip` bubble the commit receipt's roster wears.
 *
 * Per [#bk-conformance] item 8 this is THE path-truncation pattern for
 * tool-block headers. `ReadToolBlock` and `EditToolBlock` both
 * compose it; a new tool block with a `Tool · {path}` header should too,
 * rather than composing `TugPath` directly and re-deriving the tail
 * length, the slot, and the tooltip around it.
 *
 * Laws:
 *  - [L06] no React state — the truncation is pure CSS; the tooltip's
 *    open/closed state lives in `TugTooltip`'s own DOM-driven
 *    machinery, not here.
 *  - [L19] file pair (`.tsx` + `.css`). The component carries no
 *    `data-slot` of its own — it is a header fragment, and the
 *    `<code data-slot="tool-block-path">` it renders is the slot.
 *  - [L20] consumes only `--tugx-block-*` (inherited from the
 *    composing chrome) and introduces no tokens.
 *
 * @module components/tugways/blocks/middle-ellipsis-path
 */

import "./middle-ellipsis-path.css";

import React from "react";

import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { TugPath, pathHeadClipped } from "@/components/tugways/tug-path";
import { fileTip } from "@/components/tugways/entity-tips";

/*
 * The tail is the FILENAME — `TugPath`'s default split, at the last
 * separator. A fixed character count stood here once, to keep a column of
 * paths ragged-free, and it bought that evenness by cutting filenames
 * mid-word: a 20-char tail turns `…/tug-text-editor-selection-suppress.test.ts`
 * into `ion-suppress.test.ts` and then clips THAT, so the row truncates twice
 * and names nothing. A ragged right edge is a cosmetic cost; an unreadable
 * filename defeats the list.
 */

/**
 * Tooltip-suppression predicate for the path: suppress (return `true`)
 * unless the head segment is actually clipped, so a path showing whole
 * never explains itself. Measured fresh on each hover by `TugTooltip`.
 */
export function pathTooltipSuppressed(trigger: Element): boolean {
  return !pathHeadClipped(trigger);
}

export interface MiddleEllipsisPathProps {
  /** The file path to render. */
  path: string;
  /**
   * The whole path, when what is rendered is a shortened form of it (a
   * workspace-relative row). The tooltip shows this, so the full location is
   * one hover away even where the column shows only the part that varies.
   *
   * @default path
   */
  fullPath?: string;
  /**
   * Stamps `data-tugx-findable` on the path element, opting it into
   * transcript Find. Set by the tool-call header that composes it (the
   * fetched URL), whose text `tool-header-projection` projects. Off by
   * default: the body kinds that also render paths (`path-list-block`,
   * `commit-block`, `search-result-block`) are not projected, and an
   * unprojected unit would desync the match count from the paint.
   *
   * The truncation is pure CSS — both halves of the path are real text —
   * so the unit's text is the whole path however it is clipped.
   */
  findable?: boolean;
  /**
   * Which hover the path answers with.
   *
   * `"path"` — the truncation's own explanation: the raw string, and only
   * when the path is actually clipped. Right for a tool-block header, where
   * the hover exists to un-elide a header line.
   *
   * `"file"` — the house file hover, the same `fileTip` bubble a path in
   * prose, a commit roster, or a Overview ref gets. Always opens, because it
   * states the whole location of a file the row NAMES, which is a fact the
   * row withholds whether or not its glyphs happen to fit.
   *
   * @default "path"
   */
  tip?: "path" | "file";
}

/**
 * Render a file path with a middle ellipsis (see module docstring).
 */
export function MiddleEllipsisPath({
  path,
  fullPath,
  findable = false,
  tip = "path",
}: MiddleEllipsisPathProps): React.ReactElement {
  const whole = fullPath ?? path;
  const houseTip = tip === "file";
  return (
    <TugTooltip
      content={houseTip ? fileTip({ path: whole }) : whole}
      variant={houseTip ? "entity" : "label"}
      side={houseTip ? "top" : "bottom"}
      align={houseTip ? "start" : "center"}
      suppressOpen={houseTip ? undefined : pathTooltipSuppressed}
    >
      {/* The `<code>` is the slot and the mono face; the truncation is
          `TugPath`'s, so the head/tail split is authored once for every
          surface that shows a path. */}
      <code
        data-slot="tool-block-path"
        className="tool-block-path"
        data-tugx-findable={findable ? "" : undefined}
      >
        <TugPath path={path} />
      </code>
    </TugTooltip>
  );
}
