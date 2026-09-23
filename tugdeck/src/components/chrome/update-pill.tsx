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
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugIconButton } from "@/components/tugways/tug-icon-button";

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

/** The one sentence. The version says *which* update, never what it is doing. */
function pillLabel(version: string): string {
  return version === "" ? "A Tug update is available" : `Tug ${version} is available`;
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
      <button
        type="button"
        className="tugx-update-pill-button"
        data-testid="update-pill"
        data-stage={state.stage}
        aria-label={`${pillLabel(state.version)} — open the update wizard`}
        onClick={requestUpdateTug}
      >
        <TugBadge
          emphasis="filled"
          role="accent"
          size="lg"
          icon={<ArrowDownToLine aria-hidden />}
        >
          {pillLabel(state.version)}
        </TugBadge>
      </button>
      <TugIconButton
        icon={<X size={14} aria-hidden />}
        aria-label="Hide the update notice"
        title="Hide"
        data-testid="update-pill-hide"
        className="tugx-update-pill-hide"
        onClick={() => setHidden(true)}
      />
    </div>,
    overlayRoot,
  );
}
