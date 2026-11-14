/**
 * RestoreGate — the app-wide, blocking "restoring sessions" gate. A
 * sibling of {@link VersionGate} and {@link ConfigureTug} at the deck
 * root, on the same TugAlert chrome (Radix AlertDialog portalled into
 * the canvas overlay).
 *
 * ## Why an app-modal
 *
 * It is the cover for "visible but not yet usable". A workspace arriving
 * cold — at launch, or on its first visit — is on screen at once, and its
 * resumed sessions are not yet there: each card stands a skeleton while
 * its page is made, its transcript replayed, and the list mounted and
 * measured. The gate says so for as long as that is true, once: it opens
 * with the arrival, and closes when the last such card has settled.
 *
 * It was written for a harder case. Every card then shared one thread, a
 * cold restore's reveal was one uninterruptible task on it, and the app
 * answered nothing while it ran, in any card, under chrome that went on
 * painting its last frame. Each card now has its own page, so one card's
 * restore blocks that card alone, and the gate was kept by decision for
 * the job above: a deck of skeletons with no word over it reads as an app
 * that is ready and is not.
 *
 * Precedence (Spec S02): the strictly-required gates win. This one
 * suppresses itself while the macOS version gate is open, so the two
 * app-modals never stack.
 *
 * No dismiss: there is nothing behind it to interact with. It closes
 * when the workspace can be used — which is not `replay_complete`. The
 * replay ingests in under 100 ms; the reveal behind it, the list's
 * first mount and the settle of its heights, is the stretch where the
 * card still shows nothing. A resumed card in the shown workspace counts
 * toward this gate from the moment the restore pass names it, before its
 * page exists, through both (`deriveRestoreGateHold`), and lets go on its
 * first settle — the moment its skeleton comes down.
 *
 * Over an arrival — cards a restore pass named — it stays on screen at
 * least 1.25 s (`GATE_FLOOR_MS`): a gate up for a few hundred milliseconds
 * is a flash of its own. Through the held time it reads every session
 * finished. One card resuming on its own lets it go at its settle.
 *
 * Every window the gate holds has a horizon. The replay window ends on
 * the silence deadline (`REPLAY_SILENCE_DEADLINE_MS`,
 * `code-session-store/reducer.ts`): a card that has sat in `replaying`
 * for the deadline with no frame arriving raises an error on itself,
 * which drops it out of the fold and shows the failure on that card
 * alone. The reveal ends on `COLD_REVEAL_SETTLE_BOUND_MS` if the list
 * never settles. So one card's lost frame or unmeasured list can never
 * hold every other card behind a modal with no way out — which, with no
 * dismiss, is the only way out there is. Those horizons are the card's
 * page's; the shell keeps its own over them (`restore-gate-store.ts`): only
 * a card in the shown workspace whose page is awake holds, an open gate
 * reads every card again each two seconds, and no card holds past twenty.
 *
 * ## What it says
 *
 * One count, of sessions: "2 of 5 sessions" beside a bar over the same
 * numbers, under the title "Restoring sessions". The total is fixed when
 * the round opens and the count only rises (`restore-gate-store.ts`), so
 * the bar fills in steps, one per session whose wait has ended — the
 * truth about the work. Before the first session finishes the bar runs
 * indeterminate with no count, by the progress indicator's own rule that
 * a bar never sits at a literal 0. A round of one session shows that same
 * bar as a barber pole throughout and no count, since "0 of 1" says
 * nothing. The title carries no number.
 *
 * @module components/chrome/restore-gate
 */

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef, type ReactElement } from "react";

import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useRestoreGate, type RestoreGateSnapshot } from "@/lib/restore-gate-store";
import { useVersionGateOpen } from "@/lib/macos-support";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import "@/components/tugways/tug-alert.css";
import "./restore-gate.css";

export function RestoreGate(): ReactElement {
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
                  <p>
                    {single
                      ? "Rebuilding your transcript…"
                      : "Rebuilding your transcripts…"}
                  </p>
                  {single ? (
                    <TugProgressIndicator
                      variant="bar"
                      size={8}
                      tone="action"
                      state="running"
                      className="tug-restore-gate-bar"
                      aria-label={title}
                    />
                  ) : (
                    <TugProgressIndicator
                      variant="bar"
                      size={8}
                      tone="action"
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
