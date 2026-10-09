/**
 * TugValueInput — Compact inline numeric editor with formatted display.
 *
 * Standalone field for displaying and editing a single numeric value.
 * Supports formatted display (e.g. "75%"), type-to-replace on focus,
 * arrow key increment/decrement, validate-on-commit, and Escape to revert.
 * All input value management is imperative via refs — no React state for
 * the display/edit cycle. [L06]
 *
 * Per [L11], TugValueInput is a control that owns state the editing
 * actions operate on: a caret, selection, and the input's native
 * undo stack. Inside a `ResponderChainProvider` it registers as a
 * responder node and handles `cut` / `copy` / `paste` / `selectAll`
 * / `undo` / `redo` via the shared `useTextInputResponder` hook —
 * the same hook used by TugInput and TugTextarea. It also dispatches
 * a `setValue` action with `phase: "discrete"` on every commit path
 * (blur, Enter, arrow key). Outside a provider, the input still
 * renders correctly with its full imperative editing cycle — the
 * chain dispatches become no-ops and the custom context menu is
 * suppressed, but native editing is unaffected. A single component
 * handles both cases via `useOptionalResponder`; provider
 * transitions never flip React's component identity, so caret and
 * focus survive wrap/unwrap tests.
 *
 * When used standalone, parents bind via the `setValueNumber` slot
 * in `useResponderForm` using a gensym'd `senderId`. When nested
 * inside `TugSlider`, the slider passes its own `senderId` down so
 * both the slider drag and the value-input edits dispatch under the
 * same sender — the parent handler receives both and can branch on
 * `event.phase` (`"change"` for live scrub, `"discrete"` for the
 * text field commit).
 *
 * Right-click opens a `TugEditorContextMenu` anchored at the cursor
 * with cut / copy / paste / selectAll items, driven by the shared
 * hook.
 *
 * Laws: [L06] appearance via DOM refs not React state,
 *       [L11] controls emit actions; responders handle actions,
 *       [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide
 * Decisions: [D05] component token naming
 */

import "./tug-value-input.css";

import React, { useRef, useCallback, useId, useLayoutEffect } from "react";
import { cn } from "@/lib/utils";
import type { TugFormatter } from "@/lib/tug-format";
import { clamp, validateNumericInput } from "@/lib/tug-validate";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import { useControlDispatch } from "./use-control-dispatch";
import { useFocusable } from "./use-focusable";
import type { FocusPolicy } from "./focus-manager";
import { useTextInputResponder } from "./use-text-input-responder";
import { TUG_ACTIONS } from "./action-vocabulary";
import { useComponentStatePreservation } from "./use-component-state-preservation";

// ---- Props ----

export interface TugValueInputProps
  extends Omit<React.ComponentPropsWithoutRef<"input">, "value" | "onChange" | "defaultValue" | "type" | "size"> {
  /** Current numeric value. Display is derived from this via the formatter. */
  value: number;
  /**
   * Stable opaque sender id for chain dispatches. Auto-derived via
   * `useId()` if omitted. Parent responders disambiguate multi-input
   * forms by matching this id in their `setValue` handler bindings.
   * When nested inside `TugSlider`, the slider passes its own senderId
   * down so both the drag and text-input dispatches share the same
   * sender. [L11]
   */
  senderId?: string;
  /** Formatter for display/parse. When absent, shows raw number. */
  formatter?: TugFormatter<number>;
  /** Minimum value. Used for clamping on commit and arrow key lower bound. */
  min?: number;
  /** Maximum value. Used for clamping on commit and arrow key upper bound. */
  max?: number;
  /**
   * Step increment for arrow keys and snap-to-step on commit.
   * @default 1
   */
  step?: number;
  /**
   * Visual size variant.
   * @selector .tug-value-input-sm | .tug-value-input-md | .tug-value-input-lg
   * @default "md"
   */
  size?: "sm" | "md" | "lg";
  /**
   * What the input shows when focused for editing.
   * - "display" (default): stripped display-space number ("50%" → "50", "2.5 s" → "2.5")
   * - "raw": internal value ("50%" → "0.5")
   * @default "display"
   */
  editMode?: "display" | "raw";
  /**
   * @selector [aria-disabled="true"]
   * @default false
   */
  disabled?: boolean;
  /**
   * Opt the value input into the Component State Preservation Protocol
   * ([D13], [A9]). When provided (and rendered inside a card), the
   * numeric value is captured into
   * `bag.components[componentStatePreservationKey]` at every save
   * trigger. On restore the component re-dispatches `setValue` (phase
   * `discrete`) so the parent (which owns `value`) updates.
   * Controlled-only — no internal mirror.
   *
   * Note: when nested inside a `TugSlider` that already opts in via
   * its own `componentStatePreservationKey`, the value-input should
   * leave `componentStatePreservationKey` undefined to avoid
   * double-capture. The slider's `componentStatePreservationKey`
   * captures the same axis on a parent-scope key.
   */
  componentStatePreservationKey?: string;

  // ---- Focus engine ([P02]) ----
  /** Author this input into a focus group so Tab reaches it ([P02]). When set,
   *  the input registers as a Tab stop; arrows step the value (the input owns
   *  them natively, so the spatial plane yields). */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0. */
  focusOrder?: number;
  /** Walk policy when registered: `accept` (default) or `skip`. */
  focusPolicy?: FocusPolicy;
}

