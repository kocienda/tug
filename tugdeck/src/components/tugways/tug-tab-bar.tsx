/**
 * TugTabBar — presentational tab strip for multi-tab card hosts.
 *
 * Renders in the TugPane accessory slot when a card has more than one tab.
 * Purely presentational: no DeckManager coupling. Per [L11], TugTabBar is a
 * control, not a responder — it dispatches `selectTab` and `closeTab`
 * actions through the chain, where the enclosing TugPane's responder
 * handles them and updates the store.
 *
 * **Authoritative references:**
 * - [L06] Appearance changes go through CSS and DOM, never React state
 * - [L11] Controls emit actions; responders handle actions
 * - [L16] Every foreground rule declares its rendering surface
 * - [L19] Component authoring guide
 * - [D01] DOM measurement for full widths, fixed constant for icon-only
 * - [D02] Overflow state split across appearance and structural zones
 * - [D03] Tab bar uses the TugPane accessory slot
 * - [D04] Replace overflow-x: auto with overflow-x: hidden
 */

import "./tug-tab-bar.css";
import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cn } from "@/lib/utils";
import { cardTitleStore } from "@/lib/card-title-store";
import { cardTitleTextFor } from "@/lib/pane-title";
import { icons } from "lucide-react";
import type { CardState } from "@/layout-tree";
import { getAllRegistrations } from "@/card-registry";
import { TugButton } from "./internal/tug-button";
import { TugPopupMenu } from "./internal/tug-popup-menu";
import type { TugPopupMenuEntry, TugPopupMenuItem } from "./internal/tug-popup-menu";
import { TugTooltip } from "./tug-tooltip";
import { useControlDispatch } from "./use-control-dispatch";
import { useItemGroupKeyboard } from "./use-item-group-keyboard";
import type { FocusPolicy } from "./focus-manager";
import { cardDragCoordinator, exceedsDragThreshold } from "@/card-drag-coordinator";
import { TUG_ACTIONS } from "./action-vocabulary";
import {
  computeOverflow,
  ICON_ONLY_TAB_WIDTH,
  OVERFLOW_BUTTON_WIDTH,
  type TabMeasurement,
} from "@/tab-overflow";

// ---- Types ----

/**
 * Props for TugTabBar.
 */
export interface TugTabBarProps extends Omit<React.ComponentPropsWithoutRef<"div">, "role"> {
  /** Unique stack / pane instance ID. Stamped as `data-pane-id` on the bar
   *  div so `CardDragCoordinator`'s hit-test cache can locate this bar at drag-start. */
  stackId: string;
  /** All cards in this stack. */
  cards: readonly CardState[];
  /** The currently active card id. */
  activeCardId: string;
  /**
   * Stable opaque sender id for chain dispatches. Auto-derived via `useId()`
   * if omitted. Parent responders disambiguate multi-tab-bar scenarios by
   * matching this id in their `selectTab` / `closeTab` / `addTab` handler
   * bindings. [L11]
   */
  senderId?: string;
  /**
   * Families of card types to show in the [+] type picker.
   * Only registrations whose `family` matches one of these strings appear.
   * Defaults to `["standard"]` when omitted.
   *
   * **Authoritative reference:** [D03] acceptsFamilies field.
   */
  acceptedFamilies?: readonly string[];
  /**
   * Optional callback invoked whenever the overflow state changes.
   * Receives the current overflow stage and the count of overflow tabs.
   * Intended for demo/diagnostic use (e.g., the gallery TugTabBar demo
   * status line). Not required for production tab bar usage.
   */
  onOverflowChange?: (stage: "none" | "collapsed" | "overflow", overflowCount: number) => void;
  /**
   * Whether the trailing `[+]` add-tab button is shown. Defaults to
   * `true` (the card-stack tab bar lets users open new cards). Set to
   * `false` for a **fixed** tab set — e.g. an in-sheet tab bar over a
   * known set of panels — where there is no "add a tab" affordance and
   * no `addTab` dispatch ever fires.
   */
  addable?: boolean;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this tab bar is authored into ([P02]). When set, the bar
   * registers as a **single item-container stop** in the engine's Tab walk: Tab
   * lands the behind-tint on the bar (never a leaf ring on the bar) with the
   * cursor ring on the active tab; arrows move the cursor **and switch the
   * active view live** ([P08] automatic activation), so the cursor rides the
   * active tab. When omitted, the tabs stay plain native focus stops. Supplied
   * by the surface that owns the Tab order (e.g. the enclosing pane).
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /**
   * Walk policy when registered: `accept` (default) is an ordinary Tab stop;
   * `skip` is reachable only in accessibility mode.
   */
  focusPolicy?: FocusPolicy;
}

