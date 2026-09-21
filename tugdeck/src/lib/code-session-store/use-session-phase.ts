/**
 * use-session-phase.ts — the session-keyed liveness door.
 *
 * Identity is keyed by session and liveness is keyed by card: phase lives on a
 * per-*card* `codeSessionStore`, and the join between the two has to happen
 * somewhere. Doing it once, here, is what lets a surface holding nothing but a
 * session id — a citation chip, a picker row for a session with no card at all —
 * show a live dot.
 *
 * **It returns the flattened phase KEY, not the snapshot.** That is the whole
 * reason the hook is safe on identity surfaces. The snapshot is the entire
 * session state and wakes on every transcript event; a hook handing it back
 * would re-render every chip in the app on every token. A short string means
 * React bails out of the re-render unless the *reading* actually changed, which
 * is what keeps a Changes card with a citation per row affordable.
 *
 * **Doubt reads idle, never danger.** A session whose live state cannot be
 * reached — no bound card, services not yet constructed, a closed or external
 * row — answers `"idle"`. Red is the error channel, and spending it on "we do
 * not know" would make every ordinary closed session look broken. A card that
 * exists and whose transport is genuinely offline still reads danger; that is a
 * real failure rather than doubt.
 *
 * Liveness stays OUT of the identity record: two subscriptions, two keys,
 * meeting in the component that mounts them both.
 *
 * **The join offer is the one fact that is not the session's own.** A finished
 * arc reads Ready ([B01]), and readiness belongs to the *arc* the card is
 * mated to rather than to the session store — so the walk this module already
 * makes (session → card → services) is extended by one leg: the card's arc
 * binding, and that arc's row in the changes feed. One derivation, read here,
 * is what keeps the masthead dot, the Z2 STATE cell, the Changes card's
 * citation dots and the Arcs card row from each deriving their own and
 * disagreeing.
 *
 * Laws: [L02] every store read enters through `useSyncExternalStore`.
 *
 * @module lib/code-session-store/use-session-phase
 */

import { useSyncExternalStore } from "react";

import {
  cardIdForSession,
  useCardIdForSession,
  cardSessionBindingStore,
} from "@/lib/card-session-binding-store";
import { cardServicesStore } from "@/lib/card-services-store";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { ArcChangesetEntry } from "@/lib/changeset-types";
import { isNetworkStalled } from "@/lib/code-session-store/lifecycle-state";
import { countRunningJobs } from "@/lib/code-session-store/select-jobs";
import {
  sessionSessionPhaseKey,
  type SessionPhaseKey,
} from "@/lib/code-session-store/session-phase-visual";
import type { CodeSessionSnapshot } from "@/lib/code-session-store/types";

/** Stable no-op subscribe for a session with no reachable session store. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/**
 * The five snapshot fields the phase reading is made of — named as a type so the
 * fold below states its whole appetite, and a caller cannot mistake it for
 * something that reads the transcript.
 */
export type SessionPhaseSource = Pick<
  CodeSessionSnapshot,
  | "phase"
  | "transportState"
  | "interruptInFlight"
  | "stopStalled"
  | "streamStalled"
  | "apiRetry"
  | "jobs"
  | "pendingAsk"
>;

/**
 * Whether a join offer stands for `arcId` in the changes feed and nothing has
 * spent it — the whole input to the `ready` key ([B01]).
 *
 * The offer is the server's own derivation of `join_ready` made durable: it is
 * raised when the machine's work is done and a candidate stands, and it is
 * gone the moment the join is taken, discarded, or the arc head moves under a
 * reopen. So "the offer is present" is exactly "the offer stands", and there
 * is nothing here to age out or spend a second time.
 *
 * Pure, and separate from the walk above it, so the reading is a unit test
 * rather than a claim about a running app.
 */
export function joinOfferStands(
  arcId: string | null,
  arcs: readonly ArcChangesetEntry[],
): boolean {
  if (arcId === null) return false;
  const entry = arcs.find((row) => row.owner_id === arcId);
  return (entry?.join?.offer ?? null) !== null;
}

