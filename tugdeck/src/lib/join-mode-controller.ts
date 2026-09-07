/**
 * join-mode-controller — per-card state + join path for join mode ([P01],
 * [P04], [P05]).
 *
 * Join mode is commit mode's twin in the arc lane: `/arc-join` (or the Z4A
 * Join segment, or the lane's Join affordance) turns the composer into the
 * join-message editor over the arc the feed describes, and Z5 swaps to cancel /
 * auto-message / join. Everything structural is `CommitModeController`'s shape
 * — the same four upstream stores folded into one referentially-stable
 * snapshot, the same enter / leave / exit / land triggers, the same staged-land
 * hook — so the composer drives both through one {@link LandingMode} slot and
 * neither has to know the other exists.
 *
 * What differs is what a join *means* here. The gate's third reason is the
 * arc's join state rather than the changeset: a join may proceed only over a
 * merge the server reports clean, or over a candidate the resolution ladder
 * built out of the conflicts. That state is not asked for — it rides the arc's
 * feed entry as a `join` block the server computes on every changeset
 * recompute, so this controller reads it and never previews. And the draft is
 * the *arc's*: it keys on the arc's owner id, so the message the run's
 * `tugtool draft set` maintained is what the editor opens on.
 *
 * @module lib/join-mode-controller
 */

import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { CommitModeController } from "@/lib/commit-mode-controller";
import type {
  ArcChangesetEntry,
  ArcJoinBlockerWire,
  ArcJoinStateWire,
} from "@/lib/changeset-types";
import type { JoinPhase } from "@/lib/changeset-verb-store";
import type {
  LandOutcome,
  LandingMode,
  LandingRefusal,
  LandingSnapshot,
} from "@/lib/landing-mode";
import {
  CHANGES_SERVICE_DISCONNECTED,
  matchesJoinReceipt,
  sameRefusal,
} from "@/lib/landing-mode";
import { getChangesetVerbStore } from "@/lib/changeset-verb-store";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { sendLandingReceipt } from "@/lib/landing-press-receipt";
import { getChangesetDraftStore, type DraftOverlayPhase } from "@/lib/changeset-draft-store";
import { getChangesetJoinStore } from "@/lib/changeset-join-store";
import {
  arcJoinRegister,
  SETTLED_REST_MS,
  type ArcJoinRegister,
} from "@/lib/arc-join-register";

/** The arc a join mode is aimed at — the identity plus what the face reads. */
export interface JoinTarget {
  /** The arc's owner key: its identity, and its draft row's `owner_id`. */
  ownerId: string;
  /** The short display name (`tugtool arc join <name>`). */
  name: string;
  /** The base branch this arc joins onto. */
  base: string;
  /** Commits on the arc branch past its base. */
  rounds: number;
  /** Whether the arc worktree has uncommitted changes. */
  worktreeDirty: boolean;
}

/**
 * The join outcome the surface fronts ([#outcome-derivation]). `empty` and
 * `blocked` both come from the feed's blockers — `empty` is called out
 * separately because its answer is release, not a fix. `stale` is a candidate
 * the server has already invalidated: it names which side moved, and the act
 * that clears it is another run of the ladder.
 */
export type JoinOutcome = "clean" | "conflicted" | "blocked" | "empty" | "stale";

/** Inputs to the pure join gate. */
export interface JoinGateInput {
  /** A Claude turn is in flight (`canInterrupt`) — durable mutations wait. */
  turnInProgress: boolean;
  /**
   * A session holding the *arc* is still working — mid-turn, or waiting on a
   * background job it launched. The feed's `holders_busy`.
   *
   * Distinct from `turnInProgress`, which is about the composer's own session.
   * The arc is usually built by a different card, and its work is not
   * finished when the model stops speaking: the tests it backgrounded are
   * still deciding whether it works. A join pressed in that window lands work
   * nobody has finished checking.
   */
  holderBusy: boolean;
  /** The current join round-trip phase for this entry. */
  joinPhase: JoinPhase;
  /** The derived join outcome. */
  outcome: JoinOutcome;
  /** A candidate commit from the resolution ladder, if one was built. */
  candidateCommit: string | null;
  /** The trimmed join message. */
  message: string;
}

/** Why a join press was refused. */
export type JoinGateReason =
  | "turn"
  | "holder"
  | "pending"
  | "outcome"
  | "empty-message";

/** The join-gate verdict — `ok`, or the first failing reason. */
export type JoinGate = { ok: true } | { ok: false; reason: JoinGateReason };

/**
 * Whether a join may proceed, and if not, why ([P05]). Pure; exported so the Join
 * button's disable state and the controller's join path share one gate. The
 * order is commit's, field for field — turn, then the round trip, then what is
 * being joined, then the message — because the reasons map to the button's
 * disable-and-hint precedence and the two gates must not disagree.
 *
 * `outcome` passes on a clean preview, or on any state carrying a candidate
 * commit: a resolved conflict is a joinable arc even though its history is
 * `conflicted`.
 */
