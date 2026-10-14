/**
 * BodyPlacementBeacon — zero-output component that tells the host where each
 * body card's body stands, after every deck commit.
 *
 * Mounted once in `DeckCanvas`, as the sibling just after the canvas
 * container it measures under: a ref is attached in the same layout pass that
 * runs the effects, in tree order, so only a later sibling finds it set at
 * mount — and by then every pane's own layout effects in the commit have run,
 * so the placeholders it measures are the ones the commit produced. The measurement, the visibility
 * rule, the settle's hold and the wakes that move a placeholder without a
 * commit are `lib/body-placement.ts`; this component is only where they are
 * attached to the deck's life. When the host makes no bodies it installs
 * nothing, and its per-commit effect returns at once.
 *
 * Laws: [L03] (the measurement runs in a layout effect, after the commit it
 * reads), [L06] (the rects go to the host, never into React state), [L27]
 * (the install returns its release), [D211] (no reader in a settle's set-up).
 *
 * @module components/chrome/body-placement-beacon
 */

import { useLayoutEffect, useMemo, type RefObject } from "react";
import { useDeckManager } from "@/deck-manager-context";
import { BodyPlacer } from "@/lib/body-placement";

export interface BodyPlacementBeaconProps {
  /** The canvas container: what is measured, and what carries the settle's mark. */
  containerRef: RefObject<HTMLDivElement | null>;
}

export function BodyPlacementBeacon({ containerRef }: BodyPlacementBeaconProps): null {
  const store = useDeckManager();
  const placer = useMemo(() => new BodyPlacer(store), [store]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    return placer.install(container);
  }, [placer, containerRef]);
  useLayoutEffect(() => {
    placer.afterCommit();
  });
  return null;
}
