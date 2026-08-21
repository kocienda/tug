/**
 * TugButton — internal button infrastructure for tugways.
 *
 * Building block composed by TugPushButton, TugPopupButton, and TugTabBar.
 * App code should use TugPushButton for standalone action buttons.
 *
 * Laws: [L06] appearance via CSS, [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide
 * Decisions: [D02] emphasis x role system
 */

import "./tug-button.css";

import React, { useContext, useSyncExternalStore } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import { useResponderChain } from "../responder-chain-provider";
import type { TugAction } from "../action-vocabulary";
import { useTugBoxDisabled } from "./tug-box-context";
import { useControlDispatch } from "../use-control-dispatch";
import { ResponderParentContext } from "../responder-chain";
import { useFocusable, useFocusManager } from "../use-focusable";
import type { FocusPolicy } from "../focus-manager";
import { CardIdContext } from "@/lib/card-id-context";
import { TugStableOverlay } from "./tug-stable-overlay";
import { TugPopupMenuTriggerContext } from "./tug-popup-menu";

// ---- No-op constants for useSyncExternalStore when chain is inactive ----
// Module-level stable references prevent React from seeing new function
// identities and triggering unnecessary re-subscriptions.

const NOOP_SUBSCRIBE = (_cb: () => void): (() => void) => () => {};
const NOOP_SNAPSHOT = (): number => 0;

// ---- Confirmation defaults ----
//
// Default dwell time for the confirmation feedback state. Long enough that
// a glance-and-look-away user catches the swap (the "✔ Copied" idiom on the
// web converges on ~1.5–2s); short enough that re-clicks aren't blocked
// for a noticeable beat. Override per call site via `confirmation.duration`.
const DEFAULT_CONFIRMATION_DURATION_MS = 1500;


// ---- Types ----

/**
 * TugButton emphasis values — controls visual weight [D02].
 *
 * `tinted` is the display-leaning emphasis shared with TugBadge: a faint
 * role-tinted wash behind role-colored text (the session-card status-chip look),
 * for buttons that should read as a quiet chip rather than a solid call to
 * action. It reuses TugBadge's `tinted` tokens directly and is static across
 * rest/hover/active — the mirror image of TugBadge's `filled` reusing the
 * control tokens. See the tinted section in `tug-button.css`.
 *
 * `primary` is the *recommended-default* emphasis for the commit button of a
 * multi-control surface (a sheet / dialog / alert's "Open", "Save", "Confirm").
 * It encodes the focus-language prominence hierarchy: solid fill is reserved
 * for *selection* and the *live* (keyboard) control, so a primary button rests
 * at the quiet `tinted` wash (its standing "Return's home" identity) and
 * **promotes to the solid `filled` look + role ring** when it is engaged —
 * hovered, or holding the keyboard key view. This stops an idle default button
 * from impersonating a selected item (both were solid blue before). Like
 * `filled` + `action`, a `primary` + `action` button registers as the scope's
 * default (Return target).
 *
 * The resting look is the **badge treatment, deliberately**: `primary` rest
 * reuses the same `tinted` tokens as `TugBadge`, so a recommended-default at
 * rest reads as a labeled chip / marker rather than a pressed control. That
 * linkage is enshrined ([P14]) — keep `primary`-at-rest and `TugBadge tinted`
 * as one visual language. See the primary section in `tug-button.css`.
 */
export type TugButtonEmphasis = "filled" | "outlined" | "ghost" | "tinted" | "primary";

/** TugButton role values — controls color domain [D02] */
export type TugButtonRole = "accent" | "action" | "agent" | "data" | "danger" | "option";

/**
 * The compound emphasis × role class a button paints its look through [D02].
 *
 * Exported because it is the only definition of that grammar. A caller that
 * swaps a rendered button's look outside React — a per-frame DOM projection
 * over children it owns — would otherwise have to restate the template, which
 * is the token restatement [L20] exists to prevent. `TugButton` itself calls
 * this, so there is one composition and no second spelling to drift from.
 */
export function tugButtonEmphasisClass(
  emphasis: TugButtonEmphasis,
  role: TugButtonRole,
): string {
  return `tug-button-${emphasis}-${role}`;
}

/**
 * Set of recognized semantic role values. Used at runtime to disambiguate
 * TugButton's semantic `role` prop from an ARIA role attribute that
 * arrives via Radix `asChild` composition (e.g. `RadioGroupPrimitive.Item`
 * merging `role="radio"` onto the child button). When the incoming `role`
 * is not in this set, TugButton treats it as an ARIA role and forwards
 * it to the DOM rather than using it for classname theming.
 */
const SEMANTIC_ROLES: ReadonlySet<string> = new Set<TugButtonRole>([
  "accent",
  "action",
  "agent",
  "data",
  "danger",
  "option",
]);

/** TugButton size names. `2xs` is the most compact, intended for in-header
 * affordance clusters where a button needs to sit alongside a label and
 * a few sibling controls without dominating the strip. */
export type TugButtonSize = "2xs" | "xs" | "sm" | "md" | "lg";

/**
 * TugButton subtype names.
 * Three subtypes: text (default), icon (square), icon-text (leading icon + label).
 */
export type TugButtonSubtype = "text" | "icon" | "icon-text";

/**
 * TugButton layout — single-line (default) vs two-line label/content.
 *
 * Mirrors {@link TugBadgeLayout}: `label-top` / `content-top` stack a
 * letter-spaced uppercase `label` caption and the `children` content as two
 * rows, with an optional leading `icon` to the left of the stack. `single`
 * (the default) is the ordinary one-line button and is non-breaking for every
 * existing call site. DOM order is always caption-first; `content-top` only
 * reverses the visual stacking via CSS.
 */
export type TugButtonLayout = "single" | "label-top" | "content-top";

/** TugButton border-radius tokens (proportional, rem-based like Tailwind) */
export type TugButtonRounded = "none" | "sm" | "md" | "lg" | "full";

