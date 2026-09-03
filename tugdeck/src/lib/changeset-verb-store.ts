/**
 * Changeset card CONTROL verbs — app-level round-trip store.
 *
 * Two verbs ride here. `changeset_git_init { project_dir }` is the non-repo
 * "Initialize git" affordance: the deck sends the CONTROL request and
 * tugcast's supervisor replies `changeset_git_init_ok { project_dir }` /
 * `changeset_git_init_err { project_dir, detail }` (Spec S07). On success the
 * server fires the aggregate recompute, so the project's section self-heals to
 * a clean repo and drops its Init affordance — there is no client-side flip;
 * this store only tracks the in-flight request and any error to surface.
 *
 * `changeset_commit { project_dir, files, message }` commits exactly the
 * card-selected files (Spec S03, [P15]); the reply carries the new HEAD sha
 * and the numstat receipt (`_ok {sha, receipt}`) or the git stderr detail
 * (`_err {detail}`). Commit state is keyed by the initiating card *entry*
 * (the response only names the project, so the store correlates through a
 * project→entry in-flight map).
 *
 * `changeset_claim { project_dir, session_id, files }` promotes hinted files
 * into a session's changeset ([D120]); the reply carries the count actually
 * written (`_ok {claimed}`) or a guard's refusal (`_err {detail}`). Success
 * shows itself — the rows migrate on the next aggregate recompute — but a
 * refusal has no other surface, so the round trip is tracked and keyed by the
 * initiating card entry the way commit is.
 *
 * `changeset_disclaim { project_dir, session_id, files }` is claim's inverse:
 * the session renounces the listed files and they fall to another live owner or
 * back to unattributed. The reply carries the ledger rows deleted
 * (`_ok {disclaimed}`) or a guard's refusal (`_err {detail}`), and is tracked
 * and keyed exactly as claim is.
 *
 * `changeset_replay { project_dir, arc, session_id? }` replays an arc's rounds
 * onto its base branch's current tip. Its reply carries the server's own
 * outcome word plus that outcome's fields (`_ok {outcome, …}`) or a guard's
 * refusal (`_err {detail}`). Three of the five outcomes — `current`,
 * `deferred`, `conflicted` — move nothing an arc row can show, so the outcome
 * is also reported to {@link arcReplayOutcomeStore}, which the card's notice
 * controller turns into a pane bulletin. Without that a press whose answer was
 * "I declined, and here is why" would be indistinguishable from a dead button.
 *
 * Git-init state is keyed by `project_dir` (several non-repo projects can be
 * open at once). Consumed via {@link useChangesetGitInit} /
 * {@link useChangesetCommit} / {@link useChangesetClaim} /
 * {@link useChangesetDisclaim}; attached once at app boot with
 * {@link attachChangesetVerbStore}.
 *
 * Laws: [L02] external state enters React through useSyncExternalStore only.
 *
 * @module lib/changeset-verb-store
 */

import { useSyncExternalStore } from "react";

import type { TugConnection } from "../connection";
import { FeedId } from "../protocol";
import {
  arcReplayOutcomeStore,
  type ArcReplayOutcomeWord,
} from "./arc-replay-outcome-store";
import { gitLogStore } from "./git-log-store";

export type GitInitPhase = "idle" | "pending" | "error";

export interface GitInitState {
  phase: GitInitPhase;
  error: string | null;
}

/** Shared idle state — a stable reference so `useSyncExternalStore` is quiet. */
const IDLE: GitInitState = Object.freeze({ phase: "idle", error: null });

export type CommitPhase = "idle" | "pending" | "error" | "done";

/** One commit round trip's state, keyed by the initiating card entry. */
export interface CommitState {
  phase: CommitPhase;
  error: string | null;
  /** New HEAD sha when `phase === "done"`. */
  sha: string | null;
  /** `git show --numstat --format= HEAD` receipt when `phase === "done"`. */
  receipt: string | null;
  /** Server-formatted standard commit summary (S02) when `phase === "done"`. */
  summary: string | null;
  /**
   * The shell-ledger row the server persisted this landing's receipt as, when
   * it persisted one. The live transcript row is painted under that identity,
   * so a later restore of the same ledger row settles it in place instead of
   * seating a second copy of one landing. `null` when nothing was persisted
   * (no session id, no ledger, a ledger error) — the row then takes a local
   * identity and the pre-existing duplication risk stands for that case alone.
   */
  receiptId: number | null;
}

const COMMIT_IDLE: CommitState = Object.freeze({
  phase: "idle",
  error: null,
  sha: null,
  receipt: null,
  summary: null,
  receiptId: null,
});

/**
 * One arc-landing round trip's state, keyed by the initiating card entry.
 *
 * This is the *execute* round trip and nothing else. What a landing would do —
 * blockers, conflicts, the resolved candidate — arrives on the arc's feed
 * entry as server-owned state, so the card asks nothing and the phases here
 * describe only a landing the user pressed for.
 *
 * `pending` is an execute in flight; `done` means a commit was made and the
 * entry will drop on the next aggregate recompute; `conflict` means the join
 * cleanly aborted on the listed paths; `error` carries a verb-level refusal
 * (e.g. "Nothing to join").
 */
export type JoinPhase = "idle" | "pending" | "done" | "conflict" | "error";

