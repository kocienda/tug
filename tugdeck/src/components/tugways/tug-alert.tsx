/**
 * TugAlert — App-modal dialog for critical interruptions requiring explicit user response.
 *
 * Wraps @radix-ui/react-alert-dialog. Exposes a single ergonomic entry
 * point: the imperative Promise API via `TugAlertHandle.alert(options)`.
 * Two usage patterns:
 *
 * - **Singleton via TugAlertProvider.** Mount one `<TugAlertProvider>`
 *   in the root tree, then call `const showAlert = useTugAlert()` from
 *   any descendant. The hook resolves the Promise the provider's
 *   singleton opens.
 * - **Inline with a local ref.** Mount `<TugAlert ref={alertRef} title="..." />`
 *   directly and call `alertRef.current.alert(options)`. Per-call
 *   overrides stack on top of the props for title, message, labels,
 *   icon, and confirm role.
 *
 * ## Chain-native button wiring
 *
 * The confirm and cancel buttons dispatch `confirmDialog` /
 * `cancelDialog` through the responder chain rather than calling local
 * handlers directly. The alert registers itself as a responder via
 * `useOptionalResponder` with matching handlers that resolve the
 * pending promise and close. The dispatch walks from the innermost
 * responder (promoted by the pointerdown capture from the button click
 * to the `.tug-alert-content` element, which carries
 * `data-responder-id`) and lands back on the alert's own handler — the
 * same short self-loop used by TugConfirmPopover. [L11]
 *
 * The Radix `Dialog.Close` wrappers around both buttons are retained so
 * the built-in close affordance continues to work. When Radix's internal
 * click fires `onOpenChange(false)` alongside our chain dispatch, the
 * second resolveAndClose call is a no-op because the resolver ref was
 * already nulled by the first.
 *
 * Rendered outside a `ResponderChainProvider`, `useOptionalResponder`
 * no-ops and the buttons fall back to invoking the handler functions
 * directly so the component still works as a plain alert dialog.
 *
 * ## No observeDispatch subscription — modal semantics
 *
 * Unlike TugConfirmPopover (which is an anchored popover and dismisses
 * on any external chain activity), TugAlert is modal: the overlay
 * physically blocks clicks outside, and the user is expected to
 * explicitly confirm or cancel. A chain-driven auto-dismiss would
 * surprise users whose alert disappears because an unrelated keyboard
 * shortcut fired. The alert stays open until the user responds via the
 * confirm button, the cancel button, Escape, or Cmd+. — or the host
 * calls `TugAlertHandle.dismiss()` because the condition that opened
 * the alert no longer holds (resolves the pending promise with false).
 *
 * Laws: [L06] appearance via CSS,
 *       [L11] controls emit actions; responders handle actions,
 *       [L16] pairings declared,
 *       [L19] component authoring guide,
 *       [L20] token sovereignty (composes TugButton)
 *
 * @see ./internal/floating-surface-notes.ts for the cross-surface
 *      invariants table covering popover / confirm-popover / alert /
 *      sheet and the chain-reactive vs. modal semantic models.
 */

import "./tug-alert.css";

import React from "react";
// Plain Dialog, not AlertDialog ([P13] of the keyboard-as-engine-state
// plan): AlertDialog.Content force-focuses its Cancel button on open from
// an internal composed handler that runs regardless of the user handler's
// `preventDefault` — a raw focus write the engine cannot prevent, only
// correct (one ledgered steal per alert open, forever). Dialog.Content's
// open-autofocus IS preventable, so the engine owns the landing. The
// alertdialog semantics AlertDialog provided are kept explicit below:
// `role="alertdialog"` on the content, and outside interactions never
// dismiss (`onInteractOutside` prevented).
import * as AlertDialog from "@radix-ui/react-dialog";
import { icons } from "lucide-react";
import { TugPushButton } from "./tug-push-button";
import { TugListRow } from "./tug-list-row";
import { isCancelChordEvent } from "./keymap-registry";
import type { TugButtonEmphasis, TugButtonRole } from "./internal/tug-button";
import { suppressButtonFocusShift } from "./internal/safari-focus-shift";
import { useResponderChain } from "./responder-chain-provider";
import { useOptionalResponder } from "./use-responder";
import { useItemGroupKeyboard } from "./use-item-group-keyboard";
import { TUG_ACTIONS } from "./action-vocabulary";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { MODAL_REST_LINE } from "./cards/modal-rest-line";
import { useFocusTrap } from "./use-focus-trap";
import { useFocusManager } from "./use-focusable";
import { useSpatialOrder } from "./use-spatial-order";
import type { SpatialOrder, SpatialSeam } from "./spatial-order";

/* ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------*/

/** Map confirmRole to a default Lucide icon name (PascalCase — matches lucide-react `icons` keys). */
function defaultIconForRole(role: TugButtonRole): string {
  if (role === "danger") {
    return "TriangleAlert";
  }
  return "Info";
}

/* ---------------------------------------------------------------------------
 * TugAlertChoice
 * ---------------------------------------------------------------------------*/