/**
 * TugButton activity — the motion a button wears while the action it fires
 * is in flight.
 *
 * This is the button-level answer to a shape that kept getting hand-rolled
 * per call site: a control that has already been pressed, whose work has not
 * come back yet, and which must say so without pretending to be disabled.
 * `loading` is the neighboring concept and a different claim — it blanks the
 * content and overlays a spinner, which reads as "this button is out of
 * service." An activity keeps the glyph and lets it move.
 *
 * Two moving parts, usable together or apart:
 *
 *  - **The name** picks the motion. `busy` is the null motion — the
 *    attribute is on and nothing moves in place — for buttons whose tell is
 *    a swapped-in {@link TugButtonProps.activityIcon} (a progress glyph
 *    replacing the rest glyph). `twinkle` animates the parts of the glyph
 *    marked `.tug-icon-spark` (see `tug-icons.tsx`), leaving the rest of the
 *    drawing still — sparkles that sparkle while the thing they promise is
 *    being written.
 *  - **The glyph** decides what can move. Whole-icon motion is the button's
 *    business and lives in `tug-button.css`; part-of-icon motion belongs to
 *    the icon, which declares its own animatable parts and answers the
 *    ancestor's `data-tug-activity` in `tug-icons.css`. A `twinkle` on a
 *    glyph that marks no sparks is simply still — the button does not
 *    invent motion for a drawing that never offered any.
 *
 * The attribute, not the prop, is the contract ([L06]). A surface that must
 * not re-render to show a transient — the prompt entry's shell arbitration,
 * which parks a submit for a few hundred milliseconds and would otherwise
 * repaint the composer mid-keystroke — writes `data-tug-activity` onto the
 * button element directly and gets the same appearance. Passing `activity`
 * is the ordinary path; writing the attribute is the escape hatch for state
 * that has no business in React.
 *
 * Adding a motion is: a name here, a rule keyed on it, and the keyframes
 * beside the rule — in `tug-button.css` if it moves the whole glyph, in the
 * icon's own file if it moves a part.
 */
export type TugButtonActivity = "busy" | "twinkle";

/**
 * TugButton confirmation configuration.
 *
 * When set, clicking the button enters the `confirmed` state ([token-naming.md])
 * for `duration` ms — swapping the icon and/or label to the confirmation values —
 * then automatically restores to rest. The button is non-interactive during the
 * confirmation window. Mirrors the "✔ Copied" pattern used by Copy buttons across
 * the web.
 *
 * The confirmation transition is appearance-zone state per [L06]: the swap is
 * driven by a `data-tug-confirming` attribute and CSS visibility rules rather
 * than React state, so re-rendering subtrees stay quiet during the duration window.
 */
export interface TugButtonConfirmation {
  /** Icon shown in the `confirmed` state. Falls back to the rest icon when omitted. */
  icon?: React.ReactNode;
  /** Label shown in the `confirmed` state. Falls back to rest children when omitted. */
  label?: React.ReactNode;
  /**
   * Milliseconds to remain in the confirmed state before restoring rest.
   * Default `DEFAULT_CONFIRMATION_DURATION_MS` (2000).
   */
  duration?: number;
  /** Optional aria-label override for the confirmed state (icon-only buttons). */
  ariaLabel?: string;
}

/**
 * TugButton props interface.
 *
 * Extends ButtonHTMLAttributes so that Radix composition (asChild pattern)
 * can merge arbitrary props (data-state, aria-expanded, onPointerDown, ref,
 * etc.) onto the underlying DOM button element. We omit:
 *   - 'role': TugButton redefines it as TugButtonRole (not the HTML aria role)
 *   - 'onClick': TugButton redefines it to accept an optional MouseEvent (for asChild compatibility)
 *   - 'children': TugButton redefines it as React.ReactNode (same type but explicit)
 */
export interface TugButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'onClick' | 'children'> {
  /**
   * Button rendering subtype.
   * @selector .tug-button-icon-sm | .tug-button-icon-md | .tug-button-icon-lg
   * @default "text"
   */
  subtype?: TugButtonSubtype;
  /**
   * Visual weight. Controls filled/outlined/ghost styling. [D02]
   * @selector .tug-button-{emphasis}-{role}
   * @default "outlined"
   */
  emphasis?: TugButtonEmphasis;
  /**
   * Color domain. Controls accent/action/data/danger hue. [D02]
   * @selector .tug-button-{emphasis}-{role}
   * @default "action"
   *
   * Accepts an arbitrary string in addition to the semantic {@link TugButtonRole}
   * values: a non-semantic string is treated as an **ARIA role** and passed
   * through to the DOM (`role="radio"`, `role="tab"`, …), while theming falls
   * back to `action`. This matches the runtime disambiguation below — formerly
   * only reachable via a Radix `asChild` Slot merge, now also usable directly by
   * hand-rolled controls (e.g. TugRadioItem). The `(string & {})` keeps
   * autocomplete for the semantic values.
   */
  role?: TugButtonRole | (string & {});
  /**
   * Size variant.
   * @selector .tug-button-size-2xs | .tug-button-size-xs | .tug-button-size-sm | .tug-button-size-md | .tug-button-size-lg
   * @default "md"
   */
  size?: TugButtonSize;

  /**
   * Layout arrangement. `single` is the one-row button (default, non-breaking
   * for every existing call site). `label-top` / `content-top` render the
   * `label` caption and `children` content as two stacked rows, with an
   * optional leading `icon`. See {@link TugButtonLayout}.
   * @selector .tug-button-layout-label-top | .tug-button-layout-content-top
   * @default "single"
   */
  layout?: TugButtonLayout;

  /**
   * Letter-spaced uppercase caption line for the two-line layouts. Only
   * meaningful when `layout !== "single"`; ignored in single layout. The
   * content line is always `children`.
   */
  label?: React.ReactNode;

  /** Direct-action mode click handler. Mutually exclusive with `action`. */
  onClick?: (e?: React.MouseEvent<HTMLButtonElement>) => void;

  /**
   * Chain-action mode: action name to dispatch via the responder chain.
   * Mutually exclusive with `onClick`.
   * When set, TugButton subscribes to canHandle/validateAction on the chain.
   * If canHandle returns false, the button renders as aria-disabled (never hidden).
   * If validateAction returns false, the button is visually disabled (aria-disabled).
   *
   * [D06] TugButton never hides -- disable instead of hide
   */
  action?: TugAction;

  /**
   * Explicit-target dispatch: ID of the responder node that should receive
   * the action directly. Overrides the default parent-responder target.
   * Requires `action` to be set.
   *
   * When omitted, the button dispatches to its parent responder via
   * `useControlDispatch` (the standard targeted dispatch pattern).
   * When set, the button dispatches to the named node instead.
   *
   * [D03] sendToTarget throws on unregistered target
   * [D04] TugButton target prop requires action prop
   * [D07] nodeCanHandle for per-node capability query
   */
  target?: string;

