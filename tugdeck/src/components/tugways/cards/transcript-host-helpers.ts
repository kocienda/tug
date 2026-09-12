/**
 * Transcript-host helpers — value exports split out of
 * `session-card-transcript.tsx` so that file stays a component-only React Fast
 * Refresh boundary. A `.tsx` exporting hooks/functions alongside its
 * `SessionTranscriptHost` component is "mixed" and non-accepting, so editing it
 * (or anything it transitively imports) full-reloads. This module owns the
 * model-name hook, the timestamp formatter, and the per-cell context-menu
 * wiring; `session-card-transcript.tsx` and the copy-wiring gallery import them.
 *
 * **Laws:** [L02] — `useSessionModelName` reads the model through
 * `useSyncExternalStore` over `SessionMetadataStore` only. [L07] — the
 * cell-menu copy/select-all handlers sample the body element live from a ref
 * and close over the captured value, so a re-render during the menu blink
 * can't race the deferred operation. [L11] — the menu dispatches COPY /
 * SELECT_ALL via `useResponder` + targeted control dispatch, the canonical
 * tugway control shape.
 *
 * @module components/tugways/cards/transcript-host-helpers
 */

import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { isKnownSlashCommandName } from "@/lib/slash-supported";
import { formatContextualStamp } from "@/lib/contextual-stamp";
import {
  HighlightSelectionAdapter,
  type TextSelectionAdapter,
} from "@/components/tugways/text-selection-adapter";
import { transcriptMarkdownToHtml } from "@/lib/markdown/transcript-copy-html";
import { clipboardOriginFor } from "@/lib/clipboard-origin";
import { writeCopyClipboard } from "@/lib/copy-clipboard";
import {
  hasNativeClipboardBridge,
  writeClipboardViaNative,
} from "@/lib/tug-native-clipboard";
import {
  TUG_ATOMS_MIME,
  withClipboardOrigins,
  type TugAtomsClipboardPayload,
} from "@/components/tugways/tug-text-editor/clipboard-filters";
import { atomTextClipboardPayload, formatAtomTextForCopy } from "@/lib/atom-text";
import type { SelectionSubstrate } from "@/lib/markdown/serialize-selection";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import type { PromptInsertTarget } from "@/lib/prompt-insert-target";
import type { AnnotationContext } from "@/lib/annotator/types";
import { useAnnotationContextFor } from "@/components/tugways/use-annotation-context";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import type { ActionHandlerResult } from "@/components/tugways/responder-chain";
import { useResponder } from "@/components/tugways/use-responder";
import { useTextSurfaceContextMenu } from "@/components/tugways/use-text-surface-context-menu";
import { useAnnotationMenu } from "@/components/tugways/use-annotation-menu";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import type { SessionMetadataStore, SlashCommandInfo } from "@/lib/session-metadata-store";

/** Stable empty catalog for the no-metadata-store case (keeps `useSyncExternalStore` snapshot identity). */
const EMPTY_SLASH_COMMANDS: SlashCommandInfo[] = [];

/**
 * Read the active model name from a `SessionMetadataStore` via
 * `useSyncExternalStore` ([L02]). Returns `null` when the store has
 * not yet observed a `system_metadata` event for this session.
 */
export function useSessionModelName(
  sessionMetadataStore: SessionMetadataStore,
): string | null {
  return useSyncExternalStore(
    sessionMetadataStore.subscribe,
    useCallback(
      () => sessionMetadataStore.getSnapshot().model,
      [sessionMetadataStore],
    ),
  );
}

/**
 * Build a predicate over the *known* slash-command set: claude's live
 * catalog (`SessionMetadataStore.slashCommands`) plus the card's
 * locally-handled commands. The transcript feeds this to the annotator to
 * gate which inline `<code>` command spans become clickable — the strict
 * known-list gate, not a loose regex.
 *
 * The membership test is {@link isKnownSlashCommandName}, which resolves a
 * bare name against the catalog **namespace-aware** — so `` `/arc` `` written
 * in prose is a chip even though the catalog entry is `tugplug:arc`. It is
 * the same resolver the submit path runs, so clickable and sendable agree by
 * construction.
 *
 * [L02] — the catalog is read through `useSyncExternalStore`. The predicate
 * identity is memoized on the catalog array (stable between store changes,
 * so unrelated metadata updates don't rebuild it); a catalog change
 * yields a fresh predicate, which newly-mounting turn cells pick up.
 */
