/**
 * TugSheet — pane-modal dialog scoped to a single pane.
 *
 * Original component (not a Radix wrapper). Drops from the pane title bar
 * like a window shade. Uses Radix FocusScope for focus trapping. The
 * pane body gets `inert` for keyboard-routing scope; the pane's
 * built-in scrim layer (raised via `useTugPaneScrim()`) provides the
 * visual + pointer dead zone within the host pane. Peer panes remain
 * fully interactive.
 *
 * Compound API: TugSheet (Root) / TugSheetTrigger / TugSheetContent.
 * The panel + slide-in clip portal into the host pane's frame element
 * via `TugPaneFrameContext` so the panel sits inside the pane's
 * stacking context [D19, D20]. Peer panes z-stacked above paint above
 * the panel without manual z coordination — modal scope IS the pane.
 * Open state is internal — consumers open the sheet via
 * `TugSheetTrigger` (click-to-open), an imperative ref handle
 * (`TugSheetHandle.open()`), or the `useTugSheet()` hook's
 * `showSheet()` Promise API. There is no public `open`/`onOpenChange`
 * controlled-mode prop; the sheet owns its own open state and exposes
 * close as a chain action.
 *
 * Imperative hook: useTugSheet() — returns { showSheet, renderSheet }.
 * Call renderSheet() once in your component's JSX; call showSheet() anywhere
 * to present a sheet imperatively and await its result.
 *
 * ## Chain-native close path
 *
 * TugSheetContent registers itself as a responder via
 * `useOptionalResponder` with a `cancelDialog` handler that closes the
 * sheet through the internal context's onOpenChange. Inside the sheet,
 * Escape and Cmd+. dispatch `cancelDialog` through the chain and the
 * walk lands back on the sheet's own handler (routed via the input or
 * other focused-responder's parent chain — the sheet is the parent
 * via ResponderScope). Consumer Cancel/Save buttons inside a sheet
 * dispatch `cancelDialog` directly through the chain to close the
 * sheet, matching the pattern established by TugConfirmPopover and
 * TugAlert. [L11]
 *
 * Rendered outside a `ResponderChainProvider`, `useOptionalResponder`
 * no-ops and Escape/Cmd+. fall back to calling the context's
 * onOpenChange directly. Consumer buttons must provide their own
 * close path (e.g., via the imperative ref) in that case.
 *
 * ## Exclusive sheets — the cover of a run
 *
 * A sheet opened with `exclusive` (see {@link SheetExclusivity}) is not
 * dismissible from any of the paths above. It takes the host card's
 * modal hold while it stands, so a later `showSheet` on this host is
 * refused instead of superseding it, Escape and Cmd+. report the run's
 * own refusal, and the pane's chrome reads the hold and renders its
 * controls disabled. The two doors that still work are the ones that
 * belong to the run: the `close(result)` callback handed to the sheet's
 * content, and the host unmounting.
 *
 * ## No observeDispatch subscription — pane-modal semantics
 *
 * Like TugAlert, TugSheet is modal (pane-scoped via the pane's
 * built-in scrim and `inert` on the pane body). External chain
 * activity — including activity in other panes on the same canvas —
 * should not auto-dismiss a sheet the user has opened. The sheet
 * stays open until the user explicitly closes it via a Cancel
 * button, Save button, Escape, or Cmd+.
 *
 * Laws: [L06] appearance via CSS,
 *       [L11] controls emit actions; responders handle actions,
 *       [L16] pairings declared,
 *       [L19] component authoring guide,
 *       [L20] token sovereignty (composes child controls)
 *
 * @see ./internal/floating-surface-notes.ts for the cross-surface
 *      invariants table covering popover / confirm-popover / alert /
 *      sheet and the chain-reactive vs. modal semantic models.
 * @see `arc/tugplan-dev-overlay-framework.md` (#mental-model)
 *      for the system-level architecture covering portals, the
 *      responder chain, focus events, the pane focus controller,
 *      and focus-discipline markers — the five subsystems whose
 *      interaction defines this surface's contract.
 */

import "./tug-sheet.css";

import React, {
  createContext,
  useCallback,
  useContext,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import * as FocusScopeRadix from "@radix-ui/react-focus-scope";
import { TugPaneFrameContext, TugPanePortalContext } from "@/components/chrome/tug-pane";
import { CardIdContext } from "@/lib/card-id-context";
import {
  cardModalHoldStore,
  refuseCardModalHold,
} from "@/lib/card-modal-hold-store";
import { useSheetLifecycle } from "@/lib/sheet-lifecycle";
import { group } from "@/components/tugways/tug-animator";
import { useTugPaneScrim } from "@/components/tugways/use-tug-pane-scrim";
import { usePaneInert } from "@/components/tugways/use-pane-inert";
import type { ActionEvent } from "./responder-chain";
import { useResponderChain } from "./responder-chain-provider";
import { useOptionalResponder } from "./use-responder";
import { useFocusTrap } from "./use-focus-trap";
import { isCancelChordEvent } from "./keymap-registry";
import { FocusManagerContext } from "./focus-manager";
import { TUG_ACTIONS } from "./action-vocabulary";
import { suppressButtonFocusShift } from "./internal/safari-focus-shift";
import {
  useComponentStatePreservation,
  useSavedComponentState,
} from "./use-component-state-preservation";
import { TugSheetStackingContext } from "./tug-sheet-stacking-context";
import {
  DEFAULT_SHADE_FRAC,
  clampShadeFrac,
  readPersistedShadeFrac,
  subscribeShadeHeightDomain,
  writePersistedShadeFrac,
} from "./shade-height";
import { icons } from "lucide-react";

export { SHADE_HEIGHT_DOMAIN } from "./shade-height";

/* ---------------------------------------------------------------------------
 * Presentation styles
 * ---------------------------------------------------------------------------*/

/**
 * Visual entrance/exit style for a TugSheet. Every style lands in the
 * *identical* fully-presented geometry (position, size, centering) —
 * the difference is purely the animated transition into and out of that
 * resting state [L06]. UX is the same across all three; this is a UI
 * affordance only.
 *
 *   - `"top"`        Window-shade drop from the title bar. The panel
 *                    slides down into place and slides back up on
 *                    dismiss. The original window-shade style.
 *   - `"bottom"`     Mirror of `"top"` from the opposite edge: the
 *                    panel slides up into place from below and slides
 *                    back down on dismiss.
 *   - `"rise"`       The shade's motion in panel geometry: the panel rolls a
 *                    short FIXED distance ({@link SHEET_ROLL_PX}) up into
 *                    place while fading in, and back down while fading out.
 *                    Unlike `"bottom"`, the distance does not scale with the
 *                    panel — a tall sheet moves exactly as few pixels as a
 *                    short one, so the entrance reads as a settle rather than
 *                    a sweep. For sheets anchored near their trigger (the Z4B
 *                    pickers above Z2), where a full-height slide is more
 *                    movement than the moment deserves.
 *   - `"scale-fade"` The panel fades in while scaling up from slightly
 *                    smaller, and fades out while scaling back down.
 *                    No directional slide. The default.
 *   - `"shade"`      NOT just a transition — a distinct panel geometry
 *                    ([P17]): full slot width, top-anchored, rendered IN
 *                    PLACE (no pane-frame portal) inside a positioned
 *                    wrapper the consumer provides, with a bottom grabber
 *                    that drags the height fraction (persisted via
 *                    tugbank under `persistKey`). Modal scope covers the
 *                    consumer's `modalScopeSelector` element only — the
 *                    deliberate carve-out that keeps the prompt entry
 *                    live beneath the shade's bottom edge. Enters and
 *                    exits with the `top` window-shade motion.
 *
 * The resting (pre-enter / post-exit) state for each style is declared
 * in `tug-sheet.css` keyed on `data-tug-sheet-presentation` so the
 * panel is correctly positioned before the JS enter animation runs —
 * no first-paint flash. The keyframes below must stay in sync with
 * those resting states.
 */
export type TugSheetPresentation =
  | "top"
  | "bottom"
  | "rise"
  | "scale-fade"
  | "shade";

/**
 * Resting width of the sheet panel, on the same `sm`/`md`/`lg`/`xl` scale as
 * `TugPushButton` / `TugBadge`.
 *
 * Three of the four tiers are pegged to the content-width presets a card can
 * wear (`CONTENT_WIDTH_*_PX` in `lib/layout-imposer.ts`): each is the widest
 * panel that still nests, with a proportional gutter, on the card it is named
 * for. So a tier is a width the sheet actually gets rather than one that
 * always clamps.
 *
 *   - `sm` (510)  The decision width — confirmations, alerts, short forms.
 *                 Nests on every preset, including slim.
 *   - `md` (580)  Fits a slim (675) card. Single-column forms, short lists.
 *   - `lg` (680)  Fits a comfy (800) card. Lists whose rows carry trailing
 *                 controls, two-column panels.
 *   - `xl` (1040) Fits a wide (1230) card. Tabbed reference panels and the
 *                 document column for diffs.
 *
 * The numbers are PAINTED widths — the panel is `border-box`, so a tier is the
 * panel's outer edge-to-edge measure, not its content column.
 *
 * Each is fixed but guarded by a proportional `max-width` so a card narrower
 * than the chosen tier shrinks the panel rather than pressing it against the
 * card's edges. Declared in `tug-sheet.css` keyed on `data-display-width`.
 */
export type TugSheetDisplayWidth = "sm" | "md" | "lg" | "xl";

/**
 * Drag-resize handles for a `resizable` sheet. The sheet is top-anchored and
 * horizontally centered, so there is no north handle (the top edge is pinned
 * below the title bar) — east/west grow the centered width, south grows the
 * height downward, and the two bottom corners combine them.
 */
type SheetResizeEdge = "e" | "w" | "s" | "se" | "sw";
const SHEET_RESIZE_EDGES: SheetResizeEdge[] = ["e", "w", "s", "se", "sw"];
/** Lower bound for drag-resize: the `sm` reading-cap width. */
const SHEET_RESIZE_MIN_WIDTH = 460;
/** Lower bound for drag-resize height. */
const SHEET_RESIZE_MIN_HEIGHT = 250;
/** Gap kept between the sheet's bottom and the canvas bottom (px). */
const SHEET_CANVAS_GAP = 32;

/** Enter/exit keyframe pair for one presentation style. */
interface SheetPresentationMotion {
  enter: Keyframe[];
  exit: Keyframe[];
}

/**
 * Keyframes per presentation style. The first enter frame (and last
 * exit frame) must match the resting state declared in `tug-sheet.css`
 * for the same `data-tug-sheet-presentation` value, so the panel does
 * not jump when the JS animation takes over from the CSS resting state.
 *
 * Under reduced motion TugAnimator strips the spatial properties and
 * substitutes a short opacity fade; the CSS resting states are reset to
 * the presented geometry in that mode (see `tug-sheet.css`).
 */
/**
 * The roll distance shared by the `shade` and `rise` presentations — a short
 * fixed nudge (px, so a tall surface rolls the same light distance as a short
 * one) in place of a full-height `translateY(±100%)` sweep.
 */
const SHEET_ROLL_PX = 28;

const SHEET_PRESENTATION_MOTION: Record<TugSheetPresentation, SheetPresentationMotion> = {
  top: {
    enter: [{ transform: "translateY(-100%)" }, { transform: "translateY(0)" }],
    exit: [{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }],
  },
  bottom: {
    enter: [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }],
    exit: [{ transform: "translateY(0)" }, { transform: "translateY(100%)" }],
  },
  // The shade's roll + fade, carried over to panel geometry. The fade is what
  // makes so short a move read as an entrance rather than a twitch — the roll
  // alone would pop. Opacity targets 1 here (a panel is opaque), where the
  // shade's targets its own `--tugx-shade-alpha`.
  rise: {
    enter: [
      { transform: `translateY(${SHEET_ROLL_PX}px)`, opacity: 0 },
      { transform: "translateY(0)", opacity: 1 },
    ],
    exit: [
      { transform: "translateY(0)", opacity: 1 },
      { transform: `translateY(${SHEET_ROLL_PX}px)`, opacity: 0 },
    ],
  },
  "scale-fade": {
    enter: [
      { transform: "scale(0.96)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    exit: [
      { transform: "scale(1)", opacity: 1 },
      { transform: "scale(0.96)", opacity: 0 },
    ],
  },
  // The shade rolls a short, fixed distance rather than sweeping the full sheet
  // height — a light nudge, not a heavy drop. Transform only: the shade carries
  // its own `--tugx-shade-alpha` translucency, which an opacity keyframe would
  // clobber. `SHADE_BOTTOM_MOTION` mirrors this for the bottom anchor; the
  // paired scrim fade (below) carries the dimming.
  shade: {
    enter: [
      { transform: `translateY(-${SHEET_ROLL_PX}px)` },
      { transform: "translateY(0)" },
    ],
    exit: [
      { transform: "translateY(0)" },
      { transform: `translateY(-${SHEET_ROLL_PX}px)` },
    ],
  },
};

/**
 * Motion for a bottom-anchored shade (`shadeAnchor="bottom"`) — the mirror of
 * the `shade` entry above: the panel rolls up from just below its resting spot
 * and settles back down on dismiss. Kept beside {@link SHEET_PRESENTATION_MOTION}
 * so the enter/exit resolver picks it when the shade is bottom-anchored.
 */
const SHADE_BOTTOM_MOTION: SheetPresentationMotion = {
  enter: [
    { transform: `translateY(${SHEET_ROLL_PX}px)` },
    { transform: "translateY(0)" },
  ],
  exit: [
    { transform: "translateY(0)" },
    { transform: `translateY(${SHEET_ROLL_PX}px)` },
  ],
};

/**
 * Scrim dimming timing. The scrim fades in with the shade's roll, and on
 * dismiss fades a beat *sooner* than the roll finishes — so from the user's eye
 * the dimming is already gone the instant the panel lands, never a hard cut at
 * the end. `ease-out` drops it fast, and the shorter exit clears it early.
 */
const SHADE_SCRIM_EXIT_MS = 150;

/**
 * The shade's resting translucency (`--tugx-shade-alpha`), read live so the fade
 * targets that alpha rather than full opacity — preserving the transcript
 * read-through the shade is designed for. Falls back to 1 if the token is
 * absent.
 */
function readShadeAlpha(el: Element): number {
  const raw = getComputedStyle(el).getPropertyValue("--tugx-shade-alpha").trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 1;
}

/**
 * Merge an opacity fade into the shade's roll keyframes so the panel fades
 * between transparent and its resting alpha AS it rolls — the roll on its own is
 * a short nudge that reads as a pop; the fade is what makes it dismiss smoothly
 * in step with the scrim.
 */
function withShadeOpacity(frames: Keyframe[], from: number, to: number): Keyframe[] {
  return [
    { ...frames[0], opacity: from },
    { ...frames[1], opacity: to },
  ];
}

/* ---------------------------------------------------------------------------
 * Internal context
 * ---------------------------------------------------------------------------*/

interface TugSheetContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentId: string;
  /**
   * Responder id the <TugSheetContent> registers under. Carried on the
   * context so consumer children can target dispatches directly at the
   * sheet via `manager.sendToTarget(responderId, ...)` — critical for
   * the close path, which must not depend on the sheet being first
   * responder (see `useTugSheetClose` for the canonical usage).
   */
  responderId: string;
}

