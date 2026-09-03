/**
 * changes-route-controller — the per-card Changes view-route store ([P07]).
 *
 * On the `±` route the Session card commits its session's changeset as one
 * unit ([P05]): every file this session is attributed to, one
 * `changeset_commit`. There is no per-file election — an AI session emits a
 * unified changeset; a file you don't want in it is a conversation with the
 * AI, not a checkbox. Unattributed files (no session claims them) are shown
 * for awareness but never swept into this session's commit.
 *
 * Below the file, though, a landing can be partial: {@link
 * ChangesRouteController.electHunks} persists which hunks of a path to land
 * ([P09], riding the draft's free-form selection), and {@link
 * ChangesRouteController.commit} sends them as `changeset_commit.hunks`. A
 * path with no election lands whole.
 *
 * It opens NO feed of its own — the per-workspace `CHANGESET` feed (0x23)
 * is retired. Instead it subscribes to the app-level `ChangesetAllStore`
 * singleton (`CHANGESET_ALL`, 0x24 — the same store the rail reads) and
 * derives its slice as a filtered projection: this card's project by
 * `workspace_key`, its session entry by `owner_id`, the project's arc
 * entries, and the unattributed bucket.
 *
 * The commit and draft triggers are pass-throughs to the shipping app-level
 * verb / draft stores, and the two keys they use are different in kind.
 *
 * `entryKey` is a **client-local** correlation key and never leaves the deck:
 * the verb store holds it as the *value* of in-flight maps keyed by
 * `project_dir`, and every frame it sends addresses the server by
 * `project_dir` plus a separate `session_id`. It must therefore stay stable
 * for the card's whole life — a key that moved mid-flight would strand a
 * pending round trip under the old one while the notice controllers watched
 * the new, which is a silence in the same class as the one below.
 *
 * The identity that *does* reach the server is {@link
 * ChangesRouteController.requestOwnerId}, derived at call time from the
 * resolved entry. Draft addressing uses `workspaceKey` — the registry's
 * canonical spelling ([L29]) — never `projectDir`, which is the raw path the
 * card was bound with and is for display and file links only.
 *
 * @module lib/changes-route-controller
 */

import {
  ChangesetAllStore,
  getChangesetAllStore,
} from "./changeset-all-store";
import { getChangesetDraftStore } from "./changeset-draft-store";
import { getChangesetVerbStore } from "./changeset-verb-store";
import { sessionLineStore } from "./session-line-store";
import type {
  ChangesetDraftSelection,
  ArcChangesetEntry,
  DocumentArcEntry,
  OrphanedFile,
  ProjectChangeset,
  SessionChangesetEntry,
  UnattributedFile,
  WorkspacesChangesetSnapshot,
} from "./changeset-types";

/** Identity of the card the controller is bound to. */
export interface ChangesRouteBinding {
  /** The tug session id that owns this card's changeset entry. */
  tugSessionId: string;
  /** Canonical key of the workspace this card's project lives in. */
  workspaceKey: string;
  /**
   * Absolute checkout root as the card was bound with — the commit target and
   * file-link base. A RAW path ([L29]): display and OS-facing uses only, never
   * an identity. Draft addressing keys on `workspaceKey`.
   */
  projectDir: string;
}

/**
 * The controller's derived slice, reference-stable between recomputes so it
 * can drive `useSyncExternalStore` directly.
 */
export interface ChangesRouteSnapshot {
  /** This card session's changeset entry, or null when the feed has none yet. */
  entry: SessionChangesetEntry | null;
  /** Arc worktree entries in this workspace (their own Join affordance). */
  arcs: ArcChangesetEntry[];
  /**
   * Arcs in this workspace that exist only as documents — a brief or a plan
   * written, no branch cut yet. A card can be bound to one of these, so they
   * are a peer of `arcs` rather than a detail of it.
   */
  documentArcs: DocumentArcEntry[];
  /** Dirty files no owner claims. */
  unattributed: UnattributedFile[];
  /** Dirty files owned only by non-live sessions — claimable orphans ([D120]). */
  orphaned: OrphanedFile[];
  /** The project header (real feed project, or a placeholder before first emit). */
  project: ProjectChangeset;
  /**
   * True once the aggregate has actually emitted this workspace — i.e. `project`
   * is a real composed frame, not the pre-emit `placeholderProject` fallback.
   * A clean-and-composed project shows the "No changes" all-clear; a
   * not-yet-composed one says "waiting for project scan" instead, so an empty
   * placeholder never masquerades as a verified all-clear ([P02]).
   */
  composed: boolean;
  /** Repo-relative paths this session's commit lands — its full attributed set. */
  committedPaths: ReadonlySet<string>;
  /**
   * True when the serving tugcast has hit ledger corruption — attribution
   * is unavailable, not empty, and the view must say so honestly.
   */
  ledgerDegraded: boolean;
}