// ---- Helpers ----

/**
 * Fallback icon name used when a registration does not specify an icon.
 * Ensures all tabs render an icon and can collapse to icon-only mode.
 */
const DEFAULT_TAB_ICON = "Diamond";

/** Render a lucide icon by name, or null if the name is absent or unrecognised.
 *  Shared with the Cards card, whose tool rows wear the same
 *  registration icon a tab does — one resolver, so the two never disagree. */
export function renderIcon(iconName: string | undefined): React.ReactNode {
  const name = iconName ?? DEFAULT_TAB_ICON;
  const IconComponent = icons[name as keyof typeof icons] ?? icons[DEFAULT_TAB_ICON as keyof typeof icons];
  if (!IconComponent) return null;
  return React.createElement(IconComponent, { size: 12 });
}

// ---- useTabOverflow hook ----

/**
 * useTabOverflow -- ResizeObserver-driven tab overflow management.
 *
 * Attaches a ResizeObserver to the tab bar container. On each observation:
 * 1. Guards against mutations during an active drag gesture.
 * 2. Measures tab widths via getBoundingClientRect (appearance-zone reads).
 * 3. Calls computeOverflow() to partition tabs into visible/collapsed/overflow.
 * 4. Applies per-tab data-overflow attributes imperatively via requestAnimationFrame
 *    (appearance-zone writes, no React state) [D02].
 * 5. Updates overflowTabs React state only when the set of overflow IDs
 *    changes (structural-zone change: controls overflow button rendering) [D02].
 *
 * The dependency array for the useLayoutEffect covers:
 * - `tabs.length`: tab add/remove triggers re-measurement.
 * - `activeTabId`: active tab change triggers re-measurement.
 * - `titleKey`: serialised tab titles so a title rename triggers re-measurement.
 *
 * The ResizeObserver handles container resize automatically (card resize,
 * window resize) via its observation of the bar element.
 *
 * ResizeObserver loop is mitigated by requestAnimationFrame write deferral. [L06]
 * Measurement timing is mitigated by useLayoutEffect. [L03]
 *
 * @param barRef    Ref to the tab bar container div.
 * @param cards     Ordered array of cards in the enclosing stack.
 * @param activeCardId ID of the currently active card.
 * @param onOverflowChange Optional callback invoked when overflow stage or count changes.
 * @returns {{ overflowTabs: CardState[] }} Cards currently in the overflow dropdown.
 */
