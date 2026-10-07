/**
 * TugRestoreRevealCover — the deck's busy cover over a cold restore's
 * reveals.
 *
 * A Session card's first transcript list mount after a cold restore is one
 * uninterruptible task on the main thread every card shares; for its length
 * the app answers nothing while its chrome goes on painting its last frame.
 * This cover says so, for exactly that long. Its lifetime is the deck's own
 * reveal queue (`restore-reveal-store.ts`): it is requested when a reveal is
 * enqueued, the queue waits for it to composite before the first reveal
 * runs, and it lifts on the frame after the queue drains. No frame from the
 * wire opens or closes it, so a card still waiting on its relay never holds
 * it ([L33]); that card's own `Z0` restore strip says it is loading.
 *
 * It catches the pointer over the whole deck and names the cards being
 * revealed. It shows no count, because it lifts between reveals while other
 * cards are still restoring, and a count would promise a finish it does not
 * keep. It does not take focus or set `inert`: inerting the deck would blur
 * the composer the user was in, and the restore must hand the deck back the
 * way it found it.
 *
 * The wrapper is always mounted; the store enters through
 * `useSyncExternalStore` ([L02]) and the wrapper's appearance is the
 * `data-state` attribute CSS reads ([L06]). The scrim and panel inside it
 * mount only while the cover is up, so a closed cover leaves no alert chrome
 * in the DOM for anything that counts app-modals to find.
 *
 * @module components/tugways/tug-restore-reveal-cover
 */

import { useCallback, type ReactElement } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";
import { restoreRevealStore } from "@/lib/restore-reveal-store";
import { cardTitleStore } from "@/lib/card-title-store";
import "./tug-alert.css";
import "./tug-restore-reveal-cover.css";

/** What the cover calls a card whose title has not published yet. */
const UNTITLED = "Session";

export function TugRestoreRevealCover(): ReactElement {
  const { cover, cardIds } = useSyncExternalStore(
    restoreRevealStore.subscribe,
    restoreRevealStore.getSnapshot,
  );
  const titles = useSyncExternalStore(
    cardTitleStore.subscribe,
    useCallback(
      () => cardIds.map((id) => cardTitleStore.get(id) ?? UNTITLED).join(" · "),
      [cardIds],
    ),
  );
  const state = cover ? "open" : "closed";

  return (
    <div
      className="tug-restore-reveal-cover"
      data-slot="tug-restore-reveal-cover"
      data-state={state}
      aria-hidden={!cover}
      aria-busy={cover}
      role="status"
    >
      {cover && <div className="tug-alert-overlay" data-state={state} />}
      {cover && (
        <div className="tug-alert-content tug-restore-reveal-panel" data-state={state}>
          <div className="tug-alert-body" data-has-message={titles !== "" || undefined}>
            <div className="tug-alert-text">
              <p className="tug-alert-title">Restoring sessions…</p>
              {titles !== "" && (
                <p className="tug-alert-message" data-slot="tug-restore-reveal-titles">
                  {titles}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