/**
 * Whether the entry's changes have moved since its draft was written — the
 * shade's "changes moved since this draft" marker ([P02]; advisory, never
 * blocks a landing). True when any attributed file was touched after the
 * draft's last regeneration.
 */
export function draftDrifted(entry: SessionChangesetEntry | null): boolean {
  const draft = entry?.draft;
  if (entry === null || draft === undefined) return false;
  return entry.files.some((file) => file.last_touched > draft.updated_at);
}

/**
 * A minimal project shell for a binding whose project the feed hasn't
 * emitted yet — enough identity to render immediately; the feed's next
 * frame supplies the real project. Mirrors the rail `placeholderProject`.
 */
function placeholderProject(binding: ChangesRouteBinding): ProjectChangeset {
  const dir = binding.projectDir;
  return {
    workspace_key: binding.workspaceKey,
    project_dir: dir,
    display_name: dir.slice(dir.lastIndexOf("/") + 1) || dir,
    no_repo: false,
    branch: "",
    ahead: 0,
    behind: 0,
    head_sha: "",
    head_message: "",
    changesets: [],
    unattributed: [],
    orphaned: [],
  };
}

/**
 * Pure derivation of a card's Changes slice from the aggregate snapshot.
 * Scoped to one workspace, with the placeholder-project fallback. The
 * committed set is the session's full attributed file list — no per-file
 * election; unattributed files are surfaced but never committed by this
 * session. Exported for unit tests.
 */
export function deriveChangesRouteSnapshot(
  data: WorkspacesChangesetSnapshot,
  binding: ChangesRouteBinding,
): ChangesRouteSnapshot {
  const composedProject = data.projects.find(
    (p) => p.workspace_key === binding.workspaceKey,
  );
  const composed = composedProject !== undefined;
  const project = composedProject ?? placeholderProject(binding);

  // Entry matching is line-first ([P01]): the card's session id is one
  // segment of a line, and after an id rotation the server keys the entry by
  // the line's current seat — which may not be the id this card was bound
  // with. An exact id match still outranks the line match, and a card whose
  // line the store has not learned yet falls back to the id alone.
  const bindingLine = sessionLineStore.lineOf(binding.tugSessionId);
  let entry: SessionChangesetEntry | null = null;
  let lineEntry: SessionChangesetEntry | null = null;
  const arcs: ArcChangesetEntry[] = [];
  for (const changeset of project.changesets) {
    if (changeset.kind === "arc") {
      arcs.push(changeset);
    } else if (changeset.owner_id === binding.tugSessionId) {
      entry = changeset;
    } else if (
      bindingLine !== null &&
      typeof changeset.line_id === "string" &&
      changeset.line_id === bindingLine
    ) {
      lineEntry = changeset;
    }
  }
  entry ??= lineEntry;

  const committedPaths = new Set<string>(
    entry?.files.map((file) => file.path) ?? [],
  );

  return {
    entry,
    arcs,
    documentArcs: project.document_arcs ?? [],
    unattributed: project.unattributed,
    orphaned: project.orphaned ?? [],
    project,
    composed,
    committedPaths,
    ledgerDegraded: data.ledger_degraded === true,
  };
}

const EMPTY_SNAPSHOT: WorkspacesChangesetSnapshot = { projects: [] };

/**
 * Per-card Changes-route store ([P07]). Constructed with the card's binding;
 * subscribes to the app-level `ChangesetAllStore` singleton and republishes
 * a filtered, selection-aware slice. `dispose` unsubscribes.
 */
export class ChangesRouteController {
  readonly tugSessionId: string;
  readonly workspaceKey: string;
  readonly projectDir: string;
  /**
   * Verb-store correlation key ([P07]) — **client-local, and deliberately
   * frozen at construction**. It is never serialized: the verb store files it
   * as the value of a `project_dir`-keyed in-flight map, so its only job is to
   * be the same string on the send and on the reply. The identity the server
   * is addressed by is {@link requestOwnerId}, which is a different question.
   */
  readonly entryKey: string;
  /** Draft-store owner kind for this entry. */
  readonly draftOwnerKind = "session";

