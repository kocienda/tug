/**
 * `TugChangesList` — a read-only list of changed files with inline diffs
 * ([P01], Spec S01). One `TugListRow` per file (compact, mono): a status
 * glyph + path (a file reference — under a transcript's annotation scope it
 * is stamped as one, so the host's own menu serves it), the house `+N −M` badge
 * pair, a pop-out-to-a-card diff affordance, and a fold cue, over a diff
 * body that expands and collapses in place. Every row is expandable —
 * untracked files diff via the backend's synthesized new-file diffs.
 *
 * Two diff sources share the row renderer:
 *  - the live list (`TugChangesList`) diffs the working tree (`head`
 *    flavor, eagerly fetched so the ± badges fill in), and
 *  - the `/commit` receipt (`CommitChangesList`) diffs one committed sha
 *    (`commit` flavor, fetched lazily per row on first expand — the counts
 *    are frozen in the receipt record, so nothing loads until you look).
 *
 * The component owns diff fetching — one `GitDiffStore` per entry / per
 * expanded receipt row, dropped on unmount — and nothing else: live
 * per-file collapse is CONTROLLED by the host (`expandedKeys` +
 * `onToggleFile`) so each host keeps its own fold-all / whole-diff chrome.
 *
 * A session-entry row can also elect *which hunks* of a file the landing
 * takes ([P09]): the expanded diff renders a checkbox per hunk, keyed by the
 * server-computed hunk id, and the row wears an `N of M hunks` badge when only
 * part of it will land. The election is persisted by the host (the draft's
 * selection) — this component owns the controls and their responder wiring,
 * `DiffBlock` only paints the slot ([D05]).
 *
 * Laws: [L02] diff stores enter React through `useSyncExternalStore`;
 * [L06] status tones, hover affordances, and the partial-landing mark paint
 * via CSS, never React state; [L11] the hunk checkboxes dispatch `toggle`
 * through a `useResponderForm` scope this module owns; [L26] the diff body
 * collapses by unmount.
 *
 * @module components/tugways/tug-changes-list
 */

import "./tug-changes-list.css";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CornerDownLeft, CornerUpRight, SquareArrowOutUpRight } from "lucide-react";

import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import { useAnnotationScope } from "@/components/tugways/annotation-scope";
import { useAnnotationMenu } from "@/components/tugways/use-annotation-menu";
import { useTextSurfaceContextMenu } from "@/components/tugways/use-text-surface-context-menu";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import {
  annotationFromEvent,
  hostCardIdOf,
} from "@/lib/annotator/annotation-element";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import { isSecondaryPress } from "@/lib/whole-entity-press";
import { stampAnnotation } from "@/lib/annotator/annotation-element";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { DiffBlock } from "@/components/tugways/body-kinds/diff-block";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { DiffSummaryBadges } from "@/components/tugways/blocks/diff-summary-badges";
import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { fileTip } from "@/components/tugways/entity-tips";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { TugActionTooltip } from "@/components/tugways/tug-action-tooltip";
import { TugSessionCitation } from "@/components/tugways/tug-session-identity";
import { TugStatusMark } from "@/components/tugways/tug-status-mark";
import { TugMetaRun } from "@/components/tugways/tug-meta-run";
import {
  TugSectionLabel,
  type SectionLabel,
} from "@/components/tugways/tug-section-label";
import {
  getEntryDiffStore,
  releaseEntryDiffStore,
} from "@/lib/changeset-diff-store";
import {
  electionToPersist,
  reconcileHunkElection,
} from "@/lib/hunk-election";
import {
  diffDescriptorKey,
  type DiffDescriptor,
  type GitDiffFile,
  type GitDiffSnapshot,
} from "@/lib/git-diff-store";
import type {
  ChangesetFile,
  OrphanedFile,
  ProjectChangeset,
  SessionChangesetEntry,
  SharedOwner,
  UnattributedFile,
} from "@/lib/changeset-types";

// ---------------------------------------------------------------------------
// Entry model — one head entry (the session's attributed files, or the
// project's unattributed files) the list renders. The arc lane lives in the
// Changes shade, not here ([P01]).
// ---------------------------------------------------------------------------

export type TugChangesListEntry =
  | { kind: "session"; id: string; project: ProjectChangeset; entry: SessionChangesetEntry }
  | { kind: "unattributed"; id: string; project: ProjectChangeset; files: UnattributedFile[] }
  | { kind: "orphaned"; id: string; project: ProjectChangeset; files: OrphanedFile[] };

function isDeleted(op: string, gitStatus: string): boolean {
  return op === "deleted" || /D/.test(gitStatus);
}

// ---------------------------------------------------------------------------
// Click vs drag
// ---------------------------------------------------------------------------

/** Pointer travel (px) past which a press-and-release is a drag, not a click. */
const CLICK_SLOP_PX = 4;

/**
 * A press tracker that lets a click handler tell a click from a drag. The rows
 * carry click gestures — the fold, the path's open — over text a reader may
 * want to SELECT, and a selection drag ends in a `click` on the element it
 * started in. Without this, every attempt to select a path opened it.
 */
function usePressTracker(): {
  onMouseDown: (event: React.MouseEvent) => void;
  draggedSincePress: (event: React.MouseEvent) => boolean;
} {
  const origin = useRef<{ x: number; y: number } | null>(null);
  const onMouseDown = useCallback((event: React.MouseEvent) => {
    origin.current = { x: event.clientX, y: event.clientY };
  }, []);
  const draggedSincePress = useCallback((event: React.MouseEvent): boolean => {
    const start = origin.current;
    origin.current = null;
    if (start === null) return false;
    return Math.hypot(event.clientX - start.x, event.clientY - start.y) >= CLICK_SLOP_PX;
  }, []);
  return { onMouseDown, draggedSincePress };
}

// ---------------------------------------------------------------------------
// File path link + pop-out
// ---------------------------------------------------------------------------

