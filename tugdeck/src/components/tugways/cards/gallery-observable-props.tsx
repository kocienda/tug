/**
 * gallery-observable-props.tsx -- GalleryObservableProps demo component.
 *
 * Demonstrates the full PropertyStore round-trip:
 *   1. Card content registers a PropertyStore via usePropertyStore().
 *   2. An inspector panel reads current values and dispatches setProperty
 *      actions via manager.sendToTarget(cardId, ...) — routing through the
 *      parent TugPane's responder node to the registered store.
 *   3. The target element's appearance updates reactively via
 *      useSyncExternalStore subscriptions, one per property.
 *   4. Source attribution prevents circular re-dispatch: inspector controls
 *      tag their changes as source 'inspector'; if a content observer sees
 *      source 'inspector' it skips re-dispatch.
 *
 * This is the first gallery tab to use the cardId argument from contentFactory.
 * The cardId is needed to direct setProperty actions to the correct TugPane
 * responder node via sendToTarget.
 *
 * Design decisions:
 *   [D01] Context callback registration for PropertyStore
 *   [D02] Store owns values with optional callbacks
 *   [D03] Observer-side circular guard
 *   [D04] setProperty action routed through TugPane responder
 *   [D05] Per-path observe for useSyncExternalStore
 *
 * Rules of Tugways:
 *   #1  -- No root.render() after initial mount
 *   #2  -- useSyncExternalStore for external state reads
 *   #3  -- useLayoutEffect for registrations events depend on
 *   #4  -- Appearance changes through CSS/DOM, never React state
 *
 *,, (#s07-gallery-demo)
 *
 *
 * @module components/tugways/cards/gallery-observable-props
 */

import React, { useId, useLayoutEffect, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { useRequiredResponderChain } from "@/components/tugways/responder-chain-provider";
import { usePropertyStore } from "@/components/tugways/hooks/use-property-store";
import type { PropertyChange, PropertyDescriptor } from "@/components/tugways/property-store";
import { TugPopupButton } from "@/components/tugways/tug-popup-button";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { TUG_ACTIONS } from "../action-vocabulary";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugValueInput } from "@/components/tugways/tug-value-input";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// Schema constants (module-scope to avoid recreation on each render)
// ---------------------------------------------------------------------------

/**
 * Property schema for the Observable Props demo.
 * Three properties: color, number (with min/max), enum.
 *
 * (#s07-gallery-demo)
 */
const DEMO_SCHEMA: PropertyDescriptor[] = [
  {
    path: "style.backgroundColor",
    type: "color",
    label: "Background Color",
  },
  {
    path: "style.fontSize",
    type: "number",
    label: "Font Size",
    min: 8,
    max: 72,
  },
  {
    path: "style.fontFamily",
    type: "enum",
    label: "Font Family",
    enumValues: ["system-ui", "monospace", "serif"],
  },
];

const DEMO_INITIAL_VALUES: Record<string, unknown> = {
  "style.backgroundColor": "#4f8ef7",
  "style.fontSize": 16,
  "style.fontFamily": "system-ui",
};

const FONT_FAMILY_OPTIONS = ["system-ui", "monospace", "serif"] as const;

// ---------------------------------------------------------------------------
// GalleryObservableProps
// ---------------------------------------------------------------------------

/**
 * GalleryObservableProps -- gallery tab demo for the PropertyStore
 * observable-properties pipeline.
 *
 * Accepts the `cardId` prop from contentFactory so it can target setProperty
 * actions at the correct TugPane responder node via sendToTarget. This is the
 * first gallery tab content to use the cardId argument; existing tabs discard
 * it as `_cardId`.
 *
 * **Target element:** A styled div whose backgroundColor, fontSize, and
 * fontFamily are driven by useSyncExternalStore subscriptions to the
 * PropertyStore. Each property subscribes independently so only the component
 * consuming the changed path re-renders. [D05]
 *
 * **Inspector panel:** Three controls (color input, number input + range,
 * select dropdown). Each control dispatches a setProperty action via
 * manager.sendToTarget(cardId, { action: 'set-property', value: { path, value,
 * source: 'inspector' } }). The action routes through the parent TugPane's
 * responder node, which calls store.set() on the registered PropertyStore.
 * [D04]
 *
 * **Source attribution:** Inspector controls tag changes with
 * source: 'inspector'. Content observers that see source === 'inspector'
 * skip re-dispatch to avoid circular notification loops. [D03]
 *
 * (#s07-gallery-demo)
 */
