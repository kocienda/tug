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
 *    (`extraEntries` / `hideStandardItems` / `wholeEntityTarget`), the first
 *    two answered from the registry entry for the sampled kind and the last
 *    from the sampled element itself;
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
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import { SHA_DISPLAY_LEN } from "@/components/tugways/commit-sha-text";
import type { ActionHandlerResult } from "@/components/tugways/responder-chain";
import type { TugEditorContextMenuEntry } from "@/components/tugways/tug-editor-context-menu";
import { entityMenuItems } from "@/components/tugways/entity-menu-items";
import { annotationFromEvent } from "@/lib/annotator/annotation-element";
import { scanPathReferences } from "@/lib/annotator/detect-path-reference";
import {
  annotationEntryFor,
  type AnnotationMenuFacts,
} from "@/lib/annotator/registry";
import { pathResolutionStore } from "@/lib/annotator/path-resolution";
import {
  annotationValue,
  type AnnotationPayload,
} from "@/lib/annotator/payloads";
import { clipboardOriginFor } from "@/lib/clipboard-origin";
import { escapeHtml, writeCopyClipboard } from "@/lib/copy-clipboard";
import { openAttachmentPreview } from "@/lib/attachment-preview-open";
import { revealDirectoryInFinder, revealPathInFinder } from "@/lib/os-open";
import { dispatchCommand } from "@/command-dispatch";
import { getRegistryHandler } from "@/action-dispatch";
import { atomPlainTextFor, atomSegmentFor } from "@/lib/annotator/atom-segment";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import type { PromptInsertTarget } from "@/lib/prompt-insert-target";

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
   * The composer an Insert into Prompt seeds — the Session card's, the
   * Overview's, whichever the surface is showing entities beside. Omitted by
   * a surface with no composer to send to (a fixture), and the item is then
   * not offered at all, rather than offered and dead.
   */
  insertTarget?: PromptInsertTarget;
  /**
   * The directory a relative path in this surface's prose is counted from —
   * the same one its annotation context resolves paths against. Read only to
   * answer whether a command's `@path` argument is still there, which is one
   * of the two reasons the run rows dim. Omitted by a surface with no cwd,
   * and a relative path is then simply not an answer anybody has, which is
   * not the same as a missing one.
   */
  cwd?: string | null;
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
  wholeEntityTarget: (event: MouseEvent) => HTMLElement | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The file a command's arguments name, bare, or `null` when they name none.
 *
 * A command line is not a sentence to parse: the one thing worth knowing
 * here is whether the run would be aimed at a file that is gone, and the
 * argument that carries a file looks like one. What that looks like is the
 * annotator's own path grammar rather than a rule invented here: it peels
 * surrounding punctuation and a trailing `:14` citation, and it already
 * knows that a `scheme://` is a URL and a `~` prefix is a shape nothing
 * resolves. The `@` the composer's mention syntax puts in front is peeled
 * first — that is Tug's marker, not part of the path.
 *
 * **The grammar is permissive on purpose, and here that has a cost the
 * annotator does not pay.** In transcript ink an unresolved candidate simply
 * stays plain text; here it would DIM a row, so `/model vendor/name` would
 * be refused over a slash that never named a file. So a candidate has to
 * declare itself a file as well as look like a path: either the reader wrote
 * the `@` mention marker, or its last segment is a `name.ext` the same
 * grammar recognises. Anything else is a word the command means something by,
 * and this says nothing about it.
 *
 * Only the cwd-relative and absolute shape is answered, because
 * {@link pathResolutionStore} is the only resolver this asks: a bare
 * `name.ext` with no directory on it is the project file index's question,
 * and a run row is not worth a second resolver's plumbing.
 *
 * Exported for the pure-logic test suite.
 */
export function argsFilePath(args: string): string | null {
  for (const token of args.split(/\s+/)) {
    const mentioned = token.startsWith("@");
    const bare = mentioned ? token.slice(1) : token;
    if (bare.length === 0) continue;
    const [reference] = scanPathReferences(bare);
    if (reference === undefined || reference.shape !== "path") continue;
    if (mentioned) return reference.path;
    const base = reference.path.slice(reference.path.lastIndexOf("/") + 1);
    if (scanPathReferences(base)[0]?.shape === "name") return reference.path;
  }
  return null;
}