function FilePathLink({
  path,
  shownPath,
  op,
  gitStatus,
  projectRoot,
  highlightQuery = "",
}: {
  path: string;
  /** The string to *render*, when it differs from `path` — a file under a
   *  directory row shows its cluster-relative name. `path` keeps every other
   *  job below: the absolute path, the stamp, the menu, the open. */
  shownPath?: string;
  op: string;
  gitStatus: string;
  projectRoot: string;
  highlightQuery?: string;
}) {
  const absolutePath = projectRoot ? `${projectRoot}/${path}` : path;
  // The path is matchable content wherever a filtered list shows it, so the
  // marks go on the rendered string. `path` stays the authority for the
  // hover, the menu, and the open action.
  const shown = renderFilterHighlight(shownPath ?? path, highlightQuery);

  // Inside the transcript a file reference has a HOST: one delegated click
  // listener and one context-menu provider that serve every annotation,
  // whatever surface produced it ([P05] the annotation registry). A row is
  // stamped wherever it is drawn, because the stamp IS the row's answer to
  // "what is this?" — the shades sample it through `TugChangesList`'s own
  // menu, the Overview through its cell's. What the scope still decides is
  // the CLICK: under a host the delegated listener opens the file, and acting
  // here as well would open it twice.
  const annotationHost = useAnnotationScope() !== null;

  const { onMouseDown: handleMouseDown, draggedSincePress } = usePressTracker();

  const stampRef = useRef<HTMLSpanElement | null>(null);
  // [L03] the mark must be on the element before any gesture the host's
  // delegated listeners resolve by reading it.
  useLayoutEffect(() => {
    const el = stampRef.current;
    if (el === null) return;
    // `guardPress: false` — the stamp's press guard preventDefaults the
    // mousedown, which is also what begins a text selection. A path in prose
    // wants that guard; a row's path is a whole element the reader sweeps to
    // copy, and the row's surface owns its focus policy.
    stampAnnotation(el, { kind: "file-path", path: absolutePath }, { guardPress: false });
  }, [absolutePath]);

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (
        event.button !== 0 ||
        isSecondaryPress(event.nativeEvent) ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      // A press that travelled was a selection drag over the path, not a click
      // on it — the reader was copying the name, not asking to open it.
      if (draggedSincePress(event)) return;
      // Opening the file is the reference's own gesture — never also the row's
      // expand toggle.
      event.stopPropagation();
      // Under a host, the open belongs to its delegated listener (which knows
      // the whole annotation vocabulary, and ignores the tail of a drag the
      // same way this does). Acting here too would open the file twice.
      if (annotationHost) return;
      const originCardId = hostCardIdOf(event.currentTarget);
      dispatchCommand(TUG_ACTIONS.OPEN_FILE, {
        path: absolutePath,
        ...(originCardId !== undefined ? { originCardId } : {}),
      });
    },
    [absolutePath, annotationHost, draggedSincePress],
  );

  // The hover is the house file tip — the same bubble this path gets in a
  // tool header, a Overview ref, or a commit roster. A row elides its path,
  // so the whole one belongs on the hover; a deleted file says so, since
  // that is the fact its unclickable name cannot carry.
  const deleted = isDeleted(op, gitStatus);
  const tip = fileTip({ path, status: deleted ? "deleted" : undefined });

  if (deleted || !projectRoot) {
    return (
      <TugTooltip variant="entity" align="start" content={tip}>
        <span className="tug-changes-list-file-path">{shown}</span>
      </TugTooltip>
    );
  }

  const link = (
    <span
      ref={stampRef}
      className="tug-changes-list-file-path tug-changes-list-file-path--link"
      data-slot="tug-changes-list-file-ref"
      // No `data-tug-focus="refuse"` here: refusing the gesture makes the
      // interpreter preventDefault the paired mousedown, which is also what
      // starts a text selection — the path became unselectable. Whether a
      // surface takes focus from a click is the SURFACE's policy (the
      // Changes shade refuses for its whole view), not a property of a
      // filename.
      data-no-activate={annotationHost ? undefined : ""}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      {shown}
    </span>
  );

  const hovered = (
    <TugTooltip variant="entity" align="start" content={tip}>
      {link}
    </TugTooltip>
  );

  // The menu comes from whichever surface hosts this row, built from the
  // registry for the kind the gesture landed on — the same Open in Editor /
  // Show in Finder / Copy Path a file reference in prose offers. The row is
  // stamped either way (above); the host samples the stamp. A menu here as
  // well would be the two popups over one press this surface used to show,
  // and a shorter list than the one the same file answers everywhere else.
  return hovered;
}

export function PopOutDiffButton({
  descriptor,
  label,
  size = "2xs",
}: {
  descriptor: DiffDescriptor;
  label: string;
  /** `2xs` for a per-file row; `xs` for a header's trailing cluster. */
  size?: "2xs" | "xs";
}) {
  // The card the button stands in, which the diff's card opens beside.
  const hostCardId = useCardId();
  return (
    <TugActionTooltip action={TUG_ACTIONS.OPEN_DIFF} content="Open this diff in a card">
      <TugPushButton
        subtype="icon"
        icon={<SquareArrowOutUpRight size={size === "xs" ? 14 : 12} />}
        size={size}
        emphasis="ghost"
        role="action"
        aria-label={label}
        data-testid="tug-changes-list-diff-popout"
        onClick={(event) => {
          event?.stopPropagation();
          dispatchCommand(TUG_ACTIONS.OPEN_DIFF, {
            descriptor,
            ...(hostCardId !== null ? { originCardId: hostCardId } : {}),
          });
        }}
      />
    </TugActionTooltip>
  );
}

// ---------------------------------------------------------------------------
// Diff descriptors + inline diff sourcing
// ---------------------------------------------------------------------------

const DIFF_IDLE_SNAPSHOT: GitDiffSnapshot = {
  phase: "idle",
  requestId: null,
  payload: null,
  error: null,
};

const DIFF_NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** The whole-entry diff descriptor: `git diff HEAD` (untracked included)
 *  scoped to the entry's paths. Null for a non-repo project or an empty
 *  entry. */
export function entryDiffDescriptor(entry: TugChangesListEntry): DiffDescriptor | null {
  if (entry.project.no_repo) return null;
  const files = entry.kind === "session" ? entry.entry.files : entry.files;
  const paths = files.map((file) => file.path);
  if (paths.length === 0) return null;
  return { kind: "head", root: entry.project.project_dir, paths };
}

/** The pop-out descriptor for one file (`git diff HEAD` scoped to it). */
function filePopOutDescriptor(
  project: ProjectChangeset,
  path: string,
): DiffDescriptor | null {
  if (project.no_repo) return null;
  return { kind: "head", root: project.project_dir, paths: [path] };
}

/** An entry's inline diff store + snapshot — one `GitDiffStore` per entry id,
 *  sourcing the descriptor the caller memoizes. */
export function useEntryDiff(
  id: string,
  descriptor: DiffDescriptor | null,
): {
  snapshot: GitDiffSnapshot;
  ensureRequested: () => void;
} {
  const store = getEntryDiffStore(id);
  const requestedKeyRef = useRef<string | null>(null);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? DIFF_NOOP_SUBSCRIBE,
    store?.getSnapshot ?? (() => DIFF_IDLE_SNAPSHOT),
  );
  const ensureRequested = useCallback(() => {
    if (store === null || descriptor === null) return;
    const key = diffDescriptorKey(descriptor);
    if (requestedKeyRef.current === key) return;
    requestedKeyRef.current = key;
    store.requestDiff(descriptor);
  }, [store, descriptor]);
  return { snapshot, ensureRequested };
}

// ---------------------------------------------------------------------------
// Hunk election ([P09]) — which hunks of a partial file the landing takes
// ---------------------------------------------------------------------------

/**
 * One file's hunk election as the row needs it: the server-supplied ids (the
 * only identity anyone uses — the deck never derives one) and the elected
 * subset. An absent entry in the draft means the whole file lands, so
 * `elected` is every id until the user unchecks one.
 */