const TugSheetContext = createContext<TugSheetContextValue | null>(null);

function useTugSheetContext(): TugSheetContextValue {
  const ctx = useContext(TugSheetContext);
  if (!ctx) {
    throw new Error("TugSheet sub-components must be used within <TugSheet>.");
  }
  return ctx;
}

/* ---------------------------------------------------------------------------
 * TugSheetHandle
 * ---------------------------------------------------------------------------*/

/** Imperative handle for TugSheet. */
export interface TugSheetHandle {
  /** Opens the sheet. */
  open(): void;
  /** Closes the sheet. */
  close(): void;
}

/* ---------------------------------------------------------------------------
 * TugSheet (Root)
 * ---------------------------------------------------------------------------*/

/** TugSheet root props. */
export interface TugSheetProps {
  /**
   * Seed the initial open state. Primarily an internal affordance for
   * the `useTugSheet()` hook, which mounts a sheet in an already-open
   * state instead of synthesizing an immediate trigger click. Defaults
   * to false; most consumers never set this and open the sheet via
   * `TugSheetTrigger` or the imperative ref handle.
   */
  defaultOpen?: boolean;
  /**
   * Override the auto-generated responder id. Primarily an internal
   * affordance for `useTugSheet()`, which needs to know the responder
   * id up-front so its close callback can dispatch `cancelDialog` via
   * `sendToTarget` without a context round-trip.
   *
   * Regular consumers never set this; TugSheet auto-generates a stable
   * id via `useId()`.
   */
  responderId?: string;
  /** Trigger + Content children. */
  children: React.ReactNode;
  /**
   * Opt the sheet into the Component State Preservation Protocol
   * ([D13], [A9]). When provided (and rendered inside a card), the
   * open state is captured into
   * `bag.components[componentStatePreservationKey]` at every save
   * trigger and reapplied on the next mount — so a sheet the user
   * opened (and was interacting with) re-opens after reload or
   * cmd-tab. Per-surface payloads (form values inside the sheet,
   * scroll position, etc.) are owned by the consumer's own
   * components, which ride their own `bag.components` keys.
   *
   * `tug-sheet` is uncontrolled-only — open state lives in this
   * component's `useState`, so `restoreState` writes through
   * `setOpen` directly. Marked state-preserving per [A9] / [AT0026].
   */
  componentStatePreservationKey?: string;
  /**
   * Observer for open-state commits — NOT a controlled-mode prop (the sheet
   * still owns its own state). Lets a consumer that mirrors the sheet's
   * visibility in an external store (e.g. the Session card's
   * `shadeViewController`) hear a self-initiated close (Escape / Cmd-. /
   * `cancelDialog`) and re-sync.
   */
  onOpenChange?: (open: boolean) => void;
}

/** Serialized shape of `TugSheet`'s preserved state. */
interface TugSheetState {
  open: boolean;
}

/**
 * TugSheet root — manages open/close state and provides context.
 *
 * Compose with TugSheetTrigger and TugSheetContent:
 * ```tsx
 * <TugSheet>
 *   <TugSheetTrigger asChild><TugPushButton>Open</TugPushButton></TugSheetTrigger>
 *   <TugSheetContent title="Settings">…</TugSheetContent>
 * </TugSheet>
 * ```
 */
export const TugSheet = React.forwardRef<TugSheetHandle, TugSheetProps>(
  function TugSheet({ defaultOpen = false, responderId: responderIdProp, children, componentStatePreservationKey, onOpenChange }, ref) {
    const savedSheetState = useSavedComponentState<TugSheetState>(
      componentStatePreservationKey,
    );
    const [open, setOpen] = useState<boolean>(() =>
      typeof savedSheetState?.open === "boolean"
        ? savedSheetState.open
        : defaultOpen,
    );
    const contentId = useId();
    const fallbackResponderId = useId();
    const responderId = responderIdProp ?? fallbackResponderId;

    const handleOpenChange = useCallback(
      (next: boolean) => {
        setOpen(next);
        onOpenChange?.(next);
      },
      [onOpenChange],
    );

    // Opt-in Component State Preservation Protocol. Hook no-ops when
    // `componentStatePreservationKey` is undefined or rendered outside
    // a card. The mount-in-saved-state half lives above in `useState`'s
    // initializer. [AT0026] state-preserving classification.
    useComponentStatePreservation<TugSheetState>({
      componentStatePreservationKey,
      captureState: () => ({ open }),
    });

    useImperativeHandle(ref, () => ({
      open() {
        handleOpenChange(true);
      },
      close() {
        handleOpenChange(false);
      },
    }));

    return (
      <TugSheetContext value={{ open, onOpenChange: handleOpenChange, contentId, responderId }}>
        {children}
      </TugSheetContext>
    );
  },
);

/* ---------------------------------------------------------------------------
 * TugSheetTrigger
 * ---------------------------------------------------------------------------*/

/** TugSheetTrigger props. */
export interface TugSheetTriggerProps {
  /**
   * Render as child element, merging ARIA + click handler onto it.
   * @default true
   */
  asChild?: boolean;
  children: React.ReactNode;
}

/**
 * TugSheetTrigger — wraps a single child, merging ARIA attributes and open handler.
 *
 * Defaults to asChild so the caller's element is used directly.
 */
export function TugSheetTrigger({ asChild = true, children }: TugSheetTriggerProps) {
  const { open, onOpenChange, contentId } = useTugSheetContext();

  if (!asChild) {
    return (
      <button
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => onOpenChange(true)}
      >
        {children}
      </button>
    );
  }

  // asChild: merge props onto the single child element.
  const child = React.Children.only(children) as React.ReactElement<
    React.HTMLAttributes<HTMLElement> & {
      "aria-haspopup"?: string;
      "aria-expanded"?: boolean;
      "aria-controls"?: string;
    }
  >;

  return React.cloneElement(child, {
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? contentId : undefined,
    onClick: (e: React.MouseEvent) => {
      // Call original onClick if present.
      const original = child.props.onClick as ((e: React.MouseEvent) => void) | undefined;
      original?.(e);
      onOpenChange(true);
    },
  });
}

/* ---------------------------------------------------------------------------
 * TugSheetContent
 * ---------------------------------------------------------------------------*/

/** TugSheetContent props. */
/**
 * Color role for a sheet header icon. `"muted"` (the default) paints the
 * neutral icon color TugAlert uses; the others tint the icon with the matching
 * tone color — `"agent"` is the violet the Z4B agent chips carry, so the
 * permission/model/effort picker sheets read as agent surfaces.
 */
export type TugSheetIconRole =
  | "muted"
  | "agent"
  | "accent"
  | "active"
  | "caution"
  | "danger"
  | "data"
  | "success";

/* ---------------------------------------------------------------------------
 * Exclusivity
 * ---------------------------------------------------------------------------*/

/**
 * What a sheet declares when it covers a **run** rather than a decision.
 *
 * An ordinary sheet is dismissible from every direction, and that is right: a
 * picker the user opened costs nothing to abandon, another `showSheet` may
 * supersede it, and closing the card takes it with everything else. A run — a
 * `/compact` that will go on for minutes whether or not anything is watching —
 * wants the opposite. While it stands there are exactly two honest ways
 * forward, the run settling and the user canceling it, and every other door is
 * a way to lose sight of work that is still going.
 *
 * A sheet opened with this takes its card's modal hold for as long as it is
 * open (see `lib/card-modal-hold-store`). Escape, ⌘., a later `showSheet` on
 * the same host, and the pane's own close routes all find the hold and report
 * {@link onRefused} instead of acting. What still works is exactly the pair
 * that should: the `close(result)` callback handed to the sheet's content, and
 * the host unmounting — because the run's lifetime was never the sheet's, and
 * a card moved between panes must not strand a hold on a sheet that no longer
 * exists.
 */
export interface SheetExclusivity {
  /** Why the card is refusing, in the holder's own wording. */
  reason: string;
  /**
   * Speak the refusal. Called with no argument for every door pressed while
   * the sheet stands, so the answer comes from the run rather than from
   * whichever piece of chrome was touched ([L31]).
   */
  onRefused: () => void;
}

/**
 * The `ActionEvent.value` a `CANCEL_DIALOG` must carry to dismiss an exclusive
 * sheet. The hook's own `close(result)` callback carries it; Escape, ⌘., and a
 * content-side `useTugSheetClose()` do not, which is what tells the sheet's
 * responder handler a dismissal from the run apart from one from the user.
 * Module-private on purpose — the only legitimate dismissal is the one the
 * sheet's content was handed.
 */
const SHEET_SETTLED_DISMISS = "tug-sheet:settled";

