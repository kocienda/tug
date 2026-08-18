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
}

const COMMIT_IDLE: CommitState = Object.freeze({
  phase: "idle",
  error: null,
  sha: null,
  receipt: null,
  summary: null,
});

/**
 * One dash-join round trip's state, keyed by the initiating card entry.
 *
 * `pending` covers a preview or execute request in flight. A preview reply
 * lands in `preview` (its `conflicts` empty ⇒ a clean bill, non-empty ⇒ the
 * conflicting paths). An execute reply lands in `done` (a commit was made and
 * the entry will drop on the next aggregate recompute) or `conflict` (the join
 * cleanly aborted on the listed paths — the "Resolve with AI" path). `error`
 * carries a verb-level refusal (e.g. "Nothing to join").
 */
export type JoinPhase = "idle" | "pending" | "preview" | "done" | "conflict" | "error";

/**
 * One reason a join would be refused, as the server's preflight reports it
 * (Spec S03). `kind` is `off-base` | `base-dirt` | `stale-journal` | `empty`;
 * an unrecognized kind still carries a renderable `detail`, so a blocker the
 * deck has never heard of is shown rather than swallowed.
 */
export interface JoinBlocker {
  kind: string;
  detail: string;
  /** Paths, for `base-dirt`; empty otherwise. */
  paths: readonly string[];
}

/** One base commit behind a conflicted path (Spec S03). */
export interface ConflictCommit {
  sha: string;
  subject: string;
}

/**
 * What the base did to one conflicted path since the two sides parted — the
 * history that explains the conflict. Server-computed on the preview path,
 * newest first and capped; `total` counts every commit, so the face can say
 * how many it is not showing.
 */
export interface ConflictHistory {
  path: string;
  commits: readonly ConflictCommit[];
  total: number;
}

export interface JoinState {
  phase: JoinPhase;
  error: string | null;
  /** Conflicting paths for a `preview`/`conflict` phase; empty otherwise. */
  conflicts: readonly string[];
  /** Per-path base history for a conflicted `preview`; empty otherwise. */
  archaeology: readonly ConflictHistory[];
  /** The landing commit sha when `phase === "done"`. */
  commitHash: string | null;
  /**
   * What would refuse this join, from a `preview` reply. Blocked is a finding
   * *about* a preview, not a phase of its own — a blocked preview still lands
   * in `phase: "preview"` and the surface reads this to pick its face.
   */
  blockers: readonly JoinBlocker[];
  /** The server-formatted landing summary (Spec S01) when `phase === "done"`. */
  summary: string | null;
}

