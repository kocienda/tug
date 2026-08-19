/**
 * join-mode-controller — per-card state + join path for join mode ([P01],
 * [P04], [P05]).
 *
 * Join mode is commit mode's twin in the dash lane: `/dash-join` (or the Z4A
 * Join segment, or the lane's Join affordance) turns the composer into the
 * join-message editor over the dash the feed describes, and Z5 swaps to cancel /
 * auto-message / join. Everything structural is `CommitModeController`'s shape
 * — the same four upstream stores folded into one referentially-stable
 * snapshot, the same enter / leave / exit / land triggers, the same staged-land
 * hook — so the composer drives both through one {@link LandingMode} slot and
 * neither has to know the other exists.
 *
 * What differs is what a join *means* here. The gate's third reason is the
 * dash's join state rather than the changeset: a join may proceed only over a
 * merge the server reports clean, or over a candidate the resolution ladder
 * built out of the conflicts. That state is not asked for — it rides the dash's
 * feed entry as a `join` block the server computes on every changeset
 * recompute, so this controller reads it and never previews. And the draft is
 * the *dash's*: it keys on the dash's owner id, so the message the run's
 * `tugutil draft set` maintained is what the editor opens on.
 *
 * @module lib/join-mode-controller
 */

import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { CommitModeController } from "@/lib/commit-mode-controller";
import type {
  DashChangesetEntry,
  DashJoinBlockerWire,
  DashJoinStateWire,
} from "@/lib/changeset-types";
import type { JoinPhase } from "@/lib/changeset-verb-store";
import type { LandOutcome, LandingMode, LandingRefusal, LandingSnapshot } from "@/lib/landing-mode";
import { CHANGES_SERVICE_DISCONNECTED, sameRefusal } from "@/lib/landing-mode";
import { getChangesetVerbStore } from "@/lib/changeset-verb-store";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { sendLandingReceipt } from "@/lib/landing-press-receipt";
import { getChangesetDraftStore, type DraftOverlayPhase } from "@/lib/changeset-draft-store";
import { getChangesetJoinStore } from "@/lib/changeset-join-store";

/** The dash a join mode is aimed at — the identity plus what the face reads. */
export interface JoinTarget {
  /** The dash's owner key: its identity, and its draft row's `owner_id`. */
  ownerId: string;
  /** The short display name (`tugutil dash join <name>`). */
  name: string;
  /** The base branch this dash joins onto. */
  base: string;
  /** Commits on the dash branch past its base. */
  rounds: number;
  /** Whether the dash worktree has uncommitted changes. */
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
  /** The current join round-trip phase for this entry. */
  joinPhase: JoinPhase;
  /** The derived join outcome. */
  outcome: JoinOutcome;
  /** A candidate commit from the resolution ladder, if one was built. */
  candidateCommit: string | null;
  /** What the project's own checks said about the joined tree ([P04]). */
  verdict: JoinVerdict;
  /**
   * The user has looked at a red verdict and chosen to join past it ([P07]).
   *
   * Pinned to a candidate sha by whoever supplies it, so an override is a
   * decision about the tree it was made in view of and never carries to the
   * next one.
   */
  redOverride: boolean;
  /** The trimmed join message. */
  message: string;
}

/**
 * What verification says about the candidate that stands.
 *
 * `not-applicable` is the ordinary clean join: nothing was resolved by
 * machine, so there is no candidate and nothing to examine — that join gates
 * exactly as it always did. Every other value belongs to a candidate.
 */
export type JoinVerdict =
  | "not-applicable"
  | "unrun"
  | "running"
  | "green"
  | "red";

/** Why a join press was refused. */
export type JoinGateReason =
  | "turn"
  | "pending"
  | "outcome"
  | "unverified"
  | "verifying"
  | "verification-red"
  | "empty-message";

/** The join-gate verdict — `ok`, or the first failing reason. */
export type JoinGate = { ok: true } | { ok: false; reason: JoinGateReason };