/**
 * One selectable action in the multi-action {@link TugAlertHandle.choose} form.
 *
 * A choice carrying a {@link description} or {@link icon} renders as a **rich
 * list row**: the chooser becomes a selectable list (list coloration — the
 * selection blue on the highlighted row) plus an OK / Cancel action bar. A click
 * (or arrow) only *highlights* the row; OK commits the highlighted choice, a
 * double-click commits it directly, and the `choose()` promise resolves with that
 * choice's {@link id}. The default choice (exactly one — flagged via
 * {@link isDefault}, or the last when none is flagged) is the row highlighted at
 * open. A plain choice (no description/icon) keeps the compact button-row form,
 * where each choice is its own button that resolves immediately when clicked.
 */
export interface TugAlertChoice {
  /** Opaque value the `choose()` promise resolves to when this row is picked. */
  id: string;
  /** Primary line of the row. */
  label: string;
  /**
   * Secondary explanatory line under {@link label}. When any choice carries a
   * `description` (or `icon`), the chooser renders as a vertical stack of rich
   * rows (leading icon + title + description) rather than a compact button row.
   */
  description?: string;
  /** Lucide icon name (PascalCase) shown at the leading edge of the row. */
  icon?: string;
  /**
   * Color domain for the row.
   * @default "action"
   */
  role?: TugButtonRole;
  /**
   * Visual weight. Defaults to `primary` for the default choice and
   * `outlined` for the rest.
   */
  emphasis?: TugButtonEmphasis;
  /**
   * Marks this as the Return-default (recommended-default look, seeded key
   * view). At most one choice should set it; when none does, the last choice
   * is the default.
   */
  isDefault?: boolean;
}

/* ---------------------------------------------------------------------------
 * TugAlertHandle
 * ---------------------------------------------------------------------------*/

/** Imperative handle for TugAlert. */
export interface TugAlertHandle {
  /**
   * Opens the alert dialog and returns a promise.
   * Resolves true if confirmed, false if cancelled or dismissed.
   */
  alert(options?: {
    title?: string;
    message?: string | React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string | null;
    confirmRole?: TugButtonRole;
    /** Lucide icon name override. Defaults to role-based icon. */
    icon?: string;
  }): Promise<boolean>;
  /**
   * Opens the alert as a multi-action chooser. Rich {@link choices} (any carrying
   * a description or icon) render as a selectable list — click / arrow highlights
   * a row, the ringed default OK commits it (a double-click commits directly),
   * Cancel sits at the action bar's left. Plain choices keep the compact form: an
   * ordered row of buttons that resolve on click. Resolves with the committed
   * choice's `id`, or `null` on Cancel / Escape / Cmd-. / {@link dismiss}.
   */
  choose(options: {
    title?: string;
    message?: string | React.ReactNode;
    /** Lucide icon name override. Defaults to role-based icon. */
    icon?: string;
    /**
     * Cancel button text; pass `null` to omit it.
     * @default "Cancel"
     */
    cancelLabel?: string | null;
    /** The selectable actions, rendered left-to-right after Cancel. */
    choices: TugAlertChoice[];
  }): Promise<string | null>;
  /**
   * Closes the alert programmatically, resolving any pending `alert()`
   * promise with false (or a pending `choose()` promise with null). For
   * hosts whose precondition evaporates while the alert is open (e.g. the
   * empty-deck offer when a card lands via Cmd-N). No-op when closed.
   */
  dismiss(): void;
}

/* ---------------------------------------------------------------------------
 * TugAlertProps
 * ---------------------------------------------------------------------------*/

/** TugAlert props. */
export interface TugAlertProps {
  /** Alert title (required). */
  title: string;
  /** Body content. */
  message?: string | React.ReactNode;
  /**
   * Confirm button text.
   * @default "OK"
   */
  confirmLabel?: string;
  /**
   * Cancel button text. Pass null to hide cancel button.
   * @default "Cancel"
   */
  cancelLabel?: string | null;
  /**
   * Semantic role for confirm button.
   * @default "action"
   */
  confirmRole?: TugButtonRole;
  /**
   * Lucide icon name. Defaults to a role-based icon.
   * Pass an empty string to suppress the icon.
   */
  icon?: string;
  /**
   * Stable opaque sender id for chain dispatches. Auto-derived via
   * `useId()` if omitted. Disambiguates multi-alert pages when a
   * parent responder observes dispatches by sender. [L11]
   */
  senderId?: string;
}

/* ---------------------------------------------------------------------------
 * TugAlert
 * ---------------------------------------------------------------------------*/

/**
 * TugAlert — app-modal dialog composing Radix AlertDialog.
 *
 * Use `ref.current.alert(options)` for the imperative Promise API, or
 * mount under `TugAlertProvider` and call `useTugAlert()` for the
 * singleton pattern.
 */
