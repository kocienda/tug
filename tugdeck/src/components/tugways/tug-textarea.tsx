/**
 * TugTextarea — tugways public API for multi-line text inputs.
 *
 * Wraps a plain <textarea> element (not a Radix primitive). All visual states
 * are driven by --tug7-field-* tokens — theme switches update CSS
 * variables at the DOM level with no React re-renders.
 *
 * Auto-resize adjusts height imperatively via the native input event [L06].
 * Character counter renders below the textarea when maxLength is set.
 *
 * ## Chain participation
 *
 * TugTextarea consumes `useTextInputResponder`, which registers the
 * component as a chain responder (via `useOptionalResponder`) and
 * handles the six standard editing actions (`cut`, `copy`, `paste`,
 * `selectAll`, `undo`, `redo`). See that hook's module docstring for
 * the full dispatch semantics, the paste-sync rationale, and the
 * reason execCommand("paste") must run in the sync phase.
 *
 * Like TugInput, TugTextarea is a single component that adapts to
 * its environment: inside a `<ResponderChainProvider>` it registers
 * as a responder with a right-click context menu; outside a provider
 * it renders as a plain `<textarea>` with no chain wiring. Provider
 * transitions preserve the `<textarea>` element (caret, focus,
 * selection, auto-resize height all survive) because the branching
 * happens inside the hooks, not at the component-type level. See
 * `useOptionalResponder` for the transition mechanics.
 *
 * Laws: [L06] appearance via CSS / imperative DOM for auto-resize,
 *       [L11] controls emit actions; responders handle actions,
 *       [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide
 * Decisions: [D04] token-driven control state model,
 *            [D05] component token naming
 */

import "./tug-textarea.css";
import type { TugSize } from "./tug-vocabulary";

import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import { useTextInputResponder } from "./use-text-input-responder";
import { useFocusable } from "./use-focusable";
import type { FocusPolicy } from "./focus-manager";

// ---- Types ----

/** TugTextarea size names — matches TugInput and TugButton sizes */
export type TugTextareaSize = Extract<TugSize, "sm" | "md" | "lg">;

/** TugTextarea validation state */
export type TugTextareaValidation = "default" | "invalid" | "valid" | "warning";

/** TugTextarea resize direction */
export type TugTextareaResize = "horizontal" | "vertical" | "both";

/** TugTextarea props — extends native textarea attributes. */
export interface TugTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> {
  /**
   * Visual size variant.
   * @selector .tug-textarea-size-sm | .tug-textarea-size-md | .tug-textarea-size-lg
   * @default "md"
   */
  size?: TugTextareaSize;
  /**
   * Validation state. Controls border color.
   * @selector .tug-textarea-invalid | .tug-textarea-valid | .tug-textarea-warning
   * @default "default"
   */
  validation?: TugTextareaValidation;
  /**
   * User-resizable direction. Sets CSS resize property.
   * When omitted, the textarea is not user-resizable (resize: none).
   * @selector .tug-textarea-resize-horizontal | .tug-textarea-resize-vertical | .tug-textarea-resize-both
   * @default undefined (not resizable)
   */
  resize?: TugTextareaResize;
  /**
   * Number of visible text rows. Maps to the HTML rows attribute.
   * @default 3
   */
  rows?: number;
  /**
   * Maximum character count. When provided, renders a character counter
   * below the textarea showing "current / max".
   * @default undefined (no limit, no counter)
   */
  maxLength?: number;
  /**
   * Auto-resize: grow the textarea height to fit content, up to maxRows.
   * Implemented via imperative DOM height adjustment [L06].
   * @default false
   */
  autoResize?: boolean;
  /**
   * Maximum rows before scrolling kicks in. Only meaningful when autoResize is true.
   * @default undefined (no limit — grows indefinitely)
   */
  maxRows?: number;
  /**
   * Focus indication style.
   * "background" — subtle background shift on focus (default).
   * "ring" — accent border ring on focus.
   * @default "background"
   */
  focusStyle?: "background" | "ring";
  /**
   * Remove visible border. For embedding in compound components
   * where the parent owns the border treatment.
   * @default false
   */
  borderless?: boolean;
  /**
   * Opt into DOM-authority state preservation. When set, the rendered
   * `<textarea>` carries `data-tug-state-key={componentStatePreservationKey}`.
   * CardHost's save path captures the element's `value`, selection,
   * and scroll at save time and reapplies them on restore.
   *
   * **Uniqueness.** The key must be unique **within the owning card's
   * content subtree**. Cross-card collisions are impossible: CardHost
   * scopes its DOM query to the card's own root (the
   * `[data-card-host][data-card-id]` div), so sibling cards in the
   * same pane (tabs) and separate card instances each keep their own
   * isolated bag. Collisions within one card are author error.
   *
   * **Uncontrolled only.** Use with uncontrolled textareas (native
   * `defaultValue` or no value prop). Setting `.value` on a controlled
   * textarea (`value={state}`) will be immediately overwritten on the
   * next React render — use `useCardStatePreservation` for controlled state.
   */
  componentStatePreservationKey?: string;
  /**
   * Author the field into a focus group ([P02]) — the standard `useFocusable`
   * opt-in, mirroring {@link TugInput}. When set, the `<textarea>` registers as
   * one stop in the surrounding surface's trapped Tab walk, so the engine lands
   * the key view (and the ring) on the real caret and Tab moves to/from it like
   * any other control. Omitted ⇒ the field stays a plain native focus stop
   * (unchanged behavior). A text field never consumes Tab — Tab always moves to
   * the next focusable.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /** Focus policy for the registered stop ([P02]); forwarded to `useFocusable`. */
  focusPolicy?: FocusPolicy;
}