  private readonly _binding: ChangesRouteBinding;
  private readonly _allStore: ChangesetAllStore | null;
  private readonly _unsubscribe: () => void;
  private readonly _listeners = new Set<() => void>();
  private _snapshot: ChangesRouteSnapshot;

  constructor(
    binding: ChangesRouteBinding,
    allStore: ChangesetAllStore | null = getChangesetAllStore(),
  ) {
    this._binding = binding;
    this.tugSessionId = binding.tugSessionId;
    this.workspaceKey = binding.workspaceKey;
    this.projectDir = binding.projectDir;
    this.entryKey = `session:${binding.tugSessionId}`;
    this._allStore = allStore;
    this._snapshot = this._derive();
    this._unsubscribe =
      allStore !== null ? allStore.subscribe(() => this._recompute()) : () => {};
  }

  private _derive(): ChangesRouteSnapshot {
    const data = this._allStore?.getSnapshot() ?? EMPTY_SNAPSHOT;
    return deriveChangesRouteSnapshot(data, this._binding);
  }

  private _recompute(): void {
    this._snapshot = this._derive();
    for (const listener of [...this._listeners]) listener();
  }

  // ── Store surface ([L02]) ──────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): ChangesRouteSnapshot => this._snapshot;

  // ── Triggers ───────────────────────────────────────────────────────────

  /** The message of the most recent commit this controller initiated —
   *  the landing receipt's subject source ([P09]; the verb store's reply
   *  carries sha + numstat but not the message). */
  private _lastCommitMessage: string | null = null;

  /** See {@link _lastCommitMessage}. */
  lastCommitMessage(): string | null {
    return this._lastCommitMessage;
  }

  /**
   * The identity every **server-bound** request from this card carries: the
   * resolved entry's `owner_id`, falling back to the binding id only when no
   * entry resolved ([B01]).
   *
   * The card's `tugSessionId` is frozen at bind time, but a session id rotates
   * — compaction, rewind, respawn — and the server keys a changeset entry by
   * the line's current **seat**. `deriveChangesRouteSnapshot` already resolves
   * the entry line-first, so the entry in hand is the one the server knows
   * about; its `owner_id` is the id the server will match. Sending the binding
   * id instead addresses a demoted segment, and the server's answer to an
   * owner it cannot place is to do nothing at all — a draft request that never
   * runs, a draft row written where nothing reads it.
   *
   * **Derived at call time, never cached.** A value read once in the
   * constructor is the same defect one rotation along ([B02]).
   */
  requestOwnerId(): string {
    return this._snapshot.entry?.owner_id ?? this.tugSessionId;
  }

  /**
   * Commit the current selection with `message` via the app-level verb store
   * ([P07]). No-op when the selection is empty or no store is attached.
   */
  commit(message: string): void {
    const files = [...this._snapshot.committedPaths];
    if (files.length === 0) return;
    this._lastCommitMessage = message;
    // A path whose hunks are only partly elected rides `hunks`; everything
    // else stages whole. Elections for paths that have since left the landing
    // set are dropped rather than sent — the server refuses an out-of-set key.
    //
    // The election goes out **unreconciled** ([P18]). The row reconciles it
    // against the file's current hunks for display, but the wire must carry
    // what the user actually stated: dropping ids that have drifted would land
    // a commit they never elected. `CommitError::HunkDrift` naming the path and
    // the ids is the authority here, and a loud refusal is the better failure.
    //
    // With nothing stated for a path, the default rides too: on a contended
    // file the server placed this session in particular hunks ([P12]), and
    // those are what the row shows checked. Sending whole-file there would
    // land the co-owner's regions under this session's message while the
    // boxes said otherwise.
    const election = this.hunkElection();
    const own = this.ownHunks();
    const hunks: Record<string, string[]> = {};
    for (const path of files) {
      const ids = election[path] ?? own[path];
      if (ids !== undefined && ids.length > 0) hunks[path] = [...ids];
    }
    // Carry the session's display name + id so `do_changeset_commit` appends a
    // `Tug-Session:` trailer ([P08], Spec S01). Sourced from the CHANGESET
    // entry; absent an entry (an unattributed-only commit), the id still
    // resolves from the binding and the backend simply omits the trailer.
    getChangesetVerbStore()?.commit(
      this.entryKey,
      this.workspaceKey,
      files,
      message,
      {
        name: this._snapshot.entry?.display_name,
        id: this.requestOwnerId(),
      },
      Object.keys(hunks).length > 0 ? hunks : undefined,
    );
  }

