/**
 * Changeset feed wire types — TS mirror of `tugcast-core/src/types.rs`.
 *
 * The per-workspace `ChangesetSnapshot` / `ChangesetEntry` / `ChangesetFile`
 * ride the CHANGESET feed (0x23); the account-global aggregate
 * `WorkspacesChangesetSnapshot` / `ProjectChangeset` ride the CHANGESET_ALL
 * feed (0x24).
 *
 * The Rust definitions are authoritative; both sides deserialize the shared
 * golden fixtures `src/__tests__/fixtures/changeset-snapshot.golden.json` and
 * `src/__tests__/fixtures/workspaces-changeset-snapshot.golden.json`, so drift
 * on either side fails a test.
 *
 * @module lib/changeset-types
 */

/** One file inside a changeset entry. */
export interface ChangesetFile {
  /** Path relative to the repository root. */
  path: string;
  /** Porcelain-v2 XY status (working tree) or name-status letter (dash). */
  git_status: string;
  /** Attribution operation: write | edit | notebook | created | modified | deleted | renamed. */
  op: string;
  /** Attribution origin: exact | bash | turn | replay | dash. */
  origin: string;
  /** True when more than one changeset owns this file **and** their claimed
   *  regions overlap ([P12]). Two sessions editing disjoint parts of one file
   *  are co-owners without contending. */
  shared: boolean;
  /** Epoch milliseconds of the most recent attribution event for this file. */
  last_touched: number;
  /** The hunks this owner's evidence places it in, by [P06] id. Absent means
   *  file-level: nobody else owns the path, or this owner's evidence cannot
   *  say where it wrote and claims the file whole. */
  own_hunks?: string[];
  /** The hunks another owner claims too — where the contention actually is. */
  contested_hunks?: string[];
  /** Who else is claiming this file, when `shared` ([P06]). Absent on
   *  non-shared files and from pre-plan servers. */
  shared_with?: SharedOwner[];
  /** Lines added over the dash's `base...branch` range. Only a dash row
   *  carries it; absent for a binary file and from older servers. */
  added?: number;
  /** Lines deleted, on the same terms. */
  deleted?: number;
}

/** One co-owner named on a shared file's badge. */
export interface SharedOwner {
  id: string;
  name: string;
  /** Whether that session is still running. All-dead co-owners are what make
   *  the row releasable by hand. */
  live: boolean;
}

/** A dirty file no owner claims (hand edits, detached background writes). */
export interface UnattributedFile {
  path: string;
  git_status: string;
  /** Sessions whose live bracket rows saw the path change ([P13]) — a hint
   *  for the disposition decision, never an attribution. */
  hinted_by?: string[];
}

/** A file owned only by non-live ("dead") sessions — a claimable orphan
 *  ([D120]). A closed session keeps its proof rows, but no live card surfaces
 *  another session's entry, so these are lifted into their own bucket. */
export interface OrphanedFile {
  path: string;
  git_status: string;
  /** Attribution op/origin carried over from the dead owner's proof row. */
  op: string;
  origin: string;
  /** The dead session that last proof-owned this file, for the "orphaned
   *  from <name>" label. */
  prior_owner_name: string;
  /** The dead session's tug id. */
  prior_owner_id: string;
  last_touched: number;
}

/** The maintained commit-message draft for a changeset entry (Spec S10). */
export interface ChangesetDraft {
  /** Hash of the entry's scoped content the draft was generated for. */
  fingerprint: string;
  /** The maintained commit message (subject + terse bullets). */
  message: string;
  /** Epoch milliseconds of the last regeneration. */
  updated_at: number;
  /** True once a human has touched the message — never machine-clobbered. */
  edited?: boolean;
  /** Persisted selection dispositions against the default rule. */
  selection?: ChangesetDraftSelection;
}

/** Repo-relative path overrides riding a draft's persisted selection. */
export interface ChangesetDraftSelection {
  /** Paths elected into the landing beyond the default rule. */
  include?: string[];
  /** Paths excluded from the landing against the default rule. */
  exclude?: string[];
  /**
   * Per-path hunk election: the server-supplied hunk ids to land for a path
   * whose landing is partial. A path absent from this map lands whole, which
   * is what every landing did before hunks existed. Meaningful only for paths
   * that are in the landing set.
   */
  hunks?: { [path: string]: string[] };
}