// ---- Shared rendering helper ----
//
// Both the plain and responder-wired variants render identical JSX.
// The body owns the auto-resize imperative ref, the character counter,
// and the optional maxLength wrapper. The caller (plain or
// WithResponder) supplies a single `ref` prop that the body merges
// with its own internal ref. The plain variant hands through the
// consumer's forwarded ref directly; the WithResponder variant passes
// the pre-composed `composedRef` from `useTextInputResponder` (which
// has already merged internal + forwarded + data-responder-id).

interface TugTextareaBodyProps
  extends Omit<TugTextareaProps, "size" | "validation" | "resize" | "focusStyle" | "borderless"> {
  size: TugTextareaSize;
  validation: TugTextareaValidation;
  resize?: TugTextareaResize;
  focusStyle: "background" | "ring";
  borderless: boolean;
  /**
   * Single ref slot. Composed with the body's own auto-resize ref via
   * the internal `setRef`. For the plain variant this is the
   * consumer's forwarded ref; for the responder variant it's the
   * hook's `composedRef` (which already merges the consumer ref + the
   * hook's inputRef + data-responder-id).
   *
   * Named `hostRef` rather than `ref` so the body can stay a plain
   * `React.FC` without tripping the reserved-`ref`-prop name.
   */
  hostRef?: React.Ref<HTMLTextAreaElement>;
}

const TugTextareaBody: React.FC<TugTextareaBodyProps> = ({
  size,
  validation,
  resize,
  rows = 3,
  maxLength,
  autoResize = false,
  maxRows,
  focusStyle,
  borderless,
  componentStatePreservationKey,
  className,
  disabled,
  onChange,
  value,
  defaultValue,
  hostRef,
  ...rest
}) => {
  const boxDisabled = useTugBoxDisabled();
  const effectiveDisabled = disabled || boxDisabled;

  // Internal ref for imperative auto-resize. Merged with the caller's
  // `hostRef` in setRef below so the element lands on both.
  const internalRef = useRef<HTMLTextAreaElement | null>(null);

  // The character counter is appearance: its text and its warning/danger
  // colour are written to the DOM from the field's own value ([L06]), after
  // every commit (a controlled value) and on every input.
  const counterRef = useRef<HTMLSpanElement | null>(null);
  const paintCounter = useCallback(() => {
    const el = internalRef.current;
    const counter = counterRef.current;
    if (el === null || counter === null || maxLength === undefined) return;
    const count = el.value.length;
    counter.textContent = `${count} / ${maxLength}`;
    counter.classList.toggle("tug-textarea-counter-danger", count >= maxLength);
    counter.classList.toggle(
      "tug-textarea-counter-warning",
      count < maxLength && count >= maxLength - Math.ceil(maxLength * 0.1),
    );
  }, [maxLength]);
  useLayoutEffect(() => {
    paintCounter();
  });

  // Merge the caller-supplied `hostRef` with the body's own
  // `internalRef`. React calls setRef with the element on mount and
  // with null on unmount, so the hostRef gets cleaned up the same
  // way internalRef does.
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      internalRef.current = el;
      if (typeof hostRef === "function") {
        hostRef(el);
      } else if (hostRef) {
        (hostRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      }
    },
    [hostRef],
  );

  // Auto-resize: adjust height imperatively on input events [L06].
  useLayoutEffect(() => {
    if (!autoResize) return;
    const el = internalRef.current;
    if (!el) return;

    const adjust = () => {
      // Collapse to auto so scrollHeight reflects content only.
      el.style.height = "auto";
      const scrollHeight = el.scrollHeight;

      if (maxRows) {
        const style = window.getComputedStyle(el);
        const lineHeight = parseFloat(style.lineHeight) || 16;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const paddingBottom = parseFloat(style.paddingBottom) || 0;
        const maxHeight = lineHeight * maxRows + paddingTop + paddingBottom;

        if (scrollHeight > maxHeight) {
          el.style.height = maxHeight + "px";
          el.style.overflow = "auto";
        } else {
          el.style.height = scrollHeight + "px";
          el.style.overflow = "hidden";
        }
      } else {
        el.style.height = scrollHeight + "px";
        el.style.overflow = "hidden";
      }
    };

    // Size on mount.
    adjust();

    // Listen to native input events for immediate response.
    el.addEventListener("input", adjust);
    return () => {
      el.removeEventListener("input", adjust);
    };
  }, [autoResize, maxRows]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      paintCounter();
      onChange?.(e);
    },
    [onChange, paintCounter],
  );

  const textareaClassName = cn(
    "tug-textarea",
    `tug-textarea-size-${size}`,
    validation === "invalid" && "tug-textarea-invalid",
    validation === "valid" && "tug-textarea-valid",
    validation === "warning" && "tug-textarea-warning",
    resize && !autoResize && `tug-textarea-resize-${resize}`,
    autoResize && "tug-textarea-auto-resize",
    className,
  );

  const textarea = (
    <textarea
      ref={setRef}
      data-slot="tug-textarea"
      data-focus-style={focusStyle}
      data-borderless={borderless || undefined}
      data-tug-state-key={componentStatePreservationKey}
      className={textareaClassName}
      disabled={effectiveDisabled}
      aria-invalid={validation === "invalid" ? "true" : undefined}
      rows={rows}
      maxLength={maxLength}
      value={value}
      defaultValue={defaultValue}
      onChange={handleChange}
      {...rest}
    />
  );

  if (maxLength !== undefined) {
    return (
      <div className="tug-textarea-wrapper">
        {textarea}
        <span ref={counterRef} className="tug-textarea-counter" />
      </div>
    );
  }

  return textarea;
};

