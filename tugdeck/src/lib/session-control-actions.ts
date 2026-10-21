/**
 * The session-domain CONTROL acks: the frames that bind a card to its
 * session and keep the session's identity current — the spawn ack and its
 * refusal, the arc mating, the ledger's row pushes, the rename and privacy
 * acks, the restore's bindings, the line moves, and the two restore tails a
 * card's own stores answer.
 *
 * Every page that holds Session cards registers these. The shell registers
 * them unfiltered, as it always has. A body registers them with its card's
 * filter: tugcast broadcasts every one of these to every page, and a body
 * that applied another card's spawn ack would build that card's session
 * services — an engine and a replay — for a card it does not hold. The
 * filter is pure, over the ack and what the body's card holds.
 *
 * @module lib/session-control-actions
 */

import {
  registerAction as registerInRegistry,
  type ActionHandler,
} from "../action-registry";
import {
  cardIdForLine,
  cardIdForSession,
  cardSessionBindingStore,
} from "./card-session-binding-store";
import { arcBindErrorStore } from "./arc-bind-error-store";
import { sessionNameStore } from "./session-name-store";
import { identityKeyForSession, sessionLineStore } from "./session-line-store";
import { sessionTagStore } from "./session-tag-store";
import { getSessionLedgerStore } from "./session-ledger-store";
import { sessionPrivateStore } from "./session-private-store";
import { sessionSynopsisStore } from "./session-synopsis-store";
import { sessionUsageStore } from "./session-usage-store";
import { sessionCitationStore } from "./session-citation-store";
import { sessionSpawnErrorStore } from "./session-spawn-error-store";
import { notifySpawnRejected } from "./session-restore";
import { logSessionLifecycle } from "./session-lifecycle-log";
import { takePendingReload } from "./reload-reasons";
import { sendRequestInflight } from "./session-lifecycle";
import { getConnection } from "./connection-singleton";
import {
  directoryChangeNotifier,
  settleDirectoryChangeAck,
  settleDirectoryChangeError,
} from "./directory-change";
import { decodeSessionUpdated, type CardBinding } from "../protocol";
import { cardServicesStore } from "./card-services-store";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import { page } from "../bus/page";
import {
  publishSessionUpdated,
  publishListCardBindingsOk,
  publishListCardBindingsErr,
} from "./session-ledger-events";

/** Every action this module registers, in registration order. */
export const SESSION_CONTROL_ACTIONS = [
  "spawn_session_ok",
  "bind_arc_ok",
  "bind_arc_err",
  "unbind_arc_ok",
  "session_updated",
  "rename_session_ok",
  "rename_session_err",
  "set_session_private_ok",
  "set_session_private_err",
  "spawn_session_error",
  "list_card_bindings_ok",
  "session_line_rebound",
  "session_line_seated",
  "list_card_bindings_err",
  "list_shell_exchanges_ok",
  "list_refs_ok",
] as const;

export type SessionControlAction = (typeof SESSION_CONTROL_ACTIONS)[number];

/**
 * What a page applies of one ack: the payload (possibly narrowed — a
 * bindings list cut to the page's own card), or null to drop it.
 */
export type SessionControlFilter = (
  action: SessionControlAction,
  payload: Record<string, unknown>,
) => Record<string, unknown> | null;

/** What a body's card holds right now: the session ids and line it wears. Its card is the page's. */
export interface HeldSession {
  /** The segment ids the card answers to — its address and its seat. */
  sessionIds: readonly string[];
  lineId: string | null;
}

/** The acks keyed by card: applied only for the body's own card. */
const CARD_KEYED: ReadonlySet<SessionControlAction> = new Set([
  "spawn_session_ok",
  "spawn_session_error",
  "session_line_rebound",
  "session_line_seated",
]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The body's filter, over the ack and what its card holds (read fresh on
 * every ack, so a card that binds mid-stream starts admitting its session's
 * pushes at once). Card-keyed acks need the page's card (`page.cardId`);
 * session-keyed acks need a session or line the card wears; the bindings
 * list is cut to the card's own row. A page with no card yet admits nothing
 * of a card's.
 *
 * A card that **lists** other sessions (`lists: true` — the Cards card, the
 * Overview, the Arcs card) is shown what it lists: every ledger row push and
 * the whole bindings list, which only fill identity caches and the bindings
 * cache its rows read. Nothing it is shown drives a session — the card-keyed
 * acks and the arc and rename answers stay its own card's — and a cut list
 * would replace the page's whole bindings cache with its own card's one row.
 */