function useTabOverflow(
  barRef: React.RefObject<HTMLDivElement | null>,
  cards: readonly CardState[],
  activeCardId: string,
  onOverflowChange?: (stage: "none" | "collapsed" | "overflow", overflowCount: number) => void,
): { overflowTabs: CardState[] } {
  // overflowTabs is structural-zone state: it controls whether the overflow
  // dropdown button is rendered and what items it contains. [D02]
  const [overflowTabs, setOverflowTabs] = useState<CardState[]>([]);

  // Stable reference to the last overflow tab IDs string, used to avoid
  // unnecessary React state updates when the set hasn't changed.
  const lastOverflowIdsRef = useRef<string>("");

  // Stable reference to the last overflow stage, tracked independently so
  // onOverflowChange fires on stage transitions even when overflowIds stays
  // empty (e.g. "none" → "collapsed": both have overflowIds = []).
  const lastStageRef = useRef<"none" | "collapsed" | "overflow">("none");

  // Stable ref for the onOverflowChange callback so the RAF closure always
  // calls the latest version without needing it in the dependency array.
  const onOverflowChangeRef = useRef(onOverflowChange);
  onOverflowChangeRef.current = onOverflowChange;

  // Stable reference to the pending RAF id, for cancellation on cleanup.
  const rafIdRef = useRef<number | null>(null);

  // Serialised title key for dependency tracking -- triggers re-measurement
  // when any tab title changes. A tab draws its label from `cardTitleStore`
  // whenever the card publishes one (the static `card.title` is just "File" or
  // "Session"), so fold the per-card override in and subscribe to it —
  // otherwise binding a file (label "File" → "foo.py") would widen the tabs
  // without recomputing overflow, leaving them clipped until an unrelated
  // resize.
  //
  // This key is deliberately a superset of what `cardTitleTextFor` reads: the
  // registry titles are already folded in below, so two override-less tabs of
  // different types cannot collide on it. Nothing more is needed here.
  const overrideKey = useSyncExternalStore(cardTitleStore.subscribe, () =>
    cards.map((c) => cardTitleStore.get(c.id) ?? "").join("|"),
  );
  const titleKey = `${cards.map((c) => c.title).join("|")}|${overrideKey}`;

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    /**
     * Core measurement and DOM attribute application logic.
     * Called from the ResizeObserver callback (and immediately on first mount).
     *
     * Reads are synchronous; DOM attribute writes are deferred to RAF
     * to avoid ResizeObserver loop warnings.
     */
    function runOverflow() {
      const barEl = barRef.current;
      if (!barEl) return;

      // Skip recalculation during an active drag gesture.
      if (cardDragCoordinator.isDragging) return;

      // --- Measurements (synchronous reads) ---

      const containerWidth = barEl.getBoundingClientRect().width;

      // Measure the [+] add button width.
      const addBtn = barEl.querySelector<HTMLElement>(".tug-tab-add");
      const addButtonWidth = addBtn ? addBtn.getBoundingClientRect().width : 28;

      // Measure the overflow button width (if already rendered), or use
      // the bootstrap constant for the first computation introducing overflow.
      const overflowBtn = barEl.querySelector<HTMLElement>(".tug-tab-overflow-btn");
      const overflowButtonWidth = overflowBtn
        ? overflowBtn.getBoundingClientRect().width
        : OVERFLOW_BUTTON_WIDTH;

      // Build TabMeasurement array from current DOM state.
      // Temporarily clear any data-overflow attributes so all tabs are
      // rendered at their natural (full) widths for accurate measurement.
      // We re-apply after computeOverflow runs.
      const tabEls = barEl.querySelectorAll<HTMLElement>(".tug-tab");
      const savedOverflow: Array<string | null> = [];

      tabEls.forEach((el) => {
        savedOverflow.push(el.getAttribute("data-overflow"));
        el.removeAttribute("data-overflow");
      });

      // Read full widths now that overflow attributes are cleared.
      const measurements: TabMeasurement[] = [];
      tabEls.forEach((el) => {
        const tabKey = el.getAttribute("data-testid")?.replace("tug-tab-", "") ?? "";
        const fullWidth = el.getBoundingClientRect().width;
        const hasIcon = el.querySelector(".tug-tab-icon") !== null;
        measurements.push({
          id: tabKey,
          fullWidth,
          iconOnlyWidth: hasIcon ? ICON_ONLY_TAB_WIDTH : fullWidth,
          hasIcon,
        });
      });

      // Restore saved overflow attributes before DOM writes.
      tabEls.forEach((el, i) => {
        const saved = savedOverflow[i];
        if (saved !== null) {
          el.setAttribute("data-overflow", saved);
        }
      });

      // --- Computation (pure, no DOM) ---

      const result = computeOverflow(
        measurements,
        containerWidth,
        activeCardId,
        overflowButtonWidth,
        addButtonWidth,
      );

      // --- DOM writes deferred to RAF ---

      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }

      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;

        const barEl2 = barRef.current;
        if (!barEl2) return;

        // Apply data-overflow attribute to each tab element (appearance-zone).
        const tabEls2 = barEl2.querySelectorAll<HTMLElement>(".tug-tab");
        tabEls2.forEach((el) => {
          const tabKey = el.getAttribute("data-testid")?.replace("tug-tab-", "") ?? "";
          if (result.overflowIds.includes(tabKey)) {
            el.setAttribute("data-overflow", "hidden");
          } else if (result.collapsedIds.includes(tabKey)) {
            el.setAttribute("data-overflow", "collapsed");
          } else {
            el.removeAttribute("data-overflow");
          }
        });

        // Apply data-overflow-active on the bar itself (appearance-zone).
        if (result.stage !== "none") {
          barEl2.setAttribute("data-overflow-active", "true");
        } else {
          barEl2.removeAttribute("data-overflow-active");
        }

        // --- Structural-zone and callback updates ---
        //
        // Snapshot previous values before any mutations so comparisons
        // against "what changed" are accurate.
        const prevOverflowIdsKey = lastOverflowIdsRef.current;
        const prevStage = lastStageRef.current;

        const newOverflowIdsKey = result.overflowIds.join(",");
        const newOverflowCount = result.overflowIds.length;

        // Update structural-zone state only when overflow tab IDs change.
        // Joining IDs into a string gives cheap reference equality. [D02]
        if (newOverflowIdsKey !== prevOverflowIdsKey) {
          lastOverflowIdsRef.current = newOverflowIdsKey;

          // Map overflow IDs back to CardState objects, preserving order.
          const overflowCards = result.overflowIds
            .map((id) => cards.find((c) => c.id === id))
            .filter((c): c is CardState => c !== undefined);

          setOverflowTabs(overflowCards);
        }

        // Notify optional observer whenever stage OR overflow count changes.
        //
        // This check is intentionally separate from the overflowIds gate
        // above. The "none" → "collapsed" Stage 1 transition keeps
        // overflowIds = [] in both states, so newOverflowIdsKey stays ""
        // and the gate above never fires for it. Tracking stage in its own
        // ref lets us detect that transition and call onOverflowChange. [D02]
        const prevOverflowCount = prevOverflowIdsKey.split(",").filter(Boolean).length;
        if (result.stage !== prevStage || newOverflowCount !== prevOverflowCount) {
          lastStageRef.current = result.stage;
          onOverflowChangeRef.current?.(result.stage, newOverflowCount);
        }
      });
    }

    // Attach ResizeObserver to the bar element. The observer fires after
    // layout (post-paint), ensuring getBoundingClientRect is accurate.
    // useLayoutEffect guarantees DOM is committed before attach. [L03]
    const observer = new ResizeObserver(() => {
      runOverflow();
    });
    observer.observe(bar);

    // Run immediately for the initial measurement.
    runOverflow();

    return () => {
      observer.disconnect();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length, activeCardId, titleKey]);

  return { overflowTabs };
}

