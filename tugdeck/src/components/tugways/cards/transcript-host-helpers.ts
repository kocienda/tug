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
import { LOCAL_SLASH_COMMANDS } from "@/lib/slash-commands";
import { formatContextualStamp } from "@/lib/contextual-stamp";
import {
  HighlightSelectionAdapter,
  type TextSelectionAdapter,
} from "@/components/tugways/text-selection-adapter";
import { transcriptMarkdownToHtml } from "@/lib/markdown/transcript-copy-html";
import { clipboardOriginFor } from "@/lib/clipboard-origin";
import {
  hasNativeClipboardBridge,
  writeClipboardViaNative,
} from "@/lib/tug-native-clipboard";
import { withClipboardOrigins } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { dispatchCommand } from "@/command-dispatch";
import { revealDirectoryInFinder, revealPathInFinder } from "@/lib/os-open";
import { openAttachmentPreview } from "@/lib/attachment-preview-open";
import { useDeckManager } from "@/deck-manager-context";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import type { CodeSessionStore } from "@/lib/code-session-store";
import { formatAtomLabel, type AtomSegment } from "@/lib/tug-atom-img";
import type { AnnotationContext } from "@/lib/annotator/types";
import { pathResolutionStore } from "@/lib/annotator/path-resolution";
import { fileNameResolverFor } from "@/lib/annotator/file-name-resolution";
import {
  commitResolverFor,
  NO_COMMIT_VERDICT,
} from "@/lib/annotator/commit-resolution";
import { makeReferenceResolver } from "@/lib/annotator/resolve-reference";
import { resolveSessionRef } from "@/lib/annotator/session-resolution";
import { VerdictBatcher } from "@/lib/annotator/verdict-batching";
import { sessionCitationStore } from "@/lib/session-citation-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { annotationFromEvent } from "@/lib/annotator/annotation-element";
import { annotationEntryFor } from "@/lib/annotator/registry";
import {
  annotationValue,
  type AnnotationPayload,
} from "@/lib/annotator/payloads";
import type { ActionHandlerResult } from "@/components/tugways/responder-chain";
import { useResponder } from "@/components/tugways/use-responder";
import { useTextSurfaceContextMenu } from "@/components/tugways/use-text-surface-context-menu";
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
 * catalog (`SessionMetadataStore.slashCommands`) unioned with the dev
 * card's locally-handled commands (`LOCAL_SLASH_COMMANDS`). The transcript
 * transcript feeds this to the annotator to gate which inline `<code>`
 * command spans become clickable — the strict known-list gate, not a
 * loose regex.
 *
 * [L02] — the catalog is read through `useSyncExternalStore`. The predicate
 * identity is memoized on the catalog array (stable between store changes,
 * so unrelated metadata updates don't rebuild the set); a catalog change
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
    const set = new Set<string>();
    for (const cmd of catalog) set.add(cmd.name);
    for (const cmd of LOCAL_SLASH_COMMANDS) set.add(cmd.name);
    return (name: string) => set.has(name);
  }, [catalog]);
}

/**
 * Assemble the transcript's {@link AnnotationContext} — the live inputs
 * the annotator needs beyond the DOM it walks. Handed to every markdown
 * surface in the transcript; a surface that renders markdown *outside*
 * the transcript passes none and gets the state-free entity kinds only.
 *
 * The context object's identity is deliberately **stable across verdict
 * arrivals**. Identity changes only when a real input changes — the
 * command catalog, the session cwd, the project binding — which is the
 * everything-must-re-mark case, and those changes are rare and bounded.
 * Verdicts instead travel through `context.subscribe` (a coalescing
 * {@link VerdictBatcher} over the three resolver stores), so an answer
 * about one path re-marks only the containers still awaiting one and
 * never re-renders the transcript. Folding resolver versions into the
 * memo here is the mistake that once re-annotated *and re-rendered* every
 * block per answer; nothing here reads a version.
 */
