/**
 * use-permission-mode.ts — the session-card's permission-mode `Shift+Tab` cycle
 * plus its per-card persistence and mount-restore, factored out of
 * `session-card.tsx`.
 *
 * The chip itself ([ai-chip.tsx]) only *displays* the mode; the
 * behavior — advancing the cycle, sending the IPC, persisting per card, and
 * restoring on relaunch — lives here so the session card's card-content responder
 * can register a single `cycle` handler.
 *
 * Mutations round-trip per [D03]: `cycle()` sends a `permission_mode` frame
 * (via `CodeSessionStore.setPermissionMode`) and the chip reflects the new
 * mode from the post-mutation `system_metadata` (owned by
 * `SessionMetadataStore`), not from the keypress.
 *
 * Persistence mirrors `diff-view-pref.ts`: an optimistic `setLocalValue` so
 * `useSyncExternalStore` readers reflect instantly, plus a PUT to
 * `/api/defaults/dev.permission-mode/<cardId>` ([D07], `feedback_no_localstorage`).
 *
 * Laws: [L02] store subscription, [L07] handler reads current state through
 *       the store (no stale render closure)
 */

import { useCallback, useEffect, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionStore } from "@/lib/code-session-store";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import {
  PERMISSION_MODE_DEFAULT_DOMAIN,
  PERMISSION_MODE_DEFAULT_KEY,
  PERMISSION_MODE_DOMAIN,
  cyclePermissionMode,
  parsePersistedPermissionMode,
  resolveSeedPermissionMode,
} from "@/lib/permission-mode";
import type { PermissionMode } from "@tugproto/inbound";

/**
 * Persist a card's permission mode: optimistic local-cache write (so
 * `useTugbankValue` readers re-render instantly) plus an HTTP PUT to the
 * defaults endpoint. PUT failure logs and otherwise vanishes — the cache
 * holds for the session and a fresh load falls back to the default.
 */