export function evaluateJoinGate(input: JoinGateInput): JoinGate {
  if (input.turnInProgress) return { ok: false, reason: "turn" };
  // Above the round trip for the same reason `turn` is: nothing about the
  // join's own state matters while the work behind it is still moving.
  if (input.holderBusy) return { ok: false, reason: "holder" };
  if (input.joinPhase === "pending") return { ok: false, reason: "pending" };
  // The outcome already accounts for the candidate ({@link deriveJoinOutcome}),
  // so it is the whole answer. It deliberately no longer reads
  // `candidateCommit` as a second, independent arm: that arm re-admitted every
  // state the outcome had just refused — a blocked join with a candidate was
  // joinable through it, which is the shade saying "blocked" and the button
  // saying "go".
  if (input.outcome !== "clean") return { ok: false, reason: "outcome" };
  // Nothing about a build is asked here. The run's ending verified the tree
  // that lands, so what is left between a press and the base is the message.
  if (input.message.trim().length === 0) return { ok: false, reason: "empty-message" };
  return { ok: true };
}

/**
 * Why the join is refused, in the gate's own precedence — the sentence that
 * goes wherever a Join control is disabled.
 *
 * It lives beside {@link evaluateJoinGate} rather than in a surface,
 * because two surfaces need it (the fronted row's join face and the
 * composer's Join button) and a refusal that reads differently in two places
 * is worse than one that reads tersely in both.
 */
export function joinDisabledReason(
  reason: JoinGateReason,
  outcome: JoinOutcome,
  staleNote?: string | null,
): string {
  if (reason === "turn") return "Wait for the turn to finish";
  // Named for the arc rather than "the turn", because the two are usually
  // different cards — and because a background test sweep outlives the turn
  // that started it, so "the turn is finished" would be true and useless.
  if (reason === "holder") return "Wait for the arc to finish its work";
  // `pending` is the execute round trip and nothing else now that the card
  // never previews, so the sentence says the only thing it can mean.
  if (reason === "pending") return "Joining…";
  // Without its own arm this falls to the outcome switch and, on a clean
  // preview, reads "This join is not ready yet" — which names nothing the user
  // can act on when all that is missing is the message.
  if (reason === "empty-message") return "Write a join message";
  switch (outcome) {
    case "conflicted":
      return "Resolve the conflicts first";
    case "blocked":
      return "Clear what blocks this join first";
    case "empty":
      return "Nothing to join";
    // The server's own sentence names which side moved, so it is the refusal;
    // the fallback covers a stale state whose note did not survive the wire.
    case "stale":
      return staleNote !== null && staleNote !== undefined && staleNote !== ""
        ? staleNote
        : "The resolution is out of date — resolve again";
    default:
      return "This join is not ready yet";
  }
}

/**
 * What clears a refusal, and where the user finds it ([P08]).
 *
 * [L31] got refusals to *speak*. It was not enough: the 2026-08-18 deadlock
 * produced a true sentence pointing at a control that was not on screen, which
 * is silence in the only terms that matter. So every reason names the DOM slot
 * of the thing that clears it, or says plainly that time clears it and nothing
 * else does — and a reason added without a row fails `tsc`.
 *
 * `slot` is `null` exactly where waiting is the whole answer. Those rows are
 * not an exemption from [L31]; they are why the sentence has to name the wait,
 * since there is nothing to point at — and after [P09] they are nearly all of
 * them, because the machine took over the acts they used to name.
 */
export interface ReachabilityRow {
  /** The `data-slot` of the control that clears this refusal, or `null`. */
  slot: string | null;
  /**
   * Where that control is — the composer, or nowhere, because only time
   * clears it ([P09]).
   *
   * `"join-face"` was the third arm, and it is gone. Every act in the join
   * now lives in Z5 or in a summoned prompt, so a refusal pointing at the
   * shade would name a control that is not there: the same 2026-08-18 failure
   * this table was written to make impossible, arrived at from the other
   * direction. With the arm deleted, a reason that tried to point at the shade
   * is a type error rather than a bug somebody has to notice.
   */
  where: "composer" | "time";
}

export const REFUSAL_REACHABILITY = {
  // No control clears a running turn — the sentence names the wait.
  turn: { slot: null, where: "time" },
  // Nor an arc still working. Time is the whole answer: the session finishes
  // its turn and its background jobs report, and the refusal clears itself.
  holder: { slot: null, where: "time" },
  // Nor a join already in flight. This reason is also why the joinable row
  // needs no control of its own: with nothing to press twice, a second press
  // cannot double-submit a join.
  pending: { slot: null, where: "time" },
  // Every reading of `outcome` is now a wait. Conflicted and stale are the
  // pilot's to clear and it starts unprompted; blocked is cleared outside the
  // app entirely, which is why each blocker carries its own act sentence; and
  // an empty arc is the one state whose answer — discard — is deliberately
  // rare enough to live in the row's overflow menu rather than in a refusal.
  // What every one of them has in common is that the composer holds nothing
  // that would help, so the sentence has to be the whole answer.
  outcome: { slot: null, where: "time" },
  // The message is the composer's document, so the editor is the control.
  "empty-message": { slot: "tug-prompt-entry", where: "composer" },
} satisfies Record<JoinGateReason, ReachabilityRow>;

/**
 * The gate's inputs, reduced to what may be written down ([L31]). The message
 * is carried as a length: the join draft's words are the user's, and a refusal
 * record that quoted them would put a private document into a log line.
 *
 * Exported because the dev-log line and the durable receipt must describe the
 * same press — one value, two consumers, so a receipt cannot disagree with the
 * sentence it accompanies.
 */
