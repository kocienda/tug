/**
 * gallery-mutation-tx.tsx -- GalleryMutationTx demo component.
 *
 * Demonstrates the MutationTransaction / MutationTransactionManager / StyleCascadeReader
 * pipeline with three interaction models:
 *
 *   1. Color input  -- HTML <input type="color"> scrubs background-color on a mock card.
 *   2. Hue swatch   -- pointer-scrub div maps x-position to HSL hue.
 *   3. Position sliders -- two <input type="range"> scrub left/top on the mock card,
 *                          demonstrating multi-property snapshotting.
 *
 * Design decisions followed:
 *   [D04] Action phases drive transaction lifecycle -- controls dispatch ActionEvents
 *         through the responder chain; responders call the manager, never the transaction
 *         methods directly.
 *   [D05] Three interaction models.
 *   [D06] Cascade reader display uses direct DOM writes (no setState during change phase).
 *
 * Rules of Tugways:
 *   #9  -- No React state changes during continuous preview gestures.
 *   #10 -- Controls emit actions; responders handle actions.
 *
 *
 * @module components/tugways/cards/gallery-mutation-tx
 */

import React, { useRef, useLayoutEffect } from "react";
import { useRequiredResponderChain } from "@/components/tugways/responder-chain-provider";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent, GalleryAction } from "@/components/tugways/responder-chain";
import { TUG_GALLERY_ACTIONS } from "@/components/tugways/action-vocabulary";
import { mutationTransactionManager } from "@/components/tugways/mutation-transaction";
import { StyleCascadeReader } from "@/components/tugways/style-cascade-reader";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable responder ID for the demo node -- used by sendToTarget. */
const DEMO_RESPONDER_ID = "mutation-tx-demo";

/** Initial position of the mock card element. */
const INITIAL_LEFT_PX = 40;
const INITIAL_TOP_PX = 20;
const INITIAL_BG_COLOR = "#4f8ef7";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a pointer x-position within an element's bounding rect to an HSL hue
 * (0–360 degrees). Clamps to [0, 360].
 */
function xToHue(clientX: number, rect: DOMRect): number {
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return Math.round(ratio * 360);
}

// ---------------------------------------------------------------------------
// GalleryMutationTx
// ---------------------------------------------------------------------------

/**
 * GalleryMutationTx -- gallery tab demo for MutationTransaction pipeline.
 *
 * Renders three demo sections, a shared positioned mock card element, and a
 * cascade reader display panel. All live-preview mutations are CSS/DOM only;
 * React state is only updated at commit/cancel boundaries or for UI labels that
 * are not part of the continuous gesture path.
 *
 * **Responder wiring:**
 * Controls call `manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, event)` (explicit-target
 * dispatch). The demo's own responder node handles `previewColor`, `previewHue`,
 * and `previewPosition` actions and translates action phases to transaction
 * lifecycle calls.
 *
 * **Display wiring:**
 * Cascade reader display spans are updated via direct DOM writes during `change`
 * events. This keeps the gesture path React-render-free ([D06], Rule of Tug #9).
 * On commit/cancel the same direct DOM writes apply -- no phase needs setState.
 *
 * **Authoritative references:** [D04], [D05], [D06], Rule of Tug #9, #10.
 */