/**
 * What the project's own checks said about the candidate that would join
 * ([P04], [P07]).
 *
 * This replaced a gate that asked the *human* to read a diff. That framing was
 * wrong twice over: it made the person the auditor of machine text decisions,
 * and it caught nothing a careless click could not wave through. What matters
 * about a resolved tree is whether it builds and passes — and whether the
 * resolver accounted for every file it touched ([P10]), which the report
 * carries. So the gate reads a verdict.
 *
 * Absence is `unrun`, never green: nobody having asked about this candidate is
 * a different fact from the checks having passed on it, and conflating them is
 * how a tree nobody built would join looking verified. The verdict is anchored
 * to `(base_sha, candidate_sha)` server-side, so it cannot survive either head
 * moving.
 */
export function verificationVerdict(
  join: DashJoinStateWire | null | undefined,
): JoinVerdict {
  if (join === null || join === undefined) return "not-applicable";
  if (typeof join.candidate !== "string" || join.candidate === "") {
    return "not-applicable";
  }
  const verification = join.verification;
  if (verification === undefined) return "unrun";
  const tiers = [verification.tier0, verification.tier1];
  if (tiers.includes("red")) return "red";
  if (tiers.includes("running")) return "running";
  if (tiers.includes("unrun")) return "unrun";
  return "green";
}

/**
 * Whether a standing red override is about *this* candidate ([P07]).
 *
 * The comparison is the whole point. The override is recorded against the sha
 * it was decided over, so a re-resolve — the ordinary response to a red — puts
 * a new candidate up and the override stops applying to it. Without the
 * comparison, one press of Join anyway would wave through every candidate that
 * dash ever produced afterwards.
 */
export function redOverrideStands(
  candidateCommit: string | null,
  resolve: { redOverrideFor: string | null } | null,
): boolean {
  if (candidateCommit === null || resolve === null) return false;
  return resolve.redOverrideFor === candidateCommit;
}

/**
 * Whether a join may proceed, and if not, why ([P05]). Pure; exported so the Join
 * button's disable state and the controller's join path share one gate. The
 * order is commit's, field for field — turn, then the round trip, then what is
 * being joined, then the message — because the reasons map to the button's
 * disable-and-hint precedence and the two gates must not disagree.
 *
 * `outcome` passes on a clean preview, or on any state carrying a candidate
 * commit: a resolved conflict is a joinable dash even though its history is
 * `conflicted`. The verdict sits immediately after it, because it is the same
 * question one level finer — not *is* there something to join, but *does what
 * would join survive the project's own checks*.
 */