export function useKnownSlashCommand(
  sessionMetadataStore: SessionMetadataStore | undefined,
): (name: string) => boolean {
  const catalog = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        sessionMetadataStore ? sessionMetadataStore.subscribe(listener) : () => {},
      [sessionMetadataStore],
    ),
    useCallback(
      () => sessionMetadataStore?.getSnapshot().slashCommands ?? EMPTY_SLASH_COMMANDS,
      [sessionMetadataStore],
    ),
  );
  return useMemo(() => {
    const catalogNames = catalog.map((cmd) => cmd.name);
    return (name: string) => isKnownSlashCommandName(name, catalogNames);
  }, [catalog]);
}

/**
 * The session's live working directory, or `null` where there is no session
 * to ask. Two callers, and they must agree: the annotation context counts a
 * relative path reference from it, and the cell menu asks whether a
 * command's `@path` argument is still there. A second subscription that
 * resolved paths differently would dim a row over a file the same
 * transcript was happily linking.
 */
export function useSessionCwd(
  sessionMetadataStore: SessionMetadataStore | undefined,
): string | null {
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        sessionMetadataStore ? sessionMetadataStore.subscribe(listener) : () => {},
      [sessionMetadataStore],
    ),
    useCallback(
      () => sessionMetadataStore?.getSnapshot().cwd ?? null,
      [sessionMetadataStore],
    ),
  );
}

/**
 * Assemble the transcript's {@link AnnotationContext} — the live inputs
 * the annotator needs beyond the DOM it walks. Handed to every markdown
 * surface in the transcript; a surface that renders markdown *outside*
 * the transcript passes none and gets the state-free entity kinds only.
 *
 * What this hook owns is the transcript's three inputs: the live command
 * catalog, the session's cwd, and the card's own project binding — not the
 * frontmost project, since this transcript's references belong to the
 * session it is showing. The context itself is assembled by
 * {@link useAnnotationContextFor}, which every annotating surface shares
 * and which is where the identity-stable-across-verdicts contract is
 * written down.
 */
export function useAnnotationContext(
  sessionMetadataStore: SessionMetadataStore | undefined,
): AnnotationContext {
  const isKnownSlashCommand = useKnownSlashCommand(sessionMetadataStore);
  const cwd = useSessionCwd(sessionMetadataStore);
  // The card's own project — not the frontmost one — since this
  // transcript's references belong to the session it is showing. Its
  // `projectDir` is the file index's search root and its `workspaceKey`
  // scopes the shared FILETREE feed.
  const cardId = useCardId();
  const binding = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    useCallback(
      () =>
        cardId === null ? undefined : cardSessionBindingStore.getBinding(cardId),
      [cardId],
    ),
  );
  // The transcript's rows carry `@` atoms, so it asks for the roots their
  // project-relative values are counted from; the shared builder holds the
  // same two roots the path resolver uses.
  return useAnnotationContextFor({
    projectDir: binding?.projectDir ?? null,
    workspaceKey: binding?.workspaceKey ?? null,
    cwd,
    isKnownSlashCommand,
    withAtomRoots: true,
  });
}

/**
 * Format an absolute millisecond timestamp as a clock-style string for
 * display next to a transcript row's identifier.
 *
 * The stamp is context-aware ([formatContextualStamp]): a row from
 * today shows the clock alone, and a row from any other day carries
 * that day's name ahead of it (`Yesterday`, `Monday`, `Aug 4`) — a
 * resumed session's early turns must not read as if they happened this
 * evening. The hour separator is U+2236 RATIO, which pairs with the
 * timestamp's tabular numerals.
 *
 * Returns the empty string for the special sentinel `0` so a callsite
 * can pass `entry.endedAt` unconditionally without fabricating a
 * "Jan 1 1970" timestamp on rows whose end-time was never recorded.
 */
export function formatTranscriptTimestamp(ms: number): string {
  return formatContextualStamp(ms, { seconds: true, ratioSeparator: true });
}

// ---------------------------------------------------------------------------
// Per-cell context-menu wiring
// ---------------------------------------------------------------------------

/**
 * Per-cell context menu + responder wiring for transcript entries.
 *
 * Each entry installs its own responder + right-click menu via the
 * shared `useTextSurfaceContextMenu` hook so the same code path that
 * powers the editor and markdown view drives transcript-cell
 * right-clicks. Per-entry scope follows from the responder model:
 * the document-level pointerdown listener in
 * `ResponderChainProvider` promotes whichever cell's responder owns
 * the click target to first responder, and `TugEditorContextMenu`
 * dispatches first-responder-targeted, so items from the menu reach
 * THIS cell's `COPY` / `SELECT_ALL` handlers — no
 * `makeFirstResponder` boilerplate needed.
 *
 * The cell uses a query-only `HighlightSelectionAdapter` scoped to its body
 * element (for the menu's Cut / Copy enablement). Selection preservation on a
 * secondary-click is handled by the hook's `onMouseDown` preventDefault guard
 * (wired to the cell's `onMouseDown`), so the selection is never collapsed and
 * there is no capture/restore. The adapter is held in a ref the hook reads
 * live; it is `null` until the body mounts (the hook tolerates that).
 */