export function GalleryMutationTx() {
  const manager = useRequiredResponderChain();

  // Ref to the mock card element -- target for all three transaction demos.
  const mockCardRef = useRef<HTMLDivElement>(null);

  // Display span refs for the cascade reader panel.
  // Updated via direct DOM writes; never via setState.
  const bgColorSourceRef = useRef<HTMLSpanElement>(null);
  const bgColorValueRef = useRef<HTMLSpanElement>(null);
  const leftSourceRef = useRef<HTMLSpanElement>(null);
  const leftValueRef = useRef<HTMLSpanElement>(null);
  const topSourceRef = useRef<HTMLSpanElement>(null);
  const topValueRef = useRef<HTMLSpanElement>(null);

  // Pointer-scrub: track whether we have a pointer capture active.
  const scrubActiveRef = useRef(false);

  // Use a locally-constructed StyleCascadeReader for the display panel.
  // We inject the mutationTransactionManager so preview detection is wired.
  const cascadeReaderRef = useRef<StyleCascadeReader | null>(null);
  if (cascadeReaderRef.current === null) {
    cascadeReaderRef.current = new StyleCascadeReader(mutationTransactionManager);
  }

  // ---------------------------------------------------------------------------
  // Helper: update the cascade display for a property
  // ---------------------------------------------------------------------------

  /**
   * Read the declared source for `property` on the mock card and write the
   * result into the display span refs. Direct DOM write -- no setState.
   */
  function updateDisplay(property: string): void {
    const el = mockCardRef.current;
    if (!el) return;
    const reader = cascadeReaderRef.current!;

    const layer = reader.getDeclared(el, property);
    const value = layer?.value ?? "";
    const source = layer?.source ?? "—";

    if (property === "background-color") {
      if (bgColorSourceRef.current) bgColorSourceRef.current.textContent = source;
      if (bgColorValueRef.current) bgColorValueRef.current.textContent = value;
    } else if (property === "left") {
      if (leftSourceRef.current) leftSourceRef.current.textContent = source;
      if (leftValueRef.current) leftValueRef.current.textContent = value;
    } else if (property === "top") {
      if (topSourceRef.current) topSourceRef.current.textContent = source;
      if (topValueRef.current) topValueRef.current.textContent = value;
    }
  }

  // ---------------------------------------------------------------------------
  // Responder registration
  // ---------------------------------------------------------------------------

  // Register the demo responder. useResponder uses useLayoutEffect internally
  // ([D41]) so the node is registered before any event can fire.
  // The action handlers close over stable refs (mockCardRef, display refs) and
  // the singleton mutationTransactionManager -- no stale closure issues.
  //
  // The `<GalleryAction>` type parameter opts into the demo-only
  // vocabulary. `previewColor`, `previewHue`, and `previewPosition`
  // are gallery-only action names; passing `GalleryAction` widens the
  // action map's key set to include them alongside production actions.
  useResponder<GalleryAction>({
    id: DEMO_RESPONDER_ID,
    actions: {
      // ---- preview-color: maps color input events to background-color transaction ----
      [TUG_GALLERY_ACTIONS.PREVIEW_COLOR]: (event: ActionEvent<GalleryAction>) => {
        const el = mockCardRef.current;
        if (!el) return;
        const color = event.value as string;

        switch (event.phase) {
          case "begin":
            mutationTransactionManager.beginTransaction(el, ["background-color"]);
            break;
          case "change": {
            const tx = mutationTransactionManager.getActiveTransaction(el);
            if (tx) tx.preview("background-color", color);
            updateDisplay("background-color");
            break;
          }
          case "commit":
            mutationTransactionManager.commitTransaction(el);
            updateDisplay("background-color");
            break;
          case "cancel":
            mutationTransactionManager.cancelTransaction(el);
            updateDisplay("background-color");
            break;
          default:
            break;
        }
      },

      // ---- preview-hue: maps pointer-scrub x-position to HSL hue on background-color ----
      [TUG_GALLERY_ACTIONS.PREVIEW_HUE]: (event: ActionEvent<GalleryAction>) => {
        const el = mockCardRef.current;
        if (!el) return;

        switch (event.phase) {
          case "begin":
            mutationTransactionManager.beginTransaction(el, ["background-color"]);
            break;
          case "change": {
            const hue = event.value as number;
            const tx = mutationTransactionManager.getActiveTransaction(el);
            if (tx) tx.preview("background-color", `hsl(${hue}, 70%, 60%)`);
            updateDisplay("background-color");
            break;
          }
          case "commit":
            mutationTransactionManager.commitTransaction(el);
            updateDisplay("background-color");
            break;
          case "cancel":
            mutationTransactionManager.cancelTransaction(el);
            updateDisplay("background-color");
            break;
          default:
            break;
        }
      },

      // ---- preview-position: maps range slider input to left/top on the mock card ----
      [TUG_GALLERY_ACTIONS.PREVIEW_POSITION]: (event: ActionEvent<GalleryAction>) => {
        const el = mockCardRef.current;
        if (!el) return;
        const { left, top } = (event.value as { left: number; top: number });

        switch (event.phase) {
          case "begin":
            mutationTransactionManager.beginTransaction(el, ["left", "top"]);
            break;
          case "change": {
            const tx = mutationTransactionManager.getActiveTransaction(el);
            if (tx) {
              tx.preview("left", `${left}px`);
              tx.preview("top", `${top}px`);
            }
            updateDisplay("left");
            updateDisplay("top");
            break;
          }
          case "commit":
            mutationTransactionManager.commitTransaction(el);
            updateDisplay("left");
            updateDisplay("top");
            break;
          case "cancel":
            mutationTransactionManager.cancelTransaction(el);
            updateDisplay("left");
            updateDisplay("top");
            break;
          default:
            break;
        }
      },
    },
  });

  // ---------------------------------------------------------------------------
  // Initialize cascade display after mount
  // ---------------------------------------------------------------------------

  useLayoutEffect(() => {
    // Write initial values into the display spans after the DOM is settled.
    updateDisplay("background-color");
    updateDisplay("left");
    updateDisplay("top");
  }, []);

  // ---------------------------------------------------------------------------
  // Slider refs (for reading current values in change handler)
  // ---------------------------------------------------------------------------

  const sliderXRef = useRef<HTMLInputElement>(null);
  const sliderYRef = useRef<HTMLInputElement>(null);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="cg-content" data-testid="gallery-mutation-tx">
      {/* ------------------------------------------------------------------ */}
      {/* Mock card -- absolute-positioned target element                     */}
      {/* ------------------------------------------------------------------ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Mock Target Element</TugLabel>
        <TugLabel size="2xs" emphasis="calm">A positioned div whose CSS properties are mutated by the demos below. Commit keeps the final value; cancel restores the original.</TugLabel>
        <div className="cg-mutation-tx-stage" data-testid="mutation-tx-stage">
          <div
            ref={mockCardRef}
            className="cg-mutation-tx-card"
            data-testid="mutation-tx-mock-card"
            style={{
              backgroundColor: INITIAL_BG_COLOR,
              left: `${INITIAL_LEFT_PX}px`,
              top: `${INITIAL_TOP_PX}px`,
            }}
          />
        </div>
      </div>

      <TugSeparator />

      {/* ------------------------------------------------------------------ */}
      {/* Cascade reader display                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Cascade Reader Display</TugLabel>
        <TugLabel size="2xs" emphasis="calm">Updated via direct DOM writes during gestures — no React re-renders.</TugLabel>
        <table className="cg-cascade-table" data-testid="cascade-reader-display">
          <tbody>
            <tr>
              <td className="cg-cascade-prop">background-color</td>
              <td className="cg-cascade-source">
                <span ref={bgColorSourceRef} data-testid="bg-color-source">—</span>
              </td>
              <td className="cg-cascade-value">
                <span ref={bgColorValueRef} data-testid="bg-color-value">—</span>
              </td>
            </tr>
            <tr>
              <td className="cg-cascade-prop">left</td>
              <td className="cg-cascade-source">
                <span ref={leftSourceRef} data-testid="left-source">—</span>
              </td>
              <td className="cg-cascade-value">
                <span ref={leftValueRef} data-testid="left-value">—</span>
              </td>
            </tr>
            <tr>
              <td className="cg-cascade-prop">top</td>
              <td className="cg-cascade-source">
                <span ref={topSourceRef} data-testid="top-source">—</span>
              </td>
              <td className="cg-cascade-value">
                <span ref={topValueRef} data-testid="top-value">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <TugSeparator />

      {/* ------------------------------------------------------------------ */}
      {/* Demo 1: Color input                                                 */}
      {/* ------------------------------------------------------------------ */}
      <div className="cg-section" data-testid="demo-color-input">
        <TugLabel className="cg-section-title">Demo 1 — Color Input (background-color)</TugLabel>
        <TugLabel size="2xs" emphasis="calm">The color picker dispatches begin on first input, change on subsequent inputs (intermediate picks), and commit on the change event (dialog closed). Cancel restores the original color.</TugLabel>
        <div className="cg-mutation-tx-controls">
          <input
            type="color"
            className="cg-color-input"
            defaultValue={INITIAL_BG_COLOR}
            data-testid="color-input"
            onInput={(e) => {
              const color = (e.target as HTMLInputElement).value;
              const target = mockCardRef.current;
              // Distinguish begin vs. change by checking for active transaction.
              // This avoids stale closure issues without needing extra state.
              const phase =
                target && mutationTransactionManager.getActiveTransaction(target) !== null
                  ? "change"
                  : "begin";
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_COLOR,
                phase,
                value: color,
              });
            }}
            onChange={(e) => {
              const color = (e.target as HTMLInputElement).value;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_COLOR,
                phase: "commit",
                value: color,
              });
            }}
          />
          <TugLabel size="2xs" emphasis="calm">Pick a color to preview on the mock card</TugLabel>
        </div>
      </div>

      <TugSeparator />

      {/* ------------------------------------------------------------------ */}
      {/* Demo 2: Pointer-scrub swatch                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="cg-section" data-testid="demo-hue-scrub">
        <TugLabel className="cg-section-title">Demo 2 — Hue Scrub (pointer drag)</TugLabel>
        <TugLabel size="2xs" emphasis="calm">Drag horizontally across the swatch to scrub the hue of the mock card's background-color. Release to commit; press Escape to cancel and restore the original color.</TugLabel>
        <div className="cg-mutation-tx-controls">
          <div
            className="cg-hue-swatch"
            data-testid="hue-swatch"
            onPointerDown={(e) => {
              if (typeof e.currentTarget.setPointerCapture === "function") {
                e.currentTarget.setPointerCapture(e.pointerId);
              }
              scrubActiveRef.current = true;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_HUE,
                phase: "begin",
                value: xToHue(e.clientX, e.currentTarget.getBoundingClientRect()),
              });
            }}
            onPointerMove={(e) => {
              if (!scrubActiveRef.current) return;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_HUE,
                phase: "change",
                value: xToHue(e.clientX, e.currentTarget.getBoundingClientRect()),
              });
            }}
            onPointerUp={(e) => {
              if (!scrubActiveRef.current) return;
              scrubActiveRef.current = false;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_HUE,
                phase: "commit",
                value: xToHue(e.clientX, e.currentTarget.getBoundingClientRect()),
              });
            }}
            onPointerCancel={() => {
              if (!scrubActiveRef.current) return;
              scrubActiveRef.current = false;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_HUE,
                phase: "cancel",
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && scrubActiveRef.current) {
                scrubActiveRef.current = false;
                manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                  action: TUG_GALLERY_ACTIONS.PREVIEW_HUE,
                  phase: "cancel",
                });
              }
            }}
          />
          <TugLabel size="2xs" emphasis="calm">Drag to scrub hue · Esc to cancel</TugLabel>
        </div>
      </div>

      <TugSeparator />

      {/* ------------------------------------------------------------------ */}
      {/* Demo 3: Position sliders                                            */}
      {/* ------------------------------------------------------------------ */}
      <div className="cg-section" data-testid="demo-position-sliders">
        <TugLabel className="cg-section-title">Demo 3 — Position Sliders (left + top)</TugLabel>
        <TugLabel size="2xs" emphasis="calm">Two range sliders set the left and top inline styles of the mock card, demonstrating multi-property snapshotting. The transaction begins on pointerdown and commits on pointerup.</TugLabel>
        <div className="cg-mutation-tx-slider-group">
          <TugLabel size="2xs" emphasis="calm" htmlFor="slider-x">X (left)</TugLabel>
          <input
            ref={sliderXRef}
            id="slider-x"
            type="range"
            className="cg-position-slider"
            data-testid="slider-x"
            min={0}
            max={200}
            defaultValue={INITIAL_LEFT_PX}
            onPointerDown={() => {
              // Begin on pointerdown -- NOT on focus (to avoid auto-cancel on focus).
              const left = sliderXRef.current ? Number(sliderXRef.current.value) : INITIAL_LEFT_PX;
              const top = sliderYRef.current ? Number(sliderYRef.current.value) : INITIAL_TOP_PX;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_POSITION,
                phase: "begin",
                value: { left, top },
              });
            }}
            onInput={() => {
              const left = sliderXRef.current ? Number(sliderXRef.current.value) : INITIAL_LEFT_PX;
              const top = sliderYRef.current ? Number(sliderYRef.current.value) : INITIAL_TOP_PX;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_POSITION,
                phase: "change",
                value: { left, top },
              });
            }}
            onPointerUp={() => {
              const left = sliderXRef.current ? Number(sliderXRef.current.value) : INITIAL_LEFT_PX;
              const top = sliderYRef.current ? Number(sliderYRef.current.value) : INITIAL_TOP_PX;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_POSITION,
                phase: "commit",
                value: { left, top },
              });
            }}
          />
        </div>
        <div className="cg-mutation-tx-slider-group">
          <TugLabel size="2xs" emphasis="calm" htmlFor="slider-y">Y (top)</TugLabel>
          <input
            ref={sliderYRef}
            id="slider-y"
            type="range"
            className="cg-position-slider"
            data-testid="slider-y"
            min={0}
            max={200}
            defaultValue={INITIAL_TOP_PX}
            onPointerDown={() => {
              const left = sliderXRef.current ? Number(sliderXRef.current.value) : INITIAL_LEFT_PX;
              const top = sliderYRef.current ? Number(sliderYRef.current.value) : INITIAL_TOP_PX;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_POSITION,
                phase: "begin",
                value: { left, top },
              });
            }}
            onInput={() => {
              const left = sliderXRef.current ? Number(sliderXRef.current.value) : INITIAL_LEFT_PX;
              const top = sliderYRef.current ? Number(sliderYRef.current.value) : INITIAL_TOP_PX;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_POSITION,
                phase: "change",
                value: { left, top },
              });
            }}
            onPointerUp={() => {
              const left = sliderXRef.current ? Number(sliderXRef.current.value) : INITIAL_LEFT_PX;
              const top = sliderYRef.current ? Number(sliderYRef.current.value) : INITIAL_TOP_PX;
              manager.sendToTarget<GalleryAction>(DEMO_RESPONDER_ID, {
                action: TUG_GALLERY_ACTIONS.PREVIEW_POSITION,
                phase: "commit",
                value: { left, top },
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