export interface JoinState {
  phase: JoinPhase;
  error: string | null;
  /** Conflicting paths an execute aborted on; empty otherwise. */
  conflicts: readonly string[];
  /** The landing commit sha when `phase === "done"`. */
  commitHash: string | null;
  /** The server-formatted landing summary (Spec S01) when `phase === "done"`. */
  summary: string | null;
  /** The persisted receipt's ledger row id — see {@link CommitState.receiptId}. */
  receiptId: number | null;
}

const JOIN_IDLE: JoinState = Object.freeze({
  phase: "idle",
  error: null,
  conflicts: Object.freeze([]) as readonly string[],
  commitHash: null,
  summary: null,
  receiptId: null,
});

export type ClaimPhase = "idle" | "pending" | "error" | "done";

/**
 * One claim round trip's state, keyed by the initiating card entry.
 *
 * `claimed` is the server's receipt — how many of the requested paths it wrote
 * a proof row for. The server writes the whole gesture as one transactional
 * batch, so this is the full count or zero; the shortfall rule stays as the
 * guard that catches any other way a claim could silently do nothing (a path
 * skipped before the batch for landing outside the repo, most of all).
 */
export interface ClaimState {
  phase: ClaimPhase;
  error: string | null;
  /** Paths the server reports it claimed; null until a reply lands. */
  claimed: number | null;
  /** Paths this round trip asked for; null when idle. */
  requested: number | null;
}

const CLAIM_IDLE: ClaimState = Object.freeze({
  phase: "idle",
  error: null,
  claimed: null,
  requested: null,
});

export type DisclaimPhase = "idle" | "pending" | "error" | "done";

/**
 * One disclaim round trip's state, keyed by the initiating card entry — the
 * inverse of {@link ClaimState}.
 *
 * `disclaimed` is the server's receipt: the number of ledger **rows** deleted,
 * not paths. One path can carry several rows (a proof row and a bracket row
 * for the same file), and a path the session no longer holds carries none, so
 * there is no shortfall rule to run against `requested` — a count under the
 * request is an ordinary outcome, not a silent failure. `changeset_disclaim_err`
 * is the only failure signal, and it is explicit.
 */
export interface DisclaimState {
  phase: DisclaimPhase;
  error: string | null;
  /** Ledger rows the server reports it deleted; null until a reply lands. */
  disclaimed: number | null;
  /** Paths this round trip asked for; null when idle. */
  requested: number | null;
}

const DISCLAIM_IDLE: DisclaimState = Object.freeze({
  phase: "idle",
  error: null,
  disclaimed: null,
  requested: null,
});

/**
 * One arc-discard round trip's state, keyed by the initiating card entry.
 *
 * `done` is a terminal phase rather than a return to idle: the discard's
 * receipt hangs off that edge, and pending → idle would be indistinguishable
 * from a manual clear. `clearDiscard` is still the way back to idle.
 */
export type DiscardPhase = "idle" | "pending" | "error" | "done";

export interface DiscardState {
  phase: DiscardPhase;
  error: string | null;
  /** The server-formatted discard summary (Spec S02) when `phase === "done"`. */
  summary: string | null;
  /** The persisted receipt's ledger row id — see {@link CommitState.receiptId}. */
  receiptId: number | null;
}

const DISCARD_IDLE: DiscardState = Object.freeze({
  phase: "idle",
  error: null,
  summary: null,
  receiptId: null,
});

/**
 * An arc's terminal receipt, as the server announced it ([P12]).
 *
 * Not a round-trip state and deliberately not shaped like one: it has no
 * phases, because nothing here asked for it and nothing is waiting on it. The
 * arc ended on a server tick, the durable row was written before this frame
 * was sent, and this is the announcement that lets the card paint its live
 * copy under the same row identity instead of waiting for a restore.
 */
export interface ArcReceipt {
  /** The arc whose arc ended. */
  arc: string;
  /** The server-formatted receipt text — the one source both copies read. */
  summary: string;
  /** The persisted ledger row's id — see {@link CommitState.receiptId}. */
  receiptId: number | null;
}

/**
 * One announced arc ledger gesture — a step opened, closed, withdrawn, reset
 * or reopened, a run declared, an arc created, a round committed, a mark made.
 *
 * Unlike {@link ArcReceipt} these are a **sequence**: a run makes dozens, and
 * every one is meant to be read. `seq` is this store's own monotonic counter,
 * which is what lets a card append only the notes that arrived after it
 * started watching — a receipt id cannot serve, because the server writes
 * `null` for it whenever no shell ledger is configured.
 */
export interface ArcNote {
  /** The verb as it was typed, rendered after the row's `$` sigil. */
  command: string;
  /** The one sentence announcing what the gesture did. */
  note: string;
  /** The persisted ledger row's id — see {@link CommitState.receiptId}. */
  receiptId: number | null;
  /** This store's arrival order. Strictly increasing, never reused. */
  seq: number;
}

/**
 * One arc-replay round trip's state, keyed by the initiating card entry.
 *
 * `outcome` is the server's own word — `current`, `replayed`, `recorded`,
 * `deferred`, `conflicted` — and `detail` the text that goes with a `deferred`.
 * Three of those five move nothing the row can show, which is why the outcome
 * also reports to {@link arcReplayOutcomeStore} for the pane bulletin.
 */
export type ReplayPhase = "idle" | "pending" | "error" | "done";

export interface ReplayState {
  phase: ReplayPhase;
  /** The server's outcome word when `phase === "done"`. */
  outcome: string | null;
  /** A `deferred` outcome's detail. */
  detail: string | null;
  error: string | null;
}