  // ── Hunk election ([P09]) ──────────────────────────────────────────────

  /**
   * The persisted per-path hunk election, read straight off the entry's draft
   * selection. A path absent from the map lands whole — the default, and what
   * every landing did before hunks existed.
   */
  hunkElection(): Readonly<Record<string, readonly string[]>> {
    return this._snapshot.entry?.draft?.selection?.hunks ?? {};
  }

  /**
   * Per-path, the hunks the server places this session in ([P12]) — the
   * default election on a contended file. Empty for every path the server
   * found no contention on, which is the whole-file default this landing had
   * before contention was hunk-aware.
   */
  private ownHunks(): Readonly<Record<string, readonly string[]>> {
    const out: Record<string, readonly string[]> = {};
    for (const file of this._snapshot.entry?.files ?? []) {
      const ids = file.own_hunks;
      if (ids !== undefined && ids.length > 0) out[file.path] = ids;
    }
    return out;
  }

  /**
   * Persist the elected hunk ids for one path. `ids` of `null` clears the
   * path's entry, restoring whole-file landing — the same thing the UI means
   * when every hunk is checked again, so a fully-elected file leaves no
   * partial-looking residue in the draft.
   *
   * The write rides the draft's free-form selection column immediately (no
   * debounce): a settled checkbox must show what the store holds.
   */
  electHunks(path: string, ids: readonly string[] | null): void {
    const entry = this._snapshot.entry;
    if (entry === null) return;
    const current = entry.draft?.selection ?? {};
    const nextHunks: Record<string, string[]> = { ...(current.hunks ?? {}) };
    if (ids === null || ids.length === 0) {
      delete nextHunks[path];
    } else {
      nextHunks[path] = [...ids];
    }
    const selection: ChangesetDraftSelection = { ...current };
    if (Object.keys(nextHunks).length > 0) {
      selection.hunks = nextHunks;
    } else {
      delete selection.hunks;
    }
    getChangesetDraftStore()?.setDraft(
      this.workspaceKey,
      this.draftOwnerKind,
      this.requestOwnerId(),
      { selection },
    );
  }

  /**
   * Claim unattributed files for this session: promote the given repo-relative
   * paths from "likely" hints into this session's changeset. Keyed by the
   * workspace's canonical key ([L29]) so the claim rows land under the same
   * project the unattributed rows compose against, and by `entryKey` so the
   * round trip's outcome reaches this card's claim-error notice. No-op when the
   * store is absent or `paths` is empty.
   */
  claim(paths: string[]): void {
    if (paths.length === 0) return;
    getChangesetVerbStore()?.claim(
      this.entryKey,
      this.workspaceKey,
      this.requestOwnerId(),
      paths,
    );
  }

  /**
   * Disclaim files for this session: remove the given repo-relative paths from
   * this session's changeset. The inverse of {@link claim} — a path falls to
   * another session that still holds proof of it (resolving a SHARED file in
   * that session's favor), or back to unattributed. Keyed by the workspace's
   * canonical key and by `entryKey`, exactly as claim is. No-op when the store
   * is absent or `paths` is empty.
   */
  disclaim(paths: string[]): void {
    if (paths.length === 0) return;
    getChangesetVerbStore()?.disclaim(
      this.entryKey,
      this.workspaceKey,
      this.requestOwnerId(),
      paths,
    );
  }

  /**
   * Nudge the server to re-scan the working tree and recompose the aggregate.
   * Fired when the Changes shade opens so a just-created orphan surfaces the
   * moment you look, rather than waiting on the next FS-watch bump. No-op when
   * no verb store is attached; the recompose is diff-suppressed server-side.
   */
  refresh(): void {
    getChangesetVerbStore()?.refresh();
  }

  /** Request an on-demand AI draft for this entry ([P06]). `force` is the
   *  confirmed Regenerate — the only path that overwrites an edited draft
   *  ([P03]). */
  requestDraft(force = false): void {
    getChangesetDraftStore()?.requestDraft(
      this.workspaceKey,
      this.draftOwnerKind,
      this.requestOwnerId(),
      force,
    );
  }

  dispose(): void {
    this._unsubscribe();
    this._listeners.clear();
  }
}