export interface HunkElection {
  /** The elected ids for this path, or `null` when the file lands whole. */
  elected: readonly string[] | null;
  /** The hunks the server places this session in ([P12]) — the default
   *  election on a contended path, empty everywhere else. */
  own: readonly string[];
  /** The hunks another session claims too, marked in the diff. */
  contested: readonly string[];
  /** Persist a new election; `null` restores whole-file landing. */
  onElect: (ids: readonly string[] | null) => void;
}

/**
 * The checked set for a file: the persisted election reconciled against the
 * hunks actually in the file ([P18]), or — with nothing persisted — this
 * session's own hunks. Same rule the row's badge reads, so a count and its
 * boxes cannot disagree.
 */
function electedSet(
  ids: readonly string[],
  election: HunkElection | undefined,
): ReadonlySet<string> {
  if (election === undefined) return new Set(ids);
  return new Set(
    reconcileHunkElection(ids, election.elected, election.own).elected,
  );
}

/**
 * A file's inline diff — with a per-hunk election checkbox in each `@@` band
 * wherever a hunk can actually be elected.
 *
 * One component for every diff, branching internally on whether there is an
 * election ([L26]). The predicate moves at runtime — edit a one-hunk file into
 * two while its row is open and the aggregate recomposes — so a call site that
 * swapped between two component types would unmount the open diff, taking its
 * collapsed bands, view mode, and scroll with it.
 *
 * The responder wiring lives here rather than in `DiffBlock` ([D05], [L11]):
 * `DiffBlock` paints the slot and hands back each hunk's id, this component
 * owns the checkboxes, their `toggle` bindings, and the write. Unchecking the
 * last elected hunk is refused at the control — a file in the landing set with
 * nothing elected is a refusal server-side, so the UI never offers it.
 */
function FileDiffBody({
  file,
  election,
}: {
  file: GitDiffFile;
  election?: HunkElection;
}): React.ReactElement {
  const ids = file.hunks ?? [];
  const elected = electedSet(ids, election);
  const senderId = useCallback(
    (id: string) => `hunk:${file.path}:${id}`,
    [file.path],
  );
  // Built plainly, not memoized: `useResponderForm` reads the bindings through
  // a ref it refreshes every render, so there is nothing for a memo to save —
  // and a memo that actually held would freeze each closure over a stale
  // `elected` and break toggling.
  const toggle: Record<string, (value: boolean) => void> = {};
  if (election !== undefined) {
    for (const id of ids) {
      toggle[senderId(id)] = (next: boolean) => {
        const nextElected = ids.filter((candidate) =>
          candidate === id ? next : elected.has(candidate),
        );
        election.onElect(electionToPersist(ids, nextElected, election.own));
      };
    }
  }
  // Unconditional: hooks may not be conditional, and the form is cheap when
  // there is nothing bound to it.
  const form = useResponderForm({ toggle });

  // Hunk controls only where a hunk can actually be elected: the server sends
  // ids for tracked, textual files and none for a created file (whose diff it
  // synthesizes) or a binary one, and the landing engine refuses an election
  // on either ([P07]). The ids ride every diff regardless — identity is what
  // the wire serves, and an affordance is a separate question.
  const renderHunkAffordance =
    election !== undefined && ids.length > 1
      ? (hunkId: string) => {
          const checked = elected.has(hunkId);
          // The sole remaining hunk cannot be unchecked: an empty election
          // on a landing path is a server-side refusal, not a disposition.
          const isLast = checked && elected.size === 1;
          const box = (
            <TugCheckbox
              checked={checked}
              disabled={isLast}
              size="sm"
              senderId={senderId(hunkId)}
              aria-label={`Land this hunk of ${file.path}`}
              data-testid="tug-changes-list-hunk-elect"
            />
          );
          // A disabled control with no stated reason reads as broken. The
          // tooltip rides a wrapper this caller owns rather than widening
          // `TugCheckbox` for one caller — and a disabled checkbox swallows
          // the pointer, so the wrapper is also what the hover lands on.
          return isLast ? (
            <TugTooltip content="At least one hunk must land — a file in the landing set with nothing elected is refused">
              <span data-testid="tug-changes-list-hunk-elect-locked">{box}</span>
            </TugTooltip>
          ) : (
            box
          );
        }
      : undefined;

  return (
    <form.ResponderScope>
      {/* Unconditional wrapper: rendering it only when there is an election
          would be the same mount-identity breach one level down. It is
          unstyled, and the diff's sticky pin chain is unaffected — the pin's
          containing block is `.tugx-diff-hunk`. */}
      <div ref={form.responderRef}>
        <DiffBlock
          data={{ source: "unified", text: file.unified, filePath: file.path }}
          embedded
          hunkIds={file.hunks}
          contestedHunkIds={election?.contested}
          renderHunkAffordance={renderHunkAffordance}
        />
      </div>
    </form.ResponderScope>
  );
}

/** One file's diff as the row's expanded body. */
function fileBlockBody(
  snapshot: GitDiffSnapshot,
  path: string,
  election?: HunkElection,
): React.ReactNode {
  if (snapshot.phase === "error") {
    return (
      <p className="tug-changes-list-file-block-notice" role="alert">
        {snapshot.error ?? "Couldn't load the diff."}
      </p>
    );
  }
  // The notice is for having nothing to show, not for a request being in
  // flight: the store keeps the last payload across a refetch, and an open
  // diff must keep rendering it rather than blanking to a notice and back.
  // Swapping to a `<p>` and back is a remount, which loses the collapsed
  // bands, the view mode, and the scroll — the same [L23] loss the one-body
  // unification exists to prevent, arriving one level up.
  if (snapshot.payload === null) {
    return (
      <p className="tug-changes-list-file-block-notice" role="status">
        Loading diff…
      </p>
    );
  }
  const file = snapshot.payload.files.find((f) => f.path === path);
  if (file === undefined) {
    return (
      <p className="tug-changes-list-file-block-notice" role="status">
        No diff for this file.
      </p>
    );
  }
  if (file.binary) {
    return (
      <p className="tug-changes-list-file-block-notice" role="note">
        Binary file — no textual diff.
      </p>
    );
  }
  // One component type for every diff, whatever the hunk count and whatever
  // the entry kind ([L26]) — the branch that used to live here now lives
  // inside `FileDiffBody`. The notice branches above stay `<p>`: those are
  // genuinely different entities, not phases of the same one.
  return <FileDiffBody file={file} election={election} />;
}

// ---------------------------------------------------------------------------
// File rows
// ---------------------------------------------------------------------------

export interface FileBlockData {
  path: string;
  git_status: string;
  op: string;
  origin: string;
  shared: boolean;
  /**
   * The row's provenance mark ([P13]) — a bracket hint's terse text, or, for an
   * orphaned row, the citation chip naming the session that left the file
   * behind. A node rather than a string because a session reference is rendered
   * by `TugSessionIdentity` everywhere in the app, and the orphan hint is a
   * reference like any other.
   */
  hint?: React.ReactNode;
  /** The hunks the server places this session in ([P12]); present only on a
   *  contended path, where they are the default election. */
  own_hunks?: readonly string[];
  /** The hunks another session claims too, marked in the expanded diff. */
  contested_hunks?: readonly string[];
  /** Who else claims this file ([P06]) — the SHARED badge's own evidence. */
  shared_with?: readonly SharedOwner[];
}

