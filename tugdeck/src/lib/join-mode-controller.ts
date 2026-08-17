/**
 * join-mode-controller — per-card state + land path for join mode ([P01],
 * [P04], [P05]).
 *
 * Join mode is commit mode's twin in the dash lane: `/dash-join` (or the Z4A
 * Join segment, or the lane's Join affordance) turns the composer into the
 * join-message editor over a *previewed* merge, and Z5 swaps to cancel /
 * auto-message / join. Everything structural is `CommitModeController`'s shape
 * — the same four upstream stores folded into one referentially-stable
 * snapshot, the same enter / leave / exit / land triggers, the same staged-land
 * hook — so the composer drives both through one {@link LandingMode} slot and
 * neither has to know the other exists.
 *
 * What differs is what a landing *means* here. The gate's third reason is the
 * preview rather than the changeset: a join may land only over a preview that
 * came back clean, or over a candidate the resolution ladder built out of the
 * conflicts. Entering therefore fires a preview immediately — a landing surface
 * that opens without knowing whether it can land is the thing this mode exists
 * to fix. And the draft is the *dash's*: it keys on the dash's owner id, so the
 * message the run's `tugutil draft set` maintained is what the editor opens on.
 *
 * @module lib/join-mode-controller
 */

import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { CommitModeController } from "@/lib/commit-mode-controller";
import type { DashChangesetEntry } from "@/lib/changeset-types";
import type { JoinBlocker, JoinPhase } from "@/lib/changeset-verb-store";
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
  /** The base branch this dash lands on. */
  base: string;
  /** Commits on the dash branch past its base. */
  rounds: number;
  /** Whether the dash worktree has uncommitted changes. */
  worktreeDirty: boolean;
}

/**
 * The landing outcome the surface fronts ([#outcome-derivation]). `empty` and
 * `blocked` both come from a preview's blockers — `empty` is called out
 * separately because its answer is release, not a fix.
 */
export type JoinOutcome = "unknown" | "previewing" | "clean" | "conflicted" | "blocked" | "empty";

/** Inputs to the pure join land-gate. */
export interface JoinLandGateInput {
  /** A Claude turn is in flight (`canInterrupt`) — durable mutations wait. */
  turnInProgress: boolean;
  /** The current join round-trip phase for this entry. */
  joinPhase: JoinPhase;
  /** The derived landing outcome. */
  outcome: JoinOutcome;
  /** A candidate commit from the resolution ladder, if one was built. */
  candidateCommit: string | null;
  /**
   * The ladder resolved files by machine and the user has not yet read what it
   * decided ({@link resolutionAwaitsReview}).
   */
  unreviewedResolution: boolean;
  /** The trimmed join message. */
  message: string;
}

/** The land-gate verdict — `ok`, or the first failing reason. */
export type JoinLandGate =
  | { ok: true }
  | { ok: false; reason: "turn" | "pending" | "outcome" | "unreviewed" | "empty-message" };

/**
 * Whether the ladder's per-file decisions still await the user's eyes ([P31]).
 *
 * Only a candidate built out of *per-file* resolutions asks for this. A rung-1
 * replay and a clean one-shot squash resolve nothing by machine — their
 * `resolved` list is empty — so they land as they always did. Everything above
 * that rung is a guess or a replayed cache entry: the 2026-08-15 landing proved
 * a stale rerere resolution can keep one side wholesale and discard the other,
 * build green, and break at runtime.
 */
export function resolutionAwaitsReview(resolve: {
  candidateCommit: string | null;
  resolved: readonly unknown[];
  reviewed: boolean;
}): boolean {
  return resolve.candidateCommit !== null && resolve.resolved.length > 0 && !resolve.reviewed;
}

/**
 * Whether a join may land, and if not, why ([P05]). Pure; exported so the Join
 * button's disable state and the controller's land path share one gate. The
 * order is commit's, field for field — turn, then the round trip, then what is
 * being landed, then the message — because the reasons map to the button's
 * disable-and-hint precedence and the two landings must not disagree.
 *
 * `outcome` passes on a clean preview, or on any state carrying a candidate
 * commit: a resolved conflict is a landable join even though its history is
 * `conflicted`. `unreviewed` sits immediately after it, because it is the same
 * question one level finer — not *is* there something to land, but *has anyone
 * looked at what the machine decided to land*.
 */
export function evaluateJoinLandGate(input: JoinLandGateInput): JoinLandGate {
  if (input.turnInProgress) return { ok: false, reason: "turn" };
  if (input.joinPhase === "pending") return { ok: false, reason: "pending" };
  const landable = input.outcome === "clean" || input.candidateCommit !== null;
  if (!landable) return { ok: false, reason: "outcome" };
  if (input.unreviewedResolution) return { ok: false, reason: "unreviewed" };
  if (input.message.trim().length === 0) return { ok: false, reason: "empty-message" };
  return { ok: true };
}