/**
 * The base branch of the arc whose offer stands for this card, or `null` when
 * none does.
 *
 * The same read as {@link joinOfferStands}, carrying the one fact the register's
 * sentence needs beyond the condition itself ([B10]). A primitive rather than
 * the entry, deliberately: the hook below hands this to the masthead, and a row
 * that woke on every changes beat would be the whole reason the phase hook
 * returns a short string in the first place.
 */
export function joinOfferBase(
  arcId: string | null,
  arcs: readonly ArcChangesetEntry[],
): string | null {
  if (arcId === null) return null;
  const entry = arcs.find((row) => row.owner_id === arcId);
  if (entry === undefined || (entry.join?.offer ?? null) === null) return null;
  return entry.base;
}

/**
 * The display name of the arc whose offer stands for this card, or `null`.
 *
 * The third reading off the same pair of subscriptions, for the one surface
 * that has to know *which* arc the standing offer is about: the finished arc's
 * transcript receipt ([B04]). That row names the arc it reports, and a card
 * may well have moved on to another one since — so the Join it offers appears
 * only when the offer standing now is this row's.
 */
export function joinOfferArcName(
  arcId: string | null,
  arcs: readonly ArcChangesetEntry[],
): string | null {
  if (arcId === null) return null;
  const entry = arcs.find((row) => row.owner_id === arcId);
  if (entry === undefined || (entry.join?.offer ?? null) === null) return null;
  return entry.display_name;
}

/** The arc bound to a card, read once. */
function arcIdForCard(cardId: string | null): string | null {
  if (cardId === null) return null;
  return cardSessionBindingStore.getBinding(cardId)?.arc?.id ?? null;
}

/**
 * A card's arc binding and the changes feed's arc rows, live — two
 * subscriptions, because two
 * stores move independently: the binding changes when the card is mated or
 * unmated, the changes feed when the repository does.
 *
 * Always called, like every hook here: a card with no services subscribes to
 * the no-op and reads nothing, which is the same doubt-reads-quiet rule the
 * phase walk itself keeps.
 *
 * It hands back the two inputs rather than an answer so both readings — the
 * offer-stands boolean and the base the sentence names — come off one pair of
 * subscriptions. The object is a render value, never a store snapshot, so a
 * fresh one each render costs nothing.
 */
function useCardArcJoin(
  cardId: string | null,
  changesController: ChangesRouteController | null,
): { readonly arcId: string | null; readonly arcs: readonly ArcChangesetEntry[] } {
  const arcId = useSyncExternalStore(cardSessionBindingStore.subscribe, () =>
    arcIdForCard(cardId),
  );
  const changes = useSyncExternalStore(
    changesController?.subscribe ?? NOOP_SUBSCRIBE,
    () => changesController?.getSnapshot() ?? null,
    () => null,
  );
  return { arcId, arcs: changes?.arcs ?? [] };
}

/**
 * The pure fold: a session store's snapshot, or `null` for a session whose live
 * state could not be reached, onto one phase key.
 *
 * Separate from the hook so the doubt rule is a unit test rather than a claim —
 * the store walk above it only exists in a running app, but "no snapshot reads
 * idle" is the decision, and it is checkable here.
 *
 * `joinReady` arrives beside the snapshot rather than inside it, because it is
 * not the session's fact: see {@link joinOfferStands}. Omitted is "makes no
 * claim", which is what a replayed historical row has to say.
 */
export function sessionPhaseFromSnapshot(
  snap: SessionPhaseSource | null,
  joinReady?: boolean,
): SessionPhaseKey {
  if (snap === null) return "idle";
  return sessionSessionPhaseKey({
    phase: snap.phase,
    transportState: snap.transportState,
    interruptInFlight: snap.interruptInFlight,
    // A stop the session never answered reads from a list too: that row is
    // how a card the user isn't looking at says their stop went nowhere.
    stopStalled: snap.stopStalled,
    // A session waiting on a network that has stopped answering reads that
    // from a list too. The condition is derived once, in `lifecycle-state`,
    // so the overlay on the card and the dot on the row cannot disagree.
    stalled: isNetworkStalled(snap),
    runningJobCount: countRunningJobs(snap.jobs),
    // A session waiting on an answer reads Awaiting from a list too — that row
    // is how a card the user isn't looking at says it needs them.
    pendingAsk: snap.pendingAsk !== null,
    // A finished arc still waiting on the user reads Ready from a list too —
    // the one green on the dot, and the only thing that says the work is done
    // rather than merely quiet.
    joinReady,
  });
}