/**
 * What the SHARED badge says about who it is shared with, or `null` when it
 * has nothing to add — an unshared file, or a server that does not send
 * `shared_with`.
 *
 * A closed co-owner is marked as such: "shared with probe (closed)" is the
 * whole difference between an inexplicable badge and a recognizable one, and
 * it is also the cue that the row can be released by hand.
 */
export function sharedWithTitle(
  file: Pick<FileBlockData, "shared" | "shared_with">,
): string | null {
  if (!file.shared) return null;
  const owners = file.shared_with ?? [];
  if (owners.length === 0) return null;
  const names = owners.map((o) => (o.live ? o.name : `${o.name} (closed)`));
  return `shared with ${names.join(", ")}`;
}

/**
 * Whether this row's share can be released by claiming it: every co-owner is
 * closed, so nobody running is about to be severed. Claiming severs the
 * co-owners ([D120]), which is the remedy for the unfalsifiable residue —
 * claim rows and legacy span-less rows that retirement cannot reach.
 */
export function sharedIsReleasable(
  file: Pick<FileBlockData, "shared" | "shared_with">,
): boolean {
  if (!file.shared) return false;
  const owners = file.shared_with ?? [];
  return owners.length > 0 && owners.every((o) => !o.live);
}

export function changesetFileData(file: ChangesetFile): FileBlockData {
  const sharedWith = file.shared_with ?? [];
  return {
    path: file.path,
    git_status: file.git_status,
    op: file.op,
    origin: file.origin,
    shared: file.shared === true,
    own_hunks: file.own_hunks,
    contested_hunks: file.contested_hunks,
    shared_with: sharedWith,
    // The co-owner rides the row as a citation chip, the same reference shape
    // an orphaned row's prior owner uses — so "who is this shared with" is
    // answerable at a glance and followable in a click.
    hint:
      file.shared === true && sharedWith.length > 0 ? (
        <span className="tug-changes-list-file-hint-from">
          with{" "}
          {sharedWith.map((owner, index) => (
            <React.Fragment key={owner.id}>
              {index > 0 ? ", " : null}
              <TugSessionCitation citedId={owner.id} recordedTag={owner.name} />
              {owner.live ? null : " (closed)"}
            </React.Fragment>
          ))}
        </span>
      ) : undefined,
  };
}

/**
 * Unattributed row data with its bracket-hint text ([P13]): the card
 * session's own hint reads as a terse `likely` badge — the one-glance
 * disposition cue; foreign hints render as a `seen by N` provenance count.
 */
function unattributedFileData(
  file: UnattributedFile,
  ownSessionId?: string,
): FileBlockData {
  const hintedBy = file.hinted_by ?? [];
  let hint: string | undefined;
  if (ownSessionId !== undefined && hintedBy.includes(ownSessionId)) {
    hint = "likely";
  } else if (hintedBy.length > 0) {
    hint = `seen by ${hintedBy.length}`;
  }
  return {
    path: file.path,
    git_status: file.git_status,
    op: "",
    origin: "",
    shared: false,
    hint,
  };
}

/**
 * Orphaned row data ([D120]): a file stranded on a dead session, shown with a
 * `from <prior owner>` hint so the reclaim reads as adoption. Keeps the dead
 * owner's op/origin provenance.
 *
 * The prior owner is named by a citation chip rather than by the feed's
 * `prior_owner_name` string. The string was a name with no identifier behind
 * it — two sessions that had been renamed alike read identically, and neither
 * could be followed. The chip resolves the id the feed already sends, so the
 * row says which session and lets the reader go to it.
 */
function orphanedFileData(file: OrphanedFile): FileBlockData {
  return {
    path: file.path,
    git_status: file.git_status,
    op: file.op,
    origin: file.origin,
    shared: false,
    hint: (
      <span className="tug-changes-list-file-hint-from">
        from{" "}
        <TugSessionCitation
          citedId={file.prior_owner_id}
          recordedTag={file.prior_owner_name}
        />
      </span>
    ),
  };
}

/**
 * What a row's badge says about the file's election — the reconciled shape,
 * not the raw persisted one, so the badge and the checkboxes read the same
 * rule ([P18]).
 */
export type FileElectionBadge =
  | { kind: "partial"; elected: number; total: number }
  | { kind: "stale" };

function FileIdentity({
  file,
  shownPath,
  projectRoot,
  highlightQuery,
  election = null,
}: {
  file: FileBlockData;
  /** See {@link ChangesFileRow}'s `shownPath`. */
  shownPath?: string;
  projectRoot: string;
  highlightQuery?: string;
  /** See {@link ChangesFileRow}'s `election`. */
  election?: FileElectionBadge | null;
}) {
  const provenance =
    file.origin === ""
      ? null
      : file.origin === "arc" || file.origin === "claim"
        ? file.op
        : `${file.op} · ${file.origin}`;
  // The divider is a separator between the file name and its metadata cluster,
  // not a property of one metadata kind — so it rides a wrapper that renders
  // only when the cluster has something in it. A badge-only or hint-only row
  // gets the same single divider a provenance row does; a bare row gets none.
  const hasMeta =
    file.shared ||
    provenance !== null ||
    file.hint !== undefined ||
    election !== null;
  // The badge names its co-owners when the server sent them; against an older
  // server it renders bare, exactly as before.
  const sharedTitle = sharedWithTitle(file);
  const sharedMark = (
    <span className="tug-changes-list-badge tug-changes-list-badge-shared">
      shared
    </span>
  );
  const sharedBadge =
    sharedTitle !== null ? (
      <TugTooltip content={sharedTitle}>{sharedMark}</TugTooltip>
    ) : (
      sharedMark
    );
  return (
    <span className="tug-changes-list-file-identity">
      <FilePathLink
        path={file.path}
        shownPath={shownPath}
        op={file.op}
        gitStatus={file.git_status}
        projectRoot={projectRoot}
        highlightQuery={highlightQuery}
      />
      {hasMeta ? (
        <TugMetaRun className="tug-changes-list-file-meta">
          {election !== null ? (
            election.kind === "partial" ? (
              <TugTooltip
                content={`Only ${election.elected} of this file's ${election.total} hunks will land`}
              >
                <span
                  className="tug-changes-list-badge tug-changes-list-badge-partial"
                  data-testid="tug-changes-list-file-partial"
                >
                  {`${election.elected} of ${election.total} hunks`}
                </span>
              </TugTooltip>
            ) : (
              // Every box is checked, but not because the file lands whole —
              // saying nothing here would assert a landing the engine is about
              // to refuse.
              <TugTooltip content="The hunks elected for this file are no longer in it — the landing will refuse until they are re-elected">
                <span
                  className="tug-changes-list-badge tug-changes-list-badge-stale"
                  data-testid="tug-changes-list-file-stale-election"
                >
                  stale election
                </span>
              </TugTooltip>
            )
          ) : null}
          {file.shared ? sharedBadge : null}
          {provenance !== null ? (
            <span className="tug-changes-list-file-provenance">{provenance}</span>
          ) : null}
          {file.hint !== undefined ? (
            <span
              className="tug-changes-list-file-hint"
              data-testid="tug-changes-list-file-hint"
            >
              {file.hint}
            </span>
          ) : null}
        </TugMetaRun>
      ) : null}
    </span>
  );
}