// ---- Public component ----

/**
 * TugTextarea — chain-aware when inside a provider, plain when not.
 *
 * Single component that adapts to its environment: inside a
 * `<ResponderChainProvider>` it registers as a chain responder with
 * cut/copy/paste/selectAll/undo/redo handlers and a right-click
 * context menu; outside a provider it renders as a plain native
 * `<textarea>` with no chain wiring and no custom menu. The branch
 * happens inside the hooks, not at the component-type level, so a
 * provider transition never flips React's reconciliation identity —
 * the `<textarea>` element stays mounted and preserves caret, focus,
 * selection, and any auto-resize geometry state. See
 * `useOptionalResponder` for the transition mechanics and
 * `useTextInputResponder` for the menu gating.
 */
export const TugTextarea = React.forwardRef<
  HTMLTextAreaElement,
  TugTextareaProps
>(function TugTextarea(
  {
    size = "md",
    validation = "default",
    resize,
    focusStyle = "background",
    borderless = false,
    disabled,
    onContextMenu,
    focusGroup,
    focusOrder = 0,
    focusPolicy,
    ...rest
  },
  ref,
) {
  const boxDisabled = useTugBoxDisabled();
  const effectiveDisabled = disabled || boxDisabled;

  // Local ref to the textarea DOM node for the editing action
  // handlers in the shared hook to reach `select()`, `setRangeText()`,
  // etc. The hook writes this ref itself as part of `composedRef`.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Everything chain-related lives in the shared hook: six editing
  // action handlers, responder registration (via
  // `useOptionalResponder` — tolerates no-provider mode), ref
  // composition (internal + forwarded + data-responder-id), the
  // onContextMenu bridge, and the context menu JSX (gated to null
  // when there is no provider). See `use-text-input-responder.tsx`.
  const { composedRef, handleContextMenu, contextMenu } = useTextInputResponder({
    inputRef: textareaRef,
    disabled: effectiveDisabled,
    forwardedRef: ref,
    onContextMenu,
  });

  // Standard focus-stop opt-in ([P02]), mirroring TugInput: the focusable IS the
  // `<textarea>`, so the engine lands the key view on the real caret. A text
  // field never consumes Tab, so `consumesTab` stays false (default). The
  // focusable ref composes with the responder's `composedRef`.
  const focusableId = useId();
  const { focusableRef } = useFocusable({
    id: focusableId,
    group: focusGroup ?? "",
    order: focusOrder,
    policy: focusPolicy,
    register: focusGroup !== undefined,
  });
  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      composedRef(el);
      focusableRef(el);
    },
    [composedRef, focusableRef],
  );

  return (
    <>
      <TugTextareaBody
        size={size}
        validation={validation}
        resize={resize}
        focusStyle={focusStyle}
        borderless={borderless}
        disabled={disabled}
        hostRef={setRefs}
        onContextMenu={handleContextMenu}
        {...rest}
      />
      {contextMenu}
    </>
  );
});