  /**
   * Disable the button.
   * @selector :disabled
   * @default false
   */
  disabled?: boolean;
  /**
   * Show spinner overlay and disable interaction.
   * @selector .tug-button-loading
   */
  loading?: boolean;
  /** Button label content (required for text and icon-text subtypes) */
  children?: React.ReactNode;

  /** Lucide icon node for "icon" and "icon-text" subtypes */
  icon?: React.ReactNode;

  /**
   * Motion the button wears while the action it fires is in flight. See
   * {@link TugButtonActivity} for the vocabulary and for the contract a
   * surface uses to drive the attribute by hand.
   * @selector [data-tug-activity="busy" | "twinkle"]
   */
  activity?: TugButtonActivity;

  /**
   * Glyph shown in place of {@link icon} while an activity is on. Both
   * glyphs mount and CSS picks between them off `data-tug-activity`, so the
   * swap is a cascade decision — a surface that drives the attribute by
   * hand gets the swap without re-rendering. Omit for an activity that
   * animates the rest glyph in place rather than replacing it.
   */
  activityIcon?: React.ReactNode;

  /**
   * Trailing icon node rendered after the label text in "text" and "icon-text" subtypes.
   * Useful for dropdown triggers that show a ChevronDown indicator.
   */
  trailingIcon?: React.ReactNode;

  /** Accessibility label (required for "icon" subtype without visible text) */
  "aria-label"?: string;

  /**
   * Confirmation feedback configuration. When set, clicking the button briefly
   * swaps to the confirmation icon/label and disables interaction, then restores.
   * @selector [data-tug-confirming="true"]
   *
   * Two modes:
   *  - **Uncontrolled** (default): `confirmation` set, `isConfirming` omitted.
   *    Click enters the confirmed state and the button's internal timer
   *    restores after `confirmation.duration` ms. Use this when the
   *    feedback should fire on every successful click without needing
   *    to filter on async success.
   *  - **Controlled**: `confirmation` set, `isConfirming` provided.
   *    The parent drives the confirmed state via the prop; the internal
   *    timer is bypassed. Use this when the feedback should reflect an
   *    asynchronous outcome (e.g. clipboard write success) — the parent
   *    flips `isConfirming` to `true` after the operation resolves and
   *    clears it on its own schedule.
   */
  confirmation?: TugButtonConfirmation;

  /**
   * Controlled-confirmation flag. When provided alongside
   * {@link confirmation}, the parent owns the confirmed-state lifecycle
   * and the button's internal timer is bypassed. `true` enters the
   * confirmed state; `false` exits it. When omitted (uncontrolled
   * mode), the button runs the internal timer keyed on
   * `confirmation.duration` as before.
   *
   * Honest feedback for async outcomes: a Copy button can call
   * `navigator.clipboard.writeText(text)` in `onClick`, then flip
   * `isConfirming` to `true` inside the `.then()` callback only when
   * the write actually succeeded. A failed write leaves
   * `isConfirming` at `false` — no false-positive "Copied" flash.
   *
   * Mutually-exclusive expectation with `confirmation.duration`: when
   * `isConfirming` is provided, the duration is ignored. Setting both
   * is a programming error and fires a dev-mode console.warn.
   *
   * @selector [data-tug-confirming="true"]
   */
  isConfirming?: boolean;

  /**
   * Width-stabilization configuration. When a button's label swings
   * between two values (e.g. a view-toggle reading "Inline" vs
   * "Side by side", or a Copy → "Copied" flash), the bare-width
   * difference would re-flow every sibling on every toggle. Pass the
   * *opposite* label here so the button renders both in a single
   * grid cell — the active label paints and the alternate stays
   * `visibility: hidden` but contributes to layout sizing. The button's
   * intrinsic width becomes the max-content of both labels and is
   * stable across toggles.
   *
   * Implementation: the shared {@link TugStableOverlay} primitive — both
   * labels overlaid in one grid cell. The inactive child carries
   * `aria-hidden="true"` so screen readers don't announce a ghost
   * label. Per [L06] the visibility swap is appearance — driven by
   * CSS, never React state.
   *
   * @selector [data-slot="tug-button-stable-label"]
   */
  widthStabilize?: { alternateLabel: React.ReactNode };

  /** Border radius token. Default is size-proportional (sm→"sm", md→"md", lg→"lg"). */
  rounded?: TugButtonRounded;

  /** Additional CSS class names */
  className?: string;

  /**
   * Render as a different element or component (Radix asChild polymorphism).
   * When true, the single child element becomes the button's DOM root.
   */
  asChild?: boolean;

  // ---- Focus engine ([P01], [P10]) ----
  //
  // The base button's focus has two independent axes, separated here (the
  // old `data-tug-focus="refuse"` fused them):
  //
  //   (a) no-steal-on-click — does clicking the button promote the responder
  //       chain / move browser focus? Buttons dispatch actions and should
  //       keep focus where it is, so this defaults to "no" (`stealsFocusOnClick`
  //       false → the button carries `data-tug-focus="refuse"`).
  //   (b) walk policy — is the button a stop in the app-authored Tab walk?
  //       It joins the walk only when a surrounding surface *authors* it into
  //       a focus group ([P02]); `focusGroup` is that opt-in. Until then it is
  //       a plain native focus stop (the global ring still paints on keyboard
  //       focus) and does not make the engine walk non-empty for its siblings.

