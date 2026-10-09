/**
 * gallery-prompt-entry.tsx — TugPromptEntry showcase card.
 *
 * Mounts `TugPromptEntry` in a flex column. A placeholder stands in for a
 * transcript and flexes into the remaining height; the entry below is
 * content-sized — the editor auto-heights up to `maxRows` then scrolls, so
 * the entry is as tall as the prompt. No split pane, no JS sizing, no
 * maximize in the showcase. The card wires:
 *
 *   • A `TestFrameChannel`-backed `CodeSessionStore` paired with a fresh
 *     `ConnectionLifecycle` that never receives transport events (no real
 *     Claude backend is required in the gallery).
 *   • Live `@` file completion via `FileTreeStore` against the real
 *     connection-singleton, mirroring `gallery-prompt-input`. When no
 *     live connection is available (tests, first paint before
 *     `getConnection()` resolves), the `@` provider falls back to an
 *     empty stable closure so the engine's typeahead trigger stays
 *     wired regardless of timing.
 *   • Offline `/` slash-command completion sourced from the captured
 *     `capabilities/<LATEST>/system-metadata.jsonl` via the Vite virtual
 *     module. The gallery card's `CodeSessionStore` runs against a mock
 *     connection, so the live `SESSION_SIDEBAND` frame never reaches the
 *     card; the fixture keeps the `/` demo populated with real plugin
 *     skills and agents. Wrapped in a position-0 gate so `/` mid-text
 *     produces an empty popup (D5.c P1).
 *   • A local `PromptHistoryStore` for arrow-up/down recall.
 *
 * The entry is mounted inside a `TugBox` with `inset={false}` so the
 * pane fills edge-to-edge. The split pane's grip pill is suppressed via
 * `showHandle={false}` and the sash is non-draggable (`disabled`) — the
 * line is a pure visual divider; sizing is content-driven or pegged.
 */

import { useEffect, useMemo, useRef } from "react";

import { TugPromptEntry, type TugPromptEntryDelegate } from "../tug-prompt-entry";
import { TugBox } from "../tug-box";
import { TugBadge } from "../tug-badge";
import { useResponderForm } from "../use-responder-form";
import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { PromptHistoryStore } from "@/lib/prompt-history-store";
import { FileTreeStore } from "@/lib/filetree-store";
import { FeedStore, type FeedStoreFilter } from "@/lib/feed-store";
import { getConnection } from "@/lib/connection-singleton";
import { presentWorkspaceKey } from "@/card-registry";
import { FeedId } from "@/protocol";
import type { CompletionProvider } from "@/lib/tug-text-types";
import { useCardWorkspaceKey } from "@/components/tugways/hooks/use-card-workspace-key";
import { getFixtureSessionMetadataStore } from "./completion-fixtures/system-metadata-fixture";
import { wrapPositionZero } from "./completion-providers/position-zero";

import "./gallery-prompt-entry.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stable identifier for the gallery's mock `CodeSessionStore`. Not tied
 * to any real Claude session — the gallery runs the turn-state surface
 * entirely against the `TestFrameChannel`.
 */
export const GALLERY_TUG_SESSION_ID = "gallery-prompt-entry-session";

/** Stable empty completion provider for the unbound / no-connection window. */
const EMPTY_FILE_COMPLETION_PROVIDER = ((_q: string) => []) as CompletionProvider;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GalleryPromptEntryProps {
  /**
   * Card instance id. Forwarded from the card registry's `contentFactory`
   * callback and used for per-card workspace binding (via
   * `useCardWorkspaceKey`) plus the responder scope id of the embedded
   * `TugPromptEntry`.
   */
  cardId: string;
}

// ---------------------------------------------------------------------------
// GalleryPromptEntry
// ---------------------------------------------------------------------------