const JOIN_IDLE: JoinState = Object.freeze({
  phase: "idle",
  error: null,
  conflicts: Object.freeze([]) as readonly string[],
  archaeology: Object.freeze([]) as readonly ConflictHistory[],
  commitHash: null,
  blockers: Object.freeze([]) as readonly JoinBlocker[],
  summary: null,
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
 * One dash-discard round trip's state, keyed by the initiating card entry.
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
}

const DISCARD_IDLE: DiscardState = Object.freeze({
  phase: "idle",
  error: null,
  summary: null,
});

/** Correlation key for a join/discard reply: `project_dir` + dash name. */
function verbKey(projectDir: string, dash: string): string {
  return `${projectDir}\x00${dash}`;
}

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

/**
 * Read the `blockers` array off a `changeset_join_ok` body. A malformed entry
 * is dropped rather than thrown on — a blocker the deck cannot read must not
 * cost the user the blockers it can.
 */
function readJoinBlockers(value: unknown): JoinBlocker[] {
  if (!Array.isArray(value)) return [];
  const blockers: JoinBlocker[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { kind, detail } = entry;
    if (typeof kind !== "string" || kind === "") continue;
    if (typeof detail !== "string" || detail === "") continue;
    blockers.push({ kind, detail, paths: readStringArray(entry.paths) });
  }
  return blockers;
}

/**
 * The per-path base history a conflicted preview carries (Spec S03). Additive
 * and preview-only, so absence is ordinary rather than an error; a malformed
 * row is dropped, since a history is context and half of one is misleading.
 */
function readConflictHistories(value: unknown): ConflictHistory[] {
  if (!Array.isArray(value)) return [];
  const histories: ConflictHistory[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { path } = entry;
    if (typeof path !== "string" || path === "") continue;
    const commits: ConflictCommit[] = [];
    if (Array.isArray(entry.commits)) {
      for (const commit of entry.commits) {
        if (!isRecord(commit)) continue;
        const { sha, subject } = commit;
        if (typeof sha !== "string" || sha === "") continue;
        commits.push({ sha, subject: typeof subject === "string" ? subject : "" });
      }
    }
    const total = typeof entry.total === "number" ? entry.total : commits.length;
    histories.push({ path, commits, total });
  }
  return histories;
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
  /** `verbKey(project_dir, dash)` → the entry key whose join is in flight. */
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
  /** `verbKey(project_dir, dash)` → the entry key whose discard is in flight. */
  private _discardInflight = new Map<string, string>();
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
    const projectDir = typeof body.project_dir === "string" ? body.project_dir : null;
    if (projectDir === null) return;

    if (body.action === "changeset_git_init_ok") {
      // Success: the aggregate recompute (server bump) removes this project's
      // non-repo section shortly. Clear the in-flight state meanwhile.
      this._setGitInit(projectDir, IDLE);
      // The History shade rides a separate GIT_LOG singleton: a fresh `git
      // init` leaves an unborn HEAD that moves no HEAD, so no GIT_HEAD signal
      // arrives to shake its cached `no_repo` snapshot. Nudge it directly so
      // History flips off "Not a git repository" in lockstep with Changes.
      gitLogStore()?.onRepoInitialized(projectDir);
    } else if (body.action === "changeset_git_init_err") {
      const detail = typeof body.detail === "string" ? body.detail : "git init failed";
      this._setGitInit(projectDir, { phase: "error", error: detail });
    } else if (body.action === "changeset_commit_ok") {
      const entryKey = this._commitInflight.get(projectDir);
      if (entryKey === undefined) return;
      this._commitInflight.delete(projectDir);
      this._setCommit(entryKey, {
        phase: "done",
        error: null,
        sha: typeof body.sha === "string" ? body.sha : null,
        receipt: typeof body.receipt === "string" ? body.receipt : null,
        summary: typeof body.summary === "string" ? body.summary : null,
      });
    } else if (body.action === "changeset_commit_err") {
      const entryKey = this._commitInflight.get(projectDir);
      if (entryKey === undefined) return;
      this._commitInflight.delete(projectDir);
      const detail = typeof body.detail === "string" ? body.detail : "git commit failed";
      this._setCommit(entryKey, {
        phase: "error",
        error: detail,
        sha: null,
        receipt: null,
        summary: null,
      });
    } else if (body.action === "changeset_claim_ok") {
      const entryKey = this._claimInflight.get(projectDir);
      if (entryKey === undefined) return;
      this._claimInflight.delete(projectDir);
      const requested = this._claims.get(entryKey)?.requested ?? null;
      const claimed = typeof body.claimed === "number" ? body.claimed : 0;
      // A shortfall is a failure with a receipt attached, not a success.
      const shortfall = requested !== null && claimed < requested;
      this._setClaim(entryKey, {
        phase: shortfall ? "error" : "done",
        error: shortfall ? claimShortfallDetail(claimed, requested) : null,
        claimed,
        requested,
      });
    } else if (body.action === "changeset_claim_err") {
      const entryKey = this._claimInflight.get(projectDir);
      if (entryKey === undefined) return;
      this._claimInflight.delete(projectDir);
      const requested = this._claims.get(entryKey)?.requested ?? null;
      const detail = typeof body.detail === "string" ? body.detail : "claim failed";
      this._setClaim(entryKey, {
        phase: "error",
        error: detail,
        claimed: 0,
        requested,
      });
    } else if (body.action === "changeset_disclaim_ok") {
      const entryKey = this._disclaimInflight.get(projectDir);
      if (entryKey === undefined) return;
      this._disclaimInflight.delete(projectDir);
      this._setDisclaim(entryKey, {
        phase: "done",
        error: null,
        disclaimed: typeof body.disclaimed === "number" ? body.disclaimed : 0,
        requested: this._disclaims.get(entryKey)?.requested ?? null,
      });
    } else if (body.action === "changeset_disclaim_err") {
      const entryKey = this._disclaimInflight.get(projectDir);
      if (entryKey === undefined) return;
      this._disclaimInflight.delete(projectDir);
      this._setDisclaim(entryKey, {
        phase: "error",
        error: typeof body.detail === "string" ? body.detail : "disclaim failed",
        disclaimed: 0,
        requested: this._disclaims.get(entryKey)?.requested ?? null,
      });
    } else if (body.action === "changeset_join_ok") {
      const dash = typeof body.dash === "string" ? body.dash : null;
      if (dash === null) return;
      const key = verbKey(projectDir, dash);
      const entryKey = this._joinInflight.get(key);
      if (entryKey === undefined) return;
      this._joinInflight.delete(key);
      const previewed = body.previewed === true;
      const conflicts = readStringArray(body.conflicts);
      const commitHash = typeof body.commit_hash === "string" ? body.commit_hash : null;
      const blockers = readJoinBlockers(body.blockers);
      if (previewed) {
        this._setJoin(entryKey, {
          phase: "preview",
          error: null,
          conflicts,
          archaeology: readConflictHistories(body.archaeology),
          commitHash: null,
          blockers,
          summary: null,
        });
      } else if (commitHash !== null) {
        this._setJoin(entryKey, {
          phase: "done",
          error: null,
          conflicts: [],
          archaeology: [],
          commitHash,
          blockers: [],
          // The landing's receipt, formatted by the server so the durable row
          // and the live one cannot drift (Spec S01).
          summary: typeof body.summary === "string" ? body.summary : null,
        });
      } else {
        // A real join that cleanly aborted on conflicts.
        this._setJoin(entryKey, {
          phase: "conflict",
          error: null,
          conflicts,
          // Preview-only ([P07]): an execute that aborted did not compute it.
          archaeology: [],
          commitHash: null,
          blockers: [],
          summary: null,
        });
      }
    } else if (body.action === "changeset_join_err") {
      const dash = typeof body.dash === "string" ? body.dash : null;
      if (dash === null) return;
      const key = verbKey(projectDir, dash);
      const entryKey = this._joinInflight.get(key);
      if (entryKey === undefined) return;
      this._joinInflight.delete(key);
      const detail = typeof body.detail === "string" ? body.detail : "join failed";
      this._setJoin(entryKey, {
        phase: "error",
        error: detail,
        conflicts: [],
        archaeology: [],
        commitHash: null,
        blockers: [],
        summary: null,
      });
    } else if (body.action === "changeset_discard_ok") {
      const dash = typeof body.dash === "string" ? body.dash : null;
      if (dash === null) return;
      const key = verbKey(projectDir, dash);
      const entryKey = this._discardInflight.get(key);
      if (entryKey === undefined) return;
      this._discardInflight.delete(key);
      // Success: the aggregate recompute drops this dash entry shortly (no
      // client-side flip). The phase settles on `done` carrying the receipt's
      // summary, which is the edge the transcript's discard row hangs off.
      this._setDiscard(entryKey, {
        phase: "done",
        error: null,
        summary: typeof body.summary === "string" ? body.summary : null,
      });
    } else if (body.action === "changeset_discard_err") {
      const dash = typeof body.dash === "string" ? body.dash : null;
      if (dash === null) return;
      const key = verbKey(projectDir, dash);
      const entryKey = this._discardInflight.get(key);
      if (entryKey === undefined) return;
      this._discardInflight.delete(key);
      const detail = typeof body.detail === "string" ? body.detail : "discard failed";
      this._setDiscard(entryKey, { phase: "error", error: detail, summary: null });
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
  claim(entryKey: string, projectDir: string, sessionId: string, files: string[]): void {
    if (files.length === 0) return;
    this._claimInflight.set(projectDir, entryKey);
    this._setClaim(entryKey, {
      phase: "pending",
      error: null,
      claimed: null,
      requested: files.length,
    });
    this._connection.sendControlFrame("changeset_claim", {
      project_dir: projectDir,
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
  disclaim(entryKey: string, projectDir: string, sessionId: string, files: string[]): void {
    if (files.length === 0) return;
    this._disclaimInflight.set(projectDir, entryKey);
    this._setDisclaim(entryKey, {
      phase: "pending",
      error: null,
      disclaimed: null,
      requested: files.length,
    });
    this._connection.sendControlFrame("changeset_disclaim", {
      project_dir: projectDir,
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
    projectDir: string,
    files: string[],
    message: string,
    session?: { name?: string; id?: string },
    hunks?: Record<string, string[]>,
  ): void {
    this._commitInflight.set(projectDir, entryKey);
    this._setCommit(entryKey, {
      phase: "pending",
      error: null,
      sha: null,
      receipt: null,
      summary: null,
    });
    // Optional `Tug-Session:` trailer fields (Spec S01) — appended server-side
    // by `do_changeset_commit`; omitted here keeps today's behavior byte-for-byte.
    const frame: Record<string, unknown> = {
      project_dir: projectDir,
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
   * Send `changeset_join` for `(projectDir, dash)` and mark `entryKey`
   * in-flight. `preview: true` reports conflicts without touching the tree;
   * `preview: false` executes the join. One in-flight join per (project, dash).
   */
  join(entryKey: string, projectDir: string, dash: string, args: JoinArgs): void {
    this._joinInflight.set(verbKey(projectDir, dash), entryKey);
    this._setJoin(entryKey, {
      phase: "pending",
      error: null,
      conflicts: [],
      archaeology: [],
      commitHash: null,
      blockers: [],
      summary: null,
    });
    this._connection.sendControlFrame("changeset_join", {
      project_dir: projectDir,
      dash,
      preview: args.preview,
      ...(args.strategy !== undefined ? { strategy: args.strategy } : {}),
      ...(args.message !== undefined ? { message: args.message } : {}),
      ...(args.candidate !== undefined ? { candidate: args.candidate } : {}),
      ...(args.continueJoin === true ? { continue: true } : {}),
      ...(args.sessionId !== undefined ? { session_id: args.sessionId } : {}),
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
   * Send `changeset_discard` for `(projectDir, dash)`; mark `entryKey`
   * in-flight. `sessionId` is the card's tug session id, which the server needs
   * to leave the discard's receipt ([P06]); absent, the discard still runs.
   */
  discard(entryKey: string, projectDir: string, dash: string, sessionId?: string): void {
    this._discardInflight.set(verbKey(projectDir, dash), entryKey);
    this._setDiscard(entryKey, { phase: "pending", error: null, summary: null });
    this._connection.sendControlFrame("changeset_discard", {
      project_dir: projectDir,
      dash,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    });
  }

  discardState(entryKey: string): DiscardState {
    return this._discards.get(entryKey) ?? DISCARD_IDLE;
  }

  clearDiscard(entryKey: string): void {
    this._setDiscard(entryKey, DISCARD_IDLE);
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
  commit: (projectDir: string, files: string[], message: string) => void;
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
  const commit = (projectDir: string, files: string[], message: string): void => {
    _activeStore?.commit(entryKey, projectDir, files, message);
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
 * React hook: the dash-join round-trip state for one dash entry plus its
 * triggers. Returns idle + no-op triggers when no store is attached.
 */
export function useChangesetJoin(entryKey: string): JoinState & {
  join: (projectDir: string, dash: string, args: JoinArgs) => void;
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
  const join = (projectDir: string, dash: string, args: JoinArgs): void => {
    _activeStore?.join(entryKey, projectDir, dash, args);
  };
  const clear = (): void => {
    _activeStore?.clearJoin(entryKey);
  };
  return { ...state, join, clear };
}

/**
 * React hook: the dash-discard round-trip state for one dash entry plus its
 * triggers. Returns idle + no-op triggers when no store is attached.
 */
export function useChangesetDiscard(entryKey: string): DiscardState & {
  discard: (projectDir: string, dash: string, sessionId?: string) => void;
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
  const discard = (projectDir: string, dash: string, sessionId?: string): void => {
    _activeStore?.discard(entryKey, projectDir, dash, sessionId);
  };
  const clear = (): void => {
    _activeStore?.clearDiscard(entryKey);
  };
  return { ...state, discard, clear };
}
