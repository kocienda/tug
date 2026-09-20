/**
 * useCommitIdentityMenu — the right-click menu a commit row offers, for the
 * whole row.
 *
 * A History row shows a hash, a subject, a stamp, and — expanded — a message
 * and a file roster, and the press that lands anywhere on it opens this menu:
 * the four forms a commit is worth carrying away as, in the order a reader
 * reaches for them.
 *
 * So: ONE menu, claimed by the row, listing every act the row can offer.
 *
 *   Show Detail / Hide Detail   the row's own fold, named rather than remembered
 *   ─────
 *   Open Commit                 the commit's own card, wherever there is a root
 *   Open Diff                   where the surface has no diff of its own
 *   ─────
 *   Copy Short Hash             `commit:<8>`, the form the app writes commits as
 *   Copy Full Hash              the complete 40 characters, bare, for a git verb
 *   Copy Commit Header          `commit:<8>` and the subject, one line
 *   Copy Commit Record          the whole record — the row's Copy button's text
 *   Copy as Atom                the commit itself, so a paste is a pill again
 *
 * **The fold item says which way it goes.** `Show Detail` on a collapsed row,
 * `Hide Detail` on an expanded one — the same act the row's click performs,
 * spelled so the menu never asks the reader to recall the row's state.
 *
 * **Open Commit follows the root.** A commit's own card is its primary act,
 * so every surface that knows which repository the commit lives in offers it;
 * a receipt header, which knows a sha and nothing else, cannot resolve one and
 * so does not. The Commit card's own masthead turns it off explicitly, because
 * that card IS the commit's card and a menu item raising the card you are
 * already looking at is a row that does nothing.
 *
 * **Open Diff is the surface's call, and it defaults off.** A History row's
 * own diff is the shade beneath it and every file in its roster carries a
 * pop-out, so the row offers no second door. The Commit card's masthead is
 * the case that turns it on: the whole-commit diff is nowhere else on that
 * card, and the tier's right-click is how it stays one gesture away without
 * the body growing a button. A surface that says yes owes a `root`, because
 * the descriptor the diff opens on is scoped to a repository.
 *
 * **Every item writes through `writeCopyClipboard`.** The four text forms used
 * to call `navigator.clipboard.writeText` directly, which carried no atom
 * sidecar, stamped no project root, and — outside the native bridge — asked
 * Safari for permission. `Copy as Atom` is the item that made the difference
 * visible: it writes the same one-atom sidecar the annotation menu's item
 * writes, off the same {@link atomSegmentFor} rule, so a commit copied from a
 * receipt header and a commit copied from a prose mention are the same bytes.
 *
 * `TugEditorContextMenu` rather than the Radix-backed `TugContextMenu`, for the
 * reason {@link useSessionIdentityMenu} uses it: its items write to the
 * clipboard inside the mousedown, and it moves no focus — a History row is
 * chrome, and a copy from it must not take the key view away from the shade's
 * Done button.
 *
 * Laws: [L11] controls emit actions, responders handle them — every item is a
 *       typed action dispatched to this hook's own responder;
 *       [L06] no appearance passes through React state.
 *
 * @module components/tugways/commit-identity-menu
 */

import React from "react";

import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import {
  commitCopyText,
  type CommitCopyFacts,
} from "@/components/tugways/commit-presentation";
import { SHA_DISPLAY_LEN } from "@/components/tugways/commit-sha-text";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import { entityMenuItems } from "@/components/tugways/entity-menu-items";
import { atomPlainTextFor, atomSegmentFor } from "@/lib/annotator/atom-segment";
import { annotationEntryFor } from "@/lib/annotator/registry";
import { clipboardOriginFor } from "@/lib/clipboard-origin";
import { writeCopyClipboard } from "@/lib/copy-clipboard";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import { useWholeEntityPress } from "@/lib/whole-entity-press";

/** What the menu is offered for, and what each item has to write. */
export interface CommitIdentityMenuOptions {
  /** The commit. Every copy item is derived from this record. */
  commit: CommitCopyFacts & {
    /** The paths the commit changed, when the surface knows them. */
    paths?: readonly string[];
  };
  /**
   * The repository the commit was read in — what the diff descriptor is
   * scoped by. Only {@link canOpenDiff} needs it; a surface that offers no
   * Open Diff may leave it out.
   */
  root?: string;
  /**
   * Offer Open Diff. @default false — a History row's diff is the shade
   * beneath it, which is the surface this hook was written for.
   */
  canOpenDiff?: boolean;
  /**
   * Offer Open Commit. @default true wherever a {@link root} was given, since
   * that is exactly the condition under which the card can resolve the sha.
   * The Commit card's masthead is the one surface that says no with a root in
   * hand.
   */
  canOpenCommit?: boolean;
  /**
   * Whether the row's detail is open — the fold item states the direction it
   * will move. Omit on a surface with no fold, and the item is absent.
   */
  expanded?: boolean;
  /** Perform the fold. Omit together with `expanded`. */
  onToggleDetail?: () => void;
}

