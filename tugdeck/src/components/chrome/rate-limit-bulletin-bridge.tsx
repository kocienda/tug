/**
 * RateLimitBulletinBridge — non-blocking usage notifications.
 *
 * The quota is **account-global**, so this is one bridge for the
 * whole deck. It replaces the old persistent `TugBanner` (which sat
 * over the UI for the entire warning window — the UI must NEVER block
 * on quota; the server enforces the real limit). Instead, each 5%
 * barrier between 80 and 100 fires exactly ONE `TugBulletin` per
 * reset window — `caution` below the limit, `danger` at it — and the
 * policy re-arms when the window's `resetsAt` rolls over.
 *
 * The decision logic is pure (`nextUsageBulletin` in
 * `lib/rate-limit.ts`); this component is only the [L02] subscription
 * plus the imperative `bulletin()` call, and renders nothing.
 *
 * Laws: [L02] store via `useSyncExternalStore`; the fired-barrier
 * memory is a ref (presentation bookkeeping, never rendered).
 *
 * @module components/chrome/rate-limit-bulletin-bridge
 */

import { useEffect, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { bulletin } from "@/components/tugways/tug-bulletin";
import type { RateLimitStore } from "../../lib/rate-limit-store";
import {
  USAGE_BULLETIN_IDLE,
  nextUsageBulletin,
  type UsageBulletinState,
} from "../../lib/rate-limit";

export interface RateLimitBulletinBridgeProps {
  /** App-level account-global quota store (constructed once at deck boot). */
  store: RateLimitStore;
}

/** Subscribe to the quota and fire barrier bulletins. Renders nothing. */
export function RateLimitBulletinBridge({
  store,
}: RateLimitBulletinBridgeProps): null {
  const rateLimit = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const stateRef = useRef<UsageBulletinState>(USAGE_BULLETIN_IDLE);

  useEffect(() => {
    if (rateLimit === null) return;
    const { state, fire } = nextUsageBulletin(
      stateRef.current,
      rateLimit,
      Date.now(),
    );
    stateRef.current = state;
    if (fire === null) return;
    const options = {
      description: "Check usage at claude.ai",
    };
    if (fire.tone === "danger") {
      bulletin.danger(fire.message, options);
    } else {
      bulletin.caution(fire.message, options);
    }
  }, [rateLimit]);

  return null;
}