export interface TugSheetContentProps {
  /**
   * Sheet title (required — renders in header row, wired to aria-labelledby).
   */
  title: string;
  /**
   * Optional Lucide icon name (PascalCase, e.g. `"Pencil"`) shown to the left
   * of the title — the TugAlert header layout. Omit for no icon.
   */
  icon?: string;
  /**
   * Color role for {@link icon}. Defaults to `"muted"`. Pass `"agent"` for the
   * Z4B picker sheets so the icon carries the agent tone.
   */
  iconRole?: TugSheetIconRole;
  /**
   * Optional description text (wired to aria-describedby).
   */
  description?: string;
  /**
   * Override initial focus target. Call event.preventDefault() to manage manually.
   */
  onOpenAutoFocus?: (event: Event) => void;
  /**
   * Optional supplier of the close-result, read at the moment
   * `mounted` transitions to false (sheet fully torn down). When
   * provided, the sheet emits `sheetLifecycle.notifySheetDidReturnResult(cardId, getResult())`
   * immediately after `sheetDidHide`, so consumers subscribed via
   * `useSheetDelegate({ sheetDidReturnResult })` receive the
   * result alongside the structural transition.
   *
   * Hook-driven sheets (`useTugSheet`) supply this automatically
   * by closing over the hook's `lastResultRef`. Direct
   * `<TugSheetContent>` consumers that don't track a result omit
   * it; in that case `sheetDidReturnResult` does not fire (only
   * the structural `sheetDidHide` does).
   *
   * The closure-based `onClosed(result)` callback that older code
   * used has been removed in favor of this lifecycle event — a
   * single, observable, per-card pipe replaces N closure-handler
   * threads. See `lib/sheet-lifecycle.ts` for the full contract.
   */
  getResult?: () => string | undefined;
  /**
   * Declare this sheet the cover of a **run**: it takes the host card's modal
   * hold while open, and every dismissal that is not the content's own
   * `close(result)` is refused through {@link SheetExclusivity.onRefused}.
   * Omit for an ordinary sheet. See {@link SheetExclusivity}.
   */
  exclusive?: SheetExclusivity;
  /**
   * Stable opaque sender id for chain dispatches. Auto-derived via
   * `useId()` if omitted. Parent responders disambiguate multi-sheet
   * pages when observing dispatches by sender. [L11]
   */
  senderId?: string;
  /**
   * Visual entrance/exit style. All styles share the identical
   * fully-presented geometry — only the animated transition differs
   * [L06]. Defaults to `"scale-fade"` (fade in while scaling up). See
   * {@link TugSheetPresentation}.
   */
  presentation?: TugSheetPresentation;
  /**
   * Resting width of the panel within the host pane. Defaults to `"sm"`.
   * See {@link TugSheetDisplayWidth}.
   */
  displayWidth?: TugSheetDisplayWidth;
  /**
   * When `true`, the user can drag-resize the panel (native CSS `resize`).
   * Defaults to `false`. See {@link ShowSheetOptions.resizable}.
   */
  resizable?: boolean;
  /**
   * Cap the panel to this fraction (0–1) of the host card's box on BOTH
   * axes — the panel never exceeds `fraction × pane-frame width/height`,
   * so it stays visibly nested inside the card rather than bleeding to
   * its edges. Applied as inline `max-width`/`max-height` (re-measured
   * on resize), overriding the {@link displayWidth} cap and the
   * viewport-relative height clamp.
   *
   * Width nesting is NOT a reason to reach for this: the CSS
   * `--tugx-sheet-gutter` already holds every tier a proportional distance
   * off the card's edges. What this adds is the HEIGHT axis and a cap
   * tighter than the tier — which is why the aspect-locked lightbox needs
   * it. Omit otherwise (height clamped to the canvas bottom).
   * See {@link ShowSheetOptions.maxHostFraction}.
   */
  maxHostFraction?: number;
  /**
   * Lock the panel's proportions to an aspect-ratio'd content region so the
   * margin around that region stays uniform at every size (e.g. an image
   * preview). The body must mark its aspect region with
   * `data-tug-aspect-region`; the panel's height then becomes
   * content-driven (the region's `aspect-ratio` sets it from the width) and
   * drag-resize is width-only — height follows the aspect, so dragging can't
   * produce lopsided letterbox margins. The width is still capped to
   * {@link maxHostFraction} of the card, and additionally clamped so the
   * content-driven height never exceeds that same fraction. Requires
   * `resizable`. Defaults to `false`.
   */
  aspectLockContent?: boolean;
  /**
   * Suppress the title-bar header; the content owns the panel. `title`
   * still labels the dialog (via `aria-label`). Defaults to `false`.
   * See {@link ShowSheetOptions.hideHeader}.
   */
  hideHeader?: boolean;
  /**
   * Keep the title but drop the divider rule beneath it (and its extra
   * spacing). For compact sheets whose body reads as one unit with the
   * title. Defaults to `false`. See {@link ShowSheetOptions.hideHeaderRule}.
   */
  hideHeaderRule?: boolean;
  /**
   * Disposition toward an enclosing focus cycle on a **committed** close ([P15]
   * generalized to sub-surfaces). `"retain"` (default) pops normally — the cycle
   * stays, focus returns to the originating stop. `"relinquish"` cascade-pops the
   * enclosing cycle so it exits to its resting destination. Honored only when
   * `getResult()` reports a committed value at close; a cancel always retains.
   * See {@link ShowSheetOptions.onCommitDisposition}.
   */
  onCommitDisposition?: "retain" | "relinquish";
  /**
   * Tugbank key the `shade` presentation's height fraction persists under
   * (shades sharing a key share a height). Required for
   * `presentation="shade"`; ignored otherwise.
   */
  persistKey?: string;
  /**
   * Pixel floor for the shade's height — it can never be dragged shorter.
   * Shade presentation only. @default 160
   */
  shadeMinHeight?: number;
  /**
   * Content-drive the shade's height instead of the drag fraction. The panel
   * sizes to its content (`fit-content`) and may grow to the full slot height
   * (the transcript, capped at the Z2 status bar); a short body sizes small.
   * The drag grabber and the `shadeMinHeight` floor are dropped — the content
   * owns the height. Shade presentation only. @default false
   */
  shadeAutoSize?: boolean;
  /**
   * Which edge of the slot the `shade` presentation anchors to ([P17]).
   * `"top"` (default) is the window-shade drop from the header; `"bottom"`
   * mirrors it — the shade is pinned to the slot's bottom edge (the top of
   * the Z2 status bar) and rises upward over the transcript, with a
   * `border-top` and an upward shadow. Bottom-anchored shades carry no
   * grabber (they pair with `shadeAutoSize`). Shade presentation only.
   * @default "top"
   */
  shadeAnchor?: "top" | "bottom";
  /**
   * Present the shade WITHOUT claiming focus ([P17] passive shade). The scrim
   * and the transcript-inert modality still apply, but the shade installs no
   * focus trap, does not auto-focus its content on open, and restores nothing
   * on close — focus stays wherever it was (the live prompt entry below the
   * shade). For the commit route, where the composer is the message editor and
   * the rising changes sheet is a passive display beside it. Shade presentation
   * only. @default false
   */
  shadePassive?: boolean;
  /**
   * Whether the shade shows its bottom resize grabber. Default `true`. A plain,
   * non-resizable shade (e.g. History) passes `false` — the shade keeps its
   * fixed-fraction height with no drag handle. Ignored under `shadeAutoSize`
   * (which never shows a grabber). Shade presentation only.
   */
  shadeGrabber?: boolean;
  /** Accessible label for the shade's resize grabber. @default "Resize" */
  grabberLabel?: string;
  /**
   * Bottom-anchor the panel to the bottom edge of the element matching this
   * selector (queried within the host pane chrome) instead of top-anchoring it
   * under the pane title bar. The clip keeps its top pinned below the chrome
   * and takes its bottom from the measured anchor edge, so the panel rests just
   * above that edge and grows upward — the placement the Z4B picker sheets use
   * to sit above the Session card's Z2 status bar, near the chips that open
   * them. Pair with `presentation="bottom"` so the panel rises from the anchor
   * rather than dropping from the title bar.
   *
   * A selector that matches nothing (a host without the anchor element) falls
   * back to the default top anchor.
   */
  bottomAnchorSelector?: string;
  /**
   * Selector (queried within the host pane chrome) for the element that goes
   * `inert` while the sheet is open. Defaults to `.tug-pane-body` — the
   * whole-pane-body modal contract. The `shade` presentation passes a
   * narrower region ([P17]'s carve-out: the transcript slot, leaving the
   * prompt entry live).
   */
  modalScopeSelector?: string;
  /** Arbitrary content. */
  children?: React.ReactNode;
}

/**
 * TugSheetContent — the sheet panel, focus scope, and portal logic.
 *
 * Portals into the pane frame element (from `TugPaneFrameContext`),
 * which is the `.tug-pane` outer frame and its own stacking context.
 * The panel paints inside the pane's stacking context — peer panes
 * z-stacked above paint above the panel automatically [D19, D20].
 *
 * Visual scrim is provided by the pane's built-in scrim layer raised
 * via `useTugPaneScrim()`; this component does not own a scrim
 * element of its own. `inert` is applied to `.tug-pane-body` (read
 * from `TugPanePortalContext`) for keyboard-routing scope. Restores
 * focus to the trigger element on close.
 */
