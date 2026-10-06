/**
 * use-after-motion.ts — a value React takes up only once the motion gate is open.
 *
 * `useDeferredValue` keeps a costly render out of the urgent commit, which is
 * what it is for, but it does not choose when the deferred commit lands: React
 * renders it at transition priority and commits it the moment it finishes —
 * and when the urgent commit was a settle's set-up, that moment is inside the
 * motion the set-up just launched. The Layout card's preview layers were that
 * case: a 677-fibre commit landing 70 ms into a column rejoin, behind a motion
 * gate that holds every store's tell and cannot hold React's own scheduler.
 *
 * This hook is the gated form. A new value waits for the gate
 * (`afterGesture`, which runs at once when no gesture holds it), and is then
 * taken up at transition priority, so it still renders in slices and still
 * never joins an urgent commit. A value that changes again while it waits is
 * taken up once, at its latest.
 *
 * Compared by value (`deepEqual` unless the caller says otherwise), because a
 * caller that rebuilds its value every render — the Layout card's layers are
 * mapped afresh each time — would otherwise take up an equal value forever,
 * re-rendering itself with each one.
 */

import { startTransition, useEffect, useRef, useState } from "react";
import { deepEqual } from "@/lib/deep-equal";
import { afterGesture } from "@/lib/gesture-scope";

export function useAfterMotion<T>(
  value: T,
  equal: (a: T, b: T) => boolean = deepEqual,
): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  const waiting = useRef(false);
  const same = equal(value, shown);
  useEffect(() => {
    if (same || waiting.current) return;
    waiting.current = true;
    afterGesture(() => {
      waiting.current = false;
      startTransition(() => setShown(() => latest.current));
    });
  }, [same, value]);
  return shown;
}
