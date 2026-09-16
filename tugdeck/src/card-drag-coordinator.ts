/**
 * CardDragCoordinator -- module-scope singleton managing tab drag gestures.
 *
 * Handles the full drag lifecycle: initiation (via startDrag called from
 * TugTabBar's onPointerDown handler), RAF-throttled pointer move tracking,
 * hit-testing, visual feedback (ghost tab, insertion indicator,
 * drop-target highlights), and drop commit to DeckManager.
 *
 * All appearance mutations during drag go through direct DOM manipulation --
 * never through React state (Rule 4, [D08, D09]).
 *
 * **Authoritative references:**
 * - [D01] Pointer capture on tab div
 * - [D02] Ghost tab as imperatively-created canvas child
 * - [D03] Appearance-zone mutations during drag, structure-zone commit on drop
 * - [D04] Detach threshold = source bar bounding rect exit
 * - [D05] Single-tab card drop zone preview
 * - [D06] Last tab cannot be detached
 * - [D07] Coordinator is a module-scope singleton
 */

import type { IDeckManagerStore } from "./deck-manager-store";
import { SHOWN_PANE_FRAMES } from "./components/chrome/space-layer";
import {
  captureFocusForDragStart,
  transferFocusAfterMove,
} from "./focus-transfer";

// ---- Constants ----

/**
 * Z-index for the ghost tab element.
 * Above GALLERY_ZINDEX (1000), below DisconnectBanner (9999).
 * [D02]
 */
export const GHOST_TAB_ZINDEX = 5000;

/**
 * CSS selector for visible tab elements within a tab bar.
 *
 * Excludes tabs with `data-overflow="hidden"` (tabs in the overflow dropdown),
 * because hidden tabs have `display: none` and return zero-width bounding rects
 * from `getBoundingClientRect()`, which would corrupt midpoint calculations and
 * produce wrong insertion indices during drag.
 *
 * When no tabs have `data-overflow="hidden"` (i.e., overflow is inactive),
 * this selector matches the same set as `.tug-tab`, so it is backward-compatible.
 *
 * [D07] CardDragCoordinator selectors exclude hidden overflow tabs
 */
export const VISIBLE_TAB_SELECTOR = '.tug-tab:not([data-overflow="hidden"])';

/** Drag threshold in pixels before drag initiates (from startDrag entry). */
const DRAG_THRESHOLD_PX = 5;

// ---- Internal types ----

interface TabBarEntry {
  paneId: string;
  rect: DOMRect;
  barElement: HTMLElement;
}

interface PaneFrameEntry {
  paneId: string;
  rect: DOMRect;
  accessoryElement: HTMLElement;
}

type DragMode = "reorder" | "detach" | "merge";

// ---- CardDragCoordinator class ----

/**
 * Manages the full lifecycle of a tab drag gesture.
 *
 * Usage:
 *   1. Call `cardDragCoordinator.init(store)` once when DeckCanvas mounts.
 *   2. TugTabBar's onPointerDown handler calls `cardDragCoordinator.startDrag(...)`
 *      after the 5px threshold is exceeded and pointer capture is acquired.
 *
 * [D07] Singleton -- not a React component, not a hook.
 */
class CardDragCoordinator {
  // ---- Store reference (set once via init) ----
  private store: IDeckManagerStore | null = null;

  // ---- Per-drag state (valid only while dragActive is true) ----
  private dragActive: boolean = false;
  private sourcePaneId: string = "";
  private sourceCardId: string = "";
  private sourceTabElement: HTMLElement | null = null;
  private capturedPointerId: number = -1;

  /** Cached bounding rect of the source tab bar. */
  private sourceBarRect: DOMRect | null = null;

  /** Cached bounding rect of #deck-container for coordinate conversion. */
  private containerRect: DOMRect | null = null;

  /** Where within the tab the pointer was grabbed (for ghost offset). */
  private grabOffsetX: number = 0;
  private grabOffsetY: number = 0;

  /** All visible multi-tab bar rects at drag-start (excluding source card). */
  private allTabBarRects: TabBarEntry[] = [];

  /**
   * All single-tab pane frame rects at drag-start.
   * These are `.tug-pane` frames whose pane id is NOT in allTabBarRects.
   */
  private allPaneFrameRects: PaneFrameEntry[] = [];

