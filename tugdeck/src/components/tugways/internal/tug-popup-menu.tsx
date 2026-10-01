/**
 * TugPopupMenu — Internal building block for popup menus.
 *
 * Internal building block — app code should use TugPopupButton instead.
 * Composed by TugPopupButton (convenience wrapper) and TugTabBar (overflow/add menus).
 *
 * Wraps @radix-ui/react-dropdown-menu directly (no shadcn intermediary).
 * Callers pass a `trigger` ReactNode; TugPopupMenu wraps it in a Radix
 * Trigger with asChild, so the caller's element becomes the trigger.
 *
 * This architectural inversion allows callers to control all trigger
 * presentation: TugPopupButton passes a styled TugButton; tab bar triggers
 * pass TugButton ghost-option elements without chevrons.
 *
 * ## Open state is locally controlled, and optionally externally
 *
 * The Radix Root is bound to a `useState<boolean>` here so TugPopupMenu
 * knows its own open state in React. Callers still get the uncontrolled
 * ergonomics — they pass a `trigger` and `items`, never touch open/close —
 * but the menu itself can observe the chain and react to external
 * dispatches. The activation close path ("an item was picked") also uses
 * this controlled state to close cleanly instead of synthesizing a
 * document-level Escape keydown.
 *
 * A caller that must open the menu from somewhere other than a press on the
 * trigger — a chord, or a gesture on a surface the trigger sits in — passes
 * the optional `open` / `onOpenChange` pair. The prop then holds the truth
 * and every internal transition reports outward. Both modes run through one
 * `setOpen`, so the focus trap, the observeDispatch subscription, the
 * sub-menu reset, and the blink-then-close selection path are the same code
 * either way; a caller that omits `open` gets exactly the behavior it has
 * always had.
 *
 * ## Chain-reactive dismissal via observeDispatch
 *
 * While the menu is open, TugPopupMenu subscribes to
 * `manager.observeDispatch` (matching the `tug-editor-context-menu`
 * precedent). Any action flowing through the responder chain — a keyboard
 * shortcut from the keybinding map, a button click elsewhere, a
 * programmatic dispatch — dismisses the menu. The only dispatches that do
 * NOT dismiss are the menu's own item activations, which are guarded by
 * `blinkingRef`: during the blink-animate-then-onSelect window,
 * blinkingRef is true and the observer callback skips its close. This
 * generalizes "close on external shortcut" through a single signal, per
 * [L11].
 *
 * When rendered outside a ResponderChainProvider (standalone previews,
 * unit tests that don't mount a provider), `useResponderChain()` returns
 * null and the subscription is skipped — the menu still renders and
 * opens/closes normally, it just doesn't get the chain-reactive dismiss.
 *
 * ## Sub-menu open state is locally controlled
 *
 * Each `Sub` is a controlled component bound to a single `openSubKey`
 * value, so exactly one sub-menu is open at a time. Hovering a
 * sub-trigger sets `openSubKey` directly from an `onPointerEnter`
 * handler, switching the visible sub-menu on the same commit the
 * cursor lands — Radix's own pointer-grace heuristic would otherwise
 * keep the previous sub-menu open while the cursor sits on a sibling.
 * Hovering a plain top-level item clears `openSubKey` so no stale
 * sub-menu lingers. Keyboard open/close still flows through Radix via
 * `onOpenChange`.
 *
 * **Authoritative references:**
 * - [D02] TugPopupMenu takes a single ReactNode trigger prop
 *
 * **Law citations:** [L06] [L11] [L19]
 */

import "../tug-menu.css";

