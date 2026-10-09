/**
 * gallery-text-editor.tsx — TugTextEditor gallery card.
 *
 * Demo surface for the CodeMirror 6-backed `TugTextEditor` substrate.
 * Mirrors `gallery-prompt-input`'s wiring so the typeahead is
 * exercised against the live FileTreeStore and SessionMetadataStore
 * — same backing data the production prompt input uses, no synthetic
 * fixtures. Without that, the spike's typeahead surface would only
 * exercise the substrate's keyboard / popup mechanics; integrating
 * the real providers is what proves the substrate can replace the
 * `tug-prompt-input` engine for completion as well.
 *
 * Provider sources:
 *   - `@` triggers `FileTreeStore.getFileCompletionProvider()` over a
 *     workspace-filtered live `FeedStore<FILETREE>` — async; results
 *     stream in via the provider's `subscribe` hook and the substrate
 *     dispatches a refresh transaction whenever the FileTreeStore
 *     emits.
 *   - `/` triggers `getFixtureSessionMetadataStore().getCommandCompletionProvider()`
 *     — same `SessionMetadataStore` class production uses, but
 *     backed by the captured `capabilities/<LATEST>/system-metadata.jsonl`
 *     payload from `just capture-capabilities`. Live SESSION_SIDEBAND
 *     only arrives when a code session is active, and the gallery is a
 *     harness with no session — `gallery-prompt-entry` uses the same
 *     fixture for the same reason.
 *
 * Card-scoped history is kept in a per-instance ref-held entry list:
 * each Return submit captures the current editing state, appends it,
 * and clears the editor. Up/Down (from the edges) and Opt-Up/Opt-Down
 * walk the live entries and the saved draft, mirroring `SessionHistoryProvider`'s contract
 * without requiring a real session.
 *
 * Dropped files round-trip through `galleryDropHandler` — the same
 * shape `gallery-prompt-input` uses — so the substrate's
 * `domEventHandlers.drop` path lands real `AtomSegment` values rather
 * than gallery-only stand-ins.
 *
 * Control surface: every non-deferred prop in `tug-text-editor`'s public
 * API has a runtime control on this card. Layout / state / behavior
 * props ride on `TugChoiceGroup` (selectValue) and `TugSwitch`
 * (toggle); `maxRows` rides on `TugValueInput` (setValueNumber);
 * typography props ride on `TugPopupButton` (setValueString /
 * setValueNumber). A `TugPushButton` toolbar above the editor carries
 * the imperative actions (`Clear`).
 *
 * Laws: [L01] one root.render() at mount, [L02] history list and
 *        feed-store stack live in refs; React state carries only
 *        prop values that flow back into `TugTextEditor`, [L03] the
 *        file-tree feed-store filter is re-installed in a
 *        `useEffect` keyed on workspace identity, matching
 *        `gallery-prompt-input`'s pattern, [L06] appearance via CSS
 *        and DOM, never React state, [L07] provider thunks and the
 *        card-scoped history closure read their state at call
 *        time, [L09] cards never set their own position / size /
 *        z-order — `TugPane` owns geometry, [L11] toggle controls
 *        and atom-insert buttons emit actions consumed by this
 *        scope's responder form, [L19] component authoring guide,
 *        [L22] the file-completion provider's async refresh path
 *        is a direct store-observation channel — no React
 *        round-trip, [L25] deck → pane → card hierarchy preserved.
 */

