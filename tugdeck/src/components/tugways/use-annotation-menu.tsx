/**
 * useAnnotationMenu — the registry's right-click, on any surface.
 *
 * An annotation's menu is a fact about the *entity*, not about the surface
 * showing it: a file path offers Open in Editor / Show in Finder / Copy Path /
 * Insert into Prompt whether it was found in transcript prose, placed as an
 * atom in the composer, or cited in an Overview post. `lib/annotator/registry`
 * has stated that since it was written. This hook is what makes it true
 * everywhere, by owning the whole per-kind menu path in one place:
 *
 *  - **sampling** — which annotation the press landed on, held for the
 *    handlers that run when an item is picked;
 *  - **the three predicates** `useTextSurfaceContextMenu` asks a consumer for
 *    (`extraEntries` / `hideStandardItems` / `suppressSelectionChange`), each
 *    answered from the registry entry for the sampled kind;
 *  - **the handlers** those items dispatch to, which a consumer folds into its
 *    own responder's action map.
 *
 * The split between this hook and its consumer is the split between the entity
 * and the surface. Everything here acts on the *sampled annotation* and would
 * read identically on any surface. Everything a consumer keeps — the transcript
 * cell's selection Copy, its Select All, the editor's clipboard extension —
 * acts on the *surface's own selection*, which is exactly the part that cannot
 * be shared.
 *
 * **Why the payload and not the DOM selection.** Every handler reads the
 * sampled payload rather than `window.getSelection()`. WebKit smart-selects the
 * nearest word inside `sendContextMenuEvent`, before any handler runs, so a
 * Copy that read the selection would copy whatever sub-word the browser
 * happened to pick out of a path. Sampling is also why the ref is menu-only: no
 * keyboard path reads it, and every menu open rewrites it.
 *
 * **Open in Editor is deliberately not a handler here.** `open-file` is a
 * chain-routed command the deck implements, and a handler on the surface would
 * intercept every dispatch that reaches it — a click on a file reference among
 * them — to answer one it can only service after a right-click. The registry's
 * item carries the target as its own value instead, so the dispatch walks past
 * the surface to the deck.
 *
 * **Laws:** [L07] — every handler reads the sampled annotation and the origin
 * element from refs at dispatch time, never from a render-time closure. [L11] —
 * the items are typed `TugAction`s dispatched to the surface's responder, and
 * the handlers returned here are that responder's, not a callback path around
 * it. [L31] — a handler whose payload carries nothing to act on returns without
 * writing, and the item that would have called it is never offered.
 *
 * @module components/tugways/use-annotation-menu
 */

import React, { useCallback, useMemo, useRef } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import type { ActionHandlerResult } from "@/components/tugways/responder-chain";
import type { TugEditorContextMenuEntry } from "@/components/tugways/tug-editor-context-menu";
import { entityMenuItems } from "@/components/tugways/entity-menu-items";
import { DeckManagerContext } from "@/deck-manager-context";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import { annotationFromEvent } from "@/lib/annotator/annotation-element";
import { annotationEntryFor } from "@/lib/annotator/registry";
import {
  annotationValue,
  type AnnotationPayload,
} from "@/lib/annotator/payloads";
import { clipboardOriginFor } from "@/lib/clipboard-origin";
import { escapeHtml, writeCopyClipboard } from "@/lib/copy-clipboard";
import { openAttachmentPreview } from "@/lib/attachment-preview-open";
import { revealDirectoryInFinder, revealPathInFinder } from "@/lib/os-open";
import { dispatchCommand } from "@/command-dispatch";
import { formatAtomLabel, type AtomSegment } from "@/lib/tug-atom-img";
import type { CodeSessionStore } from "@/lib/code-session-store";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UseAnnotationMenuOptions {
  /**
   * The surface element a copy reads its clipboard provenance from — the
   * transcript body, the editor host, the Overview's scroller. Walked with
   * `clipboardOriginFor`, so any node inside the surface answers; `null`
   * simply yields a copy with no provenance, which is the pre-provenance
   * behavior rather than a failure.
   */
  originRef?: React.RefObject<HTMLElement | null>;
  /**
   * The prompt an Insert into Prompt seeds. Omitted by a surface with no live
   * session — the Overview, a fixture — and the item is then not offered at
   * all, rather than offered and dead.
   */
  codeSessionStore?: CodeSessionStore;
}

