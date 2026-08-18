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
  /** The tug session id that owns these files. */
  owner_id: string;
  /** Session display name (name when user-set, else the id hash). */
  display_name: string;
  /** True when the session has a live relay right now. */
  live: boolean;
  files: ChangesetFile[];
  /** The maintained commit-message draft, when one exists (Spec S10). */
  draft?: ChangesetDraft;
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
  /** Live sessions mated to this dash. Empty is how *unbound* reads. */
  bound_sessions?: string[];
  /** Declared step counters, from the latest step declaration. */
  step_current?: number;
  step_total?: number;
  /** What `step_current` *is* — the latest `step-start` declaration's title. */
  step_title?: string;
  /** When the dash was last touched — the newest dash-log line's timestamp for
   *  its current generation, as an ISO-8601 UTC instant. Absent for a dash
   *  whose generation has logged nothing, which for one created before
   *  creation wrote a birth record is the ordinary case; a surface shows no
   *  age rather than guessing one. */
  last_activity?: string;
  /** The plan this dash is driving, relative to its **worktree** — the copy a
   *  run edits and whose ledger the step verbs rewrite. Absolute path is
   *  `worktree` / `plan_path`, and involves no third component. */
  plan_path?: string;
  /** What that plan's Review Record says about the document on disk now — one
   *  of `reviewed` | `stale` | `never-reviewed`, the same spellings
   *  `tugutil plan status` reports. Absent when the dash records no plan, or
   *  when the file cannot be read or parsed: absence means *nothing to say*,
   *  and a surface paints nothing for it. */
  review?: string;
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
  /** Paths the last replay attempt stopped on, when it conflicted. */
  replay_conflict_paths?: string[];
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
    v === undefined || (Array.isArray(v) && v.every((p) => typeof p === "string"));
  const isHunkMap = (v: unknown): boolean =>
    v === undefined ||
    (isRecord(v) &&
      Object.values(v).every(
        (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
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
    return typeof value.live === "boolean";
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
      isOptionalStringArray(value.bound_sessions) &&
      (value.step_current === undefined || typeof value.step_current === "number") &&
      (value.step_total === undefined || typeof value.step_total === "number") &&
      (value.step_title === undefined || typeof value.step_title === "string") &&
      (value.last_activity === undefined || typeof value.last_activity === "string") &&
      (value.plan_path === undefined || typeof value.plan_path === "string") &&
      (value.base_ahead === undefined || typeof value.base_ahead === "number") &&
      isOptionalStringArray(value.base_overlap) &&
      (value.last_replay === undefined || typeof value.last_replay === "string") &&
      isOptionalStringArray(value.replay_conflict_paths)
    );
  }
  return false;
}

export function isChangesetSnapshot(value: unknown): value is ChangesetSnapshot {
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
