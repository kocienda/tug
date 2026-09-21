/**
 * TextCard — the Text card body: open a text file from disk, edit it in
 * a `TugTextCardEditor`, and save it in one of two modes.
 *
 * Save modes (from the deck-wide `save-mode` default, resolved by the
 * store): **manual** — the classic document model, with dirty state, a
 * crash-safety set-aside record, explicit Save / Save As… / Save a Copy… /
 * Revert / Reload, and a close guard that prompts when the buffer is dirty;
 * **automatic** — live autosave-in-place with no dirty state, where closing
 * is always safe. The card bag persists positions only
 * (`{ path, anchor, scrollTop }`); content comes from disk (or the aside)
 * on restore.
 *
 * Body states, rendered from the store snapshot:
 *
 *   - `empty`   — a `TugFileChooser` open surface (type a path, or the
 *     native Browse picker); Enter / Open binds the card to the path.
 *   - `loading` — quiet placeholder while the first read is in flight.
 *   - `ready`   — the editor. Mounted ONCE per file binding and kept
 *     mounted across every autosave sub-state (clean / editing /
 *     writing / conflict) — the conflict banner renders ALONGSIDE the
 *     editor, never in its place, so scroll, selection, and the undo
 *     stack survive the moment the user must choose ([L26]: one
 *     component, stable key/type/renderer across the transition).
 *   - `error`   — read failure detail with a Try Again affordance.
 *
 * Conflict UX: automatic mode renders a card-scoped `TugPaneBanner`
 * (error variant) whose footer buttons drive `store.resolveConflict` —
 * "Reload from disk" replaces the buffer, "Keep mine" re-issues the write
 * against the disk hash the conflict reported. Manual mode raises the modal
 * save sheets (see `text-card-save-sheets`) for external-change,
 * missing-file, revert, reload, and open-time aside conflicts. Either way
 * the buffer is preserved until the user chooses.
 *
 * Read-only files: the store never arms autosave and the editor
 * mounts read-only; the title shows a lock suffix.
 *
 * Laws: [L02] all rendering from the store via `useSyncExternalStore`;
 * [L03] lifecycle registrations in `useLayoutEffect`; [L06] no React
 * state for appearance; [L09]/[L10] the card supplies content only —
 * pane owns geometry/chrome; [L23]/[L26] see body-state notes above.
 *
 * @module components/tugways/cards/text-card
 */

import "./text-card.css";

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { TextCardStore, type FilePositions } from "@/lib/text-card-store";
import { saveText } from "@/lib/text-card-save-text";
import { cardTitleStore } from "@/lib/card-title-store";
import {
  paneTitleBarItemsStore,
  type PaneTitleBarItem,
} from "@/lib/pane-title-bar-items-store";
import {
  notifyOpenTextCardsChanged,
  registerOpenTextCard,
  unregisterOpenTextCard,
} from "@/lib/text-card-open-registry";
import { registerCardCloseGuard } from "@/lib/card-close-guard";
import {
  publishFileMenuState,
  clearFileMenuState,
} from "@/lib/host-menu-state";
import { readSaveMode } from "@/lib/open-file-in-card";
import { reserveUntitledNumber } from "@/lib/untitled-naming";
import { noteRecentDocument } from "@/lib/recent-documents";
import { openPathInOS } from "@/lib/os-open";
import { useTugSheet } from "@/components/tugways/tug-sheet";
import { useFileSaveSheets } from "./text-card-save-sheets";
import type { CompareSheetChoice } from "./text-card-save-sheets";
import { buildTwoTextDiffPayload } from "@/lib/diff/two-text-diff";

import { TugTextCardEditor, type TugTextCardEditorDelegate } from "../tug-text-card-editor";
import { AssetProjection } from "@/lib/asset-projection";
import { removeAssetWithUndo } from "../tug-text-card-editor/asset-trash";
import { TugAttachmentPreview } from "./tug-attachment-preview";
import { TugFileChooser } from "../tug-file-chooser";
import { TugPaneBanner } from "../tug-pane-banner";
import { TugPushButton } from "../tug-push-button";
import {
  TextCardFindBar,
  type TextCardFindBarHandle,
} from "./text-card-find-bar";
import { TugLabel } from "../tug-label";
import { presentCardSettingsSheet } from "./card-settings-sheet";
import { TextCardStatusBar } from "./text-card-status-bar";
import { useTextCardSettings } from "@/lib/use-text-card-settings";
import { EditorStatsStore } from "@/lib/editor-stats-store";
import {
  extensionForLanguageId,
  languageIdForPath,
} from "@/lib/language-registry";
import type { LineEnding } from "@/lib/text-card-store";
import { isPathPickerAvailable, pickPath } from "@/lib/native-path-picker";
import {
  useCardId,
  useCardStatePreservation,
} from "../use-card-state-preservation";
import { useResponderChain } from "../responder-chain-provider";
import { useResponder } from "../use-responder";
import { useFocusManager } from "../use-focusable";
import { useCycleMode } from "../use-cycle-mode";
import { useCardDelegate, useCardLifecycle } from "@/lib/card-lifecycle";
import { TUG_ACTIONS } from "../action-vocabulary";
import { getDeckStore } from "@/lib/deck-store-registry";
import { openAttachmentPath } from "@/lib/open-attachment";

// ---------------------------------------------------------------------------
// Keyboard-focus cycle ([P09]/[P10])
// ---------------------------------------------------------------------------

/**
 * The Text card's cycle stops all register in one group. `CycleScope` keys the
 * group into this card's own focus mode, so two Text cards on screen never
 * share a walk.
 */
const TEXT_CARD_CYCLE_GROUP = "text-card-cycle";

/**
 * The find bar's four consecutive stops — query field, the two navigation
 * arrows, the options control ([D122]) — walked before the status strip
 * because the bar sits above it: the walk reads the card downward from the
 * editor, the same order the Session card teaches (find 8…11, status 12…16).
 */
const TEXT_CARD_CYCLE_ORDER_FIND_BASE = 4;
/** The status strip's line-ending popup; the file-type popup takes the next slot. */
const TEXT_CARD_CYCLE_ORDER_LINE_ENDING = 8;
/**
 * The editor is LAST, matching the Session card. The lowest order in a group
 * is the engine's seed seat when the group's membership changes, and this
 * editor is a responder with a focus CONTRACT — a seed landing on it GRANTS
 * real DOM focus rather than merely ringing ([P06] `grantTextSurface`), so a
 * ring-only stop holds that seat instead.
 *
 * ⌥⇥ still rings the editor when the caret is in it: entering a mode keeps the
 * key view where the keyboard already is rather than seeding
 * (`enterModeAtKeyView`), and that landing is a movement, so the stop parks.
 */
const TEXT_CARD_CYCLE_ORDER_EDITOR = 19;

// ---------------------------------------------------------------------------
// Bag payload
// ---------------------------------------------------------------------------