export function evaluateJoinGate(input: JoinGateInput): JoinGate {
  if (input.turnInProgress) return { ok: false, reason: "turn" };
  if (input.joinPhase === "pending") return { ok: false, reason: "pending" };
  // The outcome already accounts for the candidate ({@link deriveJoinOutcome}),
  // so it is the whole answer. It deliberately no longer reads
  // `candidateCommit` as a second, independent arm: that arm re-admitted every
  // state the outcome had just refused — a blocked join with a candidate was
  // joinable through it, which is the shade saying "blocked" and the button
  // saying "go".
  if (input.outcome !== "clean") return { ok: false, reason: "outcome" };
  // The verdict sits immediately after the outcome, because it is the same
  // question one level finer — not *is* there something to join, but *does
  // what would join survive the project's own checks*. A red is refused unless
  // the user has looked at it and said join anyway: an override is a decision
  // made in view of the failure, never a default and never a trap.
  if (input.verdict === "red" && !input.redOverride) {
    return { ok: false, reason: "verification-red" };
  }
  if (input.verdict === "running") return { ok: false, reason: "verifying" };
  if (input.verdict === "unrun") return { ok: false, reason: "unverified" };
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
  // `pending` is the execute round trip and nothing else now that the card
  // never previews, so the sentence says the only thing it can mean.
  if (reason === "pending") return "Joining…";
  // Without its own arm this falls to the outcome switch and, on a clean
  // preview, reads "This join is not ready yet" — which names nothing the user
  // can act on when all that is missing is the message.
  if (reason === "empty-message") return "Write a join message";
  // Each names the act that clears it. The red one names the *override*
  // rather than a fix, because the override is the only thing on this surface
  // that moves a red join forward — the fix is another resolve, and saying so
  // here would point at a control that is not on screen.
  if (reason === "unverified") return "Verify the joined tree first";
  if (reason === "verifying") return "Verification is running";
  if (reason === "verification-red") {
    return "Verification failed — join anyway to proceed";
  }
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
 * `slot` is `null` exactly where waiting is the whole answer. Those two rows
 * are not an exemption from [L31]; they are why the sentence has to name the
 * wait, since there is nothing to point at.
 */
export interface ReachabilityRow {
  /** The `data-slot` of the control that clears this refusal, or `null`. */
  slot: string | null;
  /** Where that control is: the dash row's join face, or the composer. */
  where: "join-face" | "composer" | "time";
}

export const REFUSAL_REACHABILITY = {
  // No control clears a running turn — the sentence names the wait.
  turn: { slot: null, where: "time" },
  // Nor a join already in flight. This reason is also why the joinable row
  // needs no control of its own: with nothing to press twice, a second press
  // cannot double-submit a join.
  pending: { slot: null, where: "time" },
  // The conflicted and stale readings of `outcome`; see
  // {@link refusalReachability} for the two that answer to a different act.
  outcome: { slot: "session-changes-dash-resolve", where: "join-face" },
  // The verdict's three refusals, each pointing at the control that moves it:
  // the exam for an unrun one, nothing at all for one already running, and the
  // override for a red — which is the only control on this surface that can
  // carry a red join forward.
  unverified: { slot: "session-changes-dash-join-verify", where: "join-face" },
  verifying: { slot: null, where: "time" },
  "verification-red": {
    slot: "session-changes-dash-join-override",
    where: "join-face",
  },
  // The message is the composer's document, so the editor is the control.
  "empty-message": { slot: "tug-prompt-entry", where: "composer" },
} satisfies Record<JoinGateReason, ReachabilityRow>;

/**
 * The row for a live refusal, which needs the outcome as well as the reason.
 *
 * `outcome` is one reason covering four states, and they do not answer to the
 * same act: conflicted and stale want the ladder, blocked wants whatever each
 * blocker's own row names, and empty wants the dash released. Collapsing them
 * would point a refusal at a control that state does not mount — the exact
 * failure this table exists to make impossible.
 */
export function refusalReachability(
  reason: JoinGateReason,
  outcome: JoinOutcome,
): ReachabilityRow {
  if (reason !== "outcome") return REFUSAL_REACHABILITY[reason];
  if (outcome === "blocked") {
    return { slot: "session-changes-dash-join-blockers", where: "join-face" };
  }
  if (outcome === "empty") {
    return { slot: "session-changes-dash-discard", where: "join-face" };
  }
  return REFUSAL_REACHABILITY.outcome;
}

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
    joinPhase: input.joinPhase,
    outcome: input.outcome,
    candidateCommit: input.candidateCommit,
    verdict: input.verdict,
    redOverride: input.redOverride,
    messageLen: input.message.trim().length,
  };
}

/** The controller's subscribable snapshot — the shared half plus join's own. */
export interface JoinModeSnapshot extends LandingSnapshot {
  /** The dash being joined, or null when the mode is down. */
  dash: JoinTarget | null;
  /** The derived join outcome ([#outcome-derivation]). */
  outcome: JoinOutcome;
  /** Conflicting paths, as the server's merge probe reports them. */
  conflicts: readonly string[];
  /** What would refuse this join, from the server's preflight. */
  blockers: readonly DashJoinBlockerWire[];
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

/** The dash draft's owner kind — the draft engine's `DraftTarget::Dash` key. */
const DASH_OWNER_KIND = "dash";

export class JoinModeController implements LandingMode {
  /** The landing this mode performs ([P01]) — the composer's labels read it. */
  readonly kind = "join" as const;

  private readonly deps: JoinModeControllerDeps;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[] = [];

  private active = false;
  private seedMessage: string | null = null;
  private target: JoinTarget | null = null;
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

  /** The dash entry this mode is aimed at, read live off the changes snapshot. */
  private entry(): DashChangesetEntry | null {
    const ownerId = this.target?.ownerId;
    if (ownerId === undefined) return null;
    return this.entryFor(ownerId);
  }