export function joinGateFacts(input: JoinGateInput): Record<string, unknown> {
  return {
    turnInProgress: input.turnInProgress,
    holderBusy: input.holderBusy,
    joinPhase: input.joinPhase,
    outcome: input.outcome,
    candidateCommit: input.candidateCommit,
    messageLen: input.message.trim().length,
  };
}

/** The controller's subscribable snapshot — the shared half plus join's own. */
export interface JoinModeSnapshot extends LandingSnapshot {
  /** The arc being joined, or null when the mode is down. */
  arc: JoinTarget | null;
  /** The derived join outcome ([#outcome-derivation]). */
  outcome: JoinOutcome;
  /** Conflicting paths, as the server's merge probe reports them. */
  conflicts: readonly string[];
  /** What would refuse this join, from the server's preflight. */
  blockers: readonly ArcJoinBlockerWire[];
  /** A candidate commit from the resolution ladder, if one still verifies. */
  candidateCommit: string | null;
  /** The server's sentence for a candidate that no longer describes the heads. */
  staleNote: string | null;
}

export interface JoinModeControllerDeps {
  changesController: ChangesRouteController;
  codeSessionStore: CodeSessionStore;
  /** Entering join mode exits commit mode — one composer, one document ([P01]). */
  commitModeController: CommitModeController;
}

/**
 * The arc draft's owner kind — the draft engine's `DraftTarget::Arc` key.
 *
 * It must match what the server stores and filters on: `changes.db`'s
 * `changeset_drafts.owner_kind` reads `arc`, and a draft reaches an arc's
 * entry only for rows carrying that value. A deck sending the retired
 * spelling writes a row nothing ever reads back.
 */
const ARC_OWNER_KIND = "arc";

export class JoinModeController implements LandingMode {
  /** The landing this mode performs ([P01]) — the composer's labels read it. */
  readonly kind = "join" as const;

  private readonly deps: JoinModeControllerDeps;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[] = [];

  private active = false;
  private seedMessage: string | null = null;
  private target: JoinTarget | null = null;
  /**
   * The arc this composer last fired a join at, kept **past the mode exit**
   * so the register can finish its sentence ([P03]).
   *
   * Landing exits the mode — the host stages a join by exiting, and exiting
   * clears the target — which used to take the composer's register down at the
   * exact moment it had the most to say. The press was the last thing that
   * surface reported about a join it started. So the target dies on exit and
   * this does not: it is what the register is derived from while the join runs
   * and after it settles, and the next entry or aim retires it.
   *
   * A narration that **succeeded** also retires itself, after
   * {@link SETTLED_REST_MS} ([P03]). It used to rest until something replaced
   * it, which was right when the register was the only surface that could
   * report a landed join. It no longer is: the join lands a durable
   * `/arc-join` receipt row in the transcript, and the inline surface says so
   * where the decision was made. A third copy of the same sentence resting
   * forever on an input surface is furniture, not news. A **failed** narration
   * still rests — it is the outcome the user has something to do about.
   */
  private narration: JoinTarget | null = null;
  /**
   * The newest `/arc-join` receipt already in the transcript when the current
   * narration began, or `null` when there was none — the mark that tells this
   * join's receipt from a past one.
   */
  private narrationPriorReceipt: string | null = null;
  /** The pending retirement of a settled-success narration, if one is due. */
  private narrationRestTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: JoinModeSnapshot;
  private landHook: ((runJoin: () => void) => void) | null = null;
  private messageProvider: (() => string) | null = null;
  private landRefusal: LandingRefusal | null = null;
  private refusalSeq = 0;

  constructor(deps: JoinModeControllerDeps) {
    this.deps = deps;
    this.snapshot = this.derive();

    this.unsubscribes.push(deps.codeSessionStore.subscribe(() => this.recompute()));
    this.unsubscribes.push(deps.changesController.subscribe(() => this.recompute()));
    const verbStore = getChangesetVerbStore();
    if (verbStore !== null) {
      this.unsubscribes.push(verbStore.subscribe(() => this.recompute()));
    }
    const draftStore = getChangesetDraftStore();
    if (draftStore !== null) {
      this.unsubscribes.push(draftStore.subscribe(() => this.recompute()));
    }
    // The join's beats and the ladder's progress both live here, and both feed
    // the register the composer shows ([P03], [P04]). Without this subscription
    // the composer's status row would freeze on whichever beat happened to be
    // current when some *other* store last moved.
    const joinStore = getChangesetJoinStore();
    if (joinStore !== null) {
      this.unsubscribes.push(joinStore.subscribe(() => this.recompute()));
    }
  }

  // ── Store surface ([L02]) ──────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): JoinModeSnapshot => this.snapshot;

  /** Install (or clear) the host's land orchestrator — the staged join. */
  setLandHook(hook: ((runJoin: () => void) => void) | null): void {
    this.landHook = hook;
  }

  /** The arc entry this mode is aimed at, read live off the changes snapshot. */
  private entry(): ArcChangesetEntry | null {
    // The narration is the fallback for the same reason {@link entryFor} takes
    // an id: the arc a join is *about* outlives the mode aimed at it. A
    // server-started join never sets a target at all, and without this arm its
    // register would derive from an absent feed entry — a live join reported
    // as an arc nothing can say anything about.
    const ownerId = (this.target ?? this.narration)?.ownerId;
    if (ownerId === undefined) return null;
    return this.entryFor(ownerId);
  }

