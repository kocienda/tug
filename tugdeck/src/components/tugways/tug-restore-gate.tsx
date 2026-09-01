/**
 * TugRestoreGate — the app-wide, blocking "restoring sessions" gate. A
 * sibling of {@link TugVersionGate} and {@link ConfigureTug} at the deck
 * root, on the same TugAlert chrome (Radix AlertDialog portalled into
 * the canvas overlay).
 *
 * ## Why an app-modal
 *
 * A cold restore's reveal is one uninterruptible task on the single
 * thread every card shares, so for its duration the app answers
 * nothing — no keystroke, no click, in any card. Before this gate the
 * chrome went on painting its last frame throughout, which told the
 * user the app was ready when it demonstrably was not; typing into it
 * dropped input on the floor. Chunking the work so input could
 * interleave was tried and rejected — a transcript filling in behind
 * the user flashes and hops, and it left a class of scroll pathologies
 * to chase indefinitely. Saying "busy" for exactly as long as the app
 * is busy costs the user nothing they actually had, and it is true.
 *
 * Precedence (Spec S02): the strictly-required gates win. This one
 * suppresses itself while the macOS version gate is open, so the two
 * app-modals never stack.
 *
 * No dismiss: there is nothing behind it to interact with. It closes
 * when the app can answer again.
 *
 * @module components/tugways/tug-restore-gate
 */

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef, type ReactElement } from "react";

import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useRestoreGate } from "@/lib/restore-gate-store";
import { useVersionGateOpen } from "@/lib/macos-support";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import "./tug-alert.css";
import "./tug-restore-gate.css";

export function TugRestoreGate(): ReactElement {
  const gate = useRestoreGate();
  const versionGateOpen = useVersionGateOpen();
  const overlayRoot = useCanvasOverlay();
  const open = gate.open && !versionGateOpen;

  // Determinate where the windows are known, indeterminate where they
  // are not: a restore whose target has not landed yet would otherwise
  // paint a full bar over an empty transcript. The readout is the same
  // turns metric the per-card load bar counts, summed across the cards
  // being waited on (`tuglaws/turn-metric.md`).
  const determinate = gate.turnsTarget > 0;
  const value = Math.min(gate.turnsLoaded, gate.turnsTarget);

  // Radix keeps Content mounted through its close animation, and by then the
  // store has already fallen to zero cards — so the last frame a user sees
  // read "Restoring 0 sessions", which is a sentence about nothing. Hold the
  // last count the gate was actually open for and render that on the way out.
  // A ref, not state: this must not schedule a render of its own, and the
  // value is only ever read during one the store already caused.
  const lastCards = useRef(0);
  if (gate.cards > 0) lastCards.current = gate.cards;
  const subjectCards = gate.cards > 0 ? gate.cards : lastCards.current;

  const subject =
    subjectCards === 1 ? "1 session" : `${subjectCards} sessions`;

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal container={overlayRoot}>
        <AlertDialog.Overlay className="tug-alert-overlay" />
        <AlertDialog.Content
          className="tug-alert-content tug-restore-gate"
          data-slot="tug-restore-gate"
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          {/* In-jail key sink ([P13]): AlertDialog.Content's FocusScope is
              always trapped, so the engine's park must land INSIDE it or
              every park while the gate is up is answered by a Radix
              refocus and the two systems fight. */}
          <div
            data-tug-key-sink=""
            tabIndex={-1}
            className="tug-key-sink"
            aria-label="Keyboard"
          />
          <div className="tug-alert-body" data-has-message="true">
            <div className="tug-alert-text">
              <AlertDialog.Title className="tug-alert-title">
                Restoring {subject}
              </AlertDialog.Title>
              <AlertDialog.Description className="tug-alert-message" asChild>
                <div>
                  <p>Tug is rebuilding your transcripts. Just a moment.</p>
                  <TugProgressIndicator
                    variant="bar"
                    size={8}
                    role="action"
                    state="running"
                    className="tug-restore-gate-bar"
                    aria-label={`Restoring ${subject}`}
                    {...(determinate
                      ? {
                          value,
                          max: gate.turnsTarget,
                          showValue: true,
                          formatValue: (v: number, m: number) =>
                            `${v.toLocaleString()} of ${m.toLocaleString()} turns`,
                        }
                      : {})}
                  />
                </div>
              </AlertDialog.Description>
            </div>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