export function GalleryPromptEntry({ cardId }: GalleryPromptEntryProps) {
  // --- Mock-backed CodeSessionStore (turn-state surface). ---
  const mockSessionRef = useRef<{
    connection: TestFrameChannel;
    codeSessionStore: CodeSessionStore;
  } | null>(null);
  if (mockSessionRef.current === null) {
    const connection = new TestFrameChannel();
    // Fresh lifecycle for the gallery card. No transport events ever
    // fire against it — the gallery has no real WebSocket — so the
    // `transport_close` reducer event is effectively unreachable.
    const lifecycle = new ConnectionLifecycle();
    const codeSessionStore = new CodeSessionStore({
      conn: connection as unknown as TugConnection,
      lifecycle,
      tugSessionId: GALLERY_TUG_SESSION_ID,
      // Gallery card models a fresh session for visual demos; no
      // resume binding is in play. The choice is purely cosmetic
      // here since the gallery never wires up a real binding store.
      sessionMode: "new",
    });
    mockSessionRef.current = { connection, codeSessionStore };
  }
  useEffect(() => {
    return () => {
      mockSessionRef.current?.codeSessionStore.dispose();
      mockSessionRef.current = null;
    };
  }, []);

  // --- File tree stack with workspace filter. ---
  const workspaceKey = useCardWorkspaceKey(cardId);
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
  const fileTreeStackRef = useRef<{
    feedStore: FeedStore;
    fileTreeStore: FileTreeStore;
    provider: CompletionProvider;
  } | null>(null);
  if (fileTreeStackRef.current === null) {
    const connection = getConnection();
    if (connection) {
      const feedStore = new FeedStore(
        connection,
        [FeedId.FILETREE],
        undefined,
        workspaceFilter,
      );
      const fileTreeStore = new FileTreeStore(feedStore, FeedId.FILETREE);
      const provider = fileTreeStore.getFileCompletionProvider();
      fileTreeStackRef.current = { feedStore, fileTreeStore, provider };
    } else {
      console.warn("GalleryPromptEntry: connection not available at render");
    }
  }
  useEffect(() => {
    fileTreeStackRef.current?.feedStore.setFilter(workspaceFilter);
  }, [workspaceFilter]);
  useEffect(() => {
    return () => {
      const stack = fileTreeStackRef.current;
      if (stack) {
        stack.fileTreeStore.dispose();
        stack.feedStore.dispose();
        fileTreeStackRef.current = null;
      }
    };
  }, []);

  // --- Local PromptHistoryStore (no backend wiring). ---
  const historyStoreRef = useRef<PromptHistoryStore | null>(null);
  if (historyStoreRef.current === null) {
    historyStoreRef.current = new PromptHistoryStore();
  }

  // --- Entry handle (declared here so completionProviders' memo can read
  // entryDelegateRef for the position-0 gate). Stable ref identity — the
  // memo below uses [] deps correctly. ---
  const entryDelegateRef = useRef<TugPromptEntryDelegate | null>(null);

  // --- Compose completion providers. ---
  // Stable — provider identities are owned by refs and don't change for
  // the card's lifetime, so the memo's [] deps are correct.
  //
  //   `@`: live `FileTreeStore` against the real connection, mirroring
  //        gallery-prompt-input. Falls back to EMPTY_FILE_COMPLETION_PROVIDER
  //        if `getConnection()` was null at first render so the trigger
  //        stays wired regardless of timing.
  //
  //   `/`: fixture `SessionMetadataStore` sourced from the captured
  //        `capabilities/<LATEST>/system-metadata.jsonl`, wrapped with the
  //        position-0 gate so `/` mid-text yields an empty popup.
  const completionProviders = useMemo(() => {
    const innerSlash = getFixtureSessionMetadataStore().getCommandCompletionProvider();
    return {
      "@": fileTreeStackRef.current?.provider ?? EMPTY_FILE_COMPLETION_PROVIDER,
      "/": wrapPositionZero(entryDelegateRef, "/", innerSlash),
    };
  }, []);

  // --- Responder scope for the card. ---
  const { ResponderScope, responderRef } = useResponderForm({});

  // --- Status row content. ---
  const statusContent = (
    <TugBadge size="sm" emphasis="tinted" role="data">
      Project path /gallery/demo
    </TugBadge>
  );

  return (
    // Flex column ([L06]/[L13] — no JS sizing). A placeholder stands in for
    // a transcript and flexes into the remaining height; the entry region
    // below is content-sized — the editor auto-heights up to `maxRows` then
    // scrolls, so the entry is as tall as the prompt and the placeholder
    // takes the rest. No split pane, no content-sizing observers.
    <div className="gallery-prompt-entry-card" data-testid="gallery-prompt-entry">
      <div className="gallery-prompt-entry-placeholder" aria-hidden="true" />
      <div className="gallery-prompt-entry-region">
        <ResponderScope>
          <TugBox
            ref={(el) =>
              (responderRef as (node: Element | null) => void)(
                el as Element | null,
              )
            }
            variant="plain"
            inset={false}
            className="gallery-prompt-entry-entry-pane"
          >
            <TugPromptEntry
              ref={entryDelegateRef}
              id={`${cardId}-entry`}
              codeSessionStore={mockSessionRef.current!.codeSessionStore}
              sessionMetadataStore={getFixtureSessionMetadataStore()}
              historyStore={historyStoreRef.current}
              completionProviders={completionProviders}
              statusContent={statusContent}
            />
          </TugBox>
        </ResponderScope>
      </div>
    </div>
  );
}