/** Files attributed to one Claude session. */
export interface SessionChangesetEntry {
  kind: "session";
  /**
   * The tug session id that owns these files — the owning line's current
   * seat segment when the server knows the line, else the raw id the rows
   * were written under.
   */
  owner_id: string;
  /**
   * The line of work this owner is ([P01]), when the server knows one. The
   * stable key across id rotations: match an entry to a card by line first,
   * `owner_id` as the fallback.
   */
  line_id?: string | null;
  /** Session display name (name when user-set, else the id hash). */
  display_name: string;
  /** True when the session has a live relay right now. */
  live: boolean;
  files: ChangesetFile[];
  /** The maintained commit-message draft, when one exists (Spec S10). */
  draft?: ChangesetDraft;
}

/**
 * One row of a dash's plan ledger — the step list a surface renders.
 *
 * Two fields on purpose. The ledger row on disk also carries an anchor and a
 * commit cell; both belong to the Changes shade rather than to a placard, and a
 * list that shows a title and a state needs a title and a state.
 */
export interface DashStep {
  /** The step's title, as the ledger table spells it. */
  title: string;
  /**
   * The status cell, lowercased: `pending` | `in progress` | `done` |
   * `withdrawn`. Carried as a bare string, so a new spelling rides the wire
   * with no schema bump.
   */
  status: string;
}

export function isDashStep(value: unknown): value is DashStep {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.status === "string"
  );
}

/**
 * What a server-driven arc is doing on one dash, when one is running it.
 *
 * Absent for every hand-driven dash — which is most of them — and from a
 * server that predates arcs. Read **beside** {@link DashChangesetEntry.stage},
 * never instead of it: `stage` says what the dash is doing in git, this says
 * which stage of the arc is driving it, and a stopped arc is precisely the
 * state where both have to be sayable at once.
 */
export interface DashArcState {
  /** The stage last rotated: `devise` | `review` | `implement` | `audit`. */
  stage?: string;
  /** Why the arc stopped, when it did. Cleared by the next rotation, because
   *  resuming a stopped arc *is* rotating it again. */
  stopped?: string;
  /** The stage it stopped *in* — not necessarily `stage`, since a refused
   *  rotation stops in the stage it was trying to leave. */
  stopped_stage?: string;
  /** Whether the arc reached its terminal line. */
  done?: boolean;
  /** The arc's most recent note — what it last did, in its own words
   *  (`compacted at 0.73 > 0.60`). */
  note?: string;
}