  /**
   * An arc entry by owner key. Taken by id rather than off `this.target`
   * because the staged land path runs a beat after the mode exits, and by then
   * the target is gone while the arc it captured is still on the feed.
   */
  private entryFor(ownerId: string): ArcChangesetEntry | null {
    return (
      this.deps.changesController.getSnapshot().arcs.find((d) => d.owner_id === ownerId) ?? null
    );
  }

  // ── Derivation ─────────────────────────────────────────────────────────

  private derive(): JoinModeSnapshot {
    const { changesController, codeSessionStore } = this.deps;
    const turnInProgress = codeSessionStore.getSnapshot().canInterrupt === true;

    const verbStore = getChangesetVerbStore();
    const joinState = verbStore?.joinState(changesController.entryKey) ?? null;
    const joinPhase: JoinPhase = joinState?.phase ?? "idle";
    const landError = joinState?.error ?? null;

    // Everything about what a join would do comes from the arc’s own feed
    // entry — one server-owned block, delivered on the snapshot every card
    // already subscribes to. There is no second reading of it to disagree with.
    const entry = this.entry();
    const join = entry?.join ?? null;
    const conflicts = join?.conflicts ?? [];
    const blockers = join?.blockers ?? [];
    const candidateCommit =
      typeof join?.candidate === "string" && join.candidate !== "" ? join.candidate : null;
    const staleNote =
      typeof join?.stale_note === "string" && join.stale_note !== "" ? join.stale_note : null;

    const outcome = deriveJoinOutcome(join);

    const draftStore = getChangesetDraftStore();
    // The arc's own draft row — `workspaceKey`, never `projectDir` ([L29]) —
    // so the editor opens on the join message the run maintained.
    const overlay =
      this.target !== null
        ? draftStore?.overlay(
            changesController.workspaceKey,
            ARC_OWNER_KIND,
            this.target.ownerId,
          ) ?? null
        : null;
    const draftPhase: DraftOverlayPhase = overlay?.phase ?? "idle";
    const persistedMessage = entry?.draft?.message ?? "";
    const draftText =
      draftPhase === "drafting" || draftPhase === "ready"
        ? overlay?.text ?? persistedMessage
        : persistedMessage;
    const draftError = draftPhase === "error" ? overlay?.detail ?? null : null;

    const gate = evaluateJoinGate({
      turnInProgress,
      holderBusy: entry?.holders_busy === true,
      joinPhase,
      outcome,
      candidateCommit,
      message: "x", // ignore message emptiness here (CSS-gated on data-commit-empty)
    });
    // The same sentence the fronted row's join face shows, carried to the
    // composer's button — which is where somebody who typed `/arc-join` is
    // actually looking, and which otherwise reports a constant.
    const landBlockedReason = gate.ok
      ? null
      : joinDisabledReason(gate.reason, outcome, staleNote);
    const messagePresent = this.active && (this.messageProvider?.() ?? "").trim().length > 0;
    // The aimed arc while there is one, the arc this composer last fired at
    // once the press has taken the mode down. Only the register reads it —
    // every other field on this snapshot is about a mode that is *open*, and a
    // narration is about a run that is over.
    const registerTarget = this.target ?? this.narration;

    return {
      active: this.active,
      // Between the press and the next thing this composer is asked to do.
      narrating: !this.active && this.narration !== null,
      seedMessage: this.seedMessage,
      canLandIgnoringMessage: gate.ok,
      landBlockedReason,
      // The same reading the Arcs card row and the shade row show, because all
      // three call one derivation ([P04]). The composer is where somebody who
      // typed `/arc-join` is actually looking.
      register:
        registerTarget === null
          ? null
          : arcJoinRegister({
              arc: registerTarget.name,
              base: registerTarget.base,
              stage: entry?.stage ?? null,
              join,
              holdersBusy: entry?.holders_busy === true,
              // The composer says the same thing the two rows do, so a live
              // wheel holds this surface's offer shut too.
              run: entry?.arc ?? null,
              resolvePhase: getChangesetJoinStore()?.state(
                changesController.workspaceKey,
                registerTarget.name,
              ).phase,
              // …and which act it is. The composer says the same thing the two
              // rows do, so it reads the same pair they do.
              resolveAct: getChangesetJoinStore()?.state(
                changesController.workspaceKey,
                registerTarget.name,
              ).act,
              landBeat: getChangesetJoinStore()?.landProgress(
                changesController.workspaceKey,
                registerTarget.name,
              ),
            }),
      landReady: this.active && gate.ok && messagePresent,
      landPhase: joinPhase,
      landError,
      landRefusal: this.landRefusal,
      draftPhase,
      draftText,
      persistedMessage,
      edited: entry?.draft?.edited === true,
      draftError,
      arc: this.target,
      outcome,
      conflicts,
      blockers,
      candidateCommit,
      staleNote,
    };
  }

  private recompute(): void {
    this.scheduleNarrationRetirement();
    const next = this.derive();
    if (!snapshotsEqual(next, this.snapshot)) {
      this.snapshot = next;
      this.fire();
    }
  }