  /**
   * Focus group this button is authored into ([P02]). When set, the button
   * registers as a focusable and participates in the engine's Tab walk; when
   * omitted, the button is a native focus stop only. Supplied by the surface
   * that owns the Tab order, not hand-set per call site in app code.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /**
   * Walk policy when registered: `accept` (default) is an ordinary Tab stop;
   * `skip` is reachable only in accessibility mode.
   */
  focusPolicy?: FocusPolicy;
  /**
   * Keep the keyboard ring (and `primary`→filled promotion) lit on this button
   * the entire time it is mounted — not just while it holds the key view. Opt-in,
   * for a surface whose **default action is the sole Return consumer**: a sheet
   * with no text entry (or a single one) where Return always commits this button
   * ([D02], `isDefaultButton` already routes Return here). The ring then reads as
   * "Return's home" even while the keyboard focus / caret is on the list or the
   * field. Do NOT set on multi-control surfaces where another control may claim
   * Return (e.g. `/permissions`). Appearance-only ([L06]); the button still gains
   * its own key-view ring normally when Tab'd onto.
   */
  persistentDefaultRing?: boolean;
  /**
   * Opt out of the emphasis-derived default-button registration ([D02]). A
   * `filled` / `primary` action button is Return's home by convention, which is
   * right for a CTA and wrong for a floating affordance that merely borrows the
   * filled look — a scroll-to-latest arrow is not what Return means anywhere on
   * the surface, and while it is registered it swallows every Return-submit in
   * the scope (an editor's submit chord defers to the chain's default button).
   */
  neverDefaultButton?: boolean;
  /**
   * Whether clicking promotes the responder chain and moves browser focus to
   * the button. Default `false` — the button dispatches its action and leaves
   * focus undisturbed (the no-steal-on-click half of the old `refuse` bundle).
   * Set `true` for the rare button that should itself become first responder.
   */
  stealsFocusOnClick?: boolean;
  /**
   * This button's act opens a menu it is the trigger for — declare the macOS
   * popup-button keyboard contract on top of the plain act.
   *
   * A popup button on macOS is not a two-key control. `Space` / `Return` open
   * it, and so do `↓` / `↑`, and so does any printable character. Without this
   * the engine's spatial plane owns the arrows and nothing at all owns the
   * letters, and the control reads as a dead end with two magic keys — the
   * "arrow never beeps" rule of `focus-language.md` applied to a leaf.
   *
   * The declaration is what makes the delivery possible: `captures` claims the
   * vertical arrows so the engine hands them to this element rather than moving
   * the ring ({@link KeyViewBehavior}), and `onKey` is the engine's delegated
   * channel for the printable characters no other stage claims. Both decline
   * while the menu is open — an open menu owns its own keys, including Radix's
   * type-ahead.
   *
   * Set by {@link TugPopupButton}; a bespoke trigger passing its own
   * {@link TugPopupMenu} sets it too.
   */
  menuTrigger?: boolean;
}

// ---- Border-radius ----
//
// The named → px mapping lives in `tug-button.css`, keyed on the
// `data-rounded` attribute the component stamps below. Appearance belongs
// in the cascade ([L06]); a component or theme can override the radius with
// an ordinary rule, with no inline style to fight and no `!important`.

/** Size-proportional default: compact sizes take proportionally tighter
 *  corners (an 8px radius on a 20px-tall `2xs` button reads as a 40%
 *  roundover); a caller's explicit `rounded` always wins. */
const SIZE_ROUNDED_DEFAULT: Record<TugButtonSize, TugButtonRounded> = {
  "2xs": "sm",
  xs: "md",
  sm: "lg",
  md: "lg",
  lg: "lg",
};

// ---- Spinner component ----

function Spinner() {
  return (
    <span className="tug-button-spinner-overlay" aria-hidden="true">
      <span className="tug-petals" style={{ "--tug-petals-size": "14px" } as React.CSSProperties}>
        <span className="petal" /><span className="petal" /><span className="petal" /><span className="petal" />
        <span className="petal" /><span className="petal" /><span className="petal" /><span className="petal" />
      </span>
    </span>
  );
}

// ---- TugButton ----

/**
 * TugButton -- internal tugways button component.
 *
 * Supports three subtypes (text, icon, icon-text), three sizes (sm, md, lg),
 * loading state, direct-action mode (onClick), and chain-action mode (action).
 *
 * TugButton is typographically neutral. For uppercase standalone action buttons,
 * use TugPushButton instead.
 *
 * Styling is controlled by the emphasis x role system [D02]:
 *   emphasis: "filled" | "outlined" | "ghost" | "tinted" | "primary" (default: "outlined")
 *   role:     "accent" | "action" | "data" | "danger" (default: "action")
 *
 * All colors use var(--tug-*) semantic tokens for zero-re-render theme switching. [L06]
 *
 * Implemented as React.forwardRef so that refs from Radix composition (asChild)
 * reach the underlying DOM button element.
 */