import "./gallery-text-editor.css";

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TugTextEditor } from "@/components/tugways/tug-text-editor";
import type { TugTextEditorDelegate, TugTextEditorFocusStyle } from "@/components/tugways/tug-text-editor";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import type { TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugPopupButton } from "@/components/tugways/tug-popup-button";
import type { TugPopupButtonItem } from "@/components/tugways/tug-popup-button";
import { TugSwitch } from "@/components/tugways/tug-switch";
import { TugValueInput } from "@/components/tugways/tug-value-input";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import {
  useComponentStatePreservation,
  useSavedComponentState,
} from "@/components/tugways/use-component-state-preservation";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { captureEditState } from "@/components/tugways/tug-text-editor/keymap";
import { useCardWorkspaceKey } from "@/components/tugways/hooks/use-card-workspace-key";
import { presentWorkspaceKey } from "@/card-registry";
import { FeedStore, type FeedStoreFilter } from "@/lib/feed-store";
import { FileTreeStore } from "@/lib/filetree-store";
import { getConnection } from "@/lib/connection-singleton";
import { FeedId } from "@/protocol";
import { getFixtureSessionMetadataStore } from "./completion-fixtures/system-metadata-fixture";
import {
  LOCAL_SLASH_COMMANDS,
  type LocalSlashCommandSpec,
} from "@/lib/slash-commands";
import { resolveArgumentHint } from "@/lib/slash-argument-hint";
import type { ArgumentHintResolver } from "@/components/tugways/tug-text-editor/argument-hint-extension";
import type { AtomSegment } from "@/lib/tug-atom-img";
import type {
  CompletionProvider,
  HistoryProvider,
  InputAction,
  TugTextEditingState,
} from "@/lib/tug-text-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUS_STYLE_CHOICES: TugChoiceItem[] = [
  { value: "background", label: "Background" },
  { value: "ring", label: "Ring" },
];

const BORDERLESS_CHOICES: TugChoiceItem[] = [
  { value: "false", label: "Bordered" },
  { value: "true", label: "Borderless" },
];

const RETURN_ACTION_CHOICES: TugChoiceItem[] = [
  { value: "newline", label: "Newline" },
  { value: "submit", label: "Submits" },
];

const ENTER_ACTION_CHOICES: TugChoiceItem[] = [
  { value: "submit", label: "Submits" },
  { value: "newline", label: "Newline" },
];

const GROW_DIRECTION_CHOICES: TugChoiceItem[] = [
  { value: "down", label: "Down" },
  { value: "up", label: "Up" },
];

const COMPLETION_DIRECTION_CHOICES: TugChoiceItem[] = [
  { value: "down", label: "Down" },
  { value: "up", label: "Up" },
];

const FONT_FAMILY_OPTIONS: TugPopupButtonItem<string>[] = [
  { action: TUG_ACTIONS.SET_VALUE, value: "default", label: "Default (editor)" },
  {
    action: TUG_ACTIONS.SET_VALUE,
    value: '"IBM Plex Mono", "SFMono-Regular", "Menlo", monospace',
    label: "IBM Plex Mono",
  },
  {
    action: TUG_ACTIONS.SET_VALUE,
    value: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif',
    label: "IBM Plex Sans",
  },
];

