/**
 * session-pending-context-strip.tsx — the composer-side reminder of staged
 * shell / `/btw` context.
 *
 * Staged context (via a row's Add-to-context toggle, or a route's VISIBILITY=
 * Context) rides the next `❯` submission — but on the `❯` route the VISIBILITY
 * chip is absent and the source rows may be scrolled away, so without this strip
 * a queued item is invisible right where the user is about to send. This strip
 * sits at the top of the composer pane and lists what will ride the next
 * message: one removable chip per staged item, plus a Clear. It self-hides when
 * the queue is empty (the overwhelmingly common state), so it costs no space
 * until something is staged.
 *
 * Reads the per-card {@link PendingContextStore} via `useSyncExternalStore`
 * ([L02]); appearance is CSS-only ([L06]). Each chip's ✕ dispatches
 * `UNSTAGE_CONTEXT` to this strip's responder ([L11]).
 *
 * @module components/tugways/cards/session-pending-context-strip
 */

import React from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { MessageSquareShare } from "lucide-react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugChip } from "@/components/tugways/tug-chip";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import type { PendingContextStore } from "@/lib/pending-context-store";

import "./session-pending-context-strip.css";

export interface SessionPendingContextStripProps {
  pendingContextStore: PendingContextStore;
}

/**
 * The staged-context strip, or `null` when nothing is staged. Rendered at the
 * top of the composer pane.
 */
export function SessionPendingContextStrip({
  pendingContextStore,
}: SessionPendingContextStripProps): React.ReactElement | null {
  const snapshot = useSyncExternalStore(
    pendingContextStore.subscribe,
    pendingContextStore.getSnapshot,
  );
  const { items } = snapshot;
  const responderId = React.useId();
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.UNSTAGE_CONTEXT]: (event) => {
        if (typeof event.value === "string") pendingContextStore.unstage(event.value);
      },
    },
  });
  if (items.length === 0) return null;

  return (
    <ResponderScope>
    <div
      ref={responderRef}
      className="session-pending-context-strip"
      data-slot="session-pending-context-strip"
    >
      <span className="session-pending-context-strip-lead" aria-hidden>
        <MessageSquareShare size={13} strokeWidth={2} />
      </span>
      <span className="session-pending-context-strip-caption">
        Rides next message:
      </span>
      <div className="session-pending-context-strip-chips">
        {items.map((item) => (
          <TugChip
            key={item.id}
            className="session-pending-context-chip"
            title={item.label}
            removeAction={TUG_ACTIONS.UNSTAGE_CONTEXT}
            value={item.id}
            removeLabel={`Remove ${item.label} from the next submission's context`}
          >
            {item.label}
          </TugChip>
        ))}
      </div>
      <TugPushButton
        emphasis="ghost"
        role="action"
        size="2xs"
        aria-label="Clear staged context"
        title="Clear staged context"
        onClick={() => pendingContextStore.clear()}
      >
        Clear
      </TugPushButton>
    </div>
    </ResponderScope>
  );
}