/** A dash worktree branch and its accumulated base..branch changes. */
export interface DashChangesetEntry {
  kind: "dash";
  /**
   * The dash's **owner key** and its identity: `tugdash/<name>#<tugid>`, or
   * the bare branch ref for a dash created before ids existed.
   *
   * Opaque — never a git ref, never displayed. Draft rows, session bindings,
   * and this entry's `(workspace_key, owner_kind, owner_id)` draft-overlay key
   * are all this same string. Display uses `display_name`; anything needing a
   * ref reads `branch`.
   */
  owner_id: string;
  /** The dash's short name (branch name without the `tugdash/` prefix). */
  display_name: string;
  /** The dash branch ref name (e.g. `tugdash/fix-join`). Absent from an older
   *  sender, where `tugdash/${display_name}` is the fallback. */
  branch?: string;
  /** Derived lifecycle stage: `created` | `working` | `draft-ready` |
   *  `landing`. */
  stage?: string;
  /** The arc driving this dash, when one is — see {@link DashArcState}. */
  arc?: DashArcState;
  /** Live sessions mated to this dash. Empty is how *unbound* reads. */
  bound_sessions?: string[];
  /**
   * Whether any session holding this dash is still working — mid-turn, or
   * waiting on a background job it launched (a test sweep, an agent).
   *
   * Read beside `stage`, never folded into it. A dash whose last step is
   * committed on a clean worktree genuinely reads `ready` by its own git
   * facts; this says whether the session that built it has actually stopped.
   * Every surface that offers a join holds it shut while this is true, so a
   * join is never presented before the work behind it is finished.
   */
  holders_busy?: boolean;
  /** Declared step counters, from the latest step declaration. Plan-absolute:
   *  the step's number in the plan, and how many rows the plan holds. The ring
   *  draws its segments from this pair. */
  step_current?: number;
  step_total?: number;
  /** How far through the *declared run* — position within the selection
   *  somebody asked for, and that selection's length. This is the pair the
   *  numerals show: a run of steps 5–7 reads `2/3` here while `step_current`
   *  reads 6. Absent for a generation that declared no run, where the numerals
   *  fall back to the plan pair. */
  run_position?: number;
  run_length?: number;
  /** What `step_current` *is* — the latest `step-start` declaration's title. */
  step_title?: string;
  /** When the dash was last touched — the newest dash-log line's timestamp for
   *  its current generation, as an ISO-8601 UTC instant. Absent for a dash
   *  whose generation has logged nothing, which for one created before
   *  creation wrote a birth record is the ordinary case; a surface shows no
   *  age rather than guessing one. */
  last_activity?: string;
  /** Which of this dash's documents exist, as **absolute** paths. The server
   *  resolves them where the main repository root is known and hands them over
   *  whole; nothing here composes a path. Absent when the dash has neither. */
  documents?: DashDocuments;
  /** What that plan's Review Record says about the document on disk now — one
   *  of `reviewed` | `stale` | `never-reviewed`, the same spellings
   *  `tugtool plan status` reports. Absent when the dash records no plan, or
   *  when the file cannot be read or parsed: absence means *nothing to say*,
   *  and a surface paints nothing for it. */
  review?: string;
  /** True when that plan is a **task list** — the steps and the ledger and
   *  nothing else — rather than a document devised against the skeleton. A
   *  dash worked directly writes one for itself before its first round, and
   *  the two documents are otherwise identical here, so this is what tells
   *  the faces which phases the dash actually has. Absent means false. */
  task_list?: boolean;
  /** That plan's ledger, in source order — one entry per declared step.
   *
   *  The counters above say *where* the run is; this says what the walk *is*,
   *  and it is the only source for that. Read off the same parse `review` comes
   *  from, so a dash's fraction and its step list cannot come from two readings
   *  of two different bytes. Absent when the dash records no plan, or when the
   *  file cannot be read or parsed — the same silence `review` keeps. */
  steps?: DashStep[];
  /** The base branch the dash was created from. */
  base: string;
  /** Number of commits on the dash branch past its base. */
  rounds: number;
  /** The dash worktree's **absolute** path, resolved on the server against the
   *  main repository root — which is not necessarily this card's project root,
   *  since a project directory may itself be a linked worktree. Never compose
   *  it with `projectDir`; use it as it arrives. */
  worktree: string;
  /** True when the dash worktree has uncommitted changes. */
  worktree_dirty: boolean;
  files: ChangesetFile[];
  /** Round commit subjects, newest first — the lane's expanded row lists them. */
  round_subjects?: string[];
  /** The maintained draft — the dash's eventual join message ([P23]). */
  draft?: ChangesetDraft;
  /** Commits the base branch has gained past this dash's merge-base. Absent
   *  means the dash already contains the base tip. */
  base_ahead?: number;
  /** Base-checkout uncommitted paths this dash also changes — the landing's
   *  `base-dirt` refusal, said the moment it becomes true. */
  base_overlap?: string[];
  /** Where this dash's rounds went the last time its base moved under it. */
  last_replay?: string;
  /** What the last green verify said about the tree a join would land: the
   *  head, the base it was verified onto, and whether both still stand.
   *  Absent when nothing has verified this dash. It says; it gates nothing. */
  fit?: { head: string; base: string; current: boolean };
  /** Paths the last replay attempt stopped on, when it conflicted. */
  replay_conflict_paths?: string[];
  /**
   * The join pipeline's entire durable state for this dash.
   *
   * This is the join's single source of truth. The client keeps no durable
   * copy of any of it — what remains client-side is the in-flight resolve's
   * progress and the draft message, both genuinely ephemeral. Absent from an
   * older server, which reads as *nothing to say*.
   */
  join?: DashJoinStateWire;
}

