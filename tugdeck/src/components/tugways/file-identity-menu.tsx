/**
 * useFileIdentityMenu — the right-click menu a document card's masthead
 * offers, for the whole tier.
 *
 * A card showing a file says the file's name, its path, and how it stands, and
 * a press anywhere on those three lines is a press about the file:
 *
 *   Show in Finder              the folder around it, with the file selected
 *   ─────
 *   Copy Path                   the path as characters
 *   Copy as Atom                the file itself, so a paste is a chip again
 *
 * So: ONE menu, claimed by the tier, and its list is the REGISTRY's — the same
 * items the same file answers with in transcript prose, in the same order, off
 * `annotationEntryFor("file-path")`. Before this the masthead had no menu of
 * its own at all: the title line is a `TugLabel`, which is intrinsically
 * copyable, so a press there offered a bare `Copy` of the filename, and the
 * path line and the tier's own ground fell through to the app's "No Actions" —
 * the surface showing a path most plainly was the one surface that could not
 * copy it. `useSessionIdentityMenu` closed the same hole on the Session card's
 * masthead ([D132]); this is that fix for a document.
 *
 * **Two of the registry's items are dropped, and both for [L31]'s reason** — an
 * item is offered only where it can be performed. `Open in Editor` names the
 * card the menu is mounted IN, the way the session menu withholds its go-to on
 * the session's own card. `Insert into Prompt` needs a composer, and a pane's
 * title bar has none. What is left is exactly the three acts above.
 *
 * `TugEditorContextMenu` rather than the Radix-backed `TugContextMenu`, for the
 * reason {@link useCommitIdentityMenu} uses it: its items write to the
 * clipboard inside the mousedown, and it moves no focus — a masthead is chrome,
 * and a copy from it must not take the key view away from the card's editor.
 *
 * Laws: [L11] controls emit actions, responders handle them — every item is a
 *       typed action dispatched to this hook's own responder;
 *       [L06] no appearance passes through React state.
 *
 * @module components/tugways/file-identity-menu
 */

import React from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { entityMenuItems } from "@/components/tugways/entity-menu-items";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import { atomPlainTextFor, atomSegmentFor } from "@/lib/annotator/atom-segment";
import { annotationEntryFor } from "@/lib/annotator/registry";
import { clipboardOriginFor } from "@/lib/clipboard-origin";
import { writeCopyClipboard } from "@/lib/copy-clipboard";
import { revealPathInFinder } from "@/lib/os-open";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import { useWholeEntityPress } from "@/lib/whole-entity-press";

/** What the menu is offered for. */
export interface FileIdentityMenuOptions {
  /**
   * The file, as an ABSOLUTE path. Every item is derived from it. A relative
   * path names nothing the Finder or a paste could resolve off this surface,
   * so the hook goes inert on one — see {@link enabled}.
   */
  path: string | null;
  /**
   * A selector for the run the press should light — the path line, so the
   * highlight names the same entity the items act on. Resolved inside the
   * host; omitted, the press paints nothing.
   */
  entitySelector?: string;
  /**
   * Off, the hook is inert — no responder is registered and `contextMenu` is
   * null, so the press falls through to whatever claimed it before. A knob
   * rather than a second component because hooks cannot be called
   * conditionally.
   * @default true
   */
  enabled?: boolean;
}

/** Wiring for the tier: attach both, render the menu beside it. */
export interface FileIdentityMenuResult {
  /**
   * Attach to the tier's `ref` — the responder's element, and the host the
   * whole-entity press is bound to.
   */
  ref: (el: HTMLElement | null) => void;
  /**
   * Attach to the tier's `onContextMenuCapture`. CAPTURE, so the tier is asked
   * before anything inside it: the title is a `TugLabel` and a label is
   * intrinsically copyable, so on the bubble the press would be claimed by the
   * label and answered with a `Copy` of the title's characters rather than
   * with the file.
   */
  onContextMenu: (e: React.MouseEvent) => void;
  /** Render alongside the tier; holds the menu portal. Null when disabled. */
  contextMenu: React.ReactNode;
}

/** An absolute path is the only kind any item here can stand behind. */
function usable(path: string | null): path is string {
  return path !== null && path.startsWith("/");
}