  /**
   * The exchange id of the newest `/arc-join` receipt in the transcript, or
   * `null` when there is none.
   *
   * Scanned backwards, from the live edge, because the row this looks for is
   * the one that just landed: the hot path stops on the first receipt it
   * reads, and only the once-per-press mark walks the whole record.
   */
  private newestJoinReceipt(): string | null {
    const snapshot = this.deps.codeSessionStore.getSnapshot();
    // Newest run first: the active turn, then the committed ones in reverse.
    const runs = [
      ...(snapshot.activeTurn === null ? [] : [snapshot.activeTurn.messages]),
      ...[...snapshot.transcript].reverse().map((turn) => turn.messages),
    ];
    for (const messages of runs) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.kind !== "shell_exchange") continue;
        if (message.settledAtMs === null) continue;
        if (!matchesJoinReceipt(message.command)) continue;
        return message.exchangeId;
      }
    }
    return null;
  }

  /**
   * Retire a narration whose join has landed — on its receipt, or failing
   * that after its rest ([P03]).
   *
   * Only a *success* retires, and only while the mode is closed: an open mode
   * has a target of its own and nothing here applies. A failure keeps the
   * register, because `join-failed` is the standing surface for the one
   * outcome that still wants an act. Anything that replaces the narration
   * first — a new aim, a new press — cancels the pending retirement, so the
   * timer can never clear a sentence about a different join.
   *
   * **The receipt is what the narration was narrating toward.** A landed join
   * writes a `/arc-join` row into the transcript, and that row carries the
   * settled sentence itself — so from the moment it arrives, a live register
   * still resting is a second copy of a sentence the ledger now holds, two
   * rows apart and identical. The rest exists so a success cannot vanish on
   * its own terminal frame; a durable receipt taking its place is not
   * vanishing, so the receipt cuts the rest short. The timer stays for the
   * join whose receipt lands somewhere else — the pilot's, on an arc another
   * card holds — where nothing in this transcript will ever speak for it.
   */
  private scheduleNarrationRetirement(): void {
    const cancel = (): void => {
      if (this.narrationRestTimer === null) return;
      clearTimeout(this.narrationRestTimer);
      this.narrationRestTimer = null;
    };
    const target = this.narration;
    if (target === null || this.active) {
      cancel();
      return;
    }
    const progress = getChangesetJoinStore()?.landProgress(
      this.deps.changesController.workspaceKey,
      target.name,
    );
    if (progress?.terminal !== true || progress.status === "error") {
      cancel();
      return;
    }
    if (this.newestJoinReceipt() !== this.narrationPriorReceipt) {
      cancel();
      this.narration = null;
      return;
    }
    if (this.narrationRestTimer !== null) return;
    this.narrationRestTimer = setTimeout(() => {
      this.narrationRestTimer = null;
      // Guard the moment of firing, not only the moment of scheduling: the
      // narration may have been replaced by a join started while this one
      // rested.
      if (this.narration !== target) return;
      this.narration = null;
      this.recompute();
    }, SETTLED_REST_MS);
  }

  private fire(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // ── Triggers ───────────────────────────────────────────────────────────

  /**
   * Enter join mode on `target`. A `/arc-join <name> <message>` seed is
   * written into the arc's draft as an edited draft, so the composer seeds
   * from it exactly as commit mode does. Commit mode exits — one composer, one
   * document ([P01]). Nothing is asked of the server: the arc's feed entry
   * already says what a join would do, so the surface opens knowing.
   */
  enter(target: JoinTarget, seedMessage?: string): void {
    const seed = seedMessage?.trim() ?? "";
    if (seed.length > 0) {
      getChangesetDraftStore()?.setDraft(
        this.deps.changesController.workspaceKey,
        ARC_OWNER_KIND,
        target.ownerId,
        { message: seed, edited: true },
      );
    }
    this.deps.commitModeController.exit();
    // Opening the mode is the composer being put to a new use, so the last
    // join's settled sentence stops being what it is for.
    this.narration = null;
    this.target = target;
    this.seedMessage = seed.length > 0 ? seed : null;
    this.active = true;
    this.snapshot = this.derive();
    this.fire();
    this.ensureCandidate();
  }

  /**
   * A clean arc grows a candidate without being asked ([P03]).
   *
   * A conflicted arc has always been resolved before it could join, so what
   * would land was a tree the project's checks had judged. A clean one skipped
   * all of it and joined on the strength of git reporting no textual conflict —
   * which is not the same claim. The failure this closes is a merge with no
   * conflicting file that does not build: a symbol renamed on one side, a new
   * call site added on the other.
   *
   * So entering the mode on a clean arc sends the same resolve a conflicted
   * one sends. The ladder's one-shot squash anchors a candidate, the server
   * verifies it unpressed, and the gate that already refuses an unverified
   * candidate finally has one to refuse.
   *
   * An action taken on entry, never derived state — and safe to fire twice,
   * because one arc admits one run ([P01]) and the second send comes back as
   * a named refusal rather than a second ladder.
   */
  private ensureCandidate(): void {
    const target = this.target;
    if (target === null) return;
    const join = this.entry()?.join ?? null;
    if (join === null) return;
    if (deriveJoinOutcome(join) !== "clean") return;
    if (typeof join.candidate === "string" && join.candidate !== "") return;
    if (typeof join.run === "string" && join.run !== "") return;
    getChangesetJoinStore()?.resolve(this.deps.changesController.workspaceKey, target.name);
  }

  /**
   * Aim the mode at an arc **without entering** — the arc lane's expand. The
   * face the row renders is this controller's snapshot, so aiming is what makes
   * one derivation serve both the lane and the composer; without it the lane
   * would need a second reading of the same state.
   *
   * Pure targeting: the join state the face reads arrives with the feed, so
   * opening a row asks the server nothing and costs nothing.
   */
  aim(target: JoinTarget): void {
    this.retarget(target);
  }

  /** Point the mode at an arc. */
  private retarget(target: JoinTarget): void {
    if (sameTarget(this.target, target)) return;
    // Aiming somewhere is the composer being asked about an arc, so whatever
    // it was still saying about the last join it fired stops being what this
    // surface is for.
    this.narration = null;
    this.target = target;
    this.snapshot = this.derive();
    this.fire();
  }

  // `resumeTeardown` lived here. It is gone with its button ([P08]): the join
  // journal is durable and an interrupted teardown resumes itself off it, so
  // the method existed only because nothing did. `continueJoin` stays on
  // `JoinArgs` — the CLI still asks for it, and it is the server's own resume.

  setMessageProvider(read: (() => string) | null): void {
    this.messageProvider = read;
    this.recompute();
  }

  notifyMessageChanged(): void {
    this.recompute();
  }

  /** The user leaving the route: persist what is typed, then exit. */
  leave(): void {
    if (!this.active) return;
    const message = this.messageProvider?.() ?? "";
    if (message.trim().length > 0) this.persistMessage(message);
    this.exit();
  }

  /** Exit the mode (the composer clears back to the prompt). */
  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.seedMessage = null;
    this.target = null;
    this.landRefusal = null;
    // A standing failure is the mode's, not the store's ([P05]): leaving the
    // join surface and coming back must not re-raise the error the user
    // already walked away from. Only `error` qualifies — a `conflict` settle
    // carries `error: null`, so there is no standing failure to clear there.
    //
    // The entry key comes from the changes controller rather than the target,
    // which the line above just nulled. And the order matters: `clearJoin`
    // fires the store's subscribers synchronously and this controller is one
    // of them, so it re-enters `recompute()` mid-`exit()`. Clearing after the
    // flag is down means that re-entrant derive already sees `active: false`
    // and agrees with the final derive below; clearing before it would publish
    // one intermediate snapshot reading active-with-no-error, which the strip
    // would render for a frame.
    const { entryKey } = this.deps.changesController;
    const verbStore = getChangesetVerbStore();
    if (verbStore?.joinState(entryKey).phase === "error") verbStore.clearJoin(entryKey);
    this.snapshot = this.derive();
    this.fire();
  }

  /** Persist a message edit into the arc's draft row. */
  persistMessage(text: string): void {
    const target = this.target;
    if (target === null) return;
    getChangesetDraftStore()?.setDraft(
      this.deps.changesController.workspaceKey,
      ARC_OWNER_KIND,
      target.ownerId,
      { message: text, edited: true },
    );
  }

  /** Request an auto-message draft for the arc; `force` is the Regenerate. */
  requestDraft(force = false): void {
    const target = this.target;
    if (target === null) return;
    getChangesetDraftStore()?.requestDraft(
      this.deps.changesController.workspaceKey,
      ARC_OWNER_KIND,
      target.ownerId,
      force,
    );
  }

  /** Cancel an in-flight auto-message draft. A no-op when nothing is drafting. */
  cancelDraft(): void {
    const target = this.target;
    if (target === null) return;
    getChangesetDraftStore()?.cancelDraft(
      this.deps.changesController.workspaceKey,
      ARC_OWNER_KIND,
      target.ownerId,
    );
  }

  /**
   * Land the join ([P05]): re-check the gate against live state, then either
   * hand it to the host's land hook (staged behind the shade's dismissal) or
   * fire it inline. A refusal is surfaced here and reported by type ([L31]) —
   * this path has no outcome where nothing happens and nothing is said.
   */
  land(message: string): LandOutcome {
    const text = message.trim();
    // The arc is captured at press time and carried into the staged callback,
    // never re-read from `this.target` when it runs. The host stages a join
    // by exiting the mode, and exiting clears the target — so a staged join
    // that looked its arc up on the later beat would find nothing to join.
    const target = this.target;
    if (target === null) {
      return this.refuse(
        "fault",
        "No arc is aimed for this join — reopen the arc row",
        "no-target",
        null,
      );
    }
    const input = this.liveGateInput(text, target);
    const gate = evaluateJoinGate(input);
    if (!gate.ok) {
      return this.refuse(
        "gate",
        joinDisabledReason(gate.reason, input.outcome, this.staleNoteFor(target)),
        gate.reason,
        input,
      );
    }
    this.clearRefusal();
    sendLandingReceipt({ kind: "join", verdict: "ok", gate: joinGateFacts(input) });
    // The press is the first beat ([P01], [P02]). The staged path exits the
    // mode before the join fires — which clears `target`, the register's first
    // choice of subject — so aiming the narration here is what keeps the
    // register mounted across the shade's dismissal, and seeding the store's
    // beat here is what gives it something true to say while the server is
    // still deciding. Both are retracted by {@link performJoin} if the
    // re-check refuses.
    getChangesetJoinStore()?.beginLand(this.deps.changesController.workspaceKey, target.name);
    this.narration = target;
    this.narrationPriorReceipt = this.newestJoinReceipt();
    const runJoin = () => this.performJoin(text, target);
    if (this.landHook !== null) {
      this.landHook(runJoin);
      return { kind: "staged" };
    }
    runJoin();
    return { kind: "fired" };
  }

  /**
   * Retry the failed join — the strip's Retry button ([P04]).
   *
   * It is {@link land} over the composer's live message, and deliberately not
   * a second path: the message is still in the editor because a failure never
   * clears the draft, and the gate has to be re-checked because the world may
   * have moved since the failure (a turn started, the preview went dirty). One
   * land verb means Retry and Z5 cannot disagree about what a press does.
   */
  retry(): LandOutcome {
    return this.land(this.messageProvider?.() ?? "");
  }

  /**
   * Publish and log a refused land press ([L31]).
   *
   * Every refusing branch on the land route ends here, which is what makes the
   * silence structurally unavailable: there is one exit from a refusal and it
   * writes to three places — the snapshot a notice surface subscribes to, the
   * dev log, and the caller's return value.
   */
  private refuse(
    kind: "gate" | "fault",
    sentence: string,
    reason: string,
    input: JoinGateInput | null,
  ): LandOutcome {
    this.refusalSeq += 1;
    this.landRefusal = { sentence, kind, seq: this.refusalSeq };
    const gate = input !== null ? joinGateFacts(input) : {};
    tugDevLogStore.warn("landing", `join land refused: ${sentence}`, { kind, ...gate });
    sendLandingReceipt({ kind: "join", verdict: "refused", reason, sentence, gate });
    this.snapshot = this.derive();
    this.fire();
    return { kind: "refused", sentence };
  }

  /** Drop a published refusal — an accepted press answers the last refused one. */
  private clearRefusal(): void {
    if (this.landRefusal === null) return;
    this.landRefusal = null;
    this.snapshot = this.derive();
    this.fire();
  }

  /**
   * The gate's inputs against live state — the same read the affordance's
   * disable uses. Built separately from the snapshot so a refusal can record
   * exactly what it judged, rather than a reconstruction of it.
   */
  private liveGateInput(message: string, target: JoinTarget): JoinGateInput {
    const { changesController, codeSessionStore } = this.deps;
    // Read live off the feed, not off the snapshot: the land path fires a beat
    // after the shade dismisses, and the mode has already exited by then — so a
    // snapshot read would judge a null target. The arc comes from the caller
    // for the same reason the staged land carries it.
    const join = this.entryFor(target.ownerId)?.join ?? null;
    const candidate = join?.candidate;
    return {
      turnInProgress: codeSessionStore.getSnapshot().canInterrupt === true,
      holderBusy: this.entryFor(target.ownerId)?.holders_busy === true,
      joinPhase: getChangesetVerbStore()?.joinState(changesController.entryKey).phase ?? "idle",
      outcome: deriveJoinOutcome(join),
      candidateCommit: typeof candidate === "string" && candidate !== "" ? candidate : null,
      message,
    };
  }

  /** The arc's stale-candidate sentence, for a refusal that must quote it. */
  private staleNoteFor(target: JoinTarget): string | null {
    const note = this.entryFor(target.ownerId)?.join?.stale_note;
    return typeof note === "string" && note !== "" ? note : null;
  }

  /**
   * Send the join and settle the round trip: on a landed commit the server
   * clears the arc's draft and every binding to it, so the mode just exits; on
   * a failure the error surfaces where the user acted — re-entering the mode if
   * the staged path already dismissed it. The gate is re-checked because the
   * staged path fires a beat later, after the shade animates out.
   */
  private performJoin(text: string, target: JoinTarget): void {
    const { changesController } = this.deps;
    const input = this.liveGateInput(text, target);
    const gate = evaluateJoinGate(input);
    if (!gate.ok) {
      this.retractNarration(target);
      if (!this.active) this.enter(target);
      this.refuse(
        "gate",
        joinDisabledReason(gate.reason, input.outcome, this.staleNoteFor(target)),
        gate.reason,
        input,
      );
      return;
    }
    const verbStore = getChangesetVerbStore();
    if (verbStore === null) {
      this.retractNarration(target);
      if (!this.active) this.enter(target);
      this.refuse("fault", CHANGES_SERVICE_DISCONNECTED, "no-verb-store", input);
      return;
    }
    verbStore.join(changesController.entryKey, changesController.workspaceKey, target.name, {
      preview: false,
      message: text,
      sessionId: changesController.tugSessionId,
      ...(input.candidateCommit !== null ? { candidate: input.candidateCommit } : {}),
    });
    const unsubscribe = verbStore.subscribe(() => {
      const phase = verbStore.joinState(changesController.entryKey).phase;
      if (phase === "pending") return;
      unsubscribe();
      if (phase === "done") {
        // The landed arc's draft row and bindings die server-side ([P14]);
        // clearing the ladder's candidate is what keeps a reused arc name
        // from inheriting a stale one.
        getChangesetJoinStore()?.clear(changesController.workspaceKey, target.name);
        this.exit();
      } else if (!this.active) {
        this.enter(target);
      }
    });
  }

  /**
   * Take back the narration an accepted press announced ([P02]).
   *
   * The press writes its own first beat, so a press that is then refused on
   * the live re-check has to unsay it — otherwise the register reports a join
   * that nobody is running, which is the resting lie this whole path exists to
   * remove, pointed the other way.
   */
  private retractNarration(target: JoinTarget): void {
    getChangesetJoinStore()?.clearLand(this.deps.changesController.workspaceKey, target.name);
    this.narration = null;
  }

  /**
   * Narrate a join **this composer did not fire** — the one a prompt-sheet
   * "Join now" starts on the server.
   *
   * Sets the narration and nothing else. Entering the mode would be wrong on
   * every count: there is no message to compose, no gate to evaluate, and no
   * press to make — the work is already under way. What the narration buys is
   * that `registerTarget` resolves, so the composer's status row carries the
   * beats and rests on the settled sentence, exactly as it does for a press.
   *
   * The previous run's last word is retired here for the same reason
   * {@link land} retires it: a new join is the only thing that may. This path
   * has no production caller today; one that wires it should seed the store's
   * own first beat (`beginLand`) rather than only clearing, since a
   * server-started join has no press to write one.
   */
  narrateServerJoin(target: JoinTarget): void {
    const { changesController } = this.deps;
    getChangesetJoinStore()?.clearLand(changesController.workspaceKey, target.name);
    this.narration = target;
    this.narrationPriorReceipt = this.newestJoinReceipt();
    this.recompute();
  }

  dispose(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.listeners.clear();
    if (this.narrationRestTimer !== null) clearTimeout(this.narrationRestTimer);
  }
}