// ---- TabView ----

/**
 * Props for TabView — a single tab rendered inside TugTabBar.
 *
 * Extracted into its own component only so each tab's TugTooltip has a
 * stable cloned-child path; TabView holds no React state of its own.
 */
interface TabViewProps {
  tab: CardState;
  isActive: boolean;
  iconNode: React.ReactNode;
  stackId: string;
  totalTabs: number;
  onSelect: (cardId: string) => void;
  onClose: (cardId: string) => void;
}

/**
 * Suppress predicate for the tab's TugTooltip.
 *
 * Returns true (suppress open) unless the tab is currently iconified
 * (data-overflow="collapsed"). Reads the live DOM attribute set
 * imperatively by useTabOverflow, so the tooltip decision follows the
 * appearance-zone state without any React state. [L06]
 */
function suppressTabTooltip(trigger: Element): boolean {
  return trigger.getAttribute("data-overflow") !== "collapsed";
}

/** Max visible tab-title length before center truncation. */
export const TAB_TITLE_MAX = 24;

/**
 * Middle-truncate `s` to at most `max` chars, keeping the head and tail
 * with an ellipsis between (so a file's extension stays visible). BBEdit
 * truncates document tabs the same way.
 */
export function centerTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/**
 * TabView -- single tab button. Renders inside a TugTooltip whose
 * `suppressOpen` predicate gates opening on the live `data-overflow`
 * attribute: the tooltip only surfaces when the tab has been collapsed
 * to icon-only. No React state is introduced — the gate reads the DOM
 * attribute set by useTabOverflow at open-transition time. [L06]
 */