/** One reason a join would be refused right now. */
export interface DashJoinBlockerWire {
  /** `off-base` | `base-dirt` | `stale-journal` | `empty`. */
  kind: string;
  /** The situation as a short phrase — the dialog's title row. */
  title: string;
  /** The human sentence — the same one the CLI's execute path returns. */
  detail: string;
  /** The offending paths, for `base-dirt`; empty otherwise. */
  paths?: string[];
  /**
   * What a `Resolve` on this blocker would do, when one can. Absent on the
   * kinds nothing at the card can clear, which are reported all the same.
   *
   * The deck composes none of this. The remedy is the server's sentence for
   * the same reason `detail` is: a second copy here would be free to disagree
   * with the act the server actually performs.
   */
  remedy?: DashJoinRemedyWire;
}

/** The one way out of a blocker, and the sentence that explains it. */
export interface DashJoinRemedyWire {
  /** What Resolve will do, as one sentence the reader weighs before pressing. */
  explain: string;
}

/** One base commit behind a conflicted path. */
export interface DashConflictCommitWire {
  sha: string;
  subject: string;
}

/** What the base did to one conflicted path since the two sides parted. */
export interface DashConflictHistoryWire {
  path: string;
  commits?: DashConflictCommitWire[];
  /** How many commits touched it in total — more than `commits` when capped. */
  total: number;
}

/** One file the resolution ladder resolved, as the review panel reads it. */
export interface DashResolvedFileWire {
  path: string;
  /**
   * Which rung decided it: `replay` | `rerere` | `merge-file` | `driver` |
   * `ai`, or `unknown` when the provenance could not be read back.
   *
   * This is why the review exists: every rung above the replay probe is a
   * machine decision nobody saw, and a diff without its provenance drops the
   * signal the panel was built to carry.
   */
  resolved_by: string;
  /** The unified diff this resolution lands on the base, capped server-side. */
  diff?: string;
  /** Lines added and removed as git counts them — not as the capped diff reads. */
  added?: number;
  removed?: number;
}

/**
 * The join pipeline's server-owned state for one dash.
 *
 * Every field is computed fresh server-side on each recompute; nothing here is
 * a client-held accumulation, which is what makes two cards on one dash, a
 * reloaded deck, and a relaunched app agree by construction.
 */
export interface DashJoinStateWire {
  /** `blocked` | `previewed` | `conflicted` | `resolved`. Derived, never stored. */
  phase: string;
  /** Non-empty means `phase` is `blocked`. */
  blockers?: DashJoinBlockerWire[];
  /** Conflicted paths from the in-memory merge probe. */
  conflicts?: string[];
  /** What the base did to each conflicted path. */
  archaeology?: DashConflictHistoryWire[];
  /**
   * The resolved candidate commit, present only while it still verifies
   * against the current base and dash heads. Present means `phase` is
   * `resolved`.
   */
  candidate?: string;
  /** The ladder's per-file results, for the review panel. */
  resolved?: DashResolvedFileWire[];
  /** Whether the user has read what the ladder decided **for this candidate**. */
  reviewed?: boolean;
  /**
   * A candidate existed but no longer describes the current heads; the
   * sentence names which side moved. The server drops the stale candidate when
   * it says this, so the state demotes itself rather than standing as a lie.
   */
  stale_note?: string;
  /**
   * What the resolver did and why, for the candidate that stands — anchored to
   * the candidate sha server-side, so it never outlives the resolution it
   * describes.
   */
  report?: DashJoinReportWire;
  /**
   * Why the resolve stopped short, when it did. A join that will not proceed
   * and cannot say why is the one state the face must never render.
   */
  stuck?: string;
  /**
   * The intent question the resolver is waiting on. Durable state rather than
   * a live frame, so a reload re-renders the question instead of losing it and
   * leaving the resolver blocked on an answer nobody can give.
   */
  question?: DashJoinQuestionWire;
  /**
   * What is running on this dash right now — `resolve` or `verify` — absent
   * when nothing is.
   *
   * The one join fact that is not durable: occupancy is the server's
   * in-process state, so a restart clears it. It is on the wire because a
   * reload mid-resolve would otherwise render a running resolve as absence.
   */
  run?: string;
  /**
   * The join this dash is ready for, standing until it is taken or the work
   * moves on.
   *
   * Raised once the machine's work is done and a candidate stands. Absent is
   * the ordinary case — a dash still being worked, and one with nothing
   * reconciled yet.
   */
  offer?: DashJoinOfferWire;
}

