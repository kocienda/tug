/**
 * TugInput — tugways public API for text inputs.
 *
 * Wraps a plain <input> element (not a Radix primitive). All visual states
 * are driven by --tug7-field-* tokens — theme switches update CSS
 * variables at the DOM level with no React re-renders.
 *
 * ## Chain participation
 *
 * TugInput consumes `useTextInputResponder`, which registers the
 * component as a chain responder (via `useOptionalResponder`) and
 * handles the six standard editing actions (`cut`, `copy`, `paste`,
 * `selectAll`, `undo`, `redo`). See that hook's module docstring for
 * the execCommand-vs-Clipboard-API rationale, the two-phase dispatch
 * pattern, and the reason paste must run synchronously. TugTextarea
 * and TugValueInput consume the same hook.
 *
 * ## No-provider tolerance
 *
 * TugInput works both inside and outside a `<ResponderChainProvider>`.
 * Inside a provider, the input is registered as a responder, its
 * action handlers are reachable from the chain, `data-responder-id` is
 * on the DOM element, and the right-click context menu is available.
 * Outside a provider, the input still renders as a plain native
 * `<input>`: registration is skipped, no `data-responder-id`, no
 * custom context menu (the browser's default is shown). All chain
 * features degrade gracefully without a branch at the component-type
 * level, so a test that wraps or unwraps a provider around a mounted
 * TugInput preserves the underlying DOM element — caret, focus, and
 * native selection survive the transition. See the
 * `useOptionalResponder` docstring for the reconciliation details.
 *
 * Laws: [L06] appearance via CSS, [L11] controls emit actions;
 *       responders handle actions, [L15] token-driven states,
 *       [L16] pairings declared, [L19] component authoring guide
 * Decisions: [D04] token-driven control state model,
 *            [D05] component token naming
 */

import "./tug-input.css";
import type { TugSize } from "./tug-vocabulary";

import React, { useCallback, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import { useTextInputResponder } from "./use-text-input-responder";
import { useFocusable } from "./use-focusable";
import type { FocusPolicy, KeyViewBehavior } from "./focus-manager";

// ---- Types ----

/** TugInput size names — matches TugButton sizes */
export type TugInputSize = Extract<TugSize, "sm" | "md" | "lg">;

/** TugInput validation state */
export type TugInputValidation = "default" | "invalid" | "valid" | "warning";

/** TugInput props — extends native input attributes. */
export interface TugInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  /**
   * Visual size variant.
   * @selector .tug-input-size-sm | .tug-input-size-md | .tug-input-size-lg
   * @default "md"
   */
  size?: TugInputSize;
  /**
   * Validation state. Controls border color.
   * @selector .tug-input-invalid | .tug-input-valid | .tug-input-warning
   * @default "default"
   */
  validation?: TugInputValidation;
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
   * Opt into DOM-authority state preservation. When set, the rendered `<input>`
   * carries `data-tug-state-key={componentStatePreservationKey}`. CardHost's save path
   * captures the element's `value`, selection, and scroll at save time
   * and reapplies them on restore.
   *
   * **Uniqueness.** The key must be unique **within the owning card's
   * content subtree**. Cross-card collisions are impossible: CardHost
   * scopes its DOM query to the card's own root (the
   * `[data-card-host][data-card-id]` div), so sibling cards in the
   * same pane (tabs) and separate card instances each keep their own
   * isolated bag. Collisions within one card are author error —
   * `querySelectorAll` returns in document order; save overwrites in
   * loop order (last element wins); restore uses `querySelector`
   * (first element wins). Either way, only one of the two elements
   * survives the round trip.
   *
   * **Uncontrolled only.** Use with uncontrolled inputs (native
   * `defaultValue` or no value prop). Setting `.value` on a controlled
   * input (`value={state}`) will be immediately overwritten on the
   * next React render — use `useCardStatePreservation` for controlled state.
   */
  componentStatePreservationKey?: string;
  /**
   * Author the field into a focus group ([P02]) — the standard `useFocusable`
   * opt-in. When set, the `<input>` registers as one stop in the surrounding
   * surface's trapped Tab walk, so the engine lands the key view (and the ring)
   * on the real caret and Tab moves to/from it like any other control. Omitted ⇒
   * the field stays a plain native focus stop (unchanged behavior). A text field
   * never consumes Tab — Tab always moves to the next focusable.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /** Focus policy for the registered stop ([P02]); forwarded to `useFocusable`. */
  focusPolicy?: FocusPolicy;
  /**
   * The field's key-view behavior, read live at dispatch time and forwarded to
   * `useFocusable`. A plain field declares none — it is a leaf and the engine's
   * act tier leaves its keys alone. A field that transiently owns a key the
   * engine would otherwise arbitrate declares a `captures` predicate: the filter
   * field claims `Escape` while its query is non-empty, so Escape clears the
   * filter instead of dismissing the surrounding sheet.
   */
  focusBehavior?: () => KeyViewBehavior | null;
}

