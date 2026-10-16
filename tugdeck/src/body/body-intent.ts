/**
 * What a body does with its card's session when it is bound: the spawn the
 * shell would have made, made here instead.
 *
 * The shell decides how a Session card's session starts — resume a ledgered
 * session, spawn its zero-turn binding fresh, open a new one from the picker,
 * or recover a body whose page crashed — and hands the decision to the body
 * as an intent. The body replays it through the same funnel the shell would
 * have called, so a card in a body binds, replays and restores exactly as
 * one in the shell.
 *
 * Before acting the body narrows its connection to the session the intent
 * names, so the spawn's replay reaches it; a crash recovery learns its
 * session from the bindings answer first.
 *
 * A card of a kind with no session — a Text card, the Overview — is bound
 * with `mount`: the body mounts it and there is nothing to replay.
 *
 * @module body/body-intent
 */

import type { TugConnection } from "../connection";
import type { CardStateBag, DeckState } from "../layout-tree";
import {
  fireFreshSpawn,
  fireNewSpawn,
  fireRestore,
  restoreSessions,
  stashOpeningCommand,
  type ResumeDisplayMetadata,
} from "../lib/session-restore";
import { subscribeToListCardBindingsOk } from "../lib/session-ledger-events";

export type BodyIntent =
  | { kind: "resume"; tugSessionId: string; projectDir: string; display?: ResumeDisplayMetadata }
  | {
      kind: "fresh";
      tugSessionId: string;
      projectDir: string;
      openingCommand?: { name: string; args: string };
    }
  | { kind: "new"; tugSessionId: string; projectDir: string; lineId: string; tag: string }
  | { kind: "restore" }
  /**
   * A kind with no session, handed off as the deck holds it. `bag` is the
   * card's state as the shell holds it at the hand-off — a just-opened
   * file's seed is there before anything reaches tugbank.
   */
  | { kind: "mount"; bag?: CardStateBag };

function str(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** `raw` as an intent, or null when it is not one. */
export function parseBodyIntent(raw: unknown): BodyIntent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "restore":
      return { kind: "restore" };
    case "mount":
      return typeof r.bag === "object" && r.bag !== null
        ? { kind: "mount", bag: r.bag as CardStateBag }
        : { kind: "mount" };
    case "resume":
      if (!str(r.tugSessionId) || !str(r.projectDir)) return null;
      return {
        kind: "resume",
        tugSessionId: r.tugSessionId,
        projectDir: r.projectDir,
        ...(typeof r.display === "object" && r.display !== null
          ? { display: r.display as ResumeDisplayMetadata }
          : {}),
      };
    case "fresh": {
      if (!str(r.tugSessionId) || !str(r.projectDir)) return null;
      const opening = r.openingCommand as { name?: unknown; args?: unknown } | undefined;
      return {
        kind: "fresh",
        tugSessionId: r.tugSessionId,
        projectDir: r.projectDir,
        ...(opening !== undefined && str(opening.name) && typeof opening.args === "string"
          ? { openingCommand: { name: opening.name, args: opening.args } }
          : {}),
      };
    }
    case "new":
      if (!str(r.tugSessionId) || !str(r.projectDir) || !str(r.lineId) || !str(r.tag)) return null;
      return {
        kind: "new",
        tugSessionId: r.tugSessionId,
        projectDir: r.projectDir,
        lineId: r.lineId,
        tag: r.tag,
      };
    default:
      return null;
  }
}

/**
 * Act on `intent` for `cardId`. `deck` is the body's one-card deck, which is
 * what scopes a crash recovery's restore pass to this card.
 *
 * `inShell` is the fallback's replay: a card whose body failed before its
 * session was bound re-runs its intent through the shell's own funnels. The
 * shell's connection carries every session, so it is not narrowed, and a
 * restore pass is scoped to the one card rather than the deck.
 */
export function replayBodyIntent(
  intent: BodyIntent,
  cardId: string,
  connection: TugConnection,
  deck: { getSnapshot(): DeckState },
  options?: { inShell?: boolean },
): void {
  const narrow = (sessionId: string): void => {
    if (options?.inShell !== true) connection.setSessions([sessionId]);
  };
  switch (intent.kind) {
    case "mount":
      return;
    case "resume":
      narrow(intent.tugSessionId);
      fireRestore(cardId, intent.tugSessionId, intent.projectDir, connection, intent.display);
      return;
    case "fresh":
      narrow(intent.tugSessionId);
      if (intent.openingCommand !== undefined) stashOpeningCommand(cardId, intent.openingCommand);
      fireFreshSpawn(cardId, intent.tugSessionId, intent.projectDir, connection);
      return;
    case "new":
      narrow(intent.tugSessionId);
      fireNewSpawn(cardId, intent.tugSessionId, intent.projectDir, connection, {
        lineId: intent.lineId,
        tag: intent.tag,
      });
      return;
    case "restore": {
      if (options?.inShell === true) {
        restoreSessions(deck, connection, { cardIds: new Set([cardId]) });
        return;
      }
      // Subscribed before the restore pass, so the session set goes out
      // ahead of the resume that pass sends from the same answer.
      const release = subscribeToListCardBindingsOk(({ bindings }) => {
        const own = bindings.find((b) => b.card_id === cardId);
        if (own === undefined) return;
        release();
        connection.setSessions([own.session_id]);
      });
      restoreSessions(deck, connection);
      return;
    }
  }
}