export const TugButton = React.forwardRef<HTMLButtonElement, TugButtonProps>(function TugButton({
  subtype = "text",
  emphasis = "outlined",
  role: roleProp = "action",
  size = "md",
  layout = "single",
  label,
  onClick,
  action,
  target,
  disabled = false,
  loading = false,
  children,
  icon,
  activity,
  activityIcon,
  trailingIcon,
  confirmation,
  isConfirming,
  widthStabilize,
  rounded,
  "aria-label": ariaLabel,
  className,
  asChild = false,
  focusGroup,
  focusOrder = 0,
  focusPolicy,
  persistentDefaultRing = false,
  neverDefaultButton = false,
  stealsFocusOnClick = false,
  menuTrigger = false,
  onKeyDown: onKeyDownProp,
  ...rest
}: TugButtonProps, ref) {
  // `role` is overloaded. For 99% of call sites it's a semantic theming
  // value from [D02]'s emphasis × role matrix (`action`, `data`, etc.)
  // and maps into a classname like `tug-button-ghost-action`. But when
  // this button is composed under a Radix `asChild` primitive (e.g.
  // `RadioGroupPrimitive.Item`), the primitive merges an *ARIA* role —
  // `"radio"`, `"tab"`, `"menuitem"` — onto the child via Slot. That
  // string isn't a valid `TugButtonRole`, and without the disambiguation
  // below it would both (a) produce a broken classname with no matching
  // CSS and (b) never land on the DOM button as an ARIA role.
  //
  // Disambiguation: if the incoming `role` matches a known semantic
  // value, use it for theming and leave the DOM role attribute empty
  // (native <button> semantics apply). Otherwise, treat it as an ARIA
  // role and pass it through to the DOM, using `"action"` as the
  // theming fallback so visual appearance stays sensible.
  const isSemanticRole = SEMANTIC_ROLES.has(roleProp as string);
  const role: TugButtonRole = isSemanticRole
    ? (roleProp as TugButtonRole)
    : "action";
  const htmlRole: string | undefined = isSemanticRole
    ? undefined
    : (roleProp as string);
  const boxDisabled = useTugBoxDisabled();
  const effectiveDisabled = disabled || boxDisabled;

  // Dev-mode warning for icon subtype without aria-label
  React.useEffect(() => {
    if (
      subtype === "icon" &&
      !ariaLabel &&
      !children &&
      process.env.NODE_ENV !== "production"
    ) {
      console.warn(
        "TugButton [icon subtype]: Missing aria-label. Icon-only buttons require an aria-label for accessibility."
      );
    }
  }, [subtype, ariaLabel, children]);

  // Dev-mode warning when both action and onClick are set (mutually exclusive)
  React.useEffect(() => {
    if (action !== undefined && onClick !== undefined && process.env.NODE_ENV !== "production") {
      console.warn(
        "TugButton: `action` and `onClick` are mutually exclusive. " +
        "When `action` is set, the chain dispatches on click; `onClick` is ignored."
      );
    }
  }, [action, onClick]);

  // Dev-mode warning when target is set without action
  React.useEffect(() => {
    if (target !== undefined && action === undefined && process.env.NODE_ENV !== "production") {
      console.warn(
        "TugButton: `target` is set without `action`. " +
        "`target` requires `action` to be set for dispatch to work."
      );
    }
  }, [target, action]);

  // ---- Chain-action mode: unconditional hook calls (React rules of hooks) ----

  // useResponderChain() returns the manager or null (safe outside provider).
  // Needed for canHandle/validateAction queries and explicit-target dispatch.
  const manager = useResponderChain();
  // Focus manager — owns the engine-projected `data-default-ring` ([P14]).
  const focusManager = useFocusManager();
  // The owning card ([P21]): the persistent default ring registers into THIS
  // card's focus context, so a (possibly background) card's dialog button never
  // pollutes the key card's default-ring stack. `null` outside a card host.
  const defaultRingCardId = useContext(CardIdContext);
  // Parent responder ID — the default dispatch and validation target.
  const parentId = useContext(ResponderParentContext);
  // Targeted dispatch to parent responder — same hook all controls use.
  const { dispatch: controlDispatch } = useControlDispatch();

  // useSyncExternalStore() called unconditionally on every render. [L02]
  // When the chain is inactive (no manager, or no action prop), use the
  // module-level NOOP constants so React sees stable function references
  // and never triggers unnecessary re-subscriptions.
  const chainActive = manager !== null && action !== undefined;
  const subscribe = chainActive ? manager.subscribe.bind(manager) : NOOP_SUBSCRIBE;
  const getSnapshot = chainActive ? manager.getValidationVersion.bind(manager) : NOOP_SNAPSHOT;
  useSyncExternalStore(subscribe, getSnapshot);

  // ---- Chain-action validation (computed from hook results) ----

  // Query the effective target for capability and enabled state.
  // Explicit `target` prop wins; otherwise use the parent responder
  // (same target the dispatch will use) — the button always validates
  // against its dispatch target, never the first responder.
  //
  // Two distinct questions, and they used to be one: `nodeCanHandle` asks
  // whether the target handles the action at all, `validateActionAtNode`
  // asks whether it is enabled right now. Aliasing the second to the first
  // meant a responder's `validateAction` was written, registered, and never
  // consulted by any button — a control could not go dim for the reason the
  // menu item beside it did.
  //
  // A button does NOT defer to its command's registry `validate` predicate,
  // and the reason is scope. Those predicates answer for a MENU item, so
  // they are written against the frontmost card — `interrupt-session` is
  // enabled when the frontmost session card has a turn to interrupt. A
  // button asks about the card it lives in. Handing a background card's Stop
  // button the frontmost card's answer would dim it for a turn running
  // somewhere else. Both surfaces bottom out in the same responder-registered
  // `validateAction`; they differ only in which node they ask, which is
  // exactly what makes each one right for its own question.
  // [D07] nodeCanHandle for per-node capability query
  const effectiveValidationTarget = target ?? parentId;
  const chainCanHandle = chainActive && effectiveValidationTarget !== null
    ? manager.nodeCanHandle(effectiveValidationTarget, action)
    : false;
  const chainValidated = chainActive && effectiveValidationTarget !== null
    ? manager.validateActionAtNode(effectiveValidationTarget, action)
    : false;

  // isChainDisabled: chain is active and either canHandle is false OR validateAction is false.
  // When true, the button renders as aria-disabled (never hidden -- [D06] never-hide).
  const isChainDisabled = chainActive && (!chainCanHandle || !chainValidated);

  // ---- Layout helpers ----

  // Border radius: explicit token wins, otherwise the size-proportional
  // default. Stamped as `data-rounded` below; the px value lives in CSS.
  const resolvedRounded: TugButtonRounded = rounded ?? SIZE_ROUNDED_DEFAULT[size];

  // ---- Confirmation state (appearance-zone, [L06]) ----
  //
  // The confirmed state is driven entirely by DOM attributes and CSS, not by
  // React state. The ref tracks "are we currently confirming?" so the click
  // handler can short-circuit; the timer ref owns the restore-to-rest schedule.
  // Both are mutated imperatively — no setState, no re-render — per [L06].

  const internalButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const confirmingRef = React.useRef(false);
  const timerRef = React.useRef<number | null>(null);

  // ---- Focus-engine registration ([P01], [P10]) ----
  //
  // A stable auto-id identifies this button to the focus engine. It registers
  // as a focusable only when a surrounding surface has authored it into a focus
  // group ([P02]); `register: false` otherwise leaves it a plain native focus
  // stop so an un-authored button never makes the engine's Tab walk non-empty
  // (which would suppress native Tab for its un-authored siblings). The
  // returned `focusableRef` writes `data-tug-focusable` so the engine can land
  // the key view on this button and paint the ring on keyboard focus.
  const autoFocusId = React.useId();

  // ---- The popup-button key contract ([P01] behavior, `menuTrigger`) ----
  //
  // "Is my menu up?" is read off the DOM rather than mirrored in React state:
  // Radix stamps `data-state` on the trigger, and that attribute IS the open
  // state ([L22] observe, don't duplicate). Both halves below decline while it
  // is open, so an open menu keeps every key — its own type-ahead included.
  const menuIsOpen = React.useCallback(
    () => internalButtonRef.current?.getAttribute("data-state") === "open",
    [],
  );
  // A bare printable character — one grapheme, no chord. Space is a single
  // character too and is deliberately NOT one: it belongs to the act tier, and
  // claiming it here would swallow the very keydown the engine delivers to
  // carry the act out.
  const isTypeAheadKey = React.useCallback(
    (e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) =>
      e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey,
    [],
  );
  // The menu's own open control, handed down by TugPopupMenu. Moving its state
  // is the whole mechanism — no synthesized press, no guess about which DOM
  // event the menu primitive listens on.
  const menuHandle = React.useContext(TugPopupMenuTriggerContext);
  const openMenu = React.useCallback(() => {
    menuHandle?.open();
  }, [menuHandle]);
  const menuTriggerBehavior = React.useCallback(() => {
    if (!menuTrigger) return null;
    return {
      container: "none" as const,
      // Claim the vertical arrows so the engine delivers them here instead of
      // walking the ring off this control.
      captures: (k: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) =>
        (k.key === "ArrowDown" || k.key === "ArrowUp") &&
        k.metaKey !== true &&
        k.ctrlKey !== true &&
        k.altKey !== true &&
        !menuIsOpen(),
      onKey: (e: KeyboardEvent) => {
        if (menuIsOpen() || !isTypeAheadKey(e)) return false;
        openMenu();
        return true;
      },
    };
  }, [menuTrigger, menuIsOpen, isTypeAheadKey, openMenu]);

  const { focusableRef } = useFocusable({
    id: autoFocusId,
    group: focusGroup ?? "",
    order: focusOrder,
    policy: focusPolicy,
    register: focusGroup !== undefined,
    behavior: menuTriggerBehavior,
  });

  // The arrows, once the engine has delivered them here (that delivery is what
  // `captures` above buys). Composed ahead of the caller's handler, never
  // instead of it — the menu primitive's own trigger keydown still runs.
  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        menuTrigger &&
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !menuIsOpen()
      ) {
        e.preventDefault();
        openMenu();
      }
      onKeyDownProp?.(e);
    },
    [menuTrigger, menuIsOpen, openMenu, onKeyDownProp],
  );

  // ---- Default-button registration ([L03]) ----
  //
  // A `filled` (or `primary`) + `action` button is, by visual
  // contract, the "primary action" of its scope — the button Return
  // is supposed to activate ([D02]). `primary` is the preferred form
  // (it rests quiet and promotes when live); `filled` + `action`
  // stays a valid default for standalone CTAs. The responder chain
  // owns the actual Enter→click routing (`responder-chain-provider.tsx`
  // Stage 2); this hook simply opts the button into that mechanism.
  // Stack semantics (innermost-wins) come from the chain — a nested
  // PermissionDialog over a QuestionDialog automatically takes
  // over while it's mounted and restores the outer button on
  // unmount.
  //
  // Skipped when the button is disabled, aria-disabled, or
  // loading — a non-interactive button shouldn't capture Return.
  // Skipped when no chain manager is in scope (standalone previews
  // and unit tests).
  // The emphasis-derived default: a `filled` / `primary` action button is the
  // scope's Return-home by convention, with no opt-in (the common case — a lone
  // Save / Open / Submit CTA).
  const isDefaultButton =
    !neverDefaultButton &&
    (emphasis === "filled" || emphasis === "primary") &&
    isSemanticRole &&
    role === "action" &&
    !effectiveDisabled &&
    !loading;

  // The persistent default ring ([P14]) is the EXPLICIT declaration of "this
  // button is the scope's Return-home" — used when the keyboard rests on a
  // non-button control (a list / field / cursor) and when the emphasis-auto rule
  // doesn't pick the button a layout actually wants (e.g. a wizard's `outlined`
  // Next, which advances on Return while Submit is still gated). Opt out while
  // disabled / loading — a non-interactive button is no Return target.
  const wantsDefaultRing = persistentDefaultRing && !effectiveDisabled && !loading;

  // "Return's home" is ONE concept: the button Enter activates AND the button
  // that wears the ring must be the same. So the activation registration honors
  // BOTH derivations — the emphasis-auto default and the explicit
  // `persistentDefaultRing` — rather than only emphasis. Without this an explicit
  // ring could point at a button Enter never presses (the ring would lie). A
  // button that is both (a `primary` action with `persistentDefaultRing`, e.g.
  // Allow / Submit) registers exactly once.
  const isReturnHome = isDefaultButton || wantsDefaultRing;
  React.useLayoutEffect(() => {
    if (!isReturnHome || manager === null) return;
    const node = internalButtonRef.current;
    if (node === null) return;
    manager.pushDefaultButton(node);
    return () => {
      manager.popDefaultButton(node);
    };
  }, [isReturnHome, manager]);

  // The focus manager OWNS the `data-default-ring` attribute — it stamps it on
  // this node iff the current key view is not itself a button, and removes it the
  // instant the keyboard lands on any button. So the one-filled-ring-per-scope
  // invariant is structural: a focused button is always the sole filled+ring, and
  // this ring stands down to it (never a second filled+ring).
  React.useLayoutEffect(() => {
    if (!wantsDefaultRing || focusManager === null) return;
    const node = internalButtonRef.current;
    if (node === null) return;
    const ctx = focusManager.contextFor(defaultRingCardId);
    ctx.registerDefaultRing(node);
    return () => {
      ctx.unregisterDefaultRing(node);
    };
  }, [wantsDefaultRing, focusManager, defaultRingCardId]);

  // Merged ref forwards to the caller while keeping our internal handle for
  // imperative DOM mutation during the confirmation cycle. Stable across
  // renders so React doesn't tear down/re-attach the ref on every render.
  const setRefs = React.useCallback(
    (node: HTMLButtonElement | null) => {
      internalButtonRef.current = node;
      // Project the focusable's DOM attribute (no-op when not registered).
      focusableRef(node);
      if (typeof ref === "function") ref(node);
      else if (ref !== null && ref !== undefined) {
        (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node;
      }
    },
    [ref, focusableRef],
  );

  // Controlled-mode discriminator. When `isConfirming` is provided
  // (boolean — `true` or `false`), the parent owns the lifecycle and
  // the internal timer below is bypassed. When omitted (`undefined`),
  // the button runs the uncontrolled timer-based path.
  const isControlledConfirmation = isConfirming !== undefined;

  // Dev-warn on the conflicting-prop case. Setting `isConfirming`
  // alongside `confirmation.duration` is a programming error — the
  // duration is silently ignored in controlled mode, and mixing the
  // two means the author probably misunderstands which side owns the
  // lifecycle. Surface the bug at mount instead of in the wild.
  React.useEffect(() => {
    if (
      isControlledConfirmation &&
      confirmation?.duration !== undefined &&
      process.env.NODE_ENV !== "production"
    ) {
      console.warn(
        "TugButton: `isConfirming` and `confirmation.duration` are mutually exclusive. " +
          "When `isConfirming` is provided, the parent owns the confirmed-state lifecycle " +
          "and `confirmation.duration` is ignored. Remove one or the other.",
      );
    }
  }, [isControlledConfirmation, confirmation?.duration]);

  const enterConfirmation = React.useCallback(() => {
    const node = internalButtonRef.current;
    if (node === null) return;
    // Confirming is a transient *feedback* state, NOT a disabled state.
    // We deliberately do not set `aria-disabled="true"` so the existing
    // `:not([aria-disabled="true"])` exclusions in rest-state CSS rules
    // don't silently mask the confirming-state styling, and — more
    // importantly — so `:hover` continues to match while the user holds
    // the cursor over the button. Click suppression is handled by the
    // JS `confirmingRef` guard inside the click handler; we don't need
    // a DOM-level gate.
    confirmingRef.current = true;
    node.dataset.tugConfirming = "true";
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    const duration = confirmation?.duration ?? DEFAULT_CONFIRMATION_DURATION_MS;
    timerRef.current = window.setTimeout(() => {
      const el = internalButtonRef.current;
      confirmingRef.current = false;
      timerRef.current = null;
      if (el !== null) {
        delete el.dataset.tugConfirming;
        // Force WebKit to re-evaluate selector matching after the
        // attribute swap so the resting `:hover` rule paints
        // immediately instead of lagging until the user moves their
        // mouse. The flush attribute is a no-op for styling but the
        // mutation invalidates the style cache. See
        // [tuglaws/component-authoring.md] "Controlled feedback
        // states" for the rationale.
        el.dataset.tugFlush = "1";
        delete el.dataset.tugFlush;
      }
    }, duration);
  }, [confirmation?.duration]);

  // Controlled-confirmation driver — when `isConfirming` is provided,
  // the prop drives `data-tug-confirming` directly. No internal timer
  // runs; clearing the flag is the parent's job. Mirrors the existing
  // imperative DOM mutation pattern in `enterConfirmation` so the
  // attribute write paths are uniform.
  //
  // [L03] useLayoutEffect — the attribute change paints in the same
  // frame as the state transition the parent triggered.
  // [L06] DOM mutation, not React state — `data-tug-confirming` is
  // appearance, driven directly into the DOM.
  React.useLayoutEffect(() => {
    if (!isControlledConfirmation) return;
    const node = internalButtonRef.current;
    if (node === null) return;
    if (isConfirming) {
      // Cancel any uncontrolled timer that may have been mid-flight —
      // not expected when a caller uses controlled mode, but defensive
      // against switches between modes during a transition.
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      confirmingRef.current = true;
      node.dataset.tugConfirming = "true";
      // NO `aria-disabled` here. Confirming is a transient feedback
      // state, not a disabled state. Setting `aria-disabled` would
      // trip every `:not([aria-disabled="true"])` exclusion on
      // rest-state CSS rules and suppress `:hover` painting while
      // the user holds the cursor over the button. Click re-fire
      // suppression lives in the JS `confirmingRef` guard inside
      // the click handler.
    } else {
      confirmingRef.current = false;
      delete node.dataset.tugConfirming;
      // Flush selector matching so the resting `:hover` rule paints
      // without waiting for a pointer event. WebKit caches selector
      // matching against pointer events, not against arbitrary DOM
      // mutations — without this nudge, the resting hover background
      // reappears only when the user jostles the mouse.
      node.dataset.tugFlush = "1";
      delete node.dataset.tugFlush;
    }
  }, [isControlledConfirmation, isConfirming]);

  // Clear any pending timer on unmount so we never touch a detached node.
  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // ---- Click handler ----

  const handleClick = (e?: React.MouseEvent<HTMLButtonElement>) => {
    if (effectiveDisabled || loading) return;

    // Ignore secondary (context-menu) activations. On macOS a Control-click is
    // a secondary gesture, but WebKit still dispatches a `click` for it (with
    // `button === 0` and `ctrlKey === true`) alongside the `contextmenu` event
    // — without this guard a Ctrl-click would fire the button's action as well
    // as raising the context menu. A true right-click (`button === 2`) fires no
    // `click` at all, so it never reaches here. Synthetic activations
    // (`element.click()` from the keyboard default-button path) carry neither
    // flag, so they pass.
    if (e && (e.button !== 0 || e.ctrlKey)) return;

    // Chain-action disabled guard: aria-disabled buttons still receive click
    // events (unlike HTML disabled). Return early without dispatching.
    if (isChainDisabled) return;

    // Confirmation guard: button is non-interactive during its confirmation
    // window. The ref check beats the React render cycle so a click that
    // arrives mid-confirmation doesn't sneak through a stale closure.
    if (confirmingRef.current) return;

    if (chainActive && chainCanHandle) {
      // Chain-action mode: targeted dispatch. [D01]
      // Explicit `target` prop overrides the default parent dispatch.
      if (target !== undefined) {
        manager!.sendToTarget(target, { action, phase: "discrete" });
      } else {
        controlDispatch({ action, phase: "discrete" });
      }
    } else {
      onClick?.(e);
    }

    // Enter the confirmed state after the click logic runs so a downstream
    // `preventDefault`-style abort still gets the chance to run first.
    // Controlled mode (`isConfirming` provided) bypasses the internal
    // timer — the parent's prop drives the lifecycle via the layout
    // effect above.
    if (confirmation !== undefined && !isControlledConfirmation) {
      enterConfirmation();
    }
  };

  // aria-disabled for chain-action disabled state.
  // Use aria-disabled (not HTML disabled) so the button stays in the tab order.
  const ariaDisabled = isChainDisabled ? "true" : undefined;

  // CSS class composition — compound emphasis-role class [D02]
  const emphasisRoleClass = tugButtonEmphasisClass(emphasis, role);
  const sizeClass = `tug-button-size-${size}`;
  const twoLine = layout !== "single";
  const buttonClassName = cn(
    // Base tug-button class
    "tug-button",
    // Size class
    sizeClass,
    // Emphasis x role compound class for hover/active/transition styles
    emphasisRoleClass,
    // Two-line label/content layout (label-top / content-top)
    twoLine && `tug-button-layout-${layout}`,
    // Icon subtype size classes (square aspect ratio)
    subtype === "icon" && size === "2xs" && "tug-button-icon-2xs",
    subtype === "icon" && size === "xs" && "tug-button-icon-xs",
    subtype === "icon" && size === "sm" && "tug-button-icon-sm",
    subtype === "icon" && size === "md" && "tug-button-icon-md",
    subtype === "icon" && size === "lg" && "tug-button-icon-lg",
    // Loading state
    loading && "tug-button-loading",
    className
  );

  // Two-line content (`label-top` / `content-top`): an optional leading icon
  // beside a column that stacks the uppercase `label` caption over the
  // `contentNode`. DOM order is caption-first; `content-top` reverses only the
  // visual order via CSS. Mirrors TugBadge's two-line stack so the two
  // component families read with one visual vocabulary.
  function renderTwoLine(
    iconNode: React.ReactNode,
    contentNode: React.ReactNode,
  ): React.ReactNode {
    return (
      <span className="tug-button-twoline">
        {iconNode != null && iconNode !== false && (
          <span className="tug-button-twoline-icon" aria-hidden="true">
            {iconNode}
          </span>
        )}
        <span className="tug-button-stack">
          <span className="tug-button-label">{label}</span>
          <span className="tug-button-content">{contentNode}</span>
        </span>
      </span>
    );
  }

  // Inner content: the two-line stack when a `layout` is set, else the
  // subtype-driven single-line content. Both the rest and confirmation
  // sub-trees funnel through here so they stay structurally aligned.
  function renderInner(
    iconNode: React.ReactNode,
    contentNode: React.ReactNode,
  ): React.ReactNode {
    return twoLine
      ? renderTwoLine(iconNode, contentNode)
      : renderSubtypeContent(iconNode, contentNode);
  }

  // The icon slot as the activity sees it. With an `activityIcon` both
  // glyphs mount in the slot and CSS picks between them off the button's
  // `data-tug-activity` — the same shape the confirmation swap uses below,
  // and the reason a hand-written attribute produces the swap without a
  // render. Hidden is `display: none`, which is also what keeps a progress
  // glyph's keyframe loop from running for the whole time it is not showing.
  const iconSlot =
    activityIcon === undefined ? (
      icon
    ) : (
      <>
        <span className="tug-button-rest-icon">{icon}</span>
        <span className="tug-button-activity-icon" aria-hidden="true">
          {activityIcon}
        </span>
      </>
    );

  // Content rendering per subtype
  function renderContent() {
    if (loading) {
      return (
        <>
          <span className="tug-button-loading-content" aria-hidden="true">
            {renderInner(iconSlot, children)}
          </span>
          <Spinner />
        </>
      );
    }
    return renderInner(iconSlot, children);
  }

  function wrapLabel(labelNode: React.ReactNode): React.ReactNode {
    if (widthStabilize === undefined) return labelNode;
    // Overlay the active + alternate label in one grid cell so the cell
    // sizes to max-content of both and the button width is stable across
    // the swap. Shared with TugBadge via `TugStableOverlay`.
    return (
      <TugStableOverlay
        data-slot="tug-button-stable-label"
        active={labelNode}
        alternates={[widthStabilize.alternateLabel]}
      />
    );
  }

  function renderIconTextCluster(
    iconNode: React.ReactNode,
    labelNode: React.ReactNode,
  ): React.ReactNode {
    return (
      <>
        {iconNode}
        {labelNode}
        {trailingIcon && (
          <span className="tug-button-trailing-icon" aria-hidden="true">
            {trailingIcon}
          </span>
        )}
      </>
    );
  }

  function renderSubtypeContent(
    iconNode: React.ReactNode,
    labelNode: React.ReactNode,
  ) {
    const wrappedLabel = wrapLabel(labelNode);
    switch (subtype) {
      case "icon":
        return iconNode ?? null;

      case "icon-text":
        // Width-stabilized icon-text: overlay the *whole* icon+label
        // cluster for both label states in one grid cell so the
        // button width is invariant across the swap AND the active
        // cluster stays centered (icon tight against its text, slack
        // split evenly). `wrapLabel` only stabilizes a lone label,
        // which would leave the cluster jammed to the leading edge.
        if (widthStabilize !== undefined) {
          return (
            <TugStableOverlay
              data-slot="tug-button-stable-label"
              active={
                <span className="tug-button-icon-text">
                  {renderIconTextCluster(iconNode, labelNode)}
                </span>
              }
              alternates={[
                <span className="tug-button-icon-text">
                  {renderIconTextCluster(iconNode, widthStabilize.alternateLabel)}
                </span>,
              ]}
            />
          );
        }
        return (
          <span className="tug-button-icon-text">
            {iconNode}
            {wrappedLabel}
            {trailingIcon && (
              <span className="tug-button-trailing-icon" aria-hidden="true">
                {trailingIcon}
              </span>
            )}
          </span>
        );

      case "text":
      default:
        return (
          <>
            {wrappedLabel}
            {trailingIcon && (
              <span className="tug-button-trailing-icon" aria-hidden="true">
                {trailingIcon}
              </span>
            )}
          </>
        );
    }
  }

  // Confirmation content: falls back to the rest icon/label when only one
  // half of the swap is provided. Rendered as a sibling sub-tree that CSS
  // toggles via `[data-tug-confirming]` — no React state churn during the
  // restore-to-rest window. [L06]
  const confirmIconResolved = confirmation?.icon ?? icon;
  const confirmLabelResolved = confirmation?.label ?? children;

  // Use Radix Slot for asChild polymorphism; plain button otherwise.
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      ref={setRefs}
      data-slot="tug-button"
      data-tug-focus={stealsFocusOnClick ? undefined : "refuse"}
      data-tug-role={role}
      disabled={effectiveDisabled}
      role={htmlRole}
      aria-label={ariaLabel}
      data-tug-activity={activity}
      aria-busy={loading || activity !== undefined ? "true" : undefined}
      aria-disabled={ariaDisabled}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={buttonClassName}
      data-rounded={resolvedRounded}
      {...rest}
    >
      <span className="tug-button-rest-content">{renderContent()}</span>
      {confirmation !== undefined && (
        <span
          className="tug-button-confirm-content"
          aria-label={confirmation.ariaLabel}
        >
          {renderInner(confirmIconResolved, confirmLabelResolved)}
        </span>
      )}
    </Comp>
  );
});