function TabView({
  tab,
  isActive,
  iconNode,
  stackId,
  totalTabs,
  onSelect,
  onClose,
}: TabViewProps) {
  // A card with a name of its own publishes it through `cardTitleStore` — a
  // Text card's basename, a Session card's `project/callsign` — and the tab
  // wears that name rather than the static registry title. Composed through
  // `cardTitleTextFor` so the tab strip and the title bar cannot name the same
  // card differently; the old `componentId === "text"` gate is what made a
  // stacked Session card's tab read the literal word "Session".
  //
  // Subscribed rather than read: the override lands after the card resolves
  // its identity, and a bare read would leave the tab on "Session" forever.
  const label = useSyncExternalStore(
    cardTitleStore.subscribe,
    useCallback(
      () => cardTitleTextFor(tab.id, tab.title),
      [tab.id, tab.title],
    ),
  );
  const fullTitle = label;
  const displayTitle = centerTruncate(fullTitle, TAB_TITLE_MAX);

  const handleTabClick = () => {
    onSelect(tab.id);
  };

  const handleCloseClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    // Stop propagation so the close click does not trigger tab select.
    event.stopPropagation();
    onClose(tab.id);
  };

  /**
   * Drag initiation with 5px threshold. [D01]
   *
   * On pointerdown: register document-level pointermove/pointerup to
   * track movement without acquiring pointer capture. This preserves the
   * normal click sequence for sub-threshold interactions.
   *
   * On first pointermove exceeding 5px: remove document-level listeners
   * and hand off to cardDragCoordinator.startDrag(), which acquires
   * pointer capture on the tab element.
   *
   * On pointerup before threshold: remove document-level listeners so
   * the normal onClick fires unimpeded.
   */
  const handleTabPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    // Drag-start focus save. Fires
    // unconditionally — even sub-threshold clicks save, since saves
    // are cheap and the symmetric "save-at-gesture-start" contract
    // is what eliminates the cross-pane drag focus race. The
    // coordinator looks up the pane's currently-active card and
    // routes to `captureFocusForDragStart`, preserving `bag.focus`
    // and `bag.domSelection` before the browser's mousedown default
    // blurs the focused element.
    cardDragCoordinator.notifyPotentialDragStart(stackId);

    const nativeEvent = event.nativeEvent;
    const tabElement = event.currentTarget;
    const startX = nativeEvent.clientX;
    const startY = nativeEvent.clientY;

    function onDocumentMove(e: PointerEvent) {
      if (exceedsDragThreshold(startX, startY, e.clientX, e.clientY)) {
        cleanup();
        cardDragCoordinator.startDrag(e, tabElement, stackId, tab.id, totalTabs);
      }
    }

    function onDocumentUp() {
      cleanup();
    }

    function cleanup() {
      document.removeEventListener("pointermove", onDocumentMove);
      document.removeEventListener("pointerup", onDocumentUp);
    }

    document.addEventListener("pointermove", onDocumentMove);
    document.addEventListener("pointerup", onDocumentUp);
  };

  return (
    <TugTooltip content={fullTitle} suppressOpen={suppressTabTooltip}>
      <div
        role="tab"
        className="tug-tab"
        data-active={isActive ? "true" : undefined}
        data-testid={`tug-tab-${tab.id}`}
        aria-selected={isActive}
        tabIndex={-1}
        onClick={handleTabClick}
        onPointerDown={handleTabPointerDown}
        data-tug-focus="refuse"
      >
        {iconNode !== null && (
          <span className="tug-tab-icon" aria-hidden="true">
            {iconNode}
          </span>
        )}
        <span className="tug-tab-title">{displayTitle}</span>
        {tab.closable && (
          <button
            type="button"
            className="tug-tab-close"
            onClick={handleCloseClick}
            data-tug-focus="refuse"
            aria-label={`Close ${fullTitle} tab`}
            data-testid={`tug-tab-close-${tab.id}`}
          >
            ×
          </button>
        )}
      </div>
    </TugTooltip>
  );
}

// ---- TugTabBar ----