  /**
   * A dash entry by owner key. Taken by id rather than off `this.target`
   * because the staged land path runs a beat after the mode exits, and by then
   * the target is gone while the dash it captured is still on the feed.
   */
  private entryFor(ownerId: string): DashChangesetEntry | null {
    return (
      this.deps.changesController.getSnapshot().dashes.find((d) => d.owner_id === ownerId) ?? null
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

    // Everything about what a join would do comes from the dash’s own feed
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
    // The dash's own draft row — `workspaceKey`, never `projectDir` ([L29]) —
    // so the editor opens on the join message the run maintained.
    const overlay =
      this.target !== null
        ? draftStore?.overlay(
            changesController.workspaceKey,
            DASH_OWNER_KIND,
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
      joinPhase,
      outcome,
      candidateCommit,
      verdict: verificationVerdict(join),
      redOverride: redOverrideStands(
        candidateCommit,
        this.target === null
          ? null
          : getChangesetJoinStore()?.state(
              changesController.workspaceKey,
              this.target.name,
            ) ?? null,
      ),
      message: "x", // ignore message emptiness here (CSS-gated on data-commit-empty)
    });
    // The same sentence the fronted row's join face shows, carried to the
    // composer's button — which is where somebody who typed `/dash-join` is
    // actually looking, and which otherwise reports a constant.
    const landBlockedReason = gate.ok
      ? null
      : joinDisabledReason(gate.reason, outcome, staleNote);
    const messagePresent = this.active && (this.messageProvider?.() ?? "").trim().length > 0;

    return {
      active: this.active,
      seedMessage: this.seedMessage,
      canLandIgnoringMessage: gate.ok,
      landBlockedReason,
      landReady: this.active && gate.ok && messagePresent,
      landPhase: joinPhase,
      landError,
      landRefusal: this.landRefusal,
      draftPhase,
      draftText,
      persistedMessage,
      edited: entry?.draft?.edited === true,
      draftError,
      dash: this.target,
      outcome,
      conflicts,
      blockers,
      candidateCommit,
      staleNote,
    };
  }

  private recompute(): void {
    const next = this.derive();
    if (!snapshotsEqual(next, this.snapshot)) {
      this.snapshot = next;
      this.fire();
    }
  }

  private fire(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // ── Triggers ───────────────────────────────────────────────────────────

  /**
   * Enter join mode on `target`. A `/dash-join <name> <message>` seed is
   * written into the dash's draft as an edited draft, so the composer seeds
   * from it exactly as commit mode does. Commit mode exits — one composer, one
   * document ([P01]). Nothing is asked of the server: the dash's feed entry
   * already says what a join would do, so the surface opens knowing.
   */
  enter(target: JoinTarget, seedMessage?: string): void {
    const seed = seedMessage?.trim() ?? "";
    if (seed.length > 0) {
      getChangesetDraftStore()?.setDraft(
        this.deps.changesController.workspaceKey,
        DASH_OWNER_KIND,
        target.ownerId,
        { message: seed, edited: true },
      );
    }
    this.deps.commitModeController.exit();
    this.target = target;
    this.seedMessage = seed.length > 0 ? seed : null;
    this.active = true;
    this.snapshot = this.derive();
    this.fire();
  }

  /**
   * Aim the mode at a dash **without entering** — the dash lane's expand. The
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

  /** Point the mode at a dash. */
  private retarget(target: JoinTarget): void {
    if (sameTarget(this.target, target)) return;
    this.target = target;
    this.snapshot = this.derive();
    this.fire();
  }

  /**
   * Resume an interrupted teardown from the dash's join journal (Spec S04).
   * Takes its dash, because the lane can offer this on a row the mode has never
   * been aimed at — a stale journal is exactly the state that refuses every
   * other act.
   */
  resumeTeardown(dash?: JoinTarget): void {
    if (dash !== undefined) this.retarget(dash);
    const target = this.target;
    if (target === null) return;
    const { changesController } = this.deps;
    getChangesetVerbStore()?.join(
      changesController.entryKey,
      changesController.workspaceKey,
      target.name,
      { preview: false, continueJoin: true, sessionId: changesController.tugSessionId },
    );
  }

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
    this.snapshot = this.derive();
    this.fire();
  }

  /** Persist a message edit into the dash's draft row. */
  persistMessage(text: string): void {
    const target = this.target;
    if (target === null) return;
    getChangesetDraftStore()?.setDraft(
      this.deps.changesController.workspaceKey,
      DASH_OWNER_KIND,
      target.ownerId,
      { message: text, edited: true },
    );
  }