export function TugSheetContent({
  title,
  icon,
  iconRole = "muted",
  description,
  onOpenAutoFocus,
  getResult,
  exclusive,
  senderId: senderIdProp,
  presentation = "scale-fade",
  displayWidth = "sm",
  resizable = false,
  maxHostFraction,
  aspectLockContent = false,
  hideHeader = false,
  hideHeaderRule = false,
  onCommitDisposition = "retain",
  persistKey,
  shadeMinHeight = 160,
  shadeAutoSize = false,
  shadeGrabber = true,
  shadeAnchor = "top",
  shadePassive = false,
  grabberLabel = "Resize",
  bottomAnchorSelector,
  modalScopeSelector,
  children,
}: TugSheetContentProps) {
  const { open, onOpenChange, contentId, responderId } = useTugSheetContext();
  // Chrome ref drives the inert effect (`inert` on `.tug-pane-body`).
  const cardEl = useContext(TugPanePortalContext);
  // Frame ref is the portal target. Pane-modal surfaces portal here so
  // they paint inside the pane's stacking context [D19, D20]; standalone
  // consumers (no TugPane ancestor) fall back to document.body.
  const paneFrameEl = useContext(TugPaneFrameContext);
  // Pane's built-in scrim layer. Show on open, hide on close — the
  // pane's CSS handles the fade transition. [D18]
  const paneScrim = useTugPaneScrim();

  const titleId = `${contentId}-title`;
  const descriptionId = `${contentId}-desc`;

  // Resolve the optional header icon by Lucide name (PascalCase), matching
  // TugAlert's lookup. Unknown names resolve to null (no icon, no throw).
  const IconComponent = icon ? (icons[icon as keyof typeof icons] ?? null) : null;

  // Chain manager — null when rendered outside a ResponderChainProvider.
  // Escape / Cmd+. fall back to calling onOpenChange directly in that
  // case; otherwise they dispatch cancelDialog via sendToTarget at the
  // sheet's own responder id so the walk starts inside the sheet
  // regardless of current first-responder state.
  const manager = useResponderChain();

  const fallbackSenderId = useId();
  const senderId = senderIdProp ?? fallbackSenderId;

  // Stable primary close action. Kept here and referenced by both the
  // cancelDialog chain handler and the no-provider keydown fallback so
  // a single function owns the "close the sheet" semantics.
  const closeSheet = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // Exclusivity, live at dispatch time rather than through the callbacks below
  // ([L07]): `requestCancel` and the responder handler are registered once and
  // outlive any number of renders, and a run that settles mid-gesture must not
  // be refused by a closure holding the value it had at registration.
  const exclusiveRef = useRef<SheetExclusivity | undefined>(exclusive);
  exclusiveRef.current = exclusive;

  // The card this sheet stands in — the key its modal hold is filed under.
  // `null` outside a card host (gallery previews, standalone harnesses), where
  // there is no card to hold and exclusivity is inert.
  const holdCardId = useContext(CardIdContext);

  // Take the hold for exactly as long as the sheet is open — the same span the
  // pane scrim and the body's `inert` cover, because the three answer the same
  // question from three directions. `useLayoutEffect` so the hold is filed
  // before the browser paints the sheet ([L03]), and the release is returned by
  // the acquisition rather than mirrored elsewhere ([L27]), which is what makes
  // the unmount-while-open path — a card dragged to another pane mid-run —
  // leave nothing behind.
  useLayoutEffect(() => {
    if (!open || exclusive === undefined || holdCardId === null) return;
    return cardModalHoldStore.hold(holdCardId, {
      reason: exclusive.reason,
      refuse: () => exclusiveRef.current?.onRefused(),
    });
  }, [open, exclusive, holdCardId]);

  // The sheet's cancel request: dispatch `CANCEL_DIALOG` to the sheet's own
  // responder id (so the walk starts inside the sheet regardless of current
  // first-responder state), or call `closeSheet` directly with no provider. Both
  // the engine's Escape ladder (registered as the trap's `onEscapeDismiss`) and
  // the ⌘. keydown route through here — one owner for "the user asked to cancel."
  const requestCancel = useCallback(() => {
    // An exclusive sheet has no keyboard exit. Refuse here, BEFORE the
    // dispatch, rather than in the responder handler below: a dispatch that
    // reached the chain would be seen by `useTugSheet`'s observer, which
    // resolves the pending promise on any `cancelDialog` carrying its sender —
    // leaving the caller told its sheet had closed while the sheet stood.
    const held = exclusiveRef.current;
    if (held !== undefined) {
      held.onRefused();
      return;
    }
    if (manager) {
      manager.sendToTarget(responderId, {
        action: TUG_ACTIONS.CANCEL_DIALOG,
        sender: senderId,
        phase: "discrete",
      });
    } else {
      closeSheet();
    }
  }, [manager, responderId, senderId, closeSheet]);

  // Register the sheet content as a chain responder. The cancelDialog
  // handler closes the sheet; there is no confirmDialog handler (a
  // sheet's "confirm" is the consumer's responsibility — their save
  // logic runs first, then they dispatch cancelDialog to close).
  // Tolerant of no-provider contexts.
  const { ResponderScope, responderRef } = useOptionalResponder({
    id: responderId,
    actions: {
      // An exclusive sheet closes for its own run and for nothing else. The
      // dismissal the hook's `close(result)` performs carries
      // `SHEET_SETTLED_DISMISS`; a cancel arriving from anywhere else — a
      // content-side `useTugSheetClose()`, a stray chain dispatch — is the
      // user asking to leave, and gets the run's answer instead ([L31]).
      [TUG_ACTIONS.CANCEL_DIALOG]: (event: ActionEvent) => {
        const held = exclusiveRef.current;
        if (held !== undefined && event.value !== SHEET_SETTLED_DISMISS) {
          held.onRefused();
          return;
        }
        closeSheet();
      },
    },
  });

  // Composed ref callback for the sheet content div. Writes to the
  // internal sheetContentRef (used by the enter/exit animation
  // effects) AND hands the element to responderRef which writes
  // data-responder-id. useCallback-stabilized so React doesn't
  // toggle data-responder-id off and on every render.
  const composedContentRef = useCallback(
    (el: HTMLDivElement | null) => {
      sheetContentRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );

  // Engine focus trap ([P03]/[#cfrunloop-model]): push a trapped focus mode
  // while the sheet is open so the Tab walk is scoped to the sheet and the key
  // view is captured at open and restored to the opener on dismiss. This is the
  // engine's logical scope, and it works *alongside* the Radix `FocusScope`
  // below — the split is deliberate and is the intended resting state, not a
  // way station. The engine owns the logical key view, the focus ring, and the
  // Tab walk over registered focusables; Radix owns the DOM-focus plumbing it
  // does well: auto-focusing the first tabbable on open, restoring DOM focus to
  // the opener on close, and `loop`-containing Tab for any focusable the engine
  // walk does not register (text inputs are key-capture leaves, not engine
  // focusables, so a form sheet relies on Radix to keep Tab inside it). The
  // sheet body is wrapped in `FocusModeScope` so any engine focusable inside it
  // joins this mode.
  // Close disposition toward an enclosing focus cycle ([P15] generalized).
  // Resolved during render from the live close state: once `open` has flipped
  // false AND this was a committed close (`getResult()` reports a value) AND the
  // consumer asked to relinquish, the trap's pop relinquishes the enclosing cycle
  // instead of restoring the originating stop. Computed during render (a ref, not
  // state) so it is set before the trap's pop cleanup reads it; a cancel
  // (no committed result) always retains. The engine relinquish is the single
  // close-focus authority, so `handleUnmountAutoFocus` below stands down for it.
  const closeDispositionRef = useRef<"retain" | "relinquish">("retain");
  closeDispositionRef.current =
    !open && onCommitDisposition === "relinquish" && getResult?.() !== undefined
      ? "relinquish"
      : "retain";

  // `deferDomFocusToTeardown`: the sheet owns its single close-focus DOM write in
  // `handleUnmountAutoFocus` (on the Radix `FocusScope` below) — relinquish
  // stand-down / engine-owns→`focusKeyView` / mouse→trigger. So the trap pops
  // `moveDomFocus: false` (logical state only, key view + first responder); the
  // engine must NOT also move DOM focus in `popFocusMode`, which would double-write
  // against the unmount-autofocus writer.
  const { FocusModeScope } = useFocusTrap({
    // Passive shade ([P17]): no trap — focus stays in the live prompt entry
    // below the shade, which is the message editor for the commit route.
    active: open && !shadePassive,
    closeDisposition: closeDispositionRef,
    deferDomFocusToTeardown: true,
    // [P01] The engine's Escape ladder owns the sheet's Escape now: when the
    // sheet's trap is the top mode, the ladder calls this instead of the sheet's
    // own `handleKeyDown` Escape branch (deleted below). ⌘. stays chain-routed.
    onEscapeDismiss: requestCancel,
  });

  // Presence: keep the portal mounted during the exit animation.
  // `mounted` becomes true when open goes true, and false only after the exit animation completes.
  const [mounted, setMounted] = useState(false);
  const sheetContentRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  // The shade's own scrim element ([P17]); the enter/exit effects fade it in
  // step with the roll (out a beat sooner, so it reads as gone on landing).
  const shadeScrimRef = useRef<HTMLDivElement | null>(null);

  // ---- Clamp the panel to the canvas ([D15]) ----
  //
  // Pure CSS can't see where the host pane sits relative to the canvas, so a
  // tall panel (long /diff) ran off the bottom. Mirror what panes do when
  // drag-resizing: measure the rectangles and clamp in JS. The canvas is the
  // pane frame's parent; the panel's top is the (un-transformed) clip top plus
  // its own top margin. Set `max-height` so the panel bottom lands
  // `SHEET_CANVAS_GAP` px above the visible bottom. Re-measured on canvas/pane
  // resize and window resize. DOM write only ([L06]); inline `max-height`
  // overrides the CSS fallback. Geometry is read from the clip (never
  // transformed) so the entrance animation on the panel doesn't skew it — no
  // rAF/commit sequencing needed ([L05]).
  // ---- Bottom anchor ----
  //
  // The element whose bottom edge the clip pins to, when the consumer asked for
  // a bottom-anchored panel. Resolved from the pane chrome the same way
  // `modalScopeSelector` resolves its inert region; null (no selector, or a
  // selector that matches nothing) leaves the default top anchor in place.
  const bottomAnchorEl = useMemo(
    () =>
      bottomAnchorSelector !== undefined
        ? (cardEl?.querySelector(bottomAnchorSelector) ?? null)
        : null,
    [cardEl, bottomAnchorSelector],
  );

  // Write the clip's bottom edge from the measured anchor, in frame
  // coordinates ([L06] — DOM write, no React state). The clip's top stays
  // pinned under the chrome via CSS, so setting `bottom` makes the clip exactly
  // the band between the title bar and the anchor; `tug-sheet.css` bottom-aligns
  // the panel within it and caps its height to that band. Re-measured whenever
  // the pane or the anchor resizes — dragging the Session card's sash and
  // growing the Z2 telemetry row both change the anchor's height.
  useLayoutEffect(() => {
    const clip = clipRef.current;
    if (clip === null || bottomAnchorEl === null || paneFrameEl === null) return;
    const measure = (): void => {
      const frame = paneFrameEl.getBoundingClientRect();
      const anchor = bottomAnchorEl.getBoundingClientRect();
      // Where the panel would rest if the band above the anchor held it.
      const restInset = Math.max(0, frame.bottom - anchor.bottom);
      // The anchor is a PREFERENCE, not a ceiling. When the panel needs more
      // height than the band between the title bar and the anchor — the
      // Session card's prompt entry grown tall leaves the view slot only a
      // sliver — pushing the whole panel up against the title bar and making
      // it scroll is the wrong trade: a sheet is a panel, read at a glance,
      // and the region below the anchor is exactly what a modal is entitled
      // to paint over. So the clip's bottom edge slides DOWN over that region
      // by however much the panel is short, stopping `SHEET_CANVAS_GAP` above
      // the frame's bottom edge. A panel that fits stays where its chips are.
      const content = sheetContentRef.current;
      let inset = restInset;
      if (content !== null) {
        const cs = getComputedStyle(content);
        const px = (value: string): number => Number.parseFloat(value) || 0;
        const marginBottom = px(cs.marginBottom);
        const gutters = px(cs.marginTop) + marginBottom;
        // `scrollHeight` is the panel's natural height whether or not the cap
        // is currently biting, so this measure is stable against its own
        // write — the loop quiesces on the second pass.
        const needed =
          content.scrollHeight +
          px(cs.borderTopWidth) +
          px(cs.borderBottomWidth) +
          gutters;
        const band = frame.bottom - restInset - clip.getBoundingClientRect().top;
        const shortfall = needed - band;
        if (shortfall > 0) {
          // How far down the panel may go: `SHEET_CANVAS_GAP` above the frame's
          // bottom edge, or above the viewport's when the pane runs off the
          // bottom of the window (the same "never below the viewport" reading
          // the canvas clamp takes). Expressed as an inset from the frame
          // bottom, which is what the clip's `bottom` is measured in.
          const floor = Math.max(
            0,
            frame.bottom -
              Math.min(frame.bottom, window.innerHeight) +
              SHEET_CANVAS_GAP -
              marginBottom,
          );
          inset = Math.max(floor, restInset - shortfall);
        }
      }
      clip.style.bottom = `${inset}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(paneFrameEl);
    observer.observe(bottomAnchorEl);
    // The panel's own height is an input now: an accordion row opening inside
    // the AI mixer is what tips a fitting sheet into an overflowing one.
    if (sheetContentRef.current !== null) observer.observe(sheetContentRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [bottomAnchorEl, paneFrameEl, mounted]);

  useLayoutEffect(() => {
    // The shade's height is fraction-driven CSS against its slot — no
    // canvas clamp applies.
    if (presentation === "shade") return;
    // A bottom-anchored clip is bounded on both edges, so CSS caps the panel
    // against the clip itself — there is no canvas bottom to measure toward.
    if (bottomAnchorEl !== null) return;
    const content = sheetContentRef.current;
    const clip = clipRef.current;
    if (content === null || clip === null || paneFrameEl === null) return;
    const canvas = paneFrameEl.parentElement;
    if (canvas === null) return;
    const measure = (): void => {
      // The visible bottom limit: the canvas rect bottom, but never below the
      // viewport (the canvas element can be taller than the window).
      const bottomLimit = Math.min(
        canvas.getBoundingClientRect().bottom,
        window.innerHeight,
      );
      const clipTop = clip.getBoundingClientRect().top;
      const marginTop =
        Number.parseFloat(getComputedStyle(content).marginTop) || 0;
      const available = bottomLimit - SHEET_CANVAS_GAP - clipTop - marginTop;
      const frac = maxHostFraction ?? 0.8;
      // Aspect-locked: height is content-driven (the body's aspect region's
      // `aspect-ratio` sets it from the width), so we clear `max-height` and
      // instead cap the WIDTH — both to `frac` of the card width AND so the
      // resulting height (chrome + region) stays within `frac` of the card
      // height. The aspect and the chrome height are scale-invariant, so this
      // is idempotent (no resize-observer feedback loop).
      if (aspectLockContent) {
        const frame = paneFrameEl.getBoundingClientRect();
        const region = content.querySelector("[data-tug-aspect-region]");
        content.style.maxHeight = "";
        let widthCap = frame.width * frac;
        if (
          region instanceof HTMLElement &&
          region.offsetWidth > 0 &&
          region.offsetHeight > 0
        ) {
          const aspect = region.offsetWidth / region.offsetHeight;
          const chromeY = content.offsetHeight - region.offsetHeight;
          const cs = getComputedStyle(content);
          const padX =
            (Number.parseFloat(cs.paddingLeft) || 0) +
            (Number.parseFloat(cs.paddingRight) || 0);
          const heightCap = Math.min(available, frame.height * frac);
          widthCap = Math.min(widthCap, (heightCap - chromeY) * aspect + padX);
        }
        // The drag floor keeps a sheet the USER is dragging from collapsing to
        // a slit. It is not a claim about how wide the sheet may be — so on a
        // host too narrow to hold it, the floor is the thing that yields. Left
        // outranking the cap it was smashing the card it nests in: on a rail
        // (a Overview a few hundred pixels wide) `max(460, cap)` is always 460,
        // whatever fraction the caller asked for, and the panel comes out
        // wider than the column it opened in. Capped by the same fraction, the
        // floor still does its job on every host wide enough to have one.
        const floor = Math.min(SHEET_RESIZE_MIN_WIDTH, frame.width * frac);
        // Write only on change — `observer.observe(content)` would otherwise
        // re-fire on our own write. The value is scale-invariant, so a repeat
        // measure yields the same string and the loop quiesces immediately.
        const next = `${Math.max(floor, widthCap)}px`;
        if (content.style.maxWidth !== next) content.style.maxWidth = next;
        return;
      }
      // When asked to nest inside the host card, cap BOTH axes to a fraction
      // of the pane-frame box so the panel never bleeds to the card edges.
      // Inline `max-width` overrides the `displayWidth` width; the height cap
      // is the tighter of the canvas-bottom clamp and the fractional cap.
      if (maxHostFraction !== undefined) {
        const frame = paneFrameEl.getBoundingClientRect();
        content.style.maxWidth = `${frame.width * maxHostFraction}px`;
        content.style.maxHeight = `${Math.max(
          SHEET_RESIZE_MIN_HEIGHT,
          Math.min(available, frame.height * maxHostFraction),
        )}px`;
        return;
      }
      content.style.maxHeight = `${Math.max(SHEET_RESIZE_MIN_HEIGHT, available)}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(paneFrameEl);
    // Aspect-lock re-measures when the body's content resizes — chiefly when
    // the image loads and the aspect region takes its true shape. Safe against
    // feedback because `measure()` is idempotent under width changes.
    if (aspectLockContent) observer.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [paneFrameEl, mounted, maxHostFraction, aspectLockContent, presentation, bottomAnchorEl]);

  // ---- Drag-resize ([D15] resizable sheets) ----
  //
  // Pane-style edge/corner handles. The geometry is written straight to the
  // content element's inline `width`/`height` ([L06] — no React state); CSS
  // `max-width`/`max-height` cap the upper bound (so a narrow pane shrinks the
  // sheet rather than overflowing), and we clamp the lower bound to the `sm`
  // width / 250px here. The sheet is horizontally centered and top-anchored,
  // so horizontal edges grow symmetrically (the dragged edge tracks the cursor
  // via 2×dx) and the south edge grows downward — there is no north handle.
  const resizeStateRef = useRef<{
    edge: SheetResizeEdge;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onResizePointerDown = useCallback(
    (edge: SheetResizeEdge) => (event: React.PointerEvent) => {
      const el = sheetContentRef.current;
      if (el === null) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = el.getBoundingClientRect();
      resizeStateRef.current = {
        edge,
        startX: event.clientX,
        startY: event.clientY,
        startW: rect.width,
        startH: rect.height,
      };
      (event.currentTarget as HTMLElement).setPointerCapture(
        event.nativeEvent.pointerId,
      );
    },
    [],
  );

  const onResizePointerMove = useCallback((event: React.PointerEvent) => {
    const state = resizeStateRef.current;
    const el = sheetContentRef.current;
    if (state === null || el === null) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    let width = state.startW;
    if (state.edge.includes("e")) width = state.startW + 2 * dx;
    if (state.edge.includes("w")) width = state.startW - 2 * dx;
    el.style.width = `${Math.max(SHEET_RESIZE_MIN_WIDTH, width)}px`;
    // Aspect-locked content drives its own height from the width, so we never
    // write an explicit height — dragging scales the panel along the aspect.
    if (aspectLockContent) {
      el.style.height = "";
      return;
    }
    let height = state.startH;
    if (state.edge.includes("s")) height = state.startH + dy;
    el.style.height = `${Math.max(SHEET_RESIZE_MIN_HEIGHT, height)}px`;
  }, [aspectLockContent]);

  const onResizePointerUp = useCallback((event: React.PointerEvent) => {
    if (resizeStateRef.current === null) return;
    resizeStateRef.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(
      event.nativeEvent.pointerId,
    );
  }, []);

  // ---- Sheet-lifecycle event emission ----
  //
  // Per-card scope: the cardId comes from `CardIdContext` (provided
  // by `CardHost`). When the sheet mounts outside a card host
  // (gallery previews, standalone tests), cardId is null and
  // emission is skipped silently — there is no subscriber that
  // cares about non-card sheets.
  //
  // Four events fire at the structural transitions of the sheet's
  // lifecycle, plus a result-bearing `sheetDidReturnResult`:
  //   - sheetWillShow:        `open` first becomes true.
  //   - sheetDidShow:         enter animation finishes (sheet fully
  //                           presented; inert set on `.tug-pane-body`).
  //   - sheetWillHide:        `open` flips from true to false (close
  //                           initiated; exit animation pending).
  //   - sheetDidHide:         `mounted` transitions from true to
  //                           false (exit animation done, portaled
  //                           DOM removed, inert cleared, FocusScope
  //                           teardown done). This is the focus-
  //                           claim signal.
  //   - sheetDidReturnResult: fires *after* sheetDidHide, carrying
  //                           the close-result returned by `close(result)`.
  //                           Hook-driven sheets (`useTugSheet`)
  //                           supply `getResult` to surface the
  //                           result; direct `<TugSheetContent>`
  //                           consumers without `getResult` skip
  //                           this event.
  const cardIdForLifecycle = useContext(CardIdContext);
  const sheetLifecycle = useSheetLifecycle();

  // Effect 1: state mutation. When `open` flips true, promote
  // `mounted` so the portal is in the DOM for the enter animation.
  // No event emission here — that responsibility lives in effect 2.
  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
    }
    // When open goes false, mounted stays true — exit animation will set it false.
  }, [open]);

  // Effect 2: emit will-show / will-hide on `open` transitions
  // (including the first-render `open=true` case, where prevOpen
  // starts false). Pure event emission — no React state mutation.
  const prevOpenForLifecycleRef = useRef(false);
  useLayoutEffect(() => {
    if (cardIdForLifecycle !== null && sheetLifecycle !== null) {
      const prev = prevOpenForLifecycleRef.current;
      if (open && !prev) {
        sheetLifecycle.notifySheetWillShow(cardIdForLifecycle);
      } else if (!open && prev) {
        sheetLifecycle.notifySheetWillHide(cardIdForLifecycle);
      }
    }
    prevOpenForLifecycleRef.current = open;
  }, [open, cardIdForLifecycle, sheetLifecycle]);

  // Effect 3: emit did-hide / did-return-result when `mounted`
  // transitions from true to false. By this point the exit animation
  // has completed, the portaled DOM has been removed, the inert
  // effect's cleanup has cleared the attribute, and Radix's
  // FocusScope unmount-autofocus has run. Body interactivity is
  // restored.
  //
  // **`sheetDidHide` is load-bearing for editor focus restoration.**
  // The sheet sets `inert` on `.tug-pane-body` while open, which
  // strips DOM focus from anything inside (including CodeMirror's
  // contentDOM). When the sheet exits, the editor is reachable again
  // but unfocused — Radix's `onUnmountAutoFocus` returns focus to
  // the trigger element, but Dev's editor is not the trigger here.
  // `SessionCardBody` subscribes to `sheetDidHide` and re-focuses the
  // prompt-entry editor, gated on first-responder state. Per the
  // contract documented in `session-card.tsx` (the focus-claim handlers
  // block) and pinned by
  // `tests/app-test/at0175-session-mount-focus.test.ts`: any modal-class
  // surface that portals into the pane chrome and sets `inert` on
  // the pane body MUST emit a per-card `didHide` lifecycle event
  // after `inert` clears, mirroring this emission. Removing or
  // gating this emission breaks at0051 — that's intentional.
  //
  // `sheetDidHide` fires first (structural-only, all subscribers).
  // `sheetDidReturnResult` fires immediately after (carries the
  // close-result), only when `getResult` is provided by the consumer
  // — it's the result-bearing layer that knows the result. No-op
  // when `getResult` is omitted (direct `<TugSheetContent>` users
  // that don't track results).
  const prevMountedRef = useRef(false);
  useLayoutEffect(() => {
    if (prevMountedRef.current && !mounted) {
      if (cardIdForLifecycle !== null && sheetLifecycle !== null) {
        sheetLifecycle.notifySheetDidHide(cardIdForLifecycle);
        if (getResult !== undefined) {
          sheetLifecycle.notifySheetDidReturnResult(
            cardIdForLifecycle,
            getResult(),
          );
        }
      }
    }
    prevMountedRef.current = mounted;
  }, [mounted, cardIdForLifecycle, sheetLifecycle, getResult]);

  // Enter animation: runs after mount when open && mounted (DOM is present).
  // The scrim animates separately via the pane's CSS transition (driven
  // by the `data-scrim` attribute toggled in the show/hide effect below).
  // Both transitions use `--tug-motion-duration-moderate`, so they finish
  // visually together without explicit synchronization. [L13, D18]
  //
  // `paneFrameEl` is a dependency for a specific reason: the panel's *visible*
  // state is held imperatively by this WAAPI animation (the CSS resting state
  // for every presentation is the pre-enter / hidden geometry — opacity 0 for
  // `scale-fade`, off-screen for `top`/`bottom` — so the panel is invisible
  // until this runs). When the host card is re-hosted into another pane (e.g.
  // dragged onto its tab bar), `createPortal`'s target changes and React
  // rebuilds the panel node in the new frame; the rebuilt node has lost the
  // animation that was holding it visible and would otherwise snap back to its
  // hidden resting state. Re-running the entrance on the recreated node
  // (keyed on the new `paneFrameEl`) re-establishes the shown state so the
  // sheet survives the move instead of vanishing. The sheet stays open and
  // usable in its new pane; its modality (scrim + `inert`) and geometry
  // re-bind via their own `paneFrameEl`-keyed effects. ([D15] pane-modal.)
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const contentEl = sheetContentRef.current;
    if (!contentEl) return;

    const g = group({ duration: "--tug-motion-duration-moderate" });
    const isShade = presentation === "shade";
    const motion =
      isShade && shadeAnchor === "bottom"
        ? SHADE_BOTTOM_MOTION
        : SHEET_PRESENTATION_MOTION[presentation];
    // The shade fades from transparent to its resting alpha as it rolls; other
    // presentations use their keyframes as-is.
    const enterFrames = isShade
      ? withShadeOpacity(motion.enter, 0, readShadeAlpha(contentEl))
      : motion.enter;
    g.animate(contentEl, enterFrames, {
      key: "sheet-content",
      easing: "ease-out",
    });
    // The shade's own scrim dims in step with the roll (the pane scrim, used by
    // the other presentations, fades via its own CSS transition).
    if (isShade && shadeScrimRef.current) {
      g.animate(shadeScrimRef.current, [{ opacity: 0 }, { opacity: 1 }], {
        key: "shade-scrim",
        easing: "ease-out",
      });
    }
    // Fire `sheetDidShow` after the enter animation completes — the
    // sheet is fully presented and any subscriber that wants to
    // capture pre-modal state ("what was focused before this sheet
    // took over?") has its signal.
    g.finished.then(() => {
      if (cardIdForLifecycle !== null && sheetLifecycle !== null) {
        sheetLifecycle.notifySheetDidShow(cardIdForLifecycle);
      }
    }).catch(() => {
      // Animation interrupted (a rapid close-then-open or the sheet
      // unmounting during enter). The transition to "fully shown"
      // didn't complete; subscribers will hear about the next
      // transition (will-hide / did-hide) instead.
    });
  }, [open, mounted, cardIdForLifecycle, sheetLifecycle, presentation, shadeAnchor, paneFrameEl]);

  // Exit animation: runs when !open && mounted (DOM still present for animation).
  useLayoutEffect(() => {
    if (open || !mounted) return;
    const contentEl = sheetContentRef.current;
    if (!contentEl) {
      setMounted(false);
      return;
    }

    const g = group({ duration: "--tug-motion-duration-moderate" });
    const isShade = presentation === "shade";
    const motion =
      isShade && shadeAnchor === "bottom"
        ? SHADE_BOTTOM_MOTION
        : SHEET_PRESENTATION_MOTION[presentation];
    // The shade fades from its resting alpha to transparent as it rolls out, so
    // it dismisses as a fade rather than popping when the DOM unmounts.
    const exitFrames = isShade
      ? withShadeOpacity(motion.exit, readShadeAlpha(contentEl), 0)
      : motion.exit;
    g.animate(contentEl, exitFrames, {
      key: "sheet-content",
      easing: "ease-in",
    });
    // The scrim fades a beat before the roll finishes (`SHADE_SCRIM_EXIT_MS` <
    // moderate) and eases out fast — so the dimming reads as already gone the
    // instant the panel lands, not cut off at the end. The group still waits on
    // the (longer) roll before unmounting.
    if (isShade && shadeScrimRef.current) {
      g.animate(shadeScrimRef.current, [{ opacity: 1 }, { opacity: 0 }], {
        key: "shade-scrim",
        duration: SHADE_SCRIM_EXIT_MS,
        easing: "ease-out",
      });
    }
    g.finished.then(() => {
      setMounted(false);
    }).catch(() => {
      // Animation interrupted — unmount anyway to avoid stuck state.
      setMounted(false);
    });
  }, [open, mounted, presentation, shadeAnchor]);

  // Scrim show/hide: raise the host pane's built-in scrim while the
  // sheet is open. The cleanup return guarantees a balanced decrement
  // when the sheet closes (open transitions true→false) and on
  // unmount-while-open (e.g. cross-pane card move with sheet up). The
  // pane-scrim registry's ref-count handles overlapping consumers
  // (multiple sheets, future modal-class surfaces sharing the chrome).
  // No-op fallback when no TugPane ancestor is in scope. [D18]
  useLayoutEffect(() => {
    // The shade owns its own scrim element scoped to its slot ([P17]) —
    // raising the whole-pane scrim would dim the live prompt entry.
    if (!open || presentation === "shade") return;
    paneScrim.show();
    return () => paneScrim.hide();
  }, [open, paneScrim, presentation]);

  // Dev warning: aria-labelledby requires a target.
  if (process.env.NODE_ENV !== "production" && !title) {
    console.warn("[TugSheetContent] `title` prop is required for aria-labelledby.");
  }

  // Track trigger element for focus restoration on close.
  const triggerElRef = useRef<Element | null>(null);

  // Close-focus ownership ([engine-owns close-focus]). When the sheet is opened
  // from a keyboard key view (a focus-cycle / Tab stop, e.g. a Z4B chip during
  // cycling), the FOCUS engine owns close-focus: its mode-stack pop restores the
  // ring AND DOM focus to that stop. The sheet then defers — it does NOT refocus
  // its trigger on close (whose `focusin` would clobber the engine's restored
  // keyboard key view, dropping the ring). Decided once at open (in
  // `handleMountAutoFocus`, before the FocusScope steals focus), so it does not
  // depend on the order in which the engine pop and Radix's unmount-autofocus
  // run. A mouse-opened sheet has no keyboard key view → the trigger restore
  // below owns close-focus as before.
  const focusManager = useContext(FocusManagerContext);
  const engineOwnsCloseFocusRef = useRef(false);

  // No anchor applier: the panel's clip is positioned by pure CSS in
  // `tug-sheet.css` (`position: absolute` inside the pane frame). The
  // canvas-tier wrapper, scrim, ResizeObserver, MutationObserver, and
  // window-resize listener are gone — when the pane moves or resizes,
  // the panel follows via the frame's own layout. [D19]

  // Inertness management: `.tug-pane-body` is `inert` while the sheet is
  // open ([L03]/[L06]). The toggle is the shared `usePaneInert` primitive
  // (also used by `TugControlBar`); the trigger capture below stays here
  // because focus-restore-on-close is sheet-specific.
  // The `modalScopeSelector` narrows the inert region below the whole pane
  // body (the shade's transcript-only carve-out, [P17]).
  const paneBody = useMemo(
    () => cardEl?.querySelector(modalScopeSelector ?? ".tug-pane-body") ?? null,
    [cardEl, modalScopeSelector],
  );
  // Capture the focused element before the body becomes inert (setting
  // `inert` blurs focus into the body), so close can restore it. Declared
  // before `usePaneInert` so this layout effect runs first.
  useLayoutEffect(() => {
    if (open) triggerElRef.current = document.activeElement;
  }, [open]);
  usePaneInert(paneBody, open);

  function handleKeyDown(e: React.KeyboardEvent) {
    // Escape is owned by the engine's Escape ladder ([P02]) via the trap's
    // `onEscapeDismiss` (= `requestCancel`); the sheet no longer handles it here.
    // ⌘. stays the force-dismiss chord, chain-routed exactly as before (#non-goals).
    if (isCancelChordEvent(e)) {
      e.preventDefault();
      requestCancel();
    }
  }

  function handleMountAutoFocus(e: Event) {
    // Passive shade ([P17]): never claim focus on open — the composer below the
    // shade keeps the caret. Stop Radix from focusing the first tabbable.
    if (shadePassive) {
      e.preventDefault();
      return;
    }
    // Decide close-focus ownership now, before the FocusScope moves focus into
    // the sheet (which would change the key view): if a keyboard key view is
    // present, the engine owns the close-focus restore and the sheet defers.
    engineOwnsCloseFocusRef.current =
      focusManager !== null &&
      focusManager.keyView() !== null &&
      focusManager.keyViewIsKeyboard();
    if (onOpenAutoFocus) {
      onOpenAutoFocus(e);
    }
    // Default: allow FocusScope to focus first tabbable element (don't preventDefault).
  }

  function handleUnmountAutoFocus(e: Event) {
    // Passive shade ([P17]): the composer never lost focus, so there is nothing
    // to restore — leave the caret where it is and stop Radix's trigger refocus.
    if (shadePassive) {
      e.preventDefault();
      return;
    }
    // Relinquish disposition ([P15] generalized): the engine's
    // `relinquishFocusMode` (fired by the trap's pop) is the single close-focus
    // authority — it exits the enclosing cycle to its resting destination. The
    // sheet must NOT also restore the opener (the chip), or it would race that
    // landing. Stand down: prevent Radix's default and return without touching
    // focus.
    if (closeDispositionRef.current === "relinquish") {
      e.preventDefault();
      return;
    }
    // The focus engine owns close-focus for keyboard-opened sheets (see
    // `handleMountAutoFocus`): the mode-stack pop restored the engine key view
    // (the originating stop, e.g. a Z4B chip) + its ring. This unmount-autofocus
    // is the surface's authoritative last word on DOM focus, so move DOM focus
    // onto that key view here — `preventDefault` so Radix does not refocus the
    // trigger (whose `focusin` would clobber the keyboard key view), then
    // `focusKeyView()` to land focus on the stop even though Radix blurs the
    // unmounting content to `<body>` during teardown.
    if (engineOwnsCloseFocusRef.current) {
      engineOwnsCloseFocusRef.current = false;
      e.preventDefault();
      focusManager?.focusKeyView();
      return;
    }
    // Mouse-opened sheet: the trigger is (almost always) a button — an
    // engine-routed stop that no longer holds DOM focus. A raw trigger
    // `.focus()` here was a ledgered steal on every mouse-opened close;
    // instead, prevent Radix's own trigger refocus and land the keyboard
    // through the engine (a routed park, or a grant if a text surface owns
    // the restored key view). A trigger that IS a text control gets its
    // focus back through the same routed landing (its responder holds the
    // restored register).
    e.preventDefault();
    focusManager?.focusKeyView();
  }

  // ---- Shade height fraction ([P17], ported from TugShade) ----
  //
  // Persisted fraction via tugbank ([L02]); re-renders when any shade
  // sharing the key commits a new height. The drag writes the fraction
  // straight onto the panel's `--tug-shade-frac` custom property ([L06] —
  // zero re-renders while dragging); release persists.
  const getShadeFracSnapshot = useCallback(
    () => (persistKey !== undefined ? readPersistedShadeFrac(persistKey) : null),
    [persistKey],
  );
  const persistedShadeFrac = useSyncExternalStore(
    subscribeShadeHeightDomain,
    getShadeFracSnapshot,
  );
  const shadeFrac = persistedShadeFrac ?? DEFAULT_SHADE_FRAC;

  const handleShadeGrabberPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || persistKey === undefined) return;
      const root = sheetContentRef.current;
      // The shade's containing block is its positioned wrapper (the
      // consumer's slot pane) — the box the height fraction resolves
      // against.
      const slot = root?.offsetParent ?? null;
      if (root === null || slot === null) return;
      event.preventDefault();
      const grabber = event.currentTarget;
      grabber.setPointerCapture(event.pointerId);
      const slotRect = slot.getBoundingClientRect();
      if (slotRect.height <= 0) return;
      let liveFrac = shadeFrac;

      const onMove = (move: PointerEvent): void => {
        liveFrac = clampShadeFrac((move.clientY - slotRect.top) / slotRect.height);
        root.style.setProperty("--tug-shade-frac", String(liveFrac));
      };
      const onUp = (): void => {
        grabber.removeEventListener("pointermove", onMove);
        grabber.removeEventListener("pointerup", onUp);
        grabber.removeEventListener("pointercancel", onUp);
        writePersistedShadeFrac(persistKey, liveFrac);
      };
      grabber.addEventListener("pointermove", onMove);
      grabber.addEventListener("pointerup", onUp);
      grabber.addEventListener("pointercancel", onUp);
    },
    [persistKey, shadeFrac],
  );

  if (!mounted) return null;

  // ---- Shade presentation ([P17]) — rendered in place, no portal ----
  //
  // The consumer mounts this inside a positioned wrapper over the region
  // the shade covers (the Session card's view slot pane). The scrim fills
  // that wrapper only, and `modalScopeSelector` narrows the inert region
  // to match — everything outside (the prompt entry) stays live. The
  // modal machinery is the sheet's own: focus trap, chain-native
  // `cancelDialog` close (Escape / Cmd-.), lifecycle events.
  if (presentation === "shade") {
    return (
      <TugSheetStackingContext.Provider value={true}>
        <div
          ref={shadeScrimRef}
          className="tug-sheet-shade-scrim"
          data-slot="tug-sheet-shade-scrim"
        />
        <FocusScopeRadix.FocusScope
          trapped={false}
          loop
          onMountAutoFocus={handleMountAutoFocus}
          onUnmountAutoFocus={handleUnmountAutoFocus}
        >
          <div
            ref={composedContentRef}
            id={contentId}
            className="tug-sheet-shade"
            role="dialog"
            aria-label={title}
            aria-describedby={description ? descriptionId : undefined}
            data-slot="tug-sheet"
            data-tug-sheet-presentation="shade"
            data-shade-anchor={shadeAnchor}
            data-autosize={shadeAutoSize ? "true" : undefined}
            style={{
              ["--tug-shade-frac" as string]: String(shadeFrac),
              // Auto-size hugs its content; the fixed floor (which keeps the
              // grabber reachable in drag mode) does not apply.
              ...(shadeAutoSize ? {} : { minHeight: `${shadeMinHeight}px` }),
            }}
            onKeyDown={handleKeyDown}
            onMouseDown={suppressButtonFocusShift}
          >
            <ResponderScope>
              {/* The consumer owns the shade's chrome (its BlockStrip
                  header row) and content — the panel is a flex column;
                  the grabber is the only chrome this presentation adds. */}
              <div className="tug-sheet-shade-body">
                <FocusModeScope>{children}</FocusModeScope>
              </div>
            </ResponderScope>
            {/* The drag grabber is dropped in auto-size mode (the content owns
                the height) and when a consumer opts out via `shadeGrabber`
                (a plain, non-resizable shade). */}
            {!shadeAutoSize && shadeGrabber ? (
              <div
                className="tug-sheet-shade-grabber"
                role="separator"
                aria-orientation="horizontal"
                aria-label={grabberLabel}
                data-tug-focus="refuse"
                data-no-activate=""
                onPointerDown={handleShadeGrabberPointerDown}
              >
                <div className="tug-sheet-shade-grabber-handle" />
              </div>
            ) : null}
          </div>
        </FocusScopeRadix.FocusScope>
      </TugSheetStackingContext.Provider>
    );
  }

  return createPortal(
    // Single clip element positioned by CSS inside the pane frame.
    // `overflow: hidden` clips the panel during the
    // `translateY(-100%) → 0` enter animation; `pointer-events: none`
    // makes the empty clip area pass clicks through to the (inert)
    // pane body, while the panel itself absorbs interaction via
    // `pointer-events: auto`. The clip extends below the chrome so
    // a tall panel can paint into the canvas grid without being
    // clipped by the chrome's overflow:hidden.
    <TugSheetStackingContext.Provider value={true}>
      <div
        className="tug-sheet-clip"
        ref={clipRef}
        data-vertical-anchor={bottomAnchorEl !== null ? "bottom" : undefined}
      >
        {/* A sheet is PANE-modal, never app-modal: its modality must not leak
            to other panes ([D15], pane-model). Same-pane modality is enforced
            by `inert` on this pane's `.tug-pane-body` (the card behind is
            unfocusable) — scoped to this pane only. `loop` contains Tab/Shift-Tab
            within the sheet at its ends. We deliberately do NOT set `trapped`:
            Radix's `trapped` installs a DOCUMENT-GLOBAL focusin redirect that
            yanks focus back from anywhere — including OTHER panes — so a sheet
            open in one pane would block focusing a card in another. `loop` +
            `inert` give full pane-modal containment without that leak. */}
        <FocusScopeRadix.FocusScope
          trapped={false}
          loop
          onMountAutoFocus={handleMountAutoFocus}
          onUnmountAutoFocus={handleUnmountAutoFocus}
        >
          <div
            ref={composedContentRef}
            id={contentId}
            className="tug-sheet-content"
            role="dialog"
            aria-labelledby={hideHeader ? undefined : titleId}
            aria-label={hideHeader ? title : undefined}
            aria-describedby={description ? descriptionId : undefined}
            data-slot="tug-sheet"
            data-tug-sheet-presentation={presentation}
            data-display-width={displayWidth}
            data-resizable={resizable ? "true" : undefined}
            data-aspect-lock={aspectLockContent ? "true" : undefined}
            onKeyDown={handleKeyDown}
            onMouseDown={suppressButtonFocusShift}
          >
            <ResponderScope>
              {/* Sheet header: an optional role-colored icon left of the
                  title + description (the TugAlert header layout). No close
                  button — sheets dismiss via Cancel/Escape. Suppressed when
                  `hideHeader` (e.g. TugAlertSheet owns the panel); the title
                  still labels the dialog via aria-label above. */}
              {!hideHeader && (
                <div
                  className={
                    hideHeaderRule
                      ? "tug-sheet-header tug-sheet-header-no-rule"
                      : "tug-sheet-header"
                  }
                  data-icon-role={icon ? iconRole : undefined}
                  data-has-description={description ? "true" : undefined}
                >
                  {IconComponent && (
                    <div className="tug-sheet-icon" aria-hidden="true">
                      {/* The icon box owns the size (one-line vs two-line
                          header, see tugx-header.css); the svg fills it. */}
                      <IconComponent size="100%" />
                    </div>
                  )}
                  <div className="tug-sheet-heading">
                    <h2 id={titleId} className="tug-sheet-title">{title}</h2>
                    {description && (
                      <p id={descriptionId} className="tug-sheet-description">
                        {description}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Headerless sheets (e.g. TugAlertSheet) still expose their
                  description for aria-describedby and reading order. */}
              {hideHeader && description && (
                <p id={descriptionId} className="tug-sheet-description">{description}</p>
              )}

              {/* Sheet body: arbitrary content. Wrapped in the trap's focus
                  mode so focusables inside join this sheet's mode. */}
              <div className="tug-sheet-body">
                <FocusModeScope>{children}</FocusModeScope>
              </div>
            </ResponderScope>

            {/* Drag-resize handles (pane-style edge/corner strips). Absolutely
                positioned, so they sit outside the flex flow. `data-tug-focus="refuse"`
                keeps a resize drag from coarsening the key view onto the sheet box
                — the seeded default button (e.g. Done) keeps its ring + filled
                promotion across a resize. */}
            {resizable &&
              SHEET_RESIZE_EDGES
                // Aspect-locked resize is width-driven (height follows the
                // aspect), so the pure-south handle — which only changes
                // height — is dropped; the east/west edges and corners remain.
                .filter((edge) => !(aspectLockContent && edge === "s"))
                .map((edge) => (
                  <div
                    key={edge}
                    className={`tug-sheet-resize tug-sheet-resize-${edge}`}
                    data-edge={edge}
                    data-tug-focus="refuse"
                    onPointerDown={onResizePointerDown(edge)}
                    onPointerMove={onResizePointerMove}
                    onPointerUp={onResizePointerUp}
                  />
                ))}
          </div>
        </FocusScopeRadix.FocusScope>
      </div>
    </TugSheetStackingContext.Provider>,
    paneFrameEl ?? document.body,
  );
}

/* ---------------------------------------------------------------------------
 * useTugSheetClose — consumer-facing close hook
 * ---------------------------------------------------------------------------*/

/**
 * Returns a stable `close()` function that dismisses the nearest
 * ancestor `<TugSheet>`. Intended for Cancel / Save / Apply buttons
 * inside a sheet's content — they call `close()` on click and the sheet
 * closes via the chain-native path (`sendToTarget` at the sheet's
 * responder id, which routes to the sheet's own `cancelDialog` handler).
 *
 * Must be called from a component rendered inside a `<TugSheet>` — the
 * hook reads the enclosing sheet's responder id from `TugSheetContext`.
 * Outside a TugSheet the returned function is a no-op (with a dev
 * warning) so standalone previews / tests can render the same button
 * components without crashing.
 *
 * Outside a `ResponderChainProvider` the function falls back to
 * `onOpenChange(false)` on the sheet context, matching the
 * no-provider fallbacks elsewhere in the sheet.
 */
export function useTugSheetClose(): () => void {
  const ctx = useContext(TugSheetContext);
  const manager = useResponderChain();
  const fallbackSenderId = useId();

  return useCallback(() => {
    if (!ctx) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[useTugSheetClose] called outside <TugSheet>. No-op.",
        );
      }
      return;
    }
    if (manager) {
      manager.sendToTarget(ctx.responderId, {
        action: TUG_ACTIONS.CANCEL_DIALOG,
        sender: fallbackSenderId,
        phase: "discrete",
      });
    } else {
      ctx.onOpenChange(false);
    }
  }, [ctx, manager, fallbackSenderId]);
}