/**
 * TugTabBar -- horizontal tab strip component.
 *
 * Renders each tab as a button with an optional icon and title.
 * The active tab has `data-active="true"` set for CSS targeting.
 * A [+] button at the end opens a TugPopupMenu type picker listing all
 * registered card types; selecting one dispatches an `addTab` action
 * through the responder chain with the chosen componentId as the
 * payload. The enclosing TugPane's responder handles the dispatch.
 *
 * Overflow handling is provided by the `useTabOverflow` hook, which attaches
 * a ResizeObserver to the bar container and applies data-overflow attributes
 * imperatively (appearance-zone). The overflow dropdown button is rendered
 * conditionally based on `overflowTabs` React state (structural-zone). [D02]
 *
 * Tab drag initiation uses a 5px threshold pattern: onPointerDown registers
 * document-level listeners to track movement without acquiring pointer capture.
 * Once the threshold is exceeded, document-level listeners are removed and
 * `cardDragCoordinator.startDrag()` is called, which acquires pointer capture
 * and takes over the drag gesture. Sub-threshold pointer moves do not
 * interfere with the click event sequence, so click-to-select still works.
 * [D01]
 *
 * All interactive elements have `user-select: none` (enforced in CSS).
 * All appearance changes go through CSS `data-active` attribute, never React state. [L06]
 */