/**
 * The join a dash is ready for, as a fact rather than an ask.
 *
 * The decision surface is the Changes shade, so this carries what the shade
 * shows and what summons it — nothing that belongs to a dialog.
 */
export interface DashJoinOfferWire {
  /**
   * `<dash>:<base_sha>:<dash_head>` — stable across recomputes, and different
   * the moment any of those three facts moves. A surface reveals itself once
   * per id, so stability is what keeps it from re-revealing on every recompute
   * and motion is what makes new work summon it again.
   */
  request_id: string;
  base_sha: string;
  dash_head: string;
  /**
   * The message this join would land with, composed server-side by the same
   * code the landing itself uses, so the preview cannot drift from the act.
   * Deliberately absent from `request_id`: editing the draft while the offer
   * stands must not mint a new offer.
   */
  message?: string;
  /** `"draft"` | `"description"` | `"fallback"` — which arm the message came from. */
  message_source?: string;
}

/** An escalation from the resolver, phrased as intent — never as a diff. */
export interface DashJoinQuestionWire {
  /** Identifies this ask, so an answer cannot resolve a different one. */
  request_id: string;
  question: string;
  options: DashJoinQuestionOptionWire[];
}

/** One concrete resolution offered on an escalation. */
export interface DashJoinQuestionOptionWire {
  label: string;
  description?: string;
}

/** The resolver's account of a candidate — what the review panel's space now shows. */
export interface DashJoinReportWire {
  files: DashJoinReportFileWire[];
  question?: DashJoinReportQuestionWire;
  notes?: string;
}

/** One file's account in the resolver's report. */
export interface DashJoinReportFileWire {
  path: string;
  resolved_by?: string;
  what_each_side_did?: string;
  reconciliation?: string;
  /**
   * `kept` | `redone` for a path an algorithmic rung decided and the resolver
   * reviewed; absent for one the resolver finished itself.
   */
  audit?: string;
}

/** The escalation the resolver raised and the answer it was given. */
export interface DashJoinReportQuestionWire {
  question: string;
  answer?: string;
}

export type ChangesetEntry = SessionChangesetEntry | DashChangesetEntry;

/** The workspace-scoped changeset snapshot (CHANGESET feed, 0x23). */
export interface ChangesetSnapshot {
  /** Canonical key of the workspace the snapshot was computed in. */
  workspace_key: string;
  /** Current branch name, or "(detached)" if HEAD is detached. */
  branch: string;
  /** Number of commits ahead of upstream. */
  ahead: number;
  /** Number of commits behind upstream. */
  behind: number;
  /** SHA of HEAD commit. */
  head_sha: string;
  /** Subject line of HEAD commit. */
  head_message: string;
  /** One entry per owner (session or dash) with attributed files. */
  changesets: ChangesetEntry[];
  /** Dirty files no owner claims. */
  unattributed: UnattributedFile[];
  /** Dirty files owned only by non-live sessions — claimable orphans
   *  ([D120]). Optional: absent/empty in the common case. */
  orphaned?: OrphanedFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isChangesetFile(value: unknown): value is ChangesetFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.git_status === "string" &&
    typeof value.op === "string" &&
    typeof value.origin === "string" &&
    typeof value.shared === "boolean" &&
    typeof value.last_touched === "number" &&
    isOptionalStringArray(value.own_hunks) &&
    isOptionalStringArray(value.contested_hunks) &&
    isOptionalSharedOwnerArray(value.shared_with)
  );
}

function isOptionalSharedOwnerArray(
  value: unknown,
): value is SharedOwner[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (owner) =>
          isRecord(owner) &&
          typeof owner.id === "string" &&
          typeof owner.name === "string" &&
          typeof owner.live === "boolean",
      ))
  );
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((s) => typeof s === "string"))
  );
}

/**
 * The join block, checked field for field.
 *
 * Every member below `phase` is optional, so a server that sends a sparse block
 * — the common case, since the wire skips empty collections — passes, and so
 * does an older server that sends none at all.
 */
