/**
 * lens-section-presence-probe.tsx — the writer for `lens-section-presence`.
 *
 * One probe is mounted per **registered** section kind, whether or not that
 * section renders. That independence is the whole point: a section's own body
 * cannot decide whether the section exists, because deciding "no" would unmount
 * the decider (see `lens-section-presence.ts`).
 *
 * The probe renders nothing. It exists to hold whatever subscription the
 * section's `presence` hook needs — the hook is called as a hook, in this
 * component's own boundary, following `LensSectionSlot`'s precedent in
 * `lens-section-band.tsx`. Rules of hooks hold because a probe instance is
 * keyed by `kind` and a kind's `presence` is fixed at registration, so one
 * instance's hook sequence never varies.
 *
 * Publication is a `useLayoutEffect` ([L03]): `LensContent` computes its group
 * order, spatial order, and ⌘L seed from the visible order, and all three must
 * be right before the first key event of the commit that changed them.
 *
 * @module components/lens/lens-section-presence-probe
 */

import React, { useLayoutEffect } from "react";

import type {
  LensSectionDefinition,
  LensSectionHost,
} from "./lens-section-registry";
import { setSectionPresent } from "./lens-section-presence";

export interface LensSectionPresenceProbeProps {
  def: LensSectionDefinition;
  host: LensSectionHost;
}

export function LensSectionPresenceProbe({
  def,
  host,
}: LensSectionPresenceProbeProps): null {
  // A section that declares no `presence` is always present — the behavior
  // every section had before the capability existed.
  const present = def.presence?.(host) ?? true;

  useLayoutEffect(() => {
    setSectionPresent(def.kind, present);
    // A probe going away takes its claim with it rather than leaving a stale
    // `false` behind for a kind that no longer has a writer.
    return () => setSectionPresent(def.kind, true);
  }, [def.kind, present]);

  return null;
}
