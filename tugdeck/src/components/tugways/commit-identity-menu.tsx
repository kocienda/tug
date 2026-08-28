/**
 * useCommitIdentityMenu — the right-click menu a commit row offers, for the
 * whole row.
 *
 * A History row shows a hash, a subject, a stamp, and — expanded — a message
 * and a file roster, and until this hook the only press that meant anything
 * was the one that landed on the eight characters of the sha, which opened a
 * single-item Copy of those same eight characters. Every other pixel of the
 * row fell through to the app's "No Actions" fallback: the subject, the stamp,
 * the whole background. The facts a reader actually wants out of a commit —
 * the FULL hash, the message, the paths it touched — were reachable from no
 * menu at all.
 *
 * So: ONE menu, claimed by the row, listing every act the row can offer.
 *
 *   Show Detail / Hide Detail   the row's own fold, named rather than remembered
 *   ─────
 *   Copy Commit Hash            the complete 40 characters, which nothing shows
 *   Copy Short Hash             the 8 the row shows, the form a sentence quotes
 *   Copy Subject                the subject line alone
 *   Copy Message                subject + body, the message as written
 *   Copy Commit Record          the whole record — the row's Copy button's text
 *   ─────
 *   Copy Changed Files          the paths, one per line
 *
 * **The fold item says which way it goes.** `Show Detail` on a collapsed row,
 * `Hide Detail` on an expanded one — the same act the row's click performs,
 * spelled so the menu never asks the reader to recall the row's state.
 *
 * Copy Changed Files is DISABLED rather than absent when the commit changed
 * none (a merge, an empty commit): a menu whose height changes commit to
 * commit is a menu whose items move under the pointer between one right-click
 * and the next.
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
import { entityMenuItems } from "@/components/tugways/entity-menu-items";
import { annotationEntryFor } from "@/lib/annotator/registry";

/** What the menu is offered for, and what each item has to write. */
export interface CommitIdentityMenuOptions {
  /** The commit. Every copy item is derived from this record. */
  commit: CommitCopyFacts & {
    /** The paths the commit changed, when the surface knows them. */
    paths?: readonly string[];
  };
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
  /** Attach to the row's `ref` — the responder's element. */
  ref: (el: HTMLElement | null) => void;
  /** Attach to the row's `onContextMenu`. */
  onContextMenu: (e: React.MouseEvent) => void;
  /** Render alongside the row; holds the menu portal. */
  contextMenu: React.ReactNode;
}

/** Plain text to the clipboard, when there is any. */
function writeText(text: string): void {
  if (text.length > 0) void navigator.clipboard.writeText(text);
}

export function useCommitIdentityMenu({
  commit,
  expanded,
  onToggleDetail,
}: CommitIdentityMenuOptions): CommitIdentityMenuResult {
  const manager = useResponderChain();
  const [menuState, setMenuState] = React.useState<{ x: number; y: number } | null>(
    null,
  );
  const closeMenu = React.useCallback(() => setMenuState(null), []);

  const paths = commit.paths ?? [];
  const body = commit.body ?? "";
  // The message as it was written: the subject, then the body under a blank
  // line. A subject-only commit copies its one line and no trailing blank.
  const message = body.length > 0 ? `${commit.subject}\n\n${body}` : commit.subject;
  const folds = expanded !== undefined && onToggleDetail !== undefined;

  const responderId = React.useId();
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    // No bare COPY — the same rule the session row follows. ⌘C is the app's
    // Copy and what it copies is what the reader SELECTED; a row that
    // redefined it because the pointer rests on one would take a core chord
    // away from the surface underneath.
    actions: {
      [TUG_ACTIONS.TOGGLE_COMMIT_DETAIL]: () => onToggleDetail?.(),
      [TUG_ACTIONS.COPY_COMMIT_HASH]: () => writeText(commit.sha),
      [TUG_ACTIONS.COPY_COMMIT_SHORT_HASH]: () =>
        writeText(commit.sha.slice(0, SHA_DISPLAY_LEN)),
      [TUG_ACTIONS.COPY_COMMIT_SUBJECT]: () => writeText(commit.subject),
      [TUG_ACTIONS.COPY_COMMIT_MESSAGE]: () => writeText(message),
      // The row's Copy button's exact text, through the one formatter, so the
      // button and the menu item can never write two different records.
      [TUG_ACTIONS.COPY_COMMIT_RECORD]: () => writeText(commitCopyText(commit)),
      [TUG_ACTIONS.COPY_COMMIT_FILES]: () => writeText(paths.join("\n")),
    },
  });

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
    // that it holds the whole record, how many paths it touched, and which
    // way its fold would move.
    const entries =
      annotationEntryFor("commit-sha")?.menuEntries(
        { kind: "commit-sha", sha: commit.sha, root: "", paths: [...paths] },
        {
          kind: "commit-sha",
          ...(folds ? { expanded: expanded === true } : {}),
          hasRecord: true,
          pathCount: paths.length,
          // A History row's own diff is the shade beneath it; the row does
          // not open a second one from its menu.
          canOpenDiff: false,
        },
      ) ?? [];
    return entityMenuItems(entries);
  }, [commit.sha, folds, expanded, paths]);

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

  return { ref: responderRef, onContextMenu, contextMenu };
}