export const TugTabBar = React.forwardRef<HTMLDivElement, TugTabBarProps>(function TugTabBar(
  {
    stackId,
    cards,
    activeCardId,
    senderId,
    acceptedFamilies,
    onOverflowChange,
    addable = true,
    focusGroup,
    focusOrder = 0,
    focusPolicy,
    className,
    ...rest
  }: TugTabBarProps,
  ref,
) {
  // Chain dispatch [L11]: targeted dispatch of tab select/close/add
  // actions to the parent responder. The enclosing card's responder
  // handles them by matching `event.sender` against this tab bar's
  // senderId. Outside a provider the dispatch is a no-op.
  const { dispatch: controlDispatch } = useControlDispatch();
  const fallbackSenderId = useId();
  const effectiveSenderId = senderId ?? fallbackSenderId;
  const dispatchSelectTab = useCallback(
    (cardId: string) => {
      controlDispatch({
        action: TUG_ACTIONS.SELECT_TAB,
        value: cardId,
        sender: effectiveSenderId,
        phase: "discrete",
      });
    },
    [controlDispatch, effectiveSenderId],
  );
  const dispatchCloseTab = useCallback(
    (cardId: string) => {
      controlDispatch({
        action: TUG_ACTIONS.CLOSE_TAB,
        value: cardId,
        sender: effectiveSenderId,
        phase: "discrete",
      });
    },
    [controlDispatch, effectiveSenderId],
  );
  const dispatchAddTab = useCallback(
    (componentId: string) => {
      controlDispatch({
        action: TUG_ACTIONS.ADD_TAB,
        value: componentId,
        sender: effectiveSenderId,
        phase: "discrete",
      });
    },
    [controlDispatch, effectiveSenderId],
  );
  // Ref for the tab bar container, used by useTabOverflow. [D02]
  const barRef = useRef<HTMLDivElement>(null);

  // Holds the engine focusable's root-ref callback (assigned after the keyboard
  // hook below) so `setRefs` — defined before the hook — can forward to it.
  const attachRootRef = useRef<((el: HTMLElement | null) => void) | null>(null);

  // Merge the forwarded ref with the internal barRef and the engine focusable
  // ref (so the bar root carries `data-tug-focusable` and wears the ring).
  const setRefs = (el: HTMLDivElement | null) => {
    (barRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    attachRootRef.current?.(el);
    if (typeof ref === "function") {
      ref(el);
    } else if (ref) {
      (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }
  };

  // Overflow hook: attaches ResizeObserver, applies appearance-zone DOM
  // attributes, returns structural-zone overflowTabs for dropdown rendering.
  const { overflowTabs } = useTabOverflow(barRef, cards, activeCardId, onOverflowChange);

  // ---- Item-container keyboard ([P01], [P03]) — live commit ----
  //
  // The bar is a single stop in the engine Tab walk; the bar wears the
  // behind-tint and a movement cursor traverses the visible tabs under the
  // arrows. The tab bar is a **view switcher**, so it **commits live** ([P08],
  // the ARIA-tabs "automatic activation" pattern): every arrow move switches the
  // active view as the cursor lands, so the cursor always rides the active tab —
  // you see the tab you move to, never a cursor stranded on an un-shown tab.
  // Space/Enter re-affirm the current tab. One focusable id for the whole bar.
  const autoFocusId = useId();

  // Card id carried by a tab element (via its `data-testid`).
  const cardIdOf = useCallback(
    (el: Element | null): string =>
      el?.getAttribute("data-testid")?.slice("tug-tab-".length) ?? "",
    [],
  );

  // Visible (non-overflow) tab elements, in DOM order — the cursor's range.
  const visibleTabEls = useCallback((): HTMLElement[] => {
    const bar = barRef.current;
    if (!bar) return [];
    return Array.from(bar.querySelectorAll<HTMLElement>(".tug-tab")).filter(
      (t) => t.getAttribute("data-overflow") !== "hidden",
    );
  }, []);

  const { attachRoot, onKeyDown, syncItems, setCursor } = useItemGroupKeyboard({
    id: autoFocusId,
    group: focusGroup ?? "",
    order: focusOrder,
    policy: focusPolicy,
    register: focusGroup !== undefined,
    commit: "live",
    collectItems: visibleTabEls,
    initialIndex: () => {
      const i = visibleTabEls().findIndex((el) => cardIdOf(el) === activeCardId);
      return i >= 0 ? i : 0;
    },
    // Live ([P08]): every arrow move switches the active view; Space/Enter
    // re-affirm the current tab.
    onMove: (element) => {
      const id = cardIdOf(element);
      if (id) dispatchSelectTab(id);
    },
    onSelect: (element) => {
      const id = cardIdOf(element);
      if (id) dispatchSelectTab(id);
    },
  });
  attachRootRef.current = attachRoot;

  // Keep the cursor's range current as tabs and the active view change.
  useLayoutEffect(() => {
    syncItems();
  }, [cards.length, activeCardId, syncItems]);

  // Click selects the tab and parks the cursor on it (so a following arrow
  // continues from the clicked tab).
  const handleSelectTab = useCallback(
    (cardId: string) => {
      const idx = visibleTabEls().findIndex((el) => cardIdOf(el) === cardId);
      if (idx >= 0) setCursor(idx);
      dispatchSelectTab(cardId);
    },
    [visibleTabEls, cardIdOf, setCursor, dispatchSelectTab],
  );

  // Resolve effective families: default to ["standard"] when prop is omitted.
  const effectiveFamilies = acceptedFamilies ?? ["standard"];

  // Build the type-picker dropdown entries from registered card types,
  // filtered by family. A registration with no `family` field is treated as
  // "standard" (default family). Only registrations whose family is in
  // effectiveFamilies are shown. Items are organized into sub-menus by
  // category so the top-level menu stays compact.
  const typePickerItems: TugPopupMenuEntry[] = (() => {
    const regs = Array.from(getAllRegistrations().values())
      .filter((reg) => effectiveFamilies.includes(reg.family ?? "standard"))
      // `hidden` registrations stay in the registry (seedable by app-tests,
      // resolvable by id) but never appear in the human-facing [+] menu.
      .filter((reg) => reg.hidden !== true);

    // Group registrations by their declared `category` (see
    // CardRegistration.category in card-registry.ts). Sections and items
    // are sorted alphabetically by label — registration order in the
    // source file has no effect on menu placement. Registrations without
    // a category fall through at the end as top-level items, also sorted.
    //
    // TugTabBar has no knowledge of which categories exist — grouping data
    // lives on the registration, not in this component.
    const sections = new Map<
      string,
      { label: string; iconName: string | undefined; items: TugPopupMenuItem[] }
    >();
    const ungrouped: TugPopupMenuItem[] = [];

    for (const reg of regs) {
      const item: TugPopupMenuItem = {
        id: reg.componentId,
        label: reg.defaultMeta.title,
        icon: renderIcon(reg.defaultMeta.icon),
      };
      if (!reg.category) {
        ungrouped.push(item);
        continue;
      }
      const key = reg.category.label;
      let section = sections.get(key);
      if (!section) {
        section = { label: reg.category.label, iconName: reg.category.icon, items: [] };
        sections.set(key, section);
      }
      section.items.push(item);
    }

    const sortedSections = Array.from(sections.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    for (const section of sortedSections) {
      section.items.sort((a, b) => a.label.localeCompare(b.label));
    }
    ungrouped.sort((a, b) => a.label.localeCompare(b.label));

    const entries: TugPopupMenuEntry[] = [];
    for (const section of sortedSections) {
      entries.push({
        type: "sub",
        label: section.label,
        icon: renderIcon(section.iconName),
        items: section.items,
      });
    }
    if (ungrouped.length > 0) {
      if (entries.length > 0) entries.push({ type: "separator" });
      for (const item of ungrouped) entries.push(item);
    }

    return entries;
  })();

  // Build overflow dropdown items from overflowTabs (icon + label each). [D07]
  // Same rule as the visible tabs: a card that publishes a name of its own
  // wears it, whatever its type. The menu is rebuilt on every render of this
  // bar, which `overrideKey` already subscribes to.
  const overflowDropdownItems: TugPopupMenuItem[] = overflowTabs.map((tab) => {
    const iconName = getAllRegistrations().get(tab.componentId)?.defaultMeta.icon;
    return {
      id: tab.id,
      label: centerTruncate(cardTitleTextFor(tab.id, tab.title), TAB_TITLE_MAX),
      icon: renderIcon(iconName),
    };
  });

  // Stable handler for [+] button type picker selection.
  // Dispatches `addTab` through the chain; TugPane's responder handles
  // it by calling `store.addCardToPane(paneId, componentId)`. [L11, A2.5]
  const handleTypeSelect = useCallback(
    (componentId: string) => {
      dispatchAddTab(componentId);
    },
    [dispatchAddTab],
  );

  // Handler for selecting a tab from the overflow dropdown. [D05]
  // Dispatches `selectTab` through the responder chain; the enclosing
  // card's responder updates activeTabId, triggering re-render, and the
  // ResizeObserver recomputes overflow with the new active tab visible.
  const handleOverflowSelect = useCallback(
    (cardId: string) => {
      dispatchSelectTab(cardId);
    },
    [dispatchSelectTab],
  );

  return (
    <div
      ref={setRefs}
      className={cn("tug-tab-bar", className)}
      role="tablist"
      data-slot="tug-tab-bar"
      data-testid="tug-tab-bar"
      data-pane-id={stackId}
      tabIndex={focusGroup !== undefined ? 0 : undefined}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {cards.map((card) => {
        // A per-card icon override wins over the componentId's registry
        // default — lets fixed tab sets that share one sentinel
        // componentId give each tab a distinct icon.
        const iconName =
          card.icon ?? getAllRegistrations().get(card.componentId)?.defaultMeta.icon;
        const iconNode = renderIcon(iconName);
        return (
          <TabView
            key={card.id}
            tab={card}
            isActive={card.id === activeCardId}
            iconNode={iconNode}
            stackId={stackId}
            totalTabs={cards.length}
            onSelect={handleSelectTab}
            onClose={dispatchCloseTab}
          />
        );
      })}

      {/* Overflow popup menu -- rendered only when tabs overflow [D07, D08].
          Placed between the last visible tab and the [+] button.
          Trigger is a ghost-option TugButton with no chevron. [D07] */}
      {overflowTabs.length > 0 && (
        <TugPopupMenu
          trigger={
            <TugButton
              emphasis="ghost"
              role="option"
              size="sm"
              className="tug-tab-overflow-btn"
              aria-label={`${overflowTabs.length} more tabs`}
              data-testid="tug-tab-overflow-btn"
            >
              <span className="tug-tab-overflow-badge">+{overflowTabs.length}</span>
            </TugButton>
          }
          items={overflowDropdownItems}
          onSelect={handleOverflowSelect}
        />
      )}

      {/* [+] type picker button -- always rightmost [D07, D08].
          Trigger is a ghost-option TugButton with no chevron. [D07].
          Suppressed for a fixed tab set (`addable={false}`). */}
      {addable && (
        <TugPopupMenu
          trigger={
            <TugButton
              emphasis="ghost"
              role="option"
              size="sm"
              className="tug-tab-add"
              aria-label="Add tab"
              data-testid="tug-tab-add"
            >
              +
            </TugButton>
          }
          items={typePickerItems}
          onSelect={handleTypeSelect}
        />
      )}
    </div>
  );
});