export const TugAlert = React.forwardRef<TugAlertHandle, TugAlertProps>(
  function TugAlert(
    {
      title: titleProp,
      message: messageProp,
      confirmLabel: confirmLabelProp = "OK",
      cancelLabel: cancelLabelProp = "Cancel",
      confirmRole: confirmRoleProp = "action",
      icon: iconProp,
      senderId: senderIdProp,
    },
    ref,
  ) {
    const overlayRoot = useCanvasOverlay();
    const [open, setOpen] = React.useState(false);

    // The committed selection in the rich chooser (`choose()` with icon/description
    // rows). The list only *selects* on click / arrow — the pick is committed by the
    // OK button — so the currently-highlighted row lives here, seeded to the default
    // choice at open. Mirrored into a ref so the confirm handler (which fires from a
    // stable chain closure) reads the live value. Inert in `alert()` / compact-choose
    // mode.
    const [selectedChoiceId, setSelectedChoiceId] = React.useState<string | null>(
      null,
    );
    const selectedChoiceIdRef = React.useRef<string | null>(null);
    selectedChoiceIdRef.current = selectedChoiceId;

    // Override options set by the imperative alert() / choose() call. `mode`
    // discriminates the single-confirm form (default) from the multi-action
    // chooser; `choices` is populated only in "choose" mode.
    const overrideRef = React.useRef<{
      mode?: "confirm" | "choose";
      title?: string;
      message?: string | React.ReactNode;
      confirmLabel?: string;
      cancelLabel?: string | null;
      confirmRole?: TugButtonRole;
      icon?: string;
      choices?: TugAlertChoice[];
    } | null>(null);

    // Resolver for imperative mode. Null when not in an active promise. The
    // value is `boolean` for `alert()` and `string | null` for `choose()`.
    const resolverRef = React.useRef<
      ((value: boolean | string | null) => void) | null
    >(null);

    // The value a dismissal (Cancel / Escape / Cmd-. / dismiss()) resolves
    // with — `false` for `alert()`, `null` for `choose()`. Set at open.
    const dismissValueRef = React.useRef<false | null>(false);

    // Chain manager — null when rendered outside a ResponderChainProvider
    // (standalone previews, unit tests). Buttons fall back to calling
    // the primary handler directly.
    const manager = useResponderChain();

    const fallbackResponderId = React.useId();
    const fallbackSenderId = React.useId();
    const responderId = fallbackResponderId;
    const senderId = senderIdProp ?? fallbackSenderId;

    // Primary handler — resolves the pending promise and closes the
    // dialog. Shared by the chain action handlers, the no-provider
    // fallback on button click, and the Radix onOpenChange dismissal
    // path (Escape, Cmd+., AlertDialog.Close/Action's built-in close).
    // Idempotent: a second call with the resolver already null just
    // closes redundantly, which matches the "two converging close
    // paths" expectation when Radix's Cancel/Action wrappers fire
    // alongside the chain dispatch.
    const resolveAndClose = React.useCallback((value: boolean | string | null) => {
      if (resolverRef.current) {
        resolverRef.current(value);
        resolverRef.current = null;
      }
      setOpen(false);
    }, []);

    // Confirm resolves the mode-appropriate positive value: the highlighted row's
    // id in the rich chooser (OK commits the selection), else `true` for a plain
    // `alert()`. A rich chooser with no selectable row resolves `null` (a dismissal)
    // rather than a bogus `true`.
    const handleConfirmAction = React.useCallback(() => {
      if (overrideRef.current?.mode === "choose") {
        resolveAndClose(selectedChoiceIdRef.current);
        return;
      }
      resolveAndClose(true);
    }, [resolveAndClose]);

    // Select a rich-chooser row (click or arrow) without committing — OK commits.
    const handleSelectChoice = React.useCallback((id: string) => {
      selectedChoiceIdRef.current = id;
      setSelectedChoiceId(id);
    }, []);

    // Commit a rich-chooser row directly (double-click) — the OK shortcut.
    const handleActivateChoice = React.useCallback(
      (id: string) => {
        resolveAndClose(id);
      },
      [resolveAndClose],
    );

    // Dismissal resolves the mode-appropriate negative value (`false` for
    // alert(), `null` for choose()).
    const handleCancelAction = React.useCallback(() => {
      resolveAndClose(dismissValueRef.current);
    }, [resolveAndClose]);

    // Register the alert as a chain responder so the buttons inside
    // the portaled content can dispatch confirmDialog / cancelDialog
    // and have the walk land back here. Tolerant of no-provider
    // contexts.
    const { responderRef } = useOptionalResponder({
      id: responderId,
      actions: {
        [TUG_ACTIONS.CONFIRM_DIALOG]: handleConfirmAction,
        [TUG_ACTIONS.CANCEL_DIALOG]: handleCancelAction,
      },
    });

    // Engine focus trap ([P06]): the alert is the last dismissable surface that
    // sat entirely outside the engine model — "single authority" is false while
    // it does. Push a trapped mode while open so the engine's Escape ladder owns
    // its Escape (calling `handleCancelAction`, the same cancel its CANCEL_DIALOG
    // handler / Radix dismissal ran), the key view is captured/restored on close,
    // and the close-focus DOM write is the trap's single teardown writer wired to
    // `AlertDialog.Content` below. App-modal blocking is unchanged — Radix's own
    // overlay + focus scope still block everything; only Escape routing moves.
    const { FocusModeScope, onCloseAutoFocus } = useFocusTrap({
      active: open,
      deferDomFocusToTeardown: true,
      onEscapeDismiss: handleCancelAction,
    });

    // ---- The card's modal rest line ([B01]) ----
    //
    // An alert is a decision surface in a card like any other, so it rests where
    // that card's sheets rest — on the bottom edge of the view slot, the top of
    // Z2 — and settles upward, rather than floating at the middle of the
    // viewport with nothing behind it to belong to.
    //
    // The alert is canvas-level and has no card context of its own, so the
    // anchor is captured at the moment the host raises it, while the host's own
    // focus is still in place and before Radix moves it: the rest line inside
    // whichever card focus was in. A host outside any card, or inside a card
    // with no view slot, resolves nothing — and then the alert stays centred,
    // which is the right answer there and needs no exception clause.
    const restLineRef = React.useRef<HTMLElement | null>(null);
    const contentElRef = React.useRef<HTMLDivElement | null>(null);

    const captureRestLine = React.useCallback(() => {
      const focused = document.activeElement;
      const card =
        focused instanceof Element ? focused.closest("[data-card-id]") : null;
      restLineRef.current =
        card?.querySelector<HTMLElement>(MODAL_REST_LINE) ?? null;
    }, []);

    // Write the panel's resting geometry from the measured rest line, in
    // viewport coordinates ([L06] — a DOM write, never React state). The panel's
    // bottom edge sits on the line and it is centred over the line's box, so it
    // reads as belonging to the card that raised it rather than to the canvas.
    // Re-measured while it is open: dragging the card's sash and growing the Z2
    // telemetry row both move the line under it.
    React.useLayoutEffect(() => {
      const content = contentElRef.current;
      if (!open || content === null) return;
      const anchor = restLineRef.current;
      if (anchor === null || !anchor.isConnected) {
        content.style.top = "";
        content.style.bottom = "";
        content.style.left = "";
        delete content.dataset["verticalAnchor"];
        return;
      }
      const measure = (): void => {
        const box = anchor.getBoundingClientRect();
        content.style.top = "auto";
        content.style.bottom = `${Math.max(0, window.innerHeight - box.bottom)}px`;
        content.style.left = `${box.left + box.width / 2}px`;
        content.dataset["verticalAnchor"] = "rest-line";
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(anchor);
      window.addEventListener("resize", measure);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", measure);
      };
    }, [open]);

    React.useImperativeHandle(ref, () => ({
      alert(options) {
        return new Promise<boolean>((resolve) => {
          overrideRef.current = { mode: "confirm", ...options };
          dismissValueRef.current = false;
          resolverRef.current = resolve as (v: boolean | string | null) => void;
          captureRestLine();
          setOpen(true);
        });
      },
      choose(options) {
        return new Promise<string | null>((resolve) => {
          overrideRef.current = { mode: "choose", ...options };
          dismissValueRef.current = null;
          // Seed the highlighted row to the default choice (flagged `isDefault`,
          // else the last) so the list opens with a selection and OK commits it.
          const choices = options.choices;
          const flagged = choices.findIndex((c) => c.isDefault);
          const seed =
            (flagged >= 0 ? choices[flagged] : choices[choices.length - 1])?.id ??
            null;
          selectedChoiceIdRef.current = seed;
          setSelectedChoiceId(seed);
          resolverRef.current = resolve as (v: boolean | string | null) => void;
          captureRestLine();
          setOpen(true);
        });
      },
      dismiss() {
        resolveAndClose(dismissValueRef.current);
      },
    }));

    // Resolve effective values: override (imperative) takes precedence over props.
    const override = overrideRef.current;
    const mode = override?.mode ?? "confirm";
    const title = override?.title ?? titleProp;
    const message = override?.message ?? messageProp;
    const confirmLabel = override?.confirmLabel ?? confirmLabelProp;
    const cancelLabel = override !== null && override !== undefined && "cancelLabel" in override
      ? override.cancelLabel
      : cancelLabelProp;
    const confirmRole = override?.confirmRole ?? confirmRoleProp;
    const iconName = override !== null && override !== undefined && "icon" in override
      ? override.icon
      : iconProp;

    // Resolve icon component: explicit name, role-based default, or nothing if "".
    const resolvedIconName = iconName !== undefined
      ? iconName
      : defaultIconForRole(confirmRole);

    const IconComponent = resolvedIconName
      ? (icons[resolvedIconName as keyof typeof icons] ?? null)
      : null;

    // ---- Action buttons ----
    // The generalized button model: Cancel (order 0, when present) followed by
    // an ordered list of action buttons (orders 1..N). In "confirm" mode that
    // list is the single confirm button; in "choose" mode it is one button per
    // choice. Exactly one action button is the Radix Action / Return default —
    // the confirm button, or the choice flagged `isDefault` (else the last).
    const CANCEL_ORDER = 0;
    const hasCancel = cancelLabel !== null;
    interface ActionButtonSpec {
      key: string;
      order: number;
      label: React.ReactNode;
      /** Secondary line + leading icon, present only for rich chooser rows. */
      description?: string;
      icon?: string;
      emphasis: TugButtonEmphasis;
      role: TugButtonRole;
      /** Wrapped in AlertDialog.Close + the Return default. */
      isDefault: boolean;
      onClick: () => void;
    }
    const actionButtons: ActionButtonSpec[] = React.useMemo(() => {
      if (mode === "choose") {
        const choices = override?.choices ?? [];
        const flagged = choices.findIndex((c) => c.isDefault);
        const defaultIndex = flagged >= 0 ? flagged : choices.length - 1;
        return choices.map((choice, i) => {
          // Rich rows read as a uniform list — every row `outlined`, the
          // default marked by the resting key-view ring (seeded at open).
          // Compact inline choices keep the recommended-default `primary` look.
          const isRich = Boolean(choice.description || choice.icon);
          const defaultEmphasis: TugButtonEmphasis = isRich
            ? "outlined"
            : i === defaultIndex
              ? "primary"
              : "outlined";
          return {
            key: choice.id,
            order: i + 1,
            label: choice.label,
            description: choice.description,
            icon: choice.icon,
            emphasis: choice.emphasis ?? defaultEmphasis,
            role: choice.role ?? "action",
            isDefault: i === defaultIndex,
            onClick: () => resolveAndClose(choice.id),
          };
        });
      }
      return [
        {
          key: "__confirm__",
          order: 1,
          label: confirmLabel,
          emphasis: confirmRole === "action" ? "primary" : "filled",
          role: confirmRole,
          isDefault: true,
          onClick: onConfirmClick,
        },
      ];
      // onConfirmClick is a stable closure over refs; safe to omit.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, override?.choices, confirmLabel, confirmRole, resolveAndClose]);

    // Rich rows: a chooser whose choices carry an icon or description renders as
    // a vertical stack of list rows (leading icon + title + description) with
    // Cancel below, rather than a compact right-aligned button row.
    const richRows =
      mode === "choose" && actionButtons.some((b) => b.description || b.icon);

    // ---- Focus language ([P14]/[P22]/[P23]) ----
    // Author the controls into a focus group so Tab walks them, declare the arrow
    // plane (registered inside the trap's FocusModeScope by AlertSpatialOrder), and
    // seed the engine key view on the default control at open — the ring rests
    // there and the default button promotes to its live/filled style ([P14]).
    // Danger keeps Return safe by defaulting to Cancel when present.
    const focusManager = useFocusManager();
    const buttonFocusGroup = React.useId();
    const actionCount = actionButtons.length;

    // Rich chooser Tab/arrow orders: the row list is one item-container stop (0),
    // then the action bar — Cancel (1), OK (2). The list carries the selection; OK
    // is the ringed default that commits it.
    const RICH_ROWS_ORDER = 0;
    const RICH_CANCEL_ORDER = 1;
    const RICH_OK_ORDER = 2;

    const buttonSpatialOrder = React.useMemo<SpatialOrder>(() => {
      if (richRows) {
        const rowsKey = `${buttonFocusGroup}:${RICH_ROWS_ORDER}`;
        const cancelKey = `${buttonFocusGroup}:${RICH_CANCEL_ORDER}`;
        const okKey = `${buttonFocusGroup}:${RICH_OK_ORDER}`;
        // Horizontal ring across the action bar; seams join the row list (a 1D
        // cursor node, its length supplied by the registered cursor handle) to the
        // buttons — an arrow off the list edge crosses to OK, an arrow off a button
        // drops back into the list. The same shape the permission dialog uses for
        // its scope group + button row.
        const buttonNodes = hasCancel ? [cancelKey, okKey] : [okKey];
        const seams: SpatialSeam[] = [
          { from: okKey, direction: "up", to: rowsKey },
          { from: okKey, direction: "down", to: rowsKey },
          { from: rowsKey, direction: "down", to: okKey },
          { from: rowsKey, direction: "up", to: okKey },
        ];
        if (hasCancel) {
          seams.push(
            { from: cancelKey, direction: "up", to: rowsKey },
            { from: cancelKey, direction: "down", to: rowsKey },
          );
        }
        return {
          rings: [{ axis: "horizontal", nodes: buttonNodes, closed: true }],
          seams,
        };
      }
      const actionOrders = Array.from({ length: actionCount }, (_, i) => i + 1);
      const orders = [...(hasCancel ? [CANCEL_ORDER] : []), ...actionOrders];
      const nodes = orders.map((o) => `${buttonFocusGroup}:${o}`);
      return {
        rings: [
          { axis: "horizontal", nodes, closed: true },
          { axis: "vertical", nodes, closed: true },
        ],
      };
    }, [buttonFocusGroup, hasCancel, actionCount, richRows]);
    // The order the key view rests on at open: the row list for the rich chooser
    // (it wears the ring immediately, its cursor on the default row — Return still
    // commits via OK's persistent default ring), Cancel for a danger confirm (so
    // Return can't destroy), otherwise the default action button.
    const defaultButtonOrder = richRows
      ? RICH_ROWS_ORDER
      : mode === "confirm" && confirmRole === "danger" && hasCancel
        ? CANCEL_ORDER
        : (actionButtons.find((b) => b.isDefault)?.order ?? CANCEL_ORDER);
    const handleOpenAutoFocus = React.useCallback(
      (event: Event) => {
        // Stop Radix's own first-focusable walk; the engine drives focus.
        event.preventDefault();
        focusManager?.place(null, { kind: "focus-key", focusKey: `${buttonFocusGroup}:${defaultButtonOrder}` }, { modality: "keyboard" });
      },
      [focusManager, buttonFocusGroup, defaultButtonOrder],
    );

    // IMPORTANT: Never clear overrideRef during close. The exit animation
    // needs the override values to stay so the content doesn't revert to
    // singleton defaults while fading out. Overrides are cleared on next open
    // (the imperative alert() sets fresh overrides before opening).

    // Radix-level dismissal (Escape via DismissableLayer, Cmd+. via
    // onKeyDown, AlertDialog.Close/Action built-in close) routes
    // through here. Convert any open→false transition to a cancel so
    // the pending promise resolves with false. The cancel-and-close is
    // idempotent, so Radix's own close after a chain-dispatched
    // confirm is a no-op.
    function handleOpenChange(nextOpen: boolean) {
      if (!nextOpen) {
        resolveAndClose(false);
        return;
      }
      setOpen(nextOpen);
    }

    // Button onClick handlers. Dispatch through the chain (for keyboard/
    // responder consistency) AND resolve directly. The direct call is what
    // makes a click reliable: when this alert is an app-level singleton (e.g.
    // the deck-root one TugLogout opens), the chain's first responder is a
    // card, not this alert, so `sendToFirstResponder` never reaches the
    // handler and only Radix's built-in Action/Cancel close fires — which
    // resolves `false` for *both* buttons. `resolveAndClose` is idempotent, so
    // if the chain did reach the handler first, the direct call is a no-op.
    function onConfirmClick() {
      manager?.sendToFirstResponder({
        action: TUG_ACTIONS.CONFIRM_DIALOG,
        sender: senderId,
        phase: "discrete",
      });
      handleConfirmAction();
    }

    function onCancelClick() {
      manager?.sendToFirstResponder({
        action: TUG_ACTIONS.CANCEL_DIALOG,
        sender: senderId,
        phase: "discrete",
      });
      handleCancelAction();
    }

    return (
      <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
        <AlertDialog.Portal container={overlayRoot}>
          <AlertDialog.Overlay className="tug-alert-overlay" />
          <AlertDialog.Content
            ref={(el: HTMLDivElement | null) => {
              (responderRef as (node: HTMLDivElement | null) => void)(el);
              contentElRef.current = el;
            }}
            className="tug-alert-content"
            data-slot="tug-alert"
            // The alertdialog semantics AlertDialog used to provide, kept
            // explicit on the plain Dialog primitive ([P13]): the role, and
            // outside interactions never dismiss — the user must respond.
            role="alertdialog"
            onInteractOutside={(e) => e.preventDefault()}
            onMouseDown={suppressButtonFocusShift}
            // The engine seeds the default button as the key view ([P14]); stop
            // Radix's own first-focusable walk so the two don't fight.
            onOpenAutoFocus={handleOpenAutoFocus}
            // [P03] Suppress Radix's own Escape — the engine's Escape ladder owns
            // it via the trap's `onEscapeDismiss` (above).
            onEscapeKeyDown={(e) => e.preventDefault()}
            // [P06] The trap is the single close-focus DOM writer at teardown.
            onCloseAutoFocus={onCloseAutoFocus}
            onKeyDown={(e) => {
              // Cmd+. dismisses (macOS convention) — treat as cancel. Stays
              // chain-routed; only Escape moved to the engine ladder (#non-goals).
              if (isCancelChordEvent(e)) {
                e.preventDefault();
                handleOpenChange(false);
              }
            }}
          >
            <FocusModeScope>
            {/* The alert's own key sink ([P13]): Radix AlertDialog's trapped
                FocusScope refocuses into itself whenever focus leaves it, so
                the engine's park must land INSIDE the jail — the engine
                always parks at the innermost mounted sink (see
                KEY_SINK_ATTRIBUTE). Without this, every park while the
                alert is open is answered by a raw Radix refocus onto the
                first tabbable button. */}
            <div
              data-tug-key-sink=""
              tabIndex={-1}
              className="tug-key-sink"
              aria-label="Keyboard"
            />
            {/* Registers the button-row arrow ring against the alert's trap
                mode. Must mount INSIDE FocusModeScope so the context-form
                `useSpatialOrder` reads the trap scope, not the outer one. */}
            <AlertSpatialOrder order={buttonSpatialOrder} />
            {/* Classic Mac HIG layout: icon left, text right, buttons bottom-right */}
            <div
              className="tug-alert-body"
              data-scale="alert"
              data-has-message={message ? "true" : undefined}
            >
              {IconComponent && (
                <div className="tug-alert-icon" aria-hidden="true">
                  {/* The icon box owns the size (see tugx-header.css); the
                      svg fills it. */}
                  {React.createElement(IconComponent, { size: "100%" })}
                </div>
              )}
              <div className="tug-alert-text">
                <AlertDialog.Title className="tug-alert-title">
                  {title}
                </AlertDialog.Title>
                {message && (
                  <AlertDialog.Description className="tug-alert-message">
                    {message}
                  </AlertDialog.Description>
                )}
              </div>
            </div>
            {richRows ? (
              // Rich chooser: a selectable list of rows (leading icon + title +
              // description) that only *highlights* on click / arrow, with an
              // action bar below — Cancel on the left, the ringed default OK on the
              // right. OK commits the highlighted row; a double-click commits
              // directly.
              <>
                <AlertChoiceList
                  choices={override?.choices ?? []}
                  focusGroup={buttonFocusGroup}
                  order={RICH_ROWS_ORDER}
                  selectedId={selectedChoiceId}
                  onSelect={handleSelectChoice}
                  onActivate={handleActivateChoice}
                />
                <div className="tug-alert-actions">
                  {hasCancel && (
                    <AlertDialog.Close asChild>
                      <TugPushButton
                        size="sm"
                        emphasis="outlined"
                        onClick={onCancelClick}
                        focusGroup={buttonFocusGroup}
                        focusOrder={RICH_CANCEL_ORDER}
                      >
                        {cancelLabel}
                      </TugPushButton>
                    </AlertDialog.Close>
                  )}
                  <AlertDialog.Close asChild>
                    <TugPushButton
                      size="sm"
                      emphasis="primary"
                      role="action"
                      persistentDefaultRing
                      onClick={onConfirmClick}
                      focusGroup={buttonFocusGroup}
                      focusOrder={RICH_OK_ORDER}
                    >
                      {confirmLabel}
                    </TugPushButton>
                  </AlertDialog.Close>
                </div>
              </>
            ) : (
              <div className="tug-alert-actions">
                {hasCancel && (
                  <AlertDialog.Close asChild>
                    <TugPushButton
                      size="sm"
                      emphasis="outlined"
                      onClick={onCancelClick}
                      focusGroup={buttonFocusGroup}
                      focusOrder={CANCEL_ORDER}
                    >
                      {cancelLabel}
                    </TugPushButton>
                  </AlertDialog.Close>
                )}
                {actionButtons.map((b) => {
                  const button = (
                    <TugPushButton
                      size="sm"
                      emphasis={b.emphasis}
                      role={b.role}
                      onClick={b.onClick}
                      focusGroup={buttonFocusGroup}
                      focusOrder={b.order}
                    >
                      {b.label}
                    </TugPushButton>
                  );
                  // Exactly one action button is the semantic Radix Action (the
                  // Return default); the rest are plain buttons in the arrow ring.
                  return b.isDefault ? (
                    <AlertDialog.Close asChild key={b.key}>
                      {button}
                    </AlertDialog.Close>
                  ) : (
                    <React.Fragment key={b.key}>{button}</React.Fragment>
                  );
                })}
              </div>
            )}
            </FocusModeScope>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    );
  },
);

/* ---------------------------------------------------------------------------
 * AlertChoiceList
 * ---------------------------------------------------------------------------*/

interface AlertChoiceListProps {
  choices: readonly TugAlertChoice[];
  /** Focus group the alert authors this stop into. */
  focusGroup: string;
  /** Order of the list within {@link focusGroup} (the item-container stop). */
  order: number;
  /** The highlighted row's id (owned by TugAlert), or null. */
  selectedId: string | null;
  /** Highlight a row without committing (click / arrow). */
  onSelect: (id: string) => void;
  /** Commit a row directly (double-click). */
  onActivate: (id: string) => void;
}

/**
 * The rich chooser's selectable row list. One item-container stop in the alert's
 * Tab walk ([P01]/[P03]): Tab lands the ring on the whole list, arrows move a
 * movement cursor that live-commits the highlight, Space selects the cursor row,
 * and Enter bubbles to the ringed OK ([P24] — `commitOnEnter` off). Rows paint
 * the list idiom (`flush` `TugListRow`, the selection blue on the highlighted
 * row) rather than buttons — a click only highlights; OK commits. Mounts INSIDE
 * the alert's `FocusModeScope` (like `AlertSpatialOrder`) so its
 * `useItemGroupKeyboard` registration binds to the trapped focus mode, not the
 * mode above it. [L03]
 */
function AlertChoiceList({
  choices,
  focusGroup,
  order,
  selectedId,
  onSelect,
  onActivate,
}: AlertChoiceListProps): React.ReactElement {
  const rowsId = React.useId();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const selectedIdRef = React.useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  const idOf = (el: Element | null): string =>
    el?.getAttribute("data-choice-id") ?? "";
  const collectItems = React.useCallback((): HTMLElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>('[data-slot="tug-alert-choice-item"]'),
    );
  }, []);

  const { attachRoot, onKeyDown, syncItems, setCursor } = useItemGroupKeyboard({
    id: rowsId,
    group: focusGroup,
    order,
    register: true,
    // Live commit: the highlight follows the cursor as the arrows move it, so the
    // selection blue tracks the keyboard the way it tracks a click.
    commit: "live",
    collectItems,
    // Land the cursor on the highlighted row when the list gains the key view.
    initialIndex: () => {
      const items = collectItems();
      const idx = items.findIndex((el) => idOf(el) === selectedIdRef.current);
      return idx >= 0 ? idx : 0;
    },
    onSelect: (el) => {
      const id = idOf(el);
      if (id !== "") onSelect(id);
    },
    onMove: (el) => {
      const id = idOf(el);
      if (id !== "") onSelect(id);
    },
  });

  // Re-sync the cursor's item range whenever the rendered rows change.
  React.useLayoutEffect(() => {
    syncItems();
  }, [choices.length, syncItems]);

  const setRoot = React.useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      attachRoot(el);
    },
    [attachRoot],
  );

  return (
    <div
      ref={setRoot}
      className="tug-alert-choices"
      role="listbox"
      aria-orientation="vertical"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {choices.map((choice) => {
        const RowIcon = choice.icon
          ? (icons[choice.icon as keyof typeof icons] ?? null)
          : null;
        const selected = choice.id === selectedId;
        return (
          <div
            key={choice.id}
            className="tug-alert-choice"
            data-slot="tug-alert-choice-item"
            data-choice-id={choice.id}
            role="option"
            aria-selected={selected}
            onClick={() => {
              // Highlight + park the cursor so a following arrow continues from
              // the clicked row.
              const idx = collectItems().findIndex(
                (el) => idOf(el) === choice.id,
              );
              if (idx >= 0) setCursor(idx);
              onSelect(choice.id);
            }}
            onDoubleClick={() => onActivate(choice.id)}
          >
            <TugListRow
              variant="flush"
              selected={selected}
              leading={
                // The rendered size is set in CSS (the base `.tug-list-row`
                // leading rule clamps the svg).
                RowIcon ? React.createElement(RowIcon, { size: 30 }) : undefined
              }
              title={choice.label}
              subtitle={choice.description}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * AlertSpatialOrder
 * ---------------------------------------------------------------------------*/

/**
 * Null-rendering registrar for the alert's button-row arrow ring. It must mount
 * INSIDE the alert's `FocusModeScope` so the context-form `useSpatialOrder(order)`
 * resolves the enclosing `FocusModeContext` to the alert's trapped focus mode —
 * calling it in the `TugAlert` body would bind the order to the mode ABOVE the
 * trap. Mirrors `ConfirmPopoverSpatialOrder`. [L03]
 */
function AlertSpatialOrder({ order }: { order: SpatialOrder }): null {
  useSpatialOrder(order);
  return null;
}

/* ---------------------------------------------------------------------------
 * TugAlertContext + TugAlertProvider + useTugAlert
 * ---------------------------------------------------------------------------*/

/** Shape of the context value provided by TugAlertProvider. */
interface TugAlertContextValue {
  showAlert: (options?: {
    title?: string;
    message?: string | React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string | null;
    confirmRole?: TugButtonRole;
    /** Lucide icon name override. Defaults to role-based icon. */
    icon?: string;
  }) => Promise<boolean>;
}

const TugAlertContext = React.createContext<TugAlertContextValue | null>(null);

/** Props for TugAlertProvider. */
export interface TugAlertProviderProps {
  children: React.ReactNode;
}

/**
 * TugAlertProvider — mounts a singleton TugAlert and exposes showAlert()
 * via the useTugAlert() hook to all descendant components.
 *
 * Mount once in the root render tree, wrapping the main app content.
 */
export function TugAlertProvider({ children }: TugAlertProviderProps) {
  const alertRef = React.useRef<TugAlertHandle>(null);

  const showAlert = React.useCallback(
    (options?: {
      title?: string;
      message?: string | React.ReactNode;
      confirmLabel?: string;
      cancelLabel?: string | null;
      confirmRole?: TugButtonRole;
      icon?: string;
    }) => {
      if (!alertRef.current) {
        return Promise.resolve(false);
      }
      return alertRef.current.alert(options);
    },
    [],
  );

  const contextValue = React.useMemo(() => ({ showAlert }), [showAlert]);

  return (
    <TugAlertContext.Provider value={contextValue}>
      {children}
      {/* Singleton TugAlert — rendered after children so it layers above them */}
      <TugAlert
        ref={alertRef}
        title=""
        confirmLabel="OK"
        cancelLabel="Cancel"
        confirmRole="action"
      />
    </TugAlertContext.Provider>
  );
}

/**
 * useTugAlert — returns a showAlert function that opens the singleton TugAlert.
 *
 * Must be used inside a TugAlertProvider.
 *
 * @example
 * ```tsx
 * const showAlert = useTugAlert();
 * const confirmed = await showAlert({ title: "Delete Card", confirmRole: "danger" });
 * ```
 */
export function useTugAlert(): (options?: {
  title?: string;
  message?: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string | null;
  confirmRole?: TugButtonRole;
  icon?: string;
}) => Promise<boolean> {
  const ctx = React.useContext(TugAlertContext);
  if (!ctx) {
    throw new Error("useTugAlert must be used within a TugAlertProvider");
  }
  return ctx.showAlert;
}