function isOptionalDashArcState(
  value: unknown,
): value is DashArcState | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.stage !== undefined && typeof value.stage !== "string")
    return false;
  if (value.stopped !== undefined && typeof value.stopped !== "string")
    return false;
  if (
    value.stopped_stage !== undefined &&
    typeof value.stopped_stage !== "string"
  ) {
    return false;
  }
  if (value.done !== undefined && typeof value.done !== "boolean") return false;
  return true;
}

/** The fit fact, whose three fields travel together or not at all — a head
 *  without the base it was verified onto cannot name a tree. */
function isOptionalDashFit(
  value: unknown,
): value is { head: string; base: string; current: boolean } | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.head === "string" &&
    typeof value.base === "string" &&
    typeof value.current === "boolean"
  );
}

function isOptionalDashJoinState(
  value: unknown,
): value is DashJoinStateWire | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (typeof value.phase !== "string") return false;
  if (value.candidate !== undefined && typeof value.candidate !== "string")
    return false;
  if (value.reviewed !== undefined && typeof value.reviewed !== "boolean")
    return false;
  if (value.stale_note !== undefined && typeof value.stale_note !== "string")
    return false;
  if (value.run !== undefined && typeof value.run !== "string") return false;
  if (!isOptionalStringArray(value.conflicts)) return false;
  if (
    value.blockers !== undefined &&
    !(
      Array.isArray(value.blockers) &&
      value.blockers.every(
        (b) =>
          isRecord(b) &&
          typeof b.kind === "string" &&
          typeof b.detail === "string" &&
          isOptionalStringArray(b.paths) &&
          (b.remedy === undefined ||
            (isRecord(b.remedy) && typeof b.remedy.explain === "string")),
      )
    )
  ) {
    return false;
  }
  if (
    value.archaeology !== undefined &&
    !(
      Array.isArray(value.archaeology) &&
      value.archaeology.every(
        (h) =>
          isRecord(h) &&
          typeof h.path === "string" &&
          typeof h.total === "number" &&
          (h.commits === undefined ||
            (Array.isArray(h.commits) &&
              h.commits.every(
                (c) =>
                  isRecord(c) &&
                  typeof c.sha === "string" &&
                  typeof c.subject === "string",
              ))),
      )
    )
  ) {
    return false;
  }
  if (
    value.resolved !== undefined &&
    !(
      Array.isArray(value.resolved) &&
      value.resolved.every(
        (r) =>
          isRecord(r) &&
          typeof r.path === "string" &&
          typeof r.resolved_by === "string" &&
          (r.diff === undefined || typeof r.diff === "string") &&
          (r.added === undefined || typeof r.added === "number") &&
          (r.removed === undefined || typeof r.removed === "number"),
      )
    )
  ) {
    return false;
  }
  return true;
}

export function isUnattributedFile(value: unknown): value is UnattributedFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.git_status === "string" &&
    (value.hinted_by === undefined ||
      (Array.isArray(value.hinted_by) &&
        value.hinted_by.every((s) => typeof s === "string")))
  );
}

export function isOrphanedFile(value: unknown): value is OrphanedFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.git_status === "string" &&
    typeof value.op === "string" &&
    typeof value.origin === "string" &&
    typeof value.prior_owner_name === "string" &&
    typeof value.prior_owner_id === "string" &&
    typeof value.last_touched === "number"
  );
}

/** A present draft must be well-formed; absent is valid (the field is optional). */
export function isOptionalChangesetDraft(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    typeof value.fingerprint === "string" &&
    typeof value.message === "string" &&
    typeof value.updated_at === "number" &&
    (value.edited === undefined || typeof value.edited === "boolean") &&
    isOptionalDraftSelection(value.selection)
  );
}

/**
 * A present selection must be include/exclude string arrays and, when present,
 * a `hunks` record of string arrays; absent is valid.
 */
function isOptionalDraftSelection(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const isPathArray = (v: unknown): boolean =>
    v === undefined ||
    (Array.isArray(v) && v.every((p) => typeof p === "string"));
  const isHunkMap = (v: unknown): boolean =>
    v === undefined ||
    (isRecord(v) &&
      Object.values(v).every(
        (ids) =>
          Array.isArray(ids) && ids.every((id) => typeof id === "string"),
      ));
  return (
    isPathArray(value.include) &&
    isPathArray(value.exclude) &&
    isHunkMap(value.hunks)
  );
}

