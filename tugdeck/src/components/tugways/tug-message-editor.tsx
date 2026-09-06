/**
 * `TugMessageEditor` — a small reusable multi-line message field over the
 * {@link TugTextEditor} CM6 substrate.
 *
 * One CM6 field for short authored messages (the Changeset card's
 * commit-message composer is the first consumer; the question wizard's answer
 * and reply fields are the standalone-frame form, `borderless={false}` plus a
 * `focusGroup` stop). It composes the substrate
 * exactly as {@link TugFindBar} composes it for its query field: a
 * `borderless`, `preserveState={false}` mount with an
 * `EditorView.updateListener` that mirrors the document text back out — no
 * controlled-input round-trip. Because the substrate IS the editor, the
 * clipboard/undo responders (CUT / COPY / PASTE / SELECT_ALL / UNDO / REDO)
 * come for free through `TugTextEditor`'s own `useOptionalResponder`
 * registration ([L11], [P26]); the field wires none of its own.
 *
 * ## The mirror reports the substrate, not a string
 *
 * `onChange` hands out the whole `(text, atoms)` pair ([B04]). A field that
 * mirrored `doc.toString()` alone reported a `U+FFFC` where every chip stood
 * and nothing at all about what it was, so a host could not have held its
 * atoms even if it wanted to — a chip pasted into a Jot, a question answer or
 * a commit message was already lost by the time the host saw the edit. Every
 * host therefore keeps the pair for as long as its field lives, and the seam
 * that puts a document back (`value` + `atoms`, {@link
 * TugMessageEditorHandle.restoreState}) takes the pair too. Flattening to a
 * string is an exit-time act, in the spelling the thing outside Tug reads —
 * never an edit-time one.
 *
 * ## onChange fires for USER edits only
 *
 * The mirror `updateListener` fires `onChange` only for user-originated
 * document changes (typing, delete, paste, undo/redo) — NOT for the
 * programmatic {@link TugMessageEditorHandle.restoreState} /
 * {@link TugMessageEditorHandle.clear} seams, which dispatch non-user
 * transactions (restore carries no `userEvent`; clear carries the internal
 * `delete.tug-clear` marker, filtered out). This is what lets a consumer seed
 * a draft into a pristine field via `restoreState()` WITHOUT that seed reading
 * as a user edit — the [P28] pinning contract: a new draft streams in silently,
 * the field pins only when the human actually edits it.
 *
 * Keys: `returnAction="newline"` (Enter inserts a newline — this is a
 * multi-line message, not a submit-on-Enter input); Cmd-Enter fires `onSubmit`
 * regardless of `returnAction`, per the substrate contract.
 *
 * Laws: [L02] the document lives in CM6, mirrored out imperatively — never a
 * controlled React value; [L06] appearance via the substrate's CSS/DOM; [L11]
 * editing responders ride the composed substrate; [L19] `.tsx` + `.css` pair,
 * exported props interface, `data-slot`; [L20] composes the real
 * `TugTextEditor` — no borrowed CSS.
 *
 * @module components/tugways/tug-message-editor
 */

import "./tug-message-editor.css";