interface TranscriptCellProps {
  ref: (node: Element | null) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onMouseDown: (event: React.MouseEvent) => void;
  /** Substitutes the reconstructed markdown into a native ⌘C. */
  onCopy: (event: React.ClipboardEvent<HTMLElement>) => void;
}

/**
 * Resolve a live selection within the cell body to the `(text, atoms)`
 * substrate: markdown for the prose, a `U+FFFC` for each chip it crossed, and
 * the atoms behind them. Returns `null` when nothing copyable was touched (the
 * hook then falls back to plain text as a last-resort guard).
 *
 * The substrate rather than a string because a copy owes two answers — the
 * readable text for anywhere else, and the sidecar that rebuilds the chips on
 * the way back into Tug — and they have to come from one reading of the
 * selection. Every cell whose body can hold a chip supplies one; a cell of
 * literal ink (shell, refs) omits it and copies its selection verbatim.
 */
export type CopyMarkdownResolver = (
  bodyEl: HTMLElement,
  selection: Selection,
) => SelectionSubstrate | null;

/** What a transcript cell hands its context menu. */
export interface TranscriptCellMenuOptions {
  /**
   * Reconstructs markdown for the cell's current selection. Omitted by the
   * user row, which is plain text by design.
   */
  resolveCopyMarkdown?: CopyMarkdownResolver;
  /**
   * The composer an annotation's Insert into Prompt item seeds. Omitted by a
   * fixture with no composer to send to; the item is then not offered.
   */
  insertTarget?: PromptInsertTarget;
  /**
   * The session whose cwd a relative path in this cell's prose is counted
   * from. Read for one thing: whether a command's `@path` argument still
   * names a file, which is what dims the menu's run rows. Omitted by a
   * fixture, and a relative path is then an answer nobody has.
   */
  sessionMetadataStore?: SessionMetadataStore;
}