  /** Ghost element appended to #deck-container during drag. */
  private ghostElement: HTMLDivElement | null = null;

  /** Insertion indicator injected into the active tab bar during drag. */
  private indicatorElement: HTMLDivElement | null = null;

  /** The tab bar element currently hosting the indicator. */
  private indicatorBarElement: HTMLElement | null = null;

  /** Current drag mode determined by pointer position. */
  private currentMode: DragMode = "reorder";

  /** Insertion index for reorder or merge modes. */
  private currentReorderIndex: number = 0;

  /** Current merge target, or null when not in merge mode. */
  private currentMergeTarget: { paneId: string; insertIndex: number } | null = null;

  /**
   * The element currently highlighted as a drop target.
   * Cleared on pointer move when target changes.
   */
  private currentDropTargetElement: HTMLElement | null = null;

  // ---- RAF throttle ----
  private rafId: number | null = null;
  private latestPointerX: number = 0;
  private latestPointerY: number = 0;

  // ---- Bound handlers (stable references for addEventListener/removeEventListener) ----
  private boundOnPointerMove: (e: PointerEvent) => void;
  private boundOnPointerUp: (e: PointerEvent) => void;
  private boundOnPointerCancel: () => void;
  private boundOnDocumentKeydown: (e: KeyboardEvent) => void;