/* ---------------------------------------------------------------------------
 * useTugSheet — imperative hook
 * ---------------------------------------------------------------------------*/

/**
 * Options for showSheet() returned by useTugSheet().
 */
export interface ShowSheetOptions {
  /** Sheet title (required — wired to aria-labelledby). */
  title: string;
  /**
   * Optional Lucide icon name (PascalCase) shown left of the title — the
   * TugAlert header layout. See {@link TugSheetContentProps.icon}.
   */
  icon?: string;
  /**
   * Color role for {@link icon}. Defaults to `"muted"`; pass `"agent"` for the
   * Z4B picker sheets. See {@link TugSheetIconRole}.
   */
  iconRole?: TugSheetIconRole;
  /** Optional description (wired to aria-describedby). */
  description?: string;
  /**
   * Content render function. Receives a `close` callback.
   * Call close(result?) to dismiss the sheet and resolve the promise.
   */
  content: (close: (result?: string) => void) => React.ReactNode;
  /** Override initial focus target. */
  onOpenAutoFocus?: (event: Event) => void;
  /**
   * Visual entrance/exit style. Forwarded to the rendered
   * `TugSheetContent`. Defaults to `"scale-fade"`. See
   * {@link TugSheetPresentation}.
   */
  presentation?: TugSheetPresentation;
  /**
   * Resting width of the panel within the host pane. Defaults to `"sm"`.
   * See {@link TugSheetDisplayWidth}.
   */
  displayWidth?: TugSheetDisplayWidth;
  /**
   * When `true`, the sheet can be drag-resized by the user (a grab handle
   * at the bottom-right corner; native CSS `resize`, so the browser owns
   * the geometry and no React state is involved — [L06]). The chosen
   * `displayWidth` is the starting size; dragging overrides it for the
   * life of the open sheet. Defaults to `false`.
   */
  resizable?: boolean;
  /**
   * Cap the panel to this fraction (0–1) of the host card's box on both
   * axes (e.g. `0.9` for the image preview). Re-measured on resize and
   * overrides the {@link displayWidth} width cap and the viewport height
   * clamp. Width nesting comes free from `--tugx-sheet-gutter`; reach for
   * this only when the HEIGHT needs capping too, or when a sheet needs a
   * tighter width than its tier. See
   * {@link TugSheetContentProps.maxHostFraction}.
   */
  maxHostFraction?: number;
  /**
   * Lock the panel to an aspect-ratio'd body region (marked
   * `data-tug-aspect-region`) so its margin stays uniform at every size and
   * drag-resize is width-only (height follows the aspect). Requires
   * `resizable`; pairs with {@link maxHostFraction} for the size cap. See
   * {@link TugSheetContentProps.aspectLockContent}.
   */
  aspectLockContent?: boolean;
  /**
   * Suppress the sheet's title-bar header (the `<h2>` + divider). The
   * content then owns the whole panel — used by `TugAlertSheet`, which
   * renders its own icon + title layout. `title` is still required and is
   * wired to the dialog's `aria-label` for accessibility. Defaults to
   * `false`.
   */
  hideHeader?: boolean;
  /**
   * Keep the title but drop the divider rule beneath it (and its extra
   * spacing), so the title reads as part of a compact body. Unlike
   * {@link hideHeader} the title row still renders. Defaults to `false`.
   */
  hideHeaderRule?: boolean;
  /**
   * Cascade-target responder id captured at sheet-open time.
   *
   * Per `tugplan-dev-overlay-framework.md` [D02]
   * (#sheet-cascade-rationale), modal surfaces that need a follow-up
   * chain dispatch on close (e.g., dispatching `CLOSE` to dismiss the
   * host card after a picker cancel) capture the dispatch's target
   * id at open time rather than relying on `firstResponderId` at
   * close time. First-responder state is the product of multiple
   * racing inputs (registration order, focus events, FocusScope
   * mount/unmount, unregister fallback) and is fragile after a
   * portaled modal closes — using it as the cascade dispatch target
   * is a known bug class.
   *
   * The hook stores this value on its internal state for parity with
   * the other `ShowSheetOptions` fields. It does not itself dispatch
   * with the value: per [D02], the canonical pattern is for the
   * consumer to capture the id in the same closure where they call
   * `showSheet`, then read it from that closure inside their
   * `onClosed` callback and dispatch via
   * `manager.sendToTarget(cascadeTargetId, ...)`. The value travels
   * with the rest of the options for the lifetime of the open sheet
   * (and through the exit animation, since hook state is preserved
   * until the next `showSheet()` call).
   *
   * Optional — sheets without a cascade need (most pickers, settings
   * dialogs that don't dismiss their host card) leave it undefined.
   */
  cascadeTargetId?: string;
  /**
   * Disposition toward an enclosing focus cycle when this sheet is opened from a
   * cycle stop and **commits** a value ([P15] generalized to sub-surfaces). Only
   * a committed close (the `close(result)` promise resolves with a value) honors
   * it; a cancel always retains. Default `"retain"`.
   *
   *  - `"retain"`: the cycle stays on and the ring returns to the originating
   *    stop (the chip) — the user can keep cycling.
   *  - `"relinquish"`: the cycle exits and focus returns to its resting
   *    destination (the prompt caret).
   *
   * No-op when the sheet is not opened from within a cycle.
   */
  onCommitDisposition?: "retain" | "relinquish";
  /**
   * Bottom-anchor the panel above the named element instead of dropping it from
   * the pane title bar — the Z4B pickers' placement above the Session card's Z2
   * status bar. See {@link TugSheetContentProps.bottomAnchorSelector}.
   */
  bottomAnchorSelector?: string;
  /**
   * Present this sheet as the cover of a **run**: it takes the host card's
   * modal hold while it stands, so a later `showSheet` on this host is refused
   * rather than superseding it, and Escape / ⌘. report the run's refusal
   * instead of dismissing. The `close(result)` callback handed to
   * {@link content} is unaffected — it is how the run dismisses its own sheet.
   * See {@link SheetExclusivity}.
   */
  exclusive?: SheetExclusivity;
}