  /** Request an auto-message draft for the dash; `force` is the Regenerate. */
  requestDraft(force = false): void {
    const target = this.target;
    if (target === null) return;
    getChangesetDraftStore()?.requestDraft(
      this.deps.changesController.workspaceKey,
      DASH_OWNER_KIND,
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
      DASH_OWNER_KIND,
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
    // The dash is captured at press time and carried into the staged callback,
    // never re-read from `this.target` when it runs. The host stages a join
    // by exiting the mode, and exiting clears the target — so a staged join
    // that looked its dash up on the later beat would find nothing to join.
    const target = this.target;
    if (target === null) {
      return this.refuse(
        "fault",
        "No dash is aimed for this join — reopen the dash row",
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
    const runJoin = () => this.performJoin(text, target);
    if (this.landHook !== null) {
      this.landHook(runJoin);
      return { kind: "staged" };
    }
    runJoin();
    return { kind: "fired" };
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
   * disable uses. Built separately from the verdict so a refusal can record
   * exactly what it judged, rather than a reconstruction of it.
   */
  private liveGateInput(message: string, target: JoinTarget): JoinGateInput {
    const { changesController, codeSessionStore } = this.deps;
    // Read live off the feed, not off the snapshot: the land path fires a beat
    // after the shade dismisses, and the mode has already exited by then — so a
    // snapshot read would judge a null target. The dash comes from the caller
    // for the same reason the staged land carries it.
    const join = this.entryFor(target.ownerId)?.join ?? null;
    const candidate = join?.candidate;
    return {
      turnInProgress: codeSessionStore.getSnapshot().canInterrupt === true,
      joinPhase: getChangesetVerbStore()?.joinState(changesController.entryKey).phase ?? "idle",
      outcome: deriveJoinOutcome(join),
      candidateCommit: typeof candidate === "string" && candidate !== "" ? candidate : null,
      verdict: verificationVerdict(join),
      redOverride: redOverrideStands(
        typeof candidate === "string" && candidate !== "" ? candidate : null,
        getChangesetJoinStore()?.state(
          changesController.workspaceKey,
          target.name,
        ) ?? null,
      ),
      message,
    };
  }

  /** The dash's stale-candidate sentence, for a refusal that must quote it. */
  private staleNoteFor(target: JoinTarget): string | null {
    const note = this.entryFor(target.ownerId)?.join?.stale_note;
    return typeof note === "string" && note !== "" ? note : null;
  }

  /**
   * Send the join and settle the round trip: on a landed commit the server
   * clears the dash's draft and every binding to it, so the mode just exits; on
   * a failure the error surfaces where the user acted — re-entering the mode if
   * the staged path already dismissed it. The gate is re-checked because the
   * staged path fires a beat later, after the shade animates out.
   */
  private performJoin(text: string, target: JoinTarget): void {
    const { changesController } = this.deps;
    const input = this.liveGateInput(text, target);
    const gate = evaluateJoinGate(input);
    if (!gate.ok) {
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
        // The landed dash's draft row and bindings die server-side ([P14]);
        // clearing the ladder's candidate is what keeps a reused dash name
        // from inheriting a stale one.
        getChangesetJoinStore()?.clear(changesController.workspaceKey, target.name);
        this.exit();
      } else if (!this.active) {
        this.enter(target);
      }
    });
  }

  dispose(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.listeners.clear();
  }
}

/**
 * The join outcome, derived from the dash's server-owned join block
 * ([#outcome-derivation]). Pure and exported so the lane's face and the
 * controller agree by construction rather than by two readings of the same
 * table.
 *
 * An absent block is `blocked`: a dash whose join state has not reached this
 * deck is one nothing can say is joinable, and refusing is the only answer
 * that cannot be wrong.
 */
export function deriveJoinOutcome(join: DashJoinStateWire | null | undefined): JoinOutcome {
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
    sameTarget(a.dash, b.dash) &&
    sameStrings(a.conflicts, b.conflicts) &&
    sameBlockers(a.blockers, b.blockers)
  );
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
  a: readonly DashJoinBlockerWire[],
  b: readonly DashJoinBlockerWire[],
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

/** Build a {@link JoinTarget} from a dash changeset entry. */
export function joinTargetFromEntry(entry: DashChangesetEntry): JoinTarget {
  return {
    ownerId: entry.owner_id,
    name: entry.display_name,
    base: entry.base,
    rounds: entry.rounds,
    worktreeDirty: entry.worktree_dirty,
  };
}
