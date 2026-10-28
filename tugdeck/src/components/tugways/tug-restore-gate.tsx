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
 * when the app can answer again — which is not `replay_complete`. The
 * replay ingests in under 100 ms; the reveal behind it, the list's
 * first mount and the settle of its heights, is the seconds-long
 * stretch where the card still shows nothing. A card counts toward this
 * gate for both (`deriveRestoreGateHold`), and the gate lets go on the
 * card's first settle.
 *
 * Every window the gate holds has a horizon. The replay window ends on
 * the silence deadline (`REPLAY_SILENCE_DEADLINE_MS`,
 * `code-session-store/reducer.ts`): a card that has sat in `replaying`
 * for the deadline with no frame arriving raises an error on itself,
 * which drops it out of the fold and shows the failure on that card
 * alone. The reveal ends on `COLD_REVEAL_SETTLE_BOUND_MS` if the list
 * never settles. So one card's lost frame or unmeasured list can never
 * hold every other card behind a modal with no way out — which, with no
 * dismiss, is the only way out there is.
 *
 * ## What it says
 *
 * One count, of sessions: "2 of 5 sessions" beside a bar over the same
 * numbers, under the title "Restoring sessions". The total is fixed when
 * the round opens and the count only rises (`restore-gate-store.ts`), so
 * the bar fills in steps, one per session whose wait has ended — the
 * truth about the work. Before the first session finishes the bar runs
 * indeterminate with no count, by the progress indicator's own rule that
 * a bar never sits at a literal 0. A round of one session shows a spinner
 * and no count, since "0 of 1" says nothing. The title carries no number.
 *
 * @module components/tugways/tug-restore-gate
 */

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef, type ReactElement } from "react";

import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useRestoreGate, type RestoreGateSnapshot } from "@/lib/restore-gate-store";
import { useVersionGateOpen } from "@/lib/macos-support";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import "./tug-alert.css";
import "./tug-restore-gate.css";

export function TugRestoreGate(): ReactElement {
  const gate = useRestoreGate();
  const versionGateOpen = useVersionGateOpen();
  const overlayRoot = useCanvasOverlay();
  const open = gate.open && !versionGateOpen;

  // Radix keeps Content mounted through its close animation, and by then the
  // store has already fallen closed — so the last frame a user sees would
  // read "0 of 0 sessions", a sentence about nothing. Hold the last snapshot
  // the gate was actually open for and render that on the way out. A ref,
  // not state: this must not schedule a render of its own, and the value is
  // only ever read during one the store already caused.
  const lastOpen = useRef<RestoreGateSnapshot | null>(null);
  if (gate.open) lastOpen.current = gate;
  const shown = gate.open ? gate : (lastOpen.current ?? gate);

  const total = shown.sessionsTotal;
  const done = Math.min(shown.sessionsDone, total);
  const single = total <= 1;
  const title = single ? "Restoring session" : "Restoring sessions";

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal container={overlayRoot}>
        <AlertDialog.Overlay className="tug-alert-overlay" />
        <AlertDialog.Content
          className="tug-alert-content tug-restore-gate"
          data-slot="tug-restore-gate"
          data-sessions-done={done}
          data-sessions-total={total}
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
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description className="tug-alert-message" asChild>
                <div>
                  <p>Tug is rebuilding your transcripts. Just a moment.</p>
                  {single ? (
                    <TugProgressIndicator
                      variant="spinner"
                      role="action"
                      state="running"
                      aria-label={title}
                    />
                  ) : (
                    <TugProgressIndicator
                      variant="bar"
                      size={8}
                      role="action"
                      state="running"
                      className="tug-restore-gate-bar"
                      aria-label={title}
                      value={done}
                      max={total}
                      showValue
                      formatValue={(v: number, m: number) =>
                        `${v.toLocaleString()} of ${m.toLocaleString()} sessions`
                      }
                    />
                  )}
                </div>
              </AlertDialog.Description>
            </div>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