export function bodyCardFilter(
  held: () => HeldSession,
  options: { lists?: boolean } = {},
): SessionControlFilter {
  const lists = options.lists === true;
  return (action, payload) => {
    if (lists && (action === "session_updated" || action === "list_card_bindings_ok")) {
      return payload;
    }
    const h = held();
    const cardId = page.cardId;
    if (cardId === null) return null;
    const wearsSession = (id: string | null): boolean =>
      id !== null && h.sessionIds.includes(id);
    const wearsLine = (id: string | null): boolean => id !== null && id === h.lineId;
    if (CARD_KEYED.has(action)) {
      return str(payload.card_id) === cardId ? payload : null;
    }
    switch (action) {
      case "bind_arc_ok": {
        const card = str(payload.card_id);
        if (card !== null) return card === cardId ? payload : null;
        return wearsLine(str(payload.line_id)) || wearsSession(str(payload.tug_session_id))
          ? payload
          : null;
      }
      case "bind_arc_err":
      case "unbind_arc_ok":
      case "list_shell_exchanges_ok":
      case "list_refs_ok":
        return wearsSession(str(payload.tug_session_id)) ? payload : null;
      case "session_updated": {
        const fields = payload.fields as Record<string, unknown> | undefined;
        return wearsSession(str(payload.session_id)) || wearsLine(str(fields?.line_id))
          ? payload
          : null;
      }
      case "rename_session_ok":
      case "rename_session_err":
        return wearsLine(str(payload.line_id)) ? payload : null;
      case "set_session_private_ok":
      case "set_session_private_err":
        return wearsSession(str(payload.session_id)) ? payload : null;
      case "list_card_bindings_ok": {
        const rows = Array.isArray(payload.bindings) ? payload.bindings : [];
        const own = rows.filter(
          (row) => (row as { card_id?: unknown } | null)?.card_id === cardId,
        );
        return { ...payload, bindings: own };
      }
      case "list_card_bindings_err":
        return payload;
      default:
        return null;
    }
  };
}

/**
 * Register the session-domain acks. With no filter every ack applies — the
 * shell. With one, each ack applies only as the filter admits it — a body.
 */
