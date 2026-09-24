/**
 * UpdatePill — the one modeless piece of the update feature, and it says one
 * thing.
 *
 * An update exists. That is the whole sentence, and the whole job ([B02]). The
 * surface this replaces narrated every stage the flow passed through — *Checking
 * for updates…*, *Downloading Tug 0.8.3…*, *Unpacking the update…*,
 * *Installing…* — which is the opposite of one purpose ([F08]), and is what the
 * wizard is for. Clicking the pill opens `UpdateTug`; the `x` puts the pill away.
 *
 * # One object, two hit targets
 *
 * The pill is a single painted surface holding both controls: the label on the
 * left opens the wizard, the `x` at its right edge hides it. The `x` used to
 * hang outside the pill as a bare sibling floating over whatever the canvas had
 * at that spot, which read as a second, unrelated thing rather than as part of
 * the notice — so it is inside the fill now, sharing its background and its
 * squared top corners.
 *
 * That is also why the surface is painted here rather than by `TugBadge`. A
 * badge is display-only and puts its children inside a clipping text span, so a
 * badge can be the pill *or* it can hold the two buttons, never both. The fill
 * is two shipping tokens — the same `filled` / `accent` pair the badge would
 * have resolved — so nothing about the colour is invented here ([L20]).
 *
 * # When it shows
 *
 * Whenever an update is **live** and the wizard is **closed**. Live means an
 * update actually exists: `available` through `installing`. A check in flight is
 * not an update — nobody knows yet whether there is one — and `upToDate` is a
 * check that found nothing, which the user is not owed a notice about at all. So
 * a scheduled check runs to its end and lights nothing unless it finds
 * something, which is the one thing every version of this feature has agreed on
 * ([B03], and the non-goal that names it).
 *
 * `error` shows nothing either, and that is a decision rather than an omission:
 * the pill's only sentence is *an update is available*, and a failed check has
 * no update to be available. The wizard carries the error, the menu item still
 * opens the wizard, and a pill that appeared to say something it cannot say
 * would be the narration this component exists to remove.
 *
 * # The two questions the brief left open, settled here
 *
 * **No second sentence at `readyToInstall`.** Resume clarity argues a user who
 * paused after the download deserves *ready to install*; one purpose argues the
 * text never changes. `[B02]` is explicit — "text that says an update exists,
 * never what the flow is doing" — and *ready to install* is a fact about where
 * the flow got to, which is precisely the thing the wizard is now there to show.
 * The version moves with the update because that is which update exists, not
 * what is happening to it.
 *
 * **The `x` does not survive a deck reload.** The hide is this component's
 * state, the store behind it is in memory, and the host replays its snapshot to
 * a fresh deck — so a reload brings the pill back. That is the simplest answer
 * and the right one: the alternative is the host remembering a deck-side
 * preference, which is a bridge field and a persistence question for a control
 * whose whole meaning is "not now". It does survive every stage transition
 * within one flow, which is the part that matters — a pill hidden while
 * `downloading` does not reappear at `readyToInstall`.
 *
 * # What the `x` does not do
 *
 * It answers Sparkle nothing. No reply closure is consumed, no host state moves,
 * the update stays exactly as live as it was, and the Tug-menu item still opens
 * the wizard afterwards. Hiding is not dismissing, and the update is not
 * declined by being put out of sight ([B04]'s pause, at the pill's scale).
 *
 * Laws: [L02] the snapshot and the wizard's open flag both enter through
 * `useSyncExternalStore`; [L19] `.tsx`/`.css` pair, `data-slot`.
 *
 * @module components/chrome/update-pill
 */

import "./update-pill.css";

import { ArrowDownToLine, X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useUpdateState, type UpdateStage } from "@/lib/update-store";
import {
  requestUpdateTug,
  useUpdateTugOpen,
} from "@/lib/update-tug-request-store";

/**
 * The stages in which an update exists.
 *
 * `checking` is not one: a check in flight has found nothing yet, and a pill
 * that appeared at its start would be claiming an update before anybody knew
 * there was one. `upToDate` and `error` are not either; see the module note.
 */
const LIVE_STAGES: ReadonlySet<UpdateStage> = new Set<UpdateStage>([
  "available",
  "downloading",
  "extracting",
  "readyToInstall",
  "installing",
]);

/**
 * The one sentence. The version says *which* update, never what it is doing.
 *
 * Spelled `v0.9.0`, the same as the wizard's Check row — the pill is the door
 * to that panel, and one version wearing two spellings two lines apart reads
 * as two different facts.
 */
function pillLabel(version: string): string {
  return version === ""
    ? "A Tug update is available"
    : `Tug v${version} is available`;
}

export function UpdatePill(): ReactElement | null {
  const state = useUpdateState();
  const overlayRoot = useCanvasOverlay();
  const wizardOpen = useUpdateTugOpen();
  const [hidden, setHidden] = useState(false);

  const live = LIVE_STAGES.has(state.stage);

  // The hide lasts the rest of *this* update's flow and no longer. The component
  // stays mounted while it is hiding — it renders null rather than unmounting —
  // so the reset is explicit here rather than a side effect of going away.
  useEffect(() => {
    if (!live) setHidden(false);
  }, [live]);

  if (!live || hidden || wizardOpen) return null;

  return createPortal(
    <div className="tugx-update-pill-anchor" data-slot="update-pill">
      <div className="tugx-update-pill" data-stage={state.stage}>
        <button
          type="button"
          className="tugx-update-pill-open"
          data-testid="update-pill"
          data-stage={state.stage}
          aria-label={`${pillLabel(state.version)} — open the update wizard`}
          onClick={requestUpdateTug}
        >
          <ArrowDownToLine size={12} aria-hidden />
          <span className="tugx-update-pill-text">
            {pillLabel(state.version)}
          </span>
        </button>
        <button
          type="button"
          className="tugx-update-pill-hide"
          data-testid="update-pill-hide"
          aria-label="Hide the update notice"
          title="Hide"
          onClick={() => setHidden(true)}
        >
          <X size={12} aria-hidden />
        </button>
      </div>
    </div>,
    overlayRoot,
  );
}
