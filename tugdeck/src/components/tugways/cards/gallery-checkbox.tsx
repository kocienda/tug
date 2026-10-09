/**
 * gallery-checkbox.tsx -- TugCheckbox demo tab for the Component Gallery.
 *
 * Shows TugCheckbox in all sizes, states, with labels, and disabled.
 *
 * L11 migration pattern template. This card is the reference
 * implementation for every other A2 substep: register as a
 * responder via `useResponder`, handle the `toggle` action,
 * disambiguate senders with explicit `senderId` props.
 *
 * Rules of Tugways compliance:
 *   - No root.render() after initial mount [D40, D42]
 *   - [L11] controls emit actions; responders handle actions.
 *
 * @module components/tugways/cards/gallery-checkbox
 */

import React, { useId, useState } from "react";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import type { TugCheckboxRole, TugCheckboxSize, TugCheckedState } from "@/components/tugways/tug-checkbox";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_SIZES: TugCheckboxSize[] = ["sm", "md", "lg"];

const ALL_ROLES: TugCheckboxRole[] = [
  "option",
  "action",
  "agent",
  "data",
  "success",
  "caution",
  "danger",
];

// ---------------------------------------------------------------------------
// GalleryCheckbox
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// L11 migration pattern — the reference shape for every A2 substep
// ---------------------------------------------------------------------------
//
// This card owns three pieces of state (checked1/2/3) and renders three
// TugCheckbox controls bound to them. Under the old callback-prop model,
// each checkbox had its own `onCheckedChange` prop wired to a state
// setter. After A2.1 (and simplified post-A2.2):
//
// 1. Each control gets a *gensym'd* sender id via `useId()` at the top of
//    the component. The id is opaque, unique per mount, and bound to a
//    variable. It never appears as a string literal anywhere — typos at
//    the binding sites become compile errors on the variable name.
// 2. The card registers as a responder via `useResponderForm`, declaring
//    its bindings as `{toggle: { [cb1Id]: setChecked1, ... }}`. The hook
//    installs typed handlers for every action type, narrows payloads,
//    warns on unbound senders in dev, and returns `{ResponderScope,
//    responderRef}` to attach to the root.
// 3. Each TugCheckbox receives its own `senderId` prop, bound to the
//    variable from step 1. When the user clicks, the checkbox dispatches
//    `{action: TUG_ACTIONS.TOGGLE, value: <boolean>, sender: <senderId>, phase:
//    "discrete"}` through the responder chain.
// 4. The chain walks from the innermost responder (resolved via
//    `data-responder-id` on this card's root div) and calls our `toggle`
//    handler inside `useResponderForm`. The handler looks up the sender
//    in the bindings map and calls the corresponding setter.
// 5. React re-renders; the checkbox's `checked` prop flows through; the
//    DOM updates.
//
// This reference pattern is the shape every A2.* substep follows. There
// is no per-card boilerplate for setters maps, handler callbacks, or
// `useResponder` plumbing — the hook owns all of it.

export function GalleryCheckbox() {
  // Controlled state for the interactive demo.
  const [checked1, setChecked1] = useState<TugCheckedState>(false);
  const [checked2, setChecked2] = useState<TugCheckedState>(true);
  const [checked3, setChecked3] = useState<TugCheckedState>("indeterminate");

  // Gensym'd sender ids — each useId() returns an opaque unique string.
  // The same variable is passed to the TugCheckbox via `senderId` and
  // used as the key in the bindings map below. Compile-time variable
  // binding means typos are impossible; runtime uniqueness is
  // guaranteed by useId().
  const cb1Id = useId();
  const cb2Id = useId();
  const cb3Id = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    toggle: {
      [cb1Id]: setChecked1,
      [cb2Id]: setChecked2,
      [cb3Id]: setChecked3,
    },
  });

  return (
    <ResponderScope>
    <div
      className="cg-content"
      data-testid="gallery-checkbox"
      ref={responderRef as (el: HTMLDivElement | null) => void}
    >

      {/* ---- Focus Language ---- */}
      {/* First section so the focusables sit above the fold for native clicks.
          Two checkboxes authored into one focus group drive the engine Tab walk
          in this card. The app-test Tabs to reach them (ring on keyboard focus),
          presses Space to toggle (data-state flips), and confirms a mouse click
          leaves no ring. */}
      <div className="cg-section" data-testid="checkbox-focus-demo">
        <TugLabel className="cg-section-title" data-testid="checkbox-focus-title">Focus Language</TugLabel>
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <TugCheckbox
            label="Focus A"
            focusGroup="gallery-checkbox-focus"
            focusOrder={0}
            data-testid="checkbox-focus-a"
          />
          <TugCheckbox
            label="Focus B"
            focusGroup="gallery-checkbox-focus"
            focusOrder={1}
            data-testid="checkbox-focus-b"
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- Size Variants ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Size Variants</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {ALL_SIZES.map((size) => (
            <TugCheckbox key={size} size={size} label={`Size: ${size}`} defaultChecked />
          ))}
        </div>
      </div>

      <TugSeparator />

      {/* ---- States ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">States (Controlled)</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <TugCheckbox
            checked={checked1}
            senderId={cb1Id}
            label={`Unchecked → ${String(checked1)}`}
          />
          <TugCheckbox
            checked={checked2}
            senderId={cb2Id}
            label={`Checked → ${String(checked2)}`}
          />
          <TugCheckbox
            checked={checked3}
            senderId={cb3Id}
            label={`Indeterminate → ${String(checked3)}`}
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- Without Labels ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Without Labels</TugLabel>
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <TugCheckbox aria-label="Option A" />
          <TugCheckbox aria-label="Option B" defaultChecked />
          <TugCheckbox aria-label="Option C" defaultChecked />
        </div>
      </div>

      <TugSeparator />

      {/* ---- Disabled ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Disabled</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <TugCheckbox disabled label="Disabled unchecked" />
          <TugCheckbox disabled defaultChecked label="Disabled checked" />
          <TugCheckbox disabled checked="indeterminate" label="Disabled indeterminate" />
        </div>
      </div>

      <TugSeparator />

      {/* ---- Group Example ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Group Example</TugLabel>
        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend style={{
            fontSize: "0.8125rem",
            fontWeight: 500,
            color: "var(--tug7-element-field-text-normal-label-rest)",
            marginBottom: "8px",
          }}>
            Notification preferences
          </legend>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <TugCheckbox label="Email notifications" defaultChecked />
            <TugCheckbox label="Push notifications" defaultChecked />
            <TugCheckbox label="SMS notifications" />
            <TugCheckbox label="Slack notifications" defaultChecked />
          </div>
        </fieldset>
      </div>

      <TugSeparator />

      {/* ---- Role Variants ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Role Variants</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <TugCheckbox defaultChecked label="accent (default)" />
          {ALL_ROLES.map((role) => (
            <TugCheckbox
              key={role}
              role={role}
              defaultChecked
              label={role}
            />
          ))}
        </div>
      </div>

    </div>
    </ResponderScope>
  );
}