export function writePersistedPermissionMode(cardId: string, mode: string): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(PERMISSION_MODE_DOMAIN, cardId, {
      kind: "string",
      value: mode,
    });
  }
  const url = `/api/defaults/${PERMISSION_MODE_DOMAIN}/${encodeURIComponent(cardId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: mode }),
  }).catch((err) => {
    console.warn(`[permission-mode] PUT failed for card ${cardId}:`, err);
  });
}

export interface UsePermissionModeOptions {
  /** The card whose mode is cycled / persisted / restored. */
  cardId: string;
  /** Store that sends the `permission_mode` frame. */
  codeSessionStore: CodeSessionStore;
  /** Store supplying the live mode the cycle reads and the restore aligns. */
  sessionMetadataStore: SessionMetadataStore;
}

export interface UsePermissionModeResult {
  /** Advance the mode one `Shift+Tab` step (default → acceptEdits → plan → auto → …). */
  cycle: () => void;
  /** Set the mode to an explicit value (the behavior-sheet / `/permissions` path). */
  setMode: (mode: PermissionMode) => void;
}

export function usePermissionMode({
  cardId,
  codeSessionStore,
  sessionMetadataStore,
}: UsePermissionModeOptions): UsePermissionModeResult {
  // Whether the session is alive — its turn-free `session_capabilities`
  // handshake has landed (`models` populated). This arrives "from the drop",
  // BEFORE the first turn, whereas `permissionMode` only rides the post-turn
  // `system_metadata`. The seed below needs the earlier signal so a fresh card
  // adopts its default mode before the user's first prompt, not after.
  const sessionAlive = useSyncExternalStore(
    sessionMetadataStore.subscribe,
    useCallback(
      () => sessionMetadataStore.getSnapshot().models.length > 0,
      [sessionMetadataStore],
    ),
  );

  const persistedMode = useTugbankValue<PermissionMode | null>(
    PERMISSION_MODE_DOMAIN,
    cardId,
    parsePersistedPermissionMode,
    null,
  );

  // The deck-wide default a card with nothing persisted of its own adopts on
  // mount (set from the Settings card). Per-card persistence always wins, so
  // this only seeds genuinely fresh cards.
  const globalDefaultMode = useTugbankValue<PermissionMode | null>(
    PERMISSION_MODE_DEFAULT_DOMAIN,
    PERMISSION_MODE_DEFAULT_KEY,
    parsePersistedPermissionMode,
    null,
  );

  // Pre-armed by a manual `setMode` so the mount-restore effect below never
  // overrides a change the user just made.
  const sentRef = useRef(false);

  // Set the mode to an explicit value: send the frame to tugcode → claude,
  // optimistically reflect it on the chip (no metadata round-trip exists —
  // see `applyPermissionMode`), and persist it per card. The single path
  // both `cycle` and the chip's behavior sheet funnel through.
  //
  // A user-initiated change is declined while a turn is in flight so the
  // setting never races the running turn: the session lifecycle publishes
  // `canSubmit` (idle/errored + online) and each control is a delegate that
  // acts only when it is set. The mount-restore seed passes `fromRestore` to
  // bypass the gate — it establishes the session's initial mode and may run
  // before the first turn settles (`sessionAlive` precedes `canSubmit`).
  const setMode = useCallback(
    (mode: PermissionMode, opts?: { fromRestore?: boolean }) => {
      if (!opts?.fromRestore && !codeSessionStore.getSnapshot().canSubmit) {
        return;
      }
      // A manual change supersedes any not-yet-fired mount restore.
      sentRef.current = true;
      // Optimistic chip update + persist first, so the indicator reflects the
      // change even if the frame send is a no-op (no live session yet).
      sessionMetadataStore.applyPermissionMode(mode);
      writePersistedPermissionMode(cardId, mode);
      codeSessionStore.setPermissionMode(mode);
    },
    [cardId, codeSessionStore, sessionMetadataStore],
  );

  // Mount-restore + fresh-seed ([D07]). Once the session is alive, align it to
  // the seed mode — the per-card persisted mode if any, else the deck-wide
  // default — so a relaunched card comes back in the mode it was left in and a
  // fresh card opens in the configured default. Fires at most once per mount
  // (`sentRef`), gated on `sessionAlive` so a fresh card seeds before its first
  // turn (when `permissionMode` is still null — it only rides the post-turn
  // `system_metadata`).
  //
  // Whenever a seed exists we drive the full `setMode` path unconditionally —
  // optimistic chip update, per-card persist, and the IPC frame — rather than
  // skipping when the seed happens to equal the session's current mode. The
  // session already spawned in the seed via tugcode's `--permission-mode`
  // (tugdeck forwards the resolved seed in `spawn_session`), so the frame is an
  // idempotent confirmation; sending it unconditionally means the chip and the
  // per-card record always carry the resolved seed explicitly instead of
  // relying on a coincidental fallback match (the old `else` branch marked the
  // seed "sent" without applying or persisting it, which let the chip and the
  // actual mode silently diverge). A card with neither a persisted mode nor a
  // global default has `seedMode === null` and is left untouched. A manual
  // change via `setMode` pre-arms `sentRef`, superseding any pending restore.
  const seedMode = resolveSeedPermissionMode(persistedMode, globalDefaultMode);
  useEffect(() => {
    if (sentRef.current) return;
    if (!sessionAlive) return;
    if (seedMode === null) return;
    setMode(seedMode, { fromRestore: true });
  }, [sessionAlive, seedMode, setMode]);

  const cycle = useCallback(() => {
    // Read the current mode fresh from the store rather than a render-time
    // closure so the handler registered once on the responder is never
    // stale [L07]. A session with no metadata yet is in `default` (what the
    // chip shows), so cycling from it advances `default → acceptEdits` — not
    // a no-op reset that would leave the chip unchanged.
    const current = sessionMetadataStore.getSnapshot().permissionMode ?? "default";
    setMode(cyclePermissionMode(current));
  }, [sessionMetadataStore, setMode]);

  return { cycle, setMode };
}
