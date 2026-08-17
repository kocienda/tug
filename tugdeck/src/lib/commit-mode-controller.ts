/**
 * commit-mode-controller — per-card state + land path for commit mode
 * ([P03], Spec S03).
 *
 * Commit mode is the prompt entry's one secondary resting mode: ⌃⌘C /
 * `/commit` / Session ▸ Commit… turn the entry into the commit-message editor
 * (the editor holds only the message — no routing chip) while the
 * bottom-anchored changes sheet is up, and Z5 swaps to cancel / auto-message /
 * commit. This controller is the single façade the generic `TugPromptEntry`
 * reads to drive the mode — it holds the `active` flag and folds the four
 * upstream stores (code-session turn state, the changeset snapshot, the draft
 * overlay, the commit verb round-trip) into one referentially-stable snapshot,
 * plus the enter / exit / land / draft triggers.
 *
 * The mode is orthogonal to the changes sheet's visibility ([P03] revised):
 * the sheet can be up as a read-only glance with no mode active, and the
 * session card owns the coupling (⌃⌘C toggles the sheet and, only when the
 * composer is empty, the mode). This controller no longer knows about the
 * shade. The mode is transient / in-memory; the composer force-exits on
 * deactivate so the editor's own persistence only ever sees the prompt draft.
 * The commit message itself is durable in the changeset draft store (the
 * debounced `persistMessage` write), so re-entering the mode resumes it.
 *
 * @module lib/commit-mode-controller
 */

import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { LandOutcome, LandingMode, LandingRefusal, LandingSnapshot } from "@/lib/landing-mode";
import { CHANGES_SERVICE_DISCONNECTED, sameRefusal } from "@/lib/landing-mode";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { sendLandingReceipt } from "@/lib/landing-press-receipt";
import {
  getChangesetVerbStore,
  type CommitPhase,
} from "@/lib/changeset-verb-store";
import {
  getChangesetDraftStore,
  type DraftOverlayPhase,
} from "@/lib/changeset-draft-store";

/** Inputs to the pure commit land-gate. */
export interface CommitLandGateInput {
  /** A Claude turn is in flight (`canInterrupt`) — durable mutations wait. */
  turnInProgress: boolean;
  /** The current commit round-trip phase for this entry. */
  commitPhase: CommitPhase;
  /** The trimmed commit message. */
  message: string;
  /** The number of files the commit would land. */
  fileCount: number;
}

/** The land-gate verdict — `ok`, or the first failing reason. */
export type CommitLandGate =
  | { ok: true }
  | { ok: false; reason: "turn" | "pending" | "empty-changeset" | "empty-message" };

/**
 * Whether a commit may land, and if not, why ([P04]/[P09]/[P11]). Pure;
 * exported so the composer's Commit-disable state and the controller's land
 * path share one gate. Order matters — the reasons map to the Commit button's
 * disable + hint precedence (turn gate first).
 */
export function evaluateCommitLandGate(input: CommitLandGateInput): CommitLandGate {
  if (input.turnInProgress) return { ok: false, reason: "turn" };
  if (input.commitPhase === "pending") return { ok: false, reason: "pending" };
  if (input.fileCount === 0) return { ok: false, reason: "empty-changeset" };
  if (input.message.trim().length === 0) return { ok: false, reason: "empty-message" };
  return { ok: true };
}

/**
 * Why the commit cannot land, in the gate's own precedence — commit's half of
 * the same contract `joinDisabledReason` fills for join. A disabled land button
 * says what would enable it.
 */
export function commitDisabledReason(
  reason: "turn" | "pending" | "empty-changeset" | "empty-message",
): string {
  switch (reason) {
    case "turn":
      return "Wait for the turn to finish";
    case "pending":
      return "Committing…";
    case "empty-changeset":
      return "Nothing to commit — this session has claimed no changes";
    default:
      return "Write a commit message";
  }
}

/**
 * The gate's inputs, reduced to what may be written down ([L31]) — commit's
 * half of the shape `joinGateFacts` produces for join. The message is carried
 * as a length: the draft's words are the user's and do not belong in a log.
 */