/** Positions-only persistence payload — never file content. */
export interface TextCardBagContent {
  /** Bound file path; null for an untitled draft. */
  path: string | null;
  /** Draft id for an untitled buffer (content autosaves under the
   * drafts directory); null for a path-bound card. */
  draftId: string | null;
  /** True when the buffer is a manual-mode untitled buffer —
   * restore re-enters `openUntitled` and finds the aside. */
  untitled: boolean;
  /** Session number behind the untitled name ("Untitled-2", …); null
   * for a titled card or a legacy bag. */
  untitledNumber: number | null;
  /** Selection anchor (fixed end). */
  anchor: { line: number; ch: number };
  /** Selection head (caret / moving end). Absent in a legacy bag →
   * restore collapses to `anchor`. */
  head?: { line: number; ch: number };
  scrollTop: number;
  /**
   * A one-time reveal target for a fresh open-from-click (a tool-call
   * file-ref): on first bind the card reveals + flashes this passage
   * instead of silently restoring a viewport. Never written by the
   * persistence save path — only the open seed carries it.
   */
  revealOnOpen?: {
    line: number;
    endLine?: number;
    columns?: readonly [number, number];
  };
}

/** Narrow an unknown `{ line, ch }` pair, or undefined. */
function coerceLineCh(
  value: unknown,
): { line: number; ch: number } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.line !== "number" || typeof obj.ch !== "number") {
    return undefined;
  }
  return { line: obj.line, ch: obj.ch };
}

/** Narrow an unknown restored bag payload. */
function coerceBagContent(state: unknown): TextCardBagContent | null {
  if (state === null || typeof state !== "object") return null;
  const obj = state as Record<string, unknown>;
  const path = typeof obj.path === "string" ? obj.path : null;
  const draftId = typeof obj.draftId === "string" ? obj.draftId : null;
  if (path === null && draftId === null) return null;
  const anchor = coerceLineCh(obj.anchor) ?? { line: 1, ch: 0 };
  return {
    path,
    draftId,
    untitled: obj.untitled === true,
    untitledNumber:
      typeof obj.untitledNumber === "number" ? obj.untitledNumber : null,
    anchor,
    head: coerceLineCh(obj.head),
    scrollTop: typeof obj.scrollTop === "number" ? obj.scrollTop : 0,
    revealOnOpen: coerceRevealOnOpen(obj.revealOnOpen),
  };
}

/** Narrow an unknown `{ line, endLine?, columns? }` reveal target, or
 *  undefined. */
function coerceRevealOnOpen(
  value: unknown,
):
  | { line: number; endLine?: number; columns?: readonly [number, number] }
  | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.line !== "number") return undefined;
  const raw = obj.columns;
  const columns =
    Array.isArray(raw) && typeof raw[0] === "number" && typeof raw[1] === "number"
      ? ([raw[0], raw[1]] as const)
      : undefined;
  return {
    line: obj.line,
    endLine: typeof obj.endLine === "number" ? obj.endLine : undefined,
    columns,
  };
}

/**
 * The masthead's second line for a buffer that is not a file yet — the
 * stand-in rung of the document description ladder ([D132]). A draft does sit
 * on disk, under the Tug drafts directory, but not anywhere the reader put it,
 * and the line's question is where the document LIVES.
 *
 * Two words, in the slot's own terms. The line holds a PATH once there is one,
 * so its stand-in answers the same question a path answers rather than
 * restating the save state the line below it already carries — "Not saved to a
 * file" over "Draft" said one thing twice, in a sentence where the rest of the
 * ladder shows a place. The tier tells the two apart by TYPE: a stand-in is
 * italic where a real path is not.
 */
const UNNAMED_PLACE = "No file";

// ---------------------------------------------------------------------------
// Human-readable error copy
// ---------------------------------------------------------------------------

function describeReadError(kind: string, size?: number): string {
  switch (kind) {
    case "not_found":
      return "The file does not exist.";
    case "denied":
      return "Tug can't open this file (permission refused or a protected file type).";
    case "binary":
      return "This file isn't text — binary content can't be edited here.";
    case "too_large":
      return `This file is too large to edit here${
        size !== undefined ? ` (${Math.round(size / (1024 * 1024))} MB)` : ""
      }.`;
    case "bad_path":
      return "That path isn't a file Tug can open.";
    case "network":
      return "Tug couldn't reach its file service.";
    default:
      return "The file couldn't be opened.";
  }
}

// ---------------------------------------------------------------------------
// TextCardContent
// ---------------------------------------------------------------------------

