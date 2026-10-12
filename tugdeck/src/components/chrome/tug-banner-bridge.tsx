/**
 * TugBannerProvider — subscribes to connection disconnect state and renders TugBanner.
 *
 * Always mounted in the React tree (status variant, never conditionally rendered).
 * Bridges the TugConnection disconnect callback to the TugBanner `visible` prop.
 * Renders TugBanner with the caution tone while disconnected, showing reconnect info.
 */

import React, { useMemo } from "react";
import type { TugConnection, DisconnectState } from "../../connection";
import { TugBanner } from "@/components/tugways/tug-banner";
import { useSyncExternalStore } from "@/lib/gesture-scope";

// ---- Props ----

export interface TugBannerProviderProps {
  connection: TugConnection | null;
}

// ---- Component ----

/** Delay before showing the banner, so brief jitters at launch don't flash it. */
const SHOW_DELAY_MS = 2000;

/**
 * The banner's view of a connection's disconnect state, as a store the door's
 * `useSyncExternalStore` reads — so a reconnect that lands inside a gesture is
 * held with every other store's tell rather than committed in the gesture's
 * task. The snapshot is the state the banner shows: a disconnect only after it
 * has stood for {@link SHOW_DELAY_MS}, a reconnect at once.
 */
function bannerStateStore(connection: TugConnection | null): {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => DisconnectState | null;
} {
  let shown: DisconnectState | null = null;
  return {
    getSnapshot: () => shown,
    subscribe: (onStoreChange) => {
      if (!connection || typeof connection.onDisconnectState !== "function") {
        return () => {};
      }

      let showTimer: number | null = null;
      let latestDisconnectedState: DisconnectState | null = null;

      const unsubscribe = connection.onDisconnectState((state) => {
        if (state.disconnected) {
          // Stash the latest disconnect state so the timer always applies current info.
          latestDisconnectedState = state;

          // One delay timer at a time. While it is pending, further callbacks
          // only update latestDisconnectedState above, so it shows the latest
          // state when it fires; it clears itself as it fires, so a callback
          // after the banner is up arms a fresh one. A reconnect cancels a
          // pending timer below, so a stale timer never overwrites it.
          if (showTimer === null) {
            showTimer = window.setTimeout(() => {
              showTimer = null;
              if (latestDisconnectedState) {
                shown = latestDisconnectedState;
                onStoreChange();
              }
            }, SHOW_DELAY_MS);
          }
        } else {
          // Reconnected — cancel pending show and update immediately.
          latestDisconnectedState = null;
          if (showTimer !== null) {
            window.clearTimeout(showTimer);
            showTimer = null;
          }
          shown = state;
          onStoreChange();
        }
      });

      return () => {
        if (showTimer !== null) window.clearTimeout(showTimer);
        unsubscribe();
      };
    },
  };
}

/**
 * The banner's words for a disconnect state. The reason rides every form —
 * a reconnect under way included — so a failure the deck is recovering from
 * (an ingest Worker that died, say) is named while the banner stands.
 */
export function bannerMessage(state: DisconnectState | null): string {
  const reason = state?.reason ? ` (${state.reason})` : "";
  if (state?.reconnecting) return `Reconnecting${reason}...`;
  let message = `Disconnected${reason}`;
  if (state?.disconnected && state.countdown > 0) {
    message += ` — reconnecting in ${state.countdown}s...`;
  }
  return message;
}

export function TugBannerProvider({ connection }: TugBannerProviderProps) {
  const store = useMemo(() => bannerStateStore(connection), [connection]);
  const disconnectState = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const isVisible = Boolean(disconnectState?.disconnected);
  const message = bannerMessage(disconnectState);

  return (
    <TugBanner
      visible={isVisible}
      variant="status"
      tone="caution"
      message={message}
      icon="wifi-off"
    />
  );
}