const REPLAY_IDLE: ReplayState = Object.freeze({
  phase: "idle",
  outcome: null,
  detail: null,
  error: null,
});

/**
 * Correlation key for a join/discard reply.
 *
 * The workspace's canonical key ([L29]), never a raw binding path — the server
 * echoes `project_dir` back exactly as it was sent, so keying on what was sent
 * is what makes the correlation exact rather than approximately right.
 */
function verbKey(workspaceKey: string, arc: string): string {
  return `${workspaceKey}\x00${arc}`;
}

/**
 * The `receipt_id` a landing's `_ok` frame carries — the shell-ledger row the
 * server persisted the receipt as. Absent (an older tugcast) or non-numeric
 * reads as `null`, which is the same answer as "nothing was persisted".
 */
function receiptIdOf(body: Record<string, unknown>): number | null {
  return typeof body.receipt_id === "number" ? body.receipt_id : null;
}

/**
 * How many announced arc gestures this store keeps per session.
 *
 * The transcript is where they live; this is only the hand-off between the
 * frame arriving and each card's next `onChange`, so a bound well above any
 * one run's burst is generous.
 */
const ARC_NOTE_CAP = 500;

/** The shared empty answer, so a session with no notes allocates nothing. */
const EMPTY_ARC_NOTES: readonly ArcNote[] = Object.freeze([]);