const FONT_SIZE_OPTIONS: TugPopupButtonItem<number>[] = [
  { action: TUG_ACTIONS.SET_VALUE, value: 11, label: "11 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 12, label: "12 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 13, label: "13 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 14, label: "14 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 15, label: "15 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 16, label: "16 px" },
  { action: TUG_ACTIONS.SET_VALUE, value: 18, label: "18 px" },
];

const LINE_HEIGHT_OPTIONS: TugPopupButtonItem<number>[] = [
  { action: TUG_ACTIONS.SET_VALUE, value: 1.0, label: "1.0" },
  { action: TUG_ACTIONS.SET_VALUE, value: 1.2, label: "1.2" },
  { action: TUG_ACTIONS.SET_VALUE, value: 1.4, label: "1.4" },
  { action: TUG_ACTIONS.SET_VALUE, value: 1.6, label: "1.6 (default)" },
  { action: TUG_ACTIONS.SET_VALUE, value: 1.75, label: "1.75" },
  { action: TUG_ACTIONS.SET_VALUE, value: 2.0, label: "2.0" },
  { action: TUG_ACTIONS.SET_VALUE, value: 2.5, label: "2.5" },
];

const LETTER_SPACING_OPTIONS: TugPopupButtonItem<string>[] = [
  { action: TUG_ACTIONS.SET_VALUE, value: "-0.05em", label: "-0.05em" },
  { action: TUG_ACTIONS.SET_VALUE, value: "-0.02em", label: "-0.02em" },
  { action: TUG_ACTIONS.SET_VALUE, value: "normal", label: "Normal" },
  { action: TUG_ACTIONS.SET_VALUE, value: "0.02em", label: "0.02em" },
  { action: TUG_ACTIONS.SET_VALUE, value: "0.05em", label: "0.05em" },
];

/**
 * Demo placeholder text. Mentions the completion triggers, drop
 * action, IME case, and the Return-vs-Enter contrast so a manual
 * walk-through hits every behavior the substrate exposes.
 */
const DEMO_PLACEHOLDER =
  "Type here… @ for file, / for command, drag files, test IME, Return vs Enter";

/**
 * Sample atoms exercising every kind that `tug-atom-img.ts` knows
 * how to draw. Each click on the matching button inserts a fresh
 * atom of that kind at the editor's current selection.
 */
const ATOM_SAMPLES: { label: string; segment: AtomSegment }[] = [
  {
    label: "file",
    segment: { kind: "atom", type: "file", label: "main.ts", value: "/project/src/main.ts" },
  },
  {
    label: "command",
    segment: { kind: "atom", type: "command", label: "/commit", value: "/commit" },
  },
  {
    label: "doc",
    segment: { kind: "atom", type: "doc", label: "tuglaws.md", value: "/tuglaws/tuglaws.md" },
  },
  {
    label: "image",
    segment: { kind: "atom", type: "image", label: "screenshot.png", value: "/Desktop/screenshot.png" },
  },
  {
    label: "link",
    segment: { kind: "atom", type: "link", label: "anthropic.com", value: "https://www.anthropic.com" },
  },
];

// ---------------------------------------------------------------------------
// Drop handler
// ---------------------------------------------------------------------------

/**
 * Map a `FileList` into one `file`-kind `AtomSegment` per file. Same
 * shape `gallery-prompt-input` uses; the substrate runs the dropped
 * payload through this and inserts the resulting atoms at the drop
 * point in a single transaction.
 */
function galleryDropHandler(files: FileList): AtomSegment[] {
  const atoms: AtomSegment[] = [];
  for (let i = 0; i < files.length; i++) {
    const name = files[i]!.name;
    atoms.push({ kind: "atom", type: "file", label: name, value: name });
  }
  return atoms;
}

// ---------------------------------------------------------------------------
// Empty provider — fallback when the live FILETREE connection isn't
// yet available. Stable identity so the substrate's provider thunk
// doesn't churn on the unbound-window first render.
// ---------------------------------------------------------------------------

const EMPTY_PROVIDER: CompletionProvider = ((_q: string) => []) as CompletionProvider;

// ---------------------------------------------------------------------------
// Card-scoped history provider
// ---------------------------------------------------------------------------

/**
 * History provider whose entry list is owned by the gallery card.
 *
 * Mirrors `SessionHistoryProvider` from `prompt-history-store.ts` so
 * the gallery exercises the same contract production wires up. The
 * crucial difference: the entry list is supplied via a getter, not
 * baked at construction. The card's `onSubmit` handler appends to a
 * ref-held array, and the provider reads through the same ref on
 * every `back()` / `forward()` — so a submit landing right before an
 * ArrowUp brings the new entry into view immediately.
 */
class CardHistoryProvider implements HistoryProvider {
  private cursor = -1;
  private draft: TugTextEditingState = { text: "", atoms: [], selection: null };

  constructor(private readonly getEntries: () => readonly TugTextEditingState[]) {}

  back(current: TugTextEditingState): TugTextEditingState | null {
    const entries = this.getEntries();
    if (entries.length === 0) return null;
    if (this.cursor === -1) {
      this.draft = current;
      this.cursor = entries.length - 1;
    } else if (this.cursor > 0) {
      this.cursor--;
    } else {
      return null;
    }
    return entries[this.cursor]!;
  }

  forward(): TugTextEditingState | null {
    const entries = this.getEntries();
    if (this.cursor === -1) return null;
    if (this.cursor < entries.length - 1) {
      this.cursor++;
      return entries[this.cursor]!;
    }
    this.cursor = -1;
    return this.draft;
  }

  /**
   * Reset the cursor to the draft slot and replace the saved draft
   * with the supplied state. Called from the submit flow so a
   * subsequent ArrowUp offers the just-submitted entry as the most
   * recent — not the historic "draft I navigated away from."
   */
  resetToDraft(draft: TugTextEditingState): void {
    this.cursor = -1;
    this.draft = draft;
  }
}

// ---------------------------------------------------------------------------
// GalleryTextEditor
// ---------------------------------------------------------------------------

interface GalleryTextEditorProps {
  /** Card instance id — used to scope the FILETREE feed-store filter. */
  cardId: string;
}

export function GalleryTextEditor({ cardId }: GalleryTextEditorProps) {
  const editRef = useRef<TugTextEditorDelegate>(null);

  // ---- Layout / state props ----
  // Mount-in-saved-state for every persisted prop. The saved value (if
  // any) seeds the corresponding `useState` initializer so the gallery
  // card mounts in the user's last-saved configuration on cold boot —
  // no post-mount apply pass.
  const savedFontFamily = useSavedComponentState<string | null>("fontFamily");
  const savedFontSize = useSavedComponentState<number | null>("fontSize");
  const savedLineHeight = useSavedComponentState<number | null>("lineHeight");
  const savedLetterSpacing = useSavedComponentState<string | null>(
    "letterSpacing",
  );
  // The View-section switches capture into `bag.components` under their
  // own `componentStatePreservationKey` (shape `{ checked }`), but a
  // *controlled* TugSwitch never re-dispatches its saved value on
  // restore (the parent owns truth — see tug-switch.tsx). So the card
  // must read the saved `checked` itself and seed the `useState`
  // initializer, exactly as the typography props above do; without this
  // the switches reset to their hard-coded defaults on every reload.
  const savedLineWrap = useSavedComponentState<{ checked: boolean }>(
    "lineWrap",
  );
  const savedLineNumbers = useSavedComponentState<{ checked: boolean }>(
    "lineNumbers",
  );
  const savedActiveLineGutter = useSavedComponentState<{ checked: boolean }>(
    "highlightActiveLineGutter",
  );
  const savedMarkdownStyling = useSavedComponentState<{ checked: boolean }>(
    "markdownTextStyling",
  );

  const [maxRows, setMaxRows] = useState<number>(15);
  const [growDirection, setGrowDirection] = useState<"up" | "down">("down");
  const [disabled, setDisabled] = useState<boolean>(false);

  // ---- Focus / border (existing) ----
  const [focusStyle, setFocusStyle] = useState<TugTextEditorFocusStyle>("background");
  const [borderless, setBorderlessFlag] = useState<boolean>(false);

  // ---- Behavior props ----
  const [returnAction, setReturnAction] = useState<InputAction>("newline");
  const [enterAction, setEnterAction] = useState<InputAction>("submit");
  const [completionDirection, setCompletionDirection] = useState<"up" | "down">("down");

  // ---- Typography props ----
  // `undefined` means "let the prop fall through to the token default";
  // explicit values override.
  const [fontFamily, setFontFamily] = useState<string | undefined>(() =>
    savedFontFamily === null
      ? undefined
      : typeof savedFontFamily === "string"
        ? savedFontFamily
        : undefined,
  );
  const [fontSize, setFontSize] = useState<number | undefined>(() =>
    savedFontSize === null
      ? undefined
      : typeof savedFontSize === "number"
        ? savedFontSize
        : undefined,
  );
  const [lineHeight, setLineHeight] = useState<number | undefined>(() =>
    savedLineHeight === null
      ? undefined
      : typeof savedLineHeight === "number"
        ? savedLineHeight
        : undefined,
  );
  const [letterSpacing, setLetterSpacing] = useState<string | undefined>(() =>
    savedLetterSpacing === null
      ? undefined
      : typeof savedLetterSpacing === "string"
        ? savedLetterSpacing
        : undefined,
  );

  // ---- View controls ----
  const [lineWrap, setLineWrap] = useState<boolean>(() =>
    typeof savedLineWrap?.checked === "boolean" ? savedLineWrap.checked : true,
  );
  const [lineNumbers, setLineNumbers] = useState<boolean>(() =>
    typeof savedLineNumbers?.checked === "boolean"
      ? savedLineNumbers.checked
      : true,
  );
  const [highlightActiveLineGutter, setHighlightActiveLineGutter] =
    useState<boolean>(() =>
      typeof savedActiveLineGutter?.checked === "boolean"
        ? savedActiveLineGutter.checked
        : false,
    );
  const [markdownTextStyling, setMarkdownTextStyling] = useState<boolean>(() =>
    typeof savedMarkdownStyling?.checked === "boolean"
      ? savedMarkdownStyling.checked
      : false,
  );

  // ---- Submit counter (display only) ----
  const [submitCount, setSubmitCount] = useState<number>(0);

  // ---- Component State Preservation ----
  //
  // Every prop the card lets the user tune is React state owned by
  // this component, so it falls under the Component-level layer of
  // the State Preservation Protocol (see
  // `tuglaws/state-preservation.md`):
  //
  //   - State driven by tug components that already accept
  //     `componentStatePreservationKey` (TugSwitch, TugChoiceGroup,
  //     TugValueInput) is preserved by threading a key through the
  //     prop. The framework captures `.checked` / `.value` into
  //     `bag.components` and replays it on cold-boot — the parent
  //     state owner reconciles via the existing dispatch chain.
  //   - State driven by TugPopupButton (typography popups) doesn't
  //     have built-in preservation support, so we register
  //     `useComponentStatePreservation` calls here that capture /
  //     restore the local React state directly. Same `bag.components`
  //     channel; same restore ordering.
  //
  // Keys are scoped to this card and stay grep-stable; the registry
  // dedupes within the card subtree. The card-level
  // `useCardStatePreservation` registration (inside `TugTextEditor` itself,
  // gated on `preserveState`) handles the editor's document + atoms +
  // selection on a separate axis (`bag.content`).
  useComponentStatePreservation<string | null>({
    componentStatePreservationKey: "fontFamily",
    captureState: () => fontFamily ?? null,
  });
  useComponentStatePreservation<number | null>({
    componentStatePreservationKey: "fontSize",
    captureState: () => fontSize ?? null,
  });
  useComponentStatePreservation<number | null>({
    componentStatePreservationKey: "lineHeight",
    captureState: () => lineHeight ?? null,
  });
  useComponentStatePreservation<string | null>({
    componentStatePreservationKey: "letterSpacing",
    captureState: () => letterSpacing ?? null,
  });

  // Per-card runtime history. The ref-held array is the single source
  // of truth; React state (`submitCount`) carries only the rendered
  // counter, not the entries themselves [L02].
  const entriesRef = useRef<TugTextEditingState[]>([]);

  // One provider instance per card lifetime.
  const historyProvider = useMemo(
    () => new CardHistoryProvider(() => entriesRef.current),
    [],
  );

  // ---- File-tree completion provider (per-card) ----
  //
  // Mirrors `gallery-prompt-input`'s setup: a workspace-filtered
  // FeedStore over FILETREE plus a FileTreeStore that exposes the
  // async `@`-trigger provider. The provider's `subscribe` hook
  // streams refreshed results into the substrate's typeahead state
  // through the completion-extension ([L22]).
  const workspaceKey = useCardWorkspaceKey(cardId);
  const workspaceFilter: FeedStoreFilter = useMemo(
    () =>
      workspaceKey
        ? (_feedId, decoded) =>
            typeof decoded === "object"
            && decoded !== null
            && "workspace_key" in decoded
            && (decoded as { workspace_key: unknown }).workspace_key === workspaceKey
        : presentWorkspaceKey,
    [workspaceKey],
  );

  const fileTreeStackRef = useRef<{
    feedStore: FeedStore;
    fileTreeStore: FileTreeStore;
    provider: CompletionProvider;
  } | null>(null);

  if (fileTreeStackRef.current === null) {
    const connection = getConnection();
    if (connection) {
      const feedStore = new FeedStore(
        connection,
        [FeedId.FILETREE],
        undefined,
        workspaceFilter,
      );
      const fileTreeStore = new FileTreeStore(feedStore, FeedId.FILETREE);
      const provider = fileTreeStore.getFileCompletionProvider();
      fileTreeStackRef.current = { feedStore, fileTreeStore, provider };
    }
  }

  // Re-install the workspace filter when the binding changes —
  // mirror of the `gallery-prompt-input` pattern.
  useEffect(() => {
    fileTreeStackRef.current?.feedStore.setFilter(workspaceFilter);
  }, [workspaceFilter]);

  // Dispose the file-tree stack on unmount.
  useEffect(() => {
    return () => {
      const stack = fileTreeStackRef.current;
      if (stack !== null) {
        stack.fileTreeStore.dispose();
        stack.feedStore.dispose();
        fileTreeStackRef.current = null;
      }
    };
  }, []);

  // Stable provider map. The thunk inside the substrate reads this
  // map at every transaction; both providers' identities are stable
  // across the card's lifetime, so empty deps are correct.
  const completionProviders = useMemo<Record<string, CompletionProvider>>(
    () => ({
      "@": fileTreeStackRef.current?.provider ?? EMPTY_PROVIDER,
      "/": getFixtureSessionMetadataStore().getCommandCompletionProvider(),
    }),
    [],
  );

  // Argument-hint resolver mirroring the session card's: accepting a skill /
  // agent command atom (or a `takesArgs` local) paints a ghost placeholder.
  // Lets the slot be vetted here without the full app.
  const argumentHintResolver = useMemo<ArgumentHintResolver>(() => {
    const store = getFixtureSessionMetadataStore();
    return (value: string): string | null => {
      const hit = store
        .getSnapshot()
        .slashCommands.find((c) => c.name === value);
      const local: LocalSlashCommandSpec | undefined = LOCAL_SLASH_COMMANDS.find(
        (c) => c.name === value,
      );
      return resolveArgumentHint({
        name: value,
        category: hit?.category,
        argumentHint: hit?.argumentHint,
        takesArgs: local?.takesArgs,
      });
    };
  }, []);

  // Submit handler: capture the current editing state, append it to
  // the per-card history, reset the provider's cursor / draft, then
  // clear the editor for the next draft. The capture happens on the
  // current view so atoms in the submitted draft are preserved (so
  // ArrowUp after submit restores the exact draft, atoms and all).
  const handleSubmit = (): void => {
    const view = editRef.current?.view();
    if (view === null || view === undefined) return;
    const snapshot = captureEditState(view);
    if (snapshot.text.length === 0) return; // ignore empty submits
    entriesRef.current.push(snapshot);
    historyProvider.resetToDraft({ text: "", atoms: [], selection: null });
    editRef.current?.clear();
    setSubmitCount((n) => n + 1);
  };

  // Sender ids for every responder-form binding below. Held in
  // `useId()` slots so dispatches resolve through the responder
  // chain by id, not by closure capture.
  const focusId = React.useId();
  const borderlessId = React.useId();
  const returnId = React.useId();
  const enterId = React.useId();
  const growId = React.useId();
  const completionDirId = React.useId();
  const maxRowsId = React.useId();
  const disabledId = React.useId();
  const lineWrapId = React.useId();
  const lineNumbersId = React.useId();
  const activeLineGutterId = React.useId();
  const markdownStylingId = React.useId();
  const fontFamilyId = React.useId();
  const fontSizeId = React.useId();
  const lineHeightId = React.useId();
  const letterSpacingId = React.useId();

  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [focusId]: (v: string) => setFocusStyle(v as TugTextEditorFocusStyle),
      [borderlessId]: (v: string) => setBorderlessFlag(v === "true"),
      [returnId]: (v: string) => setReturnAction(v as InputAction),
      [enterId]: (v: string) => setEnterAction(v as InputAction),
      [growId]: (v: string) => setGrowDirection(v as "up" | "down"),
      [completionDirId]: (v: string) => setCompletionDirection(v as "up" | "down"),
    },
    toggle: {
      [disabledId]: (v: boolean) => setDisabled(v),
      [lineWrapId]: (v: boolean) => setLineWrap(v),
      [lineNumbersId]: (v: boolean) => setLineNumbers(v),
      [activeLineGutterId]: (v: boolean) => setHighlightActiveLineGutter(v),
      [markdownStylingId]: (v: boolean) => setMarkdownTextStyling(v),
    },
    setValueNumber: {
      [maxRowsId]: (v: number) => setMaxRows(Math.max(1, Math.min(20, Math.round(v)))),
      [fontSizeId]: (v: number) => setFontSize(v),
      [lineHeightId]: (v: number) => setLineHeight(v),
    },
    setValueString: {
      [fontFamilyId]: (v: string) => setFontFamily(v === "default" ? undefined : v),
      [letterSpacingId]: (v: string) => setLetterSpacing(v === "normal" ? undefined : v),
    },
  });

  // Derive labels for the typography popups so the trigger reads
  // back the active value rather than a generic placeholder.
  const fontFamilyLabel =
    fontFamily === undefined
      ? "Font: Default"
      : `Font: ${FONT_FAMILY_OPTIONS.find((o) => o.value === fontFamily)?.label ?? "Custom"}`;
  const fontSizeLabel =
    fontSize === undefined ? "Size: Default" : `Size: ${fontSize}px`;
  const lineHeightLabel =
    lineHeight === undefined ? "Line: Default" : `Line: ${lineHeight}`;
  const letterSpacingLabel =
    letterSpacing === undefined
      ? "Spacing: Normal"
      : `Spacing: ${letterSpacing}`;

  return (
    <ResponderScope>
      <div
        className="cg-content"
        data-testid="gallery-text-editor"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >

        {/* ---- Editor ----
            Toolbar above carries the imperative + typography
            controls; the editor itself sits below.
         */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">TugTextEditor</TugLabel>
          <div className="gallery-text-editor-stack">
            <div className="gallery-text-editor-toolbar">
              <TugPushButton
                size="sm"
                emphasis="outlined"
                onClick={() => editRef.current?.clear()}
              >
                Clear
              </TugPushButton>
              <TugPopupButton
                label={fontFamilyLabel}
                items={FONT_FAMILY_OPTIONS}
                senderId={fontFamilyId}
                size="sm"
              />
              <TugPopupButton
                label={fontSizeLabel}
                items={FONT_SIZE_OPTIONS}
                senderId={fontSizeId}
                size="sm"
              />
              <TugPopupButton
                label={lineHeightLabel}
                items={LINE_HEIGHT_OPTIONS}
                senderId={lineHeightId}
                size="sm"
              />
              <TugPopupButton
                label={letterSpacingLabel}
                items={LETTER_SPACING_OPTIONS}
                senderId={letterSpacingId}
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-host">
              <TugTextEditor
                ref={editRef}
                placeholder={DEMO_PLACEHOLDER}
                maxRows={maxRows}
                growDirection={growDirection}
                disabled={disabled}
                focusStyle={focusStyle}
                borderless={borderless}
                returnAction={returnAction}
                numpadEnterAction={enterAction}
                completionDirection={completionDirection}
                lineWrap={lineWrap}
                lineNumbers={lineNumbers}
                highlightActiveLineGutter={highlightActiveLineGutter}
                markdownTextStyling={markdownTextStyling}
                fontFamily={fontFamily}
                fontSize={fontSize === undefined ? undefined : `${fontSize}px`}
                lineHeight={lineHeight}
                letterSpacing={letterSpacing}
                onSubmit={handleSubmit}
                historyProvider={historyProvider}
                completionProviders={completionProviders}
                argumentHintResolver={argumentHintResolver}
                dropHandler={galleryDropHandler}
              />
            </div>
          </div>
        </div>

        <TugSeparator />

        {/* ---- Atoms ----
            Each button inserts a fresh atom of one kind at the
            editor's current selection. Verifies that
            atomicRanges, decoration rendering, and the
            imperative `insertAtom` delegate method work end to
            end.
         */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Insert atom</TugLabel>
          <div className="gallery-text-editor-atom-row">
            {ATOM_SAMPLES.map((sample) => (
              <TugPushButton
                key={sample.label}
                size="sm"
                emphasis="outlined"
                onClick={() => editRef.current?.insertAtom(sample.segment)}
              >
                {sample.label}
              </TugPushButton>
            ))}
          </div>
        </div>

        <TugSeparator />

        {/* ---- View controls ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">View</TugLabel>
          <div className="gallery-text-editor-row">
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Soft wrap text</span>
              <TugSwitch
                checked={lineWrap}
                senderId={lineWrapId}
                componentStatePreservationKey="lineWrap"
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Line numbers</span>
              <TugSwitch
                checked={lineNumbers}
                senderId={lineNumbersId}
                componentStatePreservationKey="lineNumbers"
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Active line</span>
              <TugSwitch
                checked={highlightActiveLineGutter}
                senderId={activeLineGutterId}
                componentStatePreservationKey="highlightActiveLineGutter"
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Markdown styling</span>
              <TugSwitch
                checked={markdownTextStyling}
                senderId={markdownStylingId}
                componentStatePreservationKey="markdownTextStyling"
                size="sm"
              />
            </div>
          </div>
        </div>

        <TugSeparator />

        {/* ---- Layout ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Layout</TugLabel>
          <div className="gallery-text-editor-row">
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Max rows</span>
              <TugValueInput
                value={maxRows}
                senderId={maxRowsId}
                componentStatePreservationKey="maxRows"
                min={1}
                max={20}
                step={1}
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Disabled</span>
              <TugSwitch
                checked={disabled}
                senderId={disabledId}
                componentStatePreservationKey="disabled"
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Grow direction</span>
              <TugChoiceGroup
                items={GROW_DIRECTION_CHOICES}
                value={growDirection}
                senderId={growId}
                componentStatePreservationKey="growDirection"
                size="sm"
              />
            </div>
          </div>
        </div>

        <TugSeparator />

        {/* ---- Behavior ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Behavior</TugLabel>
          <div className="gallery-text-editor-row">
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Return action</span>
              <TugChoiceGroup
                items={RETURN_ACTION_CHOICES}
                value={returnAction}
                senderId={returnId}
                componentStatePreservationKey="returnAction"
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Numpad Enter</span>
              <TugChoiceGroup
                items={ENTER_ACTION_CHOICES}
                value={enterAction}
                senderId={enterId}
                componentStatePreservationKey="numpadEnterAction"
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Completion popup</span>
              <TugChoiceGroup
                items={COMPLETION_DIRECTION_CHOICES}
                value={completionDirection}
                senderId={completionDirId}
                componentStatePreservationKey="completionDirection"
                size="sm"
              />
            </div>
          </div>
        </div>

        <TugSeparator />

        {/* ---- Style ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Style</TugLabel>
          <div className="gallery-text-editor-row">
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Focus style</span>
              <TugChoiceGroup
                items={FOCUS_STYLE_CHOICES}
                value={focusStyle}
                senderId={focusId}
                componentStatePreservationKey="focusStyle"
                size="sm"
              />
            </div>
            <div className="gallery-text-editor-row-cell">
              <span className="gallery-text-editor-row-label">Border</span>
              <TugChoiceGroup
                items={BORDERLESS_CHOICES}
                value={borderless ? "true" : "false"}
                senderId={borderlessId}
                componentStatePreservationKey="borderless"
                size="sm"
              />
            </div>
          </div>
        </div>

        <TugSeparator />

        {/* ---- Submit counter ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">
            {`Submits: ${submitCount}`}
          </TugLabel>
        </div>

      </div>
    </ResponderScope>
  );
}