export function registerSessionControlActions(filter?: SessionControlFilter): void {
  const registerAction = (action: SessionControlAction, handler: ActionHandler): void => {
    registerInRegistry(
      action,
      filter === undefined
        ? handler
        : (payload) => {
            const admitted = filter(action, payload);
            if (admitted !== null) handler(admitted);
          },
    );
  };

  // spawn_session_ok: the tugcast supervisor echoes the
  // canonical workspace_key back via this CONTROL ack after a successful
  // spawn_session (). The handler populates
  // `cardSessionBindingStore` so `useCardWorkspaceKey(cardId)` returns
  // the exact string tugcast splices into FILETREE/FILESYSTEM/GIT
  // frames, enabling the per-card value-check filter in `TugPane`.
  //
  // Tugdeck does NOT canonicalize the path client-side — the canonical
  // form includes macOS firmlink resolution that JS path libraries
  // don't match. The server-provided `workspace_key` is the single
  // source of truth for filter identity.
  registerAction("spawn_session_ok", (payload) => {
    const cardId = payload.card_id;
    const tugSessionId = payload.tug_session_id;
    const workspaceKey = payload.workspace_key;
    const projectDir = payload.project_dir;
    const sessionMode = payload.session_mode;
    if (
      typeof cardId !== "string" ||
      typeof tugSessionId !== "string" ||
      typeof workspaceKey !== "string"
    ) {
      console.warn(
        "spawn_session_ok: missing or invalid field in ack payload",
        payload,
      );
      return;
    }
    // `project_dir` is the server's canonical spelling of the directory the
    // spawn named ([L29]) — the binding's `projectDir` is compared and
    // persisted downstream, so it is never the raw path the client sent.
    // `workspace_key` is the same canonical form, and stands in for an ack
    // from a server that omits `project_dir`.
    const projectDirResolved =
      typeof projectDir === "string" ? projectDir : workspaceKey;
    // Pre-`session_mode` server acks omit the field; default to
    // "new" to match the fresh-by-default behavior elsewhere.
    const sessionModeResolved =
      sessionMode === "resume" ? "resume" : "new";
    logSessionLifecycle("spawn.ack", {
      card_id: cardId,
      tug_session_id: tugSessionId,
      workspace_key: workspaceKey,
      project_dir: projectDirResolved,
      session_mode: sessionModeResolved,
    });
    // The arc this session is working on rides the ack beside
    // `workspace_key`, and the server has already nulled it when the arc's
    // branch is gone — so an absent pair is simply "not mated".
    const ackArcId = typeof payload.arc_id === "string" ? payload.arc_id : null;
    const ackArcName =
      typeof payload.arc_name === "string" ? payload.arc_name : null;
    // The line the ledger settled this card on ([P03]). A fresh spawn sent one
    // and gets it back verbatim; a resume learns the binding's. The store is
    // seeded first so every identity write below — and every later frame that
    // names this segment — keys by the line rather than the segment.
    const ackLineId =
      typeof payload.line_id === "string" && payload.line_id.length > 0
        ? payload.line_id
        : identityKeyForSession(tugSessionId);
    // The seat rides the ack beside the address ([B01]). `tug_session_id` is
    // the bridge's key — the id the card first spawned under — and a rotation
    // leaves that segment behind while the binding, and every identity read,
    // moves to a fresh one. A reconnect re-spawns under the address and no
    // frame announces the seat again, so before this field the card came back
    // keyed to a retired segment and read unbound.
    //
    // Absent means the seat *is* the address, which is every card before its
    // first rotation and every server older than this field.
    const ackSeat =
      typeof payload.seated_session_id === "string" &&
      payload.seated_session_id.length > 0
        ? payload.seated_session_id
        : tugSessionId;
    // Both pairs, and only one of them seats the line: the address is a
    // segment of this line that the line is not sitting on, so it is `bind`
    // rather than `seat`, and the line's seat is the segment the server says
    // is live.
    if (ackSeat !== tugSessionId) sessionLineStore.bind(tugSessionId, ackLineId);
    sessionLineStore.seat(ackSeat, ackLineId);
    cardSessionBindingStore.setBinding(cardId, {
      tugSessionId,
      // Written only when it has moved, so the record of a card that never
      // rotated is byte-for-byte what it was before this field existed and
      // `cardSeatedSegment`'s `?? tugSessionId` keeps answering for it.
      seatedSessionId: ackSeat !== tugSessionId ? ackSeat : undefined,
      lineId: ackLineId,
      workspaceKey,
      projectDir: projectDirResolved,
      sessionMode: sessionModeResolved,
      arc:
        ackArcId && ackArcName
          ? { id: ackArcId, name: ackArcName }
          : undefined,
    });
    // The binding above built this card's stores and asked them for nothing.
    // The spawn it answers was sent for a reason, and that reason is what
    // reads the transcript — once, into the stores just built. An ack this
    // page sent no spawn for (a body's card, seen by the shell) has none.
    const reloadReason = takePendingReload(cardId);
    if (reloadReason === "rebind") {
      // A same-server reconnect re-asserting a card whose stores stood
      // through it ([B03]). The binding above matched them, so nothing was
      // built and nothing is read: the ack is the server holding the session
      // for this socket again, which is what settles the store out of the
      // `restoring` its reconnect put it in.
      //
      // A turn the card was in the middle of ran on while the socket was
      // down, and tugcast does not replay what a reconnecting client missed.
      // So a card that is not settled asks tugcode for the turn as it now
      // stands ([B05]): the snapshot fills in what streamed in the gap, and
      // carries the turn's end if the turn finished there.
      logSessionLifecycle("spawn.rebind_ack", {
        card_id: cardId,
        tug_session_id: tugSessionId,
      });
      const services = cardServicesStore.getServices(cardId);
      services?.codeSessionStore.notifyTransportSettled();
      const phase = services?.codeSessionStore.getSnapshot().phase;
      const connection = getConnection();
      if (services && connection && phase !== "idle" && phase !== "errored") {
        sendRequestInflight(connection, services.tugSessionId);
      }
    } else if (reloadReason !== undefined) {
      cardServicesStore.requestTranscript(cardId, reloadReason);
    } else {
      logSessionLifecycle("spawn.ack_without_reason", {
        card_id: cardId,
        tug_session_id: tugSessionId,
      });
    }
    // A directory change's ack: the binding above is the move. tugcast has
    // already closed the session the card moved away from.
    const movedTo = settleDirectoryChangeAck(cardId, tugSessionId);
    if (movedTo !== null) {
      directoryChangeNotifier(cardId)?.success(`Moved to ${movedTo}`);
    }
    // Seed the chip's name/tag caches straight off the bind ack so a bound
    // card shows its identity immediately — never stranded on the id-hash
    // waiting for a later frame. A mid-turn resume binds via this ack alone:
    // `session_updated` only fires at turn boundaries, so without this the
    // chip sits on the hash for the whole in-flight turn even though the
    // ledger holds a good name/tag. Non-clobbering (`seed*`): a fresh spawn's
    // ack carries no row yet, and its `null`s must not wipe the optimistic
    // tag `provisionSpawnTag` already set. The ledger stays authoritative via
    // the later `session_updated` push.
    const ackName = typeof payload.name === "string" ? payload.name : null;
    const ackNameUserSet = payload.name_user_set === true;
    const ackTag = typeof payload.tag === "string" ? payload.tag : null;
    const ackSynopsis =
      typeof payload.synopsis === "string" ? payload.synopsis : null;
    sessionNameStore.seedName(ackLineId, ackNameUserSet ? ackName : null);
    sessionTagStore.seedTag(ackLineId, ackTag);
    // The description is the second half of the identity's description line;
    // it seeds beside the name for the same reason (a resume binds via this
    // ack alone).
    sessionSynopsisStore.seedSynopsis(ackLineId, ackSynopsis);
    // Privacy is authoritative on the ack too: the row is read fresh, and a
    // resumed card must show the marker without waiting for a later push.
    sessionPrivateStore.setPrivate(tugSessionId, payload.private === true);
  });

  // bind_arc_ok / unbind_arc_ok: a session's arc mating changed while the
  // card is open — a skill running `tugtool arc bind`, the `arc bind` that
  // follows a `arc create`, or the rotation seat carrying a mid-arc binding
  // onto a freshly minted segment. The store's record already exists (the
  // spawn ack made it), so this merges the arc half in rather than replacing
  // it: a `setBinding` here would clobber the `workspaceKey` the pane's feed
  // filter is built from.
  //
  // Routing has three doors, most-specific first. The server names `card_id`
  // when it knows it, which is the rotation seat — the one caller whose
  // segment this deck may never have heard of, since it was minted in the same
  // breath as the announcement. `line_id` is the same knowledge one step less
  // direct. Only then the reverse walk from the session id, which is all the
  // older doors send and all they need to send, because they bind a segment
  // the card is already seated on.
  //
  // An unroutable announcement **warns**. The card it was meant for reads
  // "unbound" for the rest of its arc and no gesture from inside that session
  // can repair it, so a silent `return` here spends a real failure on nothing
  // ([D167]).
  registerAction("bind_arc_ok", (payload) => {
    const sessionId = payload.tug_session_id;
    const arcId = payload.arc_id;
    const arcName = payload.arc_name;
    if (
      typeof sessionId !== "string" ||
      typeof arcId !== "string" ||
      typeof arcName !== "string"
    ) {
      console.warn("bind_arc_ok: missing or invalid field", payload);
      return;
    }
    // Pre-routing servers send neither field; absent is not a shape error.
    const sentCardId =
      typeof payload.card_id === "string" && payload.card_id.length > 0
        ? payload.card_id
        : null;
    const sentLineId =
      typeof payload.line_id === "string" && payload.line_id.length > 0
        ? payload.line_id
        : null;
    // The pair the server just told us, recorded whether or not it routes —
    // every later frame naming this segment resolves for free afterwards.
    if (sentLineId !== null) sessionLineStore.seat(sessionId, sentLineId);
    // A binding that landed is not still a failure — clear any parked refusal
    // before the notice's next read.
    arcBindErrorStore.clear(sessionId);
    const cardId =
      (sentCardId !== null && cardSessionBindingStore.getBinding(sentCardId)
        ? sentCardId
        : null) ??
      (sentLineId !== null ? cardIdForLine(sentLineId) : null) ??
      cardIdForSession(sessionId);
    if (cardId === null) {
      console.warn(
        "bind_arc_ok: no card holds this session; the arc chip will not paint",
        payload,
      );
      return;
    }
    cardSessionBindingStore.setArcBinding(cardId, {
      id: arcId,
      name: arcName,
    });
  });

  // bind_arc_err: the mating did not happen. Nothing optimistic was raised —
  // the chip and the lane both wait for `bind_arc_ok` — so a refusal has
  // nothing to put back and would otherwise land in silence. Park it for the
  // card's `ArcBindErrorNoticeController` to surface as a bulletin.
  registerAction("bind_arc_err", (payload) => {
    console.warn("bind_arc failed", payload);
    const sessionId = payload.tug_session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    arcBindErrorStore.fail(
      sessionId,
      typeof payload.reason === "string" ? payload.reason : "unknown",
    );
  });

  registerAction("unbind_arc_ok", (payload) => {
    const sessionId = payload.tug_session_id;
    if (typeof sessionId !== "string") return;
    const cardId = cardIdForSession(sessionId);
    if (cardId === null) {
      console.warn(
        "unbind_arc_ok: no card holds this session; the arc chip will not clear",
        payload,
      );
      return;
    }
    cardSessionBindingStore.setArcBinding(cardId, null);
  });

  // session_updated: tugcast supervisor broadcasts these on every
  // ledger write (`record_spawn`, `record_turn`, `mark_closed`,
  // `mark_failed`, `trash`). Routed through the
  // `session-ledger-events` bus so the picker's session-ledger
  // store (step 4) can patch its in-memory cache without re-fetching.
  registerAction("session_updated", (payload) => {
    const decoded = decodeSessionUpdated(payload);
    if (decoded === null) {
      console.warn("session_updated: invalid payload shape", payload);
      return;
    }
    // Keep the Z4B chip's name cache authoritative ([#step-13d]): a rename
    // (or any ledger write) pushes the post-write row. Only a user `/rename`
    // feeds the chip — an auto `aiTitle` (name_user_set false) clears it so the
    // chip falls back to the hash.
    // A trash must reach every identity cache, not just the ledger store: a
    // lingering tag entry would let `/resume <tag>` hand back a trashed
    // session's id, and a lingering citation answer would keep its chips
    // resolvable for the rest of the run.
    if (decoded.removed === true) {
      const goneLine = identityKeyForSession(decoded.session_id);
      sessionNameStore.setName(goneLine, null);
      sessionTagStore.setTag(goneLine, null);
      sessionSynopsisStore.setSynopsis(goneLine, null);
      sessionCitationStore.forgetSession(decoded.session_id);
      sessionPrivateStore.forget(decoded.session_id);
      sessionLineStore.forgetSession(decoded.session_id);
      // Usage is the segment's own fact, so it is forgotten by segment: the
      // ledger no longer holds the row, and neither does this.
      sessionUsageStore.forget(decoded.session_id);
    }
    if (decoded.fields !== undefined) {
      // Every identity field on the row is the **line's** ([P02]), so it is
      // filed under the line the push names — never under the segment, which
      // is one of several the conversation has worn.
      const lineId =
        decoded.fields.line_id.length > 0
          ? decoded.fields.line_id
          : identityKeyForSession(decoded.session_id);
      if (decoded.fields.state === "live") {
        sessionLineStore.seat(decoded.session_id, lineId);
      } else {
        sessionLineStore.bind(decoded.session_id, lineId);
      }
      sessionNameStore.setName(
        lineId,
        decoded.fields.name_user_set ? (decoded.fields.name ?? null) : null,
      );
      // Make the optimistic provisional tag authoritative: the echoed row
      // carries the server's claimed-or-suffixed tag (the tag has no user-set
      // gate; it always fronts the session when present). Non-clobbering — a
      // row read before the tag landed carries `null`, which must not wipe the
      // optimistic tag back to the id-hash.
      sessionTagStore.seedTag(lineId, decoded.fields.tag);
      // The description, unlike the callsign, is authoritative on every push:
      // the Summarize lane rewrites it as the work moves and the ledger row is
      // the only truth, so a push carrying `null` means it really is empty
      // (a rename froze it, or none has been written yet).
      sessionSynopsisStore.setSynopsis(
        lineId,
        decoded.fields.synopsis,
      );
      // Overview privacy is authoritative on every push: the row is the only
      // truth, and a push carrying `false` means the session really is public.
      sessionPrivateStore.setPrivate(
        decoded.session_id,
        decoded.fields.private === true,
      );
    }
    // Usage rides the push beside the row and is keyed by SEGMENT, not by
    // line: a stage of an arc is a segment, and the whole point of the figure
    // is that two stages of one conversation differ. Authoritative on every
    // push, including the one the turn-telemetry write now sends, which is
    // what moves a live stage's number as its turns commit.
    if (decoded.removed !== true) {
      sessionUsageStore.set(decoded.session_id, decoded.usage);
    }
    publishSessionUpdated(decoded);
  });

  // rename_session_ok / _err: the ack for `/rename`. The rename surface writes
  // the chip name optimistically and holds the name it replaced; these arms
  // resolve that waiter, which puts the old name back on a refusal and reports
  // either outcome in the card's bulletin. The name identifies WHICH rename is
  // being acked — CONTROL is a broadcast, and a second rename in flight must
  // not have its outcome spoken by the first one's ack.
  registerAction("rename_session_ok", (payload) => {
    const lineId = payload.line_id;
    if (typeof lineId !== "string" || lineId.length === 0) return;
    const name = typeof payload.name === "string" ? payload.name : null;
    // The lines this rename took the name from ([P11]): the newest gesture
    // wins, so their chips fall back to their callsigns here rather than
    // waiting on the `session_updated` push that says the same thing
    // authoritatively a moment later.
    const displaced = Array.isArray(payload.displaced)
      ? payload.displaced.flatMap((entry) => {
          if (entry === null || typeof entry !== "object") return [];
          const holder = entry as Record<string, unknown>;
          const holderLineId = holder.line_id;
          const tag = holder.tag;
          if (typeof holderLineId !== "string" || holderLineId.length === 0) {
            return [];
          }
          return [{ lineId: holderLineId, tag: typeof tag === "string" ? tag : "" }];
        })
      : [];
    for (const holder of displaced) sessionNameStore.setName(holder.lineId, null);
    sessionNameStore.settle(lineId, name, {
      ok: true,
      displaced: displaced.length > 0 ? displaced : undefined,
    });
  });
  registerAction("rename_session_err", (payload) => {
    console.warn("rename_session failed", payload);
    const lineId = payload.line_id;
    if (typeof lineId !== "string" || lineId.length === 0) return;
    const name = typeof payload.name === "string" ? payload.name : null;
    sessionNameStore.settle(lineId, name, {
      ok: false,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    });
  });

  // set_session_private_ok / _err: the ack for `/private`. The command writes
  // the store optimistically so the atom's marker turns over with the gesture;
  // these arms reconcile it with what the ledger actually did. The `_err` arm
  // is why the optimistic write is safe — a refused toggle is put back rather
  // than left showing a state the server never entered.
  registerAction("set_session_private_ok", (payload) => {
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const written = payload.private === true;
    sessionPrivateStore.setPrivate(sessionId, written);
    sessionPrivateStore.settle(sessionId, written, { ok: true });
  });
  registerAction("set_session_private_err", (payload) => {
    console.warn("set_session_private failed", payload);
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    // Put back the state the toggle came FROM, which is the negation of what
    // was refused — the command toggles off what the store holds, and a
    // refused write left the ledger where it was. Restoring a fixed `false`
    // would only undo one of the two directions: a refused un-private would
    // leave the deck showing "public" over a session that is still private,
    // and no `session_updated` is coming to correct it, since nothing changed.
    const refused = payload.private === true;
    sessionPrivateStore.setPrivate(sessionId, !refused);
    sessionPrivateStore.settle(sessionId, refused, {
      ok: false,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    });
  });

  // spawn_session_error: the supervisor rejected a `spawn_session`
  // (e.g. the project directory no longer exists). The router echoes
  // the originating `card_id` so the failure routes to that card's
  // picker, which surfaces it as an inline alert — the unbound card has
  // no CodeSessionStore to carry it.
  registerAction("spawn_session_error", (payload) => {
    const cardId = payload.card_id;
    if (typeof cardId !== "string") {
      console.warn("spawn_session_error: missing card_id", payload);
      return;
    }
    const detail = payload.detail;
    // A refused directory change leaves the card on its old session, still
    // bound and still working — so it says why on the card and stops here,
    // rather than dropping the card to the picker.
    const refusedMove = settleDirectoryChangeError(
      cardId,
      typeof detail === "string" ? detail : "unknown",
    );
    if (refusedMove !== null) {
      directoryChangeNotifier(cardId)?.danger(refusedMove);
      return;
    }
    sessionSpawnErrorStore.set(cardId, {
      reason: typeof detail === "string" ? detail : "unknown",
    });
    // A rejection during the startup restore pass leaves a
    // `sessionRestoreRegistry` hold in place — the zero-turn fresh-spawn
    // path arms one so the card doesn't flash the picker mid-bind.
    // Drop it so the card falls through to the picker, which reads the
    // error set above and shows its inline alert.
    notifySpawnRejected(cardId);
  });
  // list_card_bindings_ok / _err: response to a startup/reconnect
  // request from `restoreSessions`.
  registerAction("list_card_bindings_ok", (payload) => {
    const bindings = payload.bindings;
    if (!Array.isArray(bindings)) {
      console.warn("list_card_bindings_ok: missing or invalid bindings", payload);
      return;
    }
    const rows = bindings as CardBinding[];
    // Seed the chip's name cache on restore ([#step-13d]) so a session renamed
    // in a prior run shows its name the moment its card rebinds. Only a user
    // `/rename` feeds the chip; an auto `aiTitle` leaves it on the hash.
    for (const b of rows) {
      // One binding per line, seated on the segment a restore should resume
      // ([P06]).
      const lineId =
        (b.line_id ?? "").length > 0
          ? (b.line_id as string)
          : identityKeyForSession(b.session_id);
      sessionLineStore.seat(b.session_id, lineId);
      sessionNameStore.seedName(lineId, b.name_user_set ? (b.name ?? null) : null);
      // Seed the chip's tag cache on restore so a session's mnemonic shows the
      // moment its card rebinds (parity with the name seed).
      sessionTagStore.seedTag(lineId, b.tag ?? null);
      sessionSynopsisStore.seedSynopsis(lineId, b.synopsis ?? null);
    }
    // One `list_sessions` per distinct project the deck spans, kicked here
    // rather than left to whichever row happens to mount first ([B09]).
    //
    // The on-demand path is conditioned on a surface being OPEN ([F08]):
    // `SessionIdentityRow` builds its rest line from `useSessionLedgerRow`,
    // whose hook kicks the listing for that project — so with the Workspaces
    // card closed nothing is fetched at all, and the first open pays the
    // latency on every project at once. The fan-out is bounded by the number
    // of distinct projects the deck spans, a handful rather than a per-session
    // cost, and `getSnapshot` is keyed by project directory and idempotent: a
    // row mounting later finds the listing settled and kicks nothing.
    const ledger = getSessionLedgerStore();
    if (ledger !== null) {
      const projects = new Set<string>();
      for (const b of rows) {
        if (typeof b.project_dir === "string" && b.project_dir.length > 0) {
          projects.add(b.project_dir);
        }
      }
      for (const projectDir of projects) ledger.getSnapshot(projectDir);
    }
    publishListCardBindingsOk({ bindings: rows });
  });
  // session_line_rebound: a plain `/new` on an already-bound card births a
  // fresh line rather than joining the card's ([P03]), so the card's identity
  // starts over. The push is the only frame that says so — the spawn ack for a
  // `/clear` names the card's previous line, and every later frame names the
  // new one, which would leave the binding pointing at a line nothing is on.
  registerAction("session_line_rebound", (payload) => {
    const cardId = payload.card_id;
    const tugSessionId = payload.tug_session_id;
    const lineId = payload.line_id;
    if (
      typeof cardId !== "string" ||
      typeof tugSessionId !== "string" ||
      typeof lineId !== "string" ||
      lineId.length === 0
    ) {
      console.warn("session_line_rebound: missing or invalid fields", payload);
      return;
    }
    sessionLineStore.seat(tugSessionId, lineId);
    cardSessionBindingStore.setLineBinding(cardId, tugSessionId, lineId);
    // The new line arrives wearing its own callsign, and a `/new` clears the
    // name: a fresh conversation is untitled until the user says otherwise.
    sessionTagStore.seedTag(lineId, typeof payload.tag === "string" ? payload.tag : null);
    sessionNameStore.setName(
      lineId,
      payload.name_user_set === true && typeof payload.name === "string"
        ? payload.name
        : null,
    );
  });

  // session_line_seated: the card's line moved onto a fresh segment — a
  // rotation above all — and the card's *seat* moves with it while its
  // **address** does not. `session_line_rebound`'s twin, for the case that is
  // not a new line, and the frame the postmortem's card never got: the row push
  // says a segment exists and which line it is on, and nothing says the card is
  // now sitting on it. Derived instead, the answer was "whichever live row on
  // this line was pushed last" — and a rotation leaves two, because the retired
  // segment's row stays live until the card closes.
  //
  // The line rides along because the server knows it and the spawn ack may not:
  // a resume of a row the ledger had not yet birthed a line for is acked with
  // none, so the binding has been carrying a line of one ever since.
  registerAction("session_line_seated", (payload) => {
    const cardId = payload.card_id;
    const sessionId = payload.session_id;
    const lineId = payload.line_id;
    if (
      typeof cardId !== "string" ||
      typeof sessionId !== "string" ||
      typeof lineId !== "string" ||
      sessionId.length === 0 ||
      lineId.length === 0
    ) {
      console.warn("session_line_seated: missing or invalid fields", payload);
      return;
    }
    // Recorded whether or not a card holds it, exactly as `bind_arc_ok` does:
    // every later frame naming this segment resolves for free afterwards.
    sessionLineStore.seat(sessionId, lineId);
    cardSessionBindingStore.setSeatedSegment(cardId, sessionId, lineId);
  });

  registerAction("list_card_bindings_err", (payload) => {
    const reason = payload.reason;
    if (typeof reason !== "string") {
      console.warn("list_card_bindings_err: missing reason", payload);
      return;
    }
    publishListCardBindingsErr({ reason });
  });

  // list_shell_exchanges_ok ([P07]): the shell-restore tail for one session.
  // Route the ledgered exchanges to the owning card's code-session store,
  // which interleaves them by timestamp among the JSONL-replayed Claude turns.
  registerAction("list_shell_exchanges_ok", (payload) => {
    const sid = payload.tug_session_id;
    const exchanges = payload.exchanges;
    if (typeof sid !== "string" || !Array.isArray(exchanges)) {
      console.warn("list_shell_exchanges_ok: missing session id / exchanges", payload);
      return;
    }
    const services = cardServicesStore.getByTugSessionId(sid);
    if (services === null) {
      // No bag owns this session — the card was disposed, or this answer
      // beat its own construction. Either way the rows are dropped, and the
      // transcript will come back short unless the fetch asks again, so say
      // so rather than returning into silence.
      tugDevLogStore.warn("shell-restore", "no services bag for the answered session", {
        tugSessionId: sid,
        exchanges: exchanges.length,
      });
      return;
    }
    // The completeness pair rides through: the store settles its retry only
    // when the rows account for the ledger's own `total` ([P07]).
    services.shellSessionStore.applyRestore(
      exchanges as ReadonlyArray<Record<string, unknown>>,
      { total: payload.total, answered: payload.answered },
    );
  });

  // list_refs_ok ([P05]): the refs-restore read for one session. The ledger
  // keeps the latest run only, so `run` is that run or `null` for a session
  // that has never searched. Re-minting it seats the `#r` block in the
  // transcript and restores the list `/ref N` resolves against.
  registerAction("list_refs_ok", (payload) => {
    const sid = payload.tug_session_id;
    if (typeof sid !== "string") {
      console.warn("list_refs_ok: missing session id", payload);
      return;
    }
    const services = cardServicesStore.getByTugSessionId(sid);
    if (services === null) {
      tugDevLogStore.warn("refs-restore", "no services bag for the answered session", {
        tugSessionId: sid,
      });
      return;
    }
    const run = payload.run;
    services.refsSessionStore.applyRestore(
      typeof run === "object" && run !== null ? (run as Record<string, unknown>) : null,
    );
  });
}