export interface UseAnnotationMenuResult {
  /**
   * Fold into the surface's own `useResponder` action map. Keys are the
   * annotation actions and nothing else, so a surface's own COPY / SELECT_ALL
   * / PASTE handlers sit beside these without either side knowing about the
   * other.
   */
  actions: Record<string, () => ActionHandlerResult>;
  /** Pass to `useTextSurfaceContextMenu`. Samples the press and builds items. */
  extraEntries: (event: MouseEvent) => TugEditorContextMenuEntry[];
  /** Pass to `useTextSurfaceContextMenu`. */
  hideStandardItems: (event: MouseEvent) => boolean;
  /** Pass to `useTextSurfaceContextMenu`. */
  suppressSelectionChange: (event: MouseEvent) => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The canonical text of the annotation a menu handler was invoked for, or
 * `null` when the menu was not opened over one (or the payload carries
 * nothing to act on).
 */
function sampledAnnotationValue(payload: AnnotationPayload | null): string | null {
  if (payload === null) return null;
  const value = annotationValue(payload);
  return value === "" ? null : value;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useAnnotationMenu({
  originRef,
  codeSessionStore,
}: UseAnnotationMenuOptions = {}): UseAnnotationMenuResult {
  // Insert into Prompt brings the annotation's own card forward before it
  // types into it. Read from context rather than props: every surface that
  // shows annotations already renders inside a card host, and threading the
  // deck down through a cell tree would be ceremony. Read optionally, because
  // a gallery fixture mounts these surfaces outside a deck and an entity menu
  // is not the thing that should refuse to exist there.
  const deck = React.useContext(DeckManagerContext);
  const cardId = useCardId();

  // The annotation the current right-click landed on, sampled by
  // `extraEntries` at menu-open time and read by the handlers when the user
  // picks an item. `null` when the right-click missed every annotation.
  const contextAnnotationRef = useRef<AnnotationPayload | null>(null);

  /** The clipboard provenance in scope for this surface, at write time. */
  const origin = useCallback(
    (): string | null => clipboardOriginFor(originRef?.current ?? null),
    [originRef],
  );

  // Copy the right-clicked command, code formatting preserved: the
  // `text/plain` flavor is the command wrapped in Markdown backticks and the
  // `text/html` flavor is a `<code>` element — mirroring how a copied
  // transcript selection carries markdown + rendered HTML ([P05]). Synchronous
  // (no continuation) so the clipboard write stays inside the activation
  // gesture.
  const handleCopyCommand = useCallback((): ActionHandlerResult => {
    const cmd = sampledAnnotationValue(contextAnnotationRef.current);
    if (cmd === null) return;
    writeCopyClipboard(
      "`" + cmd + "`",
      `<code>${escapeHtml(cmd)}</code>`,
      origin(),
      null,
    );
  }, [origin]);

  // Copy the right-clicked command as bare text — no backticks, no
  // `text/html` flavor — the terminal-paste-friendly variant.
  const handleCopyCommandPlain = useCallback((): ActionHandlerResult => {
    const cmd = sampledAnnotationValue(contextAnnotationRef.current);
    if (cmd === null) return;
    writeCopyClipboard(cmd, null, origin(), null);
  }, [origin]);

  // Copy the right-clicked annotation's canonical value as bare text — the
  // URL, the address, the path. The kinds that route here have no code
  // formatting to preserve, so there is no `text/html` flavor.
  const handleCopyAnnotationValue = useCallback((): ActionHandlerResult => {
    const value = sampledAnnotationValue(contextAnnotationRef.current);
    if (value === null) return;
    writeCopyClipboard(value, null, origin(), null);
  }, [origin]);

  // Send the right-clicked annotation back into the conversation. Brings the
  // card forward first, so the prompt it lands in is the one the user is
  // looking at. Returns a continuation so the insert happens after the menu's
  // activation blink, like Select All — the prompt takes the caret, and doing
  // that mid-blink fights the menu's own teardown.
  //
  // A file goes in as an object: the same chip an `@` mention mints, carrying
  // the canonical path as its value, so the prompt treats it as one thing to
  // move, delete, or send rather than as a run of path characters. A cited
  // line is deliberately dropped — an atom names a file, and `path:line` is
  // not one. Every other kind goes in as its text.
  const handleInsertIntoPrompt = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null || codeSessionStore === undefined) return;
    const raise = (): void => {
      if (cardId !== null && deck !== null) deck.activateCard(cardId);
    };
    if (payload.kind === "file-path") {
      const segment: AtomSegment = {
        kind: "atom",
        type: "file",
        // The chip reads as a filename and carries the whole path underneath —
        // the same split every other file chip in the app makes, and the
        // reason one fits on a prompt line at all.
        label: formatAtomLabel(payload.path, "filename"),
        value: payload.path,
      };
      return () => {
        raise();
        codeSessionStore.insertAtomDraft(segment);
      };
    }
    const value = sampledAnnotationValue(payload);
    if (value === null) return;
    return () => {
      raise();
      codeSessionStore.insertJot(value, null);
    };
  }, [cardId, codeSessionStore, deck]);

  // Show in Finder for the right-clicked file annotation. Revealing a file
  // opens the folder around it; a directory is already that folder, so the two
  // take different routes to the same gesture.
  const handleRevealAnnotatedFile = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload?.kind === "file-path") revealPathInFinder(payload.path);
    else if (payload?.kind === "directory") revealDirectoryInFinder(payload.path);
  }, []);

  const handleOpenAnnotatedDiff = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null || payload.kind !== "commit-sha") return;
    dispatchCommand(TUG_ACTIONS.OPEN_DIFF, {
      descriptor: {
        kind: "commit",
        root: payload.root,
        sha: payload.sha,
        paths: payload.paths,
      },
    });
  }, []);

  const handleOpenImagePreview = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null || payload.kind !== "image") return;
    openAttachmentPreview(payload.atomId);
  }, []);

  const actions = useMemo(
    () => ({
      [TUG_ACTIONS.COPY_COMMAND]: handleCopyCommand,
      [TUG_ACTIONS.COPY_COMMAND_AS_PLAIN_TEXT]: handleCopyCommandPlain,
      [TUG_ACTIONS.COPY_ANNOTATION_VALUE]: handleCopyAnnotationValue,
      // A session's canonical value IS its id, so the item the registry
      // names and the generic value-copy are one act under two names. Named
      // separately because the row surfaces implement the same item from an
      // identity record, and one action reaching both is what makes the two
      // menus the same menu.
      [TUG_ACTIONS.COPY_SESSION_ID]: handleCopyAnnotationValue,
      [TUG_ACTIONS.INSERT_INTO_PROMPT]: handleInsertIntoPrompt,
      [TUG_ACTIONS.REVEAL_IN_FINDER]: handleRevealAnnotatedFile,
      [TUG_ACTIONS.OPEN_IMAGE_PREVIEW]: handleOpenImagePreview,
      [TUG_ACTIONS.OPEN_DIFF]: handleOpenAnnotatedDiff,
    }),
    [
      handleCopyCommand,
      handleCopyCommandPlain,
      handleCopyAnnotationValue,
      handleInsertIntoPrompt,
      handleRevealAnnotatedFile,
      handleOpenImagePreview,
      handleOpenAnnotatedDiff,
    ],
  );

  // A right-click on an annotation samples its payload and offers the items
  // its kind registers. Whether those items replace the standard text-menu
  // block or sit below it is the kind's call (`suppressStandardItems`): a
  // command replaces it, because a selection-scoped Copy beside
  // Copy-the-command would copy whatever sub-word the browser smart-selected;
  // a kind whose items don't collide appends, so a right-click inside a
  // selection keeps Copy / Select All.
  const extraEntries = useCallback(
    (event: MouseEvent): TugEditorContextMenuEntry[] => {
      const hit = annotationFromEvent(event);
      contextAnnotationRef.current = hit?.payload ?? null;
      if (hit === null) return [];
      const entries =
        annotationEntryFor(hit.payload.kind)?.menuEntries(hit.payload, {
          kind: "none",
        }) ?? [];
      // Annotated ink and a placed atom know the entity and nothing else
      // about it, which is what `{ kind: "none" }` says. A surface with no
      // live session can't seed a prompt, so it doesn't offer to.
      return entityMenuItems(entries, (e) =>
        codeSessionStore === undefined &&
        e.action === TUG_ACTIONS.INSERT_INTO_PROMPT,
      );
    },
    [codeSessionStore],
  );

  const hideStandardItems = useCallback((event: MouseEvent): boolean => {
    const hit = annotationFromEvent(event);
    if (hit === null) return false;
    return annotationEntryFor(hit.payload.kind)?.suppressStandardItems ?? false;
  }, []);

  // A secondary click on a whole-entity annotation (a command) keeps its hands
  // off the selection: the browser would smart-select a sub-word, and every
  // item the menu is about to show acts on the entire command.
  const suppressSelectionChange = useCallback((event: MouseEvent): boolean => {
    const hit = annotationFromEvent(event);
    if (hit === null) return false;
    return annotationEntryFor(hit.payload.kind)?.wholeEntitySelection ?? false;
  }, []);

  return { actions, extraEntries, hideStandardItems, suppressSelectionChange };
}