export function isChangesetEntry(value: unknown): value is ChangesetEntry {
  if (
    !isRecord(value) ||
    typeof value.owner_id !== "string" ||
    typeof value.display_name !== "string" ||
    !Array.isArray(value.files) ||
    !value.files.every(isChangesetFile) ||
    !isOptionalChangesetDraft(value.draft)
  ) {
    return false;
  }
  if (value.kind === "session") {
    return (
      typeof value.live === "boolean" &&
      (value.line_id === undefined ||
        value.line_id === null ||
        typeof value.line_id === "string")
    );
  }
  if (value.kind === "dash") {
    // The added fields are all optional, so an entry from a sender that
    // predates them still passes.
    return (
      typeof value.base === "string" &&
      typeof value.rounds === "number" &&
      typeof value.worktree === "string" &&
      typeof value.worktree_dirty === "boolean" &&
      isOptionalStringArray(value.round_subjects) &&
      (value.branch === undefined || typeof value.branch === "string") &&
      (value.stage === undefined || typeof value.stage === "string") &&
      isOptionalDashArcState(value.arc) &&
      isOptionalStringArray(value.bound_sessions) &&
      (value.holders_busy === undefined ||
        typeof value.holders_busy === "boolean") &&
      (value.step_current === undefined ||
        typeof value.step_current === "number") &&
      (value.step_total === undefined ||
        typeof value.step_total === "number") &&
      (value.run_position === undefined ||
        typeof value.run_position === "number") &&
      (value.run_length === undefined ||
        typeof value.run_length === "number") &&
      (value.step_title === undefined ||
        typeof value.step_title === "string") &&
      (value.last_activity === undefined ||
        typeof value.last_activity === "string") &&
      isOptionalDashDocuments(value.documents) &&
      (value.steps === undefined ||
        (Array.isArray(value.steps) && value.steps.every(isDashStep))) &&
      (value.base_ahead === undefined ||
        typeof value.base_ahead === "number") &&
      isOptionalStringArray(value.base_overlap) &&
      (value.last_replay === undefined ||
        typeof value.last_replay === "string") &&
      isOptionalDashFit(value.fit) &&
      isOptionalStringArray(value.replay_conflict_paths) &&
      isOptionalDashJoinState(value.join)
    );
  }
  return false;
}

export function isChangesetSnapshot(
  value: unknown,
): value is ChangesetSnapshot {
  return (
    isRecord(value) &&
    typeof value.workspace_key === "string" &&
    typeof value.branch === "string" &&
    typeof value.ahead === "number" &&
    typeof value.behind === "number" &&
    typeof value.head_sha === "string" &&
    typeof value.head_message === "string" &&
    Array.isArray(value.changesets) &&
    value.changesets.every(isChangesetEntry) &&
    Array.isArray(value.unattributed) &&
    value.unattributed.every(isUnattributedFile) &&
    (value.orphaned === undefined ||
      (Array.isArray(value.orphaned) && value.orphaned.every(isOrphanedFile)))
  );
}

/**
 * One project's slice of the account-global aggregate snapshot.
 *
 * Extends {@link ChangesetSnapshot} (the per-project payload is flattened on
 * the wire — Spec S06) with the project's identity. When `no_repo` is true the
 * project dir is not a git working tree: the snapshot fields are empty/zero
 * and the card renders an "Initialize git" affordance.
 */
export interface ProjectChangeset extends ChangesetSnapshot {
  /** Absolute checkout root; also the base for the card's clickable links. */
  project_dir: string;
  /** Basename of `project_dir`, shown as the section title. */
  display_name: string;
  /** True when `project_dir` is not inside a git working tree. */
  no_repo: boolean;
  /** The maintained draft for this project's unattributed bucket (Spec S10). */
  unattributed_draft?: ChangesetDraft;
  /**
   * Dashes that exist only as documents — a `.tug/dashes/<name>/` with no
   * branch yet — sorted by name. Absent when there are none.
   */
  document_dashes?: DocumentDashEntry[];
}