export function commitGateFacts(input: CommitLandGateInput): Record<string, unknown> {
  return {
    turnInProgress: input.turnInProgress,
    commitPhase: input.commitPhase,
    fileCount: input.fileCount,
    messageLen: input.message.trim().length,
  };
}

/**
 * The controller's subscribable snapshot — everything the composer + Z5 read.
 * The shared half is {@link LandingSnapshot} ([P01]); the fields below it are
 * commit's own.
 */
export interface CommitModeSnapshot extends LandingSnapshot {
  /** Number of files the commit would land (0 ⇒ the "No changes" state). */
  fileCount: number;
  /**
   * Dirty files this session could claim into the commit — the unattributed +
   * orphaned buckets. When `fileCount` is 0 but this is positive, commit mode
   * points at the claimable work ("claim N") instead of a dead-end "0 files".
   */
  claimableCount: number;
  /** Commit round-trip phase — `"pending"` drives the Committing… button label. */
  landPhase: CommitPhase;
}

export interface CommitModeControllerDeps {
  changesController: ChangesRouteController;
  codeSessionStore: CodeSessionStore;
}

export class CommitModeController implements LandingMode {
  /** The landing this mode performs ([P01]) — the composer's labels read it. */
  readonly kind = "commit" as const;

  private readonly deps: CommitModeControllerDeps;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[] = [];

  private active = false;
  private seedMessage: string | null = null;
  private snapshot: CommitModeSnapshot;
  private landHook: ((runCommit: () => void) => void) | null = null;
  private messageProvider: (() => string) | null = null;
  private landRefusal: LandingRefusal | null = null;
  private refusalSeq = 0;