/**
 * The join outcome, derived from the arc's server-owned join block
 * ([#outcome-derivation]). Pure and exported so the lane's face and the
 * controller agree by construction rather than by two readings of the same
 * table.
 *
 * An absent block is `blocked`: an arc whose join state has not reached this
 * deck is one nothing can say is joinable, and refusing is the only answer
 * that cannot be wrong.
 */
export function deriveJoinOutcome(join: ArcJoinStateWire | null | undefined): JoinOutcome {
  if (join === null || join === undefined) return "blocked";
  const blockers = join.blockers ?? [];
  if (blockers.some((b) => b.kind === "empty")) return "empty";
  // A BLOCKER outranks a resolved candidate, and the order here is the whole
  // point. The ladder resolves conflicts; it does not commit the base's
  // outstanding changes, finish an interrupted prior join, or make a branch
  // exist. Ranked the other way — as this was — a successful Resolve painted
  // `clean` over a face still displaying `join: commit outstanding changes`
  // one line below it, and the join gate believed the badge.
  if (blockers.length > 0) return "blocked";
  // A candidate the server still verifies DOES outrank the conflicts it was
  // built from — that is the one state where a conflicted history is joinable,
  // and the reason this check sits between the two.
  if (typeof join.candidate === "string" && join.candidate !== "") return "clean";
  // A note means the candidate that stood here no longer describes these two
  // heads. The merge underneath may well be clean, but joining it would land
  // an unreviewed machine merge under a review that answered a different one.
  if (typeof join.stale_note === "string" && join.stale_note !== "") return "stale";
  if ((join.conflicts ?? []).length > 0) return "conflicted";
  return "clean";
}