/**
 * Which of a dash's documents exist, with the first heading of each.
 *
 * Absolute paths. The title rides along because the deck has no filesystem: a
 * surface that wants to name a document cannot open it to find out.
 */
export interface DashDocuments {
  /** Absolute path of `brief.md`, when it exists. */
  brief?: string;
  /** Its first heading's text. */
  brief_title?: string;
  /** Absolute path of `plan.md`, when it exists. */
  plan?: string;
  /** Its first heading's text. */
  plan_title?: string;
}

export function isDashDocuments(value: unknown): value is DashDocuments {
  return (
    isRecord(value) &&
    (value.brief === undefined || typeof value.brief === "string") &&
    (value.brief_title === undefined ||
      typeof value.brief_title === "string") &&
    (value.plan === undefined || typeof value.plan === "string") &&
    (value.plan_title === undefined || typeof value.plan_title === "string")
  );
}

function isOptionalDashDocuments(value: unknown): boolean {
  return value === undefined || isDashDocuments(value);
}

/**
 * A dash that exists only as documents: a `.tug/dashes/<name>/` with no
 * `tugdash/<name>` branch yet — the planning phase in flight.
 *
 * Deliberately not a `DashChangesetEntry`: that carries a worktree, a base,
 * rounds, and files, none of which a branchless dash has. Creating the dash
 * turns this row into a live one rather than adding a second.
 */
export interface DocumentDashEntry {
  /** The dash's owner key — the same identity a live dash wears. */
  owner_id: string;
  /** The dash name, which is also its display identity. */
  display_name: string;
  /** The documents themselves. Never empty. */
  documents: DashDocuments;
  /** `reviewed` | `stale` | `never-reviewed` for the plan, when there is one. */
  review?: string;
  /** True when that plan is a task list rather than a devised document — the
   *  same bit the branch-bearing entry carries. Absent means false. */
  task_list?: boolean;
  /** Ledger rows the plan declares. 0 when there is no plan yet. */
  step_total: number;
  /** Ledger rows reading `done`. */
  steps_done: number;
  /**
   * Ledger rows reading anything but `pending`. The gesture keys off this,
   * never off `steps_done`: a plan whose first row is in progress with nothing
   * finished has begun, and Resume is what it wants.
   */
  steps_begun: number;
  /** The arc driving this dash, when one is open. */
  arc?: DashArcState;
  /** Sessions bound to this dash. */
  bound_sessions?: string[];
}

export function isDocumentDashEntry(
  value: unknown,
): value is DocumentDashEntry {
  return (
    isRecord(value) &&
    typeof value.owner_id === "string" &&
    typeof value.display_name === "string" &&
    isDashDocuments(value.documents) &&
    (value.review === undefined || typeof value.review === "string") &&
    typeof value.step_total === "number" &&
    typeof value.steps_done === "number" &&
    typeof value.steps_begun === "number" &&
    isOptionalStringArray(value.bound_sessions)
  );
}

/** The account-global aggregate changeset snapshot (CHANGESET_ALL feed, 0x24). */
export interface WorkspacesChangesetSnapshot {
  /** One entry per open project, in registry-enumeration order. */
  projects: ProjectChangeset[];
  /**
   * True once any ledger statement in the serving tugcast has hit database
   * corruption. Claims must render as *unavailable*, never as an empty
   * "no session claims these" result. Optional for frames from older
   * tugcasts.
   */
  ledger_degraded?: boolean;
}

export function isProjectChangeset(value: unknown): value is ProjectChangeset {
  return (
    isRecord(value) &&
    typeof value.project_dir === "string" &&
    typeof value.display_name === "string" &&
    typeof value.no_repo === "boolean" &&
    isOptionalChangesetDraft(value.unattributed_draft) &&
    (value.document_dashes === undefined ||
      (Array.isArray(value.document_dashes) &&
        value.document_dashes.every(isDocumentDashEntry))) &&
    isChangesetSnapshot(value)
  );
}

export function isWorkspacesChangesetSnapshot(
  value: unknown,
): value is WorkspacesChangesetSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.projects) &&
    value.projects.every(isProjectChangeset)
  );
}
