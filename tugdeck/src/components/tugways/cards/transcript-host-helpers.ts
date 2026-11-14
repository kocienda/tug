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
 * COPY_ALTERNATE / SELECT_ALL via `useResponder` + targeted control dispatch,
 * the canonical tugway control shape; the cell is the responder for all three
 * because the selection they read is its own. [L30] — the alternate copy is
 * one registry command with one chord and one menu item; the cell answers
 * its `queryActionState` so the entry's `dynamicTitle` names the face the
 * gesture will have, rather than a second command standing beside the first.
 *
 * @module components/tugways/cards/transcript-host-helpers
 */

import React, { useCallback, useId, useLayoutEffect, useMemo, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { COPY_ALTERNATE_MARKDOWN } from "@/components/tugways/command-registry";
import { copySelectionAsPlainText } from "@/lib/copy-as-plain-text";
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
import type { PromptInsertTarget } from "@/components/tugways/prompt-insert-target";
import type { AnnotationContext } from "@/lib/annotator/types";
import { useAnnotationContextFor } from "@/components/tugways/use-annotation-context";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import type { ActionHandlerResult } from "@/components/tugways/responder-chain";
import { useResponder } from "@/components/tugways/use-responder";
import { useTextSurfaceContextMenu } from "@/components/tugways/use-text-surface-context-menu";
import { ReadOnlyTextHostContext } from "@/components/tugways/use-read-only-text-surface";
import { useAnnotationMenu } from "@/components/tugways/use-annotation-menu";
import type { TugEditorContextMenuEntry } from "@/components/tugways/tug-editor-context-menu";
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
  /** Substitutes the cell's own reading of the selection into a native ⌘C. */
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
 *
 * A cell that supplies one is a **rendered surface**: what it shows is the
 * rendering of markdown, not the markdown. Its Copy gives the plain text of
 * what was selected and its alternate copy gives the markdown, which is the
 * reverse of a source surface, whose Copy is already its source.
 */
export type CopyMarkdownResolver = (
  bodyEl: HTMLElement,
  selection: Selection,
) => SelectionSubstrate | null;

/**
 * The same selection as plain text, in the same substrate shape: no markdown
 * syntax in the text, the chips still a `U+FFFC` each with their atoms
 * beside. What a rendered surface's Copy writes.
 */
export type CopyPlainResolver = CopyMarkdownResolver;

/** What a transcript cell hands its context menu. */
export interface TranscriptCellMenuOptions {
  /**
   * Reconstructs markdown for the cell's current selection: what Copy as
   * Markdown writes. Supplying it is what makes the cell a rendered surface.
   * Omitted by a cell of literal ink, whose Copy is its text as it stands.
   */
  resolveCopyMarkdown?: CopyMarkdownResolver;
  /**
   * Reads the cell's current selection as plain text: what Copy and ⌘C
   * write on a rendered surface. Supplied beside `resolveCopyMarkdown`.
   */
  resolveCopyPlain?: CopyPlainResolver;
  /**
   * The composer an annotation's Insert into Prompt item seeds. Omitted by a
   * fixture with no composer to send to; the item is then not offered.
   */
  insertTarget?: PromptInsertTarget;
  /**
   * Items about the cell's turn, appended after the entity items when the
   * menu opens — the Session card's Share from Here…. Read at open time, so
   * a cell that stops offering them needs no re-render of the menu.
   */
  turnEntries?: () => TugEditorContextMenuEntry[];
}

// Exported for the copy-wiring app-test fixture (`fixture-transcript-copy`),
// which mounts this exact hook over a static body so `just app-test` drives
// the real ⌘C / menu-Copy path. Not part of the card's public API otherwise.
export function useTranscriptCellMenu({
  resolveCopyMarkdown,
  resolveCopyPlain,
  insertTarget,
  turnEntries,
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
  const annotation = useAnnotationMenu({
    originRef: bodyRef,
    ...(insertTarget !== undefined ? { insertTarget } : {}),
  });
  // Live-ref the resolvers ([L07]) so the copy handlers keep a stable
  // identity while always invoking the latest closure (which captures
  // the current messages / store).
  const resolveCopyRef = useRef(resolveCopyMarkdown);
  resolveCopyRef.current = resolveCopyMarkdown;
  const resolvePlainRef = useRef(resolveCopyPlain);
  resolvePlainRef.current = resolveCopyPlain;
  // Live-ref the turn items for the same reason ([L07]).
  const turnEntriesRef = useRef(turnEntries);
  turnEntriesRef.current = turnEntries;
  const annotationExtraEntries = annotation.extraEntries;
  const extraEntries = useCallback(
    (event: MouseEvent): TugEditorContextMenuEntry[] => {
      const entity = annotationExtraEntries(event);
      const turn = turnEntriesRef.current?.() ?? [];
      if (turn.length === 0) return entity;
      if (entity.length === 0) return turn;
      return [...entity, { type: "separator" }, ...turn];
    },
    [annotationExtraEntries],
  );

  // Build the adapter once the body element is available. Re-runs
  // whenever the body element identity changes (rare for inline-rendered
  // transcript cells; the body element is stable for the cell's life).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    adapterRef.current = body !== null ? new HighlightSelectionAdapter(body) : null;
  });

  // A copy reads the live selection synchronously inside the menu's
  // mousedown gesture so `clipboard.writeText` is permitted.
  //
  // Two forms off one reading. On a rendered surface — a cell with a
  // markdown resolver — `plain` is what Copy writes: the selected text with
  // no markdown syntax, `text/plain` alone, because an HTML flavor beside it
  // would have a mail or message composer paste the styling the reader was
  // leaving behind. `markdown` is what the alternate copy writes: the
  // markdown that produced the selection, and that markdown re-rendered as
  // `text/html`. Both keep the atom sidecar, so a paste back into a Tug
  // prompt rebuilds its chips whichever form was copied.
  //
  // Split from the write so the two doors into a transcript Copy — the
  // menu's chain dispatch and the native ⌘C, which never enters the chain
  // at all — reconstruct through one body of code and cannot drift.
  // Returns null when there is nothing to copy.
  const reconstructCopy = useCallback((form: "plain" | "markdown"): {
    text: string;
    html: string | null;
    sidecar: TugAtomsClipboardPayload | null;
  } | null => {
    const sel = window.getSelection();
    if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null;
    // Reconstruct the selection in the form asked for ([P03] — the
    // serializer's own reading, never the browser's). `Selection.toString()`
    // is only a last-resort guard for an unexpected DOM shape, and the
    // whole of the copy for a cell with no resolver (literal ink).
    const body = bodyRef.current;
    const rendered = resolveCopyRef.current !== undefined;
    const resolve =
      form === "markdown" ? resolveCopyRef.current : resolvePlainRef.current;
    let substrate: SelectionSubstrate | null = null;
    let text: string | null = null;
    if (body !== null && rendered && resolve !== undefined) {
      try {
        substrate = resolve(body, sel);
        text =
          substrate === null
            ? null
            : formatAtomTextForCopy(substrate.text, substrate.atoms);
      } catch (err) {
        tugDevLogStore.warn(
          "session-card-transcript",
          "copy reconstruction threw; falling back to the selection's text",
          { error: String(err), form },
        );
        text = null;
      }
      // A resolver was available but produced nothing — the reconstruction
      // failed for this selection. Surface it ([P07]) rather than
      // silently degrading to the browser's reading. (No resolver = literal
      // ink, which is its own text by design and not logged.)
      if (text === null) {
        tugDevLogStore.warn(
          "session-card-transcript",
          "copy reconstruction yielded nothing; falling back to the selection's text",
          { form },
        );
      }
    }
    // The markdown form writes both flavors ([P05]): text/plain = markdown,
    // text/html = that markdown re-rendered ([Q04]). The plain form, and
    // the guard, write text/plain only.
    let html: string | null = null;
    if (form === "markdown" && text !== null) {
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

  // Copy — plain on a rendered surface, the selection's own text on ink.
  const handleCopy = useCallback((): ActionHandlerResult => {
    const copy = reconstructCopy("plain");
    if (copy === null) return;
    writeCopyClipboard(
      copy.text,
      copy.html,
      clipboardOriginFor(bodyRef.current),
      copy.sidecar,
    );
  }, [reconstructCopy]);

  // The alternate copy, ⌥⇧⌘C and its menu rows: the copy this surface's
  // Copy does not give. On a rendered surface that is the markdown, and only
  // the cell can write it, because it takes the cell's resolver. On ink the
  // cell has no markdown to offer, so it gives the face every source surface
  // gives — the selection stripped to plain text — exactly as the root
  // would have, had the action walked past this cell to reach it.
  const handleCopyAlternate = useCallback((): ActionHandlerResult => {
    if (resolveCopyRef.current === undefined) {
      copySelectionAsPlainText();
      return;
    }
    const copy = reconstructCopy("markdown");
    if (copy === null) return;
    // Edit ▸ Copy as Markdown arrives as a control frame from the host, with
    // no user gesture in this page behind it, and the async Clipboard API
    // refuses a write nobody gestured for. So inside Tug.app the whole write
    // goes over the native bridge, every flavor with it; the Clipboard API
    // is the browser-mode path, where the only doors are the chord and the
    // context menu and both are gestures.
    const origin = clipboardOriginFor(bodyRef.current);
    const sidecar = withClipboardOrigins(copy.sidecar, copy.text, origin);
    if (
      hasNativeClipboardBridge() &&
      writeClipboardViaNative(
        copy.text,
        sidecar !== null ? JSON.stringify(sidecar) : "",
        copy.html ?? undefined,
      )
    ) {
      return;
    }
    writeCopyClipboard(copy.text, copy.html, origin, copy.sidecar);
  }, [reconstructCopy]);

  // Which face the alternate has here, for the registry entry's title and
  // this cell's own menu row. Read live from the ref ([L07]).
  const copyAlternateState = useCallback(
    (): string | undefined =>
      resolveCopyRef.current !== undefined ? COPY_ALTERNATE_MARKDOWN : undefined,
    [],
  );

  // The native ⌘C.
  //
  // ⌘C is Edit ▸ Copy's key equivalent: AppKit resolves it against the main
  // menu and performs `NSText.copy(_:)` on the web view, so it never enters
  // the responder chain and {@link handleCopy} above never sees it. Left
  // alone, WebKit then copies its own rendering of the selection — the
  // cell's own reading reachable only from the menu, and the same selection
  // yielding two different clipboards depending on which door the reader
  // used.
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
      const copy = reconstructCopy("plain");
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
  const { ResponderScope: CellScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      ...annotation.actions,
      [TUG_ACTIONS.COPY]: handleCopy,
      [TUG_ACTIONS.COPY_ALTERNATE]: handleCopyAlternate,
      [TUG_ACTIONS.SELECT_ALL]: handleSelectAll,
    },
    queryActionState: (action) =>
      action === TUG_ACTIONS.COPY_ALTERNATE ? copyAlternateState() : undefined,
  });

  // The cell owns Select All, Copy and the menu for every markdown block
  // inside it, so its scope tells them to stand aside rather than register a
  // document responder each (`TugMarkdownBlock`). Built once, as `CellScope`
  // is, so the subtree never remounts.
  const scopeRef = useRef<React.FC<{ children: React.ReactNode }> | null>(null);
  if (scopeRef.current === null) {
    scopeRef.current = function ResponderScope({ children }: { children: React.ReactNode }) {
      return React.createElement(
        CellScope,
        null,
        React.createElement(ReadOnlyTextHostContext.Provider, { value: true }, children),
      );
    };
  }
  const ResponderScope = scopeRef.current;

  // The shared hook owns menuState, the contextmenu pipeline, and
  // the menu render. We feed it the adapter (read live from the ref
  // so it's whatever the latest layout-effect installed) and the
  // capabilities for a read-only surface. The menu's items dispatch
  // via `useControlDispatch` to the parent responder — i.e., this
  // cell's `<ResponderScope>`, which we render the menu inside
  // below. The cell may never have been promoted to first responder
  // (the editor often holds it across the right-click), but targeted
  // dispatch via `parentId` doesn't care: COPY, COPY_ALTERNATE, the
  // command-copy actions, and SELECT_ALL always land on this cell's handlers
  // regardless of first-responder state. Same canonical L11 shape every
  // other tugway control uses. For the same reason the menu's alternate row
  // is labelled from this cell's own answer rather than from the chain's:
  // the row will act here, whoever the first responder is.
  const {
    onMouseDown: hookMouseDown,
    onContextMenu: hookContextMenu,
    menu,
  } = useTextSurfaceContextMenu({
    adapterRef,
    extraEntries,
    hideStandardItems: annotation.hideStandardItems,
    wholeEntityTarget: annotation.wholeEntityTarget,
    copyAlternateState,
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
    // the right-click menu routes to this entry, and so does ⌘A: Select All
    // is chain-routed (`routing: "first-responder"`), so the key funnel and
    // Edit ▸ Select All both reach this cell's handler while the composer
    // keeps DOM focus. ⌘C does NOT — Copy is performed natively by AppKit
    // against the document selection — which is why the cell carries
    // `onCopy` as well.
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