  constructor() {
    this.boundOnPointerMove = this.onPointerMove.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
    this.boundOnPointerCancel = this.onPointerCancel.bind(this);
    this.boundOnDocumentKeydown = this.onDocumentKeydown.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Initialize with store reference. Called once from DeckCanvas useEffect.
   * Safe to call multiple times -- only updates the stored reference.
   */
  init(store: IDeckManagerStore): void {
    this.store = store;
  }

  /**
   * Whether a tab drag is currently in progress.
   *
   * Used by the `useTabOverflow` hook to skip overflow recalculation while
   * a drag gesture is active, preventing DOM attribute mutations on elements
   * the coordinator is actively manipulating.
   */
  get isDragging(): boolean {
    return this.dragActive;
  }

  /**
   * Notify the coordinator that a tab pointerdown has fired and the
   * gesture *may* escalate to a drag past the 5px threshold. Called
   * unconditionally from `tug-tab-bar.tsx#handleTabPointerDown` —
   * even sub-threshold clicks fire it, since saves are cheap and the
   * symmetric "save-at-gesture-start" contract is what eliminates
   * the cross-pane drag focus race.
   *
   * Internally invokes
   * {@link captureFocusForDragStart} for the pane's currently-active
   * card so the active card's `bag.focus` and `bag.domSelection` are
   * captured before the browser's mousedown default has a chance to
   * blur the focused element.
   *
   * Routed through this method (rather than calling
   * `captureFocusForDragStart` directly from `TugTabBar`) so the
   * tab-bar component stays decoupled from the deck store at the
   * import level — `cardDragCoordinator` is already its single
   * coordination dependency.
   *
   */
  notifyPotentialDragStart(paneId: string): void {
    const store = this.store;
    if (!store) return;
    const pane = store.getSnapshot().panes.find((p) => p.id === paneId);
    if (!pane) return;
    captureFocusForDragStart({ sourceCardId: pane.activeCardId, store });
  }

  /**
   * Start a tab drag. Called from TugTabBar's onPointerDown handler after
   * the 5px threshold has been exceeded and pointer capture should be applied.
   *
   * Guards against single-tab cards ([D06]).
   *
   * @param event - The native PointerEvent that triggered the drag
   * @param tabElement - The DOM element of the dragged tab div
   * @param paneId - The source pane id
   * @param cardId - The card being dragged
   * @param cardCount - Number of cards in the source pane
   */
  startDrag(
    event: PointerEvent,
    tabElement: HTMLElement,
    paneId: string,
    cardId: string,
    cardCount: number,
  ): void {
    // [D06] Guard: single-card windows cannot be dragged (multi-tab bar only).
    if (cardCount <= 1) return;
    if (!this.store) return;

    // Cancel any in-progress drag (safety).
    if (this.dragActive) {
      this.cleanup();
    }

    this.dragActive = true;
    this.sourcePaneId = paneId;
    this.sourceCardId = cardId;
    this.sourceTabElement = tabElement;
    this.capturedPointerId = event.pointerId;

    // Apply pointer capture on the tab element. [D01]
    tabElement.setPointerCapture(event.pointerId);

    // Cache container rect for ghost coordinate conversion. [D02]
    const container = document.getElementById("deck-container");
    this.containerRect = container?.getBoundingClientRect() ?? null;

    // Cache source bar rect for detach threshold detection. [D04]
    const sourceBar = tabElement.closest(".tug-tab-bar") as HTMLElement | null;
    this.sourceBarRect = sourceBar?.getBoundingClientRect() ?? null;

    // Compute grab offset: pointer position within the tab element at drag start. []
    const tabRect = tabElement.getBoundingClientRect();
    this.grabOffsetX = event.clientX - tabRect.left;
    this.grabOffsetY = event.clientY - tabRect.top;

    // Build two-tier hit-test cache. []
    this.buildHitTestCache(paneId);

    // Create ghost element. [D02]
    this.ghostElement = this.createGhost(tabElement, event.clientX, event.clientY);
    if (container && this.ghostElement) {
      container.appendChild(this.ghostElement);
    }

    // Dim the source tab during drag. [D03]
    tabElement.setAttribute("data-dragging", "true");

    // Register element-level listeners on the tab element (pointer capture
    // routes all events here regardless of position). [D01]
    // pointercancel uses a separate handler that cancels silently without
    // committing any DeckManager action.
    tabElement.addEventListener("pointermove", this.boundOnPointerMove);
    tabElement.addEventListener("pointerup", this.boundOnPointerUp);
    tabElement.addEventListener("pointercancel", this.boundOnPointerCancel);

    // Document-level Escape listener (cancels drag; capture phase).
    // Capture phase so the cancel decision lands before any nested
    // dialog or popover keydown handler can consume the event. The
    // listener lives only for the drag's lifetime (cleanup removes
    // it) so it cannot leak across gestures.
    //
    // Substrate-local, not a command: this Escape is part of a pointer
    // gesture — take-back for a drag that is in the user's hand right now —
    // and it exists only while that hand is down. A registry binding would be
    // a durable claim on the chord for a claim that lasts a few hundred
    // milliseconds, and `resolveChord` would have to report a chord that is
    // taken only mid-drag, which is not a fact the keymap models.
    document.addEventListener("keydown", this.boundOnDocumentKeydown, true);

    // Snapshot initial position for RAF frame.
    this.latestPointerX = event.clientX;
    this.latestPointerY = event.clientY;

    // Initial mode: we are inside the source bar.
    this.currentMode = "reorder";
    this.currentMergeTarget = null;

    // Compute initial reorder insertion index so indicator appears immediately.
    if (sourceBar) {
      this.currentReorderIndex = this.computeReorderIndex(sourceBar, event.clientX);
      this.updateInsertionIndicator(sourceBar, this.currentReorderIndex);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Hit-test cache
  // ---------------------------------------------------------------------------

  /**
   * Build the two-tier hit-test cache at drag-start.
   *
   * Tier 1: allTabBarRects -- all visible .tug-tab-bar[data-pane-id] elements
   *   excluding the source card.
   * Tier 2: allPaneFrameRects -- all .tug-pane[data-pane-id] elements whose
   *   pane id is NOT present in allTabBarRects (i.e., single-tab panes).
   *   The accessoryElement is the matching .tug-pane-accessory[data-pane-id]
   *   inside each such pane frame, used for drop-target visual feedback.
   *
   * []
   */
  private buildHitTestCache(sourcePaneId: string): void {
    // Tier 1: multi-card tab bars (excluding source pane).
    const barElements = document.querySelectorAll<HTMLElement>(".tug-tab-bar[data-pane-id]");
    const tabBarPaneIds = new Set<string>();
    this.allTabBarRects = [];

    barElements.forEach((el) => {
      const paneId = el.getAttribute("data-pane-id");
      if (!paneId || paneId === sourcePaneId) return;
      tabBarPaneIds.add(paneId);
      this.allTabBarRects.push({
        paneId,
        rect: el.getBoundingClientRect(),
        barElement: el,
      });
    });

    // Tier 2: single-card frames (not in the tab bar set).
    const frameElements = document.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES);
    this.allPaneFrameRects = [];

    frameElements.forEach((el) => {
      const paneId = el.getAttribute("data-pane-id");
      if (!paneId || paneId === sourcePaneId || tabBarPaneIds.has(paneId)) return;

      // Resolve the accessory div for drop-target visual feedback. [D05]
      const accessory = el.querySelector<HTMLElement>(`.tug-pane-accessory[data-pane-id="${paneId}"]`);
      if (!accessory) return;

      this.allPaneFrameRects.push({
        paneId,
        rect: el.getBoundingClientRect(),
        accessoryElement: accessory,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Private: Pointer event handlers
  // ---------------------------------------------------------------------------

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragActive) return;
    this.latestPointerX = e.clientX;
    this.latestPointerY = e.clientY;

    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.applyDragFrame();
      });
    }
  }

  private applyDragFrame(): void {
    if (!this.dragActive) return;

    const cx = this.latestPointerX;
    const cy = this.latestPointerY;

    // Update ghost position. [D02]
    this.updateGhostPosition(cx, cy);

    // Determine drag mode from pointer position relative to cached rects.
    this.updateDragMode(cx, cy);
  }

  /**
   * Handle pointercancel: silently cancel the drag without committing any
   * DeckManager action. This differs from onPointerUp, which commits the drop.
   *
   * pointercancel fires when the browser takes over the pointer (e.g., scroll
   * takeover, system gesture, or touch cancellation). The correct response is
   * to return the UI to its pre-drag state as if the drag never happened.
   * [D03] -- no structure-zone commit on cancel.
   */
  private onPointerCancel(): void {
    if (!this.dragActive) return;

    // Cancel any pending RAF frame.
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // Snapshot before cleanup so the post-cleanup refocus knows
    // which card to target.
    const sourceCardId = this.sourceCardId;

    // cleanup() removes all visual artifacts and listeners; no DeckManager call.
    this.cleanup();

    // Refocus into the dragged card's pre-drag DOM location
    // The card never moved (no commit
    // ran), so its CardHost is still mounted under the original
    // pane and the registered host root resolves correctly. The
    // drag-start save preserved bag.focus / bag.domSelection so
    // the helper can restore them.
    this.fireDragCancel(sourceCardId);
  }

  /**
   * Document-level keydown handler installed for the drag's
   * lifetime. On Escape, runs the same
   * cancel sequence as pointercancel: cleanup-without-commit, then
   * refocus into the original DOM location.
   *
   * Capture phase so the cancel decision lands before any nested
   * dialog / popover / responder-chain keydown handler can consume
   * the event. Other keys are ignored.
   */
  private onDocumentKeydown(event: KeyboardEvent): void {
    if (!this.dragActive) return;
    if (event.key !== "Escape") return;

    // Cancel any pending RAF frame.
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    const sourceCardId = this.sourceCardId;
    this.cleanup();
    this.fireDragCancel(sourceCardId);
  }

  /**
   * Refocus into the dragged card's original DOM location after a
   * cancel (Escape or pointercancel). No-op when no store is bound
   * or when `cardId` is empty (defensive — `cleanup()` empties the
   * id field, so callers must snapshot before cleanup).
   *
   * Routed through {@link transferFocusAfterMove} for symmetry with
   * the post-drop refocus path: same resolve / gate / focus +
   * restore logic, just with no preceding mutation.
   */
  private fireDragCancel(cardId: string): void {
    if (!this.store) return;
    if (cardId === "") return;
    transferFocusAfterMove({ sourceCardId: cardId, store: this.store });
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragActive) return;

    // Cancel any pending RAF frame.
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // Snapshot final state before cleanup.
    const mode = this.currentMode;
    const sourcePaneId = this.sourcePaneId;
    const sourceCardId = this.sourceCardId;
    const reorderIndex = this.currentReorderIndex;
    const mergeTarget = this.currentMergeTarget;
    const dropX = e.clientX;
    const dropY = e.clientY;
    const containerRect = this.containerRect;

    // Cleanup-before-commit ordering. [D03]:
    // (1) Remove listeners, (2) release capture, (3) clean visual elements,
    // (4) THEN commit to DeckManager. This prevents stale event routing if
    // React synchronously unmounts the tab element during notify().
    this.cleanup();

    // Commit the drop to DeckManager. [D03]
    const store = this.store;
    if (!store) return;

    if (mode === "reorder") {
      // Find the original index of the dragged card in the source stack.
      const snapshot = store.getSnapshot();
      const sourcePane = snapshot.panes.find((s) => s.id === sourcePaneId);
      if (sourcePane) {
        const fromIndex = sourcePane.cardIds.indexOf(sourceCardId);
        if (fromIndex !== -1 && fromIndex !== reorderIndex) {
          // When dropping after the source position, the effective toIndex is
          // reorderIndex - 1 because removing fromIndex shifts items left.
          let toIndex = reorderIndex;
          if (reorderIndex > fromIndex) {
            toIndex = reorderIndex - 1;
          }
          store.reorderCardInPane(sourcePaneId, fromIndex, toIndex);
        }
      }
    } else if (mode === "detach") {
      // Convert viewport drop coordinates to container-relative position. []
      let x = dropX;
      let y = dropY;
      if (containerRect) {
        x = dropX - containerRect.left;
        y = dropY - containerRect.top;
      }
      store.detachCard(sourcePaneId, sourceCardId, { x, y });
    } else if (mode === "merge" && mergeTarget) {
      store.moveCardToPane(sourcePaneId, sourceCardId, mergeTarget.paneId, mergeTarget.insertIndex);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Mode determination
  // ---------------------------------------------------------------------------

  /**
   * Determine the current drag mode from pointer position relative to cached
   * bounding rects, then update visual feedback accordingly.
   *
   * Inside source bar  → reorder mode
   * Outside source bar, over another tab bar → merge mode (multi-tab target)
   * Outside source bar, over `.tug-pane` (no tab bar) → merge mode (single-tab target)
   * Anywhere else → detach mode
   *
   * [D04, D05]
   */
  private updateDragMode(cx: number, cy: number): void {
    // Check if pointer is inside the source bar. [D04]
    if (this.sourceBarRect && this.pointInRect(cx, cy, this.sourceBarRect)) {
      this.setMode("reorder");
      this.clearDropTarget();

      // Update reorder insertion indicator.
      const sourceBar = this.sourceTabElement?.closest(".tug-tab-bar") as HTMLElement | null;
      if (sourceBar) {
        this.currentReorderIndex = this.computeReorderIndex(sourceBar, cx);
        this.updateInsertionIndicator(sourceBar, this.currentReorderIndex);
      }
      return;
    }

    // Check tier-1: multi-tab card bars.
    for (const entry of this.allTabBarRects) {
      if (this.pointInRect(cx, cy, entry.rect)) {
        this.setMode("merge");
        this.setDropTarget(entry.barElement);

        // Compute merge insertion index from pointer X vs tab midpoints in target bar.
        const insertIndex = this.computeReorderIndex(entry.barElement, cx);
        this.currentMergeTarget = { paneId: entry.paneId, insertIndex };
        this.updateInsertionIndicator(entry.barElement, insertIndex);
        return;
      }
    }

    // Check tier-2: single-card stack frames. [D05]
    for (const entry of this.allPaneFrameRects) {
      if (this.pointInRect(cx, cy, entry.rect)) {
        this.setMode("merge");
        this.setDropTarget(entry.accessoryElement);

        // Default insertion index: append (insertIndex = cardIds.length of target).
        // DeckManager clamps insertAtIndex to [0, cardIds.length] in
        // moveCardToPane, so using a large sentinel (999) is safe.
        this.currentMergeTarget = { paneId: entry.paneId, insertIndex: 999 };
        this.removeInsertionIndicator();
        return;
      }
    }

    // Pointer is outside all known targets -- detach mode.
    this.setMode("detach");
    this.clearDropTarget();
    this.removeInsertionIndicator();
    this.currentMergeTarget = null;
  }

  private setMode(mode: DragMode): void {
    if (this.currentMode !== mode) {
      this.currentMode = mode;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Drop-target highlight
  // ---------------------------------------------------------------------------

  private setDropTarget(el: HTMLElement): void {
    if (this.currentDropTargetElement === el) return;
    this.clearDropTarget();
    this.currentDropTargetElement = el;
    el.setAttribute("data-drop-target", "true");
  }

  private clearDropTarget(): void {
    if (this.currentDropTargetElement) {
      this.currentDropTargetElement.removeAttribute("data-drop-target");
      this.currentDropTargetElement = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Reorder hit-testing
  // ---------------------------------------------------------------------------

  /**
   * Compute the insertion index for a tab bar given a pointer X coordinate.
   *
   * Iterates over all visible .tug-tab children of the bar (excluding tabs
   * with data-overflow="hidden"), comparing pointer X against each tab's
   * midpoint. Returns the index where the tab would be inserted if dropped
   * at this X position.
   *
   * Uses VISIBLE_TAB_SELECTOR to exclude hidden overflow tabs, which have
   * display:none and return zero-width bounding rects. [D07]
   *
   * []
   */
  computeReorderIndex(barElement: HTMLElement, pointerX: number): number {
    const tabEls = barElement.querySelectorAll<HTMLElement>(VISIBLE_TAB_SELECTOR);
    if (tabEls.length === 0) return 0;

    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (pointerX < midX) {
        return i;
      }
    }
    return tabEls.length;
  }

  // ---------------------------------------------------------------------------
  // Private: Insertion indicator
  // ---------------------------------------------------------------------------

  /**
   * Create or move the insertion indicator inside the given bar at the given
   * insertion index. The indicator's left position is computed from the left
   * edge of the tab at insertIndex (or right edge of the last tab if appending).
   *
   * []
   */
  private updateInsertionIndicator(barElement: HTMLElement, insertIndex: number): void {
    // If the indicator is in a different bar, remove it and recreate.
    if (this.indicatorElement && this.indicatorBarElement !== barElement) {
      this.removeInsertionIndicator();
    }

    // Create indicator if it doesn't exist.
    if (!this.indicatorElement) {
      const indicator = document.createElement("div");
      indicator.className = "tug-tab-insert-indicator";
      barElement.appendChild(indicator);
      this.indicatorElement = indicator;
      this.indicatorBarElement = barElement;
    }

    // Compute left position relative to the bar.
    // Uses VISIBLE_TAB_SELECTOR to exclude hidden overflow tabs. [D07]
    const barRect = barElement.getBoundingClientRect();
    const tabEls = barElement.querySelectorAll<HTMLElement>(VISIBLE_TAB_SELECTOR);
    let leftPx = 0;

    if (tabEls.length === 0) {
      leftPx = 0;
    } else if (insertIndex >= tabEls.length) {
      // Append after last tab.
      const lastRect = tabEls[tabEls.length - 1].getBoundingClientRect();
      leftPx = lastRect.right - barRect.left;
    } else {
      const tabRect = tabEls[insertIndex].getBoundingClientRect();
      leftPx = tabRect.left - barRect.left;
    }

    this.indicatorElement.style.left = `${leftPx}px`;
  }

  private removeInsertionIndicator(): void {
    if (this.indicatorElement) {
      this.indicatorElement.remove();
      this.indicatorElement = null;
      this.indicatorBarElement = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Ghost element
  // ---------------------------------------------------------------------------

  /**
   * Create the ghost tab element and position it at the initial pointer position.
   * [D02]
   */
  private createGhost(sourceTab: HTMLElement, clientX: number, clientY: number): HTMLDivElement {
    const ghost = document.createElement("div");
    ghost.className = "tug-tab-ghost";

    // Clone inner content (icon + title text) but not nested buttons.
    ghost.innerHTML = sourceTab.innerHTML;

    // Remove close buttons from the ghost -- they should not be interactive.
    const closeBtns = ghost.querySelectorAll(".tug-tab-close");
    closeBtns.forEach((btn) => btn.remove());

    // Match source tab dimensions.
    ghost.style.width = `${sourceTab.offsetWidth}px`;
    ghost.style.height = `${sourceTab.offsetHeight || 28}px`;

    // Initial position.
    this.positionGhost(ghost, clientX, clientY);

    return ghost;
  }

  private updateGhostPosition(clientX: number, clientY: number): void {
    if (this.ghostElement) {
      this.positionGhost(this.ghostElement, clientX, clientY);
    }
  }

  private positionGhost(ghost: HTMLDivElement, clientX: number, clientY: number): void {
    if (!this.containerRect) return;
    const x = clientX - this.containerRect.left - this.grabOffsetX;
    const y = clientY - this.containerRect.top - this.grabOffsetY;
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
  }

  // ---------------------------------------------------------------------------
  // Private: Geometry helper
  // ---------------------------------------------------------------------------

  private pointInRect(x: number, y: number, rect: DOMRect): boolean {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // ---------------------------------------------------------------------------
  // Test-only accessor
  // ---------------------------------------------------------------------------

  /**
   * Synchronously apply a drag frame at the given pointer coordinates.
   *
   * For use in unit tests only. In production, applyDragFrame() is called
   * from inside a requestAnimationFrame callback scheduled by onPointerMove.
   * Tests call this directly to drive mode transitions without relying on RAF
   * timing, keeping tests synchronous and deterministic.
   *
   * Naming convention: _testOnly_ prefix signals that this method must not be
   * used in production code paths.
   */
  _testOnly_applyDragFrame(cx: number, cy: number): void {
    this.latestPointerX = cx;
    this.latestPointerY = cy;
    this.applyDragFrame();
  }

  /**
   * Return the current drag mode. For use in unit tests only.
   */
  _testOnly_getCurrentMode(): string {
    return this.currentMode;
  }

  /**
   * Return the current merge target. For use in unit tests only.
   */
  _testOnly_getCurrentMergeTarget(): { paneId: string; insertIndex: number } | null {
    return this.currentMergeTarget;
  }

  // ---------------------------------------------------------------------------
  // Private: Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Remove all visual artifacts and event listeners from the drag.
   *
   * Called as the FIRST step of onPointerUp (cleanup-before-commit, [D03]).
   * Also called on cancel (pointercancel) or if a new drag starts while one
   * is already in progress.
   */
  cleanup(): void {
    if (!this.dragActive) return;
    this.dragActive = false;

    // Cancel pending RAF.
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // Remove event listeners.
    if (this.sourceTabElement) {
      this.sourceTabElement.removeEventListener("pointermove", this.boundOnPointerMove);
      this.sourceTabElement.removeEventListener("pointerup", this.boundOnPointerUp);
      this.sourceTabElement.removeEventListener("pointercancel", this.boundOnPointerCancel);

      // Release pointer capture.
      if (this.capturedPointerId !== -1) {
        try {
          this.sourceTabElement.releasePointerCapture(this.capturedPointerId);
        } catch {
          // May throw if the element was already removed from the DOM.
        }
      }

      // Clear dragging dim.
      this.sourceTabElement.removeAttribute("data-dragging");
    }

    // Remove document-level Escape listener. Symmetrically paired with the addEventListener
    // call in startDrag — capture-phase, true.
    document.removeEventListener("keydown", this.boundOnDocumentKeydown, true);

    // Remove ghost element.
    if (this.ghostElement) {
      this.ghostElement.remove();
      this.ghostElement = null;
    }

    // Remove insertion indicator.
    this.removeInsertionIndicator();

    // Clear drop-target highlight.
    this.clearDropTarget();

    // Clear all data-drop-target attributes from cached bar elements
    // (belt-and-suspenders in case setDropTarget tracking diverged).
    for (const entry of this.allTabBarRects) {
      entry.barElement.removeAttribute("data-drop-target");
    }
    for (const entry of this.allPaneFrameRects) {
      entry.accessoryElement.removeAttribute("data-drop-target");
    }

    // Reset per-drag state.
    this.sourceTabElement = null;
    this.sourcePaneId = "";
    this.sourceCardId = "";
    this.capturedPointerId = -1;
    this.sourceBarRect = null;
    this.containerRect = null;
    this.allTabBarRects = [];
    this.allPaneFrameRects = [];
    this.currentMergeTarget = null;
    this.currentDropTargetElement = null;
    this.currentMode = "reorder";
    this.currentReorderIndex = 0;
  }
}

// ---- Module-scope singleton export ----

/**
 * Module-scope singleton instance of CardDragCoordinator.
 * [D07] -- accessible from TugTabBar's pointer event handlers without prop drilling.
 */
export const cardDragCoordinator = new CardDragCoordinator();

// ---- Threshold detection helper (exported for TugTabBar integration) ----

/**
 * Returns true if the distance between two pointer positions exceeds the
 * drag threshold (5px). Used by TugTabBar's onPointerDown threshold detection.
 */
export function exceedsDragThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): boolean {
  const dx = currentX - startX;
  const dy = currentY - startY;
  return Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD_PX;
}