import React, { useMemo, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { cn } from "@/lib/utils";
import type {
  TugSubstrateAtom,
  TugTextSubstrate,
} from "@/lib/tug-text-types";
import { captureSubstrate } from "@/components/tugways/tug-text-editor/keymap";
import {
  TugTextEditor,
  type TugTextEditorDelegate,
  type TugTextEditorFocusStyle,
} from "@/components/tugways/tug-text-editor";
import type { FocusPolicy } from "@/components/tugways/focus-manager";

/**
 * Resting/maximum visible rows before the field scrolls. The 3-row resting
 * height (≈ the retired `TugTextarea`'s `rows={3}`) is reserved by the CSS
 * `--tug-text-editor-min-height` floor; this cap lets a longer message grow to
 * a comfortable height before it scrolls.
 */
const DEFAULT_MAX_ROWS = 12;

/**
 * Imperative surface a consumer drives: seed a draft into a pristine field
 * (`restoreState`) and empty it (`clear`). Both are PROGRAMMATIC — they do not
 * fire `onChange`, so seeding a draft never reads as a user edit (the [P28]
 * pinning contract).
 */
export interface TugMessageEditorHandle {
  /**
   * Replace the field's document — text AND atoms — without claiming focus or
   * firing `onChange`. Handing back only the text would drop every chip in it
   * to a bare placeholder, which is exactly the demotion [B04] forbids.
   */
  restoreState(substrate: TugTextSubstrate): void;
  /** Empty the field without firing `onChange`. */
  clear(): void;
  /** Move keyboard focus into the field. */
  focus(): void;
  /**
   * Bring the caret into view in every enclosing scroller, the outer ones
   * included. A consumer that lets the field grow uncapped inside its own
   * scroller (the Jots editor: the list scrolls, not the field) calls
   * this on each edit — see the substrate's `revealCaret` for the scheduling.
   */
  revealCaret(): void;
}

export interface TugMessageEditorProps {
  /**
   * Initial document text, seeded once at mount. Later prop changes do NOT
   * round-trip into the field (no controlled input) — a consumer pushes new
   * text through {@link TugMessageEditorHandle.restoreState} instead.
   */
  value?: string;
  /**
   * Atoms standing at the `U+FFFC` positions in {@link value}, seeded with it
   * once at mount. Omit for a plain-text seed; a seed whose text carries
   * placeholders but whose atoms are missing renders them as bare characters.
   */
  atoms?: readonly TugSubstrateAtom[];
  /**
   * Fired with the mirrored `(text, atoms)` substrate on every USER edit
   * (typing, paste, delete, undo/redo). NOT fired for the programmatic
   * `restoreState` / `clear` seams — see the module docstring.
   */
  onChange?: (substrate: TugTextSubstrate) => void;
  /** Fired on Cmd-Enter (regardless of `returnAction`). */
  onSubmit?: () => void;
  /**
   * Fired when a paste carried its source project's roots. Forwarded to the
   * substrate; see `TugTextEditorProps.onPastedOrigins`. The Jots editor
   * records them on the jot, which is what lets a relative path pasted out of
   * a transcript keep resolving after that session is gone.
   */
  onPastedOrigins?: (origins: readonly string[]) => void;
  /**
   * Whether a submit Enter defers to a default button on the responder chain
   * instead of firing `onSubmit`. Forwarded to the substrate. @default true
   */
  deferToDefaultButton?: boolean;
  /** Empty-state hint shown while the document is empty. */
  placeholder?: string;
  /** Maximum visible rows before the field scrolls. @default 12 */
  maxRows?: number;
  /**
   * Soft-wrap long lines instead of scrolling horizontally. Forwarded to the
   * substrate (`EditorView.lineWrapping` + `data-wrap`). @default false
   */
  lineWrap?: boolean;
  /**
   * Light markdown token styling (heading / emphasis / code colors and
   * weights, raw syntax always visible). Forwarded to the substrate's
   * `markdownTextStyling`. @default false
   */
  markdownTextStyling?: boolean;
  /**
   * Editor font size (a CSS length; drives `--tug-font-size-editor` on the
   * substrate). Omit to keep the substrate default.
   */
  fontSize?: string;
  /** Read-only + non-editable when true. */
  disabled?: boolean;
  /**
   * Suppress the substrate's own field frame. `true` (the default) is the
   * embedded form: the consumer's surrounding well owns the border, as the
   * Changeset composer's does. Set `false` for a standalone field that should
   * wear the substrate's field border + focus treatment — the same frame the
   * retired `TugTextarea` drew. @default true
   */
  borderless?: boolean;
  /**
   * Focus indication style for the field frame, forwarded to the substrate.
   * @default "background"
   */
  focusStyle?: TugTextEditorFocusStyle;
  /**
   * Let Tab move keyboard focus out of the field instead of indenting.
   * Forwarded to the substrate. Use in a dialog whose action buttons must stay
   * keyboard-reachable from the message field. @default false
   */
  tabMovesFocus?: boolean;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this field is authored into, forwarded to the substrate. When
   * set, the field becomes a stop in the engine's Tab / arrow walk and the
   * key view lands the caret through the editor's focus contract.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. */
  focusOrder?: number;
  /** Walk policy when registered. */
  focusPolicy?: FocusPolicy;
  /**
   * Forwarded to the substrate: a transient, in-list editor (the Jots
   * editor) that is not its card's primary text surface should NOT register
   * card engine hooks, whose mount/unmount churn re-fires the card's focus
   * restore and steals the keyboard key view. @default false
   */
  suppressCardEngineHooks?: boolean;
  /**
   * Extra CM6 extensions, installed at mount alongside the field's own
   * document mirror. Mount-captured like the substrate's own `extensions`
   * prop — a later change does NOT propagate — so an extension that needs
   * live host state reads it through a stable closure rather than a new
   * identity (the Jots editor's annotation links do exactly that).
   */
  extensions?: Extension | readonly Extension[];
  /** Forwarded to the host wrapper. */
  className?: string;
  /** Test hook, forwarded to the host wrapper. */
  "data-testid"?: string;
  /** Accessible label, forwarded to the host wrapper. */
  "aria-label"?: string;
}

export const TugMessageEditor = React.forwardRef<
  TugMessageEditorHandle,
  TugMessageEditorProps
>(function TugMessageEditor(
  {
    value,
    atoms,
    onChange,
    onSubmit,
    onPastedOrigins,
    deferToDefaultButton = true,
    placeholder,
    maxRows = DEFAULT_MAX_ROWS,
    suppressCardEngineHooks = false,
    lineWrap,
    markdownTextStyling,
    fontSize,
    disabled = false,
    borderless = true,
    focusStyle,
    tabMovesFocus = false,
    focusGroup,
    focusOrder,
    focusPolicy,
    extensions,
    className,
    "data-testid": dataTestid,
    "aria-label": ariaLabel,
  },
  ref,
) {
  const substrateRef = useRef<TugTextEditorDelegate | null>(null);

  // Callbacks read through refs so the mount-captured extension always sees
  // the latest handler without rebuilding ([L07], the find-bar's technique).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Seed `value` once — the mount-time initial text. Applied via the substrate
  // delegate's programmatic restore (no `onChange`). A ref guard keeps it a
  // one-shot even across a Fast-Refresh effect re-run.
  const seededRef = useRef(false);

  // The doc-mirror extension, captured at mount (the substrate reads
  // `extensions` once). Fires `onChange` only for genuine user edits — the
  // programmatic restore/clear paths carry no matching `userEvent`, so a
  // seeded draft never reads as a user edit ([P28] pinning). `delete.tug-clear`
  // is the substrate's own `clear()` marker and is excluded explicitly.
  //
  // Host extensions ride along, snapshotted at mount for the same reason:
  // the substrate would ignore a later identity anyway, and a ref snapshot
  // says so rather than implying a live prop.
  const hostExtensionsRef = useRef(extensions);
  const messageEditorExtensions = useMemo(() => {
    const mirror = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const userEdit = update.transactions.some(
        (t) =>
          (t.isUserEvent("input") ||
            t.isUserEvent("delete") ||
            t.isUserEvent("undo") ||
            t.isUserEvent("redo")) &&
          !t.isUserEvent("delete.tug-clear"),
      );
      if (!userEdit) return;
      // The whole substrate, not `doc.toString()`: what the host receives is
      // what the field holds, chips included ([B04]).
      onChangeRef.current?.(captureSubstrate(update.state));
    });
    const host = hostExtensionsRef.current;
    return host === undefined ? mirror : [mirror, host];
  }, []);

  const seed = (substrate: TugTextSubstrate): void => {
    substrateRef.current?.restoreState({
      text: substrate.text,
      atoms: [...substrate.atoms],
      selection: null,
    });
  };

  // Seed `value` once, from a layout effect — NOT from the substrate ref
  // callback. `TugTextEditor` declares its `useImperativeHandle` (the delegate
  // this ref receives) BEFORE its view-creation `useLayoutEffect`, so the
  // delegate lands while `viewRef.current` is still null and a seed from the
  // ref callback restores into a view that does not exist yet — a silent no-op
  // that drops the initial text (a real data-loss path when the field opens an
  // existing document). A parent layout effect runs AFTER the child's
  // view-creation effect, so the view is live by the time this fires; the
  // delegate reads `viewRef.current` at call time, so the restore lands.
  const valueRef = useRef(value);
  valueRef.current = value;
  const seedAtomsRef = useRef(atoms);
  seedAtomsRef.current = atoms;
  React.useLayoutEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const initial = valueRef.current;
    if (initial !== undefined && initial !== "") {
      seed({ text: initial, atoms: seedAtomsRef.current ?? [] });
    }
    // Mount-only seed; later `value` changes go through `restoreState`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useImperativeHandle(
    ref,
    (): TugMessageEditorHandle => ({
      restoreState: (substrate) => seed(substrate),
      clear: () => substrateRef.current?.clear(),
      focus: () => substrateRef.current?.focus(),
      revealCaret: () => substrateRef.current?.revealCaret(),
    }),
    [],
  );

  return (
    <TugTextEditor
      ref={(delegate) => {
        substrateRef.current = delegate;
      }}
      className={cn("tug-message-editor", className)}
      data-slot="tug-message-editor"
      data-testid={dataTestid}
      aria-label={ariaLabel}
      borderless={borderless}
      focusStyle={focusStyle}
      suppressCardEngineHooks={suppressCardEngineHooks}
      preserveState={false}
      returnAction="newline"
      deferToDefaultButton={deferToDefaultButton}
      maxRows={maxRows}
      lineWrap={lineWrap}
      markdownTextStyling={markdownTextStyling}
      fontSize={fontSize}
      placeholder={placeholder}
      disabled={disabled}
      tabMovesFocus={tabMovesFocus}
      focusGroup={focusGroup}
      focusOrder={focusOrder}
      focusPolicy={focusPolicy}
      onSubmit={onSubmit}
      onPastedOrigins={onPastedOrigins}
      extensions={messageEditorExtensions}
    />
  );
});