export function useAnnotationContext(
  sessionMetadataStore: SessionMetadataStore | undefined,
): AnnotationContext {
  const isKnownSlashCommand = useKnownSlashCommand(sessionMetadataStore);
  const cwd = useSyncExternalStore(
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
  const projectDir = binding?.projectDir ?? null;
  const workspaceKey = binding?.workspaceKey ?? null;
  const names = fileNameResolverFor(projectDir, workspaceKey);
  const commits = commitResolverFor(projectDir, workspaceKey);
  const resolvePath = useMemo(
    () => makeReferenceResolver({ paths: pathResolutionStore, names, cwd }),
    [names, cwd],
  );
  const resolveCommit = useMemo(
    () => (sha: string) => commits?.lookup(sha) ?? NO_COMMIT_VERDICT,
    [commits],
  );
  // Verdicts arrive asynchronously, long after the ink they belong to was
  // painted. They travel as batched notifications, not as context
  // identity: consumers subscribe and re-mark only the containers still
  // awaiting an answer. The batcher attaches to the stores lazily, so it
  // needs no effect-cleanup of its own — the last consumer's unsubscribe
  // detaches it.
  const subscribe = useMemo(() => {
    // The citation store joins the batcher for the same reason the path store
    // does: a session verdict arriving is what turns a reserved run into a
    // citation, and without it here the run would stay reserved forever.
    const sources = [
      pathResolutionStore,
      sessionCitationStore,
      names,
      commits,
    ].filter((source): source is NonNullable<typeof source> => source !== null);
    return new VerdictBatcher(sources).subscribe;
  }, [names, commits]);
  // The same two roots the path resolver counts from, handed on for the
  // atoms the row carries: an `@` mention's value is project-relative, and
  // without a root it names nothing a menu item could act on. Memoized so a
  // consumer can hang an effect on it — both roots arrive after mount, and
  // an atom annotated on the pass that first has one must not be re-stamped
  // on every render after.
  const atomPathRoots = useMemo(
    () => ({ projectDir, cwd }),
    [projectDir, cwd],
  );
  return useMemo(
    () => ({
      isKnownSlashCommand,
      resolvePath,
      resolveCommit,
      // Parity cuts both ways: a session spelled in assistant prose is the
      // same reference it is in a Overview post, and gets the same chip.
      resolveSession: resolveSessionRef,
      commitRoot: projectDir,
      atomPathRoots,
      subscribe,
    }),
    [
      isKnownSlashCommand,
      resolvePath,
      resolveCommit,
      projectDir,
      atomPathRoots,
      subscribe,
    ],
  );
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
 * Resolve a live selection within the cell body to markdown. Returns
 * `null` when nothing copyable was touched (the hook then falls back to
 * plain text as a last-resort guard). The assistant cell supplies a
 * resolver that reconstructs markdown across the row's blocks ([P03]);
 * the user cell omits it and copies plain text.
 */
export type CopyMarkdownResolver = (
  bodyEl: HTMLElement,
  selection: Selection,
) => string | null;

/**
 * Write a copied selection to the clipboard in both flavors ([P05]):
 * `text/plain` (markdown for plain paste targets) and, when an HTML
 * rendering is available, `text/html` (rich paste targets). Built and
 * issued synchronously inside the copy gesture so transient activation
 * still holds. Degrades to `writeText` when `ClipboardItem` / async
 * `clipboard.write` is unavailable or the dual-format write rejects, so
 * copy never silently produces nothing ([P07]).
 */
function writeCopyClipboard(
  plain: string,
  html: string | null,
  origin: string | null,
): void {
  // Inside Tug.app the native bridge is the only write that can carry the
  // sidecar — WebKit's pasteboard normalization swallows custom types, which
  // is the whole reason the bridge exists — so a copy with provenance goes
  // that way, carrying its html flavor along rather than losing it.
  if (origin !== null && hasNativeClipboardBridge()) {
    const sidecar = withClipboardOrigins(null, plain, origin);
    if (
      sidecar !== null &&
      writeClipboardViaNative(plain, JSON.stringify(sidecar), html ?? undefined)
    ) {
      return;
    }
  }
  const clip = navigator.clipboard;
  if (clip === undefined || clip === null) return;
  if (
    html !== null &&
    typeof ClipboardItem !== "undefined" &&
    typeof clip.write === "function"
  ) {
    try {
      const item = new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      });
      void clip.write([item]).catch(() => {
        void clip.writeText?.(plain);
      });
      return;
    } catch {
      // ClipboardItem construction or write threw synchronously —
      // fall through to the plain-text path below.
    }
  }
  void clip.writeText?.(plain);
}

/**
 * Escape the five HTML metacharacters so a command string can be embedded
 * in the `text/html` clipboard flavor as `<code>…</code>` without a stray
 * `<` or `&` in the command corrupting the markup.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

/** What a transcript cell hands its context menu. */
export interface TranscriptCellMenuOptions {
  /**
   * Reconstructs markdown for the cell's current selection. Omitted by the
   * user row, which is plain text by design.
   */
  resolveCopyMarkdown?: CopyMarkdownResolver;
  /**
   * The session whose prompt an annotation's Insert into Prompt item
   * seeds. Omitted by a fixture with no live session; the item is then not
   * offered.
   */
  codeSessionStore?: CodeSessionStore;
}