export function GalleryObservableProps({ cardId }: { cardId: string }) {
  const manager = useRequiredResponderChain();

  // Register the PropertyStore with TugPane via context callback.
  // [D01] usePropertyStore calls CardPropertyContext in useLayoutEffect.
  const store = usePropertyStore({
    schema: DEMO_SCHEMA,
    initialValues: DEMO_INITIAL_VALUES,
  });

  // Subscribe to each property independently via useSyncExternalStore.
  // This means only the component consuming the changed path re-renders. [D05]
  // observe() signature matches useSyncExternalStore's subscribe argument:
  //   subscribe: (callback: () => void) => () => void
  const backgroundColor = useSyncExternalStore(
    (cb) => store.observe("style.backgroundColor", cb),
    () => store.get("style.backgroundColor") as string,
  );

  const fontSize = useSyncExternalStore(
    (cb) => store.observe("style.fontSize", cb),
    () => store.get("style.fontSize") as number,
  );

  const fontFamily = useSyncExternalStore(
    (cb) => store.observe("style.fontFamily", cb),
    () => store.get("style.fontFamily") as string,
  );

  // ---------------------------------------------------------------------------
  // Source-attribution observer — live [D03] circular guard demonstration
  // ---------------------------------------------------------------------------
  //
  // This is the content-side observer required by the plan. It calls
  // store.observe() with a full PropertyChangeListener that receives the
  // PropertyChange record and inspects change.source:
  //
  //   - source === 'content': the change originated from content code; the
  //     observer would re-dispatch or apply secondary effects here.
  //   - source === 'inspector': the change came from the inspector; the
  //     observer SKIPS re-dispatch to break the circular loop:
  //       inspector → sendToTarget → TugPane.setProperty → store.set →
  //       notify observers → (skip) → no re-dispatch back to inspector.
  //
  // The observer writes the last change record into a DOM ref for live display
  // (appearance-zone: direct DOM write, no React state — Rule #4). [D03]

  // Ref to the DOM span that displays the last PropertyChange record.
  const lastChangeRef = useRef<HTMLSpanElement>(null);

  // Ref to count how many times the observer fired — exposed as a data
  // attribute for testability without React state.
  const observerFireCountRef = useRef<HTMLSpanElement>(null);
  const fireCountRef = useRef(0);

  useLayoutEffect(() => {
    // Subscribe to all three paths with a single typed PropertyChangeListener.
    // The listener checks change.source and guards against re-dispatch. [D03]
    const handleChange = (change: PropertyChange) => {
      // [D03] Observer-side circular guard:
      // When source === 'inspector', this content observer skips re-dispatch.
      // This prevents: inspector writes → store notifies → content re-dispatches
      // → store notifies again → infinite loop.
      if (change.source === "inspector") {
        // Write to DOM to show the guard fired (no React setState). [D04]
        if (lastChangeRef.current) {
          lastChangeRef.current.textContent =
            `[guarded] ${change.path} ← ${JSON.stringify(change.newValue)} (source: inspector, skipped re-dispatch)`;
        }
        fireCountRef.current += 1;
        if (observerFireCountRef.current) {
          observerFireCountRef.current.textContent = String(fireCountRef.current);
        }
        return; // ← circular guard: skip re-dispatch
      }

      // source === 'content' (or any other source): apply secondary effects.
      if (lastChangeRef.current) {
        lastChangeRef.current.textContent =
          `[applied] ${change.path} ← ${JSON.stringify(change.newValue)} (source: ${change.source})`;
      }
      fireCountRef.current += 1;
      if (observerFireCountRef.current) {
        observerFireCountRef.current.textContent = String(fireCountRef.current);
      }
    };

    const unsub1 = store.observe("style.backgroundColor", handleChange);
    const unsub2 = store.observe("style.fontSize", handleChange);
    const unsub3 = store.observe("style.fontFamily", handleChange);
    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // ---------------------------------------------------------------------------
  // Inspector control handlers — dispatch setProperty via sendToTarget
  // ---------------------------------------------------------------------------
  //
  // All controls tag their changes with source: 'inspector'. This allows the
  // content-side observer above to detect that it did not originate the change
  // and skip re-dispatch, preventing circular notification loops. [D03]
  //
  // The action routes through the parent TugPane's setProperty handler, which
  // calls store.set(path, value, source). This exercises the full round-trip:
  //   inspector control → sendToTarget → TugPane.setProperty → store.set →
  //   observer notification → useSyncExternalStore re-render. [D04]

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    manager.sendToTarget(cardId, {
      action: TUG_ACTIONS.SET_PROPERTY,
      phase: "discrete",
      value: {
        path: "style.backgroundColor",
        value: e.target.value,
        source: "inspector",
      },
    });
  };

  // L11 migration via useResponderForm — the font-family popup dispatches
  // setValue with a string payload; its binding does the explicit-target
  // setProperty dispatch to this specific cardId. This is the same
  // inspector pattern the original card demonstrated, now routed via the
  // chain-dispatch path from TugPopupButton instead of a direct callback.
  const fontSizeInputId = useId();
  const fontFamilyPopupId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueNumber: {
      [fontSizeInputId]: (value: number) => {
        manager.sendToTarget(cardId, {
          action: TUG_ACTIONS.SET_PROPERTY,
          phase: "discrete",
          value: {
            path: "style.fontSize",
            value,
            source: "inspector",
          },
        });
      },
    },
    setValueString: {
      [fontFamilyPopupId]: (value: string) => {
        manager.sendToTarget(cardId, {
          action: TUG_ACTIONS.SET_PROPERTY,
          phase: "discrete",
          value: {
            path: "style.fontFamily",
            value,
            source: "inspector",
          },
        });
      },
    },
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <ResponderScope>
    <div
      className="cg-content"
      data-testid="gallery-observable-props"
      ref={responderRef as (el: HTMLDivElement | null) => void}
    >

      {/* ------------------------------------------------------------------ */}
      {/* Target element: appearance driven by PropertyStore via              */}
      {/* useSyncExternalStore. No React state — values flow from the store.  */}
      {/* ------------------------------------------------------------------ */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Target Element</TugLabel>
        <TugLabel size="2xs" emphasis="calm">Appearance driven by PropertyStore values via useSyncExternalStore. Each property subscribes independently — only the affected field re-renders when a value changes.</TugLabel>
        <div className="cg-observable-props-stage" data-testid="observable-props-stage">
          <div
            className="cg-observable-props-target"
            data-testid="observable-props-target"
            style={{
              backgroundColor,
              fontSize: `${fontSize}px`,
              fontFamily,
            }}
          >
            The quick brown fox jumps over the lazy dog.
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ------------------------------------------------------------------ */}
      {/* Inspector panel: controls dispatch setProperty via sendToTarget.      */}
      {/* Source attribution: source: 'inspector' tags all writes so          */}
      {/* content-side observers can skip re-dispatch. [D03]                  */}
      {/* ------------------------------------------------------------------ */}
      <div className="cg-section" data-testid="observable-props-inspector">
        <TugLabel className="cg-section-title">Inspector Panel</TugLabel>
        <TugLabel size="2xs" emphasis="calm">Each control dispatches setProperty via sendToTarget(cardId, ...). The action routes through the parent TugPane's responder node to the registered PropertyStore. Source is tagged 'inspector' to prevent circular loops.</TugLabel>

        {/* Background Color */}
        <div className="cg-control-group" data-testid="inspector-bg-color-group">
          <TugLabel size="2xs" emphasis="calm" htmlFor="obs-props-bg-color">{DEMO_SCHEMA[0].label}</TugLabel>
          <input
            id="obs-props-bg-color"
            type="color"
            className="cg-color-input"
            value={backgroundColor}
            data-testid="inspector-bg-color"
            onChange={handleColorChange}
          />
        </div>

        {/* Font Size */}
        <div className="cg-control-group" data-testid="inspector-font-size-group">
          <TugLabel size="2xs" emphasis="calm">{DEMO_SCHEMA[1].label}</TugLabel>
          <TugValueInput
            value={fontSize}
            senderId={fontSizeInputId}
            min={DEMO_SCHEMA[1].min}
            max={DEMO_SCHEMA[1].max}
            step={1}
            size="sm"
            data-testid="inspector-font-size"
          />
        </div>

        {/* Font Family */}
        <div className="cg-control-group" data-testid="inspector-font-family-group">
          <TugLabel size="2xs" emphasis="calm">{DEMO_SCHEMA[2].label}</TugLabel>
          <TugPopupButton
            label={fontFamily}
            size="sm"
            senderId={fontFamilyPopupId}
            items={FONT_FAMILY_OPTIONS.map((ff) => ({
              action: TUG_ACTIONS.SET_VALUE,
              value: ff,
              label: ff,
            }))}
          />
        </div>
      </div>

      <TugSeparator />

      {/* ------------------------------------------------------------------ */}
      {/* Source attribution — live circular guard display [D03]             */}
      {/* ------------------------------------------------------------------ */}
      <div className="cg-section" data-testid="observable-props-source-note">
        <TugLabel className="cg-section-title">Source Attribution (Circular Guard)</TugLabel>
        <TugLabel size="2xs" emphasis="calm">A content-side store.observe() listener receives every PropertyChange record and checks change.source: when source is 'inspector' it skips re-dispatch; when source is 'content' it applies secondary effects. The observer count and last record below update via direct DOM writes — no React state, no re-render. [D03, Rule #4]</TugLabel>

        {/* Live observer output — updated via direct DOM writes in the observer */}
        <table className="cg-cascade-table" data-testid="observable-props-state-table">
          <tbody>
            <tr>
              <td className="cg-cascade-prop">Observer fire count</td>
              <td className="cg-cascade-value">
                <span
                  ref={observerFireCountRef}
                  data-testid="observer-fire-count"
                >
                  0
                </span>
              </td>
            </tr>
            <tr>
              <td className="cg-cascade-prop">Last change record</td>
              <td className="cg-cascade-value">
                <span
                  ref={lastChangeRef}
                  data-testid="observer-last-change"
                >
                  (none yet — use the inspector above)
                </span>
              </td>
            </tr>
            <tr>
              <td className="cg-cascade-prop">style.backgroundColor</td>
              <td className="cg-cascade-value" data-testid="state-bg-color">
                {backgroundColor}
              </td>
            </tr>
            <tr>
              <td className="cg-cascade-prop">style.fontSize</td>
              <td className="cg-cascade-value" data-testid="state-font-size">
                {fontSize}px
              </td>
            </tr>
            <tr>
              <td className="cg-cascade-prop">style.fontFamily</td>
              <td className="cg-cascade-value" data-testid="state-font-family">
                {fontFamily}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    </ResponderScope>
  );
}