export function useFileIdentityMenu({
  path,
  entitySelector,
  enabled = true,
}: FileIdentityMenuOptions): FileIdentityMenuResult {
  const manager = useResponderChain();
  const [menuState, setMenuState] = React.useState<{ x: number; y: number } | null>(
    null,
  );
  const closeMenu = React.useCallback(() => setMenuState(null), []);

  const live = enabled && usable(path);
  const filePath = live ? path : "";

  // The tier itself, kept so every copy can stamp the project it was read
  // against — the same provenance a transcript selection carries.
  const hostRef = React.useRef<HTMLElement | null>(null);

  const copyPath = React.useCallback((): void => {
    if (filePath === "") return;
    writeCopyClipboard(filePath, null, clipboardOriginFor(hostRef.current), null);
  }, [filePath]);

  // The file as an OBJECT: the one-atom substrate, written exactly as the
  // annotation menu writes it, off the one {@link atomSegmentFor} rule. One
  // rule, two menus, so a file copied from a card's masthead and the same file
  // copied from a sentence are the same bytes.
  const copyAtom = React.useCallback((): void => {
    if (filePath === "") return;
    const payload = { kind: "file-path" as const, path: filePath };
    const segment = atomSegmentFor(payload);
    if (segment === null) return;
    writeCopyClipboard(
      atomPlainTextFor(payload, segment),
      null,
      clipboardOriginFor(hostRef.current),
      { version: 1, text: TUG_ATOM_CHAR, atoms: [{ position: 0, segment }] },
    );
  }, [filePath]);

  const reveal = React.useCallback((): void => {
    if (filePath === "") return;
    revealPathInFinder(filePath);
  }, [filePath]);

  const responderId = React.useId();
  // No bare COPY — the same rule the commit row and the session row follow.
  // ⌘C is the app's Copy and what it copies is what the reader SELECTED; a
  // tier that redefined it because the pointer rests on one would take a core
  // chord away from the surface underneath.
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.REVEAL_IN_FINDER]: reveal,
      [TUG_ACTIONS.COPY_ANNOTATION_VALUE]: copyPath,
      [TUG_ACTIONS.COPY_ANNOTATION_ATOM]: copyAtom,
    },
  });

  // The press that opens this menu selects the entity whole and paints it —
  // the one rule every menu about an entity is under
  // (`lib/whole-entity-press`). The entity is the path run: the tier claims
  // all three lines, and a highlight over the title would name the filename
  // where the menu names the file.
  const { attach: attachPress } = useWholeEntityPress((event) =>
    live && manager !== null && entitySelector !== undefined &&
    event.currentTarget instanceof HTMLElement
      ? event.currentTarget.querySelector<HTMLElement>(entitySelector)
      : null,
  );

  const ref = React.useCallback(
    (el: HTMLElement | null): void => {
      // Inert while disabled means registering nothing at all — the same shape
      // `useSessionIdentityMenu` takes, so a tier with no usable path leaves
      // the press to whatever claimed it before.
      hostRef.current = live ? el : null;
      responderRef(live ? el : null);
      attachPress(live ? el : null);
    },
    [responderRef, attachPress, live],
  );

  const onContextMenu = React.useCallback(
    (e: React.MouseEvent): void => {
      if (!live || manager === null) return;
      e.preventDefault();
      // Claimed, not merely handled — the same rule `useCopyableText` follows.
      // The title inside the tier is a copyable in its own right and is on this
      // tier's path, so a press that only suppressed the native menu would open
      // a stack of menus over one point.
      e.stopPropagation();
      setMenuState({ x: e.clientX, y: e.clientY });
    },
    [live, manager],
  );

  const items = React.useMemo<TugEditorContextMenuEntry[]>(() => {
    if (filePath === "") return [];
    // The list and its order are the registry's, for every surface a file
    // appears on. `{ kind: "none" }` is what a surface that knows the entity
    // and nothing else about it passes, which is this one.
    const entries =
      annotationEntryFor("file-path")?.menuEntries(
        { kind: "file-path", path: filePath },
        { kind: "none" },
      ) ?? [];
    return entityMenuItems(
      entries,
      (e) =>
        e.action === TUG_ACTIONS.OPEN_FILE ||
        e.action === TUG_ACTIONS.INSERT_INTO_PROMPT,
    );
  }, [filePath]);

  // Inside this hook's own ResponderScope, so the menu's targeted dispatch
  // lands on the responder above rather than on the pane around the tier.
  const contextMenu =
    live && manager !== null ? (
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