interface UseTugSheetState {
  options: ShowSheetOptions;
  resolve: (result: string | undefined) => void;
  /**
   * Monotonic id incremented per `showSheet()` call. Used as the
   * React `key` on the rendered <TugSheet> so each new call mounts a
   * fresh component instance, letting `defaultOpen` re-fire and the
   * enter animation replay cleanly.
   */
  callId: number;
}

/**
 * useTugSheet — imperative Promise-based sheet hook.
 *
 * Returns `{ showSheet, renderSheet }`:
 * - `showSheet(options)` opens a sheet and returns a Promise that resolves
 *   when the sheet is closed (via the `close` callback, Escape, or Cmd+.).
 * - `renderSheet()` must be called once in the component's JSX to render
 *   the sheet portal. Returns null when no sheet is open.
 *
 * Must be called from within a TugPane (requires TugPanePortalContext).
 *
 * ## State machine
 *
 * The hook juggles five pieces of state (`state`, `resolverRef`,
 * `callIdRef`, the mounted `<TugSheet>` instance, and the chain's
 * `observeDispatch` subscription) across four transition paths. The
 * tricky invariant is that the exit animation must play on close,
 * which requires the `<TugSheet>` to stay mounted across the
 * unmount-decision boundary. The diagram below traces each path.
 *
 * ```
 *                     ┌─────────────────┐
 *                     │      idle       │
 *                     │ state = null    │
 *                     │ resolverRef:0   │
 *                     └────────┬────────┘
 *                              │
 *               showSheet() ───┤  callIdRef++, setState({options, callId})
 *                              ▼
 *   ┌──────────────────────────────────────────────────┐
 *   │                     open                        │
 *   │  state = {options, resolve, callId}              │
 *   │  resolverRef = resolve  ← promise pending        │
 *   │  <TugSheet key={callId} defaultOpen> mounted     │
 *   │  observeDispatch subscription active             │
 *   └────────────┬─────────────────────────┬───────────┘
 *                │                         │
 *     close(r) ──┤            chain────────┤  Escape / Cmd+.
 *                │         cancelDialog    │  dispatches cancelDialog
 *                │       (from any source) │  with sender=this hook's id
 *                ▼                         ▼
 *   ┌────────────────────────┐  ┌────────────────────────┐
 *   │ resolveHook(r):        │  │ observer fires:        │
 *   │   resolver?(r); ref=0  │  │   if resolverRef≠null  │
 *   │ then dispatch          │  │   resolveHook(undef)   │
 *   │   cancelDialog         │  └───────────┬────────────┘
 *   │   (sender=hook id)     │              │
 *   └───────────┬────────────┘              │
 *               │                           │
 *               ▼                           ▼
 *   ┌──────────────────────────────────────────────────┐
 *   │               closing (exit animation)          │
 *   │  state = {…same…, callId unchanged}              │
 *   │  resolverRef = null  ← promise already resolved  │
 *   │  <TugSheet> internal open=false, animating out   │
 *   │  observer is still mounted but guarded on        │
 *   │    resolverRef === null → no-op                  │
 *   └────────────────┬─────────────────────────────────┘
 *                    │
 *      showSheet() ──┤  callIdRef++
 *                    │  setState → new callId → new key
 *                    ▼
 *                  (back to "open" with a fresh <TugSheet>;
 *                   the old one unmounts, the new one's
 *                   defaultOpen fires and enter animation plays)
 * ```
 *
 * ### Load-bearing ordering rules
 *
 * - `close(r)` **must** null `resolverRef` before dispatching
 *   `cancelDialog`. The dispatch re-enters the observer subscription,
 *   which would otherwise see the still-set resolver and call
 *   `resolveHook(undefined)` — double-resolving the promise with a
 *   wrong result.
 *
 * - The hook deliberately does **not** clear `state` on close. The
 *   old `<TugSheet>` stays mounted, animating out internally, until
 *   the next `showSheet()` call swaps it for a fresh instance via
 *   `key={callId}`. Clearing state would unmount the sheet mid-
 *   animation and skip the exit.
 *
 * - `callIdRef++` before `setState` ensures each `showSheet()` gets
 *   a unique React key, forcing remount instead of reuse. Without
 *   this, a rapid `close() → showSheet()` sequence would try to
 *   "reopen" the same instance whose `defaultOpen` has already
 *   fired once.
 *
 * ## Cascade-target pattern (modal close → follow-up chain dispatch)
 *
 * When a sheet's consumer needs to dispatch a follow-up action
 * through the responder chain — for example, the Dev picker
 * canceling and dismissing its host card — it must capture the
 * cascade dispatch's target id at sheet-open time, not at close time.
 * Per `tugplan-dev-overlay-framework.md` [D02]
 * (#sheet-cascade-rationale), `firstResponderId` at close time is
 * fragile (it settles via the unregister fallback after FocusScope
 * unmount, focusin handlers, etc.) and using
 * `manager.sendToFirstResponder(...)` from a close handler is a
 * known bug class.
 *
 * The canonical pattern subscribes to the sheet's
 * `sheetDidReturnResult` lifecycle event (per
 * `lib/sheet-lifecycle.ts`) — fires after the exit animation
 * completes and carries the close-result. The consumer's own
 * closure holds the captured cascade target id, so the dispatch is
 * robust regardless of focus settling:
 *
 * ```ts
 * const senderId = useId();
 * const presentSheet = useCallback(() => {
 *   void showSheet({
 *     title: "Open Project",
 *     content: (close) => (...),
 *     cascadeTargetId: hostStackId,         // stored on hook state
 *   });
 * }, [showSheet, hostStackId]);
 *
 * useSheetDelegate(cardId, {
 *   sheetDidReturnResult: (_id, result) => {
 *     if (result === "open") return;        // user did the thing
 *     manager?.sendToTarget(hostStackId, {  // captured in closure
 *       action: TUG_ACTIONS.CLOSE,
 *       sender: senderId,
 *       phase: "discrete",
 *     });
 *   },
 * });
 * ```
 *
 * The hook stores `cascadeTargetId` on its active state for parity
 * with the other `ShowSheetOptions` fields; `useTugSheet` itself does
 * NOT dispatch with the value. The consumer's own closure is where
 * the id lives — that's why the pattern is robust regardless of
 * focus settling. See [D02] for the rationale and (#mental-model)
 * for the broader five-subsystem architecture this pattern lives in.
 *
 * ## Example
 *
 * @example
 * ```tsx
 * function MyCardContent() {
 *   const { showSheet, renderSheet } = useTugSheet();
 *   return (
 *     <>
 *       <TugPushButton onClick={async () => {
 *         const result = await showSheet({
 *           title: "Settings",
 *           content: (close) => (
 *             <>
 *               <form>...</form>
 *               <div className="tug-sheet-actions">
 *                 <TugPushButton onClick={() => close()}>Cancel</TugPushButton>
 *                 <TugPushButton onClick={() => close("save")}>Save</TugPushButton>
 *               </div>
 *             </>
 *           ),
 *         });
 *         if (result === "save") { ... }
 *       }}>Open Settings</TugPushButton>
 *       {renderSheet()}
 *     </>
 *   );
 * }
 * ```
 */