/** Field-by-field snapshot equality so `getSnapshot` stays referentially stable. */
function snapshotsEqual(a: JoinModeSnapshot, b: JoinModeSnapshot): boolean {
  return (
    a.active === b.active &&
    a.seedMessage === b.seedMessage &&
    a.canLandIgnoringMessage === b.canLandIgnoringMessage &&
    a.landBlockedReason === b.landBlockedReason &&
    a.landReady === b.landReady &&
    sameRegister(a.register, b.register) &&
    a.landPhase === b.landPhase &&
    a.landError === b.landError &&
    sameRefusal(a.landRefusal, b.landRefusal) &&
    a.draftPhase === b.draftPhase &&
    a.draftText === b.draftText &&
    a.persistedMessage === b.persistedMessage &&
    a.edited === b.edited &&
    a.draftError === b.draftError &&
    a.outcome === b.outcome &&
    a.candidateCommit === b.candidateCommit &&
    a.staleNote === b.staleNote &&
    sameTarget(a.arc, b.arc) &&
    sameStrings(a.conflicts, b.conflicts) &&
    sameBlockers(a.blockers, b.blockers)
  );
}

/**
 * The register is derived fresh on every recompute, so it is never
 * referentially stable and has to be compared by value ([P04]).
 *
 * It also has to be compared *at all*: a live join moves nothing else on this
 * snapshot — the gate stays refused on `pending` and the phase stays
 * `"pending"` — so a landing beat is the one fact that changes only here. An
 * equality check that skipped it would leave the composer's register frozen on
 * the first beat of a join it is narrating.
 */
function sameRegister(a: ArcJoinRegister | null, b: ArcJoinRegister | null): boolean {
  if (a === null || b === null) return a === b;
  return a.phase === b.phase && a.line === b.line && a.word === b.word;
}

function sameTarget(a: JoinTarget | null, b: JoinTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.ownerId === b.ownerId &&
    a.name === b.name &&
    a.base === b.base &&
    a.rounds === b.rounds &&
    a.worktreeDirty === b.worktreeDirty
  );
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameBlockers(
  a: readonly ArcJoinBlockerWire[],
  b: readonly ArcJoinBlockerWire[],
): boolean {
  return (
    a.length === b.length &&
    a.every((v, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        v.kind === other.kind &&
        v.detail === other.detail &&
        sameStrings(v.paths ?? [], other.paths ?? [])
      );
    })
  );
}

/** Build a {@link JoinTarget} from an arc changeset entry. */
export function joinTargetFromEntry(entry: ArcChangesetEntry): JoinTarget {
  return {
    ownerId: entry.owner_id,
    name: entry.display_name,
    base: entry.base,
    rounds: entry.rounds,
    worktreeDirty: entry.worktree_dirty,
  };
}