/**
 * One file's row + expandable diff body, shared by the live list and the
 * `/commit` receipt: a compact mono `TugListRow` (status glyph leading; path
 * + badges content; ± counts, pop-out, and fold cue trailing) over a
 * mount-on-expand diff body ([L26]). The whole row is a click target for the
 * fold; the path link and trailing controls own their gestures and stop
 * propagation. Presentation carries no lifecycle dot — a changed file has no
 * lifecycle.
 */
export function ChangesFileRow({
  file,
  shownPath,
  projectRoot,
  counts,
  election = null,
  expanded,
  onToggle,
  popOut,
  body,
  onClaim,
  claimKind = "claim",
  claimPending = false,
  onDisclaim,
  disclaimPending = false,
  highlightQuery,
}: {
  file: FileBlockData;
  /**
   * What the row *renders* in place of `file.path`, when the two differ — a
   * file under a directory row shows its cluster-relative name. It is used for
   * the displayed string and the filter highlight run over it, and for nothing
   * else: `file.path` stays the authority for the absolute path the annotation
   * stamp carries, the context menu, the open action, and the pop-out's label.
   * Passing a relative string as `file.path` instead would stamp
   * `<projectRoot>/<relative-to-cluster>` and open a file that is not there.
   */
  shownPath?: string;
  projectRoot: string;
  /** A list filter's live query — marks the path where it matched. Absent for
   *  the live Changes list, which carries no filter. */
  highlightQuery?: string;
  /** The `+N −M` pair when known (live: from the eager entry diff; receipt:
   *  from the frozen record). Absent → no badges (binary, still loading). */
  counts: { added: number; removed: number } | null;
  /** What the row says about the file's hunk election ([P09], [P18]): a
   *  partial landing counts the elected hunks, a wholly-drifted one says so
   *  rather than reading as a whole landing. Absent → nothing to say. */
  election?: FileElectionBadge | null;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  popOut: DiffDescriptor | null;
  /** The expanded body. Rendered only while `expanded`. */
  body: React.ReactNode;
  /** When set, a Claim affordance leads the trailing cluster — the row's
   *  file is unattributed-but-likely and this session can claim it ([D1xx]). */
  onClaim?: () => void;
  /** What that affordance is *for*. The gesture is the same `changeset_claim`
   *  either way; on a shared row whose co-owners are all closed it reads as a
   *  release, because what it does there is sever them ([P06]). */
  claimKind?: "claim" | "release";
  /** A claim round trip is in flight — the affordance disables rather than
   *  re-sending, so a slow reply reads as "working", not as a dead button. */
  claimPending?: boolean;
  /** When set, a Disclaim affordance trails the cluster — the row's file is in
   *  this session's changeset and the session can renounce it. */
  onDisclaim?: () => void;
  /** A disclaim round trip is in flight — the affordance disables. */
  disclaimPending?: boolean;
}): React.ReactElement {
  // The whole row folds on a click — but a drag across it is a selection, and
  // the reader who just swept a path out of the row shouldn't have the row
  // close under the gesture.
  const { onMouseDown: trackPress, draggedSincePress } = usePressTracker();
  return (
    <div
      className="tug-changes-list-file-block"
      data-testid="tug-changes-list-file-block"
      data-path={file.path}
      data-expanded={expanded ? "true" : undefined}
      data-partial={election?.kind === "partial" ? "true" : undefined}
      data-stale-election={election?.kind === "stale" ? "true" : undefined}
    >
      <div
        className="tug-changes-list-row-hit"
        onMouseDown={trackPress}
        onClick={(event) => {
          // A secondary press is the menu's gesture, never the fold's. A
          // macOS Control-click is button 0 and WebKit dispatches a `click`
          // for it alongside the `contextmenu`, so right-clicking the
          // orphaned row's prior-owner chip raised the chip's menu AND folded
          // the row open under it. The chip stops the click itself only while
          // it is interactive — it has a card to raise — and a dead session's
          // has none, so the guard belongs on the hit region that owns the
          // fold.
          if (isSecondaryPress(event.nativeEvent)) return;
          if (draggedSincePress(event)) return;
          onToggle(!expanded);
        }}
      >
        <TugListRow
          variant="flush"
          density="compact"
          mono
          leading={<TugStatusMark status={file.git_status} />}
          trailing={
            <span
              className="tug-changes-list-row-trailing"
              onClick={(event) => event.stopPropagation()}
            >
              {counts !== null ? (
                <DiffSummaryBadges added={counts.added} removed={counts.removed} />
              ) : null}
              {popOut !== null ? (
                <PopOutDiffButton
                  descriptor={popOut}
                  label={`Open diff for ${file.path} in a card`}
                />
              ) : null}
              <BlockFoldCue
                collapsed={!expanded}
                onToggle={(nextCollapsed) => onToggle(!nextCollapsed)}
                collapsedLabel="Expand diff"
                ariaLabelExpand={`Show diff for ${file.path}`}
                ariaLabelCollapse={`Hide diff for ${file.path}`}
                size="2xs"
                subtype="icon"
                stabilizeScroll={false}
                data-slot="tug-changes-list-fold"
              />
              {onClaim !== undefined ? (
                <TugTooltip
                  content={
                    claimPending
                      ? "Claiming…"
                      : claimKind === "release"
                        ? "Release this file from its closed co-owners"
                        : "Claim this file for this session"
                  }
                >
                  <TugPushButton
                    className="tug-changes-list-claim"
                    subtype="icon"
                    icon={<CornerDownLeft size={12} />}
                    size="2xs"
                    emphasis="outlined"
                    role="action"
                    disabled={claimPending}
                    aria-label={
                      claimKind === "release"
                        ? `Release ${file.path} from its closed co-owners`
                        : `Claim ${file.path} for this session`
                    }
                    data-testid="tug-changes-list-claim"
                    onClick={(event) => {
                      event?.stopPropagation();
                      onClaim();
                    }}
                  />
                </TugTooltip>
              ) : null}
              {onDisclaim !== undefined ? (
                <TugTooltip
                  content={
                    disclaimPending
                      ? "Disclaiming…"
                      : "Disclaim this file from this session"
                  }
                >
                  <TugPushButton
                    className="tug-changes-list-disclaim"
                    subtype="icon"
                    icon={<CornerUpRight size={12} />}
                    size="2xs"
                    emphasis="outlined"
                    role="accent"
                    disabled={disclaimPending}
                    aria-label={`Disclaim ${file.path} from this session`}
                    data-testid="tug-changes-list-disclaim"
                    onClick={(event) => {
                      event?.stopPropagation();
                      onDisclaim();
                    }}
                  />
                </TugTooltip>
              ) : null}
            </span>
          }
        >
          <FileIdentity
            file={file}
            shownPath={shownPath}
            projectRoot={projectRoot}
            highlightQuery={highlightQuery}
            election={election}
          />
        </TugListRow>
      </div>
      {expanded ? (
        <div className="tug-changes-list-file-diff" data-slot="tug-changes-list-file-diff">
          {body}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry file lists + host helpers
// ---------------------------------------------------------------------------

/** The file paths of an entry (host builds fold-all key sets). Every file is
 *  diffable — untracked files arrive as synthesized new-file diffs. */
export function diffablePathsOf(entry: TugChangesListEntry): string[] {
  const files: readonly { path: string }[] =
    entry.kind === "session" ? entry.entry.files : entry.files;
  return files.map((f) => f.path);
}

/** The controlled expand key for one file of one entry. */
export function fileExpandKey(entryId: string, path: string): string {
  return `${entryId}|${path}`;
}

/**
 * One entry's file list with per-file diff expansion (eager `git diff` on
 * mount for the `+N −M` badges). Collapse state is CONTROLLED from the host
 * (`expandedKeys`) so the fold-all / whole-diff controls live once in the
 * host's chrome and act across every entry; this only fetches + renders.
 */
function EntryFiles({
  entry,
  expandedKeys,
  onToggleFile,
  ownSessionId,
  onClaim,
  onRelease,
  claimPending,
  onDisclaim,
  disclaimPending,
  hunkElection,
  onElectHunks,
}: {
  entry: TugChangesListEntry;
  expandedKeys: ReadonlySet<string>;
  onToggleFile: (entryId: string, path: string, collapsed: boolean) => void;
  /** The card session's id — distinguishes own vs foreign bracket hints ([P13]). */
  ownSessionId?: string;
  /** Per-path claim, wired only for the unattributed and orphaned entries. */
  onClaim?: (path: string) => void;
  /** Per-path release, wired only for the session entry: claiming a file whose
   *  every co-owner is closed severs them ([D120]), which is the one remedy
   *  the unfalsifiable rows have. */
  onRelease?: (path: string) => void;
  /** A claim round trip is in flight. */
  claimPending?: boolean;
  /** Per-path disclaim, wired only for the session entry. */
  onDisclaim?: (path: string) => void;
  /** A disclaim round trip is in flight. */
  disclaimPending?: boolean;
  /** The persisted per-path hunk election ([P09]). */
  hunkElection?: Readonly<Record<string, readonly string[]>>;
  /** Persist a path's election; `null` restores whole-file landing. */
  onElectHunks?: (path: string, ids: readonly string[] | null) => void;
}) {
  const projectRoot = entry.project.project_dir;
  const descriptor = useMemo(() => entryDiffDescriptor(entry), [entry]);
  const { snapshot: diffSnapshot, ensureRequested } = useEntryDiff(entry.id, descriptor);
  useEffect(() => {
    ensureRequested();
  }, [ensureRequested]);
  // Drop this entry's inline-diff store on unmount (targeted, so a sibling
  // card's stores are untouched).
  useEffect(() => () => releaseEntryDiffStore(entry.id), [entry.id]);

  const files =
    entry.kind === "session"
      ? entry.entry.files.map(changesetFileData)
      : entry.kind === "orphaned"
        ? entry.files.map(orphanedFileData)
        : entry.files.map((file) => unattributedFileData(file, ownSessionId));

  return (
    <div
      className="tug-changes-list-file-list"
      data-entry-kind={entry.kind}
      data-entry-owner={entry.kind === "session" ? entry.entry.owner_id : undefined}
    >
      {files.map((file) => {
        const diffFile = diffSnapshot.payload?.files.find((f) => f.path === file.path);
        const counts =
          diffFile !== undefined && !diffFile.binary
            ? { added: diffFile.added, removed: diffFile.removed }
            : null;
        const expanded = expandedKeys.has(fileExpandKey(entry.id, file.path));
        const election: HunkElection | undefined =
          onElectHunks !== undefined
            ? {
                elected: hunkElection?.[file.path] ?? null,
                own: file.own_hunks ?? [],
                contested: file.contested_hunks ?? [],
                onElect: (ids) => onElectHunks(file.path, ids),
              }
            : undefined;
        // The row says so when only part of the file lands, and says so
        // differently when the election has drifted out of the file entirely —
        // a landing that reads whole but isn't would be a resting lie either
        // way. The badge computes here rather than in the body because a
        // collapsed row has no body, and it reads the same rule the boxes do
        // ([P18]), so the two cannot disagree about the count.
        const badge = ((): FileElectionBadge | null => {
          const ids = diffFile?.hunks;
          if (ids === undefined || election === undefined) return null;
          const display = reconcileHunkElection(
            ids,
            election.elected,
            election.own,
          );
          if (display.stale) return { kind: "stale" };
          if (display.partial === null) return null;
          return { kind: "partial", ...display.partial };
        })();
        return (
          <ChangesFileRow
            key={file.path}
            file={file}
            projectRoot={projectRoot}
            counts={counts}
            election={badge}
            expanded={expanded}
            onToggle={(next) => onToggleFile(entry.id, file.path, !next)}
            popOut={filePopOutDescriptor(entry.project, file.path)}
            body={expanded ? fileBlockBody(diffSnapshot, file.path, election) : null}
            onClaim={
              onClaim !== undefined
                ? () => onClaim(file.path)
                : onRelease !== undefined && sharedIsReleasable(file)
                  ? () => onRelease(file.path)
                  : undefined
            }
            claimKind={onClaim === undefined ? "release" : "claim"}
            claimPending={claimPending}
            onDisclaim={
              onDisclaim !== undefined ? () => onDisclaim(file.path) : undefined
            }
            disclaimPending={disclaimPending}
          />
        );
      })}
    </div>
  );
}

export interface TugChangesListProps {
  /** Head entries to render, in order: the session entry, then unattributed. */
  entries: ReadonlyArray<TugChangesListEntry>;
  /** The card session's id — distinguishes own vs foreign bracket hints on
   *  unattributed rows. */
  ownSessionId?: string;
  /** Controlled per-file expansion, keyed `${entryId}|${path}` (fileExpandKey). */
  expandedKeys: ReadonlySet<string>;
  onToggleFile: (entryId: string, path: string, collapsed: boolean) => void;
  /** Optional label rendered above the unattributed entry. */
  unattributedLabel?: SectionLabel;
  /** When set, unattributed rows show a Claim affordance that promotes the
   *  path into this session's changeset ([D1xx]). */
  onClaimUnattributed?: (path: string) => void;
  /** When set (and the section has 1+ files), a "Claim all" button on the
   *  unattributed header claims every path in one batch. */
  onClaimAllUnattributed?: (paths: string[]) => void;
  /** Optional label rendered above the orphaned entry ([D120]). */
  orphanedLabel?: SectionLabel;
  /** When set, orphaned rows show a Claim affordance that reclaims the path
   *  into this session, severing the dead originator ([D120]). */
  onClaimOrphaned?: (path: string) => void;
  /** When set (and the section has 1+ files), a "Claim all" button on the
   *  orphaned header reclaims every path in one batch ([D120]). */
  onClaimAllOrphaned?: (paths: string[]) => void;
  /** A claim round trip is in flight — every Claim affordance disables until
   *  the reply lands, so a slow or refused claim never invites a re-click. */
  claimPending?: boolean;
  /** Optional label rendered above the session entry. Present only when the
   *  section needs a header — which is what carries "Disclaim all". */
  sessionLabel?: SectionLabel;
  /** When set, a session-entry row shared only with *closed* sessions shows a
   *  release affordance — the same `changeset_claim`, which severs them
   *  ([D120]). It is the only remedy for shares no evidence can falsify:
   *  claim rows and legacy span-less rows ([P06]). */
  onReleaseShared?: (path: string) => void;
  /** When set, session-entry rows show a Disclaim affordance that removes the
   *  path from this session's changeset — claim's inverse. */
  onDisclaimFile?: (path: string) => void;
  /** When set (and the section has 1+ files), a "Disclaim all" button on the
   *  session header renounces every path in one request — claim-all's inverse. */
  onDisclaimAllFiles?: (paths: string[]) => void;
  /** A disclaim round trip is in flight — every Disclaim affordance disables
   *  until the reply lands. */
  disclaimPending?: boolean;
  /** The persisted per-path hunk election ([P09]) — a path absent from it
   *  lands whole. Read to check the boxes and mark partial rows. */
  hunkElection?: Readonly<Record<string, readonly string[]>>;
  /** When set, session-entry files with more than one hunk show a per-hunk
   *  election checkbox; `null` ids restore whole-file landing. */
  onElectHunks?: (path: string, ids: readonly string[] | null) => void;
  className?: string;
}

export function TugChangesList({
  entries,
  ownSessionId,
  expandedKeys,
  onToggleFile,
  unattributedLabel,
  onClaimUnattributed,
  onClaimAllUnattributed,
  orphanedLabel,
  onClaimOrphaned,
  onClaimAllOrphaned,
  claimPending,
  sessionLabel,
  onReleaseShared,
  onDisclaimFile,
  onDisclaimAllFiles,
  disclaimPending,
  hunkElection,
  onElectHunks,
  className,
}: TugChangesListProps): React.ReactElement {
  // The shades are the surface a changes row's file reference is hosted by:
  // the rows stamp themselves, this samples the stamp, and the registry says
  // what a file offers — the same Open in Editor / Show in Finder / Copy Path
  // the same file answers in transcript prose. Before this the row carried a
  // two-item menu of its own, so one file had a four-item menu in one place
  // and a two-item menu in another.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const annotation = useAnnotationMenu({ originRef: rootRef });
  const responderId = React.useId();
  const { ResponderScope, responderRef } = useOptionalResponder({
    id: responderId,
    actions: annotation.actions,
  });
  const { onMouseDown, onContextMenu, menu } = useTextSurfaceContextMenu({
    adapterRef: null,
    extraEntries: annotation.extraEntries,
    hideStandardItems: annotation.hideStandardItems,
    wholeEntityTarget: annotation.wholeEntityTarget,
  });
  // Only a press that landed on a stamped reference opens this menu. A press
  // on the list's own chrome carries no entity, and answering it with an
  // entity menu's empty shell would be worse than the fallback it falls
  // through to ([L31] — the refusal is the fallback's, and it is visible).
  const handleContextMenu = useCallback(
    (event: React.MouseEvent): void => {
      if (annotationFromEvent(event.nativeEvent) === null) return;
      event.stopPropagation();
      onContextMenu(event.nativeEvent);
    },
    [onContextMenu],
  );
  return (
   <ResponderScope>
    <div
      ref={responderRef as (node: HTMLDivElement | null) => void}
      className={className !== undefined ? `tug-changes-list ${className}` : "tug-changes-list"}
      data-slot="tug-changes-list"
      onContextMenu={handleContextMenu}
      onMouseDown={(event) => onMouseDown(event.nativeEvent)}
    >
      {entries.map((entry) => {
        const label =
          entry.kind === "unattributed"
            ? unattributedLabel
            : entry.kind === "orphaned"
              ? orphanedLabel
              : sessionLabel;
        const onClaim =
          entry.kind === "unattributed"
            ? onClaimUnattributed
            : entry.kind === "orphaned"
              ? onClaimOrphaned
              : undefined;
        const onRelease = entry.kind === "session" ? onReleaseShared : undefined;
        const onClaimAll =
          entry.kind === "unattributed"
            ? onClaimAllUnattributed
            : entry.kind === "orphaned"
              ? onClaimAllOrphaned
              : undefined;
        const claimAllPaths = onClaimAll !== undefined ? diffablePathsOf(entry) : [];
        const onDisclaimAll = entry.kind === "session" ? onDisclaimAllFiles : undefined;
        const disclaimAllPaths =
          onDisclaimAll !== undefined ? diffablePathsOf(entry) : [];
        // The bulk affordances trail their section rather than heading it: the
        // header names the bucket, the reader walks the rows, and the button
        // sits where the decision is made — after what it acts on.
        const claimAllButton =
          onClaimAll !== undefined && claimAllPaths.length >= 1 ? (
            <TugActionTooltip
              action={TUG_ACTIONS.CLAIM_ALL_CHANGES}
              content={claimPending ? "Claiming…" : "Claim all files in this session"}
            >
              <TugPushButton
                className="tug-changes-list-claim-all"
                subtype="icon-text"
                icon={<CornerDownLeft size={12} />}
                size="2xs"
                emphasis="outlined"
                role="action"
                disabled={claimPending}
                aria-label={`Claim all ${entry.kind} files in this session`}
                data-testid={`tug-changes-list-claim-all-${entry.kind}`}
                onClick={(event) => {
                  event?.stopPropagation();
                  onClaimAll(claimAllPaths);
                }}
              >
                Claim all
              </TugPushButton>
            </TugActionTooltip>
          ) : null;
        const disclaimAllButton =
          onDisclaimAll !== undefined && disclaimAllPaths.length >= 1 ? (
            <TugActionTooltip
              action={TUG_ACTIONS.DISCLAIM_ALL_CHANGES}
              content={
                disclaimPending
                  ? "Disclaiming…"
                  : "Disclaim all files from this session"
              }
            >
              <TugPushButton
                className="tug-changes-list-disclaim-all"
                subtype="icon-text"
                icon={<CornerUpRight size={12} />}
                size="2xs"
                emphasis="outlined"
                role="accent"
                disabled={disclaimPending}
                aria-label="Disclaim all files from this session"
                data-testid="tug-changes-list-disclaim-all"
                onClick={(event) => {
                  event?.stopPropagation();
                  onDisclaimAll(disclaimAllPaths);
                }}
              >
                Disclaim all
              </TugPushButton>
            </TugActionTooltip>
          ) : null;
        return (
          <React.Fragment key={entry.id}>
            {label !== undefined ? (
              <TugSectionLabel
                label={label}
                slot={`tug-changes-list-${entry.kind}-label`}
              />
            ) : null}
            <EntryFiles
              entry={entry}
              expandedKeys={expandedKeys}
              onToggleFile={onToggleFile}
              ownSessionId={entry.kind === "unattributed" ? ownSessionId : undefined}
              onClaim={onClaim}
              onRelease={onRelease}
              claimPending={claimPending}
              onDisclaim={entry.kind === "session" ? onDisclaimFile : undefined}
              disclaimPending={disclaimPending}
              hunkElection={entry.kind === "session" ? hunkElection : undefined}
              onElectHunks={entry.kind === "session" ? onElectHunks : undefined}
            />
            {claimAllButton !== null || disclaimAllButton !== null ? (
              <div
                className="tug-changes-list-section-actions"
                data-slot={`tug-changes-list-${entry.kind}-actions`}
              >
                {claimAllButton}
                {disclaimAllButton}
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
      {menu}
    </div>
   </ResponderScope>
  );
}

// ---------------------------------------------------------------------------
// Commit list — the `/commit` receipt's file rows ([P08])
// ---------------------------------------------------------------------------

/** One committed file frozen in a `/commit` receipt: path, git name-status
 *  word (`modified` | `created` | `deleted` | `renamed`), ± counts. */
export interface CommitChangesFile {
  path: string;
  status: string;
  added: number;
  removed: number;
}

/** Map a name-status word to a synthetic porcelain code the glyph / tone
 *  helpers key on. */
function commitStatusToGitCode(status: string): string {
  switch (status) {
    case "created":
      return "A ";
    case "deleted":
      return "D ";
    case "renamed":
      return "R ";
    default:
      return " M";
  }
}

/**
 * One receipt row's lazy commit diff: nothing is fetched until the row first
 * expands, then a per-row `GitDiffStore` runs the `commit` flavor scoped to
 * this path. The store is keyed by sha + path (commit diffs are immutable,
 * so a re-expand reuses the ready snapshot) and dropped on unmount.
 */
function CommitFileRow({
  root,
  sha,
  file,
  highlightQuery,
}: {
  root: string;
  sha: string;
  file: CommitChangesFile;
  highlightQuery?: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const storeId = `commit:${sha}:${file.path}`;
  const descriptor = useMemo<DiffDescriptor>(
    () => ({ kind: "commit", root, sha, paths: [file.path] }),
    [root, sha, file.path],
  );
  const { snapshot, ensureRequested } = useEntryDiff(storeId, descriptor);
  useEffect(() => {
    if (expanded) ensureRequested();
  }, [expanded, ensureRequested]);
  useEffect(() => () => releaseEntryDiffStore(storeId), [storeId]);

  const gitStatus = commitStatusToGitCode(file.status);
  return (
    <ChangesFileRow
      file={{
        path: file.path,
        git_status: gitStatus,
        // A committed file renders no op/origin provenance — the receipt
        // header already carries the commit identity.
        op: file.status === "deleted" ? "deleted" : "",
        origin: "",
        shared: false,
      }}
      projectRoot={root}
      counts={{ added: file.added, removed: file.removed }}
      expanded={expanded}
      onToggle={setExpanded}
      popOut={descriptor}
      body={expanded ? fileBlockBody(snapshot, file.path) : null}
      highlightQuery={highlightQuery}
    />
  );
}

/**
 * One changed file of an **arc range**, as the receipt's own row.
 *
 * The range twin of {@link CommitFileRow}, and it lives here rather than under
 * `session-changes/` for one reason: `fileBlockBody` is module-private, and it
 * is the right thing to stay private. It encodes the policy an expanded diff
 * body must have — a refetch keeps rendering the last payload rather than
 * blanking to a notice and back, which would remount and lose the collapsed
 * bands, the view mode and the scroll ([L26]). Exporting that helper to a card
 * would put the policy on the wrong side of a boundary; exporting a *row*
 * keeps it inside.
 *
 * Unlike a commit, an arc range is **mutable** — a new round moves it — so the
 * per-row store is dropped on unmount and a re-expand after a round re-requests
 * rather than serving a stale snapshot.
 */
export function ArcRangeFileRow({
  root,
  worktree,
  base,
  branch,
  file,
  shown,
}: {
  /** The project dir the arc lives in (resolves the workspace). */
  root: string;
  /** The arc worktree's absolute path, as the wire carries it. */
  worktree: string;
  /** The arc's base branch. */
  base: string;
  /** The arc's branch ref. */
  branch: string;
  file: ChangesetFile;
  /** What to render in place of `file.path` — a cluster-relative name. The
   *  descriptor, the store id and the open action all still use `file.path`. */
  shown?: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const storeId = `range:${worktree}:${base}:${branch}:${file.path}`;
  const descriptor = useMemo<DiffDescriptor>(
    () => ({ kind: "range", root, worktree, base, branch, paths: [file.path] }),
    [root, worktree, base, branch, file.path],
  );
  const { snapshot, ensureRequested } = useEntryDiff(storeId, descriptor);
  useEffect(() => {
    if (expanded) ensureRequested();
  }, [expanded, ensureRequested]);
  useEffect(() => () => releaseEntryDiffStore(storeId), [storeId]);

  return (
    <ChangesFileRow
      file={{
        path: file.path,
        git_status: file.git_status,
        // A file in an arc range renders no op/origin provenance — the fold's
        // own eyebrow already carries the arc identity.
        op: "",
        origin: "",
        shared: false,
      }}
      shownPath={shown}
      projectRoot={root}
      counts={{ added: file.added ?? 0, removed: file.deleted ?? 0 }}
      expanded={expanded}
      onToggle={setExpanded}
      popOut={descriptor}
      body={expanded ? fileBlockBody(snapshot, file.path) : null}
    />
  );
}

/**
 * The committed files of one `/commit` receipt as the same rows as
 * {@link TugChangesList} — sha-backed instead of working-tree-backed
 * ([P08]). Counts render instantly from the frozen record; each row's diff
 * fetches lazily on first expand (a thousand-file commit costs nothing until
 * you look). A vanished sha (rebase, gc) degrades to an in-body notice while
 * the rows stay intact.
 */
export function CommitChangesList({
  root,
  sha,
  files,
  highlightQuery,
}: {
  /** The project dir the commit lives in (resolves the workspace). */
  root: string;
  /** The commit's full sha, parsed from the receipt record. */
  sha: string;
  files: readonly CommitChangesFile[];
  /** A list filter's live query — marks the paths it matched. The History
   *  filter matches on a commit's file roster, so an expanded row under a
   *  filter must show which of its files the query found. */
  highlightQuery?: string;
}): React.ReactElement {
  return (
    <div className="tug-changes-list-file-list" data-slot="tug-commit-changes-list">
      {files.map((file) => (
        <CommitFileRow
          key={file.path}
          root={root}
          sha={sha}
          file={file}
          highlightQuery={highlightQuery}
        />
      ))}
    </div>
  );
}