import React, { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { animate } from "@/components/tugways/tug-animator";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import { useOpenMenuClaim } from "@/components/tugways/use-open-menu-claim";
import { TugSheetStackingContext } from "@/components/tugways/tug-sheet-stacking-context";
import { cn } from "@/lib/utils";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { sequencePopupMenuActivation } from "./tug-popup-menu-activation";

// ---- Types ----

/**
 * The open control TugPopupMenu hands down to its trigger.
 *
 * A trigger that is a focus-engine key view has keys delivered to it by the
 * engine, not by the browser, and it has to be able to act on them. Without
 * this it could only reach the menu by synthesizing a press on itself — a
 * guess at whichever DOM event Radix happens to listen on, and a lie about
 * what the user did. `open()` is the same state transition the pointer takes.
 *
 * `null` outside a TugPopupMenu, which is the ordinary case for every button
 * that is not a menu trigger.
 */
export interface TugPopupMenuTriggerHandle {
  /** Open the menu. Idempotent — opening an open menu is a no-op. */
  open: () => void;
}

export const TugPopupMenuTriggerContext =
  React.createContext<TugPopupMenuTriggerHandle | null>(null);

/** A single selectable item in a TugPopupMenu. */
export interface TugPopupMenuItem {
  /** Unique identifier for this item. Passed to onSelect when clicked. */
  id: string;
  /** Display label for this item. */
  label: string;
  /** Optional icon node rendered before the label. */
  icon?: React.ReactNode;
  /** Whether this item is disabled. Disabled items are not interactive. */
  disabled?: boolean;
  /**
   * Checkmark state for single-select menus. When defined, the item reserves
   * a leading check column (so its label aligns with checked siblings) and
   * shows a checkmark when `true`. Set it on EVERY item of a single-select
   * menu so all labels align. Leave `undefined` for plain action menus (no
   * check column).
   */
  selected?: boolean;
  /**
   * Optional keyboard-shortcut label rendered right-aligned after the label
   * (e.g. `"⌃⌘C"`). Presentational only — the accelerator itself is wired in
   * the command registry, not here. Omit for items with no shortcut.
   */
  shortcut?: string;
}

/** A visual separator line between menu sections. */
export interface TugPopupMenuSeparator {
  type: "separator";
}

/** A non-interactive section label in the menu. */
export interface TugPopupMenuLabel {
  type: "label";
  label: string;
  /** Optional icon node rendered before the label. */
  icon?: React.ReactNode;
}

/** A sub-menu group with its own trigger and nested items. */
export interface TugPopupMenuSub {
  type: "sub";
  /** Display label for the sub-menu trigger. */
  label: string;
  /** Optional icon node rendered before the trigger label. */
  icon?: React.ReactNode;
  /** Nested entries inside the sub-menu. Supports items, separators, and labels (not nested subs). */
  items: TugPopupMenuEntry[];
}

/**
 * A single entry in a TugPopupMenu items array.
 *
 * Plain objects without a `type` field are selectable items.
 * Objects with `type: "separator"` render a divider line.
 * Objects with `type: "label"` render a non-interactive section heading.
 * Objects with `type: "sub"` render a sub-menu with a trigger and nested content.
 */
export type TugPopupMenuEntry = TugPopupMenuItem | TugPopupMenuSeparator | TugPopupMenuLabel | TugPopupMenuSub;

/**
 * Props for TugPopupMenu.
 *
 * TugPopupMenu is headless: the caller provides the trigger ReactNode.
 * The trigger element must accept Radix-injected props (ref, data-state,
 * aria-expanded, etc.) -- any HTML element or forwardRef component does.
 */
export interface TugPopupMenuProps {
  /** Trigger element. Wrapped in Radix Trigger asChild -- must accept ref. */
  trigger: React.ReactNode;
  /** List of entries to display in the popup menu. Accepts items, separators, and labels. */
  items: TugPopupMenuEntry[];
  /** Called with the selected item's id when an item is clicked. */
  onSelect: (id: string) => void;
  /**
   * Run {@link onSelect} as the confirmation blink starts instead of when it
   * ends. Default `false`: the pick waits out the blink, then `onSelect` runs
   * and the menu closes.
   *
   * Set it on a menu whose pick has a visible effect the user is waiting on —
   * the workspace row's theme menu applies its theme this way, so the theme
   * changes while the blink plays rather than after it. The blink still
   * plays, the menu still closes at its end, and the guard that keeps the
   * menu's own chain dispatches from dismissing it stays up for the whole
   * blink in either timing.
   */
  selectAtBlinkStart?: boolean;
  /** Menu alignment relative to the trigger. Default: "start". */
  align?: "start" | "center" | "end";
  /**
   * Preferred side of the trigger the menu opens toward. Radix still
   * collision-flips when there is no room. Default: Radix's `"bottom"`.
   * A bottom-anchored trigger (e.g. a prompt-bar chip) passes `"top"`.
   */
  side?: "top" | "right" | "bottom" | "left";
  /**
   * Distance in pixels between trigger and menu content.
   * Default: 3px (works well across sm/md/lg button sizes).
   * Callers requiring precise control can pass an explicit value.
   */
  sideOffset?: number;
  /**
   * Seed the initial open state. Useful for test setups that want to
   * render a pre-opened menu without synthesizing trigger clicks through
   * Radix. Defaults to false; real consumers never set this.
   */
  defaultOpen?: boolean;
  /**
   * Controlled open state. Omit for the uncontrolled behavior every existing
   * call site relies on. When supplied, this prop is authoritative and every
   * internal transition — trigger press, Escape, click-outside, chain
   * dismiss, item activation — reports through {@link onOpenChange} instead
   * of writing local state.
   *
   * Exists for openers that are not a press on the trigger: a pane-level
   * chord or gesture that must open a menu it does not own. Synthesizing a
   * click on the trigger element would be a guess at whichever DOM event
   * Radix happens to listen on, and a lie about what the user did.
   */
  open?: boolean;
  /** Reports every open-state transition when {@link open} is supplied. */
  onOpenChange?: (open: boolean) => void;
  /** data-testid for the menu content element. */
  "data-testid"?: string;
}

// ---- TugPopupMenu ----

/**
 * TugPopupMenu -- headless popup menu component.
 *
 * Renders a Radix-based dropdown via @radix-ui/react-dropdown-menu primitives
 * directly (no shadcn wrapper). Uses `--tug-*` semantic tokens for all
 * visual properties via tug-menu.css. The content renders into a Radix portal
 * (document root), avoiding z-index conflicts with TugPane and other stacked
 * elements.
 *
 * The trigger is the caller-provided ReactNode, wrapped in Radix Trigger asChild.
 * The caller owns trigger presentation; the menu owns dropdown behavior. [D02]
 *
 * Selection behavior ([L06], [D01]):
 * - `onSelect` is intercepted; Radix close is prevented via event.preventDefault().
 * - A double-blink background-color animation is driven by TugAnimator (programmatic
 *   lane, needs completion sequencing to know when to close the menu).
 * - animate().finished resolves when the blink completes; the caller's
 *   onSelect is invoked and then the locally controlled open state
 *   flips to false, closing the menu through Radix's onOpenChange path.
 * - With `selectAtBlinkStart`, the caller's onSelect runs as the blink
 *   starts instead; the close still waits for the blink to complete.
 */
export function TugPopupMenu({
  trigger,
  items,
  onSelect,
  selectAtBlinkStart = false,
  align = "start",
  side,
  sideOffset = 3,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  "data-testid": dataTestId,
}: TugPopupMenuProps) {
  const overlayRoot = useCanvasOverlay();

  // Popup-in-sheet z-tier elevation per [D09]. When the menu's React
  // tree is rendered inside a `<TugSheetContent>`, the sheet provides
  // `TugSheetStackingContext` with value `true`; we tag the portaled
  // content so its CSS class swaps to the elevated `--tug-z-overlay-
  // menu-in-dialog` token. Outside any sheet the context is `false`
  // (default) and stacking is unchanged.
  const inDialog = useContext(TugSheetStackingContext);

  // Tracks whether a blink animation is in progress to guard against re-entrant calls.
  const blinkingRef = useRef(false);

  // Open state. Radix Root is bound to this so TugPopupMenu can react to
  // chain-driven dismiss requests without losing any of the built-in
  // trigger/escape/click-outside behavior: those all continue to flow
  // through Radix's internal open handlers back into our setOpen.
  //
  // With no `open` prop the state is internal and the component behaves
  // exactly as it always has. With one, the prop is the source of truth and
  // every transition below reports outward instead of writing local state —
  // the two paths share one `setOpen`, so the focus trap, the observeDispatch
  // subscription, the `openSubKey` reset, and the blink-then-close selection
  // path all read and write the same value in either mode.
  const [openInternal, setOpenInternal] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openInternal;
  // Kept identity-stable through a ref: `openHandle`'s memo and the
  // observeDispatch subscription both capture this, and a fresh function per
  // render would hand them a closure over a stale `onOpenChange`.
  const setOpenImpl = useRef<(next: boolean) => void>(() => {});
  setOpenImpl.current = (next: boolean): void => {
    if (!isControlled) setOpenInternal(next);
    onOpenChange?.(next);
  };
  const setOpen = useCallback((next: boolean): void => {
    setOpenImpl.current(next);
  }, []);

  // Engine focus trap ([P04]): the menu joins the engine model exactly as the
  // popover did, replacing the old service-popup binding. The trap captures the key
  // view + first responder at push (the binding's `captureOnOpen` snapshot), its
  // external-pointerdown observer is the binding's outside-click predicate, and
  // its `onCloseAutoFocus` is the single close-focus DOM writer (the binding's
  // engine-owns / external-defer / restore branches). `onEscapeDismiss` is the
  // controlled close, so the engine's Escape ladder owns the menu's Escape
  // (Radix Escape suppressed below). Menu items register no engine focusables, so
  // the trap's Tab walk is empty for this mode and Radix's arrow-nav/typeahead
  // fall through untouched.
  const { FocusModeScope, onCloseAutoFocus } = useFocusTrap({
    active: open,
    deferDomFocusToTeardown: true,
    onEscapeDismiss: () => setOpen(false),
  });

  // No tooltip opens while this menu stands. [see lib/open-menu-registry]
  useOpenMenuClaim(open);

  // Which sub-menu is currently open, keyed by the entry's render key.
  // `null` means no sub-menu is open. Each `Sub` is controlled against
  // this single value so only one sub-menu shows at a time and it
  // always tracks the hovered sub-trigger — see the "Sub-menu open
  // state is locally controlled" note above.
  const [openSubKey, setOpenSubKey] = useState<string | null>(null);

  // Every close path funnels through `open`, so resetting here covers
  // selection, Escape, click-outside, and chain dismiss alike: a reopen
  // always starts with every sub-menu collapsed.
  useEffect(() => {
    if (!open) setOpenSubKey(null);
  }, [open]);

  // The engine focus trap captures the key view + first responder at push (keyed
  // off `open`), so there is no separate capture-on-open call: flipping `open`
  // drives both Radix and the trap.
  function handleOpenChange(next: boolean): void {
    setOpen(next);
  }

  // Handed to the trigger through context so an engine-routed key view can open
  // the menu by moving the state, not by faking a press on itself.
  const openHandle = React.useMemo<TugPopupMenuTriggerHandle>(
    () => ({ open: () => setOpen(true) }),
    [],
  );

  // Chain manager — null when rendered outside a ResponderChainProvider
  // (standalone previews, unit tests that don't mount a provider). In
  // that case the observeDispatch subscription effect below is a no-op
  // and the menu still opens/closes normally via Radix; it just does
  // not get the chain-reactive dismiss.
  const manager = useResponderChain();

  // Subscribe to observeDispatch while the menu is open. Any action
  // flowing through the chain dismisses the menu, with one exception:
  // the menu's own item activation sets blinkingRef=true for the
  // duration of the blink-animate-then-onSelect window, and the
  // observer skips its close so the menu can finish its animation.
  // Matches the tug-editor-context-menu precedent. Uses
  // useLayoutEffect per [L03] so the subscription is in place before
  // any paint that could deliver a pointer or key event through the
  // chain. [L11]
  useLayoutEffect(() => {
    if (!open || !manager) return;
    return manager.observeDispatch(() => {
      if (blinkingRef.current) return;
      setOpen(false);
    });
  }, [open, manager]);

  function handleItemSelect(id: string, event: Event) {
    // Prevent Radix from immediately closing the menu.
    event.preventDefault();

    if (blinkingRef.current) return;
    blinkingRef.current = true;

    const target = event.currentTarget as HTMLElement;

    // Read the computed accent/orange selection colors for WAAPI keyframes —
    // the flash matches the item's resting highlight so it stays in the
    // selection hue. getPropertyValue() returns a string with leading
    // whitespace per CSS spec; .trim() is required. WAAPI cannot interpolate
    // CSS variable references directly, so we resolve to concrete values. [D01]
    const computed = getComputedStyle(target);
    const blinkBg = computed
      .getPropertyValue("--tug7-surface-selection-primary-normal-selected-hover")
      .trim() || "transparent";
    const blinkFg = computed
      .getPropertyValue("--tug7-element-selection-text-normal-selected-rest")
      .trim() || "inherit";

    // Read the standard easing value at runtime -- WAAPI does not resolve
    // var() references in easing strings. [D01]
    const easing = computed
      .getPropertyValue("--tug-motion-easing-standard")
      .trim() || "cubic-bezier(0.2, 0, 0, 1)";

    // Double-blink keyframes: highlight -> transparent -> highlight -> highlight.
    // Uses the accent/orange selection colors for strong visual feedback. [D01]
    const blinkKeyframes = [
      { backgroundColor: blinkBg, color: blinkFg },
      { backgroundColor: "transparent", color: "inherit" },
      { backgroundColor: blinkBg, color: blinkFg },
      { backgroundColor: blinkBg, color: blinkFg },
    ];

    // Drive blink via TugAnimator; sequence menu close on animate().finished.
    // slow = 350ms. The close path uses the locally controlled open
    // state (setOpen(false)) rather than synthesizing a document-level
    // Escape keydown. blinkingRef stays true from here until the blink
    // settles, across the onSelect call in either timing, so that any chain
    // dispatches issued by the handler (e.g., TugPopupButton's
    // sendToFirstResponderForContinuation) are skipped by the
    // observeDispatch subscription above and do not double-close the
    // menu. [D01]
    //
    // `onSelect` runs at the blink's end by default, or at its start under
    // `selectAtBlinkStart`; the close is at the end either way. A rejected
    // blink (element removed from DOM before it completes) still selects
    // and still closes — otherwise blinkingRef would stay true permanently
    // and all subsequent selections would be silently swallowed.
    void sequencePopupMenuActivation(
      animate(target, blinkKeyframes, {
        duration: "--tug-motion-duration-slow",
        easing,
      }).finished,
      {
        selectAtBlinkStart,
        select: () => onSelect(id),
        finish: () => {
          blinkingRef.current = false;
          setOpen(false);
        },
      },
    );
  }

  /**
   * Render a list of menu entries. Extracted so the same logic handles
   * both top-level content and sub-menu content.
   *
   * `topLevel` marks the root menu. Only root entries steer
   * `openSubKey` on hover: hovering a root sub-trigger opens its
   * sub-menu and hovering a plain root item closes whatever was open.
   * Entries nested inside a sub-menu must not touch `openSubKey` —
   * doing so would close the sub-menu the cursor is currently in.
   */
  function renderEntries(
    entries: TugPopupMenuEntry[],
    keyPrefix: string,
    topLevel: boolean,
  ) {
    return entries.map((entry, idx) => {
      if ("type" in entry && entry.type === "separator") {
        return (
          <DropdownMenuPrimitive.Separator
            key={`${keyPrefix}-sep-${idx}`}
            className="tug-menu-separator"
          />
        );
      }
      if ("type" in entry && entry.type === "label") {
        return (
          <DropdownMenuPrimitive.Label
            key={`${keyPrefix}-label-${idx}`}
            className="tug-menu-label"
          >
            {entry.icon !== undefined && (
              <span className="tug-menu-item-icon" aria-hidden="true">
                {entry.icon}
              </span>
            )}
            {entry.label}
          </DropdownMenuPrimitive.Label>
        );
      }
      if ("type" in entry && entry.type === "sub") {
        const subKey = `${keyPrefix}-sub-${idx}`;
        return (
          <DropdownMenuPrimitive.Sub
            key={subKey}
            open={openSubKey === subKey}
            onOpenChange={(next) => {
              // `next` true: a request to open this sub-menu (hover,
              // click, or ArrowRight). `next` false: a request to
              // close it (ArrowLeft, Escape, or the parent menu
              // closing) — only honored when this sub is the open one.
              setOpenSubKey((cur) =>
                next ? subKey : cur === subKey ? null : cur,
              );
            }}
          >
            <DropdownMenuPrimitive.SubTrigger
              className="tug-menu-item tug-menu-sub-trigger"
              // Switch the open sub-menu the instant the cursor lands,
              // ahead of Radix's pointer-grace heuristic.
              onPointerEnter={() => setOpenSubKey(subKey)}
            >
              {entry.icon !== undefined && (
                <span className="tug-menu-item-icon" aria-hidden="true">
                  {entry.icon}
                </span>
              )}
              <span className="tug-menu-item-label">{entry.label}</span>
              <span className="tug-menu-sub-chevron" aria-hidden="true">
                <ChevronRight size={12} />
              </span>
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal container={overlayRoot}>
              <DropdownMenuPrimitive.SubContent
                className={cn("tug-menu-content", inDialog && "tug-menu-in-dialog")}
                sideOffset={4}
              >
                {renderEntries(entry.items, subKey, false)}
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>
        );
      }
      const item = entry as TugPopupMenuItem;
      return (
        <DropdownMenuPrimitive.Item
          key={item.id}
          className="tug-menu-item"
          data-item-id={item.id}
          disabled={item.disabled}
          onSelect={(event) => handleItemSelect(item.id, event)}
          // Hovering a plain root item dismisses any open sub-menu.
          // Nested items leave `openSubKey` alone — the cursor is
          // inside the sub-menu they belong to.
          onPointerEnter={topLevel ? () => setOpenSubKey(null) : undefined}
          {...(item.selected !== undefined
            ? { role: "menuitemradio", "aria-checked": item.selected }
            : {})}
        >
          {item.selected !== undefined && (
            <span className="tug-menu-item-check" aria-hidden="true">
              {item.selected ? <Check /> : null}
            </span>
          )}
          {item.icon !== undefined && (
            <span className="tug-menu-item-icon" aria-hidden="true">
              {item.icon}
            </span>
          )}
          <span className="tug-menu-item-label">{item.label}</span>
          {item.shortcut !== undefined && (
            <span className="tug-menu-item-shortcut" aria-hidden="true">
              {item.shortcut}
            </span>
          )}
        </DropdownMenuPrimitive.Item>
      );
    });
  }

  return (
    <TugPopupMenuTriggerContext.Provider value={openHandle}>
    <DropdownMenuPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuPrimitive.Trigger asChild>
        {trigger}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={overlayRoot}>
        <DropdownMenuPrimitive.Content
          className={cn("tug-menu-content", inDialog && "tug-menu-in-dialog")}
          align={align}
          {...(side !== undefined ? { side } : {})}
          sideOffset={sideOffset}
          data-testid={dataTestId}
          onCloseAutoFocus={onCloseAutoFocus}
          // [P03] Suppress Radix's own Escape — the engine's Escape ladder owns
          // it via the trap's `onEscapeDismiss` (controlled close).
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <FocusModeScope>{renderEntries(items, "root", true)}</FocusModeScope>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
    </TugPopupMenuTriggerContext.Provider>
  );
}