  constructor(deps: CommitModeControllerDeps) {
    this.deps = deps;
    this.snapshot = this.derive();

    // Recompute the snapshot whenever any upstream store moves.
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

  getSnapshot = (): CommitModeSnapshot => this.snapshot;

  /**
   * Install (or clear with `null`) the host's land orchestrator ([P03]). When
   * set, {@link land} hands it a `runCommit` callback instead of committing
   * inline; the host stages the commit behind the Changes shade's dismissal so
   * the transcript receipt lands on a clean beat after the panel is gone. With
   * no hook the commit fires immediately (the default the unit tests exercise).
   */
  setLandHook(hook: ((runCommit: () => void) => void) | null): void {
    this.landHook = hook;
  }

  // ── Derivation ─────────────────────────────────────────────────────────

  private derive(): CommitModeSnapshot {
    const { changesController, codeSessionStore } = this.deps;
    const changes = changesController.getSnapshot();
    const fileCount = changes.committedPaths.size;
    const claimableCount = changes.unattributed.length + changes.orphaned.length;
    const turnInProgress = codeSessionStore.getSnapshot().canInterrupt === true;

    const verbStore = getChangesetVerbStore();
    const commit = verbStore?.commitState(changesController.entryKey) ?? null;
    const commitPhase: CommitPhase = commit?.phase ?? "idle";
    const commitError = commit?.error ?? null;

    const draftStore = getChangesetDraftStore();
    // Every draft read and write in this controller keys on `workspaceKey` —
    // the registry's canonical spelling, which the backend stamps on every
    // draft frame ([L29]). `changesController.projectDir` is the raw path the
    // card was bound with and can be any spelling of the same directory; it is
    // not an identity and is never used as one here.
    const overlay =
      draftStore?.overlay(
        changesController.workspaceKey,
        "session",
        changesController.tugSessionId,
      ) ?? null;
    const draftPhase: DraftOverlayPhase = overlay?.phase ?? "idle";
    const persistedMessage = changes.entry?.draft?.message ?? "";
    // While the scribe streams, the overlay text is the live document; once it
    // settles the persisted message is the source of truth.
    const draftText =
      draftPhase === "drafting" || draftPhase === "ready"
        ? overlay?.text ?? persistedMessage
        : persistedMessage;
    const draftError = draftPhase === "error" ? overlay?.detail ?? null : null;

    const gate = evaluateCommitLandGate({
      turnInProgress,
      commitPhase,
      message: "x", // ignore message emptiness here (CSS-gated on data-empty)
      fileCount,
    });
    // The menu's gate reads the composer live, through the same provider
    // `leave` persists with. Only meaningful inside the mode — outside it the
    // provider is reading the prompt draft, which is not a commit message.
    const messagePresent =
      this.active && (this.messageProvider?.() ?? "").trim().length > 0;

    return {
      active: this.active,
      seedMessage: this.seedMessage,
      canLandIgnoringMessage: gate.ok,
      landBlockedReason: gate.ok ? null : commitDisabledReason(gate.reason),
      landReady: this.active && gate.ok && messagePresent,
      fileCount,
      claimableCount,
      draftPhase,
      draftText,
      persistedMessage,
      edited: changes.entry?.draft?.edited === true,
      landPhase: commitPhase,
      landError: commitError,
      landRefusal: this.landRefusal,
      draftError,
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
   * Enter commit mode (mark it active). A `/commit <message>` seed is
   * written into the changeset draft as an edited draft so [P05] semantics
   * apply and the composer seeds its message editor from it. The session
   * card ensures the changes sheet is up.
   */
  enter(seedMessage?: string): void {
    const seed = seedMessage?.trim() ?? "";
    if (seed.length > 0) {
      getChangesetDraftStore()?.setDraft(
        this.deps.changesController.workspaceKey,
        "session",
        this.deps.changesController.tugSessionId,
        { message: seed, edited: true },
      );
    }
    this.seedMessage = seed.length > 0 ? seed : null;
    this.active = true;
    this.snapshot = this.derive();
    this.fire();
  }

  /**
   * Install the live read of the composer's message, so the controller can
   * persist a typed draft on its own when the user leaves the route by a door
   * that isn't the composer's ({@link leave}). The composer owns the document,
   * so only it can supply this; `null` uninstalls on unmount.
   */
  setMessageProvider(read: (() => string) | null): void {
    this.messageProvider = read;
    this.recompute();
  }

  /**
   * The composer telling the controller its message crossed the empty ↔
   * non-empty line, so {@link CommitModeSnapshot.landReady} can move. Called
   * from the same substrate update listener that writes `data-commit-empty`;
   * `recompute` fires only when the snapshot actually differs, so the keystrokes
   * between the edges cost a comparison and nothing else ([L22]).
   */
  notifyMessageChanged(): void {
    this.recompute();
  }

  /**
   * The user leaving the route: persist whatever is typed so coming back
   * resumes it, then exit. Distinct from {@link exit}, which is the bare
   * state flip the land path uses *after* clearing the draft — persisting
   * there would resurrect a message that has already been committed.
   */
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
    this.landRefusal = null;
    this.snapshot = this.derive();
    this.fire();
  }

  /** Persist a message edit into the changeset draft ([P05]; `edited` pin rides). */
  persistMessage(text: string): void {
    getChangesetDraftStore()?.setDraft(
      this.deps.changesController.workspaceKey,
      "session",
      this.deps.changesController.tugSessionId,
      { message: text, edited: true },
    );
  }

  /** Request an auto-message draft ([P06]); `force` is the confirmed Regenerate. */
  requestDraft(force = false): void {
    this.deps.changesController.requestDraft(force);
  }

  /**
   * Cancel an in-flight auto-message draft ([P06]) — the Z5 cancel button,
   * Escape, or Cmd-. while the scribe streams. Aborts only the draft's scribe
   * child; the session's turn is untouched. A no-op when nothing is drafting.
   */
  cancelDraft(): void {
    const { changesController } = this.deps;
    getChangesetDraftStore()?.cancelDraft(
      changesController.workspaceKey,
      "session",
      changesController.tugSessionId,
    );
  }

  /**
   * Land the commit ([P09]): re-check the gates against live state, then either
   * hand the commit to the host's land-hook (staged behind the shade dismissal)
   * or fire it inline. The up-front gate keeps an empty message / running turn
   * from ever dismissing the shade. A refusal is surfaced here and reported by
   * type ([L31]) — never a silent no-op.
   */
  land(message: string): LandOutcome {
    const text = message.trim();
    const input = this.landGateInput(text);
    const gate = evaluateCommitLandGate(input);
    if (!gate.ok) {
      return this.refuse("gate", commitDisabledReason(gate.reason), gate.reason, input);
    }
    this.clearRefusal();
    sendLandingReceipt({ kind: "commit", verdict: "ok", gate: commitGateFacts(input) });
    const runCommit = () => this.performCommit(text);
    if (this.landHook !== null) {
      this.landHook(runCommit);
      return { kind: "staged" };
    }
    runCommit();
    return { kind: "fired" };
  }

  /**
   * The gate's inputs against live state. Built separately from the verdict so
   * a refusal can record exactly what it judged rather than a reconstruction.
   */
  private landGateInput(message: string): CommitLandGateInput {
    const { changesController, codeSessionStore } = this.deps;
    return {
      turnInProgress: codeSessionStore.getSnapshot().canInterrupt === true,
      commitPhase:
        getChangesetVerbStore()?.commitState(changesController.entryKey).phase ?? "idle",
      message,
      fileCount: changesController.getSnapshot().committedPaths.size,
    };
  }

  /**
   * Publish and log a refused land press ([L31]) — commit's half of the funnel
   * join's `refuse` fills. One exit from a refusal, writing to the snapshot a
   * notice surface subscribes to, the dev log, and the caller's return value.
   */
  private refuse(
    kind: "gate" | "fault",
    sentence: string,
    reason: string,
    input: CommitLandGateInput | null,
  ): LandOutcome {
    this.refusalSeq += 1;
    this.landRefusal = { sentence, kind, seq: this.refusalSeq };
    const gate = input !== null ? commitGateFacts(input) : {};
    tugDevLogStore.warn("landing", `commit land refused: ${sentence}`, { kind, ...gate });
    sendLandingReceipt({ kind: "commit", verdict: "refused", reason, sentence, gate });
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
   * Send the commit and settle the round-trip ([P09]): on success clear the
   * draft and exit; on failure surface `commitError` — re-entering the mode
   * (and its shade) if the staged path already dismissed it. Re-checks the gate
   * because the staged path fires a beat later, after the shade animates out,
   * so live state may have drifted (a turn started, the changeset emptied).
   */
  private performCommit(text: string): void {
    const { changesController } = this.deps;
    const verbStore = getChangesetVerbStore();
    const input = this.landGateInput(text);
    const gate = evaluateCommitLandGate(input);
    if (!gate.ok) {
      if (!this.active) this.enter();
      this.refuse("gate", commitDisabledReason(gate.reason), gate.reason, input);
      return;
    }
    changesController.commit(text);
    if (verbStore === null) {
      // The commit went out with nothing to settle it: no phase to read, so the
      // mode would sit in a landing that never resolves. That is a fault, and
      // the user needs to be told they are stranded rather than left waiting.
      if (!this.active) this.enter();
      this.refuse("fault", CHANGES_SERVICE_DISCONNECTED, "no-verb-store", input);
      return;
    }
    const unsubscribe = verbStore.subscribe(() => {
      const phase = verbStore.commitState(changesController.entryKey).phase;
      if (phase === "pending") return;
      unsubscribe();
      if (phase === "done") {
        getChangesetDraftStore()?.setDraft(
          changesController.workspaceKey,
          "session",
          changesController.tugSessionId,
          { clear: true },
        );
        this.exit();
      } else if (!this.active) {
        // Failed after the staged dismissal already left the mode — bring it
        // (and the shade) back so the error surfaces where the user acted.
        this.enter();
      }
    });
  }

  dispose(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.listeners.clear();
  }
}

/** Field-by-field snapshot equality so `getSnapshot` stays referentially stable. */
function snapshotsEqual(a: CommitModeSnapshot, b: CommitModeSnapshot): boolean {
  return (
    a.active === b.active &&
    a.seedMessage === b.seedMessage &&
    a.canLandIgnoringMessage === b.canLandIgnoringMessage &&
    a.landBlockedReason === b.landBlockedReason &&
    a.landReady === b.landReady &&
    a.fileCount === b.fileCount &&
    a.claimableCount === b.claimableCount &&
    a.draftPhase === b.draftPhase &&
    a.draftText === b.draftText &&
    a.persistedMessage === b.persistedMessage &&
    a.edited === b.edited &&
    a.landPhase === b.landPhase &&
    a.landError === b.landError &&
    sameRefusal(a.landRefusal, b.landRefusal) &&
    a.draftError === b.draftError
  );
}
