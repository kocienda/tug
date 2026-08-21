/**
 * `CommitShaText` — a placed commit, wearing the read-only atom skin.
 *
 * One atom shared by every surface that names a commit: the History shade's
 * rows and the `/commit` receipt's header. A sha in a receipt header or a
 * History row arrived in a *field* of a commit record — somebody placed it,
 * nobody wrote it in a sentence — so it is an atom, and it takes the same
 * read-only skin every other placed value takes ({@link TugAtomRef}). A sha
 * written in prose stays a mention and is the annotator's business, not this
 * component's. See `tuglaws/entity-presentation.md`.
 *
 * **The label carries the word.** `commit:227a8eb9`, not `227a8eb9`: eight
 * bare hex characters name nothing a reader can act on, and a small glyph was
 * never going to rescue them. An atom stands with no sentence around it, so
 * the work a sentence would have done moves into the label. That is also the
 * spelling right-click → Copy has always written, so what the eye reads and
 * what the clipboard gets are now one string rather than two.
 *
 * This component survives the skin rather than being replaced by it, because
 * what it owns is not appearance: it owns every pointer gesture on the sha.
 * A commit atom is a copy target, not a link, and the gestures stop here so a
 * right-click in the History shade cannot fold the row out from under its own
 * menu. It therefore renders the skin **presentationally** — no annotation
 * dataset, no delegated click.
 *
 * The complete 40-char hash comes from the row's Copy button, which writes
 * the whole commit record.
 *
 * @module components/tugways/commit-sha-text
 */

import "./commit-sha-text.css";

import React, { useRef } from "react";

import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { useCopyableText } from "@/components/tugways/use-copyable-text";

/** Short-sha display length — enough to uniquely name a commit at a glance. */
export const SHA_DISPLAY_LEN = 8;

export function CommitShaText({
  sha,
  content,
  menu = true,
  className,
}: {
  /** The full commit sha; displayed and copied truncated to the short form. */
  sha: string;
  /**
   * Whether the sha carries its own single-item Copy menu. Off where a HOST
   * claims the right-click for the whole commit — a History row, whose menu
   * offers the full hash, the message, and the roster — so the pointer does
   * not get the poorer of two menus for landing on eight characters rather
   * than beside them. The gesture then bubbles to that host; every other
   * pointer gesture still stops here.
   * @default true
   */
  menu?: boolean;
  /**
   * The short sha rendered with decoration — filter-match `<mark>`s, say.
   * MUST read as the same characters the plain form shows; it replaces how the
   * sha is painted, never what it says. It decorates the sha characters
   * *within* the label, so a filter match highlights the hash and leaves the
   * word alone. Omitted ⇒ the plain short text.
   */
  content?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const ref = useRef<HTMLElement | null>(null);
  const { composedRef, handleContextMenu, contextMenu } = useCopyableText({
    ref,
    getText: () => `commit:${sha.slice(0, SHA_DISPLAY_LEN)}`,
    copyMenu: true,
    disabled: !menu,
  });
  return (
    <>
      <span
        ref={composedRef}
        className={
          className !== undefined ? `commit-sha-text ${className}` : "commit-sha-text"
        }
        onContextMenu={(event) => {
          // Only claimed when this atom is the one answering the press. Under
          // a host that claims the whole commit, the gesture rides on up.
          if (!menu) return;
          event.stopPropagation();
          handleContextMenu(event);
        }}
        // The sha is a copy target, not a toggle. Every pointer gesture on it
        // ends here rather than reaching a host that treats a click on the row
        // as activation — otherwise right-clicking a hash in the History shade
        // folds the row out from under its own menu.
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <TugAtomRef
          entity={{ kind: "commit", sha }}
          // The default label is already `commit:<8>`; an override is needed
          // only to let a decorated sha through, and it keeps the word.
          label={
            content === undefined ? undefined : <>commit:{content}</>
          }
        />
      </span>
      {/* The copy menu's own gestures stop here. A React portal still bubbles
          through the REACT tree, so without this a click on the menu's Copy
          item would reach whatever wraps the sha — in the History shade, the
          row's expand toggle — and fold the row on a right-click. `display:
          contents` keeps the wrapper out of the host's layout. */}
      <span
        className="commit-sha-text-menu"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        {contextMenu}
      </span>
    </>
  );
}