export function useTugSheet(): {
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
  renderSheet: () => React.ReactNode;
} {
  // TugPanePortalContext is consumed downstream by TugSheetContent,
  // which returns null when the portal target isn't attached yet. A
  // dev-time "you're outside a TugPane" warning here fires on every
  // first render of a card body (TugPane populates `cardEl` via a
  // `useState` ref callback that commits one render after mount), so
  // we rely on the defensive null handling in TugSheetContent and
  // skip the warning.

  // State tracks the current active sheet's options plus a monotonically
  // increasing callId. The callId is used as the React `key` on the
  // rendered <TugSheet> so each `showSheet()` call mounts a fresh
  // component instance: defaultOpen fires on the new mount, the enter
  // animation plays, and the previous sheet's React subtree is cleanly
  // replaced (rather than re-used, which would skip defaultOpen and
  // prevent a mid-animation interrupt from re-opening cleanly).
  const [state, setState] = useState<UseTugSheetState | null>(null);
  const callIdRef = useRef(0);
  const resolverRef = useRef<((result: string | undefined) => void) | null>(null);
  // The last value passed to `close(result)` on the currently active
  // sheet, captured so `options.onClosed` can receive it after the
  // exit animation completes. Reset to undefined on every new
  // `showSheet()` call; set explicitly by the `close` callback handed
  // to the consumer's content render function. Escape / Cmd+. paths
  // leave it at its reset value (undefined), matching the "no explicit
  // result" semantics of a keyboard dismissal.
  const lastResultRef = useRef<string | undefined>(undefined);
  const manager = useResponderChain();

  // The card this host stands in, held in a ref because `showSheet` is a
  // stable callback that must read the CURRENT card at call time ([L07]).
  // `null` outside a card host, where no hold can exist and nothing is refused.
  const hostCardId = useContext(CardIdContext);
  const hostCardIdRef = useRef<string | null>(hostCardId);
  hostCardIdRef.current = hostCardId;

  // Stable senderId scoped to this hook call. Passed down to the
  // TugSheetContent rendered by `renderSheet`, and used as the filter
  // key for the observeDispatch subscription below so the hook only
  // reacts to its own sheet's chain-driven dismissals.
  const senderId = useId();

  // Stable responder id the hook's <TugSheet> registers under. Held
  // here so the close callback can dispatch `cancelDialog` via
  // `sendToTarget(responderId, ...)` — a first-responder walk is
  // unsafe because the sheet may not be first responder at close time
  // (e.g., after the user focused another card and returned).
  const responderId = useId();

  // Resolve the pending promise without touching the hook's local
  // state. Used by both the explicit `close(result)` callback and the
  // observeDispatch subscription for Escape / Cmd+. dismissal. We
  // deliberately do NOT clear `state` here — that would unmount the
  // <TugSheet> immediately and interrupt its exit animation. The old
  // sheet stays mounted in the React tree, internally animating out;
  // on the next `showSheet()` call, a new callId forces a remount via
  // `key` and the stale sheet is replaced.
  const resolveHook = useCallback((result: string | undefined) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
  }, []);

  // While a hook-rendered sheet is mounted, observe the chain for a
  // cancelDialog dispatch carrying this hook's senderId. This catches
  // the Escape / Cmd+. path: the sheet's own handler fires first and
  // closes internal state (triggering the exit animation), then this
  // observer runs and resolves the pending promise with undefined.
  //
  // Explicit consumer-driven closes via the `close(result)` callback
  // null `resolverRef` BEFORE dispatching cancelDialog, so the observer
  // sees `null` and skips its resolve path — the explicit close's
  // `resolveHook(result)` has already happened.
  useLayoutEffect(() => {
    if (!state || !manager) return;
    return manager.observeDispatch((event) => {
      if (event.action !== "cancel-dialog") return;
      if (event.sender !== senderId) return;
      if (resolverRef.current === null) return;
      resolveHook(undefined);
    });
  }, [state, manager, senderId, resolveHook]);

  const showSheet = useCallback((options: ShowSheetOptions): Promise<string | undefined> => {
    // A card held by a run does not take a second sheet. This host is the one
    // every sheet on the card shares, so without the check `/usage` would not
    // open OVER a compaction sheet — it would REPLACE it, and dismissing the
    // usage sheet would leave the card looking like the run had been dismissed
    // too. Resolve rather than reject: `undefined` is the value every
    // non-committing close already yields, so a caller awaiting the result
    // reads a refusal the same way it reads an Escape, and nothing hangs. The
    // holder speaks the reason ([L31]).
    if (refuseCardModalHold(hostCardIdRef.current)) {
      return Promise.resolve(undefined);
    }
    // A showSheet() while a prior sheet is still pending supersedes it.
    // Resolve the superseded promise with `undefined` (the same "no
    // explicit result" value an Escape dismissal yields) before adopting
    // the new resolver — orphaning it would leave its awaiter hung forever,
    // wedging any caller that gates on the promise (e.g. a card close
    // guard whose sheet is replaced by a conflict sheet mid-decision).
    resolverRef.current?.(undefined);
    return new Promise<string | undefined>((resolve) => {
      resolverRef.current = resolve;
      lastResultRef.current = undefined;
      callIdRef.current += 1;
      setState({ options, resolve, callId: callIdRef.current });
    });
  }, []);

  const renderSheet = useCallback((): React.ReactNode => {
    if (!state) return null;

    const { options, callId } = state;

    // close(result) — the callback handed to consumer content. Resolve
    // the pending promise immediately (so `await showSheet(...)` yields
    // the result the user just picked), then dispatch cancelDialog
    // through the chain. The sheet's own cancelDialog handler catches
    // it and flips internal open state false, triggering the exit
    // animation. Nulling resolverRef before the dispatch is load-
    // bearing: the observeDispatch subscription above is guarded on
    // resolverRef being non-null, so it will no-op for this dispatch
    // and not try to resolve the promise a second time.
    //
    // No-provider fallback: without a chain manager the dispatch path
    // is unavailable, so we fall back to the pre-migration behavior
    // of clearing hook state synchronously. This unmounts the sheet
    // without an exit animation — acceptable for tests and isolated
    // previews that don't mount a ResponderChainProvider.
    const close = (result?: string) => {
      lastResultRef.current = result;
      resolveHook(result);
      if (manager) {
        manager.sendToTarget(responderId, {
          action: TUG_ACTIONS.CANCEL_DIALOG,
          sender: senderId,
          // The token an exclusive sheet's responder requires. This callback is
          // the run's own door — the one the sheet's content was handed — and
          // it is the only dismissal that carries it.
          value: SHEET_SETTLED_DISMISS,
          phase: "discrete",
        });
      } else {
        setState(null);
      }
    };

    // Surface the close-result to TugSheetContent's didReturnResult
    // emitter. `getResult` is read at the moment the sheet's
    // `mounted` flips false (post exit animation, post inert clear)
    // and the resulting `notifySheetDidReturnResult(cardId, result)`
    // event reaches subscribers via `useSheetDelegate({ sheetDidReturnResult })`.
    // Reads `lastResultRef.current` — set by `close(result)` above
    // or left at its showSheet-reset `undefined` for Escape /
    // Cmd+. dismissals.
    const getResultForContent = (): string | undefined =>
      lastResultRef.current;

    return (
      <TugSheet key={callId} defaultOpen responderId={responderId}>
        <TugSheetContent
          title={options.title}
          icon={options.icon}
          iconRole={options.iconRole}
          description={options.description}
          onOpenAutoFocus={options.onOpenAutoFocus}
          getResult={getResultForContent}
          senderId={senderId}
          presentation={options.presentation}
          displayWidth={options.displayWidth}
          resizable={options.resizable}
          maxHostFraction={options.maxHostFraction}
          aspectLockContent={options.aspectLockContent}
          hideHeader={options.hideHeader}
          hideHeaderRule={options.hideHeaderRule}
          exclusive={options.exclusive}
          onCommitDisposition={options.onCommitDisposition}
          bottomAnchorSelector={options.bottomAnchorSelector}
        >
          {options.content(close)}
        </TugSheetContent>
      </TugSheet>
    );
  }, [state, senderId, responderId, resolveHook, manager]);

  return { showSheet, renderSheet };
}