// Exported for the copy-wiring app-test fixture (`gallery-transcript-copy`),
// which mounts this exact hook over a static body so `just app-test` drives
// the real ⌘C / menu-Copy path. Not part of the card's public API otherwise.
export function useTranscriptCellMenu({
  resolveCopyMarkdown,
  codeSessionStore,
}: TranscriptCellMenuOptions = {}): {
  ResponderScope: React.FC<{ children: React.ReactNode }>;
  cellProps: TranscriptCellProps;
  bodyRef: React.MutableRefObject<HTMLElement | null>;
  menu: React.ReactNode;
} {
  const bodyRef = useRef<HTMLElement | null>(null);
  const adapterRef = useRef<TextSelectionAdapter | null>(null);
  // Insert into Prompt brings the annotation's own card forward before
  // it types into it. Both come from context rather than props: every
  // transcript cell already renders inside the deck and its card host, so
  // threading them down through the cell tree would be ceremony.
  const deck = useDeckManager();
  const cardId = useCardId();
  // Live-ref the resolver ([L07]) so `handleCopy` keeps a stable
  // identity while always invoking the latest closure (which captures
  // the current messages / store).
  const resolveCopyRef = useRef(resolveCopyMarkdown);
  resolveCopyRef.current = resolveCopyMarkdown;

  // The annotation the current right-click landed on, sampled by
  // `extraEntries` at menu-open time and read by the menu's handlers when
  // the user picks an item. `null` when the right-click missed every
  // annotation. Reading the annotation's own payload (not the DOM
  // selection) is what makes a Copy copy the WHOLE value regardless of any
  // sub-word WebKit smart-selected on the right-click. Menu-only: no
  // keyboard path reads it, and every menu open refreshes it, so there is
  // no stale-value risk.
  const contextAnnotationRef = useRef<AnnotationPayload | null>(null);

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
  } | null => {
    const sel = window.getSelection();
    if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null;
    // Reconstruct markdown for the selection ([P03] — no plain-text
    // fallback for the markdown path). The plain-text branch is only a
    // last-resort guard for an unexpected DOM shape or a cell with no
    // resolver (the user row).
    const body = bodyRef.current;
    const resolve = resolveCopyRef.current;
    let text: string | null = null;
    if (body !== null && resolve !== undefined) {
      try {
        text = resolve(body, sel);
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
    return { text, html };
  }, []);

  const handleCopy = useCallback((): ActionHandlerResult => {
    const copy = reconstructCopy();
    if (copy === null) return;
    writeCopyClipboard(
      copy.text,
      copy.html,
      clipboardOriginFor(bodyRef.current),
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
      if (origin !== null && hasNativeClipboardBridge()) {
        const sidecar = withClipboardOrigins(null, copy.text, origin);
        if (
          sidecar !== null &&
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

  // Copy the right-clicked command, code formatting preserved: the
  // `text/plain` flavor is the command wrapped in Markdown backticks and
  // the `text/html` flavor is a `<code>` element — mirroring how a copied
  // transcript selection carries markdown + rendered HTML ([P05]). Reads
  // the whole command from the annotation sampled at menu-open time, so it
  // never narrows to a smart-selected sub-word. Synchronous (no
  // continuation) so the clipboard write stays inside the activation
  // gesture, like `handleCopy`.
  const handleCopyCommand = useCallback((): ActionHandlerResult => {
    const cmd = sampledAnnotationValue(contextAnnotationRef.current);
    if (cmd === null) return;
    writeCopyClipboard(
      "`" + cmd + "`",
      `<code>${escapeHtml(cmd)}</code>`,
      clipboardOriginFor(bodyRef.current),
    );
  }, []);

  // Copy the right-clicked command as bare text — no backticks, no
  // `text/html` flavor — the terminal-paste-friendly variant.
  const handleCopyCommandPlain = useCallback((): ActionHandlerResult => {
    const cmd = sampledAnnotationValue(contextAnnotationRef.current);
    if (cmd === null) return;
    writeCopyClipboard(cmd, null, clipboardOriginFor(bodyRef.current));
  }, []);

  // Copy the right-clicked annotation's canonical value as bare text — the
  // URL, the address, the path. The kinds that route here have no code
  // formatting to preserve, so there is no `text/html` flavor.
  const handleCopyAnnotationValue = useCallback((): ActionHandlerResult => {
    const value = sampledAnnotationValue(contextAnnotationRef.current);
    if (value === null) return;
    writeCopyClipboard(value, null, clipboardOriginFor(bodyRef.current));
  }, []);

  // Send the right-clicked annotation back into the conversation. Brings
  // the card forward first, so the prompt it lands in is the one the user
  // is looking at. Returns a continuation so the insert happens after the
  // menu's activation blink, like Select All — the prompt takes the
  // caret, and doing that mid-blink fights the menu's own teardown.
  //
  // A file goes in as an object: the same chip an `@` mention mints,
  // carrying the canonical path as its value, so the prompt treats it as
  // one thing to move, delete, or send rather than as a run of path
  // characters. A cited line is deliberately dropped — an atom names a
  // file, and `path:line` is not one. Every other kind goes in as its text.
  const handleInsertIntoPrompt = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    if (payload === null || codeSessionStore === undefined) return;
    if (payload.kind === "file-path") {
      const segment: AtomSegment = {
        kind: "atom",
        type: "file",
        // The chip reads as a filename and carries the whole path
        // underneath — the same split every other file chip in the app
        // makes, and the reason one fits on a prompt line at all.
        label: formatAtomLabel(payload.path, "filename"),
        value: payload.path,
      };
      return () => {
        if (cardId !== null) deck.activateCard(cardId);
        codeSessionStore.insertAtomDraft(segment);
      };
    }
    const value = sampledAnnotationValue(payload);
    if (value === null) return;
    return () => {
      if (cardId !== null) deck.activateCard(cardId);
      codeSessionStore.insertJot(value, null);
    };
  }, [cardId, codeSessionStore, deck]);

  // Show in Finder for the right-clicked file annotation: the path comes
  // from the annotation sampled at menu-open time. Open in Editor is NOT
  // here — `open-file` is a chain-routed command the deck implements, and
  // a handler on this cell would intercept every dispatch that reaches it
  // (a click on a file reference among them) to answer one it can only
  // service after a right-click. Its menu item carries the target as its
  // own value instead, so it walks past this cell to the deck.
  const handleRevealAnnotatedFile = useCallback((): ActionHandlerResult => {
    const payload = contextAnnotationRef.current;
    // Revealing a file opens the folder around it; a directory is already
    // that folder, so the two take different routes to the same gesture.
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

  const responderId = useId();
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.COPY]: handleCopy,
      [TUG_ACTIONS.COPY_COMMAND]: handleCopyCommand,
      [TUG_ACTIONS.COPY_COMMAND_AS_PLAIN_TEXT]: handleCopyCommandPlain,
      [TUG_ACTIONS.COPY_ANNOTATION_VALUE]: handleCopyAnnotationValue,
      [TUG_ACTIONS.INSERT_INTO_PROMPT]: handleInsertIntoPrompt,
      [TUG_ACTIONS.REVEAL_IN_FINDER]: handleRevealAnnotatedFile,
      [TUG_ACTIONS.OPEN_IMAGE_PREVIEW]: handleOpenImagePreview,
      [TUG_ACTIONS.OPEN_DIFF]: handleOpenAnnotatedDiff,
      [TUG_ACTIONS.SELECT_ALL]: handleSelectAll,
    },
  });

  // A right-click on an annotation samples its payload and offers the
  // items its kind registers. Whether those items replace the standard
  // text-menu block or sit below it is the kind's call
  // (`suppressStandardItems`): a command replaces it, because a
  // selection-scoped Copy beside Copy-the-command would copy whatever
  // sub-word the browser smart-selected; a kind whose items don't collide
  // appends, so a right-click inside a selection keeps Copy / Select All.
  const extraEntries = useCallback(
    (event: MouseEvent): TugEditorContextMenuEntry[] => {
      const hit = annotationFromEvent(event);
      contextAnnotationRef.current = hit?.payload ?? null;
      if (hit === null) return [];
      const entries =
        annotationEntryFor(hit.payload.kind)?.menuEntries(hit.payload) ?? [];
      // A surface with no live session can't seed a prompt, so it doesn't
      // offer to.
      return codeSessionStore === undefined
        ? entries.filter((e) => e.action !== TUG_ACTIONS.INSERT_INTO_PROMPT)
        : entries;
    },
    [codeSessionStore],
  );

  const hideStandardItems = useCallback((event: MouseEvent): boolean => {
    const hit = annotationFromEvent(event);
    if (hit === null) return false;
    return annotationEntryFor(hit.payload.kind)?.suppressStandardItems ?? false;
  }, []);

  // A secondary click on a whole-entity annotation (a command) keeps its
  // hands off the selection: the browser would smart-select a sub-word, and
  // every item the menu is about to show acts on the entire command.
  const suppressSelectionChange = useCallback((event: MouseEvent): boolean => {
    const hit = annotationFromEvent(event);
    if (hit === null) return false;
    return annotationEntryFor(hit.payload.kind)?.wholeEntitySelection ?? false;
  }, []);

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
    extraEntries,
    hideStandardItems,
    suppressSelectionChange,
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