/**
 * Why the join cannot land, in the gate's own precedence — the sentence that
 * goes wherever a Join control is disabled.
 *
 * It lives beside {@link evaluateJoinLandGate} rather than in a surface,
 * because two surfaces need it (the fronted row's landing face and the
 * composer's land button) and a refusal that reads differently in two places
 * is worse than one that reads tersely in both.
 */
export function joinDisabledReason(
  reason: "turn" | "pending" | "outcome" | "unreviewed" | "empty-message",
  outcome: JoinOutcome,
): string {
  if (reason === "turn") return "Wait for the turn to finish";
  if (reason === "pending") return "Previewing…";
  // Without its own arm this falls to the outcome switch and, on a clean
  // preview, reads "This join cannot land yet" — which names nothing the user
  // can act on when all that is missing is the message.
  if (reason === "empty-message") return "Write a join message";
  // Named as the act that clears it, and it says *where*: the composer's Join
  // shows this sentence too, and the diffs it points at live on the dash row.
  if (reason === "unreviewed") return "Review what the ladder resolved first";
  switch (outcome) {
    case "unknown":
      return "Not previewed yet";
    case "previewing":
      return "Previewing…";
    case "conflicted":
      return "Resolve the conflicts first";
    case "blocked":
      return "Clear what blocks this join first";
    case "empty":
      return "Nothing to join";
    default:
      return "This join cannot land yet";
  }
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
export function joinGateFacts(input: JoinLandGateInput): Record<string, unknown> {
  return {
    turnInProgress: input.turnInProgress,
    joinPhase: input.joinPhase,
    outcome: input.outcome,
    candidateCommit: input.candidateCommit,
    unreviewedResolution: input.unreviewedResolution,
    messageLen: input.message.trim().length,
  };
}

/** The controller's subscribable snapshot — the shared half plus join's own. */
export interface JoinModeSnapshot extends LandingSnapshot {
  /** The dash being landed, or null when the mode is down. */
  dash: JoinTarget | null;
  /** The derived landing outcome ([#outcome-derivation]). */
  outcome: JoinOutcome;
  /** Conflicting paths from the preview or the aborted execute. */
  conflicts: readonly string[];
  /** What would refuse this join, from the preview's preflight (Spec S03). */
  blockers: readonly JoinBlocker[];
  /** A candidate commit from the resolution ladder, if one was built. */
  candidateCommit: string | null;
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

  /** The dash entry this mode is aimed at, read live off the changes snapshot. */
  private entry(): DashChangesetEntry | null {
    const ownerId = this.target?.ownerId;
    if (ownerId === undefined) return null;
    return (
      this.deps.changesController.getSnapshot().dashes.find((d) => d.owner_id === ownerId) ?? null
    );
  }

  // ── Derivation ─────────────────────────────────────────────────────────

  private derive(): JoinModeSnapshot {
    const { changesController, codeSessionStore } = this.deps;
    const turnInProgress = codeSessionStore.getSnapshot().canInterrupt === true;

    const verbStore = getChangesetVerbStore();
    const join = verbStore?.joinState(changesController.entryKey) ?? null;
    const joinPhase: JoinPhase = join?.phase ?? "idle";
    const conflicts = join?.conflicts ?? [];
    const blockers = join?.blockers ?? [];
    const landError = join?.error ?? null;

    // A resolved candidate outlives the join state it came from: the ladder
    // runs its own round trip, and landing it is what clears it.
    const resolve = this.target
      ? getChangesetJoinStore()?.state(changesController.projectDir, this.target.name)
      : null;
    const candidateCommit = resolve?.candidateCommit ?? null;

    const outcome = deriveJoinOutcome({
      joinPhase,
      conflicts,
      blockers,
      candidateCommit,
    });

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
    const entry = this.entry();
    const persistedMessage = entry?.draft?.message ?? "";
    const draftText =
      draftPhase === "drafting" || draftPhase === "ready"
        ? overlay?.text ?? persistedMessage
        : persistedMessage;
    const draftError = draftPhase === "error" ? overlay?.detail ?? null : null;

    const gate = evaluateJoinLandGate({
      turnInProgress,
      joinPhase,
      outcome,
      candidateCommit,
      unreviewedResolution: resolve !== null && resolve !== undefined
        ? resolutionAwaitsReview(resolve)
        : false,
      message: "x", // ignore message emptiness here (CSS-gated on data-commit-empty)
    });
    // The same sentence the fronted row's landing face shows, carried to the
    // composer's button — which is where somebody who typed `/dash-join` is
    // actually looking, and which otherwise reports a constant.
    const landBlockedReason = gate.ok
      ? null
      : joinDisabledReason(gate.reason, outcome);
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
   * document ([P01]) — and a preview fires straight away so the surface knows
   * what it is offering before the user reads it.
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
    this.preview();
  }

  /**
   * Aim the mode at a dash and preview it **without entering** — the dash
   * lane's expand. The face the row renders is this controller's snapshot, so
   * aiming is what makes one derivation serve both the lane and the composer;
   * without it the lane would need a second reading of the same stores.
   *
   * Every call previews: the lane aims on the expand gesture, and a row the
   * reader deliberately reopens should answer for the repository as it is now,
   * not as it was the first time.
   */
  aim(target: JoinTarget): void {
    this.retarget(target);
    this.preview();
  }

  /** Point the mode at a dash without asking the server anything. */
  private retarget(target: JoinTarget): void {
    if (sameTarget(this.target, target)) return;
    this.target = target;
    this.snapshot = this.derive();
    this.fire();
  }

  /** Ask the server what this join would do, touching nothing (`--preview`). */
  preview(): void {
    const target = this.target;
    if (target === null) return;
    const { changesController } = this.deps;
    getChangesetVerbStore()?.join(
      changesController.entryKey,
      changesController.projectDir,
      target.name,
      { preview: true },
    );
  }

  /**
   * Resume an interrupted teardown from the dash's join journal (Spec S04).
   * Takes its dash, because the lane can offer this on a row nothing has
   * previewed — a stale journal is exactly the state that refuses a preview's
   * every other act.
   */
  resumeTeardown(dash?: JoinTarget): void {
    if (dash !== undefined) this.retarget(dash);
    const target = this.target;
    if (target === null) return;
    const { changesController } = this.deps;
    getChangesetVerbStore()?.join(
      changesController.entryKey,
      changesController.projectDir,
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
    // never re-read from `this.target` when it runs. The host stages a landing
    // by exiting the mode, and exiting clears the target — so a staged join
    // that looked its dash up on the later beat would find nothing to land.
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
    const gate = evaluateJoinLandGate(input);
    if (!gate.ok) {
      return this.refuse(
        "gate",
        joinDisabledReason(gate.reason, input.outcome),
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
    input: JoinLandGateInput | null,
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
  private liveGateInput(message: string, target: JoinTarget): JoinLandGateInput {
    const { changesController, codeSessionStore } = this.deps;
    const snapshot = this.snapshot;
    // The review is read live, not off the snapshot: the land path fires a beat
    // after the shade dismisses, and an unreviewed resolution must not slip
    // through that gap. The dash comes from the caller for the same reason the
    // staged land carries it — by that beat the mode has already exited.
    const resolve =
      getChangesetJoinStore()?.state(changesController.projectDir, target.name) ?? null;
    return {
      turnInProgress: codeSessionStore.getSnapshot().canInterrupt === true,
      joinPhase: getChangesetVerbStore()?.joinState(changesController.entryKey).phase ?? "idle",
      outcome: snapshot.outcome,
      // From the resolve store rather than the snapshot: a mode the host has
      // already exited derives a null candidate, and a staged landing must
      // still carry the commit the ladder built.
      candidateCommit: resolve?.candidateCommit ?? null,
      unreviewedResolution: resolve !== null ? resolutionAwaitsReview(resolve) : false,
      message,
    };
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
    const gate = evaluateJoinLandGate(input);
    if (!gate.ok) {
      if (!this.active) this.enter(target);
      this.refuse("gate", joinDisabledReason(gate.reason, input.outcome), gate.reason, input);
      return;
    }
    const verbStore = getChangesetVerbStore();
    if (verbStore === null) {
      if (!this.active) this.enter(target);
      this.refuse("fault", CHANGES_SERVICE_DISCONNECTED, "no-verb-store", input);
      return;
    }
    verbStore.join(changesController.entryKey, changesController.projectDir, target.name, {
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
        getChangesetJoinStore()?.clear(changesController.projectDir, target.name);
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
 * The landing outcome, derived from the join round trip ([#outcome-derivation]).
 * Pure and exported so the lane's face and the controller agree by construction
 * rather than by two readings of the same table.
 */
export function deriveJoinOutcome(input: {
  joinPhase: JoinPhase;
  conflicts: readonly string[];
  blockers: readonly JoinBlocker[];
  candidateCommit: string | null;
}): JoinOutcome {
  // A resolved candidate outranks the conflicts it was built from — it is the
  // one state where a conflicted history is landable.
  if (input.candidateCommit !== null) return "clean";
  if (input.joinPhase === "pending") return "previewing";
  if (input.joinPhase === "idle") return "unknown";
  if (input.blockers.some((b) => b.kind === "empty")) return "empty";
  if (input.blockers.length > 0) return "blocked";
  if (input.conflicts.length > 0) return "conflicted";
  if (input.joinPhase === "error") return "blocked";
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

function sameBlockers(a: readonly JoinBlocker[], b: readonly JoinBlocker[]): boolean {
  return (
    a.length === b.length &&
    a.every((v, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        v.kind === other.kind &&
        v.detail === other.detail &&
        sameStrings(v.paths, other.paths)
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
