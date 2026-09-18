/**
 * `CommitShaText` — a placed commit, wearing the read-only atom skin.
 *
 * One atom shared by every surface that names a commit: the History shade's
 * rows and the `/commit` receipt's header. A sha in a receipt header or a
 * History row arrived in a *field* of a commit record — somebody placed it,
 * nobody wrote it in a sentence — so it is an atom, and it takes the same
 * placed skin every commit takes ({@link TugCommitAtom}). A sha written in
 * prose stays a mention and is the annotator's business, not this component's.
 * See `tuglaws/entity-presentation.md`.
 *
 * **The skin is the commit's own pill now, not the generic read-only ref.** A
 * commit used to wear the same glyph-label-underline mark a `file_path` in a
 * tool header wears, so a History row's sha and a file reference two inches
 * away were the same drawing of two different kinds of thing. The pill says
 * what a commit is — a point in history, wearing the enclosure the session and
 * the arc beside it wear — and it says it identically on every surface this
 * component feeds, which is what makes it worth having one component here.
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
 * The gestures stop here so a right-click in the History shade cannot fold the
 * row out from under its own menu, and so a plain click on the pill is not
 * also a click on whatever the pill is sitting in.
 *
 * **A placed pill answers a plain click when its host gives it an act.** The
 * user's rule is that a click on a commit atom shows the commit's card, and a
 * placed pill is still the atom — it is only the annotator's delegated click
 * that does not reach here. So `onActivate` is the host's hook: given one, the
 * pill takes the skin's pointer cursor and the click calls it INSTEAD of
 * reaching the host's own surface, which is how a History row's remaining
 * ground still folds while the eight characters in it do something else.
 * Without one the pill stays what it was — a copy target with no navigation to
 * promise, rendered presentationally with no annotation dataset and no
 * delegated click.
 *
 * The complete 40-char hash comes from the row's Copy button, which writes
 * the whole commit record.
 *
 * @module components/tugways/commit-sha-text
 */

import "./commit-sha-text.css";

import React, { useRef } from "react";

import { TugCommitAtom } from "@/components/tugways/tug-commit-atom";
import { useCopyableText } from "@/components/tugways/use-copyable-text";

/** Short-sha display length — enough to uniquely name a commit at a glance. */
export const SHA_DISPLAY_LEN = 8;

export function CommitShaText({
  sha,
  content,
  menu = true,
  onActivate,
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
   * What a plain click on the pill does. Present → the pill takes the pointer
   * cursor and the click calls this and goes no further; absent → the click is
   * swallowed as before, so a host whose ground does something else is not
   * triggered by a press on the hash.
   */
  onActivate?: () => void;
  /**
   * The short sha rendered with decoration — filter-match `<mark>`s, say.
   * MUST read as the same characters the plain form shows; it replaces how the
   * sha is painted, never what it says. It decorates the sha characters
   * *within* the label, so a filter match highlights the hash and leaves the
   * word and the enclosure alone — which the pill now guarantees rather than
   * merely intends, because it takes the hash run as `labelContent` and
   * supplies the word itself. Omitted ⇒ the plain short text.
   */
  content?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const ref = useRef<HTMLElement | null>(null);
  const { composedRef, handleContextMenu, contextMenu } = useCopyableText({
    ref,
    getText: () => `commit:${sha.slice(0, SHA_DISPLAY_LEN)}`,
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
        onClick={(event) => {
          // Stopped either way: the pill's click is never also the host's.
          // What `onActivate` decides is whether it is anything at all.
          event.stopPropagation();
          onActivate?.();
        }}
      >
        {/* The word is the pill's, so a decorated sha no longer has to
            reconstruct it: `content` is the HASH's characters and nothing
            else, which is what a filter matched and all it may paint. */}
        <TugCommitAtom
          sha={sha}
          labelContent={content}
          interactive={onActivate !== undefined}
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