/**
 * The live facts a slash command's menu reads, from what this surface knows.
 *
 * Two things dim the run rows and nothing else does: no composer to run in,
 * and an argument naming a file the resolver has looked for and not found.
 * A path nobody has answered about yet is not missing — it is unanswered,
 * and a row that dimmed on it would dim for the beat before the verdict
 * lands and then quietly come back, which is worse than either state.
 */
function slashCommandFacts(
  payload: AnnotationPayload,
  target: PromptInsertTarget | undefined,
  cwd: string | null,
): AnnotationMenuFacts {
  const path =
    payload.kind === "slash-command" ? argsFilePath(payload.args) : null;
  return {
    kind: "slash-command",
    hasComposer: target?.runCommand !== undefined,
    argsPathMissing:
      path !== null && pathResolutionStore.lookup(path, cwd).state === "missing",
  };
}

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
  insertTarget,
  cwd = null,
}: UseAnnotationMenuOptions = {}): UseAnnotationMenuResult {
  // The annotation the current right-click landed on, sampled by
  // `extraEntries` at menu-open time and read by the handlers when the user
  // picks an item. `null` when the right-click missed every annotation.
  const contextAnnotationRef = useRef<AnnotationPayload | null>(null);
  // The card this surface is mounted in, for the one item whose answer is a
  // card somewhere else: the new session opens on this card's project, in
  // the slot beside it. `null` on a surface mounted outside any card.
  const cardId = useCardId();

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
    if (payload === null || insertTarget === undefined) return;
    // Whether this entity inserts as an atom or as text is the registry's
    // rule, stated once in `atomSegmentFor` and read by the Copy as Atom
    // item as well as by this one.
    const segment = atomSegmentFor(payload);
    if (segment !== null) {
      return () => {
        insertTarget.raise();
        insertTarget.insertAtom(segment);
      };
    }
    const value = sampledAnnotationValue(payload);
    if (value === null) return;
    return () => {
      insertTarget.raise();
      insertTarget.insertText(value, [], null);
    };
  }, [insertTarget]);

  // Run Here: the command the right-click landed on, as this card's next
  // turn. It goes through the surface's own `PromptInsertTarget`, which is
  // the originating card's composer and never another card's — the entity is
  // in this transcript, so "here" can only mean this one ([B05]).
  //
  // A continuation, like Insert into Prompt: the composer takes focus and
  // sends, and doing that inside the menu's activation blink fights the
  // menu's own teardown.
  const handleRunCommandHere = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null || payload.kind !== "slash-command") return;
    const run = insertTarget?.runCommand;
    if (run === undefined) return;
    const { name, args } = payload;
    return () => {
      insertTarget?.raise();
      run(name, args);
    };
  }, [insertTarget]);

  // Run in New Session: the same command, as the first turn of a NEW card
  // beside this one on the same project. Deck work rather than composer
  // work, so it dispatches to the deck's own handler and names the card the
  // right-click landed in — that card's project is the one the new card
  // opens on, and its slot is the one the new card lands beside.
  //
  // Gated on the same capability Run Here is: a surface with no composer of
  // its own is a surface whose card has no session, and a new card opened
  // from one would have no project to open on.
  const handleRunCommandInNewSession = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null || payload.kind !== "slash-command") return;
    if (insertTarget?.runCommand === undefined) return;
    const { name, args } = payload;
    return () => {
      // The registry handler directly, not `dispatchCommand`: this is a
      // menu-only verb over a sampled target and so has no command-registry
      // row for a command id to name ([ACTIONS_OUTSIDE_THE_TABLE]). The deck
      // work — the card, the slot, the spawn — lives in `action-dispatch.ts`,
      // which is the only place holding the DeckManager and the connection.
      getRegistryHandler(TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION)?.({
        name,
        args,
        originCardId: cardId ?? undefined,
      });
    };
  }, [insertTarget, cardId]);

  // The atom copy — the same segment the insert mints, on the clipboard as
  // the one-atom sidecar a paste back into any Tug editor rebuilds the chip
  // from. Exactly the shape `sessionAtomClipboardPayload` writes: one atom at
  // position 0 of the one-character text an atom occupies.
  //
  // The `text/plain` flavor is the atom's own plain form rather than the
  // annotation's value, which is where the two copies differ on a cited file:
  // `Copy Path` on `foo.ts:14` copies the citation as written, and an atom
  // names a file. `atomPlainTextFor` states that per kind — a session's is
  // its citation, because a bare callsign is not a reference off the machine.
  //
  // [L31] — a kind with no atom form is never offered this item, and the
  // handler answers the same predicate rather than trusting that.
  const handleCopyAnnotationAtom = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null) return;
    const segment = atomSegmentFor(payload);
    if (segment === null) return;
    writeCopyClipboard(atomPlainTextFor(payload, segment), null, origin(), {
      version: 1,
      text: TUG_ATOM_CHAR,
      atoms: [{ position: 0, segment }],
    });
  }, [origin]);

  // Show in Finder for the right-clicked file annotation. Revealing a file
  // opens the folder around it; a directory is already that folder, so the two
  // take different routes to the same gesture.
  const handleRevealAnnotatedFile = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload?.kind === "file-path") revealPathInFinder(payload.path);
    else if (payload?.kind === "directory") revealDirectoryInFinder(payload.path);
  }, []);

  // The two hash forms a sha alone can stand behind. Short is the reference
  // the app writes a commit as — `commit:<8>`, the atom's own text; full is
  // the hash bare, which is what a git verb takes as an argument. Ink may
  // carry a sha already short, and slicing a short sha is a no-op.
  const handleCopyCommitShortHash = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null || payload.kind !== "commit-sha") return;
    writeCopyClipboard(
      `commit:${payload.sha.slice(0, SHA_DISPLAY_LEN)}`,
      null,
      origin(),
      null,
    );
  }, [origin]);

  const handleCopyCommitHash = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null || payload.kind !== "commit-sha") return;
    writeCopyClipboard(payload.sha, null, origin(), null);
  }, [origin]);

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
      [TUG_ACTIONS.RUN_COMMAND_HERE]: handleRunCommandHere,
      [TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION]: handleRunCommandInNewSession,
      [TUG_ACTIONS.COPY_ANNOTATION_ATOM]: handleCopyAnnotationAtom,
      [TUG_ACTIONS.REVEAL_IN_FINDER]: handleRevealAnnotatedFile,
      [TUG_ACTIONS.OPEN_IMAGE_PREVIEW]: handleOpenImagePreview,
      [TUG_ACTIONS.OPEN_DIFF]: handleOpenAnnotatedDiff,
      [TUG_ACTIONS.COPY_COMMIT_SHORT_HASH]: handleCopyCommitShortHash,
      [TUG_ACTIONS.COPY_COMMIT_HASH]: handleCopyCommitHash,
    }),
    [
      handleCopyCommand,
      handleCopyCommandPlain,
      handleCopyAnnotationValue,
      handleInsertIntoPrompt,
      handleRunCommandHere,
      handleRunCommandInNewSession,
      handleCopyAnnotationAtom,
      handleRevealAnnotatedFile,
      handleOpenImagePreview,
      handleOpenAnnotatedDiff,
      handleCopyCommitShortHash,
      handleCopyCommitHash,
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
      // A slash command is the one kind with facts this surface can answer
      // for — whether it has a composer to run in, and whether the args
      // still name a file that is there. Every other kind knows the entity
      // and nothing else, which is what `{ kind: "none" }` says.
      const facts: AnnotationMenuFacts =
        hit.payload.kind === "slash-command"
          ? slashCommandFacts(hit.payload, insertTarget, cwd)
          : { kind: "none" };
      const entries =
        annotationEntryFor(hit.payload.kind)?.menuEntries(hit.payload, facts) ??
        [];
      // Annotated ink and a placed atom know the entity and nothing else
      // about it, which is what `{ kind: "none" }` says. A surface with no
      // composer to send to can't seed a prompt, so it doesn't offer to.
      return entityMenuItems(entries, (e) =>
        insertTarget === undefined &&
        e.action === TUG_ACTIONS.INSERT_INTO_PROMPT,
      );
    },
    [insertTarget, cwd],
  );

  const hideStandardItems = useCallback((event: MouseEvent): boolean => {
    const hit = annotationFromEvent(event);
    if (hit === null) return false;
    return annotationEntryFor(hit.payload.kind)?.suppressStandardItems ?? false;
  }, []);

  // An annotation is one thing to a secondary click, whatever its kind. The
  // browser would smart-select a sub-word of it — a segment of the path, a
  // word of the command — under a menu whose every item acts on the whole
  // entity, and a highlight that names less than the menu does is a lie about
  // what the gesture is about to do. Handing the element back is what lets
  // the surface select all of it instead.
  const wholeEntityTarget = useCallback(
    (event: MouseEvent): HTMLElement | null =>
      annotationFromEvent(event)?.element ?? null,
    [],
  );

  return { actions, extraEntries, hideStandardItems, wholeEntityTarget };
}