// ---- Shared rendering ----
//
// Both the plain and responder-wired variants render the same JSX:
// a single `<input>` with our computed className and data attributes.
// The only difference is whether the ref composes a responder
// registration or forwards straight through.

function buildInputClassName(
  size: TugInputSize,
  validation: TugInputValidation,
  className: string | undefined,
): string {
  return cn(
    "tug-input",
    `tug-input-size-${size}`,
    validation === "invalid" && "tug-input-invalid",
    validation === "valid" && "tug-input-valid",
    validation === "warning" && "tug-input-warning",
    className,
  );
}

// ---- Public component ----

/**
 * TugInput — chain-aware when inside a provider, plain when not.
 *
 * Single component that adapts to its environment: inside a
 * `<ResponderChainProvider>` it registers as a chain responder with
 * cut/copy/paste/selectAll/undo/redo handlers and a right-click
 * context menu; outside a provider it renders as a plain native
 * `<input>` with no chain wiring and no custom menu. The branch
 * happens inside the hooks, not at the component-type level, so a
 * provider transition never flips React's reconciliation identity —
 * the `<input>` element stays mounted and preserves caret, focus,
 * and selection. See `useOptionalResponder` for the transition
 * mechanics and `useTextInputResponder` for the menu gating.
 */
export const TugInput = React.forwardRef<HTMLInputElement, TugInputProps>(
  function TugInput(
    {
      size = "md",
      validation = "default",
      focusStyle = "background",
      borderless = false,
      componentStatePreservationKey,
      className,
      disabled,
      onContextMenu,
      focusGroup,
      focusOrder = 0,
      focusPolicy,
      focusBehavior,
      ...rest
    },
    ref,
  ) {
    const boxDisabled = useTugBoxDisabled();
    const effectiveDisabled = disabled || boxDisabled;

    // Local ref to the input DOM node — needed by the editing action
    // handlers in the shared hook to reach `selectionStart`,
    // `select()`, `setRangeText()`, etc. The hook writes this ref
    // itself as part of `composedRef`.
    const inputRef = useRef<HTMLInputElement | null>(null);

    // Everything chain-related lives in the shared hook: the six
    // editing action handlers, responder registration (via
    // `useOptionalResponder` — tolerates no-provider mode), ref
    // composition (internal + forwarded + data-responder-id), the
    // onContextMenu bridge, and the context menu JSX (gated to null
    // when there is no provider). See `use-text-input-responder.tsx`
    // for the full rationale.
    const { composedRef, handleContextMenu, contextMenu } = useTextInputResponder({
      inputRef,
      disabled: effectiveDisabled,
      forwardedRef: ref,
      onContextMenu,
    });

    // Standard focus-stop opt-in ([P02]): the focusable IS the `<input>`, so the
    // engine lands the key view on the real caret. A text field never consumes
    // Tab, so `consumesTab` stays false (default); a field that owns a key
    // transiently says so through `focusBehavior`. The focusable ref composes
    // with the responder's `composedRef` (internal + forwarded + responder-id)
    // so one element carries both `data-responder-id` and `data-tug-focusable`.
    //
    // A DISABLED field registers nothing. The DOM refuses focus on a disabled
    // input, so a registration would leave the walk with a stop it can land on
    // in the registry and not in the browser — the ring goes nowhere and Tab
    // reads as broken. Same rule TugValueInput follows.
    const focusableId = useId();
    const { focusableRef } = useFocusable({
      id: focusableId,
      group: focusGroup ?? "",
      order: focusOrder,
      policy: focusPolicy,
      register: !effectiveDisabled && focusGroup !== undefined,
      behavior: focusBehavior,
    });
    const setRefs = useCallback(
      (el: HTMLInputElement | null) => {
        composedRef(el);
        focusableRef(el);
      },
      [composedRef, focusableRef],
    );

    return (
      <>
        <input
          ref={setRefs}
          data-slot="tug-input"
          data-focus-style={focusStyle}
          data-borderless={borderless || undefined}
          data-tug-state-key={componentStatePreservationKey}
          className={buildInputClassName(size, validation, className)}
          disabled={effectiveDisabled}
          aria-invalid={validation === "invalid" ? "true" : undefined}
          {...rest}
          onContextMenu={handleContextMenu}
        />
        {contextMenu}
      </>
    );
  },
);
