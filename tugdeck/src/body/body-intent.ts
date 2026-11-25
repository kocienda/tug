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
import { isReloadReason, type ReloadReason } from "../lib/reload-reasons";
import { subscribeToListCardBindingsOk } from "../lib/session-ledger-events";
import { cardSessionBindingStore, type CardSessionMode } from "../lib/card-session-binding-store";
import { sessionLineStore } from "../lib/session-line-store";
import { markHarnessSession } from "../lib/harness-sessions";

/**
 * What the body does, with the card's state as the shell held it when it
 * asked for the body (`bag`). The shell's copy is the freshest there is at a
 * card's first hand-off — a just-opened file's seed, a seeded deck — before
 * anything has reached tugbank; without one the body reads what was last
 * written.
 */
export type BodyIntent = BodyIntentKind & { bag?: CardStateBag };

type BodyIntentKind =
  | {
      kind: "resume";
      tugSessionId: string;
      projectDir: string;
      reason: ReloadReason;
      display?: ResumeDisplayMetadata;
    }
  | {
      kind: "fresh";
      tugSessionId: string;
      projectDir: string;
      reason: ReloadReason;
      openingCommand?: { name: string; args: string };
    }
  | {
      kind: "new";
      tugSessionId: string;
      projectDir: string;
      reason: ReloadReason;
      lineId: string;
      tag: string;
    }
  | { kind: "restore" }
  /**
   * A kind with no session, handed off as the deck holds it.
   */
  | { kind: "mount" }
  /**
   * The harness's fake bind (`window.__tug.bindSession`), handed to the
   * body as a spawn would be: the card takes the binding into its own
   * stores and renders its session body with no frames flowing. Honoured
   * only under the harness.
   */
  | {
      kind: "bind";
      tugSessionId: string;
      lineId: string;
      workspaceKey: string;
      projectDir: string;
      sessionMode: CardSessionMode;
    };

function str(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** `raw` as an intent, or null when it is not one. */
export function parseBodyIntent(raw: unknown): BodyIntent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = parseIntentKind(r);
  if (kind === null) return null;
  return typeof r.bag === "object" && r.bag !== null ? { ...kind, bag: r.bag as CardStateBag } : kind;
}

function parseIntentKind(r: Record<string, unknown>): BodyIntentKind | null {
  switch (r.kind) {
    case "restore":
      return { kind: "restore" };
    case "bind":
      if (!str(r.tugSessionId) || !str(r.lineId) || !str(r.workspaceKey) || !str(r.projectDir)) return null;
      return {
        kind: "bind",
        tugSessionId: r.tugSessionId,
        lineId: r.lineId,
        workspaceKey: r.workspaceKey,
        projectDir: r.projectDir,
        sessionMode: r.sessionMode === "resume" ? "resume" : "new",
      };
    case "mount":
      return { kind: "mount" };
    case "resume":
      if (!str(r.tugSessionId) || !str(r.projectDir) || !isReloadReason(r.reason)) return null;
      return {
        kind: "resume",
        tugSessionId: r.tugSessionId,
        projectDir: r.projectDir,
        reason: r.reason,
        ...(typeof r.display === "object" && r.display !== null
          ? { display: r.display as ResumeDisplayMetadata }
          : {}),
      };
    case "fresh": {
      if (!str(r.tugSessionId) || !str(r.projectDir) || !isReloadReason(r.reason)) return null;
      const opening = r.openingCommand as { name?: unknown; args?: unknown } | undefined;
      return {
        kind: "fresh",
        tugSessionId: r.tugSessionId,
        projectDir: r.projectDir,
        reason: r.reason,
        ...(opening !== undefined && str(opening.name) && typeof opening.args === "string"
          ? { openingCommand: { name: opening.name, args: opening.args } }
          : {}),
      };
    }
    case "new":
      if (
        !str(r.tugSessionId) ||
        !str(r.projectDir) ||
        !isReloadReason(r.reason) ||
        !str(r.lineId) ||
        !str(r.tag)
      ) {
        return null;
      }
      return {
        kind: "new",
        tugSessionId: r.tugSessionId,
        projectDir: r.projectDir,
        reason: r.reason,
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
 */
export function replayBodyIntent(
  intent: BodyIntent,
  cardId: string,
  connection: TugConnection,
  deck: { getSnapshot(): DeckState },
): void {
  const narrow = (sessionId: string): void => {
    connection.setSessions([sessionId]);
  };
  switch (intent.kind) {
    case "mount":
      return;
    case "bind":
      if (typeof window === "undefined" || window.__tugTestMode !== true) return;
      markHarnessSession(intent.tugSessionId);
      sessionLineStore.seat(intent.tugSessionId, intent.lineId);
      cardSessionBindingStore.setBinding(cardId, {
        tugSessionId: intent.tugSessionId,
        lineId: intent.lineId,
        workspaceKey: intent.workspaceKey,
        projectDir: intent.projectDir,
        sessionMode: intent.sessionMode,
      });
      return;
    case "resume":
      narrow(intent.tugSessionId);
      fireRestore(
        cardId,
        intent.tugSessionId,
        intent.projectDir,
        connection,
        intent.reason,
        intent.display,
      );
      return;
    case "fresh":
      narrow(intent.tugSessionId);
      if (intent.openingCommand !== undefined) stashOpeningCommand(cardId, intent.openingCommand);
      fireFreshSpawn(cardId, intent.tugSessionId, intent.projectDir, connection, intent.reason);
      return;
    case "new":
      narrow(intent.tugSessionId);
      fireNewSpawn(cardId, intent.tugSessionId, intent.projectDir, connection, intent.reason, {
        lineId: intent.lineId,
        tag: intent.tag,
      });
      return;
    case "restore": {
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
