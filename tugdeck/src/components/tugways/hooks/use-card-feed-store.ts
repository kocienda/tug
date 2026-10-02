/**
 * use-card-feed-store.ts — host-side hook that owns a card's FeedStore
 * subscription pipeline.
 *
 * Given the card's host pane id and the registration's default feed ids,
 * this hook creates a per-card `FeedStore` (lazy, on first non-empty
 * feedIds render), keeps its workspace filter in sync with the pane's
 * current workspace key, subscribes via `useSyncExternalStore`, and
 * disposes the store on unmount. Returns the decoded `feedData` map the
 * harness hands to `CardDataProvider`.
 *
 * @module components/tugways/hooks/use-card-feed-store
 */

import { useEffect, useMemo, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { presentWorkspaceKey } from "@/card-registry";
import { FeedStore, type FeedStoreFilter } from "@/lib/feed-store";
import { getConnection } from "@/lib/connection-singleton";
import type { FeedIdValue } from "@/protocol";

import { useCardWorkspaceKey } from "./use-card-workspace-key";

export function useCardFeedStore(
  hostStackId: string,
  feedIds: readonly FeedIdValue[],
): Map<number, unknown> {
  const workspaceKey = useCardWorkspaceKey(hostStackId);
  const workspaceFilter: FeedStoreFilter = useMemo(
    () =>
      workspaceKey
        ? (_feedId, decoded) =>
            typeof decoded === "object" &&
            decoded !== null &&
            "workspace_key" in decoded &&
            (decoded as { workspace_key: unknown }).workspace_key === workspaceKey
        : presentWorkspaceKey,
    [workspaceKey],
  );

  const feedStoreRef = useRef<FeedStore | null>(null);
  if (feedStoreRef.current === null && feedIds.length > 0) {
    const conn = getConnection();
    if (conn !== null) {
      feedStoreRef.current = new FeedStore(conn, feedIds, undefined, workspaceFilter);
    }
  }

  useEffect(() => {
    feedStoreRef.current?.setFilter(workspaceFilter);
  }, [workspaceFilter]);

  const noopSubscribe = useRef((_listener: () => void) => () => {}).current;
  const emptyMapRef = useRef(new Map<number, unknown>());
  const emptySnapshot = useRef(() => emptyMapRef.current).current;

  const feedData = useSyncExternalStore(
    feedStoreRef.current?.subscribe ?? noopSubscribe,
    feedStoreRef.current?.getSnapshot ?? emptySnapshot,
  );

  useEffect(() => {
    return () => {
      feedStoreRef.current?.dispose();
      feedStoreRef.current = null;
    };
  }, []);

  return feedData;
}