/** Serialized shape of `TugValueInput`'s preserved state. */
interface TugValueInputState {
  value: number;
}

// ---- Helpers ----

/** Strip non-numeric decoration from a formatted string, keeping digits, decimal, and minus. */
function extractNumericPart(formatted: string): string {
  return formatted.replace(/[^0-9.-]/g, "");
}

// ---- Shared editing hook ----
//
// Encapsulates all the imperative DOM value management (display/edit
// cycle, focus/blur/keydown handlers, ref tracking). Called by both
// the plain and responder variants so the variants don't duplicate
// ~200 lines of editing logic.

interface UseValueInputEditingOptions {
  value: number;
  formatter: TugFormatter<number> | undefined;
  min: number | undefined;
  max: number | undefined;
  step: number;
  editMode: "display" | "raw";
  dispatchCommit: (committed: number) => void;
}

interface UseValueInputEditingResult {
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  displayValue: string;
  inputWidth: string;
  handleFocus: () => void;
  handleMouseUp: (e: React.MouseEvent<HTMLInputElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleBlur: () => void;
}

function useValueInputEditing({
  value,
  formatter,
  min,
  max,
  step,
  editMode,
  dispatchCommit,
}: UseValueInputEditingOptions): UseValueInputEditingResult {
  // ---- Imperative value management [L06] ----
  //
  // All input value changes go through DOM. No React state for the display/edit
  // cycle — this prevents re-renders on every keystroke and preserves text selection.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editingRef = useRef<boolean>(false);
  const escapeRef = useRef<boolean>(false);
  // Guards against mouseup deselecting text after click-to-focus.
  const justFocusedRef = useRef<boolean>(false);

  // ---- Input width based on longest formatted boundary value ----
  const displayMin = formatter ? formatter.format(min ?? 0) : String(min ?? 0);
  const displayMax = formatter ? formatter.format(max ?? 100) : String(max ?? 100);
  const inputWidth = `${Math.max(displayMin.length, displayMax.length) + 2}ch`;

  // ---- Sync display value when not editing [L06] ----
  //
  // When value prop changes externally (e.g. slider drag, parent state update)
  // and the input is not being edited, update the DOM directly.
  const displayValue = formatter ? formatter.format(value) : String(value);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && !editingRef.current) {
      input.value = displayValue;
    }
  }, [displayValue]);

  // ---- Focus handler ----
  const handleFocus = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    editingRef.current = true;
    escapeRef.current = false;
    justFocusedRef.current = true;

    if (editMode === "raw") {
      // Show internal value: "50%" → "0.5"
      input.value = String(value);
    } else {
      // Show display-space number without decoration: "50%" → "50", "2.5 s" → "2.5"
      const formatted = formatter ? formatter.format(value) : String(value);
      input.value = extractNumericPart(formatted);
    }
    input.select();
  }, [value, formatter, editMode]);

  // ---- MouseUp handler ----
  //
  // Prevent the mouseup after click-to-focus from placing the cursor
  // and deselecting the text. Only suppressed on the first mouseup
  // after focus — subsequent clicks within the field work normally.
  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      if (justFocusedRef.current) {
        e.preventDefault();
        justFocusedRef.current = false;
      }
    },
    [],
  );

  // ---- KeyDown handler ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        escapeRef.current = true;
        // Revert to display value before blurring.
        const display = formatter ? formatter.format(value) : String(value);
        e.currentTarget.value = display;
        editingRef.current = false;
        e.currentTarget.blur();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const effectiveMax = max ?? Infinity;
        const next = clamp(value + step, -Infinity, effectiveMax);
        // Guard: at max, clamp returns value unchanged — no dispatch.
        if (next !== value) dispatchCommit(next);
        const input = inputRef.current;
        if (input) {
          const formatted = formatter ? formatter.format(next) : String(next);
          input.value = editMode === "display" ? extractNumericPart(formatted) : String(next);
          input.select();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const effectiveMin = min ?? -Infinity;
        const next = clamp(value - step, effectiveMin, Infinity);
        // Guard: at min, clamp returns value unchanged — no dispatch.
        if (next !== value) dispatchCommit(next);
        const input = inputRef.current;
        if (input) {
          const formatted = formatter ? formatter.format(next) : String(next);
          input.value = editMode === "display" ? extractNumericPart(formatted) : String(next);
          input.select();
        }
      }
    },
    [value, formatter, editMode, min, max, step, dispatchCommit],
  );

  // ---- Blur handler ----
  const handleBlur = useCallback(() => {
    const input = inputRef.current;
    editingRef.current = false;

    if (escapeRef.current) {
      escapeRef.current = false;
      return;
    }

    // Parse the typed text back to an internal value.
    const raw = input?.value ?? "";
    const effectiveMin = min ?? -Infinity;
    const effectiveMax = max ?? Infinity;
    let parsed: number | null = null;

    if (formatter) {
      // Try formatter parse first — handles decorated input ("75%", "$42").
      parsed = formatter.parse(raw);
      // If that fails and we're in display mode, the user may have typed a
      // bare number in display space (e.g., "75" meaning 75%). Re-decorate
      // and parse again.
      if (parsed === null && editMode === "display") {
        // Attempt to reconstruct: format a known value, replace its numeric
        // portion with the user's input, then parse the result.
        const template = formatter.format(value);
        const reconstructed = template.replace(extractNumericPart(template), raw);
        parsed = formatter.parse(reconstructed);
      }
    }

    // Clamp and snap if formatter parse succeeded.
    if (parsed !== null) {
      parsed = clamp(parsed, effectiveMin, effectiveMax);
      const base = effectiveMin === -Infinity ? 0 : effectiveMin;
      parsed = Math.round((parsed - base) / step) * step + base;
    }

    // Fall back to plain numeric validation if no formatter or formatter failed.
    if (parsed === null) {
      parsed = validateNumericInput(raw, { min: effectiveMin, max: effectiveMax, step });
    }

    // Only dispatch when the parsed value actually differs from
    // the current prop. Tabbing through a form of untouched inputs
    // would otherwise fire one spurious `setValue` dispatch per
    // blur — the equality guard saves every responder in the chain
    // walk from re-evaluating identical payloads.
    if (parsed !== null && parsed !== value) {
      dispatchCommit(parsed);
    }

    // Restore display format (whether committed or reverted).
    if (input) {
      const committed = parsed ?? value;
      input.value = formatter ? formatter.format(committed) : String(committed);
    }
  }, [min, max, step, value, formatter, editMode, dispatchCommit]);

  return {
    inputRef,
    displayValue,
    inputWidth,
    handleFocus,
    handleMouseUp,
    handleKeyDown,
    handleBlur,
  };
}