/** Wiring for the row: attach both, render the menu beside it. */
export interface CommitIdentityMenuResult {
  /**
   * Attach to the row's `ref` — the responder's element, and the host the
   * whole-entity press is bound to.
   */
  ref: (el: HTMLElement | null) => void;
  /** Attach to the row's `onContextMenu`. */
  onContextMenu: (e: React.MouseEvent) => void;
  /** Render alongside the row; holds the menu portal. */
  contextMenu: React.ReactNode;
}

/**
 * The entity a press on the claim is about: the commit atom — from anywhere
 * on the claim. A History row claims the whole row, subject and roster and
 * stamp, and selecting a row on a right-click is wrong; the atom is the
 * commit's visible name and the commit is what every item acts on, so a press
 * on the subject lights the atom. The receipt and the join receipt claim the
 * atom's own wrapper, where the same lookup finds the same pill.
 */
function commitAtomIn(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".tug-commit-atom");
}

export function useCommitIdentityMenu({
  commit,
  root = "",
  canOpenDiff = false,
  canOpenCommit = root.length > 0,
  expanded,
  onToggleDetail,
}: CommitIdentityMenuOptions): CommitIdentityMenuResult {
  const manager = useResponderChain();
  // The card this row stands in — the host the menu was raised in, which a
  // commit's or a diff's card opens beside rather than beside whichever card
  // holds first responder.
  const hostCardId = useCardId();
  const [menuState, setMenuState] = React.useState<{ x: number; y: number } | null>(
    null,
  );
  const closeMenu = React.useCallback(() => setMenuState(null), []);

  const paths = commit.paths ?? [];
  // The reference the whole app writes a commit as, and the header line built
  // on it — the same `commit:<8>` the row's own atom shows.
  const shortRef = `commit:${commit.sha.slice(0, SHA_DISPLAY_LEN)}`;
  const folds = expanded !== undefined && onToggleDetail !== undefined;

  // The row itself, kept so every copy can stamp the project it was read
  // against, which is the same provenance a transcript selection carries.
  const hostRef = React.useRef<HTMLElement | null>(null);
  const copy = React.useCallback((text: string): void => {
    if (text.length === 0) return;
    writeCopyClipboard(text, null, clipboardOriginFor(hostRef.current), null);
  }, []);

  // The commit as an OBJECT: the one-atom substrate, written exactly as the
  // annotation menu writes it. One rule, two menus, so a pill pasted back is a
  // pill whether it was copied from a receipt or from a sentence.
  //
  // The paths ride a ref rather than a dependency: the array is rebuilt every
  // render, and the joined-string key it was reconstructed from could not
  // survive a path with a space in it.
  const pathsRef = React.useRef<readonly string[]>(paths);
  pathsRef.current = paths;
  const copyAtom = React.useCallback((): void => {
    const payload = {
      kind: "commit-sha" as const,
      sha: commit.sha,
      root,
      paths: [...pathsRef.current],
    };
    const segment = atomSegmentFor(payload);
    if (segment === null) return;
    writeCopyClipboard(
      atomPlainTextFor(payload, segment),
      null,
      clipboardOriginFor(hostRef.current),
      { version: 1, text: TUG_ATOM_CHAR, atoms: [{ position: 0, segment }] },
    );
  }, [commit.sha, root]);

  // The same dispatch the registry's own primary click makes, from the one
  // place that holds the descriptor's parts. `dispatchCommand` rather than a
  // direct call: opening a diff card is the app's act, and this hook is a
  // menu — the action it names is the same one every other Open Diff names.
  const openDiff = React.useCallback((): void => {
    dispatchCommand(TUG_ACTIONS.OPEN_DIFF, {
      descriptor: {
        kind: "commit",
        root,
        sha: commit.sha,
        paths: [...pathsRef.current],
      },
      ...(hostCardId !== null ? { originCardId: hostCardId } : {}),
    });
  }, [commit.sha, root, hostCardId]);

  // The commit's own card, seeded with the header this surface already holds
  // so its masthead paints before the round trip lands. A History row has the
  // whole record; the Commit card's fetch is still the authority.
  const openCommit = React.useCallback((): void => {
    dispatchCommand(TUG_ACTIONS.OPEN_COMMIT, {
      root,
      sha: commit.sha,
      hint: {
        subject: commit.subject,
        author: commit.author ?? "",
        dateIso: commit.dateIso ?? "",
      },
      ...(hostCardId !== null ? { originCardId: hostCardId } : {}),
    });
  }, [commit.sha, commit.subject, commit.author, commit.dateIso, root, hostCardId]);

  const responderId = React.useId();
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    // No bare COPY — the same rule the session row follows. ⌘C is the app's
    // Copy and what it copies is what the reader SELECTED; a row that
    // redefined it because the pointer rests on one would take a core chord
    // away from the surface underneath.
    actions: {
      [TUG_ACTIONS.TOGGLE_COMMIT_DETAIL]: () => onToggleDetail?.(),
      [TUG_ACTIONS.COPY_COMMIT_HASH]: () => copy(commit.sha),
      [TUG_ACTIONS.COPY_COMMIT_SHORT_HASH]: () => copy(shortRef),
      [TUG_ACTIONS.COPY_COMMIT_HEADER]: () =>
        copy(`${shortRef} ${commit.subject}`),
      // The row's Copy button's exact text, through the one formatter, so the
      // button and the menu item can never write two different records.
      [TUG_ACTIONS.COPY_COMMIT_RECORD]: () => copy(commitCopyText(commit)),
      [TUG_ACTIONS.COPY_ANNOTATION_ATOM]: copyAtom,
      // Registered only where the item is offered: an unclaimed action falls
      // through to the responder above, which is where a surface that does
      // not offer the row wants it to go.
      ...(canOpenDiff ? { [TUG_ACTIONS.OPEN_DIFF]: openDiff } : {}),
      ...(canOpenCommit ? { [TUG_ACTIONS.OPEN_COMMIT]: openCommit } : {}),
    },
  });

  // The press that opens this menu selects the commit atom whole and paints
  // it — the one rule every menu about an entity is under
  // (`lib/whole-entity-press`). Native listeners on the claim, because the
  // atom stops React propagation of every pointer gesture on itself. Named
  // only where the menu will actually open: with no responder chain there is
  // no menu, and a press that settled the selection under nothing would be
  // the rule's own inverse — a highlight with no menu about it.
  const { attach: attachPress } = useWholeEntityPress((event) =>
    manager !== null && event.currentTarget instanceof HTMLElement
      ? commitAtomIn(event.currentTarget)
      : null,
  );
  const ref = React.useCallback(
    (el: HTMLElement | null): void => {
      hostRef.current = el;
      responderRef(el);
      attachPress(el);
    },
    [responderRef, attachPress],
  );

  const onContextMenu = React.useCallback(
    (e: React.MouseEvent): void => {
      if (manager === null) return;
      e.preventDefault();
      // Claimed, not merely handled — the same rule `useCopyableText` follows.
      // The runs inside the row are copyables of their own and every one of
      // them is on this row's path, so a press that only suppressed the native
      // menu would open a stack of them over one point.
      e.stopPropagation();
      setMenuState({ x: e.clientX, y: e.clientY });
    },
    [manager],
  );

  const items = React.useMemo<TugEditorContextMenuEntry[]>(() => {
    // The list and its order are the registry's, for every surface a commit
    // appears on; this row's contribution is the facts a sha cannot carry —
    // that it holds the whole record, and which way its fold would move.
    const entries =
      annotationEntryFor("commit-sha")?.menuEntries(
        { kind: "commit-sha", sha: commit.sha, root, paths: [...paths] },
        {
          kind: "commit-sha",
          ...(folds ? { expanded: expanded === true } : {}),
          hasRecord: true,
          canOpenDiff,
          canOpenCommit,
        },
      ) ?? [];
    return entityMenuItems(entries);
  }, [commit.sha, root, canOpenDiff, canOpenCommit, folds, expanded, paths]);

  // Inside this hook's own ResponderScope, so the menu's targeted dispatch
  // lands on the responder above rather than on whatever surrounds the row.
  const contextMenu =
    manager !== null ? (
      <ResponderScope>
        <TugEditorContextMenu
          open={menuState !== null}
          x={menuState?.x ?? 0}
          y={menuState?.y ?? 0}
          items={items}
          onClose={closeMenu}
        />
      </ResponderScope>
    ) : null;

  return { ref, onContextMenu, contextMenu };
}