// Exported for the copy-wiring app-test fixture (`fixture-transcript-copy`),
// which mounts this exact hook over a static body so `just app-test` drives
// the real ⌘C / menu-Copy path. Not part of the card's public API otherwise.
export function useTranscriptCellMenu({
  resolveCopyMarkdown,
  insertTarget,
  sessionMetadataStore,
}: TranscriptCellMenuOptions = {}): {
  ResponderScope: React.FC<{ children: React.ReactNode }>;
  cellProps: TranscriptCellProps;
  bodyRef: React.MutableRefObject<HTMLElement | null>;
  menu: React.ReactNode;
} {
  const bodyRef = useRef<HTMLElement | null>(null);
  const adapterRef = useRef<TextSelectionAdapter | null>(null);
  // The entity half of this cell's menu: the registry's per-kind items and
  // the handlers they dispatch to, which read the annotation the press
  // landed on rather than the cell's selection. Everything below is the
  // surface half — the selection Copy and Select All, which are the cell's
  // own and could not be shared.
  const cwd = useSessionCwd(sessionMetadataStore);
  const annotation = useAnnotationMenu({
    originRef: bodyRef,
    cwd,
    ...(insertTarget !== undefined ? { insertTarget } : {}),
  });
  // Live-ref the resolver ([L07]) so `handleCopy` keeps a stable
  // identity while always invoking the latest closure (which captures
  // the current messages / store).
  const resolveCopyRef = useRef(resolveCopyMarkdown);
  resolveCopyRef.current = resolveCopyMarkdown;

  // Build the adapter once the body element is available. Re-runs
  // whenever the body element identity changes (rare for inline-rendered
  // transcript cells; the body element is stable for the cell's life).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    adapterRef.current = body !== null ? new HighlightSelectionAdapter(body) : null;
  });

  // Copy reads the live selection synchronously inside the menu's
  // mousedown gesture so `clipboard.writeText` is permitted.
  //
  // Split from the write so the two doors into a transcript copy — the
  // menu's chain dispatch and the native ⌘C, which never enters the chain
  // at all — reconstruct through one body of code and cannot drift.
  // Returns null when there is nothing to copy.
  const reconstructCopy = useCallback((): {
    text: string;
    html: string | null;
    sidecar: TugAtomsClipboardPayload | null;
  } | null => {
    const sel = window.getSelection();
    if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null;
    // Reconstruct markdown for the selection ([P03] — no plain-text
    // fallback for the markdown path). The plain-text branch is only a
    // last-resort guard for an unexpected DOM shape or a cell with no
    // resolver (the user row).
    const body = bodyRef.current;
    const resolve = resolveCopyRef.current;
    let substrate: SelectionSubstrate | null = null;
    let text: string | null = null;
    if (body !== null && resolve !== undefined) {
      try {
        substrate = resolve(body, sel);
        text =
          substrate === null
            ? null
            : formatAtomTextForCopy(substrate.text, substrate.atoms);
      } catch (err) {
        tugDevLogStore.warn(
          "session-card-transcript",
          "copy reconstruction threw; falling back to plain text",
          { error: String(err) },
        );
        text = null;
      }
      // A resolver was available but produced nothing — the markdown
      // path failed for this selection. Surface it ([P07]) rather than
      // silently degrading to plain text. (No resolver = the user row,
      // which is plain text by design and not logged.)
      if (text === null) {
        tugDevLogStore.warn(
          "session-card-transcript",
          "copy reconstruction yielded no markdown; falling back to plain text",
        );
      }
    }
    // `text` is the reconstructed markdown when the resolver produced
    // it (the markdown path), or null for the plain-text guard. The
    // markdown path writes both flavors ([P05]): text/plain = markdown,
    // text/html = that markdown re-rendered ([Q04]). The plain guard
    // writes text/plain only.
    let html: string | null = null;
    if (text !== null) {
      try {
        const rendered = transcriptMarkdownToHtml(text);
        html = rendered === "" ? null : rendered;
      } catch (err) {
        tugDevLogStore.warn(
          "session-card-transcript",
          "copy text/html render threw; writing plain text only",
          { error: String(err) },
        );
        html = null;
      }
    }
    if (text === null) text = sel.toString();
    if (text === "") return null;
    // The chips the selection crossed, as the sidecar a paste back into Tug
    // rebuilds them from. Null when the selection crossed none — then this is
    // ordinary prose and only its provenance is worth carrying.
    const sidecar =
      substrate === null
        ? null
        : atomTextClipboardPayload(substrate.text, substrate.atoms);
    return { text, html, sidecar };
  }, []);

  const handleCopy = useCallback((): ActionHandlerResult => {
    const copy = reconstructCopy();
    if (copy === null) return;
    writeCopyClipboard(
      copy.text,
      copy.html,
      clipboardOriginFor(bodyRef.current),
      copy.sidecar,
    );
  }, [reconstructCopy]);

  // The native ⌘C.
  //
  // ⌘C is Edit ▸ Copy's key equivalent: AppKit resolves it against the main
  // menu and performs `NSText.copy(_:)` on the web view, so it never enters
  // the responder chain and {@link handleCopy} above never sees it. Left
  // alone, WebKit then copies its own rendering of the selection — the
  // transcript's markdown reconstruction reachable only from the menu, and
  // the same selection yielding two different clipboards depending on which
  // door the reader used.
  //
  // The `copy` DOM event is where that native path becomes ours: WebKit
  // fires it before writing, and a handler that fills `clipboardData` and
  // calls `preventDefault()` substitutes its own flavors. Synchronous by
  // necessity — the event's data cannot be set from a later turn, which is
  // why this writes through `clipboardData` rather than the async
  // `navigator.clipboard` the menu path uses.
  const handleNativeCopy = useCallback(
    (event: React.ClipboardEvent<HTMLElement>): void => {
      const data = event.clipboardData;
      if (data === null || data === undefined) return;
      // The selection must TOUCH this cell — intersect, not be contained by
      // it. A cross-cell selection's common ancestor is above both bodies,
      // so a containment test would refuse exactly the case the range-global
      // serializer exists to handle and let WebKit's plain-text default
      // stand. Intersection also still refuses a selection elsewhere
      // entirely, which is the thing worth refusing: the event fires in the
      // cell the selection is anchored in, so only one cell answers, and it
      // reconstructs the whole range.
      const body = bodyRef.current;
      const sel = window.getSelection();
      if (body === null || sel === null || sel.rangeCount === 0) return;
      if (!sel.getRangeAt(0).intersectsNode(body)) return;
      const copy = reconstructCopy();
      if (copy === null) return;
      // The project this prose was read against, so a path it cites still
      // resolves after it lands somewhere with no session and no project of
      // its own. It cannot ride `clipboardData` — a custom MIME type does not
      // survive WebKit's pasteboard normalization — so a copy with provenance
      // is handed to the native bridge, which owns every flavor including the
      // `text/html` this event would otherwise have written.
      const origin = clipboardOriginFor(body);
      const sidecar = withClipboardOrigins(copy.sidecar, copy.text, origin);
      if (sidecar !== null && hasNativeClipboardBridge()) {
        if (
          writeClipboardViaNative(
            copy.text,
            JSON.stringify(sidecar),
            copy.html ?? undefined,
          )
        ) {
          event.preventDefault();
          return;
        }
      }
      data.setData("text/plain", copy.text);
      if (copy.html !== null) data.setData("text/html", copy.html);
      // Browser-mode: no native bridge, but the event's own custom type is
      // readable by the editor's paste handler, so the chips survive a copy
      // outside Tug.app too rather than the fidelity depending on the host.
      if (sidecar !== null) {
        data.setData(TUG_ATOMS_MIME, JSON.stringify(sidecar));
      }
      event.preventDefault();
    },
    [reconstructCopy],
  );

  // Select All returns a continuation so the selection change lands
  // AFTER the menu's activation blink. Per [L07], the body element
  // is sampled at handler-invocation time (Phase 1, inside the user
  // gesture, when the ref is reliably populated) and the continuation
  // closes over the captured value — not over `bodyRef.current` —
  // so a re-render during the blink that flickers the inline ref
  // through `null` can't race the deferred operation.
  const handleSelectAll = useCallback((): ActionHandlerResult => {
    const root = bodyRef.current;
    if (root === null) return;
    return () => {
      const range = document.createRange();
      range.selectNodeContents(root);
      const sel = window.getSelection();
      if (sel === null) return;
      sel.removeAllRanges();
      sel.addRange(range);
    };
  }, []);

  const responderId = useId();
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      ...annotation.actions,
      [TUG_ACTIONS.COPY]: handleCopy,
      [TUG_ACTIONS.SELECT_ALL]: handleSelectAll,
    },
  });

  // The shared hook owns menuState, the contextmenu pipeline, and
  // the menu render. We feed it the adapter (read live from the ref
  // so it's whatever the latest layout-effect installed) and the
  // capabilities for a read-only surface. The menu's items dispatch
  // via `useControlDispatch` to the parent responder — i.e., this
  // cell's `<ResponderScope>`, which we render the menu inside
  // below. The cell may never have been promoted to first responder
  // (the editor often holds it across the right-click), but targeted
  // dispatch via `parentId` doesn't care: COPY, the command-copy actions,
  // and SELECT_ALL always land on this cell's handlers regardless of
  // first-responder state. Same canonical L11 shape every other tugway
  // control uses.
  const {
    onMouseDown: hookMouseDown,
    onContextMenu: hookContextMenu,
    menu,
  } = useTextSurfaceContextMenu({
    adapterRef,
    extraEntries: annotation.extraEntries,
    hideStandardItems: annotation.hideStandardItems,
    wholeEntityTarget: annotation.wholeEntityTarget,
  });

  // The hook returns native-event handlers; the cell wires them
  // through React event props. `onContextMenu` calls
  // `event.preventDefault` inside, so the system menu is suppressed
  // even when no adapter is attached yet. `onMouseDown` preventDefaults a
  // secondary-click over a range so the selection isn't collapsed.
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      hookContextMenu(event.nativeEvent);
    },
    [hookContextMenu],
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      hookMouseDown(event.nativeEvent);
    },
    [hookMouseDown],
  );

  return {
    ResponderScope,
    // No tabIndex on the cell: the transcript renders inside a read-only
    // (`interactive={false}`) TugListView, so nothing in the click chain is
    // focusable and the browser's mousedown-default focus walk finds no
    // target — DOM focus (the prompt entry's caret) survives a click on
    // transcript content. First-responder promotion of this cell rides the
    // chain's pointerdown promoter, which needs no focusable element, so
    // ⌘A and the right-click menu route to this entry. ⌘C does NOT — it is
    // a menu key equivalent AppKit performs natively — which is why the
    // cell carries `onCopy` as well.
    cellProps: {
      ref: responderRef as (node: Element | null) => void,
      onContextMenu: handleContextMenu,
      onMouseDown: handleMouseDown,
      onCopy: handleNativeCopy,
    },
    bodyRef,
    menu,
  };
}