export interface JoinArgs {
  preview: boolean;
  strategy?: "squash" | "merge" | "rebase";
  message?: string;
  /** Land a pre-resolved candidate commit from the resolution ladder ([P31]). */
  candidate?: string;
  /** Resume an interrupted teardown from the journal (Spec S04). */
  continueJoin?: boolean;
  /** The card's tug session id, so the landing leaves a receipt ([P06]). */
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The detail for a claim the server accepted but under-delivered on. */
function claimShortfallDetail(claimed: number, requested: number): string {
  const files = requested === 1 ? "file" : "files";
  if (claimed === 0) {
    return `The ledger refused all ${requested} ${files}. Attribution may be degraded — check the log and restart Tug if it persists.`;
  }
  return `Only ${claimed} of ${requested} ${files} were claimed; the ledger refused the rest.`;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export class ChangesetVerbStore {
  private readonly _connection: TugConnection;
  private readonly _unsubscribe: () => void;
  private readonly _listeners = new Set<() => void>();
  /** project_dir → git-init request state. Absent ⇒ idle. */
  private _gitInit = new Map<string, GitInitState>();
  /** entry key → commit round-trip state. Absent ⇒ idle. */
  private _commits = new Map<string, CommitState>();
  /** project_dir → the entry key whose commit is in flight. */
  private _commitInflight = new Map<string, string>();
  /** entry key → join round-trip state. Absent ⇒ idle. */
  private _joins = new Map<string, JoinState>();
  /** `verbKey(project_dir, arc)` → the entry key whose join is in flight. */
  private _joinInflight = new Map<string, string>();
  /** entry key → claim round-trip state. Absent ⇒ idle. */
  private _claims = new Map<string, ClaimState>();
  /** project_dir → the entry key whose claim is in flight. */
  private _claimInflight = new Map<string, string>();
  /** entry key → disclaim round-trip state. Absent ⇒ idle. */
  private _disclaims = new Map<string, DisclaimState>();
  /** project_dir → the entry key whose disclaim is in flight. */
  private _disclaimInflight = new Map<string, string>();
  /** entry key → discard round-trip state. Absent ⇒ idle. */
  private _discards = new Map<string, DiscardState>();
  /** `verbKey(project_dir, arc)` → the entry key whose discard is in flight. */
  private _discardInflight = new Map<string, string>();
  /** entry key → replay round-trip state. Absent ⇒ idle. */
  private _replays = new Map<string, ReplayState>();
  /** `verbKey(project_dir, arc)` → the entry key whose replay is in flight. */
  private _replayInflight = new Map<string, string>();
  /** tug session id → the newest arc receipt the server announced for it. */
  private _arcReceipts = new Map<string, ArcReceipt>();
  /** tug session id → the arc gestures announced for it, in arrival order. */
  private _arcNotes = new Map<string, ArcNote[]>();
  /** The monotonic arrival counter behind {@link ArcNote.seq}. */
  private _arcNoteSeq = 0;
  private readonly _decoder = new TextDecoder();

  constructor(connection: TugConnection) {
    this._connection = connection;
    this._unsubscribe = connection.onFrame(FeedId.CONTROL, (payload) =>
      this._onControl(payload),
    );
  }

  private _onControl(payload: Uint8Array): void {
    let body: unknown;
    try {
      body = JSON.parse(this._decoder.decode(payload));
    } catch {
      return;
    }
    if (!isRecord(body) || typeof body.action !== "string") return;
    // Whatever this client put in `project_dir`: the server echoes the field
    // back verbatim, so every correlation below is against what was sent rather
    // than against a spelling the server chose. Each arc/join send now carries
    // the workspace's canonical key ([L29]), which is what makes it exact.
    const sentDir = typeof body.project_dir === "string" ? body.project_dir : null;
    if (sentDir === null) return;

    if (body.action === "changeset_git_init_ok") {
      // Success: the aggregate recompute (server bump) removes this project's
      // non-repo section shortly. Clear the in-flight state meanwhile.
      this._setGitInit(sentDir, IDLE);
      // The History shade rides a separate GIT_LOG singleton: a fresh `git
      // init` leaves an unborn HEAD that moves no HEAD, so no GIT_HEAD signal
      // arrives to shake its cached `no_repo` snapshot. Nudge it directly so
      // History flips off "Not a git repository" in lockstep with Changes.
      gitLogStore()?.onRepoInitialized(sentDir);
    } else if (body.action === "changeset_git_init_err") {
      const detail = typeof body.detail === "string" ? body.detail : "git init failed";
      this._setGitInit(sentDir, { phase: "error", error: detail });
    } else if (body.action === "changeset_commit_ok") {
      const entryKey = this._commitInflight.get(sentDir);
      if (entryKey === undefined) return;
      this._commitInflight.delete(sentDir);
      this._setCommit(entryKey, {
        phase: "done",
        error: null,
        sha: typeof body.sha === "string" ? body.sha : null,
        receipt: typeof body.receipt === "string" ? body.receipt : null,
        summary: typeof body.summary === "string" ? body.summary : null,
        receiptId: receiptIdOf(body),
      });
    } else if (body.action === "changeset_commit_err") {
      const entryKey = this._commitInflight.get(sentDir);
      if (entryKey === undefined) return;
      this._commitInflight.delete(sentDir);
      const detail = typeof body.detail === "string" ? body.detail : "git commit failed";
      this._setCommit(entryKey, {
        phase: "error",
        error: detail,
        sha: null,
        receipt: null,
        summary: null,
        receiptId: null,
      });
    } else if (body.action === "changeset_claim_ok") {
      const entryKey = this._claimInflight.get(sentDir);
      if (entryKey === undefined) return;
      this._claimInflight.delete(sentDir);
      const requested = this._claims.get(entryKey)?.requested ?? null;
      const claimed = typeof body.claimed === "number" ? body.claimed : 0;
      // A shortfall is a failure with a receipt attached, not a success.
      const shortfall = requested !== null && claimed < requested;
      // The server's honesty check ([D120]): a claim whose rows landed but
      // whose claimant it cannot vouch for warns instead of handing back a
      // green count that undoes itself. Surfaced through the same error
      // path — a claim that will not hold is not a success.
      const warning = typeof body.warning === "string" ? body.warning : null;
      this._setClaim(entryKey, {
        phase: shortfall || warning !== null ? "error" : "done",
        error: shortfall ? claimShortfallDetail(claimed, requested) : warning,
        claimed,
        requested,
      });
    } else if (body.action === "changeset_claim_err") {
      const entryKey = this._claimInflight.get(sentDir);
      if (entryKey === undefined) return;
      this._claimInflight.delete(sentDir);
      const requested = this._claims.get(entryKey)?.requested ?? null;
      const detail = typeof body.detail === "string" ? body.detail : "claim failed";
      this._setClaim(entryKey, {
        phase: "error",
        error: detail,
        claimed: 0,
        requested,
      });
    } else if (body.action === "changeset_disclaim_ok") {
      const entryKey = this._disclaimInflight.get(sentDir);
      if (entryKey === undefined) return;
      this._disclaimInflight.delete(sentDir);
      this._setDisclaim(entryKey, {
        phase: "done",
        error: null,
        disclaimed: typeof body.disclaimed === "number" ? body.disclaimed : 0,
        requested: this._disclaims.get(entryKey)?.requested ?? null,
      });
    } else if (body.action === "changeset_disclaim_err") {
      const entryKey = this._disclaimInflight.get(sentDir);
      if (entryKey === undefined) return;
      this._disclaimInflight.delete(sentDir);
      this._setDisclaim(entryKey, {
        phase: "error",
        error: typeof body.detail === "string" ? body.detail : "disclaim failed",
        disclaimed: 0,
        requested: this._disclaims.get(entryKey)?.requested ?? null,
      });
    } else if (body.action === "arc_receipt") {
      // The one unsolicited receipt in this store. Every other state here is
      // half of a round-trip this client started; an arc finishes on a server
      // tick with nobody waiting, so there is no in-flight entry to settle and
      // the frame is simply recorded under the session it names. The server
      // has already written the durable row — this is what lets the card paint
      // its copy now instead of at the next restore.
      const session = typeof body.tug_session_id === "string" ? body.tug_session_id : "";
      const summary = typeof body.summary === "string" ? body.summary : "";
      if (session.length === 0 || summary.length === 0) return;
      this._arcReceipts.set(session, {
        arc: typeof body.arc === "string" ? body.arc : "",
        summary,
        receiptId: receiptIdOf(body),
      });
      for (const listener of [...this._listeners]) listener();
    } else if (body.action === "arc_note") {
      // The run's quiet lines. Unsolicited like `arc_receipt` and for the same
      // reason — a `tugtool arc` verb is a short-lived process with no client
      // waiting — but a sequence rather than a single value, because every one
      // of a run's gestures is meant to be read. The server has already
      // persisted each row, so this is the live copy; a card that mounts later
      // gets them from its restore.
      const session = typeof body.tug_session_id === "string" ? body.tug_session_id : "";
      const note = typeof body.note === "string" ? body.note : "";
      if (session.length === 0 || note.length === 0) return;
      const notes = this._arcNotes.get(session) ?? [];
      this._arcNoteSeq += 1;
      notes.push({
        command: typeof body.command === "string" ? body.command : "arc",
        note,
        receiptId: receiptIdOf(body),
        seq: this._arcNoteSeq,
      });
      // A long run makes hundreds; the transcript keeps them, this does not
      // need to. Trimming the head cannot lose a row a card still owed,
      // because a card consumes on every frame.
      if (notes.length > ARC_NOTE_CAP) notes.splice(0, notes.length - ARC_NOTE_CAP);
      this._arcNotes.set(session, notes);
      for (const listener of [...this._listeners]) listener();
    } else if (body.action === "changeset_join_ok") {
      const arc = typeof body.arc === "string" ? body.arc : null;
      if (arc === null) return;
      const key = verbKey(sentDir, arc);
      const entryKey = this._joinInflight.get(key);
      if (entryKey === undefined) return;
      this._joinInflight.delete(key);
      const conflicts = readStringArray(body.conflicts);
      const commitHash = typeof body.commit_hash === "string" ? body.commit_hash : null;
      if (body.previewed === true) {
        // Previews are the CLI's now. The arc's feed entry carries what a
        // landing would do, so a preview reply reaching this store describes a
        // question the card did not ask — it settles back to idle rather than
        // becoming a phase that outranks the feed's answer.
        this._setJoin(entryKey, JOIN_IDLE);
      } else if (commitHash !== null) {
        this._setJoin(entryKey, {
          phase: "done",
          error: null,
          conflicts: [],
          commitHash,
          // The landing's receipt, formatted by the server so the durable row
          // and the live one cannot drift (Spec S01) — and keyed by the server
          // so they are one transcript turn rather than two.
          summary: typeof body.summary === "string" ? body.summary : null,
          receiptId: receiptIdOf(body),
        });
      } else {
        // A real join that cleanly aborted on conflicts.
        this._setJoin(entryKey, {
          phase: "conflict",
          error: null,
          conflicts,
          commitHash: null,
          summary: null,
          receiptId: null,
        });
      }
    } else if (body.action === "changeset_join_err") {
      const arc = typeof body.arc === "string" ? body.arc : null;
      if (arc === null) return;
      const key = verbKey(sentDir, arc);
      const entryKey = this._joinInflight.get(key);
      if (entryKey === undefined) return;
      this._joinInflight.delete(key);
      const detail = typeof body.detail === "string" ? body.detail : "join failed";
      this._setJoin(entryKey, {
        phase: "error",
        error: detail,
        conflicts: [],
        commitHash: null,
        summary: null,
        receiptId: null,
      });
    } else if (body.action === "changeset_discard_ok") {
      const arc = typeof body.arc === "string" ? body.arc : null;
      if (arc === null) return;
      const key = verbKey(sentDir, arc);
      const entryKey = this._discardInflight.get(key);
      if (entryKey === undefined) return;
      this._discardInflight.delete(key);
      // Success: the aggregate recompute drops this arc entry shortly (no
      // client-side flip). The phase settles on `done` carrying the receipt's
      // summary, which is the edge the transcript's discard row hangs off.
      this._setDiscard(entryKey, {
        phase: "done",
        error: null,
        summary: typeof body.summary === "string" ? body.summary : null,
        receiptId: receiptIdOf(body),
      });
    } else if (body.action === "changeset_discard_err") {
      const arc = typeof body.arc === "string" ? body.arc : null;
      if (arc === null) return;
      const key = verbKey(sentDir, arc);
      const entryKey = this._discardInflight.get(key);
      if (entryKey === undefined) return;
      this._discardInflight.delete(key);
      const detail = typeof body.detail === "string" ? body.detail : "discard failed";
      this._setDiscard(entryKey, { phase: "error", error: detail, summary: null, receiptId: null });
    } else if (body.action === "changeset_replay_ok") {
      const arc = typeof body.arc === "string" ? body.arc : null;
      if (arc === null) return;
      const key = verbKey(sentDir, arc);
      const entryKey = this._replayInflight.get(key);
      if (entryKey === undefined) return;
      this._replayInflight.delete(key);
      const outcome = typeof body.outcome === "string" ? body.outcome : null;
      const detail = typeof body.detail === "string" ? body.detail : null;
      this._setReplay(entryKey, { phase: "done", outcome, detail, error: null });
      // The outcomes that move nothing have no other voice ([P06]).
      const sessionId = typeof body.session_id === "string" ? body.session_id : null;
      if (sessionId !== null && outcome !== null) {
        arcReplayOutcomeStore.report(sessionId, {
          arc,
          outcome: outcome as ArcReplayOutcomeWord,
          detail,
          roundSubject:
            typeof body.round_subject === "string" ? body.round_subject : null,
          paths: readStringArray(body.paths),
        });
      }
    } else if (body.action === "changeset_replay_err") {
      const arc = typeof body.arc === "string" ? body.arc : null;
      if (arc === null) return;
      const key = verbKey(sentDir, arc);
      const entryKey = this._replayInflight.get(key);
      if (entryKey === undefined) return;
      this._replayInflight.delete(key);
      const detail = typeof body.detail === "string" ? body.detail : "replay failed";
      this._setReplay(entryKey, { phase: "error", outcome: null, detail: null, error: detail });
      const sessionId = typeof body.session_id === "string" ? body.session_id : null;
      if (sessionId !== null) {
        arcReplayOutcomeStore.report(sessionId, {
          arc,
          outcome: "error",
          detail,
          roundSubject: null,
          paths: [],
        });
      }
    }
  }

  private _setGitInit(projectDir: string, state: GitInitState): void {
    if (state.phase === "idle") {
      this._gitInit.delete(projectDir);
    } else {
      this._gitInit.set(projectDir, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /** Send `changeset_git_init` for `projectDir` and mark it in-flight. */
  gitInit(projectDir: string): void {
    this._setGitInit(projectDir, { phase: "pending", error: null });
    this._connection.sendControlFrame("changeset_git_init", { project_dir: projectDir });
  }

  gitInitState(projectDir: string): GitInitState {
    return this._gitInit.get(projectDir) ?? IDLE;
  }

  private _setClaim(entryKey: string, state: ClaimState): void {
    if (state.phase === "idle") {
      this._claims.delete(entryKey);
    } else {
      this._claims.set(entryKey, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_claim` and mark `entryKey` (the initiating card entry)
   * in-flight: the session claims the listed repo-relative files outright,
   * promoting them from "likely" hints into its changeset. On success the rows
   * migrate from the unattributed bucket into the session's entry when the
   * server's aggregate recompute lands — there is no client-side flip.
   *
   * The round trip is still tracked, because a claim that fails has nowhere
   * else to show: the reply names only the project, so the store keeps a
   * project→entry map for the duration (one in-flight claim per project, a
   * second send superseding the first's correlation — the same rule commit
   * follows).
   */
  claim(entryKey: string, workspaceKey: string, sessionId: string, files: string[]): void {
    if (files.length === 0) return;
    this._claimInflight.set(workspaceKey, entryKey);
    this._setClaim(entryKey, {
      phase: "pending",
      error: null,
      claimed: null,
      requested: files.length,
    });
    this._connection.sendControlFrame("changeset_claim", {
      project_dir: workspaceKey,
      session_id: sessionId,
      files,
    });
  }

  claimState(entryKey: string): ClaimState {
    return this._claims.get(entryKey) ?? CLAIM_IDLE;
  }

  /** Clear a terminal (done/error) claim state back to idle. */
  clearClaim(entryKey: string): void {
    this._setClaim(entryKey, CLAIM_IDLE);
  }

  private _setDisclaim(entryKey: string, state: DisclaimState): void {
    if (state.phase === "idle") {
      this._disclaims.delete(entryKey);
    } else {
      this._disclaims.set(entryKey, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_disclaim` and mark `entryKey` in-flight: the session
   * renounces the listed repo-relative files. On success they leave this
   * session's entry when the server's aggregate recompute lands — falling to
   * another session that still holds proof of them, or to the unattributed
   * bucket. There is no client-side flip; the round trip is tracked only so a
   * refusal has somewhere to show, and correlates through the same
   * project→entry map claim uses.
   */
  disclaim(entryKey: string, workspaceKey: string, sessionId: string, files: string[]): void {
    if (files.length === 0) return;
    this._disclaimInflight.set(workspaceKey, entryKey);
    this._setDisclaim(entryKey, {
      phase: "pending",
      error: null,
      disclaimed: null,
      requested: files.length,
    });
    this._connection.sendControlFrame("changeset_disclaim", {
      project_dir: workspaceKey,
      session_id: sessionId,
      files,
    });
  }

  disclaimState(entryKey: string): DisclaimState {
    return this._disclaims.get(entryKey) ?? DISCLAIM_IDLE;
  }

  /** Clear a terminal (done/error) disclaim state back to idle. */
  clearDisclaim(entryKey: string): void {
    this._setDisclaim(entryKey, DISCLAIM_IDLE);
  }

  /**
   * Nudge the server to re-scan open projects' working trees and recompose the
   * aggregate. Fire-and-forget, no payload: the server fires the same bump its
   * internal triggers use, and emission is diff-suppressed, so a client sees a
   * frame only when the tree actually drifted from the cached snapshot. The
   * Changes shade fires this on open so an orphan created while no FS event
   * landed still surfaces the moment you look.
   */
  refresh(): void {
    this._connection.sendControlFrame("changeset_refresh", {});
  }

  private _setCommit(entryKey: string, state: CommitState): void {
    if (state.phase === "idle") {
      this._commits.delete(entryKey);
    } else {
      this._commits.set(entryKey, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_commit` and mark `entryKey` (the initiating card entry)
   * in-flight. The response carries only `project_dir`, so the store keeps a
   * project→entry map for the duration of the round trip — one in-flight
   * commit per project (a second send for the same project supersedes the
   * first's correlation, matching git's own one-at-a-time reality).
   *
   * `hunks` names, per path, the hunk ids to land for a partial file (Spec
   * S03). Every key must also be in `files`; omitting it lands every path
   * whole, which is what every caller sent before hunks existed.
   */
  commit(
    entryKey: string,
    workspaceKey: string,
    files: string[],
    message: string,
    session?: { name?: string; id?: string },
    hunks?: Record<string, string[]>,
  ): void {
    this._commitInflight.set(workspaceKey, entryKey);
    this._setCommit(entryKey, {
      phase: "pending",
      error: null,
      sha: null,
      receipt: null,
      summary: null,
      receiptId: null,
    });
    // Optional `Tug-Session:` trailer fields (Spec S01) — appended server-side
    // by `do_changeset_commit`; omitted here keeps today's behavior byte-for-byte.
    const frame: Record<string, unknown> = {
      project_dir: workspaceKey,
      files,
      message,
    };
    if (session?.name !== undefined && session.name.length > 0) {
      frame.session_name = session.name;
    }
    if (session?.id !== undefined && session.id.length > 0) {
      frame.session_id = session.id;
    }
    if (hunks !== undefined && Object.keys(hunks).length > 0) {
      frame.hunks = hunks;
    }
    this._connection.sendControlFrame("changeset_commit", frame);
  }

  commitState(entryKey: string): CommitState {
    return this._commits.get(entryKey) ?? COMMIT_IDLE;
  }

  /** Clear a terminal (done/error) commit state back to idle. */
  clearCommit(entryKey: string): void {
    this._setCommit(entryKey, COMMIT_IDLE);
  }

  private _setJoin(entryKey: string, state: JoinState): void {
    if (state.phase === "idle") {
      this._joins.delete(entryKey);
    } else {
      this._joins.set(entryKey, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_join` for `(workspaceKey, arc)` and mark `entryKey`
   * in-flight. The card only ever executes: what a landing *would* do rides
   * the arc's feed entry, so `preview: true` is the CLI's path alone. One
   * in-flight landing per (workspace, arc).
   */
  join(entryKey: string, workspaceKey: string, arc: string, args: JoinArgs): void {
    this._joinInflight.set(verbKey(workspaceKey, arc), entryKey);
    this._setJoin(entryKey, {
      phase: "pending",
      error: null,
      conflicts: [],
      commitHash: null,
      summary: null,
      receiptId: null,
    });
    this._connection.sendControlFrame("changeset_join", {
      project_dir: workspaceKey,
      arc: arc,
      preview: args.preview,
      ...(args.strategy !== undefined ? { strategy: args.strategy } : {}),
      ...(args.message !== undefined ? { message: args.message } : {}),
      ...(args.candidate !== undefined ? { candidate: args.candidate } : {}),
      ...(args.continueJoin === true ? { continue: true } : {}),
      ...(args.sessionId !== undefined ? { session_id: args.sessionId } : {}),
    });
  }

  /**
   * Register the correlation for a join **this card did not send** — the
   * server-initiated landing a prompt-sheet "Join now" starts.
   *
   * The two terminal frames are dropped on a `_joinInflight` miss, and only
   * {@link join} ever wrote that map — so a prompt-route join used to arrive
   * at a store that had never heard of it, silencing the failure bulletin and
   * the live receipt row at once. This registers the same correlation a
   * composer press registers and sends nothing: the frame is already on its
   * way from the server, and a second one would be a second join.
   */
  expectServerJoin(entryKey: string, workspaceKey: string, arc: string): void {
    this._joinInflight.set(verbKey(workspaceKey, arc), entryKey);
    this._setJoin(entryKey, {
      phase: "pending",
      error: null,
      conflicts: [],
      commitHash: null,
      summary: null,
      receiptId: null,
    });
  }

  joinState(entryKey: string): JoinState {
    return this._joins.get(entryKey) ?? JOIN_IDLE;
  }

  /** Clear a join state back to idle (e.g. the user cancels the preview). */
  clearJoin(entryKey: string): void {
    this._setJoin(entryKey, JOIN_IDLE);
  }

  private _setDiscard(entryKey: string, state: DiscardState): void {
    if (state.phase === "idle") {
      this._discards.delete(entryKey);
    } else {
      this._discards.set(entryKey, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_discard` for `(workspaceKey, arc)`; mark `entryKey`
   * in-flight. `sessionId` is the card's tug session id, which the server needs
   * to leave the discard's receipt ([P06]); absent, the discard still runs.
   */
  discard(entryKey: string, workspaceKey: string, arc: string, sessionId?: string): void {
    this._discardInflight.set(verbKey(workspaceKey, arc), entryKey);
    this._setDiscard(entryKey, { phase: "pending", error: null, summary: null, receiptId: null });
    this._connection.sendControlFrame("changeset_discard", {
      project_dir: workspaceKey,
      arc: arc,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    });
  }

  discardState(entryKey: string): DiscardState {
    return this._discards.get(entryKey) ?? DISCARD_IDLE;
  }

  clearDiscard(entryKey: string): void {
    this._setDiscard(entryKey, DISCARD_IDLE);
  }

  private _setReplay(entryKey: string, state: ReplayState): void {
    if (state.phase === "idle") {
      this._replays.delete(entryKey);
    } else {
      this._replays.set(entryKey, state);
    }
    for (const listener of [...this._listeners]) listener();
  }

  /**
   * Send `changeset_replay` for `(workspaceKey, arc)`; mark `entryKey`
   * in-flight. `sessionId` names the card whose pane bulletin reports the
   * outcome ([P06]); absent, the replay still runs and simply says nothing.
   */
  replay(entryKey: string, workspaceKey: string, arc: string, sessionId?: string): void {
    this._replayInflight.set(verbKey(workspaceKey, arc), entryKey);
    this._setReplay(entryKey, { phase: "pending", outcome: null, detail: null, error: null });
    this._connection.sendControlFrame("changeset_replay", {
      project_dir: workspaceKey,
      arc: arc,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    });
  }

  replayState(entryKey: string): ReplayState {
    return this._replays.get(entryKey) ?? REPLAY_IDLE;
  }

  clearReplay(entryKey: string): void {
    this._setReplay(entryKey, REPLAY_IDLE);
  }

  /** The newest arc receipt announced for `tugSessionId`, or null. */
  arcReceipt(tugSessionId: string): ArcReceipt | null {
    return this._arcReceipts.get(tugSessionId) ?? null;
  }

  /** Every arc gesture announced for `tugSessionId`, oldest first. */
  arcNotes(tugSessionId: string): readonly ArcNote[] {
    return this._arcNotes.get(tugSessionId) ?? EMPTY_ARC_NOTES;
  }

  dispose(): void {
    this._unsubscribe();
    this._listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Singleton + hook
// ---------------------------------------------------------------------------

let _activeStore: ChangesetVerbStore | null = null;

export function attachChangesetVerbStore(conn: TugConnection): ChangesetVerbStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new ChangesetVerbStore(conn);
  return _activeStore;
}

export function getChangesetVerbStore(): ChangesetVerbStore | null {
  return _activeStore;
}

/** Test-only: detach the singleton between cases. */
export function _resetChangesetVerbStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/**
 * React hook: the git-init round-trip state for one project plus its trigger.
 * Returns idle + a no-op `init` when no store is attached (gallery / fixtures).
 */
export function useChangesetGitInit(projectDir: string): GitInitState & { init: () => void } {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.gitInitState(projectDir) ?? IDLE,
    () => IDLE,
  );
  const init = (): void => {
    _activeStore?.gitInit(projectDir);
  };
  return { ...state, init };
}

/**
 * React hook: the commit round-trip state for one card entry plus its
 * triggers. Returns idle + no-op triggers when no store is attached
 * (gallery / fixtures).
 */
export function useChangesetCommit(entryKey: string): CommitState & {
  commit: (workspaceKey: string, files: string[], message: string) => void;
  clear: () => void;
} {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.commitState(entryKey) ?? COMMIT_IDLE,
    () => COMMIT_IDLE,
  );
  const commit = (workspaceKey: string, files: string[], message: string): void => {
    _activeStore?.commit(entryKey, workspaceKey, files, message);
  };
  const clear = (): void => {
    _activeStore?.clearCommit(entryKey);
  };
  return { ...state, commit, clear };
}

/**
 * React hook: the claim round-trip state for one card entry plus its clear
 * trigger. Claims are issued through `ChangesRouteController.claim` (which
 * owns the project/session identity), so this hook only reads and dismisses.
 * Returns idle + a no-op `clear` when no store is attached.
 */
export function useChangesetClaim(entryKey: string): ClaimState & { clear: () => void } {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.claimState(entryKey) ?? CLAIM_IDLE,
    () => CLAIM_IDLE,
  );
  const clear = (): void => {
    _activeStore?.clearClaim(entryKey);
  };
  return { ...state, clear };
}

/**
 * React hook: the disclaim round-trip state for one card entry plus its clear
 * trigger. Disclaims are issued through `ChangesRouteController.disclaim`
 * (which owns the project/session identity), so this hook only reads and
 * dismisses. Returns idle + a no-op `clear` when no store is attached.
 */
export function useChangesetDisclaim(entryKey: string): DisclaimState & { clear: () => void } {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.disclaimState(entryKey) ?? DISCLAIM_IDLE,
    () => DISCLAIM_IDLE,
  );
  const clear = (): void => {
    _activeStore?.clearDisclaim(entryKey);
  };
  return { ...state, clear };
}

/**
 * React hook: the arc-join round-trip state for one arc entry plus its
 * triggers. Returns idle + no-op triggers when no store is attached.
 */
export function useChangesetJoin(entryKey: string): JoinState & {
  join: (workspaceKey: string, arc: string, args: JoinArgs) => void;
  clear: () => void;
} {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.joinState(entryKey) ?? JOIN_IDLE,
    () => JOIN_IDLE,
  );
  const join = (workspaceKey: string, arc: string, args: JoinArgs): void => {
    _activeStore?.join(entryKey, workspaceKey, arc, args);
  };
  const clear = (): void => {
    _activeStore?.clearJoin(entryKey);
  };
  return { ...state, join, clear };
}

/**
 * React hook: the arc-discard round-trip state for one arc entry plus its
 * triggers. Returns idle + no-op triggers when no store is attached.
 */
export function useChangesetDiscard(entryKey: string): DiscardState & {
  discard: (workspaceKey: string, arc: string, sessionId?: string) => void;
  clear: () => void;
} {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.discardState(entryKey) ?? DISCARD_IDLE,
    () => DISCARD_IDLE,
  );
  const discard = (workspaceKey: string, arc: string, sessionId?: string): void => {
    _activeStore?.discard(entryKey, workspaceKey, arc, sessionId);
  };
  const clear = (): void => {
    _activeStore?.clearDiscard(entryKey);
  };
  return { ...state, discard, clear };
}

/**
 * React hook: the arc-replay round-trip state for one arc entry plus its
 * triggers. Returns idle + no-op triggers when no store is attached.
 */
export function useChangesetReplay(entryKey: string): ReplayState & {
  replay: (workspaceKey: string, arc: string, sessionId?: string) => void;
  clear: () => void;
} {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.replayState(entryKey) ?? REPLAY_IDLE,
    () => REPLAY_IDLE,
  );
  const replay = (workspaceKey: string, arc: string, sessionId?: string): void => {
    _activeStore?.replay(entryKey, workspaceKey, arc, sessionId);
  };
  const clear = (): void => {
    _activeStore?.clearReplay(entryKey);
  };
  return { ...state, replay, clear };
}