// ---- Shared rendering ----

function buildInputClassName(
  size: "sm" | "md" | "lg",
  className: string | undefined,
): string {
  return cn("tug-value-input", `tug-value-input-${size}`, className);
}

// ---- Public component ----

/**
 * TugValueInput — chain-aware when inside a provider, plain when not.
 *
 * Single component that adapts to its environment: inside a
 * `<ResponderChainProvider>` it registers as a chain responder with
 * cut/copy/paste/selectAll/undo/redo handlers, dispatches `setValue`
 * on commit paths, and shows a right-click context menu; outside a
 * provider it renders as a plain native `<input>` with full local
 * editing (focus, blur, arrow keys, Enter, Escape) but `setValue`
 * becomes a no-op and the custom menu is suppressed. The branch
 * happens inside the hooks, not at the component-type level, so a
 * provider transition never flips React's reconciliation identity —
 * the `<input>` element stays mounted and preserves caret, focus,
 * and the imperative display/edit cycle state. See
 * `useOptionalResponder` for the transition mechanics.
 */
export const TugValueInput = React.forwardRef<HTMLInputElement, TugValueInputProps>(
  function TugValueInput(
    {
      value,
      senderId,
      formatter,
      min,
      max,
      step = 1,
      size = "md",
      editMode = "display",
      disabled = false,
      className,
      style,
      onContextMenu,
      componentStatePreservationKey,
      focusGroup,
      focusOrder = 0,
      focusPolicy,
      ...rest
    },
    ref,
  ) {
    const boxDisabled = useTugBoxDisabled();
    const effectiveDisabled = disabled || boxDisabled;
    const autoFocusableId = useId();
    const { focusableRef } = useFocusable({
      id: autoFocusableId,
      group: focusGroup ?? "",
      order: focusOrder,
      policy: focusPolicy,
      register: !effectiveDisabled && focusGroup !== undefined,
    });

    // ---- Chain dispatch [L11] ----
    //
    // Targeted dispatch of `setValue` to the parent responder on
    // commit paths (blur, Enter, arrow key). Outside a provider
    // the dispatch is a no-op — native editing is unaffected.
    const { dispatch: controlDispatch } = useControlDispatch();
    const fallbackSenderId = useId();
    const effectiveSenderId = senderId ?? fallbackSenderId;
    const dispatchCommit = useCallback(
      (committed: number) => {
        controlDispatch({
          action: TUG_ACTIONS.SET_VALUE,
          value: committed,
          sender: effectiveSenderId,
          phase: "discrete",
        });
      },
      [controlDispatch, effectiveSenderId],
    );

    // Opt-in Component State Preservation Protocol. Hook no-ops when
    // `componentStatePreservationKey` is undefined. Controlled-only —
    // the parent responder owns `value` and carries its own saved state
    // via [A9]; it mounts in the saved value on cold boot, which flows
    // back down here through the `value` prop. [D13] / [A9].
    useComponentStatePreservation<TugValueInputState>({
      componentStatePreservationKey,
      captureState: () => ({ value }),
    });

    const editing = useValueInputEditing({
      value,
      formatter,
      min,
      max,
      step,
      editMode,
      dispatchCommit,
    });

    // Everything chain-related lives in the shared hook: the six
    // editing action handlers, responder-node registration (via
    // `useOptionalResponder` — tolerates no-provider mode), ref
    // composition (editing.inputRef + forwarded + data-responder-id),
    // the onContextMenu bridge, and the context menu JSX (gated to
    // null when there is no provider). Pass `editing.inputRef`
    // through as the hook's `inputRef` — the same ref that
    // `useValueInputEditing` reads selection from is the one the
    // hook writes to when composing refs, so they stay in sync.
    const { composedRef, handleContextMenu, contextMenu } = useTextInputResponder({
      inputRef: editing.inputRef,
      disabled: effectiveDisabled,
      forwardedRef: ref,
      onContextMenu,
    });

    // Compose the chain/forwarded ref with the focus-engine ref so the input is
    // both a responder element and an authored Tab stop.
    const setInputRef = useCallback(
      (el: HTMLInputElement | null) => {
        composedRef(el);
        focusableRef(el);
      },
      [composedRef, focusableRef],
    );

    return (
      <>
        <input
          ref={setInputRef}
          type="text"
          data-slot="tug-value-input"
          className={buildInputClassName(size, className)}
          defaultValue={editing.displayValue}
          style={{ width: editing.inputWidth, ...style }}
          aria-disabled={effectiveDisabled || undefined}
          aria-label="Value"
          onFocus={editing.handleFocus}
          onMouseUp={editing.handleMouseUp}
          onKeyDown={editing.handleKeyDown}
          onBlur={editing.handleBlur}
          onContextMenu={handleContextMenu}
          {...rest}
        />
        {contextMenu}
      </>
    );
  },
);