export function TextCardContent({ cardId }: { cardId: string }) {
  // One autosave engine per mounted card body. Disk is authoritative
  // and positions ride the bag, so recreating the store on a cold
  // remount is cheap — it re-reads the file.
  const [store] = useState(() => new TextCardStore({ saveMode: readSaveMode() }));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const isManual = snapshot.saveMode === "manual";
  const isDirty = snapshot.saveState !== "clean";
  // Bound to a file the USER chose. An untitled buffer has a path too, but
  // it is a drafts-directory name nobody typed and nothing outside this card
  // should be shown it.
  const isBoundFile = snapshot.path !== null && snapshot.draftId === null;
  const editorRef = useRef<TugTextCardEditorDelegate | null>(null);
  const manager = useResponderChain();
  const cardLifecycle = useCardLifecycle();
  const focusManager = useFocusManager();
  const senderId = useId();

  // Pane-modal sheet host for the manual save/close/conflict sheets.
  // `renderSheet()` is mounted once in the card body.
  const { showSheet, renderSheet } = useTugSheet();
  const sheets = useFileSaveSheets(showSheet);

  // Card-local editor settings, seeded from the deck-wide Text Card
  // defaults on first open, then owned by this card ([D07] pattern).
  const { settings: editorSettings, setSetting } = useTextCardSettings(cardId);

  // The attachment strip, derived from the buffer's own text ([P01]). One
  // instance per card, disposed with it; the editor feeds it the text source
  // and the asset base, and it publishes the tiles below.
  const [assetProjection] = useState(() => new AssetProjection());
  useEffect(() => () => assetProjection.dispose(), [assetProjection]);
  const assetTiles = useSyncExternalStore(
    assetProjection.subscribe,
    assetProjection.getSnapshot,
    assetProjection.getSnapshot,
  );
  const assetAtoms = useSyncExternalStore(
    assetProjection.subscribe,
    assetProjection.getAtoms,
    assetProjection.getAtoms,
  );
  // The responder's action map is built once; the ✕ resolves its tile through
  // this rather than through a captured array ([L07]).
  const assetTilesRef = useRef(assetTiles);
  assetTilesRef.current = assetTiles;

  // Live editor stats (caret + counts) for the bottom status bar. The
  // editor writes it; the status bar reads it — so keystroke-rate
  // updates repaint only the strip, not the editor.
  const [statsStore] = useState(() => new EditorStatsStore());

  // Card-local syntax override from the status-bar file-type popup;
  // null = follow the file's extension. Reset when the card rebinds to
  // a different file (Move To…), so a new file starts on auto-detect.
  const [languageOverrideId, setLanguageOverrideId] = useState<string | null>(
    null,
  );
  useLayoutEffect(() => {
    setLanguageOverrideId(null);
  }, [snapshot.path]);
  const effectiveLanguageId =
    languageOverrideId ?? languageIdForPath(snapshot.path);
  const effectiveLanguageExt = extensionForLanguageId(effectiveLanguageId);

  // Status-bar line-ending popup: the store owns the on-disk newline
  // representation (applied at the write boundary) and re-serializes.
  const setLineEnding = useCallback(
    (ending: LineEnding) => store.setLineEnding(ending),
    [store],
  );

  // Chooser input value (empty state only). Controlled-input local
  // data; the committed value is the store's `path` binding.
  const [chooserValue, setChooserValue] = useState("");

  // Find bar: open/closed is structural (the bar mounts/unmounts below the
  // editor); the query, options, and count live inside `TextCardFindBar`,
  // which drives the editor's CM6 search through the delegate.
  const [findOpen, setFindOpen] = useState(false);
  const findBarRef = useRef<TextCardFindBarHandle | null>(null);
  // Root element — the shared wrap overlay's containment box.
  const cardRootRef = useRef<HTMLDivElement | null>(null);

  // ⌘E's seed, handed to a bar that does not exist yet: the bar mounts on the
  // render `setFindOpen` schedules, and reads this as its `initialQuery` then.
  // A ref, not state, because nothing renders FROM it — the bar's CM6 doc owns
  // the query the moment it is up ([L24] structure zone).
  const findSeedRef = useRef("");

  const openFindBar = useCallback(() => {
    // Fresh bar: it focuses its own field on mount. Already open: ⌘F must
    // still land the caret in the query field, unconditionally.
    findSeedRef.current = "";
    setFindOpen(true);
    findBarRef.current?.focusQuery();
  }, []);

  // ⌘E — the editor's selection becomes the query and the search runs. Not a
  // toggle: an open bar is re-seeded in place, because "search for this" can
  // never mean "stop searching". The editor supplies the text (it owns the
  // selection) and gates the command; the card owns the bar.
  const findSelection = useCallback((query: string) => {
    // The bar's own ref answers "is it up?" without a second flag to keep
    // honest — React nulls it on unmount, which is exactly when the bar is
    // gone and the seed path is the right one.
    if (findBarRef.current !== null) {
      findBarRef.current.setQuery(query);
      return;
    }
    findSeedRef.current = query;
    setFindOpen(true);
  }, []);

  const closeFindBar = useCallback(() => {
    setFindOpen(false);
    editorRef.current?.clearSearch();
    editorRef.current?.focus();
  }, []);

  // Positions restored from the bag before the editor exists; applied
  // once the file binds and the editor attaches.
  const pendingPositionsRef = useRef<FilePositions | null>(null);
  // A one-time reveal target (open-from-click) applied once the file
  // binds — it reveals + flashes the passage instead of restoring a
  // viewport. Takes precedence over `pendingPositionsRef`.
  const pendingRevealRef = useRef<{
    line: number;
    endLine?: number;
    columns?: readonly [number, number];
  } | null>(
    null,
  );

  const openPath = useCallback(
    (path: string) => {
      const trimmed = path.trim();
      if (trimmed === "") return;
      void store.openPath(trimmed);
    },
    [store],
  );

  // Move To… / Save As… — NSSavePanel chooses the new path; the store
  // re-anchors the buffer there (and GCs the old draft). Resolves whether
  // a path was chosen and written (the close guard awaits it).
  const runSaveAsPanel = useCallback(async (): Promise<boolean> => {
    const snap = store.getSnapshot();
    const initial = snap.draftId !== null ? undefined : (snap.path ?? undefined);
    // Untitled buffer: seed the panel with its session name ("Untitled-2").
    const suggested =
      snap.untitled && snap.fileName !== null ? snap.fileName : undefined;
    const newPath = await pickPath("save", initial, suggested);
    if (newPath === null) return false;
    // Report the real write outcome — not merely "a path was picked" — so
    // the close guard only proceeds to destroy the card when the buffer
    // actually reached disk. A swallowed failure here is silent data loss.
    const ok = (await store.saveAs(newPath)) === "ok";
    // A successful Save As creates (and binds) a document — a recent.
    if (ok) noteRecentDocument(newPath);
    return ok;
  }, [store]);
  const saveAs = useCallback(() => {
    void runSaveAsPanel();
  }, [runSaveAsPanel]);

  // Reveal the bound file in the Finder (path click) — opens Finder with
  // the file itself selected inside its folder, not merely the folder.
  const revealInFinder = useCallback(() => {
    const path = store.getSnapshot().path;
    if (path === null) return;
    openPathInOS(path, "reveal");
  }, [store]);

  // Save a Copy… — write the buffer elsewhere without rebinding or
  // clearing the dirty bit.
  const runSaveACopy = useCallback(async () => {
    const newPath = await pickPath("save", store.getSnapshot().path ?? undefined);
    if (newPath === null) return;
    await store.saveACopy(newPath);
  }, [store]);

  // Save (⌘S / File ▸ Save) — manual explicit save; an untitled buffer
  // routes through the save panel.
  const doSave = useCallback(async (): Promise<boolean> => {
    const result = await store.save();
    if (result === "needs-path") return runSaveAsPanel();
    // conflict / missing → the presentation effect raises the sheet.
    return result === "ok";
  }, [store, runSaveAsPanel]);

  // Revert to Saved — confirm, then discard edits back to disk.
  const doRevert = useCallback(async () => {
    const ok = await sheets.presentRevertSheet(
      store.getSnapshot().fileName ?? "Untitled",
    );
    if (ok) await store.revertToSaved();
  }, [store, sheets]);

  // Reload from Disk — confirm only while dirty; a clean buffer reloads
  // without a sheet.
  const doReload = useCallback(async () => {
    const snap = store.getSnapshot();
    if (snap.saveState === "clean") {
      await store.reloadFromDisk();
      return;
    }
    const ok = await sheets.presentReloadSheet(snap.fileName ?? "Untitled");
    if (ok) await store.reloadFromDisk();
  }, [store, sheets]);

  // Single dispatcher wired to the editor's save-verb chain actions.
  const onSaveCommand = useCallback(
    (
      command:
        | "save"
        | "save-as"
        | "save-a-copy"
        | "revert-to-saved"
        | "reload-from-disk",
    ) => {
      switch (command) {
        case "save":
          void doSave();
          break;
        case "save-as":
          void runSaveAsPanel();
          break;
        case "save-a-copy":
          void runSaveACopy();
          break;
        case "revert-to-saved":
          void doRevert();
          break;
        case "reload-from-disk":
          void doReload();
          break;
      }
    },
    [doSave, runSaveAsPanel, runSaveACopy, doRevert, doReload],
  );

  // ---- Focus destination reclaim ([P20], focus-language.md) ----
  //
  // A title-bar interaction (a reposition drag, or even a zero-move click)
  // promotes the pane as first responder and fires `cardDidMove`. Without
  // restoring the card's focus destination, the editor is no longer the
  // first responder, and every first-responder-routed accelerator —
  // notably ⌘S `save` — walks up from the wrong node and misses the
  // editor's handler. Re-assert the destination through the sanctioned
  // gate: an open card-modal sheet keeps its key view (`adoptKeyCard`),
  // otherwise focus the editor (which re-promotes it via `focusin`). This
  // is the same reclaim the Session card runs; it is what keeps
  // `sendToFirstResponder` reliable across moves.
  const reclaimFocusDestination = useCallback((): void => {
    if (cardLifecycle?.getFirstResponderCardId() !== cardId) return;
    if (focusManager?.adoptKeyCard(cardId) === true) return;
    // `focusResponder`, not a bare `editor.focus()`: it promotes the editor
    // to first responder BEFORE focusing, so it repairs the case where the
    // editor still holds DOM focus but the chain first responder was pulled
    // onto the pane by a title-bar drag (a bare focus() would no-op).
    const editorResponderId = editorRef.current?.responderId();
    if (editorResponderId !== undefined && manager) {
      manager.focusResponder(editorResponderId);
    } else {
      editorRef.current?.focus();
    }
  }, [cardLifecycle, focusManager, cardId, manager]);

  useCardDelegate(cardId, {
    // `cardDidActivate` is deliberately a no-op — the SAME shape as the Dev
    // card. Activation focus for an em card rides the framework single
    // channel, not a delegate reclaim: `applyBagFocus` resolves this card to
    // its registered engine hook and calls
    // `invokeEnginePaintMirrorAsActive`, whose `paintMirrorAsActive` focuses
    // the CM6 view (`tug-text-card-editor.tsx`); the resulting `focusin`
    // promotes the editor's responder ([P21] content half). A late editor
    // bind (Open Quickly's create-before-mount) is covered by the same
    // channel: registering the engine hook bumps the engine-hooks version,
    // and `CardHost`'s `subscribeEngineHooksChange` retry re-runs
    // `applyBagFocus`. A `cardDidActivate` reclaim here would only duplicate
    // that claim — and, draining AFTER the framework's single-channel claim,
    // risk clobbering a framework-axis target ([L05] timing-derived ordering;
    // [L23] single-channel), exactly as the Session card's comment records.
    //
    // `cardDidMove` / `cardDidResize` keep their reclaim: those gestures move
    // the card's DOM identity (cross-pane move) or fire off a title-bar
    // interaction that pulled first responder onto the pane, and re-asserting
    // the editor destination is the recovery path (same as the Session card).
    cardDidMove: () => reclaimFocusDestination(),
    cardDidResize: () => reclaimFocusDestination(),
  });

  // ---- Card state preservation (positions only) ----

  useCardStatePreservation<TextCardBagContent | undefined>({
    onSave: () => {
      // Deactivation is a hard flush point; fire-and-forget with
      // keepalive so the write survives teardown. The bag itself is
      // synchronous — positions only.
      void store.flush({ keepalive: true });
      const snap = store.getSnapshot();
      if (snap.path === null && snap.draftId === null) return undefined;
      const positions = store.snapshotPositions();
      return {
        path: snap.draftId !== null ? null : snap.path,
        draftId: snap.draftId,
        untitled: snap.untitled,
        untitledNumber: snap.untitledNumber,
        anchor: positions?.anchor ?? { line: 1, ch: 0 },
        head: positions?.head,
        scrollTop: positions?.scrollTop ?? 0,
      };
    },
    onRestore: (state) => {
      const content = coerceBagContent(state);
      if (content === null) return;
      if (content.revealOnOpen !== undefined) {
        // A fresh open-from-click seed: reveal + flash the passage once
        // the file binds, rather than restoring a saved viewport.
        pendingRevealRef.current = content.revealOnOpen;
      } else {
        pendingPositionsRef.current = {
          anchor: content.anchor,
          head: content.head,
          scrollTop: content.scrollTop,
        };
      }
      if (content.untitled && content.draftId !== null) {
        // Raise the session floor so a fresh untitled card never reuses
        // this restored number, then rebind under the same name.
        if (content.untitledNumber !== null) {
          reserveUntitledNumber(content.untitledNumber);
        }
        void store.openUntitled(
          content.draftId,
          content.untitledNumber ?? undefined,
        );
      } else if (content.draftId !== null) {
        void store.openDraft(content.draftId);
      } else if (content.path !== null) {
        void store.openPath(content.path);
      }
    },
    onCardActivated: () => {
      // No focus reclaim here: activation focus rides the engine hook via the
      // framework single channel (see the `useCardDelegate` no-op comment).
      // A reclaim at this activation moment would only duplicate that claim.
      // Focus-time recheck, now a BACKSTOP rather than the mechanism: the
      // card watches its own path through FILE_WATCH wherever the file
      // lives, so an external change is caught without anybody activating
      // anything. This rung covers the gap a dropped stream would leave.
      void store.recheckOnActivation();
    },
  });

  // ---- open-file reuse registry ----

  useLayoutEffect(() => {
    registerOpenTextCard(cardId, {
      getPath: () => store.getSnapshot().path,
      getDisplayName: () => store.getSnapshot().fileName,
      isDirty: () => store.getSnapshot().saveState !== "clean",
      hasUnsavedMark: () => {
        const snap = store.getSnapshot();
        return snap.saveMode === "manual" && snap.saveState !== "clean";
      },
      revealLine: (line, endLine, columns) =>
        editorRef.current?.revealLine(line, endLine, columns),
      openFile: (path, line, endLine, columns) => {
        // Reuse this card for a different file: flush the current
        // buffer first (autosave may have pending edits), then open the
        // new path and reveal + flash `line`..`endLine` once it binds
        // via the pending-reveal channel.
        pendingRevealRef.current =
          line === undefined ? null : { line, endLine, columns };
        void store.flush().then(() => store.openPath(path));
      },
    });
    // A fresh card binds its path — and names its buffer — AFTER mount (the
    // async file read / untitled allocation), so registry consumers that
    // project the card (the Cards card Text Files list) must re-read when the path or
    // name lands, not just when the card registers. Notify on every path OR
    // fileName change so the Cards card titles the open row the moment the binding
    // resolves — instead of stranding a nameless row until the next deck
    // re-render.
    // The unsaved mark rides the same channel: the Cards card row paints the dot the
    // card header wears, so it must re-read when the dirty bit sets or clears.
    const unsavedMark = (snap: ReturnType<typeof store.getSnapshot>): boolean =>
      snap.saveMode === "manual" && snap.saveState !== "clean";
    let lastPath = store.getSnapshot().path;
    let lastName = store.getSnapshot().fileName;
    let lastMark = unsavedMark(store.getSnapshot());
    const unsubscribe = store.subscribe(() => {
      const snap = store.getSnapshot();
      const mark = unsavedMark(snap);
      if (snap.path !== lastPath || snap.fileName !== lastName || mark !== lastMark) {
        lastPath = snap.path;
        lastName = snap.fileName;
        lastMark = mark;
        notifyOpenTextCardsChanged();
      }
    });
    return () => {
      unsubscribe();
      unregisterOpenTextCard(cardId);
    };
  }, [cardId, store]);

  // ---- Close guard (manual mode) ----
  //
  // A dirty manual buffer must not die silently. Register in a layout
  // effect ([L03]: a close gesture may fire before a passive effect
  // commits, mirroring the open-file registration above); the release
  // returned by `registerCardCloseGuard` runs on cleanup ([L27]).
  useLayoutEffect(() => {
    if (!isManual) return;
    return registerCardCloseGuard(cardId, {
      // The pane activates this card before running the sheet when the
      // buffer is dirty, so the user decides looking at the content.
      needsDecision: () => store.getSnapshot().saveState !== "clean",
      run: async () => {
        const snap = store.getSnapshot();
        if (snap.saveState === "clean") return "close";
        const choice = await sheets.presentCloseSheet(snap.fileName ?? "Untitled");
        if (choice === "cancel") return "cancel";
        if (choice === "dont-save") {
          await store.discardAside();
          return "close";
        }
        const result = await store.save();
        if (result === "needs-path") {
          return (await runSaveAsPanel()) ? "close" : "cancel";
        }
        return result === "ok" ? "close" : "cancel";
      },
    });
  }, [isManual, cardId, store, sheets, runSaveAsPanel]);

  // ---- The disk-versus-buffer compare sheet ----
  //
  // "This file changed on disk while you were editing" is a claim the user
  // has no way to check, and both resolutions throw one side's work away. So
  // every conflict surface can open the diff, computed HERE from a fresh disk
  // read and the live buffer and thrown away when the sheet closes — it is a
  // view of two texts, not state anything renders from ([L02]).
  //
  // A read that fails, or a card with no editor attached, has nothing to
  // compare: answer `cancel` and leave the conflict surface exactly as it
  // was, rather than showing a diff against a guess.
  const openCompareSheet = useCallback(async (): Promise<CompareSheetChoice> => {
    const fileName = snapshot.fileName ?? "Untitled";
    const disk = await store.readDiskText();
    const buffer = store.getBufferText();
    if (disk === null || buffer === null) return "cancel";
    return sheets.presentCompareSheet(
      fileName,
      buildTwoTextDiffPayload(fileName, disk, buffer),
    );
  }, [snapshot.fileName, store, sheets]);

  // ---- Conflict / missing sheet presentation (manual mode) ----
  //
  // A store `conflict` in manual mode is a modal sheet, not
  // the automatic-mode banner. Single-flight via a ref so a snapshot
  // change while the sheet is up never stacks a second one; Cancel leaves
  // the conflict set (the status-bar badge) without re-prompting.
  const conflictSheetUpRef = useRef(false);
  useLayoutEffect(() => {
    if (!isManual) return;
    const conflict = snapshot.conflict;
    if (conflict === null || conflictSheetUpRef.current) return;
    // A missing verdict raised over a CLEAN buffer had nothing at risk, so it
    // renders as the banner instead — a modal claiming unsaved changes are in
    // danger would be asserting a falsehood. The flag is latched in the store
    // at raise time (Spec S03), so this stays true for the verdict's whole
    // life even after the user starts typing.
    if (conflict.reason === "missing" && conflict.raisedOverCleanBuffer === true) {
      return;
    }
    conflictSheetUpRef.current = true;
    const fileName = snapshot.fileName ?? "Untitled";
    void (async () => {
      if (conflict.reason === "missing") {
        const choice = await sheets.presentMissingSheet(fileName);
        if (choice === "save") {
          // Recreate the deleted file. If another process recreated the
          // path meanwhile, this returns a hash conflict — present it here
          // rather than clobber the reappeared file silently.
          if ((await store.resolveMissing()) === "conflict") {
            // The file came back between the verdict and the Save. Default to
            // reloading it: "Save Anyway" here overwrites whatever reappeared
            // — during a join, that is the joined content.
            const c = await sheets.presentConflictSheet(fileName, {
              defaultChoice: "reload",
            });
            if (c === "save-anyway") await store.resolveConflict("overwrite");
            else if (c === "reload") await store.resolveConflict("reload");
            else if (c === "save-as") await runSaveAsPanel();
          }
        } else if (choice === "save-as") {
          await runSaveAsPanel();
        } else if (choice === "dont-save") {
          // Free the user from the "jail": drop the aside (which also marks
          // the buffer clean, so the close guard won't re-prompt) and close.
          await store.discardAside();
          manager?.sendToTarget(cardId, {
            action: TUG_ACTIONS.CLOSE,
            sender: senderId,
            phase: "discrete",
          });
        }
      } else {
        // The loop is what makes "look, then decide" work: the compare sheet
        // is a detour from the conflict sheet rather than a replacement for
        // it, so cancelling out of the diff comes back to the question.
        for (;;) {
          const choice = await sheets.presentConflictSheet(fileName);
          if (choice === "save-anyway") {
            await store.resolveConflict("overwrite");
          } else if (choice === "reload") {
            await store.resolveConflict("reload");
          } else if (choice === "save-as") {
            await runSaveAsPanel();
          } else if (choice === "diff") {
            const verdict = await openCompareSheet();
            if (verdict === "reload") await store.resolveConflict("reload");
            else if (verdict === "keep-mine") {
              await store.resolveConflict("overwrite");
            } else continue;
          }
          break;
        }
      }
      conflictSheetUpRef.current = false;
    })();
  }, [
    isManual,
    snapshot.conflict,
    snapshot.fileName,
    store,
    sheets,
    runSaveAsPanel,
    manager,
    cardId,
    senderId,
    openCompareSheet,
  ]);

  // ---- Open-time aside conflict sheet ----
  const asideConflictUpRef = useRef(false);
  useLayoutEffect(() => {
    const pending = snapshot.pendingAsideConflict;
    if (pending === null || asideConflictUpRef.current) return;
    asideConflictUpRef.current = true;
    const fileName = snapshot.fileName ?? "Untitled";
    void sheets.presentOpenConflictSheet(fileName).then((choice) => {
      store.resolveAsideConflict(choice);
      asideConflictUpRef.current = false;
    });
  }, [snapshot.pendingAsideConflict, snapshot.fileName, store, sheets]);

  // ---- Store lifecycle + final flush ----

  useLayoutEffect(() => {
    const flushOnHide = () => {
      void store.flush({ keepalive: true });
    };
    // `visibilitychange` fires on BOTH hide and show; flush on hide, but
    // recheck disk ONLY when becoming visible — an unguarded
    // recheck would issue a disk read on every hide too.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void store.recheckOnActivation();
      } else {
        flushOnHide();
      }
    };
    // The window coming forward is the other half of "the user is looking
    // at this again". `visibilitychange` does not fire for a window that
    // was merely behind another app's, which is exactly the case where an
    // external editor was the thing in front of it.
    const onWindowFocus = () => {
      void store.recheckOnActivation();
    };
    window.addEventListener("pagehide", flushOnHide);
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void store.flush({ keepalive: true });
      store.dispose();
    };
  }, [store]);

  // ---- Title + masthead sync (pane chrome via cardTitleStore) ----
  //
  // ONE `set` call carries both channels. The string is what the tab bar,
  // the deck canvas, and the Window menu read; the payload is what the pane
  // renders as its document masthead. Publishing them separately would race
  // the store's equality guard and notify twice for one change.
  //
  // An untitled buffer publishes "Untitled" rather than clearing: the tier's
  // height is fixed precisely so chrome does not grow and shrink under a
  // reader, and a card that dropped to 36px while unnamed would reflow its
  // editor the moment it was first saved.
  //
  // `set` compares every payload field before notifying, so the save-state
  // line costs a notify only when its wording actually changes — the same
  // cost the dirty dot in the title already had. That guard is why the
  // teardown below is a SEPARATE effect keyed on the card alone: a `clear`
  // in this effect's cleanup would run before every re-publish and notify
  // unconditionally, which is exactly the traffic the guard exists to
  // suppress. What the card owes the store is one clear when it goes away.
  useLayoutEffect(() => {
    const detail = saveText({
      saveMode: snapshot.saveMode,
      saveState: snapshot.saveState,
      conflict: snapshot.conflict,
      lastSavedAt: snapshot.lastSavedAt,
      bound: isBoundFile,
    });
    if (snapshot.fileName === null) {
      cardTitleStore.set(cardId, "Untitled", {
        kind: "card-masthead",
        icon: "FileText",
        title: "Untitled",
        description: UNNAMED_PLACE,
        descriptionStandIn: true,
        detail,
      });
    } else {
      const base = snapshot.readOnly
        ? `${snapshot.fileName} (read-only)`
        : snapshot.fileName;
      // Manual mode marks unsaved changes with a small dot AFTER the name,
      // so the filename doesn't hop as the dirty bit sets and clears.
      const title = isManual && isDirty ? `${base} •` : base;
      cardTitleStore.set(cardId, title, {
        kind: "card-masthead",
        icon: "FileText",
        title,
        // A draft names no place the user chose — its path is a
        // drafts-directory file it was handed — so it stands in for one, a
        // step quieter, rather than leaving the line empty.
        description: isBoundFile ? snapshot.path : UNNAMED_PLACE,
        descriptionKind: isBoundFile ? "path" : "text",
        descriptionStandIn: !isBoundFile,
        detail,
      });
    }
  }, [
    cardId,
    snapshot.fileName,
    snapshot.path,
    isBoundFile,
    snapshot.readOnly,
    snapshot.saveMode,
    snapshot.saveState,
    snapshot.conflict,
    snapshot.lastSavedAt,
    isManual,
    isDirty,
  ]);

  // The chrome this card published goes away with the card, and only then
  // ([L27]). Keyed on `cardId` alone so a save-state transition re-publishes
  // through the equality guard instead of clearing and re-setting.
  useLayoutEffect(() => () => cardTitleStore.clear(cardId), [cardId]);

  // ---- Menu-state file block (drives the native File menu) ----
  //
  // Publish the block whenever the card is bound (ready); clear it
  // otherwise and on unmount ([L27]). The publisher only rides it onto
  // the payload while this card is the focused pane's active card.
  useLayoutEffect(() => {
    if (snapshot.phase !== "ready") {
      clearFileMenuState(cardId);
      return () => clearFileMenuState(cardId);
    }
    publishFileMenuState(cardId, {
      cardId,
      mode: snapshot.saveMode,
      dirty: isManual && snapshot.saveState !== "clean",
      untitled: snapshot.untitled,
      readOnly: snapshot.readOnly,
      hasPath: snapshot.path !== null,
      conflict: snapshot.conflict !== null,
    });
    return () => clearFileMenuState(cardId);
  }, [
    cardId,
    isManual,
    snapshot.phase,
    snapshot.saveMode,
    snapshot.saveState,
    snapshot.untitled,
    snapshot.readOnly,
    snapshot.path,
    snapshot.conflict,
  ]);

  // ---- What this card puts in its pane's title bar ----
  //
  // What the card publishes is MEMBERSHIP: which commands belong in this
  // pane's title bar, in what order, and in which shape. It never publishes
  // a label, a shortcut, or an enabled bit — `CardTitleBar` resolves all
  // three from the command table, which is the same answer ⌘S and File ▸
  // Save get, so a control here can never disagree with them ([L30]).
  //
  // Two standing buttons, and no `…` menu. Both are verbs the card offers
  // whenever it is open, and a verb reached that often does not belong
  // behind a menu that has to be opened to find out what is in it. Save and
  // Move To… are not here at all: they are File-menu commands with chords
  // (⌘S, ⇧⌘S), and a card that already saves does not need a button that
  // repeats what the keystroke and the menu bar both already do.
  //
  // Both buttons stand on every ready Text card, bound or not. Reveal on an
  // untitled draft has nothing for the Finder to select, so it DIMS — it does
  // not come and go: a control that appears only sometimes is a cluster the
  // hand cannot learn, and its neighbours would shift under the pointer the
  // moment a draft was saved. The dimming itself is the registry's answer,
  // asked of this card's own `validateAction`; the phrase for the dimmed
  // state is the card's, because "there is no file yet" is a fact only the
  // card holds.
  //
  // The effect is keyed on `isBoundFile` so the bar re-renders — and re-asks
  // the registry — the moment a draft becomes a file.
  useLayoutEffect(() => {
    if (snapshot.phase !== "ready") {
      paneTitleBarItemsStore.set(cardId, null);
      return;
    }
    const items: PaneTitleBarItem[] = [
      {
        commandId: TUG_ACTIONS.REVEAL_CARD_FILE,
        icon: "FolderOpenDot",
        unavailableHint: "No file",
      },
      {
        commandId: TUG_ACTIONS.SHOW_CARD_SETTINGS,
        icon: "Settings",
      },
    ];
    paneTitleBarItemsStore.set(cardId, items);
  }, [cardId, snapshot.phase, isBoundFile]);

  // Same shape as the masthead's teardown, and for the same reason: the
  // controls belong to the card's lifetime, not to any one membership fact
  // ([L27]).
  useLayoutEffect(() => () => paneTitleBarItemsStore.set(cardId, null), [cardId]);

  // The two title-bar verbs the chain has to deliver. They are KEY-CARD
  // routed and land here, on the card's own content responder, rather than
  // on the editor's: both mean "this card", and pressing a title-bar button
  // promotes the PANE as first responder, so a first-responder walk would
  // start above the editor and never reach it. Key-card dispatch starts at
  // this node regardless of where focus sits, which is the same reason the
  // Session card registers its ⌘K and ⌘F here.
  // Keyboard-focus-cycling ([P09]/[P10]). The Text card is text-first: its
  // resting key view is the editor, which owns Tab for indentation, so the
  // card's other keyboard destinations are only reachable once ⌥⇥ has traded
  // Tab away. The cycle's stops are the editor itself and the status strip's
  // two popups; entering rings the editor (a parked text stop — the ring is
  // there, the caret is not, [P12]) and Tab walks on to the line-ending and
  // file-type menus and wraps. Relinquishing lands the caret back in the
  // editor.
  const cycle = useCycleMode({
    restingFocus: () => editorRef.current?.focus(),
  });

  const {
    ResponderScope: CardContentResponderScope,
    responderRef: cardContentResponderRef,
  } = useResponder({
    id: `${cardId}-card-content`,
    kind: "card-content",
    actions: {
      [TUG_ACTIONS.REVEAL_CARD_FILE]: () => {
        revealInFinder();
      },
      [TUG_ACTIONS.SHOW_CARD_SETTINGS]: () => {
        void presentCardSettingsSheet(showSheet, "text", cardId);
      },
      // ⌥⇥ toggles keyboard-focus-cycling ([P09]/[P10]). Registered on the
      // card-content responder for the same reason the Session card does it
      // there: key-card dispatch starts at this node wherever focus sits, so
      // the gesture works from the editor's caret.
      [TUG_ACTIONS.CYCLE_FOCUS_MODE]: () => {
        cycle.toggle();
      },
      // The strip's ✕ dispatches through the chain and the owner performs the
      // removal ([L11]) — which here is both halves of a compound gesture: the
      // link comes out of the document and the file goes to the macOS Trash,
      // coupled so one ⌘Z brings both back ([P07]).
      [TUG_ACTIONS.REMOVE_ATTACHMENT]: (payload) => {
        const atomId = typeof payload?.value === "string" ? payload.value : "";
        const tile = assetTilesRef.current.find((t) => t.id === atomId);
        const view = editorRef.current?.view() ?? null;
        if (tile === undefined || view === null) return;
        if (tile.failed) {
          // Nothing on disk to remove — dismissing the failed tile is all a ✕
          // can mean here.
          assetProjection.clearFailure(tile.name);
          return;
        }
        void removeAssetWithUndo(
          view,
          { from: tile.from, to: tile.to },
          tile.path,
          (name, message) => assetProjection.noteFailure(name, message),
        );
      },
    },
    validateAction: (action) =>
      // Nothing for the Finder to select until the buffer is bound to a real
      // file — an untitled draft lives in the drafts directory under a name
      // the user never chose.
      action === TUG_ACTIONS.REVEAL_CARD_FILE ? isBoundFile : true,
  });

  // Compose the responder registration onto the card's root node, which the
  // editor branch also captures for the find bar's anchor. A `useCallback` so
  // the ref identity is stable — an inline lambda makes React detach and
  // reattach on every commit.
  const cardRootComposedRef = useCallback(
    (el: HTMLDivElement | null) => {
      cardRootRef.current = el;
      (cardContentResponderRef as (node: Element | null) => void)(el);
    },
    [cardContentResponderRef],
  );

  // ---- Focus the editor when a fresh untitled buffer opens ----
  //
  // New Text Card (⌥⌘N) should drop the caret straight into the editor so
  // the user can type immediately. Route through `reclaimFocusDestination`
  // so the focus resolves the key-card gate (never steal focus from an open
  // sheet) and repairs the chain, not just DOM focus — a bare `focus()` is
  // the resting-editor footgun. In a layout effect the editor is already
  // mounted and its responder registered, so no frame wait is needed. Fires
  // once per open.
  const untitledFocusedRef = useRef(false);
  useLayoutEffect(() => {
    if (snapshot.phase !== "ready") {
      untitledFocusedRef.current = false;
      return;
    }
    if (snapshot.untitled && !untitledFocusedRef.current) {
      untitledFocusedRef.current = true;
      reclaimFocusDestination();
    }
  }, [snapshot.phase, snapshot.untitled, reclaimFocusDestination]);

  // ---- Apply restored positions once the file binds ----

  useLayoutEffect(() => {
    if (snapshot.phase !== "ready") return;
    // A pending open-from-click reveal wins over a restored viewport:
    // reveal + flash the passage.
    const reveal = pendingRevealRef.current;
    if (reveal !== null) {
      pendingRevealRef.current = null;
      pendingPositionsRef.current = null;
      editorRef.current?.revealLine(reveal.line, reveal.endLine, reveal.columns);
      return;
    }
    const pending = pendingPositionsRef.current;
    if (pending === null) return;
    pendingPositionsRef.current = null;
    store.applyPositions(pending);
  }, [snapshot.phase, store]);

  // No editor-attach focus reclaim here: the async editor bind is covered by
  // the framework single channel. When the editor mounts it registers its
  // engine hook, which bumps the engine-hooks version; `CardHost`'s
  // `subscribeEngineHooksChange` retry re-runs `applyBagFocus`, resolves this
  // card to `engine`, and `paintMirrorAsActive` focuses the freshly-created
  // CM6 view. One claim, one channel — the same path the Session card's late
  // editor bind rides.

  // ---- Render ----

  // A card that is reading a file is already bound to a path — it is on its
  // way to the editor, so it renders a bare surface rather than the open
  // prompt. Flashing the chooser here would advertise "no file" for the
  // duration of a disk read that almost always settles in well under a
  // frame budget's worth of perceptible time.
  if (snapshot.phase === "loading") {
    return <div className="text-card text-card--loading" data-slot="text-card" />;
  }

  if (snapshot.phase === "empty") {
    return (
      <div className="text-card text-card--open" data-slot="text-card">
        <div className="text-card-open-surface">
          <TugLabel className="text-card-open-prompt">Open a file</TugLabel>
          <div className="text-card-open-row">
            <TugFileChooser
              value={chooserValue}
              onChange={setChooserValue}
              base="/"
              kind="file"
              placeholder="/path/to/file or ~/path/to/file"
              aria-label="File path"
              autoFocus
              onSubmit={() => openPath(chooserValue)}
            />
            <TugPushButton
              onClick={() => openPath(chooserValue)}
              disabled={chooserValue.trim() === ""}
            >
              Open
            </TugPushButton>
          </div>
          <div className="text-card-open-alt">
            <TugPushButton
              data-testid="text-card-new-draft"
              onClick={() => {
                // Manual: an untitled buffer with no file identity until
                // the first Save. Automatic: a real draft file.
                if (isManual) void store.openUntitled(cardId);
                else void store.openDraft(cardId);
              }}
            >
              New Untitled File
            </TugPushButton>
          </div>
        </div>
      </div>
    );
  }

  if (snapshot.phase === "error") {
    return (
      <div className="text-card text-card--error" data-slot="text-card">
        <div className="text-card-error-surface">
          <TugLabel className="text-card-error-message">
            {describeReadError(
              snapshot.error?.kind ?? "internal",
              snapshot.error?.size,
            )}
          </TugLabel>
          <TugLabel className="text-card-error-path">
            {snapshot.path ?? ""}
          </TugLabel>
          <TugPushButton
            onClick={() => {
              if (snapshot.path !== null) openPath(snapshot.path);
            }}
          >
            Try Again
          </TugPushButton>
        </div>
      </div>
    );
  }

  // `ready` — the editor plus (possibly) the conflict banner, mounted
  // side by side. The editor's mount identity is stable across every
  // autosave sub-state [L26].
  const conflict = snapshot.conflict;
  return (
    <CardContentResponderScope>
      <div
        ref={cardRootComposedRef}
        className="text-card text-card--editor"
        data-slot="text-card"
      >
        <cycle.CycleScope>
          <TugTextCardEditor
            ref={editorRef}
            store={store}
            focusGroup={TEXT_CARD_CYCLE_GROUP}
            focusOrder={TEXT_CARD_CYCLE_ORDER_EDITOR}
            readOnly={snapshot.readOnly}
            settings={editorSettings}
            languageExt={effectiveLanguageExt}
            className="text-card-editor"
            onFindRequested={openFindBar}
            onFindSelectionRequested={findSelection}
            onFindNavigated={() => findBarRef.current?.refreshCount()}
            onSaveCommand={onSaveCommand}
            onStats={statsStore.set}
            assetProjection={assetProjection}
            onOpenPath={(p) => {
              // Decided by what the file *is*: a viewable kind lands in a
              // file-view card, anything textual in a Text card, and anything
              // else — a `.zip`, a `.sketch`, a file that is no longer there —
              // in the Finder. A path already open is reused rather than
              // duplicated, as with every other open.
              const deck = getDeckStore();
              if (deck !== null) void openAttachmentPath(deck, p, cardId);
            }}
          />
        </cycle.CycleScope>
        {/* What this document has attached, derived from its own text ([P01]).
         * The same component the prompt entry mounts — extended for non-image
         * tiles, never forked. It renders inside `CardContentResponderScope`
         * so its ✕ dispatch resolves to this card ([L11]), and it returns
         * `null` for an empty tile set, so a document with no attachments
         * contributes no height at all. */}
        {assetAtoms.length > 0 ? (
          <TugAttachmentPreview
            atoms={assetAtoms}
            bytesStore={assetProjection.bytesStore}
            className="text-card-asset-strip"
            data-testid="text-card-asset-strip"
            // Enabled only now that the ✕ has a restore path: no shipped
            // intermediate state could ever remove a file irreversibly.
            deletable={!snapshot.readOnly}
            onActivateFile={(atom) => {
              // A tile with no pixels: retry the attach that failed, or
              // reveal the link the tile stands for — the document is where
              // an attachment actually lives, so that is where a click goes.
              const tile = assetTiles.find((t) => t.id === atom.id);
              if (tile === undefined) return;
              if (tile.failed) {
                assetProjection.retryFailure(tile.name);
                return;
              }
              editorRef.current?.revealOffsets(tile.from, tile.to);
            }}
          />
        ) : null}
        {/* Under the SAME cycle the editor and the status strip use, so the
         * bar's stops take their seat in the card's one Tab order instead of
         * opening a walk of their own ([P10]) — the Session card wires its bar
         * the same way. */}
        {findOpen ? (
          <cycle.CycleScope>
            <TextCardFindBar
              ref={findBarRef}
              getDelegate={() => editorRef.current}
              initialQuery={findSeedRef.current}
              onClose={closeFindBar}
              cardRootRef={cardRootRef}
              focusGroup={TEXT_CARD_CYCLE_GROUP}
              focusOrderBase={TEXT_CARD_CYCLE_ORDER_FIND_BASE}
            />
          </cycle.CycleScope>
        ) : null}
        <cycle.CycleScope>
          <TextCardStatusBar
            statsStore={statsStore}
            lineEnding={snapshot.lineEnding}
            onSetLineEnding={setLineEnding}
            languageId={effectiveLanguageId}
            onSetLanguage={setLanguageOverrideId}
            focusGroup={TEXT_CARD_CYCLE_GROUP}
            focusOrder={TEXT_CARD_CYCLE_ORDER_LINE_ENDING}
          />
        </cycle.CycleScope>
        {renderSheet()}
        {/* The card's ONE banner. There used to be a second one for
         * attachment failures, and the two were a live defect rather than
         * merely redundant: `TugPaneBanner` sets and removes `inert` on the
         * same `.tug-pane-body` with no refcount, so whichever unmounted first
         * un-inerted the body under the other. Attachment failures now render
         * on the tile that failed ([P06]), which leaves exactly one banner and
         * makes the interference impossible by construction — the same shape
         * the Session card gets by deriving a single banner. */}
        <TugPaneBanner
          visible={
            conflict !== null &&
            (snapshot.saveMode === "automatic" ||
              // Manual mode's verdicts are modal — except a missing verdict
              // raised over a clean buffer, which the sheet effect declines
              // and this shows instead. Still exactly one banner.
              (conflict.reason === "missing" &&
                conflict.raisedOverCleanBuffer === true))
          }
          variant="error"
          tone="caution"
          label={conflict?.reason === "missing" ? "File deleted" : "File changed"}
          message={
            conflict?.reason === "missing"
              ? "This file was deleted on disk. Your buffer is preserved until you close the card."
              : "This file changed on disk while you were editing."
          }
          footer={
            conflict?.reason === "missing" ? (
              <>
                {isPathPickerAvailable() ? (
                  <TugPushButton
                    data-testid="text-card-missing-save-as"
                    onClick={saveAs}
                  >
                    Save As…
                  </TugPushButton>
                ) : null}
                <TugPushButton
                  data-testid="text-card-missing-close"
                  onClick={() => {
                    // Close the card via the chain: the walk from the card
                    // reaches the host pane's CLOSE handler ([L11] — the
                    // pane owns the card list this action mutates).
                    manager?.sendToTarget(cardId, {
                      action: TUG_ACTIONS.CLOSE,
                      sender: senderId,
                      phase: "discrete",
                    });
                  }}
                >
                  Close
                </TugPushButton>
              </>
            ) : (
              <>
                <TugPushButton
                  data-testid="text-card-conflict-reload"
                  onClick={() => {
                    void store.resolveConflict("reload");
                  }}
                >
                  Reload from Disk
                </TugPushButton>
                <TugPushButton
                  data-testid="text-card-conflict-diff"
                  onClick={() => {
                    void (async () => {
                      const verdict = await openCompareSheet();
                      if (verdict === "reload") {
                        await store.resolveConflict("reload");
                      } else if (verdict === "keep-mine") {
                        await store.resolveConflict("overwrite");
                      }
                    })();
                  }}
                >
                  Diff
                </TugPushButton>
                <TugPushButton
                  data-testid="text-card-conflict-overwrite"
                  role="danger"
                  onClick={() => {
                    void store.resolveConflict("overwrite");
                  }}
                >
                  Keep Mine
                </TugPushButton>
              </>
            )
          }
        />
      </div>
    </CardContentResponderScope>
  );
}

/** CardHost-facing wrapper that resolves its own cardId from context. */
export function TextCardBody() {
  const cardId = useCardId();
  return <TextCardContent cardId={cardId ?? ""} />;
}