/**
 * The phase key for a session **as a snapshot, with no subscription** — the
 * same walk the hook makes, read once.
 *
 * Non-React callers only, and there is one: the editor's atom chip is a Canvas
 * bake, so a pasted session atom's dot is the phase at paste time and cannot be
 * anything else ([P14]). Every component uses {@link useSessionPhase}.
 */
export function sessionPhaseNow(sessionId: string): SessionPhaseKey {
  const cardId = cardIdForSession(sessionId);
  const services = cardId === null ? null : cardServicesStore.getServices(cardId);
  const joinReady = joinOfferStands(
    arcIdForCard(cardId),
    services?.changesController?.getSnapshot().arcs ?? [],
  );
  return sessionPhaseFromSnapshot(
    services?.codeSessionStore?.getSnapshot() ?? null,
    joinReady,
  );
}

/**
 * The phase key for a session, live.
 *
 * Always called — hook rules forbid a conditional call — and answers `"idle"`
 * whenever there is nothing to read. See the module header for why that is the
 * honest answer rather than a placeholder.
 */
export function useSessionPhase(sessionId: string): SessionPhaseKey {
  const cardId = useCardIdForSession(sessionId);
  const services = useSyncExternalStore(cardServicesStore.subscribe, () =>
    cardId === null ? null : cardServicesStore.getServices(cardId),
  );
  const store = services?.codeSessionStore ?? null;
  const snap = useSyncExternalStore(
    store?.subscribe ?? NOOP_SUBSCRIBE,
    store !== null ? store.getSnapshot : () => null,
    () => null,
  );
  const join = useCardArcJoin(cardId, services?.changesController ?? null);
  const joinReady = joinOfferStands(join.arcId, join.arcs);
  return sessionPhaseFromSnapshot(snap, joinReady);
}

/**
 * The offer-stands fact for a **session**, live — the same derivation
 * {@link useSessionPhase} folds in, for the one surface that builds its own
 * {@link SessionPhaseInput} instead of reading the key: the Z2 STATE cell.
 *
 * Exported so that cell reads the same fact rather than a second one. A second
 * derivation is how two surfaces come to disagree about one arc.
 */
export function useSessionJoinReady(sessionId: string): boolean {
  const cardId = useCardIdForSession(sessionId);
  return useCardJoinReady(cardId);
}

/**
 * The offer-stands fact for a **card**, live — the same reading keyed by the
 * address a transcript row actually holds ({@link CardIdContext}), rather than
 * by a session it would have to look up first.
 */
export function useCardJoinReady(cardId: string | null): boolean {
  const services = useSyncExternalStore(cardServicesStore.subscribe, () =>
    cardId === null ? null : cardServicesStore.getServices(cardId),
  );
  const join = useCardArcJoin(cardId, services?.changesController ?? null);
  return joinOfferStands(join.arcId, join.arcs);
}

/**
 * Which arc's offer stands for a card, by display name, or `null` when none
 * does — {@link joinOfferArcName}, live.
 */
export function useCardJoinReadyArc(cardId: string | null): string | null {
  const services = useSyncExternalStore(cardServicesStore.subscribe, () =>
    cardId === null ? null : cardServicesStore.getServices(cardId),
  );
  const join = useCardArcJoin(cardId, services?.changesController ?? null);
  return joinOfferArcName(join.arcId, join.arcs);
}

/**
 * The base a session's standing join offer would land on, or `null` when no
 * offer stands — the one fact the register's ready sentence needs beyond the
 * condition, for the masthead beat that composes it ([B10]).
 *
 * The same walk as {@link useSessionJoinReady}, so the beat, the dot and the
 * Z2 cell cannot disagree about whether an offer stands.
 */
export function useSessionJoinBase(sessionId: string): string | null {
  const cardId = useCardIdForSession(sessionId);
  const services = useSyncExternalStore(cardServicesStore.subscribe, () =>
    cardId === null ? null : cardServicesStore.getServices(cardId),
  );
  const join = useCardArcJoin(cardId, services?.changesController ?? null);
  return joinOfferBase(join.arcId, join.arcs);
}
