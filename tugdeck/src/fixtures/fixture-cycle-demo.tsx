/**
 * fixture-cycle-demo.tsx — exercises the keyboard-focus-cycling mode primitive
 * (`useCycleMode`) on a minimal surface, decoupled from the session card's stateful
 * picker/connected machinery.
 *
 * The card stands in for a text-first card: a **resting** focusable (the
 * "editor" stand-in, in the base mode) plus three **cycle stops** wrapped in the
 * hook's `CycleScope` (so they register into this card's cycle mode, not the
 * base mode). ⌥⇥ (the `CYCLE_FOCUS_MODE` action, routed to this card's
 * `card-content` responder) toggles cycling:
 *
 *   - ON  → the mode is pushed (trapped); the key view seeds on the commit-home
 *     (the lowest-`focusOrder` cycle stop) and Tab wraps within the stops;
 *   - OFF → the mode pops and the key view returns to the resting focusable.
 *
 * This is the permanent showcase + app-test surface for the mechanism
 * ([#step-cycle-mechanism]); the real consumer (the session card, with per-state
 * default focus + roles) lands in [#step-cycle-devcard]. Escape / Return / Space
 * mode-key semantics land in [#step-cycle-keys].
 *
 * Laws: [L02] cycling is engine-derived (in the hook); [L06] appearance is the
 *       engine ring via CSS, no React state; [L19] gallery-card authoring.
 *
 * @module fixtures/fixture-cycle-demo
 */

import "./fixture.css";

import React from "react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { useResponder } from "@/components/tugways/use-responder";
import { useCycleMode } from "@/components/tugways/use-cycle-mode";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

const CYCLE_GROUP = "gallery-cycle-stops";

export function FixtureCycleDemo({ cardId }: { cardId: string }): React.ReactElement {
  const { cycling, toggle, CycleScope } = useCycleMode();

  // The ⌥⇥ trigger is `scope: "key-card"` — it routes to the active card's
  // `card-content` responder, where this handler toggles the mode.
  const { ResponderScope, responderRef } = useResponder({
    id: `${cardId}-card-content`,
    kind: "card-content",
    actions: {
      [TUG_ACTIONS.CYCLE_FOCUS_MODE]: () => toggle(),
    },
  });

  return (
    <ResponderScope>
      <div
        className="fx-content"
        data-testid="gallery-cycle-demo"
        data-cycling={cycling ? "true" : "false"}
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <div className="fx-section">
          <TugLabel className="fx-section-title">Keyboard-focus-cycling</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            Click “Resting” to put the key view on it, then press ⌥⇥. Cycling
            seeds the ring on the commit-home; Tab wraps the stops; ⌥⇥ again
            returns the key view to “Resting”.
          </TugLabel>
        </div>

        <TugSeparator />

        {/* Resting key view — the "editor" stand-in, in the BASE mode (no
            CycleScope), so it is not a cycle stop. Ghost emphasis so it carries
            no resting border: a bordered button reads as focus-decorated even
            when it is not, which is misleading next to the real cycle ring. */}
        <div className="fx-section">
          <TugLabel className="fx-section-title">Resting (base mode)</TugLabel>
          <div className="fx-variant-row">
            <TugPushButton
              emphasis="ghost"
              focusGroup="gallery-cycle-rest"
              focusOrder={0}
              data-testid="cycle-rest"
              onClick={() => {}}
            >
              Resting
            </TugPushButton>
          </div>
        </div>

        <TugSeparator />

        {/* Cycle stops — wrapped in CycleScope so they register into this card's
            cycle mode. The commit-home is the lowest focusOrder, so it is what
            the mode seeds on entry; the rest follow in cycle order. */}
        <div className="fx-section">
          <TugLabel className="fx-section-title">Cycle stops</TugLabel>
          <CycleScope>
            <div className="fx-variant-row">
              {/* All stops are OUTLINED so the keyboard-promoted fill is the
                  live signal: only the focused stop promotes to filled + ring,
                  and the fill MOVES with Tab — it is taken off the prior stop.
                  (A permanently `filled` button would keep its fill when tabbed
                  off, which reads as a stuck decoration.) The commit-home is
                  just the seed target — distinguished by being seeded on entry,
                  not by a standing fill. */}
              <TugPushButton
                emphasis="outlined"
                role="action"
                focusGroup={CYCLE_GROUP}
                focusOrder={0}
                data-testid="cycle-home"
                onClick={() => {}}
              >
                Commit-home
              </TugPushButton>
              <TugPushButton
                emphasis="outlined"
                role="action"
                focusGroup={CYCLE_GROUP}
                focusOrder={1}
                data-testid="cycle-a"
                onClick={() => {}}
              >
                Stop A
              </TugPushButton>
              <TugPushButton
                emphasis="outlined"
                role="action"
                focusGroup={CYCLE_GROUP}
                focusOrder={2}
                data-testid="cycle-b"
                onClick={() => {}}
              >
                Stop B
              </TugPushButton>
            </div>
          </CycleScope>
        </div>
      </div>
    </ResponderScope>
  );
}
