/**
 * SessionPhaseDot — a session's liveness, as a leaf subscription.
 *
 * Liveness is not identity, and this component is where that decision becomes
 * structure. The identity record carries no phase field: phase lives on a
 * per-*card* `codeSessionStore` whose snapshot is the whole session state, and
 * a resolver that subscribed to that snapshot would wake every chip, line, row,
 * and masthead in the app on every transcript event.
 *
 * So the dot is its own leaf, composed INTO a row, a chip, or a masthead as a
 * child. A reducer wake repaints the dot and nothing else. Identity and liveness
 * are two subscriptions with two keys, and the component that mounts them both
 * is where they meet.
 *
 * Keyed by **session**, not by card: the dot is the session's mark on every
 * surface that names one, and most of those surfaces hold only a session id.
 * {@link useSessionPhase} owns the session → card → services → snapshot walk and
 * answers `idle` for a session whose live state cannot be reached, so a closed
 * or external row gets a quiet dot rather than no dot or a red one.
 *
 * **The dot carries no phase identifier, and that is the point.** It reads the
 * visual TRIPLE — `{ role, state, shape }` — rather than the phase key, and
 * passes the three as props. The six keys a working session flips between
 * (`streaming`, `tool_work`, `submitting`, `awaiting_first_token`,
 * `replaying`, `waking`) all map to the same triple, so none of those
 * crossings writes anything to the DOM. Passing the key instead put a
 * `data-phase` on the element and rewrote it on every flip, invalidating
 * style for a subtree whose appearance was identical before and after. A
 * surface that genuinely needs to name the phase reads the LABEL, which is
 * phase-keyed and stays so; this dot is not one of them.
 *
 * Laws: [L02] the phase enters through `useSyncExternalStore` (inside the hook);
 *       [L06] the pulse is CSS on an engine attribute, never React state;
 *       [L13] motion is the indicator's.
 */

import React from "react";

import { dotDriftFor } from "@/components/tugways/internal/tug-progress-pulsing-dot";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { useSessionPhaseVisual } from "@/lib/code-session-store/use-session-phase";

export interface SessionPhaseDotProps {
  /** The session whose liveness this dot reads. */
  sessionId: string;
  /** The dot's box, in px. A caller choice — the row declares its own. */
  size: number;
  /**
   * Whether the dot's period is jittered. On in a LIST of separate sessions,
   * each doing its own work: on one exact period a column of them reads as a
   * single mechanism with several heads, and a few percent of spread pulls
   * them apart over a dozen breaths. Off everywhere the dots belong to one
   * thing and must stay locked.
   * @default false
   */
  drift?: boolean;
}

export function SessionPhaseDot({
  sessionId,
  size,
  drift = false,
}: SessionPhaseDotProps): React.ReactElement {
  const visual = useSessionPhaseVisual(sessionId);
  return (
    <TugProgressIndicator
      variant="pulsing-dot"
      size={size}
      // The triple, spread as three props. `shape` is returned only for
      // `background`, so `undefined` here correctly leaves the indicator at
      // its `dot` default rather than naming one.
      role={visual.role}
      state={visual.state}
      shape={visual.shape}
      // Keyed on the session so it keeps its rate across a filter, a reorder, a
      // scroll out of view and back — and across a rebind onto another card.
      style={drift ? dotDriftFor(sessionId) : undefined}
      aria-hidden
    />
  );
}
